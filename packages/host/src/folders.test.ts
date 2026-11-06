import { beforeEach, describe, expect, it, vi } from "vitest";
import { isRefusedByChrome } from "./chrome-names.ts";
import { createFolderAccess, sourceFromFiles, type FolderAccessOptions } from "./folders.ts";
import type { SourceFolder, TargetFolder } from "./index.ts";
import { FALLBACK_NAME, folderNameFor } from "./paths.ts";

/** A file on a disk. As in the browser, writing goes to a copy that takes over on closing. */
class FakeFile {
  readonly kind = "file";
  readonly name: string;
  content: Uint8Array<ArrayBuffer> = new Uint8Array();
  /** What the disk does to what arrives. */
  mangle: ((bytes: Uint8Array<ArrayBuffer>) => Uint8Array<ArrayBuffer>) | undefined;
  failing = false;

  constructor(name: string) {
    this.name = name;
  }

  async createWritable() {
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    return new WritableStream<Uint8Array<ArrayBuffer>>({
      write: (chunk) => {
        if (this.failing) throw new DOMException("no space", "QuotaExceededError");
        chunks.push(chunk);
      },
      close: async () => {
        const bytes = new Uint8Array(await new Blob(chunks).arrayBuffer());
        this.content = this.mangle?.(bytes) ?? bytes;
      },
    });
  }

  async getFile() {
    return new File([this.content], this.name);
  }
}

const notFound = () => new DOMException("not here", "NotFoundError");
const wrongKind = () => new DOMException("wrong kind", "TypeMismatchError");

/** A folder on a disk, with what Chrome allows there: see isRefusedByChrome. */
class FakeFolder {
  readonly kind = "directory";
  readonly name: string;
  readonly entries = new Map<string, FakeFolder | FakeFile>();
  /** Stands for rules of a later browser, which nobody knows yet. */
  refuses: (name: string) => boolean = isRefusedByChrome;

  constructor(name: string) {
    this.name = name;
  }

  #check(name: string) {
    if (this.refuses(name)) throw new TypeError("Name is not allowed.");
  }

  async getDirectoryHandle(name: string, { create = false } = {}) {
    this.#check(name);
    const entry = this.entries.get(name);
    if (entry instanceof FakeFile) throw wrongKind();
    if (entry) return entry;
    if (!create) throw notFound();
    const folder = new FakeFolder(name);
    this.entries.set(name, folder);
    return folder;
  }

  async getFileHandle(name: string, { create = false } = {}) {
    this.#check(name);
    const entry = this.entries.get(name);
    if (entry instanceof FakeFolder) throw wrongKind();
    if (entry) return entry;
    if (!create) throw notFound();
    const file = new FakeFile(name);
    this.entries.set(name, file);
    return file;
  }

  async removeEntry(name: string, { recursive = false } = {}) {
    this.#check(name);
    const entry = this.entries.get(name);
    if (!entry) throw notFound();
    if (entry instanceof FakeFolder && entry.entries.size > 0 && !recursive) {
      throw new DOMException("not empty", "InvalidModificationError");
    }
    this.entries.delete(name);
  }

  async *values() {
    for (const entry of this.entries.values()) if (!this.refuses(entry.name)) yield entry;
  }

  /** Follows a path, for looking at the result. */
  at(path: string): FakeFolder | FakeFile | undefined {
    const [first = "", ...rest] = path.split("/");
    const entry = this.entries.get(first);
    if (rest.length === 0) return entry;
    return entry instanceof FakeFolder ? entry.at(rest.join("/")) : undefined;
  }

  add(path: string, text = ""): void {
    const [first = "", ...rest] = path.split("/");
    if (rest.length === 0) {
      const file = new FakeFile(first);
      file.content = new TextEncoder().encode(text);
      this.entries.set(first, file);
      return;
    }
    const existing = this.entries.get(first);
    const folder = existing instanceof FakeFolder ? existing : new FakeFolder(first);
    this.entries.set(first, folder);
    folder.add(rest.join("/"), text);
  }
}

function setup(options: Partial<FolderAccessOptions> = {}) {
  const disk = new FakeFolder("备份");
  const picker = vi.fn(async () => disk as unknown as FileSystemDirectoryHandle);
  const saveFile = vi.fn<FolderAccessOptions["saveFile"]>();
  const chooseFiles = vi.fn<FolderAccessOptions["chooseFiles"]>(async () => undefined);
  const access = createFolderAccess({ picker: () => picker, chooseFiles, saveFile, ...options });
  return { access, disk, picker, saveFile, chooseFiles };
}

const textOf = (file: FakeFolder | FakeFile | undefined) =>
  new TextDecoder().decode((file as FakeFile).content);

async function pathsIn(source: SourceFolder | undefined) {
  const paths: string[] = [];
  for await (const file of source?.files() ?? []) paths.push(file.path);
  return paths.toSorted();
}

const target = async (access: ReturnType<typeof setup>["access"], name = "我的项目") =>
  (await access.chooseTarget(name)) as TargetFolder;

const cancelled = () => Promise.reject(new DOMException("dismissed", "AbortError"));

describe("writing a folder", () => {
  it("makes a new folder inside the one people chose", async () => {
    const { access, disk } = setup();
    const folder = await target(access);
    await folder.write("timelines/main/timeline.json", new Blob(["时间轴"]));
    expect(folder.name).toBe("我的项目");
    expect(folder.kind).toBe("folder");
    expect(textOf(disk.at("我的项目/timelines/main/timeline.json"))).toBe("时间轴");
  });

  it("asks for a folder it may write to", async () => {
    const { access, picker } = setup();
    await target(access);
    expect(picker).toHaveBeenCalledWith(expect.objectContaining({ mode: "readwrite" }));
  });

  it("never touches a folder that is there already", async () => {
    const { access, disk } = setup();
    disk.add("我的项目/animaquill.json", "重要的内容");
    disk.add("我的项目 (2)/animaquill.json", "也很重要");
    const folder = await target(access);
    await folder.write("animaquill.json", new Blob(["新的"]));
    expect(folder.name).toBe("我的项目 (3)");
    expect(textOf(disk.at("我的项目/animaquill.json"))).toBe("重要的内容");
    expect(textOf(disk.at("我的项目 (2)/animaquill.json"))).toBe("也很重要");
    expect(textOf(disk.at("我的项目 (3)/animaquill.json"))).toBe("新的");
  });

  it("goes around a file of the same name", async () => {
    const { access, disk } = setup();
    disk.add("我的项目", "一个文件");
    expect((await target(access)).name).toBe("我的项目 (2)");
    expect(disk.at("我的项目")).toBeInstanceOf(FakeFile);
  });

  it("does nothing when people change their minds", async () => {
    const { access } = setup({ picker: () => cancelled });
    expect(await access.chooseTarget("我的项目")).toBeUndefined();
  });

  it("passes on when the browser says no", async () => {
    const denied = () => Promise.reject(new DOMException("denied", "NotAllowedError"));
    const { access } = setup({ picker: () => denied });
    await expect(access.chooseTarget("我的项目")).rejects.toThrow("denied");
  });

  it("reports how far a file got", async () => {
    const { access } = setup();
    const folder = await target(access);
    const onProgress = vi.fn<(bytes: number) => void>();
    await folder.write("a.bin", new Blob([new Uint8Array(1000)]), { onProgress });
    expect(onProgress).toHaveBeenLastCalledWith(1000);
  });

  it("writes a file piece by piece, however large it is", async () => {
    class OnlyInPieces extends Blob {
      override async arrayBuffer(): Promise<ArrayBuffer> {
        throw new Error("Read as a whole");
      }
    }
    const { access, disk } = setup();
    const folder = await target(access);
    await folder.write("a.bin", new OnlyInPieces(["内容"]));
    expect(textOf(disk.at("我的项目/a.bin"))).toBe("内容");
  });

  it("notices when less arrived than it wrote", async () => {
    const { access, disk } = setup();
    const folder = await target(access);
    await folder.write("a.bin", new Blob(["x"]));
    (disk.at("我的项目/a.bin") as FakeFile).mangle = (bytes) => bytes.slice(0, 2);
    await expect(folder.write("a.bin", new Blob(["完整内容"]))).rejects.toThrow("2 of 12");
  });

  it("fails when the disk does", async () => {
    const { access, disk } = setup();
    const folder = await target(access);
    await folder.write("a.bin", new Blob(["旧的"]));
    const file = disk.at("我的项目/a.bin") as FakeFile;
    file.failing = true;
    await expect(folder.write("a.bin", new Blob(["新的"]))).rejects.toThrow("no space");
    expect(textOf(file)).toBe("旧的");
  });

  it("stops in the middle of a file when asked to, and the file stays out", async () => {
    const { access, disk } = setup();
    const folder = await target(access);
    await folder.write("a.bin", new Blob(["旧的"]));

    const cancel = vi.fn<() => void>();
    let sent = false;
    const content = {
      size: 1000,
      stream: () =>
        new ReadableStream<Uint8Array>({
          pull(controller) {
            if (!sent) controller.enqueue(new Uint8Array(10));
            sent = true;
            // The rest of the file never comes: only stopping ends this.
            return new Promise<void>(() => {});
          },
          cancel,
        }),
    } as unknown as Blob;
    const controller = new AbortController();
    const onProgress = vi.fn<(bytes: number) => void>(() => {
      controller.abort(new DOMException("stop", "AbortError"));
    });

    const writing = folder.write("a.bin", content, { signal: controller.signal, onProgress });
    await expect(writing).rejects.toThrow("stop");
    expect(onProgress).toHaveBeenCalledWith(10);
    expect(cancel).toHaveBeenCalled();
    expect(textOf(disk.at("我的项目/a.bin"))).toBe("旧的");
  });

  it("stops writing when asked to, and the file stays out", async () => {
    const { access, disk } = setup();
    const folder = await target(access);
    const controller = new AbortController();
    controller.abort(new DOMException("stop", "AbortError"));
    await expect(folder.write("a.bin", new Blob(["x"]), controller)).rejects.toThrow("stop");
    expect(textOf(disk.at("我的项目/a.bin"))).toBe("");
  });

  it("removes a file", async () => {
    const { access, disk } = setup();
    const folder = await target(access);
    await folder.write("a/b.txt", new Blob(["x"]));
    await folder.remove("a/b.txt");
    expect(disk.at("我的项目/a/b.txt")).toBeUndefined();
  });

  it("takes all of it back", async () => {
    const { access, disk } = setup();
    disk.add("别的文件夹/a.txt", "留着");
    const folder = await target(access);
    await folder.write("a/b.txt", new Blob(["x"]));
    await folder.abandon();
    expect(disk.at("我的项目")).toBeUndefined();
    expect(textOf(disk.at("别的文件夹/a.txt"))).toBe("留着");
  });

  it.each([
    "../outside.txt",
    "/etc/passwd",
    "a/../../b",
    "a\\b",
    "C:/x",
    "a//b",
    "a/./b",
    "",
    "a/",
  ])("does not follow %s out of the folder", async (path) => {
    const { access, disk } = setup();
    const folder = await target(access);
    expect(await folder.write(path, new Blob(["x"]))).toBe(false);
    await folder.remove(path);
    expect([...disk.entries.keys()]).toEqual(["我的项目"]);
    expect((disk.at("我的项目") as FakeFolder).entries.size).toBe(0);
  });

  it.each([
    ["aux.js", "code/aux.js"],
    ["a folder of a reserved name", "scenes/con/index.html"],
    ["a leading tilde", "scenes/title/~draft.html"],
    ["a trailing tilde", "code/backup.js~"],
    ["a joiner", "assets/👨\u200D👩\u200D👧.png"],
    ["a shortcut", "assets/site.url"],
  ])("says when the browser will not have %s, and goes on", async (_, path) => {
    const { access, disk } = setup();
    const folder = await target(access);
    expect(await folder.write(path, new Blob(["x"]))).toBe(false);
    expect(await folder.write("assets/a.mp4", new Blob(["内容"]))).toBe(true);
    expect(textOf(disk.at("我的项目/assets/a.mp4"))).toBe("内容");
  });

  it("says when a file is where a folder has to be", async () => {
    const { access, disk } = setup();
    const folder = await target(access);
    await folder.write("assets/a", new Blob(["文件"]));
    expect(await folder.write("assets/a/b.mp4", new Blob(["x"]))).toBe(false);
    expect(textOf(disk.at("我的项目/assets/a"))).toBe("文件");
  });

  it("does not take a failure of the disk for a refusal", async () => {
    const { access, disk } = setup();
    const folder = await target(access);
    const root = disk.at("我的项目") as FakeFolder;
    vi.spyOn(root, "getFileHandle").mockRejectedValue(new DOMException("gone", "NotFoundError"));
    await expect(folder.write("a.bin", new Blob(["x"]))).rejects.toThrow("gone");
  });
});

describe("a project name that becomes a folder", () => {
  it.each([
    ["第二集~"],
    ["~草稿"],
    ["你好~~"],
    ["一家人👨\u200D👩\u200D👧"],
    ["🏳\uFE0F\u200D🌈 彩虹"],
    ["程序员🧑\u200D💻教程"],
    ["项目\u3000"],
    ["\u3000项目"],
    ["复制的\u200B标题"],
    ["\uFEFF标题\uFEFF"],
    ["clock$"],
    ["CLOCK$.备份"],
    ["CON"],
    ["com1"],
    ["desktop.ini"],
    ["Thumbs.db"],
    ["官网.url"],
    ["快捷.lnk"],
    ["a.{abc}"],
    ["\uFDD0坏字符"],
    ["\uD83D断开的表情"],
    ["行一\n行二"],
    ["a:b"],
    ["..."],
    ["~"],
    [" ~ . "],
  ])("works for %j", async (name) => {
    const { access, disk } = setup();
    const folder = await target(access, name);
    expect(isRefusedByChrome(folder.name)).toBe(false);
    expect(await folder.write("animaquill.json", new Blob(["{}"]))).toBe(true);
    expect(disk.at(`${folder.name}/animaquill.json`)).toBeDefined();
  });

  it("works whatever people call a project", async () => {
    const pool = [
      ...'~. \u3000\u200B\u200D\uFEFF:*?|<>"/\\\n\t',
      ..."😀字aA0_-",
      "\uD83D",
      "\uFDD0",
      "con",
      "aux",
      ".url",
      "clock$",
    ];
    for (let round = 0; round < 500; round++) {
      let name = "";
      for (let index = 0; index < 1 + Math.random() * 12; index++) {
        name += pool[Math.floor(Math.random() * pool.length)];
      }
      const { access } = setup();
      const folder = await target(access, name);
      expect(isRefusedByChrome(folder.name), JSON.stringify(name)).toBe(false);
    }
  });

  it("falls back on a plain name when the browser has rules nobody knows yet", async () => {
    const { access, disk } = setup();
    disk.add(`${FALLBACK_NAME}/animaquill.json`, "重要的内容");
    disk.refuses = (name) => name === "我的项目";
    const folder = await target(access, "我的项目");
    expect(folder.name).toBe(`${FALLBACK_NAME} (2)`);
    expect(textOf(disk.at(`${FALLBACK_NAME}/animaquill.json`))).toBe("重要的内容");
  });

  it("does not take a failure of the disk for rules about names", async () => {
    const { access, disk } = setup();
    const failure = new DOMException("denied", "NotAllowedError");
    vi.spyOn(disk, "getDirectoryHandle").mockRejectedValue(failure);
    await expect(access.chooseTarget("我的项目")).rejects.toThrow("denied");
  });
});

describe("reading a folder", () => {
  it("says that the browser will ask about uploading, which is how this way of choosing works", () => {
    expect(setup().access.asksToUpload).toBe(true);
  });

  it("does not go through a dialog that hides files", async () => {
    const files = [fileAt("项目/animaquill.json"), fileAt("项目/code/aux.js")];
    const { access, disk, picker } = setup({ chooseFiles: async () => files });
    disk.add("animaquill.json");
    disk.add("code/aux.js");
    const listed: string[] = [];
    for await (const entry of (disk.at("code") as FakeFolder).values()) listed.push(entry.name);
    expect(listed).toEqual([]);

    expect(await pathsIn(await access.chooseSource())).toEqual(["animaquill.json", "code/aux.js"]);
    expect(picker).not.toHaveBeenCalled();
  });

  it("gives every file, with paths from the top of the folder", async () => {
    const files = [
      fileAt("我的项目/animaquill.json", "{}"),
      fileAt("我的项目/assets/视频/a.mp4", "内容"),
      fileAt("我的项目/scenes/con/~草稿.html"),
    ];
    const { access } = setup({ chooseFiles: async () => files });
    const source = await access.chooseSource();
    expect(source?.name).toBe("我的项目");
    expect(await pathsIn(source)).toEqual([
      "animaquill.json",
      "assets/视频/a.mp4",
      "scenes/con/~草稿.html",
    ]);
    for await (const file of source?.files() ?? []) {
      if (file.path.endsWith("a.mp4")) expect(await (await file.read()).text()).toBe("内容");
    }
  });

  it("stays out of what belongs to tools", async () => {
    const files = [
      fileAt("我的项目/animaquill.json"),
      fileAt("我的项目/.git/objects/aa/bb"),
      fileAt("我的项目/.animaquill/cache.bin"),
      fileAt("我的项目/node_modules/a/index.js"),
      fileAt("我的项目/code/node_modules/a/index.js"),
    ];
    const { access } = setup({ chooseFiles: async () => files });
    expect(await pathsIn(await access.chooseSource())).toEqual(["animaquill.json"]);
  });

  it("does nothing when people change their minds", async () => {
    const { access, chooseFiles } = setup();
    expect(await access.chooseSource()).toBeUndefined();
    expect(chooseFiles).toHaveBeenCalled();
  });

  it("is not left with nothing for an empty folder", () => {
    expect(sourceFromFiles([]).name).toBe("");
  });
});

const fileAt = (path: string, text = "") => {
  const file = new File([text], path.split("/").at(-1) as string);
  Object.defineProperty(file, "webkitRelativePath", { value: path });
  return file;
};

describe("browsers that cannot give out folders", () => {
  it("get a zip file to save", async () => {
    const { access, saveFile } = setup({ picker: () => undefined });
    const folder = await target(access, "我的/项目");
    expect(folder.kind).toBe("archive");
    expect(folder.name).toBe("我的_项目.zip");
    await folder.write("animaquill.json", new Blob(["{}"]));
    await folder.finish();
    expect(saveFile).toHaveBeenCalledExactlyOnceWith(expect.any(Blob), "我的_项目.zip");
  });
});

describe("the name of a folder", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ["我的项目", "我的项目"],
    ['a/b\\c:d*e?f"g<h>i|j', "a_b_c_d_e_f_g_h_i_j"],
    ["行一\n行二\t结束", "行一_行二_结束"],
    ["尾巴. . ", "尾巴"],
    ["..隐藏", "隐藏"],
    ["...", "AnimaQuill"],
    ["   ", "AnimaQuill"],
    ["", "AnimaQuill"],
    ["CON", "_CON"],
    ["nul.txt", "_nul.txt"],
    ["com1", "_com1"],
    ["console", "console"],
    ["官网.url", "官网_url"],
    ["快捷方式.LNK", "快捷方式_LNK"],
    ["第1~3集", "第1~3集"],
    ["第二集~", "第二集"],
    ["~第二集", "第二集"],
    ["程序员🧑\u200D💻教程", "程序员🧑💻教程"],
    ["项目\u3000", "项目"],
    ["复制的\u200B标题", "复制的标题"],
    ["clock$", "_clock$"],
    ["a.b", "a.b"],
  ])("makes something every system takes of %j", (name, folder) => {
    expect(folderNameFor(name)).toBe(folder);
  });

  it("stays short enough for every disk, without cutting a character in two", () => {
    const name = folderNameFor("😀".repeat(200));
    expect(new TextEncoder().encode(name).length).toBeLessThanOrEqual(200);
    expect(name.endsWith("😀")).toBe(true);
    expect(folderNameFor("字".repeat(66))).toHaveLength(66);
    expect(folderNameFor("字".repeat(67))).toHaveLength(66);
  });

  it("does not end in what it would have to take away, after being cut", () => {
    expect(folderNameFor(`${"字".repeat(66)}~${"字".repeat(10)}`)).toBe("字".repeat(66));
    expect(folderNameFor(`${"a".repeat(199)}~字`)).toBe("a".repeat(199));
  });
});
