import { MANIFEST_FILE } from "@animaquill/schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  filesOf,
  fixture,
  recovered,
  renameClip,
  run,
  textOn,
} from "./folder-support.ts";
import { RECOVERED_FOLDER } from "./session.ts";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const noteText = (browser: TestBrowser) => JSON.parse(textOn(browser.disk, NOTES)).notes[0].text;

describe("opening a project folder", () => {
  it("reads it, and writes nothing back that is only written another way", async () => {
    const browser = new TestBrowser();
    const before = filesOf(browser.disk);
    const { session } = await browser.open();
    await browser.settle();
    expect(filesOf(browser.disk)).toEqual(before);
    expect(session.getSnapshot()).toMatchObject({ role: "writing", status: "saved" });
    // What it read is kept as the base of each file.
    const records = await browser.disk.folders().bases.load(LOCAL);
    expect(records.map(({ path }) => path).toSorted()).toContain(MAIN);
    expect(records.find(({ path }) => path === MAIN)?.base).toBe(before.get(MAIN));
  });

  it("leaves what is not the project's alone", async () => {
    const browser = new TestBrowser();
    browser.disk.write(`${PROJECT}/.git/config`, "[core]");
    browser.disk.write(`${PROJECT}/README.md`, "# 原子");
    const { store } = await browser.open();
    run(store, "project.rename", { name: "新名字" });
    renameClip(store, "clip_title", "新标题");
    await browser.settle();
    const files = filesOf(browser.disk);
    expect(files.get(".git/config")).toBe("[core]");
    expect(files.get("README.md")).toBe("# 原子");
    expect(files.get("AGENTS.md")).toBe(fixture().get("AGENTS.md"));
    expect(files.get("制作笔记/分镜.md")).toBe(fixture().get("制作笔记/分镜.md"));
  });
});

describe("writing the folder", () => {
  it("writes what changed once people stop, and only that", async () => {
    const browser = new TestBrowser();
    const { store, session } = await browser.open();
    const before = filesOf(browser.disk);
    renameClip(store, "clip_title", "新标题");
    await vi.advanceTimersByTimeAsync(900);
    expect(textOn(browser.disk, MAIN)).toBe(before.get(MAIN));
    expect(session.getSnapshot().status).toBe("saving");
    await browser.settle();
    expect(clipIn(JSON.parse(textOn(browser.disk, MAIN)), "clip_title").name).toBe("新标题");
    const after = filesOf(browser.disk);
    const changed = [...after.keys()].filter((path) => after.get(path) !== before.get(path));
    expect(changed).toEqual([MAIN]);
    expect(session.getSnapshot().status).toBe("saved");
  });

  it("writes within five seconds while people keep changing things", async () => {
    const browser = new TestBrowser();
    const { store } = await browser.open();
    for (let round = 0; round < 12; round++) {
      renameClip(store, "clip_title", `第 ${round} 次`);
      await browser.settle(500);
    }
    // Six seconds of changes, never a second without one.
    expect(clipIn(JSON.parse(textOn(browser.disk, MAIN)), "clip_title").name).not.toBe("标题");
  });

  it("writes right away when asked to", async () => {
    const browser = new TestBrowser();
    const { store, session } = await browser.open();
    renameClip(store, "clip_title", "马上");
    expect(await session.flush()).toBe(true);
    expect(clipIn(JSON.parse(textOn(browser.disk, MAIN)), "clip_title").name).toBe("马上");
  });

  it("writes what others refer to first, and animaquill.json last", async () => {
    const browser = new TestBrowser();
    const { store, session } = await browser.open();
    const order: string[] = [];
    for (const path of [MAIN, MANIFEST_FILE, CODE, "scenes/title/scene.json"]) {
      browser.disk.onNext("written", `${PROJECT}/${path}`, () => order.push(path));
    }
    run(store, "project.rename", { name: "新名字" });
    renameClip(store, "clip_title", "新标题");
    run(store, "file.write", { path: CODE, text: "export const x = 1;\n" });
    run(store, "scene.update", { scene: "title", changes: { name: "新场景" } });
    await session.flush();
    expect(order).toEqual([CODE, "scenes/title/scene.json", MAIN, MANIFEST_FILE]);
  });

  it("takes away the files of what the editor took away, and nothing else", async () => {
    const browser = new TestBrowser();
    const { store, session } = await browser.open();
    browser.disk.write(`${PROJECT}/code/notes.txt`, "别人的");
    run(store, "file.write", { path: "code/extra.js", text: "// 新的\n" });
    await session.flush();
    expect(textOn(browser.disk, "code/extra.js")).toBe("// 新的\n");
    run(store, "file.remove", { path: "code/extra.js" });
    await session.flush();
    expect(browser.disk.has(`${PROJECT}/code/extra.js`)).toBe(false);
    expect(textOn(browser.disk, "code/notes.txt")).toBe("别人的");
  });

  it("does not write over a change that kept the size and the time, which nobody told of", async () => {
    const browser = new TestBrowser({ system: "linux" });
    const { store } = await browser.open();
    const before = textOn(browser.disk, MAIN);
    // "钩子" to "钓子": as many bytes, and the program puts the time back.
    browser.disk.write(`${PROJECT}/${MAIN}`, before.replace("钩子", "钓子"), {
      quietly: true,
      keepTime: true,
    });
    renameClip(store, "clip_title", "编辑器的");
    await browser.settle();
    const written = JSON.parse(textOn(browser.disk, MAIN));
    expect(written.markers[0].name).toBe("钓子");
    expect(clipIn(written, "clip_title").name).toBe("编辑器的");
  });

  it("does not write over what another program wrote just before, and takes it in", async () => {
    const browser = new TestBrowser();
    const { store } = await browser.open();
    renameClip(store, "clip_title", "编辑器的");
    browser.disk.onNext("createWritable", `${PROJECT}/${MAIN}`, () => {
      editOnDisk(browser.disk, MAIN, (document) => {
        document.markers[0].name = "外面的";
      });
    });
    await browser.settle();
    const written = JSON.parse(textOn(browser.disk, MAIN));
    expect(clipIn(written, "clip_title").name).toBe("编辑器的");
    expect(written.markers[0].name).toBe("外面的");
    expect(store.getState().timelines["main"]?.markers["marker_hook"]?.name).toBe("外面的");
  });
});

describe("what other programs change", () => {
  it("comes in, and the file stays as they wrote it", async () => {
    const browser = new TestBrowser();
    const { store, session, merges } = await browser.open();
    editOnDisk(browser.disk, NOTES, (document) => {
      document.notes[0].text = "外面改的";
    });
    const written = textOn(browser.disk, NOTES);
    await browser.settle();
    expect(store.getState().notes?.["note_1"]?.text).toBe("外面改的");
    expect(textOn(browser.disk, NOTES)).toBe(written);
    expect(merges).toHaveLength(1);
    expect(session.getSnapshot().status).toBe("saved");
  });

  it("can be taken back, which writes the editor's side again", async () => {
    const browser = new TestBrowser();
    const { store, merges } = await browser.open();
    editOnDisk(browser.disk, NOTES, (document) => {
      document.notes[0].text = "外面改的";
    });
    await browser.settle();
    const [merge] = merges;
    expect(store.undoOrigin(merge?.origin as string).ok).toBe(true);
    await browser.settle();
    expect(noteText(browser)).toBe("字再大一点，放到画面上方");
  });

  it("comes in with what the editor has not written yet", async () => {
    const browser = new TestBrowser();
    const { store } = await browser.open();
    renameClip(store, "clip_title", "编辑器的");
    editOnDisk(browser.disk, MAIN, (document) => {
      document.markers[0].name = "外面的";
    });
    await browser.settle();
    const written = JSON.parse(textOn(browser.disk, MAIN));
    expect(clipIn(written, "clip_title").name).toBe("编辑器的");
    expect(written.markers[0].name).toBe("外面的");
  });

  it("keeps what the folder had in recovered before the editor's side of a conflict replaces it", async () => {
    const browser = new TestBrowser();
    const { store, merges } = await browser.open();
    renameClip(store, "clip_title", "编辑器的");
    editOnDisk(browser.disk, MAIN, (document) => {
      clipIn(document, "clip_title").name = "外面的";
    });
    const theirs = textOn(browser.disk, MAIN);
    await browser.settle();
    expect(clipName(store, "clip_title")).toBe("编辑器的");
    expect(merges.flatMap(({ conflicts }) => conflicts)).toHaveLength(1);
    expect(clipIn(JSON.parse(textOn(browser.disk, MAIN)), "clip_title").name).toBe("编辑器的");
    expect(recovered(browser.disk).get(MAIN)).toEqual([theirs]);
    expect(textOn(browser.disk, ".animaquill/.gitignore")).toBe("*\n");
    // In a folder named by when, in the time of this computer.
    expect(browser.disk.names(`${PROJECT}/${RECOVERED_FOLDER}`)).toEqual([
      expect.stringMatching(/^\d{4}-\d\d-\d\d \d\d\.\d\d\.\d\d$/),
    ]);
  });

  it("keeps what the folder had also when it was written again the same way just before", async () => {
    const browser = new TestBrowser();
    const { store, session } = await browser.open();
    renameClip(store, "clip_title", "编辑器的");
    editOnDisk(browser.disk, MAIN, (document) => {
      clipIn(document, "clip_title").name = "外面的";
    });
    const theirs = textOn(browser.disk, MAIN);
    // Right after it came in, before the editor keeps it and writes its side, a program saves the
    // same file again.
    session.onMerge(() => {
      browser.disk.onNext("getFile", `${PROJECT}/${MAIN}`, () => {
        browser.disk.write(`${PROJECT}/${MAIN}`, theirs, { quietly: true });
      });
    });
    await browser.settle();
    expect(clipIn(JSON.parse(textOn(browser.disk, MAIN)), "clip_title").name).toBe("编辑器的");
    expect(
      recovered(browser.disk)
        .get(MAIN)
        ?.every((kept) => kept === theirs),
    ).toBe(true);
    expect(session.getSnapshot()).toMatchObject({ status: "saved", blocked: [] });
  });

  it("are taken in once, by lines, for code", async () => {
    const browser = new TestBrowser();
    const { store, session } = await browser.open();
    const code = textOn(browser.disk, CODE);
    browser.disk.write(`${PROJECT}/${CODE}`, `// 外面加的\n${code}`);
    run(store, "file.write", { path: CODE, text: `${code}// 编辑器加的\n` });
    await browser.settle();
    await session.flush();
    expect(textOn(browser.disk, CODE)).toBe(`// 外面加的\n${code}// 编辑器加的\n`);
    expect(store.getState().files[CODE]).toBe(`// 外面加的\n${code}// 编辑器加的\n`);
  });
});

describe("a file that waits for people", () => {
  it("is not written while it cannot be read, and comes in once it is fixed", async () => {
    const browser = new TestBrowser();
    const { store, session } = await browser.open();
    browser.disk.write(`${PROJECT}/${MAIN}`, "{坏了");
    await browser.settle();
    expect(session.getSnapshot().blocked.map(({ path }) => path)).toContain(MAIN);
    renameClip(store, "clip_title", "编辑器的");
    await browser.settle();
    expect(textOn(browser.disk, MAIN)).toBe("{坏了");
    const fixed = JSON.parse(fixture().get(MAIN) as string);
    fixed.markers[0].name = "修好了";
    browser.disk.write(`${PROJECT}/${MAIN}`, JSON.stringify(fixed));
    await browser.settle();
    expect(session.getSnapshot().blocked).toEqual([]);
    const written = JSON.parse(textOn(browser.disk, MAIN));
    expect(written.markers[0].name).toBe("修好了");
    expect(clipIn(written, "clip_title").name).toBe("编辑器的");
  });

  it("gets the editor's content when people want it, and is kept in recovered first", async () => {
    const browser = new TestBrowser();
    const { store, session } = await browser.open();
    browser.disk.write(`${PROJECT}/${MAIN}`, "{坏了");
    await browser.settle();
    expect(await session.useEditorContent([MAIN])).toBe(true);
    expect(recovered(browser.disk).get(MAIN)).toEqual(["{坏了"]);
    expect(JSON.parse(textOn(browser.disk, MAIN)).name).toBe(
      store.getState().timelines["main"]?.name,
    );
    expect(session.getSnapshot().blocked).toEqual([]);
  });

  it("is one that went away outside while the project uses it", async () => {
    const browser = new TestBrowser();
    const { store, session } = await browser.open();
    browser.disk.remove(`${PROJECT}/scenes/title/scene.json`);
    await browser.settle();
    expect(store.getState().scenes["title"]).toBeDefined();
    expect(session.getSnapshot().blocked).toEqual([
      expect.objectContaining({ path: "scenes/title/scene.json", present: false }),
    ]);
    expect(browser.disk.has(`${PROJECT}/scenes/title/scene.json`)).toBe(false);
    await session.useEditorContent();
    expect(browser.disk.has(`${PROJECT}/scenes/title/scene.json`)).toBe(true);
  });
});

describe("animaquill.json going away", () => {
  it("stops all writing until it is back", async () => {
    const browser = new TestBrowser();
    const { store, session } = await browser.open();
    const manifest = textOn(browser.disk, MANIFEST_FILE);
    browser.disk.remove(`${PROJECT}/${MANIFEST_FILE}`);
    await browser.settle();
    expect(session.getSnapshot().trouble).toEqual({ reason: "manifest-gone" });
    renameClip(store, "clip_title", "编辑器的");
    await browser.settle();
    expect(clipIn(JSON.parse(textOn(browser.disk, MAIN)), "clip_title").name).toBe("标题");
    browser.disk.write(`${PROJECT}/${MANIFEST_FILE}`, manifest);
    await browser.settle();
    expect(session.getSnapshot().trouble).toBeUndefined();
    expect(clipIn(JSON.parse(textOn(browser.disk, MAIN)), "clip_title").name).toBe("编辑器的");
  });

  it("is restored with the project when people want the editor's content", async () => {
    const browser = new TestBrowser();
    const { session } = await browser.open();
    for (const path of filesOf(browser.disk).keys()) browser.disk.remove(`${PROJECT}/${path}`);
    await browser.settle();
    expect(session.getSnapshot().trouble).toEqual({ reason: "manifest-gone" });
    await session.useEditorContent();
    const files = filesOf(browser.disk);
    expect(files.has(MANIFEST_FILE)).toBe(true);
    expect(files.has(MAIN)).toBe(true);
    expect(files.has(CODE)).toBe(true);
    expect(session.getSnapshot().trouble).toBeUndefined();
  });
});

describe("a crash", () => {
  it("before writing leaves the change in the log, which goes to the folder the next time", async () => {
    const browser = new TestBrowser();
    const { store, project } = await browser.open();
    renameClip(store, "clip_title", "崩溃前");
    await project.trySave();
    browser.crash();
    const next = await browser.open();
    await browser.settle();
    expect(clipName(next.store, "clip_title")).toBe("崩溃前");
    expect(clipIn(JSON.parse(textOn(browser.disk, MAIN)), "clip_title").name).toBe("崩溃前");
  });

  it("right after writing, before noting it down, takes the file as the editor's own", async () => {
    const browser = new TestBrowser();
    const { store } = await browser.open();
    browser.disk.onNext("written", `${PROJECT}/${MAIN}`, () => browser.crash());
    renameClip(store, "clip_title", "写完就崩");
    await browser.settle();
    const written = textOn(browser.disk, MAIN);
    const next = await browser.open();
    await browser.settle();
    expect(next.merges).toEqual([]);
    expect(textOn(browser.disk, MAIN)).toBe(written);
    expect(clipName(next.store, "clip_title")).toBe("写完就崩");
  });

  it.each([
    ["empty", () => new Uint8Array()],
    ["as long, with nothing in it", (length: number) => new Uint8Array(length)],
  ])("that left a file the editor wrote %s keeps it, and writes it again", async (_, left) => {
    const browser = new TestBrowser();
    const { store } = await browser.open();
    let damaged = "";
    browser.disk.onNext("written", `${PROJECT}/${MAIN}`, () => {
      const bytes = left(browser.disk.bytes(`${PROJECT}/${MAIN}`).length);
      browser.disk.write(`${PROJECT}/${MAIN}`, bytes, { quietly: true });
      damaged = browser.disk.text(`${PROJECT}/${MAIN}`);
      browser.crash();
    });
    renameClip(store, "clip_title", "断电");
    await browser.settle();
    const next = await browser.open();
    await browser.settle();
    expect(recovered(browser.disk).get(MAIN)).toEqual([damaged]);
    expect(clipIn(JSON.parse(textOn(browser.disk, MAIN)), "clip_title").name).toBe("断电");
    expect(next.session.getSnapshot().blocked).toEqual([]);
  });

  it("restores a damaged file also when something wrote the same into it again meanwhile", async () => {
    const browser = new TestBrowser();
    const { store } = await browser.open();
    browser.disk.onNext("written", `${PROJECT}/${MAIN}`, () => {
      const length = browser.disk.bytes(`${PROJECT}/${MAIN}`).length;
      browser.disk.write(`${PROJECT}/${MAIN}`, new Uint8Array(length), { quietly: true });
      browser.crash();
    });
    renameClip(store, "clip_title", "断电");
    await browser.settle();
    // Right as the editor writes it again, a program writes the same bytes, with a new time.
    browser.disk.onNext("createWritable", `${PROJECT}/${MAIN}`, () => {
      const bytes = browser.disk.bytes(`${PROJECT}/${MAIN}`);
      browser.disk.write(`${PROJECT}/${MAIN}`, bytes, { quietly: true });
    });
    const next = await browser.open();
    await browser.settle();
    expect(clipIn(JSON.parse(textOn(browser.disk, MAIN)), "clip_title").name).toBe("断电");
    expect(next.session.getSnapshot()).toMatchObject({ status: "saved", blocked: [] });
  });

  it("leaves a file that another program broke while the editor wrote it to people", async () => {
    const browser = new TestBrowser();
    const { store } = await browser.open();
    // Another program writes right after the editor, and the power goes before it noted that down.
    browser.disk.onNext("written", `${PROJECT}/${MAIN}`, () => {
      browser.disk.write(`${PROJECT}/${MAIN}`, "{坏了", { quietly: true });
      browser.crash();
    });
    renameClip(store, "clip_title", "断电");
    await browser.settle();
    const next = await browser.open();
    await browser.settle();
    expect(textOn(browser.disk, MAIN)).toBe("{坏了");
    expect(next.session.getSnapshot().blocked.map(({ path }) => path)).toEqual([MAIN]);
  });

  it("is lived through again by what the other program fixes later, without taking back the editor's changes", async () => {
    const browser = new TestBrowser();
    const { store } = await browser.open();
    const good = textOn(browser.disk, MAIN);
    browser.disk.onNext("written", `${PROJECT}/${MAIN}`, () => {
      browser.disk.write(`${PROJECT}/${MAIN}`, "{坏了", { quietly: true });
      browser.crash();
    });
    renameClip(store, "clip_title", "第一次");
    await browser.settle();
    const next = await browser.open();
    renameClip(next.store, "clip_logo", "第二次");
    await browser.settle();
    // What the program fixes it with is what it had before it broke it, and one change of its own.
    const fixed = JSON.parse(good);
    fixed.markers[0].name = "修好了";
    browser.disk.write(`${PROJECT}/${MAIN}`, JSON.stringify(fixed));
    await browser.settle();
    const written = JSON.parse(textOn(browser.disk, MAIN));
    expect(written.markers[0].name).toBe("修好了");
    expect(clipIn(written, "clip_title").name).toBe("第一次");
    expect(clipIn(written, "clip_logo").name).toBe("第二次");
  });

  it("takes away what writing left behind on Linux", async () => {
    const browser = new TestBrowser({ system: "linux" });
    const { store } = await browser.open();
    browser.disk.onNext("createWritable", `${PROJECT}/${MAIN}`, () => {
      queueMicrotask(() => browser.crash());
    });
    renameClip(store, "clip_title", "写到一半");
    await browser.settle();
    expect(browser.disk.names(`${PROJECT}/timelines/main`)).toContain("timeline.json.crswap");
    await browser.open();
    await browser.settle();
    expect(browser.disk.names(`${PROJECT}/timelines/main`)).not.toContain("timeline.json.crswap");
    expect(clipIn(JSON.parse(textOn(browser.disk, MAIN)), "clip_title").name).toBe("写到一半");
  });
});

describe("what is kept about the folder", () => {
  it("is only what the log has, so that a crash leaves the folder ahead, never behind", async () => {
    const browser = new TestBrowser();
    const { store } = await browser.open();
    const records = browser.disk.folders().bases;
    const before = (await records.load(LOCAL)).find(({ path }) => path === MAIN)?.base;
    browser.library.failing = true;
    renameClip(store, "clip_title", "日志写不进");
    await browser.settle();
    // The folder has it, but nothing says that the editor wrote it.
    expect(clipIn(JSON.parse(textOn(browser.disk, MAIN)), "clip_title").name).toBe("日志写不进");
    expect((await records.load(LOCAL)).find(({ path }) => path === MAIN)?.base).toBe(before);
    browser.crash();
    browser.library.failing = false;
    const next = await browser.open();
    await browser.settle();
    expect(clipName(next.store, "clip_title")).toBe("日志写不进");
  });

  it("is the folder when nothing is kept, which can be taken back", async () => {
    const browser = new TestBrowser();
    const first = await browser.open();
    await first.session.close();
    await first.project.close();
    await browser.disk.folders().bases.forget(LOCAL);
    editOnDisk(browser.disk, NOTES, (document) => {
      document.notes[0].text = "关着时改的";
    });
    const next = await browser.open();
    await browser.settle();
    expect(next.store.getState().notes?.["note_1"]?.text).toBe("关着时改的");
    expect(next.merges).toHaveLength(1);
  });

  it("takes in what changed while the project was closed", async () => {
    const browser = new TestBrowser();
    const first = await browser.open();
    renameClip(first.store, "clip_title", "关之前");
    await first.session.close();
    await first.project.close();
    editOnDisk(browser.disk, NOTES, (document) => {
      document.notes[0].text = "关着时改的";
    });
    const next = await browser.open();
    await browser.settle();
    expect(next.store.getState().notes?.["note_1"]?.text).toBe("关着时改的");
    expect(clipName(next.store, "clip_title")).toBe("关之前");
    expect(noteText(browser)).toBe("关着时改的");
  });
});

describe("the place of the folder", () => {
  it("is left alone once the folder is gone, also when another project comes there", async () => {
    const browser = new TestBrowser();
    const { store, session, folders } = await browser.open();
    browser.disk.move(PROJECT, `${PROJECT}-搬走`);
    await browser.settle();
    expect(session.getSnapshot().trouble).toEqual({ reason: "gone" });
    const other = fixture();
    const manifest = JSON.parse(other.get(MANIFEST_FILE) as string);
    manifest.id = "another-project";
    other.set(MANIFEST_FILE, JSON.stringify(manifest));
    browser.disk.write(`${PROJECT}/${MANIFEST_FILE}`, other.get(MANIFEST_FILE) as string);
    browser.disk.write(`${PROJECT}/${MAIN}`, other.get(MAIN) as string);
    renameClip(store, "clip_title", "不该写进去");
    await browser.settle();
    expect(textOn(browser.disk, MAIN)).toBe(other.get(MAIN));
    expect(await session.reconnect()).toBe("other-project");
    browser.disk.chooseNext(`${PROJECT}-搬走`);
    const moved = await folders.choose();
    expect(await session.reconnect(moved)).toBe("connected");
    await browser.settle();
    expect(session.getSnapshot().trouble).toBeUndefined();
    const written = browser.disk.text(`${PROJECT}-搬走/${MAIN}`);
    expect(clipIn(JSON.parse(written), "clip_title").name).toBe("不该写进去");
    expect(textOn(browser.disk, MAIN)).toBe(other.get(MAIN));
  });

  it("is checked before writing, when the browser said nothing", async () => {
    const browser = new TestBrowser();
    // A browser without FileSystemObserver tells nothing, also not that the folder went.
    browser.disk.observes = false;
    const { store, session } = await browser.open();
    browser.disk.move(PROJECT, `${PROJECT}-搬走`, { quietly: true });
    const other = fixture();
    const manifest = JSON.parse(other.get(MANIFEST_FILE) as string);
    manifest.id = "another-project";
    other.set(MANIFEST_FILE, JSON.stringify(manifest));
    for (const [path, text] of other)
      browser.disk.write(`${PROJECT}/${path}`, text, { quietly: true });
    renameClip(store, "clip_title", "不该写进去");
    await browser.settle();
    expect(session.getSnapshot().trouble).toEqual({ reason: "replaced" });
    expect(textOn(browser.disk, MAIN)).toBe(other.get(MAIN));
  });
});

describe("windows of one browser", () => {
  it("leave writing to one of them, which writes what the others change", async () => {
    const browser = new TestBrowser();
    const first = await browser.open();
    const second = await browser.open();
    expect(first.session.getSnapshot().role).toBe("writing");
    expect(second.session.getSnapshot().role).toBe("waiting");
    renameClip(second.store, "clip_title", "第二个窗口的");
    await browser.settle();
    expect(clipIn(JSON.parse(textOn(browser.disk, MAIN)), "clip_title").name).toBe("第二个窗口的");
  });

  it("take in what another program changed in one of them only", async () => {
    const browser = new TestBrowser();
    const first = await browser.open();
    const second = await browser.open();
    const code = textOn(browser.disk, CODE);
    browser.disk.write(`${PROJECT}/${CODE}`, `// 外面加的\n${code}`);
    await browser.settle();
    expect(first.merges).toHaveLength(1);
    expect(second.merges).toEqual([]);
    expect(second.store.getState().files[CODE]).toBe(`// 外面加的\n${code}`);
  });

  it("go on with the next one when the one that writes closes", async () => {
    const browser = new TestBrowser();
    const first = await browser.open();
    const second = await browser.open();
    renameClip(first.store, "clip_title", "关之前");
    await first.session.close();
    await first.project.close();
    await browser.settle();
    expect(second.session.getSnapshot().role).toBe("writing");
    expect(clipIn(JSON.parse(textOn(browser.disk, MAIN)), "clip_title").name).toBe("关之前");
    renameClip(second.store, "clip_title", "接手以后");
    await browser.settle();
    expect(clipIn(JSON.parse(textOn(browser.disk, MAIN)), "clip_title").name).toBe("接手以后");
  });

  it("take over from one that sleeps, which keeps nothing after that", async () => {
    const browser = new TestBrowser();
    const first = await browser.open();
    const second = await browser.open();
    browser.disk.sleep(first.folders);
    renameClip(second.store, "clip_title", "抢过来");
    await browser.settle();
    expect(second.session.getSnapshot().role).toBe("writing");
    expect(first.session.getSnapshot().role).toBe("waiting");
    expect(clipIn(JSON.parse(textOn(browser.disk, MAIN)), "clip_title").name).toBe("抢过来");
  });
});

describe("what keeps the folder from being written", () => {
  it("is said, and tried again: a full disk", async () => {
    const browser = new TestBrowser();
    const { store, session } = await browser.open();
    browser.disk.failWrites(`${PROJECT}/${MAIN}`, { times: 2 });
    renameClip(store, "clip_title", "盘满了");
    await browser.settle(1500);
    expect(session.getSnapshot()).toMatchObject({
      status: "unsaved",
      trouble: { reason: "full", path: MAIN },
    });
    await browser.settle(20_000);
    expect(clipIn(JSON.parse(textOn(browser.disk, MAIN)), "clip_title").name).toBe("盘满了");
    expect(session.getSnapshot()).toMatchObject({ status: "saved", trouble: undefined });
  });

  it("is said, and tried again: a folder the editor may not write any more", async () => {
    const browser = new TestBrowser();
    const { store, session } = await browser.open();
    browser.disk.forgetPermissions();
    renameClip(store, "clip_title", "没权限");
    await browser.settle();
    expect(session.getSnapshot().trouble).toMatchObject({ reason: "denied" });
    browser.disk.grant(PROJECT);
    await browser.settle();
    expect(clipIn(JSON.parse(textOn(browser.disk, MAIN)), "clip_title").name).toBe("没权限");
    expect(session.getSnapshot().trouble).toBeUndefined();
  });
});

describe("recovered files", () => {
  it("are in a folder of the editor's own, which Git leaves out", async () => {
    expect(RECOVERED_FOLDER.startsWith(".animaquill/")).toBe(true);
  });
});

describe("what does not all come in", () => {
  it("is kept before code with a conflict is written again, and the conflict has the folder's lines", async () => {
    const browser = new TestBrowser();
    const { store, merges } = await browser.open();
    const code = textOn(browser.disk, CODE);
    const lines = code.split("\n");
    run(store, "file.write", { path: CODE, text: [`// 编辑器的`, ...lines.slice(1)].join("\n") });
    browser.disk.write(`${PROJECT}/${CODE}`, [`// 外面的`, ...lines.slice(1)].join("\n"));
    const theirs = textOn(browser.disk, CODE);
    await browser.settle();
    const [conflict] = merges.flatMap(({ conflicts }) => conflicts);
    expect(conflict).toMatchObject({ file: CODE });
    expect(conflict?.theirs).toBeDefined();
    expect(textOn(browser.disk, CODE).startsWith("// 编辑器的")).toBe(true);
    expect(recovered(browser.disk).get(CODE)).toEqual([theirs]);
  });

  it("is kept when a lock keeps a change out, before the editor's side is written", async () => {
    const browser = new TestBrowser();
    const { store } = await browser.open();
    run(store, "track.update", {
      timeline: "main",
      track: "track_video",
      changes: { locked: true },
    });
    await browser.settle();
    editOnDisk(browser.disk, MAIN, (document) => {
      clipIn(document, "clip_title").name = "锁着的";
      document.markers[0].name = "外面的";
    });
    const theirs = textOn(browser.disk, MAIN);
    await browser.settle();
    expect(clipName(store, "clip_title")).toBe("标题");
    expect(store.getState().timelines["main"]?.markers["marker_hook"]?.name).toBe("外面的");
    expect(clipIn(JSON.parse(textOn(browser.disk, MAIN)), "clip_title").name).toBe("标题");
    expect(recovered(browser.disk).get(MAIN)).toEqual([theirs]);
  });

  it("waits while a tag locks the project, and comes in once people take it off", async () => {
    const browser = new TestBrowser();
    const { store, session } = await browser.open();
    run(store, "project.setTags", { tags: [{ name: "已发布", color: "#2ea043", locked: true }] });
    await browser.settle();
    editOnDisk(browser.disk, NOTES, (document) => {
      document.notes[0].text = "锁着时改的";
    });
    await browser.settle();
    expect(store.getState().notes?.["note_1"]?.text).not.toBe("锁着时改的");
    expect(session.getSnapshot().blocked.map(({ path }) => path)).toEqual([NOTES]);
    run(store, "project.setTags", { tags: [] });
    await browser.settle();
    expect(store.getState().notes?.["note_1"]?.text).toBe("锁着时改的");
    expect(session.getSnapshot().blocked).toEqual([]);
  });

  it("waits with a timeline that cannot be read: its versions too", async () => {
    const browser = new TestBrowser();
    const { store, session } = await browser.open();
    const VERTICAL = "timelines/main/overrides/format.vertical.json";
    browser.disk.write(`${PROJECT}/${MAIN}`, "{坏了");
    editOnDisk(browser.disk, VERTICAL, (document) => {
      document.clips = { ...document.clips, clip_title: { hidden: { value: true } } };
    });
    await browser.settle();
    const waiting = session.getSnapshot().blocked.map(({ path }) => path);
    expect(waiting).toContain(MAIN);
    expect(waiting).toContain(VERTICAL);
    renameClip(store, "clip_title", "编辑器的");
    await browser.settle();
    expect(textOn(browser.disk, MAIN)).toBe("{坏了");
    browser.disk.write(`${PROJECT}/${MAIN}`, fixture().get(MAIN) as string);
    await browser.settle();
    expect(session.getSnapshot().blocked).toEqual([]);
    expect(clipIn(JSON.parse(textOn(browser.disk, MAIN)), "clip_title").name).toBe("编辑器的");
  });

  it("comes in with a byte order mark in front, as editors on Windows write it", async () => {
    const browser = new TestBrowser();
    const { store, session } = await browser.open();
    editOnDisk(browser.disk, NOTES, (document) => {
      document.notes[0].text = "带 BOM";
    });
    browser.disk.write(`${PROJECT}/${NOTES}`, `﻿${textOn(browser.disk, NOTES)}`);
    await browser.settle();
    expect(store.getState().notes?.["note_1"]?.text).toBe("带 BOM");
    expect(session.getSnapshot().blocked).toEqual([]);
    // It stays as it was written, mark and all.
    expect(Array.from(browser.disk.bytes(`${PROJECT}/${NOTES}`).slice(0, 3))).toEqual([
      0xef, 0xbb, 0xbf,
    ]);
  });
});

describe("a checkout that goes on for a while", () => {
  it("is taken in once it is over, as one change", async () => {
    const browser = new TestBrowser();
    const { store, merges } = await browser.open();
    for (let round = 0; round < 90; round++) {
      editOnDisk(browser.disk, NOTES, (document) => {
        document.notes[0].text = `第 ${round} 次`;
      });
      await browser.settle(400);
    }
    await browser.settle();
    expect(store.getState().notes?.["note_1"]?.text).toBe("第 89 次");
    expect(merges).toHaveLength(1);
  });
});

describe("names", () => {
  it("that only change in case move the file on Windows, which loses nothing", async () => {
    const browser = new TestBrowser({ system: "windows" });
    const { store, session } = await browser.open();
    const code = textOn(browser.disk, CODE);
    run(store, "file.rename", { from: CODE, to: "code/Animate.js" });
    await browser.settle();
    expect(browser.disk.names(`${PROJECT}/code`)).toEqual(["Animate.js"]);
    expect(browser.disk.text(`${PROJECT}/code/Animate.js`)).toBe(code);
    expect(store.getState().files["code/Animate.js"]).toBe(code);
    expect(session.getSnapshot()).toMatchObject({ status: "saved", blocked: [] });
    run(store, "file.rename", { from: "code/Animate.js", to: CODE });
    await browser.settle();
    expect(browser.disk.names(`${PROJECT}/code`)).toEqual(["animate.js"]);
    expect(textOn(browser.disk, CODE)).toBe(code);
    expect(session.getSnapshot()).toMatchObject({ status: "saved", blocked: [] });
  });

  it("of a scene that goes away go with it, after what referred to it", async () => {
    const browser = new TestBrowser();
    const { store, session } = await browser.open();
    const order: string[] = [];
    browser.disk.onNext("written", `${PROJECT}/${MAIN}`, () => order.push(MAIN));
    for (const path of ["scenes/title/scene.json", "scenes/title/index.html"]) {
      browser.disk.onNext("removeEntry", `${PROJECT}/${path}`, () => order.push(path));
    }
    run(store, "clip.remove", { timeline: "main", clips: ["clip_title"] });
    for (const timeline of Object.keys(store.getState().timelines)) {
      for (const clip of Object.values(store.getState().timelines[timeline]?.clips ?? {})) {
        if (clip.source.kind === "scene" && clip.source.scene === "title") {
          run(store, "clip.remove", { timeline, clips: [clip.id] });
        }
      }
    }
    run(store, "scene.remove", { scene: "title" });
    await session.flush();
    expect(browser.disk.has(`${PROJECT}/scenes/title`)).toBe(false);
    expect(order[0]).toBe(MAIN);
    expect(order.slice(1).toSorted()).toEqual([
      "scenes/title/index.html",
      "scenes/title/scene.json",
    ]);
  });
});

describe("taking over", () => {
  it("leaves a window that was not told about it nothing to keep, and it stops by itself", async () => {
    const browser = new TestBrowser();
    // As if the browser never said that another window took over.
    const first = await browser.open({
      writer: (writer) => ({
        ...writer,
        claim: async (options) => ({
          ...(await writer.claim(options)),
          lost: new Promise(() => {}),
        }),
      }),
    });
    const second = await browser.open();
    browser.disk.sleep(first.folders);
    renameClip(second.store, "clip_title", "第二个的");
    await browser.settle();
    expect(second.session.getSnapshot().role).toBe("writing");
    browser.disk.sleep(first.folders, false);
    renameClip(first.store, "clip_logo", "第一个的");
    await browser.settle();
    expect(first.session.getSnapshot().role).toBe("waiting");
    const written = JSON.parse(textOn(browser.disk, MAIN));
    expect(clipIn(written, "clip_title").name).toBe("第二个的");
    expect(clipIn(written, "clip_logo").name).toBe("第一个的");
    const records = await browser.disk.folders().bases.load(LOCAL);
    expect(records.find(({ path }) => path === MAIN)?.base).toBe(textOn(browser.disk, MAIN));
  });

  it("first takes in what the window before did last, which may not have arrived yet", async () => {
    const browser = new TestBrowser();
    const first = await browser.open();
    const second = await browser.open({ holding: true });
    const code = textOn(browser.disk, CODE);
    browser.disk.write(`${PROJECT}/${CODE}`, `// 外面加的\n${code}`);
    await browser.settle();
    expect(first.store.getState().files[CODE]).toBe(`// 外面加的\n${code}`);
    await first.session.close();
    await first.project.close();
    await browser.settle();
    expect(second.session.getSnapshot().role).toBe("writing");
    // What the first window merged is in the folder still, and in the project here.
    expect(textOn(browser.disk, CODE)).toBe(`// 外面加的\n${code}`);
    expect(second.store.getState().files[CODE]).toBe(`// 外面加的\n${code}`);
    second.arriving.holding = false;
    for (const deliver of second.arriving.updates.splice(0)) deliver();
    await browser.settle();
    expect(textOn(browser.disk, CODE)).toBe(`// 外面加的\n${code}`);
    expect(second.merges).toEqual([]);
  });
});
