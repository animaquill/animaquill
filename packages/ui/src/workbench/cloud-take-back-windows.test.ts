/**
 * A project of the platform open in two windows of this browser, whose working copy the platform
 * let go of and made again from the repository: the window that syncs takes the copy back, and
 * what the other one has that is not in the log yet goes onto the new copy too as it opens again,
 * see `TakeBack`, `CloudProjects.carryOver` and the design of the start page of AnimaQuill Cloud, 1.
 * From the review of P2, 1.
 */
import { ProjectStore } from "@animaquill/core";
import { memoryOrganizer } from "@animaquill/host";
import type { FolderAccess, Host } from "@animaquill/host";
import { MemoryDisk, memoryFolders } from "@animaquill/host/memory";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryPlatform, TestCloudBrowser } from "../cloud/cloud-support.ts";
import { account } from "../cloud/projects-support.ts";
import { FakeRepositories } from "../cloud/repository-support.ts";
import type { DialogRequest } from "./dialogs.ts";
import { FAST } from "./folder-windows.ts";
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
function browserOn(
  platform: MemoryPlatform,
  repository?: FakeRepositories,
  failing?: { on: boolean },
) {
  const disk = new MemoryDisk();
  const library = new MemoryLibrary();
  const presence = new MemoryPresence();
  const cloud = new TestCloudBrowser(platform, "ada");
  const values = new Map<string, unknown>();
  const trials = new MemoryTrials();
  const drafts = new MemoryTrials();
  const organizer = memoryOrganizer();
  // A window whose writes to the log fail while `failing.on`, as a full disk does.
  const projectsOf = (fails: boolean): MemoryLibrary =>
    !fails || !failing
      ? library
      : (new Proxy(library, {
          get(target, property) {
            if (property === "open") {
              return async (id: string) => {
                const log = await target.open(id);
                return new Proxy(log, {
                  get(inner, name) {
                    if (name === "append") {
                      return async (...args: Parameters<typeof log.append>) => {
                        if (failing.on) throw new Error("quota");
                        return inner.append(...args);
                      };
                    }
                    return Reflect.get(inner, name);
                  },
                });
              };
            }
            const value = Reflect.get(target, property) as unknown;
            return typeof value === "function" ? value.bind(target) : value;
          },
        }) as MemoryLibrary);
  const window = (fails = false) => {
    const host: Host = {
      projects: projectsOf(fails),
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

describe("a window of this browser whose last change is not in the log yet", () => {
  it(
    "does not lose it when another window takes the copy back and every window opens again",
    { timeout: 60_000 },
    async () => {
      const platform = new MemoryPlatform();
      // Another browser makes the project, which is archived, and leaves it.
      const elsewhere = browserOn(platform);
      const there = elsewhere.window();
      expect(await there.session.create("片子")).toBe(true);
      there.session.store?.execute(write(CODE, "const a = 1;\n") as never);
      expect(await there.cloud?.beginLink()).toMatchObject({ isNew: true });
      await online(there);
      const project = (await elsewhere.links.get(there.session.key as string))?.project as string;
      const repository = repositoryOf(platform, project);
      platform.archive(project);
      await leave(there);

      // This browser has it in two windows: the first syncs.
      const failing = { on: false };
      const here = browserOn(platform, repository, failing);
      const first = here.window();
      answering(first, () => true);
      expect(await first.cloud?.openCloudProject(project)).toBe(true);
      await online(first);
      const key = first.session.key as string;
      const second = here.window(true);
      answering(second, () => true);
      await second.openProject(key);
      expect(second.session.key).toBe(key);

      // The second window's last change cannot be written yet: the disk is full for a moment.
      failing.on = true;
      expect(second.session.store?.execute(write("code/第二个窗口.js", "mine\n") as never).ok).toBe(
        true,
      );
      expect(await second.session.trySave()).toBe(false);

      // Nobody else opened it for a while: the platform lets go of its copy and makes it again.
      platform.release(project);
      await vi.waitFor(
        async () => expect(await here.links.get(key)).toMatchObject({ generation: 2 }),
        { timeout: 20_000 },
      );
      await vi.waitFor(() => expect(second.cloud?.session?.generation).toBe(2), {
        timeout: 20_000,
      });
      failing.on = false;
      await online(first);
      await new Promise((resolve) => setTimeout(resolve, 6000));

      // The rule: in the content, chosen away by people, or in a backup.
      const inWindow = second.session.store?.getState().files["code/第二个窗口.js"];
      const onPlatform = platform.workingCopy(project).getState().files["code/第二个窗口.js"];
      const kept = [...(here.library.backupsOf.get(key)?.values() ?? [])].some((updates) => {
        const { store } = ProjectStore.fromUpdates(updates);
        const text = store?.getState().files["code/第二个窗口.js"];
        store?.destroy();
        return text === "mine\n";
      });
      expect({ inWindow, onPlatform, kept }).not.toEqual({
        inWindow: undefined,
        onPlatform: undefined,
        kept: false,
      });
      // ...and it went onto the new copy, as a change of that window.
      expect({ inWindow, onPlatform }).toEqual({ inWindow: "mine\n", onPlatform: "mine\n" });
      expect(second.session.getSnapshot().save).toBe("saved");
    },
  );
});
