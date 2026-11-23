import { randomBytes } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg, { Client } from "pg";
import type { Config } from "../config.ts";
import { createDatabase, type Database, type MigrationSet } from "../database.ts";

/**
 * A PostgreSQL for the tests that need one: `AQ_TEST_DATABASE`, an address like
 * postgres://user:password@host:5432/postgres of a server that is only for tests, as
 * CI starts one. Each test file gets a database of its own on it, made from the
 * migrations, and dropped afterwards. Without the variable those tests are skipped.
 */
export const TEST_DATABASE = process.env["AQ_TEST_DATABASE"];

/** What a deployment migrates besides the server's, for the databases of its tests too. */
const more: MigrationSet[] = [];
export const alsoMigrateTests = (set: MigrationSet) => {
  if (!more.some((each) => each.table === set.table)) more.push(set);
};

const quiet = { info() {}, warn() {}, error() {} };

export interface TestDatabase {
  /** How to reach it, as the configuration of the API has it, as for the job queue. */
  readonly config: Config["database"];
  readonly database: Database;
  readonly db: Database["db"];
  /** A connection of its own, for what Drizzle does not say, such as reading a row as it is. */
  query(text: string, values?: unknown[]): Promise<pg.QueryResult>;
  drop(): Promise<void>;
}

export const createTestDatabase = async (): Promise<TestDatabase> => {
  if (!TEST_DATABASE) throw new Error("AQ_TEST_DATABASE is not set");
  const server = new URL(TEST_DATABASE);
  const name = `aq_test_${randomBytes(6).toString("hex")}`;
  const admin = new Client({ connectionString: TEST_DATABASE });
  await admin.connect();
  try {
    await admin.query(`create database ${name}`);
  } finally {
    await admin.end();
  }
  const config = {
    host: server.hostname,
    port: Number(server.port || 5432),
    name,
    user: decodeURIComponent(server.username),
    password: decodeURIComponent(server.password),
  };
  const database = createDatabase(config, quiet, "animaquill-test", more);
  await database.migrate();
  const address = new URL(TEST_DATABASE);
  address.pathname = `/${name}`;
  const direct = new Client({ connectionString: address.href });
  await direct.connect();
  return {
    config,
    database,
    db: database.db,
    query: (text, values) => direct.query(text, values),
    async drop() {
      await direct.end();
      await database.close();
      const cleaner = new Client({ connectionString: TEST_DATABASE });
      await cleaner.connect();
      try {
        await cleaner.query(`drop database if exists ${name} with (force)`);
      } finally {
        await cleaner.end();
      }
    },
  };
};

/**
 * A connection of its own to a test's database, as another process would have: for holding locks
 * while the code under test runs. The caller ends it.
 */
export const connection = async (t: TestDatabase): Promise<pg.Client> => {
  const client = new Client({
    host: t.config.host,
    port: t.config.port,
    database: t.config.name,
    user: t.config.user,
    ...(t.config.password !== undefined && { password: t.config.password }),
  });
  await client.connect();
  return client;
};

/**
 * The first `count` migrations of a folder of them, in a folder of their own, as an older version
 * had them: for databases of the version before, which take the newest migrations in a test. The
 * caller takes the folder away.
 */
export const firstMigrations = (folder: string, count: number): string => {
  const journal = JSON.parse(readFileSync(join(folder, "meta", "_journal.json"), "utf8")) as {
    readonly entries: readonly { readonly tag: string }[];
  };
  if (journal.entries.length < count)
    throw new Error(`${folder} has ${journal.entries.length} migrations, not ${count}`);
  const entries = journal.entries.slice(0, count);
  const target = mkdtempSync(join(tmpdir(), "aq-migrations-"));
  mkdirSync(join(target, "meta"));
  writeFileSync(join(target, "meta", "_journal.json"), JSON.stringify({ ...journal, entries }));
  for (const entry of entries)
    copyFileSync(join(folder, `${entry.tag}.sql`), join(target, `${entry.tag}.sql`));
  return target;
};
