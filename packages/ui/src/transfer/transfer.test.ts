import { ProjectStore, USER, buildAudioPlan, buildRenderPlan, objectsOf } from "@animaquill/core";
import type { FolderAccess, SourceFolder, TargetFolder } from "@animaquill/host";
import { hashFile } from "@animaquill/media";
import {
  createProject,
  documentSchema,
  readProject,
  stringifyDocument,
  type Asset,
} from "@animaquill/schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { zipTarget } from "../../../host/src/zip.ts";
import { loadFixture } from "../../../schema/scripts/fixture.ts";
import { createI18n } from "../i18n/i18n.ts";
import { buildModel } from "../timeline/model.ts";
import { Dialogs, type DialogDetail, type ProgressRequest } from "../workbench/dialogs.ts";
import { MemoryLibrary, memoryAddress } from "../workbench/memory-library.ts";
import { Notifications } from "../workbench/notifications.ts";
import { ProjectSession } from "../workbench/session.ts";
import { INCOMPLETE_FILE } from "./export.ts";
import { MemoryTarget, memorySource } from "./memory-folder.ts";
import { ProjectTransfer, formatSize } from "./transfer.ts";

const { t } = await createI18n();

const PICTURE = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
const VIDEO = new Uint8Array(4096).map((_, index) => index % 251);

/** One window of the editor, as far as moving projects goes. */
function setup(library = new MemoryLibrary()) {
  const dialogs = new Dialogs();
  const notifications = new Notifications();
  const silent = () => {};
  const session = new ProjectSession(library, memoryAddress(), {
    createFailed: silent,
    notFound: silent,
    openFailed: silent,
    tooNew: silent,
    damaged: silent,
    saveFailed: silent,
    saveRecovered: silent,
  });
  const next: { source?: SourceFolder; target?: TargetFolder; failure?: Error } = {};
  const chosen = <T>(value: T) => {
    if (next.failure) throw next.failure;
    return value;
  };
  const folders: FolderAccess = {
    chooseSource: async () => chosen(next.source),
    chooseTarget: async () => chosen(next.target),
    saveFile: () => {},
    chooseFile: async () => undefined,
    reopen: async () => "gone" as const,
    dropTarget: async () => false,
    savesInBrowser: false,
  };
  const transfer = new ProjectTransfer({
    folders,
    projects: library,
    session,
    dialogs,
    notifications,
    t,
  });
  /** What the dialog on the screen says, and closes it, as people would. */
  const readDialog = async (answer = true) => {
    await vi.waitFor(() => {
      const current = dialogs.getSnapshot();
      expect(current?.kind).toBe("confirm");
    });
    const current = dialogs.getSnapshot();
    dialogs.answer(answer);
    if (current?.kind !== "confirm") throw new Error("No notice");
    return current;
  };
  const notices = () => notifications.getSnapshot().map((item) => item.message);
  return { library, session, dialogs, notifications, transfer, next, readDialog, notices };
}

type Window = ReturnType<typeof setup>;

/** Puts a file in the project the way bringing in media does. */
async function addAsset(
  { session, library }: Window,
  id: string,
  content: Uint8Array<ArrayBuffer>,
  fields: Partial<Asset> = {},
) {
  const { store } = session;
  if (!store) throw new Error("No project");
  const file = new Blob([content]);
  const hash = await hashFile(file);
  await library.media(store.getState().manifest.id).put(hash, file);
  const asset = {
    name: `${id}.bin`,
    kind: "video",
    path: `assets/${id}.bin`,
    storage: "local",
    hash,
    size: file.size,
    ...fields,
  };
  const result = store.execute({ type: "asset.add", params: { id, asset } });
  expect(result.ok).toBe(true);
  return hash;
}

async function projectWithFiles(window: Window = setup()) {
  await window.session.create("我的项目");
  await addAsset(window, "picture", PICTURE, { kind: "image" });
  await addAsset(window, "video", VIDEO);
  return window;
}

const idOf = ({ session }: Window) => session.store?.getState().manifest.id as string;
const assetsOf = ({ session }: Window) => session.store?.getState().assets ?? {};

/** Exports to a folder in memory and reads what the dialog says about it. */
async function exportTo(window: Window, target = new MemoryTarget()) {
  window.next.target = target;
  const exporting = window.transfer.exportProject();
  const notice = await window.readDialog();
  await exporting;
  return { target, notice };
}

/** Imports from a folder and opens the result, as the workbench does. */
async function importFrom(window: Window, source: SourceFolder) {
  window.next.source = source;
  const report = await window.transfer.importProject();
  if (report) await window.session.open(report.id);
  return report;
}

/** Tries to import what should not come in, and hands back what people get to read. */
async function refused(window: Window, source: SourceFolder) {
  window.next.source = source;
  const importing = window.transfer.importProject();
  const notice = await window.readDialog();
  expect(await importing).toBeUndefined();
  return notice;
}

/** Goes as far as the question about broken files, and says no. */
async function cancelled(window: Window, source: SourceFolder) {
  window.next.source = source;
  const importing = window.transfer.importProject();
  const question = await window.readDialog(false);
  expect(await importing).toBeUndefined();
  return question;
}

/** Says yes to the question about broken files, and opens what came in. */
async function skipping(window: Window, source: SourceFolder) {
  window.next.source = source;
  const importing = window.transfer.importProject();
  const question = await window.readDialog(true);
  const report = await importing;
  if (!report) throw new Error("Nothing came in");
  await window.session.open(report.id);
  return { question, report };
}

/** All lines of the lists of a dialog. */
const linesOf = ({ details }: { readonly details?: readonly DialogDetail[] | undefined }) =>
  (details ?? []).flatMap(({ items }) => items).join("\n");

const folderOf = (files: Iterable<readonly [string, string]>) => memorySource("文件夹", files);

/** The files of a valid project with a change made to one of them. */
function projectFiles(change: (files: Map<string, string>) => void = () => {}) {
  const store = ProjectStore.create(createProject({ name: "文件夹里的项目" }));
  const { files } = store.exportFiles();
  change(files);
  return files;
}

function withAsset(fields: Partial<Asset>, extra: readonly [string, Blob | string][] = []) {
  const asset = { kind: "video", path: "assets/a.mp4", storage: "local", ...fields };
  const files: Map<string, string | Blob> = projectFiles((texts) =>
    texts.set("assets.json", stringifyDocument({ assets: { clip: asset } })),
  );
  for (const [path, content] of extra) files.set(path, content);
  return memorySource("文件夹", files);
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("exporting", () => {
  it("writes the whole project, with its files where assets.json says", async () => {
    const window = await projectWithFiles();
    const { target, notice } = await exportTo(window);

    const { project, problems } = readProject(await target.texts());
    expect(problems).toEqual([]);
    expect(project?.manifest.name).toBe("我的项目");
    expect(Object.keys(project?.assets?.assets ?? {})).toEqual(["picture", "video"]);
    const video = await target.files.get("assets/video.bin")?.arrayBuffer();
    expect(new Uint8Array(video as ArrayBuffer)).toEqual(VIDEO);
    expect(target.finished).toBe(true);
    expect(notice.title).toBe("导出完成");
    expect(notice.message).toContain("导出");
  });

  it("only lets a folder become a project at the very end", async () => {
    const window = await projectWithFiles();
    const { target } = await exportTo(window);
    expect(target.written[0]).toBe(INCOMPLETE_FILE);
    expect(target.written.at(-1)).toBe("animaquill.json");
    expect(target.files.has(INCOMPLETE_FILE)).toBe(false);
    expect(target.written.indexOf("assets/video.bin")).toBeLessThan(
      target.written.indexOf("assets.json"),
    );
  });

  it("does nothing without a project", async () => {
    const window = setup();
    window.next.target = new MemoryTarget();
    await window.transfer.exportProject();
    expect((window.next.target as MemoryTarget).written).toEqual([]);
  });

  it("does nothing when people change their minds about the folder", async () => {
    const window = await projectWithFiles();
    await window.transfer.exportProject();
    expect(window.dialogs.getSnapshot()).toBeUndefined();
  });

  it("says so when the browser gives no folder", async () => {
    const window = await projectWithFiles();
    window.next.failure = new DOMException("denied", "NotAllowedError");
    const exporting = window.transfer.exportProject();
    expect((await window.readDialog()).title).toBe("导出没有完成");
    await exporting;
  });

  it("takes the project as it was when the export started", async () => {
    const window = await projectWithFiles();
    const target = new MemoryTarget();
    target.beforeWrite = (path) => {
      if (path !== "assets/video.bin") return;
      window.session.store?.execute({ type: "project.rename", params: { name: "后来改的名字" } });
    };
    await exportTo(window, target);
    expect(await target.text("animaquill.json")).toContain("我的项目");
  });

  it("tells about assets that this browser does not have, and goes on", async () => {
    const window = await projectWithFiles();
    window.library.files.delete(`${idOf(window)}/${assetsOf(window)["video"]?.hash}`);
    const { target, notice } = await exportTo(window);

    expect(notice.title).toBe("导出完成，但有内容没有带上");
    expect(notice.details?.[0]?.items).toEqual(["video.bin"]);
    expect(target.files.has("assets/video.bin")).toBe(false);
    expect(target.files.has("assets/picture.bin")).toBe(true);
    // The project still knows about it, so that importing can say the same thing.
    expect(await target.text("assets.json")).toContain("video.bin");
  });

  it.each([
    ["a document", "animaquill.json"],
    ["a document in another case", "ANIMAQUILL.JSON"],
    ["another asset", "assets/picture.bin"],
    ["another asset in another case", "assets/PICTURE.BIN"],
    ["the mark of an unfinished export", INCOMPLETE_FILE],
  ])("does not let a file take the place of %s", async (_, path) => {
    const window = await projectWithFiles();
    await addAsset(window, "intruder", new Uint8Array([1, 2, 3]), { path });
    const { target, notice } = await exportTo(window);

    expect(notice.title).toBe("导出完成，但有内容没有带上");
    expect(notice.details?.[0]?.items).toEqual(["intruder.bin"]);
    expect(target.finished).toBe(true);
    expect(readProject(await target.texts()).project?.manifest.name).toBe("我的项目");
    const picture = await target.files.get("assets/picture.bin")?.arrayBuffer();
    expect(new Uint8Array(picture as ArrayBuffer)).toEqual(PICTURE);
    expect(target.files.has(INCOMPLETE_FILE)).toBe(false);
  });

  it("takes two ways of writing one name for one place", async () => {
    const window = await projectWithFiles();
    await addAsset(window, "first", new Uint8Array([1]), { path: "assets/caf\u00E9.png" });
    await addAsset(window, "second", new Uint8Array([2]), { path: "assets/cafe\u0301.png" });
    const { target, notice } = await exportTo(window);
    expect(notice.details?.[0]?.items).toEqual(["second.bin"]);
    expect(target.files.has("assets/caf\u00E9.png")).toBe(true);
    expect(target.files.has("assets/cafe\u0301.png")).toBe(false);
  });

  it("does not call one file with two entries left out", async () => {
    const window = await projectWithFiles();
    const first = assetsOf(window)["picture"];
    await addAsset(window, "again", PICTURE, { kind: "image", path: first?.path as string });
    const { target, notice } = await exportTo(window);
    expect(notice.title).toBe("导出完成");
    expect(notice.details).toEqual([]);
    expect(target.written.filter((path) => path === first?.path)).toHaveLength(1);
  });

  it("does not call a text file that is also an asset left out", async () => {
    const svg = "<svg/>";
    const hash = await hashFile(new Blob([svg]));
    const scene = { name: "标题", entry: "index.html", runtime: 1 };
    const files: Map<string, string> = projectFiles((texts) => {
      texts.set("scenes/s/scene.json", stringifyDocument(scene));
      texts.set("scenes/s/logo.svg", svg);
      const asset = { kind: "image", path: "scenes/s/logo.svg", storage: "local", hash };
      texts.set("assets.json", stringifyDocument({ assets: { logo: asset } }));
    });
    const window = setup();
    const report = await importFrom(window, folderOf(files));
    expect(report?.missing).toEqual([]);
    expect(report?.skipped).toEqual([]);

    const { target, notice } = await exportTo(window);
    expect(notice.title).toBe("导出完成");
    expect(notice.details).toEqual([]);
    expect(await target.text("scenes/s/logo.svg")).toBe(svg);
  });

  it("does not call a file missing that is in the folder as text", async () => {
    const window = setup();
    await window.session.create("我的项目");
    const svg = "<svg/>";
    window.session.store?.importFile("scenes/s/logo.svg", svg, { origin: USER });
    const asset = {
      kind: "image",
      path: "scenes/s/logo.svg",
      storage: "local",
      hash: await hashFile(new Blob([svg])),
    };
    window.session.store?.execute({ type: "asset.add", params: { id: "logo", asset } });
    const { target, notice } = await exportTo(window);
    expect(notice.title).toBe("导出完成");
    expect(await target.text("scenes/s/logo.svg")).toBe(svg);
  });

  it("does say so when what is at the path of an asset is something else", async () => {
    const window = await projectWithFiles();
    const path = "scenes/s/logo.svg";
    window.session.store?.importFile(path, "<svg>改过</svg>", { origin: USER });
    await addAsset(window, "logo", new Uint8Array([1, 2, 3]), { path });
    const { target, notice } = await exportTo(window);
    expect(notice.title).toBe("导出完成，但有内容没有带上");
    expect(notice.details?.[0]?.items).toEqual(["logo.bin"]);
    expect(await target.text(path)).toBe("<svg>改过</svg>");
  });

  it("does not call an asset without a known file the same as what is at its path", async () => {
    const window = setup();
    await window.session.create("我的项目");
    window.session.store?.importFile("scenes/s/logo.svg", "<svg/>", { origin: USER });
    const asset = { kind: "image", path: "scenes/s/logo.svg", storage: "local" };
    window.session.store?.execute({ type: "asset.add", params: { id: "logo", asset } });
    const { notice } = await exportTo(window);
    expect(notice.details?.[0]?.items).toEqual(["scenes/s/logo.svg"]);
  });

  it("leaves out what a folder cannot have, says so and goes on", async () => {
    const window = await projectWithFiles();
    window.session.store?.importFile("code/aux.js", "export {};", { origin: USER });
    window.session.store?.importFile("code/ok.js", "export {};", { origin: USER });
    const target = new MemoryTarget();
    target.refuses = (path) => path === "code/aux.js" || path === "assets/video.bin";
    const { notice } = await exportTo(window, target);

    expect(notice.title).toBe("导出完成，但有内容没有带上");
    expect(notice.details?.[0]?.items).toEqual(["video.bin", "code/aux.js"]);
    expect(notice.details?.[0]?.title).toContain("不允许这样的名字");
    expect(target.finished).toBe(true);
    expect(target.files.has("code/ok.js")).toBe(true);
    expect(target.files.has("animaquill.json")).toBe(true);
    expect(target.files.has(INCOMPLETE_FILE)).toBe(false);
  });

  it("does not let a path a zip file cannot have stop the export", async () => {
    const window = await projectWithFiles();
    // Nothing writes such a path any more, but a project from before can have one.
    const store = window.session.store as ProjectStore;
    store.importFile("code/ok.js", "export {};", { origin: USER });
    type Files = { get(key: string): unknown; set(key: string, value: unknown): void };
    const files = store.doc.getMap("project").get("files") as Files;
    const Text = (files.get("code/ok.js") as { constructor: new (text: string) => unknown })
      .constructor;
    store.doc.transact(() => files.set("code/a\\b.js", new Text("export {};")), "other");
    const save = vi.fn<(file: Blob, name: string) => void>();
    window.next.target = zipTarget("我的项目", save);
    const exporting = window.transfer.exportProject();
    const notice = await window.readDialog();
    await exporting;
    expect(notice.title).toBe("导出完成，但有内容没有带上");
    expect(notice.details?.[0]?.items).toEqual(["code/a\\b.js"]);
    expect(save).toHaveBeenCalledOnce();
  });

  it("says when what a folder cannot have keeps it from coming back in", async () => {
    const files = projectFiles((texts) => {
      const manifest = JSON.parse(texts.get("animaquill.json") as string);
      manifest.timelines.push("con");
      texts.set("animaquill.json", JSON.stringify(manifest));
      texts.set("timelines/con/timeline.json", texts.get("timelines/main/timeline.json") as string);
    });
    const window = setup();
    await importFrom(window, folderOf(files));
    const target = new MemoryTarget();
    target.refuses = (path) => path.startsWith("timelines/con/");
    const { notice } = await exportTo(window, target);

    expect(notice.details?.[0]?.items).toEqual(["timelines/con/timeline.json"]);
    expect(notice.details?.[1]?.title).toContain("再导入时可能被拒绝");
    expect(notice.details?.[1]?.items.join()).toContain("没有这条时间轴：con");
  });

  it("says when a project would not come back in, which only reading it again shows", async () => {
    const window = await projectWithFiles();
    const manifest = window.session.store?.doc.getMap("project").get("manifest") as {
      set(key: string, value: unknown): void;
    };
    manifest.set("timelines", ["main", "ghost"]);
    const { target, notice } = await exportTo(window);
    expect(notice.title).toBe("导出完成，但有内容没有带上");
    expect(notice.details?.at(-1)?.items.join()).toContain("没有这条时间轴：ghost");
    expect(target.finished).toBe(true);
  });

  it("does not let one file replace another on a disk that ignores case", async () => {
    const manifest = { name: "标题", entry: "index.html", runtime: 1 };
    const files: Map<string, string> = projectFiles((texts) => {
      texts.set("scenes/title/scene.json", stringifyDocument(manifest));
      texts.set("scenes/Title/scene.json", stringifyDocument({ ...manifest, name: "另一个" }));
    });
    const window = setup();
    await importFrom(window, folderOf(files));
    const { target, notice } = await exportTo(window);
    const paths = ["scenes/title/scene.json", "scenes/Title/scene.json"];
    const written = paths.filter((path) => target.files.has(path));
    expect(written).toHaveLength(1);
    expect(notice.details?.[0]?.items).toEqual(paths.filter((path) => path !== written[0]));
  });

  it("says what stayed out when part of the project is not valid", async () => {
    const window = await projectWithFiles();
    // Two people working at once can leave things behind that nobody would write on purpose.
    window.session.store?.doc.getMap("project").set("assets/broken", { kind: "nonsense" });
    const { target, notice } = await exportTo(window);

    expect(notice.title).toBe("导出完成，但有内容没有带上");
    expect(notice.details?.[0]?.items).toEqual(["broken"]);
    expect(notice.details?.at(-1)?.items.join()).toContain("assets.json");
    expect(target.files.has("assets.json")).toBe(false);
    expect(target.files.has("assets/video.bin")).toBe(true);
    expect(target.files.has("animaquill.json")).toBe(true);
  });
});

describe("an export that does not get to the end", () => {
  /** Every point at which writing can fail. */
  async function everyStep() {
    const { target } = await exportTo(await projectWithFiles());
    return target.written;
  }

  it("never leaves a folder that looks like a project, wherever it stops", async () => {
    const steps = await everyStep();
    expect(steps.length).toBeGreaterThan(4);
    for (const failing of steps) {
      const window = await projectWithFiles();
      const target = new MemoryTarget();
      // Nothing can be taken back here, which is the worst case.
      target.stuck = true;
      target.beforeWrite = (path) => {
        if (path === failing) throw new Error("disk full");
      };
      window.next.target = target;
      const exporting = window.transfer.exportProject();
      const notice = await window.readDialog();
      await exporting;

      expect(notice.title).toBe("导出没有完成");
      expect(target.finished).toBe(false);
      expect(target.files.has("animaquill.json")).toBe(false);
      if (failing !== INCOMPLETE_FILE) expect(target.files.has(INCOMPLETE_FILE)).toBe(true);
    }
  });

  it("takes back what it wrote and says that it failed", async () => {
    const window = await projectWithFiles();
    const target = new MemoryTarget();
    target.beforeWrite = (path) => {
      if (path === "assets/video.bin") throw new Error("disk full");
    };
    const { notice } = await exportTo(window, target);
    expect(target.abandoned).toBe(true);
    expect(target.files.size).toBe(0);
    expect(notice.title).toBe("导出没有完成");
    expect(notice.message).toContain("写入“video.bin”时出错");
    expect(notice.message).toContain("磁盘空间");
    expect(notice.message).toContain("都删掉了");
  });

  it("says what is left when it cannot be taken back", async () => {
    const window = await projectWithFiles();
    const target = new MemoryTarget("我的项目 (2)");
    target.stuck = true;
    target.beforeWrite = (path) => {
      if (path === "assets/video.bin") throw new Error("disk full");
    };
    const { notice } = await exportTo(window, target);
    expect(notice.message).toContain("我的项目 (2)");
    expect(notice.message).toContain(INCOMPLETE_FILE);
    expect(notice.message).toContain("不要拿它当备份");
    expect(await target.text(INCOMPLETE_FILE)).toContain("没有完成");
  });

  it("stops when people cancel, and leaves nothing", async () => {
    const window = await projectWithFiles();
    const target = new MemoryTarget();
    target.beforeWrite = (path) => {
      if (path !== "assets/video.bin") return;
      (window.dialogs.getSnapshot() as ProgressRequest).stop();
    };
    window.next.target = target;
    await window.transfer.exportProject();

    expect(target.abandoned).toBe(true);
    expect(target.files.size).toBe(0);
    expect(window.dialogs.getSnapshot()).toBeUndefined();
    expect(window.notices()).toEqual(["导出已取消。"]);
    expect(window.transfer.running).toBe(false);
  });

  it("says what is left when cancelling cannot clean up", async () => {
    const window = await projectWithFiles();
    const target = new MemoryTarget();
    target.stuck = true;
    target.beforeWrite = (path) => {
      if (path !== "assets/video.bin") return;
      (window.dialogs.getSnapshot() as ProgressRequest).stop();
    };
    const { notice } = await exportTo(window, target);
    expect(notice.message).toContain("导出已取消");
    expect(notice.message).toContain(INCOMPLETE_FILE);
  });
});

describe("progress", () => {
  it("shows how far it got, and goes away", async () => {
    const window = await projectWithFiles();
    const target = new MemoryTarget();
    const seen: ProgressRequest[] = [];
    target.beforeWrite = async () => {
      await new Promise((resolve) => setTimeout(resolve, 110));
      seen.push(window.dialogs.getSnapshot() as ProgressRequest);
    };
    await exportTo(window, target);

    const last = seen.at(-1);
    expect(last?.title).toBe("正在导出“我的项目”");
    expect(last?.ratio).toBeGreaterThan(0.5);
    expect(last?.ratio).toBeLessThan(1);
    expect(last?.amount).toMatch(/KB \/ .* KB/);
    expect(seen.map(({ detail }) => detail)).toContain("video.bin");
    expect(window.transfer.running).toBe(false);
  });

  it("is counted in bytes, whatever the file", () => {
    expect(formatSize(999)).toBe("999 B");
    expect(formatSize(1500)).toBe("2 KB");
    expect(formatSize(123_456_789)).toBe("123.5 MB");
    expect(formatSize(2_500_000_000)).toBe("2.5 GB");
  });

  it("does not ask for a folder twice at once", async () => {
    const window = await projectWithFiles();
    let answer: (folder: undefined) => void = () => {};
    const chooseTarget = vi.fn(() => new Promise<undefined>((resolve) => (answer = resolve)));
    const transfer = new ProjectTransfer({
      folders: {
        chooseTarget,
        chooseSource: chooseTarget,
        saveFile: () => {},
        chooseFile: async () => undefined,
        reopen: async () => "gone" as const,
        dropTarget: async () => false,
        savesInBrowser: false,
      },
      projects: window.library,
      session: window.session,
      dialogs: window.dialogs,
      notifications: window.notifications,
      t,
    });
    const first = transfer.exportProject();
    await transfer.exportProject();
    await transfer.importProject();
    expect(chooseTarget).toHaveBeenCalledOnce();
    answer(undefined);
    await first;
    const again = transfer.exportProject();
    expect(chooseTarget).toHaveBeenCalledTimes(2);
    answer(undefined);
    await again;
  });

  it("does not run twice at once", async () => {
    const window = await projectWithFiles();
    const first = new MemoryTarget();
    let go = () => {};
    first.beforeWrite = () => new Promise<void>((resolve) => (go = resolve));
    window.next.target = first;
    const exporting = window.transfer.exportProject();
    await vi.waitFor(() => expect(window.transfer.running).toBe(true));

    const second = new MemoryTarget();
    window.next.target = second;
    await window.transfer.exportProject();
    window.next.source = memorySource("文件夹", []);
    expect(await window.transfer.importProject()).toBeUndefined();
    expect(second.written).toEqual([]);

    go();
    first.beforeWrite = undefined;
    await window.readDialog();
    await exporting;
  });
});

describe("importing", () => {
  it("brings back what was exported, exactly", async () => {
    const before = await projectWithFiles();
    const { session } = before;
    const { store } = session;
    const assets = assetsOf(before);
    store?.execute({ type: "project.setFrameRate", params: { fps: "24" } });
    const { target } = await exportTo(before);
    const id = idOf(before);
    await session.close();
    await before.library.remove(id);

    const report = await importFrom(before, target.asSource());
    expect(report?.id).toBe(id);
    expect(report?.copied).toBe(false);
    expect(report?.missing).toEqual([]);
    expect(report?.skipped).toEqual([]);

    const again = await exportTo(before, new MemoryTarget());
    expect(await again.target.texts()).toEqual(await target.texts());
    const video = await before.library.media(id).get(assets["video"]?.hash as string);
    expect(new Uint8Array(await (video as Blob).arrayBuffer())).toEqual(VIDEO);
    const picture = await before.library.media(id).get(assets["picture"]?.hash as string);
    expect(new Uint8Array(await (picture as Blob).arrayBuffer())).toEqual(PICTURE);
  });

  it("brings in a whole project with everything the format has", async () => {
    const files = loadFixture("v1");
    const window = setup();
    const report = await importFrom(window, memorySource("示例", files));
    expect(report?.name).toBe("原子是什么");

    expect(report?.skipped).toEqual(["AGENTS.md", "制作笔记/分镜.md"]);
    expect(report?.missing).toHaveLength(7);

    const { target } = await exportTo(window, new MemoryTarget());
    // All of it comes out as it went in, apart from what the project has no place for.
    const {
      "AGENTS.md": _notes,
      "制作笔记/分镜.md": _more,
      ...expected
    } = Object.fromEntries(files);
    expect(Object.fromEntries(await target.texts())).toEqual(expected);
  });

  it("keeps a project locked", async () => {
    const window = setup();
    await importFrom(window, memorySource("示例", loadFixture("v1")));
    const result = window.session.store?.execute({
      type: "project.rename",
      params: { name: "改名" },
    });
    expect(result?.ok).toBe(false);
  });

  it("does nothing when people change their minds about the folder", async () => {
    const window = setup();
    expect(await window.transfer.importProject()).toBeUndefined();
    expect(window.dialogs.getSnapshot()).toBeUndefined();
  });

  it("finds the project right inside of the folder people chose", async () => {
    const files = [...projectFiles()].map(([path, text]) => [`我的备份/${path}`, text] as const);
    const report = await importFrom(setup(), memorySource("备份", files));
    expect(report?.name).toBe("文件夹里的项目");
    expect(report?.skipped).toEqual([]);
  });

  it("leaves out what systems put in folders without a word", async () => {
    const files: Map<string, string> = projectFiles((texts) => {
      texts.set(".DS_Store", "x");
      texts.set("assets/Thumbs.db", "x");
      texts.set("scenes/._index.html", "x");
      texts.set("assets/video.mp4.crswap", "x");
    });
    expect((await importFrom(setup(), folderOf(files)))?.skipped).toEqual([]);
  });

  it("gives the project a place of its own while another one has its id", async () => {
    const window = await projectWithFiles();
    const { target } = await exportTo(window);
    const id = idOf(window);
    const name = "原来的名字";
    window.session.store?.execute({ type: "project.rename", params: { name } });
    await window.session.trySave();
    const before = [...(window.library.updates.get(id) ?? [])];

    const report = await importFrom(window, target.asSource());

    expect(report?.copied).toBe(true);
    expect(report?.id).not.toBe(id);
    expect(report?.name).toBe("我的项目（副本）");
    expect(window.library.updates.get(id)).toEqual(before);
    expect(window.library.summaries.get(id)?.name).toBe(name);
    expect(window.library.summaries.size).toBe(2);
    expect(idOf(window)).toBe(report?.id);
    expect(window.session.store?.getState().manifest.name).toBe("我的项目（副本）");
    // Its files are its own: removing the first project does not touch them.
    await window.library.remove(id);
    const hash = assetsOf(window)["video"]?.hash as string;
    expect(await window.library.media(report?.id as string).get(hash)).toBeDefined();
  });

  it("takes a second project with the same id in, while the first one is still coming", async () => {
    const library = new MemoryLibrary();
    const first = setup(library);
    const second = setup(library);
    const files = [...projectFiles()];

    const held = await library.receive({ id: "wanted", name: "占位" });
    const manifest = JSON.parse(new Map(files).get("animaquill.json") as string);
    manifest.id = "wanted";
    const source = memorySource("文件夹", [
      ...files,
      ["animaquill.json", JSON.stringify(manifest)],
    ]);
    expect(held).toBeDefined();
    const report = await importFrom(second, source);
    expect(report?.copied).toBe(true);
    expect(report?.id).not.toBe("wanted");
    await held?.abandon();
    expect((await importFrom(first, source))?.id).toBe("wanted");
  });

  it("says nothing more than that when all went well", async () => {
    const window = setup();
    const report = await importFrom(window, folderOf(projectFiles()));
    await window.transfer.announceImport(report as never);
    expect(window.dialogs.getSnapshot()).toBeUndefined();
    expect(window.notices()).toEqual(["“文件夹里的项目”已导入。"]);
  });

  it("says nothing about code when there is none", async () => {
    const window = setup();
    const report = await importFrom(window, folderOf(projectFiles()));
    expect(report?.runsCode).toBe(false);
    await window.transfer.warnAboutCode(report as never);
    expect(window.dialogs.getSnapshot()).toBeUndefined();
  });

  it("says that a project holds code, and waits for people to take that in", async () => {
    const window = setup();
    const files = projectFiles();
    const scene = { name: "标题", entry: "index.html", runtime: 1 };
    files.set("scenes/title/scene.json", stringifyDocument(scene));
    files.set("scenes/title/index.html", "<!doctype html><p>a</p>");
    const report = await importFrom(window, folderOf(files));
    expect(report?.runsCode).toBe(true);
    let warned = false;
    const warning = window.transfer.warnAboutCode(report as never).then(() => (warned = true));
    await vi.waitFor(() => expect(window.dialogs.getSnapshot()).toBeDefined());
    expect(warned).toBe(false);
    const notice = await window.readDialog();
    await warning;
    expect(notice.title).toBe("这个项目含有脚本");
    expect(notice.message).toContain("“文件夹里的项目”");
  });

  it("says when it became a copy", async () => {
    const window = setup();
    const files = projectFiles();
    await importFrom(window, folderOf(files));
    const report = await importFrom(window, folderOf(files));
    const announcing = window.transfer.announceImport(report as never);
    const notice = await window.readDialog();
    await announcing;
    expect(notice.title).toBe("项目已导入");
    expect(notice.message).toContain("成了副本");
  });
});

describe("a browser that asks whether a folder may be uploaded", () => {
  const HINT = "浏览器接下来会问是否“上传”，这只是读取，文件不会离开这台电脑。";

  /** Choosing goes on until `answer` runs. */
  function asking(asksToUpload: boolean | undefined) {
    const window = setup();
    let answer: (source: SourceFolder | undefined) => void = () => {};
    const chooseSource = vi.fn(
      () => new Promise<SourceFolder | undefined>((resolve) => (answer = resolve)),
    );
    const transfer = new ProjectTransfer({
      folders: {
        ...(asksToUpload === undefined ? {} : { asksToUpload }),
        chooseSource,
        chooseTarget: async () => undefined,
        saveFile: () => {},
        chooseFile: async () => undefined,
        reopen: async () => "gone" as const,
        dropTarget: async () => false,
        savesInBrowser: false,
      },
      projects: window.library,
      session: window.session,
      dialogs: window.dialogs,
      notifications: window.notifications,
      t,
    });
    return { ...window, transfer, chooseSource, answer: (source?: SourceFolder) => answer(source) };
  }

  it("says what that means for as long as people are choosing", async () => {
    vi.useFakeTimers();
    const { transfer, notices, answer } = asking(true);
    const importing = transfer.importProject();
    expect(notices()).toEqual([HINT]);
    // What the browser asks comes after the dialog, and people can take their time there.
    vi.advanceTimersByTime(60_000);
    expect(notices()).toEqual([HINT]);
    answer(folderOf(projectFiles()));
    vi.useRealTimers();
    expect((await importing)?.name).toBe("文件夹里的项目");
    expect(notices()).toEqual([]);
  });

  it("goes away when people change their minds", async () => {
    const { transfer, notices, answer } = asking(true);
    const importing = transfer.importProject();
    answer();
    await importing;
    expect(notices()).toEqual([]);
  });

  it("goes away when the browser gives no folder", async () => {
    const window = setup();
    const transfer = new ProjectTransfer({
      folders: {
        asksToUpload: true,
        chooseSource: () => Promise.reject(new DOMException("denied", "NotAllowedError")),
        chooseTarget: async () => undefined,
        saveFile: () => {},
        chooseFile: async () => undefined,
        reopen: async () => "gone" as const,
        dropTarget: async () => false,
        savesInBrowser: false,
      },
      projects: window.library,
      session: window.session,
      dialogs: window.dialogs,
      notifications: window.notifications,
      t,
    });
    const importing = transfer.importProject();
    expect((await window.readDialog()).title).toBe("导入没有完成");
    await importing;
    expect(window.notices()).toEqual([]);
  });

  it.each([false, undefined])("says nothing where the host asks no such thing", async (asks) => {
    const { transfer, notices, chooseSource, answer } = asking(asks);
    const importing = transfer.importProject();
    expect(chooseSource).toHaveBeenCalledOnce();
    expect(notices()).toEqual([]);
    answer();
    await importing;
  });
});

describe("files that are missing or different", () => {
  const CONTENT = new Blob([VIDEO]);

  it("opens the project and says which files are missing", async () => {
    const window = setup();
    const hash = await hashFile(CONTENT);
    const report = await importFrom(window, withAsset({ name: "采访.mp4", hash }));
    expect(report?.missing).toEqual(["采访.mp4"]);
    expect(window.session.store).toBeDefined();
    expect(assetsOf(window)["clip"]?.hash).toBe(hash);

    const announcing = window.transfer.announceImport(report as never);
    const notice = await window.readDialog();
    await announcing;
    expect(notice.details?.[0]?.items).toEqual(["采访.mp4"]);
    expect(notice.message).toContain("“缺失的资源”里重新找到文件");
  });

  it("does not take in a file that is not the file the project knows", async () => {
    const window = setup();
    const hash = await hashFile(new Blob(["别的内容"]));
    const report = await importFrom(
      window,
      withAsset({ name: "采访.mp4", hash }, [["assets/a.mp4", CONTENT]]),
    );
    expect(report?.damaged).toEqual(["采访.mp4"]);
    expect(report?.missing).toEqual([]);
    expect(window.session.store).toBeDefined();
    expect(assetsOf(window)["clip"]?.hash).toBe(hash);
    expect(await window.library.media(idOf(window)).get(hash)).toBeUndefined();
    expect(window.library.files.size).toBe(0);
  });

  it("reads a file piece by piece, however large it is", async () => {
    class OnlyInPieces extends File {
      override async arrayBuffer(): Promise<ArrayBuffer> {
        throw new Error("Read as a whole");
      }
      override async text(): Promise<string> {
        throw new Error("Read as a whole");
      }
    }
    const good = withAsset({}, [["assets/a.mp4", CONTENT]]);
    const source: SourceFolder = {
      name: "文件夹",
      async *files() {
        for await (const file of good.files()) {
          yield file.path === "assets/a.mp4"
            ? { path: file.path, read: async () => new OnlyInPieces([CONTENT], "a.mp4") }
            : file;
        }
      },
    };
    const window = setup();
    expect((await importFrom(window, source))?.missing).toEqual([]);
    expect(assetsOf(window)["clip"]?.hash).toBe(await hashFile(CONTENT));
  });

  it("works out the hash of a file that has none yet", async () => {
    const window = setup();
    await importFrom(window, withAsset({}, [["assets/a.mp4", CONTENT]]));
    const asset = assetsOf(window)["clip"];
    expect(asset?.hash).toBe(await hashFile(CONTENT));
    expect(asset?.size).toBe(CONTENT.size);
    expect(await window.library.media(idOf(window)).get(asset?.hash as string)).toBeDefined();
  });

  it("accepts a hash in the way another tool wrote it, and finds the file by it", async () => {
    const window = setup();
    const digest = await crypto.subtle.digest("SHA-256", VIDEO);
    const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0"));
    const hash = `sha256-${hex.join("")}`;
    const report = await importFrom(window, withAsset({ hash }, [["assets/a.mp4", CONTENT]]));
    expect(report?.damaged).toEqual([]);
    expect(assetsOf(window)["clip"]?.hash).toBe(hash);
    expect(await window.library.media(idOf(window)).get(hash)).toBeDefined();
  });

  it("does not call a file missing that another asset brought in", async () => {
    const hash = await hashFile(CONTENT);
    const shared = { kind: "video", storage: "local", hash };
    const files: Map<string, string | Blob> = projectFiles((texts) => {
      const assets = {
        here: { ...shared, path: "assets/a.mp4" },
        elsewhere: { ...shared, path: "assets/b.mp4" },
      };
      texts.set("assets.json", stringifyDocument({ assets }));
    });
    files.set("assets/a.mp4", CONTENT);
    const window = setup();
    const report = await importFrom(window, memorySource("文件夹", files));
    expect(report?.missing).toEqual([]);
    expect(window.library.files.size).toBe(1);
  });

  it("lists documents that are fine but have no place in the project", async () => {
    const stray = "timelines/ghost/overrides/language.en.json";
    const report = await importFrom(
      setup(),
      folderOf(
        projectFiles((texts) => texts.set(stray, JSON.stringify({ scope: { language: "en" } }))),
      ),
    );
    expect(report?.skipped).toEqual([stray]);
  });

  it("lists files that the project has no use for, which stay out", async () => {
    const report = await importFrom(
      setup(),
      withAsset({}, [
        ["assets/a.mp4", CONTENT],
        ["assets/unused.mp4", CONTENT],
        ["README.md", "说明"],
      ]),
    );
    expect(report?.skipped).toEqual(["README.md", "assets/unused.mp4"]);
  });
});

describe("scene files", () => {
  const scene = (extra: readonly (readonly [string, string | Uint8Array<ArrayBuffer>])[]) => {
    const manifest = { name: "标题", entry: "index.html", runtime: 1 };
    const files: Map<string, string | Uint8Array<ArrayBuffer>> = projectFiles((texts) =>
      texts.set("scenes/title/scene.json", stringifyDocument(manifest)),
    );
    for (const [path, content] of extra) files.set(path, content);
    return memorySource("文件夹", files);
  };

  it("come along exactly as they are", async () => {
    const window = setup();
    const html = "﻿<html>\r\n  <body>原子\u0000</body>\r\n</html>\r\n";
    await importFrom(
      window,
      scene([
        ["scenes/title/index.html", html],
        ["code/lib/深的路径/a.js", "export const a = 1;"],
      ]),
    );
    const { target } = await exportTo(window, new MemoryTarget());
    const bytes = await target.files.get("scenes/title/index.html")?.arrayBuffer();
    expect(new Uint8Array(bytes as ArrayBuffer)).toEqual(new TextEncoder().encode(html));
    expect(await target.text("code/lib/深的路径/a.js")).toBe("export const a = 1;");
  });

  it("are missed when a scene has no entry, which is all a link leaves behind", async () => {
    const report = await importFrom(setup(), scene([["scenes/title/other.html", "<html></html>"]]));
    expect(report?.warnings).toEqual([
      expect.objectContaining({ code: "entry-missing", file: "scenes/title/index.html" }),
    ]);
  });

  it("stay out with a word when they are no text, instead of coming in damaged", async () => {
    const window = setup();
    const report = await importFrom(
      window,
      scene([
        ["scenes/title/index.html", "<html></html>"],
        ["scenes/title/logo.png", new Uint8Array([0x89, 0x50, 0xff, 0xfe, 0x00])],
      ]),
    );
    expect(report?.skipped).toEqual(["scenes/title/logo.png"]);
    const { target } = await exportTo(window, new MemoryTarget());
    expect(target.files.has("scenes/title/logo.png")).toBe(false);
    expect(target.files.has("scenes/title/index.html")).toBe(true);
  });

  it("stay out with a word when they are too large to be text", async () => {
    const report = await importFrom(
      setup(),
      scene([["code/huge.js", new Blob([new Uint8Array(33 * 1024 ** 2)])] as never]),
    );
    expect(report?.skipped).toEqual(["code/huge.js"]);
  });

  it("say so at the export already when they are too large to come back", async () => {
    const window = setup();
    await window.session.create("我的项目");
    const store = window.session.store as ProjectStore;
    store.importFile("code/small.js", "x", { origin: USER });
    // Nothing writes a file this large any more, but a project from before can have one.
    type Files = { get(key: string): unknown; set(key: string, value: unknown): void };
    const files = store.doc.getMap("project").get("files") as Files;
    const Text = (files.get("code/small.js") as { constructor: new (text: string) => unknown })
      .constructor;
    store.doc.transact(
      () => files.set("code/huge.js", new Text("x".repeat(33 * 1024 ** 2))),
      "other",
    );
    const { target, notice } = await exportTo(window);

    expect(notice.title).toBe("导出完成");
    expect(notice.details).toEqual([
      expect.objectContaining({
        title: expect.stringContaining("再导入时不会带进来"),
        items: ["code/huge.js"],
      }),
    ]);
    expect(target.files.get("code/huge.js")?.size).toBe(33 * 1024 ** 2);
  });
});

describe("a project that is larger than anybody expected", () => {
  it("comes back whole, however large its documents are", { timeout: 60_000 }, async () => {
    const text = "字".repeat(12 * 1024 ** 2);
    const note = {
      id: "note_big",
      status: "pending",
      text,
      timeline: "main",
      time: "0",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const files = projectFiles((texts) => {
      texts.set("notes.json", JSON.stringify({ notes: [note] }));
    });
    expect(new Blob([files.get("notes.json") as string]).size).toBeGreaterThan(32 * 1024 ** 2);

    const first = setup();
    expect((await importFrom(first, folderOf(files)))?.skipped).toEqual([]);
    const { target, notice } = await exportTo(first);
    expect(notice.title).toBe("导出完成");

    const second = setup();
    const report = await importFrom(second, target.asSource());
    expect(report?.skipped).toEqual([]);
    expect(second.session.store?.getState().notes?.["note_big"]?.text).toHaveLength(text.length);
  });
});

describe("a folder with broken files", () => {
  const BROKEN = "{ oops";
  const CLIP = new Blob([VIDEO]);
  const color = { kind: "color", color: "#ff0000" };

  /** The timeline of a new project, with a clip on its first track. */
  const withClip = (text: string, source: object = color) => {
    const timeline = JSON.parse(text);
    timeline.tracks[0].clips = [{ id: "c", start: "0", duration: "1", source }];
    return JSON.stringify(timeline);
  };

  const listing = (texts: Map<string, string>, ...timelines: string[]) => {
    const manifest = JSON.parse(texts.get("animaquill.json") as string);
    manifest.timelines = timelines;
    texts.set("animaquill.json", JSON.stringify(manifest));
  };

  /** Takes a project out and back in, which must not need anybody's permission any more. */
  async function comesBackWhole(window: Window) {
    const { target, notice } = await exportTo(window);
    // Files that were never there are a different matter.
    expect(notice.details?.map(({ title }) => title).join()).not.toContain("这些内容有问题");
    const again = setup();
    const report = await importFrom(again, target.asSource());
    expect(report?.lost).toEqual([]);
    return again;
  }

  describe("asks first", () => {
    const broken = () =>
      folderOf(projectFiles((texts) => texts.set("timelines/main/timeline.json", BROKEN)));

    it("says what goes, what that means and why, with cancelling as the way out", async () => {
      const question = await cancelled(setup(), broken());
      expect(question.title).toBe("有些内容带不过来");
      expect(question.confirm).toBe("跳过这些继续导入");
      expect(question.danger).toBe(true);
      expect(question.noticeOnly).toBeUndefined();
      expect(question.message).toContain("新项目");
      expect(question.message).toContain("不要删掉");
      const [lost, reasons] = question.details ?? [];
      expect(lost?.title).toContain("这些内容会丢");
      expect(lost?.items.join()).toContain("时间轴 main");
      expect(lost?.items.join()).toContain("空的");
      expect(reasons?.items.join()).toContain("timelines/main/timeline.json");
      expect(reasons?.items.join()).toContain("不是有效的 JSON");
    });

    it("leaves everything as it was when people cancel", async () => {
      const window = await projectWithFiles();
      await window.session.trySave();
      const id = idOf(window);
      const before = {
        updates: [...(window.library.updates.get(id) ?? [])],
        summaries: [...window.library.summaries],
        files: [...window.library.files],
      };
      await cancelled(window, broken());
      expect(window.library.updates.get(id)).toEqual(before.updates);
      expect([...window.library.summaries]).toEqual(before.summaries);
      expect([...window.library.files]).toEqual(before.files);
      expect(window.library.incoming.size).toBe(0);
      expect(idOf(window)).toBe(id);
      expect(window.notices()).toEqual(["导入已取消，现有的项目没有改动。"]);
    });

    it("takes anything that closes the question for a no", async () => {
      const window = setup();
      window.next.source = broken();
      const importing = window.transfer.importProject();
      await vi.waitFor(() => expect(window.dialogs.getSnapshot()?.kind).toBe("confirm"));
      window.dialogs.answer(undefined);
      expect(await importing).toBeUndefined();
      expect(window.library.summaries.size).toBe(0);
    });

    it("has nothing unfinished while people think about it", async () => {
      const window = setup();
      window.next.source = broken();
      const importing = window.transfer.importProject();
      await vi.waitFor(() => expect(window.dialogs.getSnapshot()?.kind).toBe("confirm"));
      expect(window.transfer.running).toBe(false);
      expect(window.library.incoming.size).toBe(0);
      window.dialogs.answer(false);
      await importing;
    });

    it("can be stopped after people said yes, with nothing left of it", async () => {
      const window = setup();
      const hash = await hashFile(CLIP);
      const asset = { kind: "video", path: "assets/a.mp4", storage: "local", hash };
      const files: Map<string, string | Blob> = projectFiles((texts) => {
        texts.set("notes.json", BROKEN);
        texts.set("assets.json", stringifyDocument({ assets: { a: asset } }));
      });
      files.set("assets/a.mp4", CLIP);
      const media = window.library.media.bind(window.library);
      vi.spyOn(window.library, "media").mockImplementation((project) => {
        const store = media(project);
        return {
          ...store,
          put: async (key, file) => {
            await store.put(key, file);
            (window.dialogs.getSnapshot() as ProgressRequest).stop();
          },
        };
      });
      window.next.source = memorySource("文件夹", files);
      const importing = window.transfer.importProject();
      await window.readDialog(true);
      expect(await importing).toBeUndefined();
      expect(window.library.summaries.size).toBe(0);
      expect(window.library.incoming.size).toBe(0);
      expect(window.transfer.running).toBe(false);
    });

    it("stops when people cancel at the very end of reading, before anything is asked", async () => {
      const window = setup();
      const files = [...projectFiles((texts) => texts.set("notes.json", BROKEN))];
      const good = memorySource("文件夹", files);
      const last = files.at(-1)?.[0];
      window.next.source = {
        name: good.name,
        async *files() {
          for await (const file of good.files()) {
            yield file.path === last
              ? {
                  path: file.path,
                  read: async () => {
                    (window.dialogs.getSnapshot() as ProgressRequest).stop();
                    return file.read();
                  },
                }
              : file;
          }
        },
      };
      expect(await window.transfer.importProject()).toBeUndefined();
      expect(window.dialogs.getSnapshot()).toBeUndefined();
      expect(window.notices()).toEqual(["导入已取消，现有的项目没有改动。"]);
      expect(window.library.summaries.size).toBe(0);
    });

    it("does not ask when nothing is broken", async () => {
      const window = setup();
      const report = await importFrom(window, folderOf(projectFiles()));
      expect(report?.lost).toEqual([]);
      expect(window.dialogs.getSnapshot()).toBeUndefined();
    });
  });

  describe("a timeline", () => {
    it("that is broken comes in empty, and everything else comes along", async () => {
      const window = setup();
      const note = {
        id: "n1",
        status: "pending",
        text: "还在",
        timeline: "main",
        time: "0",
        createdAt: "2026-01-01T00:00:00.000Z",
      };
      const { report } = await skipping(
        window,
        folderOf(
          projectFiles((texts) => {
            texts.set("timelines/main/timeline.json", BROKEN);
            texts.set("notes.json", stringifyDocument({ notes: [note] }));
          }),
        ),
      );
      const state = window.session.store?.getState();
      expect(state?.manifest.timelines).toEqual(["main"]);
      const main = state?.timelines["main"];
      expect(Object.keys(main?.clips ?? {})).toEqual([]);
      expect(Object.keys(main?.tracks ?? {}).length).toBeGreaterThan(0);
      expect(Object.keys(state?.notes ?? {})).toEqual(["n1"]);
      expect(report.lost.join()).toContain("时间轴 main");
      await comesBackWhole(window);
    });

    it("costs only itself, next to one that is fine", async () => {
      const window = setup();
      const files = projectFiles((texts) => {
        const main = texts.get("timelines/main/timeline.json") as string;
        texts.set("timelines/main/timeline.json", withClip(main));
        texts.set("timelines/second/timeline.json", BROKEN);
        listing(texts, "main", "second");
      });
      await skipping(window, folderOf(files));
      const state = window.session.store?.getState();
      expect(Object.keys(state?.timelines["main"]?.clips ?? {})).toEqual(["c"]);
      expect(Object.keys(state?.timelines["second"]?.clips ?? {})).toEqual([]);
      await comesBackWhole(window);
    });

    it("that is not in the folder at all comes in empty as well", async () => {
      const window = setup();
      const files = projectFiles((texts) => texts.delete("timelines/main/timeline.json"));
      const { question } = await skipping(window, folderOf(files));
      expect(linesOf(question)).toContain("文件夹里没有这条时间轴");
      expect(window.session.store?.getState().timelines["main"]).toBeDefined();
      await comesBackWhole(window);
    });

    it("that the project does not list simply stays out, and says so", async () => {
      const window = setup();
      const files = projectFiles((texts) => texts.set("timelines/stray/timeline.json", BROKEN));
      const { question } = await skipping(window, folderOf(files));
      expect(linesOf(question)).toContain("时间轴 stray");
      expect(linesOf(question)).not.toContain("空的");
      expect(window.session.store?.getState().timelines["stray"]).toBeUndefined();
      await comesBackWhole(window);
    });

    it("that holds itself goes, which is what breaks the circle", async () => {
      const window = setup();
      const nest = (other: string) => ({ kind: "timeline", timeline: other });
      const files = projectFiles((texts) => {
        const main = texts.get("timelines/main/timeline.json") as string;
        texts.set("timelines/main/timeline.json", withClip(main, nest("second")));
        texts.set("timelines/second/timeline.json", withClip(main, nest("main")));
        listing(texts, "main", "second");
      });
      const { question } = await skipping(window, folderOf(files));
      expect(linesOf(question)).toContain("不能嵌套自己");
      const timelines = Object.values(window.session.store?.getState().timelines ?? {});
      const clips = timelines.map(({ clips: all }) => Object.keys(all).length);
      expect(clips.toSorted()).toEqual([0, 1]);
      await comesBackWhole(window);
    });

    it("nested in another one leaves that clip with nothing to show", async () => {
      const window = setup();
      const files = projectFiles((texts) => {
        const main = texts.get("timelines/main/timeline.json") as string;
        texts.set(
          "timelines/main/timeline.json",
          withClip(main, { kind: "timeline", timeline: "stray" }),
        );
        texts.set("timelines/stray/timeline.json", BROKEN);
      });
      const { question } = await skipping(window, folderOf(files));
      expect(linesOf(question)).toContain("没有这条时间轴：stray");
      const state = window.session.store?.getState();
      expect(state?.timelines["main"]?.clips["c"]).toBeDefined();
      await comesBackWhole(window);
    });
  });

  describe("what a project refers to", () => {
    it("says which clips lose their media when the list of assets goes", async () => {
      const window = setup();
      const files: Map<string, string | Blob> = projectFiles((texts) => {
        const main = texts.get("timelines/main/timeline.json") as string;
        const source = { kind: "video", media: { asset: "film" } };
        texts.set("timelines/main/timeline.json", withClip(main, source));
        texts.set("assets.json", BROKEN);
      });
      files.set("assets/a.mp4", CLIP);
      const { question, report } = await skipping(window, memorySource("文件夹", files));
      expect(linesOf(question)).toContain("所有素材");
      expect(linesOf(question)).toContain("没有这个素材：film");
      expect(window.session.store?.getState().assets).toBeUndefined();
      expect(report.skipped).toEqual(["assets/a.mp4"]);
      expect(window.library.files.size).toBe(0);

      // The clip is still there, and people can bring the file in again.
      const added = window.session.store?.execute({
        type: "asset.add",
        params: { id: "film", asset: { path: "assets/a.mp4", kind: "video", storage: "local" } },
      });
      expect(added?.ok).toBe(true);
      await comesBackWhole(window);
    });

    it("reads nothing from a path that leads out of the project", async () => {
      const window = setup();
      const source = withAsset({ path: "../secret.mp4" }, [["../secret.mp4", "x"]]);
      const { question, report } = await skipping(window, source);
      expect(linesOf(question)).toContain("assets.json");
      expect(window.session.store?.getState().assets).toBeUndefined();
      expect(report.missing).toEqual([]);
      expect(window.library.files.size).toBe(0);
    });

    it("keeps the code of a scene without its description, for putting it right", async () => {
      const window = setup();
      const files = projectFiles((texts) => {
        const main = texts.get("timelines/main/timeline.json") as string;
        const source = { kind: "scene", scene: "title" };
        texts.set("timelines/main/timeline.json", withClip(main, source));
        texts.set("scenes/title/scene.json", BROKEN);
        texts.set("scenes/title/index.html", "<h1>标题</h1>");
      });
      const { question } = await skipping(window, folderOf(files));
      expect(linesOf(question)).toContain("场景 title");
      expect(linesOf(question)).toContain("没有这个场景：title");
      const state = window.session.store?.getState();
      expect(state?.scenes).toEqual({});
      expect(state?.files["scenes/title/index.html"]).toBe("<h1>标题</h1>");
      const again = await comesBackWhole(window);
      expect(again.session.store?.getState().files["scenes/title/index.html"]).toBe(
        "<h1>标题</h1>",
      );
    });

    it("leaves out a name that a project could not keep, and keeps what is next to it", async () => {
      const window = setup();
      const scene = stringifyDocument({ name: "标题", entry: "index.html", runtime: 1 });
      const files = projectFiles((texts) => {
        texts.set("scenes/__proto__/scene.json", scene);
        texts.set("scenes/ok/scene.json", scene);
        texts.set("scenes/ok/index.html", "<p></p>");
      });
      const { question } = await skipping(window, folderOf(files));
      expect(linesOf(question)).toContain("scenes/__proto__/scene.json");
      expect(Object.keys(window.session.store?.getState().scenes ?? {})).toEqual(["ok"]);
      await comesBackWhole(window);
    });

    it("takes a version of a timeline with the wrong file name out", async () => {
      const window = setup();
      const stray = "timelines/main/overrides/language.fr.json";
      const files = projectFiles((texts) =>
        texts.set(stray, JSON.stringify({ scope: { language: "en" } })),
      );
      const { question } = await skipping(window, folderOf(files));
      expect(linesOf(question)).toContain(stray);
      await comesBackWhole(window);
    });

    it("takes a document that is no text out, with the reason", async () => {
      const window = setup();
      const files: Map<string, string | Uint8Array<ArrayBuffer>> = projectFiles();
      files.set("notes.json", new Uint8Array([0xff, 0xfe, 0x00]));
      const { question, report } = await skipping(window, memorySource("文件夹", files));
      expect(linesOf(question)).toContain("UTF-8");
      expect(report.skipped).toEqual([]);
      await comesBackWhole(window);
    });

    it("loses two notes with one id as a whole file, and says so", async () => {
      const window = setup();
      const note = {
        id: "n1",
        status: "pending",
        text: "批注",
        timeline: "main",
        time: "0",
        createdAt: "2026-01-01T00:00:00.000Z",
      };
      const files = projectFiles((texts) =>
        texts.set("notes.json", stringifyDocument({ notes: [note, note] })),
      );
      const { question } = await skipping(window, folderOf(files));
      expect(linesOf(question)).toContain("批注");
      expect(linesOf(question)).toContain("ID 重复：n1");
      await comesBackWhole(window);
    });
  });

  describe("every document of a whole project", () => {
    const fixture = loadFixture("v1");
    const documents = [...fixture.keys()].filter(
      (path) => path !== "animaquill.json" && documentSchema(path) !== undefined,
    );

    /** What opening a project and looking at it comes down to. */
    function expectUsable(window: Window) {
      const state = window.session.store?.getState();
      if (!state) throw new Error("No project");
      for (const [id, timeline] of Object.entries(state.timelines)) {
        buildRenderPlan(state, id);
        buildAudioPlan(state, id);
        const model = buildModel(id, timeline, "30", 1);
        for (const { clip } of model.boxes.values()) objectsOf(clip);
      }
    }

    it.each(documents)("can go: %s", async (path) => {
      const files = new Map(fixture).set(path, BROKEN);
      const window = setup();
      const { question, report } = await skipping(window, memorySource("示例", files));
      expect(question.details?.[0]?.items).toHaveLength(1);
      expect(report.lost).toHaveLength(1);
      expectUsable(window);
      expectUsable(await comesBackWhole(window));
    });

    it("can all go at once", async () => {
      const files = new Map(fixture);
      for (const path of documents) files.set(path, BROKEN);
      const window = setup();
      const { report } = await skipping(window, memorySource("示例", files));
      expect(report.lost).toHaveLength(documents.length);
      expect(report.name).toBe("原子是什么");
      expectUsable(window);
      expectUsable(await comesBackWhole(window));
    });
  });

  describe("afterwards", () => {
    it("still says what stayed out, and to keep the folder", async () => {
      const window = setup();
      const files = projectFiles((texts) => texts.set("notes.json", BROKEN));
      const { report } = await skipping(window, folderOf(files));
      const announcing = window.transfer.announceImport(report);
      const notice = await window.readDialog();
      await announcing;
      expect(notice.message).toContain("原来的文件夹");
      expect(notice.details?.[0]?.title).toContain("没有带入");
      expect(notice.details?.[0]?.items.join()).toContain("批注");
    });

    it("never takes the place of the project it came from", async () => {
      const window = await projectWithFiles();
      await window.session.trySave();
      const id = idOf(window);
      const before = [...(window.library.updates.get(id) ?? [])];
      const { target } = await exportTo(window);
      target.files.set("notes.json", new Blob([BROKEN]));
      const { report } = await skipping(window, target.asSource());
      expect(report.copied).toBe(true);
      expect(report.id).not.toBe(id);
      expect(window.library.updates.get(id)).toEqual(before);
    });
  });
});

describe("a folder that cannot come in", () => {
  /** Whatever the folder is, what was there before stays. */
  async function withProject() {
    const window = await projectWithFiles();
    await window.session.trySave();
    const id = idOf(window);
    const before = {
      updates: [...(window.library.updates.get(id) ?? [])],
      summaries: [...window.library.summaries],
      files: [...window.library.files],
    };
    return { window, id, before };
  }

  type Setup = Awaited<ReturnType<typeof withProject>>;

  function expectNothingChanged({ window, id, before }: Setup) {
    expect(window.library.updates.get(id)).toEqual(before.updates);
    expect([...window.library.summaries]).toEqual(before.summaries);
    expect([...window.library.files]).toEqual(before.files);
    expect(window.library.incoming.size).toBe(0);
    expect(idOf(window)).toBe(id);
  }

  it("is told apart from a project, without a manifest", async () => {
    const state = await withProject();
    const notice = await refused(state.window, memorySource("假期照片", [["a.jpg", "x"]]));
    expect(notice.title).toBe("这个文件夹不能导入");
    expect(notice.message).toContain("“假期照片”不是项目文件夹");
    expect(notice.message).toContain("现有的项目没有改动");
    expectNothingChanged(state);
  });

  it("asks for one project when there are several in it", async () => {
    const state = await withProject();
    const notice = await refused(
      state.window,
      memorySource("备份", [
        ["甲/animaquill.json", "{}"],
        ["乙/animaquill.json", "{}"],
      ]),
    );
    expect(notice.message).toContain("好几个项目");
    expectNothingChanged(state);
  });

  it("refuses a newer format and says what to do", async () => {
    const state = await withProject();
    const files = projectFiles((texts) => {
      const manifest = JSON.parse(texts.get("animaquill.json") as string);
      manifest.formatVersion = 2;
      manifest.somethingNew = true;
      texts.set("animaquill.json", JSON.stringify(manifest));
    });
    const notice = await refused(state.window, folderOf(files));
    expect(notice.message).toContain("版本 2");
    expect(notice.message).toContain("刷新页面");
    expectNothingChanged(state);
  });

  it("refuses a manifest that is not JSON", async () => {
    const state = await withProject();
    const files = projectFiles((texts) => texts.set("animaquill.json", "{ oops"));
    const notice = await refused(state.window, folderOf(files));
    expect(notice.details?.[0]?.items[0]).toContain("animaquill.json");
    expectNothingChanged(state);
  });

  it("refuses a manifest that does not fit the format, whatever else is fine", async () => {
    const state = await withProject();
    const files = projectFiles((texts) => {
      const manifest = JSON.parse(texts.get("animaquill.json") as string);
      manifest.timelines = [];
      texts.set("animaquill.json", JSON.stringify(manifest));
    });
    const notice = await refused(state.window, folderOf(files));
    expect(notice.title).toBe("这个文件夹不能导入");
    expect(notice.details?.[0]?.items.join()).toContain("animaquill.json");
    expectNothingChanged(state);
  });

  it("refuses a manifest that is no text, and lists what else is wrong", async () => {
    const state = await withProject();
    const files: Map<string, string | Uint8Array<ArrayBuffer>> = projectFiles();
    files.set("animaquill.json", new Uint8Array([0xff, 0xfe, 0x00]));
    files.set("notes.json", "{ oops");
    const notice = await refused(state.window, memorySource("文件夹", files));
    expect(notice.title).toBe("这个文件夹不能导入");
    expect(linesOf(notice)).toContain("animaquill.json");
    expectNothingChanged(state);
  });

  it("is refused for its version, however broken the rest is", async () => {
    const state = await withProject();
    const files = projectFiles((texts) => {
      const manifest = JSON.parse(texts.get("animaquill.json") as string);
      manifest.formatVersion = 2;
      texts.set("animaquill.json", JSON.stringify(manifest));
      texts.set("notes.json", "{ oops");
    });
    const notice = await refused(state.window, folderOf(files));
    expect(notice.message).toContain("版本 2");
    expectNothingChanged(state);
  });

  it("reads a document with a byte order mark, the way Notepad saves", async () => {
    const files = projectFiles((texts) => {
      texts.set("animaquill.json", `﻿${texts.get("animaquill.json")}`);
    });
    expect((await importFrom(setup(), folderOf(files)))?.name).toBe("文件夹里的项目");
  });

  it("refuses an export that did not get to the end, also with a manifest in it", async () => {
    const state = await withProject();
    const files: Map<string, string> = projectFiles();
    files.set(INCOMPLETE_FILE, "没有完成");
    const notice = await refused(state.window, folderOf(files));
    expect(notice.message).toContain("没有完成的导出");
    const partial = await refused(state.window, folderOf([[INCOMPLETE_FILE, "没有完成"]]));
    expect(partial.message).toContain("没有完成的导出");
    expectNothingChanged(state);
  });

  it("does not go on forever on a folder that is no project at all", async () => {
    const state = await withProject();
    const lots = Array.from({ length: 100_001 }, (_, index) => [`${index}.jpg`, ""] as const);
    const notice = await refused(state.window, memorySource("照片", lots));
    expect(notice.message).toContain("文件太多");
    expectNothingChanged(state);
  });

  it("takes everything back when there is no room", async () => {
    const state = await withProject();
    const { window } = state;
    const hash = await hashFile(new Blob([VIDEO]));
    const put = vi.spyOn(MemoryLibrary.prototype, "media");
    put.mockImplementation(function media(this: MemoryLibrary, project: string) {
      return {
        put: async () => {
          throw new DOMException("no room", "QuotaExceededError");
        },
        get: async (key: string) => this.files.get(`${project}/${key}`),
        listMade: async () => [],
        touchMade: async () => {},
        removeMade: async () => {},
      };
    });
    window.next.source = withAsset({ hash }, [["assets/a.mp4", new Blob([VIDEO])]]);
    const importing = window.transfer.importProject();
    const notice = await window.readDialog();
    await importing;
    put.mockRestore();

    expect(notice.title).toBe("导入没有完成");
    expect(notice.message).toContain("存储空间不够");
    expectNothingChanged(state);
  });

  it("takes everything back when the last step fails", async () => {
    const state = await withProject();
    const { window } = state;
    const content = new Blob([VIDEO]);
    const hash = await hashFile(content);
    const receive = window.library.receive.bind(window.library);
    vi.spyOn(window.library, "receive").mockImplementation(async (project) => {
      const incoming = await receive(project);
      return (
        incoming && {
          ...incoming,
          finish: async () => {
            throw new Error("gone");
          },
        }
      );
    });
    window.next.source = withAsset({ hash }, [["assets/a.mp4", content]]);
    const importing = window.transfer.importProject();
    expect((await window.readDialog()).title).toBe("导入没有完成");
    await importing;
    expectNothingChanged(state);
  });

  it("says so when a file cannot be read, and takes everything back", async () => {
    const state = await withProject();
    const { window } = state;
    const good = withAsset({}, [["assets/a.mp4", new Blob([VIDEO])]]);
    const source: SourceFolder = {
      name: "U 盘",
      async *files() {
        for await (const file of good.files()) {
          yield file.path === "assets/a.mp4"
            ? {
                path: file.path,
                read: () => Promise.reject(new DOMException("gone", "NotFoundError")),
              }
            : file;
        }
      },
    };
    window.next.source = source;
    const importing = window.transfer.importProject();
    const notice = await window.readDialog();
    await importing;
    expect(notice.title).toBe("导入没有完成");
    expect(notice.message).toContain("现有的项目没有改动");
    expectNothingChanged(state);
  });

  it("stops when people cancel, with nothing left of it", async () => {
    const state = await withProject();
    const { window } = state;
    const content = new Blob([new Uint8Array(1024 ** 2)]);
    const hash = await hashFile(content);
    const listen = vi.spyOn(window.dialogs, "progress");
    const spyOnStop = () => {
      const progress = window.dialogs.getSnapshot() as ProgressRequest;
      progress.stop();
    };
    window.next.source = withAsset({ hash }, [["assets/a.mp4", content]]);
    const media = window.library.media.bind(window.library);
    vi.spyOn(window.library, "media").mockImplementation((project) => {
      const store = media(project);
      return {
        ...store,
        put: async (key, file) => {
          await store.put(key, file);
          spyOnStop();
        },
      };
    });
    expect(await window.transfer.importProject()).toBeUndefined();
    expect(listen).toHaveBeenCalled();
    expect(window.dialogs.getSnapshot()).toBeUndefined();
    expect(window.notices()).toEqual(["导入已取消，现有的项目没有改动。"]);
    expect(window.transfer.running).toBe(false);
    expectNothingChanged(state);
  });

  it("says so when the browser gives no folder", async () => {
    const window = setup();
    window.next.failure = new DOMException("denied", "NotAllowedError");
    const importing = window.transfer.importProject();
    expect((await window.readDialog()).title).toBe("导入没有完成");
    await importing;
  });
});
