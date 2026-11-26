import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { link, mkdir, open, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { request } from "node:http";
import { writePrivate } from "./data-dir.ts";
import { isAlive } from "./postgres.ts";

/**
 * One backend for a data folder (design O4 of AnimaQuill Cloud, section 1): `lock`, made with
 * `wx`, says which process has it; `backend.json`, written once the backend answers, says how the
 * command line of the same user reaches it (`npx animaquill open`, and a second `npx animaquill`,
 * which then opens the editor of the first in place of starting). Both 600. The admin key changes
 * with every start, and so does the instance.
 */

export const LOCK_FILE = "lock";
export const BACKEND_FILE = "backend.json";
export const BACKEND_FORMAT = 1;

export interface LockNote {
  readonly pid: number;
  readonly instance: string;
  readonly startedAt: number;
}

export interface BackendNote {
  readonly format: typeof BACKEND_FORMAT;
  readonly instance: string;
  readonly pid: number;
  readonly version: string;
  readonly port: number;
  /** The editor's site, which the admin routes are asked by (`Host`). */
  readonly origin: string;
  readonly adminKey: string;
  readonly startedAt: number;
}

export const newInstance = () => randomBytes(16).toString("base64url");
export const newAdminKey = () => randomBytes(32).toString("base64url");

/** A start that holds the lock: lets it go as it stops. */
export interface HeldLock {
  readonly note: LockNote;
  /** Writes `backend.json`, once the backend answers. */
  announce(backend: Omit<BackendNote, "format" | "instance" | "pid" | "startedAt">): Promise<void>;
  release(): Promise<void>;
}

/** Another start has the folder, and answers: the editor of that one is what to open. */
export interface Running {
  readonly kind: "running";
  readonly backend: BackendNote;
}

/** Another start has the folder, and does not answer. */
export class LockHeld extends Error {
  override name = "LockHeld";
  readonly pid: number;
  constructor(pid: number) {
    super(`the data folder is held by process ${pid}, which does not answer`);
    this.pid = pid;
  }
}

/**
 * How long a start that holds the lock has to answer, from its start: the first start makes the
 * database, which on Windows with a virus scanner looking at every new file can take minutes;
 * only a lock older than this whose process is alive and does not answer is taken over (as of a
 * process whose number another one has now, after a restart of the computer).
 */
export const STARTING_MS = 5 * 60_000;
/** How long one that wrote `backend.json` has to answer a ping. */
const ANSWER_MS = 10_000;

export interface LockOptions {
  readonly now?: () => number;
  readonly wait?: (ms: number) => Promise<void>;
  /** Told once where another start is starting, and this one waits for it. */
  readonly waiting?: ((pid: number) => void) | undefined;
  /** Asks a backend who it is: `ping` unless said. */
  readonly ping?: (backend: BackendNote) => Promise<"ours" | "other" | "refused">;
}

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

/**
 * Takes the lock of `dir` for this process, or says which start has it. A lock of a process that
 * is gone, or of one that is no backend of ours (its number given to another process since, as
 * after a restart: nothing answers where it says), is taken over.
 */
export async function takeLock(
  dir: string,
  options: LockOptions = {},
): Promise<HeldLock | Running> {
  const now = options.now ?? Date.now;
  const wait = options.wait ?? sleep;
  const ask = options.ping ?? ping;
  const lockPath = join(dir, LOCK_FILE);
  const backendPath = join(dir, BACKEND_FILE);
  for (let round = 0; round < 20; round++) {
    const note: LockNote = { pid: process.pid, instance: newInstance(), startedAt: now() };
    if (await makeLock(lockPath, note)) return held(note, lockPath, backendPath);
    const seen = await readFile(lockPath, "utf8").catch(() => undefined);
    if (seen === undefined) continue;
    let other: LockNote | undefined;
    try {
      other = JSON.parse(seen) as LockNote;
    } catch {
      other = undefined;
    }
    if (!other) {
      // Nothing of it to read: on a disk without links (FAT) a lock is written after it is made,
      // so its writer gets a moment before it is taken as one that was never written whole.
      await wait(UNREADABLE_MS);
      if ((await readFile(lockPath, "utf8").catch(() => undefined)) !== seen) continue;
      await takeOver(lockPath, seen, wait);
      continue;
    }
    if (!Number.isInteger(other.pid) || !isAlive(other.pid)) {
      // A process that is gone, or a lock that says nothing of one: taken over.
      await takeOver(lockPath, seen, wait);
      continue;
    }
    // Alive: a backend that is starting, or one that runs, or a process of that number that is
    // nothing of ours.
    const found = await answerOf(other, backendPath, { now, wait, ask, waiting: options.waiting });
    if (found.kind === "running") return found;
    if (found.kind === "silent") throw new LockHeld(other.pid);
    await takeOver(lockPath, seen, wait);
  }
  throw new Error("the lock of the data folder could not be taken");
}

/**
 * Makes the lock, whole or not at all: written into a file of its own, then linked to its name,
 * which fails where there is one. A disk without links (FAT, exFAT) gets it made with `wx`.
 */
async function makeLock(lockPath: string, note: LockNote): Promise<boolean> {
  const text = JSON.stringify(note);
  const temporary = `${lockPath}.${note.instance}.tmp`;
  const file = await open(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    0o600,
  );
  try {
    await file.writeFile(text);
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    await link(temporary, lockPath);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") return false;
    if (code !== "EPERM" && code !== "ENOTSUP" && code !== "EXDEV" && code !== "ENOSYS")
      throw error;
  } finally {
    await rm(temporary, { force: true });
  }
  try {
    const direct = await open(
      lockPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    try {
      await direct.writeFile(text);
      await direct.sync();
    } finally {
      await direct.close();
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

/** How long a lock that cannot be read is given, to be written, before it is taken over. */
export const UNREADABLE_MS = 2000;

/** How long one that takes a lock over may hold the right to: one older was left by a crash. */
const TAKING_MS = 30_000;

/**
 * Takes away a lock that was `seen` as it is, and nothing else: one start at a time takes over (the
 * folder `lock.taking`, made or not at all), and only a lock that is still what it read goes. Two
 * starts after a crash never take each other's new lock away.
 */
export async function takeOver(
  lockPath: string,
  seen: string,
  wait: (ms: number) => Promise<void> = sleep,
): Promise<void> {
  const guard = `${lockPath}.taking`;
  try {
    await mkdir(guard, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const age = Date.now() - ((await stat(guard).catch(() => undefined))?.mtimeMs ?? Date.now());
    if (age > TAKING_MS) await rm(guard, { recursive: true, force: true });
    else await wait(200);
    return;
  }
  try {
    const now = await readFile(lockPath, "utf8").catch(() => undefined);
    if (now === seen) await rm(lockPath, { force: true });
  } finally {
    await rm(guard, { recursive: true, force: true });
  }
}

async function answerOf(
  other: LockNote,
  backendPath: string,
  {
    now,
    wait,
    ask,
    waiting,
  }: {
    waiting?: ((pid: number) => void) | undefined;
    now: () => number;
    wait: (ms: number) => Promise<void>;
    ask: NonNullable<LockOptions["ping"]>;
  },
): Promise<Running | { kind: "silent" } | { kind: "notOurs" }> {
  // One that is starting writes backend.json once it answers.
  let told = false;
  for (;;) {
    const backend = await readJson<BackendNote>(backendPath);
    if (backend?.instance === other.instance) {
      const until = now() + ANSWER_MS;
      for (;;) {
        const said = await ask(backend);
        if (said === "ours") return { kind: "running", backend };
        if (now() >= until) return said === "refused" ? { kind: "notOurs" } : { kind: "silent" };
        await wait(500);
      }
    }
    if (now() - other.startedAt >= STARTING_MS) return { kind: "notOurs" };
    if (!told) waiting?.(other.pid);
    told = true;
    await wait(500);
  }
}

function held(note: LockNote, lockPath: string, backendPath: string): HeldLock {
  return {
    note,
    async announce(backend) {
      const full: BackendNote = {
        format: BACKEND_FORMAT,
        instance: note.instance,
        pid: note.pid,
        startedAt: note.startedAt,
        ...backend,
      };
      await writePrivate(backendPath, `${JSON.stringify(full, null, 2)}\n`);
    },
    async release() {
      const backend = await readJson<BackendNote>(backendPath);
      if (backend?.instance === note.instance) await rm(backendPath, { force: true });
      const lock = await readJson<LockNote>(lockPath);
      if (lock?.instance === note.instance) await rm(lockPath, { force: true });
    },
  };
}

/** Reads `backend.json` of a data folder, where there is one. */
export const readBackend = (dir: string) => readJson<BackendNote>(join(dir, BACKEND_FILE));

/** Asks the admin routes of a backend (routes.ts of `@animaquill/server`'s local/). */
export function adminRequest(
  backend: BackendNote,
  method: "GET" | "POST",
  path: "ping" | "open",
  timeoutMs = 3000,
): Promise<{ status: number; body: unknown } | "refused"> {
  return new Promise((done) => {
    const sent = request(
      {
        host: "127.0.0.1",
        port: backend.port,
        method,
        path: `/api/local/admin/${path}`,
        headers: {
          host: new URL(backend.origin).host,
          authorization: `Bearer ${backend.adminKey}`,
          ...(method === "POST" && { "content-length": "0" }),
        },
        timeout: timeoutMs,
      },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => (text += chunk));
        response.on("end", () => {
          let body: unknown;
          try {
            body = JSON.parse(text);
          } catch {
            body = undefined;
          }
          done({ status: response.statusCode ?? 0, body });
        });
        response.on("error", () => done({ status: 0, body: undefined }));
      },
    );
    sent.on("timeout", () => sent.destroy(new Error("timeout")));
    sent.on("error", (error: NodeJS.ErrnoException) =>
      done(error.code === "ECONNREFUSED" ? "refused" : { status: 0, body: undefined }),
    );
    sent.end();
  });
}

/** Whether the backend of a note answers as that start. */
export async function ping(backend: BackendNote): Promise<"ours" | "other" | "refused"> {
  const answer = await adminRequest(backend, "GET", "ping");
  if (answer === "refused") return "refused";
  const body = answer.body as { instance?: unknown } | undefined;
  return answer.status === 200 && body?.instance === backend.instance ? "ours" : "other";
}
