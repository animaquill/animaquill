/**
 * Projects of the browser that move into folders, as people go through the workbench: from the
 * start page and from the file menu, what they are asked and told on the way, and what the browser
 * keeps of the project afterwards. See `FolderMove` for what moving does.
 */
import { INCOMPLETE_FILE, orderedTracks, type ProjectStore } from "@animaquill/core";
import { memoryOrganizer } from "@animaquill/host";
import type { FolderAccess, Host } from "@animaquill/host";
import { hashFile } from "@animaquill/media";
import { afterEach, describe, expect, it, vi } from "vitest";
import { filesOf } from "../folder/folder-support.ts";
import type { DialogRequest } from "./dialogs.ts";
import {
  browserOf,
  closeWindows,
  folderOf,
  manifestOn,
  notices,
  windowOf,
  written,
} from "./folder-windows.ts";
import { layouts } from "./layouts.ts";
import {
  MemoryExports,
  MemoryLibrary,
  MemoryTrials,
  memoryAddress,
  memoryWindow,
} from "./memory-library.ts";
import { Workbench } from "./workbench.ts";

afterEach(closeWindows);

type Browser = ReturnType<typeof browserOf>;

const HOME = "文档/新家";
const PICTURE = "一张图";

/**
 * A project of the browser, open in the window, with a file of an asset that the browser keeps, as
 * projects were before they were folders.
 */
async function browserProject(browser: Browser, workbench: Workbench, name = "片子") {
  expect(await workbench.session.create(name)).toBe(true);
  const store = workbench.session.store as ProjectStore;
  const key = workbench.session.key as string;
  const file = new Blob([PICTURE]);
  const hash = await hashFile(file);
  await browser.library.media(key).put(hash, file);
  const added = store.execute({
    type: "asset.add",
    params: {
      id: "asset_pic",
      asset: { kind: "image", storage: "local", path: "assets/图.png", hash, size: file.size },
    },
  });
  expect(added.ok).toBe(true);
  expect(await workbench.session.trySave()).toBe(true);
  return { key, store, hash };
}

/** Waits for a question of this kind, past the progress of the move, and answers it. */
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

const isFolderSummary = async (browser: Browser, key: string) =>
  (await browser.library.list()).find(({ id }) => id === key)?.folder === true;

const canMove = (workbench: Workbench) =>
  workbench.actions.get("project.moveToFolder")?.enabled?.() === true;

describe("an open project of the browser", () => {
  it("moves into the folder people choose, and stays open with what is being typed", async () => {
    const browser = browserOf();
    const workbench = windowOf(browser);
    const { key, store } = await browserProject(browser, workbench);
    store.execute({ type: "file.write", params: { path: "code/动画.js", text: "const a = 1;\n" } });
    workbench.code.open("code/动画.js");
    workbench.code.edit("code/动画.js", "const a = 2;\n");
    expect(canMove(workbench)).toBe(true);

    browser.disk.chooseNext(HOME);
    const moving = workbench.moveToFolder();
    const said = await answerNext(workbench, "confirm", false);
    expect(said).toMatchObject({
      title: "folder.move.movedTitle",
      cancel: "folder.move.keep",
      confirm: expect.stringContaining("folder.move.release"),
    });
    expect(await moving).toBe(true);

    // The same project, in the same window, with its log and what is being typed.
    expect(workbench.session.store).toBe(store);
    expect(workbench.session.key).toBe(key);
    expect(browser.address.read()).toBe(key);
    expect(workbench.code.unsaved).toEqual(["code/动画.js"]);
    expect(folderOf(workbench)?.record).toMatchObject({ id: key, name: "片子" });
    expect(canMove(workbench)).toBe(false);
    await written(workbench);
    const onDisk = filesOf(browser.disk, HOME);
    expect(onDisk.get("code/动画.js")).toBe("const a = 1;\n");
    expect(onDisk.get("assets/图.png")).toBe(PICTURE);
    expect(onDisk.has(INCOMPLETE_FILE)).toBe(false);
    // What was written is what the folder is known by: nothing gets written again for nothing.
    const time = browser.disk.lastModified(`${HOME}/timelines/main/timeline.json`);
    store.execute({ type: "project.rename", params: { name: "搬家以后" } });
    await vi.waitFor(() => expect(manifestOn(browser.disk, HOME).name).toBe("搬家以后"));
    expect(browser.disk.lastModified(`${HOME}/timelines/main/timeline.json`)).toBe(time);
    // Its files come from the folder now.
    expect(
      await workbench.projects.media(key).get((await hashOf(PICTURE)) as string),
    ).toBeDefined();
    expect(await isFolderSummary(browser, key)).toBe(true);
  });

  it("keeps what is being tried, which the folder gets once it is saved", async () => {
    const browser = browserOf();
    const workbench = windowOf(browser);
    const { store } = await browserProject(browser, workbench);
    const main = () => store.getState().timelines["main"];
    const track = orderedTracks(main() as never).find(({ kind }) => kind === "video")?.id;
    const clip = {
      id: "c",
      start: "0",
      duration: "5",
      source: { kind: "color", color: "#ff0000" },
    };
    expect(store.execute({ type: "clip.add", params: { timeline: "main", track, clip } }).ok).toBe(
      true,
    );
    const x = () => main()?.clips["c"]?.properties?.["transform.x"];
    workbench.properties.commit([
      { owner: { clip: "c" }, path: "transform.x", op: "write", time: "1", value: 10 },
    ]);
    expect(workbench.trials.getSnapshot().count).toBe(1);

    browser.disk.chooseNext(HOME);
    const moving = workbench.moveToFolder();
    await answerNext(workbench, "confirm", false);
    expect(await moving).toBe(true);
    await written(workbench);
    expect(workbench.trials.getSnapshot().count).toBe(1);
    expect(x()).toBeUndefined();
    const clipOnDisk = () =>
      JSON.parse(browser.disk.text(`${HOME}/timelines/main/timeline.json`))
        .tracks.flatMap((each: { clips: unknown[] }) => each.clips)
        .find((each: { id: string }) => each.id === "c");
    expect(clipOnDisk()?.properties?.["transform.x"]).toBeUndefined();
    await workbench.save();
    expect(x()).toBeDefined();
    await vi.waitFor(() => expect(clipOnDisk()?.properties?.["transform.x"]).toBeDefined());
  });

  it("goes into a folder of its own where other things are", async () => {
    const browser = browserOf();
    browser.disk.write(`${HOME}/README.md`, "# 说明");
    const workbench = windowOf(browser);
    await browserProject(browser, workbench);
    browser.disk.chooseNext(HOME);
    const moving = workbench.moveToFolder();
    expect(await answerNext(workbench, "choice", "inside")).toMatchObject({
      title: expect.stringContaining("folder.notEmptyTitle"),
    });
    await answerNext(workbench, "confirm", false);
    expect(await moving).toBe(true);
    expect(manifestOn(browser.disk, `${HOME}/片子`).name).toBe("片子");
    expect(browser.disk.text(`${HOME}/README.md`)).toBe("# 说明");
  });

  it("stays as it was where the folder is not what was written, and the folder stays to look at", async () => {
    const browser = browserOf();
    const workbench = windowOf(browser);
    const { key, store } = await browserProject(browser, workbench);
    const path = `${HOME}/assets.json`;
    browser.disk.onNext("written", path, () => {
      browser.disk.onNext("getFile", path, () => {});
      browser.disk.onNext("getFile", path, () => {
        browser.disk.write(path, browser.disk.text(path).replace("图.png", "别.png"), {
          quietly: true,
          keepTime: true,
        });
      });
    });
    browser.disk.chooseNext(HOME);
    const moving = workbench.moveToFolder();
    // People keep the folder to look at it.
    const said = await answerNext(workbench, "confirm", false);
    expect(said).toMatchObject({
      title: expect.stringContaining("folder.move.failedTitle"),
      message: expect.stringContaining("folder.move.unverified"),
      confirm: "folder.move.discard",
      cancel: "folder.move.keepFolder",
      details: [
        {
          title: expect.stringContaining("folder.move.mismatchList"),
          items: [expect.stringContaining("folder.move.mismatch.different")],
        },
      ],
    });
    expect(await moving).toBe(false);
    expect(workbench.session.store).toBe(store);
    expect(folderOf(workbench)).toBeUndefined();
    expect(await browser.disk.records.get(key)).toBeUndefined();
    expect(await isFolderSummary(browser, key)).toBe(false);
    expect(browser.disk.has(`${HOME}/${INCOMPLETE_FILE}`)).toBe(true);
    expect(canMove(workbench)).toBe(true);

    // Another place works, and the project goes on as the folder there.
    browser.disk.chooseNext("文档/另一个家");
    const again = workbench.moveToFolder();
    await answerNext(workbench, "confirm", false);
    expect(await again).toBe(true);
    expect(folderOf(workbench)?.record.folder.name).toBe("另一个家");
  });

  it("does not move where the log cannot have it first", async () => {
    const browser = browserOf();
    const workbench = windowOf(browser);
    const { key, store } = await browserProject(browser, workbench);
    browser.library.failing = true;
    store.execute({ type: "project.rename", params: { name: "存不进去" } });
    browser.disk.chooseNext(HOME);
    const moving = workbench.moveToFolder();
    expect(await answerNext(workbench, "confirm", true)).toMatchObject({
      message: "folder.move.unsaved",
    });
    expect(await moving).toBe(false);
    expect(browser.disk.names(HOME)).toEqual([]);
    expect(await browser.disk.records.get(key)).toBeUndefined();
    browser.library.failing = false;
    expect(await workbench.session.trySave()).toBe(true);
  });

  it("says what keeps it from moving, and writes nothing", async () => {
    const browser = browserOf();
    const workbench = windowOf(browser);
    const { store } = await browserProject(browser, workbench);
    store.execute({ type: "file.write", params: { path: "code/aux.js", text: "// 设备名" } });
    browser.disk.chooseNext(HOME);
    const moving = workbench.moveToFolder();
    expect(await answerNext(workbench, "confirm", true)).toMatchObject({
      title: expect.stringContaining("folder.move.refusedTitle"),
      message: "folder.move.refused.refused",
      details: [{ items: ["code/aux.js"] }],
    });
    expect(await moving).toBe(false);
    expect(browser.disk.names(HOME)).toEqual([]);
  });

  it("stops when people cancel, and nothing of it stays in the folder", async () => {
    const browser = browserOf();
    const workbench = windowOf(browser);
    const { key } = await browserProject(browser, workbench);
    browser.disk.onNext("written", `${HOME}/assets/图.png`, () => {
      const progress = workbench.dialogs.getSnapshot();
      if (progress?.kind === "progress") progress.stop();
    });
    browser.disk.chooseNext(HOME);
    expect(await workbench.moveToFolder()).toBe(false);
    expect(notices(workbench)).toContain('folder.move.cancelled {"name":"片子"}');
    expect(browser.disk.names(HOME)).toEqual([]);
    expect(await browser.disk.records.get(key)).toBeUndefined();
  });
});

describe("a project on the start page", () => {
  it("moves without opening, and opens as its folder afterwards with nothing to write", async () => {
    const browser = browserOf();
    const workbench = windowOf(browser);
    const { key } = await browserProject(browser, workbench);
    await workbench.closeProject();
    const folders = workbench.projectFolders;
    if (!folders) throw new Error("No folders");

    browser.disk.chooseNext(HOME);
    const moving = folders.moveToFolder(key);
    await answerNext(workbench, "confirm", false);
    expect(await moving).toBe(true);
    expect(workbench.session.store).toBeUndefined();
    const [record] = await folders.list();
    if (!record) throw new Error("No record");
    expect(record).toMatchObject({ id: key, name: "片子" });
    expect(await isFolderSummary(browser, key)).toBe(true);
    expect(await folders.copiesOf(record)).toBe(new Blob([PICTURE]).size);

    const time = browser.disk.lastModified(`${HOME}/animaquill.json`);
    await folders.openRecent(record);
    await written(workbench);
    expect(workbench.session.key).toBe(key);
    expect(browser.disk.lastModified(`${HOME}/animaquill.json`)).toBe(time);
    await folders.assetsChecked();
    expect(workbench.problems.getSnapshot().problems).toEqual([]);
  });

  it("lets go of the copies of its files when people say so", async () => {
    const browser = browserOf();
    const workbench = windowOf(browser);
    const { key } = await browserProject(browser, workbench);
    await browser.library.media(key).put("sound-1:abc", new Blob(["代码做的声音"]));
    await workbench.closeProject();
    browser.disk.chooseNext(HOME);
    const moving = workbench.projectFolders?.moveToFolder(key);
    await answerNext(workbench, "confirm", true);
    expect(await moving).toBe(true);
    await vi.waitFor(() =>
      expect(notices(workbench)).toContain(
        `folder.move.released {"size":"${new Blob([PICTURE]).size} B"}`,
      ),
    );
    expect(await browser.library.copies(key)).toEqual([]);
    expect(await browser.library.media(key).get("sound-1:abc")).toBeDefined();
  });

  it("lets go of the copies later on, once people say so again", async () => {
    const browser = browserOf();
    const workbench = windowOf(browser);
    const { key } = await browserProject(browser, workbench);
    await workbench.closeProject();
    browser.disk.chooseNext(HOME);
    const moving = workbench.projectFolders?.moveToFolder(key);
    await answerNext(workbench, "confirm", false);
    expect(await moving).toBe(true);
    const folders = workbench.projectFolders;
    const [record] = (await folders?.list()) ?? [];
    if (!folders || !record) throw new Error("No record");
    // The folder lost the file meanwhile: its copy stays.
    browser.disk.remove(`${HOME}/assets/图.png`);
    const releasing = folders.releaseCopies(record);
    expect(await answerNext(workbench, "confirm", true)).toMatchObject({
      title: expect.stringContaining("folder.move.releaseTitle"),
    });
    expect(await releasing).toBe(false);
    expect(notices(workbench).at(-1)).toContain("folder.move.releasedMissing");
    expect(await browser.library.copies(key)).toHaveLength(1);
  });

  it("is the open folder already, and not moved again", async () => {
    const browser = browserOf();
    const workbench = windowOf(browser);
    const { key } = await browserProject(browser, workbench);
    browser.disk.chooseNext(HOME);
    const moving = workbench.moveToFolder();
    await answerNext(workbench, "confirm", false);
    expect(await moving).toBe(true);
    browser.disk.chooseNext("文档/又一个");
    expect(await workbench.projectFolders?.moveToFolder(key)).toBe(false);
    expect(notices(workbench)).toContain('folder.move.already {"name":"片子"}');
    expect(browser.disk.names("文档/又一个")).toEqual([]);
  });
});

describe("other windows of the browser", () => {
  it("that have the project open are said first, and go on with the folder once it moved", async () => {
    const browser = browserOf();
    const first = windowOf(browser);
    const { key } = await browserProject(browser, first);
    const second = windowOf(browser);
    expect(await second.session.open(key)).toBe(true);
    const other = second.session.store as ProjectStore;

    browser.disk.chooseNext(HOME);
    const moving = first.moveToFolder();
    expect(await answerNext(first, "confirm", true)).toMatchObject({
      title: expect.stringContaining("folder.move.othersTitle"),
    });
    await answerNext(first, "confirm", false);
    expect(await moving).toBe(true);

    // The other window goes on as the folder, with the project it had open.
    await vi.waitFor(() => expect(folderOf(second)?.record.id).toBe(key));
    expect(second.session.store).toBe(other);
    expect(notices(second).some((said) => said.startsWith("folder.move.movedElsewhere"))).toBe(
      true,
    );
    // What it changes gets into the folder, which one of the two writes.
    other.execute({ type: "project.rename", params: { name: "另一个窗口改的" } });
    await vi.waitFor(() => expect(manifestOn(browser.disk, HOME).name).toBe("另一个窗口改的"));
  });

  it("that have the project open can be left as they are, and then nothing moves", async () => {
    const browser = browserOf();
    const first = windowOf(browser);
    const { key } = await browserProject(browser, first);
    const second = windowOf(browser);
    expect(await second.session.open(key)).toBe(true);
    browser.disk.chooseNext(HOME);
    const moving = first.moveToFolder();
    await answerNext(first, "confirm", false);
    expect(await moving).toBe(false);
    expect(browser.disk.has(HOME)).toBe(false);
    expect(await browser.disk.records.get(key)).toBeUndefined();
  });

  it("that listed it as a project of the browser open it as its folder, and do not take it away", async () => {
    const browser = browserOf();
    const first = windowOf(browser);
    const { key } = await browserProject(browser, first);
    await first.closeProject();
    const second = windowOf(browser);
    const [summary] = await second.session.list();
    if (!summary) throw new Error("No project");

    browser.disk.chooseNext(HOME);
    const moving = first.projectFolders?.moveToFolder(key);
    await answerNext(first, "confirm", false);
    expect(await moving).toBe(true);
    // What the other window lists is out of date, which it hears.
    await vi.waitFor(() => expect(second.projectFolders?.getSnapshot().moves).toBe(1));
    expect(await second.removeProject(summary)).toBe(false);
    expect(notices(second)).toContain('folder.move.removeIsFolder {"name":"片子"}');
    expect((await browser.library.list()).map(({ id }) => id)).toEqual([key]);
    await second.openProject(key);
    await written(second);
    expect(folderOf(second)?.record.id).toBe(key);
  });
});

describe("a project that moved", () => {
  it("that stopped right before the file that says it is not done went, is done once it opens", async () => {
    const browser = browserOf();
    const workbench = windowOf(browser);
    const { key } = await browserProject(browser, workbench);
    await workbench.closeProject();
    for (let attempt = 0; attempt < 3; attempt++) {
      browser.disk.onNext("removeEntry", `${HOME}/${INCOMPLETE_FILE}`, () => {
        throw new DOMException("The page went away", "AbortError");
      });
    }
    browser.disk.chooseNext(HOME);
    const moving = workbench.projectFolders?.moveToFolder(key);
    await answerNext(workbench, "confirm", false);
    expect(await moving).toBe(true);
    expect(browser.disk.has(`${HOME}/${INCOMPLETE_FILE}`)).toBe(true);
    const [record] = (await workbench.projectFolders?.list()) ?? [];
    if (!record) throw new Error("No record");
    await workbench.projectFolders?.openRecent(record);
    await written(workbench);
    expect(browser.disk.has(`${HOME}/${INCOMPLETE_FILE}`)).toBe(false);
    expect((await browser.disk.records.get(key))?.unfinished).toBeUndefined();
  });

  it("gets back the file of an asset that undo brought back, from the copy in the browser", async () => {
    const browser = browserOf();
    const workbench = windowOf(browser);
    const { key, store } = await browserProject(browser, workbench);
    // People took the asset away before the move.
    expect(store.execute({ type: "asset.remove", params: { asset: "asset_pic" } }).ok).toBe(true);
    browser.disk.chooseNext(HOME);
    const moving = workbench.moveToFolder();
    // They let go of the copies right away: the one that no asset uses stays, as the project is open.
    await answerNext(workbench, "confirm", true);
    expect(await moving).toBe(true);
    expect(notices(workbench).at(-1)).toContain("folder.move.releasedUnused");
    expect(await browser.library.copies(key)).toHaveLength(1);

    expect(store.undo().ok).toBe(true);
    await written(workbench);
    await workbench.projectFolders?.assetsChecked();
    const missing = workbench.problems
      .getSnapshot()
      .problems.find(({ file }) => file === "assets/图.png");
    expect(missing?.action?.label).toBe("folder.move.restoreCopy");
    missing?.action?.run();
    await vi.waitFor(() => expect(browser.disk.has(`${HOME}/assets/图.png`)).toBe(true));
    expect(browser.disk.text(`${HOME}/assets/图.png`)).toBe(PICTURE);
    await vi.waitFor(async () => {
      await workbench.projectFolders?.assetsChecked();
      expect(
        workbench.problems.getSnapshot().problems.filter(({ file }) => file === "assets/图.png"),
      ).toEqual([]);
    });
  });
});

describe("a browser that cannot write folders", () => {
  it("has nothing to move projects with, and keeps them where they are", async () => {
    const values = new Map();
    const folders: FolderAccess = {
      chooseSource: async () => undefined,
      chooseTarget: async () => undefined,
      saveFile: () => {},
      chooseFile: async () => undefined,
      reopen: async () => "gone" as const,
      dropTarget: async () => false,
      savesInBrowser: false,
    };
    const host: Host = {
      projects: new MemoryLibrary(),
      address: memoryAddress(),
      windowMemory: memoryWindow(),
      organizer: memoryOrganizer(),
      settings: {
        load: async (key) => values.get(key),
        save: async (key, value) => void values.set(key, value),
        listen: () => () => {},
      },
      folders,
      trials: new MemoryTrials(),
      drafts: new MemoryTrials(),
      exports: new MemoryExports(),
    };
    const workbench = new Workbench({
      host,
      t: ((key: string) => key) as never,
      version: "test",
      platform: "other",
      panels: [],
      layouts,
      compositorUrl: "",
    });
    expect(workbench.projectFolders).toBeUndefined();
    expect(workbench.actions.get("project.moveToFolder")).toBeUndefined();
    expect(workbench.actions.get("project.importFolder")).toBeDefined();
    expect(workbench.actions.get("project.exportFolder")).toBeDefined();
    expect(await workbench.session.create("片子")).toBe(true);
    expect(await workbench.moveToFolder()).toBe(false);
    expect((await host.projects.list()).map(({ folder }) => folder)).toEqual([undefined]);
  });
});

async function hashOf(text: string): Promise<string> {
  return hashFile(new Blob([text]));
}
