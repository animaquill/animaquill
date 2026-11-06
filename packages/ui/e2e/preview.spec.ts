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

const redBlue = {
  name: "红蓝.webm",
  mimeType: "video/webm",
  buffer: readFileSync(new URL("./fixtures/red-blue.webm", import.meta.url)),
};

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

const isBlue = async (page: Page) => {
  const [red = 255, green = 255, blue = 0] = await middle(page);
  return red < 60 && green < 60 && blue > 200;
};

async function importAndPlace(
  page: Page,
  file: { name: string; mimeType: string; buffer: Buffer },
) {
  await tab(page, "assets").click();
  const chooser = page.waitForEvent("filechooser");
  await content(page, "assets").getByRole("button", { name: "导入" }).click();
  await (await chooser).setFiles(file);
  await items(page).first().dblclick();
}

const button = (page: Page, name: string) =>
  content(page, "preview").getByRole("button", { name, exact: true });

async function goTo(page: Page, time: string) {
  await page.getByRole("contentinfo").getByRole("button", { name: "当前时间和总时长" }).click();
  await page.getByRole("textbox", { name: "当前时间" }).fill(time);
  await page.keyboard.press("Enter");
}

test("finds frames going forwards and backwards in a video", async ({ page }) => {
  await importAndPlace(page, redBlue);
  await expect.poll(() => isRed(page)).toBe(true);
  await goTo(page, "0:01/15");
  await expect.poll(() => isBlue(page)).toBe(true);
  await goTo(page, "0:00/05");
  await expect.poll(() => isRed(page)).toBe(true);
});

test("the picture changes while playing", async ({ page }) => {
  await importAndPlace(page, redBlue);
  await expect.poll(() => isRed(page)).toBe(true);
  await button(page, "播放").click();
  await expect.poll(() => isBlue(page)).toBe(true);
});

test("plays sound, and stops when paused", async ({ page }) => {
  await page.addInitScript(() => {
    const { start } = AudioBufferSourceNode.prototype;
    const counter = window as unknown as { sounds: number };
    counter.sounds = 0;
    AudioBufferSourceNode.prototype.start = function count(...args) {
      counter.sounds += 1;
      start.apply(this, args);
    };
  });
  await page.reload();
  await importAndPlace(page, { name: "配音.wav", mimeType: "audio/wav", buffer: wav(10) });
  const sounds = () => page.evaluate(() => (window as unknown as { sounds: number }).sounds);
  await button(page, "播放").click();
  await expect.poll(sounds).toBeGreaterThan(0);
  await button(page, "暂停").click();
  await page.waitForTimeout(300);
  const stopped = await sounds();
  await page.waitForTimeout(500);
  expect(await sounds()).toBe(stopped);
});
