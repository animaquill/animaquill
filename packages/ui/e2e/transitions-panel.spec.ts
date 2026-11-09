import type { Locator, Page } from "@playwright/test";
import { importClips } from "./project-files.ts";
import { content, expect, tab, tabScrolls, test } from "./support.ts";

/**
 * The transitions tab, and what it puts on the timeline: dragged onto a clip or a cut, or clicked
 * with something selected. See docs/design/resource-panels.md, sections 2 and 3.
 */

test.use({ withProject: false });

/** Screenshots to look at, in the output of each test. */
const shot = (name: string) => ({ path: test.info().outputPath(name) });

const panel = (page: Page) => content(page, "transitions");
const item = (page: Page, name: string) =>
  panel(page).getByRole("option", { name, exact: true }).first();
const clips = (page: Page) => content(page, "timeline").getByRole("option");
const properties = (page: Page) => content(page, "properties");

/** Red and green one after the other, blue after a gap. */
async function open(page: Page) {
  await importClips(page, 10, [
    { id: "a", name: "红", start: "0", duration: "3", source: { kind: "color", color: "#ff0000" } },
    { id: "b", name: "绿", start: "3", duration: "3", source: { kind: "color", color: "#00ff00" } },
    { id: "c", name: "蓝", start: "7", duration: "3", source: { kind: "color", color: "#0000ff" } },
  ]);
  await tab(page, "transitions").click();
  await expect(panel(page)).toBeVisible();
}

async function boxOf(locator: Locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error("not on screen");
  return box;
}

/** A place on a clip, as a share of it across, at the height of the clip. */
async function onClip(page: Page, index: number, share: number) {
  const box = await boxOf(clips(page).nth(index));
  return { x: box.x + box.width * share, y: box.y + box.height / 2 + 6 };
}

/** The top of a clip, where the blocks of its transitions are. */
async function onTop(page: Page, index: number, share: number) {
  const box = await boxOf(clips(page).nth(index));
  return { x: box.x + box.width * share, y: box.y + 8 };
}

/** Drags a transition from the tab to a place, and does `meanwhile` while it is over it. */
async function drag(
  page: Page,
  name: string,
  to: { x: number; y: number },
  meanwhile?: () => Promise<void>,
) {
  await item(page, name).scrollIntoViewIfNeeded();
  const from = await boxOf(item(page, name));
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 + 10, from.y + from.height / 2 + 10, { steps: 3 });
  await page.mouse.move(to.x, to.y, { steps: 12 });
  await page.mouse.move(to.x + 1, to.y, { steps: 2 });
  await meanwhile?.();
  await page.mouse.up();
}

const timelineShot = (page: Page) =>
  content(page, "timeline").getByRole("group", { name: "时间轴" }).screenshot();

/** Selects the transition at a place on the top of a clip, and says what the properties call it. */
async function chooseAt(page: Page, at: { x: number; y: number }) {
  await page.mouse.click(at.x, at.y);
}

test("lists the transitions by where they go, finds them, and groups them other ways", async ({
  page,
}) => {
  await open(page);
  const groups = panel(page).getByRole("group");
  await expect(groups.nth(0)).toHaveAccessibleName("入转场");
  await expect(groups.nth(1)).toHaveAccessibleName("衔接转场");
  await expect(groups.nth(2)).toHaveAccessibleName("出转场");
  await expect(groups.nth(0).getByRole("option")).toHaveCount(11);
  await expect(item(page, "从左推入")).toBeVisible();
  await panel(page).screenshot(shot("transitions-panel.png"));

  const search = panel(page).getByRole("searchbox", { name: "搜索转场" });
  await search.fill("推入");
  await expect(panel(page).getByRole("option")).toHaveCount(4);
  await expect(groups).toHaveCount(1);
  await search.fill("没有这种");
  await expect(panel(page).getByText("没有找到“没有这种”")).toBeVisible();
  await search.press("Escape");
  await expect(search).toHaveValue("");

  await panel(page).getByRole("radio", { name: "按来源" }).click();
  await expect(groups).toHaveCount(1);
  await expect(groups.first()).toHaveAccessibleName("内置");
  await panel(page).getByRole("radio", { name: "按标签" }).click();
  await expect(panel(page).getByRole("group", { name: "运动" })).toBeVisible();
  await expect(panel(page).getByRole("group", { name: "运动" }).getByRole("option")).toHaveCount(
    12,
  );
  // The way it groups stays after a reload.
  await page.reload();
  await tab(page, "transitions").click();
  await expect(panel(page).getByRole("radio", { name: "按标签" })).toBeChecked();
  await panel(page).getByRole("radio", { name: "按类型" }).click();

  // Right there is only the way to the explorer.
  await item(page, "淡入").click({ button: "right" });
  await expect(page.getByRole("menuitem")).toHaveText(["在资源管理器里显示"]);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
});

test("go where they are dropped, which lights up first, and nowhere else", async ({ page }) => {
  await open(page);
  const plain = await timelineShot(page);

  // The middle of a clip takes nothing, and shows nothing.
  const middle = await onClip(page, 2, 0.5);
  await drag(page, "从左推入", middle, async () => {
    expect((await timelineShot(page)).equals(plain)).toBe(true);
  });
  await expect(properties(page).getByRole("region", { name: /推/ })).toHaveCount(0);

  // The first third of a clip is where it comes in, which lights up while it is over it.
  const start = await onClip(page, 2, 0.15);
  await drag(page, "从左推入", start, async () => {
    await expect.poll(async () => (await timelineShot(page)).equals(plain)).toBe(false);
    await content(page, "timeline").screenshot(shot("transitions-drop-enter.png"));
  });
  await expect(properties(page).getByRole("region", { name: "从左推入" })).toBeVisible();
  await expect(properties(page).getByRole("textbox", { name: "时长" })).toHaveValue("0:00/15");

  // The last third is where it goes out.
  await drag(page, "向右推出", await onClip(page, 2, 0.9));
  await expect(properties(page).getByRole("region", { name: "向右推出" })).toBeVisible();

  // The cut between two clips that touch takes one between them.
  const cut = await boxOf(clips(page).nth(0));
  await drag(page, "叠化", { x: cut.x + cut.width - 1, y: cut.y + cut.height / 2 }, async () => {
    await content(page, "timeline").screenshot(shot("transitions-drop-join.png"));
  });
  await expect(properties(page).getByText("红 → 绿")).toBeVisible();
  await expect(properties(page).getByRole("region", { name: "叠化" })).toBeVisible();

  // Undo takes them away one at a time.
  await content(page, "timeline").getByRole("group", { name: "时间轴" }).focus();
  await page.keyboard.press("Control+z");
  await expect(properties(page).getByText("红 → 绿")).toHaveCount(0);
});

test("go on what is selected with a click, and say why where they cannot", async ({ page }) => {
  await open(page);
  // One clip: people say where.
  await page.mouse.click(...xy(await onClip(page, 2, 0.5)));
  await expect(panel(page).getByText(/点一个转场|前三分之一|也可以先选中/)).toHaveCount(0);
  // The reasons for what is greyed out stay, and it all fits without the tab scrolling.
  await expect(item(page, "叠化")).toHaveAttribute("aria-disabled", "true");
  await expect(item(page, "叠化")).toHaveAttribute("title", /衔接转场要加在两个首尾相接的片段之间/);
  expect(await tabScrolls(page, "transitions")).toBe(false);
  await item(page, "从左推入").click();
  await expect(page.getByRole("menuitem", { name: "加在开头（从左推入）" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "加在结尾（向右推出）" })).toBeVisible();
  await page.getByRole("menuitem", { name: "两头都加" }).click();
  await chooseAt(page, await onTop(page, 2, 0.08));
  await expect(properties(page).getByRole("region", { name: "从左推入" })).toBeVisible();
  await chooseAt(page, await onTop(page, 2, 0.92));
  await expect(properties(page).getByRole("region", { name: "向右推出" })).toBeVisible();

  // A join is selected: only another join can take its place, and the others say so.
  await page.mouse.click(...xy(await onClip(page, 0, 0.5)));
  await page.keyboard.down("Shift");
  await page.mouse.click(...xy(await onClip(page, 1, 0.5)));
  await page.keyboard.up("Shift");
  await item(page, "叠化").click();
  await chooseAt(page, await onTop(page, 0, 0.99));
  await expect(properties(page).getByText("红 → 绿")).toBeVisible();
  const fadeIn = item(page, "淡入");
  await expect(fadeIn).toHaveAttribute("aria-disabled", "true");
  await fadeIn.hover();
  await expect(panel(page).getByRole("status")).toHaveText("选中的是衔接转场，只能换成衔接转场");
  await fadeIn.click({ force: true });
  await expect(properties(page).getByText("红 → 绿")).toBeVisible();
  await panel(page).screenshot(shot("transitions-greyed.png"));

  // Several clips: each gets it.
  await page.mouse.click(...xy(await onClip(page, 0, 0.5)));
  await page.keyboard.down("Shift");
  await page.mouse.click(...xy(await onClip(page, 1, 0.5)));
  await page.keyboard.up("Shift");
  await item(page, "从黑场淡入").click();
  // a has it at its start; b comes in by the join, so its start does not take one.
  await chooseAt(page, await onTop(page, 0, 0.08));
  await expect(properties(page).getByRole("region", { name: "从黑场淡入" })).toBeVisible();
});

test("take the place of one, as long as it was, and go with Delete or a button", async ({
  page,
}) => {
  await open(page);
  await drag(page, "淡入", await onClip(page, 2, 0.15));
  const duration = properties(page).getByRole("textbox", { name: "时长" });
  await duration.fill("1");
  await duration.press("Enter");
  await expect(duration).toHaveValue("0:01/00");

  // Selected, a click on another one of the same kind takes its place.
  await item(page, "从右擦入").click();
  await expect(properties(page).getByRole("region", { name: "从右擦入" })).toBeVisible();
  await expect(duration).toHaveValue("0:01/00");
  await expect(item(page, "从右擦入")).toHaveAttribute("aria-current", "true");

  // Dragged onto it, as well.
  await drag(page, "从左推入", await onTop(page, 2, 0.2));
  await expect(properties(page).getByRole("region", { name: "从左推入" })).toBeVisible();
  await expect(duration).toHaveValue("0:01/00");

  // Delete on the timeline, and back with undo.
  await chooseAt(page, await onTop(page, 2, 0.1));
  await page.keyboard.press("Delete");
  await expect(properties(page).getByRole("region", { name: "从左推入" })).toHaveCount(0);
  await page.keyboard.press("Control+z");
  await chooseAt(page, await onTop(page, 2, 0.1));
  await expect(properties(page).getByRole("region", { name: "从左推入" })).toBeVisible();
  // The button in the properties.
  await properties(page).getByRole("button", { name: "删除转场" }).click();
  await expect(properties(page).getByRole("region", { name: "从左推入" })).toHaveCount(0);
});

test("work from the keyboard: arrows move, Enter puts one on", async ({ page }) => {
  await open(page);
  await page.mouse.click(...xy(await onClip(page, 2, 0.5)));
  const search = panel(page).getByRole("searchbox", { name: "搜索转场" });
  await search.focus();
  await page.keyboard.press("ArrowDown");
  await expect(item(page, "淡入")).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(item(page, "从黑场淡入")).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(item(page, "淡入")).toBeFocused();
  await page.keyboard.press("End");
  await page.keyboard.press("Home");
  await expect(item(page, "淡入")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("menuitem", { name: "加在开头（淡入）" })).toBeFocused();
  await page.keyboard.press("Enter");
  await chooseAt(page, await onTop(page, 2, 0.08));
  await expect(properties(page).getByRole("region", { name: "淡入" })).toBeVisible();
});

const xy = ({ x, y }: { x: number; y: number }) => [x, y] as const;
