import type { Page } from "@playwright/test";
import { addAnthropic, closeSettings, goToSettingsGroup, settingsOf } from "./ai-support.ts";
import { chooseLayout, createProject, devPageOnly, expect, tab, test } from "./support.ts";

/**
 * The settings, a dialog over the editor or the start page (docs/design/settings-and-properties.md
 * of AnimaQuill Cloud, 4 and step S-A): every way to open them, Esc, searching across the groups,
 * a narrow window one level at a time, saved layouts with the tabs they used to be, and two windows.
 */

const KEY = "sk-ant-test-0123456789abcdefSECRET";
const LAYOUT_KEY = "animaquill.layout";
/** Where the pictures go besides the output of the test, where it is said. */
const SHOTS = process.env["AQ_SHOTS"];
const header = (page: Page) => page.locator("header");
const groups = (page: Page) => settingsOf(page).getByRole("navigation", { name: "设置分组" });
const current = (page: Page) => groups(page).locator('[aria-current="page"]');

async function chooseFrom(page: Page, menu: string, item: string) {
  await header(page).getByRole("button", { name: menu, exact: true }).click();
  await page.getByRole("menu").getByRole("menuitem", { name: item, exact: true }).click();
}

async function palette(page: Page, text: string) {
  await page.keyboard.press("Control+Shift+KeyP");
  await page.getByRole("combobox", { name: "命令面板" }).fill(text);
  await page.keyboard.press("Enter");
}

/** Opened, then closed with Esc: nothing behind it changed. */
async function opensAndCloses(page: Page, open: () => Promise<void>, group = "常规") {
  await open();
  await expect(settingsOf(page)).toBeVisible();
  await expect(current(page)).toHaveText(group);
  await page.keyboard.press("Escape");
  await expect(settingsOf(page)).toBeHidden();
}

test("opens in every way the editor has, at the group it was in, and Esc closes it", async ({
  page,
}) => {
  await opensAndCloses(page, () => page.keyboard.press("Control+Comma"));
  await opensAndCloses(page, () => header(page).getByRole("button", { name: "设置" }).click());
  await opensAndCloses(page, () => chooseFrom(page, "文件", "设置…"));
  await opensAndCloses(page, () => palette(page, "设置"));
  // A group by its name, and the next time it opens there.
  await opensAndCloses(page, () => palette(page, "设置：AI 模型"), "AI 模型");
  await opensAndCloses(page, () => page.keyboard.press("Control+Comma"), "AI 模型");
  // "关于" of the help menu is the group of the settings.
  await opensAndCloses(page, () => chooseFrom(page, "帮助", "关于 AnimaQuill"), "关于");
  // A click on the dim around it closes it too, unless something typed did not go in yet.
  await page.keyboard.press("Control+Comma");
  await goToSettingsGroup(page, "AI 聊天");
  const limit = settingsOf(page).getByRole("textbox", { name: "一次任务最多调用工具" });
  await limit.fill("12");
  await page.mouse.click(5, 300);
  await expect(settingsOf(page)).toBeVisible();
  await expect(limit).toHaveValue("12");
  await limit.press("Enter");
  await page.mouse.click(5, 300);
  await expect(settingsOf(page)).toBeHidden();
  // While the settings are open, keys are theirs: the editor behind did not get them.
  await page.keyboard.press("Control+Comma");
  await page.keyboard.press("Control+Shift+KeyP");
  await expect(page.getByRole("combobox", { name: "命令面板" })).toHaveCount(0);
  await page.keyboard.press("Escape");
});

test.describe("with an account", () => {
  devPageOnly("a fake account with ?account=fake");
  test.use({ withProject: false });

  test("opens on the start page: the side bar, the title bar and its key; the account menu", async ({
    page,
  }) => {
    await page.goto("/?account=fake");
    const settingsButton = page.getByTestId("start-settings");
    await expect(settingsButton).toBeVisible();
    await opensAndCloses(page, () => settingsButton.click());
    await opensAndCloses(page, () => header(page).getByRole("button", { name: "设置" }).click());
    await opensAndCloses(page, () => page.keyboard.press("Control+Comma"));
    // Signed out: the group of the account says what signing in brings, and signs in.
    await page.keyboard.press("Control+Comma");
    await goToSettingsGroup(page, "账号");
    const account = settingsOf(page).getByTestId("settings-sign-in");
    await expect(account).toContainText("登录以后多了这些");
    await expect(settingsOf(page).getByText("这台设备", { exact: true })).toHaveCount(0);
    await account.getByRole("button", { name: "登录" }).click();
    const menu = header(page).getByRole("button", { name: "账号：octo" });
    await expect(menu).toBeVisible();
    // Signed in: from the account menu, at the account; and where each setting is kept.
    await opensAndCloses(
      page,
      async () => {
        await menu.click();
        await page.getByRole("menuitem", { name: "设置…" }).click();
      },
      "账号",
    );
    await page.keyboard.press("Control+Comma");
    await expect(settingsOf(page).getByTestId("settings-account")).toContainText("octo");
    await goToSettingsGroup(page, "常规");
    await expect(
      settingsOf(page).locator('[data-setting="general.input"] [data-where="device"]'),
    ).toHaveText("这台设备");
  });
});

test("Ctrl+, is a key like any other: it can be changed", async ({ page }) => {
  await page.keyboard.press("Control+Comma");
  await goToSettingsGroup(page, "快捷键");
  const keys = settingsOf(page).getByTestId("settings-keys");
  const row = keys.locator('[data-action="settings.open"]');
  await expect(row.locator("kbd")).toHaveText("Ctrl+,");
  await row.getByRole("button", { name: "删除快捷键 Ctrl+," }).click();
  await row.getByRole("button", { name: /^添加快捷键/ }).click();
  await page.keyboard.press("Control+Alt+KeyO");
  await expect(row.locator("kbd")).toHaveText("Ctrl+Alt+O");
  await closeSettings(page);
  await page.keyboard.press("Control+Comma");
  await expect(settingsOf(page)).toBeHidden();
  await page.keyboard.press("Control+Alt+KeyO");
  await expect(settingsOf(page)).toBeVisible();
});

test("searching finds a setting in any group, goes there and makes it stand out", async ({
  page,
}) => {
  await page.keyboard.press("Control+Comma");
  const search = settingsOf(page).getByRole("searchbox", { name: "搜索设置" });
  await search.fill("key");
  const results = settingsOf(page).getByTestId("settings-result");
  await expect(results.first()).toContainText("AI 模型 › AI 服务和 key");
  await expect(results.filter({ hasText: "存储和数据 › 这台设备上的 key" })).toHaveCount(1);
  await results.first().click();
  await expect(current(page)).toHaveText("AI 模型");
  await expect(settingsOf(page).getByTestId("ai-models")).toBeVisible();

  await search.fill("显卡");
  await expect(results).toHaveCount(1);
  await results.click();
  await expect(current(page)).toHaveText("导出");
  const row = settingsOf(page).locator('[data-setting="export.hardware"]');
  await expect(row).toHaveAttribute("data-flash", "");
  await expect(row).not.toHaveAttribute("data-flash");

  await search.fill("没有这种设置");
  await expect(settingsOf(page).getByText("没有和“没有这种设置”有关的设置。")).toBeVisible();
  // Esc empties the search first, then closes.
  await search.press("Escape");
  await expect(search).toHaveValue("");
  await expect(settingsOf(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(settingsOf(page)).toBeHidden();
});

test("narrow: the groups, a group, and back, also with the browser's back", async ({ page }) => {
  await page.setViewportSize({ width: 420, height: 800 });
  await page.keyboard.press("Control+Comma");
  const settings = settingsOf(page);
  await expect(settings).toHaveAttribute("data-narrow", "");
  // Where they were: the first group, with the way up to the groups.
  await expect(groups(page)).toBeHidden();
  await expect(settings.getByTestId("settings-general")).toBeVisible();
  await settings.getByTestId("settings-back").click();
  await expect(groups(page)).toBeVisible();
  await groups(page).getByRole("button", { name: "导出", exact: true }).click();
  await expect(settings.getByTestId("settings-export")).toBeVisible();
  await page.goBack();
  await expect(groups(page)).toBeVisible();
  await groups(page).getByRole("button", { name: "存储和数据", exact: true }).click();
  await expect(settings.getByTestId("settings-storage")).toBeVisible();
  await page.goBack();
  await page.goBack();
  await expect(settings).toBeHidden();
  await expect(tab(page, "preview")).toBeAttached();
  // Closed in a group: the history it took goes with it.
  await page.keyboard.press("Control+Comma");
  await expect(settings.getByTestId("settings-storage")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(settings).toBeHidden();
  await expect(page).toHaveURL(/./);
});

test("a saved layout with the tabs of settings and keys opens without them, the rest as it was", async ({
  page,
  problems,
}) => {
  await chooseLayout(page, "动画");
  await chooseLayout(page, "剪辑");
  await expect
    .poll(() => page.evaluate((key) => localStorage.getItem(key), LAYOUT_KEY))
    .toContain('"edit"');
  const before = await page.evaluate((key) => {
    const saved = JSON.parse(localStorage.getItem(key)!);
    const { dockview } = saved.states.edit.dock;
    // As 0.3.62 kept it: both tabs in the group of the preview, one of them in front.
    const find = (node: { type: string; data: unknown }): { views: string[] } | undefined => {
      if (node.type === "leaf") {
        const data = node.data as { views: string[]; activeView?: string };
        return data.views.includes("preview") ? data : undefined;
      }
      for (const child of node.data as { type: string; data: unknown }[]) {
        const found = find(child);
        if (found) return found;
      }
      return undefined;
    };
    const leaf = find(dockview.grid.root) as { views: string[]; activeView?: string };
    const retired: readonly (readonly [string, string])[] = [
      ["settings", "设置"],
      ["keybindings", "快捷键"],
    ];
    for (const [id, title] of retired) {
      dockview.panels[id] = {
        id,
        contentComponent: "panel",
        params: { type: id },
        title,
      };
      leaf.views.push(id);
    }
    leaf.activeView = "settings";
    localStorage.setItem(key, JSON.stringify(saved));
    return Object.keys(dockview.panels).filter((id) => id !== "settings" && id !== "keybindings");
  }, LAYOUT_KEY);
  await page.reload();
  await expect(tab(page, "preview")).toBeVisible();
  for (const id of before) await expect(tab(page, id)).toBeAttached();
  await expect(tab(page, "settings")).toHaveCount(0);
  await expect(tab(page, "keybindings")).toHaveCount(0);
  await expect(page.getByText("不可用")).toHaveCount(0);
  await expect(page.getByText("上次的布局无法恢复")).toHaveCount(0);
  expect(problems).toEqual([]);
});

test("two windows: what one changes, the other shows", async ({ page }) => {
  const other = await page.context().newPage();
  await other.goto(page.url());
  await expect(tab(other, "preview")).toBeVisible();
  for (const each of [page, other]) await each.keyboard.press("Control+Comma");
  const input = (where: Page) =>
    settingsOf(where).getByRole("combobox", { name: "输入设备", exact: true });
  await input(page).selectOption({ label: "触控板" });
  await expect(input(other)).toHaveValue("trackpad");
  await goToSettingsGroup(other, "预览和播放");
  await goToSettingsGroup(page, "预览和播放");
  const offer = (where: Page) =>
    settingsOf(where).getByRole("switch", { name: "卡顿时提示生成代理文件" });
  await expect(offer(page)).toBeChecked();
  await offer(other).uncheck();
  await expect(offer(page)).not.toBeChecked();
  // The status bar has the same value as the settings.
  await closeSettings(page);
  await expect(page.getByRole("button", { name: /输入方式/ })).toContainText("触控板");
  await other.close();
});

test.describe("pictures of every group", () => {
  test.use({ withProject: false, viewport: { width: 1440, height: 900 } });
  devPageOnly("a fake account with ?account=fake");

  test("1440 wide, each group; 390 wide, the general one and AI models; on the start page", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const save = async (name: string) => {
      await page.screenshot({ path: test.info().outputPath(`${name}.png`) });
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` });
    };
    await page.goto("/?account=fake");
    await page.getByTestId("start-settings").click();
    await save("start-page");
    await page.keyboard.press("Escape");
    await createProject(page);
    await addAnthropic(page, KEY, "claude-test");
    for (const name of [
      "常规",
      "编辑",
      "预览和播放",
      "导出",
      "快捷键",
      "AI 模型",
      "模型适配包",
      "AI 聊天",
      "电脑上的 AI 工具",
      "账号",
      "存储和数据",
      "关于",
    ]) {
      await goToSettingsGroup(page, name);
      await expect(current(page)).toHaveText(name);
      await save(`1440-${name}`);
    }
    await settingsOf(page).getByRole("searchbox", { name: "搜索设置" }).fill("key");
    await save("1440-搜索");
    await settingsOf(page).getByRole("searchbox", { name: "搜索设置" }).fill("");
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(settingsOf(page)).toHaveAttribute("data-narrow", "");
    await goToSettingsGroup(page, "常规");
    await save("390-常规");
    await settingsOf(page).getByTestId("settings-back").click();
    await save("390-分组");
    await goToSettingsGroup(page, "AI 模型");
    await save("390-AI模型");
    await settingsOf(page).getByTestId("ai-service-item").click();
    await save("390-AI模型-服务");
  });
});
