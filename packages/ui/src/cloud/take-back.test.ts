import { ProjectStore, type CommandCall } from "@animaquill/core";
import type { CloudLink } from "@animaquill/host";
import { afterEach, describe, expect, it } from "vitest";
import { loadFixture } from "../../../schema/scripts/fixture.ts";
import { MemoryLibrary, memoryAddress } from "../workbench/memory-library.ts";
import { ProjectSession, type SessionMessages } from "../workbench/session.ts";
import { MemoryPlatform, TestCloudBrowser, TestTime, statusFor } from "./cloud-support.ts";
import type { ReconcileChoices } from "./reconcile.ts";
import { CloudSession } from "./session.ts";
import {
  TakeBack,
  baseOfTakeBack,
  dropKept,
  settleRenewal,
  settleTakeBack,
  type ChooseTakeBack,
  type TakeBackPlan,
} from "./take-back.ts";
import { isSettled } from "./reconcile.ts";

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

function fixtureState(): { id: string; state: Uint8Array } {
  const files = loadFixture("v1");
  const manifest = JSON.parse(files.get("animaquill.json") as string);
  delete manifest.tags;
  files.set("animaquill.json", JSON.stringify(manifest));
  files.set("code/a.js", "a\n");
  files.set("code/b.js", "one\ntwo\nthree\n");
  const { store } = ProjectStore.open(files);
  if (!store) throw new Error("fixture did not open");
  const id = store.getState().manifest.id;
  const state = store.encodeState();
  store.destroy();
  return { id, state };
}

const writeFile = (path: string, text: string): CommandCall => ({
  type: "file.write",
  params: { path, text },
});

interface Window {
  readonly session: ProjectSession;
  readonly store: ProjectStore;
  readonly cloud: CloudSession;
  readonly page: { isAlive: () => boolean; asleep: boolean };
}

const opened: Window[] = [];
afterEach(async () => {
  for (const window of opened.splice(0)) {
    await window.cloud.close();
    await window.session.close();
  }
});

/** A browser with a copy of the project that syncs. */
class Device extends TestCloudBrowser {
  readonly library = new MemoryLibrary();
  #pages = 0;
  readonly key: string;
  readonly time: TestTime;

  constructor(platform: MemoryPlatform, key: string, time: TestTime) {
    super(platform, "ada");
    this.key = key;
    this.time = time;
  }

  async keep(state: Uint8Array, link: Partial<CloudLink> = {}): Promise<void> {
    await this.library.create({ id: this.key, name: "原子" }, state);
    const entries = await (await this.library.open(this.key)).entries?.();
    await this.links.put({
      key: this.key,
      platform: PLATFORM,
      project: CLOUD_ID,
      seq: 0,
      pushed: entries?.at(-1)?.mark ?? 0,
      linkedAt: 1,
      ...link,
    });
  }

  /** The project as the platform has it now, as "open from the platform" brings it here. */
  async fromPlatform(): Promise<void> {
    const project = this.platform.projects.get(CLOUD_ID);
    if (!project) throw new Error("not on the platform");
    await this.keep(this.platform.workingCopy(CLOUD_ID).encodeState(), {
      seq: project.head,
      generation: project.generation,
    });
  }

  async open({ create = false } = {}): Promise<Window> {
    const name = `${this.tag}w${++this.#pages}`;
    const page = { isAlive: () => true, asleep: false };
    const session = new ProjectSession(this.library, memoryAddress(), MESSAGES, { window: name });
    if (!(await session.open(this.key))) throw new Error("did not open");
    const store = session.store as ProjectStore;
    let link = await this.links.get(this.key);
    if (!link) throw new Error("no link");
    if (create && !link.creating) {
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
      environment: this.time,
      timing: { scanMs: 5, noteMs: 50, longestRetryMs: 2000 },
      onSeq: (seq) => {
        session.cloudSeq = seq;
      },
      ...(create && { create: { name: "原子", projectId: store.getState().manifest.id } }),
    });
    const window = { session, store, cloud, page };
    opened.push(window);
    cloud.start();
    return window;
  }

  async close(window: Window): Promise<void> {
    await window.cloud.close();
    await window.session.close();
    opened.splice(opened.indexOf(window), 1);
  }

  takeBack(): TakeBack {
    return new TakeBack({
      cloud: this.access({ isAlive: () => true, asleep: false }),
      projects: this.library,
      status: statusFor(this),
      window: "take-back",
      editor: "test",
    });
  }

  /** Takes the copy of a window back, with people choosing as `choose` says. */
  run(window: Window, choose: ChooseTakeBack = async () => undefined) {
    return this.takeBack().run({
      key: this.key,
      project: CLOUD_ID,
      store: window.store,
      generation: window.cloud.getSnapshot().problem?.kind === "rebuilt" ? 1 : 1,
      saved: async () => {
        await window.session.journal.readLog();
        return window.session.journal.saved();
      },
      entries: async () => (await window.session.journal.entries()) ?? [],
      choose,
    });
  }
}

/** People choose the same side for every file. */
const all =
  (side: "here" | "cloud", seen?: (plan: TakeBackPlan) => void): ChooseTakeBack =>
  async (plan) => {
    seen?.(plan);
    const choices: ReconcileChoices = new Map(
      plan.differences.map(({ path, kind }) => [
        path,
        kind === "cloud" && side === "here" ? "here" : side,
      ]),
    );
    const settled = settleTakeBack(plan, choices);
    if (!isSettled(settled)) throw new Error("did not settle");
    return { choices, settled };
  };

/** A project made on the platform from the first device, with a second one that has it too. */
async function start() {
  const time = new TestTime();
  const platform = new MemoryPlatform();
  platform.repositories.set(CLOUD_ID, { id: 7, owner: "ada", name: "atom" });
  const { id, state } = fixtureState();
  const a = new Device(platform, id, time);
  await a.keep(state);
  const window = await a.open({ create: true });
  await time.advance(200);
  expect(window.cloud.getSnapshot().state).toBe("online");
  return { time, platform, a, window, id };
}

/**
 * The clients of a Yjs state vector, by its encoding: how many, then each client with its clock.
 * Whoever wrote a document is in it for good: two documents put together share clients.
 */
function clientsOf(vector: Uint8Array): Set<number> {
  let at = 0;
  const next = () => {
    let value = 0;
    for (let shift = 1; ; shift *= 128) {
      const byte = vector[at++] ?? 0;
      value += (byte & 127) * shift;
      if (byte < 128) return value;
    }
  };
  const clients = new Set<number>();
  for (let count = next(); count > 0; count--) {
    clients.add(next());
    next();
  }
  return clients;
}

const cloudText = (platform: MemoryPlatform, path: string) =>
  platform.workingCopy(CLOUD_ID).getState().files[path];

/** The platform lets go of the copy, and the device opens it again: it hears that it is rebuilt. */
async function releaseAndComeBack(
  platform: MemoryPlatform,
  device: Device,
  time: TestTime,
): Promise<Window> {
  platform.release(CLOUD_ID);
  await time.advance(10);
  const window = await device.open();
  // The platform says to come back later meanwhile, and the window does, in a while.
  await time.advance(30_000);
  expect(window.cloud.getSnapshot()).toMatchObject({ problem: { kind: "rebuilt" } });
  return window;
}

/** The device opens the project again, where the platform let go of its copy already. */
async function releaseAndComeBackAfter(
  platform: MemoryPlatform,
  device: Device,
  time: TestTime,
): Promise<Window> {
  const window = await device.open();
  await time.advance(30_000);
  expect(window.cloud.getSnapshot()).toMatchObject({ problem: { kind: "rebuilt" } });
  return window;
}

describe("baseOfTakeBack", () => {
  const from = { generation: 1, archivedSeq: 10, commonBase: true };
  it("takes the archive where this computer got as far, and the log where it did not", () => {
    expect(baseOfTakeBack({ seq: 10, generation: 1 }, from)).toBe("archive");
    expect(baseOfTakeBack({ seq: 14 }, from)).toBe("archive");
    expect(baseOfTakeBack({ seq: 9, generation: 1 }, from)).toBe("log");
  });

  it("has nothing in common where the copy began as something else, or the log is older", () => {
    expect(baseOfTakeBack({ seq: 10 }, undefined)).toBe("none");
    expect(baseOfTakeBack({ seq: 10 }, { ...from, commonBase: false })).toBe("none");
    expect(baseOfTakeBack({ seq: 10 }, { ...from, archivedSeq: 0 })).toBe("none");
    expect(baseOfTakeBack({ seq: 10, generation: 1 }, { ...from, generation: 2 })).toBe("none");
  });
});

describe("TakeBack", () => {
  it("goes on the new copy without a word where this computer has nothing the archive does not", async () => {
    const { time, platform, a, window } = await start();
    expect(window.store.execute(writeFile("code/a.js", "a2\n")).ok).toBe(true);
    await time.advance(200);
    platform.archive(CLOUD_ID);
    await a.close(window);
    const again = await releaseAndComeBack(platform, a, time);

    const outcome = await a.run(again);
    expect(outcome).toMatchObject({ kind: "renewed", changed: false, chosen: 0 });
    const link = await a.links.get(a.key);
    expect(link).toMatchObject({ generation: 2, seq: platform.projects.get(CLOUD_ID)?.head });
    expect(link?.renewing).toBeUndefined();
    // Nothing waits: what the log had goes at once.
    expect(await dropKept(a.access(again.page), a.library, a.key)).toBe(true);
    expect(await a.library.backups(a.key)).toEqual([]);
    // The window of the copy before cannot write to the new log.
    expect(again.store.execute(writeFile("code/a.js", "late\n")).ok).toBe(true);
    expect(await again.session.trySave()).toBe(false);
  });

  it("never syncs what a window has of the copy before with the new one, whatever the link says", async () => {
    // A window that still has the project as it was, as one that went on syncing while the log
    // went on the new copy under it: it says hello for the new copy only with the new log.
    const { time, platform, a, window } = await start();
    expect(window.store.execute(writeFile("code/a.js", "old copy\n")).ok).toBe(true);
    await time.advance(200);
    platform.archive(CLOUD_ID);
    await a.close(window);
    const again = await releaseAndComeBack(platform, a, time);
    expect(await a.run(again)).toMatchObject({ kind: "renewed" });
    const link = (await a.links.get(a.key)) as CloudLink;
    expect(link.generation).toBe(2);
    const updates = platform.projects.get(CLOUD_ID)?.updates.length;
    // Its sync went, and another one starts with what it has.
    await again.cloud.close();
    const stale = new CloudSession({
      store: again.store,
      journal: again.session.journal,
      cloud: a.access(again.page),
      link,
      window: "stale",
      editor: "test",
      environment: time,
      timing: { scanMs: 5, noteMs: 50, longestRetryMs: 2000 },
    });
    try {
      stale.start();
      await time.advance(3000);
      expect(stale.getSnapshot()).toMatchObject({ problem: { kind: "rebuilt" } });
      expect(platform.projects.get(CLOUD_ID)?.updates.length).toBe(updates);
    } finally {
      await stale.close();
    }
  });

  it("brings back what got to the platform but not into the repository before it went", async () => {
    const { time, platform, a, window } = await start();
    expect(window.store.execute(writeFile("code/a.js", "archived\n")).ok).toBe(true);
    await time.advance(200);
    platform.archive(CLOUD_ID);
    // On the platform, never archived: only this computer has it once the copy goes.
    expect(window.store.execute(writeFile("code/b.js", "one\ntwo\nlate\n")).ok).toBe(true);
    await time.advance(200);
    expect(cloudText(platform, "code/b.js")).toBe("one\ntwo\nlate\n");
    await a.close(window);
    const again = await releaseAndComeBack(platform, a, time);
    expect(cloudText(platform, "code/b.js")).toBe("one\ntwo\nthree\n");
    const before = clientsOf(again.store.stateVector());

    const outcome = await a.run(again);
    expect(outcome).toMatchObject({ kind: "renewed", changed: true, merged: ["code/b.js"] });
    // What the log had stays until the platform has what came of it.
    expect(await dropKept(a.access(again.page), a.library, a.key)).toBe(false);
    expect(await a.library.backups(a.key)).toHaveLength(1);
    await a.close(again);
    const renewed = await a.open();
    await time.advance(500);
    expect(renewed.cloud.getSnapshot()).toMatchObject({ state: "online", pending: 0 });
    expect(cloudText(platform, "code/b.js")).toBe("one\ntwo\nlate\n");
    expect(cloudText(platform, "code/a.js")).toBe("archived\n");
    // Nothing of the document of the copy before got to the new one: only what came of it.
    const after = clientsOf(platform.workingCopy(CLOUD_ID).stateVector());
    expect([...after].filter((client) => before.has(client))).toEqual([]);
    // Once it is there, what the log had goes.
    await time.advance(200);
    expect(await dropKept(a.access(renewed.page), a.library, a.key)).toBe(true);
  });

  it("puts what this computer changed offline onto what others did since, file by file", async () => {
    const { time, platform, a, window } = await start();
    const b = new Device(platform, "b-key", time);
    await b.fromPlatform();
    // This computer changes a file while it is away, and so do others with another one.
    await a.close(window);
    const away = await a.open();
    platform.faults.silent = true;
    await time.advance(10);
    expect(away.store.execute(writeFile("code/a.js", "mine\n")).ok).toBe(true);
    await away.session.trySave();
    await a.close(away);
    platform.faults.silent = false;
    const other = await b.open();
    await time.advance(300);
    expect(other.store.execute(writeFile("code/b.js", "one\nTWO\nthree\n")).ok).toBe(true);
    await time.advance(300);
    platform.archive(CLOUD_ID);
    await b.close(other);
    const again = await releaseAndComeBack(platform, a, time);

    const outcome = await a.run(again);
    expect(outcome).toMatchObject({ kind: "renewed", changed: true, merged: ["code/a.js"] });
    await a.close(again);
    const renewed = await a.open();
    await time.advance(500);
    expect(cloudText(platform, "code/a.js")).toBe("mine\n");
    // What others did since is not taken back: it was not a change of this computer.
    expect(cloudText(platform, "code/b.js")).toBe("one\nTWO\nthree\n");
    expect(renewed.store.getState().files["code/b.js"]).toBe("one\nTWO\nthree\n");
  });

  it("does not take back what others did while this computer was away for long", async () => {
    // Away since before the archive: what both had is what the log has from the platform, not the
    // archive. With the archive, the old file here would look like a change of this computer.
    const { time, platform, a, window } = await start();
    const b = new Device(platform, "b-key", time);
    await b.fromPlatform();
    await a.close(window);
    const other = await b.open();
    await time.advance(300);
    expect(other.store.execute(writeFile("code/b.js", "one\nnewer\nthree\n")).ok).toBe(true);
    await time.advance(300);
    platform.archive(CLOUD_ID);
    expect((await a.links.get(a.key))?.seq ?? 0).toBeLessThan(
      platform.archivedSeq.get(CLOUD_ID) ?? 0,
    );
    await b.close(other);
    const again = await releaseAndComeBack(platform, a, time);
    expect(again.store.getState().files["code/b.js"]).toBe("one\ntwo\nthree\n");

    const outcome = await a.run(again);
    expect(outcome).toMatchObject({ kind: "renewed", changed: false });
    await a.close(again);
    const renewed = await a.open();
    await time.advance(500);
    expect(cloudText(platform, "code/b.js")).toBe("one\nnewer\nthree\n");
    expect(renewed.store.getState().files["code/b.js"]).toBe("one\nnewer\nthree\n");
  });

  it("has people choose where both changed the same place, and does as they chose", async () => {
    for (const side of ["here", "cloud"] as const) {
      const { time, platform, a, window } = await start();
      const b = new Device(platform, "b-key", time);
      await b.fromPlatform();
      await a.close(window);
      const away = await a.open();
      platform.faults.silent = true;
      await time.advance(10);
      expect(away.store.execute(writeFile("code/b.js", "one\nmine\nthree\n")).ok).toBe(true);
      expect(away.store.execute(writeFile("code/a.js", "only mine\n")).ok).toBe(true);
      await away.session.trySave();
      await a.close(away);
      platform.faults.silent = false;
      const other = await b.open();
      await time.advance(300);
      expect(other.store.execute(writeFile("code/b.js", "one\ntheirs\nthree\n")).ok).toBe(true);
      await time.advance(300);
      platform.archive(CLOUD_ID);
      await b.close(other);
      const again = await releaseAndComeBack(platform, a, time);

      let asked: TakeBackPlan | undefined;
      const outcome = await a.run(
        again,
        all(side, (plan) => (asked = plan)),
      );
      expect(asked?.differences.map(({ path }) => path)).toEqual(["code/b.js"]);
      expect(asked?.merged).toEqual(["code/a.js"]);
      expect(outcome).toMatchObject({ kind: "renewed", chosen: 1 });
      await a.close(again);
      const renewed = await a.open();
      await time.advance(500);
      expect(cloudText(platform, "code/b.js")).toBe(
        side === "here" ? "one\nmine\nthree\n" : "one\ntheirs\nthree\n",
      );
      expect(cloudText(platform, "code/a.js")).toBe("only mine\n");
      await a.close(renewed);
    }
  });

  it("asks again where the platform changed a file people chose for while they chose", async () => {
    const { time, platform, a, window } = await start();
    const b = new Device(platform, "b-key", time);
    await b.fromPlatform();
    await a.close(window);
    const away = await a.open();
    platform.faults.silent = true;
    await time.advance(10);
    expect(away.store.execute(writeFile("code/b.js", "one\nmine\nthree\n")).ok).toBe(true);
    await away.session.trySave();
    await a.close(away);
    platform.faults.silent = false;
    const other = await b.open();
    await time.advance(300);
    expect(other.store.execute(writeFile("code/b.js", "one\ntheirs\nthree\n")).ok).toBe(true);
    await time.advance(300);
    platform.archive(CLOUD_ID);
    await b.close(other);
    const again = await releaseAndComeBack(platform, a, time);
    // Somebody else is on the new copy, and changes the file while people here choose.
    const c = new Device(platform, "c-key", time);
    await c.fromPlatform();
    const meanwhile = await c.open();
    await time.advance(300);

    const seen: string[] = [];
    const choose: ChooseTakeBack = async (plan) => {
      seen.push(plan.cloud.get("code/b.js") ?? "");
      if (seen.length === 1) {
        expect(meanwhile.store.execute(writeFile("code/b.js", "one\nlater\nthree\n")).ok).toBe(
          true,
        );
        await time.advance(300);
      }
      return all("here")(plan);
    };
    const outcome = await a.run(again, choose);
    // People saw it again as it is now, and what they chose then is what the platform has.
    expect(seen).toEqual(["one\ntheirs\nthree\n", "one\nlater\nthree\n"]);
    expect(outcome).toMatchObject({ kind: "renewed", chosen: 1 });
    await a.close(again);
    await a.open();
    await time.advance(500);
    expect(cloudText(platform, "code/b.js")).toBe("one\nmine\nthree\n");
  });

  it("changes nothing where people do not choose", async () => {
    const { time, platform, a, window } = await start();
    const b = new Device(platform, "b-key", time);
    await b.fromPlatform();
    await a.close(window);
    const away = await a.open();
    platform.faults.silent = true;
    await time.advance(10);
    expect(away.store.execute(writeFile("code/b.js", "one\nmine\nthree\n")).ok).toBe(true);
    await away.session.trySave();
    await a.close(away);
    platform.faults.silent = false;
    const other = await b.open();
    await time.advance(300);
    expect(other.store.execute(writeFile("code/b.js", "one\ntheirs\nthree\n")).ok).toBe(true);
    await time.advance(300);
    platform.archive(CLOUD_ID);
    await b.close(other);
    const again = await releaseAndComeBack(platform, a, time);
    const before = (await a.library.open(a.key)).load();

    expect(await a.run(again)).toEqual({ kind: "cancelled" });
    expect(await (await a.library.open(a.key)).load()).toEqual(await before);
    expect((await a.links.get(a.key))?.generation ?? 1).toBe(1);
    expect(await a.library.backups(a.key)).toEqual([]);
  });

  it("has people choose where the log is of a copy before the last one, whose archive nobody knows", async () => {
    // This computer got a change to the platform that never got into the repository, and went
    // away; the platform let go of the copy twice meanwhile. What the log had of the platform is no
    // base: the change would look like something the new copy took away, and be gone unasked.
    const { time, platform, a, window } = await start();
    platform.archive(CLOUD_ID);
    expect(window.store.execute(writeFile("code/b.js", "one\ntwo\nmine\n")).ok).toBe(true);
    await time.advance(300);
    expect(cloudText(platform, "code/b.js")).toBe("one\ntwo\nmine\n");
    await a.close(window);
    platform.release(CLOUD_ID);
    platform.rebuild(CLOUD_ID);
    platform.archive(CLOUD_ID);
    platform.release(CLOUD_ID);
    const again = await releaseAndComeBackAfter(platform, a, time);
    expect(platform.projects.get(CLOUD_ID)?.generation).toBe(3);

    let asked: TakeBackPlan | undefined;
    const outcome = await a.run(
      again,
      all("here", (plan) => (asked = plan)),
    );
    expect(asked?.base).toBeUndefined();
    expect(asked?.differences.map(({ path }) => path)).toContain("code/b.js");
    expect(outcome).toMatchObject({ kind: "renewed" });
    await a.close(again);
    await a.open();
    await time.advance(500);
    expect(cloudText(platform, "code/b.js")).toBe("one\ntwo\nmine\n");
  });

  it("has people choose every file that is not the same where the copy began as something else", async () => {
    const { time, platform, a, window } = await start();
    expect(window.store.execute(writeFile("code/a.js", "mine\n")).ok).toBe(true);
    await time.advance(200);
    platform.archive(CLOUD_ID);
    await a.close(window);
    platform.release(CLOUD_ID);
    // People changed the repository on GitHub, and the copy is made from the branch as it is.
    const branch = new Map(platform.archives.get(CLOUD_ID));
    branch.set("code/b.js", "on github\n");
    platform.branches.set(CLOUD_ID, branch);
    platform.rebuild(CLOUD_ID, { fromBranch: true });
    const again = await a.open();
    await time.advance(30_000);
    expect(again.cloud.getSnapshot()).toMatchObject({ problem: { kind: "rebuilt" } });

    let asked: TakeBackPlan | undefined;
    const outcome = await a.run(
      again,
      all("cloud", (plan) => (asked = plan)),
    );
    expect(asked?.base).toBeUndefined();
    expect(asked?.differences.map(({ path }) => path)).toEqual(["code/b.js"]);
    expect(outcome).toMatchObject({ kind: "renewed", chosen: 1 });
  });

  it("leaves the link and the log as they were where the log cannot start anew", async () => {
    const { time, platform, a, window } = await start();
    platform.faults.silent = true;
    await time.advance(10);
    expect(window.store.execute(writeFile("code/a.js", "offline\n")).ok).toBe(true);
    await window.session.trySave();
    await a.close(window);
    platform.faults.silent = false;
    platform.archive(CLOUD_ID);
    const again = await releaseAndComeBack(platform, a, time);
    a.library.failingToRenew = true;
    const before = await (await a.library.open(a.key)).load();

    expect(await a.run(again)).toMatchObject({ kind: "failed", why: "library" });
    const link = await a.links.get(a.key);
    expect(link?.renewing).toBeUndefined();
    expect(link?.generation ?? 1).toBe(1);
    expect(await (await a.library.open(a.key)).load()).toEqual(before);
  });

  it("finishes or puts back what a page left halfway", async () => {
    const { time, platform, a, window } = await start();
    platform.archive(CLOUD_ID);
    await a.close(window);
    const again = await releaseAndComeBack(platform, a, time);
    const access = a.access(again.page);
    const link = (await a.links.get(a.key)) as CloudLink;
    const renewing = {
      id: "r1",
      from: 1,
      generation: 2,
      seq: platform.projects.get(CLOUD_ID)?.head ?? 0,
      digest: platform.projects.get(CLOUD_ID)?.digest ?? "",
      backup: "copy1-r1",
    };
    // The link says it is on its way, and the page went before the log started anew.
    await a.links.update(a.key, CLOUD_ID, { renewing });
    expect(await settleRenewal(access, a.library, { ...link, renewing })).toBe(false);
    expect((await a.links.get(a.key))?.renewing).toBeUndefined();
    expect((await a.links.get(a.key))?.generation ?? 1).toBe(1);
    // ...and once more, where the page went right after the log started anew.
    await a.links.update(a.key, CLOUD_ID, { renewing });
    const state = platform.workingCopy(CLOUD_ID).encodeState();
    await a.library.renew(
      a.key,
      [{ update: state, source: { kind: "cloud", seq: renewing.seq } }],
      "copy1-r1",
    );
    expect(await settleRenewal(access, a.library, { ...link, renewing })).toBe(true);
    expect(await a.links.get(a.key)).toMatchObject({
      generation: 2,
      seq: renewing.seq,
      kept: { backup: "copy1-r1", generation: 1 },
    });
    await a.close(again);
    const renewed = await a.open();
    await time.advance(500);
    expect(renewed.cloud.getSnapshot()).toMatchObject({ state: "online" });
  });

  it("is already done where another window took the link to the new copy", async () => {
    const { time, platform, a, window } = await start();
    platform.archive(CLOUD_ID);
    await a.close(window);
    const first = await releaseAndComeBack(platform, a, time);
    const second = await a.open();
    await time.advance(100);
    expect(await a.run(first)).toMatchObject({ kind: "renewed" });
    // The other window opened before: what it has is of the copy before.
    expect(await a.run(second)).toEqual({ kind: "already" });
    // Syncing there stops before saying hello with the copy before.
    await time.advance(3000);
    expect(second.cloud.getSnapshot()).toMatchObject({ problem: { kind: "rebuilt" } });
  });
});
