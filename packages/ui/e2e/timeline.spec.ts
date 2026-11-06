import type { Locator, Page } from "@playwright/test";
import { content, expect, tab, test } from "./support.ts";

const panel = (page: Page) => content(page, "timeline");
const clips = (page: Page) => panel(page).getByRole("option");
const timecode = (page: Page) => panel(page).getByRole("status");
const playhead = (page: Page) => panel(page).getByRole("slider", { name: "播放头" });
const addColorButton = (page: Page) => panel(page).getByRole("button", { name: "纯色片段" });
const stage = (page: Page) => panel(page).getByRole("group", { name: "时间轴" });
const trackHeader = (page: Page, name: string) => panel(page).getByText(name, { exact: true });

async function addColor(page: Page, count = 1) {
  const before = await clips(page).count();
  for (let index = 0; index < count; index++) await addColorButton(page).click();
  await expect(clips(page)).toHaveCount(before + count);
}

async function boxOf(locator: Locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error("Element has no box");
  return box;
}

/** The time a clip is at, as people can read it. */
const labelOf = async (locator: Locator) => (await locator.getAttribute("aria-label")) ?? "";

const expectLabel = (locator: Locator, text: RegExp | string) =>
  expect(locator).toHaveAttribute("aria-label", text);

/** Presses at one point and moves to another with real mouse events, then lets go. */
async function drag(page: Page, from: [number, number], to: [number, number], steps = 8) {
  await page.mouse.move(...from);
  await page.mouse.down();
  await page.mouse.move(...to, { steps });
  await page.mouse.up();
}

async function middleOf(locator: Locator): Promise<[number, number]> {
  const { x, y, width, height } = await boxOf(locator);
  return [x + width / 2, y + height / 2];
}

/** Waits until the list of clips has caught up with the view, which it does a moment later. */
async function settle(page: Page) {
  let before: string | undefined;
  await expect
    .poll(
      async () => {
        const now = await clips(page).evaluateAll((items) =>
          JSON.stringify(items.map((item) => [item.ariaLabel, item.getAttribute("style")])),
        );
        const stable = now === before;
        before = now;
        return stable;
      },
      { intervals: [150] },
    )
    .toBe(true);
}

test.beforeEach(async ({ page }) => {
  await tab(page, "timeline").click();
  await expect(panel(page)).toBeVisible();
});

test.describe("an empty timeline", () => {
  test("shows its tracks and says what to do", async ({ page }) => {
    await expect(trackHeader(page, "视频 1")).toBeVisible();
    await expect(trackHeader(page, "音频 1")).toBeVisible();
    await expect(panel(page).getByText("添加第一个片段")).toBeVisible();
    await expect(timecode(page)).toHaveText("00:00:00:00");
  });

  test("stops saying so once there is a clip", async ({ page }) => {
    await addColor(page);
    await expect(panel(page).getByText("添加第一个片段")).toHaveCount(0);
  });
});

test.describe("adding clips", () => {
  test("adds one after the other, and undo takes them back", async ({ page }) => {
    await addColor(page, 2);
    await expectLabel(clips(page).nth(0), /00:00:00:00 到 00:00:05:00/);
    await expectLabel(clips(page).nth(1), /00:00:05:00 到 00:00:10:00/);
    await expect(timecode(page)).toHaveText("00:00:10:00");

    await page.keyboard.press("Control+z");
    await expect(clips(page)).toHaveCount(1);
    await page.keyboard.press("Control+Shift+z");
    await expect(clips(page)).toHaveCount(2);
  });

  test("can be done from the menu of a track", async ({ page }) => {
    const [x] = await middleOf(stage(page));
    const header = await boxOf(trackHeader(page, "视频 1"));
    await page.mouse.click(x, header.y + header.height / 2, { button: "right" });
    await page.getByRole("menuitem", { name: "纯色片段" }).click();
    await expect(clips(page)).toHaveCount(1);
  });

  test("can be done from the menu bar", async ({ page }) => {
    await page.getByRole("button", { name: "时间轴", exact: true }).click();
    await page.getByRole("menuitem", { name: "添加纯色片段" }).click();
    await expect(clips(page)).toHaveCount(1);
  });

  test("can be done from the command palette", async ({ page }) => {
    await page.keyboard.press("F1");
    await page.getByRole("combobox").fill("纯色");
    await page.keyboard.press("Enter");
    await expect(clips(page)).toHaveCount(1);
  });

  test("survive a reload", async ({ page }) => {
    await addColor(page, 2);
    await page.reload();
    await expect(clips(page)).toHaveCount(2);
  });
});

test.describe("moving clips", () => {
  test.beforeEach(async ({ page }) => {
    await addColor(page);
    await page.keyboard.press("Home");
    await settle(page);
  });

  test("follows the mouse, and undo brings it back", async ({ page }) => {
    const clip = clips(page).first();
    const [x, y] = await middleOf(clip);
    await drag(page, [x, y], [x + 200, y]);
    await expect.poll(() => labelOf(clip)).not.toContain("00:00:00:00 到");
    await page.keyboard.press("Control+z");
    await expectLabel(clip, /00:00:00:00 到 00:00:05:00/);
  });

  test("stays where it is on a click", async ({ page }) => {
    const clip = clips(page).first();
    const before = await labelOf(clip);
    await page.mouse.click(...(await middleOf(clip)));
    await expect(clip).toHaveAttribute("aria-selected", "true");
    expect(await labelOf(clip)).toBe(before);
  });

  test("goes back on Escape", async ({ page }) => {
    const clip = clips(page).first();
    const before = await labelOf(clip);
    const [x, y] = await middleOf(clip);
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 200, y, { steps: 5 });
    await page.keyboard.press("Escape");
    await page.mouse.up();
    await settle(page);
    expect(await labelOf(clip)).toBe(before);
    await page.keyboard.press("Control+z");
    await expect(clips(page)).toHaveCount(0);
  });

  test("makes the timeline longer past its end", async ({ page }) => {
    const clip = clips(page).first();
    const [x, y] = await middleOf(clip);
    await drag(page, [x, y], [x + 800, y]);
    await expect.poll(() => labelOf(clip)).toMatch(/到 00:00:1[1-9]/);
    await page.keyboard.press("End");
    await expect(timecode(page)).not.toHaveText("00:00:10:00");
  });

  test("scrolls along when the mouse reaches the edge", async ({ page }) => {
    await panel(page).getByRole("button", { name: "放大" }).click();
    await panel(page).getByRole("button", { name: "放大" }).click();
    await settle(page);
    const clip = clips(page).first();
    const [x, y] = await middleOf(clip);
    const area = await boxOf(stage(page));
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(area.x + area.width - 4, y, { steps: 5 });
    await page.waitForTimeout(800);
    await page.mouse.up();
    await settle(page);
    const label = await labelOf(clip);
    const seconds = Number(/00:00:(\d\d):\d\d 到/.exec(label)?.[1]);
    expect(seconds).toBeGreaterThan(3);
  });
});

test.describe("clips next to each other", () => {
  test.beforeEach(async ({ page }) => {
    await addColor(page, 2);
    await page.keyboard.press("Home");
    await settle(page);
  });

  test("snap together", async ({ page }) => {
    const second = clips(page).nth(1);
    const [x, y] = await middleOf(second);
    await drag(page, [x, y], [x + 120, y]);
    await expect.poll(() => labelOf(second)).not.toContain("00:00:05:00 到");
    await drag(page, [x + 120, y], [x + 4, y]);
    await expectLabel(second, /00:00:05:00 到 00:00:10:00/);
  });

  test("stay as they are by default, and the clip goes to a free place", async ({ page }) => {
    const second = clips(page).nth(1);
    const [x, y] = await middleOf(second);
    const { width } = await boxOf(second);
    await drag(page, [x, y], [x - width * 0.8, y]);
    await settle(page);
    await expectLabel(clips(page).first(), /00:00:00:00 到 00:00:05:00/);
    await expectLabel(second, /00:00:05:00 到 00:00:10:00/);
  });

  test("are overwritten in overwrite mode, in one step", async ({ page }) => {
    await panel(page).getByRole("button", { name: "覆盖模式" }).click();
    const second = clips(page).nth(1);
    const [x, y] = await middleOf(second);
    const { width } = await boxOf(second);
    await drag(page, [x, y], [x - width / 2, y]);
    await expectLabel(clips(page).first(), /00:00:00:00 到 00:00:02:/);
    await expect(clips(page)).toHaveCount(2);
    await page.keyboard.press("Control+z");
    await expectLabel(clips(page).first(), /00:00:00:00 到 00:00:05:00/);
    await expectLabel(second, /00:00:05:00 到 00:00:10:00/);
  });

  test("move together when selected together", async ({ page }) => {
    await stage(page).focus();
    await page.keyboard.press("Control+a");
    const [x, y] = await middleOf(clips(page).first());
    await drag(page, [x, y], [x + 100, y]);
    await expect.poll(() => labelOf(clips(page).first())).not.toContain("00:00:00:00 到");
    const first = /到 (\S+)/.exec(await labelOf(clips(page).first()))?.[1];
    expect(await labelOf(clips(page).nth(1))).toContain(`${first} 到`);
  });

  test("can be selected by drawing a box", async ({ page }) => {
    const area = await boxOf(stage(page));
    const { y, height } = await boxOf(clips(page).first());
    await drag(page, [area.x + 300, y + height + 40], [area.x + 800, y + height - 10]);
    await expect(clips(page).first()).toHaveAttribute("aria-selected", "true");
    await expect(clips(page).nth(1)).toHaveAttribute("aria-selected", "true");
  });

  test("get selected one more with Shift", async ({ page }) => {
    await page.mouse.click(...(await middleOf(clips(page).first())));
    await page.keyboard.down("Shift");
    await page.mouse.click(...(await middleOf(clips(page).nth(1))));
    await page.keyboard.up("Shift");
    await expect(clips(page).first()).toHaveAttribute("aria-selected", "true");
    await expect(clips(page).nth(1)).toHaveAttribute("aria-selected", "true");
  });
});

test.describe("trimming", () => {
  test.beforeEach(async ({ page }) => {
    await addColor(page);
    await page.keyboard.press("Home");
    await settle(page);
  });

  test("moves the end of a clip", async ({ page }) => {
    const clip = clips(page).first();
    const { x, y, width, height } = await boxOf(clip);
    await drag(page, [x + width - 2, y + height / 2], [x + width / 2, y + height / 2]);
    await expect.poll(() => labelOf(clip)).toMatch(/到 00:00:02:/);
    await page.keyboard.press("Control+z");
    await expectLabel(clip, /00:00:00:00 到 00:00:05:00/);
  });

  test("moves the start of a clip", async ({ page }) => {
    const clip = clips(page).first();
    const { x, y, width, height } = await boxOf(clip);
    await drag(page, [x + 2, y + height / 2], [x + width / 2, y + height / 2]);
    await expect.poll(() => labelOf(clip)).toMatch(/00:00:02:\d\d 到 00:00:05:00/);
  });

  test("shows it can grab an edge", async ({ page }) => {
    const { x, y, width, height } = await boxOf(clips(page).first());
    await page.mouse.move(x + width - 2, y + height / 2);
    await expect(stage(page)).toHaveCSS("cursor", "ew-resize");
    await page.mouse.move(x + width / 2, y + height / 2);
    await expect(stage(page)).toHaveCSS("cursor", "default");
  });
});

test.describe("cutting", () => {
  test.beforeEach(async ({ page }) => {
    await addColor(page);
  });

  test("cuts at the playhead with the keyboard", async ({ page }) => {
    await page.keyboard.press("Home");
    await stage(page).focus();
    for (let step = 0; step < 15; step++) await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Control+k");
    await expect(clips(page)).toHaveCount(2);
    await expectLabel(clips(page).first(), /00:00:00:00 到 00:00:00:15/);
    await expectLabel(clips(page).nth(1), /00:00:00:15 到 00:00:05:00/);
    await page.keyboard.press("Control+z");
    await expect(clips(page)).toHaveCount(1);
  });

  test("cuts with the razor, and goes back to the arrow", async ({ page }) => {
    await page.keyboard.press("Home");
    await stage(page).focus();
    await page.keyboard.press("c");
    await page.mouse.click(...(await middleOf(clips(page).first())));
    await expect(clips(page)).toHaveCount(2);
    await page.keyboard.press("v");
    const pressed = panel(page).getByRole("button", { name: "选择工具" });
    await expect(pressed).toHaveAttribute("aria-pressed", "true");
  });
});

test.describe("the playhead", () => {
  test("jumps to a click on the ruler and follows a drag", async ({ page }) => {
    const area = await boxOf(stage(page));
    await page.mouse.click(area.x + area.width / 2, area.y + 10);
    await expect(timecode(page)).not.toHaveText("00:00:00:00");
    const after = await timecode(page).textContent();
    await drag(page, [area.x + area.width / 2, area.y + 10], [area.x + 100, area.y + 10]);
    await expect(timecode(page)).not.toHaveText(after ?? "");
  });

  test("steps through frames, also when the key is held", async ({ page }) => {
    await stage(page).focus();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await expect(timecode(page)).toHaveText("00:00:00:02");
    await page.keyboard.press("Shift+ArrowRight");
    await expect(timecode(page)).toHaveText("00:00:00:07");
    await page.keyboard.press("ArrowLeft");
    await expect(timecode(page)).toHaveText("00:00:00:06");
    await page.keyboard.down("ArrowRight");
    await page.keyboard.down("ArrowRight");
    await page.keyboard.down("ArrowRight");
    await page.keyboard.up("ArrowRight");
    await expect(timecode(page)).toHaveText("00:00:00:09");
  });

  test("jumps from edit to edit and to both ends", async ({ page }) => {
    await addColor(page);
    await stage(page).focus();
    await page.keyboard.press("Home");
    await expect(timecode(page)).toHaveText("00:00:00:00");
    await page.keyboard.press("ArrowDown");
    await expect(timecode(page)).toHaveText("00:00:05:00");
    await page.keyboard.press("ArrowDown");
    await expect(timecode(page)).toHaveText("00:00:10:00");
    await page.keyboard.press("ArrowUp");
    await expect(timecode(page)).toHaveText("00:00:05:00");
    await page.keyboard.press("End");
    await expect(timecode(page)).toHaveText("00:00:10:00");
  });

  test("tells screen readers where it is", async ({ page }) => {
    await stage(page).focus();
    await page.keyboard.press("ArrowRight");
    await expect(playhead(page)).toHaveAttribute("aria-valuetext", "00:00:00:01");
    await expect(playhead(page)).toHaveAttribute("aria-valuenow", "1");
  });
});

test.describe("zooming and scrolling", () => {
  test.beforeEach(async ({ page }) => {
    await addColor(page, 2);
    await page.keyboard.press("Home");
    await settle(page);
  });

  test("zooms with Ctrl and the wheel, keeping the point under the mouse", async ({ page }) => {
    const clip = clips(page).nth(1);
    const before = await boxOf(clip);
    const pointX = before.x + 20;
    await page.mouse.move(pointX, before.y + 10);
    await page.keyboard.down("Control");
    await page.mouse.wheel(0, -200);
    await page.keyboard.up("Control");
    await settle(page);
    const after = await boxOf(clip);
    expect(after.width).toBeGreaterThan(before.width);
    const share = (pointX - after.x) / after.width;
    expect(share).toBeCloseTo(20 / before.width, 1);
  });

  test("zooms with the keyboard, and fits everything again", async ({ page }) => {
    await stage(page).focus();
    const before = await boxOf(clips(page).first());
    await page.keyboard.press("=");
    await page.keyboard.press("=");
    await settle(page);
    const closer = await boxOf(clips(page).first());
    expect(closer.width).toBeGreaterThan(before.width);
    await page.keyboard.press("\\");
    await settle(page);
    await expect(clips(page)).toHaveCount(2);
    const area = await boxOf(stage(page));
    const end = await boxOf(clips(page).nth(1));
    expect(end.x + end.width).toBeLessThanOrEqual(area.x + area.width);
  });

  test("scrolls sideways with the wheel while there are few tracks", async ({ page }) => {
    await panel(page).getByRole("button", { name: "放大" }).click();
    await panel(page).getByRole("button", { name: "放大" }).click();
    await settle(page);
    const before = await boxOf(clips(page).first());
    await page.mouse.move(before.x + 10, before.y + 10);
    await page.mouse.wheel(0, 200);
    await settle(page);
    const after = await boxOf(clips(page).first());
    expect(after.width).toBeLessThan(before.width);
  });

  test("scrolls down through many tracks, the headers following along", async ({ page }) => {
    const header = trackHeader(page, "音频 1");
    for (let index = 0; index < 8; index++) {
      await panel(page).getByRole("button", { name: "添加轨道" }).click();
      await page.getByRole("menuitem", { name: "视频轨道" }).click();
    }
    await expect(trackHeader(page, "视频 9")).toBeVisible();
    const before = await boxOf(header);
    await page.mouse.move(...(await middleOf(stage(page))));
    await page.keyboard.down("Shift");
    await page.mouse.wheel(0, 300);
    await page.keyboard.up("Shift");
    await settle(page);
    const after = await boxOf(header);
    expect(after.y).toBeLessThan(before.y);
  });

  test("keeps the view through a reload", async ({ page }) => {
    await stage(page).focus();
    await page.keyboard.press("=");
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(500);
    const before = await boxOf(clips(page).first());
    await page.reload();
    await expect(clips(page).first()).toBeVisible();
    await settle(page);
    const after = await boxOf(clips(page).first());
    expect(after.width).toBeCloseTo(before.width, 0);
    await expect(timecode(page)).toHaveText("00:00:00:01");
  });

  test("has a slider that does the same", async ({ page }) => {
    const before = await boxOf(clips(page).first());
    await panel(page).getByRole("slider", { name: "缩放" }).fill("0.5");
    await settle(page);
    const after = await boxOf(clips(page).first());
    expect(after.width).toBeGreaterThan(before.width);
  });
});

test.describe("tracks", () => {
  const openTrackMenu = async (page: Page) =>
    panel(page).getByRole("button", { name: "添加轨道" }).click();

  test("can be added, named and removed, and undo works on all of it", async ({ page }) => {
    await openTrackMenu(page);
    await page.getByRole("menuitem", { name: "字幕轨道" }).click();
    await expect(trackHeader(page, "字幕 1")).toBeVisible();

    await trackHeader(page, "字幕 1").dblclick();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await panel(page).getByRole("textbox", { name: "轨道名称" }).fill("不要这个");
    await page.keyboard.press("Escape");
    await expect(trackHeader(page, "字幕 1")).toBeVisible();

    await trackHeader(page, "字幕 1").click({ button: "right" });
    await page.getByRole("menuitem", { name: "重命名轨道" }).click();
    await panel(page).getByRole("textbox", { name: "轨道名称" }).fill("中文字幕");
    await page.keyboard.press("Enter");
    await expect(trackHeader(page, "中文字幕")).toBeVisible();

    await trackHeader(page, "中文字幕").click({ button: "right" });
    await page.getByRole("menuitem", { name: "删除轨道" }).click();
    await expect(trackHeader(page, "中文字幕")).toHaveCount(0);
    await page.keyboard.press("Control+z");
    await expect(trackHeader(page, "中文字幕")).toBeVisible();
  });

  test("keep their clips safe when locked", async ({ page }) => {
    await addColor(page);
    await page.keyboard.press("Home");
    await settle(page);
    const lock = panel(page).getByRole("button", { name: "锁定 视频 1" });
    await lock.click();
    await expect(lock).toHaveAttribute("aria-pressed", "true");

    const clip = clips(page).first();
    const before = await labelOf(clip);
    const [x, y] = await middleOf(clip);
    await drag(page, [x, y], [x + 200, y]);
    await settle(page);
    expect(await labelOf(clip)).toBe(before);
    await stage(page).focus();
    await page.keyboard.press("Delete");
    await settle(page);
    await expect(clips(page)).toHaveCount(1);
  });

  test("can be hidden and muted", async ({ page }) => {
    const hide = panel(page).getByRole("button", { name: "隐藏 视频 1" });
    await hide.click();
    await expect(hide).toHaveAttribute("aria-pressed", "true");
    const mute = panel(page).getByRole("button", { name: "静音 音频 1" });
    await mute.click();
    await expect(mute).toHaveAttribute("aria-pressed", "true");
    await page.keyboard.press("Control+z");
    await expect(mute).toHaveAttribute("aria-pressed", "false");
  });

  test("take a clip to another track", async ({ page }) => {
    await openTrackMenu(page);
    await page.getByRole("menuitem", { name: "视频轨道" }).click();
    await expect(trackHeader(page, "视频 2")).toBeVisible();
    await addColor(page);
    await page.keyboard.press("Home");
    await settle(page);
    const clip = clips(page).first();
    await expectLabel(clip, /视频 1/);
    const [x, y] = await middleOf(clip);
    const target = await boxOf(trackHeader(page, "视频 2"));
    await drag(page, [x, y], [x, target.y + target.height / 2]);
    await expectLabel(clip, /视频 2/);
  });
});

test.describe("deleting", () => {
  test("removes what is selected, and only with the timeline in use", async ({ page }) => {
    await addColor(page, 2);
    await page.keyboard.press("Home");
    await settle(page);
    await page.mouse.click(...(await middleOf(clips(page).first())));
    await page.keyboard.press("Delete");
    await expect(clips(page)).toHaveCount(1);
    await page.keyboard.press("Control+z");
    await expect(clips(page)).toHaveCount(2);
  });

  test("leaves a text box alone", async ({ page }) => {
    await addColor(page);
    await stage(page).focus();
    await page.keyboard.press("Control+a");
    await page.keyboard.press("F1");
    const box = page.getByRole("combobox");
    await box.fill("abc");
    await page.keyboard.press("Backspace");
    await expect(box).toHaveValue("ab");
    await settle(page);
    await expect(clips(page)).toHaveCount(1);
  });

  test("leaves the command palette alone, also with a shortcut that works there", async ({
    page,
  }) => {
    await addColor(page);
    await page.keyboard.press("Home");
    await stage(page).focus();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("F1");
    await page.keyboard.press("Control+k");
    await page.keyboard.press("Escape");
    await settle(page);
    await expect(clips(page)).toHaveCount(1);
  });

  test("works right after clicking the tab of the timeline", async ({ page }) => {
    await addColor(page);
    await content(page, "preview").click();
    await tab(page, "timeline").click();
    await page.keyboard.press("Home");
    await expect(timecode(page)).toHaveText("00:00:00:00");
  });

  test("stays out of other panels", async ({ page }) => {
    await addColor(page);
    await stage(page).focus();
    await page.keyboard.press("Control+a");
    await content(page, "preview").click();
    await page.keyboard.press("Delete");
    await settle(page);
    await expect(clips(page)).toHaveCount(1);
  });

  test("still reaches the timeline after using a menu", async ({ page }) => {
    await addColor(page);
    await stage(page).focus();
    await page.keyboard.press("Control+a");
    await page.getByRole("button", { name: "时间轴", exact: true }).click();
    await page.getByRole("menuitem", { name: "全选片段" }).click();
    await page.keyboard.press("Delete");
    await expect(clips(page)).toHaveCount(0);
  });

  test("can be done from the menu of a clip", async ({ page }) => {
    await addColor(page);
    await page.keyboard.press("Home");
    await settle(page);
    await page.mouse.click(...(await middleOf(clips(page).first())), { button: "right" });
    await page.getByRole("menuitem", { name: "删除片段" }).click();
    await expect(clips(page)).toHaveCount(0);
  });
});

test.describe("menus", () => {
  test("keep keys to themselves while they are open", async ({ page }) => {
    await addColor(page);
    await page.keyboard.press("Home");
    await settle(page);
    await page.mouse.click(...(await middleOf(clips(page).first())), { button: "right" });
    await expect(page.getByRole("menu")).toBeVisible();
    await page.keyboard.press("Delete");
    await page.keyboard.press("=");
    await page.keyboard.press("ArrowDown");
    await settle(page);
    await expect(clips(page)).toHaveCount(1);
    await expect(timecode(page)).toHaveText("00:00:00:00");
    await page.keyboard.press("Escape");
  });

  test("run an item with Enter", async ({ page }) => {
    await addColor(page);
    await page.keyboard.press("Home");
    await settle(page);
    await page.mouse.click(...(await middleOf(clips(page).first())), { button: "right" });
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    await expect(clips(page)).toHaveCount(0);
  });

  test("close on Escape and give the keys back to the timeline", async ({ page }) => {
    await addColor(page);
    await page.keyboard.press("Home");
    await settle(page);
    await page.mouse.click(...(await middleOf(clips(page).first())), { button: "right" });
    await expect(page.getByRole("menu")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(clips(page).first()).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Delete");
    await expect(clips(page)).toHaveCount(0);
  });

  test("stay inside the window", async ({ page }) => {
    await addColor(page);
    const area = await boxOf(stage(page));
    await page.mouse.click(area.x + area.width - 4, area.y + 50, { button: "right" });
    const menu = page.getByRole("menu");
    if ((await menu.count()) > 0) {
      const box = await boxOf(menu);
      expect(box.x + box.width).toBeLessThanOrEqual(1440);
    }
  });
});

test.describe("the end of the timeline", () => {
  test("can be dragged, and stops at the last clip", async ({ page }) => {
    await addColor(page);
    await page.keyboard.press("Home");
    await settle(page);
    const { x, width } = await boxOf(clips(page).first());
    const area = await boxOf(stage(page));
    const end = x + width * 2;
    await drag(page, [end, area.y + 24], [x + 10, area.y + 24]);
    await stage(page).focus();
    await page.keyboard.press("End");
    await expect(timecode(page)).toHaveText("00:00:05:00");
  });
});

test.describe("several windows", () => {
  async function secondWindow(page: Page) {
    const other = await page.context().newPage();
    await other.goto(page.url());
    await tab(other, "timeline").click();
    await expect(panel(other)).toBeVisible();
    return other;
  }

  test("see each other's changes, but not each other's playhead", async ({ page }) => {
    const other = await secondWindow(page);
    await addColor(page);
    await expect(clips(other)).toHaveCount(1);
    await expect(timecode(page)).toHaveText("00:00:05:00");
    await expect(timecode(other)).toHaveText("00:00:00:00");
  });

  test("do not lose a selection to a change elsewhere", async ({ page }) => {
    await addColor(page, 2);
    const other = await secondWindow(page);
    await expect(clips(other)).toHaveCount(2);
    await settle(other);
    await other.mouse.click(...(await middleOf(clips(other).first())));
    await expect(clips(other).first()).toHaveAttribute("aria-selected", "true");
    await addColor(page);
    await expect(clips(other)).toHaveCount(3);
    await expect(clips(other).first()).toHaveAttribute("aria-selected", "true");
  });
});

test.describe("behind another tab", () => {
  const pixelAt = (page: Page, x: number, y: number) =>
    panel(page)
      .locator("canvas")
      .evaluate(
        (canvas, [left, top]) =>
          [
            ...((canvas as HTMLCanvasElement)
              .getContext("2d")
              ?.getImageData(left as number, top as number, 1, 1).data ?? []),
          ].slice(0, 3),
        [x, y],
      );

  const newProject = async (page: Page, name: string) => {
    await page.getByRole("banner").getByRole("button", { name: "文件" }).click();
    await page.getByRole("menuitem", { name: "新建项目" }).click();
    await page.getByRole("textbox", { name: "项目名称" }).fill(name);
    await page.keyboard.press("Enter");
    await expect(tab(page, "preview")).toBeVisible();
  };

  test("a new project opens, and draws once its tab is shown", async ({ page }) => {
    await tab(page, "problems").click();
    await page.waitForTimeout(700);
    await newProject(page, "另一个");
    await expect(content(page, "problems")).toBeVisible();
    await tab(page, "timeline").click();
    await expect(addColorButton(page)).toBeVisible();
    await expect.poll(() => pixelAt(page, 5, 5)).toEqual([24, 24, 24]);
    await expect.poll(() => pixelAt(page, 400, 250)).toEqual([22, 22, 22]);
  });

  test("a reload does not stop anything, and it draws its real colours", async ({ page }) => {
    await addColor(page);
    await tab(page, "problems").click();
    await page.waitForTimeout(700);
    await page.reload();
    await expect(content(page, "problems")).toBeVisible();
    await tab(page, "timeline").click();
    await expect(clips(page)).toHaveCount(1);
    await expect.poll(() => pixelAt(page, 5, 5)).toEqual([24, 24, 24]);
  });

  test("zooming with its tab closed does no harm", async ({ page }) => {
    await tab(page, "timeline").click({ button: "middle" });
    await expect(tab(page, "timeline")).toHaveCount(0);
    await page.getByRole("button", { name: "时间轴", exact: true }).click();
    await page.getByRole("menuitem", { name: "放大" }).click();
    await page.getByRole("button", { name: "视图" }).click();
    await page.getByRole("menuitem", { name: "时间轴" }).click();
    await expect(addColorButton(page)).toBeVisible();
    await addColor(page);
  });

  test("a drag that was left behind does not come back with the next click", async ({ page }) => {
    await addColor(page);
    await page.keyboard.press("Home");
    await settle(page);
    const clip = clips(page).first();
    const before = await labelOf(clip);
    const [x, y] = await middleOf(clip);
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 200, y, { steps: 5 });
    await page.keyboard.press("Control+Shift+KeyM");
    await expect(content(page, "problems")).toBeVisible();
    await page.mouse.up();
    await tab(page, "timeline").click();
    await settle(page);
    const area = await boxOf(stage(page));
    await page.mouse.click(area.x + area.width - 40, y);
    await settle(page);
    expect(await labelOf(clip)).toBe(before);
  });

  test("keeps where it was scrolled to", async ({ page }) => {
    await addColor(page, 2);
    await stage(page).focus();
    for (let step = 0; step < 4; step++) await page.keyboard.press("=");
    await page.keyboard.press("End");
    await settle(page);
    const before = await boxOf(clips(page).first());
    await tab(page, "problems").click();
    await tab(page, "timeline").click();
    await settle(page);
    const after = await boxOf(clips(page).first());
    expect(after.x).toBeCloseTo(before.x, 0);
    expect(after.width).toBeCloseTo(before.width, 0);
  });
});

test.describe("the bars with handles", () => {
  const handle = (page: Page, axis: string, edge: string) =>
    panel(page).locator(`[data-bar="${axis}"] [data-handle="${edge}"]`);

  test("the bottom one scrolls, and zooms from either end", async ({ page }) => {
    await addColor(page, 2);
    await page.keyboard.press("Home");
    await settle(page);
    const before = await boxOf(clips(page).first());
    const [x, y] = await middleOf(handle(page, "x", "end"));
    await drag(page, [x, y], [x - 500, y]);
    await settle(page);
    const closer = await boxOf(clips(page).first());
    expect(closer.width).toBeGreaterThan(before.width);
    expect(closer.x).toBeCloseTo(before.x, 0);

    const [left, top] = await middleOf(handle(page, "x", "start"));
    await drag(page, [left, top], [left + 100, top]);
    await settle(page);
    await expect(
      panel(page).getByRole("scrollbar", { name: "时间轴横向滚动条" }),
    ).not.toHaveAttribute("aria-valuenow", "0");
  });

  test("the right one changes the height of tracks", async ({ page }) => {
    const before = await boxOf(trackHeader(page, "视频 1").locator(".."));
    const [x, y] = await middleOf(handle(page, "y", "end"));
    await drag(page, [x, y], [x, y - 120]);
    await settle(page);
    const after = await boxOf(trackHeader(page, "视频 1").locator(".."));
    expect(after.height).toBeGreaterThan(before.height);
  });

  test("Ctrl, Shift and the wheel change the height of tracks too", async ({ page }) => {
    const before = await boxOf(trackHeader(page, "视频 1").locator(".."));
    await page.mouse.move(...(await middleOf(stage(page))));
    await page.keyboard.down("Control");
    await page.keyboard.down("Shift");
    await page.mouse.wheel(0, -200);
    await page.keyboard.up("Shift");
    await page.keyboard.up("Control");
    await expect
      .poll(async () => (await boxOf(trackHeader(page, "视频 1").locator(".."))).height)
      .toBeGreaterThan(before.height);
  });
});

test.describe("copying", () => {
  test("Ctrl and a drag leaves the clip and makes a copy", async ({ page }) => {
    await addColor(page);
    await page.keyboard.press("Home");
    await settle(page);
    const [x, y] = await middleOf(clips(page).first());
    await page.keyboard.down("Control");
    await drag(page, [x, y], [x + 400, y]);
    await page.keyboard.up("Control");
    await expect(clips(page)).toHaveCount(2);
    await expectLabel(clips(page).first(), /00:00:00:00 到 00:00:05:00/);
    await page.keyboard.press("Control+z");
    await expect(clips(page)).toHaveCount(1);
  });

  test("Ctrl+C and Ctrl+V put a copy at the playhead", async ({ page }) => {
    await addColor(page);
    await stage(page).focus();
    await page.keyboard.press("Control+a");
    await page.keyboard.press("Control+c");
    await page.keyboard.press("Control+v");
    await expect(clips(page)).toHaveCount(2);
    await expectLabel(clips(page).nth(1), /00:00:05:00 到 00:00:10:00/);
    await expect(timecode(page)).toHaveText("00:00:05:00");
  });

  test("Ctrl+X keeps the clip until Ctrl+V, in one step to undo", async ({ page }) => {
    await addColor(page);
    await stage(page).focus();
    await page.keyboard.press("Control+a");
    await page.keyboard.press("Control+x");
    await settle(page);
    await expect(clips(page)).toHaveCount(1);
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Control+v");
    await expectLabel(clips(page).first(), /00:00:05:01 到 00:00:10:01/);
    await expect(clips(page)).toHaveCount(1);
    await page.keyboard.press("Control+z");
    await expectLabel(clips(page).first(), /00:00:00:00 到 00:00:05:00/);
  });

  test("Escape takes a cut back", async ({ page }) => {
    await addColor(page);
    await stage(page).focus();
    await page.keyboard.press("Control+a");
    await page.keyboard.press("Control+x");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Control+v");
    await settle(page);
    await expect(clips(page)).toHaveCount(1);
    await expectLabel(clips(page).first(), /00:00:00:00 到 00:00:05:00/);
  });
});

test.describe("reordering tracks", () => {
  test("a track header can be dragged to another place, and undone", async ({ page }) => {
    await panel(page).getByRole("button", { name: "添加轨道" }).click();
    await page.getByRole("menuitem", { name: "视频轨道" }).click();
    await expect(trackHeader(page, "视频 2")).toBeVisible();
    await addColor(page);
    await settle(page);
    await expectLabel(clips(page).first(), /视频 1/);
    const upper = await boxOf(trackHeader(page, "视频 2"));
    const lower = await boxOf(trackHeader(page, "视频 1"));
    const x = lower.x + 10;
    await drag(page, [x, upper.y + upper.height / 2], [x, lower.y + lower.height + 10]);
    // The clip stays on its track, which is now the back one of the two and gets a new number.
    await expectLabel(clips(page).first(), /视频 2/);
    await page.keyboard.press("Control+z");
    await expectLabel(clips(page).first(), /视频 1/);
  });
});

test.describe("explaining itself", () => {
  test("every button says what it is and how to use it", async ({ page }) => {
    for (const name of ["切割工具", "在播放头切割", "吸附", "覆盖模式", "显示全部", "添加轨道"]) {
      await panel(page).getByRole("button", { name, exact: true }).hover();
      const tip = page.getByRole("tooltip");
      await expect(tip).toContainText(name);
      await expect(tip).toContainText("。");
      await page.mouse.move(0, 0);
      await expect(tip).toHaveCount(0);
    }
  });

  test("the button for cutting at the playhead cuts", async ({ page }) => {
    await addColor(page);
    await stage(page).focus();
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowLeft");
    await panel(page).getByRole("button", { name: "在播放头切割" }).click();
    await expect(clips(page)).toHaveCount(2);
  });

  test("the playhead turns into the snap line when a clip sticks to it", async ({ page }) => {
    await addColor(page);
    await stage(page).focus();
    await page.keyboard.press("Home");
    for (let step = 0; step < 3; step++) await page.keyboard.press("Shift+ArrowRight");
    await addColor(page);
    await page.keyboard.press("Home");
    await settle(page);
    const area = await boxOf(stage(page));
    await page.mouse.click(area.x + 600, area.y + 10);
    const line = await boxOf(playhead(page));
    const clip = clips(page).nth(1);
    const box = await boxOf(clip);
    const y = box.y + box.height / 2;
    await page.mouse.move(box.x + 40, y);
    await page.mouse.down();
    await page.mouse.move(line.x + 40 + 3, y, { steps: 8 });
    await expect(playhead(page)).toHaveCSS("background-color", "rgb(255, 210, 63)");
    await page.keyboard.press("Escape");
    await page.mouse.up();
  });
});

test.describe("the frame rate of the project", () => {
  test("is what the ruler counts, and formats keep theirs", async ({ page }) => {
    await panel(page).getByRole("button", { name: "项目帧率" }).click();
    await page.getByRole("textbox").fill("24");
    await page.keyboard.press("Enter");
    await expect(panel(page).getByRole("button", { name: "项目帧率" })).toHaveText("24 帧");
    await stage(page).focus();
    await page.keyboard.press("End");
    await expect(timecode(page)).toHaveText("00:00:10:00");
    await page.keyboard.press("ArrowLeft");
    await expect(timecode(page)).toHaveText("00:00:09:23");
  });

  test("says so when it is no rate", async ({ page }) => {
    await panel(page).getByRole("button", { name: "项目帧率" }).click();
    await page.getByRole("textbox").fill("快");
    await page.keyboard.press("Enter");
    await expect(page.getByText("帧率要写成大于 0 的数字")).toBeVisible();
  });
});

test.describe("a trackpad", () => {
  const swipe = (page: Page, deltaX: number, deltaY: number, ctrlKey = false) =>
    stage(page).evaluate(
      (element, init) => {
        for (let step = 0; step < 6; step++) {
          const event = new WheelEvent("wheel", { ...init, bubbles: true, cancelable: true });
          element.dispatchEvent(event);
        }
      },
      { deltaX, deltaY, ctrlKey },
    );

  test.beforeEach(async ({ page }) => {
    for (let index = 0; index < 6; index++) {
      await panel(page).getByRole("button", { name: "添加轨道" }).click();
      await page.getByRole("menuitem", { name: "音频轨道" }).click();
    }
    await addColor(page, 2);
    await page.keyboard.press("Home");
    await settle(page);
  });

  test("moves up and down with two fingers, where a wheel goes sideways", async ({ page }) => {
    const header = trackHeader(page, "音频 1");
    const before = await boxOf(header);
    await swipe(page, 0, 9);
    await expect.poll(async () => (await boxOf(header)).y).toBeLessThan(before.y);
  });

  test("zooms with a pinch", async ({ page }) => {
    const before = await boxOf(clips(page).first());
    await swipe(page, 0, -9, true);
    await settle(page);
    const after = await boxOf(clips(page).first());
    expect(after.width).toBeGreaterThan(before.width);
  });
});

test.describe("a touch screen", () => {
  test.use({ hasTouch: true });

  async function touch(page: Page, points: readonly (readonly [number, number])[]) {
    const client = await page.context().newCDPSession(page);
    const [first, ...rest] = points as [[number, number], ...[number, number][]];
    const at = ([x, y]: readonly [number, number]) => ({ x, y });
    await client.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [at(first)],
    });
    for (const point of rest) {
      await client.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [at(point)],
      });
    }
    await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  }

  test.beforeEach(async ({ page }) => {
    await addColor(page);
    await page.keyboard.press("Home");
    await panel(page).getByRole("button", { name: "放大" }).click();
    await settle(page);
  });

  test("selects with a tap, and a swipe moves the view and not the clip", async ({ page }) => {
    const clip = clips(page).first();
    await page.keyboard.press("Escape");
    await stage(page).focus();
    await page.keyboard.press("Escape");
    await expect(clip).toHaveAttribute("aria-selected", "false");
    const [x, y] = await middleOf(clip);
    await touch(page, [[x, y]]);
    await expect(clip).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Escape");
    const label = await labelOf(clip);
    await touch(page, [
      [x, y],
      [x - 100, y],
      [x - 200, y],
    ]);
    await expect(
      panel(page).getByRole("scrollbar", { name: "时间轴横向滚动条" }),
    ).not.toHaveAttribute("aria-valuenow", "0");
    expect(await labelOf(clip)).toBe(label);
  });

  test("moves a clip that is selected", async ({ page }) => {
    const clip = clips(page).first();
    const [x, y] = await middleOf(clip);
    await touch(page, [
      [x, y],
      [x + 100, y],
      [x + 200, y],
    ]);
    await expect.poll(() => labelOf(clip)).not.toContain("00:00:00:00 到");
  });
});

test.describe("the toolbar", () => {
  test("keeps tools, switches and actions apart", async ({ page }) => {
    const zone = (name: string) => panel(page).getByRole("group", { name, exact: true });
    await expect(zone("工具").getByRole("button")).toHaveCount(2);
    await expect(zone("开关").getByRole("button")).toHaveCount(2);
    await expect(zone("操作").getByRole("button", { name: "在播放头切割" })).toBeVisible();
  });

  test("showing everything twice goes back to the zoom from before", async ({ page }) => {
    await addColor(page, 2);
    await page.keyboard.press("Home");
    await panel(page).getByRole("slider", { name: "缩放" }).fill("0.4");
    await settle(page);
    const before = await boxOf(clips(page).first());
    const fit = panel(page).getByRole("button", { name: "显示全部" });
    await fit.click();
    await settle(page);
    expect((await boxOf(clips(page).first())).width).toBeLessThan(before.width);
    await fit.click();
    await settle(page);
    expect((await boxOf(clips(page).first())).width).toBeCloseTo(before.width, 0);
  });
});

test.describe("the zoom slider", () => {
  test("gives the keys back after it was used with the mouse", async ({ page }) => {
    await addColor(page);
    await page.keyboard.press("Home");
    await settle(page);
    await page.mouse.click(...(await middleOf(clips(page).first())));
    await panel(page).getByRole("slider", { name: "缩放" }).click();
    await page.keyboard.press("ArrowRight");
    await expect(timecode(page)).toHaveText("00:00:00:01");
    await page.keyboard.press("Delete");
    await expect(clips(page)).toHaveCount(0);
  });

  test("moves with the arrow keys when the keyboard got there", async ({ page }) => {
    const slider = panel(page).getByRole("slider", { name: "缩放" });
    await slider.focus();
    const before = await slider.inputValue();
    await page.keyboard.press("ArrowRight");
    await expect(slider).not.toHaveValue(before);
    await expect(timecode(page)).toHaveText("00:00:00:00");
  });
});

test.describe("as part of the editor", () => {
  test("keeps its state when the tab moves to another group", async ({ page }) => {
    await addColor(page);
    await expect(timecode(page)).toHaveText("00:00:05:00");
    const from = await middleOf(tab(page, "timeline"));
    const target = await middleOf(tab(page, "preview"));
    await drag(page, from, target, 12);
    await expect(clips(page)).toHaveCount(1);
    await expect(timecode(page)).toHaveText("00:00:05:00");
  });

  test("comes back when its tab is shown again", async ({ page }) => {
    await addColor(page);
    await tab(page, "problems").click();
    await tab(page, "timeline").click();
    await expect(clips(page)).toHaveCount(1);
    await expect(timecode(page)).toHaveText("00:00:05:00");
  });

  test("fits when the window changes", async ({ page }) => {
    await addColor(page);
    await page.setViewportSize({ width: 900, height: 600 });
    await settle(page);
    const area = await boxOf(stage(page));
    const size = await panel(page)
      .locator("canvas")
      .evaluate((canvas) => {
        const element = canvas as HTMLCanvasElement;
        return { width: element.width, height: element.height };
      });
    expect(size.width).toBe(Math.round(area.width));
    expect(size.height).toBe(Math.round(area.height));
    expect(area.x + area.width).toBeLessThanOrEqual(900);
  });

  test("is shown in every workspace with what it has", async ({ page }) => {
    await addColor(page);
    await page.getByRole("button", { name: "音频", exact: true }).click();
    await expect(panel(page)).toBeVisible();
    await expect(clips(page)).toHaveCount(1);
  });

  test("shows the clips of the project that is open", async ({ page }) => {
    await addColor(page);
    await page.getByRole("banner").getByRole("button", { name: "文件" }).click();
    await page.getByRole("menuitem", { name: "新建项目" }).click();
    await page.getByRole("textbox", { name: "项目名称" }).fill("另一个");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("status").filter({ hasText: "已保存" })).toBeVisible();
    await tab(page, "timeline").click();
    await expect(clips(page)).toHaveCount(0);
    await expect(timecode(page)).toHaveText("00:00:00:00");
  });

  test("lists its shortcuts with the others", async ({ page }) => {
    await page.keyboard.press("F1");
    await page.getByRole("combobox").fill("快捷键");
    await page.keyboard.press("Enter");
    await expect(page.locator('[data-action="timeline.split"]').getByText("Ctrl+K")).toBeVisible();
  });
});

test.describe("on a high density screen", () => {
  test.use({ deviceScaleFactor: 2 });

  test("draws with all the pixels the screen has", async ({ page }) => {
    await addColor(page);
    await settle(page);
    const canvas = panel(page).locator("canvas");
    const area = await boxOf(canvas);
    const width = await canvas.evaluate((element) => (element as HTMLCanvasElement).width);
    expect(width).toBe(Math.round(area.width * 2));
  });
});
