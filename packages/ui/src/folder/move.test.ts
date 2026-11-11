/**
 * Moving a project of the browser into a folder: all of it gets written, read again and compared,
 * and only then does the browser keep the project by its folder, under the same number. Whatever is
 * not right stops it, and the project stays in the browser as it was.
 */
import {
  INCOMPLETE_FILE,
  ProjectStore,
  readFolder,
  type CommandCall,
  type ReadOnlyFolder,
} from "@animaquill/core";
import type { FolderRecord, LocalFolder, LocalFolders } from "@animaquill/host";
import { MemoryDisk, memoryFolders } from "@animaquill/host/memory";
import { hashFile, hashText } from "@animaquill/media";
import { MANIFEST_FILE, createProject } from "@animaquill/schema";
import { describe, expect, it } from "vitest";
import { MemoryLibrary } from "../workbench/memory-library.ts";
import { FolderAssets } from "./assets.ts";
import { filesOf, fixture } from "./folder-support.ts";
import {
  FolderMove,
  loadProject,
  type LoadedProject,
  type MoveResult,
  type MoveStep,
} from "./move.ts";

const t = ((key: string) => key) as never;
const NOTICE = "没有移完";
const PLACE = "文档/放项目";

/** A file larger than what writing reads back whole, so that only pieces of it are compared. */
const BIG_BYTES = 5 * 1024 * 1024;

const bytes = (text: string) => new TextEncoder().encode(text);

function big(): Uint8Array<ArrayBuffer> {
  const content = new Uint8Array(BIG_BYTES);
  for (let index = 0; index < content.length; index++) content[index] = index % 251;
  return content;
}

interface Setup {
  readonly disk: MemoryDisk;
  readonly folders: LocalFolders;
  readonly library: MemoryLibrary;
  readonly move: FolderMove;
}

function setup(): Setup {
  const disk = new MemoryDisk();
  const folders = memoryFolders(disk);
  const library = new MemoryLibrary();
  const move = new FolderMove({ folders, projects: library, t, now: () => Date.now() });
  return { disk, folders, library, move };
}

/** A project of the browser, with these files of assets in it, which the browser keeps. */
async function browserProject(
  library: MemoryLibrary,
  files: Record<string, Uint8Array<ArrayBuffer> | string> = {},
  code: Record<string, string> = { "code/动画.js": "export const 快 = 1;\n" },
): Promise<string> {
  const store = ProjectStore.create(createProject({ name: "片子" }), code);
  const id = store.getState().manifest.id;
  for (const [index, [path, content]] of Object.entries(files).entries()) {
    const file = new Blob([content]);
    const hash = await hashFile(file);
    await library.media(id).put(hash, file);
    const result = store.execute({
      type: "asset.add",
      params: {
        id: `asset_${index}`,
        asset: { kind: "image", storage: "local", path, hash, size: file.size, name: path },
      },
    });
    expect(result.ok).toBe(true);
  }
  await library.create({ id, name: "片子" }, store.encodeState());
  store.destroy();
  return id;
}

/** The example project, as a project of the browser whose files of assets are not there. */
async function exampleInBrowser(library: MemoryLibrary): Promise<string> {
  const files = fixture();
  const folder: ReadOnlyFolder = {
    async *list() {
      yield* files.keys();
    },
    file: async (path) => new Blob([files.get(path) as string]),
  };
  const { project, sources } = await readFolder(folder);
  const store = ProjectStore.create(project, sources);
  await library.create(
    { id: project.manifest.id, name: project.manifest.name },
    store.encodeState(),
  );
  store.destroy();
  return project.manifest.id;
}

async function chosen(disk: MemoryDisk, folders: LocalFolders, path = PLACE) {
  if (!disk.has(path)) disk.folder(path);
  disk.chooseNext(path);
  return (await folders.choose()) as LocalFolder;
}

const loaded = async (library: MemoryLibrary, key: string) =>
  (await loadProject(library, key)) as LoadedProject;

/**
 * Moves a project into a new folder of its name in `PLACE`, as people do, or right into `PLACE`
 * where `inside` is undefined.
 */
async function moveIt(
  { disk, folders, library, move }: Setup,
  key: string,
  options: { readonly signal?: AbortSignal; readonly onStep?: (step: MoveStep) => void } = {},
  inside: string | null = "片子",
): Promise<MoveResult> {
  const project = await loaded(library, key);
  try {
    const place = { chosen: await chosen(disk, folders), inside: inside ?? undefined };
    return await move.run(key, project.store, library.media(key), place, {
      notice: NOTICE,
      saved: project.saved,
      ...options,
    });
  } finally {
    project.close();
  }
}

/** What the project exports, as a folder has it. */
async function exported(library: MemoryLibrary, key: string): Promise<Map<string, string>> {
  const project = await loaded(library, key);
  const { files } = project.store.exportFiles();
  project.close();
  return files;
}

const isFolderSummary = async (library: MemoryLibrary, key: string) =>
  (await library.list()).find(({ id }) => id === key)?.folder === true;

describe("a project of the browser that moves into a folder", () => {
  it("is written there as a whole, and is that folder from then on, under the same number", async () => {
    const context = setup();
    const { disk, folders, library } = context;
    const picture = bytes("一张图");
    const key = await browserProject(library, { "assets/图.png": picture, "assets/大.bin": big() });
    const log = [...(library.updates.get(key) ?? [])];
    const files = await exported(library, key);

    const result = await moveIt(context, key);

    expect(result).toMatchObject({
      kind: "moved",
      missing: [],
      copies: BIG_BYTES + picture.length,
    });
    const root = `${PLACE}/片子`;
    const onDisk = filesOf(disk, root);
    for (const [path, text] of files) expect(onDisk.get(path), path).toBe(text);
    expect([...disk.bytes(`${root}/assets/图.png`)]).toEqual([...picture]);
    expect(disk.bytes(`${root}/assets/大.bin`).length).toBe(BIG_BYTES);
    expect(disk.has(`${root}/${INCOMPLETE_FILE}`)).toBe(false);
    // The same record goes on: its number, its log, and what the editor knows the files by.
    const record = await folders.records.get(key);
    expect(record).toMatchObject({ id: key, name: "片子" });
    expect(record?.project).toBe(JSON.parse(files.get(MANIFEST_FILE) as string).id);
    expect(record?.folder.name).toBe("片子");
    expect(await isFolderSummary(library, key)).toBe(true);
    expect(library.updates.get(key)).toEqual(log);
    const bases = await folders.bases.load(key);
    expect(bases.map(({ path }) => path).toSorted()).toEqual([...files.keys()].toSorted());
    for (const { path, base, synced, stat } of bases) {
      expect(base).toBe(files.get(path));
      expect(synced).toBe(hashText(files.get(path) as string));
      expect(stat?.size).toBe(new TextEncoder().encode(files.get(path)).length);
    }
    // The files of the assets were read for their hashes, which holds when the folder opens.
    expect((await folders.bases.hashOf(key, "assets/大.bin"))?.hash).toBe(
      await hashFile(new Blob([big()])),
    );
    // What the browser had of them stays, until people let it go.
    expect((await library.copies(key)).length).toBe(2);
  });

  it("says which files of assets were not in the browser before, and moves all the rest", async () => {
    const context = setup();
    const key = await exampleInBrowser(context.library);
    const files = await exported(context.library, key);
    const result = await moveIt(context, key);
    expect(result.kind).toBe("moved");
    if (result.kind !== "moved") return;
    // Of those, what can come from where it is kept is said apart, with where that is.
    expect(result.missing).toEqual([
      "assets/fonts/sans.woff2",
      "assets/logo.svg",
      "assets/raw.mov",
      "assets/loop.wav",
    ]);
    expect(result.elsewhere).toEqual([
      { name: "采访", storage: "lfs" },
      { name: "assets/voice/en.flac", storage: "platform" },
      { name: "assets/voice/zh.flac", storage: "lfs" },
    ]);
    expect(result.copies).toBe(0);
    const onDisk = filesOf(context.disk, `${PLACE}/片子`);
    for (const [path, text] of files) expect(onDisk.get(path), path).toBe(text);
  });

  it("shows how far it got, writing and then comparing, file by file", async () => {
    const context = setup();
    const key = await browserProject(context.library, { "assets/图.png": "图" });
    const steps: MoveStep[] = [];
    await moveIt(context, key, { onStep: (step) => steps.push(step) });
    const writing = steps.filter(({ phase }) => phase === "writing");
    const checking = steps.filter(({ phase }) => phase === "checking");
    expect(writing.length).toBeGreaterThan(0);
    expect(checking.length).toBeGreaterThan(0);
    expect(steps.indexOf(checking[0] as MoveStep)).toBeGreaterThan(
      steps.indexOf(writing.at(-1) as MoveStep),
    );
    const last = writing.at(-1) as MoveStep;
    expect(last.files).toBe(last.totalFiles);
    expect(last.bytes).toBe(last.totalBytes);
    const done = checking.at(-1) as MoveStep;
    expect(done.files).toBe(done.totalFiles);
  });

  it("writes what others refer to first, and animaquill.json last", async () => {
    const context = setup();
    const key = await browserProject(context.library, { "assets/图.png": "图" });
    const order: string[] = [];
    const steps = (step: MoveStep) => {
      if (step.phase === "writing" && order.at(-1) !== step.file) order.push(step.file);
    };
    await moveIt(context, key, { onStep: steps });
    expect(order[0]).toBe(INCOMPLETE_FILE);
    expect(order.at(-1)).toBe(MANIFEST_FILE);
    expect(order.indexOf("assets/图.png")).toBeLessThan(order.indexOf("assets.json"));
    expect(order.indexOf("assets.json")).toBeLessThan(
      order.indexOf("timelines/main/timeline.json"),
    );
  });
});

describe("a folder that is not what was written", () => {
  it("stops the move: the project stays in the browser, and the folder stays for people to look at", async () => {
    const context = setup();
    const { disk, folders, library } = context;
    const key = await browserProject(library, { "assets/图.png": "图" });
    const log = [...(library.updates.get(key) ?? [])];
    // Something changes the file right after it was written and read back, as a disk or another
    // program can: once the move looks at it again, it is not what was written.
    const path = `${PLACE}/片子/assets.json`;
    disk.onNext("written", path, () => {
      disk.onNext("getFile", path, () => {});
      disk.onNext("getFile", path, () => {
        const text = disk.text(path).replace("图.png", "别.png");
        disk.write(path, text, { quietly: true, keepTime: true });
      });
    });

    const result = await moveIt(context, key);

    expect(result).toMatchObject({
      kind: "unverified",
      folder: "片子",
      mismatches: expect.arrayContaining([{ kind: "different", file: "assets.json" }]),
    });
    expect(await folders.records.get(key)).toBeUndefined();
    expect(await isFolderSummary(library, key)).toBe(false);
    expect(library.updates.get(key)).toEqual(log);
    expect(await folders.bases.load(key)).toEqual([]);
    // The folder is as it was left, and says that it is no project.
    expect(disk.has(`${PLACE}/片子/${INCOMPLETE_FILE}`)).toBe(true);
    expect(disk.text(`${PLACE}/片子/${INCOMPLETE_FILE}`)).toBe(NOTICE);
    expect(disk.has(`${PLACE}/片子/${MANIFEST_FILE}`)).toBe(true);
    expect((await library.copies(key)).length).toBe(1);
  });

  it("stops the move where only the middle of a large file of an asset changed", async () => {
    const context = setup();
    const { disk, folders } = context;
    const key = await browserProject(context.library, { "assets/大.bin": big() });
    // Writing reads back only the start, the middle and the end of a file this large.
    const path = `${PLACE}/片子/assets/大.bin`;
    disk.onNext("written", path, () => {
      const changed = disk.bytes(path);
      changed[1024 * 1024] = (changed[1024 * 1024] ?? 0) ^ 0xff;
      disk.write(path, changed, { quietly: true, keepTime: true });
    });
    const result = await moveIt(context, key);
    expect(result).toMatchObject({
      kind: "unverified",
      folder: "片子",
      mismatches: [{ kind: "asset-different", file: "assets/大.bin" }],
    });
    if (result.kind === "unverified") expect(result.mismatches).toHaveLength(1);
    expect(await folders.records.get(key)).toBeUndefined();
    // What was found out for that folder does not stay with the number of the project.
    expect(await folders.bases.hashOf(key, "assets/大.bin")).toBeUndefined();
  });

  it("stops the move where another program put a file of a project into the folder meanwhile", async () => {
    const context = setup();
    const { disk } = context;
    const key = await browserProject(context.library);
    let isPut = false;
    const result = await moveIt(context, key, {
      onStep: ({ phase }) => {
        if (phase !== "checking" || isPut) return;
        isPut = true;
        disk.write(`${PLACE}/片子/code/别人的.js`, "// 别人写的", { quietly: true });
      },
    });
    expect(result).toMatchObject({
      kind: "unverified",
      mismatches: expect.arrayContaining([{ kind: "extra", file: "code/别人的.js" }]),
    });
  });

  it("stops the move where a document is gone again", async () => {
    const context = setup();
    const { disk } = context;
    const key = await browserProject(context.library);
    let isGone = false;
    const result = await moveIt(context, key, {
      onStep: ({ phase }) => {
        if (phase !== "checking" || isGone) return;
        isGone = true;
        disk.remove(`${PLACE}/片子/code/动画.js`, { quietly: true });
      },
    });
    expect(result).toMatchObject({
      kind: "unverified",
      mismatches: expect.arrayContaining([{ kind: "missing", file: "code/动画.js" }]),
    });
  });
});

describe("a move that does not get to the end", () => {
  it("takes back what it wrote when writing fails, and a folder it made", async () => {
    const context = setup();
    const { disk, folders, library } = context;
    const key = await browserProject(library, { "assets/图.png": "图" });
    disk.failWrites(`${PLACE}/片子/timelines/main/timeline.json`);
    const result = await moveIt(context, key);
    expect(result).toMatchObject({
      kind: "stopped",
      cancelled: false,
      file: "timelines/main/timeline.json",
      cleaned: true,
      folder: "片子",
    });
    expect(disk.has(`${PLACE}/片子`)).toBe(false);
    expect(disk.names(PLACE)).toEqual([]);
    expect(await folders.records.get(key)).toBeUndefined();
    expect(await isFolderSummary(library, key)).toBe(false);
  });

  it("takes back what it wrote when people stop it", async () => {
    const context = setup();
    const key = await browserProject(context.library, { "assets/图.png": "图" });
    const stopper = new AbortController();
    const result = await moveIt(context, key, {
      signal: stopper.signal,
      onStep: ({ phase, files }) => {
        if (phase === "writing" && files === 2) stopper.abort();
      },
    });
    expect(result).toMatchObject({ kind: "stopped", cancelled: true, cleaned: true });
    expect(context.disk.names(PLACE)).toEqual([]);
    expect(await context.folders.records.get(key)).toBeUndefined();
  });

  it("takes back what it wrote when people stop it while it compares", async () => {
    const context = setup();
    const key = await browserProject(context.library, { "assets/大.bin": big() });
    const stopper = new AbortController();
    const result = await moveIt(context, key, {
      signal: stopper.signal,
      onStep: ({ phase }) => {
        if (phase === "checking") stopper.abort();
      },
    });
    expect(result).toMatchObject({ kind: "stopped", cancelled: true, cleaned: true });
    expect(context.disk.names(PLACE)).toEqual([]);
  });

  it("leaves what another program changed since it wrote it, and says so", async () => {
    const context = setup();
    const { disk } = context;
    const key = await browserProject(context.library);
    disk.failWrites(`${PLACE}/片子/${MANIFEST_FILE}`);
    // Another program writes it right after it was written and read back.
    disk.onNext("written", `${PLACE}/片子/code/动画.js`, () => {
      disk.onNext("getFile", `${PLACE}/片子/code/动画.js`, () => {});
      disk.onNext("getFile", `${PLACE}/片子/code/动画.js`, () => {
        disk.write(`${PLACE}/片子/code/动画.js`, "// 别人改的", { quietly: true });
      });
    });
    const result = await moveIt(context, key);
    expect(result).toMatchObject({ kind: "stopped", cleaned: false });
    expect(disk.text(`${PLACE}/片子/code/动画.js`)).toBe("// 别人改的");
    expect(disk.has(`${PLACE}/片子/${INCOMPLETE_FILE}`)).toBe(true);
  });
});

describe("a project with effects", () => {
  it("moves with the effects of its clips, their order, and the keys of their parameters", async () => {
    const context = setup();
    const { disk, folders, library } = context;
    const store = ProjectStore.create(createProject({ name: "片子" }), {});
    const id = store.getState().manifest.id;
    const tracks = Object.values(store.getState().timelines["main"]?.tracks ?? {});
    const track = tracks.find(({ kind }) => kind === "video")?.id;
    const run = (type: string, params: object) =>
      expect(store.execute({ type, params } as CommandCall).ok).toBe(true);
    const color = { kind: "color", color: "#ff0000" };
    run("clip.add", {
      timeline: "main",
      track,
      clip: { id: "c", start: "0", duration: "5", source: color },
    });
    const radius = {
      keys: [
        { time: "0", value: 0 },
        { time: "2", value: 20 },
      ],
    };
    run("effect.add", {
      timeline: "main",
      clip: "c",
      id: "fx_blur",
      type: "blur",
      values: { radius },
    });
    run("effect.add", {
      timeline: "main",
      clip: "c",
      id: "fx_crop",
      type: "crop",
      enabled: false,
      index: 0,
      values: { left: 0.1 },
    });
    await library.create({ id, name: "片子" }, store.encodeState());
    store.destroy();

    const result = await moveIt(context, id);
    expect(result.kind).toBe("moved");
    const timeline = JSON.parse(disk.text(`${PLACE}/片子/timelines/main/timeline.json`));
    const clip = timeline.tracks
      .flatMap((each: { clips: { id: string }[] }) => each.clips)
      .find((each: { id: string }) => each.id === "c");
    expect(clip.effects).toEqual([
      { id: "fx_crop", type: "crop", enabled: false },
      { id: "fx_blur", type: "blur" },
    ]);
    expect(clip.properties["effect.fx_blur.radius"]).toEqual(radius);
    expect(clip.properties["effect.fx_crop.left"]).toBe(0.1);
    // The folder reads as the project, effects and all, and is what the editor knows it by.
    const record = (await folders.records.get(id)) as FolderRecord;
    const reading = await readFolder({
      async *list() {
        yield* record.folder.list();
      },
      file: (path) => record.folder.file(path),
    });
    const back = reading.project.timelines.get("main")?.document;
    const read = back?.tracks.flatMap(({ clips }) => clips).find((each) => each.id === "c");
    expect(read?.effects?.map(({ id: effect }) => effect)).toEqual(["fx_crop", "fx_blur"]);
    const bases = new Map((await folders.bases.load(id)).map(({ path, base }) => [path, base]));
    expect(bases.get("timelines/main/timeline.json")).toBe(
      disk.text(`${PLACE}/片子/timelines/main/timeline.json`),
    );
  });
});

describe("what a move did not write", () => {
  it("stays: a file that says another export is not done, and what is next to it", async () => {
    const context = setup();
    const { disk } = context;
    const key = await browserProject(context.library);
    // Another export writes into the same folder right now.
    disk.write(`${PLACE}/片子/${INCOMPLETE_FILE}`, "别人的导出还没完成");
    disk.write(`${PLACE}/片子/notes.json`, "{}");
    const result = await moveIt(context, key);
    expect(result).toMatchObject({ kind: "stopped", cleaned: true });
    expect(disk.text(`${PLACE}/片子/${INCOMPLETE_FILE}`)).toBe("别人的导出还没完成");
    expect(disk.text(`${PLACE}/片子/notes.json`)).toBe("{}");
  });

  it("stays: folders that were there before, also empty ones, where the move goes right in", async () => {
    const context = setup();
    const { disk } = context;
    const key = await browserProject(context.library, { "assets/图.png": "图" });
    disk.write(`${PLACE}/README.md`, "# 我的仓库");
    disk.folder(`${PLACE}/assets`);
    disk.failWrites(`${PLACE}/${MANIFEST_FILE}`);
    const result = await moveIt(context, key, {}, null);
    expect(result).toMatchObject({ kind: "stopped", cleaned: true });
    expect(disk.names(PLACE).toSorted()).toEqual(["README.md", "assets"]);
    expect(disk.names(`${PLACE}/assets`)).toEqual([]);
    expect(disk.text(`${PLACE}/README.md`)).toBe("# 我的仓库");
  });

  it("is not where folders it made for a file that did not get there were", async () => {
    const context = setup();
    const { disk } = context;
    const key = await browserProject(context.library);
    disk.write(`${PLACE}/README.md`, "# 我的仓库");
    disk.failWrites(`${PLACE}/timelines/main/timeline.json`);
    const result = await moveIt(context, key, {}, null);
    expect(result).toMatchObject({ kind: "stopped", cleaned: true });
    expect(disk.names(PLACE)).toEqual(["README.md"]);
  });
});

describe("the file of an asset that the browser has as something else", () => {
  it("stays out of the folder, is said, and the rest moves", async () => {
    const context = setup();
    const { disk, folders, library } = context;
    const key = await browserProject(library, { "assets/图.png": "图", "assets/声.wav": "声" });
    const project = await loaded(library, key);
    const picture = Object.values(project.store.getState().assets ?? {}).find(
      ({ path }) => path === "assets/图.png",
    );
    project.close();
    // The copy in the browser is damaged.
    await library.media(key).put(picture?.hash as string, new Blob(["坏了"]));
    const result = await moveIt(context, key);
    expect(result).toMatchObject({ kind: "moved", damaged: ["assets/图.png"], missing: [] });
    expect(disk.has(`${PLACE}/片子/assets/图.png`)).toBe(false);
    expect(disk.text(`${PLACE}/片子/assets/声.wav`)).toBe("声");
    expect(await folders.records.get(key)).toBeDefined();
  });
});

describe("a folder that is not what was written, which people want gone", () => {
  it("loses what this move wrote, and keeps what somebody else put there", async () => {
    const context = setup();
    const { disk, folders } = context;
    const key = await browserProject(context.library, { "assets/图.png": "图" });
    let isPut = false;
    const result = await moveIt(context, key, {
      onStep: ({ phase }) => {
        if (phase !== "checking" || isPut) return;
        isPut = true;
        disk.write(`${PLACE}/片子/code/别人的.js`, "// 别人写的", { quietly: true });
      },
    });
    if (result.kind !== "unverified") throw new Error(`Not unverified: ${result.kind}`);
    expect(disk.has(`${PLACE}/片子/${INCOMPLETE_FILE}`)).toBe(true);
    expect(await result.takeBack()).toBe(true);
    expect(filesOf(disk, `${PLACE}/片子`)).toEqual(new Map([["code/别人的.js", "// 别人写的"]]));
    expect(await folders.records.get(key)).toBeUndefined();
  });
});

describe("a project that moved", () => {
  it("is not taken away as a project of the browser, only with its folder", async () => {
    const context = setup();
    const { folders, library } = context;
    const key = await browserProject(library);
    expect((await moveIt(context, key)).kind).toBe("moved");
    await expect(library.remove(key)).rejects.toThrow();
    expect(await folders.records.get(key)).toBeDefined();
    expect((await loaded(library, key)).store).toBeDefined();
  });

  it("leaves no file that says it is not done, and none where it stopped before taking it away", async () => {
    const context = setup();
    const { disk, folders, move } = context;
    const key = await browserProject(context.library);
    // The page goes away right after the record: the file is there, and the record says so.
    for (let attempt = 0; attempt < 3; attempt++) {
      disk.onNext("removeEntry", `${PLACE}/片子/${INCOMPLETE_FILE}`, () => {
        throw new DOMException("The page went away", "AbortError");
      });
    }
    expect((await moveIt(context, key)).kind).toBe("moved");
    expect(disk.has(`${PLACE}/片子/${INCOMPLETE_FILE}`)).toBe(true);
    const record = (await folders.records.get(key)) as FolderRecord;
    expect(record.unfinished).toBeDefined();
    // The next time it opens, that goes.
    const settled = await move.settle(record);
    expect(settled.unfinished).toBeUndefined();
    expect(disk.has(`${PLACE}/片子/${INCOMPLETE_FILE}`)).toBe(false);
    expect((await folders.records.get(key))?.unfinished).toBeUndefined();
  });

  it("leaves a file that says it is not done that somebody else wrote since", async () => {
    const context = setup();
    const { disk, folders, move } = context;
    const key = await browserProject(context.library);
    for (let attempt = 0; attempt < 3; attempt++) {
      disk.onNext("removeEntry", `${PLACE}/片子/${INCOMPLETE_FILE}`, () => {
        throw new DOMException("The page went away", "AbortError");
      });
    }
    expect((await moveIt(context, key)).kind).toBe("moved");
    disk.write(`${PLACE}/片子/${INCOMPLETE_FILE}`, "别人的导出");
    const settled = await move.settle((await folders.records.get(key)) as FolderRecord);
    expect(settled.unfinished).toBeUndefined();
    expect(disk.text(`${PLACE}/片子/${INCOMPLETE_FILE}`)).toBe("别人的导出");
  });
});

describe("an asset whose path no folder can have", () => {
  const LONG = `assets/${"长".repeat(70)}.png`;

  it("gets a path of its own, which the project takes in one step once the folder is right", async () => {
    const context = setup();
    const { disk, folders, library, move } = context;
    const key = await browserProject(library, { "assets/第1~3集.png": "图", [LONG]: "长图" });
    const project = await loaded(library, key);
    expect(await move.check(key, project.store, library.media(key))).toBeUndefined();
    // Checking changes nothing.
    const before = Object.values(project.store.getState().assets ?? {}).map(({ path }) => path);
    expect(before.toSorted()).toEqual(["assets/第1~3集.png", LONG].toSorted());
    const place = { chosen: await chosen(disk, folders), inside: "片子" };
    const result = await move.run(key, project.store, library.media(key), place, {
      notice: NOTICE,
      saved: project.saved,
    });
    expect(result.kind).toBe("moved");
    if (result.kind !== "moved") return;
    const renamed = new Map(result.renamed.map(({ from, to }) => [from, to]));
    expect(renamed.get("assets/第1~3集.png")).toBe("assets/第1-3集.png");
    const short = renamed.get(LONG) as string;
    expect(short.length).toBeLessThanOrEqual(120);
    expect(short.split("/").every((part) => part.length <= 64)).toBe(true);
    expect(disk.text(`${PLACE}/片子/assets/第1-3集.png`)).toBe("图");
    expect(disk.text(`${PLACE}/片子/${short}`)).toBe("长图");
    const after = Object.values(project.store.getState().assets ?? {}).map(({ path }) => path);
    expect(after.toSorted()).toEqual(["assets/第1-3集.png", short].toSorted());
    // What the folder has is what the project says, and the log has it too.
    expect(filesOf(disk, `${PLACE}/片子`).get("assets.json")).toBe(
      project.store.exportFiles().files.get("assets.json"),
    );
    // One step takes it back.
    expect(project.store.undo().ok).toBe(true);
    const undone = Object.values(project.store.getState().assets ?? {}).map(({ path }) => path);
    expect(undone.toSorted()).toEqual(before.toSorted());
    project.close();
    const again = await loaded(library, key);
    expect(
      Object.values(again.store.getState().assets ?? {})
        .map(({ path }) => path)
        .toSorted(),
    ).toEqual(after.toSorted());
    again.close();
  });

  it("stays as it was where the move does not get to the end", async () => {
    const context = setup();
    const { disk, library } = context;
    const key = await browserProject(library, { "assets/第1~3集.png": "图" });
    disk.failWrites(`${PLACE}/片子/${MANIFEST_FILE}`);
    expect((await moveIt(context, key)).kind).toBe("stopped");
    const project = await loaded(library, key);
    expect(Object.values(project.store.getState().assets ?? {}).map(({ path }) => path)).toEqual([
      "assets/第1~3集.png",
    ]);
    project.close();
  });

  it("cannot get one in a locked project, which then does not move", async () => {
    const context = setup();
    const { library } = context;
    const base = createProject({ name: "片子" });
    const locked = {
      ...base,
      manifest: { ...base.manifest, tags: [{ name: "已发布", color: "#2ea043", locked: true }] },
    };
    const store = ProjectStore.create(locked, {});
    const id = store.getState().manifest.id;
    store.destroy();
    const unlocked = ProjectStore.create(base, {});
    const file = new Blob(["图"]);
    const hash = await hashFile(file);
    await library.media(id).put(hash, file);
    expect(
      unlocked.execute({
        type: "asset.add",
        params: {
          id: "asset_a",
          asset: { kind: "image", storage: "local", path: "assets/第1~3集.png", hash, size: 3 },
        },
      }).ok,
    ).toBe(true);
    const withAsset = unlocked.getState();
    unlocked.destroy();
    const project = ProjectStore.create(
      {
        ...locked,
        manifest: { ...locked.manifest, id },
        assets: { assets: withAsset.assets ?? {} },
      },
      {},
    );
    await library.create({ id, name: "片子" }, project.encodeState());
    project.destroy();
    expect(await moveIt(context, id)).toEqual({
      kind: "refused",
      refusal: { kind: "locked", paths: ["assets/第1~3集.png"] },
    });
  });

  it("is no reason to give other files paths of their own: long ones of code are listed", async () => {
    const context = setup();
    const name = `code/${"长".repeat(70)}.js`;
    const key = await browserProject(context.library, {}, { [name]: "// 长" });
    expect(await moveIt(context, key)).toEqual({
      kind: "refused",
      refusal: { kind: "too-long", paths: [name] },
    });
  });
});

describe("a move that people stopped while it compared", () => {
  it("keeps nothing of what reading the files found out after that", async () => {
    const context = setup();
    const { folders, library } = context;
    const key = await browserProject(library, { "assets/大.bin": big() });
    const stopper = new AbortController();
    const result = await moveIt(context, key, {
      signal: stopper.signal,
      onStep: ({ phase, file }) => {
        if (phase === "checking" && file === "assets/大.bin") stopper.abort();
      },
    });
    expect(result).toMatchObject({ kind: "stopped", cancelled: true });
    // Reading the file goes on by itself for a moment.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await folders.bases.hashOf(key, "assets/大.bin")).toBeUndefined();
  });
});

describe("an asset that people took away before the move", () => {
  it("keeps the copy of its file while the project is open, so that undo can have it back", async () => {
    const context = setup();
    const { disk, folders, library, move } = context;
    const key = await browserProject(library, { "assets/图.png": "图" });
    const project = await loaded(library, key);
    const [asset, { hash }] = Object.entries(project.store.getState().assets ?? {})[0] as [
      string,
      { hash: string },
    ];
    expect(project.store.execute({ type: "asset.remove", params: { asset } }).ok).toBe(true);
    const place = { chosen: await chosen(disk, folders), inside: "片子" };
    const result = await move.run(key, project.store, library.media(key), place, {
      notice: NOTICE,
      saved: project.saved,
    });
    expect(result.kind).toBe("moved");
    const record = (await folders.records.get(key)) as FolderRecord;
    const files = new FolderAssets({
      folder: () => record.folder,
      key,
      bases: folders.bases,
      browser: library.media(key),
    });
    const released = await move.release(key, project.store.getState().assets ?? {}, files, {
      open: true,
    });
    files.stop();
    expect(released.released).toBe(0);
    expect(project.store.undo().ok).toBe(true);
    expect(project.store.getState().assets?.[asset]?.hash).toBe(hash);
    expect(await (await library.media(key).get(hash))?.text()).toBe("图");
    project.close();
  });
});

describe("a move after one that stopped right before the end", () => {
  it("has what the editor knows the files by from this folder, and nothing of the one before", async () => {
    const context = setup();
    const { folders, library } = context;
    const key = await browserProject(library);
    // The page went away after the bases were kept, before the record: as if for another folder.
    const turn = await folders.bases.claim(key);
    await folders.bases.save(key, turn, {
      put: [{ path: "code/旧的.js", base: "// 别处的", synced: hashText("// 别处的") }],
    });
    expect(await folders.records.get(key)).toBeUndefined();

    expect((await moveIt(context, key)).kind).toBe("moved");
    const files = await exported(library, key);
    const bases = await folders.bases.load(key);
    expect(bases.map(({ path }) => path).toSorted()).toEqual([...files.keys()].toSorted());
  });
});

describe("a project that cannot move", () => {
  it("is one that is a folder already", async () => {
    const context = setup();
    const key = await browserProject(context.library);
    expect((await moveIt(context, key)).kind).toBe("moved");
    const again = await moveIt(context, key);
    expect(again).toEqual({ kind: "refused", refusal: { kind: "already" } });
  });

  it("is one that another window is moving right now", async () => {
    const context = setup();
    const { disk, library } = context;
    const key = await browserProject(library);
    // Another window has the turn to write the folder of the project.
    const other = await memoryFolders(disk).writer(key).claim();
    const result = await moveIt(context, key);
    expect(result).toEqual({ kind: "refused", refusal: { kind: "busy" } });
    expect(disk.names(PLACE)).toEqual([]);
    other.release();
    expect((await moveIt(context, key)).kind).toBe("moved");
  });

  it("is one with names that a folder cannot have, which nothing gets written of", async () => {
    const context = setup();
    const key = await browserProject(context.library, {}, { "code/aux.js": "// 设备名" });
    const project = await loaded(context.library, key);
    expect(await context.move.check(key, project.store, context.library.media(key))).toEqual({
      kind: "refused",
      paths: ["code/aux.js"],
    });
    project.close();
    expect(await moveIt(context, key)).toMatchObject({ kind: "refused" });
    expect(context.disk.names(PLACE)).toEqual([]);
  });

  it("is one with paths that are one file on some systems", async () => {
    const context = setup();
    const key = await browserProject(
      context.library,
      {},
      { "code/Main.js": "// 大写", "code/main.js": "// 小写" },
    );
    const result = await moveIt(context, key);
    expect(result).toMatchObject({ kind: "refused", refusal: { kind: "clashing" } });
    if (result.kind === "refused" && result.refusal.kind === "clashing") {
      expect(result.refusal.paths).toHaveLength(1);
    }
    expect(context.disk.names(PLACE)).toEqual([]);
  });
});

describe("the copies in the browser of the files of a project that moved", () => {
  async function moved() {
    const context = setup();
    const { folders, library } = context;
    const key = await browserProject(library, { "assets/图.png": "图", "assets/声.wav": "声" });
    await library.media(key).put("sound-1:abc", new Blob(["代码做的声音"]));
    await library.media(key).put("sha256-unused", new Blob(["没用了"]));
    expect((await moveIt(context, key)).kind).toBe("moved");
    const record = await folders.records.get(key);
    const files = new FolderAssets({
      folder: () => record?.folder as LocalFolder,
      key,
      bases: folders.bases,
      browser: library.media(key),
    });
    const project = await loaded(library, key);
    const assets = project.store.getState().assets ?? {};
    project.close();
    return { ...context, key, files, assets };
  }

  it("go where the folder has the files as the project says, and what the editor made stays", async () => {
    const { move, library, key, files, assets } = await moved();
    expect(await move.copiesOf(key)).toBe(
      new Blob(["图"]).size + new Blob(["声"]).size + new Blob(["没用了"]).size,
    );
    const { released, missing, unused } = await move.release(key, assets, files, { open: true });
    expect(missing).toEqual([]);
    expect(released).toBe(new Blob(["图", "声"]).size);
    // Undo can bring back an asset that uses this one while the project is open somewhere.
    expect(unused.map(({ name }) => name)).toEqual(["sha256-unused"]);
    expect((await library.copies(key)).map(({ name }) => name)).toEqual(["sha256-unused"]);
    expect(await library.media(key).get("sound-1:abc")).toBeDefined();
    files.stop();
  });

  it("of files that no asset uses go once the project is open nowhere, as nothing can bring it back", async () => {
    const { move, library, key, files, assets } = await moved();
    const { released, unused } = await move.release(key, assets, files, { open: false });
    expect(unused).toEqual([]);
    expect(released).toBe(new Blob(["图", "声", "没用了"]).size);
    expect(await library.copies(key)).toEqual([]);
    expect(await library.media(key).get("sound-1:abc")).toBeDefined();
    files.stop();
  });

  it("stay where the folder does not have the file as the project says", async () => {
    const { disk, move, library, key, files, assets } = await moved();
    disk.write(`${PLACE}/片子/assets/声.wav`, "换掉了");
    const { missing } = await move.release(key, assets, files, { open: false });
    const sound = Object.values(assets).find(({ path }) => path === "assets/声.wav");
    expect(missing.map(({ name }) => name)).toEqual([sound?.hash]);
    expect((await library.copies(key)).map(({ name }) => name)).toEqual([sound?.hash]);
    files.stop();
  });

  it("are never taken from a project of the browser", async () => {
    const { library } = setup();
    const key = await browserProject(library, { "assets/图.png": "图" });
    const [copy] = await library.copies(key);
    await expect(library.dropCopies(key, [copy?.name as string])).rejects.toThrow();
    expect(await library.copies(key)).toHaveLength(1);
  });
});
