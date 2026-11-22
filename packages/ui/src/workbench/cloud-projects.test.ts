/**
 * Projects of the online mode as people go through the workbench: opened, saved to a folder as a
 * copy (`SaveToFolder`), and taken out of the browser. See `CloudProjects` for what each does.
 */
import { memoryOrganizer, newSyncId } from "@animaquill/host";
import type {
  FolderAccess,
  Host,
  LocalFolder,
  ProjectSummary,
  SavedFolders,
} from "@animaquill/host";
import { MemoryDisk, memoryFolders } from "@animaquill/host/memory";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryPlatform, TestCloudBrowser } from "../cloud/cloud-support.ts";
import { account } from "../cloud/projects-support.ts";
import { filesOf } from "../folder/folder-support.ts";
import type { DialogRequest } from "./dialogs.ts";
import { FAST, notices } from "./folder-windows.ts";
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
function browserOn(
  platform: MemoryPlatform,
  { folders = true, disk = new MemoryDisk() }: { folders?: boolean; disk?: MemoryDisk } = {},
) {
  const library = new MemoryLibrary();
  const presence = new MemoryPresence();
  const cloud = new TestCloudBrowser(platform, "ada");
  const values = new Map<string, unknown>();
  // What windows keep on projects is the browser's: one window finds what another left.
  const trials = new MemoryTrials();
  const drafts = new MemoryTrials();
  // Where projects were saved to, for the whole browser.
  const kept = new Map<string, LocalFolder>();
  const savedFolders: SavedFolders = {
    get: async (project) => kept.get(project),
    put: async (project, folder) => void kept.set(project, folder),
    forget: async (project) => void kept.delete(project),
  };
  const window = () => {
    const host: Host = {
      mode: "online",
      savedFolders,
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
  expect(await there.session.trySave()).toBe(true);
  // A link that the first connection makes the project with, as the sync protocol does.
  const key = there.session.key as string;
  const project = newSyncId();
  await first.links.put({
    key,
    platform: there.cloud?.platform ?? "",
    project,
    seq: 0,
    pushed: (await there.session.journal.entries())?.at(-1)?.mark ?? 0,
    linkedAt: Date.now(),
    creating: true,
  });
  await there.cloud?.close();
  await there.cloud?.follow();
  await online(there);
  expect(platform.projects.has(project)).toBe(true);
  return { there, project };
}

describe("a project of the online mode, saved to a folder (docs/design/online-offline.md, 1.2)", () => {
  it("writes a copy that nothing links, and the next time replaces only the files of the project", async () => {
    const platform = new MemoryPlatform();
    const { project } = await onPlatform(platform);
    const browser = browserOn(platform);
    const workbench = browser.window();
    expect(await workbench.cloud?.openCloudProject(project)).toBe(true);
    await online(workbench);

    browser.disk.folder("文档/副本", { quietly: true });
    browser.disk.chooseNext("文档/副本");
    const saving = workbench.saveToFolder();
    const done = await answerNext(workbench, "choice", "ok");
    expect(done).toMatchObject({ title: expect.stringContaining("saveToFolder.done.title") });
    await saving;
    let onDisk = filesOf(browser.disk, "文档/副本");
    expect(onDisk.get("code/动画.js")).toBe("const a = 1;\n");
    expect(onDisk.has("animaquill.json")).toBe(true);
    // A copy: the project is still the copy of the platform in this browser, and nothing else.
    expect(workbench.cloud?.getSnapshot().kind).toBe("linked");
    expect(workbench.projectFolders).toBeUndefined();

    // Changed since, with a file of the format gone and one of people's own in the folder.
    workbench.session.store?.execute(write("code/动画.js", "const a = 2;\n"));
    workbench.session.store?.execute({
      type: "file.write",
      params: { path: "code/新.js", text: "1\n" },
    });
    browser.disk.write("文档/副本/笔记.txt", "people's own", { quietly: true });
    browser.disk.write("文档/副本/code/旧的.js", "from before\n", { quietly: true });
    const again = workbench.saveToFolder();
    // The folder of the last save first: replacing what is there of the project.
    const asked = await answerNext(workbench, "choice", "replace");
    expect(asked).toMatchObject({ message: expect.stringContaining("saveToFolder.again.message") });
    await answerNext(workbench, "choice", "ok");
    await again;
    onDisk = filesOf(browser.disk, "文档/副本");
    expect(onDisk.get("code/动画.js")).toBe("const a = 2;\n");
    expect(onDisk.get("code/新.js")).toBe("1\n");
    // What the project does not have any more goes; what is not of the format stays.
    expect(onDisk.has("code/旧的.js")).toBe(false);
    expect(onDisk.get("笔记.txt")).toBe("people's own");
  });

  it("goes into a folder of its own where the folder people chose has other things", async () => {
    const platform = new MemoryPlatform();
    const { project } = await onPlatform(platform);
    const browser = browserOn(platform);
    const workbench = browser.window();
    expect(await workbench.cloud?.openCloudProject(project)).toBe(true);
    browser.disk.write("文档/杂物/别的.txt", "x", { quietly: true });
    browser.disk.chooseNext("文档/杂物");
    const saving = workbench.saveToFolder();
    await answerNext(workbench, "choice", "ok");
    await saving;
    expect(filesOf(browser.disk, "文档/杂物/片子").has("animaquill.json")).toBe(true);
    expect(filesOf(browser.disk, "文档/杂物").get("别的.txt")).toBe("x");
  });

  it("does not write into a folder that holds another project", async () => {
    const platform = new MemoryPlatform();
    const { project } = await onPlatform(platform);
    const browser = browserOn(platform);
    const workbench = browser.window();
    expect(await workbench.cloud?.openCloudProject(project)).toBe(true);
    browser.disk.write("文档/别的项目/animaquill.json", JSON.stringify({ id: "other" }), {
      quietly: true,
    });
    browser.disk.chooseNext("文档/别的项目");
    const saving = workbench.saveToFolder();
    // The open project says which it is: another one is refused right away, with another folder.
    const said = await answerNext(workbench, "choice", undefined);
    expect(said).toMatchObject({
      title: expect.stringContaining("saveToFolder.otherProject.title"),
    });
    await saving;
    expect(filesOf(browser.disk, "文档/别的项目").size).toBe(1);
  });

  it("checks which project a folder has once the copy says, for a project that is not open", async () => {
    const platform = new MemoryPlatform();
    const { project } = await onPlatform(platform);
    const browser = browserOn(platform);
    const workbench = browser.window();
    browser.disk.write("文档/别的项目/animaquill.json", JSON.stringify({ id: "other" }), {
      quietly: true,
    });
    browser.disk.chooseNext("文档/别的项目");
    // From its card: which project it is, only the copy says.
    const saving = workbench.saveToFolder(project, "片子");
    await answerNext(workbench, "confirm", true);
    const said = await answerNext(workbench, "confirm", true);
    expect(said).toMatchObject({ noticeOnly: true });
    await saving;
    expect(filesOf(browser.disk, "文档/别的项目").size).toBe(1);
  });

  it("checks the folder of the last save again, which people may have used for something else", async () => {
    const platform = new MemoryPlatform();
    const { project } = await onPlatform(platform);
    const browser = browserOn(platform);
    const workbench = browser.window();
    expect(await workbench.cloud?.openCloudProject(project)).toBe(true);
    browser.disk.folder("文档/副本", { quietly: true });
    browser.disk.chooseNext("文档/副本");
    const saving = workbench.saveToFolder();
    await answerNext(workbench, "choice", "ok");
    await saving;
    // Another project goes there since, with files of the format of its own.
    for (const path of filesOf(browser.disk, "文档/副本").keys())
      browser.disk.remove(`文档/副本/${path}`, { quietly: true });
    browser.disk.write("文档/副本/animaquill.json", JSON.stringify({ id: "other" }), {
      quietly: true,
    });
    browser.disk.write("文档/副本/code/别的.js", "theirs\n", { quietly: true });
    const again = workbench.saveToFolder();
    await answerNext(workbench, "choice", "replace");
    // Another project: refused, with another folder to choose.
    const said = await answerNext(workbench, "choice", undefined);
    expect(said).toMatchObject({
      title: expect.stringContaining("saveToFolder.otherProject.title"),
    });
    await again;
    const after = filesOf(browser.disk, "文档/副本");
    expect(after.get("code/别的.js")).toBe("theirs\n");
    expect(after.get("animaquill.json")).toBe(JSON.stringify({ id: "other" }));
    expect(after.size).toBe(2);
  });

  it("saves into a folder people choose that has a copy of this project, replacing it", async () => {
    const platform = new MemoryPlatform();
    const { project } = await onPlatform(platform);
    const browser = browserOn(platform);
    const workbench = browser.window();
    expect(await workbench.cloud?.openCloudProject(project)).toBe(true);
    browser.disk.folder("文档/副本", { quietly: true });
    browser.disk.chooseNext("文档/副本");
    const saving = workbench.saveToFolder();
    await answerNext(workbench, "choice", "ok");
    await saving;
    // Another browser, which has no folder of the last save, chooses the same one.
    const other = browserOn(platform, { disk: browser.disk }).window();
    expect(await other.cloud?.openCloudProject(project)).toBe(true);
    browser.disk.chooseNext("文档/副本");
    other.session.store?.execute(write("code/动画.js", "const a = 3;\n"));
    const again = other.saveToFolder();
    await answerNext(other, "confirm", true);
    await answerNext(other, "choice", "ok");
    await again;
    expect(filesOf(browser.disk, "文档/副本").get("code/动画.js")).toBe("const a = 3;\n");
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
