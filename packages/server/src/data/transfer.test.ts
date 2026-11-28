import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
import { LocalGitRepoHost } from "../archive/local/host.ts";
import {
  DataRefused,
  exportData,
  exportRepos,
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
    // The person of this machine, without a number of GitHub (users.kind, O4a).
    await from.query("insert into users (kind, github_id, login) values ('local', null, '本机')");
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
    // The person of this machine comes back as that, without a number of GitHub.
    const localOf = async (t: TestDatabase) =>
      (await t.query("select id, kind, github_id, login from users where kind = 'local'")).rows;
    expect(await localOf(to)).toEqual(await localOf(from));
    expect(await localOf(to)).toMatchObject([{ kind: "local", github_id: null, login: "本机" }]);
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

  /** A data folder with a repository of the server's own that has a commit, as archives make. */
  const withRepository = async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "aq-data-dir-"));
    const host = new LocalGitRepoHost({ dataDir, log: { info() {}, warn() {}, error() {} } });
    await host.prepare();
    const place = { provider: "local" as const, repoId: 1, dir: "repos/p1.git" };
    await host.create(place, "p1", {});
    const session = host.open(place);
    const author = { name: "a", email: "a@example.com" };
    await session.start({ path: "animaquill.json", text: "{}" }, "开始存档", author, new Date());
    /** Another archive: a tree on the tip's, a commit, the branch moved. */
    const archive = async (text: string) => {
      const tip = (await session.tip("main"))!;
      const tree = await session.writeTree((await session.commit(tip))!.tree, [
        { path: "code/a.js", text },
      ]);
      const sha = await session.writeCommit({
        tree,
        parents: [tip],
        message: "存档",
        author,
        at: new Date(),
      });
      expect(await session.advance("main", sha)).toBe("moved");
      return sha;
    };
    return { dataDir, repos: join(dataDir, "repos"), gitdir: host.pathOf(place), archive };
  };

  test("takes the repositories of the server's own along, after the tables, and the numbers of the sequences", async () => {
    // Repositories as the server keeps them, with what a crash leaves half written.
    const { dataDir, repos } = await withRepository();
    mkdirSync(join(repos, "p1.git", "objects", "ab"), { recursive: true });
    mkdirSync(join(repos, "broken", "p0-20261110T080000Z.git"), { recursive: true });
    writeFileSync(join(repos, "p1.git", "refs", "heads", "main.lock"), "");
    writeFileSync(join(repos, "p1.git", "objects", "ab", "cdef"), randomBytes(100));
    writeFileSync(join(repos, "p1.git", "objects", "ab", "tmp_obj_123"), "half");
    // A large file of Git LFS, copied a piece at a time; what a crash left in lfs/tmp stays out.
    const large = randomBytes(5 * 1024 * 1024 + 7);
    const lfsOid = createHash("sha256").update(large).digest("hex");
    const lfsPath = join(
      "p1.git",
      "lfs",
      "objects",
      lfsOid.slice(0, 2),
      lfsOid.slice(2, 4),
      lfsOid,
    );
    mkdirSync(join(repos, dirname(lfsPath)), { recursive: true });
    writeFileSync(join(repos, lfsPath), large);
    mkdirSync(join(repos, "p1.git", "lfs", "tmp"), { recursive: true });
    writeFileSync(join(repos, "p1.git", "lfs", "tmp", ".tmp-0123"), "half");
    writeFileSync(join(repos, "broken", "p0-20261110T080000Z.git", "HEAD"), "x");
    writeFileSync(join(dataDir, ".tmp-abc"), "not a repository");
    for (let n = 0; n < 3; n++) await from.query("select nextval('local_repo_ids')");

    const dir = tempDir();
    const client = await connection(from);
    let manifest;
    try {
      manifest = await exportData(client, dir, { server: "test", dataDir });
    } finally {
      await client.end();
    }
    expect(manifest.sequences?.["public.local_repo_ids"]).toBeGreaterThanOrEqual(3);
    expect(manifest.repos?.files).toBeGreaterThan(5);
    const list = JSON.parse(readFileSync(join(dir, "repos.json"), "utf8")) as {
      files: { path: string }[];
    };
    const paths = list.files.map((file) => file.path);
    // What names commits first, the objects last; nothing half written.
    const firstObject = paths.findIndex((path) => path.includes("/objects/"));
    expect(paths.slice(firstObject).every((path) => path.includes("/objects/"))).toBe(true);
    expect(paths).toContain("p1.git/refs/heads/main");
    expect(paths).not.toContain("p1.git/refs/heads/main.lock");
    expect(paths.some((path) => path.includes("tmp_obj_"))).toBe(false);
    expect(paths).toContain("broken/p0-20261110T080000Z.git/HEAD");

    // Into a server without any: the same files, and the sequence goes on from where it was.
    const into = await fresh();
    const otherDir = mkdtempSync(join(tmpdir(), "aq-data-dir-"));
    const inClient = await connection(into);
    try {
      await importData(inClient, dir, { dataDir: otherDir });
    } finally {
      await inClient.end();
    }
    expect(readFileSync(join(otherDir, "repos", "p1.git", "objects", "ab", "cdef"))).toEqual(
      readFileSync(join(repos, "p1.git", "objects", "ab", "cdef")),
    );
    expect(existsSync(join(otherDir, "repos", ".animaquill-repos"))).toBe(true);
    expect(readFileSync(join(otherDir, "repos", lfsPath)).equals(large)).toBe(true);
    expect(paths.indexOf(lfsPath.replace(/\\/g, "/"))).toBeGreaterThanOrEqual(firstObject);
    expect(paths.some((path) => path.includes(".tmp-"))).toBe(false);
    const next = await into.query("select nextval('local_repo_ids') as id");
    expect(Number(next.rows[0].id)).toBe(manifest.sequences!["public.local_repo_ids"]! + 1);

    // Not over repositories that are there, nor from a file that was changed: nothing goes in.
    const again = await fresh();
    const againClient = await connection(again);
    try {
      await expect(importData(againClient, dir, { dataDir: otherDir })).rejects.toBeInstanceOf(
        DataRefused,
      );
      const third = mkdtempSync(join(tmpdir(), "aq-data-dir-"));
      writeFileSync(join(dir, "repos", "p1.git", "HEAD"), "changed");
      await expect(importData(againClient, dir, { dataDir: third })).rejects.toBeInstanceOf(
        DataRefused,
      );
      expect(existsSync(join(third, "repos"))).toBe(false);
      const users = await again.query("select count(*)::int as n from users");
      expect(users.rows[0].n).toBe(0);
    } finally {
      await againClient.end();
    }
  });

  test("without the repositories, as people can ask: none in the export", async () => {
    const dir = tempDir();
    const client = await connection(from);
    try {
      const manifest = await exportData(client, dir, { server: "test" });
      expect(manifest.repos).toBeUndefined();
      expect(existsSync(join(dir, "repos.json"))).toBe(false);
    } finally {
      await client.end();
    }
  });

  test("an archive while the repositories are copied: the copy has what its branch names, and Git reads it", async () => {
    const { dataDir, gitdir, archive } = await withRepository();
    const before = await archive("a\n");
    const dir = join(mkdtempSync(join(tmpdir(), "aq-data-")), "export");
    mkdirSync(dir, { mode: 0o700 });
    let after: string | undefined;
    await exportRepos(dataDir, dir, {
      afterRefs: async () => {
        after = await archive("b\n");
      },
    });
    expect(after).toBeDefined();
    const copy = join(dir, "repos", "p1.git");
    expect(readFileSync(join(copy, "refs", "heads", "main"), "utf8").trim()).toBe(before);
    expect(readFileSync(join(gitdir, "refs", "heads", "main"), "utf8").trim()).toBe(after);
    if (spawnSync("git", ["--version"]).status === 0) {
      const fsck = spawnSync("git", ["-C", copy, "fsck", "--strict", "--no-dangling"], {
        encoding: "utf8",
      });
      expect(fsck.status, fsck.stderr).toBe(0);
    }
  });

  test("a copy whose branch names what is not in it fails the export, and says which", async () => {
    const { dataDir, repos } = await withRepository();
    writeFileSync(join(repos, "p1.git", "refs", "heads", "main"), `${"b".repeat(40)}\n`);
    const dir = join(mkdtempSync(join(tmpdir(), "aq-data-")), "export");
    mkdirSync(dir, { mode: 0o700 });
    await expect(exportRepos(dataDir, dir)).rejects.toThrow(/repos\/p1\.git \(main b+\)/);
  });

  test("an export that fails leaves nothing of it; a folder with something in it is refused as it is", async () => {
    const { dataDir, repos } = await withRepository();
    writeFileSync(join(repos, "p1.git", "refs", "heads", "main"), `${"c".repeat(40)}\n`);
    const parent = mkdtempSync(join(tmpdir(), "aq-data-"));
    const dir = join(parent, "export");
    const client = await connection(from);
    try {
      await expect(exportData(client, dir, { server: "test", dataDir })).rejects.toThrow(
        /export again/,
      );
      expect(existsSync(dir)).toBe(false);
      // There already, empty: emptied again.
      mkdirSync(dir, { mode: 0o700 });
      await expect(exportData(client, dir, { server: "test", dataDir })).rejects.toThrow();
      expect(readdirSync(dir)).toEqual([]);
      // Something of people's in it: refused, and its mode as it was.
      const theirs = join(parent, "theirs");
      mkdirSync(theirs, { mode: 0o755 });
      writeFileSync(join(theirs, "note.txt"), "mine");
      await expect(exportData(client, theirs, { server: "test" })).rejects.toThrow(/not empty/);
      if (process.platform !== "win32") expect(statSync(theirs).mode & 0o777).toBe(0o755);
      expect(readdirSync(theirs)).toEqual(["note.txt"]);
    } finally {
      await client.end();
    }
  });

  test("an import refused for anything about the database leaves no repositories behind", async () => {
    const { dataDir } = await withRepository();
    const dir = tempDir();
    const client = await connection(from);
    try {
      await exportData(client, dir, { server: "test", dataDir });
    } finally {
      await client.end();
    }
    const target = mkdtempSync(join(tmpdir(), "aq-data-dir-"));
    // Another scope, and a database that is not empty.
    const into = await fresh();
    const inClient = await connection(into);
    try {
      await expect(
        importData(inClient, dir, {
          dataDir: target,
          scope: { schemas: ["public", "other"], migrations: ["__drizzle_migrations"] },
        }),
      ).rejects.toBeInstanceOf(DataRefused);
      expect(existsSync(join(target, "repos"))).toBe(false);
      await inClient.query("insert into users (github_id, login) values (1, 'here')");
      await expect(importData(inClient, dir, { dataDir: target })).rejects.toThrow(/not empty/);
      expect(existsSync(join(target, "repos"))).toBe(false);
    } finally {
      await inClient.end();
    }
  });

  test("the pictures of conversations of the data folder go along, each checked by its name", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "aq-data-dir-"));
    const person = "00000000-0000-4000-8000-0000000000aa";
    const pictures = [randomBytes(3000), randomBytes(10)].map((bytes) => ({
      bytes,
      hash: createHash("sha256").update(bytes).digest("hex"),
    }));
    mkdirSync(join(dataDir, "chat-images", "u", person), { recursive: true });
    mkdirSync(join(dataDir, "chat-images", ".writing"), { recursive: true });
    for (const { bytes, hash } of pictures)
      writeFileSync(join(dataDir, "chat-images", "u", person, hash), bytes);
    // Half written, and a file that is not what its name says: neither goes.
    writeFileSync(join(dataDir, "chat-images", ".writing", "x.tmp"), "half");
    const wrong = "f".repeat(64);
    writeFileSync(join(dataDir, "chat-images", "u", person, wrong), "not it");
    const dir = tempDir();
    const client = await connection(from);
    let manifest;
    try {
      manifest = await exportData(client, dir, { server: "test", dataDir });
    } finally {
      await client.end();
    }
    expect(manifest.chatImages).toMatchObject({ files: 2, bytes: 3010 });
    expect(existsSync(join(dir, "chat-images", "u", person, wrong))).toBe(false);
    expect(existsSync(join(dir, "chat-images", ".writing"))).toBe(false);
    if (process.platform !== "win32")
      expect(statSync(join(dir, "chat-images", "u", person, pictures[0]!.hash)).mode & 0o777).toBe(
        0o600,
      );

    // Not without a data folder for them: they would be lost.
    const into = await fresh();
    const inClient = await connection(into);
    try {
      await expect(importData(inClient, dir)).rejects.toThrow(/pictures/);
      // A picture changed in the export: nothing goes in, neither rows nor pictures.
      const target = mkdtempSync(join(tmpdir(), "aq-data-dir-"));
      const changed = join(dir, "chat-images", "u", person, pictures[1]!.hash);
      const kept = readFileSync(changed);
      writeFileSync(changed, "other");
      await expect(importData(inClient, dir, { dataDir: target })).rejects.toBeInstanceOf(
        DataRefused,
      );
      expect(existsSync(join(target, "chat-images"))).toBe(false);
      expect((await into.query("select count(*)::int as n from users")).rows[0].n).toBe(0);
      writeFileSync(changed, kept);
      // Into a data folder without pictures: each as it was.
      await importData(inClient, dir, { dataDir: target });
      for (const { bytes, hash } of pictures)
        expect(readFileSync(join(target, "chat-images", "u", person, hash)).equals(bytes)).toBe(
          true,
        );
      // Never over pictures that are there.
      const again = await fresh();
      const againClient = await connection(again);
      try {
        await expect(importData(againClient, dir, { dataDir: target })).rejects.toThrow(
          /has pictures already/,
        );
      } finally {
        await againClient.end();
      }
    } finally {
      await inClient.end();
    }
  });
});
