import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { buildApp } from "@animaquill/server/app.ts";
import { bindingSecretOf, localCredentials } from "@animaquill/server/auth/local-credentials.ts";
import { loadConfig, readIfThere, type Config } from "@animaquill/server/config.ts";
import { createDatabase, MIGRATIONS, migrationsDue } from "@animaquill/server/database.ts";
import { localRoutes } from "@animaquill/server/local/routes.ts";
import { OneTimeTokens, TOKEN_MS } from "@animaquill/server/local/tokens.ts";
import { startServer } from "@animaquill/server/server.ts";
import { upgradeOf } from "@animaquill/server/sync/socket.ts";
import { startWorker } from "@animaquill/server/worker.ts";
import { startLocalServer, type LocalApi, type LocalServer } from "../server.ts";
import { ADMIN_PREFIX, type LocalServerState } from "@animaquill/server/local/routes.ts";
import { masterKeyOf, passwordOf, prepareDataDir } from "./data-dir.ts";
import { exportServer, type Connection } from "./data.ts";
import { adminRequest, newAdminKey, takeLock, type HeldLock } from "./lock.ts";
import { fileLogger, openLogs, type LogFiles } from "./logs.ts";
import { checkedOpening, OpenPages, type Opening } from "./open-page.ts";
import {
  findPrograms,
  folderOf,
  MAJOR,
  NoPostgres,
  Postgres,
  PostgresFailed,
  type Programs,
} from "./postgres.ts";
import { serverState } from "./server-state.ts";
import {
  madeFolders,
  settleFolders,
  upgradePostgres,
  upgradingOf,
  type UpgradeFault,
} from "./upgrade.ts";

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
  /** Only tests: the step after which an upgrade of PostgreSQL fails, see upgrade.ts. */
  readonly upgradeFault?: UpgradeFault | undefined;
}

/** The data folder has the database of a newer PostgreSQL than this version brings. */
export class NewerPostgres extends Error {
  override name = "NewerPostgres";
  readonly major: number;
  constructor(major: number) {
    super(`the data folder has PostgreSQL ${major}, this version brings ${MAJOR}`);
    this.major = major;
  }
}

/**
 * The data folder has only the database of a PostgreSQL before this version's, and this version has
 * not that one's programs to upgrade it with.
 */
export class OlderPostgres extends Error {
  override name = "OlderPostgres";
  readonly major: number;
  constructor(major: number) {
    super(`the data folder has PostgreSQL ${major}, which this version cannot upgrade`);
    this.major = major;
  }
}

export interface StartedBackend {
  readonly kind: "started";
  readonly server: LocalServer;
  /** The log of this start. */
  readonly log: string;
  /**
   * What signs the browser in, once, for ten minutes: the address, and the page of the data folder
   * that leads there, which is what the browser is given (open-page.ts).
   */
  addressToOpen(): Promise<Opening>;
  /** Stops it all, within about four seconds: see `stop`. */
  stop(): Promise<void>;
  /** Stops PostgreSQL at once, as after a second Ctrl+C: it recovers as it starts again. */
  stopNow(): Promise<void>;
  /** The data of the server into `dir`, as `server export` asks through the admin routes. */
  exportData(dir: string): Promise<Readonly<Record<string, unknown>> | string>;
}

/** Another start of the same data folder answers: what to open of it, signed in, where it said. */
export interface RunningBackend {
  readonly kind: "running";
  /** The editor's site of that start. */
  readonly editor: string;
  /** Undefined where its answer was not one to open, see `checkedOpening`. */
  readonly opening: Opening | undefined;
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
  for (const warning of (await prepareDataDir(dataDir)).warnings) options.say(warning);
  const lock = await takeLock(dataDir, {
    waiting: (pid) => options.say(`AnimaQuill 好像正在启动（进程 ${pid}），等它启动好…`),
  });
  if ("kind" in lock) {
    const opened = await adminRequest(lock.backend, "POST", "open");
    return {
      kind: "running",
      editor: lock.backend.origin,
      opening:
        opened !== "refused" && opened.status === 200
          ? await checkedOpening(lock.backend, opened.body, dataDir)
          : undefined,
    };
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
  let upgradeFailed: LocalServerState["upgradeFailed"];
  if (options.database === undefined) {
    const ours = await ownPostgres(options, logs.postgres, log);
    postgres = ours.postgres;
    upgradeFailed = ours.upgradeFailed;
    const left = await postgres.stopLeftOver();
    if (left !== "none") log.warn({ found: left }, "a PostgreSQL of a start before");
    if (!(await postgres.isMade())) {
      say("第一次准备数据库（几秒）…");
      await postgres.init();
    } else if ((await postgres.version()) !== postgres.major) {
      throw new PostgresFailed(
        "PG_VERSION",
        null,
        `${folderOf(postgres.major)}/ has PostgreSQL ${await postgres.version()}`,
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
  let madeAgain = false;
  try {
    due = await migrationsDue(check.db);
    const key = await masterKeyOf(dataDir, due < MIGRATION_COUNT());
    madeAgain = key.lost;
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
  // What a start before left of pages with tokens goes; this one's go as their tokens do.
  const pages = new OpenPages(dataDir);
  await pages.removeAll();
  undo.push(() => pages.removeAll());
  const issue = async (): Promise<{ url: string; page: string }> => {
    let page: string | undefined;
    let gone = false;
    const token = tokens.issue(() => {
      gone = true;
      if (page) void pages.remove(page);
    });
    const url = `${editor}/#aq-token=${token}`;
    page = await pages.write(url);
    const written = page;
    if (gone) await pages.remove(written);
    // Its token is too old by then, whether anybody asked for one since or not.
    setTimeout(() => void pages.remove(written), TOKEN_MS + 1000).unref();
    return { url, page: written };
  };
  const adminKey = newAdminKey();

  /** While the data is exported: no requests but the admin's, and no syncing. */
  let paused = false;
  let exporting = false;
  const connection: Connection = {
    host: database["DATABASE_HOST"]!,
    port: Number(database["DATABASE_PORT"]),
    user: database["DATABASE_USER"]!,
    password: database["DATABASE_PASSWORD"],
    database: database["DATABASE_NAME"]!,
  };
  const exportWhileRunning = async (dir: string) => {
    if (exporting) return "an export runs already";
    exporting = true;
    paused = true;
    try {
      backend.closeSyncing();
      // What was on its way as it began lands first; the export is of one moment anyway.
      await new Promise((done) => setTimeout(done, 500));
      const summary = await exportServer(connection, dir, { dataDir, version });
      log.info({ tables: summary.tables, rows: summary.rows }, "the data was exported");
      return { ...summary };
    } catch (error) {
      log.warn({ err: (error as Error).message }, "the data was not exported");
      return (error as Error).message;
    } finally {
      paused = false;
      exporting = false;
    }
  };

  const backend = startServer(config, {
    withoutGitHub: true,
    chatImagesIn: dataDir,
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
            open: issue,
            server: serverState({
              dataDir,
              version,
              major: postgres?.major,
              madeAgain,
              ...(upgradeFailed && { upgradeFailed }),
              // The folder it runs on is never one of those before; this keeps it so.
              running: (name) => postgres !== undefined && name === folderOf(postgres.major),
            }),
            exportData: (dir) => exportWhileRunning(dir),
          }),
        },
        { level: "info", stream: logs.stream },
      ),
    serve: async (app) => {
      await app.ready();
      const upgrade = upgradeOf(app);
      api = {
        request: (request, response) => {
          if (paused && !request.url?.startsWith(`${ADMIN_PREFIX}/`)) {
            response.writeHead(503, {
              "content-type": "application/json; charset=utf-8",
              "retry-after": "2",
              "cache-control": "no-store",
            });
            response.end(JSON.stringify({ error: "unavailable" }));
            return;
          }
          app.routing(request, response);
        },
        upgrade: (request, socket, head) => {
          if (upgrade && !paused) upgrade(request, socket, head);
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
    addressToOpen: async () => {
      const { url, page } = await issue();
      return { url, page: pathToFileURL(page).href };
    },
    stop() {
      stopping ??= (async () => {
        const until = Date.now() + 4000;
        // No new requests; then the WebSockets, the work behind, and PostgreSQL last.
        server.stopTaking();
        api = undefined;
        await stopBoth();
        await server.close();
        if (postgres) await postgres.stop(Math.max(1000, until - Date.now()));
        await pages.removeAll().catch(() => {});
        await lock.release().catch(() => {});
        await logs.close().catch(() => {});
      })();
      return stopping;
    },
    stopNow: async () => {
      await postgres?.stopNow();
      await pages.removeAll().catch(() => {});
      await lock.release().catch(() => {});
    },
    exportData: exportWhileRunning,
  };
}

/**
 * The PostgreSQL of the data folder: this version's, where its folder is there or none is yet;
 * else an upgrade from the one before (upgrade.ts), and where that does not go, the one before, as
 * it was, and why.
 */
async function ownPostgres(
  options: BackendOptions,
  logFile: string,
  log: ReturnType<typeof fileLogger>,
): Promise<{ postgres: Postgres; upgradeFailed?: LocalServerState["upgradeFailed"] }> {
  const { dataDir, say } = options;
  const programs = await findPrograms();
  const ours = async (major = MAJOR, at?: Programs) =>
    new Postgres({
      programs: at ?? programs,
      dataDir,
      major,
      password: await passwordOf(dataDir, major),
      logFile,
    });
  const made = await madeFolders(dataDir);
  if (made.includes(MAJOR)) {
    const staging = new Postgres({
      programs,
      dataDir,
      folderName: upgradingOf(MAJOR),
      password: await passwordOf(dataDir),
      logFile,
    });
    const { named, kept } = await settleFolders(dataDir, staging, log);
    if (named)
      say(`旧版本的数据库留在数据目录的 ${named} 里，确认一切正常后可以在“设置 › 服务器”里删掉。`);
    for (const major of kept)
      say(
        `数据目录里除了 ${folderOf(MAJOR)}/ 还有 ${folderOf(major)}/（PostgreSQL ${major}），它不是这一版升级过来的，AnimaQuill 没有动它，用的是 ${folderOf(MAJOR)}/。要用 ${folderOf(major)}/ 里的数据，先把 ${folderOf(MAJOR)}/ 挪走再启动，会从它升级。`,
      );
    return { postgres: await ours() };
  }
  const newer = made.filter((major) => major > MAJOR);
  if (newer.length > 0) throw new NewerPostgres(newer.at(-1)!);
  const from = made.filter((major) => major < MAJOR).at(-1);
  if (from === undefined) return { postgres: await ours() };
  const before = await findPrograms(undefined, undefined, from).catch((error: unknown) => {
    if (error instanceof NoPostgres) return undefined;
    throw error;
  });
  if (!before) throw new OlderPostgres(from);
  say(`数据库要从 PostgreSQL ${from} 升级到 ${MAJOR}（只做这一次，数据多时要几分钟）…`);
  const outcome = await upgradePostgres({
    dataDir,
    from: { major: from, programs: before },
    to: { programs },
    logFile,
    version: options.version,
    log,
    ...(options.upgradeFault && { fault: options.upgradeFault }),
  });
  if (outcome.kind === "upgraded") {
    say(
      `数据库已升级到 PostgreSQL ${MAJOR}（${outcome.tables} 张表、${outcome.rows} 行，逐表核对过）。原来的留在数据目录的 ${outcome.old} 里，确认一切正常后可以在“设置 › 服务器”里删掉。`,
    );
    return { postgres: await ours() };
  }
  say(
    `数据库没能升级到 PostgreSQL ${MAJOR}，这次照旧用 ${from}，数据没有动；下次启动会再试。原因：${outcome.reason}`,
  );
  return {
    postgres: await ours(from, before),
    upgradeFailed: { from, to: MAJOR, reason: outcome.reason },
  };
}
