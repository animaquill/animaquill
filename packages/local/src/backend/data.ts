import { lstat, readdir, readFile, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
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
  readManifest,
  verifyData,
  type Manifest,
} from "@animaquill/server/data/transfer.ts";
import { openedOf } from "@animaquill/server/data/sealed.ts";
import { createSealer, parseMasterKeys } from "@animaquill/server/seal.ts";
import { MASTER_KEY_FILE, writeNew } from "./data-dir.ts";

/**
 * `npx animaquill server export|import` (design O4 of AnimaQuill Cloud, 3 and 3.7): the data of the
 * backend (what is not in the repositories: accounts, settings and keys, conversations, the list of
 * projects, the working copies) and, from its data folder, its repositories and the pictures of
 * conversations, into a folder, by data/transfer.ts of `@animaquill/server`; and such a folder
 * into a data folder that has nothing yet. The master key is in neither: the keys of AI services
 * are in the export as sealed as the database has them, and open only with the same key.
 */

/** What an export says it took. */
export interface ExportSummary {
  readonly dir: string;
  readonly tables: number;
  readonly rows: number;
  readonly repos?: { readonly files: number; readonly bytes: number };
  readonly chatImages?: { readonly files: number; readonly bytes: number };
}

export const summaryOf = (dir: string, manifest: Manifest): ExportSummary => ({
  dir,
  tables: manifest.tables.length,
  rows: manifest.tables.reduce((sum, table) => sum + table.rows, 0),
  ...(manifest.repos && { repos: { files: manifest.repos.files, bytes: manifest.repos.bytes } }),
  ...(manifest.chatImages && {
    chatImages: { files: manifest.chatImages.files, bytes: manifest.chatImages.bytes },
  }),
});

/**
 * Where an export may go: anywhere but in the data folder, whose copy it is (a copy there goes
 * with it, and would be copied into the next export).
 */
export function exportTarget(dir: string, dataDir: string): string {
  const target = resolve(dir);
  const inside = relative(resolve(dataDir), target);
  if (inside === "" || (!inside.startsWith("..") && !isAbsolute(inside)))
    throw new DataRefused(`${target} is in the data folder: export somewhere else`);
  return target;
}

export interface Connection {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password?: string | undefined;
  readonly database: string;
}

const clientOf = async (connection: Connection) => {
  const client = new Client({ ...connection, connectionTimeoutMillis: 10_000 });
  await client.connect();
  return client;
};

/** Exports the data of the database of `connection`, with the repositories and pictures of `dataDir`. */
export async function exportServer(
  connection: Connection,
  dir: string,
  options: { readonly dataDir: string; readonly version: string },
): Promise<ExportSummary> {
  const target = exportTarget(dir, options.dataDir);
  const client = await clientOf(connection);
  try {
    const manifest = await exportData(client, target, {
      server: options.version,
      migrations: migrationsOfCode([SERVER_MIGRATIONS]),
      dataDir: options.dataDir,
    });
    return summaryOf(target, manifest);
  } finally {
    await client.end().catch(() => {});
  }
}

/**
 * What a data folder may have and still be taken as empty for an import: its logs, and the lock of
 * the import itself.
 */
const EMPTY_ENOUGH = new Set(["logs", "lock"]);

/** Throws where the data folder has anything an import could be mixed with. */
export async function emptyForImport(dataDir: string): Promise<void> {
  const there = (await readdir(dataDir).catch(() => [])).filter(
    (name) => !EMPTY_ENOUGH.has(name) && !name.startsWith("lock."),
  );
  if (there.length > 0)
    throw new DataRefused(
      `${dataDir} is not empty (${there.slice(0, 5).join(", ")}${there.length > 5 ? ", …" : ""}): import only into a data folder without anything yet`,
    );
}

/** A master key's file, as `master.key` has it: checked before it is taken. */
export async function readMasterKey(path: string): Promise<string> {
  const text = await readFile(path, "utf8");
  parseMasterKeys(text.trim());
  return `${text.trim()}\n`;
}

export interface ImportOutcome {
  readonly summary: ExportSummary;
  /** How many of the sealed keys and tokens open with the master key here. */
  readonly sealed: { readonly opened: number; readonly total: number };
}

/**
 * Puts an export into a database that has nothing yet (migrated here first), and its repositories
 * and pictures into the data folder, then compares every table with the export again. The data
 * folder has to be empty but for what this start made (`emptyForImport` before it); nothing of
 * the export is left half in where it fails, see `importData`.
 */
export async function importServer(
  connection: Connection,
  dir: string,
  options: { readonly dataDir: string; readonly log: Logger; readonly masterKey?: string },
): Promise<ImportOutcome> {
  const manifest = readManifest(dir);
  const db = createDatabase(
    {
      host: connection.host,
      port: connection.port,
      name: connection.database,
      user: connection.user,
      password: connection.password,
    },
    options.log,
    "animaquill-import",
  );
  try {
    if ((await migrationsDue(db.db)) > 0) await db.migrate();
  } finally {
    await db.close().catch(() => {});
  }
  const client = await clientOf(connection);
  try {
    await importData(client, dir, { dataDir: options.dataDir });
    const { differences } = await verifyData(client, dir, {
      migrations: migrationsOfCode([SERVER_MIGRATIONS]),
    });
    if (differences.length > 0)
      throw new DataRefused(`what went in is not what was exported: ${differences.join("; ")}`);
  } finally {
    await client.end().catch(() => {});
  }
  let sealed = { opened: 0, total: 0 };
  if (options.masterKey !== undefined) {
    const check = createDatabase(
      {
        host: connection.host,
        port: connection.port,
        name: connection.database,
        user: connection.user,
        password: connection.password,
      },
      options.log,
      "animaquill-import",
    );
    try {
      const opened = await openedOf(
        check.db,
        createSealer(parseMasterKeys(options.masterKey.trim())),
      );
      sealed = {
        opened: opened.aiKeys.opened + opened.githubTokens.opened,
        total: opened.aiKeys.total + opened.githubTokens.total,
      };
    } finally {
      await check.close().catch(() => {});
    }
  }
  return { summary: summaryOf(dir, manifest), sealed };
}

/** Puts a master key in place for the data folder, where there is none yet. */
export async function placeMasterKey(dataDir: string, text: string): Promise<void> {
  if (!(await writeNew(join(dataDir, MASTER_KEY_FILE), text)))
    throw new DataRefused(`${join(dataDir, MASTER_KEY_FILE)} is there already`);
}

/** Takes away what an import that failed made in a data folder that was empty, but its logs. */
export async function undoImport(dataDir: string, made: readonly string[]): Promise<void> {
  for (const name of made) {
    if (EMPTY_ENOUGH.has(name)) continue;
    if (await lstat(join(dataDir, name)).catch(() => undefined))
      await rm(join(dataDir, name), { recursive: true, force: true });
  }
}
