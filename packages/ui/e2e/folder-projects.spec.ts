/**
 * Projects that are folders, the way people go about them in the editor: new in a folder they
 * choose, opened from a folder, dropped in, changed outside, opened again after a reload, found again
 * after it moved, and open in two windows.
 *
 * A test cannot answer the browser's dialog for choosing a folder, so choosing gives a folder in the
 * private storage of the site instead. What people drop is a folder on the real disk: Chromium gives
 * those to a page as they are, and with experimental web platform features it lets the page write
 * them without asking, as people would allow.
 */
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import { expect, tab, test } from "./support.ts";

test.use({
  folders: true,
  withProject: false,
  launchOptions: { args: ["--enable-experimental-web-platform-features"] },
});

declare global {
  interface Window {
    /** Which folder of the private storage the next "chosen" one is. */
    chosenFolder: string;
  }
}

/** Renames the project in this page, through the hook of the development page. */
const rename = (page: Page, name: string) =>
  page.evaluate((wanted) => {
    const { aqExecute } = window as unknown as { aqExecute: (call: unknown) => unknown };
    aqExecute({ type: "project.rename", params: { name: wanted } });
  }, name);

/** The example project, without its locked tag, so that it can be changed. */
function exampleProject(): Record<string, string> {
  const root = fileURLToPath(new URL("../../schema/fixtures/v1/", import.meta.url));
  const files: Record<string, string> = {};
  const walk = (folder: string) => {
    for (const entry of readdirSync(join(root, folder), { withFileTypes: true })) {
      const path = folder === "" ? entry.name : `${folder}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else files[path] = readFileSync(join(root, path), "utf8");
    }
  };
  walk("");
  const manifest = JSON.parse(files["animaquill.json"] as string);
  delete manifest.tags;
  files["animaquill.json"] = JSON.stringify(manifest, null, 2);
  return files;
}

/** A folder on the disk with the example project in it. */
function projectOnDisk(name = "原子"): string {
  const disk = join(mkdtempSync(join(tmpdir(), "animaquill-projects-")), name);
  for (const [path, text] of Object.entries(exampleProject())) put(disk, path, text);
  return disk;
}

function put(disk: string, path: string, text: string) {
  mkdirSync(dirname(join(disk, path)), { recursive: true });
  writeFileSync(join(disk, path), text);
}

const text = (disk: string, path: string) => readFileSync(join(disk, path), "utf8");
const nameIn = (disk: string) => JSON.parse(text(disk, "animaquill.json")).name as string;

/** Chosen folders come from the private storage of the site, from the next page on. */
const installChosen = (page: Page) =>
  page.addInitScript(() => {
    window.chosenFolder = "选的";
    const choose = async () => {
      let folder = await navigator.storage.getDirectory();
      for (const part of window.chosenFolder.split("/")) {
        folder = await folder.getDirectoryHandle(part, { create: true });
      }
      return folder;
    };
    Object.assign(window, { showDirectoryPicker: choose });
  });

/** What a file in the private storage of the site has, or undefined. */
const privateText = (page: Page, path: string) =>
  page.evaluate(async (wanted) => {
    let folder = await navigator.storage.getDirectory();
    const parts = wanted.split("/");
    try {
      for (const part of parts.slice(0, -1)) folder = await folder.getDirectoryHandle(part);
      const file = await folder.getFileHandle(parts.at(-1) as string);
      return await (await file.getFile()).text();
    } catch {
      return undefined;
    }
  }, path);

/** Puts files into a folder of the private storage of the site, as another program would. */
const putPrivate = (page: Page, root: string, files: Record<string, string>) =>
  page.evaluate(
    async ({ root: top, files: all }) => {
      for (const [path, content] of Object.entries(all)) {
        let folder = await navigator.storage.getDirectory();
        const parts = `${top}/${path}`.split("/");
        for (const part of parts.slice(0, -1)) {
          folder = await folder.getDirectoryHandle(part, { create: true });
        }
        const file = await folder.getFileHandle(parts.at(-1) as string, { create: true });
        const writable = await file.createWritable();
        await writable.write(content);
        await writable.close();
      }
    },
    { root, files },
  );

/** Drops a folder of the disk on the page, as people drag it in from their files. */
async function drop(page: Page, disk: string) {
  const client = await page.context().newCDPSession(page);
  const data = { items: [], files: [disk], dragOperationsMask: 1 };
  for (const type of ["dragEnter", "dragOver", "drop"] as const) {
    await client.send("Input.dispatchDragEvent", { type, x: 300, y: 300, data });
  }
  await client.detach();
}

const footer = (page: Page) => page.locator("footer");
const dialog = (page: Page) => page.getByRole("dialog");

/** A project with code asks once, the first time it comes into this browser. */
async function agreeToCode(page: Page) {
  await expect(dialog(page)).toContainText("这个项目含有脚本");
  await dialog(page).getByRole("button", { name: "知道了，打开项目" }).click();
}

/** Drops the example project in, and waits until it is open and its folder has everything. */
async function openDropped(page: Page, disk: string) {
  await drop(page, disk);
  await agreeToCode(page);
  await expect(tab(page, "preview")).toBeVisible();
  await expect(footer(page).getByText("已保存")).toBeVisible({ timeout: 10_000 });
}

test.describe("a project folder", () => {
  test("is where a new project goes, and gets all of it", async ({ page }) => {
    await installChosen(page);
    await page.reload();
    await page.getByRole("button", { name: "新建项目" }).click();
    await expect(dialog(page)).toContainText("下一步选一个放项目的文件夹");
    await page.getByRole("textbox", { name: "项目名称" }).fill("新的片子");
    await dialog(page).getByRole("button", { name: "选文件夹…" }).click();
    await expect(tab(page, "preview")).toBeVisible();
    await expect(footer(page).getByText("已保存")).toBeVisible({ timeout: 10_000 });
    await expect
      .poll(async () => JSON.parse((await privateText(page, "选的/animaquill.json")) ?? "{}").name)
      .toBe("新的片子");
  });

  test("opens from where people choose, and stays as it was written", async ({ page }) => {
    await installChosen(page);
    await page.reload();
    const files = exampleProject();
    await putPrivate(page, "选的", files);
    await page.getByRole("button", { name: "打开项目文件夹…" }).click();
    await agreeToCode(page);
    await expect(tab(page, "preview")).toBeVisible();
    await expect(footer(page).getByText("原子是什么")).toBeVisible();
    await expect(footer(page).getByText("已保存")).toBeVisible({ timeout: 10_000 });
    // Opening writes nothing that did not change.
    expect(await privateText(page, "选的/notes.json")).toBe(files["notes.json"]);
  });

  test("opens when people drop it, and takes in what changes outside", async ({ page }) => {
    const disk = projectOnDisk();
    await openDropped(page, disk);
    const notes = JSON.parse(text(disk, "notes.json"));
    const before = notes.notes[0].text;
    notes.notes[0].text = "外面改的";
    writeFileSync(join(disk, "notes.json"), JSON.stringify(notes, null, 4));
    const notice = page.getByText("外面改了 1 个文件，已并入。");
    await expect(notice).toBeVisible({ timeout: 10_000 });
    // What came in can be taken back as a whole, and the folder gets that too.
    await page.getByRole("button", { name: "撤销这次" }).click();
    await expect(page.getByText("已撤销这次并入")).toBeVisible();
    await expect.poll(() => JSON.parse(text(disk, "notes.json")).notes[0].text).toBe(before);
  });

  test("opens again after a reload, and after the browser asks once more", async ({ page }) => {
    const disk = projectOnDisk();
    await openDropped(page, disk);
    await page.reload();
    await expect(footer(page).getByText("原子是什么")).toBeVisible();
    await expect(footer(page).getByText("已保存")).toBeVisible({ timeout: 10_000 });
    // As after the browser was closed: it has to ask, which takes one press.
    await page.addInitScript(() => {
      const asked = { done: false };
      Object.assign(FileSystemHandle.prototype, {
        queryPermission: async () => (asked.done ? "granted" : "prompt"),
        requestPermission: async () => {
          asked.done = true;
          return "granted";
        },
      });
    });
    await page.reload();
    await expect(tab(page, "preview")).toHaveCount(0);
    await expect(page.getByText("每次访问都允许").first()).toBeVisible();
    await page.getByRole("button", { name: "继续打开“原子是什么”" }).click();
    await expect(tab(page, "preview")).toBeVisible();
    await expect(footer(page).getByText("原子是什么")).toBeVisible();
  });

  test("that moved is found again, with what was not written yet", async ({ page }) => {
    const disk = projectOnDisk();
    await openDropped(page, disk);
    const moved = `${disk}-搬走`;
    renameSync(disk, moved);
    // People go on meanwhile, and that cannot be written: it stays until the folder is back.
    await rename(page, "搬走以后改的");
    await expect(footer(page).getByText("找不到文件夹")).toBeVisible({ timeout: 15_000 });
    await page.reload();
    await expect(page.getByText("找不到“原子是什么”的文件夹")).toBeVisible();
    await drop(page, moved);
    await expect(dialog(page)).toContainText("这是移动过的“原子是什么”吗");
    await dialog(page).getByRole("button", { name: "是，接上原来的" }).click();
    await expect(footer(page).getByText("已保存")).toBeVisible({ timeout: 10_000 });
    await expect.poll(() => nameIn(moved)).toBe("搬走以后改的");
  });

  test("is written by one window, while another one works on it too", async ({ page, context }) => {
    const disk = projectOnDisk();
    await openDropped(page, disk);
    const other = await context.newPage();
    await other.goto(page.url());
    await expect(footer(other).getByText("另一个窗口在写这个文件夹")).toBeVisible({
      timeout: 10_000,
    });
    await rename(other, "另一个窗口改的");
    await expect.poll(() => nameIn(disk), { timeout: 10_000 }).toBe("另一个窗口改的");
    await expect(footer(page).getByText("另一个窗口改的")).toBeVisible();
  });
});
