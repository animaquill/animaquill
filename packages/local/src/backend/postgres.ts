import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import {
  appendFile,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join, relative, resolve } from "node:path";
import { Client } from "pg";

/**
 * The PostgreSQL of the backend of `npx animaquill` (design O4 of AnimaQuill Cloud, section 1): the
 * programs of `@embedded-postgres/<platform>` (PostgreSQL License), of the exact version the
 * package names, started as programs of their own, never by a library around them. On macOS and
 * Linux `postgres` is started and stopped here, by its signals, without `pg_ctl`, which hands the
 * paths to `sh -c` (a folder named with `$(…)` would run that); on Windows by `pg_ctl`, which
 * starts it with a restricted token where the user is an administrator, and goes through `cmd`:
 * there a data folder with `"` or `%` in its path is refused (`unsafeDataDir` of data-dir.ts).
 *
 * - The first time `initdb` makes `pg18/` (into a folder of its own first, which only becomes
 *   `pg18/` once it is whole), UTF-8 without a locale, with a random password (`pg18.password`).
 * - It listens on 127.0.0.1 only, at a free port of each start, with a password; never on a Unix
 *   socket, so there is none that others of the machine could reach.
 * - It is stopped "fast", and "immediate" where that takes too long.
 * - One that was left running, as when the process was killed, is found by `pg18/postmaster.pid`,
 *   and stopped first: only once it answered with the password, that is, once it is ours. One that
 *   is alive and does not answer so is never signalled, and nothing starts (`LeftOverRunning`).
 */

/** The version of PostgreSQL, the name of its folder in the data folder. */
export const MAJOR = 18;
export const FOLDER = `pg${MAJOR}`;
export const USER = "animaquill";
export const DATABASE = "animaquill";

/** The platforms PostgreSQL comes with, by Node's names. */
const PACKAGES: Readonly<Record<string, string>> = {
  "darwin-arm64": "@embedded-postgres/darwin-arm64",
  "darwin-x64": "@embedded-postgres/darwin-x64",
  "linux-arm64": "@embedded-postgres/linux-arm64",
  "linux-x64": "@embedded-postgres/linux-x64",
  "win32-x64": "@embedded-postgres/windows-x64",
};

export interface Programs {
  readonly initdb: string;
  readonly pgCtl: string;
  readonly postgres: string;
}

/** Why there is no PostgreSQL to start on this machine, for what people are told. */
export class NoPostgres extends Error {
  override name = "NoPostgres";
  readonly reason: "platform" | "musl" | "missing" | "links" | "path";
  constructor(reason: NoPostgres["reason"], message: string) {
    super(message);
    this.reason = reason;
  }
}

/**
 * Whether a path has what a shell or `cmd` reads inside double quotes: initdb starts `postgres`
 * with its path in such a string everywhere, and `pg_ctl` on Windows the data folder too.
 */
export const unsafePath = (path: string, platform: NodeJS.Platform = process.platform): boolean =>
  platform === "win32" ? /["%\r\n]/.test(path) : /["`$\\\r\n]/.test(path);

const exe = (name: string) => (process.platform === "win32" ? `${name}.exe` : name);

/**
 * The programs, with the links between the libraries made where they are not (the package makes
 * them as it is installed, which `ignore-scripts` and pnpm do not let it).
 */
export async function findPrograms(
  from: string = import.meta.url,
  platform: string = `${process.platform}-${process.arch}`,
): Promise<Programs> {
  const name = PACKAGES[platform];
  if (!name) throw new NoPostgres("platform", platform);
  if (platform.startsWith("linux-") && !isGlibc())
    throw new NoPostgres("musl", "PostgreSQL here needs glibc");
  let root: string;
  try {
    root = resolve(dirname(createRequire(from).resolve(name)), "..");
  } catch {
    throw new NoPostgres("missing", `${name} is not installed`);
  }
  if (unsafePath(root))
    throw new NoPostgres(
      "path",
      `PostgreSQL is in a folder whose name a shell would read: ${root}`,
    );
  await makeLinks(root);
  const bin = join(root, "native", "bin");
  return {
    initdb: join(bin, exe("initdb")),
    pgCtl: join(bin, exe("pg_ctl")),
    postgres: join(bin, exe("postgres")),
  };
}

const isGlibc = () => {
  const header = (process.report?.getReport() as { header?: { glibcVersionRuntime?: string } })
    ?.header;
  return typeof header?.glibcVersionRuntime === "string";
};

/** The links of `native/pg-symlinks.json` of the package that are not there yet. */
export async function makeLinks(root: string): Promise<void> {
  let links: { source: string; target: string }[];
  try {
    links = JSON.parse(await readFile(join(root, "native", "pg-symlinks.json"), "utf8"));
  } catch {
    return;
  }
  for (const { source, target } of links) {
    const from = resolve(root, source);
    const to = resolve(root, target);
    // Only inside the package.
    if (relative(root, from).startsWith("..") || relative(root, to).startsWith("..")) continue;
    const there = await lstat(to).catch(() => undefined);
    if (there) continue;
    try {
      await symlink(relative(dirname(to), from), to);
    } catch (error) {
      throw new NoPostgres(
        "links",
        `the libraries of PostgreSQL could not be linked in ${root}: ${(error as Error).message}`,
      );
    }
  }
}

/**
 * What runs a program of PostgreSQL to its end: its output, for the log and for what went wrong.
 * The output goes through a file of the logs of the data folder, never a pipe: `pg_ctl start`
 * leaves PostgreSQL running, which on Windows inherits the handles of `pg_ctl`, and would hold a
 * pipe open for as long as it runs.
 */
async function run(
  program: string,
  args: readonly string[],
  outputFile: string,
  timeoutMs?: number,
): Promise<{ code: number | null; output: string }> {
  const file = await open(outputFile, "a", 0o600);
  const from = (await file.stat()).size;
  try {
    const { code } = await new Promise<{ code: number | null }>((done, fail) => {
      const child = spawn(program, [...args], {
        env: ownEnvironment(),
        stdio: ["ignore", file.fd, file.fd],
        windowsHide: true,
      });
      const timer =
        timeoutMs === undefined ? undefined : setTimeout(() => child.kill("SIGKILL"), timeoutMs);
      child.on("error", (error) => {
        clearTimeout(timer);
        fail(error);
      });
      child.on("exit", (exitCode) => {
        clearTimeout(timer);
        done({ code: exitCode });
      });
    });
    return { code, output: await tailOf(outputFile, from) };
  } finally {
    await file.close();
  }
}

/** What PostgreSQL would take from the environment of whoever started this, it does not. */
const ownEnvironment = () => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("PG"))),
  LC_ALL: "C",
});

/** What a log has after `from` bytes. */
async function tailOf(path: string, from: number): Promise<string> {
  const text = await readFile(path).catch(() => Buffer.alloc(0));
  return text.subarray(from).toString();
}

/** PostgreSQL did not do what it was asked: what it said is in `output` and the log. */
export class PostgresFailed extends Error {
  override name = "PostgresFailed";
  readonly output: string;
  /** Windows: a library it needs is not there (0xC0000135), as the Visual C++ runtime. */
  readonly missingLibrary: boolean;
  constructor(what: string, code: number | null, output: string) {
    super(`${what} ended with ${code}: ${output.trim().split("\n").slice(-3).join(" | ")}`);
    this.output = output;
    this.missingLibrary = code === 3221225781 || code === -1073741515;
  }
}

/**
 * A PostgreSQL of this data folder runs, and does not answer with our password: it may be
 * recovering, stopped (`kill -STOP`), or `pg18.password` was changed. It is left alone, and nothing
 * starts on the folder meanwhile, as a second one would be refused by its shared memory anyway.
 */
export class LeftOverRunning extends Error {
  override name = "LeftOverRunning";
  readonly pid: number;
  constructor(pid: number) {
    super(`a PostgreSQL of this data folder (process ${pid}) runs and does not answer`);
    this.pid = pid;
  }
}

/** A port of 127.0.0.1 nobody listens on now. */
export const freePort = (): Promise<number> =>
  new Promise((done, fail) => {
    const server = createServer();
    server.once("error", fail);
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
      const { port } = server.address() as { port: number };
      server.close(() => done(port));
    });
  });

export interface PostgresOptions {
  readonly programs: Programs;
  /** The data folder of the backend: `pg18/` is in it. */
  readonly dataDir: string;
  readonly password: string;
  /** The log of PostgreSQL; what `initdb` and `pg_ctl` say goes next to it (`.ctl`). */
  readonly logFile: string;
  /** Only tests: how long a PostgreSQL left running has to answer. */
  readonly answerMs?: number;
}

/** Where a log is longer than this as PostgreSQL starts, the one before is kept, and no more. */
const LOG_MOST = 10 * 1024 * 1024;

const CONFIG = `
# Written by AnimaQuill: only this machine, by TCP with a password, never a Unix socket.
listen_addresses = '127.0.0.1'
unix_socket_directories = ''
max_connections = 100
`;

const HBA = `# Written by AnimaQuill: only this machine, only its user, only with the password.
host all ${USER} 127.0.0.1/32 scram-sha-256
`;

const windows = () => process.platform === "win32";
const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/** What `postmaster.pid` says: the process, its port, and whether it is ready. */
async function postmasterOf(folder: string) {
  let text: string;
  try {
    text = await readFile(join(folder, "postmaster.pid"), "utf8");
  } catch {
    return undefined;
  }
  const lines = text.split("\n");
  return { pid: Number(lines[0]), port: Number(lines[3]), status: (lines[7] ?? "").trim() };
}

export class Postgres {
  readonly #options: PostgresOptions;
  #port: number | undefined;

  constructor(options: PostgresOptions) {
    this.#options = options;
  }

  get folder(): string {
    return join(this.#options.dataDir, FOLDER);
  }

  /** The port it listens on, once started. */
  get port(): number {
    if (this.#port === undefined) throw new Error("PostgreSQL is not started");
    return this.#port;
  }

  get #ctlLog(): string {
    return `${this.#options.logFile}.ctl`;
  }

  /** Whether `pg18/` is there, made whole. */
  async isMade(): Promise<boolean> {
    return (await lstat(join(this.folder, "PG_VERSION")).catch(() => undefined)) !== undefined;
  }

  /** The version of what is in `pg18/`, which has to be this one's, see `MAJOR`. */
  async version(): Promise<number> {
    return Number((await readFile(join(this.folder, "PG_VERSION"), "utf8")).trim());
  }

  /** Makes `pg18/`, the first time. */
  async init(): Promise<void> {
    await mkdir(dirname(this.#options.logFile), { recursive: true });
    const making = join(this.#options.dataDir, `${FOLDER}.making`);
    await rm(making, { recursive: true, force: true });
    // initdb reads the password from a file, of its own for the moment.
    const passwordFile = `${making}.pw`;
    await writeFile(passwordFile, `${this.#options.password}\n`, { mode: 0o600 });
    let made;
    try {
      made = await run(
        this.#options.programs.initdb,
        [
          "-D",
          making,
          "-U",
          USER,
          `--pwfile=${passwordFile}`,
          "--auth=scram-sha-256",
          "--encoding=UTF8",
          "--no-locale",
          "--no-instructions",
        ],
        this.#ctlLog,
      );
    } finally {
      await rm(passwordFile, { force: true });
    }
    if (made.code !== 0) throw new PostgresFailed("initdb", made.code, made.output);
    await appendFile(join(making, "postgresql.conf"), CONFIG);
    await writeFile(join(making, "pg_hba.conf"), HBA);
    await rename(making, this.folder);
  }

  /** Starts it, and makes its database where there is none. */
  async start(): Promise<void> {
    await mkdir(dirname(this.#options.logFile), { recursive: true });
    for (const log of [this.#options.logFile, this.#ctlLog])
      if (((await stat(log).catch(() => undefined))?.size ?? 0) > LOG_MOST)
        await rename(log, `${log}.old`).catch(() => {});
    for (let attempt = 0; ; attempt++) {
      const port = await freePort();
      const from = (await stat(this.#options.logFile).catch(() => undefined))?.size ?? 0;
      const started = windows() ? await this.#startByPgCtl(port) : await this.#startHere(port);
      if (started.code === 0) {
        this.#port = port;
        break;
      }
      // Someone took the port meanwhile: another one.
      const log = await tailOf(this.#options.logFile, from);
      if (attempt < 2 && /could not bind|Address already in use/i.test(log)) continue;
      throw new PostgresFailed("postgres", started.code, `${started.output}\n${log.slice(-2000)}`);
    }
    await this.#makeDatabase();
  }

  /** Windows: `pg_ctl start`, which waits until it is ready. */
  #startByPgCtl(port: number) {
    return run(
      this.#options.programs.pgCtl,
      [
        "start",
        "-w",
        "-t",
        "120",
        "-D",
        this.folder,
        "-l",
        this.#options.logFile,
        "-o",
        `-p ${port}`,
      ],
      this.#ctlLog,
    );
  }

  /**
   * macOS and Linux: `postgres` itself, as a process of its own (a session of its own, so that
   * Ctrl+C in the terminal reaches only this process, which stops it in its order), its output
   * into the log; ready once `postmaster.pid` says so, as `pg_ctl -w` waits.
   */
  async #startHere(port: number): Promise<{ code: number | null; output: string }> {
    const log = await open(this.#options.logFile, "a", 0o600);
    let child;
    try {
      child = spawn(this.#options.programs.postgres, ["-D", this.folder, "-p", String(port)], {
        env: ownEnvironment(),
        stdio: ["ignore", log.fd, log.fd],
        detached: true,
      });
    } finally {
      await log.close();
    }
    child.unref();
    let exited: number | null | undefined;
    child.on("exit", (code) => (exited = code ?? 1));
    child.on("error", () => (exited = 1));
    const until = Date.now() + 120_000;
    for (;;) {
      if (exited !== undefined) return { code: exited === 0 ? 1 : exited, output: "" };
      const found = await postmasterOf(this.folder);
      if (found && found.pid === child.pid && found.status === "ready")
        return { code: 0, output: "" };
      if (Date.now() > until) {
        if (child.pid) process.kill(child.pid, "SIGQUIT");
        return { code: 1, output: "PostgreSQL was not ready in two minutes" };
      }
      await sleep(100);
    }
  }

  /** How to reach it, as the server's settings have it. */
  connection(database = DATABASE) {
    return {
      host: "127.0.0.1",
      port: this.port,
      user: USER,
      password: this.#options.password,
      database,
    };
  }

  async #makeDatabase() {
    const client = new Client({ ...this.connection("postgres"), connectionTimeoutMillis: 10_000 });
    await client.connect();
    try {
      const found = await client.query("select 1 from pg_database where datname = $1", [DATABASE]);
      if (found.rowCount === 0) await client.query(`create database ${DATABASE}`);
    } finally {
      await client.end();
    }
  }

  /** Stops it: fast, and at once where that takes longer than `ms`. */
  async stop(ms: number): Promise<void> {
    if (windows()) {
      const seconds = String(Math.max(1, Math.round(ms / 1000)));
      const fast = await run(
        this.#options.programs.pgCtl,
        ["stop", "-D", this.folder, "-m", "fast", "-w", "-t", seconds],
        this.#ctlLog,
        ms + 2000,
      ).catch(() => ({ code: 1, output: "" }));
      if (fast.code === 0 || !(await postmasterOf(this.folder))) return;
      await this.stopNow();
      return;
    }
    // SIGINT is what `pg_ctl stop -m fast` sends, SIGQUIT what `-m immediate` does.
    const found = await postmasterOf(this.folder);
    if (!found || !isAlive(found.pid)) return;
    if (await this.#signal(found.pid, "SIGINT", ms)) return;
    await this.#signal(found.pid, "SIGQUIT", 5000);
  }

  /** Stops it at once ("immediate"): it recovers from its log as it starts again. */
  async stopNow(): Promise<void> {
    if (windows()) {
      await run(
        this.#options.programs.pgCtl,
        ["stop", "-D", this.folder, "-m", "immediate", "-w", "-t", "3"],
        this.#ctlLog,
        4000,
      ).catch(() => undefined);
      return;
    }
    const found = await postmasterOf(this.folder);
    if (found && isAlive(found.pid)) await this.#signal(found.pid, "SIGQUIT", 3000);
  }

  /** Sends a signal, and resolves to whether the process is gone within `ms`. */
  async #signal(pid: number, signal: NodeJS.Signals, ms: number): Promise<boolean> {
    try {
      process.kill(pid, signal);
    } catch {
      return !isAlive(pid);
    }
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (!isAlive(pid)) return true;
      await sleep(50);
    }
    return !isAlive(pid);
  }

  /**
   * One left running by a start before, as when that process was killed: stopped, once it showed
   * it is ours. Resolves to what was found, for the log; throws `LeftOverRunning` for one that runs
   * and does not answer as ours, which is left alone.
   */
  async stopLeftOver(): Promise<"none" | "stopped" | "stale"> {
    const found = await postmasterOf(this.folder);
    if (!found) return "none";
    if (!Number.isInteger(found.pid) || found.pid <= 0 || !isAlive(found.pid)) return "stale";
    if (
      Number.isInteger(found.port) &&
      found.port > 0 &&
      (await answersAsOurs(found.port, this.#options.password, this.#options.answerMs ?? 10_000))
    ) {
      this.#port = found.port;
      await this.stop(4000);
      return "stopped";
    }
    throw new LeftOverRunning(found.pid);
  }
}

export const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/**
 * Whether a PostgreSQL that takes our password listens there; one that says it is starting or
 * stopping is PostgreSQL too, and is waited for. Anything else is not ours.
 */
async function answersAsOurs(port: number, password: string, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  for (;;) {
    const client = new Client({
      host: "127.0.0.1",
      port,
      user: USER,
      password,
      database: "postgres",
      connectionTimeoutMillis: Math.max(500, Math.min(3000, until - Date.now())),
    });
    try {
      await client.connect();
      return true;
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      // Starting up, or recovering: ours, once it is through.
      if ((code !== "57P03" && code !== "57P01") || Date.now() >= until) return false;
      await sleep(500);
    } finally {
      await client.end().catch(() => {});
    }
  }
}
