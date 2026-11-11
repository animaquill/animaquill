/**
 * Renaming a project of the platform from the start page, without opening it (the design of the
 * start page, 6.6), against a platform in memory: what the link then says waits, and what another
 * device did meanwhile.
 */
import { ProjectStore, type CommandCall } from "@animaquill/core";
import { type CloudLink } from "@animaquill/host";
import { afterEach, describe, expect, it } from "vitest";
import { loadFixture } from "../../../schema/scripts/fixture.ts";
import { MemoryLibrary, memoryAddress } from "../workbench/memory-library.ts";
import { ProjectSession, type SessionMessages } from "../workbench/session.ts";
import { MemoryPlatform, TestCloudBrowser, TestTime } from "../cloud/cloud-support.ts";
import { CloudSession, isOnPlatform, type CloudTiming } from "../cloud/session.ts";
import { renameUnopened } from "./rename.ts";

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

class Browser extends TestCloudBrowser {
  readonly library = new MemoryLibrary();
  #pages = 0;
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
  ): Promise<Win> {
    const name = `w${++this.#pages}`;
    const page = { isAlive: () => !window.gone, asleep: false };
    const session = new ProjectSession(this.library, memoryAddress(), MESSAGES, { window: name });
    if (!(await session.open(id))) throw new Error("did not open");
    const store = session.store as ProjectStore;
    let link = await this.links.get(id);
    if (!link) throw new Error("no link");
    if (options.create && !link.creating) {
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
    cloud.start();
    return window;
  }
}

interface Win {
  readonly session: ProjectSession;
  readonly store: ProjectStore;
  readonly cloud: CloudSession;
  readonly page: { isAlive: () => boolean; asleep: boolean };
  gone: boolean;
}

const rename = (name: string): CommandCall => ({ type: "project.rename", params: { name } });
const fps = (value: string): CommandCall => ({
  type: "project.setFrameRate",
  params: { fps: value },
});

const opened: Win[] = [];
afterEach(async () => {
  for (const w of opened.splice(0)) {
    await w.cloud.close();
    await w.session.close();
  }
});

async function start(time: TestTime, timing?: Partial<CloudTiming>) {
  const platform = new MemoryPlatform();
  const { id, state } = fixtureState();
  const first = new Browser(platform, "ada");
  await first.project(id, state);
  const a = await first.open(id, time, { create: true, ...(timing && { timing }) });
  opened.push(a);
  await time.advance(100);
  return { platform, id, first, a };
}

/** What taking the copy away counts: what the log has after `pushed`, not from the platform. */
async function countedByRemove(browser: Browser, id: string): Promise<number> {
  const link = await browser.links.get(id);
  const log = await browser.library.open(id);
  const entries = (await log.entries?.()) ?? [];
  log.close();
  return entries.filter((entry) => entry.mark > (link?.pushed ?? 0) && !isOnPlatform(entry)).length;
}

describe("renaming a project of the platform that is not open here", () => {
  it("changes only the name, also where the copy here is far behind the platform", async () => {
    const time = new TestTime();
    const { platform, id, first, a } = await start(time);
    // This computer closes the project.
    await a.cloud.close();
    await a.session.close();
    opened.splice(0);
    // Another computer changes its frame rate and its name later.
    const second = new Browser(platform, "ada");
    await second.fromPlatform(id);
    const b = await second.open(id, time);
    opened.push(b);
    await time.advance(100);
    expect(b.store.execute(fps("25")).ok).toBe(true);
    expect(b.store.execute(rename("别处改的名字")).ok).toBe(true);
    await time.advance(200);
    // This computer renames it on the start page, with a copy that has neither.
    expect(
      await renameUnopened(id, "开始页改的名字", {
        projects: first.library,
        links: first.links,
        window: "start",
      }),
    ).toBe("renamed");
    expect((await first.links.get(id))?.pending).toBe(1);
    // It syncs the next time it opens.
    const again = await first.open(id, time);
    opened.push(again);
    await time.advance(500);
    const there = platform.workingCopy(CLOUD_ID).getState().manifest;
    // The frame rate of the other computer stays.
    expect(there.fps).toBe("25");
    expect(again.store.getState().manifest.fps).toBe("25");
    // Both changed the name at once: Yjs settles on one, the same everywhere.
    expect(again.store.getState().manifest.name).toBe(there.name);
    expect(b.store.getState().manifest.name).toBe(there.name);
    expect(again.cloud.getSnapshot().pending).toBe(0);
  });

  it("says nothing waits once the window that has the project open synced the new name", async () => {
    const time = new TestTime();
    const { platform, id, first, a } = await start(time);
    await time.advance(200);
    expect((await first.links.get(id))?.pending ?? 0).toBe(0);
    expect(
      await renameUnopened(id, "开着时改的", { projects: first.library, links: first.links }),
    ).toBe("renamed");
    await time.advance(500);
    // The open window gets it, and sends it.
    expect(a.store.getState().manifest.name).toBe("开着时改的");
    expect(platform.workingCopy(CLOUD_ID).getState().manifest.name).toBe("开着时改的");
    expect(a.cloud.getSnapshot().pending).toBe(0);
    // The link says so as well, which is what the card shows: the window notes what it counts,
    // whatever it noted before another window wrote.
    expect((await first.links.get(id))?.pending).toBe(0);
    await a.cloud.close();
    expect((await first.links.get(id))?.pending).toBe(0);
    expect(await countedByRemove(first, id)).toBe(0);
  });
});

describe("what waits, right after the connection went", () => {
  it("does not count what the platform took just before, nor anything less than what it did not take", async () => {
    const time = new TestTime();
    // A second between looks at the log, so that the connection surely goes after the platform took
    // a change and before the next look: 30 ms for people.
    const { id, first, a } = await start(time, { scanMs: 1000, noteMs: 50 });
    await time.advance(3000);
    expect(a.store.execute(rename("第二个名字")).ok).toBe(true);
    // Sent after a second, and taken at once; the next look is a second later.
    await time.advance(1010);
    time.goOffline();
    await time.advance(10);
    expect(a.store.execute(rename("离线时的名字")).ok).toBe(true);
    expect(await a.session.trySave()).toBe(true);
    await time.advance(3000);
    const shown = a.cloud.getSnapshot().pending;
    await a.cloud.close();
    await a.session.close();
    opened.splice(0);
    const link = await first.links.get(id);
    const counted = await countedByRemove(first, id);
    // Only the change made without a connection: not the one the platform has.
    expect(shown).toBe(1);
    expect(link?.pending).toBe(1);
    expect(counted).toBe(1);
  });
});
