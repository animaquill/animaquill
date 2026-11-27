import type { Locator, Page } from "@playwright/test";
import { animateBesideTimeline, content, expect, newAsset, showTab, test } from "./support.ts";

const panel = (page: Page) => content(page, "timeline");
const stage = (page: Page) => panel(page).getByRole("group", { name: "时间轴", exact: true });
const timecode = (page: Page) => content(page, "preview").locator("output");
const followButton = (area: Locator) => area.getByRole("button", { name: "跟随播放头" });

async function boxOf(locator: Locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error("Element has no box");
  return box;
}

/** Where the playhead is, from the left of the time, in pixels. */
async function playheadAt(page: Page): Promise<number> {
  return page.evaluate(() => {
    const area = document.querySelector('[data-panel="timeline"] [data-follow]');
    const line = document.querySelector<HTMLElement>(
      '[data-panel="timeline"] [role="slider"][aria-label="播放头"]',
    );
    if (!area || !line) return Number.NaN;
    if (line.style.visibility === "hidden") return Number.NaN;
    return line.getBoundingClientRect().left - area.getBoundingClientRect().left;
  });
}

async function chooseWay(area: Locator, page: Page, way: "翻页" | "居中") {
  await area.getByRole("button", { name: "跟随方式" }).click();
  await page.getByRole("menuitemradio", { name: way }).click();
}

/** Ten seconds of clips, from the start, with the timeline close enough to show about two. */
async function closeUp(page: Page) {
  for (let index = 0; index < 2; index += 1) await newAsset(page, "纯色片段");
  await showTab(page, "timeline");
  await stage(page).focus();
  await page.keyboard.press("Home");
  for (let step = 0; step < 4; step += 1) await page.keyboard.press("=");
}

/** The frame of the playhead, also while it is out of sight, which hides it from roles. */
const frameOf = (page: Page) =>
  page.evaluate(() =>
    Number(
      document
        .querySelector('[data-panel="timeline"] [role="slider"][aria-label="播放头"]')
        ?.getAttribute("aria-valuenow"),
    ),
  );

test.beforeEach(async ({ page }) => {
  await showTab(page, "timeline");
  await expect(panel(page)).toBeVisible();
});

test("is on and turns pages by default, and the way stays through a reload", async ({ page }) => {
  await expect(followButton(panel(page))).toHaveAttribute("aria-pressed", "true");
  await expect(stage(page)).toHaveAttribute("data-follow", "page");
  await chooseWay(panel(page), page, "居中");
  await expect(stage(page)).toHaveAttribute("data-follow", "center");
  await followButton(panel(page)).click();
  await expect(stage(page)).toHaveAttribute("data-follow", "off");
  await followButton(panel(page)).click();
  await page.reload();
  await showTab(page, "timeline");
  await expect(stage(page)).toHaveAttribute("data-follow", "center");
  // The menu bar has the same, with which way it is.
  await page.locator("header").getByRole("button", { name: "时间轴", exact: true }).click();
  const pageWay = page.getByRole("menuitemradio", { name: "跟随播放头：翻页" });
  await expect(pageWay).toHaveAttribute("aria-checked", "false");
  await pageWay.click();
  await expect(stage(page)).toHaveAttribute("data-follow", "page");
});

test("turns the page at the right edge while playing", async ({ page }) => {
  await closeUp(page);
  const width = (await boxOf(stage(page))).width;
  await page.keyboard.press("Space");
  // Past a view's worth of time, the playhead is back near the left, not lost on the right.
  await expect
    .poll(
      async () => {
        const x = await playheadAt(page);
        return (await frameOf(page)) > 70 && x >= 40 && x < width / 2;
      },
      { timeout: 10_000, intervals: [50] },
    )
    .toBe(true);
  await page.keyboard.press("Space");
});

test("lets people look elsewhere while it plays, until it plays again", async ({ page }) => {
  await closeUp(page);
  await page.keyboard.press("Space");
  const area = await boxOf(stage(page));
  await page.mouse.move(area.x + area.width / 2, area.y + area.height / 2);
  await page.mouse.wheel(0, 4000);
  await expect.poll(() => playheadAt(page)).toBeNaN();
  await page.waitForTimeout(1500);
  expect(await playheadAt(page)).toBeNaN();
  await page.keyboard.press("Space");
  await page.keyboard.press("Space");
  await expect.poll(() => playheadAt(page), { timeout: 5000 }).not.toBeNaN();
  await page.keyboard.press("Space");
});

test("holds the playhead in the middle the centred way", async ({ page }) => {
  await closeUp(page);
  await chooseWay(panel(page), page, "居中");
  await stage(page).focus();
  await page.keyboard.press("Home");
  const area = await boxOf(stage(page));
  // 0 in the middle, with nothing before it on the left.
  await expect.poll(() => playheadAt(page)).toBeCloseTo(area.width / 2, -0.5);
  await page.keyboard.press("Space");
  for (let sample = 0; sample < 5; sample += 1) {
    await page.waitForTimeout(200);
    expect(Math.abs((await playheadAt(page)) - area.width / 2)).toBeLessThanOrEqual(1);
  }
  await page.keyboard.press("Space");
  // Scrolling across takes time along: the timecode and the picture change.
  const before = await timecode(page).textContent();
  await page.mouse.move(area.x + area.width / 4, area.y + area.height / 2);
  await page.mouse.wheel(0, 300);
  await expect(timecode(page)).not.toHaveText(before ?? "");
  await expect.poll(() => playheadAt(page)).toBeCloseTo(area.width / 2, -0.5);
  // A click on the ruler takes the playhead there, and the view brings it back to the middle.
  const clicked = await timecode(page).textContent();
  await page.mouse.click(area.x + area.width * 0.85, area.y + 10);
  await expect(timecode(page)).not.toHaveText(clicked ?? "");
  await expect.poll(() => playheadAt(page)).toBeCloseTo(area.width / 2, -0.5);
});

test("stays put when off", async ({ page }) => {
  await closeUp(page);
  await followButton(panel(page)).click();
  await expect(stage(page)).toHaveAttribute("data-follow", "off");
  await stage(page).focus();
  await page.keyboard.press("Space");
  await expect.poll(() => frameOf(page), { timeout: 10_000 }).toBeGreaterThan(100);
  await page.keyboard.press("Space");
  expect(await playheadAt(page)).toBeNaN();
  await page.keyboard.press("End");
  expect(await playheadAt(page)).toBeNaN();
});

test("is one switch for the timeline and the keyframe tab", async ({ page }) => {
  await animateBesideTimeline(page);
  const keys = content(page, "keyframes");
  await expect(keys).toBeVisible();
  await followButton(keys).click();
  await expect(followButton(panel(page))).toHaveAttribute("aria-pressed", "false");
  await chooseWay(keys, page, "居中");
  await expect(followButton(panel(page))).toHaveAttribute("aria-pressed", "true");
  await expect(stage(page)).toHaveAttribute("data-follow", "center");
  await expect(keys.getByRole("group", { name: "关键帧", exact: true })).toHaveAttribute(
    "data-follow",
    "center",
  );
});
