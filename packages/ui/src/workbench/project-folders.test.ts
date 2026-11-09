/**
 * Projects that are folders, as people go through the workbench: new, open, dropped, opened again
 * after a reload, let in again, found again, changed outside, and left for another project.
 */
import type { FolderAccess, Host, LocalFolders } from "@animaquill/host";
import { MemoryDisk, memoryFolders } from "@animaquill/host/memory";
import { MANIFEST_FILE } from "@animaquill/schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import { editOnDisk, fixture, putProject, textOn } from "../folder/folder-support.ts";
import {
  MemoryExports,
  MemoryLibrary,
  MemoryTrials,
  memoryAddress,
  memoryWindow,
} from "./memory-library.ts";
import { Workbench } from "./workbench.ts";
import { workspaces } from "./workspaces.ts";

const noFolders: FolderAccess = {
  chooseSource: async () => undefined,
  chooseTarget: async () => undefined,
  saveFile: () => {},
  chooseFile: async () => undefined,
  reopen: async () => "gone" as const,
  dropTarget: async () => false,
  savesInBrowser: false,
};

const FAST = { quietMs: 20, longestMs: 200, retryMs: 100, settleMs: 50, answerMs: 100 };

/** A browser, which every window of it shares: the disk, the log of projects, the address. */
function browserOf(disk = new MemoryDisk()) {
  return { disk, library: new MemoryLibrary(), address: memoryAddress(), values: new Map() };
}

const opened: Workbench[] = [];

afterEach(async () => {
  for (const workbench of opened.splice(0)) await workbench.projectFolders?.close();
});

/** A window of that browser, with folders of its own, as a page has. */
function windowOf(browser: ReturnType<typeof browserOf>, localFolders?: LocalFolders) {
  const { values } = browser;
  const host: Host = {
    projects: browser.library,
    address: browser.address,
    windowMemory: memoryWindow(),
    settings: {
      load: async (key) => values.get(key),
      save: async (key, value) => void values.set(key, value),
      listen: () => () => {},
    },
    folders: noFolders,
    localFolders: localFolders ?? memoryFolders(browser.disk),
    trials: new MemoryTrials(),
    drafts: new MemoryTrials(),
    exports: new MemoryExports(),
  };
  const workbench = new Workbench({
    host,
    t: ((key: string, words?: Record<string, unknown>) =>
      words ? `${key} ${JSON.stringify(words)}` : key) as never,
    version: "test",
    platform: "other",
    panels: [],
    workspaces,
    compositorUrl: "",
    folderTiming: FAST,
  });
  opened.push(workbench);
  return workbench;
}

/** Answers the next question, once it is asked. */
async function answer(workbench: Workbench, value: unknown) {
  await vi.waitFor(() => expect(workbench.dialogs.getSnapshot()).toBeDefined());
  const asked = workbench.dialogs.getSnapshot();
  workbench.dialogs.answer(value as never);
  return asked;
}

/** Opens a project folder that this browser does not know yet, which has code in it. */
async function openAt(browser: ReturnType<typeof browserOf>, workbench: Workbench, path: string) {
  browser.disk.chooseNext(path);
  const opening = workbench.openFolder();
  // People hear about the code the first time the project comes into this browser.
  expect(await answer(workbench, true)).toMatchObject({ title: "transfer.codeTitle" });
  await opening;
}

const nameOf = (workbench: Workbench) => workbench.session.store?.getState().manifest.name;
const folderOf = (workbench: Workbench) => workbench.projectFolders?.getSnapshot().open;
const manifestOn = (disk: MemoryDisk, path: string) =>
  JSON.parse(disk.text(`${path}/${MANIFEST_FILE}`)) as { id: string; name: string };
const notices = (workbench: Workbench) =>
  workbench.notifications.getSnapshot().map(({ message }) => message);

/** Until the open folder has everything, as a page that goes on would get there. */
async function written(workbench: Workbench) {
  try {
    await vi.waitFor(() => expect(folderOf(workbench)?.snapshot.status).toBe("saved"), {
      timeout: 3000,
    });
  } catch (error) {
    console.warn("The folder did not get everything", folderOf(workbench)?.snapshot);
    throw error;
  }
}

describe("a new project", () => {
  it("goes into the folder people choose, and the folder gets all of it", async () => {
    const browser = browserOf();
    browser.disk.folder("文档/新的");
    const workbench = windowOf(browser);
    browser.disk.chooseNext("文档/新的");
    const creating = workbench.newProject();
    expect(await answer(workbench, "我的片子")).toMatchObject({
      kind: "prompt",
      hint: "folder.chooseHint",
    });
    await creating;
    expect(nameOf(workbench)).toBe("我的片子");
    await written(workbench);
    expect(manifestOn(browser.disk, "文档/新的")).toMatchObject({ name: "我的片子" });
    // The window shows it by the number of the folder, which its log has too.
    const record = folderOf(workbench)?.record;
    expect(browser.address.read()).toBe(record?.id);
    expect(record?.id).not.toBe(manifestOn(browser.disk, "文档/新的").id);
  });

  it("goes into a folder of its own where other things are, unless people say otherwise", async () => {
    const browser = browserOf();
    browser.disk.write("文档/仓库/README.md", "# 说明");
    const workbench = windowOf(browser);
    browser.disk.chooseNext("文档/仓库");
    const creating = workbench.newProject();
    await answer(workbench, "我的片子");
    expect(await answer(workbench, "inside")).toMatchObject({ kind: "choice" });
    await creating;
    await written(workbench);
    expect(manifestOn(browser.disk, "文档/仓库/我的片子").name).toBe("我的片子");
    expect(browser.disk.text("文档/仓库/README.md")).toBe("# 说明");
  });
});

describe("a project folder people open", () => {
  it("comes in once, and what changes on either side is in the other one", async () => {
    const browser = browserOf();
    putProject(browser.disk, fixture(), "文档/原子");
    const workbench = windowOf(browser);
    await openAt(browser, workbench, "文档/原子");
    expect(nameOf(workbench)).toBe("原子是什么");
    await written(workbench);
    const store = workbench.session.store;
    store?.execute({ type: "project.rename", params: { name: "改过的" } });
    await vi.waitFor(() => expect(manifestOn(browser.disk, "文档/原子").name).toBe("改过的"));
    editOnDisk(browser.disk, "notes.json", (document) => {
      document.notes[0].text = "外面写的";
    });
    await vi.waitFor(() => expect(store?.getState().notes?.["note_1"]?.text).toBe("外面写的"));
    // It said so, and it can be taken back as a whole.
    const said = workbench.notifications
      .getSnapshot()
      .find(({ message }) => message.startsWith("folder.merged"));
    expect(said?.actions?.map(({ label }) => label)).toContain("folder.undoMerge");
    said?.actions?.find(({ label }) => label === "folder.undoMerge")?.run();
    expect(store?.getState().notes?.["note_1"]?.text).not.toBe("外面写的");
    await vi.waitFor(() =>
      expect(JSON.parse(textOn(browser.disk, "notes.json")).notes[0].text).not.toBe("外面写的"),
    );
  });

  it("that was dropped opens after people let the editor write it", async () => {
    const browser = browserOf();
    putProject(browser.disk, fixture(), "文档/原子");
    const workbench = windowOf(browser);
    workbench.projectFolders?.dropped(browser.disk.drop("文档/原子"));
    expect(await answer(workbench, true)).toMatchObject({ title: "transfer.codeTitle" });
    await vi.waitFor(() => expect(nameOf(workbench)).toBe("原子是什么"));
    await written(workbench);
  });

  it("that was dropped where the browser does not let it ask opens with one more press", async () => {
    const browser = browserOf();
    putProject(browser.disk, fixture(), "文档/原子");
    const workbench = windowOf(browser);
    const transfer = browser.disk.drop("文档/原子");
    // This browser does not count dropping as a click.
    browser.disk.activation = false;
    workbench.projectFolders?.dropped(transfer);
    await vi.waitFor(() =>
      expect(workbench.dialogs.getSnapshot()).toMatchObject({
        title: expect.stringContaining("folder.openTitle"),
      }),
    );
    browser.disk.activation = true;
    workbench.dialogs.answer(true);
    expect(await answer(workbench, true)).toMatchObject({ title: "transfer.codeTitle" });
    await vi.waitFor(() => expect(nameOf(workbench)).toBe("原子是什么"));
    await written(workbench);
  });

  it("that is empty can become a new project", async () => {
    const browser = browserOf();
    browser.disk.folder("文档/空的");
    const workbench = windowOf(browser);
    browser.disk.chooseNext("文档/空的");
    const opening = workbench.openFolder();
    expect(await answer(workbench, true)).toMatchObject({
      title: expect.stringContaining("folder.emptyTitle"),
    });
    await answer(workbench, "空的里的");
    await opening;
    expect(nameOf(workbench)).toBe("空的里的");
    await written(workbench);
    expect(manifestOn(browser.disk, "文档/空的").name).toBe("空的里的");
  });

  it("that is no project is said to be none, and nothing opens", async () => {
    const browser = browserOf();
    browser.disk.write("文档/别的/笔记.txt", "笔记");
    const workbench = windowOf(browser);
    browser.disk.chooseNext("文档/别的");
    const opening = workbench.openFolder();
    expect(await answer(workbench, true)).toMatchObject({
      message: "folder.refused.not-a-project",
    });
    await opening;
    expect(workbench.session.store).toBeUndefined();
  });
});

describe("a project folder after a reload", () => {
  it("opens again by itself while the editor may write it", async () => {
    const browser = browserOf();
    putProject(browser.disk, fixture(), "文档/原子");
    const first = windowOf(browser);
    await openAt(browser, first, "文档/原子");
    await written(first);
    await first.projectFolders?.close();
    const again = windowOf(browser);
    await again.load();
    expect(nameOf(again)).toBe("原子是什么");
    expect(folderOf(again)?.record.folder.name).toBe("原子");
  });

  it("waits for people to let the editor at it, and opens with one press", async () => {
    const browser = browserOf();
    putProject(browser.disk, fixture(), "文档/原子");
    const first = windowOf(browser);
    await openAt(browser, first, "文档/原子");
    await written(first);
    await first.projectFolders?.close();
    // The browser was closed: it asks again, once people do something.
    browser.disk.forgetPermissions();
    const again = windowOf(browser);
    await again.load();
    expect(again.session.store).toBeUndefined();
    const waiting = again.projectFolders?.getSnapshot().waiting;
    expect(waiting).toMatchObject({ status: "ask", record: { name: "原子是什么" } });
    // The address stays, or a reload would not come back to it.
    expect(browser.address.read()).toBe(waiting?.record.id);
    browser.disk.activation = true;
    await again.projectFolders?.openRecent(waiting!.record);
    expect(nameOf(again)).toBe("原子是什么");
    expect(again.projectFolders?.getSnapshot().waiting).toBeUndefined();
  });

  it("comes from the folder again where the browser lost its log", async () => {
    const browser = browserOf();
    putProject(browser.disk, fixture(), "文档/原子");
    const first = windowOf(browser);
    await openAt(browser, first, "文档/原子");
    await written(first);
    const id = folderOf(first)?.record.id as string;
    await first.closeProject();
    // As when the data of the site was cleared, but for the folders the browser knows.
    await browser.library.remove(id);
    browser.address.write(id);
    const again = windowOf(browser);
    const loading = again.load();
    expect(await answer(again, true)).toMatchObject({ title: "transfer.codeTitle" });
    await loading;
    expect(nameOf(again)).toBe("原子是什么");
    expect(folderOf(again)?.record.id).toBe(id);
  });

  it("that is not where it was can be found again, and is the same project", async () => {
    const browser = browserOf();
    putProject(browser.disk, fixture(), "文档/原子");
    const first = windowOf(browser);
    await openAt(browser, first, "文档/原子");
    await written(first);
    await first.projectFolders?.close();
    browser.disk.move("文档/原子", "桌面/原子");
    const again = windowOf(browser);
    await again.load();
    const waiting = again.projectFolders?.getSnapshot().waiting;
    expect(waiting).toMatchObject({ status: "gone" });
    browser.disk.chooseNext("桌面/原子");
    await again.projectFolders?.findAgain(waiting!.record);
    expect(nameOf(again)).toBe("原子是什么");
    expect(folderOf(again)?.record.id).toBe(waiting?.record.id);
  });
});

describe("the open project folder", () => {
  it("gets what is waiting when people press Ctrl+S, and lets go for the next project", async () => {
    const browser = browserOf();
    putProject(browser.disk, fixture(), "文档/原子");
    const workbench = windowOf(browser);
    await openAt(browser, workbench, "文档/原子");
    await written(workbench);
    const session = workbench.projectFolders?.session;
    workbench.session.store?.execute({ type: "project.rename", params: { name: "马上写" } });
    await workbench.save();
    expect(manifestOn(browser.disk, "文档/原子").name).toBe("马上写");
    // Another project: the folder is written and let go, for whichever window comes next.
    await workbench.closeProject();
    expect(session?.getSnapshot().role).toBe("closed");
    expect(folderOf(workbench)).toBeUndefined();
    expect(workbench.problems.getSnapshot().problems).toEqual([]);
  });

  it("is written by one window, and the other one says so", async () => {
    const browser = browserOf();
    putProject(browser.disk, fixture(), "文档/原子");
    const first = windowOf(browser);
    await openAt(browser, first, "文档/原子");
    await written(first);
    const second = windowOf(browser);
    await second.load();
    expect(nameOf(second)).toBe("原子是什么");
    await vi.waitFor(() => expect(folderOf(second)?.snapshot.status).toBe("elsewhere"));
    // Nothing comes in there twice, and nothing is said about the folder there.
    expect(notices(second).filter((notice) => notice.startsWith("folder."))).toEqual([]);
  });
});
