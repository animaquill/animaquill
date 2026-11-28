import { OWNER_ONLY } from "../access.ts";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import {
  Editor,
  edit,
  linkTo,
  newProject,
  quiet,
  world,
  write,
  type World,
} from "../test/archive-support.ts";
import { createTestDatabase, TEST_DATABASE, type TestDatabase } from "../test/database.ts";
import { platform, type Platform } from "../test/platform-support.ts";
import { changeableLimits } from "../test/limits-support.ts";
import { fixedLimits } from "../limits.ts";
import { platformHeld } from "../sync/room.ts";
import { projectRepos, projects } from "../schema.ts";
import { SyncHub } from "../sync/hub.ts";
import { wakeCopy } from "../sync/wake.ts";
import { Archiver } from "./archiver.ts";
import { ProjectExporter } from "./exporter.ts";
import { READ_MOST_BYTES, Rebuilder, sweepRestoring } from "./rebuild.ts";
import { RepoHosts, type GitHubPlace, type RepoHost, type RepoSession } from "./repo-host.ts";

/**
 * What keeps making working copies from repositories within bounds (the review of step RB): how
 * much of a repository is read, how long it may take, what is left of a restore that failed, how
 * often a copy that does not come is tried again, and the way out once people put the repository
 * right. On a real PostgreSQL and the fake GitHub. Needs AQ_TEST_DATABASE, see vitest.config.ts.
 */

const MB = 1024 * 1024;

describe.skipIf(!TEST_DATABASE)("making working copies within bounds, on a database", () => {
  let t: TestDatabase;
  let w: World;
  let p: Platform;
  let hub: SyncHub;
  /** Bytes of files the worker read of repositories. */
  let read = 0;
  /** Whether the worker runs what it is asked at once. */
  let busy = false;
  beforeAll(async () => {
    t = await createTestDatabase();
  });
  afterAll(async () => {
    await t?.drop();
  });

  /** The host of the world, counting the bytes of files read for a copy. */
  const counting = (): RepoHost<GitHubPlace> => ({
    open: (place, options) => {
      const session = w.host.open(place, options);
      return new Proxy(session, {
        get(target, prop) {
          if (prop === "files")
            return async (...args: Parameters<RepoSession["files"]>) => {
              const files = await target.files(...args);
              for (const bytes of files.values()) read += bytes.length;
              return files;
            };
          const value = (target as unknown as Record<string | symbol, unknown>)[prop];
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as RepoSession;
    },
  });
  const rebuilder = (deadlineMs?: number) =>
    new Rebuilder({
      db: t.db,
      hosts: RepoHosts.github(counting()),
      exporter: new ProjectExporter({ heapMb: 256 }),
      log: quiet,
      now: () => w.time.now,
      ...(deadlineMs !== undefined && { deadlineMs }),
    });

  beforeEach(async () => {
    w = await world(t.db);
    read = 0;
    busy = false;
    hub = new SyncHub({ db: t.db, log: quiet, now: () => w.time.now });
    p = await platform(w, {
      hub,
      rebuild: async (id) => {
        if (!busy) void rebuilder().run(id);
      },
      restoreWaitMs: 60_000,
      now: () => w.time.now.getTime(),
    });
  });
  afterEach(() => {
    hub.stop();
  });

  const rowOf = async (id: string) =>
    (await t.db.select().from(projects).where(eq(projects.id, id)))[0];
  const restore = (repoId: number) =>
    p.request("POST", "/api/projects/restore", { existing: { id: repoId } });

  /** A repository that has a project, whose project on the platform was deleted. */
  const leftBehind = async (name: string) => {
    const project = await newProject(w);
    await edit(w, project, write("code/a.js", "export const a = 1;\n"));
    const repo = w.github.addRepo(w.person, { name, select: true });
    await linkTo(w, project.id, repo);
    await w.archiver().run(project.id, "first");
    expect(await hub.remove(project.id, w.userId, { discard: true })).toBe("removed");
    return { project, repo };
  };

  test("code too large to be the editor's is not read at all", async () => {
    const { repo } = await leftBehind("big-code");
    const big = "x".repeat(9 * MB);
    const files: Record<string, string> = {};
    for (let index = 0; index < 12; index++) files[`code/big-${index}.js`] = big + index;
    w.github.commitAs(repo.id, w.person, files);
    const restored = await restore(repo.id);
    expect(restored.status).toBe(201);
    // Only what the project is made of came into the worker.
    expect(read).toBeLessThan(MB);
  }, 120_000);

  test("documents larger, together, than a project may be are turned away before any is read", async () => {
    const { repo } = await leftBehind("big-documents");
    const files: Record<string, string> = {};
    const each = Math.ceil(READ_MOST_BYTES / 4) + 1024;
    for (let index = 0; index < 4; index++) files[`scenes/s${index}/scene.json`] = "x".repeat(each);
    w.github.commitAs(repo.id, w.person, files);
    const restored = await restore(repo.id);
    expect(restored).toMatchObject({ status: 413, json: { error: "tooLarge" } });
    expect(read).toBe(0);
    // And nothing is left of it.
    expect(await t.db.select().from(projectRepos).where(eq(projectRepos.repoId, repo.id))).toEqual(
      [],
    );
  }, 120_000);

  test("an animaquill.json too large is not read into the API", async () => {
    const repo = w.github.addRepo(w.person, {
      name: "big-manifest",
      select: true,
      files: { "animaquill.json": `{"id":"p","pad":"${"x".repeat(2 * MB)}"}` },
    });
    w.github.calls.length = 0;
    expect(await restore(repo.id)).toMatchObject({ status: 413, json: { error: "tooLarge" } });
    expect(w.github.calls.filter((call) => call.includes("/git/blobs/"))).toEqual([]);
  });

  test("a restore that answered that it goes on, and then failed, leaves nothing that holds the repository", async () => {
    const { repo } = await leftBehind("leftover");
    busy = true;
    p = await platform(w, { hub, rebuild: async () => {}, restoreWaitMs: 200 });
    const restored = await restore(repo.id);
    expect(restored.status).toBe(202);
    const id = restored.json.project.id as string;
    // GitHub fails as the worker reads it: tried again a few times, then given up.
    w.github.faults.down = 1000;
    const outcomes = [];
    for (let attempt = 0; attempt < 5 && (await rowOf(id)); attempt++) {
      outcomes.push((await rebuilder().run(id)).kind);
      w.time.later(60 * 60_000);
    }
    w.github.faults.down = 0;
    expect(outcomes).toEqual(["failed", "failed", "failed"]);
    expect(await rowOf(id)).toBeUndefined();
    expect(await t.db.select().from(projectRepos).where(eq(projectRepos.repoId, repo.id))).toEqual(
      [],
    );
    // The same repository again: as the first time.
    busy = false;
    p = await platform(w, {
      hub,
      rebuild: async (each) => void rebuilder().run(each),
      restoreWaitMs: 60_000,
    });
    expect((await restore(repo.id)).status).toBe(201);

    // One that does not read goes at once.
    const broken = w.github.addRepo(w.person, {
      name: "broken",
      select: true,
      files: {
        "animaquill.json": new Editor().store.exportFiles().files.get("animaquill.json")!,
        "timelines/main/timeline.json": "{ not json",
      },
    });
    p = await platform(w, { hub, rebuild: async () => {}, restoreWaitMs: 200 });
    const late = await restore(broken.id);
    expect(late.status).toBe(202);
    expect(await rebuilder().run(late.json.project.id)).toMatchObject({
      kind: "failed",
      problem: { code: "unreadable" },
    });
    expect(await rowOf(late.json.project.id)).toBeUndefined();
  });

  test("a copy that does not come for what the repository has is not read again for hours; from the branch once it is put right", async () => {
    const project = await newProject(w);
    await edit(w, project, write("code/a.js", "a\n"));
    const repo = w.github.addRepo(w.person, { name: "stuck", select: true });
    await linkTo(w, project.id, repo);
    await w.archiver().run(project.id, "first");
    expect((await hub.release(project.id)).kind).toBe("released");
    // As if what the archive has does not pass the checks of this platform (a newer check).
    const broken = w.github.commitAs(repo.id, w.person, {
      "timelines/main/timeline.json": "{ not json",
    });
    const row = (await rowOf(project.id))!;
    await t.db
      .update(projects)
      .set({ releasedFrom: { ...row.releasedFrom!, headSha: broken } })
      .where(eq(projects.id, project.id));
    const outcomes: string[] = [];
    for (let minute = 0; minute < 5; minute++) {
      const woke = await wakeCopy(
        t.db,
        project.id,
        { userId: w.userId, access: OWNER_ONLY },
        w.time.now,
      );
      if (woke.copy === "restoring") {
        const outcome = await rebuilder().run(project.id);
        outcomes.push(`${outcome.kind}:${"problem" in outcome ? outcome.problem.code : ""}`);
      } else outcomes.push(woke.copy);
      w.time.later(61_000);
    }
    expect(outcomes).toEqual(["failed:unreadable", "released", "released", "released", "released"]);
    // The status says why, for the editor.
    const status = await p.request("GET", `/api/projects/${project.id}/repository`);
    expect(status.json).toMatchObject({ copy: "released", copyProblem: { code: "unreadable" } });
    expect(status.json.copyProblem.retryAt - w.time.now.getTime()).toBeGreaterThan(3600_000);

    // Only after a failure for what the repository has.
    const other = await newProject(w);
    expect(
      await wakeCopy(t.db, other.id, { userId: w.userId, access: OWNER_ONLY }, w.time.now, {
        fromBranch: true,
      }),
    ).toMatchObject({ copy: "live" });
    // People put the branch right on GitHub, and ask for the copy from it.
    const fixed = w.github.commitAs(repo.id, w.person, {
      "timelines/main/timeline.json": project.editor.store
        .exportFiles()
        .files.get("timelines/main/timeline.json")!,
    });
    // The test runs the worker itself.
    busy = true;
    const woke = await p.send("POST", `/api/projects/${project.id}/wake`, {
      payload: JSON.stringify({ fromBranch: true }),
      headers: { "content-type": "application/json" },
    });
    expect(woke).toMatchObject({ status: 202, json: { copy: "restoring" } });
    expect(await rebuilder().run(project.id)).toMatchObject({ kind: "rebuilt", generation: 2 });
    expect(
      await t.db.select().from(projectRepos).where(eq(projectRepos.projectId, project.id)),
    ).toMatchObject([{ headSha: fixed }]);
    // Not what the copy before had in common with it: said so, not by a number.
    expect((await rowOf(project.id))!.releasedFrom).toMatchObject({
      archivedSeq: 2,
      commonBase: false,
    });
    expect((await p.request("GET", `/api/projects/${project.id}/repository`)).json).toMatchObject({
      rebuiltFrom: { generation: 1, archivedSeq: 2, commonBase: false },
    });
  });

  test("a copy that takes too long to make stops, and is let go of again", async () => {
    const project = await newProject(w);
    await edit(w, project, write("code/a.js", "a\n"));
    const repo = w.github.addRepo(w.person, { name: "slow", select: true });
    await linkTo(w, project.id, repo);
    await w.archiver().run(project.id, "first");
    expect((await hub.release(project.id)).kind).toBe("released");
    await wakeCopy(t.db, project.id, { userId: w.userId, access: OWNER_ONLY }, w.time.now);
    w.github.faults.delayMs = 400;
    const began = Date.now();
    const outcome = await rebuilder(1000).run(project.id);
    expect(Date.now() - began).toBeLessThan(5000);
    w.github.faults.delayMs = 0;
    expect(outcome).toMatchObject({ kind: "failed", problem: { code: "unavailable" } });
    expect(await rowOf(project.id)).toMatchObject({ copyState: "released" });

    // An archive too.
    const other = await newProject(w);
    const otherRepo = w.github.addRepo(w.person, { name: "slow-archive", select: true });
    await linkTo(w, other.id, otherRepo);
    w.github.faults.delayMs = 400;
    const archiver = new Archiver({
      db: t.db,
      hosts: RepoHosts.github(w.host),
      exporter: new ProjectExporter({ heapMb: 256 }),
      log: quiet,
      now: () => w.time.now,
      deadlineMs: 1000,
    });
    const started = Date.now();
    expect(await archiver.run(other.id, "first")).toMatchObject({ kind: "failed" });
    expect(Date.now() - started).toBeLessThan(5000);
    w.github.faults.delayMs = 0;
  });

  test("a copy whose making stopped with the worker is queued again, and given up on after a few", async () => {
    const project = await newProject(w);
    const repo = w.github.addRepo(w.person, { name: "crash", select: true });
    await linkTo(w, project.id, repo);
    await w.archiver().run(project.id, "first");
    await hub.release(project.id);
    await wakeCopy(t.db, project.id, { userId: w.userId, access: OWNER_ONLY }, w.time.now);
    const queued: string[] = [];
    const enqueue = async (id: string) => void queued.push(id);
    // Not begun: queued.
    await sweepRestoring(t.db, { now: w.time.now, enqueue });
    expect(queued).toEqual([project.id]);
    // Begun a moment ago: it runs.
    await t.db
      .update(projects)
      .set({ rebuildAttempts: 1, rebuildStartedAt: w.time.now })
      .where(eq(projects.id, project.id));
    queued.length = 0;
    await sweepRestoring(t.db, { now: w.time.now, enqueue });
    expect(queued).toEqual([]);
    // Begun long ago, and the worker went: again.
    w.time.later(30 * 60_000);
    await sweepRestoring(t.db, { now: w.time.now, enqueue });
    expect(queued).toEqual([project.id]);
    // The third time the worker went with it: not again until it is asked for, after a while.
    await t.db
      .update(projects)
      .set({ rebuildAttempts: 3, rebuildStartedAt: new Date(w.time.now.getTime() - 3600_000) })
      .where(eq(projects.id, project.id));
    queued.length = 0;
    await sweepRestoring(t.db, { now: w.time.now, enqueue });
    expect(queued).toEqual([]);
    expect(await rowOf(project.id)).toMatchObject({
      copyState: "released",
      copyProblem: { code: "unavailable" },
    });
    expect(
      await wakeCopy(t.db, project.id, { userId: w.userId, access: OWNER_ONLY }, w.time.now),
    ).toMatchObject({
      copy: "released",
      why: "later",
    });
  });

  test("two restores at once do not go past the projects a person may have", async () => {
    const repos = [];
    for (let index = 0; index < 2; index++) repos.push((await leftBehind(`two-${index}`)).repo);
    const held = (await t.db.select().from(projects).where(eq(projects.ownerId, w.userId))).length;
    p = await platform(w, {
      hub,
      rebuild: async (id) => void rebuilder().run(id),
      restoreWaitMs: 60_000,
      limits: fixedLimits({ "projects.count": held + 1 }),
    });
    const answers = await Promise.all(repos.map((repo) => restore(repo.id)));
    expect(answers.map((answer) => answer.status).toSorted()).toEqual([201, 409]);
    expect(answers.find((answer) => answer.status === 409)?.json).toEqual({
      error: "quota",
      detail: "count",
      used: held + 1,
      limit: held + 1,
    });
    expect((await t.db.select().from(projects).where(eq(projects.ownerId, w.userId))).length).toBe(
      held + 1,
    );
  });

  test("a restore is turned away where the person keeps more than they may already, and only then", async () => {
    const { repo } = await leftBehind("over");
    // A project they keep, which takes room.
    const there = await newProject(w);
    await edit(w, there, write("code/b.js", "export const b = 2;\n"));
    const { bytes: used } = await platformHeld(t.db, w.userId, "person");
    expect(used).toBeGreaterThan(0);
    const limits = changeableLimits();
    p = await platform(w, {
      hub,
      rebuild: async (id) => void rebuilder().run(id),
      restoreWaitMs: 60_000,
      limits,
    });
    limits.set({ "storage.platform": used - 1 });
    expect(await restore(repo.id)).toMatchObject({
      status: 409,
      json: { error: "quota", used, limit: used - 1 },
    });
    // Nothing is left of it.
    expect(await t.db.select().from(projectRepos).where(eq(projectRepos.repoId, repo.id))).toEqual(
      [],
    );
    // As much as they may keep, but not more: it is made, however large it is once it is there.
    limits.set({ "storage.platform": used });
    const restored = await restore(repo.id);
    expect(restored.status).toBe(201);
    expect(await rowOf(restored.json.project.id)).toMatchObject({ copyState: "live" });
  });
});
