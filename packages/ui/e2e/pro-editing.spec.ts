import { readFileSync } from "node:fs";
import type { Locator, Page } from "@playwright/test";
import { content, expect, resourcesIn, tab, test } from "./support.ts";

/** In and out, and J, K and L (pro-editing P1 of AnimaQuill Cloud). */

const panel = (page: Page) => content(page, "timeline");
const stage = (page: Page) => panel(page).getByRole("group", { name: "时间轴" });
const timecode = (page: Page) => content(page, "preview").locator("output");
const rate = (page: Page) => content(page, "preview").getByTestId("play-rate");
const inPoint = (page: Page) => panel(page).getByRole("slider", { name: "入点" });
const outPoint = (page: Page) => panel(page).getByRole("slider", { name: "出点" });
const playhead = (page: Page) => panel(page).getByRole("slider", { name: "播放头" });

/** What it looks like, in both themes, for people to look at. */
async function shoot(page: Page, name: string, of: "ruler" | "transport" = "ruler") {
  const area =
    of === "ruler"
      ? stage(page)
      : content(page, "preview").getByRole("toolbar", { name: "播放控制" });
  const box = await area.boundingBox();
  if (!box) return;
  const height = of === "ruler" ? 120 : box.height;
  await page.screenshot({
    path: test.info().outputPath(name),
    clip: { x: box.x, y: box.y, width: Math.min(box.width, 900), height },
  });
}

/** The frame the playhead is on, as the timeline says it. */
const frameOf = async (page: Page) => Number(await playhead(page).getAttribute("aria-valuenow"));

async function stepRight(page: Page, frames: number) {
  for (let index = 0; index < frames; index++) await page.keyboard.press("ArrowRight");
}

test.beforeEach(async ({ page }) => {
  await tab(page, "timeline").click();
  await expect(panel(page)).toBeVisible();
  await stage(page).focus();
});

test.describe("in and out", () => {
  test("I and O mark at the playhead, show on the ruler, and go with Ctrl+Shift+X", async ({
    page,
  }) => {
    await page.keyboard.press("Home");
    await stepRight(page, 30);
    await page.keyboard.press("KeyI");
    await expect(inPoint(page)).toHaveAttribute("aria-valuenow", "30");
    await expect(outPoint(page)).toHaveCount(0);
    await stepRight(page, 45);
    await page.keyboard.press("KeyO");
    await expect(outPoint(page)).toHaveAttribute("aria-valuenow", "75");
    await expect(outPoint(page)).toHaveAttribute("aria-valuetext", "0:02/15");
    // The out is where its frame ends, to the right of the in.
    const left = (await inPoint(page).boundingBox())?.x ?? 0;
    const right = (await outPoint(page).boundingBox())?.x ?? 0;
    expect(right).toBeGreaterThan(left + 10);
    await shoot(page, "marks-dark.png");

    await page.keyboard.press("Home");
    await page.keyboard.press("Shift+KeyO");
    await expect(timecode(page)).toHaveText("0:02/15");
    await page.keyboard.press("Shift+KeyI");
    await expect(timecode(page)).toHaveText("0:01/00");

    await page.keyboard.press("Control+Shift+KeyX");
    await expect(inPoint(page)).toHaveCount(0);
    await expect(outPoint(page)).toHaveCount(0);
  });

  test("an end can be dragged on the ruler", async ({ page }) => {
    await page.keyboard.press("Home");
    await stepRight(page, 30);
    await page.keyboard.press("KeyI");
    await stepRight(page, 30);
    await page.keyboard.press("KeyO");
    const box = await inPoint(page).boundingBox();
    if (!box) throw new Error("no in");
    await page.mouse.move(box.x, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x - 40, box.y + box.height / 2, { steps: 6 });
    await page.mouse.up();
    const moved = Number(await inPoint(page).getAttribute("aria-valuenow"));
    expect(moved).toBeLessThan(30);
    await expect(outPoint(page)).toHaveAttribute("aria-valuenow", "60");
  });

  test("O is no longer the switch for overwriting", async ({ page }) => {
    const overwrite = panel(page).getByRole("button", { name: "覆盖模式" });
    await expect(overwrite).toHaveAttribute("aria-pressed", "false");
    await page.keyboard.press("KeyO");
    await expect(outPoint(page)).toBeVisible();
    await expect(overwrite).toHaveAttribute("aria-pressed", "false");
  });

  test("are in the menu, with their keys, and greyed out while there is nothing to clear", async ({
    page,
  }) => {
    await page.getByRole("button", { name: "时间轴", exact: true }).click();
    const menu = page.getByRole("menu");
    await expect(menu.getByRole("menuitem", { name: /^标记入点/ })).toContainText("I");
    await expect(menu.getByRole("menuitem", { name: /^标记出点/ })).toContainText("O");
    await expect(menu.getByRole("menuitem", { name: /^清除入点和出点/ })).toBeDisabled();
    await expect(menu.getByRole("menuitem", { name: /^清除入点$/ })).toBeDisabled();
    await menu.getByRole("menuitem", { name: /^标记入点/ }).click();
    await expect(inPoint(page)).toBeVisible();
    await page.getByRole("button", { name: "时间轴", exact: true }).click();
    await expect(
      page.getByRole("menu").getByRole("menuitem", { name: /^清除入点$/ }),
    ).toBeEnabled();
    await page
      .getByRole("menu")
      .getByRole("menuitem", { name: /^清除入点$/ })
      .click();
    await expect(inPoint(page)).toHaveCount(0);
  });
});

test.describe("J, K and L", () => {
  test("L twice plays at twice the speed, says so, and K stops", async ({ page }) => {
    // What keeps the pitch at other speeds comes from the editor's own address, and starts.
    const worklet = page.waitForRequest(/stretch-worklet/);
    const problems: string[] = [];
    page.on("console", (message) => {
      if (message.text().includes("keeps no pitch")) problems.push(message.text());
    });
    await page.keyboard.press("Home");
    await page.keyboard.press("KeyL");
    await expect(rate(page)).toHaveCount(0);
    await page.keyboard.press("KeyL");
    await expect(rate(page)).toHaveText("2×");
    const start = await frameOf(page);
    const wall = Date.now();
    await page.waitForTimeout(1000);
    const frames = (await frameOf(page)) - start;
    const seconds = (Date.now() - wall) / 1000;
    // Twice the clock, give or take what a busy machine does to it.
    expect(frames / 30 / seconds).toBeGreaterThan(1.5);
    await shoot(page, "rate-dark.png", "transport");
    await page.keyboard.press("KeyK");
    await expect(rate(page)).toHaveCount(0);
    await worklet;
    await page.waitForTimeout(500);
    expect(problems).toEqual([]);
  });

  test("J plays backwards, and the preview says how fast", async ({ page }) => {
    await page.keyboard.press("End");
    const end = await frameOf(page);
    await page.keyboard.press("KeyJ");
    await expect(rate(page)).toHaveText("−1×");
    await expect.poll(() => frameOf(page)).toBeLessThan(end - 5);
    await page.keyboard.press("KeyJ");
    await expect(rate(page)).toHaveText("−2×");
    await page.keyboard.press("KeyK");
    await expect(rate(page)).toHaveCount(0);
  });

  test("K held with a tap of L is one frame on", async ({ page }) => {
    await page.keyboard.press("Home");
    await page.keyboard.down("KeyK");
    await page.keyboard.press("KeyL");
    await page.keyboard.press("KeyL");
    await page.keyboard.up("KeyK");
    await expect.poll(() => frameOf(page)).toBe(2);
    await expect(rate(page)).toHaveCount(0);
  });

  test("work as they are with a Chinese input method on, by where the keys are", async ({
    page,
  }) => {
    await page.keyboard.press("Home");
    // An input method says "Process" for the letter, and only the key code says which it was.
    const press = (code: string) =>
      stage(page).evaluate((element, which) => {
        for (const type of ["keydown", "keyup"]) {
          element.dispatchEvent(
            new KeyboardEvent(type, { code: which, key: "Process", bubbles: true }),
          );
        }
      }, code);
    await press("KeyL");
    await press("KeyL");
    await expect(rate(page)).toHaveText("2×");
    await press("KeyK");
    await expect(rate(page)).toHaveCount(0);
  });
});

test.describe("Alt+K", () => {
  test("keys the row last worked with, on the selected clip only", async ({ page }) => {
    await panel(page).getByRole("button", { name: "纯色片段" }).click();
    // Into the clip, where its properties can change.
    await stage(page).focus();
    await page.keyboard.press("Home");
    await stepRight(page, 30);
    await tab(page, "properties").click();
    const row = content(page, "properties").getByRole("group", { name: "位置 X", exact: true });
    await row.getByRole("spinbutton").click();
    await page.keyboard.press("Alt+KeyK");
    await expect(row.getByRole("button", { name: "删除关键帧" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await page.keyboard.press("Alt+KeyK");
    await expect(row.getByRole("button", { name: "添加关键帧" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    // Nothing selected: nothing to key, and the menu says so.
    await tab(page, "timeline").click();
    await stage(page).focus();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "时间轴", exact: true }).click();
    await expect(
      page.getByRole("menu").getByRole("menuitem", { name: /^在播放头添加或删除关键帧/ }),
    ).toBeDisabled();
  });
});

test.describe("in light colours", () => {
  test.use({ colorScheme: "light" });

  test("the marks and how fast it plays", async ({ page }) => {
    await page.keyboard.press("Home");
    await stepRight(page, 30);
    await page.keyboard.press("KeyI");
    await stepRight(page, 45);
    await page.keyboard.press("KeyO");
    await expect(outPoint(page)).toBeVisible();
    await shoot(page, "marks-light.png");
    await page.keyboard.press("Home");
    await page.keyboard.press("KeyL");
    await page.keyboard.press("KeyL");
    await page.keyboard.press("KeyL");
    await expect(rate(page)).toHaveText("4×");
    await shoot(page, "rate-light.png", "transport");
    await page.keyboard.press("KeyK");
  });
});

/* Markers and sections (pro-editing P2 of AnimaQuill Cloud). */

const markers = (page: Page) =>
  panel(page).getByRole("list", { name: "标记" }).getByRole("listitem");
const band = (page: Page) => panel(page).getByRole("group", { name: "段落" });
const boundaries = (page: Page) => band(page).getByRole("separator");
const markerBubble = (page: Page) => page.getByRole("dialog");

/** The ruler and the tracks with what is above them, as far as markers and sections go. */
async function shootTop(page: Page, name: string) {
  const box = await panel(page).boundingBox();
  if (!box) return;
  await page.screenshot({
    path: test.info().outputPath(name),
    clip: { x: box.x, y: box.y, width: Math.min(box.width, 900), height: 150 },
  });
}

/** A marker open to change, with the ruler under it. */
async function shootBubble(page: Page, name: string) {
  const bubble = await markerBubble(page).boundingBox();
  const box = await panel(page).boundingBox();
  if (!bubble || !box) return;
  const top = Math.max(bubble.y - 8, 0);
  await page.screenshot({
    path: test.info().outputPath(name),
    clip: { x: box.x, y: top, width: Math.min(box.width, 900), height: box.y + 110 - top },
  });
}

/** Where to take hold of a marker on the ruler: its flag. */
async function flagOf(page: Page, index: number) {
  const box = await markers(page).nth(index).boundingBox();
  if (!box) throw new Error("no marker");
  return { x: box.x, y: box.y + 17 };
}

async function addMarkersAt(page: Page, frames: readonly number[]) {
  for (const frame of frames) {
    await page.keyboard.press("Home");
    await stepRight(page, frame);
    await page.keyboard.press("KeyM");
    await expect(panel(page).locator(`[data-marker][data-frame="${frame}"]`)).toHaveCount(1);
  }
}

test.describe("markers", () => {
  test("M adds one at the playhead, Shift+M and Alt+Shift+M go from one to the next", async ({
    page,
  }) => {
    await addMarkersAt(page, [30, 75]);
    await expect(markers(page)).toHaveCount(2);
    await page.keyboard.press("Home");
    await page.keyboard.press("Shift+KeyM");
    await expect(timecode(page)).toHaveText("0:01/00");
    await page.keyboard.press("Shift+KeyM");
    await expect(timecode(page)).toHaveText("0:02/15");
    await page.keyboard.press("Alt+Shift+KeyM");
    await expect(timecode(page)).toHaveText("0:01/00");
    // M where there is one opens it, and adds nothing.
    await page.keyboard.press("KeyM");
    await expect(markerBubble(page)).toBeVisible();
    await expect(markers(page)).toHaveCount(2);
    await page.keyboard.press("Escape");
    await expect(markerBubble(page)).toHaveCount(0);
    // Ctrl+Alt+M takes away the one at the playhead.
    await stage(page).focus();
    await page.keyboard.press("Control+Alt+KeyM");
    await expect(markers(page)).toHaveCount(1);
    await expect(markers(page).first()).toHaveAttribute("data-frame", "75");
  });

  test("a double click opens its name, colour, duration and note, and each change is a step", async ({
    page,
  }) => {
    await addMarkersAt(page, [30]);
    const flag = await flagOf(page, 0);
    await page.mouse.dblclick(flag.x, flag.y);
    const bubble = markerBubble(page);
    await expect(bubble).toBeVisible();
    await bubble.getByLabel("名字").fill("钩子");
    await bubble.getByLabel("名字").press("Enter");
    await bubble.getByRole("radio", { name: "红色" }).click();
    await bubble.getByLabel("时长").fill("1");
    await bubble.getByLabel("时长").press("Enter");
    await bubble.getByLabel("备注").fill("第一句话抓住观众");
    await bubble.getByLabel("名字").focus();
    await expect(markers(page).first()).toHaveAttribute("aria-label", "标记“钩子”，0:01/00");
    await expect(markers(page).first()).toHaveAttribute("data-color", "red");
    await expect(markers(page).first()).toHaveAttribute("data-end", "60");
    await shootBubble(page, "marker-edit-dark.png");
    await page.mouse.click(flag.x + 300, flag.y + 200);
    await expect(bubble).toHaveCount(0);
    // A second one, with a name that has room between the timecodes; M there opens it.
    await addMarkersAt(page, [105]);
    await page.keyboard.press("KeyM");
    await markerBubble(page).getByLabel("名字").fill("转折");
    await markerBubble(page).getByLabel("名字").press("Enter");
    await page.keyboard.press("Escape");
    await stage(page).focus();
    await page.keyboard.press("Home");
    await shootTop(page, "markers-dark.png");
    // The second marker goes first, its name and then itself; the note was a step of its own,
    // and so was the duration.
    await stage(page).focus();
    await page.keyboard.press("Control+KeyZ");
    await expect(markers(page).nth(1)).toHaveAttribute("aria-label", /^标记，/);
    await page.keyboard.press("Control+KeyZ");
    await expect(markers(page)).toHaveCount(1);
    await page.keyboard.press("Control+KeyZ");
    await expect(markers(page).first()).toHaveAttribute("data-end", "60");
    await page.keyboard.press("Control+KeyZ");
    await expect(markers(page).first()).not.toHaveAttribute("data-end", /./);
    await expect(markers(page).first()).toHaveAttribute("data-color", "red");
  });

  test("drags on the ruler, is selected by a click, and Delete takes it away", async ({ page }) => {
    await addMarkersAt(page, [30]);
    const flag = await flagOf(page, 0);
    await page.mouse.move(flag.x, flag.y);
    await page.mouse.down();
    await page.mouse.move(flag.x + 60, flag.y, { steps: 6 });
    await page.mouse.up();
    const moved = Number(await markers(page).first().getAttribute("data-frame"));
    expect(moved).toBeGreaterThan(30);
    await expect(markers(page).first()).toHaveAttribute("aria-current", "true");
    await page.keyboard.press("Delete");
    await expect(markers(page)).toHaveCount(0);
    await page.keyboard.press("Control+KeyZ");
    await expect(markers(page)).toHaveCount(1);
  });

  test("are in the menu, with their keys", async ({ page }) => {
    await page.getByRole("button", { name: "时间轴", exact: true }).click();
    const menu = page.getByRole("menu");
    await expect(menu.getByRole("menuitem", { name: /^添加标记/ })).toContainText("M");
    await expect(menu.getByRole("menuitem", { name: /^转到下一个标记/ })).toBeDisabled();
    await expect(menu.getByRole("menuitem", { name: /^在播放头分段/ })).toBeDisabled();
    // Delete takes away whatever is selected: markers, transitions, keys or clips.
    await expect(menu.getByRole("menuitem", { name: /^删除(?!片段)/ })).toHaveCount(1);
    await menu.getByRole("menuitem", { name: /^添加标记/ }).click();
    await expect(markers(page)).toHaveCount(1);
  });
});

test.describe("sections", () => {
  async function splitAt(page: Page, frame: number) {
    await stage(page).focus();
    await page.keyboard.press("Home");
    await stepRight(page, frame);
    await page.getByRole("button", { name: "时间轴", exact: true }).click();
    await page
      .getByRole("menu")
      .getByRole("menuitem", { name: /^在播放头分段/ })
      .click();
  }

  test("show once there are two, whose boundary drags, and merge back into one", async ({
    page,
  }) => {
    await expect(band(page)).toHaveCount(0);
    await splitAt(page, 60);
    await expect(band(page)).toBeVisible();
    await expect(boundaries(page)).toHaveCount(1);
    await expect(boundaries(page)).toHaveAttribute("aria-valuenow", "60");
    await splitAt(page, 120);
    await expect(boundaries(page)).toHaveCount(2);

    const blocks = band(page).getByRole("button");
    await blocks.first().dblclick();
    await band(page).getByLabel("段落名字").fill("片头");
    await band(page).getByLabel("段落名字").press("Enter");
    await expect(blocks.first()).toHaveAttribute("aria-label", /^段落“片头”/);
    await addMarkersAt(page, [90]);
    await shootTop(page, "sections-dark.png");

    const first = boundaries(page).first();
    const box = await first.boundingBox();
    if (!box) throw new Error("no boundary");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 - 30, box.y + box.height / 2, { steps: 6 });
    await page.mouse.up();
    const moved = Number(await first.getAttribute("aria-valuenow"));
    expect(moved).toBeLessThan(60);
    // The length stays: the last boundary is where it was.
    await expect(boundaries(page).nth(1)).toHaveAttribute("aria-valuenow", "120");
    await stage(page).focus();
    await page.keyboard.press("Control+KeyZ");
    await expect(first).toHaveAttribute("aria-valuenow", "60");

    await blocks.nth(1).click({ button: "right" });
    await page.getByRole("menuitem", { name: "和前一段合并" }).click();
    await expect(boundaries(page)).toHaveCount(1);
    await expect(boundaries(page)).toHaveAttribute("aria-valuenow", "120");
    await blocks.first().click({ button: "right" });
    await expect(page.getByRole("menuitem", { name: "和前一段合并" })).toHaveCount(0);
    await page.getByRole("menuitem", { name: "和后一段合并" }).click();
    // What is left has no name: nothing to show.
    await expect(band(page)).toHaveCount(0);
  });
});

test.describe("markers and sections in light colours", () => {
  test.use({ colorScheme: "light" });

  test("look as they do in the dark", async ({ page }) => {
    await addMarkersAt(page, [30, 105]);
    await page.keyboard.press("KeyM");
    await markerBubble(page).getByLabel("名字").fill("转折");
    await markerBubble(page).getByLabel("名字").press("Enter");
    await page.keyboard.press("Escape");
    await stage(page).focus();
    const flag = await flagOf(page, 0);
    await page.mouse.dblclick(flag.x, flag.y);
    const bubble = markerBubble(page);
    await bubble.getByLabel("名字").fill("开场");
    await bubble.getByLabel("名字").press("Enter");
    await bubble.getByLabel("时长").fill("1");
    await bubble.getByLabel("时长").press("Enter");
    await shootBubble(page, "marker-edit-light.png");
    await page.keyboard.press("Escape");
    await stage(page).focus();
    await page.keyboard.press("Home");
    await shootTop(page, "markers-light.png");
    await stage(page).focus();
    await page.keyboard.press("Home");
    await stepRight(page, 60);
    await page.getByRole("button", { name: "时间轴", exact: true }).click();
    await page
      .getByRole("menu")
      .getByRole("menuitem", { name: /^在播放头分段/ })
      .click();
    await expect(band(page)).toBeVisible();
    await shootTop(page, "sections-light.png");
  });
});

/* Linked clips taken apart and put together again (pro-editing P4 of AnimaQuill Cloud). */

const clips = (page: Page) =>
  panel(page).getByRole("listbox", { name: "时间轴片段" }).getByRole("option");
const picture = (page: Page) => clips(page).and(page.locator('[aria-label*="，视频 1，"]'));
const sound = (page: Page) => clips(page).and(page.locator('[aria-label*="，音频 1，"]'));
const cards = (page: Page) => resourcesIn(page, "assets");
const VIDEO = {
  name: "采访.mp4",
  mimeType: "video/mp4",
  buffer: readFileSync(new URL("./fixtures/clip.mp4", import.meta.url)),
};

async function middleOf(locator: Locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error("no box");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2, left: box.x };
}

/** A video with sound in the project, and nothing of it on the timeline yet. */
async function importVideo(page: Page) {
  await tab(page, "assets").click();
  const chooser = page.waitForEvent("filechooser");
  await content(page, "assets").getByRole("button", { name: "导入" }).click();
  await (await chooser).setFiles(VIDEO);
  await expect(cards(page)).toHaveCount(1);
}

/** The video at the playhead: its picture and its sound, linked, both selected. */
async function placeVideo(page: Page) {
  await importVideo(page);
  await cards(page).first().click();
  await expect(clips(page)).toHaveCount(2);
  await stage(page).focus();
  // Wider, so that their names and what they say fit.
  for (let index = 0; index < 3; index++) await page.keyboard.press("Equal");
}

/** A click on a clip, with keys held down: the clips on the canvas are what takes it. */
async function clickOn(page: Page, what: Locator, key?: "Alt" | "Shift") {
  const at = await middleOf(what);
  if (key) await page.keyboard.down(key);
  await page.mouse.click(at.x, at.y);
  if (key) await page.keyboard.up(key);
}

/** Drags with the mouse, by some pixels to the right, holding Alt or not. */
async function dragBy(page: Page, what: Locator, pixels: number, alt = false) {
  const from = await middleOf(what);
  if (alt) await page.keyboard.down("Alt");
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + pixels / 2, from.y, { steps: 4 });
  await page.mouse.move(from.x + pixels, from.y, { steps: 4 });
  await page.mouse.up();
  if (alt) await page.keyboard.up("Alt");
}

/** The menu of a clip, with the tracks under it. */
async function shootMenu(page: Page, name: string) {
  const menu = await page.getByRole("menu").boundingBox();
  const box = await panel(page).boundingBox();
  if (!menu || !box) return;
  await page.screenshot({
    path: test.info().outputPath(name),
    clip: {
      x: box.x,
      y: box.y,
      width: Math.min(box.width, 700),
      height: menu.y + menu.height + 8 - box.y,
    },
  });
}

/** The tracks with the clips, for people to look at. */
async function shootClips(page: Page, name: string) {
  const box = await panel(page).boundingBox();
  if (!box) return;
  await page.screenshot({
    path: test.info().outputPath(name),
    clip: {
      x: box.x,
      y: box.y,
      width: Math.min(box.width, 700),
      height: Math.min(box.height, 220),
    },
  });
}

test.describe("linked clips", () => {
  test("Ctrl+L takes them apart and links them again, and out of step they say by how much in red", async ({
    page,
  }) => {
    await placeVideo(page);
    await expect(picture(page)).toHaveAttribute("data-linked", "");
    await expect(sound(page)).toHaveAttribute("data-linked", "");
    await shootClips(page, "linked-dark.png");
    // The page keeps Ctrl+L from the address bar.
    await page.evaluate(() => {
      addEventListener("keydown", (event) => {
        if (event.key === "l")
          (window as unknown as { kept?: boolean }).kept = event.defaultPrevented;
      });
    });
    await page.keyboard.press("Control+KeyL");
    await expect(picture(page)).not.toHaveAttribute("data-linked");
    await expect(sound(page)).not.toHaveAttribute("data-linked");
    expect(await page.evaluate(() => (window as unknown as { kept?: boolean }).kept)).toBe(true);

    // Apart, the picture goes alone, and nothing says it is out of step: they are not linked.
    const lane = await middleOf(picture(page));
    const room = await stage(page).boundingBox();
    await page.mouse.click((room?.x ?? 0) + (room?.width ?? 0) - 30, lane.y);
    const before = await middleOf(sound(page));
    await dragBy(page, picture(page), 60);
    expect((await middleOf(sound(page))).left).toBe(before.left);
    await expect
      .poll(async () => (await middleOf(picture(page))).left)
      .toBeGreaterThan(before.left + 40);
    await expect(clips(page).and(page.locator("[data-out-of-sync]"))).toHaveCount(0);

    // Linked again, out of step: each says how many frames, the one in red on its name.
    await clickOn(page, picture(page));
    await clickOn(page, sound(page), "Shift");
    await page.getByRole("button", { name: "时间轴", exact: true }).click();
    await page.getByRole("menu").getByRole("menuitem", { name: /^联动/ }).click();
    await expect(picture(page)).toHaveAttribute("data-linked", "");
    const ahead = Number(await picture(page).getAttribute("data-out-of-sync"));
    expect(ahead).toBeGreaterThan(0);
    await expect(sound(page)).toHaveAttribute("data-out-of-sync", String(-ahead));
    await expect(sound(page)).toHaveAttribute("aria-description", `和联动的片段差 −${ahead} 帧`);
    await shootClips(page, "out-of-sync-dark.png");

    // The menu of a clip out of step moves it back into step.
    const target = await middleOf(sound(page));
    await page.mouse.click(target.x, target.y, { button: "right" });
    await expect(page.getByRole("menuitem", { name: "分离画面和声音" })).toBeVisible();
    await shootMenu(page, "clip-menu-dark.png");
    await page.getByRole("menuitem", { name: "移回同步" }).click();
    await expect(clips(page).and(page.locator("[data-out-of-sync]"))).toHaveCount(0);
    const lined = await middleOf(picture(page));
    await expect.poll(async () => (await middleOf(sound(page))).left).toBeCloseTo(lined.left, 0);
    await expect(picture(page)).toHaveAttribute("data-linked", "");
    await page.keyboard.press("Control+z");
    await expect(sound(page)).toHaveAttribute("data-out-of-sync", String(-ahead));
  });

  test("Alt takes one of them alone, which then moves alone, out of step", async ({ page }) => {
    await placeVideo(page);
    const at = await middleOf(picture(page));
    await clickOn(page, picture(page), "Alt");
    await expect(picture(page)).toHaveAttribute("aria-selected", "true");
    await expect(sound(page)).toHaveAttribute("aria-selected", "false");
    const before = await middleOf(sound(page));
    await dragBy(page, picture(page), 45, true);
    expect((await middleOf(sound(page))).left).toBe(before.left);
    await expect(picture(page)).toHaveAttribute("data-linked", "");
    await expect(picture(page)).toHaveAttribute("data-out-of-sync", /^[1-9]/);
    await expect(sound(page)).toHaveAttribute("data-out-of-sync", /^-[1-9]/);
    // Without Alt a click takes both again.
    await page.mouse.click(at.x + 45, at.y);
    await expect(sound(page)).toHaveAttribute("aria-selected", "true");
  });
});

test.describe("linked clips in light colours", () => {
  test.use({ colorScheme: "light" });

  test("show their names underlined, and in red how far out of step", async ({ page }) => {
    await placeVideo(page);
    await shootClips(page, "linked-light.png");
    await clickOn(page, sound(page), "Alt");
    await dragBy(page, sound(page), 40, true);
    await expect(sound(page)).toHaveAttribute("data-out-of-sync", /^[1-9]/);
    await shootClips(page, "out-of-sync-light.png");
  });
});

test.describe("only the picture or only the sound of a video", () => {
  /** The card of the video in the assets, with what shows on it while the pointer is there. */
  async function shootCard(page: Page, name: string) {
    const box = await cards(page).first().boundingBox();
    if (!box) return;
    await page.screenshot({
      path: test.info().outputPath(name),
      clip: { x: box.x - 8, y: box.y - 8, width: box.width + 16, height: box.height + 16 },
    });
  }
  const half = (page: Page, which: "video" | "audio") =>
    cards(page).first().locator(`[data-only="${which}"]`);

  test("show on its card under the pointer, and each is one clip of its own where it is dropped", async ({
    page,
  }) => {
    await importVideo(page);
    // They show on the picture only while the pointer is on the card.
    const handles = half(page, "video").locator("..");
    await expect(handles).toHaveCSS("opacity", "0");
    await cards(page).first().hover();
    await expect(handles).toHaveCSS("opacity", "1");
    await expect(half(page, "audio")).toBeVisible();
    await shootCard(page, "card-halves-dark.png");

    await half(page, "audio").dragTo(stage(page), { targetPosition: { x: 200, y: 140 } });
    await expect(clips(page)).toHaveCount(1);
    await expect(sound(page)).toHaveCount(1);
    await expect(sound(page)).not.toHaveAttribute("data-linked");
    await half(page, "video").dragTo(stage(page), { targetPosition: { x: 400, y: 50 } });
    await expect(clips(page)).toHaveCount(2);
    await expect(picture(page)).toHaveCount(1);
    await expect(picture(page)).not.toHaveAttribute("data-linked");
    await expect(clips(page).and(page.locator("[data-linked]"))).toHaveCount(0);

    // The menu of the card has the same, at the playhead.
    await cards(page).first().click({ button: "right" });
    await page.getByRole("menuitem", { name: "放到播放头：只放声音" }).click();
    await expect(clips(page)).toHaveCount(3);
    await expect(clips(page).and(page.locator("[data-linked]"))).toHaveCount(0);
    // A click on the card is all of it, linked, as before.
    await cards(page).first().click();
    await expect(clips(page)).toHaveCount(5);
    await expect(clips(page).and(page.locator("[data-linked]"))).toHaveCount(2);
  });

  test.describe("in light colours", () => {
    test.use({ colorScheme: "light" });

    test("look as they do in the dark", async ({ page }) => {
      await importVideo(page);
      await cards(page).first().hover();
      await expect(half(page, "audio").locator("..")).toHaveCSS("opacity", "1");
      await shootCard(page, "card-halves-light.png");
    });
  });
});
