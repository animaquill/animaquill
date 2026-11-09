/**
 * The assets of a project that is a folder on the disk, the way people go about them: what they drop
 * from elsewhere goes into its assets folder, what is in the folder already is used where it is, the
 * picture comes from there, and what changes outside is listed until people say what to do. The
 * project is a folder on the real disk that gets dropped in, see `folder-support.ts`.
 */
import { createHash } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  existsSync,
  ftruncateSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import { dialog, drop, footer, openDropped, projectOnDisk, text } from "./folder-support.ts";
import { content, expect, findCompositor, tab, test } from "./support.ts";

test.use({
  folders: true,
  withProject: false,
  launchOptions: { args: ["--enable-experimental-web-platform-features"] },
});

const RED = fileURLToPath(new URL("./fixtures/red.webm", import.meta.url));
const RED_BLUE = fileURLToPath(new URL("./fixtures/red-blue.webm", import.meta.url));

/** How a project writes down the hash of a file. */
const hashOf = (path: string) =>
  `sha256-${createHash("sha256")
    .update(readFileSync(path))
    .digest("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")}`;

const assets = (page: Page) => content(page, "assets");
const items = (page: Page) => assets(page).getByRole("listitem");
const problems = (page: Page) => content(page, "problems");

/** The assets that the folder says the project has, none before the editor wrote any. */
const assetsIn = (disk: string) =>
  existsSync(join(disk, "assets.json"))
    ? (Object.values(JSON.parse(text(disk, "assets.json")).assets) as {
        readonly path: string;
        readonly hash?: string;
      }[])
    : [];

/** Drops files of the disk on the assets panel. */
async function dropOnAssets(page: Page, ...paths: string[]) {
  await tab(page, "assets").click();
  const box = await assets(page).boundingBox();
  if (!box) throw new Error("The assets panel has no box");
  await drop(page, paths, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
}

/**
 * A new project in an empty folder on the disk, which people dropped in: nothing is on its timeline
 * yet, so a clip that comes is where the playhead is.
 */
async function newProjectOnDisk(page: Page): Promise<string> {
  const disk = join(mkdtempSync(join(tmpdir(), "animaquill-projects-")), "片子");
  mkdirSync(disk);
  await drop(page, disk);
  await dialog(page).getByRole("button", { name: "在这里新建项目" }).click();
  await dialog(page).getByRole("textbox").fill("片子");
  await dialog(page).getByRole("button", { name: "创建" }).click();
  await expect(tab(page, "preview")).toBeVisible();
  await expect(footer(page).getByText("已保存")).toBeVisible({ timeout: 10_000 });
  return disk;
}

/** Puts a copy of a file into the project on the disk, as people do with their files. */
function putFile(disk: string, path: string, from: string) {
  mkdirSync(dirname(join(disk, path)), { recursive: true });
  copyFileSync(from, join(disk, path));
}

/** A folder somewhere else on the disk, with a copy of a file in it. */
function elsewhere(from: string, name: string): string {
  const path = join(mkdtempSync(join(tmpdir(), "animaquill-files-")), name);
  copyFileSync(from, path);
  return path;
}

/** The window comes to the front, which has the folder looked at again. */
const toTheFront = (page: Page) => page.evaluate(() => dispatchEvent(new Event("focus")));

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

const isRed = async (page: Page) => {
  const [red = 0, green = 255, blue = 255] = await middle(page);
  return red > 200 && green < 60 && blue < 60;
};

const isBlue = async (page: Page) => {
  const [red = 255, green = 255, blue = 0] = await middle(page);
  return red < 60 && green < 60 && blue > 200;
};

async function goTo(page: Page, time: string) {
  await page.getByRole("contentinfo").getByRole("button", { name: "当前时间和总时长" }).click();
  await page.getByRole("textbox", { name: "当前时间" }).fill(time);
  await page.keyboard.press("Enter");
}

test.describe("the assets of a project folder", () => {
  test("are copied in from elsewhere, and used where they are when they are in it", async ({
    page,
  }) => {
    const warnings: string[] = [];
    page.on("console", (message) => void warnings.push(message.text()));
    const disk = projectOnDisk();
    putFile(disk, "footage/在里面.webm", RED);
    await openDropped(page, disk);
    await tab(page, "assets").click();
    const before = await items(page).count();

    await dropOnAssets(page, join(disk, "footage/在里面.webm"));
    await expect(items(page)).toHaveCount(before + 1);
    await expect
      .poll(() => assetsIn(disk).map(({ path }) => path), { timeout: 10_000 })
      .toContain("footage/在里面.webm");
    expect(existsSync(join(disk, "assets/在里面.webm"))).toBe(false);

    await dropOnAssets(page, elsewhere(RED_BLUE, "红蓝.webm"));
    await expect(items(page)).toHaveCount(before + 2);
    await expect
      .poll(() => assetsIn(disk).map(({ path }) => path), { timeout: 10_000 })
      .toContain("assets/红蓝.webm");
    expect(readFileSync(join(disk, "assets/红蓝.webm")).equals(readFileSync(RED_BLUE))).toBe(true);
    expect(assetsIn(disk).find(({ path }) => path === "assets/红蓝.webm")?.hash).toBe(
      hashOf(RED_BLUE),
    );

    // The hashes were found out in a worker, away from the page.
    const workers = await page.evaluate(() =>
      performance
        .getEntriesByType("resource")
        .filter(({ name }) => name.includes("hash-worker"))
        .map(({ name }) => name),
    );
    expect(workers).toHaveLength(1);
    expect(warnings).not.toContainEqual(expect.stringContaining("worker for hashes"));

    // The browser keeps none of them.
    const kept = await page.evaluate(
      () =>
        new Promise<number>((resolve, reject) => {
          const request = indexedDB.open("animaquill");
          request.addEventListener("error", () => reject(request.error));
          request.addEventListener("success", () => {
            const keys = request.result.transaction("media").objectStore("media").getAllKeys();
            keys.addEventListener("success", () => {
              const files = keys.result.filter((key) => String(key).includes("sha256-"));
              request.result.close();
              resolve(files.filter((key) => !String(key).includes(":")).length);
            });
          });
        }),
    );
    expect(kept).toBe(0);
  });

  test("show in the picture from the folder, and what replaced one once people take it", async ({
    page,
  }) => {
    const disk = await newProjectOnDisk(page);
    putFile(disk, "assets/红色.webm", RED);
    await dropOnAssets(page, join(disk, "assets/红色.webm"));
    await items(page).filter({ hasText: "红色.webm" }).dblclick();
    await expect.poll(() => isRed(page)).toBe(true);

    copyFileSync(RED_BLUE, join(disk, "assets/红色.webm"));
    await toTheFront(page);
    await tab(page, "problems").click();
    // The innermost of the lists: problems are listed by file.
    const replaced = problems(page)
      .getByRole("listitem")
      .filter({ hasText: "在外面被换过" })
      .last();
    await expect(replaced).toBeVisible({ timeout: 10_000 });
    await replaced.getByRole("button", { name: "用新文件" }).click();
    await expect(problems(page)).not.toContainText("在外面被换过");
    await expect
      .poll(() => assetsIn(disk).find(({ path }) => path === "assets/红色.webm")?.hash, {
        timeout: 10_000,
      })
      .toBe(hashOf(RED_BLUE));
    await expect.poll(() => isRed(page)).toBe(true);
  });

  test("are found again where people moved them in the folder", async ({ page }) => {
    const disk = await newProjectOnDisk(page);
    putFile(disk, "assets/红色.webm", RED);
    await dropOnAssets(page, join(disk, "assets/红色.webm"));
    await expect
      .poll(() => assetsIn(disk).map(({ path }) => path), { timeout: 10_000 })
      .toContain("assets/红色.webm");

    mkdirSync(join(disk, "footage"), { recursive: true });
    renameSync(join(disk, "assets/红色.webm"), join(disk, "footage/红色.webm"));
    await toTheFront(page);
    await tab(page, "problems").click();
    const moved = problems(page)
      .getByRole("listitem")
      .filter({ hasText: "footage/红色.webm" })
      .last();
    await expect(moved).toBeVisible({ timeout: 10_000 });
    await moved.getByRole("button", { name: "改用这个位置" }).click();
    await expect
      .poll(() => assetsIn(disk).map(({ path }) => path), { timeout: 10_000 })
      .toContain("footage/红色.webm");
    await expect(problems(page)).not.toContainText("footage/红色.webm");
  });
});

/** How a project writes down the hash of so many zeros, without having them in memory. */
function hashOfZeros(bytes: number): string {
  const hash = createHash("sha256");
  const piece = Buffer.alloc(1024 * 1024);
  for (let left = bytes; left > 0; left -= piece.length) {
    hash.update(left >= piece.length ? piece : piece.subarray(0, left));
  }
  return `sha256-${hash.digest("base64").replaceAll("+", "-").replaceAll("/", "_")}`;
}

test.describe("a project folder opened for the first time in a browser", () => {
  test("says which files it reads for their hashes, and which the preview waits for", async ({
    page,
  }) => {
    const disk = projectOnDisk();
    // A large video, as far as reading it goes: the disk keeps no zeros for it.
    const size = 1200 * 1024 * 1024;
    mkdirSync(join(disk, "assets"), { recursive: true });
    const handle = openSync(join(disk, "assets/大.mp4"), "w");
    ftruncateSync(handle, size);
    closeSync(handle);
    const listed = JSON.parse(text(disk, "assets.json"));
    Object.assign(listed.assets.interview, {
      path: "assets/大.mp4",
      size,
      hash: hashOfZeros(size),
    });
    writeFileSync(join(disk, "assets.json"), JSON.stringify(listed, null, 2));
    // Its clip first, where the playhead is.
    const timeline = JSON.parse(text(disk, "timelines/main/timeline.json"));
    for (const track of timeline.tracks) {
      for (const clip of track.clips) {
        if (clip.id === "clip_interview") clip.start = "0";
        if (clip.id === "clip_title") clip.start = "12.5";
      }
    }
    writeFileSync(join(disk, "timelines/main/timeline.json"), JSON.stringify(timeline, null, 2));
    await drop(page, disk);
    await dialog(page).getByRole("button", { name: "知道了，打开项目" }).click();
    const waiting = content(page, "preview").getByRole("status").filter({ hasText: "预览在等" });
    await expect(waiting).toContainText("正在核对素材，预览在等：assets/大.mp4", {
      timeout: 10_000,
    });
    await tab(page, "assets").click();
    const reading = assets(page).getByRole("status").filter({ hasText: "正在核对" });
    await expect(reading).toContainText("正在核对“assets/大.mp4”");
  });
});

test.describe("the compositor", () => {
  test("reads a file again when it comes again, as after it changed on the disk", async ({
    page,
  }) => {
    const disk = await newProjectOnDisk(page);
    putFile(disk, "assets/红蓝.webm", RED_BLUE);
    await dropOnAssets(page, join(disk, "assets/红蓝.webm"));
    await items(page).filter({ hasText: "红蓝.webm" }).dblclick();
    await goTo(page, "0:01/15");
    await expect.poll(() => isBlue(page)).toBe(true);
    // What arrives for the same file now is red all the way: what was read of the old one goes.
    const red = readFileSync(RED).toString("base64");
    await content(page, "preview")
      .locator("iframe")
      .evaluate(
        (element: HTMLIFrameElement, { id, data }) => {
          const bytes = Uint8Array.from(atob(data), (letter) => letter.charCodeAt(0));
          const file = new Blob([bytes], { type: "video/webm" });
          element.contentWindow?.postMessage({ type: "file", id, file }, "*");
          element.contentWindow?.postMessage({ type: "seek", seconds: 1.5, jump: true }, "*");
        },
        { id: hashOf(RED_BLUE), data: red },
      );
    await expect.poll(() => isRed(page)).toBe(true);
  });
});
