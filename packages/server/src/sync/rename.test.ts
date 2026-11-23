import { ProjectStore } from "@animaquill/core";
import { RepoHosts } from "../archive/repo-host.ts";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { OWNER_ONLY } from "../access.ts";
import { ProjectExporter } from "../archive/exporter.ts";
import { pauseLink } from "../archive/links.ts";
import { Rebuilder } from "../archive/rebuild.ts";
import { clock, quiet, world, type World } from "../test/archive-support.ts";
import { createTestDatabase, TEST_DATABASE, type TestDatabase } from "../test/database.ts";
import {
  archiveAndMerge,
  mergeWorld,
  platformFiles,
  projectFilesOf,
  Window,
  type MergeWorld,
} from "../test/merge-support.ts";
import { platform, type Platform } from "../test/platform-support.ts";
import { projectBatches, projects } from "../schema.ts";
import { RENAME_BATCH } from "./hub.ts";
import { NAME_BODY_BYTES } from "./routes.ts";
import { wakeCopy } from "./wake.ts";

/**
 * Renaming a project from the start page without opening it (`PUT /api/projects/:id/name`,
 * `SyncHub.rename`): written by the platform into the working copy as a batch of its own, which
 * the windows of the project hear at once, the list says, the next archive writes, and which goes
 * back as a whole as a merge from GitHub does. On a real PostgreSQL and the fake GitHub. Needs
 * AQ_TEST_DATABASE, see vitest.config.ts.
 */

describe.skipIf(!TEST_DATABASE)("renaming a project from the start page, on a database", () => {
  let t: TestDatabase;
  let w: World;
  let m: MergeWorld;
  let p: Platform;
  /** Copies the platform had the worker make again. */
  let rebuilt: string[];
  beforeAll(async () => {
    t = await createTestDatabase();
  });
  afterAll(async () => {
    await t?.drop();
  });
  beforeEach(async () => {
    w = await world(t.db, clock(new Date()));
    m = await mergeWorld(w);
    rebuilt = [];
    p = await platform(w, {
      hub: m.hub,
      rebuild: async (id) => {
        rebuilt.push(id);
      },
      now: () => w.time.now.getTime(),
    });
  });

  const rename = (name: unknown, project = m.project) =>
    p.request("PUT", `/api/projects/${project}/name`, { name });
  const nameOf = () => {
    m.window.hear();
    return m.window.store.getState().manifest.name;
  };
  const rowOf = async () =>
    (await t.db.select().from(projects).where(eq(projects.id, m.project)))[0];
  const batchesOf = () =>
    t.db.select().from(projectBatches).where(eq(projectBatches.projectId, m.project));
  const listed = async () =>
    (await p.request("GET", "/api/projects")).json.projects.find(
      (each: { id: string }) => each.id === m.project,
    );

  test("renames the working copy as a batch of the platform's, which the windows hear at once and the list says", async () => {
    expect(nameOf()).toBe("测试");
    const renamed = await rename("  宣传片  ");
    expect(renamed.status).toBe(200);
    expect(renamed.json).toEqual({
      name: "宣传片",
      batch: expect.any(String),
      seq: expect.any(Number),
    });
    // The window that has the project open: the name, and who wrote it.
    expect(nameOf()).toBe("宣传片");
    const [heard] = m.window.peer.of("update").slice(-1);
    expect(heard?.by).toEqual({
      batch: renamed.json.batch,
      kind: RENAME_BATCH,
      label: "在开始页改名为「宣传片」",
      files: 1,
    });
    expect(await rowOf()).toMatchObject({ name: "宣传片", head: renamed.json.seq });
    expect(await listed()).toMatchObject({ name: "宣传片" });
    const [batch] = (await batchesOf()).filter(({ kind }) => kind === RENAME_BATCH);
    expect(batch).toMatchObject({ id: renamed.json.batch, seq: renamed.json.seq, files: 1 });
    expect(batch?.undo).not.toBeNull();
    expect((await platformFiles(m)).get("animaquill.json")).toContain('"name": "宣传片"');
    // A window that comes later reads it as any change, and hears what it was.
    const later = await Window.open(m.hub, m.who, m.project);
    const updates = later.peer.of("update");
    const { store } = ProjectStore.fromUpdates(updates.map(({ payload }) => payload));
    expect(store?.getState().manifest.name).toBe("宣传片");
    expect(updates.at(-1)?.by).toMatchObject({ kind: RENAME_BATCH });

    // Called so already: nothing is written.
    const again = await rename("宣传片");
    expect(again).toMatchObject({ status: 200, json: { name: "宣传片" } });
    expect(again.json).not.toHaveProperty("batch");
    expect(await batchesOf()).toHaveLength(1);
  });

  test("the next archive writes the new name into the repository", async () => {
    await archiveAndMerge(m);
    expect((await rename("宣传片")).status).toBe(200);
    expect((await archiveAndMerge(m)).map(({ kind }) => kind)).toContain("archived");
    expect(projectFilesOf(m).get("animaquill.json")).toContain('"name": "宣传片"');
  });

  test("goes back as a whole as a merge does, and again", async () => {
    const renamed = await rename("宣传片");
    const taken = await m.hub.takeBack(m.project, w.userId, renamed.json.batch);
    expect(taken).toMatchObject({ kind: "taken", direction: "undo", keptCount: 0 });
    expect(nameOf()).toBe("测试");
    expect(await rowOf()).toMatchObject({ name: "测试" });
    const [heard] = m.window.peer.of("update").slice(-1);
    expect(heard?.by).toMatchObject({ kind: "undo", undoes: renamed.json.batch });
    if (taken.kind !== "taken") throw new Error("not taken");
    expect(await m.hub.takeBack(m.project, w.userId, taken.next.batch)).toMatchObject({
      kind: "taken",
      direction: "redo",
    });
    expect(nameOf()).toBe("宣传片");
  });

  test("a name of nothing, or no name, is turned away, and so is more than a name", async () => {
    for (const name of ["", "   ", 3, null, undefined, ["x"]]) {
      expect((await rename(name)).status, JSON.stringify(name)).toBe(400);
    }
    const large = await p.request("PUT", `/api/projects/${m.project}/name`, {
      name: "长".repeat(NAME_BODY_BYTES),
    });
    expect(large.status).toBe(413);
    expect(nameOf()).toBe("测试");
    expect(await batchesOf()).toEqual([]);
  });

  test("a locked project, or one whose repository cannot be used, keeps its name", async () => {
    await m.window.change({
      type: "project.setTags",
      params: { tags: [{ name: "定稿", locked: true }] },
    });
    expect(await rename("宣传片")).toMatchObject({ status: 409, json: { error: "locked" } });
    await m.window.change({ type: "project.setTags", params: { tags: [] } });
    await pauseLink(
      t.db,
      { projectId: m.project, provider: "github", repoId: m.repo.id },
      { reason: "gone", detail: "gone", at: w.time.now },
    );
    expect(await rename("宣传片")).toMatchObject({ status: 409, json: { error: "unusable" } });
    expect(nameOf()).toBe("测试");
    expect(await batchesOf()).toEqual([]);
  });

  test("someone else's project is not there, as one that is not", async () => {
    const other = await world(t.db, w.time);
    const theirs = await platform(other, { hub: m.hub });
    const said = await theirs.request("PUT", `/api/projects/${m.project}/name`, { name: "x" });
    expect(said).toMatchObject({ status: 404, json: { error: "notFound" } });
    expect(await rename("x", "pnotthere0000")).toMatchObject({ status: 404 });
    expect(nameOf()).toBe("测试");
  });

  test("a copy that was let go of is made again first, and renamed once it is back", async () => {
    await archiveAndMerge(m);
    m.window.peer.connection.close();
    await m.hub.idle();
    expect((await m.hub.release(m.project)).kind).toBe("released");
    const waking = await rename("宣传片");
    expect(waking).toMatchObject({ status: 409, json: { error: "waking", copy: "restoring" } });
    expect(rebuilt).toEqual([m.project]);
    expect(await rowOf()).toMatchObject({ name: "测试", copyState: "restoring" });
    // The worker makes it, as asked.
    await wakeCopy(t.db, m.project, { userId: w.userId, access: OWNER_ONLY }, w.time.now);
    const made = await new Rebuilder({
      db: t.db,
      hosts: RepoHosts.github(w.host),
      exporter: new ProjectExporter({ heapMb: 256 }),
      log: quiet,
      now: () => w.time.now,
      lookAgain: async () => {},
    }).run(m.project);
    expect(made).toMatchObject({ kind: "rebuilt" });
    expect(await rename("宣传片")).toMatchObject({ status: 200, json: { name: "宣传片" } });
    expect(await rowOf()).toMatchObject({ name: "宣传片", copyState: "live" });
  });
});
