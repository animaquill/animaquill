import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createProject, writeProject, type SoundManifest } from "@animaquill/schema";
import type { Locator, Page } from "@playwright/test";
import { importFolder } from "./scene-support.ts";
import { chooseLayout, content, expect, tab, test } from "./support.ts";

// Making a sound starts a page and a worker, which takes its time on a busy computer.
test.describe.configure({ timeout: 90_000 });

/**
 * Pink noise at −20 dBFS, as AES17 has dBFS: its RMS is that of a sine at −20 dBFS, 3 dB below
 * the sine's peak. As one sound in the middle it is on both sides, and BS.1770 reads it as about
 * −20 LUFS, as a sine at −20 dBFS on both sides is exactly.
 */
const PINK = `aq.sound(({ frames }) => {
  const samples = new Float32Array(frames);
  let state = 1;
  const white = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 31 - 1;
  };
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  let sum = 0;
  for (let at = 0; at < frames; at += 1) {
    const w = white();
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856;
    b4 = 0.55 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.016898;
    const value = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
    b6 = w * 0.115926;
    samples[at] = value;
    sum += value * value;
  }
  const gain = 0.1 / Math.SQRT2 / Math.sqrt(sum / frames);
  for (let at = 0; at < frames; at += 1) samples[at] *= gain;
  return samples;
});`;

/** A project with ten seconds of pink noise on a track of sound called 配音. */
function noiseFolder(): string {
  const manifests: [string, SoundManifest][] = [
    ["pink", { name: "粉红噪声", entry: "sound.js", runtime: 1 }],
  ];
  const project = { ...createProject({ name: "混音项目" }), sounds: new Map(manifests) };
  const files = writeProject(project);
  const path = "timelines/main/timeline.json";
  const main = JSON.parse(files.get(path) as string) as {
    sections: { duration: string }[];
    tracks: unknown[];
  };
  main.sections = main.sections.map((section) => ({ ...section, duration: "30" }));
  main.tracks.push({
    id: "voice",
    kind: "audio",
    name: "配音",
    clips: [
      {
        id: "noise",
        name: "粉红噪声",
        start: "0",
        duration: "10",
        source: { kind: "sound", sound: "pink" },
        properties: { "param.duration": 10 },
      },
    ],
  });
  files.set(path, JSON.stringify(main));
  files.set("sounds/pink/sound.js", PINK);
  const root = join(mkdtempSync(join(tmpdir(), "animaquill-mixer-")), "项目");
  for (const [name, text] of files) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), text);
  }
  return root;
}

const mixer = (page: Page) => content(page, "mixer");
const strip = (page: Page) => mixer(page).getByRole("group", { name: "配音", exact: true });
const fader = (page: Page) => strip(page).getByRole("slider", { name: "配音 音量" });
const meterOf = (page: Page, name: string) => mixer(page).getByRole("img", { name });
const play = (page: Page) =>
  content(page, "preview").getByRole("button", { name: "播放", exact: true }).click();
const pause = (page: Page) =>
  content(page, "preview").getByRole("button", { name: "暂停", exact: true }).click();

/** What a meter shows, in dBFS; −∞ at the bottom. */
async function levelOf(meter: Locator): Promise<number> {
  const level = await meter.getAttribute("data-level");
  return level ? Number(level) : Number.NEGATIVE_INFINITY;
}

/** The short-term loudness the master reads, in LUFS. */
async function loudness(page: Page): Promise<number> {
  const text = (await mixer(page).getByTestId("mixer-loudness").textContent()) ?? "";
  const value = Number(text.replace("−", "-"));
  return Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY;
}

async function openNoise(page: Page) {
  await importFolder(page, noiseFolder());
  await chooseLayout(page, "音频");
  await expect(mixer(page)).toBeVisible();
  await expect(strip(page)).toBeVisible();
  // The sound is made once: until then it is silent.
  await expect(content(page, "timeline").getByRole("option").first()).toHaveAttribute(
    "aria-label",
    /^粉红噪声，/,
    { timeout: 30_000 },
  );
}

test.describe("the mixer", () => {
  test("is in the audio layout, and its meters move while playing and drop when it stops", async ({
    page,
  }) => {
    await openNoise(page);
    await expect(tab(page, "mixer")).toBeVisible();
    await expect(mixer(page).getByRole("group", { name: "主输出" })).toBeVisible();
    const track = meterOf(page, "配音 电平");
    const left = meterOf(page, "主输出 左声道 电平");
    expect(await levelOf(track)).toBe(Number.NEGATIVE_INFINITY);
    await play(page);
    await expect.poll(() => levelOf(track), { timeout: 10_000 }).toBeGreaterThan(-30);
    await expect.poll(() => levelOf(left)).toBeGreaterThan(-30);
    // It moves: not one value all along.
    const seen = new Set<number>();
    await expect
      .poll(
        async () => {
          seen.add(await levelOf(track));
          return seen.size;
        },
        { intervals: [100] },
      )
      .toBeGreaterThan(3);
    // Pink noise at −20 dBFS reads −20 LUFS, once 3 s of it played.
    await page.waitForTimeout(3200);
    const lufs = await loudness(page);
    expect(lufs).toBeGreaterThan(-21);
    expect(lufs).toBeLessThan(-19);
    await pause(page);
    await expect.poll(() => levelOf(track)).toBe(Number.NEGATIVE_INFINITY);
    await expect.poll(() => levelOf(left)).toBe(Number.NEGATIVE_INFINITY);
    console.log(`loudness of −20 dBFS pink noise: ${lufs} LUFS`);
  });

  test("is heard while a fader moves, and letting go is one step to undo", async ({ page }) => {
    await openNoise(page);
    const track = meterOf(page, "配音 电平");
    await expect(fader(page)).toHaveAttribute("aria-valuetext", "0.0 dB");
    await play(page);
    await expect.poll(() => levelOf(track), { timeout: 10_000 }).toBeGreaterThan(-30);
    // Loud as it is, the peaks of a tenth of a second stay within a few dB of each other.
    const before = await levelOf(track);
    const box = await fader(page).boundingBox();
    if (!box) throw new Error("no fader");
    const x = box.x + box.width / 2;
    const unity = box.y + box.height * (1 - 2 / 3);
    await page.mouse.move(x, unity);
    await page.mouse.down();
    await page.mouse.move(x, unity + box.height * 0.3, { steps: 6 });
    const held = await fader(page).getAttribute("aria-valuetext");
    expect(held).toMatch(/^−\d+\.\d dB$/);
    const down = Number((held ?? "").replace("−", "-").replace(" dB", ""));
    expect(down).toBeLessThan(-12);
    // Heard before it is written: the meter after the fader goes down with it.
    await expect.poll(() => levelOf(track)).toBeLessThan(before + down + 6);
    await page.mouse.up();
    await expect(strip(page).getByRole("textbox", { name: "配音 音量数值" })).toHaveValue(
      (held ?? "").replace(" dB", ""),
    );
    await pause(page);
    await page.keyboard.press("Control+z");
    await expect(fader(page)).toHaveAttribute("aria-valuetext", "0.0 dB");
    await page.keyboard.press("Control+Shift+z");
    await expect(fader(page)).toHaveAttribute("aria-valuetext", held ?? "");
    // A double click goes back to 0 dB, as one step.
    await fader(page).dblclick();
    await expect(fader(page)).toHaveAttribute("aria-valuetext", "0.0 dB");
    await page.keyboard.press("Control+z");
    await expect(fader(page)).toHaveAttribute("aria-valuetext", held ?? "");
  });

  test("solos the same track as the S of the timeline, and shows a selected track in the properties and the keyframes", async ({
    page,
  }) => {
    await openNoise(page);
    const solo = strip(page).getByRole("button", { name: "独奏 配音" });
    const header = content(page, "timeline").getByRole("button", { name: "独奏 配音" });
    await solo.click();
    await expect(solo).toHaveAttribute("aria-pressed", "true");
    await expect(header).toHaveAttribute("aria-pressed", "true");
    await header.click();
    await expect(solo).toHaveAttribute("aria-pressed", "false");
    await expect(header).toHaveAttribute("aria-pressed", "false");

    await strip(page).getByRole("button", { name: "配音", exact: true }).click();
    await tab(page, "properties").click();
    const properties = content(page, "properties");
    await expect(properties.getByRole("slider", { name: "音量" })).toBeVisible();
    await expect(properties.getByRole("slider", { name: "声像" })).toBeVisible();
    await tab(page, "keyframes").click();
    await expect(content(page, "keyframes").getByText("轨道", { exact: true })).toBeVisible();
    // The pan knob writes what the properties show.
    await tab(page, "mixer").click();
    const knob = strip(page).getByRole("slider", { name: "配音 声像" });
    const box = await knob.boundingBox();
    if (!box) throw new Error("no knob");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 50, { steps: 5 });
    await page.mouse.up();
    await expect(knob).toHaveAttribute("aria-valuetext", "L 50");
    await tab(page, "properties").click();
    await expect(properties.getByRole("slider", { name: "声像" })).toHaveAttribute(
      "aria-valuetext",
      "L 50",
    );
  });

  test("can be opened from the view menu and the command palette", async ({ page }) => {
    await page.locator("header").getByRole("button", { name: "视图", exact: true }).click();
    await page.getByRole("menu").getByRole("menuitem", { name: "混音器", exact: true }).click();
    await expect(mixer(page)).toBeVisible();
    await tab(page, "mixer").click({ button: "middle" });
    await expect(mixer(page)).toHaveCount(0);
    await page.keyboard.press("Control+Shift+KeyP");
    await page.getByRole("combobox", { name: "命令面板" }).fill("混音器");
    await page.keyboard.press("Enter");
    await expect(mixer(page)).toBeVisible();
  });
});
