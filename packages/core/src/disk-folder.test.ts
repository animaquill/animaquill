import {
  type Dirent,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import * as promises from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadFixture } from "../../schema/scripts/fixture.ts";
import { diskFolder } from "./disk-folder.ts";
import { readFolder, type ReadOnlyFolder } from "./read-folder.ts";

vi.mock(import("node:fs/promises"), async (importOriginal) => {
  const real = await importOriginal();
  // A mock of it cannot say all the ways of calling it.
  const readdir = vi.fn(real.readdir) as unknown as typeof real.readdir;
  return { ...real, open: vi.fn(real.open), readdir };
});

const { open: reallyOpen, readdir: reallyList } =
  await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");

/** How Node lists a folder with what each entry is. */
type ListEntries = (path: string, options: { withFileTypes: true }) => Promise<Dirent[]>;

const SAMPLE = fileURLToPath(new URL("../../schema/fixtures/v1", import.meta.url));

const made: string[] = [];

/** A new folder on the disk with these files in it. */
function folderWith(files: Readonly<Record<string, string | Uint8Array>>): string {
  const root = mkdtempSync(join(tmpdir(), "animaquill-disk-"));
  made.push(root);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

afterEach(() => {
  for (const folder of made.splice(0)) rmSync(folder, { recursive: true, force: true });
  vi.mocked(promises.readdir).mockImplementation(reallyList);
});

async function listed(folder: ReadOnlyFolder): Promise<string[]> {
  const paths: string[] = [];
  for await (const path of folder.list()) paths.push(path);
  return paths;
}

const bytesOf = async (folder: ReadOnlyFolder, path: string) =>
  new Uint8Array(await (await folder.file(path)).arrayBuffer());

const failureOf = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (error: unknown) => error as Error & { readonly code?: string },
  );

describe("a folder on a disk", () => {
  it("lists every file, in the same order on every disk", async () => {
    const root = folderWith({
      "b.txt": "",
      "a/z.json": "",
      "a/b/c.js": "",
      "中文/名字.json": "",
      "A.txt": "",
      "空的/.keep": "",
    });
    mkdirSync(join(root, "没有文件"));
    // Node happens to sort on Linux, and other systems have orders of their own.
    vi.mocked(promises.readdir as unknown as ListEntries).mockImplementation(
      async (path, options) =>
        (await (reallyList as unknown as ListEntries)(path, options)).toReversed(),
    );
    expect(await listed(await diskFolder(root))).toEqual([
      "A.txt",
      "a/b/c.js",
      "a/z.json",
      "b.txt",
      "中文/名字.json",
      "空的/.keep",
    ]);
  });

  it("reads a file exactly as it is, with its size", async () => {
    const binary = new Uint8Array([0, 255, 254, 0xef, 0xbb, 0xbf, 10, 13]);
    const folder = await diskFolder(folderWith({ "a.bin": binary, "empty.txt": "" }));
    const file = await folder.file("a.bin");
    expect(file.size).toBe(binary.length);
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(binary);
    expect((await folder.file("empty.txt")).size).toBe(0);
    expect(await bytesOf(folder, "empty.txt")).toEqual(new Uint8Array());
  });

  it("leaves out links, and what is behind them, and reads nothing through one", async () => {
    const outside = folderWith({ "secret.txt": "不是项目的", "folder/x.txt": "x" });
    const root = folderWith({ "a.txt": "a" });
    symlinkSync(join(outside, "secret.txt"), join(root, "link.txt"));
    symlinkSync(join(outside, "folder"), join(root, "linked"));
    symlinkSync(join(root, "a.txt"), join(root, "inner.txt"));
    symlinkSync(join(root, "nowhere"), join(root, "broken.txt"));
    const folder = await diskFolder(root);
    expect(await listed(folder)).toEqual(["a.txt"]);
    for (const path of ["link.txt", "linked/x.txt", "inner.txt"]) {
      expect((await failureOf(folder.file(path)))?.name).toBe("NotFoundError");
    }
    expect((await failureOf(folder.file("broken.txt")))?.code).toBe("ENOENT");
  });

  it("leaves out the folders of tools, at any depth, and only those", async () => {
    const root = folderWith({
      "animaquill.json": "{}",
      ".git/HEAD": "ref",
      ".animaquill/recovered/a.json": "{}",
      "node_modules/a/index.js": "",
      "code/node_modules/b/index.js": "",
      "scenes/s/.git/x": "",
      ".github/workflow.yml": "",
      "sub/.git": "gitdir: ../.git/worktrees/sub",
      ".gitignore": "",
    });
    expect(await listed(await diskFolder(root))).toEqual([
      ".github/workflow.yml",
      ".gitignore",
      "animaquill.json",
      "sub/.git",
    ]);
  });

  it("leaves out what is no file", async () => {
    const root = folderWith({ "a.txt": "a" });
    const server = createServer();
    await new Promise<void>((resolve) => {
      server.listen(join(root, "socket"), resolve);
    });
    try {
      const folder = await diskFolder(root);
      expect(await listed(folder)).toEqual(["a.txt"]);
      expect((await failureOf(folder.file("socket")))?.name).toBe("TypeMismatchError");
    } finally {
      server.close();
    }
  });

  it("reads nothing outside of the folder, however the path is written", async () => {
    const parent = folderWith({
      "outside.txt": "外面的",
      "folder/a.txt": "a",
      "folder/sub/b.txt": "b",
    });
    const root = join(parent, "folder");
    const folder = await diskFolder(root);
    const paths = [
      "../outside.txt",
      "sub/../../outside.txt",
      join(parent, "outside.txt"),
      join(root, "a.txt"),
      "/a.txt",
      "./a.txt",
      "sub/./b.txt",
      "sub/../a.txt",
      "sub//b.txt",
      "",
      "sub/",
      "a.txt/",
    ];
    for (const path of paths) {
      const failure = await failureOf(folder.file(path));
      expect(failure, path).toBeDefined();
      expect(["NotFoundError", "ENOTDIR"], path).toContain(failure?.code ?? failure?.name);
    }
    expect(await failureOf(folder.file("a.txt\0"))).toBeInstanceOf(Error);
    expect(new TextDecoder().decode(await bytesOf(folder, "sub/b.txt"))).toBe("b");
  });

  it("takes no folder for a file, and fails for a file that is not there", async () => {
    const folder = await diskFolder(folderWith({ "sub/a.txt": "a" }));
    expect((await failureOf(folder.file("sub")))?.name).toBe("TypeMismatchError");
    expect((await failureOf(folder.file("missing.txt")))?.code).toBe("ENOENT");
  });

  it("does not read a file that is something else since it was looked at", async () => {
    const root = folderWith({ "a.txt": "原来的", "b.txt": "原来的", "c.txt": "c", "d.txt": "d" });
    const folder = await diskFolder(root);
    const same = await folder.file("a.txt");
    const longer = await folder.file("b.txt");
    const link = await folder.file("c.txt");
    const gone = await folder.file("d.txt");

    // The same size, and only the time says that it changed.
    writeFileSync(join(root, "a.txt"), "后来的");
    const { mtime } = statSync(join(root, "a.txt"));
    utimesSync(join(root, "a.txt"), mtime, new Date(mtime.getTime() + 10_000));
    expect((await failureOf(same.arrayBuffer()))?.name).toBe("NotReadableError");

    writeFileSync(join(root, "b.txt"), "原来的，后来又多了");
    expect((await failureOf(longer.arrayBuffer()))?.name).toBe("NotReadableError");

    rmSync(join(root, "c.txt"));
    symlinkSync(join(root, "d.txt"), join(root, "c.txt"));
    expect((await failureOf(link.arrayBuffer()))?.code).toBe("ELOOP");

    rmSync(join(root, "d.txt"));
    expect((await failureOf(gone.arrayBuffer()))?.code).toBe("ENOENT");
  });

  it("does not hand over a file that changes while it is being read", async () => {
    const folder = await diskFolder(folderWith({ "a.txt": "原来的内容" }));
    const file = await folder.file("a.txt");
    vi.mocked(promises.open).mockImplementationOnce(async (path, flags) => {
      const handle = await reallyOpen(path, flags);
      const shorter = {
        stat: () => handle.stat(),
        readFile: async () => (await handle.readFile()).subarray(1),
        close: () => handle.close(),
      };
      return shorter as unknown as promises.FileHandle;
    });
    expect((await failureOf(file.arrayBuffer()))?.name).toBe("NotReadableError");
    expect(new TextDecoder().decode(await file.arrayBuffer())).toBe("原来的内容");
  });

  it("is only there for a folder, which can be behind a link", async () => {
    const root = folderWith({ "a.txt": "a" });
    expect((await failureOf(diskFolder(join(root, "a.txt"))))?.name).toBe("TypeMismatchError");
    expect((await failureOf(diskFolder(join(root, "missing"))))?.code).toBe("ENOENT");

    const elsewhere = folderWith({});
    symlinkSync(root, join(elsewhere, "link"));
    const folder = await diskFolder(join(elsewhere, "link"));
    expect(await listed(folder)).toEqual(["a.txt"]);
    expect(new TextDecoder().decode(await bytesOf(folder, "a.txt"))).toBe("a");
  });

  it("can be the whole disk", async () => {
    const root = folderWith({ "a.txt": "整个磁盘" });
    const path = realpathSync(join(root, "a.txt")).slice(1);
    const folder = await diskFolder("/");
    expect(new TextDecoder().decode(await bytesOf(folder, path))).toBe("整个磁盘");
  });
});

describe("a project on a disk", () => {
  it("is what the files of the folder make, as a project reads them anywhere", async () => {
    const fixture = loadFixture("v1");
    const fromDisk = await readFolder(await diskFolder(SAMPLE));
    const fromMemory = await readFolder({
      async *list() {
        yield* fixture.keys();
      },
      async file(path) {
        const bytes = new TextEncoder().encode(fixture.get(path));
        return { size: bytes.length, arrayBuffer: async () => bytes.slice().buffer };
      },
    });
    expect(fromDisk.project).toEqual(fromMemory.project);
    expect(fromDisk.sources).toEqual(fromMemory.sources);
    expect(fromDisk.skipped).toEqual(fromMemory.skipped);
    expect(fromDisk.lost).toEqual(fromMemory.lost);
    expect(fromDisk.warnings).toEqual(fromMemory.warnings);
    expect(fromDisk.files.toSorted()).toEqual([...fixture.keys()].toSorted());
    expect(fromDisk.skipped).toEqual(["AGENTS.md", "制作笔记/分镜.md"]);
  });
});
