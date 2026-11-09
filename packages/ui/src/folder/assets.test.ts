/**
 * The files of the assets of a project folder: found by their paths, hashed once for each size and
 * time, copied in under their own names, compared with what the project says, and watched.
 */
import { ProjectStore } from "@animaquill/core";
import type { LocalFolder, LocalFolders } from "@animaquill/host";
import { MemoryDisk, memoryFolders } from "@animaquill/host/memory";
import { hashFile } from "@animaquill/media";
import { createProject, type Asset } from "@animaquill/schema";
import { describe, expect, it, vi } from "vitest";
import { hasherHere, type Hasher } from "../media/hasher.ts";
import { MemoryLibrary } from "../workbench/memory-library.ts";
import { FolderAssets } from "./assets.ts";

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

async function setup(options: { hasher?: Hasher } = {}) {
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
  const add = (id: string, asset: Partial<Asset> & { path: string }) => {
    const result = store.execute({
      type: "asset.add",
      params: { id, asset: { kind: "video", storage: "local", ...asset } },
    });
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
    add("remote", {
      path: "assets/loop.wav",
      kind: "audio",
      storage: "remote",
      url: "https://storage.example.com/loop.wav",
    });
    expect(await assets.check(store)).toEqual([
      { kind: "changed", asset: "changed", path: "assets/changed.webm" },
      { kind: "missing", asset: "missing", path: "assets/missing.webm" },
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
