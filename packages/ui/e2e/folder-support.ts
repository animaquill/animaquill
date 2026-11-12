/**
 * What the browser tests of project folders share: projects on the real disk, dropping them and
 * files from it, and folders "chosen" from the private storage of the site.
 *
 * A test cannot answer the browser's dialog for choosing a folder, so choosing gives a folder in the
 * private storage of the site instead. What people drop is a folder on the real disk: Chromium gives
 * those to a page as they are, and with experimental web platform features it lets the page write
 * them without asking, as people would allow.
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import { editorReady, expect, tab } from "./support.ts";

declare global {
  interface Window {
    /** Which folder of the private storage the next "chosen" one is. */
    chosenFolder: string;
  }
}

/**
 * Renames the project in this page, through the hooks of the development page, and waits until the
 * log has it, as a reload right after must not take it away.
 */
export const rename = (page: Page, name: string) =>
  page.evaluate(async (wanted) => {
    const { aqExecute, aqSave } = window as unknown as {
      aqExecute: (call: unknown) => unknown;
      aqSave: () => Promise<void>;
    };
    aqExecute({ type: "project.rename", params: { name: wanted } });
    await aqSave();
  }, name);

/** The example project, without its locked tag, so that it can be changed. */
export function exampleProject(): Record<string, string> {
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
export function projectOnDisk(name = "原子"): string {
  const disk = join(mkdtempSync(join(tmpdir(), "animaquill-projects-")), name);
  for (const [path, text] of Object.entries(exampleProject())) put(disk, path, text);
  return disk;
}

export function put(disk: string, path: string, text: string) {
  mkdirSync(dirname(join(disk, path)), { recursive: true });
  writeFileSync(join(disk, path), text);
}

export const text = (disk: string, path: string) => readFileSync(join(disk, path), "utf8");
export const nameIn = (disk: string) => JSON.parse(text(disk, "animaquill.json")).name as string;

/** Chosen folders come from the private storage of the site, from the next page on. */
export const installChosen = (page: Page) =>
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
export const privateText = (page: Page, path: string) =>
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
export const putPrivate = (page: Page, root: string, files: Record<string, string>) =>
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

/** How `drop` goes about it, beyond where. */
export interface DropOptions {
  /** Drops at once, also before the editor is there: by default it waits for the editor. */
  readonly early?: boolean;
  /** What happens while the pointer is over the page, right before letting go. */
  readonly meanwhile?: () => Promise<unknown>;
}

/**
 * Drops folders or files of the disk on the page, as people drag them in from their files: where
 * `at` says, or somewhere in the middle. By default not before the editor is there, also right
 * after a reload, as people drop what they see. What the page does with a drop before then is for
 * the tests of that, with `early`.
 */
export async function drop(
  page: Page,
  paths: string | readonly string[],
  at: { readonly x: number; readonly y: number } = { x: 300, y: 300 },
  { early = false, meanwhile }: DropOptions = {},
) {
  if (!early) await editorReady(page);
  const client = await page.context().newCDPSession(page);
  const files = typeof paths === "string" ? [paths] : [...paths];
  const data = { items: [], files, dragOperationsMask: 1 };
  for (const type of ["dragEnter", "dragOver"] as const) {
    await client.send("Input.dispatchDragEvent", { type, ...at, data });
  }
  await meanwhile?.();
  await client.send("Input.dispatchDragEvent", { type: "drop", ...at, data });
  await client.detach();
}

export const footer = (page: Page) => page.locator("footer");
export const dialog = (page: Page) => page.getByRole("dialog");

/**
 * A project with code asks once, the first time it comes into this browser. It asks once the whole
 * folder is read, after the page loaded and looked at the folder: on a busy machine that takes as
 * long as saving does.
 */
export async function agreeToCode(page: Page) {
  await expect(dialog(page)).toContainText("这个项目含有脚本", { timeout: 10_000 });
  await dialog(page).getByRole("button", { name: "知道了，打开项目" }).click();
}

/** Drops the example project in, and waits until it is open and its folder has everything. */
export async function openDropped(page: Page, disk: string) {
  await drop(page, disk);
  await agreeToCode(page);
  await expect(tab(page, "preview")).toBeVisible();
  await expect(footer(page).getByText("已保存")).toBeVisible({ timeout: 10_000 });
}
