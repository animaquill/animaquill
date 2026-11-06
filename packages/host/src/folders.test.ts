import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFolderAccess, sourceFromFiles, type FolderAccessOptions } from "./folders.ts";
import type { SourceFolder, TargetFolder } from "./index.ts";
import { folderNameFor } from "./paths.ts";

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

class FakeFolder {
  readonly kind = "directory";
  readonly name: string;
  readonly entries = new Map<string, FakeFolder | FakeFile>();

  constructor(name: string) {
    this.name = name;
  }

  async getDirectoryHandle(name: string, { create = false } = {}) {
    const entry = this.entries.get(name);
    if (entry instanceof FakeFile) throw wrongKind();
    if (entry) return entry;
    if (!create) throw notFound();
    const folder = new FakeFolder(name);
    this.entries.set(name, folder);
    return folder;
  }

  async getFileHandle(name: string, { create = false } = {}) {
    const entry = this.entries.get(name);
    if (entry instanceof FakeFolder) throw wrongKind();
    if (entry) return entry;
    if (!create) throw notFound();
    const file = new FakeFile(name);
    this.entries.set(name, file);
    return file;
  }

  async removeEntry(name: string, { recursive = false } = {}) {
    const entry = this.entries.get(name);
    if (!entry) throw notFound();
    if (entry instanceof FakeFolder && entry.entries.size > 0 && !recursive) {
      throw new DOMException("not empty", "InvalidModificationError");
    }
    this.entries.delete(name);
  }

  async *values() {
    yield* this.entries.values();
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
    await expect(folder.write(path, new Blob(["x"]))).rejects.toThrow(TypeError);
    await expect(folder.remove(path)).rejects.toThrow(TypeError);
    expect([...disk.entries.keys()]).toEqual(["我的项目"]);
  });
});

describe("reading a folder", () => {
  it("lists every file, with paths from the top of the folder", async () => {
    const { access, disk, picker } = setup();
    disk.add("animaquill.json", "{}");
    disk.add("assets/视频/a.mp4", "内容");
    const source = await access.chooseSource();
    expect(source?.name).toBe("备份");
    expect(await pathsIn(source)).toEqual(["animaquill.json", "assets/视频/a.mp4"]);
    expect(picker).toHaveBeenCalledWith(expect.objectContaining({ mode: "read" }));
  });

  it("reads a file when asked", async () => {
    const { access, disk } = setup();
    disk.add("assets/a.txt", "内容");
    const source = await access.chooseSource();
    for await (const file of source?.files() ?? []) {
      expect(await (await file.read()).text()).toBe("内容");
    }
  });

  it("stays out of what belongs to tools", async () => {
    const { access, disk } = setup();
    disk.add("animaquill.json");
    disk.add(".git/objects/aa/bb");
    disk.add(".animaquill/cache.bin");
    disk.add("node_modules/a/index.js");
    expect(await pathsIn(await access.chooseSource())).toEqual(["animaquill.json"]);
  });

  it("does nothing when people change their minds", async () => {
    const { access } = setup({ picker: () => cancelled });
    expect(await access.chooseSource()).toBeUndefined();
  });
});

const fileAt = (path: string, text = "") => {
  const file = new File([text], path.split("/").at(-1) as string);
  Object.defineProperty(file, "webkitRelativePath", { value: path });
  return file;
};

describe("browsers that cannot give out folders", () => {
  it("get a folder the old way, with the same paths", async () => {
    const files = [
      fileAt("我的项目/animaquill.json", "{}"),
      fileAt("我的项目/assets/a.mp4", "内容"),
      fileAt("我的项目/.git/config"),
      fileAt("我的项目/node_modules/a/b.js"),
    ];
    const { access } = setup({ picker: () => undefined, chooseFiles: async () => files });
    const source = await access.chooseSource();
    expect(source?.name).toBe("我的项目");
    expect(await pathsIn(source)).toEqual(["animaquill.json", "assets/a.mp4"]);
    for await (const file of source?.files() ?? []) {
      if (file.path === "assets/a.mp4") expect(await (await file.read()).text()).toBe("内容");
    }
  });

  it("do nothing when people change their minds", async () => {
    const { access, chooseFiles } = setup({ picker: () => undefined });
    expect(await access.chooseSource()).toBeUndefined();
    expect(chooseFiles).toHaveBeenCalled();
  });

  it("are not left with nothing for an empty folder", () => {
    expect(sourceFromFiles([]).name).toBe("");
  });

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
  ])("makes something every system takes of %j", (name, folder) => {
    expect(folderNameFor(name)).toBe(folder);
  });

  it("stays short enough, without cutting a character in two", () => {
    const name = folderNameFor("😀".repeat(200));
    expect([...name]).toHaveLength(80);
    expect(name.endsWith("😀")).toBe(true);
  });
});
