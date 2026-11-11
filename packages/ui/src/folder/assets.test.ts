/**
 * The files of the assets of a project folder: found by their paths, hashed once for each size and
 * time, copied in under their own names, compared with what the project says, and watched.
 */
import { ProjectStore, STORAGE, USER } from "@animaquill/core";
import type { LocalFolder, LocalFolders } from "@animaquill/host";
import { MemoryDisk, memoryFolders } from "@animaquill/host/memory";
import { hashFile } from "@animaquill/media";
import { createProject, lfsPointer, type Asset } from "@animaquill/schema";
import { describe, expect, it, vi } from "vitest";
import { hasherHere, type Hasher } from "../media/hasher.ts";
import { MemoryLibrary } from "../workbench/memory-library.ts";
import { FolderAssets, RACY_MS, type AssetProgress, type FolderAssetsOptions } from "./assets.ts";

const ROOT = "文档/原子";
const KEY = "本机1";

const bytes = (text: string) => new TextEncoder().encode(text);

/** A hasher that counts how often it reads a whole file. */
function countingHasher() {
  const reads: number[] = [];
  const hasher: Hasher = {
    file: async (file, options) => {
      reads.push(file.size);
      return hasherHere.file(file, options);
    },
    copy: (file) => hasherHere.copy(file),
  };
  return { hasher, reads };
}

async function setup(options: Partial<Omit<FolderAssetsOptions, "folder" | "key">> = {}) {
  const disk = new MemoryDisk();
  disk.folder(ROOT);
  const folders: LocalFolders = memoryFolders(disk);
  disk.chooseNext(ROOT);
  const folder = (await folders.choose()) as LocalFolder;
  const library = new MemoryLibrary();
  const assets = new FolderAssets({
    folder: () => folder,
    key: KEY,
    bases: folders.bases,
    browser: library.media(KEY),
    ...options,
  });
  const store = ProjectStore.create(createProject({ name: "原子" }));
  /** An asset, as assets.json says it: only files say where else a file is, and uploads. */
  const add = (id: string, asset: Partial<Asset> & { path: string }) => {
    const text = store.exportFiles().files.get("assets.json") ?? '{ "assets": {} }';
    const document = JSON.parse(text);
    document.assets[id] = { kind: "video", storage: "local", ...asset };
    const result = store.importFile("assets.json", JSON.stringify(document), { origin: USER });
    expect(result.ok).toBe(true);
  };
  return { disk, folders, folder, library, assets, store, add };
}

describe("the file of an asset", () => {
  it("is hashed once for each size and time, also in another window", async () => {
    const { hasher, reads } = countingHasher();
    const { disk, folders, assets } = await setup({ hasher });
    disk.write(`${ROOT}/assets/a.webm`, "一段视频");
    const hash = await hashFile(new Blob([bytes("一段视频")]));
    expect(await assets.fileAt("assets/a.webm")).toMatchObject({ kind: "there", hash });
    await assets.fileAt("assets/a.webm");
    expect(reads).toHaveLength(1);

    // Another window has the hash from what the browser keeps.
    const window2 = memoryFolders(disk);
    disk.chooseNext(ROOT);
    const again = (await window2.choose()) as LocalFolder;
    const elsewhere = new FolderAssets({
      folder: () => again,
      key: KEY,
      bases: window2.bases,
      browser: new MemoryLibrary().media(KEY),
      hasher,
    });
    await vi.waitFor(async () =>
      expect((await folders.bases.hashOf(KEY, "assets/a.webm"))?.hash).toBe(hash),
    );
    expect(await elsewhere.fileAt("assets/a.webm")).toMatchObject({ kind: "there", hash });
    expect(reads).toHaveLength(1);

    // A new time may well be new content.
    disk.touch(`${ROOT}/assets/a.webm`);
    expect(await assets.fileAt("assets/a.webm")).toMatchObject({ kind: "there", hash });
    expect(reads).toHaveLength(2);
  });

  it("is read again once when it changes while it is hashed", async () => {
    const { disk, folders, folder } = await setup();
    disk.write(`${ROOT}/assets/a.webm`, "旧的");
    let changed = false;
    const hasher: Hasher = {
      file: async (file, options) => {
        if (!changed) {
          changed = true;
          disk.write(`${ROOT}/assets/a.webm`, "新的内容");
        }
        return hasherHere.file(file, options);
      },
      copy: (file) => hasherHere.copy(file),
    };
    const assets = new FolderAssets({
      folder: () => folder,
      key: KEY,
      bases: folders.bases,
      browser: new MemoryLibrary().media(KEY),
      hasher,
    });
    expect(await assets.fileAt("assets/a.webm")).toMatchObject({
      kind: "there",
      hash: await hashFile(new Blob([bytes("新的内容")])),
    });
  });

  it("is read again where another file of the same size and time took its place", async () => {
    const { hasher, reads } = countingHasher();
    const changed: string[][] = [];
    const { disk, assets } = await setup({
      hasher,
      onChanged: (paths) => void changed.push([...paths]),
    });
    disk.write(`${ROOT}/assets/a.webm`, "红色的视频");
    await assets.fileAt("assets/a.webm");
    // As a program that puts back a file it keeps the time of.
    disk.write(`${ROOT}/assets/a.webm`, "蓝色的视频", { keepTime: true });
    expect(await assets.fileAt("assets/a.webm")).toMatchObject({
      kind: "there",
      hash: await hashFile(new Blob([bytes("蓝色的视频")])),
    });
    expect(reads).toHaveLength(2);
    expect(changed).toEqual([["assets/a.webm"]]);
  });

  it("is read again while it changed right before it was read, and once more a moment later", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { hasher, reads } = countingHasher();
      const { disk, assets } = await setup({
        hasher,
        // The clock of the editor, which the times of the disk in memory follow here.
        now: () => disk.lastModified(`${ROOT}/assets/a.webm`) + 500,
      });
      disk.write(`${ROOT}/assets/a.webm`, "刚写好的视频");
      await assets.fileAt("assets/a.webm");
      await assets.fileAt("assets/a.webm");
      // Each time: what changed so shortly before may have changed again without a new time.
      expect(reads).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(RACY_MS + 200);
      expect(reads.length).toBeGreaterThanOrEqual(3);
      assets.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("is read all through again for an export, once", async () => {
    const { hasher, reads } = countingHasher();
    const { disk, assets, store, add } = await setup({ hasher });
    disk.write(`${ROOT}/assets/a.webm`, "一段视频");
    const hash = await hashFile(new Blob([bytes("一段视频")]));
    add("a", { path: "assets/a.webm", hash });
    await assets.fileAt("assets/a.webm");
    expect(reads).toHaveLength(1);
    // The export begins after that.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const exporting = assets.media(() => store.getState().assets, { since: Date.now() });
    expect(await (await exporting.get(hash))?.text()).toBe("一段视频");
    await exporting.get(hash);
    expect(reads).toHaveLength(2);
  });

  it("says which files are read for their hashes, and which something waits for", async () => {
    let release = () => {};
    const progress: AssetProgress[] = [];
    const hasher: Hasher = {
      file: async (file, options) => {
        await new Promise<void>((resolve) => (release = resolve));
        return hasherHere.file(file, options);
      },
      copy: (file) => hasherHere.copy(file),
    };
    const { disk, assets, store, add } = await setup({
      hasher,
      onProgress: (now) => void progress.push(now),
    });
    disk.write(`${ROOT}/assets/a.webm`, "一段视频");
    const hash = await hashFile(new Blob([bytes("一段视频")]));
    add("a", { path: "assets/a.webm", hash });
    const getting = assets.media(() => store.getState().assets).get(hash);
    await vi.waitFor(() =>
      expect(progress.at(-1)).toMatchObject({
        reading: [{ path: "assets/a.webm" }],
        waiting: ["assets/a.webm"],
      }),
    );
    release();
    expect(await getting).toBeDefined();
    expect(progress.at(-1)).toEqual({ reading: [], waiting: [] });
  });

  it("is missing when nothing is at its path", async () => {
    const { assets } = await setup();
    expect(await assets.fileAt("assets/没有.webm")).toEqual({ kind: "missing" });
  });
});

describe("a file that people bring in", () => {
  it("goes into the assets folder under its own name, with its hash", async () => {
    const { disk, assets } = await setup();
    const file = new File(["红色的视频"], "红色.webm", { type: "video/webm" });
    const copied = await assets.copyIn(file);
    expect(copied).toMatchObject({ path: "assets/红色.webm", hash: await hashFile(file) });
    expect(disk.text(`${ROOT}/assets/红色.webm`)).toBe("红色的视频");
  });

  it("gets a number where the name is taken, also in another case", async () => {
    const { disk, assets } = await setup();
    disk.write(`${ROOT}/assets/红色.WEBM`, "别的");
    disk.write(`${ROOT}/assets/红色 (2).webm/里面.txt`, "一个文件夹");
    const copied = await assets.copyIn(new File(["红色的视频"], "红色.webm"));
    expect(copied.path).toBe("assets/红色 (3).webm");
    expect(disk.text(`${ROOT}/assets/红色.WEBM`)).toBe("别的");
  });

  it("takes another name while another file of that name is being written in this browser", async () => {
    const { disk, assets } = await setup();
    const one = new File(["第一台机器拍的".repeat(50)], "clip.mp4");
    const two = new File(["第二台机器拍的".repeat(50)], "clip.mp4");
    const [first, second] = await Promise.all([assets.copyIn(one), assets.copyIn(two)]);
    expect(new Set([first.path, second.path])).toEqual(
      new Set(["assets/clip.mp4", "assets/clip (2).mp4"]),
    );
    expect(disk.text(`${ROOT}/${first.path}`)).toBe("第一台机器拍的".repeat(50));
    expect(disk.text(`${ROOT}/${second.path}`)).toBe("第二台机器拍的".repeat(50));
  });

  it("takes another name when another program takes its name right then", async () => {
    const { disk, assets } = await setup();
    disk.folder(`${ROOT}/assets`);
    disk.onNext("createWritable", `${ROOT}/assets/红色.webm`, () => {
      disk.write(`${ROOT}/assets/红色.webm`, "别的程序写的");
    });
    const copied = await assets.copyIn(new File(["红色的视频"], "红色.webm"));
    expect(copied.path).toBe("assets/红色 (2).webm");
    expect(disk.text(`${ROOT}/assets/红色.webm`)).toBe("别的程序写的");
    expect(disk.text(`${ROOT}/assets/红色 (2).webm`)).toBe("红色的视频");
  });

  it("gets a name that every system takes", async () => {
    const { disk, assets } = await setup();
    const odd = await assets.copyIn(new File(["内容"], "采访:第一段?.mp4"));
    expect(odd.path).toBe("assets/采访_第一段_.mp4");
    // Windows would take this for a short name of another file.
    const short = await assets.copyIn(new File(["内容"], "第1~3集.mp4"));
    expect(short.path).not.toContain("~");
    expect(disk.has(`${ROOT}/${odd.path}`) && disk.has(`${ROOT}/${short.path}`)).toBe(true);
  });

  it("is hashed while it is written, and is known by that hash afterwards", async () => {
    const { hasher, reads } = countingHasher();
    const { assets } = await setup({ hasher });
    const copied = await assets.copyIn(new File(["红色的视频"], "红色.webm"));
    expect(reads).toHaveLength(0);
    expect(await assets.fileAt(copied.path)).toMatchObject({ kind: "there", hash: copied.hash });
    expect(reads).toHaveLength(0);
  });

  it("leaves nothing behind when the write stops", async () => {
    const { disk, assets } = await setup();
    const stopper = new AbortController();
    stopper.abort(new DOMException("stopped", "AbortError"));
    await expect(
      assets.copyIn(new File(["红色的视频"], "红色.webm"), { signal: stopper.signal }),
    ).rejects.toThrow();
    expect(disk.has(`${ROOT}/assets/红色.webm`)).toBe(false);
  });
});

describe("the files of a project folder as a media store", () => {
  it("gives an asset from its path while it is that file, and keeps the rest in the browser", async () => {
    const { disk, assets, store, add, library } = await setup();
    disk.write(`${ROOT}/assets/a.webm`, "一段视频");
    const hash = await hashFile(new Blob([bytes("一段视频")]));
    add("a", { path: "assets/a.webm", hash });
    const media = assets.media(() => store.getState().assets);
    expect(await (await media.get(hash))?.text()).toBe("一段视频");
    await expect(media.put(hash, new Blob(["x"]))).rejects.toThrow();
    await media.put(`strip-1:${hash}`, new Blob(["缩略图"]));
    expect(await (await library.media(KEY).get(`strip-1:${hash}`))?.text()).toBe("缩略图");

    disk.write(`${ROOT}/assets/a.webm`, "换过的");
    expect(await media.get(hash)).toBeUndefined();
  });
});

describe("comparing the files with the project", () => {
  it("says what is missing, what another file took the place of, and what is fine", async () => {
    const { disk, assets, store, add } = await setup();
    disk.write(`${ROOT}/assets/fine.webm`, "好的");
    disk.write(`${ROOT}/assets/changed.webm`, "换过的");
    add("fine", { path: "assets/fine.webm", hash: await hashFile(new Blob([bytes("好的")])) });
    add("changed", {
      path: "assets/changed.webm",
      hash: await hashFile(new Blob([bytes("原来的")])),
    });
    add("missing", { path: "assets/missing.webm" });
    // An address alone is not enough to get it from there: nothing checks what comes.
    add("remote", {
      path: "assets/loop.wav",
      kind: "audio",
      storage: "remote",
      url: "https://storage.example.com/loop.wav",
    });
    expect(await assets.check(store)).toEqual([
      { kind: "changed", asset: "changed", path: "assets/changed.webm" },
      { kind: "missing", asset: "missing", path: "assets/missing.webm" },
      { kind: "missing", asset: "remote", path: "assets/loop.wav" },
    ]);
  });

  it("uses the file of an asset that is kept somewhere else as well, where it is here", async () => {
    const { disk, assets, store, add } = await setup();
    const fine = await hashFile(new Blob([bytes("好的")]));
    disk.write(`${ROOT}/assets/fine.webm`, "好的");
    disk.write(`${ROOT}/assets/changed.webm`, "换过的");
    add("fine", { path: "assets/fine.webm", storage: "lfs", hash: fine, size: 6 });
    add("changed", { path: "assets/changed.webm", storage: "platform", hash: fine, size: 6 });
    expect(await assets.check(store)).toEqual([
      { kind: "changed", asset: "changed", path: "assets/changed.webm" },
    ]);
  });

  it("says where the file of an asset can come from, where it is not here, not that it is missing", async () => {
    const { assets, store, add } = await setup();
    const hash = await hashFile(new Blob([bytes("别处")]));
    add("lfs", { path: "assets/a.webm", storage: "lfs", hash, size: 6 });
    add("platform", { path: "assets/b.webm", storage: "platform", hash, size: 6 });
    const url = "https://example.com/c";
    add("remote", { path: "assets/c.webm", storage: "remote", url, hash, size: 6 });
    const issues = await assets.check(store);
    expect(issues.toSorted((a, b) => a.asset.localeCompare(b.asset))).toEqual([
      { kind: "elsewhere", asset: "lfs", path: "assets/a.webm", storage: "lfs" },
      { kind: "elsewhere", asset: "platform", path: "assets/b.webm", storage: "platform" },
      { kind: "elsewhere", asset: "remote", path: "assets/c.webm", storage: "remote" },
    ]);
  });

  it("takes the pointer of Git LFS to the file, as a clone without Git LFS has it, for a file that is not here, not for another file", async () => {
    const { disk, assets, store, add } = await setup();
    const content = "一段大视频";
    const hash = await hashFile(new Blob([bytes(content)]));
    const size = bytes(content).length;
    const pointer = lfsPointer(hash, size)!;
    disk.write(`${ROOT}/assets/a.webm`, pointer);
    add("a", { path: "assets/a.webm", storage: "lfs", hash, size });
    // Kept nowhere else, as far as the project knows: missing.
    disk.write(`${ROOT}/assets/b.webm`, pointer);
    add("b", { path: "assets/b.webm", hash, size });
    // An asset that does not know its size goes by the content.
    disk.write(`${ROOT}/assets/c.webm`, pointer);
    add("c", { path: "assets/c.webm", storage: "lfs", hash });
    // The pointer to another file, or of another size, is another file.
    const other = await hashFile(new Blob([bytes("另一段")]));
    disk.write(`${ROOT}/assets/d.webm`, lfsPointer(other, size)!);
    add("d", { path: "assets/d.webm", storage: "lfs", hash, size });
    disk.write(`${ROOT}/assets/e.webm`, lfsPointer(hash, size + 1)!);
    add("e", { path: "assets/e.webm", storage: "lfs", hash, size });
    const issues = await assets.check(store);
    expect(issues.toSorted((a, b) => a.asset.localeCompare(b.asset))).toEqual([
      { kind: "elsewhere", asset: "a", path: "assets/a.webm", storage: "lfs" },
      { kind: "missing", asset: "b", path: "assets/b.webm" },
      // Not downloadable without its size, as files from before have it: not there all the same.
      { kind: "missing", asset: "c", path: "assets/c.webm" },
      { kind: "changed", asset: "d", path: "assets/d.webm" },
      { kind: "changed", asset: "e", path: "assets/e.webm" },
    ]);
  });

  it("says that a file is missing that cannot be checked where it would come from", async () => {
    const { assets, store, add } = await setup();
    // In Git LFS as projects from before had it, without the hash or the size.
    add("old", { path: "assets/old.webm", storage: "lfs" });
    expect(await assets.check(store)).toEqual([
      { kind: "missing", asset: "old", path: "assets/old.webm" },
    ]);
  });

  it("goes by where an upload put the file, as the project has it", async () => {
    const { assets, store, add } = await setup();
    const hash = await hashFile(new Blob([bytes("传上去了")]));
    add("a", { path: "assets/a.webm", hash, size: 12 });
    expect(await assets.check(store)).toEqual([
      { kind: "missing", asset: "a", path: "assets/a.webm" },
    ]);
    const params = { asset: "a", storage: "platform", hash, owner: "u-1" };
    expect(store.execute({ type: "asset.setStorage", params }, { origin: STORAGE }).ok).toBe(true);
    expect(await assets.check(store)).toEqual([
      { kind: "elsewhere", asset: "a", path: "assets/a.webm", storage: "platform" },
    ]);
  });

  it("finds a file that is kept somewhere else as well where people moved it", async () => {
    const { disk, assets, store, add } = await setup();
    const content = "挪过来的";
    disk.write(`${ROOT}/素材/挪过来.webm`, content);
    const hash = await hashFile(new Blob([bytes(content)]));
    add("moved", { path: "assets/moved.webm", storage: "lfs", hash, size: bytes(content).length });
    expect(await assets.check(store)).toEqual([
      { kind: "missing", asset: "moved", path: "assets/moved.webm", found: "素材/挪过来.webm" },
    ]);
  });

  it("finds a missing file where people moved it, by its size and hash", async () => {
    const { disk, assets, store, add } = await setup();
    const content = "会被挪走的视频";
    disk.write(`${ROOT}/素材/挪过来.webm`, content);
    disk.write(`${ROOT}/素材/一样大.webm`, "x".repeat(bytes(content).byteLength));
    add("moved", {
      path: "assets/moved.webm",
      hash: await hashFile(new Blob([bytes(content)])),
      size: bytes(content).byteLength,
    });
    expect(await assets.check(store)).toEqual([
      { kind: "missing", asset: "moved", path: "assets/moved.webm", found: "素材/挪过来.webm" },
    ]);
  });

  it("says when the name may be why a file cannot be found", async () => {
    const { assets, store, add } = await setup();
    add("hidden", { path: "assets/desktop.ini" });
    expect(await assets.check(store)).toEqual([
      { kind: "missing", asset: "hidden", path: "assets/desktop.ini", hidden: "desktop.ini" },
    ]);
  });
});

describe("empty files in the assets folder", () => {
  it("go when no asset has them, as what a copy that stopped left, and nothing else does", async () => {
    const { disk, assets, store, add } = await setup();
    disk.write(`${ROOT}/assets/半截.webm`, "");
    disk.write(`${ROOT}/assets/空的但有用.webm`, "");
    disk.write(`${ROOT}/assets/有内容.webm`, "内容");
    disk.write(`${ROOT}/footage/空的.webm`, "");
    add("used", { path: "assets/空的但有用.webm" });
    expect(await assets.removeEmpty(store)).toEqual(["assets/半截.webm"]);
    expect(disk.has(`${ROOT}/assets/半截.webm`)).toBe(false);
    expect(disk.has(`${ROOT}/assets/空的但有用.webm`)).toBe(true);
    expect(disk.has(`${ROOT}/assets/有内容.webm`)).toBe(true);
    expect(disk.has(`${ROOT}/footage/空的.webm`)).toBe(true);
  });
});

describe("watching the files of the assets", () => {
  it("tells about files of assets that change, and new files in the assets folder", async () => {
    const { disk, assets } = await setup();
    disk.write(`${ROOT}/footage/a.webm`, "一段视频");
    const told: string[][] = [];
    const stop = assets.watch(
      () => ["footage/a.webm"],
      (paths) => void told.push([...paths]),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    disk.write(`${ROOT}/footage/a.webm`, "换过的");
    await vi.waitFor(() => expect(told.flat()).toContain("footage/a.webm"), { timeout: 3000 });
    disk.write(`${ROOT}/assets/新的.webm`, "新来的");
    await vi.waitFor(() => expect(told.flat()).toContain("assets/新的.webm"), { timeout: 3000 });
    disk.write(`${ROOT}/scenes/别的.html`, "不是素材");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(told.flat()).not.toContain("scenes/别的.html");
    stop();
  });
});
