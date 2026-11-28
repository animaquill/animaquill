import { readFileSync } from "node:fs";
import { ProjectStore, mergeUpdates, type CommandCall } from "@animaquill/core";
import {
  SYNC_CLOSE,
  SYNC_LIMITS,
  SYNC_PROTOCOL,
  encodeSyncMessage,
  framesOf,
} from "@animaquill/host/sync";
import { createProject } from "@animaquill/schema";
import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createTestDatabase, TEST_DATABASE, type TestDatabase } from "../test/database.ts";
import { TestPeer, someone } from "../test/sync-support.ts";
import type { Db } from "../database.ts";
import { projectSnapshots, projects, projectUpdates } from "../schema.ts";
import { weightOf } from "./copies.ts";
import { SyncHub, type SyncLimits } from "./hub.ts";
import { changeableLimits, seeded } from "../test/limits-support.ts";

/**
 * What keeps the platform up and its projects whole when windows send what they should not, or
 * something fails half way, as a review found it. Needs
 * AQ_TEST_DATABASE, see vitest.config.ts.
 */

const quiet = { info() {}, warn() {}, error() {} };
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let projectNumber = 0;
const newId = () => `g${Date.now().toString(36)}x${++projectNumber}`;

const write = (path: string, text: string): CommandCall => ({
  type: "file.write",
  params: { path, text },
});

/** A project of the editor, and the updates of its changes. */
class Editor {
  readonly store: ProjectStore;
  readonly updates: Uint8Array[] = [];

  constructor(state?: Uint8Array) {
    this.store = state
      ? (ProjectStore.fromUpdates([state]).store as ProjectStore)
      : ProjectStore.create(createProject({ name: "测试" }));
    this.store.onLocalUpdate((update) => this.updates.push(update));
  }

  get id(): string {
    return this.store.getState().manifest.id;
  }

  change(call: CommandCall): Uint8Array {
    const before = this.updates.length;
    const result = this.store.execute(call);
    if (!result.ok) throw new Error(`${result.error.code}: ${JSON.stringify(result.error.params)}`);
    return this.updates.slice(before)[0] as Uint8Array;
  }

  raw(edit: (doc: ProjectStore["doc"]) => void): Uint8Array {
    let update: Uint8Array | undefined;
    const take = (made: Uint8Array) => {
      update = made;
    };
    this.store.doc.on("update", take);
    this.store.doc.transact(() => edit(this.store.doc));
    this.store.doc.off("update", take);
    if (!update) throw new Error("nothing changed");
    return update;
  }
}

const manifestOf = (doc: ProjectStore["doc"]) =>
  doc.getMap("project").get("manifest") as { set(key: string, value: unknown): void };

/** A change that adds `count` files of one character, as many pieces as there are: two each. */
function manyFiles(editor: Editor, count: number): Uint8Array {
  const before = editor.store.stateVector();
  editor.change(write("code/seed.js", "s"));
  type Text = { insert(index: number, text: string): void };
  const files = editor.store.doc.getMap("project").get("files") as {
    get(key: string): unknown;
    set(key: string, value: unknown): void;
  };
  const Made = (files.get("code/seed.js") as { constructor: new () => Text }).constructor;
  editor.store.doc.transact(() => {
    for (let index = 0; index < count; index++) {
      const text = new Made();
      files.set(`code/f${index}.js`, text);
      text.insert(0, "x");
    }
  });
  return editor.store.diffSince(before);
}

/**
 * Waits until the hub says so: what is in its memory has no event of its own, so this looks again
 * and again. The test's own time is what it gets, see vitest.config.ts; `what` says what it waits
 * for where it is called.
 */
async function until(done: () => boolean, _what: string): Promise<void> {
  while (!done()) await wait(5);
}

describe.skipIf(!TEST_DATABASE)("syncing, when windows send what they should not", () => {
  let database: TestDatabase;
  const hubs: SyncHub[] = [];
  beforeAll(async () => {
    database = await createTestDatabase();
  });
  afterAll(async () => {
    for (const hub of hubs) hub.stop();
    await database?.drop();
  });

  const hubOf = (limits: Partial<SyncLimits> = {}, db: Db = database.db) => {
    const hub = new SyncHub({ db, log: quiet, limits });
    hubs.push(hub);
    return hub;
  };

  const helloOf = (
    project: string,
    { create, after = 0, device = "d1" }: { create?: Editor; after?: number; device?: string } = {},
  ) =>
    ({
      t: "hello",
      v: SYNC_PROTOCOL,
      project,
      after,
      device,
      window: "w1",
      editor: "test",
      ...(create && { create: { name: "测试", projectId: create.id } }),
      payload: create ? create.store.encodeState() : new Uint8Array(0),
    }) as const;

  async function hello(
    hub: SyncHub,
    who: Awaited<ReturnType<typeof someone>>,
    project: string,
    options: { create?: Editor; after?: number; device?: string } = {},
  ): Promise<TestPeer> {
    const peer = new TestPeer(hub, who);
    peer.send(helloOf(project, options));
    await peer.until(() => peer.of("synced").length > 0 || peer.closedWith !== undefined, "synced");
    return peer;
  }

  let pushes = 0;
  async function push(peer: TestPeer, payload: Uint8Array, base = 1) {
    const id = ++pushes;
    peer.send({
      t: "push",
      id,
      kind: "user",
      base,
      at: Date.now(),
      window: "w1",
      behind: false,
      payload,
    });
    await until(
      () =>
        peer.closedWith !== undefined ||
        peer.received.some((message) => "id" in message && message.id === id),
      `an answer to ${id}`,
    );
    return peer.received.find((message) => "id" in message && message.id === id);
  }

  const headOf = async (id: string) =>
    (await database.db.select({ head: projects.head }).from(projects).where(eq(projects.id, id)))[0]
      ?.head;

  /** The project as the database keeps it, read the way a window that comes later gets it. */
  async function kept(hub: SyncHub, who: Awaited<ReturnType<typeof someone>>, id: string) {
    const peer = await hello(hub, who, id);
    const { store } = ProjectStore.fromUpdates(peer.of("update").map((update) => update.payload));
    peer.connection.close();
    if (!store) throw new Error("nothing came");
    return store;
  }

  test("somebody else's hello does not read the project into memory (S1a)", async () => {
    const hub = hubOf({ idleMs: 30 });
    const ada = await someone(database.db);
    const eve = await someone(database.db);
    const id = newId();
    const owner = await hello(hub, ada, id, { create: new Editor() });
    owner.connection.close();
    await until(() => hub.size.open === 0 && hub.size.projects === 0, "the project to go");
    const other = await hello(hub, eve, id);
    expect(other.closedWith?.code).toBe(SYNC_CLOSE.missing);
    expect(hub.size.open).toBe(0);
    await until(() => hub.size.projects === 0, "what was read of it to go");
  });

  test(
    "a connection that goes during hello leaves nothing in memory (S1b)",
    { timeout: 30_000 },
    async () => {
      for (const delay of [0, 1, 3, 10, 30]) {
        const hub = hubOf({ idleMs: 30 });
        const ada = await someone(database.db);
        const peer = new TestPeer(hub, ada);
        peer.send(helloOf(newId(), { create: new Editor() }));
        await wait(delay);
        peer.connection.close();
        await hub.idle();
        await until(
          () => hub.size.open === 0 && hub.size.projects === 0 && hub.size.connections === 0,
          `nothing in memory, after ${delay} ms`,
        );
      }
    },
  );

  test("a change turned away after the copy took it in is in neither the copy nor the database (S2)", async () => {
    const hub = hubOf({ catchUpUpdates: 0 });
    const ada = await someone(database.db);
    const editor = new Editor();
    const id = newId();
    const first = await hello(hub, ada, id, { create: editor });
    // Fine as Yjs, but no name: the copy takes it in before it can tell.
    const bad = new Editor(editor.store.encodeState()).raw((doc) =>
      manifestOf(doc).set("name", 123),
    );
    expect(await push(first, bad)).toMatchObject({ t: "reject", reason: "invalid", retry: false });
    expect(await headOf(id)).toBe(1);
    // What the next window gets is what the database has.
    expect((await kept(hub, ada, id)).getState().manifest.name).toBe("测试");
    const good = editor.change(write("code/g.js", "g"));
    expect(await push(first, good)).toMatchObject({ t: "ack", seq: 2 });
    expect((await kept(hub, ada, id)).getState().files["code/g.js"]).toBe("g");
  });

  test("a change the database could not keep is not in the copy either, and goes when sent again", async () => {
    let failing = false;
    // The database, but its next transaction fails, as when the connection to it drops.
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
    const ada = await someone(database.db);
    const editor = new Editor();
    const id = newId();
    const peer = await hello(hub, ada, id, { create: editor });
    const change = editor.change(write("code/a.js", "a"));
    failing = true;
    expect(await push(peer, change)).toMatchObject({
      t: "reject",
      reason: "unavailable",
      retry: true,
    });
    expect(await headOf(id)).toBe(1);
    // Had the copy kept it, this would be nothing new, and the database would never get it.
    expect(await push(peer, change)).toMatchObject({ t: "ack", seq: 2 });
    expect((await kept(hub, ada, id)).getState().files["code/a.js"]).toBe("a");
  });

  test("two changes that are fine on their own both go, even where together they do not fit", async () => {
    const hub = hubOf();
    const ada = await someone(database.db);
    const editor = new Editor();
    const id = newId();
    const peer = await hello(hub, ada, id, { create: editor });
    const [track] = Object.values(editor.store.getState().timelines["main"]?.tracks ?? {});
    if (!track) throw new Error("no track");
    // One browser takes the track away; another one, without that, puts a clip on it.
    const one = new Editor(editor.store.encodeState());
    const other = new Editor(editor.store.encodeState());
    const removed = one.change({
      type: "track.remove",
      params: { timeline: "main", track: track.id },
    });
    const added = other.change({
      type: "clip.add",
      params: {
        timeline: "main",
        track: track.id,
        start: "0",
        duration: "1",
        source: { kind: "color", color: "#000000" },
      },
    });
    expect(await push(peer, removed)).toMatchObject({ t: "ack", seq: 2 });
    expect(await push(peer, added)).toMatchObject({ t: "ack", seq: 3 });
  });

  test("only a new project is turned away for what a person keeps: their changes never are", async () => {
    const editor = new Editor();
    const size = editor.store.encodeState().length;
    const limits = changeableLimits();
    const hub = new SyncHub({ db: database.db, log: quiet, personLimits: limits });
    hubs.push(hub);
    const ada = await someone(database.db);
    const id = newId();
    const peer = await hello(hub, ada, id, { create: editor });
    expect(peer.closedWith).toBeUndefined();
    // As many projects as they may have: the next one is not made, and nothing of it is kept.
    limits.set({ "projects.count": 1 });
    const second = newId();
    const counted = await hello(hub, ada, second, { create: new Editor() });
    expect(counted.closedWith).toEqual({ code: SYNC_CLOSE.quota, reason: "count" });
    expect(await headOf(second)).toBeUndefined();
    // As much as they may keep, with its cover: a project that would go past it is not made...
    limits.set({ "storage.platform": size + 100 });
    const third = newId();
    const full = await hello(hub, ada, third, { create: new Editor() });
    expect(full.closedWith).toEqual({ code: SYNC_CLOSE.quota, reason: "quota" });
    expect(await headOf(third)).toBeUndefined();
    // ...but the one there grows past it, as far as it likes: the person is never stopped.
    limits.set({ "storage.platform": 1, "projects.count": 0 });
    const other = new Editor(editor.store.encodeState());
    expect(await push(peer, editor.change(write("code/big.js", "b".repeat(4000))))).toMatchObject({
      t: "ack",
      seq: 2,
    });
    expect(await push(peer, other.change(write("code/small.js", "s")), 2)).toMatchObject({
      t: "ack",
    });
    expect(await hub.rename(id, ada.userId, "改了名字")).toMatchObject({ kind: "renamed" });
    expect(await headOf(id)).toBe(4);
    // Nothing is limited again: it is made.
    limits.set({});
    expect((await hello(hub, ada, third, { create: new Editor() })).closedWith).toBeUndefined();
  });

  test("of two new projects at once, where there is room for one, one is made", async () => {
    // Two processes, as the platform runs them: the lock is in the database, not in a hub.
    const limits = changeableLimits();
    const two = [0, 1].map(() => {
      const hub = new SyncHub({ db: database.db, log: quiet, personLimits: limits });
      hubs.push(hub);
      return hub;
    });
    const size = new Editor().store.encodeState().length;
    const random = seeded(20261128);
    for (let round = 0; round < 12; round++) {
      const ada = await someone(database.db);
      const held = Math.floor(random() * 3);
      for (let index = 0; index < held; index++)
        await hello(two[0]!, ada, newId(), { create: new Editor() });
      // Room for one more: by number, or by bytes.
      limits.set(
        random() < 0.5
          ? { "projects.count": held + 1 }
          : { "storage.platform": (held + 1) * size + Math.floor(size / 2) },
      );
      const ids = [newId(), newId()];
      const peers = ids.map((id) => {
        const peer = new TestPeer(two[random() < 0.5 ? 0 : 1]!, ada);
        return { id, peer };
      });
      const gap = Math.floor(random() * 3);
      peers[0]!.peer.send(helloOf(ids[0]!, { create: new Editor() }));
      if (gap > 0) await wait(gap);
      peers[1]!.peer.send(helloOf(ids[1]!, { create: new Editor() }));
      for (const { peer } of peers)
        await peer.until(
          () => peer.of("synced").length > 0 || peer.closedWith !== undefined,
          "synced",
        );
      const made = peers.filter(({ peer }) => peer.closedWith === undefined);
      const refused = peers.filter(({ peer }) => peer.closedWith?.code === SYNC_CLOSE.quota);
      expect([made.length, refused.length], `round ${round}`).toEqual([1, 1]);
      const theirs = await database.db
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.ownerId, ada.userId));
      expect(theirs.length, `round ${round}`).toBe(held + 1);
      for (const { peer } of peers) peer.connection.close();
    }
  });

  test(
    "a change of more pieces than the platform takes in is turned away before it is",
    { timeout: 120_000 },
    async () => {
      const hub = hubOf();
      const ada = await someone(database.db);
      const editor = new Editor();
      const id = newId();
      const peer = await hello(hub, ada, id, { create: editor });
      const many = new Editor(editor.store.encodeState()).raw((doc) => {
        const manifest = manifestOf(doc);
        for (let index = 0; index <= SYNC_LIMITS.structs; index++) manifest.set(`k${index}`, index);
      });
      expect(many.length).toBeLessThan(SYNC_LIMITS.update);
      expect(await push(peer, many)).toMatchObject({
        t: "reject",
        reason: "too-large",
        retry: false,
      });
      expect(await push(peer, editor.change(write("code/a.js", "a")))).toMatchObject({
        t: "ack",
        seq: 2,
      });
    },
  );

  test("a change in parts goes; one larger than a change can be closes the connection", async () => {
    const hub = hubOf();
    const ada = await someone(database.db);
    const editor = new Editor();
    const id = newId();
    const peer = await hello(hub, ada, id, { create: editor });
    const large = editor.change(write("code/large.js", "l".repeat(3 * SYNC_LIMITS.part)));
    expect(await push(peer, large)).toMatchObject({ t: "ack", seq: 2 });
    expect((await kept(hub, ada, id)).getState().files["code/large.js"]?.length).toBe(
      3 * SYNC_LIMITS.part,
    );
    const other = await hello(hub, ada, id, { after: 2 });
    other.send({
      t: "push",
      id: 1,
      kind: "user",
      base: 2,
      at: Date.now(),
      window: "w1",
      behind: false,
      payload: new Uint8Array(SYNC_LIMITS.update + 1),
    });
    await other.until(() => other.closedWith !== undefined, "a close");
    expect(other.closedWith?.code).toBe(SYNC_CLOSE.protocol);
  });

  test("what one connection sends counts as it arrives, and only so much of it waits", async () => {
    const hub = hubOf({ queuedMessages: 4 });
    const ada = await someone(database.db);
    const editor = new Editor();
    const peer = await hello(hub, ada, newId(), { create: editor });
    for (let index = 0; index < 20; index++) {
      peer.send({ t: "check" });
    }
    await peer.until(() => peer.closedWith !== undefined, "a close");
    expect(peer.closedWith?.code).toBe(SYNC_CLOSE.tooMany);
  });

  test("a person opens only so many connections in a minute", async () => {
    const hub = hubOf({ startsPerMinute: 3 });
    const ada = await someone(database.db);
    const id = newId();
    const peers = [await hello(hub, ada, id, { create: new Editor() })];
    for (let index = 0; index < 3; index++) peers.push(await hello(hub, ada, id, { after: 1 }));
    expect(peers.map((peer) => peer.closedWith?.code)).toEqual([
      undefined,
      undefined,
      undefined,
      SYNC_CLOSE.tooMany,
    ]);
  });

  test(
    "the thread of the working copies can run out of memory, and the platform goes on",
    { timeout: 120_000 },
    async () => {
      const hub = hubOf({ copiesHeapMb: 24 });
      const ada = await someone(database.db);
      const editor = new Editor();
      const id = newId();
      const peer = await hello(hub, ada, id, { create: editor });
      // Fine on its own, and small as bytes go, but far more than the thread can take in.
      const huge = manyFiles(new Editor(editor.store.encodeState()), SYNC_LIMITS.structs / 2 - 10);
      // The first time, it may have been what else the thread had: it can come again.
      expect(await push(peer, huge)).toMatchObject({
        t: "reject",
        reason: "unavailable",
        retry: true,
      });
      // Twice in a row, it is the change.
      expect(await push(peer, huge)).toMatchObject({
        t: "reject",
        reason: "too-large",
        retry: false,
      });
      expect(await headOf(id)).toBe(1);
      expect(await push(peer, editor.change(write("code/after.js", "a")))).toMatchObject({
        t: "ack",
        seq: 2,
      });
    },
  );

  /** About the memory a copy of this project takes, as the working copies weigh it. */
  const weight = (editor: Editor) => {
    let structs = 0;
    for (const pieces of editor.store.doc.store.clients.values()) structs += pieces.length;
    return weightOf(editor.store.encodeState().length, structs);
  };

  test("the working copies keep to their budget: what was used the longest ago goes first, windows or not", async () => {
    const one = weight(new Editor());
    const hub = hubOf({ copiesBytes: Math.round(2.5 * one) });
    const ada = await someone(database.db);
    const first = new Editor();
    const firstId = newId();
    const a = await hello(hub, ada, firstId, { create: first });
    await hello(hub, ada, newId(), { create: new Editor() });
    expect(hub.size.open).toBe(2);
    // Both have windows, and nothing is done with either: the one used the longest ago goes.
    const third = await hello(hub, ada, newId(), { create: new Editor() });
    expect(third.closedWith).toBeUndefined();
    expect(hub.size.open).toBe(2);
    // Its window goes on: the copy comes back from the database.
    expect(await push(a, first.change(write("code/a.js", "a")))).toMatchObject({
      t: "ack",
      seq: 2,
    });
    expect(hub.size.open).toBe(2);
    expect((await kept(hub, ada, firstId)).getState().files["code/a.js"]).toBe("a");
  });

  test("a project that does not fit now does not open now, and comes back later", async () => {
    const one = weight(new Editor());
    const ada = await someone(database.db);
    const full = await hello(hubOf({ copiesBytes: Math.round(0.5 * one) }), ada, newId(), {
      create: new Editor(),
    });
    expect(full.closedWith?.code).toBe(SYNC_CLOSE.unavailable);
  });

  test("a project grows only so large, as the memory of its copy goes", async () => {
    const one = weight(new Editor());
    const hub = hubOf({ projectMemory: one + 300 * 550 });
    const ada = await someone(database.db);
    const editor = new Editor();
    const id = newId();
    const peer = await hello(hub, ada, id, { create: editor });
    expect(await push(peer, editor.change(write("code/a.js", "a")))).toMatchObject({
      t: "ack",
      seq: 2,
    });
    const bulk = new Editor(editor.store.encodeState());
    const made: Uint8Array[] = [];
    for (let index = 0; index < 400; index++) {
      made.push(bulk.change(write(`code/f${index}.js`, "x")));
    }
    expect(await push(peer, mergeUpdates(made), 2)).toMatchObject({
      t: "reject",
      reason: "too-large",
    });
    expect(await headOf(id)).toBe(2);
    // The copy did not keep it: what the next window gets is what the database has.
    expect(Object.keys((await kept(hub, ada, id)).getState().files)).toEqual(["code/a.js"]);
  });

  test("another process that took a change closes the connections of the copy here", async () => {
    const here = hubOf();
    const there = hubOf();
    const ada = await someone(database.db);
    const editor = new Editor();
    const id = newId();
    const peer = await hello(here, ada, id, { create: editor });
    const listener = await hello(here, ada, id, { after: 1 });
    const elsewhere = await hello(there, ada, id, { after: 1 });
    const second = new Editor(editor.store.encodeState());
    expect(await push(elsewhere, editor.change(write("code/there.js", "t")))).toMatchObject({
      t: "ack",
      seq: 2,
    });
    // Here, the head is still 1: the change does not go in on top of the wrong one.
    const change = second.change(write("code/here.js", "h"));
    await push(peer, change, 2);
    await listener.until(() => listener.closedWith !== undefined, "a close");
    expect(listener.closedWith?.code).toBe(SYNC_CLOSE.unavailable);
    // Read again, the project has both, one after the other.
    const again = await hello(here, ada, id, { after: 2 });
    expect(await push(again, change, 2)).toMatchObject({
      t: "ack",
      seq: 3,
    });
    const rows = await database.db
      .select({ seq: projectUpdates.seq })
      .from(projectUpdates)
      .where(eq(projectUpdates.projectId, id))
      .orderBy(asc(projectUpdates.seq));
    expect(rows.map((row) => row.seq)).toEqual([1, 2, 3]);
  });

  test("a key that every object has is turned away, and neither the copy nor a snapshot keeps it", async () => {
    const hub = hubOf({ compactUpdates: 3, catchUpUpdates: 0 });
    const ada = await someone(database.db);
    const editor = new Editor();
    const id = newId();
    const first = await hello(hub, ada, id, { create: editor });
    type Level = { get(key: string): unknown; set(key: string, value: unknown): void };
    const bad = new Editor(editor.store.encodeState()).raw((doc) => {
      const timelines = doc.getMap("project").get("timelines") as Level;
      const clips = (timelines.get("main") as Level).get("clips") as Level & {
        constructor: new () => Level;
      };
      const clip = new clips.constructor();
      clips.set("clip_x", clip);
      clip.set("effects/e1/__defineGetter__", "anything at all");
    });
    expect(await push(first, bad)).toMatchObject({ t: "reject", reason: "invalid", retry: false });
    const second = await hello(hub, ada, id);
    for (let index = 0; index < 3; index++) {
      expect(await push(second, editor.change(write(`code/g${index}.js`, "g")))).toMatchObject({
        t: "ack",
      });
    }
    await hub.idle();
    const snapshots = await database.db
      .select({ state: projectSnapshots.state })
      .from(projectSnapshots)
      .where(eq(projectSnapshots.projectId, id));
    expect(snapshots.length).toBeGreaterThan(0);
    const clipsOf = (store: ProjectStore) =>
      Object.keys(store.getState().timelines["main"]?.clips ?? {});
    for (const { state } of snapshots) {
      const snapshot = ProjectStore.fromUpdates([new Uint8Array(state)]).store as ProjectStore;
      expect(clipsOf(snapshot)).not.toContain("clip_x");
    }
    expect(clipsOf(await kept(hub, ada, id))).not.toContain("clip_x");
  });

  test("documents from before 2026-11-08 become projects on the platform, and pages from then go on", async () => {
    const hub = hubOf();
    const ada = await someone(database.db);
    const fixture = (name: string) =>
      Uint8Array.from(
        Buffer.from(
          readFileSync(
            new URL(`../../../core/fixtures/${name}/document.txt`, import.meta.url),
            "utf8",
          ),
          "base64",
        ),
      );
    for (const name of ["before-flat-levels", "before-flat-versions"]) {
      const editor = new Editor(
        (ProjectStore.fromUpdates([fixture(name)]).store as ProjectStore).encodeWhole(),
      );
      const peer = await hello(hub, ada, newId(), { create: editor });
      expect(peer.closedWith, name).toBeUndefined();
      // A page from back then writes a transition the old way.
      type Level = { get(key: string): unknown; set(key: string, value: unknown): void };
      const old = editor.raw((doc) => {
        const timelines = doc.getMap("project").get("timelines") as Level;
        const transitions = (timelines.get("main") as Level).get("transitions") as Level & {
          constructor: new () => Level;
        };
        const made = new transitions.constructor();
        transitions.set("tr_9", made);
        made.set("kind", "fade");
      });
      expect(await push(peer, old), name).toMatchObject({ t: "ack", seq: 2 });
    }
  });

  test("a project is as large as it is, not as what came since the last snapshot", async () => {
    const file = 2 * 1024 * 1024;
    const hub = hubOf({ projectBytes: Math.round(1.6 * file), compactBytes: 64 * file });
    const ada = await someone(database.db);
    const editor = new Editor();
    const peer = await hello(hub, ada, newId(), { create: editor });
    expect(await push(peer, editor.change(write("code/big.js", "a".repeat(file))))).toMatchObject({
      t: "ack",
    });
    // Written over: more came than the limit, the project is still less.
    expect(await push(peer, editor.change(write("code/big.js", "b".repeat(file))))).toMatchObject({
      t: "ack",
    });
    expect(await push(peer, editor.change(write("code/more.js", "c".repeat(file))))).toMatchObject({
      t: "reject",
      reason: "too-large",
    });
  });

  test("what came of a message in parts counts, for a person and for everyone, and has to go on", async () => {
    const frames = framesOf(
      {
        t: "push",
        id: 1,
        kind: "user",
        base: 1,
        at: Date.now(),
        window: "w1",
        behind: false,
        payload: new Uint8Array(6 * SYNC_LIMITS.part),
      },
      SYNC_LIMITS.part,
    );
    const begin = async (hub: SyncHub, who: Awaited<ReturnType<typeof someone>>) => {
      const peer = await hello(hub, who, newId(), { create: new Editor() });
      for (const frame of frames.slice(0, 4)) peer.sendBytes(frame);
      await hub.idle();
      return peer;
    };
    // A person: what their connections hold, together.
    const mine = hubOf({ queuedBytesPerUser: 6 * SYNC_LIMITS.part });
    const ada = await someone(database.db);
    const one = await begin(mine, ada);
    expect(one.closedWith).toBeUndefined();
    const two = await begin(mine, ada);
    expect(two.closedWith?.code).toBe(SYNC_CLOSE.tooMany);
    // Everyone: the platform takes in so much at once.
    const all = hubOf({ queuedBytesTotal: 6 * SYNC_LIMITS.part });
    await begin(all, await someone(database.db));
    const other = await begin(all, await someone(database.db));
    expect(other.closedWith?.code).toBe(SYNC_CLOSE.unavailable);
    // A message whose next part does not come.
    const slow = hubOf({ partsMs: 200 });
    const waiting = await begin(slow, await someone(database.db));
    await waiting.until(() => waiting.closedWith !== undefined, "a close");
    expect(waiting.closedWith?.code).toBe(SYNC_CLOSE.tooMany);
    expect(slow.size.connections).toBe(0);
  });

  test("a browser that takes nothing of what it is sent holds only so much, and not for long", async () => {
    const ada = await someone(database.db);
    const editor = new Editor();
    editor.change(write("code/big.js", "x".repeat(3 * 1024 * 1024)));
    const id = newId();
    const setup = hubOf();
    await hello(setup, ada, id, { create: editor });
    /** A socket whose browser reads nothing: what goes into it stays. */
    const reader = (hub: SyncHub) => {
      const state = { sent: 0, closed: undefined as number | undefined };
      const peer = {
        send: (data: Uint8Array) => void (state.sent += data.length),
        close: (code: number) => void (state.closed = code),
        buffered: () => state.sent,
      };
      const connection = hub.open(peer, ada);
      connection.receive(
        encodeSyncMessage({
          t: "hello",
          v: SYNC_PROTOCOL,
          project: id,
          after: 0,
          device: "d1",
          window: "w1",
          editor: "test",
          payload: new Uint8Array(0),
        }),
      );
      return state;
    };
    const stuck = reader(hubOf({ stuckMs: 300 }));
    await until(() => stuck.closed !== undefined, "a close");
    expect(stuck.closed).toBe(SYNC_CLOSE.tooMany);
    // Only as much went into the socket as it takes before it waits.
    expect(stuck.sent).toBeLessThan(2 * 1024 * 1024);
    const full = reader(hubOf({ outboundBytes: 1024 * 1024 }));
    await until(() => full.closed !== undefined, "a close");
    expect(full.closed).toBe(SYNC_CLOSE.tooMany);
  });

  test("a person signed out everywhere loses every connection at once", async () => {
    const hub = hubOf();
    const ada = await someone(database.db);
    const bob = await someone(database.db);
    const id = newId();
    const one = await hello(hub, ada, id, { create: new Editor() });
    const two = await hello(hub, { ...ada, session: "another-session" }, id, { after: 1 });
    const theirs = await hello(hub, bob, newId(), { create: new Editor() });
    hub.closeUser(ada.userId);
    await until(() => one.closedWith !== undefined && two.closedWith !== undefined, "the closes");
    expect([one.closedWith?.code, two.closedWith?.code]).toEqual([
      SYNC_CLOSE.signedOut,
      SYNC_CLOSE.signedOut,
    ]);
    expect(theirs.closedWith).toBeUndefined();
  });
});
