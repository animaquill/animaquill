import { ProjectStore, aiTask, folderBatch, isEmptyUpdate, type Origin } from "@animaquill/core";
import { and, asc, desc, eq, gt } from "drizzle-orm";
import { expect } from "vitest";
import { randomCommand, randomFrom, seedIds, type Random } from "../../../core/src/fuzz-support.ts";
import { loadFixture } from "../../../schema/scripts/fixture.ts";
import { MemoryLines, TestNetwork, TestTime, settle } from "../../../ui/src/cloud/cloud-support.ts";
import { CloudSession } from "../../../ui/src/cloud/session.ts";
import { MemoryLibrary, memoryAddress } from "../../../ui/src/workbench/memory-library.ts";
import { ProjectSession, type SessionMessages } from "../../../ui/src/workbench/session.ts";
import { MemoryCloudLinks, newSyncId, type CloudAccess } from "@animaquill/host";
import { MemoryWriters } from "@animaquill/host/memory";
import type { TestDatabase } from "../test/database.ts";
import { hubConnection, someone, type LineFaults } from "../test/sync-support.ts";
import { projectSnapshots, projects, projectUpdates } from "../schema.ts";
import { SyncHub } from "./hub.ts";

/**
 * What editors.test.ts runs: the editor's sync (`CloudSession` of @animaquill/ui) against this
 * platform, on a real PostgreSQL:
 * browsers with windows that change a project at random while connections drop, browsers go
 * offline, windows reload or go, the platform restarts, and turns changes away when they come too
 * fast. In the end every window has what the database has, and nothing any window did is missing
 * from it. Needs AQ_TEST_DATABASE, see vitest.config.ts.
 */

const quiet = { info() {}, warn() {}, error() {} };
const MESSAGES: SessionMessages = {
  createFailed() {},
  notFound() {},
  openFailed() {},
  tooNew() {},
  damaged() {},
  saveFailed() {},
  saveRecovered() {},
};
const PLATFORM = "https://editor.example.com";

interface Window {
  readonly name: string;
  readonly session: ProjectSession;
  readonly store: ProjectStore;
  readonly cloud: CloudSession;
  readonly page: { alive: boolean; isAlive: () => boolean; asleep: boolean };
}

/** The platform, which restarts as a new hub on the same database. */
class Platform {
  hub: SyncHub;
  readonly faults: LineFaults = { silent: false };
  readonly lines = new Set<ReturnType<typeof hubConnection>>();

  readonly database: TestDatabase;
  readonly time: TestTime;
  readonly limits: ConstructorParameters<typeof SyncHub>[0]["limits"];

  constructor(
    database: TestDatabase,
    time: TestTime,
    limits: ConstructorParameters<typeof SyncHub>[0]["limits"],
  ) {
    this.database = database;
    this.time = time;
    this.limits = limits;
    this.hub = this.#newHub();
  }

  #newHub(): SyncHub {
    return new SyncHub({
      db: this.database.db,
      log: quiet,
      now: () => new Date(this.time.now()),
      ...(this.limits && { limits: this.limits }),
    });
  }

  restart(): void {
    this.hub.stop();
    this.hub = this.#newHub();
  }
}

class Browser {
  readonly library = new MemoryLibrary();
  readonly links = new MemoryCloudLinks();
  readonly writers = new MemoryWriters();
  readonly lines = new MemoryLines();
  readonly windows: Window[] = [];
  readonly network: TestNetwork;
  readonly connections = new Set<ReturnType<typeof hubConnection>>();
  #pages = 0;

  readonly platform: Platform;
  readonly who: Awaited<ReturnType<typeof someone>>;
  readonly produced: Uint8Array[];
  readonly index: number;

  constructor(
    platform: Platform,
    who: Awaited<ReturnType<typeof someone>>,
    produced: Uint8Array[],
    index: number,
  ) {
    this.platform = platform;
    this.who = who;
    this.produced = produced;
    this.index = index;
    this.network = new TestNetwork(platform.time);
  }

  access(page: Window["page"]): CloudAccess {
    return {
      platform: PLATFORM,
      connect: () => {
        const line = hubConnection(this.platform.hub, this.who, this.platform.faults);
        this.connections.add(line);
        void line.closed.then(() => this.connections.delete(line));
        return line;
      },
      list: async () => [],
      links: this.links,
      syncer: (key) => this.writers.writer(`cloud.${key}`, page),
      line: (key) => this.lines.line(key),
    };
  }

  /** Drops every connection of the browser, as its network going away. */
  drop(): void {
    for (const line of Array.from(this.connections)) line.drop();
  }

  async open(id: string): Promise<Window> {
    const name = `b${this.index}w${++this.#pages}`;
    const page = { alive: true, isAlive: () => page.alive, asleep: false };
    const session = new ProjectSession(this.library, memoryAddress(), MESSAGES, {
      window: name,
      compactThrough: async (key) => (await this.links.get(key))?.pushed,
    });
    if (!(await session.open(id))) throw new Error("did not open");
    const store = session.store as ProjectStore;
    store.onLocalUpdate((update, origin) => {
      if (!origin.startsWith("cloud:")) this.produced.push(update);
    });
    const link = await this.links.get(id);
    if (!link) throw new Error("no link");
    const cloud = new CloudSession({
      store,
      journal: session.journal,
      cloud: this.access(page),
      link,
      window: name,
      editor: "test",
      environment: this.network,
      timing: {
        scanMs: 5,
        noteMs: 100,
        pingMs: 4000,
        deadMs: 2000,
        steadyMs: 2000,
        firstRetryMs: 200,
        longestRetryMs: 4000,
        helloMs: 10_000,
      },
      onSeq: (seq) => {
        session.cloudSeq = seq;
      },
      ...(link.creating && {
        create: { name: "原子", projectId: store.getState().manifest.id },
      }),
    });
    const window = { name, session, store, cloud, page };
    this.windows.push(window);
    cloud.start();
    return window;
  }

  async close(window: Window, { crash = false } = {}): Promise<void> {
    const at = this.windows.indexOf(window);
    if (at >= 0) this.windows.splice(at, 1);
    const before = crash ? await this.links.get(window.session.key ?? "") : undefined;
    await window.cloud.close();
    await window.session.close();
    window.page.alive = false;
    this.writers.sweep();
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

function fixture(): { state: Uint8Array; id: string } {
  const files = loadFixture("v1");
  const manifest = JSON.parse(files.get("animaquill.json") as string);
  delete manifest.tags;
  files.set("animaquill.json", JSON.stringify(manifest));
  const store = ProjectStore.open(files).store as ProjectStore;
  const result = { state: store.encodeState(), id: store.getState().manifest.id };
  store.destroy();
  return result;
}

/** The project as the database has it, as a restarted platform reads it. */
async function kept(database: TestDatabase, id: string): Promise<ProjectStore> {
  const [snapshot] = await database.db
    .select({ seq: projectSnapshots.seq, state: projectSnapshots.state })
    .from(projectSnapshots)
    .where(and(eq(projectSnapshots.projectId, id), eq(projectSnapshots.reason, "compact")))
    .orderBy(desc(projectSnapshots.seq))
    .limit(1);
  const rows = await database.db
    .select({ data: projectUpdates.data })
    .from(projectUpdates)
    .where(and(eq(projectUpdates.projectId, id), gt(projectUpdates.seq, snapshot?.seq ?? 0)))
    .orderBy(asc(projectUpdates.seq));
  const { store } = ProjectStore.fromUpdates([
    ...(snapshot ? [snapshot.state] : []),
    ...rows.map((row) => row.data),
  ]);
  if (!store || store.isMissingUpdates) throw new Error("what the database has does not open");
  return store;
}

/**
 * The editor's sync against the platform at random, see editors.test.ts. A failure can be found
 * again from its seed.
 */
export async function runEditors(
  database: TestDatabase,
  seed: number,
  steps: number,
): Promise<void> {
  seedIds(seed);
  const random = randomFrom(seed);
  const time = new TestTime();
  const platform = new Platform(database, time, {
    compactUpdates: 8 + random.int(30),
    // Changes that come too fast get turned away, to come again later.
    messagesPerMinute: 6 + random.int(10),
  });
  const advance = async (ms: number) => {
    const end = time.now() + ms;
    while (time.now() < end) {
      await time.advance(Math.min(250, end - time.now()));
      await platform.hub.idle();
      await settle();
    }
  };
  const ada = await someone(database.db);
  const produced: Uint8Array[] = [];
  const { id, state } = fixture();
  const cloudId = newSyncId();
  const browsers = [0, 1, 2].map((index) => new Browser(platform, ada, produced, index));
  const [first] = browsers as [Browser];
  await first.library.create({ id, name: "原子" }, state);
  const mark = (await (await first.library.open(id)).entries?.())?.at(-1)?.mark ?? 0;
  await first.links.put({
    key: id,
    platform: PLATFORM,
    project: cloudId,
    seq: 0,
    pushed: mark,
    linkedAt: 1,
    creating: true,
  });
  await first.open(id);
  await advance(1000);
  for (const browser of browsers.slice(1)) {
    // As opening it from the platform does.
    const now = await kept(database, cloudId);
    const [row] = await database.db
      .select({ head: projects.head })
      .from(projects)
      .where(eq(projects.id, cloudId));
    await browser.library.create({ id, name: "原子" }, now.encodeState());
    const last = (await (await browser.library.open(id)).entries?.())?.at(-1)?.mark ?? 0;
    await browser.links.put({
      key: id,
      platform: PLATFORM,
      project: cloudId,
      seq: row?.head ?? 0,
      pushed: last,
      linkedAt: 1,
    });
    await browser.open(id);
  }

  const someWindow = () => {
    const browser = random.pick(browsers) as Browser;
    return { browser, window: random.pick(browser.windows) };
  };

  for (let step = 0; step < steps; step++) {
    const roll = random.int(100);
    if (roll < 55) {
      const { window } = someWindow();
      if (window) {
        const origin = (random.pick(ORIGINS) as (random: Random) => Origin | undefined)(random);
        try {
          window.store.execute(randomCommand(window.store, random), origin ? { origin } : {});
        } catch {
          // Some random commands make no sense on some projects.
        }
      }
    } else if (roll < 68) {
      await advance(random.int(1500));
    } else if (roll < 74) {
      (random.pick(browsers) as Browser).drop();
    } else if (roll < 77) {
      platform.restart();
    } else if (roll < 83) {
      const browser = random.pick(browsers) as Browser;
      if (browser.network.online) {
        browser.network.goOffline();
        browser.drop();
      } else {
        browser.network.online = true;
        browser.network.wake();
      }
    } else if (roll < 89) {
      const { browser, window } = someWindow();
      if (window) {
        await browser.close(window, { crash: random.chance(0.5) });
        if (browser.windows.length === 0 || random.chance(0.5)) await browser.open(id);
      }
    } else if (roll < 93) {
      const browser = random.pick(browsers) as Browser;
      if (browser.windows.length < 3) await browser.open(id);
    } else if (roll < 97) {
      platform.faults.silent = true;
      await advance(random.int(8000));
      platform.faults.silent = false;
    } else {
      // A change arrives broken: the platform turns it away, and that window stops syncing
      // until people try again, with everything kept.
      platform.faults.breaking = 1;
    }
    await advance(random.int(100));
    // People press "retry" now and then, as the status bar offers.
    if (random.chance(0.05)) {
      for (const browser of browsers) for (const window of browser.windows) window.cloud.resume();
    }
  }

  platform.faults.silent = false;
  platform.faults.breaking = 0;
  for (const browser of browsers) {
    browser.network.online = true;
    if (browser.windows.length === 0) await browser.open(id);
    browser.network.wake();
  }
  await advance(30_000);
  // What stopped at a change that was turned away goes on once people try again.
  for (const browser of browsers) for (const window of browser.windows) window.cloud.resume();
  await advance(150_000);

  const truth = await kept(database, cloudId);
  for (const browser of browsers) {
    for (const window of browser.windows) {
      const snapshot = window.cloud.getSnapshot();
      expect({ window: window.name, state: snapshot.state, pending: snapshot.pending }).toEqual({
        window: window.name,
        state: "online",
        pending: 0,
      });
      expect(window.store.stateVector()).toEqual(truth.stateVector());
      expect(window.store.getState()).toEqual(truth.getState());
    }
  }
  // Nothing any window did is missing from what the platform keeps.
  const copy = ProjectStore.fromUpdates([truth.encodeState()]).store as ProjectStore;
  for (const update of produced) {
    const { delta } = copy.applyChecked(update, "check");
    expect(delta === undefined || isEmptyUpdate(delta)).toBe(true);
  }
  for (const browser of browsers) {
    for (const window of Array.from(browser.windows)) await browser.close(window);
  }
  platform.hub.stop();
}
