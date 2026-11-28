import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ProjectStore,
  checkUpdate,
  mergeUpdates,
  orderAt,
  isUndoRecord,
  type CommandCall,
  type PlatformBatch,
} from "@animaquill/core";
import { SYNC_PROTOCOL, type SyncServerMessage } from "@animaquill/host/sync";
import { CURRENT_FORMAT_VERSION } from "@animaquill/schema";
import { and, asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createTestDatabase, TEST_DATABASE, type TestDatabase } from "../test/database.ts";
import { TestPeer, someone } from "../test/sync-support.ts";
import type { Db } from "../database.ts";
import {
  projectBatches,
  projectRepos,
  projectSnapshots,
  projectUpdates,
  repoConflicts,
  repoMerges,
  type MergePrefer,
} from "../schema.ts";
import { batchFromRow, writeMergeInput, type MergeInput } from "./batches.ts";
import { SyncHub, type SyncLimits } from "./hub.ts";
import { sweepProjects } from "./sweep.ts";
import { changeableLimits } from "../test/limits-support.ts";

/**
 * Changes on GitHub merged into the working copy of a project by the hub, and changes of editors
 * that were made without them and arrive after them, on a real PostgreSQL. Needs AQ_TEST_DATABASE,
 * see vitest.config.ts.
 */

const quiet = { info() {}, warn() {}, error() {} };
const FIXTURE = fileURLToPath(new URL("../../../schema/fixtures/v1/", import.meta.url));
const CODE = "code/animate.js";

/** The files of the fixture project, unlocked, as a folder would hand them over. */
function fixtureFiles(): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (folder: string) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) walk(path);
      else files.set(relative(FIXTURE, path).split(sep).join("/"), readFileSync(path, "utf8"));
    }
  };
  walk(FIXTURE);
  const manifest = JSON.parse(files.get("animaquill.json") as string) as Record<string, unknown>;
  delete manifest["tags"];
  files.set("animaquill.json", JSON.stringify(manifest));
  return files;
}

/** A window's project: what it changes, as the updates it sends. */
class Editor {
  readonly store: ProjectStore;
  readonly updates: Uint8Array[] = [];

  constructor(store?: ProjectStore) {
    this.store = store ?? (ProjectStore.open(fixtureFiles()).store as ProjectStore);
    this.store.onLocalUpdate((update) => this.updates.push(update));
  }

  get id(): string {
    return this.store.getState().manifest.id;
  }

  change(call: CommandCall): Uint8Array {
    const before = this.updates.length;
    const result = this.store.execute(call);
    if (!result.ok) throw new Error(`${result.error.code}: ${JSON.stringify(result.error.params)}`);
    const made = this.updates.slice(before);
    if (made.length !== 1) throw new Error(`${made.length} updates`);
    return made[0] as Uint8Array;
  }

  /** Takes in what came from the platform, as a window does. */
  hear(peer: TestPeer, from = 0): void {
    for (const update of peer.of("update").slice(from)) {
      this.store.applyCloud([update.payload], update.seq);
    }
  }
}

const REPO = 424_242;

let projectNumber = 0;
const newId = () => `m${Date.now().toString(36)}x${++projectNumber}`;
let repoNumber = 0;
let devices = 1;

describe.skipIf(!TEST_DATABASE)("merging changes on GitHub, on a database", () => {
  let database: TestDatabase;
  beforeAll(async () => {
    database = await createTestDatabase();
  });
  afterAll(async () => {
    await database?.drop();
  });

  const hubOf = (limits: Partial<SyncLimits> = {}, db: Db = database.db) =>
    new SyncHub({ db, log: quiet, limits, merged: async () => {} });

  async function hello(
    hub: SyncHub,
    who: Awaited<ReturnType<typeof someone>>,
    project: string,
    { create }: { create?: Editor } = {},
  ) {
    const peer = new TestPeer(hub, who);
    peer.send({
      t: "hello",
      v: SYNC_PROTOCOL,
      project,
      after: 0,
      device: create ? "d1" : `d${++devices}`,
      window: "w1",
      editor: "test",
      ...(create && { create: { name: "测试", projectId: create.id } }),
      payload: create ? create.store.encodeState() : new Uint8Array(0),
    });
    await peer.until(() => peer.of("synced").length > 0 || peer.closedWith !== undefined, "synced");
    return peer;
  }

  let pushes = 0;
  /** Sends a change, as made on the platform's update `base`, and waits for the answer. */
  const push = async (
    peer: TestPeer,
    payload: Uint8Array,
    { base = 1, kind = "user" }: { base?: number; kind?: "user" | "repair" } = {},
  ) => {
    const id = ++pushes;
    peer.send({
      t: "push",
      id,
      kind,
      base,
      at: Date.now(),
      window: "w1",
      behind: true,
      payload,
    });
    await peer.until(
      () => peer.received.some((message) => "id" in message && message.id === id),
      `an answer to ${id}`,
    );
    return peer.received.find((message) => "id" in message && message.id === id);
  };

  /** A project of someone, connected by a window, saved to a repository. */
  async function linked(
    hub: SyncHub,
    { prefer = "editor", editor = new Editor() }: { prefer?: MergePrefer; editor?: Editor } = {},
  ) {
    const ada = await someone(database.db);
    const id = newId();
    const peer = await hello(hub, ada, id, { create: editor });
    repoNumber += 1;
    const repoId = REPO + repoNumber * 10 + Math.floor(Math.random() * 9);
    await database.db.insert(projectRepos).values({
      projectId: id,
      installationId: 1,
      repoId,
      ownerId: 77,
      ownerLogin: "ada",
      name: `repo-${repoId}`,
      branch: "main",
      private: true,
      createdHere: true,
      prefer,
      archivedSeq: 1,
      headSha: "a".repeat(40),
    });
    const repository = editor.store.exportFiles({ here: { repo: String(repoId) } }).files;
    return { ada, id, peer, editor, repoId, repository };
  }

  /** What the worker writes down for a commit on GitHub, see archive/. */
  async function mergeOf(
    project: string,
    repoId: number,
    base: ReadonlyMap<string, string>,
    next: ReadonlyMap<string, string>,
  ): Promise<string> {
    const files: MergeInput[] = [...new Set([...base.keys(), ...next.keys()])]
      .filter((path) => base.get(path) !== next.get(path))
      .map((path) => ({ path, base: base.get(path), theirs: next.get(path) }));
    const [row] = await database.db
      .insert(repoMerges)
      .values({
        projectId: project,
        repoId,
        fromSha: "a".repeat(40),
        toSha: `${"b".repeat(39)}${projectNumber % 10}`,
        input: writeMergeInput(files),
      })
      .returning({ id: repoMerges.id });
    return (row as { id: string }).id;
  }

  const commit = (
    repository: ReadonlyMap<string, string>,
    repoId: number,
    calls: CommandCall[],
  ) => {
    const github = ProjectStore.open(new Map(repository)).store as ProjectStore;
    for (const call of calls) {
      const result = github.execute(call);
      if (!result.ok) throw new Error(`${result.error.code}`);
    }
    return github.exportFiles({ here: { repo: String(repoId) } }).files;
  };

  const updatesOf = (project: string) =>
    database.db
      .select()
      .from(projectUpdates)
      .where(eq(projectUpdates.projectId, project))
      .orderBy(asc(projectUpdates.seq));

  const conflictsOf = (project: string) =>
    database.db
      .select()
      .from(repoConflicts)
      .where(and(eq(repoConflicts.projectId, project), eq(repoConflicts.state, "open")))
      .orderBy(asc(repoConflicts.createdAt));

  /** The project as the database has it, read anew. */
  const kept = async (project: string) => {
    const rows = await updatesOf(project);
    const { store } = ProjectStore.fromUpdates(rows.map((row) => row.data));
    if (!store || store.isMissingUpdates) throw new Error("the database does not have all of it");
    return store;
  };

  const updatesOn = (peer: TestPeer) => peer.of("update");

  test("a merge goes in whatever the person keeps: only new projects are turned away for that", async () => {
    const limits = changeableLimits();
    const hub = new SyncHub({
      db: database.db,
      log: quiet,
      personLimits: limits,
      merged: async () => {},
    });
    const { id, peer, repoId, repository } = await linked(hub);
    limits.set({ "storage.platform": 1, "projects.count": 0 });
    const next = commit(repository, repoId, [
      { type: "project.rename", params: { name: "GitHub 上改的名字" } },
    ]);
    const merge = await mergeOf(id, repoId, repository, next);
    expect(await hub.mergeRepo(merge)).toMatchObject({ kind: "applied", seq: 2 });
    await peer.until(() => updatesOn(peer).length > 0, "the merge");
    expect((await kept(id)).getState().manifest.name).toBe("GitHub 上改的名字");
    // Not even asked.
    expect(limits.asked.filter(([, key]) => key === "storage.platform")).toHaveLength(1);
    hub.stop();
  });

  test("a merge goes in once, as the platform, and windows hear of it once the database has it", async () => {
    const hub = hubOf();
    const { id, peer, repoId, repository, ada } = await linked(hub);
    const other = await hello(hub, ada, id);
    const next = commit(repository, repoId, [
      { type: "project.rename", params: { name: "GitHub 上改的名字" } },
    ]);
    const merge = await mergeOf(id, repoId, repository, next);
    expect(await hub.mergeRepo(merge)).toMatchObject({ kind: "applied", seq: 2, conflicts: 0 });
    await peer.until(() => updatesOn(peer).length > 0, "the merge");
    await other.until(() => updatesOn(other).length > 1, "the merge");
    expect(updatesOn(other).at(-1)).toMatchObject({ seq: 2, by: { batch: merge } });
    const [heard] = updatesOn(peer) as [Extract<SyncServerMessage, { t: "update" }>];
    expect(heard).toMatchObject({
      seq: 2,
      kind: "repo",
      by: { batch: merge, kind: "repo", files: 1 },
    });

    const rows = await updatesOf(id);
    expect(rows.map(({ seq, kind, device, batch }) => ({ seq, kind, device, batch }))).toEqual([
      { seq: 1, kind: "first", device: "d1", batch: null },
      { seq: 2, kind: "repo", device: "platform", batch: merge },
    ]);
    // Written as the platform, whose writes win over nothing a person did without having seen them.
    const written = (rows[1] as { data: Uint8Array }).data;
    expect(checkUpdate(written, { fromEditor: true })).toBe("foreign");
    expect((await kept(id)).getState().manifest.name).toBe("GitHub 上改的名字");

    const [record] = await database.db.select().from(repoMerges).where(eq(repoMerges.id, merge));
    expect(record).toMatchObject({ state: "applied", seq: 2, oursSeq: 1, input: null });
    const [batch] = await database.db
      .select()
      .from(projectBatches)
      .where(eq(projectBatches.id, merge));
    expect(batch).toMatchObject({
      kind: "repo",
      seq: 2,
      files: 1,
      formatVersion: CURRENT_FORMAT_VERSION,
    });
    // Taking it back later goes by the record of 6.5a, of the format it was written in.
    expect(isUndoRecord(batch?.undo)).toBe(true);
    expect(batch?.undo).toMatchObject({
      origin: `repo:${merge}`,
      doc: { formatVersion: CURRENT_FORMAT_VERSION },
    });
    const what = batchFromRow(
      batch as { id: string; seq: number; writes: Uint8Array },
    ) as PlatformBatch;
    expect(what.writes.map(({ path }) => path)).toEqual([["manifest", "name"]]);
    const [before] = await database.db
      .select()
      .from(projectSnapshots)
      .where(and(eq(projectSnapshots.projectId, id), eq(projectSnapshots.reason, "before-repo")));
    expect(before).toMatchObject({ seq: 1, id: batch?.snapshotId });
    const [link] = await database.db
      .select()
      .from(projectRepos)
      .where(eq(projectRepos.projectId, id));
    expect(link).toMatchObject({ mergedSha: record?.toSha, state: "ready" });

    // Once only.
    expect(await hub.mergeRepo(merge)).toEqual({ kind: "done", state: "applied" });
    expect((await updatesOf(id)).length).toBe(2);
  });

  test("merges with no window connected, and a window that comes later hears it as a batch", async () => {
    const first = hubOf();
    const { id, ada, repoId, repository, peer } = await linked(first);
    peer.connection.close();
    // Another start of the platform: nothing of the project in memory.
    const hub = hubOf();
    const next = commit(repository, repoId, [
      { type: "project.rename", params: { name: "没人开着时改的" } },
    ]);
    const merge = await mergeOf(id, repoId, repository, next);
    expect(await hub.mergeRepo(merge)).toMatchObject({ kind: "applied", seq: 2 });
    expect(hub.size.connections).toBe(0);
    const later = await hello(hub, ada, id);
    expect(updatesOn(later).slice(1)).toMatchObject([
      { seq: 2, kind: "repo", by: { batch: merge, files: 1 } },
    ]);
    expect((await kept(id)).getState().manifest.name).toBe("没人开着时改的");
  });

  test("an editor may not write as the platform, though the whole project it sends may have what the platform wrote", async () => {
    const hub = hubOf();
    const { id, peer, repoId, repository, editor, ada } = await linked(hub);
    const next = commit(repository, repoId, [
      { type: "project.rename", params: { name: "平台写的" } },
    ]);
    await hub.mergeRepo(await mergeOf(id, repoId, repository, next));
    await peer.until(() => updatesOn(peer).length > 0, "the merge");
    editor.hear(peer);
    // A change written with the platform's id, as a broken or hostile editor could.
    const own = editor.store.doc.clientID;
    editor.store.doc.clientID = 0;
    const forged = editor.change({ type: "project.rename", params: { name: "冒充平台" } });
    editor.store.doc.clientID = own;
    expect(await push(peer, forged, { base: 2 })).toMatchObject({ t: "reject", reason: "foreign" });
    // A new project from what has the platform's writes in it: that is no change of the editor's.
    const copy = new Editor(ProjectStore.fromUpdates([editor.store.encodeState()]).store);
    const fresh = await hello(hub, ada, newId(), { create: copy });
    expect(fresh.of("welcome")).toHaveLength(1);
    expect(fresh.closedWith).toBeUndefined();
    // What a window sends where the platform has less than it may be what the platform wrote.
    expect(await push(peer, forged, { base: 2, kind: "repair" })).toMatchObject({ t: "ack" });
    void id;
  });

  test("changes made without a merge that took away what it wrote, or it what they did, leave conflicts", async () => {
    const hub = hubOf();
    const { id, peer, repoId, repository, editor } = await linked(hub);
    const clip = Object.keys(editor.store.getState().timelines["main"]?.clips ?? {})[0] as string;
    const [asset, other] = Object.keys(editor.store.getState().assets ?? {}) as [string, string];
    // Offline: the person takes an asset away, and a clip, and renames another asset.
    const offline = [
      editor.change({ type: "asset.remove", params: { asset } }),
      editor.change({ type: "clip.remove", params: { timeline: "main", clips: [clip] } }),
      editor.change({
        type: "asset.update",
        params: { asset: other, changes: { name: "离线时起的" } },
      }),
    ];
    // On GitHub meanwhile: the same asset renamed, the clip renamed, the other asset's tags.
    const next = commit(repository, repoId, [
      { type: "asset.update", params: { asset, changes: { name: "GitHub 上的" } } },
      {
        type: "clip.update",
        params: { timeline: "main", clip, changes: { name: "GitHub 上的片段" } },
      },
      { type: "asset.update", params: { asset: other, changes: { tags: ["github"] } } },
    ]);
    const merge = await mergeOf(id, repoId, repository, next);
    expect(await hub.mergeRepo(merge)).toMatchObject({ kind: "applied", conflicts: 0 });
    for (const change of offline) expect(await push(peer, change)).toMatchObject({ t: "ack" });

    const state = (await kept(id)).getState();
    // Taking away took away only what it saw: the merge's asset is there.
    expect(state.assets?.[asset]?.name).toBe("GitHub 上的");
    // The clip went, and the merge's name with it.
    expect(state.timelines["main"]?.clips[clip]).toBeUndefined();
    // The other asset is one value: the person's, without the merge's tags.
    expect(state.assets?.[other]?.name).toBe("离线时起的");
    expect(state.assets?.[other]?.tags).toBeUndefined();

    const conflicts = await conflictsOf(id);
    const at = (path: string[]) =>
      conflicts.find((conflict) => JSON.stringify(conflict.path) === JSON.stringify(path));
    expect(at(["assets", asset])).toMatchObject({
      source: "late",
      lost: "change",
      theirs: null,
      mergeId: merge,
    });
    expect(at(["timelines", "main", "clips", clip])).toMatchObject({
      lost: "batch",
      ours: null,
      theirs: { name: "GitHub 上的片段" },
    });
    expect(at(["assets", other])).toMatchObject({ lost: "batch", theirs: { tags: ["github"] } });
    expect(at(["assets", other])?.ours).toMatchObject({ name: "离线时起的" });
    // GitHub keeps what it has until people choose.
    const [link] = await database.db
      .select()
      .from(projectRepos)
      .where(eq(projectRepos.projectId, id));
    expect(link).toMatchObject({ state: "paused", pauseReason: "conflicts" });

    // A change made after the merge, which had it, is no conflict.
    const before = (await conflictsOf(id)).length;
    editor.hear(peer);
    const seen = editor.change({
      type: "asset.update",
      params: { asset, changes: { name: "看过以后改的" } },
    });
    expect(await push(peer, seen, { base: 2 + offline.length })).toMatchObject({ t: "ack" });
    expect((await conflictsOf(id)).length).toBe(before);
  });

  test("what a change wrote into what the merge took away is a conflict, as the change had it", async () => {
    const hub = hubOf();
    const { id, peer, repoId, repository, editor } = await linked(hub);
    const clip = Object.keys(editor.store.getState().timelines["main"]?.clips ?? {})[1] as string;
    // Offline, two changes of a clip, one after the other.
    const offline = [
      editor.change({
        type: "clip.update",
        params: { timeline: "main", clip, changes: { name: "离线时" } },
      }),
      editor.change({
        type: "clip.update",
        params: { timeline: "main", clip, changes: { duration: "3" } },
      }),
    ];
    // GitHub takes the clip away meanwhile.
    const next = commit(repository, repoId, [
      { type: "clip.remove", params: { timeline: "main", clips: [clip] } },
    ]);
    const merge = await mergeOf(id, repoId, repository, next);
    expect(await hub.mergeRepo(merge)).toMatchObject({ kind: "applied" });
    for (const change of offline) expect(await push(peer, change)).toMatchObject({ t: "ack" });
    expect((await kept(id)).getState().timelines["main"]?.clips[clip]).toBeUndefined();
    const conflicts = (await conflictsOf(id)).filter(
      (conflict) =>
        JSON.stringify(conflict.path) === JSON.stringify(["timelines", "main", "clips", clip]),
    );
    // One, of the latest change, with all the person did to the clip.
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({
      lost: "change",
      ours: null,
      theirs: { name: "离线时", duration: "3" },
    });
  });

  for (const prefer of ["editor", "github"] as const) {
    test(`a change that arrives late after a merge keeps the ${prefer}'s side, and the other is a conflict`, async () => {
      const hub = hubOf();
      const { id, peer, repoId, repository, editor } = await linked(hub, { prefer });
      const asset = Object.keys(editor.store.getState().assets ?? {})[1] as string;
      const offline = editor.change({
        type: "asset.update",
        params: { asset, changes: { name: "离线时起的" } },
      });
      const next = commit(repository, repoId, [
        { type: "asset.update", params: { asset, changes: { tags: ["github"] } } },
      ]);
      const merge = await mergeOf(id, repoId, repository, next);
      expect(await hub.mergeRepo(merge)).toMatchObject({ kind: "applied" });
      expect(await push(peer, offline)).toMatchObject({ t: "ack" });
      const keptAsset = (await kept(id)).getState().assets?.[asset];
      const [conflict] = (await conflictsOf(id)).filter((one) => one.source === "late");
      if (prefer === "editor") {
        expect(keptAsset).toMatchObject({ name: "离线时起的" });
        expect(keptAsset?.tags).toBeUndefined();
        expect(conflict).toMatchObject({ lost: "batch", theirs: { tags: ["github"] } });
      } else {
        expect(keptAsset).toMatchObject({ tags: ["github"] });
        expect(keptAsset?.name).not.toBe("离线时起的");
        expect(conflict).toMatchObject({ lost: "change", theirs: { name: "离线时起的" } });
        // The window hears that the platform put GitHub's side back.
        await peer.until(() => updatesOn(peer).length >= 2, "GitHub's side again");
        editor.hear(peer);
        expect(editor.store.getState().assets?.[asset]).toEqual(keptAsset);
      }
    });
  }

  test("people change which side stays first: the hub reads it again at once, also for what comes late", async () => {
    const hub = hubOf();
    const { id, peer, repoId, repository, editor } = await linked(hub, { prefer: "editor" });
    const asset = Object.keys(editor.store.getState().assets ?? {})[1] as string;
    const offline = editor.change({
      type: "asset.update",
      params: { asset, changes: { name: "离线时起的" } },
    });
    const next = commit(repository, repoId, [
      { type: "asset.update", params: { asset, changes: { tags: ["github"] } } },
    ]);
    const merge = await mergeOf(id, repoId, repository, next);
    expect(await hub.mergeRepo(merge)).toMatchObject({ kind: "applied" });
    // After the merge, which read it: as `RepositoryService.setPrefer` does, whose notice of the
    // link says so to the hub.
    await database.db
      .update(projectRepos)
      .set({ prefer: "github" })
      .where(eq(projectRepos.projectId, id));
    await hub.linkChanged(id);
    expect(await push(peer, offline)).toMatchObject({ t: "ack" });
    expect((await kept(id)).getState().assets?.[asset]).toMatchObject({ tags: ["github"] });
    const [conflict] = (await conflictsOf(id)).filter((one) => one.source === "late");
    expect(conflict).toMatchObject({ lost: "change", theirs: { name: "离线时起的" } });
  });

  for (const why of ["more merges than are watched", "a merge of too long ago"] as const) {
    test(`a change made without ${why} is a conflict to look at, never nothing`, async () => {
      const limits =
        why === "more merges than are watched" ? { batchesWatched: 1 } : { batchesWatchedMs: 1 };
      const first = hubOf(limits);
      const { id, ada, peer, repoId, repository, editor } = await linked(first);
      const offline = editor.change({ type: "project.rename", params: { name: "离线时的名字" } });
      const one = commit(repository, repoId, [{ type: "project.rename", params: { name: "一" } }]);
      expect(await first.mergeRepo(await mergeOf(id, repoId, repository, one))).toMatchObject({
        kind: "applied",
      });
      let hub = first;
      let window = peer;
      if (why === "more merges than are watched") {
        const scene = Object.keys(editor.store.getState().scenes)[0] as string;
        const two = commit(one, repoId, [
          { type: "scene.update", params: { scene, changes: { name: "二" } } },
        ]);
        expect(await first.mergeRepo(await mergeOf(id, repoId, one, two))).toMatchObject({
          kind: "applied",
        });
      } else {
        // Another start of the platform, a while after the merge.
        peer.connection.close();
        await new Promise((resolve) => setTimeout(resolve, 20));
        hub = hubOf(limits);
        window = await hello(hub, ada, id);
      }
      expect(await push(window, offline)).toMatchObject({ t: "ack" });
      const looks = (await conflictsOf(id)).filter((each) => each.kind === "check-duplicate");
      expect(looks.length).toBeGreaterThan(0);
      expect(looks[0]?.label).toContain("没法判断");
      expect(looks[0]?.ours).toBe("离线时的名字");
      const [link] = await database.db
        .select()
        .from(projectRepos)
        .where(eq(projectRepos.projectId, id));
      expect(link).toMatchObject({ state: "paused", pauseReason: "conflicts" });
      void hub;
    });
  }

  test("a change made without a merge too long ago, of more places than are listed, says how many more", async () => {
    const limits = { batchesWatched: 1 };
    const hub = hubOf(limits);
    const { id, peer, repoId, repository, editor } = await linked(hub);
    // Offline: 25 files of code, sent as one.
    const offline = mergeUpdates(
      Array.from({ length: 25 }, (_, index) =>
        editor.change({
          type: "file.write",
          params: { path: `code/n${index}.js`, text: `${index}` },
        }),
      ),
    );
    const one = commit(repository, repoId, [{ type: "project.rename", params: { name: "一" } }]);
    await hub.mergeRepo(await mergeOf(id, repoId, repository, one));
    const two = commit(one, repoId, [{ type: "project.rename", params: { name: "二" } }]);
    await hub.mergeRepo(await mergeOf(id, repoId, one, two));
    expect(await push(peer, offline)).toMatchObject({ t: "ack" });
    const looks = (await conflictsOf(id)).filter((conflict) => conflict.kind === "check-duplicate");
    expect(looks.filter((conflict) => conflict.path[0] === "files")).toHaveLength(20);
    const rest = looks.filter((conflict) => conflict.path[0] !== "files");
    expect(rest).toHaveLength(1);
    expect(rest[0]?.label).toContain("还有 5 处");
  });

  /** What a person doing `conflict.take` on a stored conflict gets, on the project as kept. */
  const taking = async (project: string, row: typeof repoConflicts.$inferSelect) => {
    const store = await kept(project);
    const result = store.execute({
      type: "conflict.take",
      params: {
        conflict: {
          file: row.file,
          path: row.path,
          kind: row.kind,
          ...(row.ours !== null && { ours: row.ours }),
          ...(row.theirs !== null && { theirs: row.theirs }),
        },
      },
    });
    return { result, store };
  };

  test("prefer github: an editor's removal of what GitHub changed is a conflict that gives it back", async () => {
    const hub = hubOf();
    const { id, peer, repoId, repository, editor } = await linked(hub, { prefer: "github" });
    const asset = Object.keys(editor.store.getState().assets ?? {})[0] as string;
    const offline = editor.change({ type: "asset.remove", params: { asset } });
    const next = commit(repository, repoId, [
      { type: "asset.update", params: { asset, changes: { tags: ["github"] } } },
    ]);
    await hub.mergeRepo(await mergeOf(id, repoId, repository, next));
    expect(await push(peer, offline)).toMatchObject({ t: "ack" });
    expect((await kept(id)).getState().assets?.[asset]).toMatchObject({ tags: ["github"] });
    const [conflict] = (await conflictsOf(id)).filter((one) => one.source === "late");
    expect(conflict).toMatchObject({ lost: "change", ours: expect.anything() });
    expect(conflict?.theirs ?? null).toBeNull();
    const { result, store } = await taking(id, conflict as typeof repoConflicts.$inferSelect);
    expect(result.ok).toBe(true);
    expect(store.getState().assets?.[asset]).toBeUndefined();
  });

  test("prefer github: an editor's removal of a code file GitHub wrote in is a conflict that gives it back", async () => {
    const hub = hubOf();
    const { id, peer, repoId, repository, editor } = await linked(hub, { prefer: "github" });
    const offline = editor.change({ type: "file.remove", params: { path: CODE } });
    const next = new Map(repository);
    next.set(CODE, `// github\n${repository.get(CODE) ?? ""}`);
    await hub.mergeRepo(await mergeOf(id, repoId, repository, next));
    expect(await push(peer, offline)).toMatchObject({ t: "ack" });
    expect((await kept(id)).getState().files[CODE]).toContain("// github");
    const late = (await conflictsOf(id)).filter((one) => one.source === "late");
    expect(late).toHaveLength(1);
    expect(late[0]).toMatchObject({ lost: "change", kind: "file" });
    const { result, store } = await taking(id, late[0] as typeof repoConflicts.$inferSelect);
    expect(result.ok).toBe(true);
    expect(store.getState().files[CODE]).toBeUndefined();
  });

  test("prefer github: what the editor wrote late is whole in the conflict and taking it gives it back", async () => {
    const hub = hubOf();
    const { id, peer, repoId, repository, editor } = await linked(hub, { prefer: "github" });
    const asset = Object.keys(editor.store.getState().assets ?? {})[1] as string;
    const offline = editor.change({
      type: "asset.update",
      params: { asset, changes: { name: "离线", tags: ["a", "b"] } },
    });
    const mine = editor.store.getState().assets?.[asset];
    const next = commit(repository, repoId, [
      { type: "asset.update", params: { asset, changes: { name: "GitHub", tags: ["g"] } } },
    ]);
    await hub.mergeRepo(await mergeOf(id, repoId, repository, next));
    expect(await push(peer, offline)).toMatchObject({ t: "ack" });
    const late = (await conflictsOf(id)).filter((one) => one.source === "late");
    expect(late.map((one) => one.lost)).toEqual(late.map(() => "change"));
    const { result, store } = await taking(id, late[0] as typeof repoConflicts.$inferSelect);
    expect(result.ok).toBe(true);
    expect(store.getState().assets?.[asset]).toEqual(mine);
  });

  test("prefer github: an order of tracks the editor made late is a conflict that gives it back", async () => {
    const hub = hubOf();
    const { id, peer, repoId, repository, editor } = await linked(hub, { prefer: "github" });
    const tracks = orderAt(editor.store.getState(), "main", "tracks");
    const [first, second, third] = tracks as [string, string, string];
    // Offline the last track goes first; on GitHub the second goes first.
    const offline = editor.change({
      type: "track.move",
      params: { timeline: "main", track: third, before: first },
    });
    const meant = orderAt(editor.store.getState(), "main", "tracks");
    const next = commit(repository, repoId, [
      { type: "track.move", params: { timeline: "main", track: second, before: first } },
    ]);
    await hub.mergeRepo(await mergeOf(id, repoId, repository, next));
    const github = orderAt((await kept(id)).getState(), "main", "tracks");
    expect(await push(peer, offline)).toMatchObject({ t: "ack" });
    expect(orderAt((await kept(id)).getState(), "main", "tracks")).toEqual(github);
    const late = (await conflictsOf(id)).filter(
      (one) => one.source === "late" && one.kind === "order",
    );
    expect(late).toHaveLength(1);
    expect(late[0]).toMatchObject({ lost: "change", ours: github, theirs: meant });
    const { result, store } = await taking(id, late[0] as typeof repoConflicts.$inferSelect);
    expect(result.ok).toBe(true);
    expect(orderAt(store.getState(), "main", "tracks")).toEqual(meant);
  });

  test("a repair may bring what the platform wrote, only from where the platform is", async () => {
    const hub = hubOf();
    const { id, peer, repoId, repository, editor } = await linked(hub);
    const next = commit(repository, repoId, [{ type: "project.rename", params: { name: "平台" } }]);
    await hub.mergeRepo(await mergeOf(id, repoId, repository, next));
    await peer.until(() => updatesOn(peer).length > 0, "the merge");
    editor.hear(peer);
    // What the platform wrote and lost, as after a backup: two of its updates, one after the other.
    const own = editor.store.doc.clientID;
    editor.store.doc.clientID = 0;
    const first = editor.change({ type: "project.rename", params: { name: "一" } });
    const second = editor.change({ type: "project.rename", params: { name: "二" } });
    editor.store.doc.clientID = own;
    expect(await push(peer, second, { base: 2, kind: "repair" })).toMatchObject({
      t: "reject",
      reason: "incomplete",
    });
    expect(await push(peer, first, { base: 2, kind: "repair" })).toMatchObject({ t: "ack" });
    expect(await push(peer, second, { base: 2, kind: "repair" })).toMatchObject({ t: "ack" });
    expect((await kept(id)).getState().manifest.name).toBe("二");
  });

  test("a conflict of a merge the platform does not keep any more is noted all the same", async () => {
    const hub = hubOf();
    const { id, peer, repoId, repository, editor } = await linked(hub);
    const asset = Object.keys(editor.store.getState().assets ?? {})[0] as string;
    const offline = editor.change({ type: "asset.remove", params: { asset } });
    const next = commit(repository, repoId, [
      { type: "asset.update", params: { asset, changes: { name: "GitHub 上的" } } },
    ]);
    const merge = await mergeOf(id, repoId, repository, next);
    await hub.mergeRepo(merge);
    await database.db.delete(repoMerges).where(eq(repoMerges.id, merge));
    expect(await push(peer, offline)).toMatchObject({ t: "ack" });
    expect(await conflictsOf(id)).toMatchObject([
      { batch: merge, mergeId: null, theirsSha: null, lost: "change" },
    ]);
  });

  test("changes kept with conflicts go once those are settled, or stale for a week", async () => {
    const hub = hubOf();
    const { id, repoId, repository } = await linked(hub);
    const next = commit(repository, repoId, [{ type: "project.rename", params: { name: "x" } }]);
    const merge = await mergeOf(id, repoId, repository, next);
    await hub.mergeRepo(merge);
    const row = (state: string, days: number) => ({
      projectId: id,
      mergeId: merge,
      batch: merge,
      source: "late",
      lost: "change" as const,
      file: "animaquill.json",
      path: ["manifest", "name"],
      label: "项目的名字",
      kind: "value",
      state,
      change: Buffer.from([1, 2, 3]),
      createdAt: new Date(Date.now() - days * 24 * 3600_000),
    });
    const rows = await database.db
      .insert(repoConflicts)
      .values([row("open", 30), row("stale", 1), row("stale", 8), row("theirs", 0)])
      .returning({ id: repoConflicts.id });
    await sweepProjects({ db: database.db, hub, log: quiet, recheck: undefined });
    const left = await database.db
      .select({ id: repoConflicts.id, change: repoConflicts.change })
      .from(repoConflicts)
      .where(eq(repoConflicts.projectId, id));
    const stays = (index: number) =>
      left.find((one) => one.id === rows[index]?.id)?.change !== null;
    expect([0, 1, 2, 3].map(stays)).toEqual([true, true, false, false]);
  });

  for (const prefer of ["editor", "github"] as const) {
    test(`where both changed the same thing, the ${prefer}'s side stays and the other is a conflict`, async () => {
      const hub = hubOf();
      const { id, peer, repoId, repository, editor } = await linked(hub, { prefer });
      const asset = Object.keys(editor.store.getState().assets ?? {})[0] as string;
      const mine = editor.change({
        type: "asset.update",
        params: { asset, changes: { name: "编辑器的" } },
      });
      expect(await push(peer, mine)).toMatchObject({ t: "ack", seq: 2 });
      const next = commit(repository, repoId, [
        { type: "asset.update", params: { asset, changes: { name: "GitHub 的" } } },
      ]);
      const merge = await mergeOf(id, repoId, repository, next);
      expect(await hub.mergeRepo(merge)).toMatchObject({ kind: "applied", conflicts: 1 });
      const [conflict] = await conflictsOf(id);
      const name = (await kept(id)).getState().assets?.[asset]?.name;
      if (prefer === "editor") {
        expect(name).toBe("编辑器的");
        expect(conflict).toMatchObject({ source: "merge", lost: "batch", kind: "value" });
        expect(JSON.stringify(conflict?.theirs)).toContain("GitHub 的");
      } else {
        expect(name).toBe("GitHub 的");
        expect(conflict).toMatchObject({ source: "merge", lost: "change", kind: "value" });
        expect(JSON.stringify(conflict?.theirs)).toContain("编辑器的");
      }
      // The window has what the database has: GitHub's side came as the merge.
      if (prefer === "github") await peer.until(() => updatesOn(peer).length > 0, "the merge");
      editor.hear(peer);
      expect(editor.store.getState().assets?.[asset]?.name).toBe(name);
    });
  }

  test("a merge the database could not keep is not in the copy either, and goes in once when tried again", async () => {
    let failing = false;
    const db = new Proxy(database.db, {
      get(target, property) {
        if (property === "transaction" && failing) {
          failing = false;
          return async () => {
            throw new Error("the database went away");
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function"
          ? (value as (...args: unknown[]) => unknown).bind(target)
          : value;
      },
    }) as Db;
    const hub = hubOf({}, db);
    const { id, peer, repoId, repository } = await linked(hub);
    const line = "// 从 GitHub 来的一行\n";
    const next = new Map(repository);
    next.set(CODE, `${line}${repository.get(CODE) ?? ""}`);
    const merge = await mergeOf(id, repoId, repository, next);
    failing = true;
    await expect(hub.mergeRepo(merge)).rejects.toThrow("the database went away");
    const [record] = await database.db.select().from(repoMerges).where(eq(repoMerges.id, merge));
    expect(record?.state).toBe("ready");
    expect(updatesOn(peer)).toEqual([]);
    expect(await hub.mergeRepo(merge)).toMatchObject({ kind: "applied", seq: 2 });
    const text = (await kept(id)).getState().files[CODE] as string;
    expect(text.split(line).length - 1).toBe(1);
    await peer.until(() => updatesOn(peer).length > 0, "the merge");
    expect(updatesOn(peer)).toHaveLength(1);
  });

  test("two editors and a merge at the same time come out the same everywhere, the merge once", async () => {
    const hub = hubOf();
    const { id, peer, repoId, repository, editor, ada } = await linked(hub);
    const second = new Editor(ProjectStore.fromUpdates([editor.store.encodeState()]).store);
    const other = await hello(hub, ada, id);
    const scene = Object.keys(editor.store.getState().scenes)[0] as string;
    const next = commit(repository, repoId, [
      { type: "project.rename", params: { name: "GitHub" } },
      { type: "scene.update", params: { scene, changes: { name: "GitHub 的场景" } } },
    ]);
    const merge = await mergeOf(id, repoId, repository, next);
    const changes = [
      editor.change({ type: "file.write", params: { path: "code/a.js", text: "a" } }),
      second.change({ type: "file.write", params: { path: "code/b.js", text: "b" } }),
      editor.change({ type: "scene.update", params: { scene, changes: { name: "编辑器的场景" } } }),
    ];
    const [outcome] = await Promise.all([
      hub.mergeRepo(merge),
      push(peer, changes[0] as Uint8Array),
      push(other, changes[1] as Uint8Array),
      push(peer, changes[2] as Uint8Array),
      hub.mergeRepo(merge),
    ]);
    expect(outcome?.kind).toBe("applied");
    await hub.idle();
    const rows = await updatesOf(id);
    expect(rows.filter((row) => row.kind === "repo")).toHaveLength(1);
    expect(rows.map((row) => row.seq)).toEqual(rows.map((_, index) => index + 1));
    const store = await kept(id);
    editor.hear(peer);
    second.hear(other);
    second.store.applyUpdates([changes[0] as Uint8Array, changes[2] as Uint8Array]);
    editor.store.applyUpdates([changes[1] as Uint8Array]);
    expect(editor.store.getState()).toEqual(store.getState());
    expect(second.store.getState()).toEqual(store.getState());
    expect(store.getState().manifest.name).toBe("GitHub");
    expect(store.getState().files["code/a.js"]).toBe("a");
    expect(store.getState().files["code/b.js"]).toBe("b");
  });

  test("two copies of the same project in two processes never both write as the platform", async () => {
    // Two APIs on one database, as for a moment during a deploy: each has a copy of the project.
    const one = hubOf();
    const two = hubOf();
    const { id, repoId, repository, peer } = await linked(one);
    peer.connection.close();
    const first = commit(repository, repoId, [{ type: "project.rename", params: { name: "一" } }]);
    const opening = await mergeOf(id, repoId, repository, first);
    // The second one reads the project into memory with this merge.
    expect(await two.mergeRepo(opening)).toMatchObject({ kind: "applied", seq: 2 });
    const scene = Object.keys(
      ProjectStore.open(new Map(first)).store?.getState().scenes ?? {},
    )[0] as string;
    const second = commit(first, repoId, [
      { type: "scene.update", params: { scene, changes: { name: "二" } } },
    ]);
    const third = commit(second, repoId, [
      { type: "file.write", params: { path: "code/c.js", text: "c" } },
    ]);
    // The first one still has its copy from before that: what it writes is never kept, and it
    // reads the project again.
    const meanwhile = await mergeOf(id, repoId, first, second);
    await expect(one.mergeRepo(meanwhile)).rejects.toThrow();
    expect(await one.mergeRepo(meanwhile)).toMatchObject({ kind: "applied", seq: 3 });
    // The second one's copy is behind the database now: its write is never kept.
    const late = await mergeOf(id, repoId, second, third);
    await expect(two.mergeRepo(late)).rejects.toThrow();
    expect(await two.mergeRepo(late)).toMatchObject({ kind: "applied", seq: 4 });
    const store = await kept(id);
    expect(store.getState().manifest.name).toBe("一");
    expect(store.getState().scenes[scene]?.name).toBe("二");
    expect(store.getState().files["code/c.js"]).toBe("c");
    // Every update the platform wrote is one the database has, in order: `kept` read all of it.
    expect(store.isMissingUpdates).toBe(false);
  });

  test("the same lines from GitHub and from a folder that is a clone of it are there once", async () => {
    const hub = hubOf();
    const { id, peer, repoId, repository, editor } = await linked(hub);
    const shared = repository.get(CODE) as string;
    const line = "// 同一行\n";
    const pulled = `${shared.slice(0, shared.indexOf("\n") + 1)}${line}${shared.slice(shared.indexOf("\n") + 1)}`;
    const next = new Map(repository);
    next.set(CODE, pulled);
    // The editor took the same commit in from its folder, offline.
    const before = editor.updates.length;
    editor.store.mergeFiles([{ path: CODE, base: shared, text: pulled }], {
      origin: "folder:pull",
      baseOf: (path) => editor.store.exportFiles().files.get(path),
    });
    const fromFolder = editor.updates.slice(before);
    const merge = await mergeOf(id, repoId, repository, next);
    expect(await hub.mergeRepo(merge)).toMatchObject({ kind: "applied" });
    for (const change of fromFolder) expect(await push(peer, change)).toMatchObject({ t: "ack" });
    expect((await kept(id)).getState().files[CODE]).toBe(pulled);
    // The window hears the platform write it once more, as of the merge.
    await peer.until(() => updatesOn(peer).length >= 2, "the text once");
    expect(updatesOn(peer).at(-1)).toMatchObject({ kind: "repo", by: { batch: merge } });
    editor.hear(peer);
    expect(editor.store.getState().files[CODE]).toBe(pulled);
    expect(await conflictsOf(id)).toEqual([]);
  });

  test("a merge that a newer one took the place of, or one of too much, does nothing", async () => {
    const hub = hubOf({ mergeFiles: 1 });
    const { id, repoId, repository } = await linked(hub);
    const next = commit(repository, repoId, [{ type: "project.rename", params: { name: "x" } }]);
    const merge = await mergeOf(id, repoId, repository, next);
    await database.db
      .update(repoMerges)
      .set({ state: "superseded" })
      .where(eq(repoMerges.id, merge));
    expect(await hub.mergeRepo(merge)).toEqual({ kind: "done", state: "superseded" });
    const more = new Map(next);
    more.set("code/one.js", "1");
    more.set("code/two.js", "2");
    const large = await mergeOf(id, repoId, repository, more);
    expect(await hub.mergeRepo(large)).toEqual({ kind: "refused", reason: "too-large" });
    expect((await updatesOf(id)).length).toBe(1);
    expect(await hub.mergeRepo("not a merge")).toEqual({ kind: "missing" });
  });
});
