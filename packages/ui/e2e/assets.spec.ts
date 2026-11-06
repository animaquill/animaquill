import { readFileSync } from "node:fs";
import type { Locator, Page } from "@playwright/test";
import { content, expect, tab, test } from "./support.ts";

const assets = (page: Page) => content(page, "assets");
const items = (page: Page) => assets(page).getByRole("listitem");
const timeline = (page: Page) => content(page, "timeline");
const clips = (page: Page) => timeline(page).getByRole("option");

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

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
  image: { name: "封面.png", mimeType: "image/png", buffer: PNG },
  sound: { name: "配音.wav", mimeType: "audio/wav", buffer: wav(3) },
  video: {
    name: "采访.mp4",
    mimeType: "video/mp4",
    buffer: readFileSync(new URL("./fixtures/clip.mp4", import.meta.url)),
  },
  broken: { name: "坏文件.mp4", mimeType: "video/mp4", buffer: Buffer.from("no video here") },
};

async function importFiles(page: Page, ...list: (typeof files)[keyof typeof files][]) {
  const chooser = page.waitForEvent("filechooser");
  await assets(page).getByRole("button", { name: "导入" }).click();
  await (await chooser).setFiles(list);
}

async function boxOf(locator: Locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error("Element has no box");
  return box;
}

test.beforeEach(async ({ page }) => {
  await tab(page, "assets").click();
  await tab(page, "timeline").click();
});

test("brings in files, and they survive a reload", async ({ page }) => {
  await importFiles(page, files.image, files.sound, files.video);
  await expect(items(page)).toHaveCount(3);
  await expect(items(page).filter({ hasText: "配音.wav" })).toContainText("0:03");
  await expect(items(page).filter({ hasText: "封面.png" }).locator("img")).toBeVisible();
  await page.reload();
  await expect(items(page)).toHaveCount(3);
  await expect(items(page).filter({ hasText: "封面.png" }).locator("img")).toBeVisible();
});

test("does not keep the same file twice", async ({ page }) => {
  await importFiles(page, files.image);
  await expect(items(page)).toHaveCount(1);
  await importFiles(page, { ...files.image, name: "别的名字.png" });
  await page.waitForTimeout(300);
  await expect(items(page)).toHaveCount(1);
});

test("says so when it cannot read a file, and goes on with the others", async ({ page }) => {
  await importFiles(page, files.broken, files.image);
  await expect(page.getByText("这个浏览器解不了“坏文件.mp4”")).toBeVisible();
  await expect(items(page)).toHaveCount(1);
});

test("a video with sound becomes two clips that belong together", async ({ page }) => {
  await importFiles(page, files.video);
  await items(page).first().dblclick();
  await expect(clips(page)).toHaveCount(2);
  await expect(clips(page).first()).toHaveAttribute("aria-label", /采访.mp4，视频 1/);
  await expect(clips(page).nth(1)).toHaveAttribute("aria-label", /采访.mp4，音频 1/);
  await expect(clips(page).first()).toHaveAttribute("aria-selected", "true");
  await expect(clips(page).nth(1)).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Control+z");
  await expect(clips(page)).toHaveCount(0);
});

test("can be dragged to a track", async ({ page }) => {
  await importFiles(page, files.image);
  const area = await boxOf(timeline(page).getByRole("group", { name: "时间轴" }));
  await items(page)
    .first()
    .dragTo(timeline(page).getByRole("group", { name: "时间轴" }), {
      targetPosition: { x: 300, y: 50 },
    });
  await expect(clips(page)).toHaveCount(1);
  const clip = await boxOf(clips(page).first());
  expect(clip.x).toBeGreaterThan(area.x + 250);
});

test("a clip cannot grow past the end of its file", async ({ page }) => {
  await importFiles(page, files.sound);
  await items(page).first().dblclick();
  await expect(clips(page)).toHaveCount(1);
  await page.waitForTimeout(200);
  const { x, y, width, height } = await boxOf(clips(page).first());
  await page.mouse.move(x + width - 2, y + height / 2);
  await page.mouse.down();
  await page.mouse.move(x + width + 300, y + height / 2, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(200);
  await expect(clips(page).first()).toHaveAttribute("aria-label", /到 00:00:03:00/);
});

test("a file in use cannot be removed", async ({ page }) => {
  await importFiles(page, files.image);
  await items(page).first().dblclick();
  await expect(clips(page)).toHaveCount(1);
  await items(page).first().click({ button: "right" });
  await page.getByRole("menuitem", { name: "删除素材" }).click();
  await expect(page.getByText("还有片段在用这个素材")).toBeVisible();
  await expect(items(page)).toHaveCount(1);
});

test("the files of a project go with it", async ({ page }) => {
  await importFiles(page, files.image);
  await expect(items(page)).toHaveCount(1);
  const count = () =>
    page.evaluate(
      () =>
        new Promise<number>((resolve) => {
          const open = indexedDB.open("animaquill");
          open.onsuccess = () => {
            const request = open.result.transaction("media").objectStore("media").count();
            request.onsuccess = () => {
              open.result.close();
              resolve(request.result);
            };
          };
        }),
    );
  expect(await count()).toBe(1);
  await page.getByRole("banner").getByRole("button", { name: "文件" }).click();
  await page.getByRole("menuitem", { name: "关闭项目" }).click();
  await page.getByRole("button", { name: /^删除/ }).click();
  await page.getByRole("dialog").getByRole("button", { name: "删除" }).click();
  await expect.poll(count).toBe(0);
});

test("a project saved before files existed still opens, and takes files", async ({ page }) => {
  const url = page.url();
  await page.evaluate(async () => {
    const read = <T>(asked: IDBRequest<T>) =>
      new Promise<T>((resolve, reject) => {
        asked.onsuccess = () => resolve(asked.result);
        asked.onerror = () => reject(asked.error);
      });
    const current = await read(indexedDB.open("animaquill"));
    const transaction = current.transaction(["projects", "updates"]);
    const projects = await read(transaction.objectStore("projects").getAll());
    const updates = await read(transaction.objectStore("updates").getAll());
    current.close();
    await read(indexedDB.deleteDatabase("animaquill"));

    // The database as the first version made it.
    const open = indexedDB.open("animaquill", 1);
    open.onupgradeneeded = () => {
      const database = open.result;
      database.createObjectStore("projects", { keyPath: "id" });
      const store = database.createObjectStore("updates", { keyPath: "seq", autoIncrement: true });
      store.createIndex("project", "project");
    };
    const old = await read(open);
    const writing = old.transaction(["projects", "updates"], "readwrite");
    for (const project of projects) writing.objectStore("projects").put(project);
    for (const update of updates) writing.objectStore("updates").put(update);
    await new Promise((resolve) => (writing.oncomplete = resolve));
    old.close();
  });
  await page.goto(url);
  await expect(page.getByRole("contentinfo")).toContainText("测试项目");
  await tab(page, "assets").click();
  await importFiles(page, files.image);
  await expect(items(page)).toHaveCount(1);
});
