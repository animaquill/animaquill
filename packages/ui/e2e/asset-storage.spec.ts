/**
 * Where the files of assets are kept besides here. The editor keeps the file here as well, so one
 * that is kept somewhere else shows from here like any other; where it is not here, it can be
 * downloaded from there, which is nothing missing. See docs/design/phase5-step14.md, 3.2.1. Both
 * ways a project can be: a folder on the disk, and one that came into the browser.
 */
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProjectStore } from "@animaquill/core";
import { createProject } from "@animaquill/schema";
import type { Page } from "@playwright/test";
import { drop, footer } from "./folder-support.ts";
import { content, expect, findCompositor, resourcesIn, tab, test } from "./support.ts";

const RED = fileURLToPath(new URL("./fixtures/red.webm", import.meta.url));
const RED_BLUE = fileURLToPath(new URL("./fixtures/red-blue.webm", import.meta.url));

/** How a project writes down the hash of a file. */
const hashOf = (path: string) =>
  `sha256-${createHash("sha256")
    .update(readFileSync(path))
    .digest("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")}`;

const video = (asset: string, start: string) => ({
  id: asset,
  start,
  duration: "0.5",
  source: { kind: "video", media: { asset } },
});

/**
 * A project of three videos: one kept in GitHub LFS as well, whose file is here; one in the cloud
 * space, whose file is not; and one only on this computer, whose file is gone. As files.
 */
function projectFiles(): Map<string, string> {
  const files = ProjectStore.create(createProject({ name: "存放位置" })).exportFiles().files;
  const size = (path: string) => readFileSync(path).byteLength;
  files.set(
    "assets.json",
    JSON.stringify({
      assets: {
        film: {
          name: "胶片.webm",
          kind: "video",
          path: "assets/胶片.webm",
          storage: "lfs",
          hash: hashOf(RED),
          size: size(RED),
        },
        away: {
          name: "云端.webm",
          kind: "video",
          path: "assets/云端.webm",
          storage: "platform",
          hash: hashOf(RED_BLUE),
          size: size(RED_BLUE),
        },
        gone: { name: "丢了.webm", kind: "video", path: "assets/丢了.webm", storage: "local" },
      },
    }),
  );
  const path = "timelines/main/timeline.json";
  const timeline = JSON.parse(files.get(path) as string);
  const track = timeline.tracks.find(({ kind }: { kind: string }) => kind === "video");
  track.clips = [video("film", "0"), video("away", "1"), video("gone", "2")];
  timeline.sections[0].duration = "3";
  files.set(path, JSON.stringify(timeline));
  return files;
}

/** The project in a folder of the disk, with the one file that is here. */
function projectOnDisk(): string {
  const disk = join(mkdtempSync(join(tmpdir(), "animaquill-projects-")), "存放位置");
  for (const [path, text] of projectFiles()) {
    mkdirSync(dirname(join(disk, path)), { recursive: true });
    writeFileSync(join(disk, path), text);
  }
  mkdirSync(join(disk, "assets"), { recursive: true });
  copyFileSync(RED, join(disk, "assets/胶片.webm"));
  return disk;
}

/** The colour in the middle of the picture. */
async function middle(page: Page): Promise<readonly number[]> {
  const frame = await findCompositor(page);
  if (!frame) return [];
  return frame.evaluate(() => {
    const canvas = document.querySelector("canvas");
    const data = canvas
      ?.getContext("2d")
      ?.getImageData(canvas.width / 2, canvas.height / 2, 1, 1).data;
    return data ? [...data] : [];
  });
}

/** The compositor starts cold, which takes a while on a busy machine. */
const FIRST_FRAME = { timeout: 20_000 };

const isRed = async (page: Page) => {
  const [red = 0, green = 255, blue = 255] = await middle(page);
  return red > 200 && green < 60 && blue < 60;
};

const explorer = (page: Page) => content(page, "explorer");
const node = (page: Page, name: string) => explorer(page).locator(`[data-node="${name}"]`);
const item = (page: Page, name: string) =>
  explorer(page).getByRole("option", { name, exact: true }).first();
const details = (page: Page) => content(page, "code").getByRole("region", { name: "详情" });

/** What the explorer and the details of each asset say. */
async function expectExplorer(page: Page) {
  await tab(page, "explorer").click();
  const missing = node(page, "missing");
  // Only the file that is nowhere else is missing.
  await expect(missing).toHaveText("缺失的资源（1）", { timeout: 10_000 });
  await node(page, "project.media").click();
  await expect(item(page, "云端.webm")).toContainText("可以下载");
  await expect(item(page, "云端.webm")).not.toContainText("文件找不到");
  await expect(item(page, "丢了.webm")).toContainText("文件找不到");
  await expect(item(page, "胶片.webm")).not.toContainText(/可以下载|文件找不到/);

  await item(page, "云端.webm").click();
  await expect(details(page).getByRole("note")).toHaveText(
    "这台电脑上没有这个文件：assets/云端.webm。可以从云端空间下载。",
  );
  await item(page, "胶片.webm").click();
  await expect(details(page).getByRole("note")).toHaveCount(0);

  await missing.click();
  await expect(resourcesIn(page, "explorer")).toHaveCount(1);
  await expect(item(page, "丢了.webm")).toBeVisible();
}

test.use({
  withProject: false,
  launchOptions: { args: ["--enable-experimental-web-platform-features"] },
});

test.describe("a project folder", () => {
  test.use({ folders: true });

  test("shows a file kept somewhere else from here, and one that is not here can be downloaded", async ({
    page,
  }) => {
    const disk = projectOnDisk();
    await drop(page, disk);
    await expect(tab(page, "preview")).toBeVisible();
    await expect(footer(page).getByText("已保存")).toBeVisible({ timeout: 10_000 });
    // The file in GitHub LFS comes from the folder, like any other.
    await expect.poll(() => isRed(page), FIRST_FRAME).toBe(true);

    await tab(page, "problems").click();
    const problems = content(page, "problems");
    const away = problems.getByRole("listitem").filter({ hasText: "assets/云端.webm" }).last();
    await expect(away).toContainText("素材文件不在这台电脑上，可以从云端空间下载。", {
      timeout: 10_000,
    });
    await expect(away).not.toContainText("不在这里了");
    const gone = problems.getByRole("listitem").filter({ hasText: "assets/丢了.webm" }).last();
    await expect(gone).toContainText("素材文件不在这里了");
    await expect(problems).not.toContainText("assets/胶片.webm");

    await expectExplorer(page);
  });
});

test.describe("a project in this browser", () => {
  test("shows a file kept somewhere else from here, and one that is not here can be downloaded", async ({
    page,
  }) => {
    const folder = projectOnDisk();
    try {
      const chooser = page.waitForEvent("filechooser");
      await page.getByRole("button", { name: "导入项目文件夹" }).click();
      await (await chooser).setFiles(folder);
      const report = page.getByRole("dialog");
      await expect(report).toContainText("云端.webm：可以从云端空间下载", { timeout: 120_000 });
      await expect(report.getByText("丢了.webm", { exact: true })).toBeVisible();
      await report.getByRole("button", { name: "关闭" }).click();
      await expect(tab(page, "preview")).toBeVisible();
      await expect.poll(() => isRed(page), FIRST_FRAME).toBe(true);
      await expectExplorer(page);
    } finally {
      rmSync(dirname(folder), { recursive: true });
    }
  });
});
