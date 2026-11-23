import { ProjectStore, type CommandCall } from "@animaquill/core";
import { SYNC_CLOSE, SYNC_PROTOCOL, unpackChecked } from "@animaquill/host/sync";
import { createProject } from "@animaquill/schema";
import { and, asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createTestDatabase, TEST_DATABASE, type TestDatabase } from "../test/database.ts";
import { TestPeer, someone } from "../test/sync-support.ts";
import { projectSnapshots, projects, projectUpdates } from "../schema.ts";
import { SyncHub, digestOf } from "./hub.ts";
import { DESCRIPTION_MOST } from "./copies.ts";

/**
 * The platform's side of syncing, on a real PostgreSQL, message by message. Needs AQ_TEST_DATABASE,
 * see vitest.config.ts.
 */

const quiet = { info() {}, warn() {}, error() {} };

/** A project of the editor, and what its changes are as updates. */
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

  /** The update of a change. */
  change(call: CommandCall): Uint8Array {
    const before = this.updates.length;
    const result = this.store.execute(call);
    if (!result.ok) throw new Error(`${result.error.code}: ${JSON.stringify(result.error.params)}`);
    const made = this.updates.slice(before);
    if (made.length !== 1) throw new Error(`${made.length} updates`);
    return made[0] as Uint8Array;
  }

  /** Writes into the document behind the editor's back, as a hostile window could. */
  raw(write: (doc: ProjectStore["doc"]) => void): Uint8Array {
    let update: Uint8Array | undefined;
    const take = (made: Uint8Array) => {
      update = made;
    };
    this.store.doc.on("update", take);
    this.store.doc.transact(() => write(this.store.doc));
    this.store.doc.off("update", take);
    if (!update) throw new Error("nothing changed");
    return update;
  }
}

const write = (path: string, text: string): CommandCall => ({
  type: "file.write",
  params: { path, text },
});

/** The project from what came on a connection. */
const replicaOf = (peer: TestPeer): ProjectStore => {
  const { store } = ProjectStore.fromUpdates(peer.of("update").map((update) => update.payload));
  if (!store) throw new Error("no project came");
  return store;
};

let projectNumber = 0;
const newId = () => `p${Date.now().toString(36)}x${++projectNumber}`;

describe.skipIf(!TEST_DATABASE)("syncing, on a database", () => {
  let database: TestDatabase;
  beforeAll(async () => {
    database = await createTestDatabase();
  });
  afterAll(async () => {
    await database?.drop();
  });

  const hubOf = (limits = {}) => new SyncHub({ db: database.db, log: quiet, limits });

  /** Says hello for a project, and waits until everything up to now has come. */
  async function hello(
    hub: SyncHub,
    who: Awaited<ReturnType<typeof someone>>,
    project: string,
    {
      after = 0,
      digest,
      create,
      device = "d1",
      generation,
    }: {
      after?: number;
      digest?: string;
      create?: Editor;
      device?: string;
      /** Which working copy the window says it has: anything, as a broken editor could say. */
      generation?: unknown;
    } = {},
  ) {
    const peer = new TestPeer(hub, who);
    peer.send({
      t: "hello",
      v: SYNC_PROTOCOL,
      project,
      after,
      ...(digest !== undefined && { digest }),
      // Whatever it is, as it goes into the header as it is.
      ...(generation !== undefined && { generation: generation as number }),
      device,
      window: "w1",
      editor: "test",
      ...(create && { create: { name: "测试", projectId: create.id } }),
      payload: create ? create.store.encodeState() : new Uint8Array(0),
    });
    await peer.until(() => peer.of("synced").length > 0 || peer.closedWith !== undefined, "synced");
    return peer;
  }

  let pushes = 0;
  const push = (
    peer: TestPeer,
    payload: Uint8Array,
    options: { kind?: "user" | "folder"; base?: number; behind?: boolean } = {},
  ) => {
    const id = ++pushes;
    peer.send({
      t: "push",
      id,
      kind: options.kind ?? "user",
      base: options.base ?? 0,
      at: Date.now(),
      window: "w1",
      behind: options.behind ?? false,
      payload,
    });
    return id;
  };

  const answerTo = async (peer: TestPeer, id: number) => {
    await peer.until(
      () => peer.received.some((message) => "id" in message && message.id === id),
      `an answer to ${id}`,
    );
    return peer.received.find((message) => "id" in message && message.id === id);
  };

  const rowsOf = (project: string) =>
    database.db
      .select()
      .from(projectUpdates)
      .where(eq(projectUpdates.projectId, project))
      .orderBy(asc(projectUpdates.seq));

  test("a new project's first version is what the editor sent, and only its owner gets it", async () => {
    const hub = hubOf();
    const ada = await someone(database.db);
    const editor = new Editor();
    const id = newId();
    const peer = await hello(hub, ada, id, { create: editor });
    const digest = digestOf("", 1, editor.store.encodeState());
    expect(peer.of("welcome")).toEqual([
      { t: "welcome", head: 1, digest, reset: false, generation: 1 },
    ]);
    // What it sent does not come back.
    expect(peer.of("update")).toEqual([]);
    const [row] = await database.db.select().from(projects).where(eq(projects.id, id));
    expect(row).toMatchObject({ ownerId: ada.userId, projectId: editor.id, name: "测试", head: 1 });
    const updates = await rowsOf(id);
    expect(updates.map(({ seq, kind, device }) => ({ seq, kind, device }))).toEqual([
      { seq: 1, kind: "first", device: "d1" },
    ]);

    // Someone else does not even learn that it is there.
    const eve = await someone(database.db);
    const other = await hello(hub, eve, id);
    expect(other.closedWith?.code).toBe(SYNC_CLOSE.missing);
    expect(other.of("welcome")).toEqual([]);
    // Nor with the first version of their own.
    const taking = await hello(hub, eve, id, { create: new Editor() });
    expect(taking.closedWith?.code).toBe(SYNC_CLOSE.missing);
    expect((await rowsOf(id)).length).toBe(1);
  });

  test("keeps what a project says about itself, cut short, as it changes", async () => {
    const hub = hubOf();
    const ada = await someone(database.db);
    const editor = new Editor();
    editor.change({ type: "project.setDescription", params: { description: "一开始的说明" } });
    const id = newId();
    const peer = await hello(hub, ada, id, { create: editor });
    const described = async () =>
      (await database.db.select().from(projects).where(eq(projects.id, id)))[0]!.description;
    expect(await described()).toBe("一开始的说明");
    const long = "长".repeat(DESCRIPTION_MOST + 50);
    const change = editor.change({ type: "project.setDescription", params: { description: long } });
    expect(await answerTo(peer, push(peer, change))).toMatchObject({ t: "ack" });
    expect(await described()).toBe("长".repeat(DESCRIPTION_MOST));
    const gone = editor.change({ type: "project.setDescription", params: { description: "" } });
    expect(await answerTo(peer, push(peer, gone))).toMatchObject({ t: "ack" });
    expect(await described()).toBe("");
  });

  test("notes since when changes wait for GitHub, in the statement that takes them", async () => {
    let now = new Date("2026-11-10T08:00:00Z");
    const hub = new SyncHub({ db: database.db, log: quiet, now: () => now });
    const ada = await someone(database.db);
    const editor = new Editor();
    const id = newId();
    const peer = await hello(hub, ada, id, { create: editor });
    const dirty = async () =>
      (await database.db.select().from(projects).where(eq(projects.id, id)))[0]!.dirtySince;
    expect(await dirty()).toEqual(now);
    const first = now;
    now = new Date("2026-11-10T08:03:00Z");
    expect(await answerTo(peer, push(peer, editor.change(write("code/a.js", "a"))))).toMatchObject({
      t: "ack",
    });
    // The first change after an archive counts, not the latest.
    expect(await dirty()).toEqual(first);
    await database.db.update(projects).set({ dirtySince: null }).where(eq(projects.id, id));
    now = new Date("2026-11-10T08:09:00Z");
    expect(await answerTo(peer, push(peer, editor.change(write("code/a.js", "b"))))).toMatchObject({
      t: "ack",
    });
    expect(await dirty()).toEqual(now);
    const [row] = await database.db.select().from(projects).where(eq(projects.id, id));
    expect(row!.updatedAt).toEqual(now);
  });

  test("a change gets the next number, is kept with who made it, and goes to the others", async () => {
    const hub = hubOf();
    const ada = await someone(database.db);
    const editor = new Editor();
    const id = newId();
    const first = await hello(hub, ada, id, { create: editor });
    const second = await hello(hub, ada, id, { after: 1, device: "d2" });
    const change = editor.change(write("code/a.js", "a"));
    const sent = push(first, change, { kind: "folder", base: 1 });
    const answer = await answerTo(first, sent);
    expect(answer).toMatchObject({ t: "ack", id: sent, seq: 2 });
    // The digest stands for this update and the one before.
    const [, kept] = await rowsOf(id);
    expect(answer).toMatchObject({ digest: kept?.digest });
    expect(kept?.digest).toBe(
      digestOf(first.of("welcome")[0]?.digest ?? "", 2, kept?.data ?? change),
    );
    await second.until(() => second.of("update").length > 0, "the update");
    const [arrived] = second.of("update");
    expect(arrived).toMatchObject({ seq: 2, kind: "folder" });
    const elsewhere = new Editor(editor.store.encodeState());
    expect(elsewhere.store.getState().files["code/a.js"]).toBe("a");
    const [, row] = await rowsOf(id);
    expect(row).toMatchObject({ seq: 2, kind: "folder", device: "d1", window: "w1", base: 1 });
    // The same change again is no new one.
    const again = push(first, editor.updates.at(-1) as Uint8Array);
    expect(await answerTo(first, again)).toMatchObject({ t: "ack", id: again, seq: 2 });
    expect((await rowsOf(id)).length).toBe(2);
  });

  test("turns away what is no change of a project, and keeps the project as it was", async () => {
    const hub = hubOf();
    const ada = await someone(database.db);
    const editor = new Editor();
    const id = newId();
    const peer = await hello(hub, ada, id, { create: editor });
    const expectRejected = async (payload: Uint8Array, reason: string) => {
      const sent = push(peer, payload);
      expect(await answerTo(peer, sent)).toEqual({ t: "reject", id: sent, reason, retry: false });
    };
    await expectRejected(new Uint8Array([1, 2, 3, 250, 251]), "malformed");
    // Each from a window of its own: a change of the same window that comes after one the
    // platform turned away needs that one, and is turned away for that.
    const fresh = () => new Editor(editor.store.encodeState());
    await expectRejected(
      fresh().raw((doc) => doc.getMap("elsewhere").set("x", 1)),
      "foreign",
    );
    // Another project in place of this one.
    await expectRejected(
      fresh().raw((doc) => {
        const manifest = doc.getMap("project").get("manifest") as {
          set(key: string, value: unknown): void;
        };
        manifest.set("id", "someone-else");
      }),
      "identity",
    );
    // A change that needs one the platform never got.
    const skipped = fresh();
    skipped.change(write("code/one.js", "1"));
    const needsIt = skipped.change(write("code/one.js", "12"));
    await expectRejected(needsIt, "incomplete");
    // Keys and values the format does not have there, each on its own.
    const manifestOf = (doc: ProjectStore["doc"]) =>
      doc.getMap("project").get("manifest") as { set(key: string, value: unknown): void };
    await expectRejected(
      fresh().raw((doc) => manifestOf(doc).set("name", 123)),
      "invalid",
    );
    await expectRejected(
      fresh().raw((doc) => doc.getMap("project").set("elsewhere", 1)),
      "invalid",
    );
    await expectRejected(
      fresh().raw((doc) => manifestOf(doc).set("x".repeat(300), "long key")),
      "invalid",
    );

    // Nothing of it is in the project, and good changes still go.
    const check = await hello(hub, ada, id, { after: 0 });
    const replica = replicaOf(check);
    expect(replica.getState().manifest).toEqual(editor.store.getState().manifest);
    expect(replica.stateVector()).toEqual(editor.store.stateVector());
    expect(replica.getState().files["code/one.js"]).toBeUndefined();
    expect((await rowsOf(id)).length).toBe(1);
    const good = push(peer, editor.change(write("code/b.js", "b")));
    expect(await answerTo(peer, good)).toMatchObject({ t: "ack", seq: 2 });
  });

  test("closes a connection that does not speak the protocol", async () => {
    const hub = hubOf();
    const ada = await someone(database.db);
    const peer = await hello(hub, ada, newId(), { create: new Editor() });
    peer.sendBytes(new TextEncoder().encode("bad") as Uint8Array<ArrayBuffer>);
    await peer.until(() => peer.closedWith !== undefined, "a close");
    expect(peer.closedWith?.code).toBe(SYNC_CLOSE.protocol);
  });

  test("catches a window up from where it got, and from a snapshot once the updates are gone", async () => {
    const hub = hubOf({ compactUpdates: 5 });
    const ada = await someone(database.db);
    const editor = new Editor();
    const id = newId();
    const peer = await hello(hub, ada, id, { create: editor });
    for (let index = 0; index < 12; index++) {
      const sent = push(peer, editor.change(write("code/n.js", String(index))));
      await answerTo(peer, sent);
    }
    // Two snapshots by now: the updates before the first one are gone.
    const snapshots = await database.db
      .select({ seq: projectSnapshots.seq, reason: projectSnapshots.reason })
      .from(projectSnapshots)
      .where(eq(projectSnapshots.projectId, id));
    expect(snapshots.filter((snapshot) => snapshot.reason === "compact").length).toBe(2);
    const kept = await rowsOf(id);
    expect(kept[0]?.seq).toBeGreaterThan(1);

    const recent = await hello(hub, ada, id, { after: 12 });
    expect(recent.of("update").map((update) => update.seq)).toEqual([13]);
    const behind = await hello(hub, ada, id, { after: 1 });
    expect(behind.of("update").map((update) => [update.seq, update.kind])).toEqual([
      [13, "snapshot"],
    ]);
    expect(replicaOf(behind).getState().files["code/n.js"]).toBe("11");
    // A window that says it has more than the platform has gets all of it.
    const ahead = await hello(hub, ada, id, { after: 99 });
    expect(ahead.of("welcome")).toMatchObject([{ t: "welcome", head: 13, reset: true }]);
    expect(ahead.of("update").length).toBeGreaterThan(0);
    // So does one that has another update under a number, as after the platform came back from
    // a backup: also where only the snapshot is left of it.
    const [last] = (await rowsOf(id)).slice(-1);
    const right = await hello(hub, ada, id, { after: 13, digest: last?.digest ?? "" });
    expect(right.of("welcome")).toMatchObject([{ head: 13, reset: false }]);
    const other = await hello(hub, ada, id, { after: 13, digest: "another" });
    expect(other.of("welcome")).toMatchObject([{ head: 13, reset: true }]);
    const recentOther = await hello(hub, ada, id, { after: 12, digest: "another" });
    expect(recentOther.of("welcome")).toMatchObject([{ reset: true }]);
  });

  test("a restarted platform reads every project as it kept it", async () => {
    const ada = await someone(database.db);
    const editor = new Editor();
    const id = newId();
    const before = hubOf({ compactUpdates: 3 });
    const peer = await hello(before, ada, id, { create: editor });
    for (let index = 0; index < 7; index++) {
      await answerTo(peer, push(peer, editor.change(write(`code/f${index}.js`, "x"))));
    }
    before.stop();
    expect(peer.closedWith?.code ?? (await peer.connection.closed).code).toBe(
      SYNC_CLOSE.unavailable,
    );
    const after = hubOf();
    const again = await hello(after, ada, id, { after: 0 });
    expect(replicaOf(again).stateVector()).toEqual(editor.store.stateVector());
    again.send({ t: "check" });
    await again.until(() => again.of("checked").length > 0, "checked");
    const checked = unpackChecked(again.of("checked")[0]?.payload ?? new Uint8Array(0));
    expect(checked?.stateVector).toEqual(editor.store.stateVector());
    expect(checked?.deletions).toEqual(editor.store.deletions());
  });

  test("keeps the project as it was before changes made without the latest of another browser", async () => {
    let now = Date.now();
    const hub = new SyncHub({ db: database.db, log: quiet, now: () => new Date(now) });
    const ada = await someone(database.db);
    const editor = new Editor();
    const id = newId();
    const here = await hello(hub, ada, id, { create: editor });
    const away = new Editor(editor.store.encodeState());
    await answerTo(here, push(here, editor.change(write("code/here.js", "1")), { base: 1 }));
    const elsewhere = await hello(hub, ada, id, { after: 2, device: "d2" });
    // Made at update 1, while offline: update 2 of the other browser came in between.
    const sent = push(elsewhere, away.change(write("code/away.js", "2")), {
      base: 1,
      behind: true,
    });
    await answerTo(elsewhere, sent);
    const kept = await database.db
      .select({ seq: projectSnapshots.seq, device: projectSnapshots.device })
      .from(projectSnapshots)
      .where(and(eq(projectSnapshots.projectId, id), eq(projectSnapshots.reason, "before-merge")));
    expect(kept).toEqual([{ seq: 2, device: "d2" }]);
    // Once per connection, and once in a while for the project, whatever browsers say they are.
    await answerTo(
      elsewhere,
      push(elsewhere, away.change(write("code/away.js", "3")), { base: 1, behind: true }),
    );
    const third = new Editor(editor.store.encodeState());
    const another = await hello(hub, ada, id, { after: 3, device: "d3" });
    await answerTo(
      another,
      push(another, third.change(write("code/third.js", "3")), { base: 1, behind: true }),
    );
    const beforeMerge = () =>
      database.db
        .select({ seq: projectSnapshots.seq })
        .from(projectSnapshots)
        .where(
          and(eq(projectSnapshots.projectId, id), eq(projectSnapshots.reason, "before-merge")),
        );
    expect((await beforeMerge()).length).toBe(1);
    now += 11 * 60_000;
    const fourth = new Editor(editor.store.encodeState());
    const later = await hello(hub, ada, id, { after: 4, device: "d4" });
    await answerTo(
      later,
      push(later, fourth.change(write("code/fourth.js", "4")), { base: 1, behind: true }),
    );
    expect((await beforeMerge()).length).toBe(2);
  });

  test("signing out closes what the session opened", async () => {
    const hub = hubOf();
    const ada = await someone(database.db);
    const peer = await hello(hub, ada, newId(), { create: new Editor() });
    hub.closeSession(ada.session);
    await peer.until(() => peer.closedWith !== undefined, "a close");
    expect(peer.closedWith?.code).toBe(SYNC_CLOSE.signedOut);
  });

  test("an editor of another protocol is told to reload", async () => {
    const hub = hubOf();
    const ada = await someone(database.db);
    const peer = new TestPeer(hub, ada);
    peer.send({
      t: "hello",
      v: SYNC_PROTOCOL + 1,
      project: newId(),
      after: 0,
      device: "d1",
      window: "w1",
      editor: "test",
      payload: new Uint8Array(0),
    });
    await peer.until(() => peer.closedWith !== undefined, "a close");
    expect(peer.closedWith?.code).toBe(SYNC_CLOSE.outdated);
  });

  test("an editor older than the oldest one the platform syncs with is told to reload; a newer one and the code as it is are not", async () => {
    const hub = new SyncHub({ db: database.db, log: quiet, oldestEditor: "0.3.72" });
    const ada = await someone(database.db);
    const say = (editor: string) => {
      const made = new Editor();
      const peer = new TestPeer(hub, ada);
      peer.send({
        t: "hello",
        v: SYNC_PROTOCOL,
        project: newId(),
        after: 0,
        device: "d1",
        window: "w1",
        editor,
        create: { name: "测试", projectId: made.id },
        payload: made.store.encodeState(),
      });
      return peer;
    };
    for (const old of ["0.3.71", "0.2.99", "test"]) {
      const peer = say(old);
      await peer.until(() => peer.closedWith !== undefined, "a close");
      expect(peer.closedWith?.code, old).toBe(SYNC_CLOSE.outdated);
    }
    for (const fine of ["0.3.72", "0.4.0", "dev"]) {
      const peer = say(fine);
      await peer.until(
        () => peer.of("synced").length > 0 || peer.closedWith !== undefined,
        "synced",
      );
      expect(peer.closedWith, fine).toBeUndefined();
    }
  });

  /** The "welcome" that came. */
  const welcomeOf = (peer: TestPeer) => peer.of("welcome")[0];

  test("says which working copy a project is, and closes a window that has another one", async () => {
    const ada = await someone(database.db);
    const editor = new Editor();
    const id = newId();
    const first = hubOf();
    const made = await hello(first, ada, id, { create: editor, generation: 1 });
    expect(welcomeOf(made)).toMatchObject({ t: "welcome", head: 1, generation: 1 });
    // The same copy, or none said, as an editor from before copies were told apart, or one that
    // has nothing of the project yet: as ever.
    const same = await hello(first, ada, id, { after: 1, generation: 1 });
    expect(same.of("synced")).toHaveLength(1);
    const none = await hello(first, ada, id);
    expect(none.of("synced")).toHaveLength(1);
    expect(welcomeOf(none)).toMatchObject({ generation: 1 });
    expect(replicaOf(none).stateVector()).toEqual(editor.store.stateVector());
    first.stop();

    // The project was made again from its repository: its second working copy.
    await database.db.update(projects).set({ generation: 2 }).where(eq(projects.id, id));
    const hub = hubOf();
    const stale = await hello(hub, ada, id, { after: 1, generation: 1 });
    expect(stale.closedWith?.code).toBe(SYNC_CLOSE.rebuilt);
    // Nothing of the other copy went to it, not even how far that is.
    expect(stale.received).toEqual([]);
    const ahead = await hello(hub, ada, id, { generation: 3 });
    expect(ahead.closedWith?.code).toBe(SYNC_CLOSE.rebuilt);
    // One that says none gets the project, and hears which copy it is.
    const fresh = await hello(hub, ada, id);
    expect(fresh.closedWith).toBeUndefined();
    expect(welcomeOf(fresh)).toMatchObject({ head: 1, generation: 2 });
    expect(replicaOf(fresh).stateVector()).toEqual(editor.store.stateVector());
    const current = await hello(hub, ada, id, { after: 1, generation: 2 });
    expect(current.of("synced")).toHaveLength(1);
    // Someone else learns nothing, also not that there is another copy.
    const eve = await someone(database.db);
    expect((await hello(hub, eve, id, { generation: 1 })).closedWith?.code).toBe(
      SYNC_CLOSE.missing,
    );
    // What is no number of a copy is no message of the protocol.
    for (const wrong of ["2", -1, 1.5, null]) {
      const broken = await hello(hub, ada, id, { generation: wrong });
      expect(broken.closedWith?.code, String(wrong)).toBe(SYNC_CLOSE.protocol);
    }
    // A project that is not there is not made for a window that says it has a later copy of it.
    const lost = newId();
    const later = await hello(hub, ada, lost, { create: new Editor(), generation: 2 });
    expect(later.closedWith?.code).toBe(SYNC_CLOSE.rebuilt);
    expect(await database.db.select().from(projects).where(eq(projects.id, lost))).toEqual([]);
    // The number editors that are out there know it by.
    expect(SYNC_CLOSE.rebuilt).toBe(4409);
  });

  test("reads nothing of a project whose working copy is not here", async () => {
    const ada = await someone(database.db);
    const editor = new Editor();
    const id = newId();
    const before = hubOf();
    const peer = await hello(before, ada, id, { create: editor });
    await answerTo(peer, push(peer, editor.change(write("code/a.js", "a"))));
    before.stop();
    // Let go of, where nothing makes it again, or on its way back: come back later. (Made again
    // as a window asks for it: see archive/rebuild.test.ts.)
    for (const [state, code] of [
      ["released", SYNC_CLOSE.unavailable],
      ["restoring", SYNC_CLOSE.unavailable],
    ] as const) {
      await database.db.update(projects).set({ copyState: state }).where(eq(projects.id, id));
      const hub = hubOf();
      const owner = await hello(hub, ada, id, { after: 2 });
      expect(owner.closedWith?.code, state).toBe(code);
      expect(owner.received, state).toEqual([]);
      // Nor is another first version taken in its place.
      const again = await hello(hub, ada, id, { create: new Editor() });
      expect(again.closedWith?.code, state).toBe(code);
      // Someone else hears what they hear of any project that is not theirs.
      const eve = await someone(database.db);
      expect((await hello(hub, eve, id)).closedWith?.code, state).toBe(SYNC_CLOSE.missing);
      // The hub does not know the project, and no copy of it is in memory.
      await hub.idle();
      expect(hub.size, state).toEqual({ connections: 0, projects: 0, open: 0 });
      hub.stop();
    }
    expect((await rowsOf(id)).length).toBe(2);
    // Here again: as ever.
    await database.db.update(projects).set({ copyState: "live" }).where(eq(projects.id, id));
    const hub = hubOf();
    const back = await hello(hub, ada, id);
    expect(replicaOf(back).getState().files["code/a.js"]).toBe("a");
    hub.stop();
  });

  test("notes when a window last connected to a project, once an hour at most", async () => {
    let now = new Date("2026-11-11T08:00:00Z");
    const clock = () => now;
    const hub = new SyncHub({ db: database.db, log: quiet, now: clock });
    const ada = await someone(database.db);
    const id = newId();
    /** As the database has it, once the hub is done with what the window asked. */
    const openedAt = async (from: SyncHub) => {
      await from.idle();
      return (await database.db.select().from(projects).where(eq(projects.id, id)))[0]!.openedAt;
    };
    await hello(hub, ada, id, { create: new Editor() });
    const first = now;
    expect(await openedAt(hub)).toEqual(first);
    // Within the hour: not written again, however many windows connect.
    now = new Date("2026-11-11T08:59:00Z");
    await hello(hub, ada, id, { after: 1 });
    await hello(hub, ada, id, { after: 1, device: "d2" });
    expect(await openedAt(hub)).toEqual(first);
    now = new Date("2026-11-11T09:00:00Z");
    await hello(hub, ada, id, { after: 1 });
    const second = now;
    expect(await openedAt(hub)).toEqual(second);
    // A platform that started again goes by what the database has.
    hub.stop();
    const restarted = new SyncHub({ db: database.db, log: quiet, now: clock });
    now = new Date("2026-11-11T09:30:00Z");
    await hello(restarted, ada, id, { after: 1 });
    expect(await openedAt(restarted)).toEqual(second);
    now = new Date("2026-11-11T10:00:01Z");
    await hello(restarted, ada, id, { after: 1 });
    expect(await openedAt(restarted)).toEqual(now);
    // Opening it is no change of it.
    const [row] = await database.db.select().from(projects).where(eq(projects.id, id));
    expect(row!.updatedAt).toEqual(first);
    restarted.stop();
  });

  test("takes a change that says where the project has to be only there, and turns the rest away", async () => {
    const hub = hubOf();
    const ada = await someone(database.db);
    const editor = new Editor();
    const id = newId();
    const peer = await hello(hub, ada, id, { create: editor });
    const expecting = (change: Uint8Array, expected: { generation: number; seq: number }) => {
      const pushId = ++pushes;
      peer.send({
        t: "push",
        id: pushId,
        kind: "user",
        base: expected.seq,
        at: Date.now(),
        window: "w1",
        behind: false,
        expect: expected,
        payload: change,
      });
      return answerTo(peer, pushId);
    };
    const first = editor.change(write("code/a.js", "one"));
    expect(await expecting(first, { generation: 1, seq: 1 })).toMatchObject({ t: "ack", seq: 2 });
    // The project is at 2 now: one made against 1 is turned away, and can never go as it is.
    const late = editor.change(write("code/a.js", "two"));
    expect(await expecting(late, { generation: 1, seq: 1 })).toEqual({
      t: "reject",
      id: pushes,
      reason: "moved",
      retry: false,
    });
    // As is one that says another copy.
    expect(await expecting(late, { generation: 2, seq: 2 })).toMatchObject({ reason: "moved" });
    expect((await rowsOf(id)).map(({ seq }) => seq)).toEqual([1, 2]);
    expect(await expecting(late, { generation: 1, seq: 2 })).toMatchObject({ t: "ack", seq: 3 });
    expect(peer.closedWith).toBeUndefined();
  });

  test("of two windows that send a change made against the same update, takes the first only", async () => {
    const hub = hubOf();
    const ada = await someone(database.db);
    const editor = new Editor();
    const id = newId();
    await hello(hub, ada, id, { create: editor });
    const state = editor.store.encodeState();
    // Two computers, each with the same change made against the project at 1.
    const a = new Editor(state);
    const b = new Editor(state);
    const peers = [
      await hello(hub, ada, id, { after: 1, digest: digestOf("", 1, state), device: "a" }),
      await hello(hub, ada, id, { after: 1, digest: digestOf("", 1, state), device: "b" }),
    ];
    const changes = [a.change(write("code/x.js", "late")), b.change(write("code/x.js", "late"))];
    const ids = peers.map((peer, index) => {
      const pushId = ++pushes;
      peer.send({
        t: "push",
        id: pushId,
        kind: "other",
        base: 1,
        at: Date.now(),
        window: "w1",
        behind: false,
        expect: { generation: 1, seq: 1 },
        payload: changes[index] as Uint8Array,
      });
      return pushId;
    });
    const answers = await Promise.all(
      peers.map((peer, index) => answerTo(peer, ids[index] as number)),
    );
    expect(answers.map((answer) => answer?.t).toSorted()).toEqual(["ack", "reject"]);
    expect(answers.find((answer) => answer?.t === "reject")).toMatchObject({ reason: "moved" });
    // Once in the project, which a third window sees.
    expect((await rowsOf(id)).map(({ seq }) => seq)).toEqual([1, 2]);
    const third = await hello(hub, ada, id);
    expect(replicaOf(third).getState().files["code/x.js"]).toBe("late");
  });

  test("notes a project opened until its window goes, and while one stays", async () => {
    let now = new Date("2026-11-11T08:00:00Z");
    const hub = new SyncHub({ db: database.db, log: quiet, now: () => now });
    const ada = await someone(database.db);
    const id = newId();
    const openedAt = async () => {
      await hub.idle();
      return (await database.db.select().from(projects).where(eq(projects.id, id)))[0]!.openedAt;
    };
    const peer = await hello(hub, ada, id, { create: new Editor() });
    expect(await openedAt()).toEqual(now);
    // Days on, the window is still there: the sweep notes it before it looks.
    now = new Date("2026-11-14T08:00:00Z");
    await hub.noteConnected();
    expect(await openedAt()).toEqual(now);
    // A window that only reads is not one that opened it.
    const reader = new TestPeer(hub, ada);
    reader.send({
      t: "hello",
      v: SYNC_PROTOCOL,
      project: id,
      after: 0,
      device: "r",
      window: "r",
      editor: "test",
      readOnly: true,
      payload: new Uint8Array(0),
    });
    await reader.until(() => reader.of("synced").length > 0, "synced");
    peer.connection.close(1000, "");
    // Noted as it went, which is within the hour of the last note: nothing new.
    await expect.poll(openedAt).toEqual(now);
    now = new Date("2026-11-16T08:00:00Z");
    await hub.noteConnected();
    expect(await openedAt()).toEqual(new Date("2026-11-14T08:00:00Z"));
    // The window that edits goes days after it last was noted: noted as it goes.
    const again = await hello(hub, ada, id, { after: 1 });
    expect(await openedAt()).toEqual(now);
    now = new Date("2026-11-19T08:00:00Z");
    again.connection.close(1000, "");
    await expect.poll(openedAt).toEqual(now);
    hub.stop();
  });
});
