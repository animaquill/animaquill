import { ProjectStore, USER, folderBatch, type CommandCall } from "@animaquill/core";
import { SYNC_LIMITS, framesOf, type CloudLink } from "@animaquill/host";
import { afterEach, describe, expect, it } from "vitest";
import { loadFixture } from "../../../schema/scripts/fixture.ts";
import { MemoryLibrary, memoryAddress } from "../workbench/memory-library.ts";
import { ProjectSession, type SessionMessages } from "../workbench/session.ts";
import { MemoryPlatform, TestCloudBrowser, TestTime } from "./cloud-support.ts";
import { CloudSession, type CloudTiming } from "./session.ts";

const MESSAGES: SessionMessages = {
  createFailed() {},
  notFound() {},
  openFailed() {},
  tooNew() {},
  damaged() {},
  saveFailed() {},
  saveRecovered() {},
};

const PLATFORM = "https://platform.test";
const CLOUD_ID = "p1";
const TIMING: Partial<CloudTiming> = { scanMs: 5, noteMs: 50 };

function fixtureState(): { id: string; state: Uint8Array } {
  const files = loadFixture("v1");
  const manifest = JSON.parse(files.get("animaquill.json") as string);
  delete manifest.tags;
  files.set("animaquill.json", JSON.stringify(manifest));
  const { store } = ProjectStore.open(files);
  if (!store) throw new Error("fixture did not open");
  const id = store.getState().manifest.id;
  const state = store.encodeState();
  store.destroy();
  return { id, state };
}

/** A browser that syncs: its log of projects, what it keeps about syncing, and its windows. */
class Browser extends TestCloudBrowser {
  readonly library = new MemoryLibrary();
  readonly windows: Window[] = [];
  #pages = 0;

  /** A project of this browser, with a link to the platform that says nothing went yet. */
  async project(id: string, state: Uint8Array, link: Partial<CloudLink> = {}): Promise<void> {
    await this.library.create({ id, name: "原子" }, state);
    const entries = await (await this.library.open(id)).entries?.();
    await this.links.put({
      key: id,
      platform: PLATFORM,
      project: CLOUD_ID,
      seq: 0,
      pushed: entries?.at(-1)?.mark ?? 0,
      linkedAt: 1,
      ...link,
    });
  }

  /** The project as the platform has it now, as "open from the platform" brings it here. */
  async fromPlatform(id: string): Promise<void> {
    const project = this.platform.projects.get(CLOUD_ID);
    if (!project) throw new Error("not on the platform");
    await this.project(id, this.platform.workingCopy(CLOUD_ID).encodeState(), {
      seq: project.head,
    });
  }

  async open(
    id: string,
    time: TestTime,
    options: { readonly create?: boolean; readonly timing?: Partial<CloudTiming> } = {},
  ): Promise<Window> {
    const name = `w${++this.#pages}`;
    const page = { isAlive: () => !window.gone, asleep: false };
    const session = new ProjectSession(this.library, memoryAddress(), MESSAGES, { window: name });
    if (!(await session.open(id))) throw new Error("did not open");
    const store = session.store as ProjectStore;
    let link = await this.links.get(id);
    if (!link) throw new Error("no link");
    if (options.create && !link.creating) {
      // As connecting leaves it: the project is not on the platform yet, as far as the link knows.
      link = { ...link, creating: true };
      await this.links.put(link);
    }
    const cloud = new CloudSession({
      store,
      journal: session.journal,
      cloud: this.access(page),
      link,
      window: name,
      editor: "test",
      environment: time,
      timing: { ...TIMING, ...options.timing },
      onSeq: (seq) => {
        session.cloudSeq = seq;
      },
      ...(options.create && {
        create: { name: "原子", projectId: store.getState().manifest.id },
      }),
    });
    const window = { session, store, cloud, page, gone: false };
    this.windows.push(window);
    cloud.start();
    return window;
  }
}

interface Window {
  readonly session: ProjectSession;
  readonly store: ProjectStore;
  readonly cloud: CloudSession;
  readonly page: { isAlive: () => boolean; asleep: boolean };
  gone: boolean;
}

const rename = (name: string): CommandCall => ({
  type: "project.rename",
  params: { name },
});

const writeFile = (path: string, text: string): CommandCall => ({
  type: "file.write",
  params: { path, text },
});

const textOf = (store: ProjectStore, path: string) => store.getState().files[path];

const opened: Window[] = [];
afterEach(async () => {
  for (const window of opened.splice(0)) {
    await window.cloud.close();
    await window.session.close();
  }
});

async function start(time: TestTime) {
  const platform = new MemoryPlatform();
  const { id, state } = fixtureState();
  const first = new Browser(platform, "ada");
  await first.project(id, state);
  const a = await first.open(id, time, { create: true });
  opened.push(a);
  await time.advance(100);
  return { platform, id, first, a };
}

describe("CloudSession", () => {
  it("makes the project the first version on the platform, and is online", async () => {
    const time = new TestTime();
    const { platform, id, first, a } = await start(time);
    expect(a.cloud.getSnapshot()).toMatchObject({ state: "online", here: true, seq: 1 });
    const project = platform.projects.get(CLOUD_ID);
    expect(project?.head).toBe(1);
    expect(project?.updates[0]?.kind).toBe("first");
    // The first version came from here: nothing of it comes back.
    expect(platform.workingCopy(CLOUD_ID).getState().manifest.id).toBe(id);
    await time.advance(200);
    expect((await first.links.get(id))?.seq).toBe(1);
  });

  it("sends changes as they happen, with who made them, and the other browser gets them", async () => {
    const time = new TestTime();
    const { platform, id, a } = await start(time);
    const second = new Browser(platform, "ada");
    await second.fromPlatform(id);
    const b = await second.open(id, time);
    opened.push(b);
    await time.advance(100);
    expect(b.cloud.getSnapshot().state).toBe("online");

    expect(a.store.execute(writeFile("code/a.js", "a1")).ok).toBe(true);
    // As a batch of files from the folder.
    expect(a.store.execute(writeFile("code/b.js", "b1"), { origin: folderBatch("1") }).ok).toBe(
      true,
    );
    await time.advance(100);

    expect(textOf(b.store, "code/a.js")).toBe("a1");
    expect(textOf(b.store, "code/b.js")).toBe("b1");
    const kinds = platform.projects.get(CLOUD_ID)?.updates.map((update) => update.kind);
    expect(kinds).toContain("user");
    expect(kinds).toContain("folder");
    expect(a.cloud.getSnapshot().pending).toBe(0);
    // The other way too.
    expect(b.store.execute(rename("改过的名字")).ok).toBe(true);
    await time.advance(100);
    expect(a.store.getState().manifest.name).toBe("改过的名字");
  });

  it("keeps changes while the connection is gone, and sends them once it is back", async () => {
    const time = new TestTime();
    const { platform, a } = await start(time);
    platform.drop();
    await time.advance(10);
    expect(a.cloud.getSnapshot().state).toBe("reconnecting");
    // The platform is away for a while.
    platform.faults.silent = true;
    expect(a.store.execute(writeFile("code/offline.js", "x")).ok).toBe(true);
    await time.advance(3000);
    expect(a.cloud.getSnapshot().pending).toBeGreaterThan(0);
    expect(platform.workingCopy(CLOUD_ID).getState().files["code/offline.js"]).toBeUndefined();
    platform.faults.silent = false;
    platform.drop();
    await time.advance(60_000);
    expect(a.cloud.getSnapshot()).toMatchObject({ state: "online", pending: 0 });
    expect(platform.workingCopy(CLOUD_ID).getState().files["code/offline.js"]).toBe("x");
  });

  it("waits while the browser is offline, and goes right away once it is back", async () => {
    const time = new TestTime();
    const { platform, a } = await start(time);
    time.goOffline();
    await time.advance(10);
    expect(a.cloud.getSnapshot().state).toBe("offline");
    a.store.execute(writeFile("code/later.js", "y"));
    await time.advance(5000);
    expect(platform.workingCopy(CLOUD_ID).getState().files["code/later.js"]).toBeUndefined();
    time.online = true;
    time.wake();
    await time.advance(100);
    expect(a.cloud.getSnapshot().state).toBe("online");
    expect(platform.workingCopy(CLOUD_ID).getState().files["code/later.js"]).toBe("y");
  });

  it("takes a connection that stopped answering for dead, and connects again", async () => {
    const time = new TestTime();
    const { platform, a } = await start(time);
    const before = platform.connections;
    platform.faults.silent = true;
    await time.advance(30_000);
    expect(a.cloud.getSnapshot().state).not.toBe("online");
    platform.faults.silent = false;
    await time.advance(60_000);
    expect(platform.connections).toBeGreaterThan(before);
    expect(a.cloud.getSnapshot().state).toBe("online");
  });

  it("tries a change the platform could not take now again later, and loses nothing", async () => {
    const time = new TestTime();
    const { platform, a } = await start(time);
    platform.faults.rejections.push({ reason: "busy", retry: true });
    a.store.execute(writeFile("code/busy.js", "z"));
    await time.advance(100);
    expect(a.cloud.getSnapshot().state).toBe("reconnecting");
    await time.advance(10_000);
    expect(a.cloud.getSnapshot().state).toBe("online");
    expect(platform.workingCopy(CLOUD_ID).getState().files["code/busy.js"]).toBe("z");
  });

  it("stops at a change the platform will never take, and goes on with everything here", async () => {
    const time = new TestTime();
    const { platform, a } = await start(time);
    platform.faults.rejections.push({ reason: "too-large", retry: false });
    a.store.execute(writeFile("code/big.js", "big"));
    await time.advance(100);
    expect(a.cloud.getSnapshot()).toMatchObject({
      state: "paused",
      problem: { kind: "rejected", reason: "too-large" },
    });
    // Nothing here is stuck: changes go on, into the log.
    expect(a.store.execute(writeFile("code/more.js", "more")).ok).toBe(true);
    expect(await a.session.trySave()).toBe(true);
    // Once people try again, and the platform takes it, all of it goes.
    a.cloud.resume();
    await time.advance(1000);
    expect(a.cloud.getSnapshot().state).toBe("online");
    const files = platform.workingCopy(CLOUD_ID).getState().files;
    expect(files["code/big.js"]).toBe("big");
    expect(files["code/more.js"]).toBe("more");
  });

  it("gets what it missed after a restart of the platform, and sends what the platform lost", async () => {
    const time = new TestTime();
    const { platform, id, a } = await start(time);
    const second = new Browser(platform, "ada");
    await second.fromPlatform(id);
    const b = await second.open(id, time);
    opened.push(b);
    await time.advance(100);
    platform.restart();
    b.store.execute(writeFile("code/b.js", "from b"));
    a.store.execute(writeFile("code/a.js", "from a"));
    await time.advance(60_000);
    for (const window of [a, b]) {
      expect(window.cloud.getSnapshot().state).toBe("online");
      expect(textOf(window.store, "code/a.js")).toBe("from a");
      expect(textOf(window.store, "code/b.js")).toBe("from b");
    }
  });

  it("puts back on the platform what it forgot, as from a backup that is older", async () => {
    const time = new TestTime();
    const { platform, a } = await start(time);
    a.store.execute(writeFile("code/kept.js", "1"));
    await time.advance(100);
    const project = platform.projects.get(CLOUD_ID);
    if (!project) throw new Error("no project");
    expect(project.head).toBe(2);
    // The platform comes back from a backup made before that change.
    project.updates = project.updates.filter((update) => update.seq === 1);
    project.head = 1;
    platform.restart();
    await time.advance(60_000);
    expect(a.cloud.getSnapshot().state).toBe("online");
    expect(platform.workingCopy(CLOUD_ID).getState().files["code/kept.js"]).toBe("1");
  });

  it("sends first what a change needs that the platform lost, and then the change", async () => {
    const time = new TestTime();
    const { platform, a } = await start(time);
    a.store.execute(writeFile("code/one.js", "1"));
    await time.advance(100);
    const project = platform.projects.get(CLOUD_ID);
    if (!project) throw new Error("no project");
    // The platform comes back from a backup made before that change...
    project.updates = project.updates.filter((update) => update.seq === 1);
    project.head = 1;
    platform.restart();
    // ...and the next change needs the one it lost.
    a.store.execute(writeFile("code/one.js", "12"));
    await time.advance(60_000);
    expect(a.cloud.getSnapshot()).toMatchObject({ state: "online", pending: 0 });
    expect(platform.workingCopy(CLOUD_ID).getState().files["code/one.js"]).toBe("12");
  });

  it("stops where another window disconnected the project", async () => {
    const time = new TestTime();
    const { id, first, a } = await start(time);
    await first.links.remove(id);
    a.store.execute(writeFile("code/after.js", "x"));
    await time.advance(2000);
    expect(a.cloud.getSnapshot()).toMatchObject({ state: "paused", problem: { kind: "unlinked" } });
  });

  it("lets one window of a browser sync, and the others show what it says", async () => {
    const time = new TestTime();
    const { platform, id, first, a } = await start(time);
    const other = await first.open(id, time);
    opened.push(other);
    await time.advance(100);
    expect(other.cloud.getSnapshot()).toMatchObject({ here: false, state: "online" });
    const connections = platform.connections;
    other.store.execute(writeFile("code/other.js", "o"));
    await time.advance(100);
    // It went through the log and the window that syncs.
    expect(platform.connections).toBe(connections);
    expect(platform.workingCopy(CLOUD_ID).getState().files["code/other.js"]).toBe("o");
    // That window goes: the other one takes over.
    a.page.isAlive = () => false;
    a.gone = true;
    await a.cloud.close();
    first.writers.sweep();
    await time.advance(200);
    expect(other.cloud.getSnapshot()).toMatchObject({ here: true, state: "online" });
    other.store.execute(writeFile("code/later.js", "l"));
    await time.advance(100);
    expect(platform.workingCopy(CLOUD_ID).getState().files["code/later.js"]).toBe("l");
  });

  it("gets what a log that lost an entry lacks from the window that syncs, and only that", async () => {
    const time = new TestTime();
    const { platform, id, first, a } = await start(time);
    a.store.execute(writeFile("code/kept.js", "k"));
    a.store.execute(writeFile("code/lost.js", "lost"));
    await time.advance(500);
    expect(await a.session.trySave()).toBe(true);
    // The entry of the second change cannot be read any more.
    const updates = first.library.updates.get(id) as Uint8Array[];
    const lost = updates.findLastIndex((update) => update.length > 0);
    updates[lost] = new Uint8Array([0, 7, 7, 7, 255, 255]);
    const before = updates.length;
    const other = await first.open(id, time);
    opened.push(other);
    expect(textOf(other.store, "code/lost.js")).toBeUndefined();
    await time.advance(500);
    // The window that syncs put into the log what the other one lacks, and the other one has it.
    expect(textOf(other.store, "code/lost.js")).toBe("lost");
    const added = (first.library.updates.get(id) as Uint8Array[]).slice(before);
    expect(added).toHaveLength(1);
    expect((added[0] as Uint8Array).length).toBeLessThan(a.store.encodeWhole().length / 4);
    expect(platform.workingCopy(CLOUD_ID).getState().files["code/lost.js"]).toBe("lost");
  });

  it("does not note down how far it got before the log has it", async () => {
    const time = new TestTime();
    const { platform, id, a } = await start(time);
    const second = new Browser(platform, "ada");
    await second.fromPlatform(id);
    const b = await second.open(id, time);
    opened.push(b);
    await time.advance(200);
    expect((await second.links.get(id))?.seq).toBe(1);
    // The log of the second browser cannot be written for now.
    second.library.failing = true;
    a.store.execute(writeFile("code/a.js", "a"));
    await time.advance(500);
    expect(textOf(b.store, "code/a.js")).toBe("a");
    expect((await second.links.get(id))?.seq).toBe(1);
    second.library.failing = false;
    expect(await b.session.trySave()).toBe(true);
    await time.advance(500);
    expect((await second.links.get(id))?.seq).toBe(2);
  });
});

const removeFile = (path: string): CommandCall => ({ type: "file.remove", params: { path } });

describe("CloudSession, with a log that cannot be written", () => {
  it("sends nothing the log does not have, so that a crash cannot send it twice", async () => {
    const time = new TestTime();
    const { platform, id, first, a } = await start(time);
    a.store.execute(writeFile("code/x.js", "ab"));
    await time.advance(500);
    expect(platform.workingCopy(CLOUD_ID).getState().files["code/x.js"]).toBe("ab");
    // The folder changed, and the log cannot keep it: the platform does not get it from memory,
    // not even when the two compare.
    first.library.failing = true;
    a.store.execute(writeFile("code/x.js", "aXb"), { origin: folderBatch("1") });
    platform.drop();
    await time.advance(30_000);
    expect(platform.workingCopy(CLOUD_ID).getState().files["code/x.js"]).toBe("ab");
    // The page crashes; the folder still has the change, and the next window takes it in again.
    await a.cloud.close();
    await a.session.close();
    opened.splice(0);
    first.library.failing = false;
    const again = await first.open(id, time);
    opened.push(again);
    expect(textOf(again.store, "code/x.js")).toBe("ab");
    again.store.execute(writeFile("code/x.js", "aXb"), { origin: folderBatch("2") });
    await time.advance(30_000);
    expect(again.cloud.getSnapshot()).toMatchObject({ state: "online", pending: 0 });
    expect(platform.workingCopy(CLOUD_ID).getState().files["code/x.js"]).toBe("aXb");
    expect(textOf(again.store, "code/x.js")).toBe("aXb");
  });
});

describe("CloudSession, when the platform came back from a backup", () => {
  it("puts back a deletion that the platform lost, and starts its link over (R1)", async () => {
    const time = new TestTime();
    const { platform, id, first, a } = await start(time);
    a.store.execute(writeFile("code/x.js", "x"));
    await time.advance(200);
    a.store.execute(removeFile("code/x.js"));
    await time.advance(200);
    expect(platform.projects.get(CLOUD_ID)?.head).toBe(3);
    // The platform comes back from a backup made before the deletion.
    platform.restoreTo(CLOUD_ID, 2);
    await time.advance(60_000);
    expect(a.cloud.getSnapshot()).toMatchObject({ state: "online", pending: 0 });
    expect(platform.workingCopy(CLOUD_ID).getState().files["code/x.js"]).toBeUndefined();
    const project = platform.projects.get(CLOUD_ID);
    const link = await first.links.get(id);
    // Written back as the platform is now, not the larger number from before.
    expect({ seq: link?.seq, digest: link?.digest }).toEqual({
      seq: project?.head,
      digest: project?.digest,
    });
    // A browser that opens it from the platform has no file either.
    const second = new Browser(platform, "ada");
    await second.fromPlatform(id);
    const b = await second.open(id, time);
    opened.push(b);
    await time.advance(1000);
    expect(textOf(b.store, "code/x.js")).toBeUndefined();
  });

  it("gets what another browser did after the backup, under a number it had for something else (R1b)", async () => {
    const time = new TestTime();
    const { platform, id, first, a } = await start(time);
    const second = new Browser(platform, "ada");
    await second.fromPlatform(id);
    let b = await second.open(id, time);
    await time.advance(200);
    a.store.execute(writeFile("code/y.js", "y"));
    await time.advance(300);
    expect(textOf(b.store, "code/y.js")).toBe("y");
    await b.cloud.close();
    await b.session.close();
    a.store.execute(writeFile("code/z.js", "z"));
    await time.advance(300);
    await a.cloud.close();
    await a.session.close();
    opened.splice(0);
    expect(platform.projects.get(CLOUD_ID)?.head).toBe(3);
    // Back from a backup without z.js: the next update gets number 3 again.
    platform.restoreTo(CLOUD_ID, 2);
    b = await second.open(id, time);
    opened.push(b);
    await time.advance(500);
    b.store.execute(removeFile("code/y.js"));
    await time.advance(500);
    expect(platform.projects.get(CLOUD_ID)?.head).toBe(3);
    // a comes back saying it has 3: its 3 is another one.
    const a2 = await first.open(id, time);
    opened.push(a2);
    await time.advance(60_000);
    expect(a2.cloud.getSnapshot()).toMatchObject({ state: "online", pending: 0 });
    expect(textOf(a2.store, "code/y.js")).toBeUndefined();
    expect(platform.workingCopy(CLOUD_ID).getState().files["code/z.js"]).toBe("z");
    expect(textOf(b.store, "code/z.js")).toBe("z");
    a2.store.execute(writeFile("code/y.js", "edited on a"));
    await time.advance(2000);
    expect(textOf(b.store, "code/y.js")).toBe("edited on a");
  });
});

describe("CloudSession, with what syncing cannot take as it is", () => {
  it("sends a change larger than one frame in parts (R2)", async () => {
    const time = new TestTime();
    const { platform, a } = await start(time);
    const big = "a".repeat(3 * 1024 * 1024);
    a.store.execute(writeFile("code/big.js", big));
    a.store.execute(writeFile("code/small.js", "s"));
    await time.advance(2000);
    expect(a.cloud.getSnapshot()).toMatchObject({ state: "online", pending: 0 });
    const files = platform.workingCopy(CLOUD_ID).getState().files;
    expect(files["code/big.js"]?.length).toBe(big.length);
    expect(files["code/small.js"]).toBe("s");
  });

  it("gets a large change and a large first version through a slow line, in parts", async () => {
    const time = new TestTime();
    const platform = new MemoryPlatform();
    // A little more than 30 KB a second, both ways: a frame takes about eight seconds.
    platform.faults.line = { time, bytesPerSecond: 32 * 1024 };
    const { id, state } = fixtureState();
    const first = new Browser(platform, "ada");
    await first.project(id, state);
    const a = await first.open(id, time, { create: true });
    opened.push(a);
    a.store.execute(writeFile("code/first.js", "f".repeat(1024 * 1024)));
    await time.advance(120_000);
    expect(a.cloud.getSnapshot()).toMatchObject({ state: "online", pending: 0 });
    a.store.execute(writeFile("code/big.js", "b".repeat(2 * 1024 * 1024)));
    for (let second = 0; second < 300; second += 10) await time.advance(10_000);
    expect(a.cloud.getSnapshot()).toMatchObject({ state: "online", pending: 0 });
    expect(platform.workingCopy(CLOUD_ID).getState().files["code/big.js"]?.length).toBe(
      2 * 1024 * 1024,
    );
    // One connection did all of it: nothing was taken for dead on the way.
    expect(platform.connections).toBe(1);
    // Another browser gets it all through the same line.
    const second = new Browser(platform, "ada");
    await second.project(id, state);
    const b = await second.open(id, time);
    opened.push(b);
    for (let step = 0; step < 300; step += 10) await time.advance(10_000);
    expect(b.cloud.getSnapshot()).toMatchObject({ state: "online", pending: 0 });
    expect(textOf(b.store, "code/big.js")?.length).toBe(2 * 1024 * 1024);
    expect(platform.connections).toBe(2);
  });

  it("stops at a change larger than the platform takes, and goes on from the project as it is, once that is fixed", async () => {
    const time = new TestTime();
    const { platform, a } = await start(time);
    // A folder brings three large files at once: each one fits, together they are more than a
    // platform takes in one change.
    const large = 6 * 1024 * 1024;
    const merged = a.store.mergeFiles(
      ["a", "b", "c"].map((name) => ({
        path: `code/${name}.js`,
        base: undefined,
        text: name.repeat(large),
      })),
      { origin: folderBatch("1"), baseOf: () => undefined },
    );
    expect(merged.ok).toBe(true);
    await time.advance(2000);
    expect(a.cloud.getSnapshot()).toMatchObject({
      state: "paused",
      problem: { kind: "rejected", reason: "too-large" },
    });
    // Everything here goes on.
    expect(a.store.execute(writeFile("code/after.js", "a")).ok).toBe(true);
    expect(await a.session.trySave()).toBe(true);
    // People take one of the files away, and sync again from the project as it is: what was taken
    // away does not go.
    expect(a.store.execute(removeFile("code/c.js")).ok).toBe(true);
    await a.cloud.resyncFromHere();
    await time.advance(5000);
    expect(a.cloud.getSnapshot()).toMatchObject({ state: "online", pending: 0 });
    const files = platform.workingCopy(CLOUD_ID).getState().files;
    expect(files["code/a.js"]?.length).toBe(large);
    expect(files["code/b.js"]?.length).toBe(large);
    expect(files["code/c.js"]).toBeUndefined();
    expect(files["code/after.js"]).toBe("a");
    // And on from there, as ever.
    a.store.execute(writeFile("code/later.js", "l"));
    await time.advance(2000);
    expect(platform.workingCopy(CLOUD_ID).getState().files["code/later.js"]).toBe("l");
  });

  it("stops at what the platform sends that is larger than it takes, rather than asking again and again", async () => {
    const time = new TestTime();
    const { platform, a } = await start(time);
    platform.drop();
    // A message in more parts than a whole project can have.
    platform.faults.first = framesOf(
      {
        t: "update",
        seq: 9,
        digest: "x",
        kind: "snapshot",
        at: 0,
        payload: new Uint8Array(2 * SYNC_LIMITS.state),
      },
      SYNC_LIMITS.part,
    ).slice(0, 1);
    const before = platform.connections;
    await time.advance(120_000);
    expect(a.cloud.getSnapshot()).toMatchObject({
      state: "paused",
      problem: { kind: "rejected", reason: "too-large" },
    });
    expect(platform.connections - before).toBe(1);
  });

  it("goes on without a change of the log that waits for one that is gone (R3)", async () => {
    const time = new TestTime();
    const { platform, id, first, a } = await start(time);
    await a.cloud.close();
    await a.session.close();
    opened.splice(0);
    // Two changes of one window, of which the log only has the second, as after a damaged entry.
    const other = ProjectStore.fromUpdates([platform.workingCopy(CLOUD_ID).encodeState()])
      .store as ProjectStore;
    const made: Uint8Array[] = [];
    other.onLocalUpdate((update) => made.push(update));
    other.execute(writeFile("code/lost.js", "1"));
    other.execute(writeFile("code/lost.js", "12"));
    const log = await first.library.open(id);
    await log.append(made[1] as Uint8Array, "原子", { kind: "user", window: "old", at: 1 });
    log.close();
    const again = await first.open(id, time);
    opened.push(again);
    expect(again.store.isMissingUpdates).toBe(true);
    expect(again.store.execute(writeFile("code/early.js", "e")).ok).toBe(true);
    await time.advance(60_000);
    expect(again.cloud.getSnapshot()).toMatchObject({ state: "online", pending: 0 });
    expect(again.store.execute(writeFile("code/later.js", "l")).ok).toBe(true);
    await time.advance(2000);
    const files = platform.workingCopy(CLOUD_ID).getState().files;
    expect(files["code/early.js"]).toBe("e");
    expect(files["code/later.js"]).toBe("l");
    expect(files["code/lost.js"]).toBeUndefined();
    expect(platform.rejected).not.toContain("incomplete");
  });
});

describe("the sources the log keeps", () => {
  it("says who made each change, and which update of the platform it was made on", async () => {
    const library = new MemoryLibrary();
    const { id, state } = fixtureState();
    await library.create({ id, name: "原子" }, state);
    const session = new ProjectSession(library, memoryAddress(), MESSAGES, { window: "w1" });
    await session.open(id);
    const store = session.store as ProjectStore;
    session.cloudSeq = 7;
    store.execute(writeFile("code/u.js", "u"), { origin: USER });
    await session.trySave();
    store.applyCloud([], 8);
    const log = await library.open(id);
    const entries = (await log.entries?.()) ?? [];
    expect(entries.at(-1)?.source).toMatchObject({ kind: "user", window: "w1", seq: 7 });
    await session.close();
  });
});

describe("what a link says about a project while nobody syncs it", () => {
  it("notes how many changes wait for the platform, as they come and as they go", async () => {
    const time = new TestTime();
    const { platform, id, first, a } = await start(time);
    await time.advance(200);
    expect((await first.links.get(id))?.pending ?? 0).toBe(0);

    // Without the platform people work on: what waits is noted while they do, not only when the
    // window closes in an orderly way, which a closing tab does not.
    platform.faults.silent = true;
    platform.drop();
    expect(a.store.execute(writeFile("code/one.js", "1")).ok).toBe(true);
    await time.advance(500);
    expect(a.store.execute(writeFile("code/two.js", "2")).ok).toBe(true);
    await time.advance(500);
    expect((await first.links.get(id))?.pending).toBe(2);

    // Back online they go, and the link says that nothing waits.
    platform.faults.silent = false;
    platform.drop();
    await time.advance(60_000);
    expect(a.cloud.getSnapshot()).toMatchObject({ state: "online", pending: 0 });
    expect((await first.links.get(id))?.pending).toBe(0);
  });

  it("counts once more as it stops, so that the last change is not missed", async () => {
    const time = new TestTime();
    const { platform, id, first, a } = await start(time);
    await time.advance(200);
    platform.faults.silent = true;
    platform.drop();
    await time.advance(10);
    // Right before the project closes: nothing looked at the log since.
    expect(a.store.execute(writeFile("code/last.js", "x")).ok).toBe(true);
    expect(await a.session.trySave()).toBe(true);
    await a.cloud.close();
    expect((await first.links.get(id))?.pending).toBe(1);
  });

  it("leaves the count to the window that syncs", async () => {
    const time = new TestTime();
    const { platform, id, first, a } = await start(time);
    const b = await first.open(id, time);
    opened.push(b);
    await time.advance(200);
    expect(b.cloud.getSnapshot().here).toBe(false);
    platform.faults.silent = true;
    platform.drop();
    expect(b.store.execute(writeFile("code/b.js", "b")).ok).toBe(true);
    await time.advance(1500);
    // The window that syncs saw it in the log, and noted it down.
    expect(a.cloud.getSnapshot().pending).toBe(1);
    expect((await first.links.get(id))?.pending).toBe(1);
    // The other one closes, and says nothing of its own about it.
    first.links.links.set(id, { ...(first.links.links.get(id) as CloudLink), pending: 7 });
    await b.cloud.close();
    expect((await first.links.get(id))?.pending).toBe(7);
  });
});

describe("the copies of a project on the platform", () => {
  it("says which copy its log is of, and notes it for a link from before", async () => {
    const time = new TestTime();
    const { platform, id, first, a } = await start(time);
    await time.advance(200);
    // The link said none, as one from before: the first, which is what the platform has.
    expect(platform.projects.get(CLOUD_ID)?.generation).toBe(1);
    expect((await first.links.get(id))?.generation).toBe(1);
    expect(a.cloud.getSnapshot().state).toBe("online");
  });

  it("stops where the platform has another copy than the one the log is of", async () => {
    const time = new TestTime();
    const { platform, id, first, a } = await start(time);
    await time.advance(200);
    expect(a.store.execute(writeFile("code/mine.js", "mine")).ok).toBe(true);
    await time.advance(200);
    // The platform made the project again from its repository: another document, as far as
    // syncing goes, whatever it holds.
    const project = platform.projects.get(CLOUD_ID);
    if (!project) throw new Error("not on the platform");
    project.generation = 2;
    platform.drop();
    expect(a.store.execute(writeFile("code/later.js", "later")).ok).toBe(true);
    await time.advance(60_000);
    expect(a.cloud.getSnapshot()).toMatchObject({
      state: "paused",
      problem: { kind: "rebuilt" },
    });
    // Nothing of the copy before went into the new one, and the link is as it was.
    expect(platform.workingCopy(CLOUD_ID).getState().files["code/later.js"]).toBeUndefined();
    expect((await first.links.get(id))?.generation).toBe(1);
    // Everything is still here.
    expect(textOf(a.store, "code/later.js")).toBe("later");
  });

  it("stops as well where a platform says so only in its welcome", async () => {
    const time = new TestTime();
    const platform = new MemoryPlatform();
    const { id, state } = fixtureState();
    const browser = new Browser(platform, "ada");
    await browser.project(id, state, { generation: 3 });
    // A platform that does not close by itself: one from before would not look at what the
    // window says. This one is made to answer as if it had not.
    const connect = platform.connect.bind(platform);
    platform.connect = (user, tag) => {
      const connection = connect(user, tag);
      const send = connection.send.bind(connection);
      return {
        ...connection,
        send: (data) => {
          const length = new DataView(data.buffer, data.byteOffset).getUint32(0);
          const header = JSON.parse(new TextDecoder().decode(data.subarray(4, 4 + length)));
          if (header.t !== "hello") return send(data);
          delete header.generation;
          const head = new TextEncoder().encode(JSON.stringify(header));
          const out = new Uint8Array(4 + head.length + data.length - 4 - length);
          new DataView(out.buffer).setUint32(0, head.length);
          out.set(head, 4);
          out.set(data.subarray(4 + length), 4 + head.length);
          send(out);
        },
      };
    };
    const a = await browser.open(id, time, { create: true });
    opened.push(a);
    await time.advance(500);
    // The platform made it as its first copy; the log here says it is of the third.
    expect(platform.projects.get(CLOUD_ID)?.generation).toBe(1);
    expect(a.cloud.getSnapshot()).toMatchObject({ state: "paused", problem: { kind: "rebuilt" } });
    expect(a.store.execute(writeFile("code/x.js", "x")).ok).toBe(true);
    await time.advance(5000);
    expect(platform.workingCopy(CLOUD_ID).getState().files["code/x.js"]).toBeUndefined();
  });
});

describe("a change the platform does not take, and going on from the project as it is", () => {
  it("takes what goes in one piece for sent only once the platform took it, also after a reload", async () => {
    const time = new TestTime();
    const { platform, id, first, a } = await start(time);
    // The platform does not take a change, and never will as it is.
    platform.faults.rejections.push({ reason: "invalid", retry: false });
    a.store.execute(writeFile("code/a.js", "a"));
    await time.advance(500);
    expect(a.cloud.getSnapshot()).toMatchObject({ state: "paused", problem: { kind: "rejected" } });
    const before = (await first.links.get(id))?.pushed ?? 0;
    // People say to go on from the project as it is, just as the platform goes out of reach.
    platform.faults.silent = true;
    platform.drop();
    await a.cloud.resyncFromHere();
    await time.advance(2000);
    let link = await first.links.get(id);
    // Nothing is taken for sent: how far the platform has the log stays where it was, and the
    // link says what waits to go in one piece.
    expect(link?.pushed).toBe(before);
    expect(link?.resync).toBeGreaterThan(before);
    expect(a.cloud.getSnapshot().pending).toBe(1);
    // More comes after it, which waits behind it.
    a.store.execute(writeFile("code/b.js", "b"));
    await time.advance(1500);
    expect(a.cloud.getSnapshot().pending).toBe(2);
    expect((await first.links.get(id))?.pushed).toBe(before);

    // The page loads again: the window that comes after knows what waits, and how.
    await a.cloud.close();
    await a.session.close();
    opened.splice(opened.indexOf(a), 1);
    const again = await first.open(id, time);
    opened.push(again);
    await time.advance(2000);
    expect(again.cloud.getSnapshot().pending).toBe(2);
    expect(platform.effectiveRepairs).toBe(0);
    // The platform is back: what waited goes as one repair, the rest as it is, and only then
    // does any of it count as sent.
    platform.faults.silent = false;
    await time.advance(40_000);
    expect(again.cloud.getSnapshot()).toMatchObject({ state: "online", pending: 0 });
    const files = platform.workingCopy(CLOUD_ID).getState().files;
    expect(files["code/a.js"]).toBe("a");
    expect(files["code/b.js"]).toBe("b");
    expect(platform.effectiveRepairs).toBe(1);
    expect(platform.rejected).toEqual(["invalid"]);
    link = await first.links.get(id);
    expect(link?.pushed).toBeGreaterThan(before);
    expect(link).not.toHaveProperty("resync");
  });

  it("goes on waiting where the platform does not take the repair either", async () => {
    const time = new TestTime();
    const { platform, id, first, a } = await start(time);
    platform.faults.rejections.push({ reason: "invalid", retry: false });
    a.store.execute(writeFile("code/a.js", "a"));
    await time.advance(500);
    const before = (await first.links.get(id))?.pushed ?? 0;
    // Still wrong: the repair is not taken either.
    platform.faults.rejections.push({ reason: "invalid", retry: false });
    await a.cloud.resyncFromHere();
    await time.advance(5000);
    expect(a.cloud.getSnapshot()).toMatchObject({
      state: "paused",
      problem: { kind: "rejected", reason: "invalid" },
      pending: 1,
    });
    const link = await first.links.get(id);
    expect(link?.pushed).toBe(before);
    expect(link?.resync).toBeGreaterThan(before);
    expect(platform.workingCopy(CLOUD_ID).getState().files["code/a.js"]).toBeUndefined();
    // Asked again once it is right, it goes.
    await a.cloud.resyncFromHere();
    await time.advance(5000);
    expect(a.cloud.getSnapshot()).toMatchObject({ state: "online", pending: 0 });
    expect(platform.workingCopy(CLOUD_ID).getState().files["code/a.js"]).toBe("a");
    expect(await first.links.get(id)).not.toHaveProperty("resync");
  });
});

describe("a project that is to be made on the platform, or was", () => {
  it("is not made again by a window that takes over, once another window saw it there", async () => {
    const time = new TestTime();
    const { platform, id, first, a } = await start(time);
    // Another window of the browser opened the project while it was still on its way there.
    const b = await first.open(id, time, { create: true });
    opened.push(b);
    await time.advance(100);
    expect(b.cloud.getSnapshot().here).toBe(false);
    // The window that made it notes that it is there, as `CloudProjects` does.
    await first.links.update(id, CLOUD_ID, { made: true });
    // The project is taken away on the platform, and that window goes. Nothing but the editor
    // keeps a platform that does not remember what it took away from making it again.
    expect(platform.remove("ada", CLOUD_ID)).toBe("removed");
    platform.deleted.clear();
    await a.cloud.close();
    await time.advance(40_000);
    expect(b.cloud.getSnapshot()).toMatchObject({
      here: true,
      state: "paused",
      problem: { kind: "missing" },
    });
    expect(b.cloud.getSnapshot().problem).not.toHaveProperty("unmade");
    expect(platform.projects.has(CLOUD_ID)).toBe(false);
  });

  it("says that the platform would not make it, apart from one that was there and is gone", async () => {
    const time = new TestTime();
    const platform = new MemoryPlatform();
    const { id, state } = fixtureState();
    const first = new Browser(platform, "ada");
    await first.project(id, state);
    // The platform was asked to take the project away before it was made, and makes none
    // under that id.
    platform.deleted.add(CLOUD_ID);
    const a = await first.open(id, time, { create: true });
    opened.push(a);
    await time.advance(500);
    expect(a.cloud.getSnapshot()).toMatchObject({ state: "paused" });
    expect(a.cloud.getSnapshot().problem).toEqual({ kind: "missing", unmade: true });
    expect(platform.projects.size).toBe(0);
    // The same where the platform does not tell editors yet that the id was taken away.
    platform.knowsDeleted = false;
    const second = new Browser(platform, "ada");
    await second.project(id, state);
    const again = await second.open(id, time, { create: true });
    opened.push(again);
    await time.advance(500);
    expect(again.cloud.getSnapshot().problem).toEqual({ kind: "missing", unmade: true });
    // One that was there, and was taken away: it was deleted, and nothing more.
    const other = await start(time);
    expect(other.platform.remove("ada", CLOUD_ID)).toBe("removed");
    await time.advance(500);
    expect(other.a.cloud.getSnapshot().problem).toEqual({ kind: "deleted" });
    // ...or missing, where the platform does not tell editors that yet.
    const older = await start(time);
    older.platform.knowsDeleted = false;
    expect(older.platform.remove("ada", CLOUD_ID)).toBe("removed");
    await time.advance(500);
    expect(older.a.cloud.getSnapshot().problem).toEqual({ kind: "missing" });
  });

  it("says that the project cannot be edited, and why, as the platform closes it (SYNC_CLOSE.unusable)", async () => {
    const time = new TestTime();
    const { platform, a } = await start(time);
    platform.repositories.set(CLOUD_ID, { id: 7, owner: "ada", name: "atom" });
    platform.makeUnusable(CLOUD_ID, { reason: "suspended", since: 1 });
    await time.advance(500);
    expect(a.cloud.getSnapshot()).toMatchObject({
      state: "paused",
      problem: { kind: "unusable", reason: "suspended" },
    });
    // It stays so: a hello is closed the same way, until the repository can be used again.
    a.cloud.resume();
    await time.advance(500);
    expect(a.cloud.getSnapshot().problem).toEqual({ kind: "unusable", reason: "suspended" });
    platform.makeUnusable(CLOUD_ID, undefined);
    a.cloud.resume();
    await time.advance(500);
    expect(a.cloud.getSnapshot()).toMatchObject({ state: "online", problem: undefined });
  });

  it("says when nothing of it is on its way to the platform any more", async () => {
    const time = new TestTime();
    const platform = new MemoryPlatform();
    const { id, state } = fixtureState();
    const first = new Browser(platform, "ada");
    await first.project(id, state);
    // A slow line: the hello that makes the project takes two seconds to get there.
    platform.faults.line = { time, bytesPerSecond: Math.ceil(state.length / 2) };
    const a = await first.open(id, time, { create: true });
    expect(a.cloud.mayStillCreate).toBe(false);
    // One that never connected has nothing on its way.
    expect(await a.cloud.whenQuiet(1000)).toBe(true);
    await time.advance(300);
    expect(a.cloud.getSnapshot().state).toBe("connecting");
    // From the first connection on, a hello that makes the project may be under way.
    expect(a.cloud.mayStillCreate).toBe(true);
    await a.cloud.close();
    expect(platform.projects.size).toBe(0);
    // Closed, and what it sent is still on its way: not quiet yet.
    let isQuiet: boolean | undefined;
    void a.cloud.whenQuiet(10_000).then((quiet) => {
      isQuiet = quiet;
    });
    await time.advance(1000);
    expect(isQuiet).toBeUndefined();
    expect(await Promise.race([a.cloud.whenQuiet(0), time.advance(10).then(() => "waiting")])).toBe(
      false,
    );
    await time.advance(3000);
    // It got there, and the platform made the project: only then is the connection closed.
    expect(isQuiet).toBe(true);
    expect(platform.projects.has(CLOUD_ID)).toBe(true);

    // Once the platform said that the project is there, nothing of this window makes it.
    delete platform.faults.line;
    const b = await first.open(id, time, { create: true });
    opened.push(b);
    await time.advance(500);
    expect(b.cloud.getSnapshot().state).toBe("online");
    expect(b.cloud.mayStillCreate).toBe(false);
  });

  it("says nothing more once it stopped, however long what it waited for takes", async () => {
    const time = new TestTime();
    const platform = new MemoryPlatform();
    const { id, state } = fixtureState();
    const first = new Browser(platform, "ada");
    await first.project(id, state);
    // What the browser is called on the platform takes a moment to read.
    let name: (device: string) => void = () => {};
    first.links.device = () =>
      new Promise<string>((resolve) => {
        name = resolve;
      });
    const a = await first.open(id, time, { create: true });
    await time.advance(100);
    expect(a.cloud.getSnapshot().state).toBe("connecting");
    // The window stops right then, as where people gave up on connecting.
    const closing = a.cloud.close();
    name("device-1");
    await closing;
    await time.advance(5000);
    // Its hello never went: nothing makes the project after whoever stopped it moved on.
    expect(platform.projects.size).toBe(0);
    expect(await a.cloud.whenQuiet(1000)).toBe(true);
  });
});
