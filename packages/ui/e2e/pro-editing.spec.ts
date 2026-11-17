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
  panel(page)
    .getByRole("listbox", { name: "时间轴片段" })
    .getByRole("option")
    .and(page.locator(":not([data-gap])"));
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

/** The button for it in the toolbar, whichever of its names it has now. */
const linkButton = (page: Page) =>
  panel(page)
    .getByRole("toolbar", { name: "时间轴工具" })
    .getByRole("button", { name: /^(分离|联动)|联动$/ });

/** Clicks where there is no clip, which selects nothing. */
async function clickAway(page: Page) {
  const lane = await middleOf(picture(page));
  const room = await stage(page).boundingBox();
  await page.mouse.click((room?.x ?? 0) + (room?.width ?? 0) - 30, lane.y);
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

  test("the button in the toolbar does what Ctrl+L does, and says which of the two", async ({
    page,
  }) => {
    await placeVideo(page);
    await clickAway(page);
    await expect(linkButton(page)).toHaveAccessibleName("分离或联动画面和声音");
    await expect(linkButton(page)).toHaveAttribute("aria-disabled", "true");
    await shootToolbar(page, "toolbar-disabled-dark.png");
    // Disabled, a click does nothing.
    await linkButton(page).click({ force: true });
    await expect(picture(page)).toHaveAttribute("data-linked", "");

    await clickOn(page, picture(page));
    await expect(linkButton(page)).toHaveAccessibleName("分离画面和声音");
    await expect(linkButton(page)).not.toHaveAttribute("aria-disabled");
    await shootToolbar(page, "toolbar-link-dark.png");
    await linkButton(page).click();
    await expect(picture(page)).not.toHaveAttribute("data-linked");
    await expect(sound(page)).not.toHaveAttribute("data-linked");
    // Both are still selected, and the same button puts them together again.
    await expect(linkButton(page)).toHaveAccessibleName("联动画面和声音");
    await shootToolbar(page, "toolbar-unlinked-dark.png");
    await linkButton(page).click();
    await expect(picture(page)).toHaveAttribute("data-linked", "");
    await expect(sound(page)).toHaveAttribute("data-linked", "");
    await expect(linkButton(page)).toHaveAccessibleName("分离画面和声音");
    // One step each.
    await page.keyboard.press("Control+z");
    await expect(picture(page)).not.toHaveAttribute("data-linked");
    await page.keyboard.press("Control+z");
    await expect(picture(page)).toHaveAttribute("data-linked", "");
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

  test("have their button in the toolbar", async ({ page }) => {
    await placeVideo(page);
    await clickAway(page);
    await expect(linkButton(page)).toHaveAttribute("aria-disabled", "true");
    await shootToolbar(page, "toolbar-disabled-light.png");
    await clickOn(page, picture(page));
    await expect(linkButton(page)).toHaveAccessibleName("分离画面和声音");
    await shootToolbar(page, "toolbar-link-light.png");
    await linkButton(page).click();
    await expect(linkButton(page)).toHaveAccessibleName("联动画面和声音");
    await shootToolbar(page, "toolbar-unlinked-light.png");
  });

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

/* Ripple delete, gaps, lift and extract (pro-editing P3a of AnimaQuill Cloud). */

/** The same video again at the playhead, after the one there is. */
async function placeAgain(page: Page) {
  const before = await clips(page).count();
  await tab(page, "assets").click();
  await cards(page).first().click();
  await expect(clips(page)).toHaveCount(before + 2);
  await tab(page, "timeline").click();
  await stage(page).focus();
}

/** Two videos with their sound, the second some frames after the first ends. */
async function twoVideos(page: Page, apart: number) {
  await placeVideo(page);
  await page.keyboard.press("ArrowDown");
  await stepRight(page, apart);
  await placeAgain(page);
}

const leftOf = async (locator: Locator) => (await middleOf(locator)).left;
const rightOf = async (locator: Locator) => {
  const box = await locator.boundingBox();
  if (!box) throw new Error("no box");
  return box.x + box.width;
};
const gapOption = (page: Page) =>
  panel(page).getByRole("listbox", { name: "时间轴片段" }).locator("[data-gap]");
const notice = (page: Page) =>
  page.getByRole("status").filter({ hasText: "后面的内容没法一起左移" });

/** A click in the empty time between the two pictures. */
async function clickGap(page: Page) {
  const from = await rightOf(picture(page).nth(0));
  const to = await leftOf(picture(page).nth(1));
  const { y } = await middleOf(picture(page).nth(0));
  await page.mouse.click((from + to) / 2, y);
}

/** All the tracks, as wide as they are, for people to look at. */
async function shootTracks(page: Page, name: string) {
  const box = await panel(page).boundingBox();
  if (!box) return;
  await page.screenshot({
    path: test.info().outputPath(name),
    clip: { x: box.x, y: box.y, width: box.width, height: Math.min(box.height, 220) },
  });
}

/** The window with the notification in its corner and the tracks, for people to look at. */
async function shootNotice(page: Page, name: string) {
  await page.screenshot({ path: test.info().outputPath(name) });
}

test.describe("ripple edits", () => {
  test("Shift+Delete takes a video away, and what follows moves back with its sound, in one step", async ({
    page,
  }) => {
    await twoVideos(page, 0);
    const start = await leftOf(picture(page).nth(0));
    const later = await leftOf(picture(page).nth(1));
    expect(later).toBeGreaterThan(start + 40);
    await clickOn(page, picture(page).nth(0));
    await expect(sound(page).nth(0)).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Shift+Delete");
    await expect(clips(page)).toHaveCount(2);
    await expect.poll(() => leftOf(picture(page).first())).toBeCloseTo(start, 0);
    await expect.poll(() => leftOf(sound(page).first())).toBeCloseTo(start, 0);
    await page.keyboard.press("Control+z");
    await expect(clips(page)).toHaveCount(4);
    await expect.poll(() => leftOf(picture(page).nth(1))).toBeCloseTo(later, 0);
  });

  test("a click in the empty time between two clips selects it, and Delete closes it", async ({
    page,
  }) => {
    await twoVideos(page, 20);
    const end = await rightOf(picture(page).nth(0));
    const soundBefore = await leftOf(sound(page).nth(1));
    await clickGap(page);
    await expect(gapOption(page)).toHaveAttribute("aria-selected", "true");
    await expect(gapOption(page)).toHaveAttribute("aria-label", /^空隙，视频 1，/);
    await expect(clips(page).and(page.locator('[aria-selected="true"]'))).toHaveCount(0);
    await shootTracks(page, "gap-dark.png");
    await page.keyboard.press("Delete");
    await expect(gapOption(page)).toHaveCount(0);
    await expect.poll(() => leftOf(picture(page).nth(1))).toBeCloseTo(end, 0);
    await expect.poll(() => leftOf(sound(page).nth(1))).toBeLessThan(soundBefore - 20);
    await page.keyboard.press("Control+z");
    await expect.poll(() => leftOf(sound(page).nth(1))).toBeCloseTo(soundBefore, 0);
  });

  test("with something on another track in the way, nothing moves, it lights up, and only those tracks can move", async ({
    page,
  }) => {
    await twoVideos(page, 20);
    const width = (await rightOf(picture(page).nth(0))) - (await leftOf(picture(page).nth(0)));
    const sounds = [await leftOf(sound(page).nth(0)), await leftOf(sound(page).nth(1))];
    const later = await leftOf(picture(page).nth(1));
    // Only the picture, with Alt: its sound is still there in that time.
    await clickOn(page, picture(page).nth(0), "Alt");
    await page.keyboard.press("Shift+Delete");
    await expect(notice(page)).toBeVisible();
    await expect(sound(page).nth(0)).toHaveAttribute("data-blocked", "true");
    await expect(clips(page)).toHaveCount(4);
    expect(await leftOf(picture(page).nth(1))).toBeCloseTo(later, 0);
    await shootNotice(page, "ripple-blocked-dark.png");
    await notice(page).getByRole("button", { name: "只动这几条轨道" }).click();
    await expect(clips(page)).toHaveCount(3);
    // The picture after it moves back by as much, and the sounds stay where they are.
    await expect.poll(() => leftOf(picture(page).first())).toBeCloseTo(later - width, -1);
    expect([await leftOf(sound(page).nth(0)), await leftOf(sound(page).nth(1))]).toEqual(sounds);
  });

  test("leave a locked track where it is", async ({ page }) => {
    await twoVideos(page, 20);
    const end = await rightOf(picture(page).nth(0));
    const soundBefore = await leftOf(sound(page).nth(1));
    await panel(page).getByRole("button", { name: "锁定 音频 1" }).click();
    await stage(page).focus();
    await clickGap(page);
    await page.keyboard.press("Delete");
    await expect.poll(() => leftOf(picture(page).nth(1))).toBeCloseTo(end, 0);
    expect(await leftOf(sound(page).nth(1))).toBeCloseTo(soundBefore, 0);
  });

  test("; lifts between in and out and leaves the time, ' extracts and closes it", async ({
    page,
  }) => {
    await placeVideo(page);
    const mark = async () => {
      await page.keyboard.press("Home");
      await stepRight(page, 10);
      await page.keyboard.press("KeyI");
      await stepRight(page, 9);
      await page.keyboard.press("KeyO");
      await expect(outPoint(page)).toBeVisible();
    };
    await mark();
    await page.keyboard.press("Semicolon");
    await expect(clips(page)).toHaveCount(4);
    // The marks went with what they marked.
    await expect(inPoint(page)).toHaveCount(0);
    expect(await leftOf(picture(page).nth(1))).toBeGreaterThan(
      (await rightOf(picture(page).nth(0))) + 10,
    );
    await page.keyboard.press("Control+z");
    await expect(clips(page)).toHaveCount(2);
    await mark();
    await page.keyboard.press("Quote");
    await expect(clips(page)).toHaveCount(4);
    await expect
      .poll(
        async () => (await leftOf(picture(page).nth(1))) - (await rightOf(picture(page).nth(0))),
      )
      .toBeLessThan(2);
    await expect
      .poll(async () => (await leftOf(sound(page).nth(1))) - (await rightOf(sound(page).nth(0))))
      .toBeLessThan(2);
  });

  test("are in the menu, with their keys, and greyed out while there is nothing to do", async ({
    page,
  }) => {
    await page.getByRole("button", { name: "时间轴", exact: true }).click();
    const menu = page.getByRole("menu");
    await expect(menu.getByRole("menuitem", { name: /^波纹删除/ })).toBeDisabled();
    await expect(menu.getByRole("menuitem", { name: /^抬起/ })).toBeDisabled();
    await expect(menu.getByRole("menuitem", { name: /^提取/ })).toBeDisabled();
    await expect(menu.getByRole("menuitem", { name: /^抬起/ })).toContainText(";");
    await expect(menu.getByRole("menuitem", { name: /^提取/ })).toContainText("'");
  });
});

test.describe("ripple edits in light colours", () => {
  test.use({ colorScheme: "light" });

  test("show the selected gap and what is in the way as they do in the dark", async ({ page }) => {
    await twoVideos(page, 20);
    await clickGap(page);
    await expect(gapOption(page)).toBeVisible();
    await shootTracks(page, "gap-light.png");
    await clickOn(page, picture(page).nth(0), "Alt");
    await page.keyboard.press("Shift+Delete");
    await expect(notice(page)).toBeVisible();
    await shootNotice(page, "ripple-blocked-light.png");
  });
});

/* Inserting and ripple trims (pro-editing P3b of AnimaQuill Cloud). */

const toolbar = (page: Page) => panel(page).getByRole("toolbar", { name: "时间轴工具" });
const switchNamed = (page: Page, name: string) =>
  toolbar(page).getByRole("button", { name, exact: true });

/** The toolbar, for people to look at. */
async function shootToolbar(page: Page, name: string) {
  const box = await toolbar(page).boundingBox();
  if (!box) return;
  await page.screenshot({
    path: test.info().outputPath(name),
    clip: { x: box.x, y: box.y, width: Math.min(box.width, 900), height: box.height },
  });
}

/** Presses on the end of a clip and drags it, leaving the button down for a look. */
async function grabEnd(page: Page, what: Locator, pixels: number, alt = false) {
  const right = await rightOf(what);
  const { y } = await middleOf(what);
  if (alt) await page.keyboard.down("Alt");
  await page.mouse.move(right - 2, y);
  await page.mouse.down();
  await page.mouse.move(right - 2 + pixels / 2, y, { steps: 4 });
  await page.mouse.move(right - 2 + pixels, y, { steps: 4 });
}

test.describe("inserting", () => {
  test("has a switch next to overwriting, and only one of them is on", async ({ page }) => {
    const inserting = switchNamed(page, "插入模式");
    const overwriting = switchNamed(page, "覆盖模式");
    await expect(inserting).toHaveAttribute("aria-pressed", "false");
    await overwriting.click();
    await inserting.click();
    await expect(inserting).toHaveAttribute("aria-pressed", "true");
    await expect(overwriting).toHaveAttribute("aria-pressed", "false");
    await shootToolbar(page, "insert-switch-dark.png");
    await overwriting.click();
    await expect(inserting).toHaveAttribute("aria-pressed", "false");
  });

  test("Shift while dragging puts a video in at the start, and what was there moves on", async ({
    page,
  }) => {
    await twoVideos(page, 20);
    const first = await leftOf(picture(page).nth(0));
    const width = (await rightOf(picture(page).nth(0))) - first;
    const second = await middleOf(picture(page).nth(1));
    await page.mouse.move(second.x, second.y);
    await page.mouse.down();
    await page.mouse.move(second.x - 40, second.y, { steps: 4 });
    // Shift on the way, without moving: inserting from now on, to the start of the first.
    await page.keyboard.down("Shift");
    await page.mouse.move(second.x - (second.left - first) - 1, second.y, { steps: 6 });
    await shootTracks(page, "insert-drag-dark.png");
    await page.mouse.up();
    await page.keyboard.up("Shift");
    await expect(clips(page)).toHaveCount(4);
    // The first video moved on by as long as the second, picture and sound.
    await expect.poll(() => leftOf(picture(page).nth(1))).toBeCloseTo(first + width, -1);
    await expect.poll(() => leftOf(sound(page).nth(1))).toBeCloseTo(first + width, -1);
    await expect.poll(() => leftOf(picture(page).nth(0))).toBeCloseTo(first, -1);
    await page.keyboard.press("Control+z");
    await expect.poll(() => leftOf(picture(page).nth(0))).toBeCloseTo(first, 0);
    await expect.poll(() => leftOf(picture(page).nth(1))).toBeCloseTo(second.left, 0);
  });

  test("Ctrl+Shift+V pastes in at the playhead, and what follows moves on", async ({ page }) => {
    await placeVideo(page);
    const start = await leftOf(picture(page).first());
    const width = (await rightOf(picture(page).first())) - start;
    await clickOn(page, picture(page).first());
    await page.keyboard.press("Control+c");
    await page.keyboard.press("Home");
    await page.keyboard.press("Control+Shift+v");
    await expect(clips(page)).toHaveCount(4);
    await expect.poll(() => leftOf(picture(page).nth(1))).toBeCloseTo(start + width, -1);
    await page.keyboard.press("Control+z");
    await expect(clips(page)).toHaveCount(2);
  });

  test(", puts the chosen asset in at the playhead, . over what is there", async ({ page }) => {
    await placeVideo(page);
    const start = await leftOf(picture(page).first());
    const width = (await rightOf(picture(page).first())) - start;
    // The card was clicked, so it is what is chosen.
    await page.keyboard.press("Home");
    await page.keyboard.press("Comma");
    await expect(clips(page)).toHaveCount(4);
    await expect.poll(() => leftOf(picture(page).nth(1))).toBeCloseTo(start + width, -1);
    // The playhead went to the end of what went in: over the video after it now.
    await page.keyboard.press("Period");
    await expect(clips(page)).toHaveCount(4);
    await page.keyboard.press("Control+z");
    await page.keyboard.press("Control+z");
    await expect(clips(page)).toHaveCount(2);
  });
});

test.describe("ripple trims", () => {
  test("W trims from the playhead to the end, Q from the start to it, and what follows closes up", async ({
    page,
  }) => {
    await twoVideos(page, 0);
    const start = await leftOf(picture(page).nth(0));
    const later = await leftOf(picture(page).nth(1));
    await page.keyboard.press("Home");
    await stepRight(page, 10);
    await page.keyboard.press("KeyW");
    const end = await rightOf(picture(page).nth(0));
    expect(end).toBeLessThan(later - 10);
    await expect.poll(() => leftOf(picture(page).nth(1))).toBeCloseTo(end, 0);
    await expect.poll(() => leftOf(sound(page).nth(1))).toBeCloseTo(end, 0);
    await page.keyboard.press("Control+z");
    await expect.poll(() => leftOf(picture(page).nth(1))).toBeCloseTo(later, 0);
    await page.keyboard.press("KeyQ");
    // The video stays where it starts; what it shows and what follows move back.
    await expect.poll(() => leftOf(picture(page).nth(0))).toBeCloseTo(start, 0);
    await expect.poll(() => leftOf(picture(page).nth(1))).toBeLessThan(later - 10);
    expect(await frameOf(page)).toBe(0);
  });

  test("B is the tool that trims with ripple: what follows moves along, and one undo takes it back", async ({
    page,
  }) => {
    await twoVideos(page, 20);
    const later = await leftOf(picture(page).nth(1));
    const laterSound = await leftOf(sound(page).nth(1));
    await page.keyboard.press("KeyB");
    await expect(toolbar(page).getByRole("button", { name: "波纹编辑工具" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    // The video is all of its file: shorter, with its sound, and both videos after it move back.
    await grabEnd(page, picture(page).nth(0), -40);
    await shootTracks(page, "ripple-tool-dark.png");
    await page.mouse.up();
    await expect.poll(() => leftOf(picture(page).nth(1))).toBeCloseTo(later - 40, -1);
    await expect.poll(() => leftOf(sound(page).nth(1))).toBeCloseTo(laterSound - 40, -1);
    await page.keyboard.press("Control+z");
    await expect.poll(() => leftOf(picture(page).nth(1))).toBeCloseTo(later, 0);
    await expect.poll(() => leftOf(sound(page).nth(1))).toBeCloseTo(laterSound, 0);
  });

  test("with the sound left in the way, nothing moves and it says so", async ({ page }) => {
    await twoVideos(page, 20);
    const later = await leftOf(picture(page).nth(1));
    await page.keyboard.press("KeyB");
    // Only the picture, with Alt: its sound is still in the time that would go.
    await grabEnd(page, picture(page).nth(0), -30, true);
    await page.mouse.up();
    await page.keyboard.up("Alt");
    await expect(notice(page)).toBeVisible();
    await expect(sound(page).nth(0)).toHaveAttribute("data-blocked", "true");
    expect(await leftOf(picture(page).nth(1))).toBeCloseTo(later, 0);
  });

  test("are in the menu, with their keys, and greyed out while there is nothing to do", async ({
    page,
  }) => {
    await page.getByRole("button", { name: "时间轴", exact: true }).click();
    const menu = page.getByRole("menu");
    for (const [name, key] of [
      ["波纹修剪开头到播放头", "Q"],
      ["波纹修剪结尾到播放头", "W"],
      ["插入粘贴", "V"],
      ["插入选中的素材", ","],
      ["覆盖选中的素材", "."],
    ]) {
      const item = menu.getByRole("menuitem", { name: new RegExp(`^${name}`) });
      await expect(item).toBeDisabled();
      await expect(item).toContainText(key as string);
    }
    await expect(menu.getByRole("menuitemradio", { name: /^波纹编辑工具/ })).toContainText("B");
  });
});

test.describe("inserting and ripple trims in light colours", () => {
  test.use({ colorScheme: "light" });

  test("look as they do in the dark", async ({ page }) => {
    await switchNamed(page, "插入模式").click();
    await shootToolbar(page, "insert-switch-light.png");
    await switchNamed(page, "插入模式").click();
    await twoVideos(page, 20);
    await page.keyboard.press("KeyB");
    await grabEnd(page, picture(page).nth(0), -40);
    await shootTracks(page, "ripple-tool-light.png");
    await page.mouse.up();
    const second = await middleOf(picture(page).nth(1));
    const first = await leftOf(picture(page).nth(0));
    await page.keyboard.press("KeyV");
    await page.mouse.move(second.x, second.y);
    await page.mouse.down();
    await page.keyboard.down("Shift");
    await page.mouse.move(second.x - (second.left - first) / 2, second.y, { steps: 6 });
    await shootTracks(page, "insert-drag-light.png");
    await page.mouse.up();
    await page.keyboard.up("Shift");
  });
});

/* Nudging, slip, slide and roll (pro-editing P5 of AnimaQuill Cloud). */

const preview = (page: Page) => content(page, "preview").locator("iframe");
const startOf = async (what: Locator) =>
  /，(\S+) 到 /.exec((await what.getAttribute("aria-label")) ?? "")?.[1];

/** What the preview shows, as pixels, once it has stopped changing. */
async function settledPicture(page: Page): Promise<Buffer> {
  let last = await preview(page).screenshot();
  await expect
    .poll(async () => {
      await page.waitForTimeout(150);
      const now = await preview(page).screenshot();
      const same = now.equals(last);
      last = now;
      return same;
    })
    .toBe(true);
  return last;
}

/** The toolbar and the preview with the tracks, for people to look at. */
async function shootWindow(page: Page, name: string) {
  await page.screenshot({ path: test.info().outputPath(name) });
}

test.describe("nudging", () => {
  test("Alt+Right moves the selected clips a frame on, and the browser does not go back", async ({
    page,
  }) => {
    await placeVideo(page);
    // Somewhere to go back to, as people come from another page.
    const url = page.url();
    await page.evaluate(() => history.pushState({ step: 2 }, "", location.href));
    await expect(picture(page)).toHaveAttribute("aria-selected", "true");
    expect(await startOf(picture(page))).toBe("0:00/00");
    await page.keyboard.press("Alt+ArrowRight");
    await expect.poll(() => startOf(picture(page))).toBe("0:00/01");
    expect(await startOf(sound(page))).toBe("0:00/01");
    await page.keyboard.press("Alt+Shift+ArrowRight");
    await expect.poll(() => startOf(picture(page))).toBe("0:00/06");
    await page.keyboard.press("Alt+ArrowLeft");
    await expect.poll(() => startOf(picture(page))).toBe("0:00/05");
    // With nothing selected it does nothing, and the page is still the page.
    await page.keyboard.press("Escape");
    await page.mouse.click((await rightOf(picture(page))) + 200, (await middleOf(picture(page))).y);
    await page.keyboard.press("Alt+ArrowLeft");
    await page.waitForTimeout(300);
    expect(page.url()).toBe(url);
    await expect(stage(page)).toBeVisible();
    expect(await startOf(picture(page))).toBe("0:00/05");
    await page.keyboard.press("Control+z");
    await expect.poll(() => startOf(picture(page))).toBe("0:00/06");
  });

  test("stops at the next clip with overwriting off, and covers it with overwriting on", async ({
    page,
  }) => {
    await twoVideos(page, 3);
    const next = await startOf(picture(page).nth(1));
    await clickOn(page, picture(page).nth(0));
    for (let index = 0; index < 3; index++) await page.keyboard.press("Alt+ArrowRight");
    await expect.poll(() => startOf(picture(page).nth(0))).toBe("0:00/03");
    // Touching the next one: one more is in the way, and only lights up.
    await page.keyboard.press("Alt+ArrowRight");
    await expect(picture(page).nth(1)).toHaveAttribute("data-blocked", "true");
    expect(await startOf(picture(page).nth(0))).toBe("0:00/03");
    expect(await startOf(picture(page).nth(1))).toBe(next);
    await switchNamed(page, "覆盖模式").click();
    await stage(page).focus();
    await page.keyboard.press("Alt+ArrowRight");
    await expect.poll(() => startOf(picture(page).nth(0))).toBe("0:00/04");
    // What was under it went: the second video starts a frame later now.
    await expect.poll(() => startOf(picture(page).nth(1))).not.toBe(next);
    await switchNamed(page, "覆盖模式").click();
  });
});

test.describe("slip, slide and roll", () => {
  test("are tools next to ripple, with their keys", async ({ page }) => {
    for (const [name, key] of [
      ["滚动编辑工具", "KeyN"],
      ["滑移工具", "KeyY"],
      ["滑动工具", "Shift+KeyY"],
    ] as const) {
      await page.keyboard.press(key);
      await expect(toolbar(page).getByRole("button", { name, exact: true })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
    }
    await shootToolbar(page, "tools-dark.png");
    await page.keyboard.press("KeyV");
  });

  test("the slip tool shows the frame at the edit while it drags, and the playhead after", async ({
    page,
  }) => {
    await placeVideo(page);
    // Half a second of the two: room to slip either way.
    await page.keyboard.press("Home");
    await stepRight(page, 15);
    await page.keyboard.press("KeyW");
    await page.keyboard.press("Home");
    await stepRight(page, 10);
    const before = await settledPicture(page);
    await page.keyboard.press("KeyY");
    const from = await middleOf(picture(page));
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x - 20, from.y, { steps: 4 });
    await page.mouse.move(from.x - 40, from.y, { steps: 4 });
    const during = await settledPicture(page);
    expect(during.equals(before)).toBe(false);
    await shootWindow(page, "slip-drag-dark.png");
    await page.mouse.up();
    const after = await settledPicture(page);
    expect(after.equals(during)).toBe(false);
    // The playhead again: the same as going there afresh.
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowLeft");
    expect((await settledPicture(page)).equals(after)).toBe(true);
    await page.keyboard.press("Control+z");
    expect((await settledPicture(page)).equals(before)).toBe(true);
  });

  test("the roll tool moves the cut between two videos, and one undo takes it back", async ({
    page,
  }) => {
    await twoVideos(page, 0);
    // The first video a second and a half long: room to roll the cut later.
    await page.keyboard.press("Home");
    await stepRight(page, 45);
    await page.keyboard.press("KeyW");
    const cut = await leftOf(picture(page).nth(1));
    expect(await rightOf(picture(page).nth(0))).toBeCloseTo(cut, 0);
    await page.keyboard.press("KeyN");
    const { y } = await middleOf(picture(page).nth(0));
    await page.mouse.move(cut - 2, y);
    await page.mouse.down();
    await page.mouse.move(cut + 10, y, { steps: 4 });
    await page.mouse.move(cut + 30, y, { steps: 4 });
    await page.mouse.up();
    await expect.poll(() => leftOf(picture(page).nth(1))).toBeGreaterThan(cut + 20);
    expect(await rightOf(picture(page).nth(0))).toBeCloseTo(await leftOf(picture(page).nth(1)), 0);
    // The sound of both goes along.
    await expect.poll(() => leftOf(sound(page).nth(1))).toBeGreaterThan(cut + 20);
    await page.keyboard.press("Control+z");
    await expect.poll(() => leftOf(picture(page).nth(1))).toBeCloseTo(cut, 0);
    await expect.poll(() => leftOf(sound(page).nth(1))).toBeCloseTo(cut, 0);
  });
});

test.describe("slip, slide and roll in light colours", () => {
  test.use({ colorScheme: "light" });

  test("look as they do in the dark", async ({ page }) => {
    await placeVideo(page);
    await page.keyboard.press("Home");
    await stepRight(page, 15);
    await page.keyboard.press("KeyW");
    await page.keyboard.press("KeyY");
    await shootToolbar(page, "tools-light.png");
    const from = await middleOf(picture(page));
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x - 40, from.y, { steps: 6 });
    await settledPicture(page);
    await shootWindow(page, "slip-drag-light.png");
    await page.mouse.up();
  });
});
