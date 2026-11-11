/**
 * The random test of syncing: browsers with windows that change a project at random while their
 * connections break, the browsers go offline, windows reload or go, and the platform restarts and
 * turns changes away. In the end every window and the platform have the same project, and nothing
 * any window did is missing from it.
 */
import { ProjectStore, aiTask, folderBatch, isEmptyUpdate, type Origin } from "@animaquill/core";
import { expect } from "vitest";
import { randomCommand, randomFrom, seedIds, type Random } from "../../../core/src/fuzz-support.ts";
import { loadFixture } from "../../../schema/scripts/fixture.ts";
import type { CloudLink } from "@animaquill/host";
import { MemoryLibrary, memoryAddress } from "../workbench/memory-library.ts";
import { ProjectSession, type SessionMessages } from "../workbench/session.ts";
import { MemoryPlatform, TestCloudBrowser, TestNetwork, TestTime } from "./cloud-support.ts";
import { CloudSession } from "./session.ts";

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
const CLOUD_ID = "fuzz";

interface FuzzWindow {
  readonly name: string;
  readonly session: ProjectSession;
  readonly store: ProjectStore;
  /** None while the project is not connected. */
  readonly cloud: CloudSession | undefined;
  readonly page: { alive: boolean; isAlive: () => boolean; asleep: boolean };
}

class FuzzBrowser extends TestCloudBrowser {
  readonly library = new MemoryLibrary();
  readonly windows: FuzzWindow[] = [];
  readonly network: TestNetwork;
  #pages = 0;

  readonly time: TestTime;
  readonly produced: Uint8Array[];
  readonly index: number;
  /** See `SessionOptions.compactAfter`. */
  compactAfter = 8;

  constructor(platform: MemoryPlatform, time: TestTime, produced: Uint8Array[], index: number) {
    super(platform, "ada");
    this.time = time;
    this.produced = produced;
    this.index = index;
    this.network = new TestNetwork(time);
  }

  async open(id: string, create = false): Promise<FuzzWindow> {
    const name = `b${this.index}w${++this.#pages}`;
    const page = { alive: true, isAlive: () => page.alive, asleep: false };
    const session = new ProjectSession(this.library, memoryAddress(), MESSAGES, {
      window: name,
      compactThrough: async (key) => (await this.links.get(key))?.pushed,
      // Short logs get made shorter when a window opens, so that it happens all the time here.
      compactAfter: this.compactAfter,
    });
    if (!(await session.open(id))) throw new Error("did not open");
    const store = session.store as ProjectStore;
    store.onLocalUpdate((update, origin) => {
      if (!origin.startsWith("cloud:")) this.produced.push(update);
    });
    const link = await this.links.get(id);
    const window = {
      name,
      session,
      store,
      cloud: link && this.#sync(session, store, link, page, name, create || link.creating === true),
      page,
    };
    this.windows.push(window);
    return window;
  }

  #sync(
    session: ProjectSession,
    store: ProjectStore,
    link: CloudLink,
    page: FuzzWindow["page"],
    name: string,
    create = false,
  ): CloudSession {
    const cloud = new CloudSession({
      store,
      journal: session.journal,
      cloud: this.access(page),
      link,
      window: name,
      editor: "test",
      environment: this.network,
      timing: { scanMs: 5, noteMs: 100, pingMs: 5000, deadMs: 3000, steadyMs: 2000 },
      onSeq: (seq) => {
        session.cloudSeq = seq;
      },
      ...(create && { create: { name: "原子", projectId: store.getState().manifest.id } }),
    });
    cloud.start();
    return cloud;
  }

  /**
   * Stops syncing in a window and starts again, as a window that looks at its link again: as
   * `CloudProjects` does where the link changed, or the project opened again.
   */
  async again(window: FuzzWindow): Promise<void> {
    await window.cloud?.close();
    const link = await this.links.get(window.session.key ?? "");
    (window as { cloud: CloudSession | undefined }).cloud =
      link &&
      this.#sync(
        window.session,
        window.store,
        link,
        window.page,
        window.name,
        link.creating === true,
      );
  }

  /**
   * Breaks an entry of the log that the platform has, as a disk can: the project skips it when it
   * opens, and what needed it waits until the platform sends it.
   */
  async breakEntry(id: string, random: Random): Promise<boolean> {
    const link = await this.links.get(id);
    const updates = this.library.updates.get(id);
    if (!link || !updates) return false;
    // Not what holds the project as a whole, the first version or what the log got shorter into:
    // without it there is no project to open here, which is no question of syncing.
    const onPlatform = updates.filter((update) => {
      const entry = this.library.entries.get(update);
      const kind = entry?.source?.kind;
      return (
        entry !== undefined && kind !== undefined && kind !== "merged" && entry.mark <= link.pushed
      );
    });
    const victim = random.pick(onPlatform);
    if (!victim) return false;
    const broken = new Uint8Array([0, 7, 7, 7, 255, 255]);
    this.library.entries.set(
      broken,
      this.library.entries.get(victim) ?? { mark: 0, source: undefined },
    );
    updates.splice(updates.indexOf(victim), 1, broken);
    return true;
  }

  async close(window: FuzzWindow, { crash = false } = {}): Promise<void> {
    const at = this.windows.indexOf(window);
    if (at >= 0) this.windows.splice(at, 1);
    const before = crash ? await this.links.get(window.session.key ?? "") : undefined;
    await window.cloud?.close();
    await window.session.close();
    window.page.alive = false;
    this.writers.sweep();
    // A crash takes what was about to be noted down: the link is behind what the log has.
    if (before) this.links.links.set(before.key, before);
  }
}

const ORIGINS: readonly ((random: Random) => Origin | undefined)[] = [
  () => undefined,
  () => undefined,
  () => undefined,
  (random) => folderBatch(String(random.int(1000))),
  (random) => aiTask(String(random.int(3))),
];

/** Whether applying an update to a copy of the store would change anything. */
function isIn(store: ProjectStore, updates: readonly Uint8Array[]): boolean {
  const copy = ProjectStore.fromUpdates([store.encodeState()]).store as ProjectStore;
  for (const update of updates) {
    const { delta } = copy.applyChecked(update, "check");
    if (delta && !isEmptyUpdate(delta)) return false;
  }
  return true;
}

/** The platform's project from what it kept, as after a restart. */
function kept(platform: MemoryPlatform, cloudId = CLOUD_ID): ProjectStore {
  const project = platform.projects.get(cloudId);
  if (!project) throw new Error("not on the platform");
  const parts = [
    ...(project.snapshot ? [project.snapshot.state] : []),
    ...project.updates.map((update) => update.data),
  ];
  const { store } = ProjectStore.fromUpdates(parts);
  if (!store || store.isMissingUpdates) throw new Error("what the platform kept does not open");
  return store;
}

/** The project the random tests start from. */
function fixtureProject(): { id: string; state: Uint8Array } {
  const files = loadFixture("v1");
  const manifest = JSON.parse(files.get("animaquill.json") as string);
  delete manifest.tags;
  files.set("animaquill.json", JSON.stringify(manifest));
  const opened = ProjectStore.open(files).store as ProjectStore;
  const id = opened.getState().manifest.id;
  const state = opened.encodeState();
  opened.destroy();
  return { id, state };
}

/**
 * What can go wrong besides connections and restarts: the platform comes back from a backup, or the
 * log of a browser loses entries that the platform has. A run without either must not need what
 * comparing repairs: everything goes as changes of its own, see `MemoryPlatform.effectiveRepairs`.
 */
export type FuzzLosses = "none" | "platform" | "log";

export async function fuzzCloud(
  seed: number,
  steps = 160,
  losses: FuzzLosses = (["none", "platform", "log"] as const)[seed % 3] ?? "none",
): Promise<void> {
  seedIds(seed);
  const random = randomFrom(seed);
  const time = new TestTime();
  const platform = new MemoryPlatform();
  // A backup a little older than the last snapshot cannot be had, so snapshots are rare where the
  // platform loses what it had.
  platform.compactAfter = losses === "platform" ? 10_000 : 10 + random.int(30);
  const produced: Uint8Array[] = [];

  const { id, state } = fixtureProject();

  const browsers = [0, 1, 2].map((index) => new FuzzBrowser(platform, time, produced, index));
  const [first] = browsers as [FuzzBrowser];
  await first.library.create({ id, name: "原子" }, state);
  const mark = (await (await first.library.open(id)).entries?.())?.at(-1)?.mark ?? 0;
  await first.links.put({
    key: id,
    platform: PLATFORM,
    project: CLOUD_ID,
    seq: 0,
    pushed: mark,
    linkedAt: 1,
    // As connecting leaves it: not on the platform yet, until the first connection made it.
    creating: true,
  });
  await first.open(id, true);
  await time.advance(200);
  await first.links.update(id, CLOUD_ID, { made: true });
  for (const browser of browsers.slice(1)) {
    const head = platform.projects.get(CLOUD_ID)?.head ?? 0;
    await browser.library.create(
      { id, name: "原子" },
      platform.workingCopy(CLOUD_ID).encodeState(),
    );
    const last = (await (await browser.library.open(id)).entries?.())?.at(-1)?.mark ?? 0;
    await browser.links.put({
      key: id,
      platform: PLATFORM,
      project: CLOUD_ID,
      seq: head,
      pushed: last,
      linkedAt: 1,
    });
    await browser.open(id);
  }

  const someWindow = () => {
    const browser = random.pick(browsers) as FuzzBrowser;
    return { browser, window: random.pick(browser.windows) };
  };

  for (let step = 0; step < steps; step++) {
    const roll = random.int(100);
    if (roll < 55) {
      const { window } = someWindow();
      if (window) {
        const origin = (random.pick(ORIGINS) as (random: Random) => Origin | undefined)(random);
        const call = randomCommand(window.store, random);
        try {
          window.store.execute(call, origin === undefined ? {} : { origin });
        } catch {
          // Some random commands make no sense on some projects; the project stays as it was.
        }
      }
    } else if (roll < 70) {
      await time.advance(random.int(2000));
    } else if (roll < 76) {
      platform.drop((random.pick(browsers) as FuzzBrowser).tag);
    } else if (roll < 79) {
      platform.restart();
    } else if (roll < 83) {
      platform.faults.rejections.push({
        reason: random.chance(0.5) ? "busy" : "unavailable",
        retry: true,
      });
    } else if (roll < 88) {
      const browser = random.pick(browsers) as FuzzBrowser;
      if (browser.network.online) {
        browser.network.goOffline();
        platform.drop(browser.tag);
      } else {
        browser.network.online = true;
        browser.network.wake();
      }
    } else if (roll < 93) {
      const { browser, window } = someWindow();
      if (window) {
        await browser.close(window, { crash: random.chance(0.5) });
        if (browser.windows.length === 0 || random.chance(0.5)) await browser.open(id);
      }
    } else if (roll < 95) {
      const browser = random.pick(browsers) as FuzzBrowser;
      if (browser.windows.length < 3) await browser.open(id);
    } else if (roll < 96) {
      // A window looks at its link again, as after the project was connected or not elsewhere.
      const { browser, window } = someWindow();
      if (window) await browser.again(window);
    } else if (roll < 97) {
      if (losses === "platform") {
        const project = platform.projects.get(CLOUD_ID);
        const lowest = Math.max(project?.snapshot?.seq ?? 1, (project?.head ?? 1) - 8);
        if (project && project.head > lowest) {
          platform.restoreTo(CLOUD_ID, lowest + random.int(project.head - lowest));
        }
      } else if (losses === "log") {
        const browser = random.pick(browsers) as FuzzBrowser;
        if (await browser.breakEntry(id, random)) {
          const window = random.pick(browser.windows);
          if (window) {
            await browser.close(window);
            await browser.open(id);
          }
        }
      } else {
        // A change larger than one frame, which goes in parts.
        const { window } = someWindow();
        window?.store.execute({
          type: "file.write",
          params: {
            path: `code/big${random.int(3)}.js`,
            text: "b".repeat(1_200_000 + random.int(500_000)),
          },
        });
      }
    } else {
      // Silence for a while, as a connection that died without a word.
      platform.faults.silent = true;
      await time.advance(random.int(20_000));
      platform.faults.silent = false;
    }
    await time.advance(random.int(50));
  }

  // Everything back to normal, and time to catch up.
  platform.faults.silent = false;
  platform.faults.rejections.length = 0;
  for (const browser of browsers) {
    browser.network.online = true;
    if (browser.windows.length === 0) await browser.open(id);
    browser.network.wake();
  }
  for (let round = 0; round < 20; round++) await time.advance(30_000);

  const truth = kept(platform);
  const working = platform.workingCopy(CLOUD_ID);
  expect(truth.stateVector()).toEqual(working.stateVector());
  for (const browser of browsers) {
    for (const window of browser.windows) {
      const snapshot = window.cloud?.getSnapshot();
      expect({ window: window.name, state: snapshot?.state, pending: snapshot?.pending }).toEqual({
        window: window.name,
        state: "online",
        pending: 0,
      });
      expect(window.store.stateVector()).toEqual(truth.stateVector());
      expect(window.store.getState()).toEqual(truth.getState());
    }
  }
  // Nothing that any window did is missing on the platform.
  expect(isIn(truth, produced)).toBe(true);
  // Where nothing was lost, everything went as itself: comparing found nothing to send.
  if (losses === "none") expect(platform.effectiveRepairs).toBe(0);

  for (const browser of browsers) {
    while (browser.windows[0]) await browser.close(browser.windows[0]);
  }
}

/**
 * Disconnecting and connecting again, at random, in a browser with a few windows that go on with the
 * project meanwhile: each time a new project of the platform, whose first version is all the project
 * has. Logs get shorter all the time, also right while a link is made. In the end the last project
 * of the platform has everything any window did, and nothing had to be repaired on the way.
 */
export async function fuzzMoves(seed: number, steps = 160): Promise<void> {
  seedIds(seed);
  const random = randomFrom(seed);
  const time = new TestTime();
  const platform = new MemoryPlatform();
  platform.compactAfter = 5 + random.int(20);
  const produced: Uint8Array[] = [];
  const { id, state } = fixtureProject();
  const browser = new FuzzBrowser(platform, time, produced, 0);
  browser.compactAfter = 3;
  await browser.library.create({ id, name: "原子" }, state);
  let projects = 0;
  let current: string | undefined;

  /** As `CloudProjects.connect` does it, in one of the windows. */
  const connect = async () => {
    const window = random.pick(browser.windows);
    if (!window || !(await window.session.trySave())) return;
    await window.session.readLog();
    const entries = await window.session.journal.entries();
    if (!entries) throw new Error("no marks in the log");
    current = `move${++projects}`;
    await browser.links.put({
      key: id,
      platform: PLATFORM,
      project: current,
      seq: 0,
      pushed: entries.at(-1)?.mark ?? 0,
      linkedAt: time.now(),
      creating: true,
    });
    // The window that connected first, the others once they hear of it.
    await browser.again(window);
    for (const other of browser.windows) if (other !== window) await browser.again(other);
  };
  const disconnect = async () => {
    await browser.links.remove(id);
    current = undefined;
    for (const window of browser.windows) await browser.again(window);
  };

  await browser.open(id);
  await connect();
  for (let step = 0; step < steps; step++) {
    const roll = random.int(100);
    if (roll < 55) {
      const window = random.pick(browser.windows);
      if (window) {
        const origin = (random.pick(ORIGINS) as (random: Random) => Origin | undefined)(random);
        try {
          window.store.execute(
            randomCommand(window.store, random),
            origin === undefined ? {} : { origin },
          );
        } catch {
          // Some random commands make no sense on some projects.
        }
      }
    } else if (roll < 70) {
      await time.advance(random.int(2000));
    } else if (roll < 76) {
      platform.drop(browser.tag);
    } else if (roll < 79) {
      platform.restart();
    } else if (roll < 87) {
      const window = random.pick(browser.windows);
      if (window) {
        await browser.close(window, { crash: random.chance(0.5) });
        if (browser.windows.length === 0 || random.chance(0.5)) await browser.open(id);
      }
    } else if (roll < 91) {
      if (browser.windows.length < 3) await browser.open(id);
    } else if (roll < 96) {
      if (current === undefined) await connect();
      else await disconnect();
    } else {
      const window = random.pick(browser.windows);
      if (window) await browser.again(window);
    }
    await time.advance(random.int(50));
  }

  if (browser.windows.length === 0) await browser.open(id);
  if (current === undefined) await connect();
  for (let round = 0; round < 20; round++) await time.advance(30_000);

  const last = current as string;
  const truth = kept(platform, last);
  expect(truth.stateVector()).toEqual(platform.workingCopy(last).stateVector());
  for (const window of browser.windows) {
    const snapshot = window.cloud?.getSnapshot();
    expect({ window: window.name, state: snapshot?.state, pending: snapshot?.pending }).toEqual({
      window: window.name,
      state: "online",
      pending: 0,
    });
    expect(window.store.getState()).toEqual(truth.getState());
  }
  expect(isIn(truth, produced)).toBe(true);
  expect(platform.effectiveRepairs).toBe(0);
  while (browser.windows[0]) await browser.close(browser.windows[0]);
}
