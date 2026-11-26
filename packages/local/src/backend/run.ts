import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildApp } from "@animaquill/server/app.ts";
import { bindingSecretOf, localCredentials } from "@animaquill/server/auth/local-credentials.ts";
import { loadConfig, readIfThere, type Config } from "@animaquill/server/config.ts";
import { createDatabase, MIGRATIONS, migrationsDue } from "@animaquill/server/database.ts";
import { localRoutes } from "@animaquill/server/local/routes.ts";
import { OneTimeTokens } from "@animaquill/server/local/tokens.ts";
import { startServer } from "@animaquill/server/server.ts";
import { upgradeOf } from "@animaquill/server/sync/socket.ts";
import { startWorker } from "@animaquill/server/worker.ts";
import { startLocalServer, type LocalApi, type LocalServer } from "../server.ts";
import { masterKeyOf, passwordOf, prepareDataDir } from "./data-dir.ts";
import { adminRequest, newAdminKey, takeLock, type HeldLock } from "./lock.ts";
import { fileLogger, openLogs, type LogFiles } from "./logs.ts";
import { findPrograms, MAJOR, Postgres, PostgresFailed } from "./postgres.ts";

/**
 * The backend of `npx animaquill` (design O4 of AnimaQuill Cloud): in one process the server of
 * the site (server.ts of this package), the API (`startServer`) and the worker (`startWorker`) of
 * `@animaquill/server`, and PostgreSQL as a program of its own (postgres.ts), for the person who
 * started it alone, without signing in: see `@animaquill/server`'s local/ and
 * auth/local-credentials.ts. Projects are saved to repositories in the data folder, as nothing of
 * GitHub is set up. What the terminal says, `say` says; the rest goes to the log.
 */

export interface BackendOptions {
  readonly dataDir: string;
  readonly port: number;
  readonly version: string;
  /** The built site and the scene page, as the server of this package takes them. */
  readonly site: string;
  readonly scenePage: string;
  /** A PostgreSQL of people's own, as `postgres://user:password@host:port/database`. */
  readonly database?: string | undefined;
  readonly say: (line: string) => void;
}

export interface StartedBackend {
  readonly kind: "started";
  readonly server: LocalServer;
  /** The log of this start. */
  readonly log: string;
  /** The address that signs the browser in, once, for ten minutes. */
  addressToOpen(): string;
  /** Stops it all, within about four seconds: see `stop`. */
  stop(): Promise<void>;
  /** Stops PostgreSQL at once, as after a second Ctrl+C: it recovers as it starts again. */
  stopNow(): Promise<void>;
}

/** Another start of the same data folder answers: its address to open, signed in. */
export interface RunningBackend {
  readonly kind: "running";
  readonly address: string;
}

/** The address of `--database`, as the server's settings take it. */
export function databaseFrom(address: string): Record<string, string> {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    throw new Error("--database has to be an address like postgres://user:password@host:5432/name");
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:")
    throw new Error("--database has to be an address like postgres://user:password@host:5432/name");
  const name = decodeURIComponent(url.pathname.replace(/^\//, ""));
  return {
    DATABASE_HOST: url.hostname.replace(/^\[|\]$/g, ""),
    DATABASE_PORT: url.port || "5432",
    DATABASE_NAME: name || "animaquill",
    DATABASE_USER: decodeURIComponent(url.username) || "animaquill",
    ...(url.password && { DATABASE_PASSWORD: decodeURIComponent(url.password) }),
  };
}

const MIGRATION_COUNT = (): number =>
  (
    JSON.parse(readFileSync(join(MIGRATIONS, "meta", "_journal.json"), "utf8")) as {
      entries: unknown[];
    }
  ).entries.length;

/** A page of whatever was started so far goes again, the latest first. */
type Undo = () => Promise<void>;

export async function startBackend(
  options: BackendOptions,
): Promise<StartedBackend | RunningBackend> {
  const { dataDir } = options;
  // What this process makes is its user's alone: the repositories, the files of assets, the logs.
  if (process.platform !== "win32") process.umask(0o077);
  await prepareDataDir(dataDir);
  const lock = await takeLock(dataDir);
  if ("kind" in lock) {
    const opened = await adminRequest(lock.backend, "POST", "open");
    const url =
      opened !== "refused" && opened.status === 200
        ? (opened.body as { url?: unknown })?.url
        : undefined;
    return { kind: "running", address: typeof url === "string" ? url : `${lock.backend.origin}/` };
  }
  const undo: Undo[] = [() => lock.release()];
  const unwind = async () => {
    for (const step of undo.toReversed()) await step().catch(() => {});
  };
  try {
    return await start(options, lock, undo);
  } catch (error) {
    await unwind();
    throw error;
  }
}

async function start(
  options: BackendOptions,
  lock: HeldLock,
  undo: Undo[],
): Promise<StartedBackend> {
  const { dataDir, say, version } = options;
  const logs: LogFiles = await openLogs(dataDir);
  undo.push(() => logs.close());
  const log = fileLogger(logs.stream, "animaquill");
  let api: LocalApi | undefined;
  const server = await startLocalServer({
    site: options.site,
    scenePage: options.scenePage,
    port: options.port,
    backend: () => api,
  });
  undo.push(() => server.close());
  const editor = server.sites.editor;

  // The database: ours, or the one people gave.
  let postgres: Postgres | undefined;
  let database: Record<string, string>;
  if (options.database === undefined) {
    postgres = new Postgres({
      programs: await findPrograms(),
      dataDir,
      password: await passwordOf(dataDir),
      logFile: logs.postgres,
    });
    const left = await postgres.stopLeftOver();
    if (left !== "none") log.warn({ found: left }, "a PostgreSQL of a start before");
    if (!(await postgres.isMade())) {
      say("第一次准备数据库（几秒）…");
      await postgres.init();
    } else if ((await postgres.version()) !== MAJOR) {
      throw new PostgresFailed(
        "PG_VERSION",
        null,
        `pg${MAJOR}/ has PostgreSQL ${await postgres.version()}`,
      );
    }
    say("启动数据库…");
    const started = postgres;
    undo.push(() => started.stop(4000));
    await postgres.start();
    const { host, port, user, password, database: name } = postgres.connection();
    database = {
      DATABASE_HOST: host,
      DATABASE_PORT: String(port),
      DATABASE_NAME: name,
      DATABASE_USER: user,
      DATABASE_PASSWORD: password,
    };
  } else {
    database = databaseFrom(options.database);
    say("连接数据库…");
  }

  // What the database has, before anything writes to it: a newer version's is refused.
  const check = createDatabase(
    {
      host: database["DATABASE_HOST"]!,
      port: Number(database["DATABASE_PORT"]),
      name: database["DATABASE_NAME"]!,
      user: database["DATABASE_USER"]!,
      password: database["DATABASE_PASSWORD"],
    },
    log,
    "animaquill-local",
  );
  let due: number;
  try {
    due = await migrationsDue(check.db);
    const key = await masterKeyOf(dataDir, due < MIGRATION_COUNT());
    if (key.lost) {
      say("主密钥 master.key 不见了，已生成新的：之前存的 AI key 解不开了，之后要在设置里重新填。");
      log.warn(
        { file: key.path },
        "the master key was made again: what was sealed before cannot be opened",
      );
    }
    if (due > 0) {
      say("更新数据库结构…");
      await check.migrate();
    }
  } finally {
    await check.close().catch(() => {});
  }

  const config: Config = {
    ...loadConfig(
      {
        ...database,
        PUBLIC_ORIGIN: editor,
        AQ_VERSION: version,
        AQ_DATA_DIR: dataDir,
        PLATFORM_MASTER_KEY_FILE: join(dataDir, "master.key"),
        // A computer of people's own: room for files of assets while a few GiB are free.
        LFS_MIN_FREE_GB: "2",
      },
      readIfThere,
    ),
    // Nothing in front of it: whoever connects is who they are.
    trustedProxies: [],
  };
  for (const problem of config.problems) log.info({}, `settings: ${problem}`);
  const masterKey = config.masterKeys?.[0];
  if (!masterKey) throw new Error(`${join(dataDir, "master.key")} is not a master key`);
  const bindingSecret = bindingSecretOf(masterKey.key);
  const tokens = new OneTimeTokens();
  const adminKey = newAdminKey();

  const backend = startServer(config, {
    withoutGitHub: true,
    build: (settings, platform) =>
      buildApp(
        settings,
        {
          ...platform,
          credentials: localCredentials(bindingSecret),
          extend: localRoutes({
            editor,
            tokens,
            bindingSecret,
            adminKey,
            instance: lock.note.instance,
            version,
          }),
        },
        { level: "info", stream: logs.stream },
      ),
    serve: async (app) => {
      await app.ready();
      const upgrade = upgradeOf(app);
      api = {
        request: (request, response) => app.routing(request, response),
        upgrade: (request, socket, head) => {
          if (upgrade) upgrade(request, socket, head);
          else socket.destroy();
        },
      };
    },
  });
  const worker = startWorker(config, { log: fileLogger(logs.stream, "worker") });
  const stopBoth = () =>
    Promise.race([
      Promise.allSettled([backend.stop(), worker.stop()]),
      new Promise((done) => setTimeout(done, 2500)),
    ]);
  undo.push(async () => {
    api = undefined;
    await stopBoth();
  });
  await backend.listen();
  await lock.announce({ version, port: options.port, origin: editor, adminKey });
  await backend.whenReady();

  let stopping: Promise<void> | undefined;
  return {
    kind: "started",
    server,
    log: logs.path,
    addressToOpen: () => `${editor}/#aq-token=${tokens.issue()}`,
    stop() {
      stopping ??= (async () => {
        const until = Date.now() + 4000;
        // No new requests; then the WebSockets, the work behind, and PostgreSQL last.
        server.stopTaking();
        api = undefined;
        await stopBoth();
        await server.close();
        if (postgres) await postgres.stop(Math.max(1000, until - Date.now()));
        await lock.release().catch(() => {});
        await logs.close().catch(() => {});
      })();
      return stopping;
    },
    stopNow: async () => {
      await postgres?.stopNow();
      await lock.release().catch(() => {});
    },
  };
}
