import { lstat, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DataRefused, readManifest } from "@animaquill/server/data/transfer.ts";
import { prepareDataDir, passwordOf } from "./data-dir.ts";
import {
  emptyForImport,
  exportServer,
  exportTarget,
  importServer,
  placeMasterKey,
  readMasterKey,
  undoImport,
  type Connection,
  type ExportSummary,
} from "./data.ts";
import { adminRequest, takeLock, type BackendNote } from "./lock.ts";
import { fileLogger, openLogs } from "./logs.ts";
import { findPrograms, MAJOR, Postgres } from "./postgres.ts";
import { databaseFrom } from "./run.ts";
import { madeFolders } from "./upgrade.ts";

/**
 * `npx animaquill server export <folder>` and `server import <folder>` (design O4 of AnimaQuill
 * Cloud, 3): where the backend of the data folder runs, the export goes through it (it stops
 * syncing for that moment, see `exportWhileRunning` of run.ts); where it does not, this process
 * takes the lock of the data folder, so that none starts meanwhile, and starts its PostgreSQL
 * itself. An import goes only into a data folder that has nothing yet.
 */

export interface DataCommandOptions {
  readonly dataDir: string;
  readonly dir: string;
  readonly version: string;
  /** A PostgreSQL of people's own, as `--database` gives it. */
  readonly database?: string | undefined;
  /** Only import: a master key's file to put into the data folder. */
  readonly masterKey?: string | undefined;
  readonly say: (line: string) => void;
}

const MB = 1024 * 1024;
const sizeText = (bytes: number) =>
  bytes >= 1024 * MB
    ? `${(bytes / 1024 / MB).toFixed(1)} GB`
    : `${Math.max(1, Math.round(bytes / MB))} MB`;

/** What an export took, as people are told. */
export function sayExport(summary: ExportSummary, dataDir: string, say: (line: string) => void) {
  say(`已导出到 ${summary.dir}：${summary.tables} 张表、${summary.rows} 行。`);
  if (summary.repos)
    say(`  本机仓库 ${summary.repos.files} 个文件（${sizeText(summary.repos.bytes)}）。`);
  if (summary.chatImages)
    say(`  对话里的图片 ${summary.chatImages.files} 张（${sizeText(summary.chatImages.bytes)}）。`);
  say(
    `AI 的 key 在里面是加密的，主密钥不在里面：要导入到别处，把 ${join(dataDir, "master.key")} 另存一份，导入时用 --master-key 给它。`,
  );
}

/** Asks the backend that runs to export, waiting as long as it takes. */
async function exportThrough(
  backend: BackendNote,
  dir: string,
  dataDir: string,
  say: (line: string) => void,
): Promise<number> {
  say(
    "AnimaQuill 正在运行：导出期间编辑器连不上服务器、同步暂停，按项目多少可能要几分钟；导完自动恢复，这期间没传上去的改动重连后会补上。",
  );
  const answer = await adminRequest(backend, "POST", "export", 6 * 3600_000, { dir });
  if (answer === "refused" || answer.status === 0) {
    say("AnimaQuill 没有回应，什么都没导出。");
    return 1;
  }
  const body = answer.body as { why?: unknown } & Partial<ExportSummary>;
  if (answer.status !== 200) {
    say(`没导出：${typeof body?.why === "string" ? body.why : `后端回答 ${answer.status}`}`);
    return 1;
  }
  sayExport(body as ExportSummary, dataDir, say);
  return 0;
}

/** Runs `work` on the database of the data folder, its own PostgreSQL started here, or people's. */
async function onDatabase<T>(
  options: DataCommandOptions,
  logFile: string,
  work: (connection: Connection) => Promise<T>,
  init = false,
): Promise<T> {
  if (options.database !== undefined) {
    const given = databaseFrom(options.database);
    return work({
      host: given["DATABASE_HOST"]!,
      port: Number(given["DATABASE_PORT"]),
      user: given["DATABASE_USER"]!,
      password: given["DATABASE_PASSWORD"],
      database: given["DATABASE_NAME"]!,
    });
  }
  const postgres = new Postgres({
    programs: await findPrograms(),
    dataDir: options.dataDir,
    password: await passwordOf(options.dataDir),
    logFile,
  });
  if (!(await postgres.isMade())) {
    if (!init) {
      const older = (await madeFolders(options.dataDir)).filter((major) => major < MAJOR);
      throw new DataRefused(
        older.length > 0
          ? `the database is of PostgreSQL ${older.at(-1)}: start npx animaquill once, which upgrades it, then export`
          : `${options.dataDir} has no database`,
      );
    }
    await postgres.init();
  }
  await postgres.stopLeftOver();
  await postgres.start();
  try {
    return await work(postgres.connection());
  } finally {
    await postgres.stop(4000);
  }
}

/** `server export <folder>`. */
export async function serverExport(options: DataCommandOptions): Promise<number> {
  const { dataDir, say } = options;
  const dir = exportTarget(options.dir, dataDir);
  if (!(await lstat(dataDir).catch(() => undefined))) {
    say(`数据目录 ${dataDir} 不存在，没有可导出的。`);
    return 1;
  }
  await prepareDataDir(dataDir);
  const lock = await takeLock(dataDir, {
    waiting: (pid) => say(`AnimaQuill 好像正在启动（进程 ${pid}），等它启动好…`),
  });
  if ("kind" in lock) return exportThrough(lock.backend, dir, dataDir, say);
  const logs = await openLogs(dataDir);
  try {
    say("导出中…");
    const summary = await onDatabase(options, logs.postgres, (connection) =>
      exportServer(connection, dir, { dataDir, version: options.version }),
    );
    sayExport(summary, dataDir, say);
    return 0;
  } finally {
    await lock.release().catch(() => {});
    await logs.close().catch(() => {});
  }
}

/** `server import <folder>`. */
export async function serverImport(options: DataCommandOptions): Promise<number> {
  const { dataDir, say } = options;
  const dir = resolve(options.dir);
  readManifest(dir);
  const masterKey =
    options.masterKey === undefined ? undefined : await readMasterKey(options.masterKey);
  await prepareDataDir(dataDir);
  await emptyForImport(dataDir);
  const lock = await takeLock(dataDir);
  if ("kind" in lock) {
    say("AnimaQuill 正在用这个数据目录：只能导入到空的数据目录。");
    return 1;
  }
  const before = new Set(await readdir(dataDir));
  const logs = await openLogs(dataDir);
  const log = fileLogger(logs.stream, "import");
  try {
    await emptyForImport(dataDir);
    if (masterKey !== undefined) await placeMasterKey(dataDir, masterKey);
    say("导入中…");
    const done = await onDatabase(
      options,
      logs.postgres,
      (connection) =>
        importServer(connection, dir, { dataDir, log, ...(masterKey && { masterKey }) }),
      true,
    );
    say(
      `已导入到 ${dataDir}：${done.summary.tables} 张表、${done.summary.rows} 行，每张表的行数和摘要都和导出的一样。`,
    );
    if (done.summary.repos) say(`  本机仓库 ${done.summary.repos.files} 个文件。`);
    if (done.summary.chatImages) say(`  对话里的图片 ${done.summary.chatImages.files} 张。`);
    if (masterKey === undefined)
      say("没有给 --master-key：存的 AI key 解不开，启动以后在设置里重新填。");
    else if (done.sealed.opened < done.sealed.total)
      say(
        `给的主密钥只打开了 ${done.sealed.opened}/${done.sealed.total} 个存着的 key，其余的启动以后要在设置里重新填。`,
      );
    say("接着运行 npx animaquill 启动。");
    return 0;
  } catch (error) {
    // Nothing of it stays: the data folder is as empty as it was, but for its logs.
    await undoImport(
      dataDir,
      (await readdir(dataDir)).filter((name) => !before.has(name)),
    ).catch(() => {});
    throw error;
  } finally {
    await lock.release().catch(() => {});
    await logs.close().catch(() => {});
  }
}
