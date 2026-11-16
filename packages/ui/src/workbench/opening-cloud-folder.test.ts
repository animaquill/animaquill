/**
 * Opening a project of the platform that has a folder on this computer, which is a clone of the
 * repository the platform saves to: while the editor was away, people committed and pushed a change
 * in the folder, and the platform merged it from GitHub, so the same change comes from both. What
 * the platform has comes first, and the folder after it, so that it comes in once, see
 * `ProjectOpening` and the design of data and syncing (AnimaQuill Cloud), 2.5.
 */
import { memoryOrganizer } from "@animaquill/host";
import type { FolderAccess, Host } from "@animaquill/host";
import { MemoryDisk, memoryFolders } from "@animaquill/host/memory";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryPlatform, TestCloudBrowser, TestTime } from "../cloud/cloud-support.ts";
import type { CloudEnvironment } from "../cloud/session.ts";
import { account } from "../cloud/projects-support.ts";
import { filesOf } from "../folder/folder-support.ts";
import type { DialogRequest } from "./dialogs.ts";
import { FAST, written } from "./folder-windows.ts";
import { layouts } from "./layouts.ts";
import {
  MemoryExports,
  MemoryLibrary,
  MemoryPresence,
  MemoryTrials,
  memoryAddress,
  memoryWindow,
} from "./memory-library.ts";
import type { OpeningTiming } from "./opening.ts";
import { Workbench } from "./workbench.ts";

const FOLDER = "文档/片子";
const CODE = "code/动画.js";
/** The file as everybody had it when the editor here went away. */
const BEFORE = "const a = 1;\nconst b = 2;\nconst c = 3;\n";
/** What another computer changed meanwhile, which the platform has. */
const ELSEWHERE = "const a = 1;\n// 另一台电脑\nconst b = 2;\nconst c = 3;\n";
/** What people committed in the folder and pushed. */
const PUSHED = "const a = 1;\nconst b = 2;\nconst c = 3;\nconst d = 4;\n";
/** What the platform made of the two, as it merges what changed on GitHub. */
const MERGED = "const a = 1;\n// 另一台电脑\nconst b = 2;\nconst c = 3;\nconst d = 4;\n";

const noFolders: FolderAccess = {
  chooseSource: async () => undefined,
  chooseTarget: async () => undefined,
  saveFile: () => {},
  chooseFile: async () => undefined,
  reopen: async () => "gone" as const,
  dropTarget: async () => false,
  savesInBrowser: false,
};

const opened: Workbench[] = [];
afterEach(async () => {
  for (const workbench of opened.splice(0)) await leave(workbench);
});

interface WindowOptions {
  readonly opening?: Partial<OpeningTiming>;
  readonly environment?: CloudEnvironment;
}

/** A browser of somebody signed in to the platform, on a computer with a disk of its own. */
function browserOn(platform: MemoryPlatform) {
  const disk = new MemoryDisk();
  const library = new MemoryLibrary();
  const presence = new MemoryPresence();
  const cloud = new TestCloudBrowser(platform, "ada");
  const values = new Map<string, unknown>();
  const trials = new MemoryTrials();
  const drafts = new MemoryTrials();
  const organizer = memoryOrganizer();
  const window = ({ opening, environment }: WindowOptions = {}) => {
    const host: Host = {
      projects: library,
      address: memoryAddress(),
      windowMemory: memoryWindow(),
      organizer,
      settings: {
        load: async (key) => values.get(key),
        save: async (key, value) => void values.set(key, value),
        listen: () => () => {},
      },
      folders: noFolders,
      localFolders: memoryFolders(disk),
      trials,
      drafts,
      exports: new MemoryExports(),
      presence: presence.window(),
      account: account(),
      cloud: cloud.access({ isAlive: () => true, asleep: false }),
    };
    const workbench = new Workbench({
      host,
      t: ((key: string, words?: Record<string, unknown>) =>
        words ? `${key} ${JSON.stringify(words)}` : key) as never,
      version: "test",
      platform: "other",
      panels: [],
      layouts,
      compositorUrl: "",
      folderTiming: FAST,
      cloudTiming: { scanMs: 5, noteMs: 20, firstRetryMs: 20, helloMs: 2000 },
      ...(opening && { openingTiming: opening }),
      ...(environment && { cloudEnvironment: environment }),
    });
    opened.push(workbench);
    return workbench;
  };
  return { disk, library, links: cloud.links, window };
}

/**
 * Opens the project of `key` in `again` with the platform slow to answer: until it has the project
 * open, its folder there, and a while for the folder to be compared, should that not wait. Then
 * the platform answers, and the project opens.
 */
async function openWithSlowPlatform(platform: MemoryPlatform, again: Workbench, key: string) {
  const time = new TestTime();
  platform.faults.line = { time, bytesPerSecond: 1_000_000 };
  const opening = again.openProject(key);
  await vi.waitFor(() => expect(again.projectFolders?.getSnapshot().open).toBeDefined());
  await new Promise((resolve) => setTimeout(resolve, 500));
  const before = {
    step: again.opening.getSnapshot().step,
    code: again.session.store?.getState().files[CODE],
  };
  await time.advance(5000);
  delete platform.faults.line;
  await time.advance(5000);
  await opening;
  return before;
}

/** Answers each question as people would: yes. */
function answering(workbench: Workbench) {
  workbench.dialogs.subscribe(() => {
    const request: DialogRequest | undefined = workbench.dialogs.getSnapshot();
    if (!request || request.kind === "progress") return;
    void Promise.resolve().then(() => {
      if (workbench.dialogs.getSnapshot() === request) workbench.dialogs.answer(true as never);
    });
  });
}

const online = (workbench: Workbench) =>
  vi.waitFor(
    () =>
      expect(workbench.cloud?.session?.getSnapshot()).toMatchObject({
        state: "online",
        pending: 0,
      }),
    { timeout: 5000 },
  );

const live = (workbench: Workbench) =>
  vi.waitFor(() => expect(workbench.opening.getSnapshot().step).toBe("live"), { timeout: 5000 });

const write = (path: string, text: string) => ({ type: "file.write", params: { path, text } });

async function leave(workbench: Workbench) {
  await workbench.cloud?.close();
  await workbench.projectFolders?.close();
  await workbench.session.close();
}

/**
 * A project of the platform, made in another browser, which this computer has as a folder; and
 * while this computer is away, what `away` does.
 */
async function linkedFolder(platform: MemoryPlatform) {
  const elsewhere = browserOn(platform);
  const there = elsewhere.window();
  expect(await there.session.create("片子")).toBe(true);
  there.session.store?.execute(write(CODE, BEFORE) as never);
  expect(await there.cloud?.beginLink()).toMatchObject({ isNew: true });
  await online(there);
  const project = (await elsewhere.links.get(there.session.key as string))?.project as string;

  const here = browserOn(platform);
  const first = here.window();
  here.disk.chooseNext(FOLDER);
  const linking = first.cloud?.linkFolder(project);
  answering(first);
  expect(await linking).toBe(true);
  await written(first);
  await online(first);
  expect(filesOf(here.disk, FOLDER).get(CODE)).toBe(BEFORE);
  const key = first.session.key as string;
  await leave(first);
  return { there, here, project, key };
}

describe("opening a folder that is a clone of the repository of its project of the platform", () => {
  it(
    "has what the platform merged from GitHub first, and the same change from the folder once",
    { timeout: 30_000 },
    async () => {
      const platform = new MemoryPlatform();
      const { there, here, project, key } = await linkedFolder(platform);
      // Another computer changes the file meanwhile...
      there.session.store?.execute(write(CODE, ELSEWHERE) as never);
      await online(there);
      await leave(there);
      // ...people commit a change of it in the folder and push it, and the platform merges it.
      here.disk.write(`${FOLDER}/${CODE}`, PUSHED);
      platform.mergeFromRepository(project, [write(CODE, MERGED)]);
      expect(platform.workingCopy(project).getState().files[CODE]).toBe(MERGED);

      const again = here.window();
      const waited = await openWithSlowPlatform(platform, again, key);
      // The folder waited for the platform: the project was as the log had it.
      expect(waited).toEqual({ step: "cloud", code: BEFORE });
      await live(again);
      expect(again.opening.getSnapshot().cloud).toBe("caught-up");
      await online(again);
      await written(again);
      // Once, everywhere: in the project, in the folder, on the platform.
      expect(again.session.store?.getState().files[CODE]).toBe(MERGED);
      expect(filesOf(here.disk, FOLDER).get(CODE)).toBe(MERGED);
      await vi.waitFor(() =>
        expect(platform.workingCopy(project).getState().files[CODE]).toBe(MERGED),
      );
    },
  );

  it(
    "takes in the change of the folder once also where the platform merged nothing else",
    { timeout: 30_000 },
    async () => {
      const platform = new MemoryPlatform();
      const { there, here, project, key } = await linkedFolder(platform);
      await leave(there);
      here.disk.write(`${FOLDER}/${CODE}`, PUSHED);
      platform.mergeFromRepository(project, [write(CODE, PUSHED)]);

      const again = here.window();
      expect(await openWithSlowPlatform(platform, again, key)).toEqual({
        step: "cloud",
        code: BEFORE,
      });
      await live(again);
      await online(again);
      await written(again);
      expect(again.session.store?.getState().files[CODE]).toBe(PUSHED);
      expect(filesOf(here.disk, FOLDER).get(CODE)).toBe(PUSHED);
      await vi.waitFor(() =>
        expect(platform.workingCopy(project).getState().files[CODE]).toBe(PUSHED),
      );
    },
  );

  it(
    "compares the folder first where the platform does not answer in time, and says on what the change was made",
    { timeout: 30_000 },
    async () => {
      const platform = new MemoryPlatform();
      const { there, here, project, key } = await linkedFolder(platform);
      await leave(there);
      here.disk.write(`${FOLDER}/${CODE}`, PUSHED);
      platform.mergeFromRepository(project, [write(CODE, PUSHED)]);
      const merged = platform.projects.get(project)?.head as number;
      // The platform does not answer.
      platform.faults.silent = true;

      const again = here.window({ opening: { catchUpMs: 300 } });
      await again.openProject(key);
      await live(again);
      expect(again.opening.getSnapshot().cloud).not.toBe("caught-up");
      // The folder came in all the same.
      expect(again.session.store?.getState().files[CODE]).toBe(PUSHED);
      // Once the platform answers, the change from the folder goes there, as one made before what it
      // merged: it can tell that the same lines came twice, see `lateOf` of AnimaQuill Cloud.
      platform.faults.silent = false;
      platform.drop();
      await online(again);
      const fromFolder = platform.projects
        .get(project)
        ?.updates.filter((update) => update.kind === "folder");
      expect(fromFolder?.length).toBeGreaterThan(0);
      for (const update of fromFolder ?? []) expect(update.base).toBeLessThan(merged);
    },
  );

  it(
    "does not wait for the platform while the browser is offline",
    { timeout: 30_000 },
    async () => {
      const platform = new MemoryPlatform();
      const { there, here, project, key } = await linkedFolder(platform);
      await leave(there);
      here.disk.write(`${FOLDER}/${CODE}`, PUSHED);
      platform.mergeFromRepository(project, [write(CODE, MERGED)]);
      let isOnline = false;
      const environment: CloudEnvironment = {
        isOnline: () => isOnline,
        onWake: () => () => {},
        onOffline: () => () => {},
        setTimeout: (run, ms) => setTimeout(run, ms),
        clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
        now: () => Date.now(),
        random: () => Math.random(),
      };
      // Offline, nothing gets there; waiting for it would take longer than the test.
      platform.faults.silent = true;
      const again = here.window({ opening: { catchUpMs: 60_000 }, environment });
      await again.openProject(key);
      await live(again);
      expect(again.opening.getSnapshot().cloud).toBe("offline");
      expect(again.session.store?.getState().files[CODE]).toBe(PUSHED);
      await written(again);
      isOnline = true;
    },
  );
});
