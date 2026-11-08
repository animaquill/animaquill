import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FolderWatcher, type WatchedFolder } from "./folder-watch.ts";
import type { DirectoryHandleLike } from "./handles.ts";
import type { FolderChange, FolderError, LocalFolder, WatchOptions } from "./index.ts";
import { MemoryDisk, memoryFolders, type MemoryDiskOptions } from "./memory-disk.ts";

const PROJECT = "文档/原子";

/** What a project has, roughly: documents at the top, and what is in its folders. */
const includes: WatchOptions["includes"] = (path, kind) =>
  kind === "folder"
    ? /^(scenes|timelines)(\/.*)?$/.test(path)
    : /^(animaquill\.json|assets\.json|(scenes|timelines)\/.+)$/.test(path);

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

interface Watched {
  readonly disk: MemoryDisk;
  readonly folder: LocalFolder;
  readonly watch: ReturnType<LocalFolder["watch"]>;
  /** What was told, a batch at a time: the path, and whether a file is there. */
  readonly told: (readonly (readonly [string, string | undefined])[])[];
  /** For each batch, whether the folder was still changing when it was told. */
  readonly stillChanging: (boolean | undefined)[];
  readonly problems: FolderError[];
}

async function watched(
  options: MemoryDiskOptions & {
    readonly observes?: boolean;
    readonly files?: readonly string[];
    readonly onChange?: (changes: readonly FolderChange[]) => Promise<void>;
  } = {},
): Promise<Watched> {
  const disk = new MemoryDisk(options);
  disk.observes = options.observes ?? true;
  disk.write(`${PROJECT}/animaquill.json`, "{}", { quietly: true });
  disk.write(`${PROJECT}/scenes/a/scene.json`, "片头", { quietly: true });
  disk.write(`${PROJECT}/assets/红色.webm`, "视频", { quietly: true });
  disk.chooseNext(PROJECT);
  const folder = (await memoryFolders(disk).choose()) as LocalFolder;
  const told: Watched["told"] = [];
  const stillChanging: Watched["stillChanging"] = [];
  const problems: FolderError[] = [];
  const watch = folder.watch({
    includes,
    ...(options.files && { files: () => options.files ?? [] }),
    async onChange(changes, batch) {
      const found = await Promise.all(
        changes.map(async ({ path, file }) => [path, await file?.text()] as const),
      );
      told.push(found);
      stillChanging.push(batch?.stillChanging);
      await options.onChange?.(changes);
    },
    onProblem: (error) => problems.push(error),
  });
  await watch.ready;
  return { disk, folder, watch, told, stillChanging, problems };
}

/** Long enough for the folder to be quiet for a moment. */
const quiet = () => vi.advanceTimersByTimeAsync(600);

describe("watching a folder", () => {
  it("tells what another program changed, once it is quiet", async () => {
    const { disk, told } = await watched();
    disk.write(`${PROJECT}/scenes/a/scene.json`, "新的片头");
    await vi.advanceTimersByTimeAsync(400);
    expect(told).toEqual([]);
    await quiet();
    expect(told).toEqual([[["scenes/a/scene.json", "新的片头"]]]);
  });

  it("tells about a batch of changes at once", async () => {
    const { disk, told } = await watched();
    disk.write(`${PROJECT}/animaquill.json`, '{"v":2}');
    await vi.advanceTimersByTimeAsync(300);
    disk.write(`${PROJECT}/scenes/b/scene.json`, "新场景");
    await vi.advanceTimersByTimeAsync(300);
    disk.remove(`${PROJECT}/scenes/a/scene.json`);
    await quiet();
    expect(told).toHaveLength(1);
    expect(told[0]?.toSorted()).toEqual([
      ["animaquill.json", '{"v":2}'],
      ["scenes/a/scene.json", undefined],
      ["scenes/b/scene.json", "新场景"],
    ]);
  });

  it("waits for what goes on for a while to be over, such as a checkout", async () => {
    const { disk, told, stillChanging } = await watched();
    for (let round = 0; round < 20; round++) {
      disk.write(`${PROJECT}/scenes/a/scene.json`, `第 ${round} 次`);
      await vi.advanceTimersByTimeAsync(400);
    }
    expect(told).toEqual([]);
    await quiet();
    expect(told).toEqual([[["scenes/a/scene.json", "第 19 次"]]]);
    expect(stillChanging).toEqual([false]);
  });

  it("tells what changed after half a minute of changes, and that it still changes", async () => {
    const { disk, told, stillChanging } = await watched();
    for (let round = 0; round < 80; round++) {
      disk.write(`${PROJECT}/scenes/a/scene.json`, `第 ${round} 次`);
      await vi.advanceTimersByTimeAsync(400);
    }
    expect(told).toHaveLength(1);
    expect(stillChanging).toEqual([true]);
    await quiet();
    expect(told.at(-1)).toEqual([["scenes/a/scene.json", "第 79 次"]]);
    expect(stillChanging).toEqual([true, false]);
  });

  it("tells a change that kept the size and the time, when the browser tells about it", async () => {
    const { disk, told } = await watched();
    disk.write(`${PROJECT}/animaquill.json`, "[]", { keepTime: true });
    await quiet();
    expect(told).toEqual([[["animaquill.json", "[]"]]]);
  });

  it("tells about a file it was told about that comes back", async () => {
    const { disk, told } = await watched({ files: ["assets/片头.mp4"] });
    disk.write(`${PROJECT}/assets/片头.mp4`, "回来了");
    await quiet();
    expect(told).toEqual([[["assets/片头.mp4", "回来了"]]]);
  });

  it("looks again a while later at a file it could not look at", async () => {
    const { disk, told } = await watched();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const cannot = () => {
      throw new DOMException("busy", "NoModificationAllowedError");
    };
    disk.onNext("getFile", `${PROJECT}/animaquill.json`, cannot);
    disk.onNext("getFile", `${PROJECT}/animaquill.json`, cannot);
    disk.write(`${PROJECT}/animaquill.json`, "后来能读了");
    await quiet();
    expect(told).toEqual([]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(told).toEqual([[["animaquill.json", "后来能读了"]]]);
  });

  it("says nothing about what it wrote itself", async () => {
    const { disk, folder, told } = await watched();
    await folder.write("scenes/a/scene.json", "编辑器写的");
    await folder.write("scenes/c/scene.json", "编辑器新建的");
    await folder.move("scenes/c/scene.json", "scenes/d/scene.json");
    await folder.remove("animaquill.json");
    await quiet();
    expect(told).toEqual([]);
    disk.write(`${PROJECT}/scenes/a/scene.json`, "外面改的");
    await quiet();
    expect(told).toEqual([[["scenes/a/scene.json", "外面改的"]]]);
  });

  it("does not take a write of its own for a change while it is not done", async () => {
    const { folder, told } = await watched();
    let release = () => {};
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    // The file is in place, and the write still reads it back: that is when the browser tells.
    const content = new (class extends Blob {
      override async arrayBuffer(): Promise<ArrayBuffer> {
        await waiting;
        return super.arrayBuffer();
      }
    })(["编辑器写的"]);
    const writing = folder.write("scenes/a/scene.json", content);
    await quiet();
    await quiet();
    expect(told).toEqual([]);
    release();
    await writing;
    await quiet();
    expect(told).toEqual([]);
  });

  it("leaves out what does not matter, and does not wait for it", async () => {
    const { disk, told } = await watched();
    disk.write(`${PROJECT}/README.md`, "说明");
    disk.write(`${PROJECT}/.git/index`, "git");
    disk.write(`${PROJECT}/assets/新素材.png`, "图");
    await quiet();
    expect(told).toEqual([]);
    disk.write(`${PROJECT}/scenes/a/scene.json`, "改了");
    await vi.advanceTimersByTimeAsync(300);
    for (let round = 0; round < 5; round++) {
      disk.write(`${PROJECT}/.git/index`, `git ${round}`);
      await vi.advanceTimersByTimeAsync(100);
    }
    await vi.advanceTimersByTimeAsync(150);
    expect(told).toEqual([[["scenes/a/scene.json", "改了"]]]);
  });

  it("looks at the files it was told about, such as assets", async () => {
    const { disk, told } = await watched({ files: ["assets/红色.webm"] });
    disk.write(`${PROJECT}/assets/红色.webm`, "换了的视频");
    disk.write(`${PROJECT}/assets/别的.webm`, "别的");
    await quiet();
    expect(told).toEqual([[["assets/红色.webm", "换了的视频"]]]);
  });

  it("tells about both ends of a move", async () => {
    const { disk, told } = await watched();
    disk.move(`${PROJECT}/scenes/a/scene.json`, `${PROJECT}/scenes/a/scene2.json`);
    await quiet();
    expect(told[0]?.toSorted()).toEqual([
      ["scenes/a/scene.json", undefined],
      ["scenes/a/scene2.json", "片头"],
    ]);
  });

  it("finds what came in with a folder, which Linux says nothing about", async () => {
    const { disk, told } = await watched({ system: "linux" });
    disk.write("文档/别处/b/scene.json", "带进来的", { quietly: true });
    disk.write("文档/别处/b/index.html", "<p>", { quietly: true });
    disk.move("文档/别处/b", `${PROJECT}/scenes/b`);
    await quiet();
    expect(told[0]?.toSorted()).toEqual([
      ["scenes/b/index.html", "<p>"],
      ["scenes/b/scene.json", "带进来的"],
    ]);
  });

  it("finds what went with a folder", async () => {
    const { disk, told } = await watched();
    disk.write(`${PROJECT}/scenes/a/index.html`, "<p>");
    await quiet();
    told.length = 0;
    disk.move(`${PROJECT}/scenes/a`, "文档/回收站/a");
    await quiet();
    expect(told[0]?.toSorted()).toEqual([
      ["scenes/a/index.html", undefined],
      ["scenes/a/scene.json", undefined],
    ]);
  });

  it("takes a name in another case for the one it knows, on Windows", async () => {
    const { disk, told } = await watched({ system: "windows" });
    disk.remove(`${PROJECT}/scenes/a/scene.json`, { quietly: true });
    disk.write(`${PROJECT}/Scenes/A/Scene.json`, "大写", { quietly: true });
    disk.tell("modified", `${PROJECT}/Scenes/A/Scene.json`);
    await quiet();
    expect(told).toEqual([[["scenes/a/scene.json", "大写"]]]);
  });

  it("waits for what it told about before it tells more", async () => {
    let finish = () => {};
    const taking = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const onChange = vi.fn(() => taking);
    const { disk, told } = await watched({ onChange });
    disk.write(`${PROJECT}/animaquill.json`, "1");
    await quiet();
    disk.write(`${PROJECT}/animaquill.json`, "2");
    await quiet();
    expect(onChange).toHaveBeenCalledTimes(1);
    finish();
    await quiet();
    expect(told).toEqual([[["animaquill.json", "1"]], [["animaquill.json", "2"]]]);
  });

  it("tells right away when asked to", async () => {
    const { disk, watch, told } = await watched();
    disk.write(`${PROJECT}/animaquill.json`, "现在");
    await Promise.resolve();
    await watch.flush();
    expect(told).toEqual([[["animaquill.json", "现在"]]]);
  });

  it("says nothing more once it is stopped", async () => {
    const { disk, watch, told } = await watched();
    watch.stop();
    disk.write(`${PROJECT}/animaquill.json`, "停了以后");
    disk.front();
    await quiet();
    expect(told).toEqual([]);
  });
});

describe("what the browser misses", () => {
  it("is found when the window comes to the front again", async () => {
    const { disk, told } = await watched();
    disk.missesChanges = true;
    disk.write(`${PROJECT}/scenes/a/scene.json`, "漏掉的");
    disk.write(`${PROJECT}/timelines/main/timeline.json`, "新的时间轴");
    await quiet();
    expect(told).toEqual([]);
    disk.front();
    await quiet();
    expect(told[0]?.toSorted()).toEqual([
      ["scenes/a/scene.json", "漏掉的"],
      ["timelines/main/timeline.json", "新的时间轴"],
    ]);
  });

  it("is found when the browser says it lost track", async () => {
    const { disk, told } = await watched();
    disk.missesChanges = true;
    disk.write(`${PROJECT}/animaquill.json`, "漏掉的");
    disk.missesChanges = false;
    disk.tell("unknown", PROJECT);
    await quiet();
    expect(told).toEqual([[["animaquill.json", "漏掉的"]]]);
  });

  it("is found by looking every so often where the browser tells nothing", async () => {
    const { disk, told } = await watched({ observes: false });
    disk.write(`${PROJECT}/animaquill.json`, "没人说");
    await quiet();
    expect(told).toEqual([]);
    await vi.advanceTimersByTimeAsync(10_000);
    await quiet();
    expect(told).toEqual([[["animaquill.json", "没人说"]]]);
  });

  it("is not looked for while nobody can see the window", async () => {
    const { disk, told } = await watched({ observes: false });
    disk.hidden = true;
    disk.write(`${PROJECT}/animaquill.json`, "看不见");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(told).toEqual([]);
    disk.front();
    await quiet();
    expect(told).toEqual([[["animaquill.json", "看不见"]]]);
  });

  it("is found by looking again, by what is in a file and not by its time", async () => {
    const { disk, watch, told } = await watched();
    disk.touch(`${PROJECT}/animaquill.json`);
    await watch.rescan();
    expect(told).toEqual([]);
    disk.missesChanges = true;
    disk.write(`${PROJECT}/animaquill.json`, "改了");
    await watch.rescan();
    expect(told).toEqual([[["animaquill.json", "改了"]]]);
  });
});

describe("a folder that goes away", () => {
  it("ends the watch, and says so", async () => {
    const { disk, told, problems } = await watched();
    disk.move(PROJECT, "文档/改了名");
    await quiet();
    expect(problems).toEqual([expect.objectContaining({ reason: "gone" })]);
    disk.move("文档/改了名", PROJECT);
    disk.write(`${PROJECT}/animaquill.json`, "回来以后");
    disk.front();
    await quiet();
    expect(told).toEqual([]);
  });

  it("says it is gone when another folder comes to its place, and tells nothing of that one", async () => {
    const { disk, told, problems } = await watched();
    disk.move(PROJECT, "文档/原子-旧");
    disk.write(`${PROJECT}/animaquill.json`, '{"id":"另一个项目"}', { quietly: true });
    await quiet();
    expect(problems).toEqual([expect.objectContaining({ reason: "gone" })]);
    disk.front();
    await quiet();
    expect(told).toEqual([]);
  });

  it("says it is gone once the browser stops watching, whatever is there", async () => {
    const { disk, told, problems } = await watched();
    disk.tell("errored", PROJECT);
    await quiet();
    expect(problems).toEqual([expect.objectContaining({ reason: "gone" })]);
    disk.write(`${PROJECT}/animaquill.json`, "之后改的");
    disk.front();
    await quiet();
    expect(told).toEqual([]);
  });

  it("cannot be watched at all", async () => {
    const disk = new MemoryDisk();
    disk.chooseNext(PROJECT);
    const folder = (await memoryFolders(disk).choose()) as LocalFolder;
    disk.remove(PROJECT);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const watch = folder.watch({ includes, onChange: () => {} });
    await expect(watch.ready).rejects.toMatchObject({ reason: "gone" });
  });
});

describe("a folder the editor may not see any more", () => {
  it("says so, and goes on once it may again", async () => {
    const { disk, told, problems } = await watched();
    disk.forgetPermissions();
    disk.front();
    await quiet();
    expect(problems).toEqual([expect.objectContaining({ reason: "denied" })]);
    disk.write(`${PROJECT}/animaquill.json`, "期间改的");
    disk.grant(PROJECT);
    disk.front();
    await quiet();
    expect(told).toEqual([[["animaquill.json", "期间改的"]]]);
  });
});

describe("writes of its own while it looks", () => {
  it("are not taken for changes, however the two fall", async () => {
    vi.useRealTimers();
    let told = 0;
    for (let delay = 0; delay < 40; delay++) {
      const disk = new MemoryDisk();
      disk.write(`${PROJECT}/animaquill.json`, "{}", { quietly: true });
      for (let index = 0; index < 30; index++) {
        disk.write(`${PROJECT}/scenes/s${index}/scene.json`, "x", { quietly: true });
      }
      disk.chooseNext(PROJECT);
      const timing = { quietMs: 1, longestMs: 1000, pollMs: 60_000 };
      const folder = (await memoryFolders(disk, timing).choose()) as LocalFolder;
      const changes: string[] = [];
      const watch = folder.watch({
        includes,
        onChange: (batch) => void changes.push(...batch.map(({ path }) => path)),
      });
      await watch.ready;
      const looking = watch.rescan();
      for (let hop = 0; hop < delay; hop++) await Promise.resolve();
      await folder.write("animaquill.json", '{"new":1}');
      await looking;
      await new Promise((resolve) => setTimeout(resolve, 10));
      await watch.flush();
      if (changes.includes("animaquill.json")) told += 1;
      watch.stop();
    }
    expect(told).toBe(0);
  });
});

describe("a look that crosses a write of the folder", () => {
  it("is looked at again, so that the write is not taken for a change", async () => {
    vi.useRealTimers();
    const file = (text: string, lastModified: number) =>
      new File([text], "zz.json", { lastModified });
    let onDisk = file("旧的", 1);
    let writes = 0;
    let looking: ((found: File) => void) | undefined;
    const folder: WatchedFolder = {
      root: {} as DirectoryHandleLike,
      // The first look after the start waits for the test, with what it found then.
      look: async () => {
        const found = onDisk;
        if (!looking) return found;
        return new Promise<File>((resolve) => {
          const waiting = looking;
          looking = undefined;
          waiting?.(found);
          setTimeout(() => resolve(found), 0);
        });
      },
      async *list() {
        yield "zz.json";
      },
      isThere: async () => true,
      isWriting: () => false,
      writes: () => writes,
    };
    const told: string[] = [];
    const environment = { onFront: () => () => {}, isHidden: () => false };
    const watcher = new FolderWatcher(
      folder,
      {
        includes: () => true,
        onChange: (changes) => void told.push(...changes.map(({ path }) => path)),
      },
      environment,
      () => {},
    );
    await watcher.ready;
    const looked = new Promise<File>((resolve) => {
      looking = resolve;
    });
    const rescan = watcher.rescan();
    await looked;
    // The folder writes the file while the look has what was there before.
    writes += 1;
    onDisk = file("编辑器写的", 2);
    watcher.wrote("zz.json", { size: onDisk.size, lastModified: 2 });
    writes += 1;
    watcher.doneWriting("zz.json");
    await rescan;
    await watcher.flush();
    expect(told).toEqual([]);
    watcher.stop();
  });
});
