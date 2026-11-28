import { lstat, readdir, readFile, rename, rm, rmdir, statfs, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "pg";
import {
  createDatabase,
  migrationsDue,
  SERVER_MIGRATIONS,
  type Logger,
} from "@animaquill/server/database.ts";
import {
  DataRefused,
  exportData,
  importData,
  migrationsOfCode,
  verifyData,
} from "@animaquill/server/data/transfer.ts";
import { passwordOf } from "./data-dir.ts";
import { folderOf, LeftOverRunning, MAJOR, Postgres, type Programs } from "./postgres.ts";

/**
 * A new major version of the PostgreSQL of `npx animaquill` (design O4 of AnimaQuill Cloud, 3.4):
 * the folders of two major versions cannot be read by each other, and the package has neither
 * `pg_upgrade` nor `pg_dump`. So the version that brings a new one depends on the one before too
 * (`packageOf` of postgres.ts), and the first time it starts on a data folder that has only the
 * folder of the one before (`pg17/`):
 *
 * 1. starts the one before on it, brings its tables to this version's migrations, and exports the
 *    data of the server (data/transfer.ts of `@animaquill/server`) into `upgrade/` of the data
 *    folder, then stops it;
 * 2. makes the folder of the new one beside, as `pg18.upgrading/`, starts it, migrates, imports,
 *    and compares every table, its rows and their digest, with the export; stops it;
 * 3. only then: `pg18.upgrading/` becomes `pg18/`, and `pg17/` becomes `pg17.old/`, which stays
 *    until people take it away ("设置 › 服务器").
 *
 * Whatever fails on the way, nothing of the one before was renamed or taken away: the backend goes
 * on with the one before, and says why; the next start tries again. What a try that stopped
 * halfway left (`pg18.upgrading/`, `upgrade/`) goes as the next one begins. The repositories and
 * the pictures of conversations stay where they are: they are not in the database.
 */

/** Where the export of an upgrade goes, in the data folder. */
export const UPGRADE_DIR = "upgrade";
/** What a folder of the new version is while it is made, beside the one that is used. */
export const upgradingOf = (major: number) => `${folderOf(major)}.upgrading`;
/** What the folder of a version before becomes once its data is in the new one. */
export const OLD = ".old";
/**
 * The mark in the folder of the new version that it has all the data of the one before, compared
 * table by table: only beside a folder with it is the one before named as old.
 */
export const UPGRADED = "animaquill-upgraded.json";

/** Folders of PostgreSQL made whole: `pg<major>/` with its `PG_VERSION`, by major version. */
export async function madeFolders(dataDir: string): Promise<number[]> {
  const majors: number[] = [];
  for (const name of await readdir(dataDir).catch(() => [])) {
    const major = /^pg(\d{1,3})$/.exec(name)?.[1];
    if (major === undefined) continue;
    if (await lstat(join(dataDir, name, "PG_VERSION")).catch(() => undefined))
      majors.push(Number(major));
  }
  return majors.toSorted((a, b) => a - b);
}

/** The folders of versions before that an upgrade left, with what they take on the disk. */
export async function oldFolders(
  dataDir: string,
): Promise<{ readonly name: string; readonly major: number; readonly bytes: number }[]> {
  const found = [];
  for (const name of (await readdir(dataDir).catch(() => [])).toSorted()) {
    const major = /^pg(\d{1,3})\.old(?:-\d+)?$/.exec(name)?.[1];
    if (major === undefined) continue;
    found.push({ name, major: Number(major), bytes: await sizeOf(join(dataDir, name)) });
  }
  return found;
}

/** Whether a name is that of a folder `oldFolders` lists: nothing else is ever taken away. */
export const isOldFolder = (name: string) => /^pg\d{1,3}\.old(?:-\d+)?$/.test(name);

/** What the files of a folder take, all of them, not following links. */
export async function sizeOf(path: string): Promise<number> {
  const found = await lstat(path).catch(() => undefined);
  if (!found) return 0;
  if (!found.isDirectory()) return found.size;
  let bytes = 0;
  for (const name of await readdir(path).catch(() => [])) bytes += await sizeOf(join(path, name));
  return bytes;
}

/** A name for the folder of the version before that is not taken: `pg17.old`, `pg17.old-2`, … */
async function oldName(dataDir: string, major: number): Promise<string> {
  for (let n = 1; ; n++) {
    const name = `${folderOf(major)}${OLD}${n === 1 ? "" : `-${n}`}`;
    if (!(await lstat(join(dataDir, name)).catch(() => undefined))) return name;
  }
}

/** Steps of an upgrade a test has fail, as after them: nothing else ever says them. */
export type UpgradeFault = "export" | "import" | "verify" | "switch";

export interface UpgradeOptions {
  readonly dataDir: string;
  /** The version before, and its programs. */
  readonly from: { readonly major: number; readonly programs: Programs };
  /** The new one: this version's unless said. */
  readonly to: { readonly major?: number; readonly programs: Programs };
  /** The log of PostgreSQL, see `PostgresOptions.logFile`. */
  readonly logFile: string;
  /** The version of the server, for the export. */
  readonly version: string;
  readonly log: Logger;
  /** Only tests: the step after which it fails. */
  readonly fault?: UpgradeFault | undefined;
}

export type UpgradeOutcome =
  | {
      readonly kind: "upgraded";
      readonly old: string;
      readonly tables: number;
      readonly rows: number;
    }
  | { readonly kind: "failed"; readonly reason: string };

/** Room on the disk an upgrade wants besides: the export and the new folder, each as large. */
const ROOM_BESIDES = 256 * 1024 * 1024;

/**
 * Takes away what a try before left of an upgrade to `major`: a PostgreSQL of it that still runs
 * (stopped once it shows it is ours), its folder, and the export. Throws `LeftOverRunning` for one
 * that runs and is not ours.
 */
async function clearLeftOver(dataDir: string, staging: Postgres, exportDir: string): Promise<void> {
  await staging.stopLeftOver();
  await rm(staging.folder, { recursive: true, force: true });
  await rm(`${staging.folder}.making`, { recursive: true, force: true });
  await rm(exportDir, { recursive: true, force: true });
  await rmdir(join(dataDir, UPGRADE_DIR)).catch(() => {});
}

/** Connects a client of `pg` to a PostgreSQL that runs, without a timeout of its queries. */
const clientOf = async (postgres: Postgres) => {
  const { host, port, user, password, database } = postgres.connection();
  const client = new Client({
    host,
    port,
    user,
    password,
    database,
    connectionTimeoutMillis: 10_000,
  });
  await client.connect();
  return client;
};

/** Migrates the database of a PostgreSQL that runs to this version's migrations. */
async function migrated(postgres: Postgres, log: Logger): Promise<void> {
  const { host, port, user, password, database } = postgres.connection();
  const db = createDatabase(
    { host, port, name: database, user, password },
    log,
    "animaquill-upgrade",
  );
  try {
    // A database a newer version migrated is never touched: that throws `NewerDatabase`.
    if ((await migrationsDue(db.db)) > 0) await db.migrate();
  } finally {
    await db.close().catch(() => {});
  }
}

/**
 * Where a data folder that has only the folder of `from` gets one of `to`, as above. Resolves to
 * how it went; rejects only for what has the start stop anyway, whichever version it went on with:
 * a database a newer version migrated (`NewerDatabase`), and a PostgreSQL of the version before
 * that runs and is not ours (`LeftOverRunning`).
 */
export async function upgradePostgres(options: UpgradeOptions): Promise<UpgradeOutcome> {
  const { dataDir, from, log, fault } = options;
  const toMajor = options.to.major ?? MAJOR;
  const exportDir = join(dataDir, UPGRADE_DIR, `pg${from.major}-to-pg${toMajor}`);
  const old = new Postgres({
    programs: from.programs,
    dataDir,
    major: from.major,
    password: await passwordOf(dataDir, from.major),
    logFile: options.logFile,
  });
  const staging = new Postgres({
    programs: options.to.programs,
    dataDir,
    major: toMajor,
    folderName: upgradingOf(toMajor),
    password: await passwordOf(dataDir, toMajor),
    logFile: options.logFile,
  });
  const failed = (reason: string): UpgradeOutcome => {
    log.warn({ reason }, "PostgreSQL was not upgraded: it goes on with the version before");
    return { kind: "failed", reason };
  };
  try {
    await clearLeftOver(dataDir, staging, exportDir);
  } catch (error) {
    if (error instanceof LeftOverRunning)
      return failed(`a PostgreSQL of an upgrade before still runs (process ${error.pid})`);
    throw error;
  }

  // Room for the export and the new folder, each about as large as the folder before.
  const need = 2 * (await sizeOf(old.folder)) + ROOM_BESIDES;
  const room = await statfs(dataDir).catch(() => undefined);
  if (room && room.bavail * room.bsize < need)
    return failed(
      `not enough room on the disk: ${Math.ceil(need / 1024 ** 2)} MB are needed, ${Math.floor((room.bavail * room.bsize) / 1024 ** 2)} MB are free`,
    );

  // 1. Out of the version before.
  await old.stopLeftOver();
  let tables = 0;
  let rows = 0;
  try {
    await old.start();
    await migrated(old, log);
    const client = await clientOf(old);
    try {
      const manifest = await exportData(client, exportDir, {
        server: options.version,
        migrations: migrationsOfCode([SERVER_MIGRATIONS]),
      });
      tables = manifest.tables.length;
      rows = manifest.tables.reduce((sum, table) => sum + table.rows, 0);
    } finally {
      await client.end().catch(() => {});
    }
    if (fault === "export") throw new Error("a test said the upgrade fails after the export");
  } catch (error) {
    await old.stop(4000).catch(() => {});
    await rm(exportDir, { recursive: true, force: true });
    await rmdir(join(dataDir, UPGRADE_DIR)).catch(() => {});
    if (isRefusal(error)) throw error;
    return failed(
      `the data could not be taken out of PostgreSQL ${from.major}: ${messageOf(error)}`,
    );
  }
  try {
    await old.stop(4000);
  } catch (error) {
    await rm(exportDir, { recursive: true, force: true });
    await rmdir(join(dataDir, UPGRADE_DIR)).catch(() => {});
    return failed(`PostgreSQL ${from.major} did not stop: ${messageOf(error)}`);
  }

  // 2. Into the new one, beside, and every table compared.
  try {
    await staging.init();
    await staging.start();
    try {
      await migrated(staging, log);
      const client = await clientOf(staging);
      try {
        await importData(client, exportDir);
        if (fault === "import") throw new Error("a test said the upgrade fails after the import");
        const { differences } = await verifyData(client, exportDir, {
          migrations: migrationsOfCode([SERVER_MIGRATIONS]),
        });
        if (differences.length > 0)
          throw new DataRefused(`not what was exported: ${differences.join("; ")}`);
        if (fault === "verify") throw new Error("a test said the upgrade fails after the check");
        // What says this folder has all the data of the one before, compared table by table.
        await writeFile(
          join(staging.folder, UPGRADED),
          `${JSON.stringify({ from: from.major, to: toMajor, tables, rows, at: new Date().toISOString() })}\n`,
          { mode: 0o600 },
        );
      } finally {
        await client.end().catch(() => {});
      }
    } finally {
      await staging.stop(4000);
    }
  } catch (error) {
    await staging.stopNow().catch(() => {});
    await rm(staging.folder, { recursive: true, force: true });
    await rm(`${staging.folder}.making`, { recursive: true, force: true });
    await rm(exportDir, { recursive: true, force: true });
    await rmdir(join(dataDir, UPGRADE_DIR)).catch(() => {});
    if (isRefusal(error)) throw error;
    return failed(`the data could not be put into PostgreSQL ${toMajor}: ${messageOf(error)}`);
  }

  // 3. The new one is whole and has it all: it is the one from now on. A crash between the two
  // renames leaves both, and the start after takes the new one (`settleFolders`).
  const name = await oldName(dataDir, from.major);
  try {
    if (fault === "switch") throw new Error("a test said the upgrade fails before the switch");
    // Neither may still run: a folder is never moved under a PostgreSQL.
    for (const each of [staging, old])
      if (await lstat(join(each.folder, "postmaster.pid")).catch(() => undefined))
        throw new Error(`PostgreSQL ${each.major} did not stop`);
    await rename(staging.folder, join(dataDir, folderOf(toMajor)));
  } catch (error) {
    await staging.stopNow().catch(() => {});
    await rm(staging.folder, { recursive: true, force: true });
    await rm(exportDir, { recursive: true, force: true });
    await rmdir(join(dataDir, UPGRADE_DIR)).catch(() => {});
    return failed(
      `the folder of PostgreSQL ${toMajor} could not be put in place: ${messageOf(error)}`,
    );
  }
  await rename(old.folder, join(dataDir, name)).catch((error: unknown) =>
    log.warn({ err: messageOf(error) }, "the folder of the version before stays as it is named"),
  );
  await rm(exportDir, { recursive: true, force: true });
  await rmdir(join(dataDir, UPGRADE_DIR)).catch(() => {});
  log.info({ from: from.major, to: toMajor, tables, rows, old: name }, "PostgreSQL upgraded");
  return { kind: "upgraded", old: name, tables, rows };
}

/**
 * Where the folder of this version is there, what an upgrade left beside it: the folder of the
 * version before, as after a crash between the two renames, is named as old; a folder of a try
 * that stopped halfway, and its export, go. Resolves to the folder named as old, if any.
 */
export async function settleFolders(
  dataDir: string,
  staging: Postgres,
  log: Logger,
): Promise<{ readonly named?: string; readonly kept: readonly number[] }> {
  const made = await madeFolders(dataDir);
  if (!made.includes(MAJOR)) return { kept: [] };
  await clearLeftOver(dataDir, staging, join(dataDir, UPGRADE_DIR)).catch((error: unknown) =>
    log.warn({ err: messageOf(error) }, "what an upgrade before left stays for now"),
  );
  const before = made.filter((each) => each < MAJOR);
  // A folder of this version that no upgrade made whole (as one a version without upgrades made
  // beside the one before): the one before is left exactly as it is, and said.
  if (
    before.length > 0 &&
    !(await lstat(join(dataDir, folderOf(MAJOR), UPGRADED)).catch(() => undefined))
  ) {
    log.warn({ kept: before }, "a folder of a version before stays beside one no upgrade made");
    return { kept: before };
  }
  let named: string | undefined;
  for (const major of before) {
    const name = await oldName(dataDir, major);
    await rename(join(dataDir, folderOf(major)), join(dataDir, name)).then(
      () => {
        named = name;
        log.info({ name }, "the folder of the version before is named as old");
      },
      (error: unknown) =>
        log.warn({ err: messageOf(error) }, "the folder of the version before stays"),
    );
  }
  return { ...(named !== undefined && { named }), kept: [] };
}

/** What stops the start whichever version it went on with. */
const isRefusal = (error: unknown) =>
  error instanceof LeftOverRunning || (error as Error)?.name === "NewerDatabase";

const messageOf = (error: unknown) =>
  error instanceof Error ? error.message.split("\n")[0]! : String(error);

/** The major version a folder of PostgreSQL says it is of. */
export const versionOf = async (folder: string): Promise<number> =>
  Number((await readFile(join(folder, "PG_VERSION"), "utf8")).trim());
