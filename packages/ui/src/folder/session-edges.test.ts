/**
 * The folder session where it goes wrong around it: crashes at the wrong moment, what the browser
 * keeps failing, windows that sleep or ask at once, the power taking back a write.
 */
import type { FolderWriter } from "@animaquill/host";
import { ProjectStore } from "@animaquill/core";
import { MANIFEST_FILE, createProject } from "@animaquill/schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { browserFolderWriter } from "../../../host/src/folder-writer.ts";
import {
  CODE,
  LOCAL,
  MAIN,
  NOTES,
  PROJECT,
  TestBrowser,
  clipIn,
  clipName,
  editOnDisk,
  fixture,
  recovered,
  renameClip,
  run,
  textOn,
  type TestWindow,
} from "./folder-support.ts";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const nameOnDisk = (browser: TestBrowser, clip = "clip_title", root = PROJECT) =>
  clipIn(JSON.parse(browser.disk.text(`${root}/${MAIN}`)), clip).name;

/** Has a method of what the browser keeps fail this many times, as a database that is busy. */
function failing<T extends object>(target: T, method: keyof T, times = 1): void {
  const original = (target[method] as (...args: unknown[]) => Promise<unknown>).bind(target);
  let left = times;
  (target as Record<keyof T, unknown>)[method] = async (...args: unknown[]) => {
    if (left-- > 0) throw new DOMException("The database could not be read", "UnknownError");
    return original(...args);
  };
}

describe("what the folder had, that did not all come in", () => {
  it("is kept before the editor writes over it, also when the browser went away first", async () => {
    const browser = new TestBrowser();
    const { store } = await browser.open();
    renameClip(store, "clip_title", "编辑器的");
    editOnDisk(browser.disk, MAIN, (document) => {
      clipIn(document, "clip_title").name = "外面的";
    });
    const theirs = textOn(browser.disk, MAIN);
    // Keeping it starts with .animaquill/.gitignore: the browser goes right then.
    browser.disk.onNext("createWritable", `${PROJECT}/.animaquill/.gitignore`, () =>
      browser.crash(),
    );
    await browser.settle();
    const kept = await browser.disk.folders().bases.load(LOCAL);
    // Its base stays the one before, so that opening again finds the same conflict.
    expect(kept.find(({ path }) => path === MAIN)?.base).not.toBe(theirs);
    const next = await browser.open();
    await browser.settle();
    expect(clipName(next.store, "clip_title")).toBe("编辑器的");
    expect(nameOnDisk(browser)).toBe("编辑器的");
    expect(recovered(browser.disk).get(MAIN)).toEqual([theirs]);
  });

  it("is the base once it is kept, so that what changes after a crash compares with it", async () => {
    const browser = new TestBrowser();
    const { store } = await browser.open();
    renameClip(store, "clip_title", "编辑器的");
    const markerOnDisk = (name: string) =>
      editOnDisk(browser.disk, MAIN, (document) => {
        document.markers.find(({ id }: { id: string }) => id === "marker_hook").name = name;
      });
    editOnDisk(browser.disk, MAIN, (document) => {
      clipIn(document, "clip_title").name = "外面的";
    });
    markerOnDisk("外面的一");
    const theirs = textOn(browser.disk, MAIN);
    // The editor's version lands, and the browser goes before it notes that down.
    browser.disk.onNext("written", `${PROJECT}/${MAIN}`, () => browser.crash());
    await browser.settle();
    expect(nameOnDisk(browser)).toBe("编辑器的");
    // The other program goes on with what is there now.
    markerOnDisk("外面的二");
    const next = await browser.open();
    await browser.settle();
    const marker = () => next.store.getState().timelines["main"]?.markers["marker_hook"]?.name;
    // What came in of the version before is no change of the editor's that would win now.
    expect(marker()).toBe("外面的二");
    expect(clipName(next.store, "clip_title")).toBe("编辑器的");
    expect(next.merges.flatMap(({ conflicts }) => conflicts)).toEqual([]);
    expect(recovered(browser.disk).get(MAIN)).toEqual([theirs]);
  });

  it("is kept from what was read, when the file changes again before it could be kept", async () => {
    const browser = new TestBrowser();
    const { store, merges } = await browser.open();
    renameClip(store, "clip_title", "编辑器的");
    const markerOnDisk = (name: string) =>
      editOnDisk(browser.disk, MAIN, (document) => {
        document.markers.find(({ id }: { id: string }) => id === "marker_hook").name = name;
      });
    editOnDisk(browser.disk, MAIN, (document) => {
      clipIn(document, "clip_title").name = "外面的";
    });
    markerOnDisk("外面的一");
    const theirs = textOn(browser.disk, MAIN);
    // The disk is full right when it is to be kept, and the other program goes on meanwhile.
    browser.disk.onNext("createWritable", `${PROJECT}/.animaquill/.gitignore`, () => {
      markerOnDisk("外面的二");
      throw new DOMException("There is no room", "QuotaExceededError");
    });
    await browser.settle();
    const marker = () => store.getState().timelines["main"]?.markers["marker_hook"]?.name;
    expect(marker()).toBe("外面的二");
    expect(clipName(store, "clip_title")).toBe("编辑器的");
    expect(nameOnDisk(browser)).toBe("编辑器的");
    // Only the first time, what the folder had of the clip did not come in.
    expect(merges.flatMap(({ conflicts }) => conflicts.map(({ path }) => path.at(-2)))).toEqual([
      "clip_title",
    ]);
    expect(recovered(browser.disk).get(MAIN)).toEqual([theirs]);
  });

  it("leaves the base as it was while it cannot be kept, also when the browser goes meanwhile", async () => {
    const browser = new TestBrowser();
    const { store } = await browser.open();
    renameClip(store, "clip_title", "编辑器的");
    // A file is where .animaquill would be: nothing can be kept there for now.
    browser.disk.write(`${PROJECT}/.animaquill`, "挡路的文件", { quietly: true });
    editOnDisk(browser.disk, MAIN, (document) => {
      clipIn(document, "clip_title").name = "外面的";
    });
    const theirs = textOn(browser.disk, MAIN);
    await browser.settle();
    expect(nameOnDisk(browser)).toBe("外面的");
    const kept = await browser.disk.folders().bases.load(LOCAL);
    expect(kept.find(({ path }) => path === MAIN)?.base).not.toBe(theirs);
    // With the old base, the next page finds the same conflict, and keeps what the folder had.
    browser.crash();
    browser.disk.remove(`${PROJECT}/.animaquill`, { quietly: true });
    const next = await browser.open();
    await browser.settle();
    expect(clipName(next.store, "clip_title")).toBe("编辑器的");
    expect(nameOnDisk(browser)).toBe("编辑器的");
    expect(recovered(browser.disk).get(MAIN)).toEqual([theirs]);
  });

  it("is kept while it cannot be yet, also when animaquill.json goes away and comes back", async () => {
    const browser = new TestBrowser();
    const { store } = await browser.open();
    renameClip(store, "clip_title", "编辑器的");
    // Nothing can go into .animaquill for a while: a full disk, say.
    browser.disk.failWrites(`${PROJECT}/.animaquill/.gitignore`, { times: 3 });
    editOnDisk(browser.disk, MAIN, (document) => {
      clipIn(document, "clip_title").name = "外面的";
    });
    const theirs = textOn(browser.disk, MAIN);
    await browser.settle(1500);
    expect(nameOnDisk(browser)).toBe("外面的");
    const manifest = textOn(browser.disk, MANIFEST_FILE);
    browser.disk.remove(`${PROJECT}/${MANIFEST_FILE}`);
    await browser.settle(500);
    browser.disk.write(`${PROJECT}/${MANIFEST_FILE}`, manifest);
    await browser.settle(30_000);
    expect(nameOnDisk(browser)).toBe("编辑器的");
    expect(recovered(browser.disk).get(MAIN)).toEqual([theirs]);
  });

  it("is kept for a file the editor takes away", async () => {
    const browser = new TestBrowser();
    const { store } = await browser.open();
    run(store, "file.write", { path: "code/extra.js", text: "// 新的\n" });
    await browser.settle();
    run(store, "file.remove", { path: "code/extra.js" });
    browser.disk.write(`${PROJECT}/code/extra.js`, "// 新的\n// 外面加的\n");
    await browser.settle();
    expect(browser.disk.has(`${PROJECT}/code/extra.js`)).toBe(false);
    expect(recovered(browser.disk).get("code/extra.js")).toEqual(["// 新的\n// 外面加的\n"]);
  });
});

describe("a crash", () => {
  it("that damaged a write is made good once animaquill.json is back, if it was not there", async () => {
    const browser = new TestBrowser();
    const { store } = await browser.open();
    browser.disk.onNext("written", `${PROJECT}/${MAIN}`, () => {
      const length = browser.disk.bytes(`${PROJECT}/${MAIN}`).length;
      browser.disk.write(`${PROJECT}/${MAIN}`, new Uint8Array(length), { quietly: true });
      browser.crash();
    });
    renameClip(store, "clip_title", "断电");
    await browser.settle();
    // A checkout of a branch without the project, before the editor opens again.
    const manifest = textOn(browser.disk, MANIFEST_FILE);
    browser.disk.remove(`${PROJECT}/${MANIFEST_FILE}`);
    const next = await browser.open();
    await browser.settle();
    expect(next.session.getSnapshot().trouble).toEqual({ reason: "manifest-gone" });
    browser.disk.write(`${PROJECT}/${MANIFEST_FILE}`, manifest);
    await browser.settle();
    expect(next.session.getSnapshot().blocked).toEqual([]);
    expect(nameOnDisk(browser)).toBe("断电");
    expect(recovered(browser.disk).has(MAIN)).toBe(true);
  });

  it.each([
    ["only zeros", (length: number) => new Uint8Array(length)],
    ["empty", () => new Uint8Array()],
  ])("that left code %s right after the editor wrote it makes it good again", async (_, left) => {
    const browser = new TestBrowser();
    const { store } = await browser.open();
    const code = textOn(browser.disk, CODE);
    browser.disk.onNext("written", `${PROJECT}/${CODE}`, () => {
      const length = browser.disk.bytes(`${PROJECT}/${CODE}`).length;
      browser.disk.write(`${PROJECT}/${CODE}`, left(length), { quietly: true });
      browser.crash();
    });
    run(store, "file.write", { path: CODE, text: `${code}// 编辑器加的\n` });
    await browser.settle();
    const next = await browser.open();
    await browser.settle();
    expect(textOn(browser.disk, CODE)).toBe(`${code}// 编辑器加的\n`);
    expect(next.merges).toEqual([]);
  });

  /** Writes a file, and has the power take that back: the file before comes back, time and all. */
  function takenBack(browser: TestBrowser, path: string) {
    const at = `${PROJECT}/${path}`;
    const before = browser.disk.has(at)
      ? { bytes: browser.disk.bytes(at), time: browser.disk.lastModified(at) }
      : undefined;
    browser.disk.onNext("written", at, () => {
      queueMicrotask(() => {
        browser.crash();
        if (before)
          browser.disk.write(at, before.bytes, { quietly: true, lastModified: before.time });
        else browser.disk.remove(at, { quietly: true });
      });
    });
  }

  it("that damaged a write, and another one before it was written again, still gets it written", async () => {
    const browser = new TestBrowser();
    const first = await browser.open();
    const at = `${PROJECT}/${MAIN}`;
    renameClip(first.store, "clip_title", "第一次");
    // The power goes right after the write: the file is as long as what was written, all zeros.
    browser.disk.onNext("written", at, () => {
      browser.disk.write(at, new Uint8Array(browser.disk.bytes(at).length), { quietly: true });
      browser.crash();
    });
    await browser.settle();
    // The next page keeps that, and goes too, right as it writes the file again with what the
    // editor did meanwhile, which is longer.
    const second = await browser.open();
    renameClip(second.store, "clip_title", "第二次，比第一次长一些");
    browser.disk.onNext("createWritable", at, () => browser.crash());
    await browser.settle();
    const third = await browser.open();
    await browser.settle();
    expect(nameOnDisk(browser)).toBe("第二次，比第一次长一些");
    expect(third.session.getSnapshot()).toMatchObject({ status: "saved", blocked: [] });
    expect(recovered(browser.disk).get(MAIN)).toHaveLength(1);
  });

  it("that took back what the editor wrote does not take the old file for a change from outside", async () => {
    const browser = new TestBrowser();
    const { store } = await browser.open();
    takenBack(browser, MAIN);
    renameClip(store, "clip_title", "断电前写的");
    await browser.settle();
    expect(nameOnDisk(browser)).toBe("标题");
    const next = await browser.open();
    await browser.settle();
    expect(clipName(next.store, "clip_title")).toBe("断电前写的");
    expect(nameOnDisk(browser)).toBe("断电前写的");
    expect(next.merges).toEqual([]);
  });

  it("that took back a write noted down already is known, also when the file can be read only later", async () => {
    const browser = new TestBrowser();
    const { store } = await browser.open();
    const at = `${PROJECT}/${MAIN}`;
    const before = { bytes: browser.disk.bytes(at), time: browser.disk.lastModified(at) };
    renameClip(store, "clip_title", "断电前写的");
    await browser.settle();
    expect(nameOnDisk(browser)).toBe("断电前写的");
    // The power goes, and the system had not kept the write after all: the file before is there,
    // time and all. Another program holds on to it for a while.
    browser.crash();
    browser.disk.write(at, before.bytes, { quietly: true, lastModified: before.time });
    browser.faults.unreadable.add(MAIN);
    const next = await browser.open();
    await browser.settle(2000);
    browser.faults.unreadable.delete(MAIN);
    await browser.settle();
    expect(clipName(next.store, "clip_title")).toBe("断电前写的");
    expect(nameOnDisk(browser)).toBe("断电前写的");
    expect(next.merges).toEqual([]);
  });

  it("that took back a new file writes it again, and does not take it away from the project", async () => {
    const browser = new TestBrowser();
    const { store } = await browser.open();
    takenBack(browser, "code/new.js");
    run(store, "file.write", { path: "code/new.js", text: "// 新文件\n" });
    await browser.settle();
    expect(browser.disk.has(`${PROJECT}/code/new.js`)).toBe(false);
    const next = await browser.open();
    await browser.settle();
    expect(next.store.getState().files["code/new.js"]).toBe("// 新文件\n");
    expect(textOn(browser.disk, "code/new.js")).toBe("// 新文件\n");
  });

  it("that brought back a file the editor took away takes it away again", async () => {
    const browser = new TestBrowser();
    const { store } = await browser.open();
    run(store, "file.write", { path: "code/old.js", text: "// 要删的\n" });
    await browser.settle();
    const at = `${PROJECT}/code/old.js`;
    const before = { bytes: browser.disk.bytes(at), time: browser.disk.lastModified(at) };
    browser.disk.onNext("removeEntry", at, () => {
      queueMicrotask(() => {
        browser.crash();
        browser.disk.write(at, before.bytes, { quietly: true, lastModified: before.time });
      });
    });
    run(store, "file.remove", { path: "code/old.js" });
    await browser.settle();
    const next = await browser.open();
    await browser.settle();
    expect(next.store.getState().files["code/old.js"]).toBeUndefined();
    expect(browser.disk.has(at)).toBe(false);
  });
});

describe("what the browser keeps, when it cannot be read", () => {
  it.each(["load", "claim", "turnOf"] as const)(
    "(%s fails once) has the folder wait, and brings back nothing the editor took away",
    async (method) => {
      const browser = new TestBrowser();
      const first = await browser.open();
      run(first.store, "marker.remove", { timeline: "main", marker: "marker_hook" });
      renameClip(first.store, "clip_title", "改了名");
      expect(await first.project.trySave()).toBe(true);
      // The browser goes before the change is written.
      browser.crash();
      const next = await browser.open({ start: false });
      failing(next.folders.bases, method);
      await next.session.start();
      await browser.settle(30_000);
      expect(next.store.getState().timelines["main"]?.markers["marker_hook"]).toBeUndefined();
      expect(clipName(next.store, "clip_title")).toBe("改了名");
      const onDisk = JSON.parse(textOn(browser.disk, MAIN));
      expect(onDisk.markers.some(({ id }: { id: string }) => id === "marker_hook")).toBe(false);
      expect(next.merges).toEqual([]);
    },
  );

  it("has the folder wait while the log cannot be read", async () => {
    const browser = new TestBrowser();
    const first = await browser.open();
    renameClip(first.store, "clip_title", "日志里的");
    expect(await first.project.trySave()).toBe(true);
    browser.crash();
    const next = await browser.open({ start: false });
    // The browser cannot read the log for a moment, right when this window takes over.
    let left = 1;
    browser.library.duringLoad = () => {
      if (left-- > 0) throw new DOMException("The database could not be read", "UnknownError");
    };
    await next.session.start();
    expect(next.session.getSnapshot().status).not.toBe("saved");
    await browser.settle(30_000);
    expect(left).toBe(-1);
    expect(nameOnDisk(browser)).toBe("日志里的");
    expect(next.merges).toEqual([]);
  });

  it("of a newer editor in another tab has this page stop writing, for that one to go on", async () => {
    const browser = new TestBrowser();
    const old = await browser.open({ start: false });
    const claim = old.folders.bases.claim.bind(old.folders.bases);
    vi.spyOn(old.folders.bases, "claim").mockImplementation(async (folder) => {
      await claim(folder);
      throw new DOMException(
        "The requested version is less than the existing version",
        "VersionError",
      );
    });
    await old.session.start();
    await browser.settle();
    expect(old.session.getSnapshot()).toMatchObject({
      role: "stopped",
      trouble: { reason: "outdated" },
    });
    const newer = await browser.open();
    renameClip(newer.store, "clip_title", "新版本的");
    await browser.settle();
    expect(newer.session.getSnapshot().role).toBe("writing");
    expect(nameOnDisk(browser)).toBe("新版本的");
  });
});

describe("the folder of a new project", () => {
  it("gets all of it, animaquill.json last, although it has none yet", async () => {
    const browser = new TestBrowser(undefined, new Map());
    browser.disk.folder(PROJECT);
    const made = ProjectStore.create(createProject({ name: "新的" }));
    await browser.library.create({ id: LOCAL, name: "新的" }, made.encodeState());
    made.destroy();
    const written: string[] = [];
    for (const path of [MANIFEST_FILE, MAIN]) {
      browser.disk.onNext("written", `${PROJECT}/${path}`, () => written.push(path));
    }
    const { session } = await browser.open();
    await browser.settle();
    expect(session.getSnapshot()).toMatchObject({ status: "saved", trouble: undefined });
    expect(JSON.parse(textOn(browser.disk, MANIFEST_FILE)).name).toBe("新的");
    expect(written).toEqual([MAIN, MANIFEST_FILE]);
  });
});

describe("the window that made the project from the folder", () => {
  it("takes over with what another window kept, where it kept nothing in its own first turn", async () => {
    const browser = new TestBrowser();
    // Its first turn cannot keep anything, and it lets go for now.
    browser.faults.bases = true;
    const first = await browser.open();
    browser.faults.bases = false;
    const second = await browser.open();
    await browser.settle();
    expect(second.session.getSnapshot().role).toBe("writing");
    // What the second one changes cannot get into the folder before it goes.
    const at = `${PROJECT}/${MAIN}`;
    const full = () => {
      throw new DOMException("There is no room", "QuotaExceededError");
    };
    const blocks = Array.from({ length: 12 }, () =>
      browser.disk.onNext("createWritable", at, full),
    );
    renameClip(second.store, "clip_title", "第二个窗口改的");
    await browser.settle();
    expect(nameOnDisk(browser)).toBe("标题");
    await second.session.close();
    await second.project.close();
    second.dead = true;
    for (const unblock of blocks) unblock();
    await browser.settle(30_000);
    // What is kept says that the folder did not get it yet: it does now, and does not go back.
    expect(first.session.getSnapshot()).toMatchObject({ role: "writing", status: "saved" });
    expect(clipName(first.store, "clip_title")).toBe("第二个窗口改的");
    expect(nameOnDisk(browser)).toBe("第二个窗口改的");
    expect(first.merges).toEqual([]);
  });
});

describe("a file that cannot be read now", () => {
  it("is said and looked at again in a while, and keeps nothing else from the folder", async () => {
    const browser = new TestBrowser();
    const { store, session, folder } = await browser.open();
    await browser.settle();
    const file = folder.file.bind(folder);
    let reads = 0;
    vi.spyOn(folder, "file").mockImplementation(async (path) => {
      const found = await file(path);
      if (path !== CODE) return found;
      reads += 1;
      // Another program holds on to it.
      const held = new File([], found.name, { lastModified: found.lastModified });
      Object.defineProperty(held, "size", { value: found.size });
      held.arrayBuffer = () =>
        Promise.reject(
          new DOMException("The requested file could not be read", "NotReadableError"),
        );
      return held;
    });
    run(store, "file.write", { path: CODE, text: "export const x = 1;\n" });
    renameClip(store, "clip_title", "时间轴的改动");
    await browser.settle(30_000);
    expect(reads).toBeLessThan(40);
    expect(session.getSnapshot()).toMatchObject({
      status: "unsaved",
      trouble: { reason: "busy", path: CODE },
    });
    expect(nameOnDisk(browser)).toBe("时间轴的改动");
    vi.mocked(folder.file).mockRestore();
    await browser.settle();
    expect(textOn(browser.disk, CODE)).toBe("export const x = 1;\n");
    expect(session.getSnapshot()).toMatchObject({ status: "saved", trouble: undefined });
  });

  it("that another program holds on to for writing keeps only itself from the folder", async () => {
    const browser = new TestBrowser();
    const { store, session } = await browser.open();
    browser.disk.failWrites(`${PROJECT}/${CODE}`, {
      name: "NoModificationAllowedError",
      times: 1000,
    });
    run(store, "file.write", { path: CODE, text: "export const x = 1;\n" });
    renameClip(store, "clip_title", "时间轴的改动");
    await browser.settle(30_000);
    expect(nameOnDisk(browser)).toBe("时间轴的改动");
    expect(session.getSnapshot().trouble).toMatchObject({ reason: "busy", path: CODE });
  });
});

describe("animaquill.json with a byte order mark, as editors on Windows write it", () => {
  it("is still this project when the folder is found again", async () => {
    const browser = new TestBrowser();
    const { session } = await browser.open();
    browser.disk.write(`${PROJECT}/${MANIFEST_FILE}`, `﻿${textOn(browser.disk, MANIFEST_FILE)}`);
    await browser.settle();
    browser.disk.move(PROJECT, `${PROJECT}-搬走`);
    await browser.settle();
    browser.disk.move(`${PROJECT}-搬走`, PROJECT);
    expect(await session.reconnect()).toBe("connected");
  });

  it("of another project is not let in", async () => {
    const browser = new TestBrowser();
    browser.disk.observes = false;
    const { session, store } = await browser.open();
    const manifest = JSON.parse(fixture().get(MANIFEST_FILE) as string);
    manifest.id = "another-project";
    browser.disk.write(`${PROJECT}/${MANIFEST_FILE}`, `﻿${JSON.stringify(manifest)}`, {
      quietly: true,
    });
    renameClip(store, "clip_title", "不该写进去");
    await browser.settle();
    expect(session.getSnapshot().trouble).toEqual({ reason: "replaced" });
    expect(nameOnDisk(browser)).toBe("标题");
  });
});

describe("windows that write in turn", () => {
  it("go on in another one that finds the folder again, while the first one stopped", async () => {
    const browser = new TestBrowser();
    const first = await browser.open();
    const second = await browser.open();
    browser.disk.move(PROJECT, `${PROJECT}-搬走`);
    await browser.settle();
    expect(first.session.getSnapshot()).toMatchObject({
      role: "stopped",
      trouble: { reason: "gone" },
    });
    browser.disk.chooseNext(`${PROJECT}-搬走`);
    const moved = await second.folders.choose();
    expect(await second.session.reconnect(moved as NonNullable<typeof moved>)).toBe("connected");
    renameClip(second.store, "clip_title", "找回以后");
    await browser.settle(30_000);
    expect(second.session.getSnapshot().role).toBe("writing");
    expect(nameOnDisk(browser, "clip_title", `${PROJECT}-搬走`)).toBe("找回以后");
  });

  it("let a new page with the folder write it when the one that wrote it lost it", async () => {
    const browser = new TestBrowser();
    const first = await browser.open();
    browser.disk.move(PROJECT, `${PROJECT}-搬走`);
    await browser.settle();
    expect(first.session.getSnapshot().role).toBe("stopped");
    browser.disk.move(`${PROJECT}-搬走`, PROJECT);
    const next = await browser.open();
    renameClip(next.store, "clip_title", "新页面的");
    await browser.settle();
    expect(next.session.getSnapshot().role).toBe("writing");
    expect(nameOnDisk(browser)).toBe("新页面的");
  });

  it("do not take in a change twice when one slept through the other taking over", async () => {
    const browser = new TestBrowser();
    browser.disk.turns.lateLost = true;
    const first = await browser.open();
    const second = await browser.open({ holding: true });
    browser.disk.sleep(first.folders);
    renameClip(second.store, "clip_title", "第二个的");
    await browser.settle();
    expect(second.session.getSnapshot().role).toBe("writing");
    // It wakes up, and the folder changed while it slept.
    const code = textOn(browser.disk, CODE);
    browser.disk.write(`${PROJECT}/${CODE}`, `// 外面加的\n${code}`);
    browser.disk.sleep(first.folders, false);
    await browser.settle(3000);
    second.arriving.holding = false;
    for (const deliver of second.arriving.updates.splice(0)) deliver();
    await browser.settle();
    const inProject = second.store.getState().files[CODE] ?? "";
    expect(inProject.split("// 外面加的\n").length - 1).toBe(1);
    expect(textOn(browser.disk, CODE).split("// 外面加的\n").length - 1).toBe(1);
  });

  it("do not take in a change twice when one hears late that the other took over", async () => {
    const browser = new TestBrowser();
    let hear = () => {};
    const heard = new Promise<void>((resolve) => {
      hear = resolve;
    });
    const first = await browser.open({
      writer: (writer) => ({
        ...writer,
        claim: async (options) => {
          const claim = await writer.claim(options);
          return { ...claim, lost: claim.lost.then(() => heard) };
        },
      }),
    });
    const second = await browser.open({ holding: true });
    browser.disk.sleep(first.folders);
    renameClip(second.store, "clip_title", "第二个的");
    await browser.settle();
    browser.disk.sleep(first.folders, false);
    const code = textOn(browser.disk, CODE);
    browser.disk.write(`${PROJECT}/${CODE}`, `// 外面加的\n${code}`);
    await browser.settle(3000);
    hear();
    second.arriving.holding = false;
    for (const deliver of second.arriving.updates.splice(0)) deliver();
    await browser.settle();
    const inProject = second.store.getState().files[CODE] ?? "";
    expect(inProject.split("// 外面加的\n").length - 1).toBe(1);
  });

  it("still write when the browser tells late that this one had to wait", async () => {
    const browser = new TestBrowser();
    // The browser says so only once the turn is there already.
    const late = (writer: FolderWriter): FolderWriter => ({
      ...writer,
      claim: async ({ onWaiting, ...options } = {}) => {
        const claim = await writer.claim(options);
        setTimeout(() => onWaiting?.(), 0);
        return claim;
      },
    });
    const { session } = await browser.open({ writer: late });
    await browser.settle();
    expect(session.getSnapshot()).toMatchObject({ role: "writing", status: "saved" });
  });

  it("all get going when the browser tells late that one has to wait", async () => {
    const browser = new TestBrowser();
    browser.disk.turns.lateWaiting = true;
    const first = await browser.open({ start: false });
    const second = await browser.open({ start: false });
    let started = 0;
    void first.session.start().then(() => (started += 1));
    void second.session.start().then(() => (started += 1));
    await browser.settle();
    const roles = [first, second].map(({ session }) => session.getSnapshot().role);
    expect(roles.toSorted()).toEqual(["waiting", "writing"]);
    expect(started).toBe(2);
  });
});

describe("two windows that open the project at the same time, with the Web Locks of Node", () => {
  const locks = () => (globalThis.navigator as Navigator & { locks?: LockManager }).locks;

  it.skipIf(!locks())("leave neither of them starting for good", async () => {
    vi.useRealTimers();
    const browser = new TestBrowser();
    const name = `本机-${Math.random()}`;
    const writer = (): FolderWriter => browserFolderWriter(name, locks);
    const windows: TestWindow[] = [
      await browser.open({ start: false, writer }),
      await browser.open({ start: false, writer }),
    ];
    let started = 0;
    for (const { session } of windows) void session.start().then(() => (started += 1));
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(windows.map(({ session }) => session.getSnapshot().role).toSorted()).toEqual([
      "waiting",
      "writing",
    ]);
    expect(started).toBe(2);
    for (const { session } of windows) await session.close();
  });
});

describe("a batch that would break the project", () => {
  it("waits, and comes in once the project changed so that it does not", async () => {
    const browser = new TestBrowser();
    const { store, session } = await browser.open();
    const merge = store.mergeFiles.bind(store);
    let refusing = true;
    vi.spyOn(store, "mergeFiles").mockImplementation((changes, options) =>
      refusing
        ? {
            ok: false,
            error: { code: "merge-would-break", message: "会出错", problems: [] },
            files: [],
          }
        : merge(changes, options),
    );
    editOnDisk(browser.disk, NOTES, (document) => {
      document.notes[0].text = "外面改的";
    });
    await browser.settle();
    expect(session.getSnapshot().blocked.map(({ path }) => path)).toEqual([NOTES]);
    refusing = false;
    renameClip(store, "clip_title", "项目变了");
    await browser.settle();
    expect(store.getState().notes?.["note_1"]?.text).toBe("外面改的");
    expect(session.getSnapshot().blocked).toEqual([]);
  });

  it("that says no file keeps out only the files that would, one at a time", async () => {
    const browser = new TestBrowser();
    const { store, session } = await browser.open();
    const merge = store.mergeFiles.bind(store);
    vi.spyOn(store, "mergeFiles").mockImplementation((changes, options) =>
      changes.some(({ path }) => path === NOTES)
        ? {
            ok: false,
            error: { code: "merge-would-break", message: "会出错", problems: [] },
            files: [],
          }
        : merge(changes, options),
    );
    editOnDisk(browser.disk, NOTES, (document) => {
      document.notes[0].text = "外面改的";
    });
    editOnDisk(browser.disk, MAIN, (document) => {
      document.markers[0].name = "外面的";
    });
    await browser.settle();
    expect(store.getState().timelines["main"]?.markers["marker_hook"]?.name).toBe("外面的");
    expect(session.getSnapshot().blocked.map(({ path }) => path)).toEqual([NOTES]);
  });
});

describe("the log, when it cannot be written", () => {
  it("does not keep the folder from being written, and says that nothing is noted down", async () => {
    const browser = new TestBrowser();
    const { store, session } = await browser.open();
    browser.library.failing = true;
    renameClip(store, "clip_title", "日志写不进");
    await browser.settle();
    expect(nameOnDisk(browser)).toBe("日志写不进");
    expect(session.getSnapshot()).toMatchObject({ unrecorded: true });
    // Nothing of it is noted down, which would be ahead of the log.
    const kept = (await browser.disk.folders().bases.load(LOCAL)).find(({ path }) => path === MAIN);
    expect(kept?.intent).toBeUndefined();
    expect(kept?.base).not.toContain("日志写不进");
    browser.library.failing = false;
    await browser.settle();
    expect(session.getSnapshot()).toMatchObject({ unrecorded: false, status: "saved" });
  });
});

describe("a project folder that a newer editor wrote", () => {
  it("is not written any more, and the window stops until people update the editor", async () => {
    const browser = new TestBrowser();
    const { store, session } = await browser.open();
    await browser.settle();
    const manifest = JSON.parse(textOn(browser.disk, MANIFEST_FILE));
    browser.disk.write(
      `${PROJECT}/${MANIFEST_FILE}`,
      JSON.stringify({ ...manifest, formatVersion: 99 }, null, 2),
    );
    await browser.settle();
    renameClip(store, "clip_title", "旧编辑器写的");
    await browser.settle();
    expect(session.getSnapshot()).toMatchObject({
      role: "stopped",
      trouble: { reason: "too-new" },
    });
    expect(nameOnDisk(browser)).toBe("标题");
  });
});
