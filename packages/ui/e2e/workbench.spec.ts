import type { Locator, Page } from "@playwright/test";
import { content, expect, group, tab, test } from "./support.ts";

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

/** Drags a tab to a point of the window. */
async function dragTab(page: Page, type: string, x: number, y: number) {
  const from = await box(tab(page, type));
  await pressAndMove(page, from.x + from.width / 2, from.y + from.height / 2, x, y);
  await page.mouse.up();
}

test("opens with the editing workspace", async ({ page }) => {
  for (const type of ["assets", "preview", "properties", "timeline"]) {
    await expect(tab(page, type)).toBeVisible();
    await expect(content(page, type)).toBeVisible();
  }
  await expect(page.getByRole("button", { name: "剪辑", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByText("未打开项目")).toBeVisible();
});

test("a tab can be dragged into another group", async ({ page }) => {
  const target = await box(group(page, "timeline").locator(".dv-tabs-container"));
  await dragTab(page, "properties", target.x + target.width / 2, target.y + target.height / 2);
  await expect(group(page, "timeline").locator('[data-tab="properties"]')).toBeVisible();
  await expect(group(page, "chat").locator('[data-tab="properties"]')).toHaveCount(0);
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
  await dragTab(page, "properties", target.x + target.width - 12, target.y + target.height / 2);
  await expect(groups(page)).toHaveCount(before + 1);
  const preview = await box(group(page, "preview"));
  const properties = await box(group(page, "properties"));
  expect(properties.x).toBeGreaterThanOrEqual(preview.x + preview.width - 2);
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
  await tab(page, "chat").click({ button: "middle" });
  await expect(tab(page, "chat")).toHaveCount(0);
  await expect(tab(page, "properties")).toBeVisible();
});

test("the tab menu closes other tabs", async ({ page }) => {
  await tab(page, "timeline").click({ button: "right" });
  await page.getByText("关闭其他", { exact: true }).click();
  await expect(tab(page, "problems")).toHaveCount(0);
  await expect(tab(page, "terminal")).toHaveCount(0);
  await expect(tab(page, "timeline")).toBeVisible();
});

test("a panel opens next to the panels of its area", async ({ page }) => {
  await chooseFromView(page, "经验库");
  await expect(group(page, "assets").locator('[data-tab="notes"]')).toBeVisible();
  await expect(content(page, "notes")).toBeVisible();
});

test("the activity bar shows and reveals panels", async ({ page }) => {
  const files = page.getByRole("button", { name: "文件", exact: true });
  await expect(files).toHaveAttribute("aria-pressed", "false");
  await files.click();
  await expect(content(page, "files")).toBeVisible();
  await expect(files).toHaveAttribute("aria-pressed", "true");
});

test("the layout survives a reload", async ({ page }) => {
  const before = await savedLayout(page);
  const target = await box(group(page, "timeline").locator(".dv-tabs-container"));
  await dragTab(page, "properties", target.x + target.width / 2, target.y + target.height / 2);
  await waitForSave(page, before);
  await page.reload();
  await expect(group(page, "timeline").locator('[data-tab="properties"]')).toBeVisible();
});

test("the layout fits a different window size", async ({ page }) => {
  const before = await savedLayout(page);
  await tab(page, "chat").click({ button: "middle" });
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

test("every workspace keeps its own arrangement", async ({ page }) => {
  await tab(page, "chat").click({ button: "middle" });
  await page.getByRole("button", { name: "动画", exact: true }).click();
  await expect(tab(page, "keyframes")).toBeVisible();
  await expect(group(page, "keyframes").locator('[data-tab="timeline"]')).toHaveCount(0);
  await page.getByRole("button", { name: "剪辑", exact: true }).click();
  await expect(tab(page, "timeline")).toBeVisible();
  await expect(tab(page, "chat")).toHaveCount(0);
});

test("reset brings back the design of the current workspace only", async ({ page }) => {
  await tab(page, "chat").click({ button: "middle" });
  await page.getByRole("button", { name: "动画", exact: true }).click();
  await tab(page, "keyframes").click({ button: "middle" });
  await chooseFromView(page, "恢复当前工作区的默认布局");
  await expect(tab(page, "keyframes")).toBeVisible();
  await page.getByRole("button", { name: "剪辑", exact: true }).click();
  await expect(tab(page, "timeline")).toBeVisible();
  await expect(tab(page, "chat")).toHaveCount(0);
});

test("closing everything leaves a way back", async ({ page }) => {
  for (const type of ["assets", "files", "preview", "properties", "chat"]) {
    await tab(page, type).click({ button: "middle" });
  }
  for (const type of ["timeline", "problems", "terminal"]) {
    await tab(page, type).click({ button: "middle" });
  }
  await expect(page.getByText("所有选项卡都关闭了")).toBeVisible();
  await page.getByRole("button", { name: "恢复默认布局" }).click();
  await expect(tab(page, "preview")).toBeVisible();
});

test("panels of every area find their place in an empty dock", async ({ page }) => {
  for (const type of ["assets", "files", "preview", "properties", "chat"]) {
    await tab(page, type).click({ button: "middle" });
  }
  for (const type of ["timeline", "problems", "terminal"]) {
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
  await expect(page.getByRole("tab", { name: "素材库" })).toBeVisible();
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
    const states = { edit: { grid: { root: { type: "nonsense" } }, panels: {} } };
    localStorage.setItem(key, JSON.stringify({ version: 1, workspace: "edit", states }));
  }, LAYOUT_KEY);
  await page.reload();
  await expect(tab(page, "preview")).toBeVisible();
  await expect(page.getByText("上次的布局无法恢复，已换成默认布局。")).toBeVisible();
});

test("a panel from another version shows a message instead of breaking", async ({ page }) => {
  const before = await savedLayout(page);
  await tab(page, "chat").click({ button: "middle" });
  await waitForSave(page, before);
  await page.evaluate((key) => {
    const text = localStorage.getItem(key) ?? "";
    localStorage.setItem(key, text.replaceAll('"type":"properties"', '"type":"from.the.future"'));
  }, LAYOUT_KEY);
  await page.reload();
  await expect(page.getByText("不可用", { exact: true })).toBeVisible();
  await expect(tab(page, "preview")).toBeVisible();
});

test("a crash stays inside its tab and can be retried", async ({ page, problems }) => {
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

test("a panel that must stay alive is not reloaded by dragging", async ({ page }) => {
  await chooseFromView(page, "内嵌页面");
  const loads = content(page, "dev.frame").locator("p");
  await expect(loads).toHaveText("加载次数：1");

  const target = await box(group(page, "timeline").locator(".dv-tabs-container"));
  await dragTab(page, "dev.frame", target.x + target.width / 2, target.y + target.height / 2);
  await expect(group(page, "timeline").locator('[data-tab="dev.frame"]')).toBeVisible();

  const edge = await box(group(page, "preview"));
  await dragTab(page, "dev.frame", edge.x + edge.width - 12, edge.y + edge.height / 2);
  await expect(group(page, "dev.frame").locator('[data-tab="preview"]')).toHaveCount(0);

  await page.waitForTimeout(300);
  await expect(loads).toHaveText("加载次数：1");
});

test("a panel shared by two workspaces is not rebuilt when switching", async ({ page }) => {
  await content(page, "preview").evaluate((element: HTMLElement) => {
    element.dataset["marker"] = "kept";
  });
  await page.getByRole("button", { name: "动画", exact: true }).click();
  await expect(tab(page, "keyframes")).toBeVisible();
  await expect(content(page, "preview")).toHaveAttribute("data-marker", "kept");
});

test("panels do not scroll when their content fits", async ({ page }) => {
  for (const name of ["剪辑", "动画", "音频", "AI"]) {
    await page.getByRole("button", { name, exact: true }).click();
    await expect(page.getByRole("button", { name, exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
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
}

test("the active tab is not hidden in a narrow group", async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 620 });
  await chooseFromView(page, "经验库");
  await expectTabInView(page, "notes");
  await chooseFromView(page, "历史记录");
  await expectTabInView(page, "history");
  await chooseFromView(page, "文件");
  await expectTabInView(page, "files");
  await chooseFromView(page, "历史记录");
  await expectTabInView(page, "history");
});

test("the active tab stays in view when the strip first runs out of room", async ({ page }) => {
  await chooseFromView(page, "经验库");
  await expectTabInView(page, "notes");
});

test("a tab dragged into a full strip is in view", async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 620 });
  // In the middle, because near the ends the strip scrolls by itself during a drag.
  const strip = await box(group(page, "assets").locator(".dv-tabs-container"));
  await dragTab(page, "properties", strip.x + strip.width / 2, strip.y + strip.height / 2);
  await expect(group(page, "assets").locator('[data-tab="properties"]')).toBeVisible();
  await expectTabInView(page, "properties");
});

test("the wheel scrolls a tab strip that is full", async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 620 });
  const list = group(page, "assets").locator(".dv-tabs-container");
  const strip = await box(list);
  await page.mouse.move(strip.x + 40, strip.y + strip.height / 2);
  await page.mouse.wheel(0, 120);
  await expect
    .poll(() => list.evaluate((element: HTMLElement) => element.scrollLeft))
    .toBeGreaterThan(0);
});

test("a tab strip that is full shows no scrollbar", async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 620 });
  const list = group(page, "assets").locator(".dv-tabs-container");
  const height = await list.evaluate(
    (element: HTMLElement) => element.offsetHeight - element.clientHeight,
  );
  expect(height).toBe(0);
});

test("the view menu works from the keyboard", async ({ page }) => {
  const trigger = page.getByRole("button", { name: "视图" });
  await trigger.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("menu")).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "动画", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(trigger).toBeFocused();
  await trigger.press("Enter");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
});

test("clicking elsewhere closes the view menu", async ({ page }) => {
  await page.getByRole("button", { name: "视图" }).click();
  await content(page, "timeline").click();
  await expect(page.getByRole("menu")).toHaveCount(0);
});
