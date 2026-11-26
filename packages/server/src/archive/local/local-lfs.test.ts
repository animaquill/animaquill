import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import type { SignedIn } from "../../auth/accounts.ts";
import type { LocalLfs } from "../../lfs/uploads.ts";
import { lfsObjects, lfsUploads, projectRepos } from "../../schema.ts";
import { clock, newProject, quiet, world, type World } from "../../test/archive-support.ts";
import { createTestDatabase, TEST_DATABASE, type TestDatabase } from "../../test/database.ts";
import { lfsWorld, oidOf, type LfsWorld } from "../../test/lfs-support.ts";
import { Archiver } from "../archiver.ts";
import { ProjectExporter } from "../exporter.ts";
import { RepoHosts, type LocalPlace } from "../repo-host.ts";
import { RepositoryService } from "../service.ts";
import { verifyDue } from "./checks.ts";
import { LocalGitRepoHost } from "./host.ts";
import { lfsPathOf } from "./lfs.ts";
import { linkLocal } from "./links.ts";

/**
 * Files of assets in the large file storage of the server's own repositories, on a database, as
 * the editor and the worker send them: no fee to say yes to, bound to `local:<number>`, which the
 * same number on GitHub is not; downloaded back; within the limits the server is set up for, and
 * the room its disk keeps; pointed at by archives, so that a clone gets them with `git lfs pull`;
 * carried over when archiving starts over; and no longer noted once they are gone from the disk.
 */

const hasGitLfs =
  spawnSync("git", ["--version"]).status === 0 && spawnSync("git", ["lfs", "version"]).status === 0;
if (!hasGitLfs && process.env["CI"]) throw new Error("git lfs is needed for these tests");

const git = (cwd: string, ...args: string[]) => {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "lfs.locksverify",
      GIT_CONFIG_VALUE_0: "false",
    },
  });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
};

const GIB = 1024 ** 3;

describe.skipIf(!TEST_DATABASE)("large files of repositories here, on a database", () => {
  let t: TestDatabase;
  let w: World;
  let l: LfsWorld;
  let dataDir: string;
  let host: LocalGitRepoHost;
  /** The disk of the repositories, as a test says it is. */
  let room: { free: number; total: number };
  let local: { -readonly [K in keyof LocalLfs]: LocalLfs[K] };
  beforeAll(async () => {
    t = await createTestDatabase();
  });
  afterAll(async () => {
    await t?.drop();
  });
  beforeEach(async () => {
    w = await world(t.db, clock(new Date()));
    dataDir = mkdtempSync(join(tmpdir(), "aq-local-lfs-db-"));
    host = new LocalGitRepoHost({ dataDir, log: quiet });
    await host.prepare();
    room = { free: 1024 * GIB, total: 2048 * GIB };
    local = {
      fileBytes: 2 * GIB,
      maxBytes: undefined,
      stagingFloorBytes: undefined,
      room: async () => room,
      sameDisk: async () => true,
    };
    l = await lfsWorld(w, {
      limits: { chunkBytes: 4096 },
      hosts: new RepoHosts({ local: host }),
      local,
      // Nobody said yes to GitHub's terms: nothing of GitHub is in this.
      acknowledged: false,
      // A server of its own: no limit a day where nobody set one. A "GB" is a byte here.
      dailyGb: undefined,
      downloadLimits: { bytesPerGb: 1 },
    });
  });
  afterEach(async () => {
    l.done();
    rmSync(dataDir, { recursive: true, force: true });
    // The tests share the database: what one put in counts against the limits of the next.
    await t.db.delete(lfsUploads);
    await t.db.delete(lfsObjects);
  });

  const archiver = () =>
    new Archiver({
      db: t.db,
      hosts: new RepoHosts({ local: host }),
      exporter: new ProjectExporter({ heapMb: 256 }),
      log: quiet,
      now: () => w.time.now,
      merging: async () => false,
      enqueueMerge: async () => {},
    });

  /** A project saved to a repository here, archived once (which makes the repository). */
  const made = async (archived = true) => {
    const project = await newProject(w);
    const repoId = await t.db.transaction((tx) =>
      linkLocal(tx, { projectId: project.id, userId: w.userId, at: w.time.now }),
    );
    const [link] = await t.db
      .select()
      .from(projectRepos)
      .where(eq(projectRepos.projectId, project.id));
    const place: LocalPlace = { provider: "local", repoId, dir: link!.localDir! };
    if (archived)
      expect(await archiver().run(project.id, "first")).toMatchObject({ kind: "archived" });
    return { project, repoId, place, gitdir: host.pathOf(place), repo: `local:${repoId}` };
  };

  /** Sends all of a file and pushes it, as the editor and the worker do. */
  const sent = async (project: string, data: Buffer) => {
    const begun = await l.begin(project, data);
    expect(begun.status, JSON.stringify(begun.json)).toBe(201);
    const checked = await l.sendAll(begun.json.id, data, begun.json.chunk);
    expect(checked.json).toMatchObject({ state: "received" });
    return { begun, pushed: await l.pusher.push(begun.json.id) };
  };

  test("goes in without the fee of GitHub, bound here, and comes back out; GitHub's same number is another", async () => {
    const m = await made();
    const data = randomBytes(20_000);
    // An object noted for the repository on GitHub of the same number is not this one's.
    await t.db.insert(lfsObjects).values({ repoId: m.repoId, oid: oidOf(data), size: data.length });
    const { begun, pushed } = await sent(m.project.id, data);
    expect(begun.json).toMatchObject({ state: "receiving", repo: m.repo });
    expect(pushed).toEqual({ kind: "done" });
    expect(readFileSync(lfsPathOf(m.gitdir, oidOf(data))).equals(data)).toBe(true);
    expect(existsSync(l.staging.pathOf(begun.json.id))).toBe(false);
    expect(
      await t.db
        .select({ provider: lfsObjects.provider, size: lfsObjects.size })
        .from(lfsObjects)
        .where(eq(lfsObjects.oid, oidOf(data))),
    ).toEqual(
      expect.arrayContaining([
        { provider: "github", size: data.length },
        { provider: "local", size: data.length },
      ]),
    );
    // There now: at once, the next time.
    expect((await l.begin(m.project.id, data)).json).toMatchObject({
      state: "present",
      repo: m.repo,
    });

    // As the editor of another computer gets it.
    const missing = randomBytes(100);
    expect(
      (
        await l.lookup(m.project.id, [
          { oid: oidOf(data), size: data.length },
          { oid: oidOf(data), size: data.length + 1 },
          { oid: oidOf(missing), size: missing.length },
        ])
      ).json,
    ).toEqual({
      objects: [
        { oid: oidOf(data), state: "ready" },
        { oid: oidOf(data), state: "changed" },
        { oid: oidOf(missing), state: "missing" },
      ],
    });
    const whole = await l.download(m.project.id, data, "bytes=0-");
    expect(whole.status).toBe(206);
    expect(whole.body.equals(data)).toBe(true);
    const part = await l.download(m.project.id, data, "bytes=100-199");
    expect(part.body.equals(data.subarray(100, 200))).toBe(true);
    // Far more than the platform's 20 "GB" a day, and nobody set a limit.
    expect(l.downloads.countedFor(w.userId)).toBeGreaterThan(20);
    expect((await l.download(m.project.id, data, "bytes=0-")).status).toBe(206);
    expect((await l.download(m.project.id, missing, "bytes=0-")).status).toBe(410);
  });

  test("a file sent before the first archive made the repository waits for it, and goes in then", async () => {
    const m = await made(false);
    const data = randomBytes(5000);
    const { begun, pushed } = await sent(m.project.id, data);
    expect(pushed).toMatchObject({ kind: "later" });
    // Nothing of the repository is made by the upload: the archive makes it whole.
    expect(existsSync(m.gitdir)).toBe(false);
    expect(await archiver().run(m.project.id, "first")).toMatchObject({ kind: "archived" });
    w.time.later(3600_000);
    expect(await l.pusher.push(begun.json.id)).toEqual({ kind: "done" });
    expect(readFileSync(lfsPathOf(m.gitdir, oidOf(data))).equals(data)).toBe(true);
  });

  test("within the largest file, all of it together, and the room the disk keeps", async () => {
    const m = await made();
    local.fileBytes = 4000;
    const big = await l.begin(m.project.id, randomBytes(4001));
    expect(big.status).toBe(413);
    expect(big.json).toMatchObject({ error: "tooLarge" });
    local.fileBytes = 2 * GIB;

    const kept = randomBytes(3000);
    await sent(m.project.id, kept);
    local.maxBytes = 5000;
    const over = await l.begin(m.project.id, randomBytes(2001));
    expect(over.status).toBe(409);
    expect(over.json).toEqual({ error: "githubQuota", detail: "local" });
    expect((await l.begin(m.project.id, randomBytes(2000))).status).toBe(201);
    local.maxBytes = undefined;
    await t.db.delete(lfsUploads);

    // 2 GiB stays free, or 5 % of the disk where that is more, counting what is still to come.
    room = { free: 2 * GIB + 20_000, total: 10 * GIB };
    expect((await l.begin(m.project.id, randomBytes(9000))).status).toBe(201);
    const full = await l.begin(m.project.id, randomBytes(11_001));
    expect(full.status).toBe(503);
    expect(full.headers["retry-after"]).toBe("600");
    expect(full.json).toEqual({ error: "busy", detail: "diskFull" });
    await t.db.delete(lfsUploads);
    room = { free: 50 * GIB + 10_000, total: 1000 * GIB };
    expect((await l.begin(m.project.id, randomBytes(10_000))).status).toBe(201);
    expect((await l.begin(m.project.id, randomBytes(10))).status).toBe(503);
    await t.db.delete(lfsUploads);
    room = { free: 100 * GIB, total: 1000 * GIB };
    // A staging folder on another disk keeps as much free there too.
    local.sameDisk = async () => false;
    l.staging.free = 10 * GIB;
    expect((await l.begin(m.project.id, randomBytes(12_000))).json).toEqual({
      error: "busy",
      detail: "diskFull",
    });
  });

  test.skipIf(!hasGitLfs)(
    "an archive points at what is here, and a clone gets it with git lfs pull",
    async () => {
      const m = await made();
      const data = randomBytes(30_000);
      await sent(m.project.id, data);
      await l.addAsset(m.project, "a1", "media/a.mp4", data);
      await l.placeIn(m.project, "a1", m.repo, data);
      expect(await archiver().run(m.project.id, "auto")).toMatchObject({ kind: "archived" });
      const clone = join(dataDir, "clone");
      git(dataDir, "clone", "--quiet", m.gitdir, clone);
      expect(readFileSync(join(clone, "media/a.mp4"), "utf8")).toContain(
        `oid sha256:${oidOf(data)}`,
      );
      git(clone, "lfs", "install", "--local");
      git(clone, "lfs", "pull");
      expect(readFileSync(join(clone, "media/a.mp4")).equals(data)).toBe(true);
      git(clone, "lfs", "fsck");
    },
  );

  test("starting over carries the large files into the new repository, each checked", async () => {
    const m = await made();
    const data = randomBytes(8000);
    await sent(m.project.id, data);
    await t.db
      .update(projectRepos)
      .set({ state: "paused", pauseReason: "broken" })
      .where(eq(projectRepos.projectId, m.project.id));
    const service = new RepositoryService({
      db: t.db,
      host: undefined,
      people: undefined,
      local: host,
      tokenFor: undefined,
      enqueue: async () => {},
      isQueued: async () => false,
      webUrl: "https://github.test",
      log: quiet,
      now: () => w.time.now,
    });
    await service.restart({ userId: w.userId } as SignedIn, m.project.id);
    const [after] = await t.db
      .select()
      .from(projectRepos)
      .where(eq(projectRepos.projectId, m.project.id));
    expect(after!.repoId).not.toBe(m.repoId);
    expect(readFileSync(lfsPathOf(m.gitdir, oidOf(data))).equals(data)).toBe(true);
    expect(
      await t.db
        .select({ size: lfsObjects.size })
        .from(lfsObjects)
        .where(and(eq(lfsObjects.provider, "local"), eq(lfsObjects.repoId, after!.repoId))),
    ).toEqual([{ size: data.length }]);
    // And the first archive into it goes as it would into any new one.
    expect(await archiver().run(m.project.id, "first")).toMatchObject({ kind: "archived" });
  });

  test("the weekly look no longer notes a file that is gone from the disk", async () => {
    const m = await made();
    const kept = randomBytes(3000);
    const gone = randomBytes(4000);
    await sent(m.project.id, kept);
    await sent(m.project.id, gone);
    unlinkSync(lfsPathOf(m.gitdir, oidOf(gone)));
    await verifyDue(t.db, host, w.time.now, quiet);
    const noted = await t.db
      .select({ oid: lfsObjects.oid })
      .from(lfsObjects)
      .where(and(eq(lfsObjects.provider, "local"), eq(lfsObjects.repoId, m.repoId)));
    expect(noted).toEqual([{ oid: oidOf(kept) }]);
    expect((await l.lookup(m.project.id, [{ oid: oidOf(gone), size: 4000 }])).json).toEqual({
      objects: [{ oid: oidOf(gone), state: "missing" }],
    });
  });

  test("what the disk has under an oid and is not the file, another size or another hash, is put right by sending it again", async () => {
    const m = await made();
    for (const spoil of [(data: Buffer) => data.subarray(0, 100), () => randomBytes(4000)]) {
      const data = randomBytes(4000);
      await sent(m.project.id, data);
      const path = lfsPathOf(m.gitdir, oidOf(data));
      writeFileSync(path, spoil(data));
      await verifyDue(t.db, host, w.time.now, quiet);
      await t.db
        .update(projectRepos)
        .set({ verifiedAt: null })
        .where(eq(projectRepos.projectId, m.project.id));
      // Taken, as a file not there: and once pushed, the file is there.
      const { begun, pushed } = await sent(m.project.id, data);
      expect(begun.json).toMatchObject({ state: "receiving", repo: m.repo });
      expect(pushed).toEqual({ kind: "done" });
      expect(readFileSync(path).equals(data)).toBe(true);
      expect((await l.begin(m.project.id, data)).json).toMatchObject({ state: "present" });
    }
  });

  test("the weekly look reads files through, so many bytes a time, and puts aside one that is not what its name says", async () => {
    const m = await made();
    const good = randomBytes(3000);
    const bad = randomBytes(3000);
    await sent(m.project.id, good);
    await sent(m.project.id, bad);
    const path = lfsPathOf(m.gitdir, oidOf(bad));
    writeFileSync(path, randomBytes(3000));
    await verifyDue(t.db, host, w.time.now, quiet);
    const noted = await t.db
      .select({ oid: lfsObjects.oid })
      .from(lfsObjects)
      .where(and(eq(lfsObjects.provider, "local"), eq(lfsObjects.repoId, m.repoId)));
    expect(noted).toEqual([{ oid: oidOf(good) }]);
    expect(existsSync(path)).toBe(false);
    expect(readdirSync(join(m.gitdir, "lfs", "bad"))).toHaveLength(1);
    expect((await l.lookup(m.project.id, [{ oid: oidOf(bad), size: 3000 }])).json).toEqual({
      objects: [{ oid: oidOf(bad), state: "missing" }],
    });
  });
});
