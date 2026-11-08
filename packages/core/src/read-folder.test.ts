import {
  MANIFEST_FILE,
  createProject,
  documentSchema,
  readProject,
  stringifyDocument,
  writeProject,
} from "@animaquill/schema";
import { describe, expect, it } from "vitest";
import { loadFixture } from "../../schema/scripts/fixture.ts";
import {
  FolderRefused,
  INCOMPLETE_FILE,
  MAX_FOLDER_FILES,
  isFolderProblem,
  isToolFolder,
  readFolder,
  type FolderRefusal,
  type ReadFolderOptions,
  type ReadOnlyFolder,
  type ReadableFile,
} from "./read-folder.ts";
import { MAX_SOURCE_BYTES } from "./scene-edits.ts";

/** A file that says how large it is, and is not there to be read: as a video would be. */
interface Sized {
  readonly size: number;
  readonly content?: string;
}

type Content = string | Uint8Array<ArrayBuffer> | Sized;

const encode = (text: string) => new TextEncoder().encode(text);

/** How large a file is, and what is in it, unless it is too large to read. */
function sizeAndBytes(content: Content) {
  if (typeof content === "string") return { size: encode(content).length, bytes: encode(content) };
  if (content instanceof Uint8Array) return { size: content.length, bytes: content };
  const bytes = content.content === undefined ? undefined : encode(content.content);
  return { size: content.size, bytes };
}

/** A folder in memory, which says what was asked of it. */
function memoryFolder(contents: Iterable<readonly [string, Content]>) {
  const files = new Map(contents);
  /** Paths of files that were looked at, and of those that were read. */
  const looked: string[] = [];
  const read: string[] = [];
  const folder: ReadOnlyFolder = {
    async *list() {
      yield* files.keys();
    },
    async file(path): Promise<ReadableFile> {
      looked.push(path);
      const content = files.get(path);
      if (content === undefined) throw new Error(`No ${path}`);
      const { size, bytes } = sizeAndBytes(content);
      return {
        size,
        arrayBuffer: async () => {
          read.push(path);
          if (bytes === undefined) throw new Error(`Read as a whole: ${path}`);
          return bytes.slice().buffer;
        },
      };
    },
  };
  return { folder, looked, read };
}

/** The files of a new project, as a folder would have them, with a change to them. */
function projectFiles(change: (files: Map<string, Content>) => void = () => {}) {
  const files: Map<string, Content> = writeProject(createProject({ name: "文件夹里的项目" }));
  change(files);
  return files;
}

const read = (files: Iterable<readonly [string, Content]>, options?: ReadFolderOptions) =>
  readFolder(memoryFolder(files).folder, options);

async function refusal(files: Iterable<readonly [string, Content]>): Promise<FolderRefused> {
  const error = await read(files).catch((failure: unknown) => failure);
  if (!(error instanceof FolderRefused)) throw new Error(`Not refused: ${String(error)}`);
  return error;
}

const reasonOf = async (files: Iterable<readonly [string, Content]>): Promise<FolderRefusal> =>
  (await refusal(files)).reason;

const BROKEN = "{ oops";
const NO_TEXT = new Uint8Array([0xff, 0xfe, 0x00, 0xc3]);
const SCENE = stringifyDocument({ name: "标题", entry: "index.html", runtime: 1 });

const manifestOf = (files: Map<string, Content>) =>
  JSON.parse(files.get(MANIFEST_FILE) as string) as { timelines: string[]; formatVersion: number };

function listing(files: Map<string, Content>, ...timelines: string[]) {
  const manifest = manifestOf(files);
  manifest.timelines = timelines;
  files.set(MANIFEST_FILE, JSON.stringify(manifest));
}

describe("finding the project", () => {
  it("reads the folder itself when it is one", async () => {
    const files = projectFiles();
    const reading = await read(files);
    expect(reading.root).toBe("");
    expect(reading.files).toEqual([...files.keys()]);
    expect(reading.project.manifest.name).toBe("文件夹里的项目");
    expect(reading.lost).toEqual([]);
    expect(reading.skipped).toEqual([]);
  });

  it("reads the one project right inside of the folder, and nothing next to it", async () => {
    const inside = [...projectFiles()].map(([path, text]) => [`我的备份/${path}`, text] as const);
    const { folder, looked } = memoryFolder([
      ["说明.txt", "x"],
      ["别的/notes.json", BROKEN],
      ...inside,
    ]);
    const reading = await readFolder(folder);
    expect(reading.root).toBe("我的备份/");
    expect(reading.files).toEqual(inside.map(([path]) => path.slice("我的备份/".length)));
    expect(reading.skipped).toEqual([]);
    expect(looked.every((path) => path.startsWith("我的备份/"))).toBe(true);
  });

  it("takes the project at the top over ones inside", async () => {
    const files = projectFiles();
    files.set("旧的/animaquill.json", BROKEN);
    files.set("更旧的/animaquill.json", BROKEN);
    const reading = await read(files);
    expect(reading.root).toBe("");
    expect(reading.skipped).toEqual(["旧的/animaquill.json", "更旧的/animaquill.json"].toSorted());
  });

  it("refuses a folder without a manifest, also one that is deeper down", async () => {
    expect(await reasonOf([["a.jpg", "x"]])).toBe("not-a-project");
    expect(await reasonOf([])).toBe("not-a-project");
    const deep = [...projectFiles()].map(([path, text]) => [`a/b/${path}`, text] as const);
    expect(await reasonOf(deep)).toBe("not-a-project");
  });

  it("refuses several projects, and does not choose one", async () => {
    const files = [
      ["甲/animaquill.json", "{}"],
      ["乙/animaquill.json", "{}"],
    ] as const;
    expect(await reasonOf(files)).toBe("several-projects");
  });

  it("refuses an export that did not get to the end, wherever its mark is", async () => {
    const files = projectFiles();
    files.set(INCOMPLETE_FILE, "没有完成");
    expect(await reasonOf(files)).toBe("incomplete");
    expect(await reasonOf([[INCOMPLETE_FILE, "没有完成"]])).toBe("incomplete");
    expect(await reasonOf([[`导出/${INCOMPLETE_FILE}`, "没有完成"]])).toBe("incomplete");
    const inside = [...projectFiles()].map(([path, text]) => [`导出/${path}`, text] as const);
    expect(await reasonOf([...inside, [`导出/${INCOMPLETE_FILE}`, "没有完成"]])).toBe("incomplete");
  });

  it("leaves out what systems put in folders, without a word", async () => {
    const clutter = [
      ".DS_Store",
      "assets/Thumbs.db",
      "THUMBS.DB",
      "desktop.ini",
      "scenes/._index.html",
      "assets/video.mp4.crswap",
    ];
    const files = projectFiles((texts) => {
      for (const path of clutter) texts.set(path, "x");
    });
    const reading = await read(files);
    expect(reading.files.filter((path) => clutter.includes(path))).toEqual([]);
    expect(reading.skipped).toEqual([]);
  });

  it("leaves out what belongs to tools, at any depth, and does not count it", async () => {
    const tools = [
      ".git/config",
      ".git/objects/aa/bb",
      ".animaquill/recovered/timeline.json",
      "node_modules/a/index.js",
      "code/node_modules/b/index.js",
      "scenes/title/.git/HEAD",
      "node_modules/other/animaquill.json",
    ];
    const files = projectFiles((texts) => {
      for (const path of tools) texts.set(path, "x");
      // Files of such a name are something else: a worktree of Git has one.
      texts.set(".git", "gitdir: ../main/.git/worktrees/a");
      texts.set("node_modules.txt", "x");
    });
    const reading = await read(files);
    expect(reading.files.filter((path) => tools.includes(path))).toEqual([]);
    expect(reading.skipped).toEqual([".git", "node_modules.txt"]);
    expect(Object.keys(reading.sources)).toEqual([]);
    expect(await reasonOf([["node_modules/p/animaquill.json", "{}"]])).toBe("not-a-project");
    expect([".git", ".animaquill", "node_modules"].every(isToolFolder)).toBe(true);
    expect([".github", "git", "modules", ".animaquill2"].some(isToolFolder)).toBe(false);
  });

  it("refuses a whole disk, without going through all of it", async () => {
    let listed = 0;
    const folder: ReadOnlyFolder = {
      async *list() {
        for (let index = 0; ; index++) {
          listed += 1;
          yield `${index}.jpg`;
        }
      },
      file: () => Promise.reject(new Error("Nothing should be read")),
    };
    const error = await readFolder(folder).catch((failure: unknown) => failure);
    expect((error as FolderRefused).reason).toBe("too-many-files");
    expect(listed).toBe(MAX_FOLDER_FILES + 1);
  });

  it("takes as many files as that, without counting what it leaves out", async () => {
    const files = projectFiles();
    const room = MAX_FOLDER_FILES - files.size;
    for (let index = 0; index < room; index++) files.set(`照片/${index}.jpg`, "");
    for (let index = 0; index < 10; index++) files.set(`.git/${index}`, "");
    files.set(".DS_Store", "");
    expect((await read(files)).skipped).toHaveLength(room);
    files.set("还有一张.jpg", "");
    expect(await reasonOf(files)).toBe("too-many-files");
  });

  it("stops when asked to while looking, right away and before anything is read", async () => {
    const stop = new AbortController();
    const files = projectFiles((texts) => {
      for (let index = 0; index < 100; index++) texts.set(`照片/${index}.jpg`, "");
    });
    const { folder, looked } = memoryFolder(files);
    let listed = 0;
    const stopping: ReadOnlyFolder = {
      async *list() {
        for await (const path of folder.list()) {
          listed += 1;
          yield path;
          stop.abort(new Error("stop"));
        }
      },
      file: (path) => folder.file(path),
    };
    await expect(readFolder(stopping, { signal: stop.signal })).rejects.toThrow("stop");
    expect(listed).toBe(2);
    expect(looked).toEqual([]);
  });

  it("stops when asked to while reading, before the next file", async () => {
    const stop = new AbortController();
    const { folder, looked } = memoryFolder(projectFiles());
    const stopping: ReadOnlyFolder = {
      list: () => folder.list(),
      file: (path) => {
        stop.abort(new Error("stop"));
        return folder.file(path);
      },
    };
    await expect(readFolder(stopping, { signal: stop.signal })).rejects.toThrow("stop");
    expect(looked).toEqual([MANIFEST_FILE]);
  });

  it("says where it is: in the folder while looking, in the project while reading", async () => {
    const inside = [...projectFiles((texts) => texts.set("README.md", "说明"))].map(
      ([path, text]) => [`备份/${path}`, text] as const,
    );
    const seen: string[] = [];
    await read(inside, { onFile: (path) => seen.push(path) });
    const paths = inside.map(([path]) => path);
    const documents = paths
      .map((path) => path.slice("备份/".length))
      .filter((path) => documentSchema(path) !== undefined);
    expect(seen).toEqual([...paths, ...documents]);
  });
});

describe("reading files", () => {
  it("reads documents and code, and not what is neither", async () => {
    const asset = { kind: "video", path: "assets/a.mp4", storage: "local" };
    const { folder, looked } = memoryFolder(
      projectFiles((texts) => {
        texts.set("assets.json", stringifyDocument({ assets: { clip: asset } }));
        texts.set("assets/a.mp4", { size: 4 * 1024 ** 3 });
        texts.set("assets/unused.mp4", { size: 10 });
        texts.set("README.md", "说明");
        texts.set("scenes/title/scene.json", SCENE);
        texts.set("scenes/title/index.html", "<p>标题</p>");
        texts.set("code/lib/深的路径/a.js", "export const a = 1;");
      }),
    );
    const reading = await readFolder(folder);
    expect(looked).not.toContain("assets/a.mp4");
    expect(looked).not.toContain("README.md");
    expect(reading.skipped).toEqual(["README.md", "assets/unused.mp4"]);
    expect(reading.sources).toEqual({
      "scenes/title/index.html": "<p>标题</p>",
      "code/lib/深的路径/a.js": "export const a = 1;",
    });
    expect(reading.warnings).toEqual([]);
  });

  it("takes the byte order mark off documents, and leaves code exactly as it is", async () => {
    const html = "\uFEFF<html>\r\n  <body>原子\u0000</body>\r\n</html>\r\n";
    const files = projectFiles((texts) => {
      texts.set(MANIFEST_FILE, `\uFEFF${texts.get(MANIFEST_FILE) as string}`);
      texts.set("scenes/title/scene.json", `\uFEFF${SCENE}`);
      texts.set("scenes/title/index.html", html);
    });
    const reading = await read(files);
    expect(reading.project.manifest.name).toBe("文件夹里的项目");
    expect(reading.project.scenes.get("title")?.name).toBe("标题");
    expect(reading.sources["scenes/title/index.html"]).toBe(html);
  });

  it("loses a document that is no text, and says why", async () => {
    const reading = await read(projectFiles((texts) => texts.set("notes.json", NO_TEXT)));
    expect(reading.lost).toEqual([
      {
        file: "notes.json",
        part: { kind: "notes" },
        problems: [
          { severity: "error", code: "not-text", file: "notes.json", message: expect.any(String) },
        ],
      },
    ]);
    expect(isFolderProblem(reading.lost[0]?.problems[0] as never)).toBe(true);
    expect(reading.project.notes).toBeUndefined();
    expect(reading.skipped).toEqual([]);
  });

  it("leaves out code that is no text, instead of letting it come in damaged", async () => {
    const reading = await read(
      projectFiles((texts) => {
        texts.set("code/logo.png", NO_TEXT);
        texts.set("code/ok.js", "export {};");
      }),
    );
    expect(reading.skipped).toEqual(["code/logo.png"]);
    expect(Object.keys(reading.sources)).toEqual(["code/ok.js"]);
    expect(reading.lost).toEqual([]);
  });

  it("leaves out code too large to be code, without reading it", async () => {
    const { folder, read: wasRead } = memoryFolder(
      projectFiles((texts) => {
        texts.set("code/huge.js", { size: MAX_SOURCE_BYTES + 1 });
        texts.set("code/just-fits.js", { size: MAX_SOURCE_BYTES, content: "// 刚好" });
      }),
    );
    const reading = await readFolder(folder);
    expect(wasRead).not.toContain("code/huge.js");
    expect(reading.skipped).toEqual(["code/huge.js"]);
    expect(reading.sources).toEqual({ "code/just-fits.js": "// 刚好" });
  });

  it("reads a document whatever its size", async () => {
    const notes = stringifyDocument({ notes: [] });
    const reading = await read(
      projectFiles((texts) => texts.set("notes.json", { size: 4 * 1024 ** 3, content: notes })),
    );
    expect(reading.project.notes).toEqual({ notes: [] });
    expect(reading.skipped).toEqual([]);
  });

  it("fails when a file cannot be read, rather than leave it out", async () => {
    const { folder } = memoryFolder(projectFiles());
    const failing = (fail: (path: string, file: ReadableFile) => ReadableFile): ReadOnlyFolder => ({
      list: () => folder.list(),
      file: async (path) => fail(path, await folder.file(path)),
    });
    const gone = failing((path, file) =>
      path === "timelines/main/timeline.json"
        ? { size: file.size, arrayBuffer: () => Promise.reject(new Error("gone")) }
        : file,
    );
    await expect(readFolder(gone)).rejects.toThrow("gone");
    const missing: ReadOnlyFolder = {
      list: () => folder.list(),
      file: () => Promise.reject(new Error("not found")),
    };
    await expect(readFolder(missing)).rejects.toThrow("not found");
  });
});

describe("documents that cannot be used", () => {
  it("refuse a newer format, whatever else is broken, and say which version", async () => {
    const files = projectFiles((texts) => {
      const manifest = manifestOf(texts);
      manifest.formatVersion = 2;
      texts.set(MANIFEST_FILE, JSON.stringify(manifest));
      texts.set("notes.json", BROKEN);
    });
    const { reason, problems } = await refusal(files);
    expect(reason).toBe("too-new");
    expect(problems).toEqual([expect.objectContaining({ code: "format-too-new" })]);
  });

  it("refuse an older format, which has to be brought up to date first", async () => {
    const files = projectFiles((texts) => {
      const manifest = manifestOf(texts);
      manifest.formatVersion = 0;
      texts.set(MANIFEST_FILE, JSON.stringify(manifest));
    });
    const { reason, problems } = await refusal(files);
    expect(reason).toBe("invalid");
    expect(problems).toEqual([expect.objectContaining({ code: "format-needs-migration" })]);
  });

  it("refuse a manifest that is broken, with all that is wrong", async () => {
    const notJson = await refusal(projectFiles((texts) => texts.set(MANIFEST_FILE, BROKEN)));
    expect(notJson.reason).toBe("invalid");
    expect(notJson.problems).toEqual([
      expect.objectContaining({ code: "invalid-json", file: MANIFEST_FILE }),
    ]);

    const wrong = await refusal(
      projectFiles((texts) => {
        const manifest = manifestOf(texts);
        manifest.timelines = [];
        texts.set(MANIFEST_FILE, JSON.stringify(manifest));
      }),
    );
    expect(wrong.reason).toBe("invalid");
    expect(wrong.problems.map(({ file }) => file)).toContain(MANIFEST_FILE);
  });

  it("refuse a manifest that is no text, and say what else is wrong first", async () => {
    const { reason, problems } = await refusal(
      projectFiles((texts) => {
        texts.set(MANIFEST_FILE, NO_TEXT);
        texts.set("notes.json", NO_TEXT);
      }),
    );
    expect(reason).toBe("invalid");
    expect(problems.map(({ code, file }) => [code, file])).toEqual([
      ["not-text", MANIFEST_FILE],
      ["not-text", "notes.json"],
      ["not-a-project", MANIFEST_FILE],
    ]);
  });

  it("leave a timeline the manifest lists empty, under the name it is given", async () => {
    const files = projectFiles((texts) => texts.set("timelines/main/timeline.json", BROKEN));
    const named = await read(files, { emptyTimeline: (id) => `${id}（空的）` });
    expect(named.project.timelines.get("main")?.document?.name).toBe("main（空的）");
    expect(named.project.timelines.get("main")?.document?.tracks.length).toBeGreaterThan(0);
    expect(named.lost).toEqual([
      {
        file: "timelines/main/timeline.json",
        part: { kind: "timeline", id: "main", listed: true },
        problems: [expect.objectContaining({ code: "invalid-json" })],
      },
    ]);
    const unnamed = await read(files);
    expect(unnamed.project.timelines.get("main")?.document?.name).toBe("main");
  });

  it("leave a timeline empty that is not in the folder at all, and say so", async () => {
    const files = projectFiles((texts) => {
      texts.set(
        "timelines/second/timeline.json",
        texts.get("timelines/main/timeline.json") as string,
      );
      texts.delete("timelines/main/timeline.json");
      listing(texts, "main", "second");
    });
    const reading = await read(files);
    expect(reading.lost).toEqual([
      {
        file: "timelines/main/timeline.json",
        part: { kind: "timeline", id: "main", listed: true },
        problems: [
          {
            severity: "error",
            code: "timeline-not-in-folder",
            file: "timelines/main/timeline.json",
            message: expect.any(String),
          },
        ],
      },
    ]);
    expect(isFolderProblem(reading.lost[0]?.problems[0] as never)).toBe(true);
    expect([...reading.project.timelines.keys()]).toEqual(["main", "second"]);
    expect(reading.project.timelines.get("second")?.document).toBeDefined();
  });

  it("let a timeline that the manifest does not list simply go", async () => {
    const files = projectFiles((texts) => texts.set("timelines/stray/timeline.json", BROKEN));
    const reading = await read(files);
    expect(reading.lost).toEqual([
      {
        file: "timelines/stray/timeline.json",
        part: { kind: "timeline", id: "stray", listed: false },
        problems: [expect.objectContaining({ code: "invalid-json" })],
      },
    ]);
    expect(reading.project.timelines.has("stray")).toBe(false);
  });

  it("go one at a time, so that a timeline that holds itself breaks the circle", async () => {
    const withClip = (text: string, other: string) => {
      const timeline = JSON.parse(text);
      const source = { kind: "timeline", timeline: other };
      timeline.tracks[0].clips = [{ id: "c", start: "0", duration: "1", source }];
      return JSON.stringify(timeline);
    };
    const files = projectFiles((texts) => {
      const main = texts.get("timelines/main/timeline.json") as string;
      texts.set("timelines/main/timeline.json", withClip(main, "second"));
      texts.set("timelines/second/timeline.json", withClip(main, "main"));
      listing(texts, "main", "second");
    });
    const reading = await read(files);
    expect(reading.lost).toHaveLength(1);
    expect(reading.lost[0]?.problems).toEqual([
      expect.objectContaining({ code: "timeline-cycle" }),
    ]);
    const clips = [...reading.project.timelines.values()].map(
      ({ document }) => document?.tracks[0]?.clips.length,
    );
    expect(clips.toSorted()).toEqual([0, 1]);
  });

  it("say what each of them is, for people to know what they lose", async () => {
    const fixture = loadFixture("v1");
    const documents = [...fixture.keys()].filter(
      (path) => path !== MANIFEST_FILE && documentSchema(path) !== undefined,
    );
    const parts = new Map<string, unknown>();
    for (const path of documents) {
      const reading = await read(new Map<string, Content>(fixture).set(path, BROKEN));
      expect(reading.lost.map(({ file }) => file)).toEqual([path]);
      parts.set(path, reading.lost[0]?.part);
    }
    expect(Object.fromEntries(parts)).toEqual({
      "assets.json": { kind: "assets" },
      "libraries.json": { kind: "libraries" },
      "libraries.lock.json": { kind: "lock" },
      "notes.json": { kind: "notes" },
      "locales/en.json": { kind: "locale", id: "en" },
      "locales/zh-CN.json": { kind: "locale", id: "zh-CN" },
      "scenes/title/scene.json": { kind: "scene", id: "title" },
      "sounds/impacts/sound.json": { kind: "sound", id: "impacts" },
      "timelines/highlight/timeline.json": { kind: "timeline", id: "highlight", listed: true },
      "timelines/main/timeline.json": { kind: "timeline", id: "main", listed: true },
      "timelines/main/overrides/format.vertical.json": {
        kind: "override",
        timeline: "main",
        version: "format.vertical",
      },
      "timelines/main/overrides/language.en.json": {
        kind: "override",
        timeline: "main",
        version: "language.en",
      },
      "timelines/main/overrides/version.en.vertical.json": {
        kind: "override",
        timeline: "main",
        version: "version.en.vertical",
      },
    });
  });

  it("can all go at once, and what is left is a project like any other", async () => {
    const fixture = loadFixture("v1");
    const files = new Map<string, Content>(fixture);
    const documents = [...fixture.keys()].filter(
      (path) => path !== MANIFEST_FILE && documentSchema(path) !== undefined,
    );
    for (const path of documents) files.set(path, BROKEN);
    const reading = await read(files);
    expect(reading.lost).toHaveLength(documents.length);
    const again = readProject(writeProject(reading.project));
    expect(again.problems.filter(({ severity }) => severity === "error")).toEqual([]);
  });
});

describe("what a project has no place for", () => {
  it("lists documents that are fine but belong to nothing", async () => {
    const stray = "timelines/ghost/overrides/language.en.json";
    const reading = await read(
      projectFiles((texts) => texts.set(stray, JSON.stringify({ scope: { language: "en" } }))),
    );
    expect(reading.skipped).toEqual([stray]);
    expect(reading.lost).toEqual([]);
  });

  it("never lists the file of an asset, whatever kind of file it is", async () => {
    const assets = {
      logo: { kind: "image", path: "scenes/title/logo.svg", storage: "local" },
      clip: { kind: "video", path: "assets/a.mp4", storage: "local" },
      notes: { kind: "image", path: "README.md", storage: "local" },
    };
    const reading = await read(
      projectFiles((texts) => {
        texts.set("assets.json", stringifyDocument({ assets }));
        texts.set("scenes/title/scene.json", SCENE);
        texts.set("scenes/title/index.html", "<p></p>");
        texts.set("scenes/title/logo.svg", "<svg/>");
        texts.set("assets/a.mp4", { size: 1 });
        texts.set("README.md", "说明");
      }),
    );
    expect(reading.skipped).toEqual([]);
    expect(reading.sources["scenes/title/logo.svg"]).toBe("<svg/>");
  });

  it("says when a scene or sound is without its entry file, also one that is no text", async () => {
    const sound = stringifyDocument({ name: "音效", entry: "main.js", runtime: 1 });
    const reading = await read(
      projectFiles((texts) => {
        texts.set("scenes/title/scene.json", SCENE);
        texts.set("scenes/title/other.html", "<p></p>");
        texts.set("scenes/second/scene.json", SCENE);
        texts.set("scenes/second/index.html", NO_TEXT);
        texts.set("sounds/hit/sound.json", sound);
      }),
    );
    expect(reading.warnings).toEqual([
      expect.objectContaining({
        severity: "warning",
        code: "entry-missing",
        file: "scenes/title/index.html",
      }),
      expect.objectContaining({ code: "entry-missing", file: "scenes/second/index.html" }),
      expect.objectContaining({ code: "entry-missing", file: "sounds/hit/main.js" }),
    ]);
    expect(reading.warnings.every(isFolderProblem)).toBe(true);
    expect(reading.skipped).toEqual(["scenes/second/index.html"]);
  });
});

describe("problems of a folder", () => {
  it("are told apart from what the format says", async () => {
    const reading = await read(
      projectFiles((texts) => {
        const timeline = JSON.parse(texts.get("timelines/main/timeline.json") as string);
        const source = { kind: "video", media: { asset: "gone" } };
        timeline.tracks[0].clips = [{ id: "c", start: "0", duration: "1", source }];
        texts.set("timelines/main/timeline.json", JSON.stringify(timeline));
        texts.set("scenes/title/scene.json", SCENE);
      }),
    );
    expect(reading.warnings.map(({ code }) => code)).toEqual(["asset-missing", "entry-missing"]);
    expect(reading.warnings.map(isFolderProblem)).toEqual([false, true]);
    for (const code of ["not-text", "timeline-not-in-folder", "entry-missing"]) {
      expect(isFolderProblem({ severity: "error", code, file: "a", message: "" })).toBe(true);
    }
    for (const code of ["timeline-missing", "unreadable", "toString", "__proto__"]) {
      expect(isFolderProblem({ severity: "error", code, file: "a", message: "" })).toBe(false);
    }
  });
});

describe("the sample project", () => {
  it("comes out as it is, with what the format says about it", async () => {
    const fixture = loadFixture("v1");
    const reading = await read(fixture);
    expect(reading.project.manifest.name).toBe("原子是什么");
    expect(reading.skipped).toEqual(["AGENTS.md", "制作笔记/分镜.md"]);
    expect(reading.lost).toEqual([]);
    const texts = new Map([...fixture].filter(([path]) => !reading.skipped.includes(path)));
    const { project, problems } = readProject(texts);
    expect(reading.project).toEqual(project);
    expect(reading.warnings).toEqual(problems);
    expect(Object.keys(reading.sources).toSorted()).toEqual(
      ["code/animate.js", "scenes/title/index.html", "sounds/impacts/main.js"].toSorted(),
    );
    const written = new Map([...writeProject(reading.project), ...Object.entries(reading.sources)]);
    expect(written).toEqual(texts);
  });
});
