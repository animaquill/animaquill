import { OWNER_ONLY } from "../access.ts";
import { randomBytes } from "node:crypto";
import { ProjectStore, isProjectFile, mergeUpdates } from "@animaquill/core";
import { SYNC_CLOSE, SYNC_PROTOCOL } from "@animaquill/host/sync";
import { and, asc, desc, eq } from "drizzle-orm";
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
import type { FakeRepo } from "../test/fake-github.ts";
import { lfsWorld, oidOf } from "../test/lfs-support.ts";
import { TestPeer } from "../test/sync-support.ts";
import { lfsObjects, projectRepos, projects, projectSnapshots, projectUpdates } from "../schema.ts";
import { SyncHub } from "../sync/hub.ts";
import { listProjects } from "../sync/list.ts";
import { REBUILD_RETRY_MS, wakeCopy } from "../sync/wake.ts";
import { ProjectExporter } from "./exporter.ts";
import { Rebuilder } from "./rebuild.ts";
import { RepoHosts, type RepoHost } from "./repo-host.ts";

/**
 * Letting go of the working copy of a project, and making it again from its repository (the plan of
 * the redesign, 13.5 and 13.7), on a real PostgreSQL and the fake GitHub: the copy is what the
 * archive has, file by file; the next copy is another one, which a window of the one before cannot
 * go on with; nothing is ever made over a copy that is there, and nothing half of one is left where
 * GitHub or anything else fails; and the list of projects does not change. Needs AQ_TEST_DATABASE,
 * see vitest.config.ts.
 */

const SCENE = { name: "开场", entry: "index.html", runtime: 1 };
const addScene = (id: string, html = `<p>${id}</p>\n`) => ({
  type: "scene.add",
  params: { id, manifest: SCENE, files: { "index.html": html } },
});

describe.skipIf(!TEST_DATABASE)(
  "making working copies again from repositories, on a database",
  () => {
    let t: TestDatabase;
    let w: World;
    let hubs: SyncHub[] = [];
    /** Projects something else may still change, as an AI task (`ProjectHolds`). */
    const held = new Set<string>();
    /** What the hubs had the worker do, in order. */
    let asked: string[] = [];
    let looked: string[] = [];
    beforeAll(async () => {
      t = await createTestDatabase();
    });
    afterAll(async () => {
      await t?.drop();
    });
    beforeEach(async () => {
      w = await world(t.db);
      asked = [];
      looked = [];
    });
    afterEach(() => {
      for (const hub of hubs.splice(0)) hub.stop();
    });

    const hubOf = () => {
      const hub = new SyncHub({
        db: t.db,
        log: quiet,
        now: () => w.time.now,
        holds: { busy: async (_tx, id) => held.has(id) },
        rebuild: async (id) => {
          asked.push(id);
        },
      });
      hubs.push(hub);
      return hub;
    };
    const rebuilder = (host: RepoHost = w.host) =>
      new Rebuilder({
        db: t.db,
        hosts: RepoHosts.github(host),
        exporter: new ProjectExporter({ heapMb: 256 }),
        log: quiet,
        now: () => w.time.now,
        lookAgain: async (id) => {
          looked.push(id);
        },
      });

    const rowOf = async (id: string) =>
      (await t.db.select().from(projects).where(eq(projects.id, id)))[0];
    const linkOf = async (id: string) =>
      (await t.db.select().from(projectRepos).where(eq(projectRepos.projectId, id)))[0]!;
    const updatesOf = (id: string) =>
      t.db
        .select()
        .from(projectUpdates)
        .where(eq(projectUpdates.projectId, id))
        .orderBy(asc(projectUpdates.seq));
    const snapshotsOf = (id: string) =>
      t.db.select().from(projectSnapshots).where(eq(projectSnapshots.projectId, id));

    /** The working copy as the database has it, as files of the project. */
    const copyFiles = async (id: string): Promise<Map<string, string>> => {
      const [snapshot] = await t.db
        .select()
        .from(projectSnapshots)
        .where(and(eq(projectSnapshots.projectId, id), eq(projectSnapshots.reason, "compact")))
        .orderBy(desc(projectSnapshots.seq))
        .limit(1);
      const after = snapshot?.seq ?? 0;
      const updates = (await updatesOf(id)).filter((row) => row.seq > after).map((row) => row.data);
      const { store } = ProjectStore.fromUpdates([
        ...(snapshot ? [snapshot.state] : []),
        ...updates,
      ]);
      if (!store) throw new Error("no project");
      const files = new Map(store.exportFiles().files);
      store.destroy();
      return files;
    };
    /** The files of the project a commit has. */
    const repoFiles = (repo: FakeRepo, sha: string) =>
      new Map([...w.github.filesAt(repo.id, sha)].filter(([path]) => isProjectFile(path)));

    /** A project with a scene and code, archived into a new repository. */
    const archived = async (name = "film") => {
      const project = await newProject(w);
      await edit(w, project, addScene("intro"));
      await edit(w, project, write("code/shared.js", "export const a = 1;\n"));
      const repo = w.github.addRepo(w.person, { name, select: true });
      await linkTo(w, project.id, repo);
      expect(await w.archiver().run(project.id, "first")).toMatchObject({ kind: "archived" });
      return { project, repo };
    };

    /** Says hello for a project as an editor does, and waits until it is synced or closed. */
    const hello = async (
      hub: SyncHub,
      id: string,
      options: { after?: number; generation?: number; readOnly?: boolean; base?: boolean } = {},
    ) => {
      const peer = new TestPeer(hub, { userId: w.userId, session: "s" });
      peer.send({
        t: "hello",
        v: SYNC_PROTOCOL,
        project: id,
        after: options.after ?? 0,
        ...(options.generation !== undefined && { generation: options.generation }),
        device: "d1",
        window: "w1",
        editor: "dev",
        ...(options.readOnly && { readOnly: true }),
        ...(options.base && { base: true }),
        payload: new Uint8Array(0),
      });
      await peer.until(
        () => peer.of("synced").length > 0 || peer.closedWith !== undefined,
        "synced",
      );
      return peer;
    };

    /**
     * What the list says of a project, but for what is of the copy itself: how large it is, whether
     * it is here, and the number of the update its archive has, which goes on with the next copy.
     */
    const listed = async (id: string) => {
      const { projects: list } = await listProjects(t.db, w.userId, {
        webUrl: "https://github.test",
        now: w.time.now.getTime(),
      });
      const found = list.find((each) => each.id === id);
      if (!found) return undefined;
      // When it was opened: asking for the copy is opening it (`wakeCopy`).
      const {
        size: _size,
        copy: _copy,
        releasedAt: _releasedAt,
        openedAt: _openedAt,
        archive,
        ...rest
      } = found;
      return { ...rest, archive: { ...archive, seq: undefined } };
    };

    test("lets go of an archived copy, and makes the next one from the archive, file by file", async () => {
      const { project, repo } = await archived();
      const before = await rowOf(project.id);
      const link = await linkOf(project.id);
      const list = await listed(project.id);
      const hub = hubOf();
      // Its first copy was not made from an archive: it has no copy to begin as.
      expect((await hello(hub, project.id, { readOnly: true, base: true })).closedWith?.code).toBe(
        SYNC_CLOSE.missing,
      );
      await hub.idle();
      expect(await hub.release(project.id)).toEqual({
        kind: "released",
        from: { generation: 1, head: 3, archivedSeq: 3, headSha: link.headSha },
      });
      // Nothing of the copy is left, and the list is as it was.
      expect(await updatesOf(project.id)).toEqual([]);
      expect(await snapshotsOf(project.id)).toEqual([]);
      expect(await rowOf(project.id)).toMatchObject({
        copyState: "released",
        generation: 1,
        head: 3,
        bytes: 0,
        dirtySince: null,
        releasedFrom: { generation: 1, head: 3, archivedSeq: 3, headSha: link.headSha },
      });
      expect(await listed(project.id)).toEqual(list);
      // Again: not here any more.
      expect(await hub.release(project.id)).toEqual({ kind: "notLive" });

      // A window of the owner asks for it: it is on its way, and the window comes back later.
      const first = await hello(hub, project.id, { after: 3, generation: 1 });
      expect(first.closedWith).toEqual({ code: SYNC_CLOSE.unavailable, reason: "restoring" });
      expect(first.received).toEqual([]);
      expect(asked).toEqual([project.id]);
      expect((await rowOf(project.id))!.copyState).toBe("restoring");

      expect(await rebuilder().run(project.id)).toEqual({ kind: "rebuilt", seq: 4, generation: 2 });
      const row = (await rowOf(project.id))!;
      expect(row).toMatchObject({
        copyState: "live",
        generation: 2,
        head: 4,
        dirtySince: null,
        copyProblem: null,
        name: before!.name,
        projectId: before!.projectId,
        updatedAt: before!.updatedAt,
      });
      expect(await linkOf(project.id)).toMatchObject({ archivedSeq: 4, headSha: link.headSha });
      expect((await updatesOf(project.id)).map((each) => [each.seq, each.kind])).toEqual([
        [4, "first"],
      ]);
      expect(
        (await snapshotsOf(project.id)).map((each) => [each.seq, each.reason]).toSorted(),
      ).toEqual([
        [4, "base"],
        [4, "compact"],
      ]);
      // What the archive has, file by file, and nothing else of the project.
      expect(await copyFiles(project.id)).toEqual(repoFiles(repo, link.headSha!));
      expect(await listed(project.id)).toEqual(list);
      // Changes on GitHub since are looked for.
      expect(looked).toEqual([project.id]);

      // The window of the copy before hears that this is another one, and gets nothing of it.
      const stale = await hello(hub, project.id, { after: 3, generation: 1 });
      expect(stale.closedWith?.code).toBe(SYNC_CLOSE.rebuilt);
      expect(stale.received).toEqual([]);
      // One from before copies were told apart, that has some of the project: reload.
      const old = await hello(hub, project.id, { after: 3 });
      expect(old.closedWith?.code).toBe(SYNC_CLOSE.outdated);
      expect(old.received).toEqual([]);
      // One that has nothing of it gets this copy whole.
      const fresh = await hello(hub, project.id);
      expect(fresh.closedWith).toBeUndefined();
      expect(fresh.of("welcome")[0]).toMatchObject({ head: 4, generation: 2 });
      const { store } = ProjectStore.fromUpdates(fresh.of("update").map((each) => each.payload));
      expect(new Map(store!.exportFiles().files)).toEqual(repoFiles(repo, link.headSha!));
      // A window of this copy goes on as ever.
      const current = await hello(hub, project.id, { after: 4, generation: 2 });
      expect(current.of("synced")).toHaveLength(1);
      // The copy as it began, for a window of the one before to put its changes onto it.
      const base = await hello(hub, project.id, { readOnly: true, base: true });
      expect(base.of("welcome")[0]).toMatchObject({ head: 4, generation: 2 });
      expect(base.of("update").map((each) => each.seq)).toEqual([4]);
      expect(base.closedWith).toBeUndefined();
      base.connection.close();
      const { store: began } = ProjectStore.fromUpdates([base.of("update")[0]!.payload]);
      expect(new Map(began!.exportFiles().files)).toEqual(repoFiles(repo, link.headSha!));
      // Only for a window that only reads.
      expect((await hello(hub, project.id, { base: true })).closedWith?.code).toBe(
        SYNC_CLOSE.protocol,
      );
    });

    test("a copy made again goes on from its first update: changed, archived, let go of and made again", async () => {
      const { project, repo } = await archived();
      const hub = hubOf();
      for (let round = 1; round <= 3; round++) {
        // The project changes, as from the newest copy, and is archived.
        const row = (await rowOf(project.id))!;
        // A window that opened the newest copy, from what the platform sends.
        const opened = await hello(hub, project.id);
        const { store } = ProjectStore.fromUpdates(opened.of("update").map((each) => each.payload));
        opened.connection.close();
        const made: Uint8Array[] = [];
        store!.onLocalUpdate((update) => made.push(update));
        const result = store!.execute(write("code/shared.js", `export const a = ${round + 1};\n`));
        expect(result.ok).toBe(true);
        const change = made.length === 1 ? made[0]! : mergeUpdates(made);
        store!.destroy();
        const peer = await hello(hub, project.id, { after: row.head, generation: row.generation });
        peer.send({
          t: "push",
          id: 1,
          kind: "user",
          base: row.head,
          at: Date.now(),
          window: "w1",
          behind: false,
          payload: change,
        });
        await peer.until(() => peer.of("ack").length > 0, "ack");
        peer.connection.close();
        await hub.idle();
        // Connected a moment ago: the hub lets it go only once nobody is.
        w.time.later(10 * 60_000);
        expect(await w.archiver().run(project.id, "auto")).toMatchObject({ kind: "archived" });
        const sha = (await linkOf(project.id)).headSha!;
        expect((await hub.release(project.id)).kind).toBe("released");
        await wakeCopy(t.db, project.id, { userId: w.userId, access: OWNER_ONLY }, w.time.now);
        expect(await rebuilder().run(project.id)).toEqual({
          kind: "rebuilt",
          seq: row.head + 2,
          generation: round + 1,
        });
        expect(await copyFiles(project.id)).toEqual(repoFiles(repo, sha));
        expect((await copyFiles(project.id)).get("code/shared.js")).toBe(
          `export const a = ${round + 1};\n`,
        );
      }
    });

    test("lets go only of a copy that nobody is connected to, whose changes the repository has", async () => {
      const hub = hubOf();
      // Not saved to a repository: there would be nothing to make it from.
      const lone = await newProject(w);
      expect(await hub.release(lone.id)).toEqual({ kind: "noRepository" });
      expect(await hub.release("nothing-of-that-name")).toEqual({ kind: "missing" });

      const { project } = await archived();
      // A window is connected, also one that only reads.
      const reader = await hello(hub, project.id, { readOnly: true });
      expect(reader.closedWith).toBeUndefined();
      expect(await hub.release(project.id)).toEqual({ kind: "connected" });
      reader.connection.close();
      await hub.idle();

      // A change waits, and is not tried yet: never let go of.
      await edit(w, project, write("code/b.js", "b"));
      expect(await hub.release(project.id)).toEqual({ kind: "transient" });
      // Nor one that waits for GitHub to be there again.
      w.github.faults.down = 10;
      expect(await w.archiver().run(project.id, "auto")).toMatchObject({ kind: "failed" });
      expect(await hub.release(project.id, { unarchived: true })).toEqual({ kind: "transient" });
      w.github.faults.down = 0;
      // One that people have to see to: only where they say to let go of what it is.
      w.github.setArchived((await linkOf(project.id)).repoId, true);
      w.time.later(60 * 60_000);
      expect(await w.archiver().run(project.id, "auto")).toMatchObject({
        kind: "paused",
        reason: "archived",
      });
      expect(await hub.release(project.id)).toMatchObject({
        kind: "notArchived",
        head: 4,
        archivedSeq: 3,
        state: "paused",
        reason: "archived",
      });
      expect((await rowOf(project.id))!.copyState).toBe("live");
      // Something else that may change it goes on, as an AI task of it: later.
      held.add(project.id);
      expect(await hub.release(project.id, { unarchived: true })).toEqual({ kind: "busy" });
      held.delete(project.id);
      // Its archive runs: later.
      expect(
        await (async () => {
          const { withLock } = await import("../database.ts");
          const { ARCHIVE_LOCK } = await import("./links.ts");
          const locked = await withLock(t.db, ARCHIVE_LOCK, project.id, () =>
            hub.release(project.id, { unarchived: true }),
          );
          return locked.held ? locked.value : undefined;
        })(),
      ).toEqual({ kind: "busy" });
      const released = await hub.release(project.id, { unarchived: true });
      expect(released).toMatchObject({ kind: "released", from: { head: 4, archivedSeq: 3 } });
      // What the repository did not have is nowhere here: nothing waits to be archived.
      expect(await rowOf(project.id)).toMatchObject({ copyState: "released", dirtySince: null });
      expect(await w.archiver().run(project.id, "manual")).toEqual({ kind: "none" });
    });

    test("restores a repository as the first copy of a new project, archived up to its last commit", async () => {
      const { project, repo } = await archived();
      const tip = repo.refs.get("main")!;
      // The project goes from the platform; its repository stays.
      expect(await hubOf().remove(project.id, w.userId, { discard: true })).toBe("removed");
      const id = `restored${randomBytes(6).toString("hex")}`;
      await t.db.insert(projects).values({
        id,
        ownerId: w.userId,
        projectId: "anything",
        name: "film",
        copyState: "restoring",
      });
      await linkTo(w, id, repo, false);
      expect(await rebuilder().run(id)).toEqual({ kind: "rebuilt", seq: 1, generation: 1 });
      expect(await rowOf(id)).toMatchObject({
        copyState: "live",
        generation: 1,
        head: 1,
        projectId: project.editor.projectId,
        name: "测试",
        releasedFrom: null,
      });
      expect(await linkOf(id)).toMatchObject({ archivedSeq: 1, headSha: tip, lfsPaths: [] });
      expect(await copyFiles(id)).toEqual(repoFiles(repo, tip));
      // Nothing to look for: what it was made from is the tip.
      expect(looked).toEqual([]);
      // Archives go on from there, and nothing is written for what the repository has.
      expect(await w.archiver().run(id, "auto")).toEqual({ kind: "same" });
      expect(repo.refs.get("main")).toBe(tip);
    });

    test("turns away a repository whose documents do not read, and says which, writing nothing", async () => {
      const repo = w.github.addRepo(w.person, {
        name: "broken",
        select: true,
        files: {
          "animaquill.json": new Editor().store.exportFiles().files.get("animaquill.json")!,
          "timelines/main/timeline.json": "{ not json",
          "scenes/intro/scene.json": '{"name": 5}',
          "README.md": "# 不是项目的文件\n",
        },
      });
      const id = `broken${randomBytes(6).toString("hex")}`;
      // A request to restore it waits for the answer: it stays, for that to say why.
      await t.db.insert(projects).values({
        id,
        ownerId: w.userId,
        projectId: "x",
        name: "x",
        copyState: "restoring",
        linkingUntil: new Date(Date.now() + 60_000),
      });
      await linkTo(w, id, repo, false);
      const outcome = await rebuilder().run(id);
      expect(outcome).toMatchObject({ kind: "failed", problem: { code: "unreadable" } });
      expect(outcome.kind === "failed" && outcome.problem.files).toEqual(
        expect.arrayContaining(["scenes/intro/scene.json", "timelines/main/timeline.json"]),
      );
      expect(await rowOf(id)).toMatchObject({
        copyState: "released",
        head: 0,
        copyProblem: { code: "unreadable" },
      });
      expect(await updatesOf(id)).toEqual([]);
      expect(await snapshotsOf(id)).toEqual([]);

      // No project at all.
      const empty = w.github.addRepo(w.person, {
        name: "notes",
        select: true,
        files: { "a.md": "" },
      });
      const other = `notes${randomBytes(6).toString("hex")}`;
      await t.db.insert(projects).values({
        id: other,
        ownerId: w.userId,
        projectId: "x",
        name: "x",
        copyState: "restoring",
      });
      await linkTo(w, other, empty, false);
      // Nothing waits for this one: it goes at once, with its link, and holds no repository.
      expect(await rebuilder().run(other)).toMatchObject({
        kind: "failed",
        problem: { code: "notProject" },
        removed: true,
      });
      expect(await rowOf(other)).toBeUndefined();
      expect(
        await t.db.select().from(projectRepos).where(eq(projectRepos.repoId, empty.id)),
      ).toEqual([]);
    });

    test("GitHub failing halfway leaves the copy let go of, with nothing of it, and the next try makes it", async () => {
      const { project, repo } = await archived();
      const sha = (await linkOf(project.id)).headSha!;
      const hub = hubOf();
      await hub.release(project.id);
      await wakeCopy(t.db, project.id, { userId: w.userId, access: OWNER_ONLY }, w.time.now);
      // The second file read fails, as GitHub does now and then.
      let blobs = 0;
      w.github.onCall = (call) => {
        if (call.includes("/git/blobs/") && ++blobs === 2) w.github.faults.down = 1;
      };
      expect(await rebuilder().run(project.id)).toMatchObject({
        kind: "failed",
        problem: { code: "unavailable" },
      });
      w.github.onCall = undefined;
      expect(await rowOf(project.id)).toMatchObject({
        copyState: "released",
        generation: 1,
        head: 3,
        copyProblem: { code: "unavailable" },
      });
      expect(await updatesOf(project.id)).toEqual([]);
      expect(await snapshotsOf(project.id)).toEqual([]);
      // Asked for again at once: not yet, GitHub is not asked over and over.
      const soon = await hello(hub, project.id, { after: 3, generation: 1 });
      expect(soon.closedWith).toEqual({ code: SYNC_CLOSE.unavailable, reason: "released" });
      expect(
        await wakeCopy(t.db, project.id, { userId: w.userId, access: OWNER_ONLY }, w.time.now),
      ).toMatchObject({
        copy: "released",
        why: "later",
      });
      w.time.later(REBUILD_RETRY_MS);
      expect(
        await wakeCopy(t.db, project.id, { userId: w.userId, access: OWNER_ONLY }, w.time.now),
      ).toEqual({
        copy: "restoring",
        queue: true,
      });
      expect(await rebuilder().run(project.id)).toMatchObject({ kind: "rebuilt", generation: 2 });
      expect(await copyFiles(project.id)).toEqual(repoFiles(repo, sha));
      expect((await rowOf(project.id))!.copyProblem).toBeNull();
    });

    test("reads many files from the tarball of the commit, and one by one where that does not come whole", async () => {
      const project = await newProject(w);
      for (let index = 0; index < 20; index++)
        await edit(w, project, addScene(`scene${index}`, `<p>${"内容".repeat(index)}</p>\n`));
      const repo = w.github.addRepo(w.person, { name: "many", select: true });
      await linkTo(w, project.id, repo);
      await w.archiver().run(project.id, "first");
      const sha = (await linkOf(project.id)).headSha!;
      const hub = hubOf();
      for (const broken of [false, true]) {
        await hub.release(project.id);
        await wakeCopy(t.db, project.id, { userId: w.userId, access: OWNER_ONLY }, w.time.now);
        if (broken) w.github.faults.tarballCut = 1;
        w.github.calls.length = 0;
        expect(await rebuilder().run(project.id)).toMatchObject({ kind: "rebuilt" });
        expect(await copyFiles(project.id)).toEqual(repoFiles(repo, sha));
        const blobs = w.github.calls.filter((call) => call.includes("/git/blobs/")).length;
        expect(w.github.calls.filter((call) => call === "GET codeload")).toHaveLength(1);
        // Whole: no file one by one. Cut short: every one of them.
        if (broken) expect(blobs).toBeGreaterThanOrEqual(40);
        else expect(blobs).toBe(0);
      }
    });

    test("never makes a copy over one that is there, and two at once make one", async () => {
      const { project } = await archived();
      // Live: nothing to do.
      expect(await rebuilder().run(project.id)).toEqual({ kind: "none" });
      const hub = hubOf();
      await hub.release(project.id);
      // Asked for twice at once: on its way once.
      const woke = await Promise.all([
        wakeCopy(t.db, project.id, { userId: w.userId, access: OWNER_ONLY }, w.time.now),
        wakeCopy(t.db, project.id, { userId: w.userId, access: OWNER_ONLY }, w.time.now),
      ]);
      expect(woke).toEqual([
        { copy: "restoring", queue: true },
        { copy: "restoring", queue: true },
      ]);
      // Two workers at once: one of them makes it, the other finds nothing to do or waits.
      const outcomes = await Promise.all([
        rebuilder().run(project.id),
        rebuilder().run(project.id),
      ]);
      expect(outcomes.filter((each) => each.kind === "rebuilt")).toHaveLength(1);
      expect((await rowOf(project.id))!.generation).toBe(2);
      expect(await rebuilder().run(project.id)).toEqual({ kind: "none" });

      // A copy that is "restoring" while the database has updates of it, as a bug would leave it:
      // nothing is written over them.
      const { project: other } = await archived("other");
      await t.db.update(projects).set({ copyState: "restoring" }).where(eq(projects.id, other.id));
      const updates = await updatesOf(other.id);
      expect(await rebuilder().run(other.id)).toMatchObject({ kind: "failed" });
      expect(await updatesOf(other.id)).toEqual(updates);
      expect((await rowOf(other.id))!.head).toBe(3);
    });

    test("a project deleted, or whose repository goes, while its copy is made, gets nothing", async () => {
      const { project } = await archived();
      const hub = hubOf();
      await hub.release(project.id);
      await wakeCopy(t.db, project.id, { userId: w.userId, access: OWNER_ONLY }, w.time.now);
      let once = true;
      w.github.onCall = async (call) => {
        if (once && call.includes("/git/blobs/")) {
          once = false;
          expect(await hub.remove(project.id, w.userId, { discard: true })).toBe("removed");
        }
      };
      expect(await rebuilder().run(project.id)).toEqual({ kind: "none" });
      w.github.onCall = undefined;
      expect(await rowOf(project.id)).toBeUndefined();
      expect(await updatesOf(project.id)).toEqual([]);

      const { project: gone, repo } = await archived("gone");
      await hub.release(gone.id);
      await wakeCopy(t.db, gone.id, { userId: w.userId, access: OWNER_ONLY }, w.time.now);
      w.github.onCall = (call) => {
        if (call.includes("/git/trees/")) w.github.deleteRepo(repo.id);
      };
      // Halfway, GitHub's 404 says nothing more than that the read failed.
      expect(await rebuilder().run(gone.id)).toMatchObject({
        kind: "failed",
        problem: { code: "unavailable" },
      });
      w.github.onCall = undefined;
      expect(await rowOf(gone.id)).toMatchObject({ copyState: "released", head: 3 });
      expect(await snapshotsOf(gone.id)).toEqual([]);
      // The next try finds the repository is not there.
      w.time.later(REBUILD_RETRY_MS);
      await wakeCopy(t.db, gone.id, { userId: w.userId, access: OWNER_ONLY }, w.time.now);
      expect(await rebuilder().run(gone.id)).toMatchObject({
        kind: "failed",
        problem: { code: "unusable" },
      });
      expect(await rowOf(gone.id)).toMatchObject({ copyState: "released", head: 3 });
      expect(await updatesOf(gone.id)).toEqual([]);
    });

    test("changes on GitHub after the archive are not taken in, nor written over: archiving pauses", async () => {
      const { project, repo } = await archived();
      const sha = (await linkOf(project.id)).headSha!;
      const hub = hubOf();
      await hub.release(project.id);
      w.github.commitAs(repo.id, w.person, { "code/shared.js": "export const a = 99;\n" });
      const theirs = repo.refs.get("main")!;
      await wakeCopy(t.db, project.id, { userId: w.userId, access: OWNER_ONLY }, w.time.now);
      expect(await rebuilder().run(project.id)).toMatchObject({ kind: "rebuilt" });
      // The copy is the archive, which a window of the copy before has in common with it.
      expect(await copyFiles(project.id)).toEqual(repoFiles(repo, sha));
      expect(looked).toEqual([project.id]);
      // The archive that looks finds their change, and nothing goes over it.
      expect(await w.archiver().run(project.id, "check")).toMatchObject({
        kind: "paused",
        reason: "diverged",
      });
      expect(repo.refs.get("main")).toBe(theirs);
      expect(w.github.files(repo.id).get("code/shared.js")).toBe("export const a = 99;\n");
    });

    test("where the archive is not there any more, the copy is the branch, with nothing in common", async () => {
      const { project, repo } = await archived();
      const hub = hubOf();
      const released = await hub.release(project.id);
      expect(released.kind).toBe("released");
      // The branch was set back elsewhere, and the archive is gone with it.
      await t.db
        .update(projects)
        .set({
          releasedFrom: {
            generation: 1,
            head: 3,
            archivedSeq: 3,
            headSha: "0".repeat(40),
          },
        })
        .where(eq(projects.id, project.id));
      await wakeCopy(t.db, project.id, { userId: w.userId, access: OWNER_ONLY }, w.time.now);
      expect(await rebuilder().run(project.id)).toMatchObject({ kind: "rebuilt" });
      const tip = repo.refs.get("main")!;
      expect(await copyFiles(project.id)).toEqual(repoFiles(repo, tip));
      // Nothing in common with the copy before, said so.
      expect((await rowOf(project.id))!.releasedFrom).toEqual({
        generation: 1,
        head: 3,
        archivedSeq: 3,
        headSha: "0".repeat(40),
        commonBase: false,
      });
      expect(await linkOf(project.id)).toMatchObject({ headSha: tip });
    });

    test("notes the objects of Git LFS that the pointers of a restored project point at", async () => {
      const l = await lfsWorld(w, { limits: { chunkBytes: 4096 } });
      try {
        const { project, repo } = await l.linked();
        const video = randomBytes(5000);
        await l.addAsset(project, "video", "assets/video.mp4", video);
        await l.upload(project.id, video);
        await l.placeIn(project, "video", repo, video);
        expect(await w.archiver().run(project.id, "first")).toMatchObject({ kind: "archived" });
        expect(await hubOf().remove(project.id, w.userId, { discard: true })).toBe("removed");
        // The platform does not know what the storage has any more, as after a backup.
        await t.db.delete(lfsObjects).where(eq(lfsObjects.repoId, repo.id));
        const id = `lfs${randomBytes(6).toString("hex")}`;
        await t.db
          .insert(projects)
          .values({ id, ownerId: w.userId, projectId: "x", name: "x", copyState: "restoring" });
        await linkTo(w, id, repo, false);
        expect(await rebuilder().run(id)).toMatchObject({ kind: "rebuilt" });
        expect(
          await t.db
            .select({ oid: lfsObjects.oid, size: lfsObjects.size })
            .from(lfsObjects)
            .where(eq(lfsObjects.repoId, repo.id)),
        ).toEqual([{ oid: oidOf(video), size: video.length }]);
        // The next archive keeps its pointer, as one to an object the storage has.
        expect(await w.archiver().run(id, "auto")).toEqual({ kind: "same" });
        expect(w.github.files(repo.id).get("assets/video.mp4")).toContain(oidOf(video));
      } finally {
        l.done();
      }
    });
  },
);
