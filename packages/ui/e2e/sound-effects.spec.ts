import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createProject, writeProject, type SoundManifest } from "@animaquill/schema";
import type { Locator, Page } from "@playwright/test";
import { importFolder } from "./scene-support.ts";
import { chooseLayout, content, expect, tab, test } from "./support.ts";

/**
 * Effects of sound in the interface (audio-mixing.md 1.3, 1.6): the tab of sound effects, the
 * slots of the mixer, the graphs of the equalizer and the compressor and the rooms of the reverb in
 * the properties tab, each change one step that undo takes back.
 */

test.describe.configure({ timeout: 90_000 });

/** A quiet sound made by code: what it sounds like does not matter here. */
const HUM = `aq.sound(({ frames, rate }) => {
  const samples = new Float32Array(frames);
  for (let at = 0; at < frames; at += 1) samples[at] = 0.1 * Math.sin((2 * Math.PI * 220 * at) / rate);
  return samples;
});`;

/** Ten seconds of a hum on a track of sound called 配音. */
function humFolder(): string {
  const manifests: [string, SoundManifest][] = [
    ["hum", { name: "嗡声", entry: "sound.js", runtime: 1 }],
  ];
  const project = { ...createProject({ name: "效果项目" }), sounds: new Map(manifests) };
  const files = writeProject(project);
  const path = "timelines/main/timeline.json";
  const main = JSON.parse(files.get(path) as string) as {
    sections: { duration: string }[];
    tracks: unknown[];
  };
  main.sections = main.sections.map((section) => ({ ...section, duration: "20" }));
  main.tracks.push({
    id: "voice",
    kind: "audio",
    name: "配音",
    clips: [
      {
        id: "hum",
        name: "嗡声",
        start: "0",
        duration: "10",
        source: { kind: "sound", sound: "hum" },
        properties: { "param.duration": 10 },
      },
    ],
  });
  files.set(path, JSON.stringify(main));
  files.set("sounds/hum/sound.js", HUM);
  const root = join(mkdtempSync(join(tmpdir(), "animaquill-effects-")), "项目");
  for (const [name, text] of files) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), text);
  }
  return root;
}

const mixer = (page: Page) => content(page, "mixer");
const strip = (page: Page) => mixer(page).getByRole("group", { name: "配音", exact: true });
const master = (page: Page) => mixer(page).getByRole("group", { name: "主输出", exact: true });
const slotsOf = (where: Locator) => where.getByRole("list").first().getByRole("listitem");
const soundTab = (page: Page) => content(page, "soundEffects");
const properties = (page: Page) => content(page, "properties");
const effectList = (page: Page) => properties(page).getByRole("region", { name: "效果" });
const undo = (page: Page) => page.keyboard.press("Control+z");

async function open(page: Page) {
  await importFolder(page, humFolder());
  await chooseLayout(page, "音频");
  await expect(strip(page)).toBeVisible();
}

async function boxOf(locator: Locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error("not on screen");
  return box;
}

/** Drags an effect from the tab of sound effects onto a place. */
async function dragEffect(page: Page, name: string, to: Locator) {
  await tab(page, "soundEffects").click();
  const item = soundTab(page).getByRole("option", { name, exact: true }).first();
  await item.scrollIntoViewIfNeeded();
  const from = await boxOf(item);
  const target = await boxOf(to);
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 + 10, from.y + from.height / 2 + 10, { steps: 3 });
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 12 });
  await page.mouse.move(target.x + target.width / 2 + 1, target.y + target.height / 2, {
    steps: 2,
  });
  await page.mouse.up();
}

/** The number field of a row of the properties tab. */
const field = (page: Page, name: string) =>
  properties(page).getByRole("group", { name, exact: true }).getByRole("spinbutton").first();

test.describe("effects of sound", () => {
  test("come from their tab by group, onto a clip, the header of a track and a strip of the mixer", async ({
    page,
  }) => {
    await open(page);
    await tab(page, "soundEffects").click();
    const groups = soundTab(page).getByRole("group");
    await expect(groups.nth(0)).toHaveAccessibleName("均衡");
    await expect(groups.nth(1)).toHaveAccessibleName("动态");
    await expect(groups.nth(2)).toHaveAccessibleName("空间");
    await expect(soundTab(page).getByRole("option")).toHaveCount(4);
    // The effects of pictures are in their own tab.
    await expect(soundTab(page).getByRole("option", { name: "模糊" })).toHaveCount(0);

    // Onto the header of the track: the mixer has its slot.
    const header = content(page, "timeline").getByText("配音", { exact: true }).first();
    await dragEffect(page, "均衡", header);
    await page.screenshot({ path: test.info().outputPath("header-drop.png") });
    await expect(slotsOf(strip(page))).toHaveCount(1);
    await expect(slotsOf(strip(page)).first()).toContainText("均衡");
    // Onto the strip in the mixer, in front of the equalizer.
    await dragEffect(page, "压缩", slotsOf(strip(page)).first());
    await expect(slotsOf(strip(page))).toHaveCount(2);
    // Onto the clip.
    const clip = content(page, "timeline").getByRole("option").first();
    await dragEffect(page, "混响", clip);
    await expect(effectList(page).getByRole("listitem", { name: "混响" })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("sound-effects-tab.png") });
    await undo(page);
    await expect(effectList(page)).toHaveCount(0);
  });

  test("have a graph in the properties: an equalizer's points dragged, wheeled, reset and turned on", async ({
    page,
  }) => {
    await open(page);
    const add = strip(page).getByRole("button", { name: "添加效果" });
    await add.click();
    await page.getByRole("menuitem", { name: "均衡" }).click();
    await slotsOf(strip(page)).first().getByRole("button", { name: "均衡", exact: true }).click();
    const graph = properties(page).locator("[data-eq-graph]");
    await expect(graph).toBeVisible();
    const box = await boxOf(graph);
    // Band 4 (mid 2, 1 kHz) dragged down a quarter of what the graph draws (8 of 120 around it):
    // −12 dB.
    const point = graph.locator('[data-band="mid2"]');
    const at = await boxOf(point);
    await page.mouse.move(at.x + at.width / 2, at.y + at.height / 2);
    await page.mouse.down();
    const quarter = (box.height * (104 / 120)) / 4;
    await page.mouse.move(at.x + at.width / 2, at.y + at.height / 2 + quarter, { steps: 6 });
    await page.mouse.up();
    await expect(point).toHaveAttribute("data-on", "true");
    await expect(field(page, "中频 2 增益")).toHaveValue(/−1[12]\./);
    // The wheel narrows it.
    const q = field(page, "中频 2 Q");
    await expect(q).toHaveValue("1");
    await point.hover();
    await page.mouse.wheel(0, -100);
    await expect(q).toHaveValue("1.12");
    // A double click is back to 0 dB, one step.
    await point.dblclick();
    await expect(point).not.toHaveAttribute("data-on", "true");
    await undo(page);
    await expect(point).toHaveAttribute("data-on", "true");
    // A click on the high pass turns it on.
    const pass = graph.locator('[data-band="hp"]');
    await pass.click();
    await expect(pass).toHaveAttribute("data-on", "true");
    await properties(page).screenshot({ path: test.info().outputPath("eq-panel.png") });
  });

  test("a compressor's knee sets its threshold, and a room of the reverb is one step", async ({
    page,
  }) => {
    await open(page);
    const add = strip(page).getByRole("button", { name: "添加效果" });
    await add.click();
    await page.getByRole("menuitem", { name: "压缩" }).click();
    await add.click();
    await page.getByRole("menuitem", { name: "混响" }).click();
    await slotsOf(strip(page)).first().getByRole("button", { name: "压缩", exact: true }).click();
    const graph = properties(page).locator("[data-compressor-graph]");
    await expect(graph).toBeVisible();
    const box = await boxOf(graph);
    const knee = graph.locator('[data-part="knee"]');
    const at = await boxOf(knee);
    await page.mouse.move(at.x + at.width / 2, at.y + at.height / 2);
    await page.mouse.down();
    // To the middle across: −30 dB.
    await page.mouse.move(box.x + box.width / 2, at.y + at.height / 2, { steps: 6 });
    await page.mouse.up();
    await expect(field(page, "阈值")).toHaveValue(/−30/);
    await properties(page).screenshot({ path: test.info().outputPath("compressor-panel.png") });

    const preset = properties(page).getByRole("combobox", { name: "预设" });
    await preset.selectOption({ label: "大厅" });
    const decay = field(page, "衰减时间");
    await expect(decay).toHaveValue("2.2s");
    await expect(field(page, "干湿比")).toHaveValue("30%");
    await undo(page);
    await expect(decay).toHaveValue("1.5s");
    await expect(field(page, "干湿比")).toHaveValue("0%");
  });

  test("move in the mixer, turn off with their dot, and the master has a limiter last", async ({
    page,
  }) => {
    await open(page);
    const add = strip(page).getByRole("button", { name: "添加效果" });
    for (const name of ["均衡", "压缩"]) {
      await add.click();
      await page.getByRole("menuitem", { name }).click();
    }
    const slots = slotsOf(strip(page));
    await expect(slots).toHaveCount(2);
    await slots.nth(1).dragTo(slots.nth(0), { targetPosition: { x: 10, y: 2 } });
    await expect(slots.nth(0)).toContainText("压缩");
    await undo(page);
    await expect(slots.nth(0)).toContainText("均衡");
    await slots.nth(0).getByRole("button", { name: "均衡：打开或关闭" }).click();
    await expect(slots.nth(0)).toHaveAttribute("data-off", "true");
    // The context menu takes one away.
    await slots.nth(1).click({ button: "right" });
    await page.getByRole("menuitem", { name: "删除" }).click();
    await expect(slots).toHaveCount(1);

    // The master: a fader, and the safe limiter that does not move.
    const limiter = master(page).getByRole("button", { name: /^限幅 / });
    await expect(limiter).toContainText("−1.0");
    await expect(master(page).getByRole("slider", { name: "主输出 音量" })).toBeVisible();
    await master(page).getByRole("button", { name: "限幅：打开或关闭" }).click();
    await expect(limiter).toContainText("关");
    await limiter.click();
    await expect(properties(page).getByRole("group", { name: "安全限幅" })).toBeVisible();
    for (const theme of ["dark", "light"] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await mixer(page).screenshot({ path: test.info().outputPath(`mixer-${theme}.png`) });
    }
    await undo(page);
    await expect(limiter).toContainText("−1.0");
  });
});

test("pictures to look at: the tab, the four panels, the mixer in both themes", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1920, height: 1200 });
  await open(page);
  const out = (name: string) => ({ path: test.info().outputPath(name) });
  const add = strip(page).getByRole("button", { name: "添加效果" });
  for (const name of ["均衡", "压缩", "限幅", "混响"]) {
    await add.click();
    await page.getByRole("menuitem", { name }).click();
  }
  await master(page).getByRole("button", { name: "添加效果" }).click();
  await page.getByRole("menuitem", { name: "均衡" }).click();
  await tab(page, "soundEffects").click();
  for (const theme of ["dark", "light"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await soundTab(page).screenshot(out(`tab-${theme}.png`));
    for (const name of ["均衡", "压缩", "限幅", "混响"]) {
      await slotsOf(strip(page)).getByRole("button", { name, exact: true }).click();
      const item = effectList(page).getByRole("listitem", { name });
      await item.evaluate((element) => element.scrollIntoView({ block: "start" }));
      await properties(page).screenshot(out(`panel-${name}-${theme}.png`));
    }
    await mixer(page).screenshot(out(`mixer-${theme}.png`));
    await master(page)
      .getByRole("button", { name: /^限幅 / })
      .click();
    await properties(page).screenshot(out(`master-${theme}.png`));
  }
});
