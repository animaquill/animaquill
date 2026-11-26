import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DrizzleQueryError, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg, { Pool } from "pg";
import type { Config } from "./config.ts";
import * as schema from "./schema.ts";

export const MIGRATIONS = fileURLToPath(new URL("./drizzle", import.meta.url));

/**
 * A folder of migrations, and the table (in the schema `drizzle`) that notes which of them ran. The
 * server's come first; a deployment adds its own after them.
 */
export interface MigrationSet {
  readonly folder: string;
  readonly table: string;
}

export const SERVER_MIGRATIONS: MigrationSet = {
  folder: MIGRATIONS,
  table: "__drizzle_migrations",
};

/** The database as Drizzle has it. */
export type Db = NodePgDatabase<typeof schema>;
/** A transaction of it, which takes the same queries. */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
/** Where a query can run: in a transaction or on its own. */
export type Executor = Db | Tx;

/** Held while migrating, so that two copies of the API never migrate at the same time. */
const MIGRATION_LOCK = 0x61712d6d; // "aq-m"

export interface Logger {
  info(object: object, message?: string): void;
  warn(object: object, message?: string): void;
  error(object: object, message?: string): void;
}

/**
 * What is safe to log about an error: its name, message and code. A failed query of Drizzle says
 * the query and what went into it, such as the hash of a session: only what the database said is
 * kept of it.
 */
export const describeError = (error: unknown): Record<string, unknown> => {
  if (error instanceof DrizzleQueryError) {
    return error.cause
      ? describeError(error.cause)
      : { name: "DrizzleQueryError", message: "a query failed" };
  }
  if (!(error instanceof Error)) return { message: String(error) };
  const code = (error as { code?: unknown }).code;
  return {
    name: error.name,
    message: error.message,
    ...(code ? { code } : {}),
  };
};

/** Whether PostgreSQL broke a transaction off for a deadlock (40P01), however drizzle passed it on. */
export const isDeadlock = (error: unknown): boolean => {
  const own = (error as { code?: unknown } | undefined)?.code;
  const cause = (error as { cause?: { code?: unknown } } | undefined)?.cause?.code;
  return own === "40P01" || cause === "40P01";
};

/**
 * Runs `work` once more when PostgreSQL broke it off for a deadlock: the other side went through, and
 * this one, done again, finds what it left. Locking rows in the same order everywhere makes this rare.
 */
export const retryOnDeadlock = async <T>(work: () => Promise<T>): Promise<T> => {
  try {
    return await work();
  } catch (error) {
    if (!isDeadlock(error)) throw error;
    return work();
  }
};

/** The pool behind the database, for what needs a connection of its own, such as a session lock. */
export const poolOf = (db: Db): Pool => (db as Db & { readonly $client: Pool }).$client;

/**
 * Runs `work` while holding a lock of PostgreSQL on `key` in `space`, on a connection of its own that
 * is held as long. Whoever else holds it already: `work` does not run, and this resolves to
 * `{ held: false }`. A process that dies lets go with its connection.
 */
export const withLock = async <T>(
  db: Db,
  space: number,
  key: string,
  work: () => Promise<T>,
): Promise<{ readonly held: true; readonly value: T } | { readonly held: false }> => {
  const client = await poolOf(db).connect();
  // A connection whose lock is not known to be let go does not go back to the pool: it ends, and
  // the lock with it.
  let broken: Error | undefined;
  const asError = (error: unknown) => (error instanceof Error ? error : new Error(String(error)));
  try {
    let held = false;
    try {
      const { rows } = await client.query<{ held: boolean }>(
        "select pg_try_advisory_lock($1, hashtext($2)) as held",
        [space, key],
      );
      held = rows[0]?.held === true;
    } catch (error) {
      broken = asError(error);
      throw error;
    }
    if (!held) return { held: false };
    try {
      return { held: true, value: await work() };
    } finally {
      try {
        await client.query("select pg_advisory_unlock($1, hashtext($2))", [space, key]);
      } catch (error) {
        broken = asError(error);
      }
    }
  } finally {
    client.release(broken);
  }
};

export const connectionOptions = (database: Config["database"], applicationName: string) => ({
  host: database.host,
  port: database.port,
  database: database.name,
  user: database.user,
  ...(database.password !== undefined && { password: database.password }),
  application_name: applicationName,
  // A database that is down has to show as down quickly, not hold every request.
  connectionTimeoutMillis: 3000,
});

/**
 * A database that a newer version migrated: this one does not know what it has, and must not write
 * to it. People run the newer version again, see `migrationsDue`.
 */
export class NewerDatabase extends Error {
  override name = "NewerDatabase";
}

/** When each migration of a folder was made, as drizzle notes it once it ran (`created_at`). */
const madeAt = (set: MigrationSet): number[] => {
  const journal = JSON.parse(readFileSync(join(set.folder, "meta", "_journal.json"), "utf8")) as {
    entries: { when: number }[];
  };
  return journal.entries.map((entry) => entry.when);
};

/**
 * How many migrations of these sets have not run on the database yet; throws `NewerDatabase` where
 * it had one that is not among them, made after the last of them: a newer version was here.
 * Nothing is written.
 */
export const migrationsDue = async (
  db: Db,
  sets: readonly MigrationSet[] = [SERVER_MIGRATIONS],
): Promise<number> => {
  let due = 0;
  for (const set of sets) {
    const made = madeAt(set);
    const last = Math.max(0, ...made);
    const table = `drizzle."${set.table.replaceAll('"', '""')}"`;
    const [there] = (
      await db.execute<{ found: string | null }>(sql`select to_regclass(${table}) as found`)
    ).rows;
    if (!there?.found) {
      due += made.length;
      continue;
    }
    const ran = (
      await db.execute<{ created_at: string }>(sql.raw(`select created_at from ${table}`))
    ).rows.map((row) => Number(row.created_at));
    if (ran.some((when) => when > last))
      throw new NewerDatabase(`a newer version migrated the database (${set.table})`);
    const done = new Set(ran);
    due += made.filter((when) => !done.has(when)).length;
  }
  return due;
};

export const createDatabase = (
  config: Config["database"],
  log: Logger,
  applicationName = "animaquill-api",
  /** What a deployment migrates after the server's own. */
  more: readonly MigrationSet[] = [],
) => {
  const pool = new Pool({
    ...connectionOptions(config, applicationName),
    max: 10,
    idleTimeoutMillis: 30_000,
    query_timeout: 10_000,
  });
  // A connection that breaks while idle, say when the database restarts, must not end the process.
  pool.on("error", (error) => {
    log.warn({ err: describeError(error) }, "database connection lost");
  });
  const db: Db = drizzle(pool, { schema });

  return {
    db,
    /** Whether the database answers, within a few seconds. */
    async check(): Promise<boolean> {
      try {
        await pool.query({
          text: "select 1",
          query_timeout: 3000,
        } as pg.QueryConfig);
        return true;
      } catch (error) {
        log.warn({ err: describeError(error) }, "database check failed");
        return false;
      }
    },
    /** Applies the migrations in drizzle/ that have not run yet. */
    async migrate(): Promise<void> {
      const client = await pool.connect();
      let broken: Error | undefined;
      try {
        // A session lock: it goes with the connection if this process dies halfway.
        await client.query("select pg_advisory_lock($1)", [MIGRATION_LOCK]);
        try {
          for (const set of [SERVER_MIGRATIONS, ...more])
            await migrate(drizzle(client, { schema }), {
              migrationsFolder: set.folder,
              migrationsTable: set.table,
              migrationsSchema: "drizzle",
            });
        } finally {
          await client.query("select pg_advisory_unlock($1)", [MIGRATION_LOCK]);
        }
      } catch (error) {
        broken = error instanceof Error ? error : new Error(String(error));
        throw error;
      } finally {
        // After a failure the connection may still hold the lock: it goes, not back to the pool.
        client.release(broken);
      }
    },
    close: () => pool.end(),
  };
};

export type Database = ReturnType<typeof createDatabase>;
