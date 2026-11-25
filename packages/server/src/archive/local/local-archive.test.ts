import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectStore, type CommandCall } from "@animaquill/core";
import { createProject } from "@animaquill/schema";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import type { SignedIn } from "../../auth/accounts.ts";
import { readLfs } from "../../me/lfs.ts";
import {
  archives,
  lfsObjects,
  projectBatches,
  projectRepos,
  projects,
  repoMerges,
} from "../../schema.ts";
import { SyncHub } from "../../sync/hub.ts";
import { clock, quiet, world, type World } from "../../test/archive-support.ts";
import { createTestDatabase, TEST_DATABASE, type TestDatabase } from "../../test/database.ts";
import { CODE, LINES, Window, withLine } from "../../test/merge-support.ts";
import { Archiver } from "../archiver.ts";
import { ProjectExporter } from "../exporter.ts";
import { Rebuilder } from "../rebuild.ts";
import { RepoHosts, type LocalPlace } from "../repo-host.ts";
import { RepositoryService } from "../service.ts";
import { pushedHere, verifyDue } from "./checks.ts";
import { LocalGitRepoHost } from "./host.ts";
import { linkUnlinked, startLocalRepos } from "./links.ts";
import { loadConfig } from "../../config.ts";

/**
 * Projects saved to repositories of the server's own, on a database: linked as they are made,
 * archived into a bare repository the first archive makes, what people push into it merged into
 * the project, a repository taken away or broken paused without the project going, and a copy let
 * go of made again from it.
 */

const hasGit = spawnSync("git", ["--version"]).status === 0;
if (!hasGit && process.env["CI"]) throw new Error("git is needed for these tests");

const git = (cwd: string, ...args: string[]) => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
};

describe.skipIf(!TEST_DATABASE || !hasGit)(
  "repositories of the server's own, on a database",
  () => {
    let t: TestDatabase;
    let w: World;
    let dataDir: string;
    let host: LocalGitRepoHost;
    beforeAll(async () => {
      t = await createTestDatabase();
    });
    afterAll(async () => {
      await t?.drop();
    });
    beforeEach(async () => {
      w = await world(t.db, clock(new Date()));
      dataDir = mkdtempSync(join(tmpdir(), "aq-local-db-"));
      host = new LocalGitRepoHost({ dataDir, log: quiet });
      await host.prepare();
    });
    afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

    const hosts = () => new RepoHosts({ local: host });
    const queued: string[] = [];
    const archiver = () =>
      new Archiver({
        db: t.db,
        hosts: hosts(),
        exporter: new ProjectExporter({ heapMb: 256 }),
        log: quiet,
        now: () => w.time.now,
        // The switch of the admin site is off: repositories here merge all the same.
        merging: async () => false,
        enqueueMerge: async (merge) => {
          queued.push(merge);
        },
      });
    const service = () =>
      new RepositoryService({
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
    const user = (): SignedIn => ({ userId: w.userId }) as SignedIn;
    const linkRow = async (id: string) =>
      (await t.db.select().from(projectRepos).where(eq(projectRepos.projectId, id)))[0]!;

    /** A project made by a window of a hub that links new ones here, and its first archive. */
    const made = async () => {
      const hub = new SyncHub({ db: t.db, log: quiet, linkLocal: true });
      const store = ProjectStore.create(createProject({ name: "片子" }));
      const run = (call: CommandCall) => {
        const result = store.execute(call);
        if (!result.ok) throw new Error(result.error.code);
      };
      run({ type: "file.write", params: { path: CODE, text: LINES.join("") } });
      const project = `l${Date.now().toString(36)}${Math.floor(Math.random() * 1e9).toString(36)}`;
      const window = await Window.open(
        hub,
        { userId: w.userId, session: `s-${w.userId}` },
        project,
        store,
      );
      const link = await linkRow(project);
      const place: LocalPlace = { provider: "local", repoId: link.repoId, dir: link.localDir! };
      return { hub, window, project, place, gitdir: host.pathOf(place) };
    };

    test("a new project is linked here as it is made, and its first archive makes the repository", async () => {
      const m = await made();
      expect(await linkRow(m.project)).toMatchObject({
        provider: "local",
        installationId: null,
        localDir: `repos/${m.project}.git`,
        state: "ready",
      });
      expect(await host.exists(m.place)).toBe(false);
      expect(await archiver().run(m.project, "first")).toMatchObject({ kind: "archived" });
      git(m.gitdir, "fsck", "--strict", "--no-dangling");
      expect(readFileSync(join(m.gitdir, "config"), "utf8")).toContain(`owner = ${w.userId}`);
      const clone = join(dataDir, "clone");
      git(dataDir, "clone", "--quiet", m.gitdir, clone);
      expect(readFileSync(join(clone, CODE), "utf8")).toBe(LINES.join(""));

      const status = await service().status(user(), m.project);
      expect(status.repository).toMatchObject({ place: "local", clone: m.gitdir });
      expect(status.repository?.url).toBeUndefined();
      expect(status.lastArchive?.url).toBeUndefined();
      expect(service().savesTo).toBe("local");
    });

    test("what people push into it is merged into the project, and the next archive goes on from it", async () => {
      const m = await made();
      await archiver().run(m.project, "first");
      const clone = join(dataDir, "clone");
      git(dataDir, "clone", "--quiet", m.gitdir, clone);
      git(clone, "config", "user.name", "me");
      git(clone, "config", "user.email", "me@example.com");
      writeFileSync(join(clone, CODE), withLine(LINES.join(""), 2, "export const v2 = 22;\n"));
      git(clone, "commit", "--quiet", "-am", "mine");
      git(clone, "push", "--quiet", "origin", "main");
      const pushed = git(clone, "rev-parse", "HEAD").trim();

      // The worker's round finds it once.
      const seen = new Map<string, string>();
      expect(await pushedHere(t.db, host, seen)).toEqual([m.project]);
      expect(await pushedHere(t.db, host, seen)).toEqual([]);

      expect(await archiver().run(m.project, "check")).toMatchObject({ kind: "merging" });
      for (const merge of queued.splice(0)) await m.hub.mergeRepo(merge);
      m.window.hear();
      expect(m.window.store.exportFiles().files.get(CODE)).toContain("v2 = 22");
      const [merge] = await t.db
        .select()
        .from(repoMerges)
        .where(eq(repoMerges.projectId, m.project));
      expect(merge).toMatchObject({ provider: "local", state: "applied", toSha: pushed });
      const [batch] = await t.db
        .select()
        .from(projectBatches)
        .where(eq(projectBatches.projectId, m.project));
      expect(batch?.label).toContain("本机仓库里的改动");

      await m.window.change({
        type: "file.write",
        params: { path: CODE, text: withLine(LINES.join(""), 2, "export const v2 = 23;\n") },
      });
      expect(await archiver().run(m.project, "auto")).toMatchObject({ kind: "archived" });
      expect(git(m.gitdir, "log", "--format=%P", "-1", "main").trim().split(" ")[0]).toBe(pushed);
      git(m.gitdir, "fsck", "--strict", "--no-dangling");
    });

    test("taken away, or broken: paused, and the project stays to be edited", async () => {
      const m = await made();
      await archiver().run(m.project, "first");
      await m.window.change({ type: "file.write", params: { path: "code/b.js", text: "b\n" } });
      rmSync(m.gitdir, { recursive: true });
      expect(await archiver().run(m.project, "auto")).toMatchObject({
        kind: "paused",
        reason: "gone",
      });
      expect(await linkRow(m.project)).toMatchObject({ pauseReason: "gone", unusableSince: null });
      const status = await service().status(user(), m.project);
      expect(status.unusable).toBeUndefined();
      // Still edited as ever.
      expect(
        await m.window.change({ type: "file.write", params: { path: "code/c.js", text: "c\n" } }),
      ).toMatchObject({ t: "ack" });

      const other = await made();
      await archiver().run(other.project, "first");
      const tip = git(other.gitdir, "rev-parse", "main").trim();
      const tree = git(other.gitdir, "rev-parse", "main^{tree}").trim();
      const path = join(other.gitdir, "objects", tree.slice(0, 2), tree.slice(2));
      const bytes = readFileSync(path);
      bytes[bytes.length - 2] = (bytes[bytes.length - 2] ?? 0) ^ 0xff;
      writeFileSync(path, bytes);
      const found = await verifyDue(t.db, host, w.time.now, quiet);
      expect(found.broken).toContain(other.project);
      expect(await linkRow(other.project)).toMatchObject({
        state: "paused",
        pauseReason: "broken",
        unusableSince: null,
      });
      expect(tip).toMatch(/^[0-9a-f]{40}$/);
    });

    test("a copy let go of is made again from the repository here", async () => {
      const m = await made();
      await archiver().run(m.project, "first");
      m.window.peer.connection.close();
      await m.hub.idle();
      expect(await m.hub.release(m.project)).toMatchObject({ kind: "released" });
      const rebuilder = new Rebuilder({
        db: t.db,
        hosts: hosts(),
        exporter: new ProjectExporter({ heapMb: 256 }),
        log: quiet,
        now: () => w.time.now,
        lookAgain: async () => {},
      });
      await t.db.update(projects).set({ copyState: "restoring" }).where(eq(projects.id, m.project));
      expect(await rebuilder.run(m.project)).toMatchObject({ kind: "rebuilt", generation: 2 });
    });

    test("projects without a repository are linked here as the worker starts; nothing of Git LFS", async () => {
      const m = await made();
      await t.db.delete(projectRepos).where(eq(projectRepos.projectId, m.project));
      expect(await linkUnlinked(t.db, w.time.now, quiet)).toBeGreaterThanOrEqual(1);
      const link = await linkRow(m.project);
      expect(link).toMatchObject({ provider: "local", localDir: `repos/${m.project}.git` });
      // An object noted for a repository on GitHub of the same number is not this one's.
      await t.db
        .insert(lfsObjects)
        .values({ repoId: link.repoId, oid: "a".repeat(64), size: 5 })
        .onConflictDoNothing();
      const lfs = await readLfs(t.db, w.userId);
      expect(lfs.repositories.map((each) => each.project.id)).not.toContain(m.project);
      expect(await t.db.select().from(archives).where(eq(archives.projectId, m.project))).toEqual(
        [],
      );
    });

    test("starting over puts the repository aside, never away, and archives the project into a new one", async () => {
      const m = await made();
      await archiver().run(m.project, "first");
      await expect(service().restart(user(), m.project)).rejects.toMatchObject({
        code: "notBroken",
      });
      const tree = git(m.gitdir, "rev-parse", "main^{tree}").trim();
      const path = join(m.gitdir, "objects", tree.slice(0, 2), tree.slice(2));
      const bytes = readFileSync(path);
      bytes[bytes.length - 2] = (bytes[bytes.length - 2] ?? 0) ^ 0xff;
      writeFileSync(path, bytes);
      await verifyDue(t.db, host, w.time.now, quiet);
      const before = await linkRow(m.project);
      expect(before.pauseReason).toBe("broken");

      const status = await service().restart(user(), m.project);
      expect(status).toMatchObject({ state: "ready", repository: { place: "local" } });
      const after = await linkRow(m.project);
      expect(after.repoId).not.toBe(before.repoId);
      expect(after).toMatchObject({ localDir: before.localDir, headSha: null, archivedSeq: 0 });
      const aside = readdirSync(join(dataDir, "repos", "broken"));
      expect(aside).toHaveLength(1);
      expect(aside[0]).toMatch(new RegExp(`^${m.project}-\\d{8}T\\d{6}Z\\.git$`));

      expect(await archiver().run(m.project, "first")).toMatchObject({ kind: "archived" });
      git(m.gitdir, "fsck", "--strict", "--no-dangling");
      expect(git(m.gitdir, "log", "--format=%s", "main").trim().split("\n")).toHaveLength(2);
      // What was put aside is still there, as it was.
      expect(readdirSync(join(dataDir, "repos", "broken"))).toEqual(aside);
    });

    test("a repository no project is saved to any more is listed for its person, and restored", async () => {
      const m = await made();
      await archiver().run(m.project, "first");
      m.window.peer.connection.close();
      await m.hub.idle();
      await t.db.delete(projects).where(eq(projects.id, m.project));
      expect(await host.exists(m.place)).toBe(true);

      const rebuilt: string[] = [];
      const restoring = new RepositoryService({
        db: t.db,
        host: undefined,
        people: undefined,
        local: host,
        tokenFor: undefined,
        enqueue: async () => {},
        isQueued: async () => false,
        webUrl: "https://github.test",
        log: quiet,
        restoreWaitMs: 50,
        rebuild: async (id) => {
          rebuilt.push(id);
        },
      });
      const listed = await restoring.localRepositories(user());
      expect(listed.repositories).toEqual([
        { dir: `repos/${m.project}.git`, name: "片子", project: expect.any(String) },
      ]);
      const someoneElse = { userId: "0190a000-0000-7000-8000-0000000000ff" } as SignedIn;
      expect((await restoring.localRepositories(someoneElse)).repositories).toEqual([]);
      await expect(
        restoring.restoreLocal(someoneElse, `repos/${m.project}.git`),
      ).rejects.toMatchObject({ code: "notFound" });

      const restored = await restoring.restoreLocal(user(), `repos/${m.project}.git`);
      expect(restored).toMatchObject({ project: { name: "片子" }, copy: "restoring" });
      expect(rebuilt).toEqual([restored.project.id]);
      const link = await linkRow(restored.project.id);
      expect(link).toMatchObject({ provider: "local", localDir: `repos/${m.project}.git` });
      const rebuilder = new Rebuilder({
        db: t.db,
        hosts: hosts(),
        exporter: new ProjectExporter({ heapMb: 256 }),
        log: quiet,
        now: () => w.time.now,
        lookAgain: async () => {},
      });
      expect(await rebuilder.run(restored.project.id)).toMatchObject({ kind: "rebuilt" });
      expect((await restoring.localRepositories(user())).repositories).toEqual([]);
    });

    test("projects were archived here and repos/ is not there: nothing is made in its place", async () => {
      const m = await made();
      await archiver().run(m.project, "first");
      rmSync(join(dataDir, "repos"), { recursive: true, force: true });
      const said: string[] = [];
      const log = {
        ...quiet,
        error: (_: object, message?: string) => void said.push(message ?? ""),
      };
      const config = loadConfig({ AQ_DATA_DIR: dataDir }, () => undefined);
      const started = await startLocalRepos(config, log, t.db);
      expect(started).toBeDefined();
      expect(existsSync(join(dataDir, "repos"))).toBe(false);
      expect(said.join(" ")).toContain("is the data volume mounted");
      // Archives wait, as for a repository that cannot be reached now: never "gone".
      const archiving = new Archiver({
        db: t.db,
        hosts: new RepoHosts({ local: started }),
        exporter: new ProjectExporter({ heapMb: 256 }),
        log: quiet,
        now: () => w.time.now,
      });
      await m.window.change({ type: "file.write", params: { path: "code/c.js", text: "c\n" } });
      expect(await archiving.run(m.project, "auto")).toMatchObject({ kind: "failed" });
      expect(await linkRow(m.project)).toMatchObject({ state: "ready", pauseReason: null });
    });
  },
);
