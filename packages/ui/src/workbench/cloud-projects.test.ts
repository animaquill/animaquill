/**
 * Projects of the platform as people go through the workbench: opened without a folder, downloaded
 * into a folder, and taken out of the browser. See `CloudProjects` for what each of them does, and
 * `FolderMove` for the move into a folder, which is the real one here.
 */
import { memoryOrganizer } from "@animaquill/host";
import type { FolderAccess, Host, ProjectSummary } from "@animaquill/host";
import { MemoryDisk, memoryFolders } from "@animaquill/host/memory";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryPlatform, TestCloudBrowser } from "../cloud/cloud-support.ts";
import { OLD_CLOUD_FILE } from "../cloud/projects.ts";
import { account } from "../cloud/projects-support.ts";
import { filesOf } from "../folder/folder-support.ts";
import type { DialogRequest } from "./dialogs.ts";
import { FAST, folderOf, notices, written } from "./folder-windows.ts";
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

/** A browser of somebody who is signed in to the platform, with or without folders it can write. */
function browserOn(platform: MemoryPlatform, { folders = true } = {}) {
  const disk = new MemoryDisk();
  const library = new MemoryLibrary();
  const presence = new MemoryPresence();
  const cloud = new TestCloudBrowser(platform, "ada");
  const values = new Map<string, unknown>();
  // What windows keep on projects is the browser's: one window finds what another left.
  const trials = new MemoryTrials();
  const drafts = new MemoryTrials();
  const window = () => {
    const host: Host = {
      projects: library,
      address: memoryAddress(),
      windowMemory: memoryWindow(),
      organizer: memoryOrganizer(),
      settings: {
        load: async (key) => values.get(key),
        save: async (key, value) => void values.set(key, value),
        listen: () => () => {},
      },
      folders: noFolders,
      ...(folders && { localFolders: memoryFolders(disk) }),
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
      cloudTiming: { scanMs: 5, noteMs: 20, firstRetryMs: 20 },
    });
    opened.push(workbench);
    return workbench;
  };
  return { disk, library, links: cloud.links, trials, drafts, window };
}

/** Waits for a question of this kind, past whatever shows progress, and answers it. */
async function answerNext(
  workbench: Workbench,
  kind: Exclude<DialogRequest["kind"], "progress">,
  value: unknown,
): Promise<DialogRequest> {
  await vi.waitFor(() => expect(workbench.dialogs.getSnapshot()?.kind).toBe(kind));
  const asked = workbench.dialogs.getSnapshot() as DialogRequest;
  workbench.dialogs.answer(value as never);
  return asked;
}

const online = (workbench: Workbench) =>
  vi.waitFor(() =>
    expect(workbench.cloud?.session?.getSnapshot()).toMatchObject({ state: "online", pending: 0 }),
  );

const write = (path: string, text: string) => ({ type: "file.write", params: { path, text } });

/** A project on the platform, from a browser that goes on having it open. */
async function onPlatform(platform: MemoryPlatform) {
  const first = browserOn(platform, { folders: false });
  const there = first.window();
  expect(await there.session.create("片子")).toBe(true);
  there.session.store?.execute(write("code/动画.js", "const a = 1;\n"));
  // As the first step of the dialog that connects it does.
  expect(await there.cloud?.beginLink()).toMatchObject({ isNew: true });
  await online(there);
  const key = there.session.key as string;
  const project = (await first.links.get(key))?.project as string;
  expect(platform.projects.has(project)).toBe(true);
  return { there, project };
}

describe("a project of the platform, downloaded into a folder", () => {
  it("opens, moves into the folder people choose, and syncs on as that folder", async () => {
    const platform = new MemoryPlatform();
    const { there, project } = await onPlatform(platform);
    const browser = browserOn(platform);
    const workbench = browser.window();

    browser.disk.chooseNext("文档/下载");
    const downloading = workbench.cloud?.downloadToFolder(project);
    // It has no files of assets in the browser to tell people about: only that it moved.
    const said = await answerNext(workbench, "confirm", true);
    expect(said).toMatchObject({ title: "folder.move.movedTitle", noticeOnly: true });
    expect(await downloading).toBe(true);

    // The folder is the project now, under the number the copy had: its id on the platform.
    expect(workbench.session.key).toBe(project);
    expect(folderOf(workbench)?.record).toMatchObject({ id: project, name: "片子" });
    await written(workbench);
    const onDisk = filesOf(browser.disk, "文档/下载");
    expect(onDisk.get("code/动画.js")).toBe("const a = 1;\n");
    expect(onDisk.has("animaquill.json")).toBe(true);
    // The same link goes on, and the folder says nothing of it.
    await vi.waitFor(() =>
      expect(workbench.cloud?.getSnapshot()).toMatchObject({ kind: "linked", local: "folder" }),
    );
    expect(browser.disk.has(`文档/下载/${OLD_CLOUD_FILE}`)).toBe(false);
    expect((await browser.links.get(project))?.project).toBe(project);
    expect([...browser.library.summaries.keys()]).toEqual([project]);
    await online(workbench);

    // Both ways, and into the folder.
    there.session.store?.execute(write("code/动画.js", "const a = 2;\n"));
    await vi.waitFor(() =>
      expect(filesOf(browser.disk, "文档/下载").get("code/动画.js")).toBe("const a = 2;\n"),
    );
    workbench.session.store?.execute(write("code/新的.js", "new\n"));
    await vi.waitFor(() =>
      expect(there.session.store?.getState().files["code/新的.js"]).toBe("new\n"),
    );

    // Opening it from the platform again opens the folder, and makes no copy.
    await workbench.closeProject();
    expect(await workbench.cloud?.openCloudProject(project)).toBe(true);
    expect(folderOf(workbench)?.record.id).toBe(project);
    expect([...browser.library.summaries.keys()]).toEqual([project]);
  });

  it("stays a project of the platform without a folder where people choose none", async () => {
    const platform = new MemoryPlatform();
    const { project } = await onPlatform(platform);
    const browser = browserOn(platform);
    const workbench = browser.window();
    // They close the browser's question about the folder.
    expect(await workbench.cloud?.downloadToFolder(project)).toBe(false);
    expect(workbench.session.key).toBe(project);
    expect(folderOf(workbench)).toBeUndefined();
    expect(workbench.cloud?.getSnapshot()).toMatchObject({ kind: "linked", local: "browser" });
    await online(workbench);
    // It can move later, as any project of the browser can.
    expect(workbench.actions.get("project.moveToFolder")?.enabled?.()).toBe(true);
  });
});

describe("the copy of a project of the platform, in the list of projects of the browser", () => {
  it("goes out of the browser by the rule for copies, not as a project that cannot come back", async () => {
    const platform = new MemoryPlatform();
    const { project } = await onPlatform(platform);
    const browser = browserOn(platform, { folders: false });
    const workbench = browser.window();
    expect(await workbench.cloud?.openCloudProject(project)).toBe(true);
    await online(workbench);
    await workbench.closeProject();
    const summary = (await browser.library.list()).find(
      ({ id }) => id === project,
    ) as ProjectSummary;

    // Something of it is only here: people are asked, and it stays where they leave it.
    platform.faults.silent = true;
    platform.drop();
    await workbench.openProject(project);
    workbench.session.store?.execute(write("code/离线.js", "only here\n"));
    expect(await workbench.session.trySave()).toBe(true);
    await workbench.closeProject();
    const removing = workbench.removeProject(summary);
    const asked = await answerNext(workbench, "choice", undefined);
    expect(asked).toMatchObject({
      title: 'cloud.remove.unsyncedTitle {"name":"片子","interpolation":{"escapeValue":false}}',
    });
    expect(await removing).toBe(false);
    expect(browser.library.summaries.has(project)).toBe(true);

    // Once the platform has all of it, it goes, and the platform keeps the project.
    platform.faults.silent = false;
    await workbench.openProject(project);
    await online(workbench);
    const again = workbench.removeProject(summary);
    const confirm = await answerNext(workbench, "confirm", true);
    expect(confirm).toMatchObject({ confirm: "cloud.remove.confirm" });
    expect(await again).toBe(true);
    expect(workbench.session.store).toBeUndefined();
    expect(browser.library.summaries.has(project)).toBe(false);
    expect(await browser.links.get(project)).toBeUndefined();
    expect(platform.projects.has(project)).toBe(true);
    expect(notices(workbench).at(-1)).toContain("cloud.remove.done");
  });

  it("says what windows left on the copy that is not saved, which goes with it", async () => {
    const platform = new MemoryPlatform();
    const { project } = await onPlatform(platform);
    const browser = browserOn(platform, { folders: false });
    const workbench = browser.window();
    expect(await workbench.cloud?.openCloudProject(project)).toBe(true);
    await online(workbench);
    await workbench.closeProject();
    const summary = (await browser.library.list()).find(
      ({ id }) => id === project,
    ) as ProjectSummary;
    // A window that is gone left code that was typed and not saved: only this browser has it.
    browser.drafts.kept.set(
      project,
      new Map([
        ["left", { version: 1, drafts: [{ path: "code/草稿.js", text: "没保存的", base: null }] }],
      ]),
    );
    const removing = workbench.removeProject(summary);
    const asked = await answerNext(workbench, "choice", undefined);
    expect(asked).toMatchObject({
      title: 'cloud.remove.unsyncedTitle {"name":"片子","interpolation":{"escapeValue":false}}',
    });
    expect((asked as { message: string }).message).toContain("cloud.remove.leftBehind");
    expect((asked as { message: string }).message).toContain("cloud.remove.left.drafts");
    expect((asked as { message: string }).message).not.toContain("cloud.remove.left.trial");
    expect(await removing).toBe(false);
    expect(browser.library.summaries.has(project)).toBe(true);

    // Opening the project brings it back as a file that is not saved, for people to keep.
    await workbench.openProject(project);
    await vi.waitFor(() =>
      expect(workbench.code.drafts.map(({ path }) => path)).toEqual(["code/草稿.js"]),
    );
  });

  it("leaves a project that is not connected to the rule it always had", async () => {
    const platform = new MemoryPlatform();
    const browser = browserOn(platform, { folders: false });
    const workbench = browser.window();
    expect(await workbench.session.create("只在浏览器里")).toBe(true);
    const key = workbench.session.key as string;
    await workbench.closeProject();
    const removing = workbench.removeProject({ id: key, name: "只在浏览器里", updatedAt: 1 });
    const asked = await answerNext(workbench, "confirm", true);
    expect(asked).toMatchObject({ message: "project.removeWarning", danger: true });
    expect(await removing).toBe(true);
    expect(browser.library.summaries.has(key)).toBe(false);
  });
});
