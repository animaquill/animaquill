import { readFileSync } from "node:fs";
import type { Download, Frame, Page } from "@playwright/test";
import { field, placeImage, red, typeInto } from "./property-helpers.ts";
import { needsDevPage } from "./support.ts";
import {
  canCapture,
  content,
  expect,
  goTo,
  importFolder,
  openScene,
  projectFolder,
  tab,
  test,
} from "./scene-support.ts";

const WIDTH = 1920;
const HEIGHT = 1080;

const items = (page: Page) => content(page, "assets").getByRole("listitem");
const dialog = (page: Page) => page.getByRole("dialog");

const video = {
  name: "片子.mp4",
  mimeType: "video/mp4",
  buffer: readFileSync(new URL("./fixtures/clip.mp4", import.meta.url)),
};

async function placeVideo(page: Page) {
  await tab(page, "assets").click();
  const chooser = page.waitForEvent("filechooser");
  await content(page, "assets").getByRole("button", { name: "导入" }).click();
  await (await chooser).setFiles(video);
  await items(page).first().dblclick();
}

const chooseExport = async (page: Page) => {
  await page.locator("header").getByRole("button", { name: "文件", exact: true }).click();
  await page.getByRole("menu").getByRole("menuitem", { name: "导出当前帧", exact: true }).click();
};

const bytesOf = async (download: Download) => {
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
};

/** Exports through the menu, and gives what lands in the downloads. */
async function exportFrame(page: Page): Promise<Buffer> {
  const download = page.waitForEvent("download");
  await chooseExport(page);
  return bytesOf(await download);
}

const sizeOf = (png: Buffer) => ({ width: png.readUInt32BE(16), height: png.readUInt32BE(20) });

/** The frame of the preview, which is not the only compositor there is. */
const previewFrame = async (page: Page): Promise<Frame> => {
  const element = await content(page, "preview").locator("iframe").elementHandle();
  const frame = await element?.contentFrame();
  if (!frame) throw new Error("No compositor");
  return frame;
};

interface Look {
  /** The largest difference of any part of any pixel, between the file and the preview. */
  readonly difference: number;
  /** The color of the pixel, in the file and in the preview. */
  readonly file: readonly number[];
  readonly shown: readonly number[];
}

/**
 * Compares a file with the preview right now. Pixels get read with a VideoFrame, because reading a
 * canvas with `getImageData` can change how it gets drawn from then on.
 */
const look = async (page: Page, png: Buffer | undefined, x = 960, y = 540): Promise<Look> =>
  (await previewFrame(page)).evaluate(
    async ({ base64, left, top }) => {
      const pixelsOf = async (source: CanvasImageSource) => {
        const frame = new VideoFrame(source, { timestamp: 0 });
        const pixels = new Uint8Array(frame.allocationSize({ format: "RGBA" }));
        await frame.copyTo(pixels, { format: "RGBA" });
        frame.close();
        return pixels;
      };
      const canvas = document.querySelector("canvas") as HTMLCanvasElement;
      const colorIn = (pixels: Uint8Array) => {
        const at = (top * canvas.width + left) * 4;
        return Array.from(pixels.subarray(at, at + 3));
      };
      const shown = await pixelsOf(canvas);
      if (base64 === undefined) return { difference: 255, file: [], shown: colorIn(shown) };
      const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
      const file = await pixelsOf(await createImageBitmap(new Blob([bytes])));
      let difference = file.length === shown.length ? 0 : 255;
      for (let index = 0; index < file.length; index += 1) {
        difference = Math.max(difference, Math.abs((file[index] ?? 0) - (shown[index] ?? 0)));
      }
      return { difference, file: colorIn(file), shown: colorIn(shown) };
    },
    { base64: png?.toString("base64"), left: x, top: y },
  );

const differenceFromPreview = async (page: Page, png: Buffer) => (await look(page, png)).difference;
const pixelOf = async (page: Page, png: Buffer, x: number, y: number) =>
  (await look(page, png, x, y)).file;
/** Nothing there while a project opens. */
const colorInPreview = async (page: Page, x?: number, y?: number) =>
  (await look(page, undefined, x, y).catch(() => ({ shown: [] }))).shown;

const close = (a: readonly number[], b: readonly number[]) =>
  a.every((part, index) => Math.abs(part - (b[index] ?? 0)) <= 8);

const RED = [255, 0, 0];
const BLACK = [0, 0, 0];
const WHITE = [255, 255, 255];

/** Changes what is stored for the files of this project, behind the back of the editor. */
const replaceMedia = (page: Page, text: string | undefined) =>
  page.evaluate(async (junk) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open("animaquill");
      open.addEventListener("success", () => resolve(open.result));
      open.addEventListener("error", () => reject(open.error));
    });
    const transaction = database.transaction("media", "readwrite");
    const store = transaction.objectStore("media");
    const all = store.getAll();
    all.addEventListener("success", () => {
      for (const record of all.result as { project: string; hash: string }[]) {
        if (junk === undefined) store.delete([record.project, record.hash]);
        else store.put({ ...record, file: new Blob([junk]) });
      }
    });
    await new Promise((resolve) => transaction.addEventListener("complete", resolve));
    database.close();
  }, text);

/** Keeps the editor from hearing what the export compositor asks for. */
const holdFiles = (page: Page) =>
  page.evaluate(() => {
    const preview = document.querySelector<HTMLIFrameElement>('[data-panel="preview"] iframe');
    const held: MessageEvent[] = [];
    const hold = (event: MessageEvent) => {
      if (event.source === preview?.contentWindow || event.data?.type !== "needs") return;
      event.stopImmediatePropagation();
      held.push(event);
    };
    addEventListener("message", hold, true);
    Object.assign(window, {
      held,
      letGo() {
        removeEventListener("message", hold, true);
        for (const { data, source } of held) {
          dispatchEvent(new MessageEvent("message", { data, source }));
        }
      },
    });
  });

const heldFiles = (page: Page) =>
  page.evaluate(() => (window as unknown as { held: unknown[] }).held.length);
const letFilesGo = (page: Page) =>
  page.evaluate(() => (window as unknown as { letGo: () => void }).letGo());

/** The size of the canvas of the export compositor, which only gets one by drawing. */
const sizeInExport = async (page: Page) => {
  const shown = await previewFrame(page);
  const frame = page
    .frames()
    .find((candidate) => candidate !== shown && candidate.url().includes("compositor.html"));
  if (!frame) throw new Error("No compositor");
  return frame.evaluate(() => {
    const { width, height } = document.querySelector("canvas") as HTMLCanvasElement;
    return { width, height };
  });
};

const noDownload = (page: Page) => {
  const seen: Download[] = [];
  page.on("download", (download) => seen.push(download));
  return seen;
};

/** There is nothing left of it when it is over. */
const noExportCompositor = async (page: Page) => {
  await expect
    .poll(() => page.frames().filter((frame) => frame.url().includes("compositor.html")).length)
    .toBeLessThanOrEqual(2);
};

test.describe("a frame with pictures", () => {
  test("has the size of the output and is the same as the preview", async ({ page }) => {
    await placeImage(page);
    await expect.poll(async () => close(await colorInPreview(page), RED)).toBe(true);
    const png = await exportFrame(page);
    expect(sizeOf(png)).toEqual({ width: WIDTH, height: HEIGHT });
    expect(await differenceFromPreview(page, png)).toBeLessThanOrEqual(2);
    await expect(page.getByRole("status").getByText("已导出")).toBeVisible();
    await noExportCompositor(page);
  });

  test("of a video is the frame of the playhead, like the preview", async ({ page }) => {
    await placeVideo(page);
    await goTo(page, "0:01/00");
    await expect.poll(async () => close(await colorInPreview(page), BLACK)).toBe(false);
    const png = await exportFrame(page);
    expect(await differenceFromPreview(page, png)).toBeLessThanOrEqual(2);
  });

  test("has all the pixels of the output whatever the preview draws at", async ({ page }) => {
    const quality = async (name: string) => {
      await content(page, "preview").getByRole("button", { name: "预览画质" }).click();
      await page.getByRole("radio", { name: new RegExp(`^${name}`) }).click();
    };
    await placeVideo(page);
    await goTo(page, "0:01/00");
    await quality("1/4");
    await expect(content(page, "preview").getByRole("button", { name: "预览画质" })).toHaveText(
      "画质 1/4",
    );
    await expect.poll(async () => close(await colorInPreview(page, 100, 50), BLACK)).toBe(false);
    const png = await exportFrame(page);
    expect(sizeOf(png)).toEqual({ width: WIDTH, height: HEIGHT });
    // The same as the preview at full quality, pixel for pixel, and not a picture made larger.
    await quality("全分辨率");
    await expect.poll(() => differenceFromPreview(page, png)).toBeLessThanOrEqual(2);
  });

  test("waits for a file that takes long, and draws nothing until then", async ({ page }) => {
    await placeImage(page);
    await expect.poll(async () => close(await colorInPreview(page), RED)).toBe(true);
    await holdFiles(page);
    const download = page.waitForEvent("download");
    await chooseExport(page);
    await expect.poll(() => heldFiles(page)).toBe(1);
    await expect(dialog(page)).toContainText("正在导出当前帧");
    expect(await sizeInExport(page)).toEqual({ width: 300, height: 150 });
    await letFilesGo(page);
    const png = await bytesOf(await download);
    expect(await differenceFromPreview(page, png)).toBeLessThanOrEqual(2);
  });

  test("does not exist when the file is gone, and it says which", async ({ page }) => {
    await placeImage(page);
    await expect.poll(async () => close(await colorInPreview(page), RED)).toBe(true);
    await replaceMedia(page, undefined);
    const downloads = noDownload(page);
    await chooseExport(page);
    await expect(dialog(page)).toContainText("当前帧没有导出");
    await expect(dialog(page)).toContainText("“红色.png”的素材文件不在这台设备上");
    expect(downloads).toHaveLength(0);
  });

  test("does not exist when the file cannot be read", async ({ page }) => {
    await placeVideo(page);
    await expect.poll(async () => close(await colorInPreview(page), BLACK)).toBe(false);
    await replaceMedia(page, "这不是视频");
    const downloads = noDownload(page);
    await chooseExport(page);
    await expect(dialog(page)).toContainText("“片子.mp4”的素材读不出来");
    expect(downloads).toHaveLength(0);
  });

  test("leaves out what is only being tried, unless people save it", async ({ page }) => {
    await placeImage(page);
    await typeInto(field(page, "不透明度"), "50");
    await expect.poll(async () => close(await colorInPreview(page), [128, 0, 0])).toBe(true);

    let download = page.waitForEvent("download");
    await chooseExport(page);
    await expect(dialog(page)).toContainText("导出的是已保存的内容，不包括试改");
    await dialog(page).getByRole("button", { name: "导出已保存的内容" }).click();
    const saved = await bytesOf(await download);
    expect(close(await pixelOf(page, saved, 960, 540), RED)).toBe(true);
    expect(await differenceFromPreview(page, saved)).toBeGreaterThan(100);

    download = page.waitForEvent("download");
    await chooseExport(page);
    await dialog(page).getByRole("button", { name: "保存后导出" }).click();
    const tried = await bytesOf(await download);
    expect(close(await pixelOf(page, tried, 960, 540), [128, 0, 0])).toBe(true);
    await expect.poll(() => differenceFromPreview(page, tried)).toBeLessThanOrEqual(2);
  });

  test("can be cancelled, and then there is no file", async ({ page }) => {
    await placeImage(page);
    await page.route("**/compositor.html*", () => {});
    const downloads = noDownload(page);
    await chooseExport(page);
    await dialog(page).getByRole("button", { name: "取消" }).click();
    await expect(page.getByRole("status").getByText("导出已取消")).toBeVisible();
    await noExportCompositor(page);
    expect(downloads).toHaveLength(0);
  });
});

/** A white square on black that goes from left to right, at 192 world units a second. */
const SLIDE = `<!doctype html><style>
  body { background: #000 }
  #square { position: absolute; left: 0; top: 490px; width: 100px; height: 100px; background: #fff;
    animation: slide 10s linear both }
  @keyframes slide { to { transform: translateX(1920px) } }
</style><div id="square"></div>`;

test.describe("a frame with a scene", () => {
  test.use({ withProject: false });

  test.describe("that can be captured", () => {
    test.skip(!canCapture, "needs a browser that can capture");

    test("is the frame of the playhead, whatever the scene had before", async ({ page }) => {
      await openScene(page, SLIDE);
      await goTo(page, "0:05/00");
      const png = await exportFrame(page);
      expect(close(await pixelOf(page, png, 5 * 192 + 50, 540), WHITE)).toBe(true);
      expect(close(await pixelOf(page, png, 50, 540), BLACK)).toBe(true);
      await noExportCompositor(page);
    });

    test("draws nothing by itself while it waits, also when the scene is there", async ({
      page,
    }) => {
      await openScene(page, SLIDE, { above: true });
      // It goes under the scene, which covers it, and it still has to be there.
      await tab(page, "assets").click();
      const chooser = page.waitForEvent("filechooser");
      await content(page, "assets").getByRole("button", { name: "导入" }).click();
      await (await chooser).setFiles(red);
      await items(page).filter({ hasText: "红色.png" }).dblclick();
      await expect(content(page, "timeline").getByRole("option")).toHaveCount(2);
      await expect.poll(async () => close(await colorInPreview(page, 50, 540), WHITE)).toBe(true);
      await holdFiles(page);
      const download = page.waitForEvent("download");
      await chooseExport(page);
      await expect.poll(() => heldFiles(page)).toBe(1);
      // Long enough for the scene to get there and to have a picture.
      await page.waitForTimeout(3000);
      expect(await sizeInExport(page)).toEqual({ width: 300, height: 150 });
      await letFilesGo(page);
      const png = await bytesOf(await download);
      expect(await differenceFromPreview(page, png)).toBeLessThanOrEqual(2);
    });

    test("is the same as the preview", async ({ page }) => {
      await openScene(page, SLIDE);
      await goTo(page, "0:03/15");
      await expect.poll(async () => close(await colorInPreview(page, 722, 540), WHITE)).toBe(true);
      const png = await exportFrame(page);
      expect(await differenceFromPreview(page, png)).toBeLessThanOrEqual(2);
    });

    test("does not exist when the scene stopped", async ({ page, problems }) => {
      await importFolder(page, projectFolder({ a: { "other.html": "<p>a</p>" } }, [{}]));
      await dialog(page).getByRole("button").click();
      const downloads = noDownload(page);
      await chooseExport(page);
      await expect(dialog(page)).toContainText("当前帧没有导出");
      await expect(dialog(page)).toContainText("入口文件不在");
      expect(downloads).toHaveLength(0);
      problems.splice(0);
    });

    test("does not exist when the scene gets there without a picture", async ({ page }) => {
      test.setTimeout(30000);
      // What gets captured has to be in the canvas.
      const gone = `<!doctype html><p>a</p><script>document.body.remove()</script>`;
      await openScene(page, gone);
      const downloads = noDownload(page);
      await chooseExport(page);
      await expect(dialog(page)).toContainText("没有给出第 0 帧的画面", { timeout: 20000 });
      expect(downloads).toHaveLength(0);
    });
  });

  test("does not exist as a placeholder", async ({ page, devPage }) => {
    test.skip(!devPage, needsDevPage("?sceneStage=plain, where a scene stays a placeholder"));
    await page.goto("/?sceneStage=plain");
    await openScene(page, SLIDE);
    const downloads = noDownload(page);
    await chooseExport(page);
    await expect(dialog(page)).toContainText("这个浏览器不能捕获场景");
    expect(downloads).toHaveLength(0);
  });
});
