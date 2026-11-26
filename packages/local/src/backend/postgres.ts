import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import {
  lstat,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
  appendFile,
  mkdir,
} from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join, relative, resolve } from "node:path";
import { Client } from "pg";

/**
 * The PostgreSQL of the backend of `npx animaquill` (design O4 of AnimaQuill Cloud, section 1): the
 * programs of `@embedded-postgres/<platform>` (PostgreSQL License), of the exact version the
 * package names, started by `pg_ctl` as programs of their own, never by a library around them.
 *
 * - The first time `initdb` makes `pg18/` (into a folder of its own first, which only becomes
 *   `pg18/` once it is whole), UTF-8 without a locale, with a random password (`pg18.password`).
 * - It listens on 127.0.0.1 only, at a free port of each start, with a password; never on a Unix
 *   socket, so there is none that others of the machine could reach.
 * - It is stopped "fast", and "immediate" where that takes too long.
 * - One that was left running, as when the process was killed, is found by `pg18/postmaster.pid`,
 *   and stopped first: only once it answered with the password, that is, once it is ours. A
 *   process of that number that is not, after a restart of the machine say, is never signalled.
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
  readonly reason: "platform" | "musl" | "missing" | "links";
  constructor(reason: NoPostgres["reason"], message: string) {
    super(message);
    this.reason = reason;
  }
}

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

/** What runs a program of PostgreSQL: its output, for the log and for what went wrong. */
async function run(
  program: string,
  args: readonly string[],
  options: { readonly detached?: boolean; readonly timeoutMs?: number } = {},
): Promise<{ code: number | null; output: string }> {
  // What PostgreSQL would take from the environment of whoever started this, it does not.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("PG")),
  );
  return new Promise((done, fail) => {
    const child = spawn(program, [...args], {
      env: { ...env, LC_ALL: "C" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      // A process group of its own, so that Ctrl+C in the terminal reaches only this process,
      // which stops PostgreSQL in its order.
      detached: options.detached === true && process.platform !== "win32",
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
    const timer =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => child.kill("SIGKILL"), options.timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      fail(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ code, output });
    });
  });
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
  /** The log of PostgreSQL. */
  readonly logFile: string;
}

const CONFIG = `
# Written by AnimaQuill: only this machine, by TCP with a password, never a Unix socket.
listen_addresses = '127.0.0.1'
unix_socket_directories = ''
max_connections = 100
`;

const HBA = `# Written by AnimaQuill: only this machine, only its user, only with the password.
host all ${USER} 127.0.0.1/32 scram-sha-256
`;

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
    const making = join(this.#options.dataDir, `${FOLDER}.making`);
    await rm(making, { recursive: true, force: true });
    // initdb reads the password from a file, of its own for the moment.
    const passwordFile = `${making}.pw`;
    await writeFile(passwordFile, `${this.#options.password}\n`, { mode: 0o600 });
    const made = await run(this.#options.programs.initdb, [
      "-D",
      making,
      "-U",
      USER,
      `--pwfile=${passwordFile}`,
      "--auth=scram-sha-256",
      "--encoding=UTF8",
      "--no-locale",
      "--no-instructions",
    ]);
    await rm(passwordFile, { force: true });
    if (made.code !== 0) throw new PostgresFailed("initdb", made.code, made.output);
    await appendFile(join(making, "postgresql.conf"), CONFIG);
    await writeFile(join(making, "pg_hba.conf"), HBA);
    await rename(making, this.folder);
  }

  /** Starts it, and makes its database where there is none. */
  async start(): Promise<void> {
    await mkdir(dirname(this.#options.logFile), { recursive: true });
    for (let attempt = 0; ; attempt++) {
      const port = await freePort();
      const started = await run(
        this.#options.programs.pgCtl,
        [
          "start",
          "-w",
          "-t",
          "60",
          "-D",
          this.folder,
          "-l",
          this.#options.logFile,
          "-o",
          `-p ${port}`,
        ],
        { detached: true },
      );
      if (started.code === 0) {
        this.#port = port;
        break;
      }
      // Someone took the port meanwhile: another one.
      const log = await readFile(this.#options.logFile, "utf8").catch(() => "");
      if (attempt < 2 && /could not bind|Address already in use/i.test(log.slice(-2000))) continue;
      throw new PostgresFailed(
        "pg_ctl start",
        started.code,
        `${started.output}\n${log.slice(-2000)}`,
      );
    }
    await this.#makeDatabase();
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
    const client = new Client({
      ...this.connection("postgres"),
      connectionTimeoutMillis: 10_000,
    });
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
    const seconds = Math.max(1, Math.round(ms / 1000));
    const fast = await run(
      this.#options.programs.pgCtl,
      ["stop", "-D", this.folder, "-m", "fast", "-w", "-t", String(seconds)],
      {
        timeoutMs: ms + 2000,
      },
    ).catch(() => ({ code: 1, output: "" }));
    if (fast.code === 0 || !(await this.#running())) return;
    await run(
      this.#options.programs.pgCtl,
      ["stop", "-D", this.folder, "-m", "immediate", "-w", "-t", "5"],
      {
        timeoutMs: 8000,
      },
    ).catch(() => undefined);
  }

  /** Stops it at once ("immediate"): it recovers from its log as it starts again. */
  async stopNow(): Promise<void> {
    await run(
      this.#options.programs.pgCtl,
      ["stop", "-D", this.folder, "-m", "immediate", "-w", "-t", "3"],
      {
        timeoutMs: 4000,
      },
    ).catch(() => undefined);
  }

  async #running(): Promise<boolean> {
    return (await lstat(join(this.folder, "postmaster.pid")).catch(() => undefined)) !== undefined;
  }

  /**
   * One left running by a start before, as when that process was killed: stopped, once it showed
   * it is ours. Resolves to what was found, for the log.
   */
  async stopLeftOver(): Promise<"none" | "stopped" | "stale" | "foreign"> {
    const file = join(this.folder, "postmaster.pid");
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch {
      return "none";
    }
    const lines = text.split("\n");
    const pid = Number(lines[0]);
    const port = Number(lines[3]);
    if (!Number.isInteger(pid) || pid <= 0 || !isAlive(pid)) return "stale";
    if (Number.isInteger(port) && port > 0 && (await answersAsOurs(port, this.#options.password))) {
      this.#port = port;
      await this.stop(4000);
      return "stopped";
    }
    // A process of that number that is no PostgreSQL of ours: it is left alone, and so is the file
    // PostgreSQL would refuse to start by.
    await rename(file, `${file}.${Date.now()}.not-ours`);
    return "foreign";
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
 * stopping is PostgreSQL too. Anything else is not ours.
 */
async function answersAsOurs(port: number, password: string): Promise<boolean> {
  const client = new Client({
    host: "127.0.0.1",
    port,
    user: USER,
    password,
    database: "postgres",
    connectionTimeoutMillis: 3000,
  });
  try {
    await client.connect();
    return true;
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    return code === "57P03" || code === "57P01";
  } finally {
    await client.end().catch(() => {});
  }
}
