import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createProject, writeProject } from "@animaquill/schema";
import type { Page } from "@playwright/test";
import { chooseFolder } from "./scene-support.ts";
import { content, expect, tab, test } from "./support.ts";

/**
 * The volume line on clips of sound (audio-mixing.md 1.1 and 1.2 of AnimaQuill Cloud, M2): over the
 * waveform, 0 dB a third from the top; a drag sets the volume, Ctrl and a click puts a key, Delete
 * takes a selected one away, and undo takes each back. The properties tab has its volume and pan.
 */

/** A WAV file of a sine tone, mono at 48 kHz, at half of full scale. */
function tone(seconds: number, hz = 1000): Buffer {
  const rate = 48_000;
  const count = Math.round(seconds * rate);
  const data = Buffer.alloc(count * 2);
  for (let index = 0; index < count; index += 1) {
    const value = Math.sin((2 * Math.PI * hz * index) / rate) * 0.5;
    data.writeInt16LE(Math.round(value * 32767), index * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/** A project with one clip of sound on the track for sound, from 0 to 6 s. */
function soundFolder(properties: Record<string, unknown> = {}): string {
  const files: Map<string, string | Buffer> = writeProject(createProject({ name: "音量线" }));
  const path = "timelines/main/timeline.json";
  const timeline = JSON.parse(files.get(path) as string) as {
    sections: { duration: string }[];
    tracks: { kind: string; clips: unknown[] }[];
  };
  timeline.sections = timeline.sections.map((section) => ({ ...section, duration: "8" }));
  const audio = timeline.tracks.find(({ kind }) => kind === "audio");
  if (!audio) throw new Error("no track of sound");
  audio.clips = [
    {
      id: "tone",
      name: "测试音",
      start: "0",
      duration: "6",
      source: { kind: "audio", media: { asset: "tone" } },
      properties,
    },
  ];
  files.set(path, JSON.stringify(timeline));
  files.set(
    "assets.json",
    JSON.stringify({
      assets: { tone: { name: "测试音", kind: "audio", path: "assets/tone.wav", storage: "git" } },
    }),
  );
  files.set("assets/tone.wav", tone(6));
  const root = join(mkdtempSync(join(tmpdir(), "animaquill-volume-")), "项目");
  for (const [name, text] of files) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), text);
  }
  return root;
}

async function open(page: Page, properties: Record<string, unknown> = {}) {
  await chooseFolder(page, soundFolder(properties));
  await expect(tab(page, "preview")).toBeVisible({ timeout: 30_000 });
  await tab(page, "timeline").click();
}

/** The clip on the canvas, where the list of clips says it is. */
async function clipBox(page: Page) {
  const box = await content(page, "timeline").getByRole("option").first().boundingBox();
  if (!box) throw new Error("No clip");
  return box;
}

/** Where 0 dB is on the clip, a third from the top of it (with room of 3 pixels at each end). */
const unityY = (box: { y: number; height: number }) => box.y + 3 + (box.height - 6) / 3;

const volumeField = (page: Page) =>
  content(page, "properties").getByRole("spinbutton", { name: "音量" });

const stageCursor = (page: Page) =>
  content(page, "timeline")
    .getByRole("group", { name: "时间轴" })
    .evaluate((element) => getComputedStyle(element).cursor);

test.use({ withProject: false });

test("a drag on the line sets the volume of the clip, and undo takes it back", async ({ page }) => {
  await open(page);
  const box = await clipBox(page);
  const x = box.x + box.width / 2;
  const y = unityY(box);
  await page.mouse.move(x, y);
  await expect.poll(() => stageCursor(page)).toBe("ns-resize");
  await page.mouse.down();
  await page.mouse.move(x, y + 6, { steps: 2 });
  await page.mouse.move(x, y + 12, { steps: 2 });
  await page.mouse.up();
  // A click on the line selects the clip as anywhere else on it.
  await page.mouse.click(box.x + box.width / 2, box.y + box.height - 6);
  await tab(page, "properties").click();
  await expect(volumeField(page)).toHaveAttribute("aria-valuetext", /^−\d+\.\d dB$/u);
  const value = Number(await volumeField(page).getAttribute("aria-valuenow"));
  expect(value).toBeLessThan(-1);
  await expect(content(page, "properties").getByRole("slider", { name: "声像" })).toHaveAttribute(
    "aria-valuetext",
    "C",
  );
  await tab(page, "timeline").click();
  await page.keyboard.press("Control+z");
  await tab(page, "properties").click();
  await expect(volumeField(page)).toHaveAttribute("aria-valuetext", "0.0 dB");
});

test("Ctrl and a click on the line puts a key there, which Delete takes away", async ({ page }) => {
  await open(page, {
    "audio.volume": {
      keys: [
        { time: "1", value: 0 },
        { time: "5", value: -20 },
      ],
    },
  });
  const box = await clipBox(page);
  // 3 s of 6, halfway between the keys: −10 dB, below 0 dB.
  const x = box.x + box.width / 2;
  // Finds the line where it is under the pointer: the cursor says so.
  let y = unityY(box);
  for (let down = 0; down < box.height / 2; down += 1) {
    await page.mouse.move(x, unityY(box) + down);
    if ((await stageCursor(page)) === "ns-resize") {
      y = unityY(box) + down;
      break;
    }
  }
  await page.keyboard.down("Control");
  await page.mouse.move(x, y);
  await expect.poll(() => stageCursor(page)).toBe("copy");
  await page.mouse.click(x, y);
  await page.keyboard.up("Control");
  await page.mouse.move(x, y);
  await expect.poll(() => stageCursor(page)).toBe("move");
  // The key is selected: Delete takes it away, and the line is back to where it was.
  await page.keyboard.press("Delete");
  await page.mouse.move(x, y + 1);
  await expect.poll(() => stageCursor(page)).toBe("ns-resize");
  await page.keyboard.press("Control+z");
  await page.mouse.move(x, y);
  await expect.poll(() => stageCursor(page)).toBe("move");
});
