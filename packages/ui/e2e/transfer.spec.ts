import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFolder as readInNode } from "@animaquill/core";
import { diskFolder } from "@animaquill/core/disk-folder";
import { writeProject } from "@animaquill/schema";
import type { Page } from "@playwright/test";
import { chromeRefuses } from "../../host/src/chrome-names.ts";
import { folderNameFor } from "../../host/src/paths.ts";
import { content, createProject, expect, resourcesIn, tab, test } from "./support.ts";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/** Eight bits of silence is still sound to the browser, which is all this needs. */
function wav(seconds: number): Buffer {
  const rate = 8000;
  const samples = rate * seconds;
  const data = Buffer.alloc(44 + samples);
  data.write("RIFF", 0);
  data.writeUInt32LE(36 + samples, 4);
  data.write("WAVEfmt ", 8);
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20);
  data.writeUInt16LE(1, 22);
  data.writeUInt32LE(rate, 24);
  data.writeUInt32LE(rate, 28);
  data.writeUInt16LE(1, 32);
  data.writeUInt16LE(8, 34);
  data.write("data", 36);
  data.writeUInt32LE(samples, 40);
  data.fill(128, 44);
  return data;
}

const files = {
  video: {
    name: "红色.webm",
    mimeType: "video/webm",
    buffer: readFileSync(new URL("./fixtures/red.webm", import.meta.url)),
  },
  sound: { name: "配音.wav", mimeType: "audio/wav", buffer: wav(3) },
  image: { name: "封面.png", mimeType: "image/png", buffer: PNG },
};

const items = (page: Page) => resourcesIn(page, "assets");
const clips = (page: Page) => content(page, "timeline").getByRole("option");
const dialog = (page: Page) => page.getByRole("dialog");

type FolderContent = Record<string, string>;

declare global {
  interface Window {
    /** Which folder the next "chosen" one is, below the private folder of the site. */
    chosenFolder: string;
    /** Writing this file waits for the test. */
    holdFile: string | undefined;
    release: (() => void) | undefined;
    /** Writing a file with this name fails. */
    failFile: string | undefined;
    /** Names that are refused, as on a disk. The private folder of a site has no such rules. */
    refusedNames: readonly string[];
    /** Folders cannot be removed. */
    stuck: boolean;
    /** How many more times that goes for a folder, as for a moment after stopping a write. */
    inUse: number | undefined;
    sounds: number;
    /** A folder on the disk. */
    real: FileSystemDirectoryHandle;
    realHandle: Promise<FileSystemHandle | null> | undefined;
  }
}

/**
 * Makes the real File System Access API work on the private folder of the site, because a test
 * cannot operate the dialog for choosing a folder. Applies from the next page on.
 */
const installFolders = (page: Page) =>
  page.addInitScript(() => {
    window.chosenFolder = "chosen";
    const open = async () => {
      let folder = await navigator.storage.getDirectory();
      for (const part of window.chosenFolder.split("/")) {
        folder = await folder.getDirectoryHandle(part, { create: true });
      }
      return folder;
    };
    Object.assign(window, { showDirectoryPicker: open });

    const { createWritable } = FileSystemFileHandle.prototype;
    FileSystemFileHandle.prototype.createWritable = async function create(...args) {
      if (this.name === window.failFile) throw new DOMException("no space", "QuotaExceededError");
      if (this.name === window.holdFile) {
        await new Promise<void>((resolve) => {
          window.release = resolve;
        });
      }
      return createWritable.apply(this, args);
    };
    const { removeEntry, getFileHandle } = FileSystemDirectoryHandle.prototype;
    FileSystemDirectoryHandle.prototype.removeEntry = async function remove(...args) {
      if (window.stuck) throw new DOMException("in use", "NoModificationAllowedError");
      if (window.inUse) {
        window.inUse -= 1;
        throw new DOMException("in use", "NoModificationAllowedError");
      }
      await removeEntry.apply(this, args);
    };
    FileSystemDirectoryHandle.prototype.getFileHandle = async function get(name, options) {
      if (window.refusedNames?.includes(name)) throw new TypeError("Name is not allowed.");
      return getFileHandle.call(this, name, options);
    };
  });

async function useFolders(page: Page) {
  await installFolders(page);
  await page.reload();
  await expect(tab(page, "preview")).toBeVisible();
}

const choose = (page: Page, folder: string) =>
  page.evaluate((path) => {
    window.chosenFolder = path;
  }, folder);

/** All files in a folder, with a hash of what is in them. */
const readFolder = (page: Page, folder: string) =>
  page.evaluate(async (path): Promise<FolderContent> => {
    let root = await navigator.storage.getDirectory();
    for (const part of path.split("/")) root = await root.getDirectoryHandle(part);
    const result: FolderContent = {};
    const walk = async (current: FileSystemDirectoryHandle, prefix: string) => {
      for await (const handle of current.values()) {
        if (handle.kind === "directory") await walk(handle, `${prefix}${handle.name}/`);
        else {
          const bytes = await (await handle.getFile()).arrayBuffer();
          const digest = await crypto.subtle.digest("SHA-256", bytes);
          result[`${prefix}${handle.name}`] = String(new Uint8Array(digest));
        }
      }
    };
    await walk(root, "");
    return result;
  }, folder);

const folderNames = (page: Page, folder: string) =>
  page.evaluate(async (path) => {
    let root = await navigator.storage.getDirectory();
    for (const part of path.split("/")) root = await root.getDirectoryHandle(part);
    const names: string[] = [];
    for await (const handle of root.values()) names.push(handle.name);
    return names.toSorted();
  }, folder);

const readText = (page: Page, folder: string, name: string) =>
  page.evaluate(
    async ([path, file]) => {
      let root = await navigator.storage.getDirectory();
      for (const part of (path as string).split("/")) root = await root.getDirectoryHandle(part);
      return (await (await root.getFileHandle(file as string)).getFile()).text();
    },
    [folder, name],
  );

/** Moves an exported folder to a real one, which is what people can choose to bring in. */
async function toDisk(page: Page, folder: string): Promise<string> {
  const contents = await page.evaluate(async (path) => {
    let root = await navigator.storage.getDirectory();
    for (const part of path.split("/")) root = await root.getDirectoryHandle(part);
    const result: Record<string, number[]> = {};
    const walk = async (current: FileSystemDirectoryHandle, prefix: string) => {
      for await (const handle of current.values()) {
        if (handle.kind === "directory") await walk(handle, `${prefix}${handle.name}/`);
        else {
          const bytes = await (await handle.getFile()).arrayBuffer();
          result[`${prefix}${handle.name}`] = [...new Uint8Array(bytes)];
        }
      }
    };
    await walk(root, "");
    return result;
  }, folder);
  const disk = join(mkdtempSync(join(tmpdir(), "animaquill-")), folder.split("/").at(-1) as string);
  for (const [path, bytes] of Object.entries(contents)) {
    mkdirSync(dirname(join(disk, path)), { recursive: true });
    writeFileSync(join(disk, path), Buffer.from(bytes));
  }
  return disk;
}

/** The same dialog people get, and the same files. */
async function chooseFolder(page: Page, folder: string, start: () => Promise<unknown>) {
  const chooser = page.waitForEvent("filechooser");
  await start();
  await (await chooser).setFiles(folder);
}

/** A project with scenes says so first. */
const openAnyway = (page: Page) =>
  dialog(page).getByRole("button", { name: "知道了，打开项目" }).click();

const importButton = (page: Page) => page.getByRole("button", { name: "导入项目文件夹" });
const importFrom = (page: Page, folder: string) =>
  chooseFolder(page, folder, () => startImport(page));
const importFromStart = (page: Page, folder: string) =>
  chooseFolder(page, folder, () => importButton(page).click());

/** Lets a test get at a folder on the disk the way a page does, which a dialog does not allow. */
async function holdRealFolder(page: Page, folder: string) {
  await page.evaluate(() => {
    const stop = (event: Event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    window.addEventListener("dragover", stop, true);
    window.addEventListener(
      "drop",
      (event) => {
        stop(event);
        const item = event.dataTransfer?.items[0] as DataTransferItem & {
          getAsFileSystemHandle(): Promise<FileSystemHandle | null>;
        };
        window.realHandle = item.getAsFileSystemHandle();
      },
      true,
    );
  });
  const client = await page.context().newCDPSession(page);
  const data = { items: [], files: [folder], dragOperationsMask: 1 };
  for (const type of ["dragEnter", "dragOver", "drop"] as const) {
    await client.send("Input.dispatchDragEvent", { type, x: 300, y: 300, data });
  }
  await page.waitForFunction(() => window.realHandle !== undefined);
  await page.evaluate(async () => {
    window.real = (await window.realHandle) as FileSystemDirectoryHandle;
  });
}

/** How the browser answers for names in that folder. */
const answersFor = (page: Page, names: readonly string[]) =>
  page.evaluate(
    (list) =>
      Promise.all(
        list.map(async (name) => {
          try {
            await window.real.getDirectoryHandle(name);
            return "there";
          } catch (error) {
            return (error as Error).name;
          }
        }),
      ),
    [...names],
  );

async function chooseFrom(page: Page, menu: string, item: string) {
  await page.locator("header").getByRole("button", { name: menu, exact: true }).click();
  await page.getByRole("menu").getByRole("menuitem", { name: item, exact: true }).click();
}

const startExport = (page: Page) => chooseFrom(page, "文件", "另存一份…");
const startImport = (page: Page) => chooseFrom(page, "文件", "导入项目文件夹");

async function closeDialog(page: Page) {
  await dialog(page).getByRole("button", { name: "关闭" }).click();
  await expect(dialog(page)).toHaveCount(0);
}

/** Runs an export to the end. */
async function exportProject(page: Page) {
  await startExport(page);
  await expect(dialog(page).getByRole("heading", { name: "导出完成" })).toBeVisible();
  await closeDialog(page);
}

async function bringInFiles(page: Page) {
  await tab(page, "assets").click();
  const chooser = page.waitForEvent("filechooser");
  await content(page, "assets").getByRole("button", { name: "导入" }).click();
  await (await chooser).setFiles([files.video, files.sound, files.image]);
  await expect(items(page)).toHaveCount(3);
}

/** A project with a picture, a video and sound, all on the timeline. */
async function buildProject(page: Page) {
  await bringInFiles(page);
  for (const name of ["红色.webm", "配音.wav", "封面.png"]) {
    await items(page).filter({ hasText: name }).dblclick();
  }
  await tab(page, "timeline").click();
  await content(page, "timeline").getByRole("button", { name: "添加轨道" }).click();
  await page.getByRole("menuitem", { name: "字幕轨道" }).click();
  await expect(clips(page)).toHaveCount(3);
  await saved(page);
}

const saved = (page: Page) => expect(page.locator("footer").getByText("已保存")).toBeVisible();

async function renameTo(page: Page, name: string) {
  await chooseFrom(page, "文件", "重命名项目");
  await page.getByRole("textbox", { name: "项目名称" }).fill(name);
  await page.keyboard.press("Enter");
}

async function removeProject(page: Page, name: string) {
  await chooseFrom(page, "文件", "关闭项目");
  await page.getByRole("listitem").filter({ hasText: name }).hover();
  await page.getByRole("button", { name: `删除 ${name}` }).click();
  await dialog(page).getByRole("button", { name: "删除" }).click();
  await expect(page.getByText("还没有项目")).toBeVisible();
}

/** The colour in the middle of the picture, of the preview: making thumbnails has a frame too. */
async function middle(page: Page): Promise<readonly number[]> {
  const element = await content(page, "preview").locator("iframe").elementHandle();
  const frame = await element?.contentFrame();
  if (!frame) return [];
  return frame.evaluate(() => {
    const canvas = document.querySelector("canvas");
    const data = canvas
      ?.getContext("2d")
      ?.getImageData(canvas.width / 2, canvas.height / 2, 1, 1).data;
    return data ? [...data] : [];
  });
}

const isRed = async (page: Page) => {
  const [red = 0, green = 255, blue = 255] = await middle(page);
  return red > 200 && green < 60 && blue < 60;
};

async function goTo(page: Page, time: string) {
  await page.getByRole("contentinfo").getByRole("button", { name: "当前时间和总时长" }).click();
  await page.getByRole("textbox", { name: "当前时间" }).fill(time);
  await page.keyboard.press("Enter");
}

/** What is saved in this browser. */
const stored = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<{ projects: unknown[]; media: number; updates: number }>((resolve) => {
        const open = indexedDB.open("animaquill");
        open.onsuccess = () => {
          const database = open.result;
          const transaction = database.transaction(["projects", "media", "updates"]);
          const projects = transaction.objectStore("projects").getAll();
          const media = transaction.objectStore("media").count();
          const updates = transaction.objectStore("updates").count();
          transaction.oncomplete = () => {
            database.close();
            resolve({ projects: projects.result, media: media.result, updates: updates.result });
          };
        };
      }),
  );

test.describe("a project that travels", () => {
  test.use({ onDisk: true });
  test.describe.configure({ timeout: 90_000 });

  test.beforeEach(async ({ page }) => {
    await useFolders(page);
  });

  test("comes back whole after being exported, removed and imported", async ({ page }) => {
    await page.addInitScript(() => {
      const { start } = AudioBufferSourceNode.prototype;
      window.sounds = 0;
      AudioBufferSourceNode.prototype.start = function count(...args) {
        window.sounds += 1;
        start.apply(this, args);
      };
    });
    await page.reload();
    await expect(tab(page, "preview")).toBeVisible();
    await buildProject(page);
    await expect.poll(() => isRed(page)).toBe(true);
    const labels = await clips(page).evaluateAll((list) => list.map((clip) => clip.ariaLabel));
    await goTo(page, "0:02/00");
    await page.waitForTimeout(300);
    const picture = await middle(page);

    await exportProject(page);
    const exported = await readFolder(page, "chosen/测试项目");
    expect(Object.keys(exported).filter((path) => path.startsWith("assets/"))).toHaveLength(3);
    expect(Object.keys(exported)).toContain("animaquill.json");
    expect(Object.keys(exported)).toContain("assets.json");
    expect(Object.keys(exported)).not.toContain("导出未完成.txt");
    const folder = await toDisk(page, "chosen/测试项目");

    await removeProject(page, "测试项目");
    expect((await stored(page)).media).toBe(0);
    await importFromStart(page, folder);

    await expect(page.getByText("“测试项目”已导入。")).toBeVisible();
    await expect(dialog(page)).toHaveCount(0);
    await expect(tab(page, "preview")).toBeVisible();
    await tab(page, "assets").click();
    await expect(items(page)).toHaveCount(3);
    await expect(items(page).filter({ hasText: "封面.png" }).locator("img")).toBeVisible();
    await tab(page, "timeline").click();
    await expect(clips(page)).toHaveCount(3);
    expect(await clips(page).evaluateAll((list) => list.map((clip) => clip.ariaLabel))).toEqual(
      labels,
    );

    // The picture and the sound come from the files that came in.
    await expect.poll(() => middle(page)).toEqual(picture);
    await goTo(page, "0:00/00");
    await expect.poll(() => isRed(page)).toBe(true);
    await content(page, "preview").getByRole("button", { name: "播放", exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.sounds)).toBeGreaterThan(0);
    await content(page, "preview").getByRole("button", { name: "暂停", exact: true }).click();

    // Going out again gives the same files, byte for byte.
    await choose(page, "again");
    await exportProject(page);
    expect(await readFolder(page, "again/测试项目")).toEqual(exported);
  });

  test("is still all there after a reload, without the folder it came from", async ({ page }) => {
    await buildProject(page);
    await exportProject(page);
    const folder = await toDisk(page, "chosen/测试项目");
    await removeProject(page, "测试项目");
    await importFromStart(page, folder);
    await expect(tab(page, "preview")).toBeVisible();
    await saved(page);
    rmSync(folder, { recursive: true, force: true });

    await page.reload();
    await expect(tab(page, "preview")).toBeVisible();
    await expect.poll(() => isRed(page)).toBe(true);
    await choose(page, "again");
    await exportProject(page);
    const exported = await readFolder(page, "again/测试项目");
    expect(Object.keys(exported).filter((path) => path.startsWith("assets/"))).toHaveLength(3);
  });

  test("does not take the place of the project it came from", async ({ page }) => {
    await buildProject(page);
    await exportProject(page);
    const folder = await toDisk(page, "chosen/测试项目");
    await chooseFrom(page, "文件", "重命名项目");
    await page.getByRole("textbox", { name: "项目名称" }).fill("原来的项目");
    await page.keyboard.press("Enter");
    await saved(page);
    const before = await stored(page);

    await importFrom(page, folder);
    await expect(dialog(page).getByText("这次导入成了副本")).toBeVisible();
    await closeDialog(page);

    await expect(
      page.locator("footer").getByRole("button", { name: "测试项目（副本）" }),
    ).toBeVisible();
    await tab(page, "timeline").click();
    await expect(clips(page)).toHaveCount(3);
    await expect.poll(() => isRed(page)).toBe(true);

    await chooseFrom(page, "文件", "关闭项目");
    await expect(page.getByRole("listitem")).toHaveCount(2);
    await page.getByRole("button", { name: /^原来的项目/ }).click();
    await expect(page.locator("footer").getByRole("button", { name: "原来的项目" })).toBeVisible();
    await tab(page, "timeline").click();
    await expect(clips(page)).toHaveCount(3);
    const after = await stored(page);
    expect(after.media).toBeGreaterThanOrEqual(before.media + 3);
  });

  test("never writes into a folder that is there", async ({ page }) => {
    await buildProject(page);
    await exportProject(page);
    const first = await readFolder(page, "chosen/测试项目");
    await chooseFrom(page, "文件", "重命名项目");
    await page.getByRole("textbox", { name: "项目名称" }).fill("别的名字");
    await page.keyboard.press("Enter");
    await chooseFrom(page, "文件", "重命名项目");
    await page.getByRole("textbox", { name: "项目名称" }).fill("测试项目");
    await page.keyboard.press("Enter");

    await startExport(page);
    await expect(dialog(page).getByText("“测试项目 (2)”")).toBeVisible();
    await closeDialog(page);
    expect(await readFolder(page, "chosen/测试项目")).toEqual(first);
  });

  const assetsIn = (folder: string) =>
    Object.values(
      (
        JSON.parse(readFileSync(join(folder, "assets.json"), "utf8")) as {
          assets: Record<string, { name: string; path: string }>;
        }
      ).assets,
    );

  test("opens without the files that are gone, and lists them", async ({ page }) => {
    await buildProject(page);
    await exportProject(page);
    const folder = await toDisk(page, "chosen/测试项目");
    const video = assetsIn(folder).find(({ name }) => name === "红色.webm");
    rmSync(join(folder, video?.path as string));

    await removeProject(page, "测试项目");
    await importFromStart(page, folder);

    const report = dialog(page);
    await expect(report.getByRole("heading", { name: "项目已导入" })).toBeVisible();
    await expect(report.getByText("这些素材的文件不在文件夹里（1）")).toBeVisible();
    await expect(report.getByRole("listitem")).toHaveText(["红色.webm"]);
    await expect(report.getByText(/缺失的资源.*导入同样的文件/)).toBeVisible();
    await closeDialog(page);

    await tab(page, "timeline").click();
    await expect(clips(page)).toHaveCount(3);
    await expect(page.getByText("有素材在这个浏览器里解不了或者找不到")).toBeVisible();
    await expect.poll(() => isRed(page)).toBe(false);

    // What is left can be exported again: the file is still missing, and says so.
    await choose(page, "again");
    await startExport(page);
    await expect(dialog(page).getByRole("heading", { name: /但有内容没有带上/ })).toBeVisible();
    await expect(dialog(page).getByRole("listitem")).toHaveText(["红色.webm"]);
    await closeDialog(page);
  });

  test("gets a missing file back by bringing in that very file", async ({ page }) => {
    await buildProject(page);
    await exportProject(page);
    const folder = await toDisk(page, "chosen/测试项目");
    for (const { name, path } of assetsIn(folder)) {
      if (name !== "配音.wav") rmSync(join(folder, path));
    }
    await removeProject(page, "测试项目");
    await importFromStart(page, folder);
    await expect(dialog(page).getByRole("heading", { name: "项目已导入" })).toBeVisible();
    await closeDialog(page);

    await expect.poll(() => isRed(page)).toBe(false);
    await tab(page, "assets").click();
    await expect(items(page).filter({ hasText: "封面.png" }).locator("img")).toHaveCount(0);

    const chooser = page.waitForEvent("filechooser");
    await content(page, "assets").getByRole("button", { name: "导入" }).click();
    await (await chooser).setFiles([files.video, files.image]);

    await expect.poll(() => isRed(page)).toBe(true);
    await expect(items(page).filter({ hasText: "封面.png" }).locator("img")).toBeVisible();
    await expect(items(page)).toHaveCount(3);
    await page.reload();
    await expect(tab(page, "preview")).toBeVisible();
    await expect.poll(() => isRed(page)).toBe(true);
  });

  test("cleans up what a page that went away left behind", async ({ page }) => {
    await exportProject(page);
    const folder = await toDisk(page, "chosen/测试项目");
    await removeProject(page, "测试项目");
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          const open = indexedDB.open("animaquill");
          open.onsuccess = () => {
            const database = open.result;
            const transaction = database.transaction(["projects", "media"], "readwrite");
            const project = { id: "left-behind", name: "半路", updatedAt: 1, incoming: true };
            transaction.objectStore("projects").add(project);
            const file = new Blob(["内容"]);
            transaction.objectStore("media").add({ project: "left-behind", hash: "h", file });
            transaction.oncomplete = () => {
              database.close();
              resolve();
            };
          };
        }),
    );
    await page.reload();
    await expect(page.getByText("还没有项目，新建一个开始吧。")).toBeVisible();
    await importFromStart(page, folder);
    await expect(page.getByText("“测试项目”已导入。")).toBeVisible();
    const { projects, media } = await stored(page);
    expect(projects).toEqual([expect.objectContaining({ name: "测试项目" })]);
    expect(media).toBe(0);
  });

  test("does not take in a file that changed", async ({ page }) => {
    await buildProject(page);
    await exportProject(page);
    const folder = await toDisk(page, "chosen/测试项目");
    const picture = assetsIn(folder).find(({ name }) => name === "封面.png");
    writeFileSync(join(folder, picture?.path as string), "这不是图片");

    await removeProject(page, "测试项目");
    await importFromStart(page, folder);
    const report = dialog(page);
    await expect(report.getByText(/和项目记录的内容不一样/)).toBeVisible();
    await expect(report.getByRole("listitem")).toHaveText(["封面.png"]);
    await closeDialog(page);
    await expect(tab(page, "preview")).toBeVisible();
  });

  test("does not lose what a window changes after the project was replaced", async ({
    page,
    context,
  }) => {
    await exportProject(page);
    const folder = await toDisk(page, "chosen/测试项目");
    await renameTo(page, "备份之后改过");
    await saved(page);

    const other = await context.newPage();
    await other.goto("/");
    await other.getByRole("listitem").filter({ hasText: "备份之后改过" }).hover();
    await other.getByRole("button", { name: "删除 备份之后改过" }).click();
    await dialog(other).getByRole("button", { name: "删除" }).click();
    await expect(other.getByText("还没有项目")).toBeVisible();

    // The first window finds out by saving.
    await renameTo(page, "删除之后改的");
    await expect(page.locator("footer").getByText("没有保存")).toBeVisible();

    await importFromStart(other, folder);
    await expect(other.getByText("“测试项目”已导入。")).toBeVisible();
    const before = await stored(other);
    expect(before.projects).toEqual([expect.objectContaining({ name: "测试项目" })]);

    // It tries again every five seconds, and has to go on saying that this did not work.
    await page.waitForTimeout(6000);
    await expect(page.locator("footer").getByText("没有保存")).toBeVisible();
    await expect(page.getByText("改动已经保存好了")).toHaveCount(0);
    await renameTo(page, "后面继续改的");
    await page.waitForTimeout(500);
    await expect(page.locator("footer").getByText("没有保存")).toBeVisible();
    expect(await stored(other)).toEqual(before);

    await other.reload();
    await expect(other.locator("footer").getByRole("button", { name: "测试项目" })).toBeVisible();
  });
});

test.describe("names on a real disk", () => {
  const names = [
    "我的项目",
    "第二集~",
    "~草稿",
    "你好~~",
    "第1~3集",
    "一家人👨\u200D👩\u200D👧",
    "🏳\uFE0F\u200D🌈 彩虹",
    "❤\uFE0F\u200D🔥",
    "程序员🧑\u200D💻教程",
    "项目\u3000",
    "\u3000项目",
    "项目 ",
    "复制的\u200B标题",
    "标题\uFEFF",
    "clock$",
    "clock$.txt",
    "CON",
    "aux.js",
    "com1",
    "lpt9.txt",
    "desktop.ini",
    "Thumbs.db",
    "site.url",
    "link.lnk",
    "x.scf",
    "name.local",
    "x.{abc}",
    "A~",
    "name.",
    "a.b",
    "😀".repeat(100),
    "conin$",
    "conout$",
    "conin$.txt",
    "a~b.txt",
    "第1~3集正片完整版",
  ];

  let folder: string;

  test.beforeEach(async ({ page }) => {
    folder = mkdtempSync(join(tmpdir(), "animaquill-"));
    await holdRealFolder(page, folder);
  });

  test("are what the unit tests think they are", async ({ page }) => {
    const answers = await answersFor(page, names);
    const refused = names.filter((_, index) => answers[index] === "TypeError");
    // Short names such as "第1~3集" are only refused on Windows, see chromeRefuses.
    const here = process.platform === "win32" ? ["everywhere", "windows"] : ["everywhere"];
    expect(refused).toEqual(names.filter((name) => here.includes(chromeRefuses(name) ?? "")));
  });

  test("work for every project", async ({ page }) => {
    const folders = names.map(folderNameFor);
    expect(await answersFor(page, folders)).toEqual(folders.map(() => "NotFoundError"));
  });
});

test.describe("a folder with something wrong with it", () => {
  let folder: string;

  test.beforeEach(async ({ page }) => {
    await useFolders(page);
    await buildProject(page);
    await exportProject(page);
    folder = await toDisk(page, "chosen/测试项目");
  });

  /** The project that is open is the one from before, with all of it there. */
  async function expectNothingChanged(page: Page, before: Awaited<ReturnType<typeof stored>>) {
    expect(await stored(page)).toEqual(before);
    await tab(page, "timeline").click();
    await expect(clips(page)).toHaveCount(3);
    await expect(page.locator("footer").getByRole("button", { name: "测试项目" })).toBeVisible();
    await expect.poll(() => isRed(page)).toBe(true);
  }

  test("asks about a broken file, and Enter leaves all projects alone", async ({ page }) => {
    writeFileSync(join(folder, "timelines/main/timeline.json"), "{ 不是 JSON");
    const before = await stored(page);
    await importFrom(page, folder);

    const question = dialog(page);
    await expect(question.getByRole("heading", { name: "有些内容带不过来" })).toBeVisible();
    await expect(question.getByRole("listitem").first()).toContainText("时间轴 main");
    await expect(question.getByRole("listitem").first()).toContainText("空的");
    await expect(question.getByText("timelines/main/timeline.json")).toBeVisible();
    await expect(question.getByRole("button", { name: "跳过这些继续导入" })).toBeVisible();
    await expect(question.getByRole("button", { name: "取消" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(dialog(page)).toHaveCount(0);
    await expectNothingChanged(page, before);
  });

  test("refuses a manifest that is broken, and leaves all projects alone", async ({ page }) => {
    writeFileSync(join(folder, "animaquill.json"), "{ 不是 JSON");
    const before = await stored(page);
    await importFrom(page, folder);

    const report = dialog(page);
    await expect(report.getByRole("heading", { name: "这个文件夹不能导入" })).toBeVisible();
    await expect(report.getByText("现有的项目没有改动")).toBeVisible();
    await expect(report.getByRole("listitem").first()).toContainText("animaquill.json");
    await closeDialog(page);
    await expectNothingChanged(page, before);
  });

  /** Says yes to the question, reads the report and is left with the project that came in. */
  async function skipBroken(page: Page, lost: string) {
    await importFrom(page, folder);
    await expect(dialog(page).getByText(lost).first()).toBeVisible();
    await dialog(page).getByRole("button", { name: "跳过这些继续导入" }).click();
    await expect(dialog(page).getByRole("heading", { name: "项目已导入" })).toBeVisible();
    await expect(dialog(page).getByText("原来的文件夹先不要删")).toBeVisible();
    await expect(dialog(page).getByText(lost).first()).toBeVisible();
    await closeDialog(page);
    await expect(
      page.locator("footer").getByRole("button", { name: "测试项目（副本）" }),
    ).toBeVisible();
  }

  /** Whatever went missing, the project goes out and comes back without a question. */
  async function comesBackWhole(page: Page) {
    await saved(page);
    await exportProject(page);
    const again = await toDisk(page, "chosen/测试项目（副本）");
    await importFrom(page, again);
    await expect(dialog(page).getByRole("heading", { name: "有些内容带不过来" })).toHaveCount(0);
    await expect(dialog(page).getByRole("heading", { name: "项目已导入" })).toBeVisible();
    await closeDialog(page);
  }

  test("skips a broken timeline, and what is left can be used", async ({ page }) => {
    writeFileSync(join(folder, "timelines/main/timeline.json"), "{ 不是 JSON");
    const before = await stored(page);
    await skipBroken(page, "时间轴 main");
    await tab(page, "timeline").click();
    await expect(clips(page)).toHaveCount(0);
    await tab(page, "assets").click();
    await expect(items(page)).toHaveCount(3);
    await comesBackWhole(page);
    expect((await stored(page)).projects.length).toBeGreaterThan(before.projects.length);
  });

  test("skips the list of assets, and clips without media do not stop anything", async ({
    page,
  }) => {
    writeFileSync(join(folder, "assets.json"), "{ 不是 JSON");
    await skipBroken(page, "所有素材");
    await tab(page, "timeline").click();
    await expect(clips(page)).toHaveCount(3);
    await tab(page, "assets").click();
    await expect(items(page)).toHaveCount(0);

    // All of it is drawn and played without what it refers to.
    await tab(page, "timeline").click();
    await clips(page).first().click({ force: true });
    await expect(clips(page).first()).toHaveAttribute("aria-selected", "true");
    await tab(page, "properties").click();
    await tab(page, "timeline").click();
    await page.keyboard.press("Space");
    await page.keyboard.press("Space");
    await comesBackWhole(page);
  });

  test("refuses a project from a newer editor", async ({ page }) => {
    const path = join(folder, "animaquill.json");
    const manifest = JSON.parse(readFileSync(path, "utf8")) as { formatVersion: number };
    manifest.formatVersion = 2;
    writeFileSync(path, JSON.stringify(manifest));
    const before = await stored(page);
    await importFrom(page, folder);
    await expect(dialog(page).getByText(/版本 2.*刷新页面/)).toBeVisible();
    await closeDialog(page);
    await expectNothingChanged(page, before);
  });

  test("says when a folder is no project", async ({ page }) => {
    const other = join(tmpdir(), `假期照片-${Date.now()}`);
    mkdirSync(other);
    writeFileSync(join(other, "a.jpg"), "x");
    const before = await stored(page);
    await importFrom(page, other);
    await expect(dialog(page).getByText("不是项目文件夹")).toBeVisible();
    await closeDialog(page);
    await expectNothingChanged(page, before);
  });

  test("finds the project when people choose the folder around it", async ({ page }) => {
    await importFrom(page, dirname(folder));
    await expect(dialog(page).getByText("这次导入成了副本")).toBeVisible();
    await closeDialog(page);
    await expect(
      page.locator("footer").getByRole("button", { name: "测试项目（副本）" }),
    ).toBeVisible();
  });
});

test.describe("an export that does not get to the end", () => {
  test.beforeEach(async ({ page }) => {
    await useFolders(page);
    await buildProject(page);
  });

  test("can be cancelled, and leaves nothing", async ({ page }) => {
    await page.evaluate(() => {
      window.holdFile = "assets.json";
    });
    await startExport(page);
    const progress = dialog(page);
    await expect(progress.getByRole("heading", { name: "正在导出“测试项目”" })).toBeVisible();
    await expect(progress.getByRole("progressbar")).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.release !== undefined)).toBe(true);
    expect(await folderNames(page, "chosen/测试项目")).toContain("导出未完成.txt");
    expect(await folderNames(page, "chosen/测试项目")).not.toContain("animaquill.json");

    await progress.getByRole("button", { name: "取消" }).click();
    await expect(progress.getByText("正在停下来")).toBeVisible();
    await page.evaluate(() => window.release?.());

    await expect(page.getByText("导出已取消。")).toBeVisible();
    await expect(dialog(page)).toHaveCount(0);
    expect(await folderNames(page, "chosen")).toEqual([]);
  });

  test("leaves nothing when the browser takes a moment to let go of the file", async ({ page }) => {
    await page.evaluate(() => {
      window.holdFile = "assets.json";
      window.inUse = 2;
    });
    await startExport(page);
    const progress = dialog(page);
    await expect.poll(() => page.evaluate(() => window.release !== undefined)).toBe(true);
    await progress.getByRole("button", { name: "取消" }).click();
    await page.evaluate(() => window.release?.());

    await expect(page.getByText("导出已取消。")).toBeVisible();
    await expect(dialog(page)).toHaveCount(0);
    expect(await page.evaluate(() => window.inUse)).toBe(0);
    expect(await folderNames(page, "chosen")).toEqual([]);
  });

  test("stops with Escape too", async ({ page }) => {
    await page.evaluate(() => {
      window.holdFile = "assets.json";
    });
    await startExport(page);
    await expect.poll(() => page.evaluate(() => window.release !== undefined)).toBe(true);
    await page.keyboard.press("Escape");
    await page.evaluate(() => window.release?.());
    await expect(page.getByText("导出已取消。")).toBeVisible();
  });

  test("says so when writing fails, and takes back what it wrote", async ({ page }) => {
    await page.evaluate(() => {
      window.failFile = "assets.json";
    });
    await startExport(page);
    const report = dialog(page);
    await expect(report.getByRole("heading", { name: "导出没有完成" })).toBeVisible();
    await expect(report.getByText(/写入“assets.json”时出错.*都删掉了/)).toBeVisible();
    await closeDialog(page);
    expect(await folderNames(page, "chosen")).toEqual([]);
  });

  test("leaves a folder that cannot be taken for a backup when it cannot clean up", async ({
    page,
  }) => {
    await page.evaluate(() => {
      window.failFile = "assets.json";
      window.stuck = true;
    });
    await startExport(page);
    await expect(dialog(page).getByText(/不要拿它当备份/)).toBeVisible();
    await closeDialog(page);

    const left = await folderNames(page, "chosen/测试项目");
    expect(left).toContain("导出未完成.txt");
    expect(left).not.toContain("animaquill.json");
    expect(await readText(page, "chosen/测试项目", "导出未完成.txt")).toContain("没有完成");

    await importFrom(page, await toDisk(page, "chosen/测试项目"));
    await expect(dialog(page).getByText("这是一次没有完成的导出")).toBeVisible();
    await closeDialog(page);
  });

  test("warns before the page closes", async ({ page }) => {
    await page.evaluate(() => {
      window.holdFile = "assets.json";
    });
    const leaving = () =>
      page.evaluate(() => {
        const event = new Event("beforeunload", { cancelable: true });
        window.dispatchEvent(event);
        return event.defaultPrevented;
      });
    expect(await leaving()).toBe(false);
    await startExport(page);
    await expect.poll(() => page.evaluate(() => window.release !== undefined)).toBe(true);
    expect(await leaving()).toBe(true);
    await page.evaluate(() => window.release?.());
    await expect(dialog(page).getByRole("heading", { name: "导出完成" })).toBeVisible();
    expect(await leaving()).toBe(false);
  });
});

test.describe("a project on its way in", () => {
  test.use({ onDisk: true });
  test.describe.configure({ timeout: 90_000 });

  let folder: string;

  test.beforeEach(async ({ page }) => {
    await useFolders(page);
    await buildProject(page);
    await exportProject(page);
    folder = await toDisk(page, "chosen/测试项目");
    await removeProject(page, "测试项目");
    await page.evaluate(() => {
      // Holds up the second file on its way in, with the first one saved already.
      const { stream } = Blob.prototype;
      let opened = 0;
      Blob.prototype.stream = function held(this: Blob) {
        opened += 1;
        if (opened !== 2) return stream.apply(this);
        const { readable, writable } = new TransformStream();
        void new Promise<void>((resolve) => {
          window.release = resolve;
        })
          .then(() => stream.apply(this).pipeTo(writable))
          .catch(() => {});
        return readable;
      };
    });
  });

  test("stays out of sight, and is gone after cancelling", async ({ page, context }) => {
    await importFromStart(page, folder);
    await expect.poll(() => page.evaluate(() => window.release !== undefined)).toBe(true);
    const { projects, media } = await stored(page);
    expect(projects).toEqual([expect.objectContaining({ name: "测试项目", incoming: true })]);
    expect(media).toBe(1);

    const other = await context.newPage();
    await other.goto("/");
    await expect(other.getByText("还没有项目，新建一个开始吧。")).toBeVisible();
    await other.close();

    await dialog(page).getByRole("button", { name: "取消" }).click();
    await page.evaluate(() => window.release?.());
    await expect(page.getByText("导入已取消，现有的项目没有改动。")).toBeVisible();
    await expect.poll(() => stored(page)).toEqual({ projects: [], media: 0, updates: 0 });
    await expect(page.getByText("还没有项目")).toBeVisible();
  });

  test("leaves nothing for good when the page goes away", async ({ page, context }) => {
    await importFromStart(page, folder);
    await expect.poll(() => page.evaluate(() => window.release !== undefined)).toBe(true);
    await page.close({ runBeforeUnload: false });

    const next = await context.newPage();
    await installFolders(next);
    await next.goto("/");
    await expect(next.getByText("还没有项目，新建一个开始吧。")).toBeVisible();
    await importFromStart(next, folder);
    await expect(next.getByText("“测试项目”已导入。")).toBeVisible();
    await expect(tab(next, "preview")).toBeVisible();
    await expect.poll(() => isRed(next)).toBe(true);
    const { projects } = await stored(next);
    expect(projects).toHaveLength(1);
    expect(projects[0]).not.toHaveProperty("incoming");
  });

  test("is left alone by another window that imports", async ({ page, context }) => {
    await importFromStart(page, folder);
    await expect.poll(() => page.evaluate(() => window.release !== undefined)).toBe(true);

    const other = await context.newPage();
    await installFolders(other);
    await other.goto("/");
    await createProject(other, "另一个项目");
    await exportProject(other);
    const second = await toDisk(other, "chosen/另一个项目");
    await importFrom(other, second);
    await expect(dialog(other).getByText("这次导入成了副本")).toBeVisible();
    await other.close();

    const { projects } = await stored(page);
    expect(projects).toContainEqual(expect.objectContaining({ name: "测试项目", incoming: true }));

    await page.evaluate(() => window.release?.());
    await expect(page.getByText("“测试项目”已导入。")).toBeVisible();
    await expect.poll(() => isRed(page)).toBe(true);
    await tab(page, "assets").click();
    await expect(items(page).filter({ hasText: "封面.png" }).locator("img")).toBeVisible();
  });
});

/** Reads a zip file without compression, as this editor makes them. */
function unzip(file: Buffer, folder: string) {
  const end = file.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = file.readUInt16LE(end + 10);
  let at = file.readUInt32LE(end + 16);
  const names: string[] = [];
  for (let index = 0; index < count; index++) {
    const size = file.readUInt32LE(at + 24);
    const nameLength = file.readUInt16LE(at + 28);
    const offset = file.readUInt32LE(at + 42);
    const name = file.toString("utf8", at + 46, at + 46 + nameLength);
    const start = offset + 30 + file.readUInt16LE(offset + 26) + file.readUInt16LE(offset + 28);
    const path = join(folder, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, file.subarray(start, start + size));
    names.push(name);
    at += 46 + nameLength + file.readUInt16LE(at + 30) + file.readUInt16LE(at + 32);
  }
  return names;
}

test.describe("a browser that cannot write to folders", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      Object.assign(window, { showDirectoryPicker: undefined });
    });
    await page.reload();
    await expect(tab(page, "preview")).toBeVisible();
  });

  test("gets a zip file, and brings the unpacked folder back", async ({ page }) => {
    await buildProject(page);
    await expect.poll(() => isRed(page)).toBe(true);

    const download = page.waitForEvent("download");
    await startExport(page);
    const file = await download;
    expect(file.suggestedFilename()).toBe("测试项目.zip");
    await expect(dialog(page).getByText("打包成了“测试项目.zip”")).toBeVisible();
    await closeDialog(page);

    const folder = mkdtempSync(join(tmpdir(), "animaquill-"));
    const names = unzip(readFileSync(await file.path()), folder);
    expect(names).toContain("测试项目/animaquill.json");
    expect(names).toContain("测试项目/assets.json");
    expect(names.filter((name) => name.startsWith("测试项目/assets/"))).toHaveLength(3);
    expect(names.join()).not.toContain("导出未完成");

    await removeProject(page, "测试项目");
    await importFromStart(page, join(folder, "测试项目"));

    await expect(page.getByText("“测试项目”已导入。")).toBeVisible();
    await tab(page, "timeline").click();
    await expect(clips(page)).toHaveCount(3);
    await expect.poll(() => isRed(page)).toBe(true);
  });

  test("brings in a folder written by hand, with what the format has", async ({ page }) => {
    const folder = fileURLToPath(new URL("../../schema/fixtures/v1", import.meta.url));
    await importFrom(page, folder);
    await openAnyway(page);

    const report = dialog(page);
    await expect(report.getByRole("heading", { name: "项目已导入" })).toBeVisible();
    await expect(report.getByText("这些素材的文件不在文件夹里（7）")).toBeVisible();
    await expect(report.getByText("AGENTS.md")).toBeVisible();
    await closeDialog(page);
    await expect(page.locator("footer").getByRole("button", { name: "原子是什么" })).toBeVisible();

    const download = page.waitForEvent("download");
    await startExport(page);
    const file = await download;
    await closeDialog(page);
    const unpacked = mkdtempSync(join(tmpdir(), "animaquill-"));
    unzip(readFileSync(await file.path()), unpacked);
    for (const path of ["scenes/title/index.html", "code/animate.js", "sounds/impacts/main.js"]) {
      expect(readFileSync(join(unpacked, "原子是什么", path))).toEqual(
        readFileSync(join(folder, path)),
      );
    }
  });

  test("brings in what Node reads of the same folder, all of it", async ({ page }) => {
    const folder = fileURLToPath(new URL("../../schema/fixtures/v1", import.meta.url));
    const reading = await readInNode(await diskFolder(folder));
    await importFrom(page, folder);
    await openAnyway(page);
    const report = dialog(page);
    await expect(report.getByRole("heading", { name: "项目已导入" })).toBeVisible();
    for (const path of reading.skipped) {
      await expect(report.getByText(path, { exact: true })).toBeVisible();
    }
    await closeDialog(page);

    const download = page.waitForEvent("download");
    await startExport(page);
    const file = await download;
    await closeDialog(page);
    const unpacked = mkdtempSync(join(tmpdir(), "animaquill-"));
    const { name } = reading.project.manifest;
    const names = unzip(readFileSync(await file.path()), unpacked);
    const expected = new Map([
      ...writeProject(reading.project),
      ...Object.entries(reading.sources),
    ]);
    expect(names.map((path) => path.slice(`${name}/`.length)).toSorted()).toEqual(
      [...expected.keys()].toSorted(),
    );
    for (const [path, text] of expected) {
      expect(readFileSync(join(unpacked, name, path), "utf8"), path).toBe(text);
    }
  });

  test("saves nothing when cancelled", async ({ page }) => {
    await buildProject(page);
    let downloads = 0;
    page.on("download", () => {
      downloads += 1;
    });
    await page.evaluate(() => {
      const { stream } = Blob.prototype;
      Blob.prototype.stream = function slow() {
        document.querySelector<HTMLButtonElement>("dialog button")?.click();
        return stream.apply(this);
      };
    });
    await startExport(page);
    await expect(page.getByText("导出已取消。")).toBeVisible();
    await page.waitForTimeout(300);
    expect(downloads).toBe(0);
  });
});

test.describe("a file with a name that a folder on a disk does not allow", () => {
  const NAMES = ["aux.js", "~草稿.js", "尾巴.js~", "👨\u200D👩\u200D👧.js", "零\u200B宽.js"];

  /** A project on the disk, with files that a folder handle does not show. */
  function folderWithSuchNames() {
    const disk = join(mkdtempSync(join(tmpdir(), "animaquill-")), "手写的项目");
    const write = (path: string, text: string) => {
      mkdirSync(dirname(join(disk, path)), { recursive: true });
      writeFileSync(join(disk, path), text);
    };
    const manifest = {
      formatVersion: 1,
      id: "hand-written",
      name: "手写的项目",
      languages: [{ id: "zh-CN", name: "中文" }],
      formats: [{ id: "landscape", name: "横屏", width: 1920, height: 1080, fps: "30" }],
      timelines: ["main"],
    };
    write("animaquill.json", JSON.stringify(manifest));
    const timeline = { name: "主线", sections: [{ id: "s", duration: "5" }], tracks: [] };
    write("timelines/main/timeline.json", JSON.stringify(timeline));
    const scene = { name: "结尾", entry: "index.html", runtime: 1 };
    write("scenes/con/scene.json", JSON.stringify(scene));
    write("scenes/con/index.html", "<html></html>");
    for (const name of NAMES) write(`code/${name}`, `// ${name}`);
    return disk;
  }

  test("comes in, which a folder handle would not have let it", async ({ page }) => {
    await page.addInitScript(() => {
      Object.assign(window, { showDirectoryPicker: undefined });
    });
    await page.reload();
    await expect(tab(page, "preview")).toBeVisible();
    await importFrom(page, folderWithSuchNames());
    await openAnyway(page);
    await expect(page.getByText("“手写的项目”已导入。")).toBeVisible();

    const download = page.waitForEvent("download");
    await startExport(page);
    const file = await download;
    await expect(dialog(page).getByRole("heading", { name: "导出完成" })).toBeVisible();
    await closeDialog(page);
    const unpacked = mkdtempSync(join(tmpdir(), "animaquill-"));
    const names = unzip(readFileSync(await file.path()), unpacked);
    for (const name of NAMES) expect(names).toContain(`手写的项目/code/${name}`);
    expect(names).toContain("手写的项目/scenes/con/index.html");
    expect(names).toContain("手写的项目/scenes/con/scene.json");
  });

  test("stays out of a folder with a word, and the rest goes on", async ({ page }) => {
    await useFolders(page);
    await importFrom(page, folderWithSuchNames());
    await openAnyway(page);
    await expect(page.getByText("“手写的项目”已导入。")).toBeVisible();
    await page.evaluate((names) => {
      window.refusedNames = names;
    }, NAMES);

    await startExport(page);
    const report = dialog(page);
    await expect(report.getByRole("heading", { name: /但有内容没有带上/ })).toBeVisible();
    await expect(report.getByText(/不允许这样的名字/)).toBeVisible();
    const refused = await report.getByRole("listitem").allInnerTexts();
    expect(refused.toSorted()).toEqual(NAMES.map((name) => `code/${name}`).toSorted());
    await closeDialog(page);
    const exported = await folderNames(page, "chosen/手写的项目");
    expect(exported).toContain("animaquill.json");
    expect(exported).not.toContain("导出未完成.txt");
  });
});

test.describe("the question the browser asks about uploading", () => {
  test.use({ withProject: false });

  test("is explained while people choose a folder", async ({ page }) => {
    const hint = page.getByText("浏览器接下来会问是否“上传”，这只是读取，文件不会离开这台电脑。");
    const opening = page.waitForEvent("filechooser");
    await importButton(page).click();
    const chooser = await opening;
    await expect(hint).toBeVisible();

    await chooser.setFiles(fileURLToPath(new URL("../../schema/fixtures/v1", import.meta.url)));
    await openAnyway(page);
    await expect(dialog(page).getByRole("heading", { name: "项目已导入" })).toBeVisible();
    await expect(hint).toHaveCount(0);
  });

  test("is not explained for exporting", async ({ page }) => {
    await createProject(page);
    await installFolders(page);
    await page.reload();
    await expect(tab(page, "preview")).toBeVisible();
    await exportProject(page);
    await expect(page.getByText("浏览器接下来会问")).toHaveCount(0);
  });
});

test.describe("without a project", () => {
  test.use({ withProject: false });

  test("offers to import, not to export", async ({ page }) => {
    await expect(page.getByRole("button", { name: "导入项目文件夹" })).toBeVisible();
    await page.locator("header").getByRole("button", { name: "文件", exact: true }).click();
    await expect(page.getByRole("menuitem", { name: "另存一份…" })).toBeDisabled();
    await expect(page.getByRole("menuitem", { name: "导入项目文件夹" })).toBeEnabled();
  });
});
