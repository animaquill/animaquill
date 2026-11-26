import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createDatabase, MIGRATIONS } from "./database.ts";
import { firstMigrations, TEST_DATABASE } from "./test/database.ts";

/**
 * The migrations in drizzle/, as the API applies them when it starts (database.ts). Drizzle runs
 * only those whose time (`when` in the journal) is later than that of the last one a database has:
 * one that is older than the one before it, as when two steps were made side by side and the later
 * of them got the earlier number, is never run on a database that has the one before. Nothing says
 * so; the tables are simply not there.
 */

interface Journal {
  readonly entries: readonly {
    readonly idx: number;
    readonly when: number;
    readonly tag: string;
  }[];
}

const journalOf = (folder: string): Journal =>
  JSON.parse(readFileSync(join(folder, "meta", "_journal.json"), "utf8")) as Journal;

describe("the migrations", () => {
  test("come one after the other, each made after the one before it", () => {
    const { entries } = journalOf(MIGRATIONS);
    expect(entries.map((entry) => entry.idx)).toEqual(entries.map((_, index) => index));
    for (let index = 1; index < entries.length; index++)
      expect(
        entries[index]!.when,
        `${entries[index]!.tag} has to be newer than ${entries[index - 1]!.tag}: make it again with db:generate`,
      ).toBeGreaterThan(entries[index - 1]!.when);
    // Each is a file, and each file is one of them.
    const files = readdirSync(MIGRATIONS).filter((name) => name.endsWith(".sql"));
    expect(files.toSorted()).toEqual(entries.map((entry) => `${entry.tag}.sql`).toSorted());
  });
});

/**
 * A database of the version before takes the newest: one made by the migrations up to `upTo`, with
 * rows of the server's in it, then migrated as the server does when it starts. Needs
 * AQ_TEST_DATABASE, see test/database.ts.
 */
describe.skipIf(!TEST_DATABASE)("a database of the version before", () => {
  let name: string;
  let direct: Client;
  let database: ReturnType<typeof createDatabase>;
  let folder: string;
  /** The rows of Git LFS before the migrations, for 0003. */
  let lfsBefore: { objects: unknown[]; uploads: unknown[] } | undefined;

  beforeAll(async () => {
    name = `aq_test_${randomBytes(6).toString("hex")}`;
    const admin = new Client({ connectionString: TEST_DATABASE });
    await admin.connect();
    await admin.query(`create database ${name}`);
    await admin.end();
    const address = new URL(TEST_DATABASE!);
    address.pathname = `/${name}`;
    direct = new Client({ connectionString: address.href });
    await direct.connect();
    const server = new URL(TEST_DATABASE!);
    database = createDatabase(
      {
        host: server.hostname,
        port: Number(server.port || 5432),
        name,
        user: decodeURIComponent(server.username),
        password: decodeURIComponent(server.password),
      },
      { info() {}, warn() {}, error() {} },
      "animaquill-test",
    );
    folder = firstMigrations(MIGRATIONS, 1);
  });
  afterAll(async () => {
    await direct?.end();
    await database?.close();
    if (folder) rmSync(folder, { recursive: true, force: true });
    const cleaner = new Client({ connectionString: TEST_DATABASE });
    await cleaner.connect();
    await cleaner.query(`drop database if exists ${name} with (force)`);
    await cleaner.end();
  });

  /** Every row of a table, in the order of its first column, as text: what a migration leaves. */
  const rowsOf = async (table: string, leaving: readonly string[] = []) => {
    const { rows } = await direct.query(`select * from ${table} order by 1, 2`);
    return rows.map((row: Record<string, unknown>) =>
      Object.fromEntries(
        Object.entries(row)
          .filter(([key]) => !leaving.includes(key))
          .map(([key, value]) => [key, JSON.stringify(value)]),
      ),
    );
  };

  test("0001_repo_providers: the repositories on GitHub stay as they were, only said to be on GitHub", async () => {
    await migrate(drizzle(direct), {
      migrationsFolder: folder,
      migrationsTable: "__drizzle_migrations",
      migrationsSchema: "drizzle",
    });
    // Rows as the platform has them: two projects on GitHub, paused and ready, with archives and
    // merges.
    await direct.query(`
      insert into users (id, github_id, login) values
        ('0190a000-0000-7000-8000-000000000001', 101, 'ada'),
        ('0190a000-0000-7000-8000-000000000002', 102, 'grace');
      insert into projects (id, owner_id, project_id, name) values
        ('p-one', '0190a000-0000-7000-8000-000000000001', 'm-one', '一'),
        ('p-two', '0190a000-0000-7000-8000-000000000002', 'm-two', '二');
      insert into project_repos (project_id, installation_id, repo_id, owner_id, owner_login, name,
          branch, private, created_here, state, pause_reason, head_sha, archived_seq, unusable_since,
          lfs_paths, blocked, prefer, merged_sha)
        values
        ('p-one', 11, 9001, 101, 'ada', 'one', 'main', true, true, 'ready', null, 'aaa', 4, null,
          '["media/a.mp4"]', '[]', 'editor', null),
        ('p-two', 12, 9002, 102, 'grace', 'two', 'trunk', false, false, 'paused', 'gone', 'bbb', 7,
          '2026-11-20T10:00:00Z', '[]', '[{"path":"x.json","reason":"invalid"}]', 'github', 'ccc');
      insert into archives (id, project_id, repo_id, seq, sha, parent_sha, kind, changed, removed) values
        ('0190a000-0000-7000-8000-0000000000a1', 'p-one', 9001, 3, 'a3', null, 'first', 5, 0),
        ('0190a000-0000-7000-8000-0000000000a2', 'p-one', 9001, 4, 'aaa', 'a3', 'auto', 1, 1),
        ('0190a000-0000-7000-8000-0000000000a3', 'p-two', 9002, 7, 'bbb', null, 'manual', 2, 0);
      insert into repo_merges (id, project_id, repo_id, from_sha, to_sha, state, seq) values
        ('0190a000-0000-7000-8000-0000000000b1', 'p-two', 9002, 'bbb', 'ccc', 'applied', 8);
      insert into lfs_objects (repo_id, oid, size, confirmed_at) values
        (9001, '${"a".repeat(64)}', 10, '2026-11-20T10:00:00Z'),
        (9001, '${"b".repeat(64)}', 20, '2026-11-20T10:00:00Z'),
        (9002, '${"a".repeat(64)}', 10, '2026-11-20T10:00:00Z');
      insert into lfs_uploads (id, user_id, project_id, repo_id, oid, size, received, state,
          created_at, updated_at)
        values
        ('0190a000-0000-7000-8000-0000000000c1', '0190a000-0000-7000-8000-000000000001', 'p-one',
          9001, '${"c".repeat(64)}', 30, 5, 'receiving', '2026-11-20T10:00:00Z', '2026-11-20T10:00:00Z'),
        ('0190a000-0000-7000-8000-0000000000c2', '0190a000-0000-7000-8000-000000000001', 'p-one',
          9001, '${"a".repeat(64)}', 10, 10, 'done', '2026-11-20T10:00:00Z', '2026-11-20T10:00:00Z');
    `);
    const before = {
      repos: await rowsOf("project_repos"),
      archives: await rowsOf("archives"),
      merges: await rowsOf("repo_merges"),
    };
    lfsBefore = { objects: await rowsOf("lfs_objects"), uploads: await rowsOf("lfs_uploads") };

    await database.migrate();

    // Nothing of what was there changed: only the new columns are new.
    expect(await rowsOf("project_repos", ["local_dir", "verified_at"])).toEqual(before.repos);
    expect(await rowsOf("archives", ["provider"])).toEqual(before.archives);
    expect(await rowsOf("repo_merges", ["provider"])).toEqual(before.merges);
    const providers = await direct.query(`
      select 'repos' as of, provider, local_dir from project_repos
      union all select 'archives', provider, null from archives
      union all select 'merges', provider, null from repo_merges`);
    expect(providers.rows).toHaveLength(6);
    for (const row of providers.rows)
      expect(row).toMatchObject({ provider: "github", local_dir: null });

    // From now on: a repository is one project's on its provider, the same number elsewhere is
    // another; only GitHub has installations, and only one of the server's own a folder.
    const fails = async (text: string) => {
      await direct.query("savepoint attempt");
      const error = await direct.query(text).then(
        () => undefined,
        (failed: unknown) => failed as { code?: string },
      );
      await direct.query("rollback to savepoint attempt");
      return error?.code;
    };
    await direct.query("begin");
    await direct.query(
      `insert into projects (id, owner_id, project_id, name) values ('p-three', '0190a000-0000-7000-8000-000000000001', 'm-three', '三')`,
    );
    const repo = (provider: string, installation: string, repoId: number, dir: string) =>
      `insert into project_repos (project_id, provider, installation_id, local_dir, repo_id, owner_id, owner_login, name, branch, private, created_here)
        values ('p-three', '${provider}', ${installation}, ${dir}, ${repoId}, 0, '', 'three', 'main', true, true)`;
    expect(await fails(repo("github", "13", 9001, "null"))).toBe("23505");
    expect(await fails(repo("github", "null", 9003, "null"))).toBe("23514");
    expect(await fails(repo("github", "13", 9003, "'repos/x.git'"))).toBe("23514");
    expect(await fails(repo("local", "null", 9001, "null"))).toBe("23514");
    expect(await fails(repo("local", "13", 9001, "'repos/p-three.git'"))).toBe("23514");
    expect(await fails(repo("gitlab", "null", 9001, "'repos/p-three.git'"))).toBe("23514");
    expect(await fails(repo("local", "null", 9001, "'repos/p-three.git'"))).toBeUndefined();
    await direct.query("rollback");
  });

  test("0002_local_repos: numbers of repositories of the server's own, one after the other; none read through yet", async () => {
    const first = await direct.query("select nextval('local_repo_ids') as id");
    const second = await direct.query("select nextval('local_repo_ids') as id");
    expect(Number(second.rows[0].id)).toBe(Number(first.rows[0].id) + 1);
    const verified = await direct.query("select verified_at from project_repos");
    for (const row of verified.rows) expect(row.verified_at).toBeNull();
  });

  test("0003_lfs_providers: the objects and uploads of Git LFS stay as they were, on GitHub; the same number here is another repository", async () => {
    expect(await rowsOf("lfs_objects", ["provider"])).toEqual(lfsBefore?.objects);
    expect(await rowsOf("lfs_uploads", ["provider"])).toEqual(lfsBefore?.uploads);
    const providers = await direct.query(
      "select provider from lfs_objects union all select provider from lfs_uploads",
    );
    expect(providers.rows).toHaveLength(5);
    for (const row of providers.rows) expect(row.provider).toBe("github");
    const fails = async (text: string) => {
      await direct.query("savepoint attempt");
      const error = await direct.query(text).then(
        () => undefined,
        (failed: unknown) => failed as { code?: string },
      );
      await direct.query("rollback to savepoint attempt");
      return error?.code;
    };
    const a = "a".repeat(64);
    const c = "c".repeat(64);
    await direct.query("begin");
    // The same object of the same repository on GitHub, once; of the same number here, another.
    expect(
      await fails(`insert into lfs_objects (repo_id, oid, size) values (9001, '${a}', 10)`),
    ).toBe("23505");
    expect(
      await fails(
        `insert into lfs_objects (provider, repo_id, oid, size) values ('local', 9001, '${a}', 10)`,
      ),
    ).toBeUndefined();
    expect(
      await fails(
        `insert into lfs_objects (provider, repo_id, oid, size) values ('gitlab', 9001, '${a}', 10)`,
      ),
    ).toBe("23514");
    const upload = (provider: string) =>
      `insert into lfs_uploads (user_id, project_id, provider, repo_id, oid, size, state)
        values ('0190a000-0000-7000-8000-000000000001', 'p-one', '${provider}', 9001, '${c}', 30, 'receiving')`;
    // One open upload of an object into a repository: on GitHub as before, and here apart.
    expect(await fails(upload("github"))).toBe("23505");
    await direct.query(upload("local"));
    expect(await fails(upload("local"))).toBe("23505");
    expect(await fails(upload("gitlab"))).toBe("23514");
    await direct.query("rollback");
  });
});
