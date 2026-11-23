import { randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { storeTokens } from "../auth/tokens.ts";
import { sealSecret } from "../me/ai-sync.ts";
import { projectCovers, projectMarks, userAiKeys, userChats } from "../schema.ts";
import { createSealer } from "../seal.ts";
import { newProject, world } from "../test/archive-support.ts";
import {
  connection,
  createTestDatabase,
  TEST_DATABASE,
  type TestDatabase,
} from "../test/database.ts";
import { openedOf } from "./sealed.ts";
import { SERVER_MIGRATIONS } from "../database.ts";
import {
  DataRefused,
  exportData,
  importData,
  migrationsOfCode,
  readManifest,
  verifyData,
} from "./transfer.ts";

/**
 * The data of the server out of one database and into an empty one (data/transfer.ts): every table
 * with the same rows, what is sealed still opening with the same master key and with no other,
 * nothing put into a database that is not empty, of other migrations, or from an export that was
 * changed. On a real PostgreSQL. Needs AQ_TEST_DATABASE, see vitest.config.ts.
 */
describe.skipIf(!TEST_DATABASE)("the data of the server, out and in again", () => {
  let from: TestDatabase;
  const sealer = createSealer([{ version: 1, key: randomBytes(32) }]);
  const made: TestDatabase[] = [];
  const fresh = async () => {
    const t = await createTestDatabase();
    made.push(t);
    return t;
  };
  const tempDir = () => join(mkdtempSync(join(tmpdir(), "aq-data-")), "export");

  beforeAll(async () => {
    from = await fresh();
    // A bit of everything: people with tokens and keys, projects with their updates (bytes), a
    // cover, marks, a conversation; more rows than a chunk holds in one table.
    const w = await world(from.db);
    await storeTokens(from.db, sealer, w.userId, {
      accessToken: "ghu_access",
      accessExpiresAt: new Date(),
      refreshToken: "ghr_refresh",
      refreshExpiresAt: new Date(),
    });
    await from.db.insert(userAiKeys).values({
      userId: w.userId,
      service: "s1",
      sealed: sealSecret(sealer, w.userId, "s1", { key: "sk-secret" }),
      format: 2,
      at: new Date(),
    });
    const projects = [];
    for (let index = 0; index < 3; index++) projects.push(await newProject(w));
    await from.db.insert(projectCovers).values({
      projectId: projects[0]!.id,
      bytes: randomBytes(1000),
      type: "image/webp",
      etag: "e",
    });
    await from.db.insert(projectMarks).values({
      userId: w.userId,
      projectId: projects[1]!.id,
      starred: true,
      starAt: new Date(),
    });
    await from.db.insert(userChats).values({
      userId: w.userId,
      projectId: projects[2]!.id,
      chatId: "c1",
      revision: 1,
      summary: { id: "c1", title: "对话 “引号” \\ 和换行\n", updatedAt: 1 },
      body: { entries: [{ text: "😀" }] },
      size: 10,
      updatedAt: new Date(),
    });
    // A JSON null in a jsonb column and no value at all, which have to stay apart.
    await from.query("update projects set stats = 'null'::jsonb where id = $1", [projects[0]!.id]);
    await from.query("update projects set stats = null where id = $1", [projects[1]!.id]);
    await from.query("update projects set stats = '{\"assets\": null}'::jsonb where id = $1", [
      projects[2]!.id,
    ]);
    // Rows of a few megabytes each, as the working copies have them.
    for (let seq = 2; seq <= 4; seq++)
      await from.query(
        "insert into project_updates (project_id, seq, digest, data, kind, device, \"window\", base) values ($1, $2, 'd', $3, 'user', 'd1', 'w1', 1)",
        [projects[0]!.id, seq, randomBytes(3 * 1024 * 1024)],
      );
    await from.query(
      "insert into users (github_id, login) select 900000000 + g, 'bulk' || g from generate_series(1, 5200) g",
    );
  }, 300_000);
  afterAll(async () => {
    for (const t of made) await t.drop();
  });

  const exported = async () => {
    const dir = tempDir();
    const client = await connection(from);
    try {
      return { dir, manifest: await exportData(client, dir, { server: "test" }) };
    } finally {
      await client.end();
    }
  };
  const inTo = async (t: TestDatabase, dir: string) => {
    const client = await connection(t);
    try {
      return await importData(client, dir);
    } finally {
      await client.end();
    }
  };

  test("goes into an empty database with every table as it was, and what is sealed opens with the same key", async () => {
    const { dir, manifest } = await exported();
    // What it is, and nobody else's to read.
    expect(manifest).toMatchObject({ format: "animaquill-data", version: 3, server: "test" });
    expect(manifest.migrations["__drizzle_migrations"]?.count).toBeGreaterThan(0);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, "manifest.json")).mode & 0o777).toBe(0o600);
    const users = manifest.tables.find((table) => table.name === "users")!;
    expect(users.rows).toBeGreaterThan(5000);
    expect(users.chunks.length).toBeGreaterThan(1);
    for (const chunk of users.chunks)
      expect(statSync(join(dir, chunk.file)).mode & 0o777).toBe(0o600);
    expect(manifest.tables.find((table) => table.name === "project_updates")!.rows).toBe(6);
    // The job queue and the record of migrations are not in it; nor anything in the clear.
    expect(manifest.tables.map((table) => table.name)).not.toContain("job");
    const all = readdirSync(join(dir, "tables"))
      .flatMap((table) =>
        readdirSync(join(dir, "tables", table)).map((file) =>
          readFileSync(join(dir, "tables", table, file), "utf8"),
        ),
      )
      .join("");
    for (const secret of ["ghu_access", "ghr_refresh", "sk-secret"])
      expect(all).not.toContain(secret);

    const to = await fresh();
    await inTo(to, dir);
    const client = await connection(to);
    try {
      expect((await verifyData(client, dir)).differences).toEqual([]);
    } finally {
      await client.end();
    }
    // The same rows as where they came from, table by table.
    const source = await connection(from);
    try {
      expect((await verifyData(source, dir)).differences).toEqual([]);
    } finally {
      await source.end();
    }
    expect(await openedOf(to.db, sealer)).toEqual({
      githubTokens: { total: 2, opened: 2 },
      aiKeys: { total: 1, opened: 1 },
    });
    expect(await openedOf(to.db, createSealer([{ version: 1, key: randomBytes(32) }]))).toEqual({
      githubTokens: { total: 2, opened: 0 },
      aiKeys: { total: 1, opened: 0 },
    });
    // A JSON null stays a JSON null, no value stays none, and the large rows come back whole.
    const jsonOf = async (t: TestDatabase) =>
      (
        await t.query(
          "select id, jsonb_typeof(stats) as type, stats is null as none, stats from projects order by id",
        )
      ).rows;
    expect(await jsonOf(to)).toEqual(await jsonOf(from));
    expect((await jsonOf(to)).map((row) => row.type ?? "none").toSorted()).toEqual([
      "none",
      "null",
      "object",
    ]);
    const updatesOf = async (t: TestDatabase) =>
      (
        await t.query(
          "select seq, md5(data) as md5, length(data) as bytes from project_updates order by project_id, seq",
        )
      ).rows;
    expect(await updatesOf(to)).toEqual(await updatesOf(from));
    // Text with quotes, backslashes, line breaks and more than the basic plane comes back the same.
    const [chat] = (await to.query("select summary, body from user_chats")).rows;
    expect(chat).toEqual({
      summary: { id: "c1", title: "对话 “引号” \\ 和换行\n", updatedAt: 1 },
      body: { entries: [{ text: "😀" }] },
    });
  });

  test("takes small rows followed by rows of megabytes a few at a time, never hundreds at once", async () => {
    const t = await fresh();
    const w = await world(t.db);
    const project = await newProject(w);
    const put = (seq: number, data: Buffer) =>
      t.query(
        "insert into project_updates (project_id, seq, digest, data, kind, device, \"window\", base) values ($1, $2, 'd', $3, 'user', 'd1', 'w1', 1)",
        [project.id, seq, data],
      );
    for (let seq = 2; seq <= 41; seq++) await put(seq, randomBytes(10));
    for (let seq = 42; seq <= 47; seq++) await put(seq, randomBytes(2 * 1024 * 1024));
    const client = await connection(t);
    // Each fetch of rows, as the database answered it: how many, and how large together.
    const fetches: { rows: number; bytes: number }[] = [];
    const query = client.query.bind(client) as (...args: unknown[]) => Promise<pg.QueryResult>;
    (client as unknown as { query: unknown }).query = async (...args: unknown[]) => {
      const result = await query(...args);
      if (typeof args[0] === "string" && /^fetch \d+ from aq_rows_/.test(args[0]))
        fetches.push({
          rows: result.rows.length,
          bytes: result.rows.reduce((sum, row) => sum + String(row.row).length, 0),
        });
      return result;
    };
    try {
      await exportData(client, tempDir(), { server: "test" });
    } finally {
      await client.end();
    }
    const large = fetches.filter((fetch) => fetch.bytes > 4 * 1024 * 1024);
    expect(large.length).toBeGreaterThan(0);
    for (const fetch of fetches)
      if (fetch.rows > 1)
        expect(fetch.bytes, JSON.stringify(fetch)).toBeLessThanOrEqual(16 * 1024 * 1024);
  });

  test("goes only into an empty database of the same migrations, from an export as it was made, or nothing goes in", async () => {
    const { dir } = await exported();
    // Not empty.
    const twice = await fresh();
    await inTo(twice, dir);
    await expect(inTo(twice, dir)).rejects.toThrow(/not empty/);
    // Other migrations, also for taking it out or comparing: only with the code of its own version.
    const client0 = await connection(from);
    try {
      const code = { __drizzle_migrations: { count: 1, last: "something else" } };
      await expect(
        exportData(client0, tempDir(), { server: "test", migrations: code }),
      ).rejects.toThrow(/other migrations/);
      await expect(verifyData(client0, dir, { migrations: code })).rejects.toThrow(
        /other migrations/,
      );
      // The migrations of this code are those it has: fine.
      expect(
        (await verifyData(client0, dir, { migrations: migrationsOfCode([SERVER_MIGRATIONS]) }))
          .differences,
      ).toEqual([]);
    } finally {
      await client0.end();
    }
    const older = await fresh();
    await older.query(
      "delete from drizzle.__drizzle_migrations where id = (select max(id) from drizzle.__drizzle_migrations)",
    );
    await expect(inTo(older, dir)).rejects.toThrow(/other migrations/);
    // A chunk changed: nothing of it, nor of any other table, goes in.
    const manifest = readManifest(dir);
    const chunk = manifest.tables.find((table) => table.name === "users")!.chunks.at(-1)!;
    writeFileSync(
      join(dir, chunk.file),
      readFileSync(join(dir, chunk.file), "utf8").replace("bulk", "bulx"),
    );
    const changed = await fresh();
    await expect(inTo(changed, dir)).rejects.toThrow(DataRefused);
    expect((await changed.query("select count(*)::int as n from users")).rows[0].n).toBe(0);
    // Into a folder that has something already, nothing is written.
    const client = await connection(from);
    try {
      await expect(exportData(client, dir, { server: "test" })).rejects.toThrow(/not empty/);
    } finally {
      await client.end();
    }
  });
});
