import { readFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import { content, expect, tab, test } from "./support.ts";

const video = {
  name: "红色.webm",
  mimeType: "video/webm",
  buffer: readFileSync(new URL("./fixtures/red.webm", import.meta.url)),
};

const items = (page: Page) => content(page, "assets").getByRole("listitem");

/** The colour in the middle of the picture. */
async function middle(page: Page): Promise<readonly number[]> {
  const frame = page.frames().find((candidate) => candidate.url().includes("compositor"));
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

async function putVideoOnTimeline(page: Page) {
  await tab(page, "assets").click();
  const chooser = page.waitForEvent("filechooser");
  await content(page, "assets").getByRole("button", { name: "导入" }).click();
  await (await chooser).setFiles(video);
  await items(page).first().dblclick();
}

test("shows the frame of a video at the playhead", async ({ page }) => {
  await putVideoOnTimeline(page);
  await expect.poll(() => isRed(page)).toBe(true);
});

test("goes dark when the clip is gone, and comes back with undo", async ({ page }) => {
  await putVideoOnTimeline(page);
  await expect.poll(() => isRed(page)).toBe(true);
  await page.keyboard.press("Control+z");
  await expect.poll(() => isRed(page)).toBe(false);
  await page.keyboard.press("Control+Shift+z");
  await expect.poll(() => isRed(page)).toBe(true);
});

test("shows the same picture after a reload", async ({ page }) => {
  await putVideoOnTimeline(page);
  await expect.poll(() => isRed(page)).toBe(true);
  await page.reload();
  await expect.poll(() => isRed(page)).toBe(true);
});

test("the picture runs in a sandbox without access to the editor", async ({ page }) => {
  const frame = content(page, "preview").locator("iframe");
  await expect(frame).toHaveAttribute("sandbox", "allow-scripts");
});

test("clicking the picture leaves the keyboard with the editor", async ({ page }) => {
  await putVideoOnTimeline(page);
  await expect.poll(() => isRed(page)).toBe(true);
  await content(page, "preview").locator("iframe").click({ force: true });
  await page.keyboard.press("Control+z");
  await expect.poll(() => isRed(page)).toBe(false);
});
