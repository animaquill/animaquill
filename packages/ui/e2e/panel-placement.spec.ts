import type { Locator, Page } from "@playwright/test";
import { addAnthropic, closeSettings } from "./ai-support.ts";
import { content, expect, group, tab, test } from "./support.ts";

// Where panels go from the view menu, and what the menu says about them: section 11 of
// docs/design/settings-and-properties.md of AnimaQuill Cloud. The numbers are the rows of 11.5.

const viewMenu = (page: Page) => page.getByRole("menu", { name: "视图" });
const viewItem = (page: Page, name: string) =>
  viewMenu(page).getByRole("menuitem", { name, exact: true });

async function chooseFromView(page: Page, name: string) {
  await page.getByRole("button", { name: "视图", exact: true }).click();
  await viewItem(page, name).click();
  await expect(viewMenu(page)).toHaveCount(0);
}

async function close(page: Page, ...types: string[]) {
  for (const type of types) {
    await tab(page, type).click({ button: "middle" });
    await expect(tab(page, type)).toHaveCount(0);
  }
}

async function box(locator: Locator) {
  const value = await locator.boundingBox();
  if (!value) throw new Error("Element has no box");
  return value;
}

/** The layout of the first rows of the table: preview; files, assets; timeline, keyframes; properties, chat. */
async function tableLayout(page: Page) {
  await close(page, "code", "explorer", "transitions", "effects", "problems");
  await expect(group(page, "files").locator("[data-tab]")).toHaveCount(2);
  await expect(group(page, "timeline").locator("[data-tab]")).toHaveCount(2);
  await expect(group(page, "properties").locator("[data-tab]")).toHaveCount(2);
}

test("the view menu ticks the panels that are open, and says so", async ({ page }) => {
  await page.getByRole("button", { name: "视图", exact: true }).click();
  // Behind another tab is open too.
  for (const name of ["预览", "资源", "聊天"]) {
    await expect(viewItem(page, name)).toHaveAccessibleDescription("已打开");
    await expect(viewItem(page, name).locator("svg")).toHaveCount(1);
  }
  await expect(viewItem(page, "运行情况")).not.toHaveAccessibleDescription("已打开");
  await expect(viewItem(page, "运行情况").locator("svg")).toHaveCount(0);
  // What is still to come is not there to choose.
  for (const name of [
    "音乐",
    "录音",
    "版本矩阵",
    "历史记录",
    "经验库",
    "批注",
    "差异列表",
    "终端",
    "缓存",
  ]) {
    await expect(viewItem(page, name)).toHaveCount(0);
  }
  // Only says how things are: it is no checkbox.
  await expect(viewMenu(page).getByRole("menuitemcheckbox")).toHaveCount(0);
  await page.keyboard.press("Escape");

  await close(page, "preview");
  await page.getByRole("button", { name: "视图", exact: true }).click();
  await expect(viewItem(page, "预览")).not.toHaveAccessibleDescription("已打开");
  await viewItem(page, "运行情况").click();
  await page.getByRole("button", { name: "视图", exact: true }).click();
  await expect(viewItem(page, "运行情况")).toHaveAccessibleDescription("已打开");
});

test("the view menu ends with the settings and the keys", async ({ page }) => {
  await page.getByRole("button", { name: "视图", exact: true }).click();
  await expect(viewMenu(page).getByRole("menuitem").last()).toHaveText("快捷键…");
  await viewItem(page, "快捷键…").click();
  await expect(page.getByTestId("settings-keys")).toBeVisible();
});

test("14: a ticked panel behind another tab comes to the front with the keyboard in it", async ({
  page,
}) => {
  // With a service, the chat has its box to put the keyboard in.
  await addAnthropic(page, "sk-ant-test-0123456789abcdefSECRET", "claude-test");
  await closeSettings(page);
  await tab(page, "properties").click();
  await expect(content(page, "chat")).toBeHidden();
  await chooseFromView(page, "聊天");
  await expect(tab(page, "chat")).toHaveCount(1);
  await expect(content(page, "chat")).toBeVisible();
  await expect(group(page, "properties").locator('[data-tab="chat"]')).toHaveCount(1);
  await expect(page.getByTestId("chat-input")).toBeFocused();
  // Again, while it is in front: still there, still focused.
  await tab(page, "properties").click();
  await chooseFromView(page, "聊天");
  await chooseFromView(page, "聊天");
  await expect(content(page, "chat")).toBeVisible();
  await expect(page.getByTestId("chat-input")).toBeFocused();
});

test("1: effects go into the group of the preview, the only large one", async ({ page }) => {
  await tableLayout(page);
  await chooseFromView(page, "效果");
  await expect(group(page, "preview").locator('[data-tab="effects"]')).toHaveCount(1);
  await expect(content(page, "effects")).toBeVisible();
});

test("2: explorer goes into the tall group used last", async ({ page }) => {
  await tableLayout(page);
  await tab(page, "files").click();
  await tab(page, "chat").click();
  await chooseFromView(page, "资源管理器");
  await expect(group(page, "chat").locator('[data-tab="explorer"]')).toHaveCount(1);
  await expect(content(page, "explorer")).toBeVisible();
  // And the other way round, which is row 3.
  await close(page, "explorer");
  await tab(page, "files").click();
  await chooseFromView(page, "资源管理器");
  await expect(group(page, "files").locator('[data-tab="explorer"]')).toHaveCount(1);
});

test("7: without a group below, the timeline opens a new one there", async ({ page }) => {
  await close(page, "timeline", "keyframes", "problems");
  await chooseFromView(page, "时间轴");
  const timeline = await box(group(page, "timeline"));
  const preview = await box(group(page, "preview"));
  const files = await box(group(page, "files"));
  expect(timeline.y).toBeGreaterThanOrEqual(preview.y + preview.height - 1);
  expect(timeline.y).toBeGreaterThanOrEqual(files.y + files.height - 1);
  await expect(group(page, "timeline").locator("[data-tab]")).toHaveCount(1);
});

test("8: assets go to the preview, also when the chat shares its group", async ({ page }) => {
  await close(page, "code", "assets", "transitions", "effects");
  // The chat into the group of the preview.
  const strip = await box(group(page, "preview").locator(".dv-tabs-container"));
  const from = await box(tab(page, "chat"));
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + 10, from.y + 10, { steps: 3 });
  await page.mouse.move(strip.x + strip.width / 2 + 5, strip.y + strip.height / 2 + 5, {
    steps: 10,
  });
  await page.mouse.up();
  await expect(group(page, "preview").locator('[data-tab="chat"]')).toHaveCount(1);

  await chooseFromView(page, "素材");
  await expect(group(page, "preview").locator('[data-tab="assets"]')).toHaveCount(1);
  await expect(content(page, "assets")).toBeVisible();
});

test("12: code opens in a column of its own to the right of the preview", async ({ page }) => {
  await close(page, "code");
  await chooseFromView(page, "资源");
  await expect(group(page, "preview").locator('[data-tab="code"]')).toHaveCount(0);
  const preview = await box(group(page, "preview"));
  const code = await box(group(page, "code"));
  expect(code.x).toBeGreaterThanOrEqual(preview.x + preview.width - 1);
  await expect(content(page, "preview")).toBeVisible();
  await expect(content(page, "code")).toBeVisible();
});
