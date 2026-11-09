import type { Locator, Page } from "@playwright/test";
import {
  chooseLayout,
  content,
  expect,
  group,
  layoutMenu,
  needsDevPage,
  tab,
  test,
} from "./support.ts";

const LAYOUT_KEY = "animaquill.layout";

const groups = (page: Page) => page.locator(".dv-groupview");

async function chooseFromView(page: Page, name: string) {
  await page.getByRole("button", { name: "视图" }).click();
  await page.getByRole("menu").getByRole("menuitem", { name, exact: true }).click();
}

async function box(locator: Locator) {
  const value = await locator.boundingBox();
  if (!value) throw new Error("Element has no box");
  return value;
}

/** The layout follows the window a moment later, so measuring right away can give the old place. */
async function settledBox(locator: Locator) {
  let before = "";
  await expect
    .poll(async () => {
      const now = JSON.stringify(await box(locator));
      const stable = now === before;
      before = now;
      return stable;
    })
    .toBe(true);
  return box(locator);
}

async function savedLayout(page: Page) {
  const text = await page.evaluate((key) => localStorage.getItem(key), LAYOUT_KEY);
  return text ?? "";
}

/** Saving is delayed, so wait until the change is on disk before leaving the page. */
async function waitForSave(page: Page, before: string) {
  await expect.poll(() => savedLayout(page)).not.toBe(before);
}

/** Presses at one point and moves to another with real mouse events, without letting go. */
async function pressAndMove(page: Page, fromX: number, fromY: number, x: number, y: number) {
  await page.mouse.move(fromX, fromY);
  await page.mouse.down();
  await page.mouse.move(fromX + 8, fromY + 8, { steps: 3 });
  await page.mouse.move(x, y, { steps: 10 });
}

/**
 * Where a dropped tab goes into a strip. Not the very middle: the middle of a tab is neither
 * before it nor after it, and dockview takes nothing there.
 */
async function intoStrip(page: Page, type: string): Promise<[number, number]> {
  const strip = await box(group(page, type).locator(".dv-tabs-container"));
  return [strip.x + strip.width / 2 + 5, strip.y + strip.height / 2 + 5];
}

/** Drags a tab to a point of the window. */
async function dragTab(page: Page, type: string, x: number, y: number) {
  const from = await box(tab(page, type));
  await pressAndMove(page, from.x + from.width / 2, from.y + from.height / 2, x, y);
  await page.mouse.up();
}

test("opens with the editing layout", async ({ page }) => {
  for (const type of ["assets", "preview", "properties", "timeline"]) {
    await expect(tab(page, type)).toBeVisible();
    await expect(content(page, type)).toBeVisible();
  }
  await expect(tab(page, "files")).toBeVisible();
  await expect(layoutMenu(page, "剪辑")).toBeVisible();
  await expect(page.locator("footer").getByRole("button", { name: "测试项目" })).toBeVisible();
});

test("the title bar has the search in the middle and the layouts on the right", async ({
  page,
}) => {
  const bar = await box(page.locator("header").first());
  const search = await box(page.getByRole("button", { name: "命令面板" }));
  expect(Math.abs(search.x + search.width / 2 - (bar.x + bar.width / 2))).toBeLessThan(2);
  const layouts = await box(layoutMenu(page, "剪辑"));
  expect(layouts.x).toBeGreaterThan(search.x + search.width);
  expect(layouts.x + layouts.width).toBeGreaterThan(bar.x + bar.width - 20);
  // Its menu opens towards the window, not past its edge.
  await layoutMenu(page, "剪辑").click();
  const menu = await box(page.getByRole("menu"));
  expect(menu.x + menu.width).toBeLessThanOrEqual(bar.x + bar.width);
});

test("the status bar has the project on the left and what goes on now on the right", async ({
  page,
}) => {
  const bar = page.locator("footer");
  const left = [
    bar.getByRole("button", { name: "测试项目" }),
    bar.getByLabel("项目分辨率：1920×1080"),
    bar.getByRole("button", { name: "项目帧率" }),
    bar.getByRole("status").filter({ hasText: "已保存" }),
  ];
  const right = [
    bar.getByRole("button", { name: "当前时间和总时长" }),
    bar.getByLabel(/^预览画质和帧率/),
  ];
  await expect(left[2] as Locator).toHaveText("30 帧");
  const xs = await Promise.all([...left, ...right].map(async (item) => (await box(item)).x));
  expect(xs).toEqual(xs.toSorted((a, b) => a - b));
  const barBox = await box(bar);
  expect(xs[3]).toBeLessThan(barBox.x + barBox.width / 2);
  expect(xs[4]).toBeGreaterThan(barBox.x + barBox.width / 2);
  // Each is there once.
  await expect(bar.getByText("1920×1080")).toHaveCount(1);
  await expect(bar.getByText(/帧/)).toHaveCount(1);
});

test("a tab can be dragged into another group", async ({ page }) => {
  // Chat shares the group of properties. Without it there, properties is the only tab of its group.
  await tab(page, "chat").click({ button: "middle" });
  await dragTab(page, "properties", ...(await intoStrip(page, "timeline")));
  await expect(group(page, "timeline").locator('[data-tab="properties"]')).toBeVisible();
  // It was the only tab of its group, which goes with it.
  await expect(groups(page)).toHaveCount(3);
});

test("only a tab starts a drag, not the empty part of the tab strip", async ({ page }) => {
  const timeline = group(page, "timeline");
  const before = await box(timeline);
  const strip = await box(timeline.locator(".dv-void-container"));
  const target = await box(group(page, "preview"));
  await expect(timeline.locator(".dv-void-container")).toHaveCSS("cursor", "default");

  await pressAndMove(
    page,
    strip.x + strip.width / 2,
    strip.y + strip.height / 2,
    target.x + target.width - 12,
    target.y + target.height / 2,
  );
  await page.waitForTimeout(150);
  await expect(page.locator(".dv-drop-target-selection, .dv-drop-target-anchor")).toHaveCount(0);
  await page.mouse.up();

  await page.waitForTimeout(150);
  expect(await box(timeline)).toEqual(before);
  expect(await page.evaluate(() => getSelection()?.toString())).toBe("");
});

test("the empty part of the tab strip still focuses the group and takes tabs", async ({ page }) => {
  const timeline = group(page, "timeline");
  const strip = await box(timeline.locator(".dv-void-container"));
  const x = strip.x + strip.width / 2;
  const y = strip.y + strip.height / 2;

  await page.mouse.click(x, y);
  await expect(timeline).toHaveClass(/dv-active-group/);

  await dragTab(page, "properties", x, y);
  await expect(timeline.locator('[data-tab="properties"]')).toBeVisible();
});

test("a tab dropped on the edge of a group makes a new group", async ({ page }) => {
  const before = await groups(page).count();
  const target = await box(group(page, "preview"));
  await dragTab(page, "assets", target.x + target.width - 12, target.y + target.height / 2);
  await expect(groups(page)).toHaveCount(before + 1);
  const preview = await box(group(page, "preview"));
  const assets = await box(group(page, "assets"));
  expect(assets.x).toBeGreaterThanOrEqual(preview.x + preview.width - 2);
});

test("groups can be resized with the divider", async ({ page }) => {
  const left = await box(group(page, "assets"));
  const preview = await box(group(page, "preview"));
  const x = preview.x;
  const y = preview.y + preview.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 120, y, { steps: 8 });
  await page.mouse.up();
  const after = await box(group(page, "assets"));
  expect(after.width).toBeGreaterThan(left.width + 100);
});

test("a closed tab comes back from the view menu", async ({ page }) => {
  await group(page, "preview").locator('button[aria-label="关闭 预览"]').click();
  await expect(tab(page, "preview")).toHaveCount(0);
  await chooseFromView(page, "预览");
  await expect(tab(page, "preview")).toBeVisible();

  const left = await box(group(page, "assets"));
  const preview = await box(group(page, "preview"));
  const right = await box(group(page, "properties"));
  expect(preview.x).toBeGreaterThanOrEqual(left.x + left.width - 1);
  expect(right.x).toBeGreaterThanOrEqual(preview.x + preview.width - 1);
});

test("a tab closes with the middle button", async ({ page }) => {
  await tab(page, "code").click({ button: "middle" });
  await expect(tab(page, "code")).toHaveCount(0);
  await expect(tab(page, "preview")).toBeVisible();
});

test("the tab menu closes other tabs", async ({ page }) => {
  await tab(page, "timeline").click({ button: "right" });
  await page.getByText("关闭其他", { exact: true }).click();
  await expect(tab(page, "problems")).toHaveCount(0);
  await expect(tab(page, "keyframes")).toHaveCount(0);
  await expect(tab(page, "timeline")).toBeVisible();
});

test("a panel opens next to the panels of its area", async ({ page }) => {
  await chooseFromView(page, "经验库");
  await expect(group(page, "properties").locator('[data-tab="notes"]')).toBeVisible();
  await expect(content(page, "notes")).toBeVisible();
});

test("the layout survives a reload", async ({ page }) => {
  const before = await savedLayout(page);
  await dragTab(page, "properties", ...(await intoStrip(page, "timeline")));
  await waitForSave(page, before);
  await page.reload();
  await expect(group(page, "timeline").locator('[data-tab="properties"]')).toBeVisible();
});

test("the layout fits a different window size", async ({ page }) => {
  const before = await savedLayout(page);
  await tab(page, "code").click({ button: "middle" });
  await waitForSave(page, before);
  await page.setViewportSize({ width: 1000, height: 640 });
  await page.reload();
  await expect(tab(page, "preview")).toBeVisible();
  const area = await box(page.locator(".dv-dockview"));
  expect(area.x + area.width).toBeLessThanOrEqual(1000);
  expect(area.y + area.height).toBeLessThanOrEqual(640);
  const timeline = await box(group(page, "timeline"));
  expect(timeline.y + timeline.height).toBeLessThanOrEqual(area.y + area.height + 1);
  expect(timeline.width).toBeGreaterThan(area.width - 2);
});

test("every layout keeps its own arrangement", async ({ page }) => {
  await tab(page, "files").click({ button: "middle" });
  await chooseLayout(page, "动画");
  await expect(tab(page, "files")).toBeVisible();
  await expect(group(page, "code").locator('[data-tab="preview"]')).toHaveCount(0);
  await chooseLayout(page, "剪辑");
  await expect(tab(page, "timeline")).toBeVisible();
  await expect(tab(page, "files")).toHaveCount(0);
});

test.describe("several windows", () => {
  async function secondWindow(page: Page) {
    const other = await page.context().newPage();
    await other.goto(page.url());
    await expect(tab(other, "preview")).toBeVisible();
    return other;
  }

  test("each window keeps its layout through a reload", async ({ page }) => {
    const other = await secondWindow(page);
    const before = await savedLayout(other);
    await chooseLayout(other, "动画");
    await waitForSave(other, before);

    await page.reload();
    await expect(tab(page, "preview")).toBeVisible();
    await expect(layoutMenu(page, "剪辑")).toBeVisible();

    await other.reload();
    await expect(tab(other, "preview")).toBeVisible();
    await expect(layoutMenu(other, "动画")).toBeVisible();
  });

  test("a new window starts in the layout chosen last", async ({ page }) => {
    const before = await savedLayout(page);
    await chooseLayout(page, "动画");
    await waitForSave(page, before);
    const other = await secondWindow(page);
    await expect(layoutMenu(other, "动画")).toBeVisible();
  });

  test("a window on the start page has not chosen a layout yet", async ({ page }) => {
    const waiting = await page.context().newPage();
    await waiting.goto("/");
    await expect(waiting.getByRole("button", { name: "新建项目" })).toBeVisible();

    const before = await savedLayout(page);
    await chooseLayout(page, "动画");
    await waitForSave(page, before);

    await waiting.getByRole("button", { name: /^测试项目/ }).click();
    await expect(tab(waiting, "preview")).toBeVisible();
    await expect(layoutMenu(waiting, "动画")).toBeVisible();
  });

  test("windows do not undo each other's arrangement", async ({ page }) => {
    const other = await secondWindow(page);
    await chooseLayout(other, "动画");
    await expect(tab(other, "keyframes")).toBeVisible();

    let before = await savedLayout(other);
    await tab(other, "keyframes").click({ button: "middle" });
    await waitForSave(other, before);

    before = await savedLayout(page);
    await tab(page, "code").click({ button: "middle" });
    await waitForSave(page, before);

    // Both ask for the other layout too: an arrangement that is gone looks the same as one that
    // is not on screen.
    await other.reload();
    await expect(tab(other, "preview")).toBeVisible();
    await chooseLayout(other, "剪辑");
    await chooseLayout(other, "动画");
    await expect(tab(other, "preview")).toBeVisible();
    await expect(tab(other, "keyframes")).toHaveCount(0);
    await page.reload();
    await expect(tab(page, "preview")).toBeVisible();
    await chooseLayout(page, "动画");
    await chooseLayout(page, "剪辑");
    await expect(tab(page, "preview")).toBeVisible();
    await expect(tab(page, "code")).toHaveCount(0);
  });

  test("switching shows what another window arranged", async ({ page }) => {
    const other = await secondWindow(page);
    await chooseLayout(other, "动画");
    await expect(tab(other, "keyframes")).toBeVisible();
    const before = await savedLayout(other);
    await tab(other, "keyframes").click({ button: "middle" });
    await waitForSave(other, before);

    await chooseLayout(page, "动画");
    await expect(tab(page, "preview")).toBeVisible();
    await expect(tab(page, "keyframes")).toHaveCount(0);
  });
});

test("reset brings back the design of the current layout only", async ({ page }) => {
  await tab(page, "code").click({ button: "middle" });
  await chooseLayout(page, "动画");
  await tab(page, "keyframes").click({ button: "middle" });
  await layoutMenu(page, "动画").click();
  await page.getByRole("menuitem", { name: "恢复这个布局的默认样子" }).click();
  await expect(tab(page, "keyframes")).toBeVisible();
  await chooseLayout(page, "剪辑");
  await expect(tab(page, "timeline")).toBeVisible();
  await expect(tab(page, "code")).toHaveCount(0);
});

const EVERY_TAB = [
  "files",
  "explorer",
  "assets",
  "transitions",
  "effects",
  "preview",
  "code",
  "properties",
  "chat",
];
const EVERY_TAB_BELOW = ["timeline", "keyframes", "problems"];

test("closing everything leaves a way back", async ({ page }) => {
  for (const type of [...EVERY_TAB, ...EVERY_TAB_BELOW]) {
    await tab(page, type).click({ button: "middle" });
  }
  await expect(page.getByText("所有选项卡都关闭了")).toBeVisible();
  await page.getByRole("button", { name: "恢复默认布局" }).click();
  await expect(tab(page, "preview")).toBeVisible();
});

test("panels of every area find their place in an empty dock", async ({ page }) => {
  for (const type of [...EVERY_TAB, ...EVERY_TAB_BELOW]) {
    await tab(page, type).click({ button: "middle" });
  }
  await chooseFromView(page, "时间轴");
  await chooseFromView(page, "属性");
  await chooseFromView(page, "文件");
  await chooseFromView(page, "预览");
  for (const type of ["timeline", "properties", "files", "preview"]) {
    await expect(content(page, type)).toBeVisible();
  }
  const files = await box(group(page, "files"));
  const preview = await box(group(page, "preview"));
  expect(preview.x).toBeGreaterThanOrEqual(files.x + files.width - 1);
});

test("opening a page changes nothing in the saved layout", async ({ page }) => {
  await page.waitForTimeout(1000);
  expect(await savedLayout(page)).toBe("");
});

test("tabs have their real names for screen readers", async ({ page }) => {
  await expect(page.getByRole("tab", { name: "素材", exact: true })).toBeVisible();
  await expect(page.getByRole("tab", { name: "assets" })).toHaveCount(0);
});

test("a broken saved layout falls back and says so", async ({ page }) => {
  await page.evaluate((key) => localStorage.setItem(key, "{not json"), LAYOUT_KEY);
  await page.reload();
  await expect(tab(page, "preview")).toBeVisible();
  await expect(page.getByText("上次的布局无法恢复，已换成默认布局。")).toBeVisible();
});

test("a saved layout that dockview refuses falls back and says so", async ({ page }) => {
  await page.evaluate((key) => {
    const dockview = { grid: { root: { type: "nonsense" } }, panels: {} };
    const states = { edit: { dock: { dockview, strips: {} }, panels: [] } };
    localStorage.setItem(key, JSON.stringify({ version: 3, current: "edit", custom: [], states }));
  }, LAYOUT_KEY);
  await page.reload();
  await expect(tab(page, "preview")).toBeVisible();
  await expect(page.getByText("上次的布局无法恢复，已换成默认布局。")).toBeVisible();
});

test("a panel from another version shows a message instead of breaking", async ({ page }) => {
  const before = await savedLayout(page);
  await tab(page, "code").click({ button: "middle" });
  await waitForSave(page, before);
  await page.evaluate((key) => {
    const text = localStorage.getItem(key) ?? "";
    localStorage.setItem(key, text.replaceAll('"type":"properties"', '"type":"from.the.future"'));
  }, LAYOUT_KEY);
  await page.reload();
  await expect(page.getByRole("tab", { name: "不可用" })).toBeVisible();
  await expect(tab(page, "preview")).toBeVisible();
});

test("a crash stays inside its tab and can be retried", async ({ page, problems, devPage }) => {
  test.skip(!devPage, needsDevPage("the tab 崩溃测试"));
  await chooseFromView(page, "崩溃测试");
  await content(page, "dev.crash").getByRole("button", { name: "崩溃" }).click();
  await expect(page.getByText("这个选项卡出错了，其他选项卡不受影响。")).toBeVisible();
  await expect(content(page, "timeline")).toBeVisible();
  await page.getByRole("button", { name: "重试" }).click();
  await expect(content(page, "dev.crash").getByRole("button", { name: "崩溃" })).toBeVisible();
  // React reports the error it caught, which is exactly what this test provokes.
  const others = problems.filter((text) => !text.includes("Crash on request"));
  problems.splice(0, problems.length, ...others);
});

test("a panel that must stay alive is not reloaded by dragging", async ({ page, devPage }) => {
  test.skip(!devPage, needsDevPage("the tab 内嵌页面"));
  await chooseFromView(page, "内嵌页面");
  const loads = content(page, "dev.frame").locator("p");
  await expect(loads).toHaveText("加载次数：1");

  await dragTab(page, "dev.frame", ...(await intoStrip(page, "timeline")));
  await expect(group(page, "timeline").locator('[data-tab="dev.frame"]')).toBeVisible();

  const edge = await box(group(page, "preview"));
  await dragTab(page, "dev.frame", edge.x + edge.width - 12, edge.y + edge.height / 2);
  await expect(group(page, "dev.frame").locator('[data-tab="preview"]')).toHaveCount(0);

  await page.waitForTimeout(300);
  await expect(loads).toHaveText("加载次数：1");
});

test("a panel that must stay alive is not reloaded when its tabs change sides", async ({
  page,
  devPage,
}) => {
  test.skip(!devPage, needsDevPage("the tab 内嵌页面"));
  await chooseFromView(page, "内嵌页面");
  const loads = content(page, "dev.frame").locator("p");
  await expect(loads).toHaveText("加载次数：1");
  for (const side of ["选项卡在左侧", "选项卡在右侧", "选项卡在上方", "选项卡在左侧"]) {
    await tab(page, "dev.frame").click({ button: "right" });
    await page.getByRole("menuitemradio", { name: side }).click();
    // The page stays where it is, and follows the content a moment later. Until then it is over
    // where the tabs went, and a click there would go to it.
    await settledBox(content(page, "dev.frame"));
  }
  await tab(page, "dev.frame").click({ button: "right" });
  await page.getByRole("menuitemcheckbox", { name: "钉住选项卡" }).click();
  await page.waitForTimeout(300);
  await expect(loads).toHaveText("加载次数：1");
});

test("a panel shared by two layouts is not rebuilt when switching", async ({ page }) => {
  await content(page, "preview").evaluate((element: HTMLElement) => {
    element.dataset["marker"] = "kept";
  });
  await chooseLayout(page, "动画");
  await expect(tab(page, "keyframes")).toBeVisible();
  await expect(content(page, "preview")).toHaveAttribute("data-marker", "kept");
});

test("panels do not scroll when their content fits", async ({ page }) => {
  for (const name of ["剪辑", "动画", "音频", "AI"]) {
    if (name !== "剪辑") await chooseLayout(page, name);
    const overflowing = await page
      .locator("[data-panel]:visible")
      .evaluateAll((elements) =>
        elements
          .filter((element) => element.scrollHeight > element.clientHeight)
          .map((element) => (element as HTMLElement).dataset["panel"]),
      );
    expect(overflowing).toEqual([]);
  }
});

test("a scrollbar that is really needed is thin and can be seen", async ({ page }) => {
  const panel = await box(content(page, "timeline"));
  const clip = { x: panel.x + panel.width - 10, y: panel.y, width: 10, height: panel.height };
  const before = await page.screenshot({ clip });

  const width = await content(page, "timeline").evaluate((element: HTMLElement) => {
    const tall = document.createElement("div");
    tall.style.height = "3000px";
    element.append(tall);
    return element.offsetWidth - element.clientWidth;
  });
  expect(width).toBe(10);
  expect((await page.screenshot({ clip })).equals(before)).toBe(false);
});

async function expectTabInView(page: Page, type: string) {
  await expect(content(page, type)).toBeVisible();
  await page.waitForTimeout(150);
  const strip = await box(group(page, type).locator(".dv-tabs-container"));
  const active = await box(tab(page, type));
  expect(active.x).toBeGreaterThanOrEqual(strip.x - 1);
  expect(active.x + active.width).toBeLessThanOrEqual(strip.x + strip.width + 1);
  expect(active.y).toBeGreaterThanOrEqual(strip.y - 1);
  expect(active.y + active.height).toBeLessThanOrEqual(strip.y + strip.height + 1);
}

/** Panels that open in the middle, enough to fill its tab strip in a small window. */
const MORE_IN_THE_MIDDLE = ["快捷键", "设置", "版本矩阵", "音乐", "录音"];

test("the active tab is not hidden in a narrow group", async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 620 });
  for (const name of MORE_IN_THE_MIDDLE) await chooseFromView(page, name);
  await expectTabInView(page, "recording");
  await chooseFromView(page, "预览");
  await expectTabInView(page, "preview");
  await chooseFromView(page, "录音");
  await expectTabInView(page, "recording");
});

test("the active tab stays in view when the strip first runs out of room", async ({ page }) => {
  for (const name of MORE_IN_THE_MIDDLE) {
    await chooseFromView(page, name);
  }
  await expectTabInView(page, "recording");
});

/** Panels that open down the right side, enough to fill its strip in a low window. */
const MORE_ON_THE_RIGHT = ["经验库", "历史记录", "批注", "聊天"];

test("the active tab of a full strip down a side is in view", async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 360 });
  for (const name of MORE_ON_THE_RIGHT) await chooseFromView(page, name);
  await expectTabInView(page, "chat");
  await chooseFromView(page, "属性");
  await expectTabInView(page, "properties");
});

test("a tab dragged into a full strip is in view", async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 620 });
  for (const name of MORE_IN_THE_MIDDLE) await chooseFromView(page, name);
  // In the middle, because near the ends the strip scrolls by itself during a drag.
  const strip = await settledBox(group(page, "preview").locator(".dv-tabs-container"));
  await dragTab(page, "properties", strip.x + strip.width / 2, strip.y + strip.height / 2);
  await expect(group(page, "preview").locator('[data-tab="properties"]')).toBeVisible();
  await expectTabInView(page, "properties");
});

test("the wheel scrolls a tab strip that is full", async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 620 });
  for (const name of MORE_IN_THE_MIDDLE) await chooseFromView(page, name);
  const list = group(page, "preview").locator(".dv-tabs-container");
  await list.evaluate((element: HTMLElement) => (element.scrollLeft = 0));
  const strip = await settledBox(list);
  await page.mouse.move(strip.x + 40, strip.y + strip.height / 2);
  await page.mouse.wheel(0, 120);
  await expect
    .poll(() => list.evaluate((element: HTMLElement) => element.scrollLeft))
    .toBeGreaterThan(0);
});

test("a tab strip that is full shows no scrollbar", async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 320 });
  for (const name of [...MORE_IN_THE_MIDDLE, ...MORE_ON_THE_RIGHT])
    await chooseFromView(page, name);
  const across = group(page, "preview").locator(".dv-tabs-container");
  const down = group(page, "properties").locator(".dv-tabs-container");
  expect(await across.evaluate((element: HTMLElement) => element.scrollWidth)).toBeGreaterThan(
    await across.evaluate((element: HTMLElement) => element.clientWidth),
  );
  expect(await down.evaluate((element: HTMLElement) => element.scrollHeight)).toBeGreaterThan(
    await down.evaluate((element: HTMLElement) => element.clientHeight),
  );
  expect(
    await across.evaluate((element: HTMLElement) => element.offsetHeight - element.clientHeight),
  ).toBe(0);
  expect(
    await down.evaluate((element: HTMLElement) => element.offsetWidth - element.clientWidth),
  ).toBe(0);
});

test("the layout menu works from the keyboard", async ({ page }) => {
  const trigger = layoutMenu(page, "剪辑");
  await trigger.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("menu")).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(layoutMenu(page, "动画")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("menu")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
});

test("clicking elsewhere closes the view menu", async ({ page }) => {
  await page.getByRole("button", { name: "视图" }).click();
  await content(page, "timeline").click();
  await expect(page.getByRole("menu")).toHaveCount(0);
});

test.describe("tabs down a side", () => {
  /** The tab itself, which dockview makes focusable, around the content of `tab`. */
  const tabButton = (page: Page, type: string) =>
    page.getByRole("tab").filter({ has: tab(page, type) });
  const radio = (page: Page, name: string) =>
    page.getByRole("menu").getByRole("menuitemradio", { name, exact: true });
  const check = (page: Page, name: string) =>
    page.getByRole("menu").getByRole("menuitemcheckbox", { name, exact: true });
  const edge = (page: Page, type: string) =>
    group(page, type).getByRole("separator", { name: "选项卡栏的宽度" });
  /** The empty part of the strip of a group, under or after its tabs. */
  const emptyPart = async (page: Page, type: string) => {
    const part = await box(group(page, type).locator(".dv-void-container"));
    return { x: part.x + part.width / 2, y: part.y + part.height / 2 };
  };
  const rightClickEmptyPart = async (page: Page, type: string) => {
    const { x, y } = await emptyPart(page, type);
    await page.mouse.click(x, y, { button: "right" });
  };
  const away = (page: Page) => page.mouse.move(700, 300);
  const widthOf = async (page: Page, type: string) => (await box(tab(page, type))).width;

  test("switch in place, with the content where it was", async ({ page }) => {
    const left = await box(group(page, "assets"));
    const assets = await box(content(page, "assets"));
    await expect(groups(page)).toHaveCount(4);
    await tab(page, "files").click();
    await expect(content(page, "files")).toBeVisible();
    await expect(content(page, "assets")).toBeHidden();
    expect(await box(group(page, "files"))).toEqual(left);
    const files = await box(content(page, "files"));
    expect(files).toEqual(assets);
    await expect(groups(page)).toHaveCount(4);
    // The tabs are one under the other, beside the content.
    await away(page);
    const first = await settledBox(tab(page, "files"));
    const second = await box(tab(page, "assets"));
    expect(second.y).toBeGreaterThanOrEqual(first.y + first.height - 1);
    expect(first.x + first.width).toBeLessThanOrEqual(files.x + 1);
    await expect(page.getByRole("tab", { name: "素材", exact: true })).toBeVisible();
  });

  test("show big icons, and their names over the content on hover", async ({ page }) => {
    await away(page);
    const narrow = await settledBox(tab(page, "timeline"));
    expect(narrow.width).toBeLessThan(50);
    const icon = await box(tab(page, "timeline").locator("svg").first());
    expect(icon.width).toBe(20);
    const before = await box(content(page, "timeline"));

    await page.mouse.move(narrow.x + narrow.width / 2, narrow.y + narrow.height / 2);
    await expect.poll(() => widthOf(page, "timeline")).toBeGreaterThan(100);
    expect(await box(content(page, "timeline"))).toEqual(before);
    const name = tab(page, "timeline").getByText("时间轴");
    await expect(name).toBeVisible();
    // The names are on top: what is under the mouse there is the tab.
    const point = await box(name);
    const hit = await page.evaluate(
      ({ x, y }) =>
        document.elementFromPoint(x, y)?.closest("[data-tab]")?.getAttribute("data-tab"),
      { x: point.x + point.width / 2, y: point.y + point.height / 2 },
    );
    expect(hit).toBe("timeline");

    // And go when the mouse leaves.
    await away(page);
    await expect.poll(() => widthOf(page, "timeline")).toBeLessThan(50);
    // A click on an icon switches, and the names go in, to show what it switched to.
    const problems = await box(tab(page, "problems"));
    const middle = { x: problems.x + problems.width / 2, y: problems.y + problems.height / 2 };
    await page.mouse.move(middle.x, middle.y);
    await expect.poll(() => widthOf(page, "problems")).toBeGreaterThan(100);
    await page.mouse.click(middle.x, middle.y);
    await expect(content(page, "problems")).toBeVisible();
    await expect.poll(() => widthOf(page, "problems")).toBeLessThan(50);
    // Until the mouse comes back.
    await away(page);
    await page.mouse.move(middle.x, middle.y);
    await expect.poll(() => widthOf(page, "problems")).toBeGreaterThan(100);
  });

  test("show their names over a panel that stays alive", async ({ page }) => {
    await chooseLayout(page, "AI");
    // Chat stays alive, which dockview shows on a layer of its own, above the groups.
    await chooseFromView(page, "聊天");
    await expect(group(page, "properties").locator('[data-tab="chat"]')).toBeVisible();
    await expect(content(page, "chat")).toBeVisible();
    await away(page);
    const right = await settledBox(tab(page, "properties"));
    expect(right.width).toBeLessThan(50);
    await page.mouse.move(right.x + right.width / 2, right.y + right.height / 2);
    await expect.poll(() => widthOf(page, "properties")).toBeGreaterThan(100);
    const name = await box(tab(page, "properties").getByText("属性"));
    const hit = await page.evaluate(
      ({ x, y }) =>
        document.elementFromPoint(x, y)?.closest("[data-tab]")?.getAttribute("data-tab"),
      { x: name.x + name.width / 2, y: name.y + name.height / 2 },
    );
    expect(hit).toBe("properties");
  });

  test("get pinned from the menu of a tab, and then give their names room", async ({ page }) => {
    await away(page);
    const before = await settledBox(content(page, "timeline"));
    await tab(page, "timeline").click({ button: "right" });
    await expect(check(page, "钉住选项卡")).toHaveAttribute("aria-checked", "false");
    await check(page, "钉住选项卡").click();
    await away(page);
    await expect.poll(() => widthOf(page, "timeline")).toBeGreaterThan(100);
    const after = await settledBox(content(page, "timeline"));
    expect(after.x).toBeGreaterThan(before.x + 60);
    await expect(tab(page, "timeline").getByText("时间轴")).toBeVisible();
    // Names that show all the time have nothing to come out.
    await tab(page, "timeline").click({ button: "right" });
    await expect(check(page, "钉住选项卡")).toHaveAttribute("aria-checked", "true");
    await expect(check(page, "鼠标悬停时展开")).toBeDisabled();
  });

  test("keep to their icons when names coming out is turned off", async ({ page }) => {
    await rightClickEmptyPart(page, "timeline");
    await expect(check(page, "鼠标悬停时展开")).toHaveAttribute("aria-checked", "true");
    await check(page, "鼠标悬停时展开").click();
    const icon = await box(tab(page, "problems"));
    await page.mouse.move(icon.x + icon.width / 2, icon.y + icon.height / 2);
    await page.waitForTimeout(400);
    expect(await widthOf(page, "problems")).toBeLessThan(50);
    // The name is still there for the mouse to find, and a click switches.
    await expect(tab(page, "problems")).toHaveAttribute("title", "问题");
    await page.mouse.click(icon.x + icon.width / 2, icon.y + icon.height / 2);
    await expect(content(page, "problems")).toBeVisible();
  });

  test("have the same menu on the empty part of their strip, for the whole group", async ({
    page,
  }) => {
    await rightClickEmptyPart(page, "timeline");
    const menu = page.getByRole("menu");
    await expect(radio(page, "选项卡在左侧")).toHaveAttribute("aria-checked", "true");
    await expect(check(page, "钉住选项卡")).toBeVisible();
    // Nothing about one tab there.
    await expect(menu.getByRole("menuitem", { name: "关闭" })).toHaveCount(0);
    await radio(page, "选项卡在右侧").click();
    const timeline = await settledBox(content(page, "timeline"));
    expect((await box(tab(page, "timeline"))).x).toBeGreaterThanOrEqual(
      timeline.x + timeline.width - 1,
    );
  });

  test("move to the top and back from the menu, and the preview is not rebuilt", async ({
    page,
  }) => {
    await content(page, "preview").evaluate((element: HTMLElement) => {
      element.dataset["marker"] = "kept";
    });
    await rightClickEmptyPart(page, "preview");
    await radio(page, "选项卡在左侧").click();
    const preview = await settledBox(content(page, "preview"));
    const code = await box(tab(page, "code"));
    expect(code.x + code.width).toBeLessThanOrEqual(preview.x + 1);
    expect(code.y).toBeGreaterThan((await box(tab(page, "preview"))).y);

    await tab(page, "preview").click({ button: "right" });
    await radio(page, "选项卡在上方").click();
    const across = await settledBox(content(page, "preview"));
    expect((await box(tab(page, "preview"))).y + 1).toBeLessThan(across.y);
    await expect(content(page, "preview")).toHaveAttribute("data-marker", "kept");
  });

  test("go to a side of their group when the empty part of the strip is dragged there", async ({
    page,
  }) => {
    const target = page.locator(".aq-strip-target");
    const drag = async (
      to: (box: { x: number; y: number; width: number; height: number }) => {
        x: number;
        y: number;
      },
    ) => {
      const from = await emptyPart(page, "timeline");
      const area = await box(group(page, "timeline"));
      const { x, y } = to(area);
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.mouse.move(from.x + 10, from.y - 10, { steps: 3 });
      await page.mouse.move(x, y, { steps: 10 });
    };

    await drag((area) => ({ x: area.x + area.width / 2, y: area.y + 20 }));
    await expect(target).toHaveAttribute("data-side", "top");
    await page.mouse.up();
    await expect(target).toHaveCount(0);
    let timeline = await settledBox(content(page, "timeline"));
    expect((await box(tab(page, "timeline"))).y + 1).toBeLessThan(timeline.y);

    await drag((area) => ({ x: area.x + area.width - 30, y: area.y + area.height / 2 }));
    await expect(target).toHaveAttribute("data-side", "right");
    await page.mouse.up();
    // Off the strip, whose names would come out under the mouse.
    await away(page);
    timeline = await settledBox(content(page, "timeline"));
    expect((await box(tab(page, "timeline"))).x).toBeGreaterThanOrEqual(
      timeline.x + timeline.width - 1,
    );

    // Esc lets go without a change, and so does letting go outside the group.
    await drag((area) => ({ x: area.x + 30, y: area.y + area.height / 2 }));
    await expect(target).toHaveAttribute("data-side", "left");
    await page.keyboard.press("Escape");
    await expect(target).toHaveCount(0);
    await page.mouse.up();
    await drag(() => ({ x: 700, y: 200 }));
    await expect(target).toHaveCount(0);
    await page.mouse.up();
    await away(page);
    timeline = await settledBox(content(page, "timeline"));
    expect((await box(tab(page, "timeline"))).x).toBeGreaterThanOrEqual(
      timeline.x + timeline.width - 1,
    );
    await expect(groups(page)).toHaveCount(4);
  });

  test("get their names, and lose them, by dragging their edge, and keep the width", async ({
    page,
  }) => {
    const saved = await savedLayout(page);
    const handle = await box(edge(page, "timeline"));
    const outer = (await box(group(page, "timeline"))).x;
    const y = handle.y + handle.height / 2;
    // From the content onto the edge: the names stay in, and the edge is that of the strip.
    await page.mouse.move(handle.x + 40, y);
    await page.mouse.move(handle.x + handle.width / 2, y, { steps: 4 });
    await page.waitForTimeout(300);
    expect(await widthOf(page, "timeline")).toBeLessThan(50);
    await page.mouse.down();
    // Out past where names fit: pinned, as wide as dragged, already while dragging.
    await page.mouse.move(outer + 200, y, { steps: 10 });
    await expect.poll(() => widthOf(page, "timeline")).toBeGreaterThan(190);
    await page.mouse.move(outer + 170, y, { steps: 5 });
    await page.mouse.up();
    await away(page);
    await expect.poll(() => widthOf(page, "timeline")).toBeGreaterThan(160);
    expect(await widthOf(page, "timeline")).toBeLessThan(175);

    await waitForSave(page, saved);
    await page.reload();
    await expect(tab(page, "timeline")).toBeVisible();
    await away(page);
    await expect.poll(() => widthOf(page, "timeline")).toBeGreaterThan(160);
    await expect(tab(page, "timeline").getByText("时间轴")).toBeVisible();

    // In to near the icons: only icons again.
    const pinned = await box(edge(page, "timeline"));
    await page.mouse.move(pinned.x + pinned.width / 2, y);
    await page.mouse.down();
    await page.mouse.move(outer + 50, y, { steps: 10 });
    await expect.poll(() => widthOf(page, "timeline")).toBeLessThan(50);
    await page.mouse.up();
    await away(page);
    await tab(page, "timeline").click({ button: "right" });
    await expect(check(page, "钉住选项卡")).toHaveAttribute("aria-checked", "false");
  });

  test("make the names that come out wider by their own edge, and stay icons", async ({ page }) => {
    const namesEdge = group(page, "timeline").getByRole("separator", { name: "展开时的宽度" });
    const saved = await savedLayout(page);
    const icon = await box(tab(page, "timeline"));
    const outer = (await box(group(page, "timeline"))).x;
    await page.mouse.move(icon.x + icon.width / 2, icon.y + icon.height / 2);
    await expect.poll(() => widthOf(page, "timeline")).toBeGreaterThan(100);
    const out = await widthOf(page, "timeline");
    // While the names are out, the edge of the strip under them is not there to catch the mouse.
    await expect(edge(page, "timeline")).toBeHidden();
    const at = await box(namesEdge);
    expect(at.x + at.width / 2).toBeCloseTo(outer + out, -1);

    const y = at.y + at.height / 2;
    await page.mouse.move(at.x + at.width / 2, y, { steps: 4 });
    await page.mouse.down();
    await page.mouse.move(outer + 240, y, { steps: 10 });
    await expect.poll(() => widthOf(page, "timeline")).toBeGreaterThan(230);
    await page.mouse.up();
    await waitForSave(page, saved);

    // Still only icons when the mouse is gone, and not pinned.
    await away(page);
    await expect.poll(() => widthOf(page, "timeline")).toBeLessThan(50);
    await tab(page, "timeline").click({ button: "right" });
    await expect(check(page, "钉住选项卡")).toHaveAttribute("aria-checked", "false");
    await page.keyboard.press("Escape");

    // And as wide as dragged when they come out, also after a reload.
    await page.reload();
    await expect(tab(page, "timeline")).toBeVisible();
    await away(page);
    const again = await settledBox(tab(page, "timeline"));
    await page.mouse.move(again.x + again.width / 2, again.y + again.height / 2);
    await expect.poll(() => widthOf(page, "timeline")).toBeGreaterThan(230);
    expect(await widthOf(page, "timeline")).toBeLessThan(250);
  });

  test("remember their side, and whether names show and come out", async ({ page }) => {
    let before = await savedLayout(page);
    await rightClickEmptyPart(page, "preview");
    await radio(page, "选项卡在右侧").click();
    await waitForSave(page, before);
    before = await savedLayout(page);
    await tab(page, "files").click({ button: "right" });
    await check(page, "钉住选项卡").click();
    await waitForSave(page, before);
    before = await savedLayout(page);
    await rightClickEmptyPart(page, "timeline");
    await check(page, "鼠标悬停时展开").click();
    await waitForSave(page, before);
    await page.reload();
    await expect(tab(page, "preview")).toBeVisible();
    await tab(page, "files").click({ button: "right" });
    await expect(check(page, "钉住选项卡")).toHaveAttribute("aria-checked", "true");
    await page.keyboard.press("Escape");
    await rightClickEmptyPart(page, "timeline");
    await expect(check(page, "鼠标悬停时展开")).toHaveAttribute("aria-checked", "false");
    await page.keyboard.press("Escape");
    const preview = await box(content(page, "preview"));
    expect((await box(tab(page, "preview"))).x).toBeGreaterThanOrEqual(
      preview.x + preview.width - 1,
    );
  });

  test("have no buttons of their own", async ({ page }) => {
    for (const type of ["assets", "preview", "properties", "timeline"]) {
      await expect(group(page, type).getByRole("button", { name: /钉住|位置/ })).toHaveCount(0);
    }
  });

  test("take tabs from across the top, and give them back", async ({ page }) => {
    const left = await box(group(page, "files").locator(".dv-tabs-container"));
    await dragTab(page, "code", left.x + left.width / 2, left.y + left.height - 6);
    await expect(group(page, "files").locator('[data-tab="code"]')).toBeVisible();
    await expect(content(page, "code")).toBeVisible();

    await dragTab(page, "assets", ...(await intoStrip(page, "preview")));
    await expect(group(page, "preview").locator('[data-tab="assets"]')).toBeVisible();
    await expect(group(page, "files").locator('[data-tab="assets"]')).toHaveCount(0);
  });

  test("change order by dragging", async ({ page }) => {
    const files = await box(tab(page, "files"));
    await dragTab(page, "assets", files.x + files.width / 2, files.y + 4);
    await expect
      .poll(async () => (await box(tab(page, "assets"))).y)
      .toBeLessThan((await box(tab(page, "files"))).y);
  });

  test("close from the menu, with the middle button and with their button", async ({ page }) => {
    await tab(page, "keyframes").click({ button: "middle" });
    await expect(tab(page, "keyframes")).toHaveCount(0);
    await tab(page, "timeline").click({ button: "right" });
    await page.getByRole("menuitem", { name: "关闭下方" }).click();
    await expect(tab(page, "problems")).toHaveCount(0);
    await tab(page, "files").hover();
    await group(page, "files").getByRole("button", { name: "关闭 文件" }).click();
    await expect(tab(page, "files")).toHaveCount(0);
    await expect(content(page, "assets")).toBeVisible();
  });

  test("switch with the arrow keys while the tabs have the focus", async ({ page }) => {
    await tabButton(page, "files").focus();
    await page.keyboard.press("ArrowDown");
    await expect(content(page, "explorer")).toBeVisible();
    await expect(tabButton(page, "explorer")).toBeFocused();
    await page.keyboard.press("ArrowUp");
    await expect(content(page, "files")).toBeVisible();
    await expect(tabButton(page, "files")).toBeFocused();
  });
});
