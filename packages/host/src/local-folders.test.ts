import { describe, expect, it, vi } from "vitest";
import { FolderError, type LocalFolder, type LocalFolders } from "./index.ts";
import { MemoryDisk, memoryFolders, type MemoryDiskOptions } from "./memory-disk.ts";

const encoder = new TextEncoder();

function setup(options?: MemoryDiskOptions) {
  const disk = new MemoryDisk(options);
  return { disk, folders: memoryFolders(disk) };
}

/** A folder people chose, which the editor may write. */
async function chosen(options?: MemoryDiskOptions, path = "文档/原子") {
  const { disk, folders } = setup(options);
  disk.folder(path);
  disk.chooseNext(path);
  const folder = (await folders.choose()) as LocalFolder;
  return { disk, folders, folder };
}

const failed = (reason: FolderError["reason"], path?: string) =>
  expect.objectContaining({ name: "FolderError", reason, ...(path !== undefined && { path }) });

/** What arrives only once the test lets it, to have a write go on for a while. */
function held(text = "新的内容") {
  const bytes = encoder.encode(text);
  let release = () => {};
  let started = () => {};
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const begun = new Promise<void>((resolve) => {
    started = resolve;
  });
  const content = new (class extends Blob {
    override stream(): ReadableStream<Uint8Array<ArrayBuffer>> {
      started();
      return new ReadableStream({
        async pull(controller) {
          await waiting;
          controller.enqueue(bytes);
          controller.close();
        },
      });
    }
  })([bytes]);
  return { content, release, begun };
}

describe("choosing a folder", () => {
  it("gives one that the editor may read and write", async () => {
    const { folder, disk } = await chosen();
    expect(folder.name).toBe("原子");
    expect(await folder.status()).toBe("ready");
    await folder.write("animaquill.json", "{}");
    expect(disk.text("文档/原子/animaquill.json")).toBe("{}");
  });

  it("gives nothing when people change their minds", async () => {
    const { disk, folders } = setup();
    disk.chooseNext("cancel");
    expect(await folders.choose()).toBeUndefined();
  });
});

describe("a folder that was dropped", () => {
  it("can be read, and is only written once people allow it", async () => {
    const { disk, folders } = setup();
    disk.write("拖进来/animaquill.json", "{}");
    const [entry] = await folders.dropped(disk.drop("拖进来"));
    if (entry?.kind !== "folder") throw new Error("No folder");
    const { folder } = entry;
    expect(await folder.readText("animaquill.json")).toBe("{}");
    expect(await folder.status()).toBe("ask");
    await expect(folder.write("a.txt", "x")).rejects.toEqual(failed("denied", "a.txt"));
    // Writing does not ask by itself, even right after people did something.
    expect(await folder.status()).toBe("ask");
    expect(await folder.requestAccess()).toBe("granted");
    await folder.write("a.txt", "x");
    expect(disk.text("拖进来/a.txt")).toBe("x");
  });

  it("asks only right after people did something", async () => {
    const { disk, folders } = setup();
    disk.folder("拖进来");
    const [entry] = await folders.dropped(disk.drop("拖进来"));
    if (entry?.kind !== "folder") throw new Error("No folder");
    disk.activation = false;
    expect(await entry.folder.requestAccess()).toBe("needs-activation");
    disk.activation = true;
    disk.answer = "refuse";
    expect(await entry.folder.requestAccess()).toBe("refused");
    expect(await entry.folder.status()).toBe("ask");
  });

  it("gives files, and says where they are in a folder", async () => {
    const { disk, folder, folders } = await chosen();
    disk.write("文档/原子/assets/红色.webm", "视频");
    disk.write("文档/外面.webm", "别的");
    const entries = await folders.dropped(
      disk.drop("文档/原子/assets/红色.webm", "文档/外面.webm", "文档/原子"),
    );
    expect(entries.map((entry) => entry.kind)).toEqual(["file", "file", "folder"]);
    const [inside, outside, itself] = entries;
    expect(await folder.pathOf(inside as never)).toBe("assets/红色.webm");
    expect(await folder.pathOf(outside as never)).toBeUndefined();
    expect(await folder.pathOf(itself as never)).toBe("");
    if (inside?.kind === "file") expect(await (await inside.file.read()).text()).toBe("视频");
  });

  it("leaves out what the browser would not give", async () => {
    const { folders } = setup();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const refused = (name: string) => ({
      kind: "file",
      getAsFileSystemHandle: () => Promise.reject(new DOMException("no", name)),
    });
    const transfer = {
      items: [refused("AbortError"), { kind: "string" }, refused("NotFoundError")],
    } as unknown as DataTransfer;
    expect(await folders.dropped(transfer)).toEqual([]);
    vi.restoreAllMocks();
  });

  it("is the same folder when it was chosen before", async () => {
    const { disk, folder, folders } = await chosen();
    const [entry] = await folders.dropped(disk.drop("文档/原子"));
    if (entry?.kind !== "folder") throw new Error("No folder");
    expect(await folder.isSame(entry.folder)).toBe(true);
    disk.folder("文档/别的");
    const [other] = await folders.dropped(disk.drop("文档/别的"));
    expect(await folder.isSame((other as { folder: LocalFolder }).folder)).toBe(false);
  });
});

describe("how a folder is", () => {
  it("is blocked where the browser does not let the editor at it", async () => {
    const { disk, folder } = await chosen();
    disk.block("文档/原子");
    expect(await folder.status()).toBe("blocked");
  });

  it("has to ask again once the browser took back what people allowed", async () => {
    const { disk, folder } = await chosen();
    disk.forgetPermissions();
    expect(await folder.status()).toBe("ask");
    disk.activation = true;
    expect(await folder.requestAccess()).toBe("granted");
    expect(await folder.status()).toBe("ready");
  });

  it("is gone when it was moved, and back when it is back", async () => {
    const { disk, folder } = await chosen();
    disk.write("文档/原子/a.txt", "x");
    disk.move("文档/原子", "文档/原子（旧）");
    expect(await folder.status()).toBe("gone");
    await expect(folder.read("a.txt")).rejects.toEqual(failed("gone"));
    await expect(folder.write("b.txt", "y")).rejects.toEqual(failed("gone"));
    await expect(folder.remove("a.txt")).rejects.toEqual(failed("gone"));
    disk.move("文档/原子（旧）", "文档/原子");
    expect(await folder.status()).toBe("ready");
    expect(await folder.readText("a.txt")).toBe("x");
  });

  it("takes whatever comes to its place, which is why a project has to be checked", async () => {
    const { disk, folder } = await chosen();
    disk.remove("文档/原子");
    disk.write("文档/原子/animaquill.json", "另一个项目");
    expect(await folder.readText("animaquill.json")).toBe("另一个项目");
  });
});

describe("reading a folder", () => {
  it("gives the text, the bytes, and the file", async () => {
    const { disk, folder } = await chosen();
    disk.write("文档/原子/scenes/a/scene.json", '{"名字":"片头"}');
    expect(await folder.readText("scenes/a/scene.json")).toBe('{"名字":"片头"}');
    expect(await folder.read("scenes/a/scene.json")).toEqual(encoder.encode('{"名字":"片头"}'));
    const file = await folder.file("scenes/a/scene.json");
    expect(file.name).toBe("scene.json");
    expect(file.size).toBe(encoder.encode('{"名字":"片头"}').length);
  });

  it("says what is not there, and what cannot be there", async () => {
    const { disk, folder } = await chosen();
    disk.write("文档/原子/code/aux.js", "whatever");
    await expect(folder.read("nothing.json")).rejects.toEqual(failed("missing", "nothing.json"));
    await expect(folder.read("no/such/folder.json")).rejects.toEqual(failed("missing"));
    await expect(folder.read("code")).rejects.toEqual(failed("missing"));
    await expect(folder.read("../outside.json")).rejects.toEqual(failed("refused"));
    // On the disk, and out of reach for a page.
    await expect(folder.read("code/aux.js")).rejects.toEqual(failed("refused"));
  });

  it("says when a file is no text", async () => {
    const { disk, folder } = await chosen();
    disk.write("文档/原子/broken.json", new Uint8Array([0xff, 0xfe, 0x00]));
    await expect(folder.readText("broken.json")).rejects.toEqual(failed("not-text"));
  });

  it("gives a file that cannot be read any more once it changed", async () => {
    const { disk, folder } = await chosen();
    disk.write("文档/原子/a.txt", "旧的");
    const old = await folder.file("a.txt");
    disk.write("文档/原子/a.txt", "新的");
    await expect(old.text()).rejects.toMatchObject({ name: "NotReadableError" });
    expect(await folder.readText("a.txt")).toBe("新的");
    disk.touch("文档/原子/a.txt");
    await expect((await folder.file("a.txt")).text()).resolves.toBe("新的");
  });

  it("gets a file again that changed right after the browser gave it", async () => {
    const { disk, folder } = await chosen();
    disk.write("文档/原子/a.txt", "旧的");
    const stale = await folder.file("a.txt");
    disk.write("文档/原子/a.txt", "新的");
    const file = vi.spyOn(folder, "file").mockResolvedValueOnce(stale);
    expect(await folder.readText("a.txt")).toBe("新的");
    expect(file).toHaveBeenCalledTimes(2);
  });

  it("lists every file, apart from those of tools and those Chrome hides", async () => {
    const { disk, folder } = await chosen();
    for (const path of [
      "animaquill.json",
      "timelines/main/timeline.json",
      "assets/b.png",
      "assets/a.png",
      ".git/HEAD",
      "node_modules/x/index.js",
      "code/aux.js",
      "README.md",
    ]) {
      disk.write(`文档/原子/${path}`, "x");
    }
    const listed: string[] = [];
    for await (const path of folder.list()) listed.push(path);
    expect(listed).toEqual([
      "README.md",
      "animaquill.json",
      "assets/a.png",
      "assets/b.png",
      "timelines/main/timeline.json",
    ]);
  });
});

describe("writing a file", () => {
  it("makes it, with the folders on the way, and tells how far it got", async () => {
    const { disk, folder } = await chosen();
    const onProgress = vi.fn<(bytes: number) => void>();
    const file = await folder.write("timelines/main/timeline.json", "时间轴", { onProgress });
    expect(disk.text("文档/原子/timelines/main/timeline.json")).toBe("时间轴");
    expect(file.size).toBe(encoder.encode("时间轴").length);
    expect(onProgress).toHaveBeenLastCalledWith(file.size);
  });

  it("replaces what is there, in one piece, and leaves nothing next to it", async () => {
    const { disk, folder } = await chosen();
    disk.write("文档/原子/a.json", "旧的");
    const { content, release, begun } = held("新的");
    const writing = folder.write("a.json", content);
    await begun;
    // Until all of it is there, whoever looks finds what was there.
    expect(disk.text("文档/原子/a.json")).toBe("旧的");
    expect(disk.names("文档/原子")).toEqual(["a.json", "a.json.crswap"]);
    release();
    await writing;
    expect(disk.text("文档/原子/a.json")).toBe("新的");
    expect(disk.names("文档/原子")).toEqual(["a.json"]);
  });

  it("writes in bytes and in text", async () => {
    const { disk, folder } = await chosen();
    await folder.write("a.bin", new Uint8Array([1, 2, 3]));
    await folder.write("b.txt", "文字");
    await folder.write("c.txt", new Blob(["块"]));
    expect([...disk.bytes("文档/原子/a.bin")]).toEqual([1, 2, 3]);
    expect(disk.text("文档/原子/b.txt")).toBe("文字");
    expect(disk.text("文档/原子/c.txt")).toBe("块");
  });

  it("keeps a second writer out, also one of another window", async () => {
    const { disk, folder } = await chosen();
    const { content, release, begun } = held();
    const first = folder.write("a.json", content);
    await begun;
    await expect(folder.write("a.json", "另一个")).rejects.toEqual(failed("busy", "a.json"));
    disk.chooseNext("文档/原子");
    const other = (await memoryFolders(disk).choose()) as LocalFolder;
    await expect(other.write("a.json", "另一个窗口")).rejects.toEqual(failed("busy"));
    release();
    await first;
    expect(disk.text("文档/原子/a.json")).toBe("新的内容");
  });

  it("stops when asked to, and the file stays as it was", async () => {
    const { disk, folder } = await chosen();
    disk.write("文档/原子/a.json", "旧的");
    const { content, begun } = held();
    const controller = new AbortController();
    const writing = folder.write("a.json", content, { signal: controller.signal });
    await begun;
    controller.abort(new DOMException("stop", "AbortError"));
    await expect(writing).rejects.toThrow("stop");
    expect(disk.text("文档/原子/a.json")).toBe("旧的");
    expect(disk.names("文档/原子")).toEqual(["a.json"]);
  });

  it("does not start when it was stopped before", async () => {
    const { disk, folder } = await chosen();
    const controller = new AbortController();
    controller.abort(new DOMException("stop", "AbortError"));
    await expect(folder.write("a.json", "x", controller)).rejects.toThrow("stop");
    expect(disk.names("文档/原子")).toEqual([]);
  });

  it.each([
    ["halfway", { afterBytes: 3 }],
    ["as it takes the place of the file", { atClose: true }],
  ])("fails %s, and the file stays as it was", async (_, failure) => {
    const { disk, folder } = await chosen();
    disk.write("文档/原子/a.json", "旧的");
    disk.failWrites("文档/原子/a.json", failure);
    await expect(folder.write("a.json", "新的内容很长")).rejects.toEqual(failed("full", "a.json"));
    expect(disk.text("文档/原子/a.json")).toBe("旧的");
    expect(disk.names("文档/原子")).toEqual(["a.json"]);
    await folder.write("a.json", "新的内容很长");
    expect(disk.text("文档/原子/a.json")).toBe("新的内容很长");
  });

  it("leaves no empty file behind that it could not fill", async () => {
    const { disk, folder } = await chosen();
    disk.failWrites("文档/原子/scenes/a/scene.json", { name: "NoModificationAllowedError" });
    await expect(folder.write("scenes/a/scene.json", "{}")).rejects.toEqual(failed("busy"));
    expect(disk.has("文档/原子/scenes/a/scene.json")).toBe(false);
  });

  it("writes only over what it expects", async () => {
    const { disk, folder } = await chosen();
    const seen = await folder.write("a.json", "编辑器写的");
    expect(await folder.write("a.json", "第二次", { expected: seen })).toBeDefined();
    const now = await folder.file("a.json");
    disk.write("文档/原子/a.json", "外面改的");
    await expect(folder.write("a.json", "第三次", { expected: now })).rejects.toEqual(
      failed("changed", "a.json"),
    );
    expect(disk.text("文档/原子/a.json")).toBe("外面改的");
    disk.remove("文档/原子/a.json");
    await expect(folder.write("a.json", "第三次", { expected: now })).rejects.toEqual(
      failed("changed"),
    );
    expect(disk.has("文档/原子/a.json")).toBe(false);
  });

  it("makes a file only where there is none, when it expects none", async () => {
    const { disk, folder } = await chosen();
    await folder.write("new.json", "新的", { expected: "absent" });
    await expect(folder.write("new.json", "又一个", { expected: "absent" })).rejects.toEqual(
      failed("changed"),
    );
    expect(disk.text("文档/原子/new.json")).toBe("新的");
  });

  it("does not have the browser ask out of the blue once access is gone", async () => {
    const { disk, folder } = await chosen();
    disk.forgetPermissions();
    disk.grant("文档/原子", "read");
    // People just did something, and the browser would ask now if the editor wrote.
    disk.activation = true;
    await expect(folder.write("a.json", "x")).rejects.toEqual(failed("denied"));
    await expect(folder.remove("a.json")).rejects.toEqual(failed("denied"));
    await expect(folder.move("a.json", "b.json")).rejects.toEqual(failed("denied"));
    expect(await folder.status()).toBe("ask");
    expect(disk.has("文档/原子/a.json")).toBe(false);
  });

  it("says when a file is where a folder has to be", async () => {
    const { disk, folder } = await chosen();
    disk.write("文档/原子/scenes", "一个文件");
    await expect(folder.write("scenes/a/scene.json", "{}")).rejects.toEqual(failed("exists"));
    await expect(folder.write("../a.json", "{}")).rejects.toEqual(failed("refused"));
  });

  it("does not write names that Chrome refuses on Windows, which is where projects go", async () => {
    const windows = await chosen({ system: "windows" });
    await expect(windows.folder.write("第1~3集.txt", "{}")).rejects.toEqual(failed("refused"));
    const linux = await chosen({ system: "linux" });
    await linux.folder.write("第1~3集.txt", "{}");
    expect(linux.disk.text("文档/原子/第1~3集.txt")).toBe("{}");
  });

  it("says when a path is likely too long", async () => {
    const windows = await chosen({ system: "windows", depth: 200 });
    await expect(windows.folder.write(`assets/${"长".repeat(60)}.mp4`, "x")).rejects.toEqual(
      failed("too-long"),
    );
    const linux = await chosen({ system: "linux" });
    await expect(linux.folder.write(`${"字".repeat(90)}.json`, "x")).rejects.toEqual(
      failed("too-long"),
    );
  });
});

describe("writing many files", () => {
  const slow = (text: string, open: { now: number; most: number }) => {
    const bytes = encoder.encode(text);
    return new (class extends Blob {
      override stream(): ReadableStream<Uint8Array<ArrayBuffer>> {
        open.now += 1;
        open.most = Math.max(open.most, open.now);
        return new ReadableStream({
          async pull(controller) {
            await new Promise((resolve) => setTimeout(resolve, 2));
            open.now -= 1;
            controller.enqueue(bytes);
            controller.close();
          },
        });
      }
    })([bytes]);
  };

  it("writes some at the same time, and tells how far it got", async () => {
    const { disk, folder } = await chosen();
    const open = { now: 0, most: 0 };
    const files = Array.from({ length: 10 }, (_, index) => ({
      path: `timelines/t${index}/timeline.json`,
      content: slow(`时间轴 ${index}`, open),
    }));
    const onProgress = vi.fn<(written: number, total: number) => void>();
    const onWritten = vi.fn<(path: string, file: File) => void>();
    await folder.writeAll(files, { concurrency: 3, onProgress, onWritten });
    expect(open.most).toBe(3);
    expect(onProgress.mock.calls[0]).toEqual([0, 10]);
    expect(onProgress).toHaveBeenLastCalledWith(10, 10);
    expect(onWritten).toHaveBeenCalledTimes(10);
    expect(disk.text("文档/原子/timelines/t7/timeline.json")).toBe("时间轴 7");
  });

  it("stops at the first failure, once the files on their way are written", async () => {
    const { disk, folder } = await chosen();
    disk.failWrites("文档/原子/b.json");
    const files = ["a", "b", "c", "d", "e"].map((name) => ({
      path: `${name}.json`,
      content: name,
    }));
    await expect(folder.writeAll(files, { concurrency: 2 })).rejects.toEqual(failed("full"));
    expect(disk.text("文档/原子/a.json")).toBe("a");
    expect(disk.has("文档/原子/b.json")).toBe(false);
    expect(disk.has("文档/原子/e.json")).toBe(false);
  });

  it("writes a file once, with what came last for it", async () => {
    const { disk, folder } = await chosen();
    await folder.writeAll([
      { path: "a.json", content: "first" },
      { path: "a.json", content: "last" },
    ]);
    expect(disk.text("文档/原子/a.json")).toBe("last");
  });
});

describe("removing a file", () => {
  it("takes away the folders on the way that are left empty", async () => {
    const { disk, folder } = await chosen();
    disk.write("文档/原子/scenes/a/scene.json", "{}");
    disk.write("文档/原子/scenes/a/index.html", "<p>");
    disk.write("文档/原子/scenes/b/scene.json", "{}");
    await folder.remove("scenes/a/scene.json");
    expect(disk.names("文档/原子/scenes/a")).toEqual(["index.html"]);
    await folder.remove("scenes/a/index.html");
    expect(disk.names("文档/原子/scenes")).toEqual(["b"]);
    await folder.remove("scenes/b/scene.json");
    expect(disk.names("文档/原子")).toEqual([]);
    expect(await folder.status()).toBe("ready");
  });

  it("leaves a folder with anything in it, also what Chrome does not show", async () => {
    const { disk, folder } = await chosen();
    disk.write("文档/原子/code/main.js", "x");
    disk.write("文档/原子/code/aux.js", "the browser cannot see this");
    await folder.remove("code/main.js");
    expect(disk.names("文档/原子/code")).toEqual(["aux.js"]);
  });

  it("is fine with a file that is not there", async () => {
    const { folder } = await chosen();
    await folder.remove("nothing/here.json");
    await folder.remove("here.json");
  });

  it("does not take away a folder of that name", async () => {
    const { disk, folder } = await chosen();
    disk.folder("文档/原子/scenes");
    await folder.remove("scenes");
    expect(disk.has("文档/原子/scenes")).toBe(true);
  });

  it("leaves a file that is being written", async () => {
    const { disk, folder } = await chosen();
    const { content, release, begun } = held();
    const writing = folder.write("a.json", content);
    await begun;
    await expect(folder.remove("a.json")).rejects.toEqual(failed("busy"));
    release();
    await writing;
    expect(disk.text("文档/原子/a.json")).toBe("新的内容");
  });
});

describe("moving a file", () => {
  it("moves it, and takes away the folder it left empty", async () => {
    const { disk, folder } = await chosen();
    disk.write("文档/原子/scenes/a/scene.json", "片头");
    await folder.move("scenes/a/scene.json", "scenes/b/scene.json");
    expect(disk.text("文档/原子/scenes/b/scene.json")).toBe("片头");
    expect(disk.names("文档/原子/scenes")).toEqual(["b"]);
  });

  it("does not replace what is at the new place", async () => {
    const { disk, folder } = await chosen();
    disk.write("文档/原子/a.json", "要移动的");
    disk.write("文档/原子/b.json", "已经在的");
    await expect(folder.move("a.json", "b.json")).rejects.toEqual(failed("exists", "b.json"));
    expect(disk.text("文档/原子/a.json")).toBe("要移动的");
    expect(disk.text("文档/原子/b.json")).toBe("已经在的");
    disk.folder("文档/原子/c.json");
    await expect(folder.move("a.json", "c.json")).rejects.toEqual(failed("exists"));
  });

  it("does not take another case for another file on Windows", async () => {
    const { disk, folder } = await chosen({ system: "windows" });
    disk.write("文档/原子/a.json", "要移动的");
    disk.write("文档/原子/B.json", "已经在的");
    await expect(folder.move("a.json", "b.json")).rejects.toEqual(failed("exists"));
    await folder.move("a.json", "A.json");
    expect(disk.names("文档/原子").toSorted()).toEqual(["A.json", "B.json"]);
  });

  it("writes it at the new place where the browser cannot move it", async () => {
    const { disk, folder } = await chosen();
    disk.write("文档/原子/a.json", "要移动的");
    disk.refusesMoves = true;
    await folder.move("a.json", "sub/b.json");
    expect(disk.text("文档/原子/sub/b.json")).toBe("要移动的");
    expect(disk.has("文档/原子/a.json")).toBe(false);
  });

  it("says what is not there, or busy", async () => {
    const { disk, folder } = await chosen();
    await expect(folder.move("nothing.json", "b.json")).rejects.toEqual(
      failed("missing", "nothing.json"),
    );
    await expect(folder.move("no/thing.json", "b.json")).rejects.toEqual(failed("missing"));
    disk.write("文档/原子/a.json", "x");
    const { content, release, begun } = held();
    const writing = folder.write("a.json", content);
    await begun;
    await expect(folder.move("a.json", "b.json")).rejects.toEqual(failed("busy"));
    release();
    await writing;
  });
});

describe("what writing left behind", () => {
  it("is taken away for the files that are named, and nothing else", async () => {
    const { disk, folder } = await chosen({ system: "linux" });
    disk.write("文档/原子/timelines/main/timeline.json", "旧的");
    const { content, begun } = held();
    void folder.write("timelines/main/timeline.json", content).catch(() => {});
    await begun;
    disk.crash();
    disk.write("文档/原子/timelines/main/timeline.json.3.crswap", "也是");
    disk.write("文档/原子/timelines/main/notes.crswap.txt", "people's");
    disk.write("文档/原子/timelines/main/other.json.crswap", "not named");
    disk.folder("文档/原子/timelines/main/x.json.crswap");
    expect(disk.text("文档/原子/timelines/main/timeline.json")).toBe("旧的");

    const folders = memoryFolders(disk);
    disk.chooseNext("文档/原子");
    const after = (await folders.choose()) as LocalFolder;
    const removed = await after.removeLeftovers(["timelines/main/timeline.json", "x.json"]);
    expect(removed.toSorted()).toEqual([
      "timelines/main/timeline.json.3.crswap",
      "timelines/main/timeline.json.crswap",
    ]);
    expect(disk.names("文档/原子/timelines/main").toSorted()).toEqual([
      "notes.crswap.txt",
      "other.json.crswap",
      "timeline.json",
      "x.json.crswap",
    ]);
  });

  it("stays while a write uses it, of this window or of another", async () => {
    const { disk, folder } = await chosen({ system: "linux" });
    const { content, release, begun } = held();
    const writing = folder.write("a.json", content);
    await begun;
    expect(await folder.removeLeftovers(["a.json"])).toEqual([]);
    disk.chooseNext("文档/原子");
    const other = (await memoryFolders(disk).choose()) as LocalFolder;
    expect(await other.removeLeftovers(["a.json"])).toEqual([]);
    release();
    await writing;
    expect(disk.names("文档/原子")).toEqual(["a.json"]);
  });

  it("is left alone where the editor may not write", async () => {
    const { disk, folder } = await chosen({ system: "linux" });
    disk.write("文档/原子/a.json.crswap", "x");
    disk.forgetPermissions();
    disk.grant("文档/原子", "read");
    expect(await folder.removeLeftovers(["a.json"])).toEqual([]);
    expect(disk.has("文档/原子/a.json.crswap")).toBe(true);
  });
});

describe("folders that were opened", () => {
  async function opened() {
    const { disk, folders, folder } = await chosen();
    await folders.records.put({ id: "本机1", folder, project: "p1", name: "原子", openedAt: 1 });
    disk.folder("文档/别的");
    disk.chooseNext("文档/别的");
    const other = (await folders.choose()) as LocalFolder;
    await folders.records.put({
      id: "本机2",
      folder: other,
      project: "p1",
      name: "复制",
      openedAt: 2,
    });
    return { disk, folders, folder, other };
  }

  it("are there for the next page, the most recent first", async () => {
    const { disk } = await opened();
    const next: LocalFolders = memoryFolders(disk);
    const records = await next.records.list();
    expect(records.map(({ id }) => id)).toEqual(["本机2", "本机1"]);
    expect(records[1]?.folder.name).toBe("原子");
    expect(await records[1]?.folder.status()).toBe("ready");
  });

  it("are found again by their folder, and by their project", async () => {
    const { disk, folders } = await opened();
    const [entry] = await folders.dropped(disk.drop("文档/原子"));
    if (entry?.kind !== "folder") throw new Error("No folder");
    expect((await folders.records.find(entry.folder))?.id).toBe("本机1");
    disk.folder("文档/新的");
    const [fresh] = await folders.dropped(disk.drop("文档/新的"));
    expect(await folders.records.find((fresh as { folder: LocalFolder }).folder)).toBeUndefined();
    const same = await folders.records.withProject("p1");
    expect(same.map(({ id }) => id)).toEqual(["本机2", "本机1"]);
  });

  it("go off the list, and their folders stay", async () => {
    const { disk, folders } = await opened();
    await folders.records.remove("本机1");
    expect((await folders.records.list()).map(({ id }) => id)).toEqual(["本机2"]);
    expect(await folders.records.get("本机1")).toBeUndefined();
    expect(disk.has("文档/原子")).toBe(true);
  });

  it("keep only folders of this host", async () => {
    const { folders } = setup();
    const stranger = { name: "别处的" } as LocalFolder;
    await expect(
      folders.records.put({ id: "x", folder: stranger, project: "p", name: "n", openedAt: 1 }),
    ).rejects.toThrow("not a folder of this host");
  });
});

it("says what went wrong in a way people can be told about", () => {
  const error = new FolderError("too-long", "assets/很长的名字.mp4");
  expect(error).toBeInstanceOf(Error);
  expect(error.name).toBe("FolderError");
  expect(error.message).toContain("assets/很长的名字.mp4");
  expect(new FolderError("gone", "").message).toBe("gone: the folder");
});
