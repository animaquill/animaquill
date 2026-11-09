import type { Locator, Page } from "@playwright/test";
import { chooseLayout, content, expect, group, layoutMenu, tab, test } from "./support.ts";

const LAYOUT_KEY = "animaquill.layout";

async function box(locator: Locator) {
  const value = await locator.boundingBox();
  if (!value) throw new Error("Element has no box");
  return value;
}

const menuItem = (page: Page, name: string) =>
  page.getByRole("menu").getByRole("menuitem", { name, exact: true });

async function fromLayoutMenu(page: Page, current: string, item: string) {
  await layoutMenu(page, current).click();
  await menuItem(page, item).click();
}

async function saveAs(page: Page, current: string, name: string) {
  await fromLayoutMenu(page, current, "另存为新布局…");
  const input = page.getByRole("textbox", { name: "另存为新布局" });
  await input.fill(name);
  await page.keyboard.press("Enter");
  await expect(layoutMenu(page, name)).toBeVisible();
}

const savedLayout = async (page: Page) =>
  (await page.evaluate((key) => localStorage.getItem(key), LAYOUT_KEY)) ?? "";

async function waitForSave(page: Page, before: string) {
  await expect.poll(() => savedLayout(page)).not.toBe(before);
}

test.describe("the layouts that come with the editor", () => {
  test("editing: names down the left and right, the preview in the middle", async ({ page }) => {
    await expect(page.locator(".dv-groupview")).toHaveCount(4);
    const assets = await box(content(page, "assets"));
    expect((await box(tab(page, "files"))).x).toBeLessThan(assets.x);
    await expect(group(page, "preview").locator('[data-tab="code"]')).toBeVisible();
    const properties = await box(content(page, "properties"));
    expect((await box(tab(page, "properties"))).x).toBeGreaterThanOrEqual(
      properties.x + properties.width - 1,
    );
    const below = group(page, "timeline");
    for (const type of ["keyframes", "problems"]) {
      await expect(below.locator(`[data-tab="${type}"]`)).toBeVisible();
    }
    await expect(content(page, "timeline")).toBeVisible();
  });

  test("animation: the preview and the code side by side, keyframes below", async ({ page }) => {
    const editBelow = await box(group(page, "timeline"));
    await chooseLayout(page, "动画");
    const preview = await box(content(page, "preview"));
    const code = await box(content(page, "code"));
    expect(code.x).toBeGreaterThanOrEqual(preview.x + preview.width - 1);
    expect(Math.abs(code.y - preview.y)).toBeLessThan(2);
    await expect(content(page, "keyframes")).toBeVisible();
    await expect(group(page, "keyframes").locator('[data-tab="timeline"]')).toBeVisible();
    expect((await box(group(page, "keyframes"))).height).toBeGreaterThan(editBelow.height + 40);
  });

  test("audio: the preview in the middle, the timeline below", async ({ page }) => {
    await chooseLayout(page, "音频");
    await expect(content(page, "preview")).toBeVisible();
    await expect(content(page, "assets")).toBeVisible();
    await expect(group(page, "timeline").locator('[data-tab="problems"]')).toBeVisible();
    await expect(tab(page, "keyframes")).toHaveCount(0);
  });

  test("AI: all the way down the right, as icons", async ({ page }) => {
    await chooseLayout(page, "AI");
    const dock = await box(page.locator(".dv-dockview"));
    const right = await box(group(page, "properties"));
    expect(right.y).toBeLessThan(dock.y + 2);
    expect(right.height).toBeGreaterThan(dock.height - 2);
    expect(right.x + right.width).toBeGreaterThan(dock.x + dock.width - 2);
    await page.mouse.move(dock.x + 300, dock.y + 300);
    await expect.poll(async () => (await box(tab(page, "properties"))).width).toBeLessThan(50);
    await expect(group(page, "timeline").locator('[data-tab="keyframes"]')).toBeVisible();
  });
});

test.describe("layouts of one's own", () => {
  test("are saved, change, switch, get renamed, reset and deleted", async ({ page }) => {
    await saveAs(page, "剪辑", "我的剪辑");
    // Changes are kept without asking.
    await tab(page, "assets").click({ button: "middle" });
    await chooseLayout(page, "剪辑");
    await expect(tab(page, "assets")).toBeVisible();
    await chooseLayout(page, "我的剪辑");
    await expect(tab(page, "assets")).toHaveCount(0);

    await fromLayoutMenu(page, "我的剪辑", "重命名…");
    const input = page.getByRole("textbox", { name: "重命名布局" });
    await expect(input).toHaveValue("我的剪辑");
    await input.fill("讲解视频");
    await page.keyboard.press("Enter");
    await expect(layoutMenu(page, "讲解视频")).toBeVisible();

    // Back to how it was saved.
    await fromLayoutMenu(page, "讲解视频", "恢复这个布局的默认样子");
    await expect(tab(page, "assets")).toBeVisible();

    await fromLayoutMenu(page, "讲解视频", "删除");
    const dialog = page.getByRole("dialog", { name: "删除布局“讲解视频”？" });
    await expect(dialog.getByRole("button", { name: "取消" })).toBeFocused();
    await dialog.getByRole("button", { name: "删除" }).click();
    await expect(layoutMenu(page, "剪辑")).toBeVisible();
    await layoutMenu(page, "剪辑").click();
    await expect(page.getByRole("menuitemradio", { name: "讲解视频" })).toHaveCount(0);
  });

  test("are listed after the presets, and only they can be renamed and deleted", async ({
    page,
  }) => {
    await layoutMenu(page, "剪辑").click();
    await expect(menuItem(page, "重命名…")).toBeDisabled();
    await expect(menuItem(page, "删除")).toBeDisabled();
    await page.keyboard.press("Escape");

    await saveAs(page, "剪辑", "我的");
    await layoutMenu(page, "我的").click();
    const names = await page.getByRole("menuitemradio").allTextContents();
    expect(names.map((name) => name.replace(/Alt.*$/, ""))).toEqual([
      "剪辑",
      "动画",
      "音频",
      "AI",
      "我的",
    ]);
    await expect(page.getByRole("menuitemradio", { name: /^我的/ })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await expect(menuItem(page, "重命名…")).toBeEnabled();
    await expect(menuItem(page, "删除")).toBeEnabled();
  });

  test("switch with Alt+Shift and their number, and the palette finds them", async ({ page }) => {
    await saveAs(page, "剪辑", "调色专用");
    await page.keyboard.press("Alt+Shift+Digit2");
    await expect(layoutMenu(page, "动画")).toBeVisible();
    await page.keyboard.press("Alt+Shift+Digit5");
    await expect(layoutMenu(page, "调色专用")).toBeVisible();
    await page.keyboard.press("Alt+Shift+Digit1");
    await expect(layoutMenu(page, "剪辑")).toBeVisible();

    await page.keyboard.press("Control+Shift+KeyP");
    await page.getByRole("combobox", { name: "命令面板" }).fill("调色");
    await expect(page.getByRole("option").first()).toContainText("切换布局：调色专用");
    await expect(page.getByRole("option").first().locator("kbd")).toHaveText("Alt+Shift+5");
    await page.keyboard.press("Enter");
    await expect(layoutMenu(page, "调色专用")).toBeVisible();
  });

  test("keep the preview and the code alive when switching", async ({ page }) => {
    await saveAs(page, "剪辑", "我的");
    for (const type of ["preview", "code"]) {
      await content(page, type).evaluate((element: HTMLElement) => {
        element.dataset["marker"] = "kept";
      });
    }
    // Audio has no code, so that one has to start again there.
    for (const name of ["动画", "AI", "我的", "剪辑"]) await chooseLayout(page, name);
    await chooseLayout(page, "动画");
    for (const type of ["preview", "code"]) {
      await expect(content(page, type)).toHaveAttribute("data-marker", "kept");
    }
  });

  test("are the same in every window", async ({ page }) => {
    const other = await page.context().newPage();
    await other.goto(page.url());
    await expect(tab(other, "preview")).toBeVisible();

    await saveAs(page, "剪辑", "共用的");
    await layoutMenu(other, "剪辑").click();
    await expect(other.getByRole("menuitemradio", { name: "共用的" })).toBeVisible();
    await other.getByRole("menuitemradio", { name: "共用的" }).click();
    await expect(layoutMenu(other, "共用的")).toBeVisible();

    await fromLayoutMenu(page, "共用的", "重命名…");
    await page.getByRole("textbox", { name: "重命名布局" }).fill("改了名的");
    await page.keyboard.press("Enter");
    await expect(layoutMenu(other, "改了名的")).toBeVisible();

    // The other window goes back to the first preset when its layout is deleted.
    await fromLayoutMenu(page, "改了名的", "删除");
    await page.getByRole("dialog").getByRole("button", { name: "删除" }).click();
    await expect(layoutMenu(other, "剪辑")).toBeVisible();
    await expect(tab(other, "preview")).toBeVisible();

    // And does not bring it back with its next change.
    const before = await savedLayout(other);
    await tab(other, "code").click({ button: "middle" });
    await waitForSave(other, before);
    expect(await savedLayout(other)).not.toContain("改了名的");
  });
});

test("the workspaces of before are dropped without a word", async ({ page }) => {
  await page.evaluate((key) => {
    const states = { edit: { grid: {}, panels: {} } };
    localStorage.setItem(key, JSON.stringify({ version: 1, workspace: "animate", states }));
  }, LAYOUT_KEY);
  await page.reload();
  await expect(tab(page, "preview")).toBeVisible();
  await expect(layoutMenu(page, "剪辑")).toBeVisible();
  await page.waitForTimeout(300);
  await expect(page.getByText("上次的布局无法恢复，已换成默认布局。")).toHaveCount(0);
});
