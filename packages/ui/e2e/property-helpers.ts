import { crc32, deflateSync } from "node:zlib";
import type { Locator, Page } from "@playwright/test";
import { compositor, content, expect, findCompositor, tab } from "./support.ts";

export type Color = readonly [red: number, green: number, blue: number];

/** A picture of known size and content, so that where it ends up can be measured. */
export function png(width: number, height: number, pixel: (x: number, y: number) => Color): Buffer {
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) rows.set(pixel(x, y), y * (width * 3 + 1) + 1 + x * 3);
  }
  const chunk = (type: string, data: Buffer) => {
    const size = Buffer.alloc(4);
    size.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const check = Buffer.alloc(4);
    check.writeUInt32BE(crc32(body));
    return Buffer.concat([size, body, check]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

export const red = {
  name: "红色.png",
  mimeType: "image/png",
  buffer: png(100, 100, () => [255, 0, 0]),
};

export const panel = (page: Page) => content(page, "properties");
export const field = (page: Page, name: string) =>
  panel(page).getByRole("spinbutton", { name, exact: true });
export const row = (page: Page, name: string) =>
  panel(page).getByRole("group", { name, exact: true });
export const keyButton = (page: Page, name: string) =>
  row(page, name)
    .getByRole("button", { name: /关键帧$/ })
    .nth(1);
/** The clips of the timeline, and not the keys that show under them. */
export const clips = (page: Page) =>
  content(page, "timeline")
    .getByRole("listbox", { name: "时间轴片段", exact: true })
    .getByRole("option");

export async function goTo(page: Page, time: string) {
  await page.getByRole("contentinfo").getByRole("button", { name: "当前时间和总时长" }).click();
  await page.getByRole("textbox", { name: "当前时间" }).fill(time);
  await page.keyboard.press("Enter");
}

export async function placeImage(page: Page, file = red) {
  await tab(page, "assets").click();
  const chooser = page.waitForEvent("filechooser");
  await content(page, "assets").getByRole("button", { name: "导入" }).click();
  await (await chooser).setFiles(file);
  await content(page, "assets").getByRole("listitem").first().dblclick();
  await tab(page, "properties").click();
  await expect(field(page, "位置 X")).toBeVisible();
}

export async function addColor(page: Page) {
  await tab(page, "timeline").click();
  await content(page, "timeline").getByRole("button", { name: "纯色片段" }).click();
  await expect(clips(page)).toHaveCount(1);
  await tab(page, "properties").click();
  await goTo(page, "0:01/00");
  await expect(field(page, "位置 X")).toBeVisible();
}

export async function typeInto(locator: Locator, text: string) {
  await locator.click();
  await locator.fill(text);
  await locator.press("Enter");
}

/**
 * Keeps the page from getting to its next frame, as on a busy computer, until the returned function
 * is called. Keys can arrive first then, and these tests are about that.
 */
export async function holdFrames(page: Page): Promise<() => Promise<void>> {
  await page.evaluate(() => {
    const waiting: FrameRequestCallback[] = [];
    const original = window.requestAnimationFrame;
    window.requestAnimationFrame = (callback) => waiting.push(callback);
    Object.assign(window, {
      showFrames: () => {
        window.requestAnimationFrame = original;
        for (const callback of waiting) callback(performance.now());
      },
    });
  });
  return () => page.evaluate(() => (window as unknown as { showFrames: () => void }).showFrames());
}

export async function dragField(page: Page, locator: Locator, pixels: number, steps = 8) {
  const box = await locator.boundingBox();
  if (!box) throw new Error("no box");
  const y = box.y + box.height / 2;
  const x = box.x + box.width / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + pixels, y, { steps });
}

export { compositor, findCompositor };

/**
 * The color of a pixel of the picture, in pixels of the picture. None while there is no picture
 * yet, so that polling goes on until there is.
 */
export const colorAt = async (page: Page, x: number, y: number): Promise<readonly number[]> => {
  const read = (await findCompositor(page))?.evaluate(
    ([left = 0, top = 0]) => [
      ...(document.querySelector("canvas")?.getContext("2d")?.getImageData(left, top, 1, 1).data ??
        []),
    ],
    [x, y],
  );
  return (await read?.catch(() => undefined)) ?? [];
};

/** Slack for what scaling and blending do to a color. */
export const near = (found: readonly number[], wanted: Color, within = 2) =>
  wanted.every((value, index) => Math.abs((found[index] ?? -999) - value) <= within);

export const expectColor = (page: Page, x: number, y: number, wanted: Color, within = 2) =>
  expect.poll(async () => near(await colorAt(page, x, y), wanted, within)).toBe(true);

export const BLACK: Color = [0, 0, 0];
