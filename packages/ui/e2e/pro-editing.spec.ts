import type { Page } from "@playwright/test";
import { content, expect, tab, test } from "./support.ts";

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
