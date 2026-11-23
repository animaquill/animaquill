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
import { projectRepos, projects } from "../schema.ts";
import { SyncHub } from "../sync/hub.ts";
import { ProjectExporter } from "./exporter.ts";
import { Rebuilder } from "./rebuild.ts";

/**
 * Restoring a repository as a project, and asking for a working copy the platform let go of, as the
 * editor does through the API: `POST /api/projects/restore`, `POST /api/projects/:id/wake`, and
 * what the list and the status say of the copy. The worker is a Rebuilder the test runs as it is
 * asked. Needs AQ_TEST_DATABASE, see vitest.config.ts.
 */

describe.skipIf(!TEST_DATABASE)("restoring repositories through the API, on a database", () => {
  let t: TestDatabase;
  let w: World;
  let p: Platform;
  let hub: SyncHub;
  /** What the platform had the worker do; `work` runs it, as the worker would. */
  let asked: string[];
  /** Whether the worker runs what it is asked at once. */
  let busy: boolean;
  beforeAll(async () => {
    t = await createTestDatabase();
  });
  afterAll(async () => {
    await t?.drop();
  });
  beforeEach(async () => {
    w = await world(t.db);
    asked = [];
    busy = false;
    hub = new SyncHub({ db: t.db, log: quiet, now: () => w.time.now });
    p = await platform(w, {
      hub,
      rebuild: async (id) => {
        asked.push(id);
        if (!busy) void rebuilder().run(id);
      },
      restoreWaitMs: 20_000,
      now: () => w.time.now.getTime(),
    });
  });
  afterEach(() => {
    hub.stop();
  });

  const rebuilder = () =>
    new Rebuilder({
      db: t.db,
      host: w.host,
      exporter: new ProjectExporter({ heapMb: 256 }),
      log: quiet,
      now: () => w.time.now,
    });
  const rowOf = async (id: string) =>
    (await t.db.select().from(projects).where(eq(projects.id, id)))[0];

  /** A repository that has a project, whose project on the platform was deleted. */
  const leftBehind = async (name = "film") => {
    const project = await newProject(w);
    await edit(w, project, write("code/a.js", "export const a = 1;\n"));
    const repo = w.github.addRepo(w.person, { name, select: true });
    await linkTo(w, project.id, repo);
    await w.archiver().run(project.id, "first");
    expect(await hub.remove(project.id, w.userId, { discard: true })).toBe("removed");
    return { project, repo };
  };

  test("restores a repository that has a project as a new project, which the list has", async () => {
    const { project, repo } = await leftBehind();
    // Linking turns it away, as it has a project.
    const check = await p.request("POST", "/api/github/repositories/check", {
      existing: { id: repo.id },
    });
    expect(check.json).toMatchObject({ ok: false, reason: "hasProject" });

    const restored = await p.request("POST", "/api/projects/restore", {
      existing: { id: repo.id },
    });
    expect(restored.status).toBe(201);
    expect(restored.json).toEqual({
      project: { id: expect.any(String), name: "测试" },
      copy: "live",
    });
    const id = restored.json.project.id as string;
    expect(id).not.toBe(project.id);
    expect(await rowOf(id)).toMatchObject({
      copyState: "live",
      generation: 1,
      head: 1,
      projectId: project.editor.projectId,
    });
    const status = await p.request("GET", `/api/projects/${id}/repository`);
    expect(status.json).toMatchObject({
      state: "ready",
      copy: "live",
      generation: 1,
      head: 1,
      archivedSeq: 1,
      repository: { id: repo.id, createdHere: false },
    });
    expect(status.json).not.toHaveProperty("rebuiltFrom");
    const list = await p.request("GET", "/api/projects");
    expect(list.json.projects.find((each: { id: string }) => each.id === id)).toMatchObject({
      copy: "live",
      repository: { id: repo.id },
      archive: { seq: 1, behind: false },
    });
    // The same again: it is that project's now.
    const again = await p.request("POST", "/api/projects/restore", { existing: { id: repo.id } });
    expect(again).toMatchObject({
      status: 409,
      json: { error: "linkedElsewhere", project: { id, name: "测试" } },
    });
  });

  test("turns away what is no project, what does not read, and what is not the person's", async () => {
    const broken = w.github.addRepo(w.person, {
      name: "broken",
      select: true,
      files: {
        "animaquill.json": new Editor().store.exportFiles().files.get("animaquill.json")!,
        "timelines/main/timeline.json": "{ not json",
      },
    });
    const before = (await t.db.select().from(projects).where(eq(projects.ownerId, w.userId)))
      .length;
    const unreadable = await p.request("POST", "/api/projects/restore", {
      existing: { id: broken.id },
    });
    expect(unreadable.status).toBe(422);
    expect(unreadable.json.error).toBe("unreadable");
    expect(unreadable.json.files).toContain("timelines/main/timeline.json");
    // Nothing is left of it, and the repository can be chosen again.
    expect((await t.db.select().from(projects).where(eq(projects.ownerId, w.userId))).length).toBe(
      before,
    );
    expect(
      await t.db.select().from(projectRepos).where(eq(projectRepos.repoId, broken.id)),
    ).toEqual([]);

    const notes = w.github.addRepo(w.person, {
      name: "notes",
      select: true,
      files: { "README.md": "#\n" },
    });
    expect(
      await p.request("POST", "/api/projects/restore", { existing: { id: notes.id } }),
    ).toMatchObject({ status: 409, json: { error: "noProject" } });
    const empty = w.github.addRepo(w.person, { name: "empty", select: true });
    expect(
      await p.request("POST", "/api/projects/restore", { existing: { id: empty.id } }),
    ).toMatchObject({ status: 409, json: { error: "noProject" } });

    const { repo: open } = await leftBehind("open");
    w.github.setPrivate(open.id, false);
    expect(
      await p.request("POST", "/api/projects/restore", { existing: { id: open.id } }),
    ).toMatchObject({ status: 409, json: { error: "public" } });
    expect(
      (
        await p.request("POST", "/api/projects/restore", {
          existing: { id: open.id },
          confirmPublic: true,
        })
      ).status,
    ).toBe(201);

    const someoneElse = w.github.addRepo({ id: 99_999_001, login: "someone" }, { name: "theirs" });
    expect(
      await p.request("POST", "/api/projects/restore", { existing: { id: someoneElse.id } }),
    ).toMatchObject({ status: 404, json: { error: "notFound" } });
    expect(
      await p.request("POST", "/api/projects/restore", { create: { name: "x" } }),
    ).toMatchObject({ status: 400, json: { error: "invalid" } });
  });

  test("says that it goes on where the worker takes longer, and the list says when it is there", async () => {
    const { repo } = await leftBehind();
    busy = true;
    p = await platform(w, {
      hub,
      rebuild: async (id) => {
        asked.push(id);
      },
      restoreWaitMs: 300,
    });
    const restored = await p.request("POST", "/api/projects/restore", {
      existing: { id: repo.id },
    });
    expect(restored.status).toBe(202);
    expect(restored.json).toMatchObject({ copy: "restoring" });
    const id = restored.json.project.id as string;
    expect(asked).toEqual([id]);
    const listed = async () =>
      (await p.request("GET", "/api/projects")).json.projects.find(
        (each: { id: string }) => each.id === id,
      );
    expect(await listed()).toMatchObject({ copy: "restoring" });
    expect(await rebuilder().run(id)).toMatchObject({ kind: "rebuilt" });
    expect(await listed()).toMatchObject({ copy: "live" });
  });

  test("asking for a copy the platform let go of makes it again, and the status says from where", async () => {
    const project = await newProject(w);
    await edit(w, project, write("code/a.js", "a"));
    const repo = w.github.addRepo(w.person, { name: "film", select: true });
    await linkTo(w, project.id, repo);
    await w.archiver().run(project.id, "first");
    busy = true;
    expect((await hub.release(project.id)).kind).toBe("released");
    const listed = async () =>
      (await p.request("GET", "/api/projects")).json.projects.find(
        (each: { id: string }) => each.id === project.id,
      );
    expect(await listed()).toMatchObject({ copy: "released" });
    expect((await p.request("GET", `/api/projects/${project.id}/repository`)).json).toMatchObject({
      copy: "released",
      generation: 1,
    });

    const woke = await p.send("POST", `/api/projects/${project.id}/wake`);
    expect(woke).toMatchObject({ status: 202, json: { copy: "restoring" } });
    expect(asked).toEqual([project.id]);
    // Again while on its way: queued again, which does nothing where it waits.
    expect((await p.send("POST", `/api/projects/${project.id}/wake`)).status).toBe(202);
    expect(await rebuilder().run(project.id)).toMatchObject({ kind: "rebuilt", generation: 2 });
    expect(await p.send("POST", `/api/projects/${project.id}/wake`)).toMatchObject({
      status: 200,
      json: { copy: "live" },
    });
    expect((await p.request("GET", `/api/projects/${project.id}/repository`)).json).toMatchObject({
      copy: "live",
      generation: 2,
      head: 3,
      archivedSeq: 3,
      rebuiltFrom: { generation: 1, archivedSeq: 2, commonBase: true },
    });

    // Where it fails, the list says why, and it is not tried again at once.
    await t.db.update(projects).set({ copyState: "released" }).where(eq(projects.id, project.id));
    await t.db
      .update(projects)
      .set({ copyProblem: { code: "unavailable", at: w.time.now.getTime() } })
      .where(eq(projects.id, project.id));
    expect(await listed()).toMatchObject({ copyProblem: { code: "unavailable" } });
    const soon = await p.send("POST", `/api/projects/${project.id}/wake`);
    expect(soon).toMatchObject({ status: 429, json: { error: "busy" } });
    expect(Number(soon.headers["retry-after"])).toBeGreaterThan(0);
    // One without a repository, or whose repository cannot be used, is not made again.
    await t.db
      .update(projectRepos)
      .set({ unusableSince: w.time.now })
      .where(eq(projectRepos.projectId, project.id));
    w.time.later(10 * 60_000);
    expect(await p.send("POST", `/api/projects/${project.id}/wake`)).toMatchObject({
      status: 409,
      json: { error: "unusable", copy: "released" },
    });
    await t.db.delete(projectRepos).where(eq(projectRepos.projectId, project.id));
    expect(await p.send("POST", `/api/projects/${project.id}/wake`)).toMatchObject({
      status: 409,
      json: { error: "noRepository" },
    });
    // Nobody else's, and not without this site.
    expect((await p.send("POST", `/api/projects/nothing-here/wake`)).status).toBe(404);
    expect(
      (await p.send("POST", `/api/projects/${project.id}/wake`, { fromHere: false })).status,
    ).toBe(403);
  });
});
