/**
 * The random test of taking copies back (the plan of the redesign, 13.7): devices change a project
 * at random, each one on its own file and now and then all over, go offline and come back, close and
 * open it; the platform archives it now and then, lets go of its working copy at random, archived
 * or not, and makes it again from the archive once somebody opens it; each device that comes back
 * takes its copy back. In the end every device is back on the platform, and:
 *
 * - every change a device made to its own file is there, as nobody else changes that file and
 *   people only choose the other side for files that are not their own: nothing that was ever on a
 *   device is lost; and
 * - no device took what others did back to what it had before, as it would where it took the
 *   archive for what it had in common with the new copy after it was away for long: what came in
 *   by itself of another device's file is never an older write of it than the platform had.
 */
import { ProjectStore, type CommandCall } from "@animaquill/core";
import type { CloudConnection, CloudLink } from "@animaquill/host";
import { describe, expect, it } from "vitest";
import { randomCommand, randomFrom, seedIds, type Random } from "../../../core/src/fuzz-support.ts";
import { loadFixture } from "../../../schema/scripts/fixture.ts";
import { MemoryLibrary, memoryAddress } from "../workbench/memory-library.ts";
import { ProjectSession, type SessionMessages } from "../workbench/session.ts";
import { MemoryPlatform, TestCloudBrowser, TestTime, statusFor } from "./cloud-support.ts";
import { isSettled, type ReconcileChoices } from "./reconcile.ts";
import { CloudSession } from "./session.ts";
import {
  KEEP_BACKUP_MS,
  TakeBack,
  dropKept,
  settleRenewal,
  settleTakeBack,
  type ChooseTakeBack,
} from "./take-back.ts";

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
const DEVICES = 3;

const fileOf = (device: number) => `code/d${device}.js`;
const DEVICE_FILE = /^code\/d(\d+)\.js$/;
/** Which write of its device a text of a device's file is: 0 for how it started. */
const writeOf = (text: string | undefined) => Number(text?.split(":")[1] ?? 0);

function fixture(): { id: string; state: Uint8Array } {
  const files = loadFixture("v1");
  const manifest = JSON.parse(files.get("animaquill.json") as string);
  delete manifest.tags;
  files.set("animaquill.json", JSON.stringify(manifest));
  for (let device = 0; device < DEVICES; device++) files.set(fileOf(device), "start\n");
  const { store } = ProjectStore.open(files);
  if (!store) throw new Error("fixture did not open");
  const id = store.getState().manifest.id;
  const state = store.encodeState();
  store.destroy();
  return { id, state };
}

interface Open {
  readonly session: ProjectSession;
  readonly store: ProjectStore;
  readonly cloud: CloudSession;
}

/** A device: a browser with one copy of the project, and at most one window on it. */
class Device extends TestCloudBrowser {
  readonly library = new MemoryLibrary();
  readonly index: number;
  readonly key: string;
  readonly time: TestTime;
  offline = false;
  window: Open | undefined;
  #pages = 0;
  /** What it wrote to its own file last, and how many times it did. */
  latest = "start\n";
  writes = 0;

  constructor(platform: MemoryPlatform, index: number, key: string, time: TestTime) {
    super(platform, "ada");
    this.index = index;
    this.key = key;
    this.time = time;
  }

  /** The platform as this device reaches it: not at all while it is offline. */
  reach() {
    const access = this.access({ isAlive: () => true, asleep: false });
    return {
      ...access,
      connect: (): CloudConnection => {
        if (!this.offline) return access.connect();
        const closed = Promise.resolve({ code: 1006, reason: "" });
        return {
          opened: Promise.resolve(),
          closed,
          send() {},
          onMessage() {},
          close() {},
        };
      },
    };
  }

  async keep(state: Uint8Array, link: Partial<CloudLink>): Promise<void> {
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

  async open(create = false): Promise<Open> {
    if (this.window) return this.window;
    // What a page left halfway is settled before the project syncs again, see `CloudProjects`.
    const link = await this.links.get(this.key);
    if (link?.renewing) await settleRenewal(this.reach(), this.library, link);
    const name = `d${this.index}w${++this.#pages}`;
    const session = new ProjectSession(this.library, memoryAddress(), MESSAGES, { window: name });
    if (!(await session.open(this.key))) throw new Error("did not open");
    const store = session.store as ProjectStore;
    let now = await this.links.get(this.key);
    if (!now) throw new Error("no link");
    if (create) {
      now = { ...now, creating: true };
      await this.links.put(now);
    }
    const cloud = new CloudSession({
      store,
      journal: session.journal,
      cloud: this.reach(),
      link: now,
      window: name,
      editor: "test",
      environment: this.time,
      timing: { scanMs: 5, noteMs: 50, longestRetryMs: 4000, steadyMs: 2000 },
      onSeq: (seq) => {
        session.cloudSeq = seq;
      },
      ...(create && { create: { name: "原子", projectId: store.getState().manifest.id } }),
    });
    cloud.start();
    this.window = { session, store, cloud };
    return this.window;
  }

  async close(): Promise<void> {
    const window = this.window;
    this.window = undefined;
    if (!window) return;
    await window.cloud.close();
    await window.session.close();
  }

  /** Writes its own file, as a change of the person. */
  write(random: Random): void {
    const store = this.window?.store;
    if (!store || store.readOnly) return;
    const text = `d${this.index}:${++this.writes}:${random.int(1000)}\n`;
    const call: CommandCall = { type: "file.write", params: { path: fileOf(this.index), text } };
    if (store.execute(call).ok) this.latest = text;
  }

  /**
   * A person who comes back: takes the copy back where syncing says it is of the copy before, and
   * opens the project again. They keep what they did to their own file, and take what the platform
   * has of the rest.
   */
  async takeBack(
    declined: Set<string>,
    goesAway?: "beforeLog" | "afterLog",
    reverted: string[] = [],
  ): Promise<boolean> {
    const window = this.window;
    if (window?.cloud.getSnapshot().problem?.kind !== "rebuilt") return false;
    // What the platform has as this begins: nothing else changes it meanwhile, as time stands.
    const there =
      this.platform.projects.get(CLOUD_ID)?.copy === "live"
        ? this.platform.workingCopy(CLOUD_ID).getState().files
        : undefined;
    const choose: ChooseTakeBack = async (plan) => {
      const choices: ReconcileChoices = new Map(
        plan.differences.map(({ path }) => [path, path === fileOf(this.index) ? "here" : "cloud"]),
      );
      const settled = settleTakeBack(plan, choices);
      if (!isSettled(settled)) throw new Error(`did not settle: ${JSON.stringify(settled)}`);
      for (const [path, side] of choices)
        if (side === "cloud") declined.add(`${this.index}:${path}`);
      return { choices, settled };
    };
    const generation = (await this.links.get(this.key))?.generation ?? 1;
    // The page goes away halfway: before the log started anew, or right after, before the link
    // went on. Whoever opens the project next settles it.
    const reach = this.reach();
    if (goesAway === "beforeLog") this.library.renewNeverEnds = true;
    const links = reach.links;
    const cloud =
      goesAway === "afterLog"
        ? {
            ...reach,
            links: new Proxy(links, {
              get: (target, property) => {
                const value = Reflect.get(target, property) as unknown;
                if (property === "update") {
                  return (...args: Parameters<typeof links.update>) =>
                    args[2].renewed !== undefined
                      ? Promise.reject(new Error("the page went away"))
                      : target.update(...args);
                }
                return typeof value === "function" ? value.bind(target) : value;
              },
            }),
          }
        : reach;
    const running = new TakeBack({
      cloud,
      projects: this.library,
      status: statusFor(this),
      window: "take-back",
      editor: "test",
    }).run({
      key: this.key,
      project: CLOUD_ID,
      store: window.store,
      generation,
      saved: async () => {
        await window.session.journal.readLog();
        return window.session.journal.saved();
      },
      entries: async () => (await window.session.journal.entries()) ?? [],
      choose,
    });
    if (goesAway === "beforeLog") {
      // Gone while the log would start anew: as far as the link said it was on its way.
      for (let tries = 0; tries < 50 && !(await this.links.get(this.key))?.renewing; tries++)
        await this.time.advance(10);
      this.library.renewNeverEnds = false;
      void running;
      await this.close();
      await this.open();
      return true;
    }
    const outcome = await running;
    // What came in by itself of a file of another device is never older than what the platform
    // had: that would take what the other one did back to before.
    if (outcome.kind === "renewed" && there) {
      for (const path of outcome.merged) {
        const owner = DEVICE_FILE.exec(path)?.[1];
        if (owner === undefined || Number(owner) === this.index) continue;
        const mine = window.store.getState().files[path];
        if (writeOf(mine) < writeOf(there[path]))
          reverted.push(`d${this.index} took ${path} back to ${mine} from ${there[path]}`);
      }
    }
    if (outcome.kind === "renewed" || outcome.kind === "already") {
      await this.close();
      await this.open();
      return true;
    }
    if (outcome.kind === "failed" && outcome.why !== "library") {
      throw new Error(`taking back failed: ${JSON.stringify(outcome)}`);
    }
    return false;
  }
}

async function run(seed: number): Promise<void> {
  seedIds(seed);
  const random = randomFrom(seed);
  const time = new TestTime();
  const platform = new MemoryPlatform();
  platform.compactAfter = 25;
  platform.repositories.set(CLOUD_ID, { id: 7, owner: "ada", name: "atom" });
  const { id, state } = fixture();
  const devices = Array.from(
    { length: DEVICES },
    (_, index) => new Device(platform, index, id, time),
  );
  const [first] = devices as [Device];
  await first.keep(state, {});
  const made = await first.open(true);
  await time.advance(500);
  if (!platform.projects.has(CLOUD_ID)) throw new Error(JSON.stringify(made.cloud.getSnapshot()));
  // Linking the repository archived it first, as it always does.
  platform.archive(CLOUD_ID);
  for (const device of devices.slice(1)) {
    const project = platform.projects.get(CLOUD_ID);
    if (!project) throw new Error("not on the platform");
    await device.keep(platform.workingCopy(CLOUD_ID).encodeState(), {
      seq: project.head,
      generation: project.generation,
    });
    await device.open();
  }
  await time.advance(500);
  /** What people let go of in a dialog: `<device>:<path>`. */
  const declined = new Set<string>();
  /** Files of other devices that a device took back to before, see `Device.takeBack`. */
  const reverted: string[] = [];
  const releases = { archived: 0, unarchived: 0 };

  for (let step = 0; step < 200; step++) {
    const device = random.pick(devices) as Device;
    const roll = random.int(100);
    if (roll < 35) {
      device.write(random);
    } else if (roll < 41) {
      // Some other change of the project, anywhere.
      const store = device.window?.store;
      if (store && !store.readOnly) {
        try {
          // Never on the file of a device: the checks below take only it to change that.
          const call = randomCommand(store, random);
          const { path, from, to } = (call.params ?? {}) as Record<string, unknown>;
          if (![path, from, to].some((each) => typeof each === "string" && DEVICE_FILE.test(each)))
            store.execute(call);
        } catch {
          // Some random commands make no sense on some projects.
        }
      }
    } else if (roll < 58) {
      await time.advance(random.int(20_000));
    } else if (roll < 70) {
      device.offline = !device.offline;
      if (device.offline) platform.drop(device.tag);
    } else if (roll < 79) {
      if (device.window) await device.close();
      else await device.open();
    } else if (roll < 91) {
      const project = platform.projects.get(CLOUD_ID);
      if ((project?.copy ?? "live") === "live") platform.archive(CLOUD_ID);
    } else if (roll < 96) {
      const project = platform.projects.get(CLOUD_ID);
      if ((project?.copy ?? "live") === "live") {
        const behind =
          project !== undefined && (platform.archivedSeq.get(CLOUD_ID) ?? 0) < project.head;
        releases[behind ? "unarchived" : "archived"] += 1;
        platform.release(CLOUD_ID);
      }
    } else {
      // The browser cannot keep what it took back, once.
      device.library.failingToRenew = true;
      await device.takeBack(declined);
      device.library.failingToRenew = false;
    }
    await time.advance(random.int(100));
    // Whoever hears that the copy was made again takes it back, as the editor does at once.
    // Now and then the page goes away while it does.
    for (const each of devices) {
      if (!random.chance(0.7)) continue;
      const goesAway = random.chance(0.2)
        ? random.chance(0.5)
          ? ("beforeLog" as const)
          : ("afterLog" as const)
        : undefined;
      await each.takeBack(declined, goesAway, reverted);
    }
  }

  // Everybody comes back.
  for (const device of devices) {
    device.offline = false;
    await device.open();
  }
  time.wake();
  for (let round = 0; round < 12; round++) {
    await time.advance(30_000);
    for (const device of devices) await device.takeBack(declined, undefined, reverted);
  }
  await time.advance(60_000);

  for (const device of devices) {
    const snapshot = device.window?.cloud.getSnapshot();
    expect({
      device: device.index,
      state: snapshot?.state,
      pending: snapshot?.pending,
      copy: platform.projects.get(CLOUD_ID)?.copy ?? "live",
    }).toEqual({ device: device.index, state: "online", pending: 0, copy: "live" });
    // What the log had before it went on the new copy goes once the platform has what came of it.
    await dropKept(device.reach(), device.library, device.key, Date.now() + 2 * KEEP_BACKUP_MS);
    expect(await device.library.backups(device.key)).toEqual([]);
  }
  const files = platform.workingCopy(CLOUD_ID).getState().files;
  for (const device of devices) {
    // Nothing a device did to its own file is lost, and nobody took it back to before.
    if (!declined.has(`${device.index}:${fileOf(device.index)}`)) {
      expect({ device: device.index, file: files[fileOf(device.index)] }).toEqual({
        device: device.index,
        file: device.latest,
      });
    }
    // Every device has what the platform has.
    expect(device.window?.store.getState().files).toEqual(files);
  }
  expect(reverted).toEqual([]);
  expect(releases.archived + releases.unarchived).toBeGreaterThan(0);
}

describe("taking copies back onto copies made again from the repository, at random", () => {
  // `FUZZ_SEEDS=200` for many more, as on the test machine, split over processes that each take
  // the seeds `FUZZ_SHARD` of `FUZZ_SHARDS` (every n-th).
  const count = Number(process.env["FUZZ_SEEDS"] ?? 8);
  const shards = Number(process.env["FUZZ_SHARDS"] ?? 1);
  const shard = Number(process.env["FUZZ_SHARD"] ?? 0);
  const seeds = Array.from({ length: count }, (_, index) => index + 1);
  for (const seed of seeds.filter((each) => each % shards === shard)) {
    it(`loses nothing a device did, and takes nothing back to before (seed ${seed})`, async () => {
      await run(seed);
    }, 60_000);
  }
});
