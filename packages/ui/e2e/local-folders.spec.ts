import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, expect, test as base, type Page } from "@playwright/test";
import { transformWithOxc } from "vite";
import type { FolderFailure, LocalEntry, LocalFolder, LocalFolders } from "../../host/src/index.ts";

/**
 * The folders of the host on a real disk, as Chromium has them: the File System Access API and
 * FileSystemObserver, with the files changed from outside of the browser as other programs do. A
 * page gets a folder only by people choosing or dropping one, so the folder comes in by dropping it,
 * as in transfer.spec.ts. The page is an empty one with the host loaded from its source, without the
 * editor around it.
 *
 * Playwright's Chromium cannot ask people, and does not let a page write a folder that was dropped.
 * With experimental web platform features it lets every page write instead, which is why asking
 * and what people answer are for the unit tests on the disk in memory. So is Windows.
 */
const test = base.extend<{ errors: string[] }>({
  errors: [
    async ({ page }, use) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await use(errors);
      expect(errors).toEqual([]);
    },
    { auto: true },
  ],
});

test.use({
  headless: true,
  launchOptions: { args: ["--enable-experimental-web-platform-features"] },
});

const SOURCE = fileURLToPath(new URL("../../host/src/", import.meta.url));
const LAB = "http://localhost:5173/__local-folders/";
/** Longer than the quiet moment a watch waits for, and than the browser takes to tell. */
const QUIET_MS = 1500;

interface Lab {
  readonly folders: LocalFolders;
  readonly paths: typeof import("../../host/src/paths.ts");
  dropping: Promise<readonly LocalEntry[]> | undefined;
  dropped: readonly LocalEntry[];
  folder: LocalFolder;
  /** What was dropped first, as the browser has it, for what the folder does not do itself. */
  raw: Promise<FileSystemHandle | null> | undefined;
  handle: FileSystemDirectoryHandle;
  /** What a watch told, a batch at a time: the path, and the text there, if there is a file. */
  readonly changes: [string, string | undefined][][];
  readonly problems: FolderFailure[];
  /** The reason a `FolderError` gives, or the name of another error, or "done". */
  failureOf(work: Promise<unknown>): Promise<string>;
  /** Content that only arrives once `letGo` runs, for a write that goes on for a while. */
  held(text: string): Blob;
  letGo: () => void;
  holding: Promise<unknown> | undefined;
}

declare global {
  interface Window {
    lab: Lab;
  }
}

/** An empty page with the host in it, from its source. */
async function openLab(page: Page) {
  const prefix = new URL(LAB).pathname;
  await page.route(`${LAB}**`, async (route) => {
    const name = new URL(route.request().url()).pathname.slice(prefix.length);
    if (name === "") {
      await route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><meta charset=utf-8>",
      });
      return;
    }
    if (!/^[\w-]+\.ts$/.test(name)) {
      await route.fulfill({ status: 404 });
      return;
    }
    const source = readFileSync(join(SOURCE, name), "utf8");
    const { code } = await transformWithOxc(source, name, { lang: "ts" });
    await route.fulfill({ contentType: "text/javascript", body: code });
  });
  await page.goto(LAB);
  await page.evaluate(async (lab) => {
    const [local, paths] = await Promise.all([
      import(`${lab}local-folders.ts`),
      import(`${lab}paths.ts`),
    ]);
    const folders = local.browserLocalFolders(() => indexedDB);
    if (!folders) throw new Error("This browser cannot write to folders");
    window.lab = {
      folders,
      paths,
      dropping: undefined,
      dropped: [],
      raw: undefined,
      changes: [],
      problems: [],
      async failureOf(work) {
        try {
          await work;
          return "done";
        } catch (error) {
          return (error as { reason?: string }).reason ?? (error as Error).name;
        }
      },
      held(text) {
        const bytes = new TextEncoder().encode(text);
        const gate = new Promise<void>((resolve) => {
          window.lab.letGo = resolve;
        });
        return new (class extends Blob {
          override stream(): ReadableStream<Uint8Array<ArrayBuffer>> {
            return new ReadableStream({
              async pull(controller) {
                await gate;
                controller.enqueue(bytes);
                controller.close();
              },
            });
          }
        })([bytes]);
      },
      letGo: () => {},
      holding: undefined,
    } as Partial<Lab> as Lab;
    addEventListener("dragover", (event) => event.preventDefault());
    addEventListener("drop", (event) => {
      event.preventDefault();
      const transfer = event.dataTransfer as DataTransfer;
      const first = transfer.items[0] as DataTransferItem & {
        getAsFileSystemHandle(): Promise<FileSystemHandle | null>;
      };
      window.lab.raw = first.getAsFileSystemHandle();
      window.lab.dropping = window.lab.folders.dropped(transfer);
    });
  }, LAB);
}

/** Drops these into the page, as people drag them in from their files. */
async function drop(page: Page, ...paths: string[]) {
  const client = await page.context().newCDPSession(page);
  const data = { items: [], files: paths, dragOperationsMask: 1 };
  for (const type of ["dragEnter", "dragOver", "drop"] as const) {
    await client.send("Input.dispatchDragEvent", { type, x: 100, y: 100, data });
  }
  await client.detach();
  await page.waitForFunction(() => window.lab.dropping !== undefined);
  await page.evaluate(async () => {
    window.lab.dropped = await (window.lab.dropping as Promise<readonly LocalEntry[]>);
    window.lab.dropping = undefined;
  });
}

/** A new folder on the disk with these files, dropped into a new page and allowed to be written. */
function onDisk(files: Readonly<Record<string, string>> = {}): string {
  const disk = join(mkdtempSync(join(tmpdir(), "animaquill-local-")), "原子");
  mkdirSync(disk);
  for (const [path, text] of Object.entries(files)) put(disk, path, text);
  return disk;
}

function put(disk: string, path: string, text: string) {
  mkdirSync(dirname(join(disk, path)), { recursive: true });
  writeFileSync(join(disk, path), text);
}

async function open(page: Page, disk: string) {
  await openLab(page);
  await drop(page, disk);
  const access = await page.evaluate(async () => {
    const [entry] = window.lab.dropped;
    if (entry?.kind !== "folder") throw new Error("No folder was dropped");
    window.lab.folder = entry.folder;
    window.lab.handle = (await window.lab.raw) as FileSystemDirectoryHandle;
    return entry.folder.requestAccess();
  });
  expect(access, "this browser does not let a page write a folder that was dropped").toBe(
    "granted",
  );
}

const text = (disk: string, path: string) => readFileSync(join(disk, path), "utf8");

/** Watches what a project has, roughly: documents at the top, and what is in its folders. */
const watch = (page: Page) =>
  page.evaluate(async () => {
    const { lab } = window;
    await lab.folder.watch({
      includes: (path, kind) =>
        kind === "folder"
          ? /^(scenes|timelines)(\/.*)?$/.test(path)
          : /^(animaquill\.json|(scenes|timelines)\/.+)$/.test(path),
      async onChange(changes) {
        lab.changes.push(
          await Promise.all(
            changes.map(
              async ({ path, file }) => [path, await file?.text()] as [string, string | undefined],
            ),
          ),
        );
      },
      onProblem: (error) => lab.problems.push(error.reason),
    }).ready;
  });

const told = (page: Page) =>
  page.evaluate(() => window.lab.changes.map((batch) => batch.toSorted()));

test.describe("writing a folder on a disk", () => {
  test("replaces a file in one piece, and keeps a second writer out", async ({ page }) => {
    const disk = onDisk({ "a.json": "旧的" });
    await open(page, disk);
    await page.evaluate(() => {
      window.lab.holding = window.lab.folder.write("a.json", window.lab.held("新的内容"));
    });
    await expect.poll(() => existsSync(join(disk, "a.json.crswap"))).toBe(true);
    // Whoever looks in the meantime finds what was there.
    expect(text(disk, "a.json")).toBe("旧的");
    const second = await page.evaluate(() =>
      window.lab.failureOf(window.lab.folder.write("a.json", "另一个")),
    );
    expect(second).toBe("busy");
    // Also a writer that does not ask to have the file to itself, as in another window.
    const another = await page.evaluate(() =>
      window.lab.failureOf(
        window.lab.handle.getFileHandle("a.json").then(async (file) => {
          await (await file.createWritable()).abort();
        }),
      ),
    );
    expect(another).toBe("NoModificationAllowedError");
    await page.evaluate(async () => {
      window.lab.letGo();
      await window.lab.holding;
    });
    expect(text(disk, "a.json")).toBe("新的内容");
    expect(readdirSync(disk)).toEqual(["a.json"]);
  });

  test("stops in the middle, and the file stays as it was", async ({ page }) => {
    const disk = onDisk({ "a.json": "旧的" });
    await open(page, disk);
    const stopped = await page.evaluate(async () => {
      const controller = new AbortController();
      const writing = window.lab.folder.write("a.json", window.lab.held("新的"), {
        signal: controller.signal,
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      controller.abort(new DOMException("stop", "AbortError"));
      return window.lab.failureOf(writing);
    });
    expect(stopped).toBe("AbortError");
    expect(text(disk, "a.json")).toBe("旧的");
    expect(readdirSync(disk)).toEqual(["a.json"]);
  });

  test("writes only over what it expects", async ({ page }) => {
    const disk = onDisk({ "a.json": "旧的" });
    await open(page, disk);
    await page.evaluate(async () => {
      const file = await window.lab.folder.file("a.json");
      window.lab.holding = Promise.resolve(file);
    });
    put(disk, "a.json", "外面改的");
    const answer = await page.evaluate(async () => {
      const seen = (await window.lab.holding) as File;
      return window.lab.failureOf(
        window.lab.folder.write("a.json", "编辑器的", { expected: seen }),
      );
    });
    expect(answer).toBe("changed");
    expect(text(disk, "a.json")).toBe("外面改的");
  });

  test("writes many files at once", async ({ page }) => {
    const disk = onDisk();
    await open(page, disk);
    const milliseconds = await page.evaluate(async () => {
      const started = performance.now();
      await window.lab.folder.writeAll(
        Array.from({ length: 200 }, (_, index) => ({
          path: `timelines/t${index}/timeline.json`,
          content: JSON.stringify({ index, text: "x".repeat(1400) }),
        })),
      );
      return performance.now() - started;
    });
    expect(readdirSync(join(disk, "timelines"))).toHaveLength(200);
    expect(JSON.parse(text(disk, "timelines/t199/timeline.json")).index).toBe(199);
    test
      .info()
      .annotations.push({ type: "200 files", description: `${Math.round(milliseconds)} ms` });
  });

  test("moves a file, and never over another one", async ({ page }) => {
    const disk = onDisk({ "a.json": "要移动的", "b.json": "已经在的" });
    await open(page, disk);
    const over = await page.evaluate(() =>
      window.lab.failureOf(window.lab.folder.move("a.json", "b.json")),
    );
    expect(over).toBe("exists");
    expect(text(disk, "a.json")).toBe("要移动的");
    expect(text(disk, "b.json")).toBe("已经在的");

    await page.evaluate(() => window.lab.folder.move("a.json", "sub/c.json"));
    expect(text(disk, "sub/c.json")).toBe("要移动的");
    expect(existsSync(join(disk, "a.json"))).toBe(false);

    // Where the browser cannot move it, as Edge once could not.
    await page.evaluate(async () => {
      Object.assign(FileSystemFileHandle.prototype, {
        move: () => Promise.reject(new DOMException("not allowed", "NotAllowedError")),
      });
      await window.lab.folder.move("sub/c.json", "d.json");
    });
    expect(text(disk, "d.json")).toBe("要移动的");
    expect(readdirSync(disk).toSorted()).toEqual(["b.json", "d.json"]);
  });

  test("does not take a file that differs only in case for the same one", async ({ page }) => {
    const disk = onDisk({ "Scene.html": "大写的", "scene.html": "用户的另一个文件" });
    await open(page, disk);
    const result = await page.evaluate(() =>
      window.lab.failureOf(window.lab.folder.move("Scene.html", "scene.html")),
    );
    expect(result).toBe("exists");
    expect(text(disk, "Scene.html")).toBe("大写的");
    expect(text(disk, "scene.html")).toBe("用户的另一个文件");
    // Where nothing else is there, only the case of the name changes.
    rmSync(join(disk, "scene.html"));
    await page.evaluate(() => window.lab.folder.move("Scene.html", "scene.html"));
    expect(readdirSync(disk)).toEqual(["scene.html"]);
    expect(text(disk, "scene.html")).toBe("大写的");
  });

  test("takes away a file, and the folders it leaves empty, but nothing else", async ({ page }) => {
    const disk = onDisk({
      "scenes/a/scene.json": "{}",
      "scenes/b/scene.json": "{}",
      "code/main.js": "x",
      "code/aux.js": "the browser cannot see this",
    });
    await open(page, disk);
    await page.evaluate(async () => {
      await window.lab.folder.remove("scenes/a/scene.json");
      await window.lab.folder.remove("code/main.js");
    });
    expect(readdirSync(join(disk, "scenes"))).toEqual(["b"]);
    expect(readdirSync(join(disk, "code"))).toEqual(["aux.js"]);
  });

  test("names what it makes so that every system takes it", async ({ page }) => {
    const disk = onDisk({ "assets/aux.js": "the browser cannot see this" });
    await open(page, disk);
    const wanted = [
      "红色.webm",
      "第1~3集.mp4",
      "a~b.txt",
      "con.wav",
      "conin$",
      "aux.js",
      "一家人👨‍👩‍👧.png",
      "快捷.lnk",
      "x.{abc}",
      "尾巴. . .png",
      `${"长".repeat(100)}.mp4`,
    ];
    const names = await page.evaluate(async (all) => {
      const { folder, paths } = window.lab;
      const taken: string[] = ["aux.js"];
      for (const name of all) {
        const safe = paths.newNameFor(name, taken, "assets");
        taken.push(safe);
        await folder.write(`assets/${safe}`, name);
      }
      const listed: string[] = [];
      for await (const path of folder.list()) listed.push(path);
      return { made: taken.slice(1), listed };
    }, wanted);
    expect(names.made.toSorted()).toEqual(
      readdirSync(join(disk, "assets"))
        .filter((name) => name !== "aux.js")
        .toSorted(),
    );
    // All of them show, apart from the one that was there and is not allowed.
    expect(names.listed.toSorted()).toEqual(names.made.map((name) => `assets/${name}`).toSorted());
    const hidden = await page.evaluate(() =>
      window.lab.failureOf(window.lab.folder.read("assets/aux.js")),
    );
    expect(hidden).toBe("refused");
  });

  test("says when a name is too long for the system", async ({ page }) => {
    const disk = onDisk();
    await open(page, disk);
    const answer = await page.evaluate(() =>
      window.lab.failureOf(window.lab.folder.write(`${"x".repeat(256)}.json`, "{}")),
    );
    expect(answer).toBe("too-long");
  });
});

test.describe("reading a folder on a disk", () => {
  test("gives a file that cannot be read once it changed, and reads it again", async ({ page }) => {
    const disk = onDisk({ "a.json": "旧的" });
    await open(page, disk);
    await page.evaluate(async () => {
      const file = await window.lab.folder.file("a.json");
      window.lab.holding = Promise.resolve(file);
    });
    put(disk, "a.json", "新的");
    const after = await page.evaluate(async () => {
      const old = (await window.lab.holding) as File;
      return {
        old: await window.lab.failureOf(old.text()),
        now: await window.lab.folder.readText("a.json"),
      };
    });
    expect(after).toEqual({ old: "NotReadableError", now: "新的" });
  });

  test("knows what was dropped from inside of it", async ({ page }) => {
    const disk = onDisk({ "assets/红色.webm": "视频" });
    const outside = join(dirname(disk), "外面.webm");
    writeFileSync(outside, "别的");
    await open(page, disk);
    await page.evaluate(() => {
      window.lab.holding = Promise.resolve(window.lab.folder);
    });
    await drop(page, join(disk, "assets/红色.webm"), outside);
    const paths = await page.evaluate(async () => {
      const folder = (await window.lab.holding) as LocalFolder;
      return Promise.all(window.lab.dropped.map((entry) => folder.pathOf(entry)));
    });
    expect(paths).toEqual(["assets/红色.webm", undefined]);
  });

  test("says when the folder is not where it was, and when it is back", async ({ page }) => {
    const disk = onDisk({ "a.json": "{}" });
    await open(page, disk);
    renameSync(disk, `${disk}（旧）`);
    const gone = await page.evaluate(async () => ({
      status: await window.lab.folder.status(),
      read: await window.lab.failureOf(window.lab.folder.read("a.json")),
      write: await window.lab.failureOf(window.lab.folder.write("b.json", "{}")),
    }));
    expect(gone).toEqual({ status: "gone", read: "gone", write: "gone" });
    renameSync(`${disk}（旧）`, disk);
    expect(await page.evaluate(() => window.lab.folder.status())).toBe("ready");
  });
});

test.describe("what writing leaves behind on a disk", () => {
  test("is taken away for the files that are named, and only that", async ({ page }) => {
    const disk = onDisk({
      "timelines/main/timeline.json": "{}",
      "timelines/main/timeline.json.crswap": "left",
      "timelines/main/timeline.json.1.crswap": "left",
      "timelines/main/other.json.crswap": "not named",
      "timelines/main/notes.crswap.txt": "people's",
    });
    mkdirSync(join(disk, "timelines/main/x.json.crswap"));
    await open(page, disk);
    const removed = await page.evaluate(() =>
      window.lab.folder.removeLeftovers(["timelines/main/timeline.json", "timelines/main/x.json"]),
    );
    expect(removed.toSorted()).toEqual([
      "timelines/main/timeline.json.1.crswap",
      "timelines/main/timeline.json.crswap",
    ]);
    expect(readdirSync(join(disk, "timelines/main")).toSorted()).toEqual([
      "notes.crswap.txt",
      "other.json.crswap",
      "timeline.json",
      "x.json.crswap",
    ]);
  });

  test("stays while another window writes, and goes once a browser went away writing", async ({
    page,
    context,
  }) => {
    const disk = onDisk({ "a.json": "旧的" });
    const other = await context.newPage();
    await open(other, disk);
    await other.evaluate(() => {
      window.lab.holding = window.lab.folder.write("a.json", window.lab.held("另一个窗口"));
    });
    await expect.poll(() => existsSync(join(disk, "a.json.crswap"))).toBe(true);
    await open(page, disk);
    expect(await page.evaluate(() => window.lab.folder.removeLeftovers(["a.json"]))).toEqual([]);
    await other.evaluate(async () => {
      window.lab.letGo();
      await window.lab.holding;
    });
    expect(text(disk, "a.json")).toBe("另一个窗口");

    // As when the computer or the browser crashes.
    const server = await chromium.launchServer({
      headless: true,
      args: ["--enable-experimental-web-platform-features"],
    });
    const crashing = await chromium.connect(server.wsEndpoint());
    const doomed = await crashing.newPage();
    await open(doomed, disk);
    await doomed.evaluate(() => {
      window.lab.holding = window.lab.folder.write("a.json", window.lab.held("一半"));
    });
    await expect.poll(() => existsSync(join(disk, "a.json.crswap"))).toBe(true);
    await server.kill();
    expect(text(disk, "a.json")).toBe("另一个窗口");
    // Chrome leaves it on Linux, and never takes it away.
    expect(readdirSync(disk).toSorted()).toEqual(["a.json", "a.json.crswap"]);
    expect(await page.evaluate(() => window.lab.folder.removeLeftovers(["a.json"]))).toEqual([
      "a.json.crswap",
    ]);
    expect(readdirSync(disk)).toEqual(["a.json"]);
  });
});

test.describe("a file that a browser was making when it went away", () => {
  test("is left empty, which counts as none", async ({ page }) => {
    const disk = onDisk();
    const server = await chromium.launchServer({
      headless: true,
      args: ["--enable-experimental-web-platform-features"],
    });
    const crashing = await chromium.connect(server.wsEndpoint());
    const doomed = await crashing.newPage();
    await open(doomed, disk);
    await doomed.evaluate(() => {
      window.lab.holding = window.lab.folder.write("animaquill.json", window.lab.held("{}"));
    });
    await expect.poll(() => existsSync(join(disk, "animaquill.json.crswap"))).toBe(true);
    await server.kill();
    expect(text(disk, "animaquill.json")).toBe("");
    await open(page, disk);
    const answer = await page.evaluate(() =>
      window.lab.failureOf(
        window.lab.folder.write("animaquill.json", "{}", { expected: "absent" }),
      ),
    );
    expect(answer).toBe("done");
    expect(text(disk, "animaquill.json")).toBe("{}");
    expect(
      await page.evaluate(() => window.lab.folder.removeLeftovers(["animaquill.json"])),
    ).toEqual(["animaquill.json.crswap"]);
    expect(readdirSync(disk)).toEqual(["animaquill.json"]);
  });
});

test.describe("watching a folder on a disk", () => {
  test("tells a change that kept the size and the time", async ({ page }) => {
    const disk = onDisk({ "animaquill.json": '{"v":1}' });
    const { mtime } = statSync(join(disk, "animaquill.json"));
    await open(page, disk);
    await watch(page);
    put(disk, "animaquill.json", '{"v":2}');
    utimesSync(join(disk, "animaquill.json"), mtime, mtime);
    await expect.poll(() => told(page)).toEqual([[["animaquill.json", '{"v":2}']]]);
  });

  test("says it is gone when another folder comes to its place, and tells nothing of it", async ({
    page,
  }) => {
    const disk = onDisk({ "animaquill.json": '{"id":"A"}' });
    await open(page, disk);
    await watch(page);
    renameSync(disk, `${disk}-旧`);
    mkdirSync(disk);
    writeFileSync(join(disk, "animaquill.json"), '{"id":"B"}');
    await expect.poll(() => page.evaluate(() => window.lab.problems)).toEqual(["gone"]);
    await page.waitForTimeout(QUIET_MS);
    expect(await told(page)).toEqual([]);
  });

  test("tells what other programs change, and nothing of its own", async ({ page }) => {
    const disk = onDisk({ "animaquill.json": "{}", "scenes/a/scene.json": "片头" });
    await open(page, disk);
    await watch(page);

    put(disk, "scenes/a/scene.json", "外面改的");
    await expect.poll(() => told(page)).toEqual([[["scenes/a/scene.json", "外面改的"]]]);

    await page.evaluate(async () => {
      await window.lab.folder.write("scenes/a/scene.json", "编辑器写的");
      await window.lab.folder.write("scenes/b/scene.json", "编辑器新建的");
      await window.lab.folder.remove("animaquill.json");
    });
    put(disk, "README.md", "不相干");
    await page.waitForTimeout(QUIET_MS);
    expect(await told(page)).toHaveLength(1);

    renameSync(join(disk, "scenes/b/scene.json"), join(disk, "scenes/b/renamed.json"));
    await expect
      .poll(async () => (await told(page)).at(-1))
      .toEqual([
        ["scenes/b/renamed.json", "编辑器新建的"],
        ["scenes/b/scene.json", undefined],
      ]);

    rmSync(join(disk, "scenes/a"), { recursive: true });
    await expect
      .poll(async () => (await told(page)).at(-1))
      .toEqual([["scenes/a/scene.json", undefined]]);
  });

  test("finds what came in with a folder, which Linux says nothing about", async ({ page }) => {
    const disk = onDisk({ "scenes/a/scene.json": "片头" });
    await open(page, disk);
    await watch(page);
    const elsewhere = join(dirname(disk), "别处");
    put(elsewhere, "c/scene.json", "带进来的");
    put(elsewhere, "c/index.html", "<p>");
    renameSync(join(elsewhere, "c"), join(disk, "scenes/c"));
    await expect
      .poll(() => told(page))
      .toEqual([
        [
          ["scenes/c/index.html", "<p>"],
          ["scenes/c/scene.json", "带进来的"],
        ],
      ]);
  });

  test("finds what the browser does not tell when the window comes to the front", async ({
    page,
  }) => {
    const disk = onDisk({ "animaquill.json": "{}" });
    await open(page, disk);
    await watch(page);
    // Through another name of the file, outside of the folder: Linux tells nothing about it. Only
    // a new time is no change, since what is in the file is the same.
    const later = new Date(Date.now() + 60_000);
    utimesSync(join(disk, "animaquill.json"), later, later);
    const elsewhere = join(dirname(disk), "另一个名字.json");
    linkSync(join(disk, "animaquill.json"), elsewhere);
    writeFileSync(elsewhere, '{"改":"了"}');
    await page.waitForTimeout(QUIET_MS);
    expect(await told(page)).toEqual([]);
    await page.evaluate(() => dispatchEvent(new Event("focus")));
    await expect.poll(() => told(page)).toEqual([[["animaquill.json", '{"改":"了"}']]]);
  });

  test("says when the folder goes away", async ({ page }) => {
    const disk = onDisk({ "animaquill.json": "{}" });
    await open(page, disk);
    await watch(page);
    renameSync(disk, `${disk}（改了名）`);
    await expect.poll(() => page.evaluate(() => window.lab.problems)).toEqual(["gone"]);
  });
});

test.describe("folders that were opened", () => {
  test("are there for the next page, and found again when they are dropped", async ({ page }) => {
    const disk = onDisk({ "animaquill.json": "{}" });
    await open(page, disk);
    await page.evaluate(() =>
      window.lab.folders.records.put({
        id: "本机1",
        folder: window.lab.folder,
        project: "p1",
        name: "原子",
        openedAt: Date.now(),
      }),
    );
    // The next page.
    await openLab(page);
    const kept = await page.evaluate(async () => {
      const [record] = await window.lab.folders.records.list();
      return {
        id: record?.id,
        name: record?.folder.name,
        status: await record?.folder.status(),
        text: await record?.folder.readText("animaquill.json"),
      };
    });
    expect(kept).toEqual({ id: "本机1", name: "原子", status: "ready", text: "{}" });
    await drop(page, disk);
    const found = await page.evaluate(async () => {
      const [entry] = window.lab.dropped;
      if (entry?.kind !== "folder") return undefined;
      return (await window.lab.folders.records.find(entry.folder))?.id;
    });
    expect(found).toBe("本机1");
  });
});
