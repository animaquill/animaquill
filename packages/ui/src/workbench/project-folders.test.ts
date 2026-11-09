/**
 * Projects that are folders, as people go through the workbench: new, open, dropped, opened again
 * after a reload, let in again, found again, changed outside, and left for another project.
 */
import { MemoryDisk } from "@animaquill/host/memory";
import { MANIFEST_FILE } from "@animaquill/schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import { editOnDisk, fixture, putProject, textOn } from "../folder/folder-support.ts";
import {
  answer,
  browserOf,
  closeWindows,
  folderOf,
  manifestOn,
  nameOf,
  notices,
  openAt,
  windowOf,
  written,
} from "./folder-windows.ts";
import type { Workbench } from "./workbench.ts";

afterEach(closeWindows);

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
    await vi.waitFor(() => expect(store?.getState().notes?.["note_1"]?.text).not.toBe("外面写的"));
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
    await again.resume();
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
    await again.resume();
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
    await again.load();
    const resuming = again.resume();
    expect(await answer(again, true)).toMatchObject({ title: "transfer.codeTitle" });
    await resuming;
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
    await again.resume();
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
    await second.resume();
    expect(nameOf(second)).toBe("原子是什么");
    await vi.waitFor(() => expect(folderOf(second)?.snapshot.status).toBe("elsewhere"));
    // Nothing comes in there twice, and nothing is said about the folder there.
    expect(notices(second).filter((notice) => notice.startsWith("folder."))).toEqual([]);
  });
});

/** Runs until done, answering every question with what `answers` says, and notes what was asked. */
async function answering(
  workbench: Workbench,
  work: Promise<unknown>,
  answers: (asked: { kind?: string; title?: string; message?: string }) => unknown,
) {
  const asked: { kind?: string; title?: string; message?: string; danger?: boolean }[] = [];
  const state = { done: false };
  void work.finally(() => {
    state.done = true;
  });
  while (!state.done) {
    const dialog = workbench.dialogs.getSnapshot() as
      { kind?: string; title?: string; message?: string; danger?: boolean } | undefined;
    if (dialog && dialog.kind !== "progress") {
      asked.push(dialog);
      workbench.dialogs.answer(answers(dialog) as never);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await work;
  return asked;
}

const titles = (asked: readonly { title?: string }[]) => asked.map(({ title }) => title ?? "");

function emptied(disk: MemoryDisk, path: string) {
  for (const name of disk.names(path)) disk.remove(`${path}/${name}`);
}

/** The example project with another id and name. */
function anotherProject(id: string, name: string) {
  const files = fixture();
  const manifest = JSON.parse(files.get(MANIFEST_FILE) as string);
  files.set(MANIFEST_FILE, JSON.stringify({ ...manifest, id, name }, null, 2));
  return files;
}

/** Opens the example project from its folder, and lets go of it again. */
async function knownFolder(browser: ReturnType<typeof browserOf>, workbench: Workbench) {
  putProject(browser.disk, fixture(), "文档/原子");
  await openAt(browser, workbench, "文档/原子");
  await written(workbench);
  const record = folderOf(workbench)?.record;
  await workbench.closeProject();
  if (!record) throw new Error("Nothing opened");
  return record;
}

describe("a folder this browser knows", () => {
  it("that holds another project now opens that one, as the only record of the folder", async () => {
    const browser = browserOf();
    const workbench = windowOf(browser);
    await knownFolder(browser, workbench);
    emptied(browser.disk, "文档/原子");
    putProject(browser.disk, anotherProject("another", "另一个"), "文档/原子");
    browser.disk.chooseNext("文档/原子");
    const asked = await answering(workbench, workbench.openFolder(), () => true);
    expect(titles(asked)[0]).toContain("folder.replacedTitle");
    expect(workbench.session.store?.getState().manifest.id).toBe("another");
    expect(await workbench.projectFolders?.list()).toHaveLength(1);
  });

  it("that was emptied opens its project, which can be put back", async () => {
    const browser = browserOf();
    const workbench = windowOf(browser);
    const record = await knownFolder(browser, workbench);
    emptied(browser.disk, "文档/原子");
    browser.disk.chooseNext("文档/原子");
    const asked = await answering(workbench, workbench.openFolder(), () => true);
    expect(titles(asked).some((title) => title.includes("folder.emptyTitle"))).toBe(false);
    expect(folderOf(workbench)?.record.id).toBe(record.id);
    await vi.waitFor(() =>
      expect(folderOf(workbench)?.snapshot.trouble).toEqual({ reason: "manifest-gone" }),
    );
    await workbench.projectFolders?.writeEditorContent();
    await written(workbench);
    expect(manifestOn(browser.disk, "文档/原子").name).toBe("原子是什么");
    expect(await workbench.projectFolders?.list()).toHaveLength(1);
  });

  it("without animaquill.json opens its project too, and is not refused", async () => {
    const browser = browserOf();
    const workbench = windowOf(browser);
    const record = await knownFolder(browser, workbench);
    browser.disk.remove(`文档/原子/${MANIFEST_FILE}`);
    browser.disk.chooseNext("文档/原子");
    const asked = await answering(workbench, workbench.openFolder(), () => true);
    expect(asked.map(({ message }) => message)).not.toContain("folder.refused.not-a-project");
    expect(folderOf(workbench)?.record.id).toBe(record.id);
  });

  it("in a newer format does not open, and its files stay as they are", async () => {
    const browser = browserOf();
    const workbench = windowOf(browser);
    const record = await knownFolder(browser, workbench);
    const path = `文档/原子/${MANIFEST_FILE}`;
    const manifest = JSON.parse(browser.disk.text(path));
    browser.disk.write(path, JSON.stringify({ ...manifest, formatVersion: 99 }, null, 2));
    const before = browser.disk.text(path);
    const asked = await answering(
      workbench,
      workbench.projectFolders!.openRecent(record),
      () => true,
    );
    expect(asked.map(({ message }) => message)).toContain("folder.refused.too-new");
    expect(workbench.session.store).toBeUndefined();
    expect(browser.disk.text(path)).toBe(before);
  });

  it("that moved while the browser was closed is offered as that folder, with what it had", async () => {
    const browser = browserOf();
    const first = windowOf(browser);
    putProject(browser.disk, fixture(), "文档/原子");
    await openAt(browser, first, "文档/原子");
    await written(first);
    // A change the folder does not get, as when the page went away right after it.
    browser.disk.block("文档/原子");
    first.session.store?.execute({ type: "project.rename", params: { name: "只在日志里" } });
    await first.session.trySave();
    await first.projectFolders?.close();
    browser.disk.forgetPermissions();
    browser.disk.move("文档/原子", "桌面/原子");
    const again = windowOf(browser);
    browser.disk.chooseNext("桌面/原子");
    const asked = await answering(again, again.openFolder(), (dialog) =>
      dialog.kind === "choice" ? "moved" : true,
    );
    expect(titles(asked).some((title) => title.includes("folder.movedTitle"))).toBe(true);
    expect(nameOf(again)).toBe("只在日志里");
    expect(await again.projectFolders?.list()).toHaveLength(1);
  });
});

describe("a new project", () => {
  it("does not go right into a folder where a project would take files for its own", async () => {
    const browser = browserOf();
    browser.disk.write("文档/仓库/README.md", "# 说明");
    browser.disk.write("文档/仓库/code/util.py", "print('别人的')\n");
    const workbench = windowOf(browser);
    browser.disk.chooseNext("文档/仓库");
    const asked = await answering(workbench, workbench.newProject(), (dialog) =>
      dialog.kind === "prompt" ? "我的片子" : dialog.kind === "choice" ? "inside" : true,
    );
    const choice = asked.find(({ kind }) => kind === "choice") as unknown as {
      choices: { id: string }[];
    };
    expect(choice.choices.map(({ id }) => id)).toEqual(["inside"]);
    await written(workbench);
    expect(manifestOn(browser.disk, "文档/仓库/我的片子").name).toBe("我的片子");
    expect(browser.disk.text("文档/仓库/code/util.py")).toBe("print('别人的')\n");
  });

  it("does not go into the folder of a project this browser knows", async () => {
    const browser = browserOf();
    const outer = windowOf(browser);
    putProject(browser.disk, fixture(), "文档/原子");
    await openAt(browser, outer, "文档/原子");
    await written(outer);
    const other = windowOf(browser);
    browser.disk.chooseNext("文档/原子/scenes");
    const asked = await answering(other, other.newProject(), (dialog) =>
      dialog.kind === "prompt" ? "嵌套的" : true,
    );
    expect(titles(asked)).toContain('folder.insideTitle {"folder":"scenes"}');
    expect(other.session.store).toBeUndefined();
    expect(browser.disk.has("文档/原子/scenes/嵌套的")).toBe(false);
  });

  it("can go next to a project in a folder, and where only what systems leave is", async () => {
    const browser = browserOf();
    putProject(browser.disk, fixture(), "文档/作品/片子A");
    browser.disk.write("文档/新的/.DS_Store", "x");
    const workbench = windowOf(browser);
    const projects = workbench.projectFolders?.projects;
    browser.disk.chooseNext("文档/作品");
    const works = await browser.localFolders.choose();
    expect(await projects?.placeFor(works!, "片子B")).toMatchObject({ kind: "other" });
    browser.disk.chooseNext("文档/新的");
    const fresh = await browser.localFolders.choose();
    expect(await projects?.placeFor(fresh!, "片子")).toEqual({ kind: "empty" });
  });
});

describe("what comes in from outside", () => {
  it("only partly says so, and lists what did not, and where the folder's side is", async () => {
    const browser = browserOf();
    const workbench = windowOf(browser);
    putProject(browser.disk, fixture(), "文档/原子");
    await openAt(browser, workbench, "文档/原子");
    await written(workbench);
    // A clip on a locked track, changed outside: that does not come in.
    const path = "文档/原子/timelines/main/timeline.json";
    const timeline = JSON.parse(browser.disk.text(path));
    const track = timeline.tracks.find(({ id }: { id: string }) => id === "track_overlay");
    track.clips[0].name = "外面改的";
    browser.disk.write(path, JSON.stringify(timeline, null, 2));
    await vi.waitFor(() =>
      expect(notices(workbench).some((notice) => notice.startsWith("folder.mergedPartly"))).toBe(
        true,
      ),
    );
    const listed = workbench.problems.getSnapshot().problems;
    expect(listed.some(({ text }) => text.includes("folder.keptIn"))).toBe(true);
  });

  it("taken back keeps what the folder had first, and can come back", async () => {
    const browser = browserOf();
    const workbench = windowOf(browser);
    putProject(browser.disk, fixture(), "文档/原子");
    await openAt(browser, workbench, "文档/原子");
    await written(workbench);
    editOnDisk(browser.disk, "notes.json", (document) => {
      document.notes[0].text = "外面写的";
    });
    const store = workbench.session.store;
    await vi.waitFor(() => expect(store?.getState().notes?.["note_1"]?.text).toBe("外面写的"));
    const merged = workbench.notifications
      .getSnapshot()
      .find(({ message }) => message.startsWith("folder.merged"));
    merged?.actions?.find(({ label }) => label === "folder.undoMerge")?.run();
    await vi.waitFor(() => expect(store?.getState().notes?.["note_1"]?.text).not.toBe("外面写的"));
    const kept = browser.disk
      .names("文档/原子/.animaquill/recovered")
      .map((stamp) => browser.disk.text(`文档/原子/.animaquill/recovered/${stamp}/notes.json`));
    expect(kept.some((text) => text.includes("外面写的"))).toBe(true);
    const undone = workbench.notifications
      .getSnapshot()
      .find(({ message }) => message.startsWith("folder.undone"));
    undone?.actions?.find(({ label }) => label === "folder.redoMerge")?.run();
    expect(store?.getState().notes?.["note_1"]?.text).toBe("外面写的");
  });
});

describe("a project whose folder was deleted", () => {
  it("can be written somewhere else from what the browser has, and only then", async () => {
    const browser = browserOf();
    const workbench = windowOf(browser);
    putProject(browser.disk, fixture(), "文档/原子");
    await openAt(browser, workbench, "文档/原子");
    await written(workbench);
    browser.disk.failWrites(`文档/原子/${MANIFEST_FILE}`, { times: 1000 });
    workbench.session.store?.execute({ type: "project.rename", params: { name: "只在浏览器里" } });
    await workbench.session.trySave();
    const record = folderOf(workbench)!.record;
    await workbench.closeProject();
    browser.disk.remove("文档/原子");
    // Taking it off the list now loses the only copy: people are told so.
    const removing = workbench.projectFolders!.remove(record);
    expect(await answer(workbench, false)).toMatchObject({
      message: "folder.removeOnlyCopy",
      danger: true,
    });
    expect(await removing).toBe(false);
    browser.disk.folder("桌面/新地方");
    browser.disk.chooseNext("桌面/新地方");
    const asked = await answering(
      workbench,
      workbench.projectFolders!.openRecent(record),
      (dialog) => (dialog.kind === "choice" ? "elsewhere" : true),
    );
    expect(titles(asked)[0]).toContain("folder.goneTitle");
    await written(workbench);
    expect(manifestOn(browser.disk, "桌面/新地方").name).toBe("只在浏览器里");
    expect(folderOf(workbench)?.record.id).toBe(record.id);
  });
});

describe("the log of a project folder", () => {
  it("is no project of the browser, also where its record cannot be found", async () => {
    const browser = browserOf();
    const workbench = windowOf(browser);
    const record = await knownFolder(browser, workbench);
    expect((await browser.library.list()).find(({ id }) => id === record.id)).toMatchObject({
      folder: true,
    });
    await browser.localFolders.records.remove(record.id);
    browser.address.write(record.id);
    const again = windowOf(browser);
    await again.load();
    await again.resume();
    expect(again.session.store).toBeUndefined();
  });

  it("opens by the address only once the page is there to ask people things", async () => {
    const browser = browserOf();
    const workbench = windowOf(browser);
    const record = await knownFolder(browser, workbench);
    browser.address.write(record.id);
    const again = windowOf(browser);
    await again.load();
    expect(again.session.store).toBeUndefined();
    await again.resume();
    expect(nameOf(again)).toBe("原子是什么");
  });
});

describe("a dropped folder", () => {
  it("that is no project is said to be none before the browser asks to write it", async () => {
    const browser = browserOf();
    browser.disk.write("文档/别的/笔记.txt", "笔记");
    // Were the browser to ask, people would say no, and nothing would be said.
    browser.disk.answer = "refuse";
    const workbench = windowOf(browser);
    workbench.projectFolders?.dropped(browser.disk.drop("文档/别的"));
    expect(await answer(workbench, true)).toMatchObject({
      message: "folder.refused.not-a-project",
    });
  });
});
