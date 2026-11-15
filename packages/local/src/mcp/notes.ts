import { randomBytes } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { SCRATCH_FOLDER, type DiskWriter } from "@animaquill/core/disk-folder";
import type { Written } from "./folder-project.ts";

/**
 * What the local MCP leaves next to the project, in `.animaquill/`, which goes into neither Git nor
 * syncing: notes on the batches it wrote, so that the editor can tell which tool changed a file and
 * take a batch back as a whole, and a file for each connection that is on, so that it can show who
 * is connected. Both are for the editor of this computer only, and say nothing it would miss.
 */

/** Keeps .animaquill out of Git, as the editor does, without changing the .gitignore of the project. */
export const IGNORE_FILE = ".animaquill/.gitignore";
export const BATCHES_FOLDER = ".animaquill/batches";
export const CONNECTIONS_FOLDER = ".animaquill/mcp";

/** Two writes of one connection this close together are one batch: one task of the AI tool. */
export const BATCH_GAP_MS = 10 * 60 * 1000;
/** How long notes on batches are kept, and how many at the most. */
export const KEEP_BATCHES_MS = 7 * 24 * 60 * 60 * 1000;
export const MOST_BATCHES = 200;
/** How often a connection says it is still there, and how long until one that did not is gone. */
export const ALIVE_EVERY_MS = 30 * 1000;
export const GONE_AFTER_MS = 2 * 60 * 1000;

/** Who is on the other end: the AI tool, as it names itself (`clientInfo`). */
export interface ClientName {
  readonly name: string;
  readonly version?: string;
}

/** What `.animaquill/batches/<batch>.json` holds. */
export interface BatchNote {
  readonly format: 1;
  readonly batch: string;
  /** The connection it was written in, see `ConnectionNote`. */
  readonly session: string;
  readonly client: ClientName | undefined;
  /** In milliseconds since 1970. */
  readonly startedAt: number;
  readonly updatedAt: number;
  /**
   * Each file it wrote, as it left it: SHA-256 of its text in hex, or null where it took the file
   * away. A file that holds something else now was changed again since, by somebody else.
   */
  readonly files: Readonly<Record<string, string | null>>;
}

/** What `.animaquill/mcp/<session>.json` holds while a connection is on. */
export interface ConnectionNote {
  readonly format: 1;
  readonly session: string;
  readonly client: ClientName | undefined;
  readonly pid: number;
  readonly startedAt: number;
  /** Updated every `ALIVE_EVERY_MS`: one older than `GONE_AFTER_MS` is of a connection that is gone. */
  readonly aliveAt: number;
}

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

export const newId = (): string => randomBytes(6).toString("hex");

/** Where the editor keeps what is not to go into Git, made once. */
async function ensureIgnored(writer: DiskWriter): Promise<void> {
  if (!(await writer.stat(IGNORE_FILE))) await writer.write(IGNORE_FILE, "*\n");
}

/** The notes of one connection on its batches. */
export class BatchNotes {
  readonly #writer: DiskWriter;
  readonly #folder: string;
  readonly #session: string;
  readonly #now: () => number;
  #note: BatchNote | undefined;

  /** `folder`: the project folder that `writer` writes. */
  constructor(writer: DiskWriter, folder: string, session: string, now: () => number = Date.now) {
    this.#writer = writer;
    this.#folder = folder;
    this.#session = session;
    this.#now = now;
  }

  /** The batch that the last write went into. */
  get current(): BatchNote | undefined {
    return this.#note;
  }

  /** Writes down what a write left: in the batch it goes on with, or in a new one after a pause. */
  async note(written: readonly Written[], client: ClientName | undefined): Promise<BatchNote> {
    const now = this.#now();
    const last = this.#note;
    const goesOn = last !== undefined && now - last.updatedAt <= BATCH_GAP_MS;
    const files = { ...(goesOn ? last.files : {}) };
    for (const { path, hash } of written) files[path] = hash ?? null;
    const note: BatchNote = {
      format: 1,
      batch: goesOn
        ? last.batch
        : `${new Date(now).toISOString().replaceAll(/[:.]/g, "-")}-${newId()}`,
      session: this.#session,
      client: client ?? last?.client,
      startedAt: goesOn ? last.startedAt : now,
      updatedAt: now,
      files,
    };
    await ensureIgnored(this.#writer);
    await this.#writer.write(`${BATCHES_FOLDER}/${note.batch}.json`, json(note));
    this.#note = note;
    if (!goesOn) await this.#tidy(now);
    return note;
  }

  /** Keeps the last `MOST_BATCHES` notes of this folder, of the last `KEEP_BATCHES_MS`. */
  async #tidy(now: number): Promise<void> {
    // Only notes that are what this writes: named by their batch, with when they were written.
    // Anything else in the folder is somebody else's, and stays.
    const ours = (await namedNotes<BatchNote>(this.#folder, BATCHES_FOLDER)).filter(
      ({ name, note }) =>
        note.format === 1 && name === `${note.batch}.json` && Number.isFinite(note.updatedAt),
    );
    const kept = ours.toSorted((a, b) => b.note.updatedAt - a.note.updatedAt);
    for (const [index, { name, note }] of kept.entries()) {
      if (index < MOST_BATCHES && now - note.updatedAt <= KEEP_BATCHES_MS) continue;
      await this.#writer.remove(`${BATCHES_FOLDER}/${name}`);
    }
  }
}

const isNamed = (name: string) => /^[A-Za-z0-9_-]+\.json$/.test(name);

async function namedNotes<T>(
  folder: string,
  inside: string,
): Promise<{ readonly name: string; readonly note: T }[]> {
  let names: string[];
  try {
    names = await readdir(join(folder, inside));
  } catch {
    return [];
  }
  const notes: { name: string; note: T }[] = [];
  for (const name of names.filter(isNamed)) {
    try {
      const note = JSON.parse(await readFile(join(folder, inside, name), "utf8")) as T;
      if (typeof note === "object" && note !== null) notes.push({ name, note });
    } catch {
      // Half written, or not ours: it says nothing.
    }
  }
  return notes;
}

const readNotes = async <T>(folder: string, inside: string): Promise<T[]> =>
  (await namedNotes<T>(folder, inside)).map(({ note }) => note);

/** How long what a write left in `.animaquill/tmp` and a file of a connection stay at the most. */
export const LEFT_PART_MS = 24 * 60 * 60 * 1000;
export const LEFT_CONNECTION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Takes away what a server that was stopped left: halves of writes (`.part`) older than a day, and
 * files of connections that said nothing for a week. Only names this server makes.
 */
export async function tidyLeftovers(
  folder: string,
  writer: DiskWriter,
  now: number = Date.now(),
): Promise<void> {
  const old = async (inside: string, pattern: RegExp, age: number) => {
    let names: string[];
    try {
      names = await readdir(join(folder, inside));
    } catch {
      return;
    }
    for (const name of names.filter((each) => pattern.test(each))) {
      const path = `${inside}/${name}`;
      const seen = await writer.stat(path).catch(() => undefined);
      if (seen && now - seen.mtimeMs > age) await writer.remove(path).catch(() => {});
    }
  };
  await old(SCRATCH_FOLDER, /^[0-9a-f]{16}\.part$/, LEFT_PART_MS);
  await old(CONNECTIONS_FOLDER, /^[0-9a-f]{12}\.json$/, LEFT_CONNECTION_MS);
}

/** The notes on batches in a project folder. */
export const readBatchNotes = (folder: string): Promise<BatchNote[]> =>
  readNotes<BatchNote>(folder, BATCHES_FOLDER).then((notes) =>
    notes.filter((note) => note.format === 1 && typeof note.batch === "string"),
  );

/** The connections that are on in a project folder: those that said so in the last two minutes. */
export async function readConnections(
  folder: string,
  now: number = Date.now(),
): Promise<ConnectionNote[]> {
  const notes = await readNotes<ConnectionNote>(folder, CONNECTIONS_FOLDER);
  return notes.filter(
    (note) =>
      note.format === 1 && typeof note.aliveAt === "number" && now - note.aliveAt <= GONE_AFTER_MS,
  );
}

/** The file of one connection, kept up to date while it is on and taken away as it ends. */
export class ConnectionFile {
  readonly #writer: DiskWriter;
  readonly #note: Omit<ConnectionNote, "aliveAt" | "client">;
  readonly #now: () => number;
  #client: ClientName | undefined;
  #timer: ReturnType<typeof setInterval> | undefined;
  #closed = false;

  constructor(writer: DiskWriter, session: string, now: () => number = Date.now) {
    this.#writer = writer;
    this.#now = now;
    this.#note = { format: 1, session, pid: process.pid, startedAt: now() };
  }

  get path(): string {
    return `${CONNECTIONS_FOLDER}/${this.#note.session}.json`;
  }

  /** Starts saying that the connection is on, every `ALIVE_EVERY_MS`. */
  async start(): Promise<void> {
    await this.#write();
    this.#timer = setInterval(() => void this.#write().catch(() => {}), ALIVE_EVERY_MS);
    this.#timer.unref();
  }

  /** The AI tool said who it is. */
  async named(client: ClientName): Promise<void> {
    if (this.#client?.name === client.name && this.#client.version === client.version) return;
    this.#client = client;
    if (this.#timer) await this.#write();
  }

  async #write(): Promise<void> {
    if (this.#closed) return;
    await ensureIgnored(this.#writer);
    const note: ConnectionNote = { ...this.#note, client: this.#client, aliveAt: this.#now() };
    await this.#writer.write(this.path, json(note));
  }

  async close(): Promise<void> {
    this.#closed = true;
    if (this.#timer) clearInterval(this.#timer);
    await this.#writer.remove(this.path).catch(() => {});
  }
}
