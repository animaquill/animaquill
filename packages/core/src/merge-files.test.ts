import { describe, expect, it } from "vitest";
import { loadFixture } from "../../schema/scripts/fixture.ts";
import type { FileChange } from "./merge-files.ts";
import { orderedSections, orderedTracks } from "./model.ts";
import {
  ProjectStore,
  USER,
  folderBatch,
  type CommandCall,
  type CommandResult,
  type ExecuteOptions,
  type MergeOptions,
  type MergeResult,
} from "./store.ts";

const MAIN = "timelines/main/timeline.json";
const VERTICAL = "timelines/main/overrides/format.vertical.json";
const TITLE = "scenes/title/scene.json";
const TITLE_PAGE = "scenes/title/index.html";
const CODE = "code/animate.js";
const FOLDER = folderBatch("1");

/** The example project without its locked tag, so that it can be changed. */
function open(): ProjectStore {
  const files = loadFixture("v1");
  const manifest = JSON.parse(files.get("animaquill.json") as string);
  delete manifest.tags;
  files.set("animaquill.json", JSON.stringify(manifest));
  const { store } = ProjectStore.open(files);
  if (!store) throw new Error("fixture did not open");
  return store;
}

/** What the editor last wrote into the folder: the project as it is now. */
const written = (store: ProjectStore) => store.exportFiles().files;

type Files = Map<string, string>;

/** What the folder holds besides a batch: what the editor last wrote there, see `changesOf`. */
const folders = new WeakMap<readonly FileChange[], ReadonlyMap<string, string>>();

/** What changed between what the folder had and what it has now, as one batch. */
function changesOf(base: ReadonlyMap<string, string>, edit: (files: Files) => void): FileChange[] {
  const next = new Map(base);
  edit(next);
  const batch = [...new Set([...base.keys(), ...next.keys()])]
    .filter((path) => base.get(path) !== next.get(path))
    .map((path) => ({ path, base: base.get(path), text: next.get(path) }));
  folders.set(batch, base);
  return batch;
}

/**
 * Merges a batch, with the files of the folder outside of it as `changesOf` had them, or else as
 * the editor would write them now, which is the same while it has nothing unwritten.
 */
function mergeFiles(
  store: ProjectStore,
  batch: readonly FileChange[],
  options: Omit<MergeOptions, "baseOf"> & Partial<Pick<MergeOptions, "baseOf">>,
): MergeResult {
  const folder = folders.get(batch) ?? written(store);
  return store.mergeFiles(batch, { baseOf: (path) => folder.get(path), ...options });
}

function editJson(files: Files, path: string, edit: (document: any) => void): void {
  const document = JSON.parse(files.get(path) as string);
  edit(document);
  files.set(path, JSON.stringify(document, null, 2));
}

const clipIn = (document: any, id: string) =>
  document.tracks.flatMap((track: any) => track.clips).find((item: any) => item.id === id);
const trackIn = (document: any, id: string) =>
  document.tracks.find((track: any) => track.id === id);

const main = (store: ProjectStore) => {
  const value = store.getState().timelines["main"];
  if (!value) throw new Error("no main timeline");
  return value;
};
const clip = (store: ProjectStore, id = "clip_title") => main(store).clips[id];
const property = (store: ProjectStore, path: string, id = "clip_title") =>
  clip(store, id)?.properties?.[path];

function success(result: CommandResult) {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result;
}

function merged(result: MergeResult) {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result;
}

function refused(result: MergeResult) {
  if (result.ok) throw new Error("expected nothing of the batch to come in");
  return result;
}

const run = (store: ProjectStore, type: string, params: unknown, options: ExecuteOptions = {}) =>
  success(store.execute({ type, params } as CommandCall, options));

const setProperty = (store: ProjectStore, path: string, value: unknown, id = "clip_title") =>
  run(store, "clip.setProperty", { timeline: "main", clip: id, path, value });

const statusOf = (result: MergeResult, path: string) =>
  result.files.find((file) => file.path === path);

describe("files changed in the folder, merged with what the editor has", () => {
  it("bring in what the folder changed, and keep what the editor did not write yet", () => {
    const store = open();
    const base = written(store);
    setProperty(store, "param.size", 80);
    const batch = changesOf(base, (files) =>
      editJson(files, MAIN, (document) => {
        clipIn(document, "clip_title").name = "新标题";
      }),
    );
    const result = merged(mergeFiles(store, batch, { origin: FOLDER }));
    expect(clip(store)?.name).toBe("新标题");
    expect(property(store, "param.size")).toBe(80);
    expect(result.conflicts).toEqual([]);
    expect(result.problems).toEqual([]);
    expect(result.patches.map(({ path }) => path.join("/"))).toEqual([
      "timelines/main/clips/clip_title/name",
    ]);
    // The file does not have what the editor did, so it is to be written again.
    expect(result.files).toEqual([
      { path: MAIN, status: "merged", base: batch[0]?.text, rewrite: true },
    ]);
  });

  it("keep the editor's value where both changed the same one, and say where", () => {
    const store = open();
    const base = written(store);
    setProperty(store, "param.size", 80);
    const batch = changesOf(base, (files) =>
      editJson(files, MAIN, (document) => {
        clipIn(document, "clip_title").properties["param.size"] = 50;
        clipIn(document, "clip_title").start = "0.5";
      }),
    );
    const result = merged(mergeFiles(store, batch, { origin: FOLDER }));
    expect(property(store, "param.size")).toBe(80);
    expect(clip(store)?.start).toBe("0.5");
    expect(result.conflicts).toEqual([
      {
        file: MAIN,
        path: ["timelines", "main", "clips", "clip_title", "properties", "param.size"],
        theirs: 50,
      },
    ]);
    expect(result.problems).toEqual([
      {
        severity: "warning",
        code: "merge-conflict",
        file: MAIN,
        path: "clip_title.properties.param.size",
        message: "片段“标题”的属性 param.size 在编辑器和文件里都改了，保留了编辑器里的",
      },
    ]);
    expect(statusOf(result, MAIN)?.rewrite).toBe(true);
  });

  it("change nothing, and need no writing, when the file is what the editor wrote", () => {
    const store = open();
    const base = written(store);
    const text = base.get(MAIN) as string;
    const result = merged(
      mergeFiles(store, [{ path: MAIN, base: text, text }], { origin: FOLDER }),
    );
    expect(result.patches).toEqual([]);
    expect(result.files).toEqual([{ path: MAIN, status: "merged", base: text, rewrite: false }]);
  });

  it("do not need writing when the file only looks different", () => {
    const store = open();
    const base = written(store);
    const text = JSON.stringify(JSON.parse(base.get(MAIN) as string));
    const result = merged(
      mergeFiles(store, [{ path: MAIN, base: base.get(MAIN), text }], { origin: FOLDER }),
    );
    expect(result.patches).toEqual([]);
    expect(result.files).toEqual([{ path: MAIN, status: "merged", base: text, rewrite: false }]);
  });

  it("are one change, from one origin, which goes back and comes again as a whole", () => {
    const store = open();
    const base = written(store);
    const before = store.getState();
    const batch = changesOf(base, (files) => {
      editJson(files, MAIN, (document) => {
        document.name = "改名的主线";
      });
      files.set(CODE, `${files.get(CODE)}// 外面加的\n`);
      editJson(files, TITLE, (document) => {
        document.name = "外面改的标题卡";
      });
    });
    const result = merged(mergeFiles(store, batch, { origin: FOLDER }));
    const after = store.getState();
    expect(store.history.at(-1)).toMatchObject({ origin: FOLDER, commands: ["file.merge"] });
    expect(store.history.at(-1)?.patches).toEqual(result.patches);
    // The person's undo is for what the person did.
    expect(store.canUndo).toBe(false);
    expect(store.undoOrigin(USER).ok).toBe(false);
    expect(store.undoOrigin(FOLDER).ok).toBe(true);
    expect(store.getState()).toEqual(before);
    expect(store.redoOrigin(FOLDER).ok).toBe(true);
    expect(store.getState()).toEqual(after);
  });

  it("can be the person's own, and then the person's undo takes them back", () => {
    const store = open();
    const base = written(store);
    const before = store.getState();
    const batch = changesOf(base, (files) =>
      editJson(files, MAIN, (document) => {
        document.name = "改名的主线";
      }),
    );
    merged(mergeFiles(store, batch, { origin: USER }));
    expect(store.canUndo).toBe(true);
    store.undo();
    expect(store.getState()).toEqual(before);
  });

  it("write nothing when only checking", () => {
    const store = open();
    const base = written(store);
    const before = store.getState();
    const batch = changesOf(base, (files) =>
      editJson(files, MAIN, (document) => {
        document.name = "改名的主线";
      }),
    );
    const result = merged(mergeFiles(store, batch, { origin: FOLDER, dryRun: true }));
    expect(result.patches).toHaveLength(1);
    expect(store.getState()).toBe(before);
  });
});

describe("code changed in the folder", () => {
  const lines = (count: number) =>
    Array.from({ length: count }, (_, index) => `line ${index}\n`).join("");

  it("merges by lines with what the editor changed", () => {
    const store = open();
    run(store, "file.write", { path: CODE, text: lines(10) });
    const base = written(store);
    run(store, "file.write", { path: CODE, text: `// 编辑器\n${lines(10)}` });
    const batch = changesOf(base, (files) => files.set(CODE, `${lines(10)}// 外面\n`));
    const result = merged(mergeFiles(store, batch, { origin: FOLDER }));
    expect(store.getState().files[CODE]).toBe(`// 编辑器\n${lines(10)}// 外面\n`);
    expect(result.conflicts).toEqual([]);
    expect(statusOf(result, CODE)?.rewrite).toBe(true);
  });

  it("keeps the editor's lines where both changed the same ones, and says which", () => {
    const store = open();
    run(store, "file.write", { path: CODE, text: lines(10) });
    const base = written(store);
    run(store, "file.write", { path: CODE, text: lines(10).replace("line 4\n", "编辑器 4\n") });
    const batch = changesOf(base, (files) =>
      files.set(CODE, lines(10).replace("line 4\n", "外面 4\n").replace("line 8\n", "外面 8\n")),
    );
    const result = merged(mergeFiles(store, batch, { origin: FOLDER }));
    expect(store.getState().files[CODE]).toBe(
      lines(10).replace("line 4\n", "编辑器 4\n").replace("line 8\n", "外面 8\n"),
    );
    expect(result.conflicts).toEqual([
      { file: CODE, path: ["files", CODE], lines: { from: 4, to: 5 }, theirs: "外面 4\n" },
    ]);
    expect(result.problems.map(({ message }) => message)).toEqual([
      "code/animate.js 第 5 行在编辑器和文件里都改了，保留了编辑器里的",
    ]);
  });

  it("keeps code the editor changed when the folder took the file away", () => {
    const store = open();
    const base = written(store);
    run(store, "file.write", { path: CODE, text: "// 编辑器改的\n" });
    const batch = changesOf(base, (files) => files.delete(CODE));
    const result = merged(mergeFiles(store, batch, { origin: FOLDER }));
    expect(store.getState().files[CODE]).toBe("// 编辑器改的\n");
    expect(result.conflicts).toEqual([{ file: CODE, path: ["files", CODE] }]);
    expect(statusOf(result, CODE)).toEqual({
      path: CODE,
      status: "merged",
      base: undefined,
      rewrite: true,
    });
  });

  it("takes a file away that the editor left as it was", () => {
    const store = open();
    run(store, "file.write", { path: "code/extra.js", text: "export {};\n" });
    const base = written(store);
    const batch = changesOf(base, (files) => files.delete("code/extra.js"));
    merged(mergeFiles(store, batch, { origin: FOLDER }));
    expect(store.getState().files["code/extra.js"]).toBeUndefined();
  });
});

describe("files the folder took away", () => {
  const addScene = (store: ProjectStore, id: string) =>
    run(store, "scene.add", {
      id,
      scene: { name: "没人用的场景", entry: "index.html", runtime: 1 },
      files: { "index.html": "<p>x</p>", "helper.js": "export {};" },
    });

  it("take away a scene that nothing uses, with its files", () => {
    const store = open();
    addScene(store, "spare");
    const base = written(store);
    const batch = changesOf(base, (files) => {
      for (const path of files.keys()) if (path.startsWith("scenes/spare/")) files.delete(path);
    });
    const result = merged(mergeFiles(store, batch, { origin: FOLDER }));
    expect(store.getState().scenes["spare"]).toBeUndefined();
    expect(Object.keys(store.getState().files).filter((path) => path.includes("spare"))).toEqual(
      [],
    );
    expect(result.files.every((file) => file.status === "merged" && file.base === undefined)).toBe(
      true,
    );
    expect(store.exportFiles().problems).toEqual([]);
  });

  it("leave a scene that is still in use, with its files, until people decide", () => {
    const store = open();
    const base = written(store);
    const before = store.getState();
    const batch = changesOf(base, (files) => {
      for (const path of files.keys()) if (path.startsWith("scenes/title/")) files.delete(path);
    });
    const result = merged(mergeFiles(store, batch, { origin: FOLDER }));
    expect(store.getState()).toBe(before);
    expect(result.files.map(({ status }) => status)).toEqual(["blocked", "blocked"]);
    expect(result.files.map(({ base: kept }) => kept)).toEqual(batch.map(({ base: old }) => old));
    expect(result.held).toEqual([
      ["scenes", "title"],
      ["files", TITLE_PAGE],
    ]);
    expect(result.problems).toEqual([
      {
        severity: "warning",
        code: "still-in-use",
        file: TITLE,
        message: "外面删掉了场景“标题卡”，但项目还在用它，先不删",
      },
      {
        severity: "warning",
        code: "still-in-use",
        file: TITLE_PAGE,
        message: "外面删掉了这个文件，但场景“标题卡”要留着，它也先留着",
      },
    ]);
  });
});

describe("locks and who changed the files", () => {
  /** In the example, 叠加 is locked, with clip_lottie and clip_idea on it. */
  const LOCKED = "track_overlay";

  it("leave what is on locked tracks as it is, take in the rest, and write the file again", () => {
    const store = open();
    const base = written(store);
    const batch = changesOf(base, (files) =>
      editJson(files, MAIN, (document) => {
        clipIn(document, "clip_idea").name = "改过";
        clipIn(document, "clip_title").name = "新标题";
      }),
    );
    const result = merged(mergeFiles(store, batch, { origin: FOLDER }));
    expect(clip(store, "clip_idea")?.name).toBe("样片：换个开场");
    expect(clip(store)?.name).toBe("新标题");
    expect(result.kept).toEqual([["timelines", "main", "clips", "clip_idea", "name"]]);
    expect(result.problems).toEqual([
      {
        severity: "warning",
        code: "track-locked",
        file: MAIN,
        path: "clip_idea",
        message: "轨道“叠加”已锁定，文件里对片段“样片：换个开场”的改动没有生效",
      },
    ]);
    expect(statusOf(result, MAIN)).toMatchObject({ status: "merged", rewrite: true });
  });

  it("do not take a lock off for the folder, but do for the person, who hears about it", () => {
    const unlocked = (store: ProjectStore) =>
      changesOf(written(store), (files) =>
        editJson(files, MAIN, (document) => {
          delete trackIn(document, LOCKED).locked;
          clipIn(document, "clip_idea").name = "改过";
        }),
      );
    const folder = open();
    const kept = merged(mergeFiles(folder, unlocked(folder), { origin: FOLDER }));
    expect(main(folder).tracks[LOCKED]?.locked).toBe(true);
    expect(clip(folder, "clip_idea")?.name).toBe("样片：换个开场");
    expect(kept.problems.map(({ message }) => message)).toEqual([
      "轨道“叠加”已锁定，只有用户自己改的文件能解锁，要解锁请用命令，或者请用户解锁",
      "轨道“叠加”已锁定，文件里对片段“样片：换个开场”的改动没有生效",
    ]);

    const person = open();
    const opened = merged(mergeFiles(person, unlocked(person), { origin: USER }));
    expect(main(person).tracks[LOCKED]?.locked).toBeUndefined();
    expect(clip(person, "clip_idea")?.name).toBe("改过");
    expect(opened.problems).toEqual([
      {
        severity: "warning",
        code: "track-unlocked",
        file: MAIN,
        path: LOCKED,
        message: "这个文件解开了轨道“叠加”的锁",
      },
    ]);
  });

  it("leave the tags to people, and take in the rest of the file", () => {
    const tagged = (store: ProjectStore) =>
      changesOf(written(store), (files) =>
        editJson(files, "animaquill.json", (document) => {
          document.tags = [{ name: "初稿", color: "#888888" }];
          document.name = "新名字";
        }),
      );
    const folder = open();
    const kept = merged(mergeFiles(folder, tagged(folder), { origin: FOLDER }));
    expect(folder.getState().manifest.tags).toBeUndefined();
    expect(folder.getState().manifest.name).toBe("新名字");
    expect(kept.kept).toEqual([["manifest", "tags"]]);
    expect(kept.problems).toEqual([
      {
        severity: "warning",
        code: "user-only",
        file: "animaquill.json",
        path: "tags",
        message: "只有用户自己能改项目的标签，文件里对标签的改动没有生效",
      },
    ]);
    expect(kept.files[0]).toMatchObject({ status: "merged", rewrite: true });

    const person = open();
    merged(mergeFiles(person, tagged(person), { origin: USER }));
    expect(person.getState().manifest.tags).toEqual([{ name: "初稿", color: "#888888" }]);
  });

  it("change nothing in a locked project, and leave the files waiting", () => {
    const { store } = ProjectStore.open(loadFixture("v1"));
    if (!store) throw new Error("fixture did not open");
    const base = written(store);
    const batch = changesOf(base, (files) =>
      editJson(files, MAIN, (document) => {
        document.name = "新名字";
      }),
    );
    const result = refused(mergeFiles(store, batch, { origin: USER }));
    expect(result.error.code).toBe("project-locked");
    expect(result.files).toEqual([
      { path: MAIN, status: "blocked", base: base.get(MAIN), rewrite: false },
    ]);
  });
});

describe("files that cannot come in", () => {
  it("leave a file that is not valid waiting, and take in the rest", () => {
    const store = open();
    const base = written(store);
    const batch = changesOf(base, (files) => {
      editJson(files, MAIN, (document) => {
        clipIn(document, "clip_title").start = 5;
      });
      files.set(CODE, "// 外面改的\n");
    });
    const result = merged(mergeFiles(store, batch, { origin: FOLDER }));
    expect(store.getState().files[CODE]).toBe("// 外面改的\n");
    expect(clip(store)?.start).toBe("0");
    expect(statusOf(result, MAIN)).toEqual({
      path: MAIN,
      status: "blocked",
      base: base.get(MAIN),
      rewrite: false,
    });
    expect(statusOf(result, CODE)).toMatchObject({ status: "merged", rewrite: false });
    expect(result.problems).toEqual([
      expect.objectContaining({ severity: "error", file: MAIN, path: "tracks.0.clips.0.start" }),
    ]);
  });

  it("leave a file waiting whose name cannot be an id", () => {
    const store = open();
    const scene = JSON.stringify({ name: "坏名字", entry: "index.html", runtime: 1 });
    const result = merged(
      mergeFiles(store, [{ path: "scenes/坏 名字/scene.json", base: undefined, text: scene }], {
        origin: FOLDER,
      }),
    );
    expect(result.files[0]).toMatchObject({ status: "blocked", base: undefined });
    expect(result.problems.map(({ code }) => code)).toEqual(["invalid-name"]);
    expect(Object.keys(store.getState().scenes)).toEqual(["title"]);
  });

  it("ignore files the project does not keep", () => {
    const store = open();
    const before = store.getState();
    const paths = [
      "AGENTS.md",
      ".animaquill/recovered/x.json",
      "assets/new.png",
      "scenes/title/index.html.crswap",
      ".git/HEAD",
      "../outside.js",
    ];
    const result = merged(
      mergeFiles(
        store,
        paths.map((path) => ({ path, base: undefined, text: "x" })),
        { origin: FOLDER },
      ),
    );
    expect(store.getState()).toBe(before);
    expect(result.files.map(({ status }) => status)).toEqual(paths.map(() => "ignored"));
  });

  it("leave the file waiting that would break the project, and take in the rest", () => {
    const store = open();
    run(store, "track.add", { timeline: "main", id: "track_empty", kind: "video" });
    const base = written(store);
    // The editor put a picture on a track that the folder made one for sound.
    run(store, "clip.add", {
      timeline: "main",
      track: "track_empty",
      clip: {
        id: "clip_mine",
        start: "0",
        duration: "1",
        source: { kind: "color", color: "#111111" },
      },
    });
    const batch = changesOf(base, (files) => {
      editJson(files, MAIN, (document) => {
        const track = trackIn(document, "track_empty");
        track.kind = "audio";
        delete track.hidden;
        document.name = "外面改的名字";
      });
      files.set(CODE, "// 外面改的\n");
    });
    const result = merged(mergeFiles(store, batch, { origin: FOLDER }));
    expect(main(store).tracks["track_empty"]?.kind).toBe("video");
    expect(main(store).name).toBe("主线");
    expect(clip(store, "clip_mine")).toBeDefined();
    expect(store.getState().files[CODE]).toBe("// 外面改的\n");
    expect(statusOf(result, MAIN)).toEqual({
      path: MAIN,
      status: "blocked",
      base: base.get(MAIN),
      rewrite: false,
    });
    expect(result.problems.filter(({ file }) => file === MAIN)).toEqual([
      {
        severity: "warning",
        code: "merge-would-break",
        file: MAIN,
        message: "片段“clip_mine”会留在放不下它的轨道“track_empty”上，这个文件先不并入",
      },
      {
        severity: "warning",
        code: "merge-would-break",
        file: MAIN,
        path: "tracks.5.clips.0.source.kind",
        message: "合并以后这个文件会不再合格式：audio 轨道不能放 color 片段，这个文件先不并入",
      },
    ]);
    expect(store.exportFiles().problems).toEqual([]);
  });

  it("bring nothing in when animaquill.json is gone", () => {
    const store = open();
    const base = written(store);
    const before = store.getState();
    const batch = changesOf(base, (files) => files.clear());
    const result = refused(mergeFiles(store, batch, { origin: FOLDER }));
    expect(result.error.code).toBe("manifest-deleted");
    expect(store.getState()).toBe(before);
    expect(result.files.every(({ status }) => status === "blocked")).toBe(true);
  });

  it("do not take a batch with a path in it twice", () => {
    const store = open();
    const text = written(store).get(CODE);
    const twice = [
      { path: CODE, base: text, text: "a" },
      { path: CODE, base: text, text: "b" },
    ];
    expect(refused(mergeFiles(store, twice, { origin: FOLDER })).error.code).toBe("invalid-batch");
  });

  it("do not take a newer format", () => {
    const store = open();
    const batch = changesOf(written(store), (files) =>
      editJson(files, "animaquill.json", (document) => {
        document.formatVersion = 2;
      }),
    );
    expect(refused(mergeFiles(store, batch, { origin: FOLDER })).error.code).toBe(
      "format-mismatch",
    );
  });
});

describe("what the folder took away that is still in use", () => {
  it("keeps an asset that the editor started to use, and the file is written again", () => {
    const store = open();
    const base = written(store);
    run(store, "clip.add", {
      timeline: "main",
      track: "track_video",
      clip: {
        id: "clip_raw",
        start: "40",
        duration: "1",
        source: { kind: "video", media: { asset: "raw-footage" } },
      },
    });
    const batch = changesOf(base, (files) =>
      editJson(files, "assets.json", (document) => {
        delete document.assets["raw-footage"];
        document.assets.logo.credit = "别人";
      }),
    );
    const result = merged(mergeFiles(store, batch, { origin: FOLDER }));
    expect(store.getState().assets?.["raw-footage"]).toBeDefined();
    expect(store.getState().assets?.["logo"]?.credit).toBe("别人");
    expect(result.held).toEqual([["assets", "raw-footage"]]);
    expect(result.problems).toEqual([
      {
        severity: "warning",
        code: "still-in-use",
        file: "assets.json",
        path: "assets.raw-footage",
        message: "外面删掉了素材“raw-footage”，但项目还在用它，先不删",
      },
    ]);
    expect(result.files[0]).toMatchObject({ status: "merged", rewrite: true });
  });

  it("takes an asset away that nothing uses", () => {
    const store = open();
    const batch = changesOf(written(store), (files) =>
      editJson(files, "assets.json", (document) => {
        delete document.assets["raw-footage"];
      }),
    );
    const result = merged(mergeFiles(store, batch, { origin: FOLDER }));
    expect(store.getState().assets?.["raw-footage"]).toBeUndefined();
    expect(result.files[0]).toMatchObject({ status: "merged", rewrite: false });
  });

  it("keeps a track that the editor put a clip on, and takes the rest of it away", () => {
    const store = open();
    run(store, "track.add", { timeline: "main", id: "track_extra", kind: "video" });
    run(store, "clip.add", {
      timeline: "main",
      track: "track_extra",
      clip: {
        id: "clip_a",
        start: "0",
        duration: "1",
        source: { kind: "color", color: "#111111" },
      },
    });
    const base = written(store);
    run(store, "clip.add", {
      timeline: "main",
      track: "track_extra",
      clip: {
        id: "clip_b",
        start: "2",
        duration: "1",
        source: { kind: "color", color: "#222222" },
      },
    });
    const batch = changesOf(base, (files) =>
      editJson(files, MAIN, (document) => {
        document.tracks = document.tracks.filter((track: any) => track.id !== "track_extra");
      }),
    );
    const result = merged(mergeFiles(store, batch, { origin: FOLDER }));
    expect(main(store).tracks["track_extra"]).toBeDefined();
    expect(clip(store, "clip_a")).toBeUndefined();
    expect(clip(store, "clip_b")).toBeDefined();
    expect(result.held).toEqual([["timelines", "main", "tracks", "track_extra"]]);
    expect(store.exportFiles().problems).toEqual([]);
  });

  it("leaves a timeline that the manifest still lists", () => {
    const store = open();
    const file = "timelines/highlight/timeline.json";
    const batch = changesOf(written(store), (files) => files.delete(file));
    const result = merged(mergeFiles(store, batch, { origin: FOLDER }));
    expect(store.getState().timelines["highlight"]).toBeDefined();
    expect(result.files[0]).toMatchObject({ status: "blocked" });
    expect(result.problems.map(({ code }) => code)).toEqual(["still-in-use"]);
  });

  it("takes a timeline away when the manifest lets it go too", () => {
    const store = open();
    const file = "timelines/highlight/timeline.json";
    const batch = changesOf(written(store), (files) => {
      files.delete(file);
      editJson(files, "animaquill.json", (document) => {
        document.timelines = ["main"];
      });
    });
    const result = merged(mergeFiles(store, batch, { origin: FOLDER }));
    expect(store.getState().timelines["highlight"]).toBeUndefined();
    expect(result.files.map(({ status }) => status)).toEqual(["merged", "merged"]);
    expect(store.exportFiles().problems).toEqual([]);
  });

  it("leaves a timeline whose versions are still there", () => {
    const store = open();
    const batch = changesOf(written(store), (files) => {
      files.delete(MAIN);
      files.delete("timelines/main/overrides/language.en.json");
    });
    const result = merged(mergeFiles(store, batch, { origin: FOLDER }));
    expect(main(store).overrides["language.en"]).toBeDefined();
    expect(result.files.map(({ status }) => status)).toEqual(["blocked", "blocked"]);
  });
});

describe("versions and languages", () => {
  it("merge what a version changes, one value at a time", () => {
    const store = open();
    const base = written(store);
    const mine = changesOf(base, (files) =>
      editJson(files, VERTICAL, (document) => {
        document.clips.clip_title.properties["param.size"].value = 40;
      }),
    );
    success(store.importFile(VERTICAL, mine[0]?.text as string, { origin: USER }));
    const batch = changesOf(base, (files) =>
      editJson(files, VERTICAL, (document) => {
        document.clips.clip_interview.properties.fit.value = "cover";
      }),
    );
    const result = merged(mergeFiles(store, batch, { origin: FOLDER }));
    const vertical = main(store).overrides["format.vertical"];
    expect(vertical?.clips?.["clip_title"]?.properties?.["param.size"]?.value).toBe(40);
    expect(vertical?.clips?.["clip_interview"]?.properties?.["fit"]?.value).toBe("cover");
    expect(result.conflicts).toEqual([]);
  });

  it("take a version away, apart from what the editor changed in it", () => {
    const store = open();
    const base = written(store);
    const mine = changesOf(base, (files) =>
      editJson(files, VERTICAL, (document) => {
        document.clips.clip_title.properties["param.size"].value = 40;
      }),
    );
    success(store.importFile(VERTICAL, mine[0]?.text as string, { origin: USER }));
    const batch = changesOf(base, (files) => files.delete(VERTICAL));
    const result = merged(mergeFiles(store, batch, { origin: FOLDER }));
    const vertical = main(store).overrides["format.vertical"];
    expect(vertical?.clips?.["clip_interview"]).toBeUndefined();
    expect(vertical?.clips?.["clip_title"]?.properties?.["param.size"]?.value).toBe(40);
    expect(result.conflicts).toEqual([
      {
        file: VERTICAL,
        path: [
          "timelines",
          "main",
          "overrides",
          "format.vertical",
          "clips",
          "clip_title",
          "properties",
          "param.size",
        ],
      },
    ]);
    expect(result.files[0]).toMatchObject({ status: "merged", base: undefined, rewrite: true });
    expect(store.exportFiles().problems).toEqual([]);
  });

  it("take a language away, or keep it empty, as the folder has it", () => {
    const FRENCH = "locales/fr.json";
    const store = open();
    const empty = JSON.stringify({ strings: {} });
    merged(mergeFiles(store, [{ path: FRENCH, base: undefined, text: empty }], { origin: FOLDER }));
    expect(store.getState().locales["fr"]).toEqual({});
    const one = JSON.stringify({ strings: { a: { text: "un", base: "一" } } });
    merged(mergeFiles(store, [{ path: FRENCH, base: empty, text: one }], { origin: FOLDER }));
    expect(store.getState().locales["fr"]).toEqual({ a: { text: "un", base: "一" } });
    merged(mergeFiles(store, [{ path: FRENCH, base: one, text: empty }], { origin: FOLDER }));
    expect(store.getState().locales["fr"]).toEqual({});
    merged(mergeFiles(store, [{ path: FRENCH, base: empty, text: undefined }], { origin: FOLDER }));
    expect(store.getState().locales["fr"]).toBeUndefined();
  });
});

describe("the order of tracks and sections", () => {
  const tracks = (store: ProjectStore) => orderedTracks(main(store)).map(({ id }) => id);
  const sections = (store: ProjectStore) => orderedSections(main(store)).map(({ id }) => id);
  const move = (document: any, id: string, to: number) => {
    const track = trackIn(document, id);
    document.tracks = document.tracks.filter((each: any) => each !== track);
    document.tracks.splice(to, 0, track);
  };

  it("follows the folder when only the folder moved things, with what the editor added", () => {
    const store = open();
    const base = written(store);
    run(store, "track.add", { timeline: "main", id: "track_mine", kind: "video" });
    const batch = changesOf(base, (files) =>
      editJson(files, MAIN, (document) => move(document, "track_captions", 0)),
    );
    const result = merged(mergeFiles(store, batch, { origin: FOLDER }));
    expect(tracks(store)).toEqual([
      "track_captions",
      "track_video",
      "track_overlay",
      "track_voice",
      "track_music",
      "track_mine",
    ]);
    expect(result.conflicts).toEqual([]);
  });

  it("keeps the editor's order when both moved things differently, and says so", () => {
    const store = open();
    const base = written(store);
    run(store, "track.move", { timeline: "main", track: "track_music" });
    const batch = changesOf(base, (files) =>
      editJson(files, MAIN, (document) => move(document, "track_captions", 0)),
    );
    const result = merged(mergeFiles(store, batch, { origin: FOLDER }));
    expect(tracks(store)).toEqual([
      "track_video",
      "track_overlay",
      "track_voice",
      "track_captions",
      "track_music",
    ]);
    // What the folder had is its order, by ids.
    expect(result.conflicts).toEqual([
      {
        file: MAIN,
        path: ["timelines", "main", "tracks"],
        theirs: ["track_captions", "track_video", "track_overlay", "track_voice", "track_music"],
      },
    ]);
    expect(result.problems.map(({ message }) => message)).toEqual([
      "时间轴“主线”的轨道顺序在编辑器和文件里都改了，保留了编辑器里的",
    ]);
  });

  it("puts what the folder added where it is there, keeping the editor's numbers", () => {
    const store = open();
    run(store, "track.move", { timeline: "main", track: "track_music", before: "track_video" });
    const base = written(store);
    const numbers = Object.fromEntries(
      Object.values(main(store).tracks).map(({ id, order }) => [id, order]),
    );
    const batch = changesOf(base, (files) =>
      editJson(files, MAIN, (document) => {
        document.tracks.splice(2, 0, { id: "track_new", kind: "audio", clips: [] });
        document.sections.splice(1, 0, { id: "section_new", duration: "3" });
      }),
    );
    const result = merged(mergeFiles(store, batch, { origin: FOLDER }));
    expect(tracks(store)).toEqual([
      "track_music",
      "track_video",
      "track_new",
      "track_overlay",
      "track_voice",
      "track_captions",
    ]);
    expect(sections(store)).toEqual([
      "section_intro",
      "section_new",
      "section_body",
      "section_end",
    ]);
    for (const [id, order] of Object.entries(numbers)) {
      expect(main(store).tracks[id]?.order, id).toBe(order);
    }
    expect(statusOf(result, MAIN)?.rewrite).toBe(false);
  });
});

describe("more of what the folder can change", () => {
  it("leaves a library that a locked track uses, and takes in the rest of the list", () => {
    const store = open();
    run(store, "track.update", {
      timeline: "main",
      track: "track_video",
      changes: { locked: true },
    });
    const batch = changesOf(written(store), (files) =>
      editJson(files, "libraries.json", (document) => {
        document.libraries[0].priority = 5;
        document.libraries[1].followLatest = false;
      }),
    );
    const result = merged(mergeFiles(store, batch, { origin: FOLDER }));
    const libraries = store.getState().libraries?.libraries ?? [];
    expect(libraries.find(({ id }) => id === "lib_7f3a")?.priority).toBe(1);
    expect(libraries.find(({ id }) => id === "lib_91c0")?.followLatest).toBe(false);
    expect(result.problems.map(({ message }) => message)).toEqual([
      "库“lib_7f3a”在锁定的轨道上使用，文件里对它的改动没有生效",
    ]);
    expect(result.files[0]).toMatchObject({ status: "merged", rewrite: true });
  });

  it("leaves the entry of a scene that stays, until people decide", () => {
    const store = open();
    const batch = changesOf(written(store), (files) => files.delete(TITLE_PAGE));
    const result = merged(mergeFiles(store, batch, { origin: FOLDER }));
    expect(store.getState().files[TITLE_PAGE]).toBeDefined();
    expect(result.files[0]).toMatchObject({ status: "blocked" });
    expect(result.held).toEqual([["files", TITLE_PAGE]]);
  });

  it("leaves a sound that is still in use, with its code", () => {
    const store = open();
    const batch = changesOf(written(store), (files) => {
      for (const path of files.keys()) if (path.startsWith("sounds/impacts/")) files.delete(path);
    });
    const result = merged(mergeFiles(store, batch, { origin: FOLDER }));
    expect(store.getState().sounds["impacts"]).toBeDefined();
    expect(store.getState().files["sounds/impacts/main.js"]).toBeDefined();
    expect(result.files.map(({ status }) => status)).toEqual(["blocked", "blocked"]);
  });

  it("keeps the editor's code where both made the same new file differently", () => {
    const store = open();
    run(store, "file.write", { path: "code/new.js", text: "// 编辑器\n" });
    const result = merged(
      mergeFiles(store, [{ path: "code/new.js", base: undefined, text: "// 外面\n" }], {
        origin: FOLDER,
      }),
    );
    expect(store.getState().files["code/new.js"]).toBe("// 编辑器\n");
    expect(result.conflicts).toEqual([
      { file: "code/new.js", path: ["files", "code/new.js"], theirs: "// 外面\n" },
    ]);
    expect(result.problems.map(({ message }) => message)).toEqual([
      "文件 code/new.js 在编辑器和文件里都改了，保留了编辑器里的",
    ]);
    const same = merged(
      mergeFiles(store, [{ path: "code/new.js", base: undefined, text: "// 编辑器\n" }], {
        origin: FOLDER,
      }),
    );
    expect(same.conflicts).toEqual([]);
    expect(same.files[0]).toMatchObject({ status: "merged", rewrite: false });
  });

  it("merges notes one at a time", () => {
    const store = open();
    const base = written(store);
    const note = (document: any, id: string) => ({ ...document.notes[0], id, text: id });
    const mine = changesOf(base, (files) =>
      editJson(files, "notes.json", (document) => {
        document.notes.push(note(document, "note_mine"));
      }),
    );
    success(store.importFile("notes.json", mine[0]?.text as string, { origin: USER }));
    const batch = changesOf(base, (files) =>
      editJson(files, "notes.json", (document) => {
        document.notes[0].text = "外面改的";
        document.notes.push(note(document, "note_theirs"));
      }),
    );
    const result = merged(mergeFiles(store, batch, { origin: FOLDER }));
    const notes = store.getState().notes ?? {};
    expect(Object.keys(notes).toSorted()).toEqual(["note_1", "note_mine", "note_theirs"]);
    expect(notes["note_1"]?.text).toBe("外面改的");
    expect(result.conflicts).toEqual([]);
  });

  it("does not count a change both sides made as a conflict", () => {
    const store = open();
    const base = written(store);
    run(store, "clip.remove", { timeline: "main", clips: ["clip_logo"] });
    run(store, "file.write", { path: CODE, text: "// 一样的\n" });
    const batch = changesOf(base, (files) => {
      editJson(files, MAIN, (document) => {
        const track = trackIn(document, "track_video");
        track.clips = track.clips.filter(({ id }: any) => id !== "clip_logo");
        track.joins = track.joins.filter(
          ({ from, to }: any) => from !== "clip_logo" && to !== "clip_logo",
        );
      });
      files.set(CODE, "// 一样的\n");
    });
    const result = merged(mergeFiles(store, batch, { origin: FOLDER }));
    expect(result.conflicts).toEqual([]);
    expect(result.patches).toEqual([]);
    expect(result.files.map(({ rewrite }) => rewrite)).toEqual([false, false]);
  });
});

describe("what the folder points at, that the editor just took away", () => {
  const RAW = { kind: "video", media: { asset: "raw-footage" } };
  const addClip = (document: any, id: string, source: object) =>
    trackIn(document, "track_video").clips.push({ id, start: "40", duration: "1", source });
  const keptMine = (path: string, message: string) => ({
    severity: "warning",
    code: "uses-removed",
    file: MAIN,
    path,
    message,
  });

  it("keeps the editor's side of that link, and takes in the rest of the file", () => {
    const store = open();
    const base = written(store);
    run(store, "asset.remove", { asset: "raw-footage" });
    const batch = changesOf(base, (files) => {
      editJson(files, MAIN, (document) => {
        addClip(document, "clip_raw", RAW);
        document.name = "外面改的名字";
      });
      files.set(CODE, "// 外面改的\n");
    });
    const result = merged(mergeFiles(store, batch, { origin: FOLDER }));
    expect(clip(store, "clip_raw")).toBeUndefined();
    expect(main(store).name).toBe("外面改的名字");
    expect(store.getState().assets?.["raw-footage"]).toBeUndefined();
    expect(store.getState().files[CODE]).toBe("// 外面改的\n");
    expect(statusOf(result, MAIN)).toMatchObject({ status: "merged", rewrite: true });
    expect(result.conflicts).toEqual([
      {
        file: MAIN,
        path: ["timelines", "main", "clips", "clip_raw"],
        theirs: { id: "clip_raw", start: "40", duration: "1", source: RAW, track: "track_video" },
      },
    ]);
    expect(result.problems).toEqual([
      keptMine(
        "clip_raw",
        "片段“clip_raw”用到了素材“raw-footage”，编辑器里刚把它删掉，还没写进文件夹，保留了编辑器里的",
      ),
    ]);
    expect(store.exportFiles().problems).toEqual([]);
  });

  it("keeps the editor's source of a clip it has, and takes in the rest of the clip", () => {
    const store = open();
    const base = written(store);
    const source = clip(store, "clip_interview")?.source;
    run(store, "asset.remove", { asset: "raw-footage" });
    const batch = changesOf(base, (files) =>
      editJson(files, MAIN, (document) => {
        clipIn(document, "clip_interview").source = RAW;
        clipIn(document, "clip_interview").name = "外面改的采访";
      }),
    );
    const result = merged(mergeFiles(store, batch, { origin: FOLDER }));
    expect(clip(store, "clip_interview")?.source).toEqual(source);
    expect(clip(store, "clip_interview")?.name).toBe("外面改的采访");
    expect(result.conflicts.map(({ path }) => path)).toEqual([
      ["timelines", "main", "clips", "clip_interview"],
    ]);
    expect(result.problems.map(({ code }) => code)).toEqual(["uses-removed"]);
    expect(store.exportFiles().problems).toEqual([]);
  });

  it("keeps the editor's side of each thing a clip points at, which the editor took away", () => {
    const store = open();
    run(store, "track.add", { timeline: "main", id: "track_spare", kind: "video" });
    const base = written(store);
    const before = clip(store, "clip_interview");
    run(store, "asset.remove", { asset: "raw-footage" });
    run(store, "track.remove", { timeline: "main", track: "track_spare" });
    const batch = changesOf(base, (files) =>
      editJson(files, MAIN, (document) => {
        const interview = clipIn(document, "clip_interview");
        interview.source = RAW;
        interview.name = "外面改的采访";
        trackIn(document, "track_video").clips = trackIn(document, "track_video").clips.filter(
          (each: any) => each !== interview,
        );
        trackIn(document, "track_spare").clips.push(interview);
        for (const track of document.tracks) {
          if (!track.joins) continue;
          track.joins = track.joins.filter(
            ({ from, to }: any) => from !== "clip_interview" && to !== "clip_interview",
          );
          if (track.joins.length === 0) delete track.joins;
        }
      }),
    );
    const result = merged(mergeFiles(store, batch, { origin: FOLDER }));
    expect(clip(store, "clip_interview")).toMatchObject({
      source: before?.source,
      track: before?.track,
      name: "外面改的采访",
    });
    expect(result.conflicts.map(({ path }) => path)).toEqual([
      ["timelines", "main", "clips", "clip_interview"],
    ]);
    expect(result.problems.filter(({ code }) => code === "uses-removed")).toHaveLength(2);
    expect(store.exportFiles().problems).toEqual([]);
  });

  it("goes by what the folder has outside the batch, so a scene the editor took away counts too", () => {
    const store = open();
    run(store, "scene.add", {
      id: "spare",
      scene: { name: "备用场景", entry: "index.html", runtime: 1 },
      files: { "index.html": "<p>x</p>" },
    });
    const base = written(store);
    run(store, "scene.remove", { scene: "spare" });
    const batch = changesOf(base, (files) =>
      editJson(files, MAIN, (document) =>
        addClip(document, "clip_spare", { kind: "scene", scene: "spare" }),
      ),
    );
    const result = merged(mergeFiles(store, batch, { origin: FOLDER }));
    expect(clip(store, "clip_spare")).toBeUndefined();
    expect(result.files).toEqual([
      { path: MAIN, status: "merged", base: batch[0]?.text, rewrite: true },
    ]);
    expect(result.problems.map(({ code }) => code)).toEqual(["uses-removed"]);
    // What the folder says it has decides: without the scene there, the clip is the folder's doing.
    const without = merged(
      store.mergeFiles(batch, {
        origin: FOLDER,
        baseOf: (path) => (path.startsWith("scenes/spare/") ? undefined : base.get(path)),
      }),
    );
    expect(clip(store, "clip_spare")).toBeDefined();
    expect(without.files[0]).toMatchObject({ status: "merged" });
  });

  it("keeps the editor's side also when what is pointed at is in the same file", () => {
    const store = open();
    const base = written(store);
    run(store, "clip.remove", { timeline: "main", clips: ["clip_logo"] });
    const batch = changesOf(base, (files) => {
      editJson(files, MAIN, (document) => {
        document.name = "AI 改的名字";
        clipIn(document, "clip_title").name = "AI 改的标题";
        trackIn(document, "track_video").joins.push({
          id: "join_new",
          from: "clip_interview",
          to: "clip_logo",
          type: "fade",
          duration: "0.5",
        });
      });
      editJson(files, "assets.json", (document) => {
        document.assets.logo.credit = "别人";
      });
    });
    const result = merged(mergeFiles(store, batch, { origin: FOLDER }));
    expect(main(store).joins?.["join_new"]).toBeUndefined();
    expect(main(store).name).toBe("AI 改的名字");
    expect(clip(store)?.name).toBe("AI 改的标题");
    expect(store.getState().assets?.["logo"]?.credit).toBe("别人");
    expect(statusOf(result, MAIN)).toMatchObject({ status: "merged", rewrite: true });
    expect(result.conflicts).toEqual([
      {
        file: MAIN,
        path: ["timelines", "main", "joins", "join_new"],
        theirs: {
          track: "track_video",
          from: "clip_interview",
          to: "clip_logo",
          transition: { type: "fade", duration: "0.5" },
        },
      },
    ]);
    expect(result.problems).toEqual([
      keptMine(
        "join_new",
        "衔接转场“join_new”用到了片段“clip_logo”，编辑器里刚把它删掉，还没写进文件夹，保留了编辑器里的",
      ),
    ]);
  });

  it("leaves the file waiting when what it points at is in a file of the batch that cannot be read", () => {
    const store = open();
    const base = written(store);
    const batch = changesOf(base, (files) => {
      files.set("scenes/fresh/scene.json", "{oops");
      files.set("scenes/fresh/index.html", "<p>新</p>");
      editJson(files, MAIN, (document) =>
        addClip(document, "clip_fresh", { kind: "scene", scene: "fresh" }),
      );
    });
    const result = merged(mergeFiles(store, batch, { origin: FOLDER }));
    expect(clip(store, "clip_fresh")).toBeUndefined();
    expect(statusOf(result, MAIN)).toEqual({
      path: MAIN,
      status: "blocked",
      base: base.get(MAIN),
      rewrite: false,
    });
    expect(result.problems.find(({ file }) => file === MAIN)).toEqual({
      severity: "warning",
      code: "needs-file",
      file: MAIN,
      path: "clip_fresh",
      message:
        "片段“clip_fresh”用到了场景“fresh”，它的文件 scenes/fresh/scene.json 读不懂，这个文件先不并入",
    });
  });

  it("counts what could be in the folder as there, for code that does not say what the folder has", () => {
    const store = open();
    const base = written(store);
    run(store, "asset.remove", { asset: "raw-footage" });
    const batch = changesOf(base, (files) =>
      editJson(files, MAIN, (document) => {
        addClip(document, "clip_raw", RAW);
        document.name = "外面改的名字";
      }),
    );
    const result = merged(store.mergeFiles(batch, { origin: FOLDER } as MergeOptions));
    expect(clip(store, "clip_raw")).toBeUndefined();
    expect(main(store).name).toBe("外面改的名字");
    expect(statusOf(result, MAIN)).toMatchObject({ status: "merged", rewrite: true });
    expect(result.problems.map(({ code }) => code)).toEqual(["uses-removed"]);
  });

  it("takes in what points at something the folder does not have either", () => {
    const store = open();
    const base = written(store);
    const batch = changesOf(base, (files) =>
      editJson(files, MAIN, (document) =>
        addClip(document, "clip_nowhere", { kind: "video", media: { asset: "nowhere" } }),
      ),
    );
    const result = merged(mergeFiles(store, batch, { origin: FOLDER }));
    expect(clip(store, "clip_nowhere")).toBeDefined();
    expect(result.files[0]).toMatchObject({ status: "merged", rewrite: false });
  });

  it("keeps the editor's fonts when the folder starts to use an asset the editor took away", () => {
    const store = open();
    const base = written(store);
    run(store, "asset.remove", { asset: "raw-footage" });
    const batch = changesOf(base, (files) =>
      editJson(files, "animaquill.json", (document) => {
        document.fonts = [...document.fonts, { family: "别的字体", asset: "raw-footage" }];
        document.name = "外面改的项目名";
      }),
    );
    const result = merged(mergeFiles(store, batch, { origin: FOLDER }));
    expect(store.getState().manifest.fonts).toEqual([
      { family: "思源黑体", asset: "font-sans", weight: 700 },
    ]);
    expect(store.getState().manifest.name).toBe("外面改的项目名");
    expect(result.conflicts.map(({ path }) => path)).toEqual([["manifest", "fonts"]]);
  });

  it("leaves code waiting that starts to use an asset whose file in the batch cannot be read", () => {
    const store = open();
    const base = written(store);
    run(store, "asset.remove", { asset: "raw-footage" });
    const batch = changesOf(base, (files) => {
      files.set("assets.json", "{oops");
      files.set(CODE, `${files.get(CODE)}const raw = aq.asset("raw-footage");\n`);
    });
    const result = merged(mergeFiles(store, batch, { origin: FOLDER }));
    expect(store.getState().files[CODE]).toBe(base.get(CODE));
    expect(statusOf(result, CODE)).toMatchObject({ status: "blocked", base: base.get(CODE) });
    expect(result.problems.find(({ file }) => file === CODE)).toMatchObject({
      code: "needs-file",
      message: "代码里新用到了素材“raw-footage”，它的文件 assets.json 读不懂，这个文件先不并入",
    });
  });

  it("leaves code waiting that starts to use an asset the editor took away", () => {
    const store = open();
    const base = written(store);
    run(store, "asset.remove", { asset: "raw-footage" });
    const batch = changesOf(base, (files) => {
      files.set(CODE, `${files.get(CODE)}const raw = aq.asset("raw-footage");\n`);
      files.set("code/other.js", "export const x = 1;\n");
    });
    const result = merged(mergeFiles(store, batch, { origin: FOLDER }));
    expect(store.getState().files[CODE]).toBe(base.get(CODE));
    expect(store.getState().files["code/other.js"]).toBe("export const x = 1;\n");
    expect(statusOf(result, CODE)).toMatchObject({ status: "blocked", base: base.get(CODE) });
    expect(result.problems.find(({ file }) => file === CODE)?.message).toBe(
      "代码里新用到了素材“raw-footage”，编辑器里刚把它删掉，还没写进文件夹，这个文件先不并入",
    );
  });
});

describe("transitions", () => {
  const JOIN = "join_1";
  const joinIn = (document: any, id: string) =>
    document.tracks.flatMap((track: any) => track.joins ?? []).find((join: any) => join.id === id);
  const join = (store: ProjectStore, id = JOIN) => main(store).joins?.[id];

  it("merge what comes in and goes out of a clip like any other field of it", () => {
    const store = open();
    const base = written(store);
    run(store, "clip.setTransition", {
      timeline: "main",
      clip: "clip_title",
      enter: { type: "fade", duration: "1" },
    });
    const batch = changesOf(base, (files) =>
      editJson(files, MAIN, (document) => {
        clipIn(document, "clip_title").enter = { type: "fade", duration: "2" };
        clipIn(document, "clip_title").name = "新标题";
        clipIn(document, "clip_card").exit = { type: "fade", duration: "0.5" };
      }),
    );
    const result = merged(mergeFiles(store, batch, { origin: FOLDER }));
    expect(clip(store)?.enter).toEqual({ type: "fade", duration: "1" });
    expect(clip(store)?.name).toBe("新标题");
    expect(clip(store, "clip_card")?.exit).toEqual({ type: "fade", duration: "0.5" });
    expect(result.conflicts).toEqual([
      {
        file: MAIN,
        path: ["timelines", "main", "clips", "clip_title", "enter"],
        theirs: { type: "fade", duration: "2" },
      },
    ]);
  });

  it("leave a join out that a move of the editor took away, where the folder changed it", () => {
    const store = open();
    const base = written(store);
    const moved = run(store, "clip.move", {
      timeline: "main",
      clips: [{ clip: "clip_interview", start: "40" }],
      overlap: "overwrite",
    });
    expect(moved.results).toEqual([{ joinsRemoved: [JOIN] }]);
    const batch = changesOf(base, (files) =>
      editJson(files, MAIN, (document) => {
        const changed = trackIn(document, "track_video").joins.find(({ id }: any) => id === JOIN);
        changed.duration = "2";
        document.name = "外面改的名字";
      }),
    );
    const result = merged(mergeFiles(store, batch, { origin: FOLDER }));
    expect(main(store).joins?.[JOIN]).toBeUndefined();
    expect(clip(store, "clip_interview")?.start).toBe("40");
    expect(main(store).name).toBe("外面改的名字");
    expect(result.conflicts.map(({ path, theirs }) => [path.join("/"), theirs])).toEqual([
      [
        `timelines/main/joins/${JOIN}`,
        {
          track: "track_video",
          from: "clip_title",
          to: "clip_interview",
          transition: { type: "fade", duration: "2" },
        },
      ],
    ]);
  });

  it("leave a join of the editor as it is, doing nothing, when the folder moves its clips apart", () => {
    const store = open();
    const base = written(store);
    run(store, "join.add", {
      timeline: "main",
      id: "join_new",
      from: "clip_interview",
      to: "clip_logo",
      type: "fade",
      duration: "0.5",
    });
    const batch = changesOf(base, (files) =>
      editJson(files, MAIN, (document) => {
        clipIn(document, "clip_logo").start = "60";
      }),
    );
    const result = merged(mergeFiles(store, batch, { origin: FOLDER }));
    // Like a join that a file leaves between clips that are apart, see `followJoins`.
    expect(main(store).joins?.["join_new"]).toMatchObject({
      from: "clip_interview",
      to: "clip_logo",
    });
    expect(clip(store, "clip_logo")?.start).toBe("60");
    expect(result.conflicts).toEqual([]);
    expect(statusOf(result, MAIN)).toMatchObject({ status: "merged", rewrite: true });
    const { files } = store.exportFiles();
    const errors = ProjectStore.open(files).problems.filter(({ severity }) => severity === "error");
    expect(errors).toEqual([]);
  });

  it("merge a join one field at a time, and keep the editor's whole when the folder took it away", () => {
    const store = open();
    const base = written(store);
    const mine = changesOf(base, (files) =>
      editJson(files, MAIN, (document) => {
        joinIn(document, JOIN).duration = "2";
      }),
    );
    success(store.importFile(MAIN, mine[0]?.text as string, { origin: USER }));
    const moved = changesOf(base, (files) =>
      editJson(files, MAIN, (document) => {
        joinIn(document, "join_2").align = "after";
      }),
    );
    merged(mergeFiles(store, moved, { origin: FOLDER }));
    expect(join(store, "join_2")?.transition).toMatchObject({ align: "after" });
    expect(join(store)?.transition).toMatchObject({ duration: "2" });
    const gone = changesOf(base, (files) =>
      editJson(files, MAIN, (document) => {
        const track = trackIn(document, "track_video");
        track.joins = track.joins.filter(({ id }: any) => id !== JOIN);
      }),
    );
    const result = merged(mergeFiles(store, gone, { origin: FOLDER }));
    expect(join(store)).toMatchObject({ from: "clip_title", to: "clip_interview" });
    expect(result.conflicts).toEqual([{ file: MAIN, path: ["timelines", "main", "joins", JOIN] }]);
    expect(result.problems.map(({ message }) => message)).toEqual([
      "衔接转场“join_1”在编辑器和文件里都改了，保留了编辑器里的",
    ]);
    expect(store.exportFiles().problems).toEqual([]);
  });

  it("leave a join on a locked track as a whole, also a new one", () => {
    const store = open();
    run(store, "track.update", {
      timeline: "main",
      track: "track_video",
      changes: { locked: true },
    });
    const before = main(store).joins;
    const batch = changesOf(written(store), (files) =>
      editJson(files, MAIN, (document) => {
        joinIn(document, JOIN).duration = "2";
        trackIn(document, "track_video").joins.push({
          id: "join_new",
          from: "clip_interview",
          to: "clip_logo",
          type: "fade",
          duration: "0.5",
        });
        document.name = "改名的主线";
      }),
    );
    const result = merged(mergeFiles(store, batch, { origin: FOLDER }));
    expect(main(store).joins).toEqual(before);
    expect(main(store).name).toBe("改名的主线");
    expect(result.problems.map(({ message }) => message)).toEqual([
      "轨道“画面”已锁定，文件里对衔接转场“join_1”的改动没有生效",
      "轨道“画面”已锁定，文件里对衔接转场“join_new”的改动没有生效",
    ]);
    expect(result.files[0]).toMatchObject({ status: "merged", rewrite: true });
  });

  it("take in a timeline file with the old fades without them, and say so", () => {
    const store = open();
    const batch = changesOf(written(store), (files) =>
      editJson(files, MAIN, (document) => {
        clipIn(document, "clip_title").fadeOut = "0.5";
        clipIn(document, "clip_title").name = "新标题";
      }),
    );
    const result = merged(mergeFiles(store, batch, { origin: FOLDER }));
    expect(clip(store)?.name).toBe("新标题");
    expect(clip(store)).not.toHaveProperty("fadeOut");
    expect(result.problems).toEqual([
      {
        severity: "warning",
        code: "fades-retired",
        file: MAIN,
        path: "tracks.0.clips.0.fadeOut",
        message: "旧的淡入淡出写法已不支持，被忽略",
      },
    ]);
  });
});

describe("a new timeline", () => {
  const COPY = "timelines/copy/timeline.json";
  const COPY_VERTICAL = "timelines/copy/overrides/format.vertical.json";
  /** A copy of the main timeline, with a clip of what is given, listed in the manifest or not. */
  const copied = (files: Files, source: object, listed: boolean) => {
    const copy = JSON.parse(files.get(MAIN) as string);
    copy.name = "副本";
    trackIn(copy, "track_video").clips.push({ id: "clip_new", start: "40", duration: "1", source });
    files.set(COPY, JSON.stringify(copy, null, 2));
    if (listed) {
      editJson(files, "animaquill.json", (document) => {
        document.timelines.push("copy");
      });
    }
  };

  it("comes in with its versions, and the manifest lists it", () => {
    const store = open();
    const batch = changesOf(written(store), (files) => {
      copied(files, { kind: "color", color: "#222222" }, true);
      files.set(COPY_VERTICAL, JSON.stringify({ scope: { format: "vertical" } }));
    });
    const result = merged(mergeFiles(store, batch, { origin: FOLDER }));
    expect(store.getState().timelines["copy"]?.name).toBe("副本");
    expect(store.getState().manifest.timelines).toEqual(["main", "highlight", "copy"]);
    expect(result.files.every(({ status }) => status === "merged")).toBe(true);
  });

  it("waits with its versions and with the manifest while its file cannot be read", () => {
    const store = open();
    const base = written(store);
    const before = store.getState();
    const batch = changesOf(base, (files) => {
      files.set(COPY, JSON.stringify({ name: 5 }));
      files.set(COPY_VERTICAL, JSON.stringify({ scope: { format: "vertical" } }));
      editJson(files, "animaquill.json", (document) => {
        document.timelines.push("copy");
      });
    });
    const result = merged(mergeFiles(store, batch, { origin: FOLDER }));
    expect(store.getState()).toBe(before);
    expect(result.files.map(({ path, status }) => [path, status])).toEqual([
      ["animaquill.json", "blocked"],
      [COPY, "blocked"],
      [COPY_VERTICAL, "blocked"],
    ]);
    expect(result.problems.find(({ file }) => file === "animaquill.json")).toMatchObject({
      code: "merge-would-break",
      message: "清单里列着时间轴“copy”，项目里却没有它，这个文件先不并入",
    });
    const { files } = store.exportFiles();
    const errors = ProjectStore.open(files).problems.filter(({ severity }) => severity === "error");
    expect(errors).toEqual([]);
  });

  it("waits with the versions of a timeline the project has, while its file cannot be read", () => {
    const store = open();
    const base = written(store);
    const version = main(store).overrides["format.vertical"];
    const batch = changesOf(base, (files) => {
      files.set(MAIN, "{oops");
      editJson(files, VERTICAL, (document) => {
        document.clips = { ...document.clips, clip_logo: { hidden: { value: true } } };
      });
      editJson(files, "assets.json", (document) => {
        document.assets.logo.credit = "别人";
      });
    });
    const result = merged(mergeFiles(store, batch, { origin: FOLDER }));
    expect(main(store).overrides["format.vertical"]).toEqual(version);
    expect(statusOf(result, VERTICAL)).toMatchObject({
      status: "blocked",
      base: base.get(VERTICAL),
    });
    expect(result.problems.find(({ file }) => file === VERTICAL)?.code).toBe("waits-with-timeline");
    expect(store.getState().assets?.["logo"]?.credit).toBe("别人");
  });

  it("waits with its versions when its file has to, and nothing goes wrong on the way", () => {
    const store = open();
    run(store, "scene.add", {
      id: "spare",
      scene: { name: "备用场景", entry: "index.html", runtime: 1 },
      files: { "index.html": "<p>x</p>" },
    });
    const base = written(store);
    run(store, "scene.remove", { scene: "spare" });
    const batch = changesOf(base, (files) => {
      copied(files, { kind: "scene", scene: "spare" }, true);
      files.set(COPY_VERTICAL, JSON.stringify({ scope: { format: "vertical" } }));
      files.set(CODE, "// 外面改的\n");
    });
    // The clip of the scene the editor took away is the editor's to keep out: the rest comes in.
    const result = merged(mergeFiles(store, batch, { origin: FOLDER }));
    expect(store.getState().timelines["copy"]?.clips["clip_new"]).toBeUndefined();
    expect(store.getState().timelines["copy"]?.overrides["format.vertical"]).toBeDefined();
    expect(store.getState().manifest.timelines).toContain("copy");
    expect(store.getState().files[CODE]).toBe("// 外面改的\n");
    expect(result.files.map(({ status }) => status)).toEqual([
      "merged",
      "merged",
      "merged",
      "merged",
    ]);
  });

  it("keeps a timeline the editor changed in the manifest, when the folder took both away", () => {
    const store = open();
    const base = written(store);
    run(store, "timeline.rename", { timeline: "highlight", name: "编辑器改的" });
    const batch = changesOf(base, (files) => {
      files.delete("timelines/highlight/timeline.json");
      editJson(files, "animaquill.json", (document) => {
        document.timelines = ["main"];
        document.name = "外面改的项目名";
      });
    });
    const result = merged(mergeFiles(store, batch, { origin: FOLDER }));
    expect(store.getState().timelines["highlight"]?.name).toBe("编辑器改的");
    expect(store.getState().manifest.timelines).toEqual(["main", "highlight"]);
    expect(store.getState().manifest.name).toBe("外面改的项目名");
    expect(statusOf(result, "animaquill.json")).toMatchObject({ status: "merged", rewrite: true });
  });

  it("leaves a version waiting whose name says another scope, and takes in the rest", () => {
    const store = open();
    const base = written(store);
    const SQUARE = "timelines/main/overrides/format.square.json";
    const batch = changesOf(base, (files) => {
      const version = {
        scope: { format: "vertical" },
        clips: { clip_title: { hidden: { value: true } } },
      };
      files.set(SQUARE, JSON.stringify(version));
      editJson(files, "animaquill.json", (document) => {
        document.name = "外面改的项目名";
      });
    });
    const result = merged(mergeFiles(store, batch, { origin: FOLDER }));
    expect(main(store).overrides["format.square"]).toBeUndefined();
    expect(store.getState().manifest.name).toBe("外面改的项目名");
    expect(statusOf(result, SQUARE)).toMatchObject({ status: "blocked", base: undefined });
    expect(result.problems.find(({ file }) => file === SQUARE)).toMatchObject({
      code: "merge-would-break",
      message: "这个范围的文件名应该是 format.vertical.json，这个文件先不并入",
    });
    const { files } = store.exportFiles();
    const errors = ProjectStore.open(files).problems.filter(({ severity }) => severity === "error");
    expect(errors).toEqual([]);
  });

  it("does not come in when it would put a timeline inside itself", () => {
    const store = open();
    const base = written(store);
    run(store, "clip.update", {
      timeline: "highlight",
      clip: "clip_nested",
      changes: { name: "编辑器改的" },
    });
    const batch = changesOf(base, (files) => {
      editJson(files, "timelines/highlight/timeline.json", (document) => {
        document.tracks[0].clips = [];
      });
      editJson(files, MAIN, (document) =>
        trackIn(document, "track_video").clips.push({
          id: "clip_inner",
          start: "40",
          duration: "1",
          source: { kind: "timeline", timeline: "highlight" },
        }),
      );
    });
    const result = merged(mergeFiles(store, batch, { origin: FOLDER }));
    const nested = (id: string) =>
      Object.values(store.getState().timelines[id]?.clips ?? {}).some(
        ({ source }) => source.kind === "timeline",
      );
    expect(nested("main") && nested("highlight")).toBe(false);
    expect(result.problems.some(({ code }) => code === "merge-would-break")).toBe(true);
    const { files } = store.exportFiles();
    expect(
      ProjectStore.open(files).problems.filter(({ severity }) => severity === "error"),
    ).toEqual([]);
  });
});

describe("what a merge remembers", () => {
  it("comes out the same whether the editor wrote the base or only read it", () => {
    const editorChange = (store: ProjectStore) =>
      run(store, "clip.update", {
        timeline: "main",
        clip: "clip_logo",
        changes: { name: "编辑器改的" },
      });
    // The editor wrote these, so it knows what they mean without reading them.
    const writer = open();
    const base = written(writer);
    editorChange(writer);
    const batch = changesOf(base, (files) => {
      editJson(files, MAIN, (document) => {
        clipIn(document, "clip_title").name = "外面改的";
        clipIn(document, "clip_logo").name = "外面也改了";
      });
      editJson(files, VERTICAL, (document) => {
        document.clips = { ...document.clips, clip_logo: { hidden: { value: true } } };
      });
      editJson(files, "assets.json", (document) => {
        document.assets.logo.credit = "别人";
      });
    });
    const remembered = merged(mergeFiles(writer, batch, { origin: FOLDER }));
    // This one only read them.
    const reader = ProjectStore.open(base).store as ProjectStore;
    editorChange(reader);
    const read = merged(mergeFiles(reader, batch, { origin: FOLDER }));
    expect(writer.getState()).toEqual(reader.getState());
    const { files, problems, conflicts, kept, held, patches } = read;
    expect(remembered).toMatchObject({ files, problems, conflicts, kept, held, patches });
    expect(conflicts.map(({ path }) => path.join("/"))).toEqual([
      "timelines/main/clips/clip_logo/name",
    ]);
  });
});

describe("when the merge itself goes wrong", () => {
  it("brings nothing in, says so, and leaves the project as it was", () => {
    const store = open();
    const base = written(store);
    run(store, "asset.remove", { asset: "raw-footage" });
    const before = store.getState();
    const batch = changesOf(base, (files) =>
      editJson(files, MAIN, (document) =>
        trackIn(document, "track_video").clips.push({
          id: "clip_raw",
          start: "40",
          duration: "1",
          source: { kind: "video", media: { asset: "raw-footage" } },
        }),
      ),
    );
    const result = refused(
      store.mergeFiles(batch, {
        origin: FOLDER,
        baseOf: () => {
          throw new Error("读不到基准");
        },
      }),
    );
    expect(result.error).toMatchObject({ code: "merge-failed" });
    expect(store.getState()).toBe(before);
    expect(result.files.map(({ status, base: kept }) => [status, kept])).toEqual([
      ["blocked", base.get(MAIN)],
    ]);
  });
});

describe("taking batches back", () => {
  it("goes for the last 20 of them", () => {
    const store = open();
    let folder = written(store);
    for (let index = 0; index < 25; index++) {
      const batch = changesOf(folder, (files) => files.set(CODE, `// ${index}\n`));
      merged(mergeFiles(store, batch, { origin: folderBatch(`b${index}`) }));
      folder = written(store);
    }
    const codes = Array.from({ length: 25 }, (_, index) => {
      const result = store.undoOrigin(folderBatch(`b${index}`));
      return result.ok ? "ok" : result.error.code;
    });
    expect(codes.slice(0, 5)).toEqual(Array(5).fill("nothing-to-undo"));
    expect(codes.slice(5).every((code) => code !== "nothing-to-undo")).toBe(true);
  });
});

describe("what conflicts say about the folder's side", () => {
  it("is the folder's value, or its lines, or its whole file", () => {
    const store = open();
    run(store, "file.write", { path: CODE, text: "a\nb\nc\nd\n" });
    run(store, "file.write", { path: "code/gone.js", text: "x\n" });
    const base = written(store);
    setProperty(store, "param.size", 80);
    run(store, "file.write", { path: CODE, text: "a\nB mine\nc\nd\n" });
    run(store, "file.write", { path: "code/gone.js", text: "x mine\n" });
    const batch = changesOf(base, (files) => {
      editJson(files, MAIN, (document) => {
        clipIn(document, "clip_title").properties["param.size"] = 50;
      });
      files.set(CODE, "a\nB theirs\nc\nD\n");
      files.delete("code/gone.js");
    });
    const result = merged(mergeFiles(store, batch, { origin: FOLDER }));
    expect(result.conflicts).toEqual([
      {
        file: MAIN,
        path: ["timelines", "main", "clips", "clip_title", "properties", "param.size"],
        theirs: 50,
      },
      { file: CODE, path: ["files", CODE], lines: { from: 1, to: 2 }, theirs: "B theirs\n" },
      { file: "code/gone.js", path: ["files", "code/gone.js"], theirs: undefined },
    ]);
    expect(store.getState().files[CODE]).toBe("a\nB mine\nc\nD\n");
  });
});

describe("fields of one value", () => {
  it("merge one at a time for an asset, a note, a scene and a sound", () => {
    const store = open();
    const base = written(store);
    const mine = changesOf(base, (files) => {
      editJson(files, "assets.json", (document) => {
        document.assets.logo.name = "编辑器起的名字";
      });
      editJson(files, "notes.json", (document) => {
        document.notes[0].text = "编辑器改的批注";
      });
    });
    for (const { path, text } of mine) {
      success(store.importFile(path, text as string, { origin: USER }));
    }
    run(store, "scene.update", { scene: "title", changes: { name: "编辑器改的标题卡" } });
    run(store, "sound.update", { sound: "impacts", changes: { name: "编辑器改的声音" } });
    const batch = changesOf(base, (files) => {
      editJson(files, "assets.json", (document) => {
        document.assets.logo.credit = "外面写的署名";
      });
      editJson(files, "notes.json", (document) => {
        document.notes[0].status = "done";
      });
      editJson(files, TITLE, (document) => {
        document.description = "外面改的说明";
      });
      editJson(files, "sounds/impacts/sound.json", (document) => {
        document.description = "外面加的说明";
      });
    });
    const result = merged(mergeFiles(store, batch, { origin: FOLDER }));
    const state = store.getState();
    expect(state.assets?.["logo"]).toMatchObject({
      name: "编辑器起的名字",
      credit: "外面写的署名",
    });
    expect(state.notes?.["note_1"]).toMatchObject({ text: "编辑器改的批注", status: "done" });
    expect(state.scenes["title"]).toMatchObject({
      name: "编辑器改的标题卡",
      description: "外面改的说明",
    });
    expect(state.sounds["impacts"]).toMatchObject({
      name: "编辑器改的声音",
      description: "外面加的说明",
    });
    expect(result.conflicts).toEqual([]);
  });

  it("conflict one at a time too", () => {
    const store = open();
    const base = written(store);
    run(store, "scene.update", { scene: "title", changes: { name: "编辑器改的" } });
    const batch = changesOf(base, (files) =>
      editJson(files, TITLE, (document) => {
        document.name = "外面改的";
        document.description = "外面改的说明";
      }),
    );
    const result = merged(mergeFiles(store, batch, { origin: FOLDER }));
    expect(store.getState().scenes["title"]).toMatchObject({
      name: "编辑器改的",
      description: "外面改的说明",
    });
    expect(result.conflicts).toEqual([
      { file: TITLE, path: ["scenes", "title", "name"], theirs: "外面改的" },
    ]);
  });
});

describe("more that has to stay", () => {
  it("keeps a library that clips use, when the folder takes it out of the list", () => {
    const store = open();
    const batch = changesOf(written(store), (files) =>
      editJson(files, "libraries.json", (document) => {
        document.libraries = document.libraries.filter(({ id }: any) => id !== "lib_7f3a");
        document.libraries[0].followLatest = false;
      }),
    );
    const result = merged(mergeFiles(store, batch, { origin: FOLDER }));
    const libraries = store.getState().libraries?.libraries ?? [];
    expect(libraries.map(({ id }) => id).toSorted()).toEqual(["lib_7f3a", "lib_91c0"]);
    expect(libraries.find(({ id }) => id === "lib_91c0")?.followLatest).toBe(false);
    expect(result.held).toEqual([["libraries", "libraries", "lib_7f3a"]]);
    expect(result.files[0]).toMatchObject({ status: "merged", rewrite: true });
  });

  it("reads documents that start with a byte order mark", () => {
    const store = open();
    const batch = changesOf(written(store), (files) =>
      editJson(files, MAIN, (document) => {
        document.name = "带 BOM 的";
      }),
    );
    const marked = batch.map((change) => ({ ...change, text: `\uFEFF${change.text}` }));
    merged(mergeFiles(store, marked, { origin: FOLDER }));
    expect(main(store).name).toBe("带 BOM 的");
  });
});
