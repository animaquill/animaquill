/**
 * A project of the platform with a folder on this computer, whose working copy the platform let go
 * of and made again from the repository while this computer was away: what the folder has that
 * the repository does not goes onto the new copy, with the workbench, the folder and a platform in
 * memory around it, see `TakeBack` and the design of the start page of AnimaQuill Cloud, 1.
 */
import { memoryOrganizer } from "@animaquill/host";
import type { FolderAccess, Host } from "@animaquill/host";
import { MemoryDisk, memoryFolders } from "@animaquill/host/memory";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryPlatform, TestCloudBrowser } from "../cloud/cloud-support.ts";
import { account } from "../cloud/projects-support.ts";
import { FakeRepositories } from "../cloud/repository-support.ts";
import { filesOf, recovered } from "../folder/folder-support.ts";
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
import { Workbench } from "./workbench.ts";

const FOLDER = "文档/片子";
const CODE = "code/动画.js";

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
  for (const workbench of opened.splice(0)) {
    await workbench.cloud?.close();
    await workbench.projectFolders?.close();
    await workbench.session.close();
  }
});

/** A browser of somebody signed in to the platform, on a computer with a disk of its own. */
function browserOn(platform: MemoryPlatform, repository?: FakeRepositories) {
  const disk = new MemoryDisk();
  const library = new MemoryLibrary();
  const presence = new MemoryPresence();
  const cloud = new TestCloudBrowser(platform, "ada");
  const values = new Map<string, unknown>();
  const trials = new MemoryTrials();
  const drafts = new MemoryTrials();
  const organizer = memoryOrganizer();
  const window = () => {
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
      cloud: {
        ...cloud.access({ isAlive: () => true, asleep: false }),
        ...(repository && { repository }),
      },
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
      cloudTiming: { scanMs: 5, noteMs: 20, firstRetryMs: 20 },
    });
    opened.push(workbench);
    return workbench;
  };
  return { disk, library, links: cloud.links, window };
}

/** Answers each question as `answer` says, and keeps what was asked. */
function answering(workbench: Workbench, answer: (request: DialogRequest) => unknown) {
  const asked: DialogRequest[] = [];
  workbench.dialogs.subscribe(() => {
    const request = workbench.dialogs.getSnapshot();
    if (!request || request.kind === "progress" || asked.includes(request)) return;
    asked.push(request);
    void Promise.resolve()
      .then(() => answer(request))
      .then((value) => {
        if (workbench.dialogs.getSnapshot() === request) workbench.dialogs.answer(value as never);
      });
  });
  return asked;
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

const write = (path: string, text: string) => ({ type: "file.write", params: { path, text } });

async function leave(workbench: Workbench) {
  await workbench.cloud?.close();
  await workbench.projectFolders?.close();
  await workbench.session.close();
}

/** GitHub as the platform saves to it. */
function repositoryOf(platform: MemoryPlatform, project: string): FakeRepositories {
  const repository = new FakeRepositories();
  repository.platform = platform;
  repository.followsPlatform = true;
  repository.autoArchive = true;
  repository.answer = {
    repository: {
      id: 7,
      owner: "ada",
      name: "atom",
      fullName: "ada/atom",
      private: true,
      branch: "main",
      url: "https://github.com/ada/atom",
      createdHere: true,
      linkedAt: 1,
    },
    state: "ready",
    archiving: false,
    head: platform.projects.get(project)?.head ?? 1,
    archivedSeq: 0,
  };
  platform.repositories.set(project, { id: 7, owner: "ada", name: "atom" });
  return repository;
}

describe("a folder of a project whose working copy the platform made again from the repository", () => {
  it(
    "goes onto the new copy: what only it changed by itself, the rest as people choose, kept first",
    { timeout: 30_000 },
    async () => {
      const platform = new MemoryPlatform();
      // Another browser makes the project and goes on having it open.
      const elsewhere = browserOn(platform);
      const there = elsewhere.window();
      expect(await there.session.create("片子")).toBe(true);
      there.session.store?.execute(write(CODE, "const a = 1;\n") as never);
      expect(await there.cloud?.beginLink()).toMatchObject({ isNew: true });
      await online(there);
      const project = (await elsewhere.links.get(there.session.key as string))?.project as string;
      const repository = repositoryOf(platform, project);

      // This computer links a folder with it.
      const here = browserOn(platform, repository);
      const first = here.window();
      here.disk.chooseNext(FOLDER);
      const linking = first.cloud?.linkFolder(project);
      answering(first, () => true);
      expect(await linking).toBe(true);
      await written(first);
      await online(first);
      platform.archive(project);

      // Away: it changes the file that the other browser changes too, and one of its own.
      platform.faults.silent = true;
      first.session.store?.execute(write(CODE, "这台电脑改的\n") as never);
      first.session.store?.execute(write("code/只在这里.js", "mine\n") as never);
      expect(await first.session.trySave()).toBe(true);
      await written(first);
      await leave(first);
      platform.faults.silent = false;
      there.session.store?.execute(write(CODE, "云端改的\n") as never);
      expect(await there.session.trySave()).toBe(true);
      await vi.waitFor(() =>
        expect(platform.workingCopy(project).getState().files[CODE]).toBe("云端改的\n"),
      );
      await online(there);
      platform.archive(project);
      await leave(there);
      // Nobody opened it for a while.
      platform.release(project);

      const again = here.window();
      const asked = answering(again, (request) =>
        request.kind === "reconcile" ? { [CODE]: "cloud" } : true,
      );
      await again.openProject(project);
      const key = again.session.key as string;
      await vi.waitFor(
        async () => expect(await here.links.get(key)).toMatchObject({ generation: 2 }),
        { timeout: 10_000 },
      );
      // ...and the window opened it again from there.
      await vi.waitFor(() => expect(again.cloud?.session?.generation).toBe(2), { timeout: 5000 });
      await online(again);
      await vi.waitFor(() => expect(filesOf(here.disk, FOLDER).get(CODE)).toBe("云端改的\n"));
      await written(again);
      // People chose for the file both changed, and nothing else.
      expect(asked.filter(({ kind }) => kind === "reconcile")).toHaveLength(1);
      expect(asked.find(({ kind }) => kind === "reconcile")).toMatchObject({
        items: [{ path: CODE }],
      });
      const folder = filesOf(here.disk, FOLDER);
      expect(folder.get(CODE)).toBe("云端改的\n");
      expect(folder.get("code/只在这里.js")).toBe("mine\n");
      const files = platform.workingCopy(project).getState().files;
      expect(files[CODE]).toBe("云端改的\n");
      expect(files["code/只在这里.js"]).toBe("mine\n");
      // What the folder had of the file that people let go of is kept.
      expect(recovered(here.disk, FOLDER).get(CODE)).toContain("这台电脑改的\n");
      // ...and the project can be edited again, here and on the platform.
      expect(again.session.store?.readOnly).toBe(false);
      again.session.store?.execute(write("code/后来.js", "later\n") as never);
      await vi.waitFor(() =>
        expect(platform.workingCopy(project).getState().files["code/后来.js"]).toBe("later\n"),
      );
      await vi.waitFor(() =>
        expect(filesOf(here.disk, FOLDER).get("code/后来.js")).toBe("later\n"),
      );
    },
  );
});
