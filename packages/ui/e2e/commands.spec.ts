import type { Page } from "@playwright/test";
import { content, expect, tab, test } from "./support.ts";

const KEYS_SETTING = "animaquill.keybindings";

const palette = (page: Page) => page.getByRole("dialog", { name: "命令面板" });
const input = (page: Page) => page.getByRole("combobox");
const options = (page: Page) => page.getByRole("option");
const active = (page: Page) => page.locator('[role="option"][aria-selected="true"]');
const workspace = (page: Page, name: string) => page.getByRole("button", { name, exact: true });
const row = (page: Page, id: string) => page.locator(`[data-action="${id}"]`);

async function openPalette(page: Page) {
  await page.keyboard.press("Control+Shift+KeyP");
  await expect(input(page)).toBeFocused();
}

async function runCommand(page: Page, text: string) {
  await openPalette(page);
  await input(page).fill(text);
  await page.keyboard.press("Enter");
  await expect(palette(page)).toHaveCount(0);
}

async function openShortcuts(page: Page) {
  await runCommand(page, "打开选项卡：快捷键");
  await expect(content(page, "keybindings")).toBeVisible();
}

async function startRecording(page: Page, id: string) {
  await row(page, id)
    .getByRole("button", { name: /^添加快捷键/ })
    .click();
  await expect(row(page, id).getByText("按下组合键，Esc 取消")).toBeVisible();
}

test.describe("command palette", () => {
  test("opens with both shortcuts and closes with Esc", async ({ page }) => {
    await page.keyboard.press("Control+Shift+KeyP");
    await expect(input(page)).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(palette(page)).toHaveCount(0);
    await page.keyboard.press("F1");
    await expect(input(page)).toBeFocused();
  });

  test("the same shortcut closes it again", async ({ page }) => {
    await openPalette(page);
    await page.keyboard.press("Control+Shift+KeyP");
    await expect(palette(page)).toHaveCount(0);
  });

  test("takes the shortcut away from the browser", async ({ page }) => {
    const prevented = await page.evaluate(
      () =>
        new Promise<boolean>((resolve) => {
          window.addEventListener("keydown", (event) => {
            setTimeout(() => resolve(event.defaultPrevented), 0);
          });
          window.dispatchEvent(
            new KeyboardEvent("keydown", {
              code: "KeyP",
              ctrlKey: true,
              shiftKey: true,
              cancelable: true,
            }),
          );
        }),
    );
    expect(prevented).toBe(true);
  });

  test("gives the focus back when it closes", async ({ page }) => {
    const trigger = page.getByRole("button", { name: "视图" });
    await trigger.focus();
    await openPalette(page);
    await page.keyboard.press("Escape");
    await expect(trigger).toBeFocused();
  });

  test("opens from the button in the title bar", async ({ page }) => {
    await page.locator("header").getByRole("button", { name: "命令面板" }).click();
    await expect(input(page)).toBeFocused();
  });

  test("opens from the view menu", async ({ page }) => {
    await page.getByRole("button", { name: "视图" }).click();
    await page.getByRole("menu").getByRole("menuitem", { name: "命令面板" }).click();
    await expect(palette(page)).toBeVisible();
    await expect(input(page)).toBeFocused();
  });

  test("closes the view menu when it opens", async ({ page }) => {
    await page.getByRole("button", { name: "视图" }).click();
    await expect(page.getByRole("menu")).toBeVisible();
    await page.keyboard.press("Control+Shift+KeyP");
    await expect(input(page)).toBeFocused();
    await expect(page.getByRole("menu")).toHaveCount(0);
  });

  test("closes when clicking outside", async ({ page }) => {
    await openPalette(page);
    await page.mouse.click(700, 700);
    await expect(palette(page)).toHaveCount(0);
  });

  test("finds a command and runs it with Enter", async ({ page }) => {
    await openPalette(page);
    await input(page).fill("关键帧");
    await expect(options(page)).toHaveCount(1);
    await page.keyboard.press("Enter");
    await expect(palette(page)).toHaveCount(0);
    await expect(content(page, "keyframes")).toBeVisible();
  });

  test("highlights what matched", async ({ page }) => {
    await openPalette(page);
    await input(page).fill("时间");
    await expect(active(page).locator("mark")).toHaveText("时间");
  });

  test("finds characters that are not next to each other", async ({ page }) => {
    await openPalette(page);
    await input(page).fill("时轴");
    await expect(active(page)).toContainText("打开选项卡：时间轴");
  });

  test("finds commands by their English name", async ({ page }) => {
    await openPalette(page);
    await input(page).fill("keyframes");
    await expect(active(page)).toContainText("关键帧");
  });

  test("says so when nothing matches, and Enter then does nothing", async ({ page }) => {
    await openPalette(page);
    await input(page).fill("没有这个命令");
    await expect(page.getByText("没有匹配的命令")).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(palette(page)).toBeVisible();
  });

  test("moves through the list with the arrow keys and wraps around", async ({ page }) => {
    await openPalette(page);
    const first = await active(page).textContent();
    await page.keyboard.press("ArrowDown");
    await expect(active(page)).not.toHaveText(first ?? "");
    await page.keyboard.press("ArrowUp");
    await expect(active(page)).toHaveText(first ?? "");
    await page.keyboard.press("ArrowUp");
    await expect(active(page)).toBeInViewport();
    await expect(options(page).last()).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("ArrowDown");
    await expect(active(page)).toHaveText(first ?? "");
  });

  test("runs a command with the mouse", async ({ page }) => {
    await openPalette(page);
    await input(page).fill("切换工作区");
    await options(page).filter({ hasText: "动画" }).click();
    await expect(workspace(page, "动画")).toHaveAttribute("aria-pressed", "true");
  });

  test("shows the shortcut of a command", async ({ page }) => {
    await openPalette(page);
    await input(page).fill("切换工作区：音频");
    await expect(active(page).locator("kbd")).toHaveText("Alt+3");
  });

  test("leaves Enter and Esc to the input method during composition", async ({ page }) => {
    await openPalette(page);
    await input(page).fill("时间");
    for (const key of ["Enter", "Escape"]) {
      await input(page).evaluate((element, name) => {
        element.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: name,
            code: name,
            bubbles: true,
            isComposing: true,
          }),
        );
      }, key);
    }
    await expect(palette(page)).toBeVisible();
    await expect(tab(page, "keyframes")).toHaveCount(0);
  });

  test("lists what was used recently first, also after a reload", async ({ page }) => {
    await runCommand(page, "关键帧");
    await runCommand(page, "切换工作区：音频");
    await page.reload();
    await expect(tab(page, "timeline")).toBeVisible();
    await openPalette(page);
    await expect(palette(page).getByText("最近使用")).toBeVisible();
    await expect(palette(page).getByText("其他命令")).toBeVisible();
    await expect(options(page).nth(0)).toContainText("音频");
    await expect(options(page).nth(1)).toContainText("关键帧");
  });

  test("does not offer itself", async ({ page }) => {
    await openPalette(page);
    await input(page).fill("命令面板");
    await expect(options(page)).toHaveCount(0);
  });
});

test.describe("shortcuts", () => {
  test("switch workspaces and open panels", async ({ page }) => {
    await page.keyboard.press("Alt+Digit2");
    await expect(workspace(page, "动画")).toHaveAttribute("aria-pressed", "true");
    await page.keyboard.press("Alt+Digit1");
    await expect(workspace(page, "剪辑")).toHaveAttribute("aria-pressed", "true");
    await page.keyboard.press("Control+Shift+KeyE");
    await expect(content(page, "files")).toBeVisible();
    await page.keyboard.press("Control+Shift+KeyM");
    await expect(content(page, "problems")).toBeVisible();
    await page.keyboard.press("Control+Backquote");
    await expect(content(page, "terminal")).toBeVisible();
  });

  test("appear in the view menu", async ({ page }) => {
    await page.getByRole("button", { name: "视图" }).click();
    const item = page.getByRole("menu").getByRole("menuitemradio", { name: "动画" });
    await expect(item).toContainText("Alt+2");
    await expect(item).toHaveAttribute("aria-keyshortcuts", "Alt+2");
  });

  test("a key can be added and works at once", async ({ page }) => {
    await openShortcuts(page);
    await startRecording(page, "view.workspace.animate");
    await page.keyboard.press("KeyJ");
    await expect(
      row(page, "view.workspace.animate").locator("kbd", { hasText: /^J$/ }),
    ).toBeVisible();
    await content(page, "keybindings").click({ position: { x: 5, y: 5 } });
    await page.keyboard.press("KeyJ");
    await expect(workspace(page, "动画")).toHaveAttribute("aria-pressed", "true");
  });

  test("a changed key shows in the menu and the palette", async ({ page }) => {
    await openShortcuts(page);
    await startRecording(page, "view.resetLayout");
    await page.keyboard.press("Control+Alt+KeyR");
    await page.getByRole("button", { name: "视图" }).click();
    await expect(
      page.getByRole("menu").getByRole("menuitem", { name: "恢复当前工作区的默认布局" }),
    ).toContainText("Ctrl+Alt+R");
  });

  test("a plain key does not fire while typing, a shortcut with modifiers does", async ({
    page,
  }) => {
    await openShortcuts(page);
    await startRecording(page, "view.workspace.animate");
    await page.keyboard.press("KeyJ");
    await openPalette(page);
    await page.keyboard.type("j");
    await expect(input(page)).toHaveValue("j");
    await expect(workspace(page, "剪辑")).toHaveAttribute("aria-pressed", "true");
    await page.keyboard.press("Alt+Digit3");
    await expect(workspace(page, "音频")).toHaveAttribute("aria-pressed", "true");
  });

  test("recording catches keys before anything else does", async ({ page }) => {
    await openShortcuts(page);
    await startRecording(page, "view.open.timeline");
    await page.keyboard.press("F1");
    await expect(palette(page)).toHaveCount(0);
    await expect(
      row(page, "view.open.timeline").getByText("F1 已被“命令面板”使用。"),
    ).toBeVisible();
  });

  test("modifiers alone do not end recording", async ({ page }) => {
    await openShortcuts(page);
    await startRecording(page, "view.open.timeline");
    await page.keyboard.down("Control");
    await page.keyboard.down("Shift");
    await page.keyboard.up("Shift");
    await page.keyboard.up("Control");
    await expect(row(page, "view.open.timeline").getByText("按下组合键，Esc 取消")).toBeVisible();
  });

  test("Esc cancels recording and the focus goes back to the button", async ({ page }) => {
    await openShortcuts(page);
    const id = "view.open.timeline";
    await startRecording(page, id);
    await page.keyboard.press("Escape");
    await expect(row(page, id).getByText("按下组合键，Esc 取消")).toHaveCount(0);
    await expect(row(page, id).getByRole("button", { name: /^添加快捷键/ })).toBeFocused();
    await expect(row(page, id).getByText("未设置")).toBeVisible();
  });

  test("clicking elsewhere cancels recording", async ({ page }) => {
    await openShortcuts(page);
    await startRecording(page, "view.open.timeline");
    await page.getByLabel("搜索命令或快捷键").click();
    await expect(page.getByText("按下组合键，Esc 取消")).toHaveCount(0);
  });

  test("a key in use has to be confirmed, and can be left where it is", async ({ page }) => {
    await openShortcuts(page);
    const id = "view.workspace.animate";
    await startRecording(page, id);
    await page.keyboard.press("Alt+Digit1");
    const warning = row(page, id).getByText("Alt+1 已被“切换工作区：剪辑”使用。");
    await expect(warning).toBeVisible();
    await row(page, id).getByRole("button", { name: "取消" }).click();
    await expect(warning).toHaveCount(0);
    await expect(row(page, "view.workspace.edit").locator("kbd")).toHaveText("Alt+1");
  });

  test("a key in use moves over when confirmed", async ({ page }) => {
    await openShortcuts(page);
    const id = "view.workspace.animate";
    await startRecording(page, id);
    await page.keyboard.press("Alt+Digit1");
    await row(page, id).getByRole("button", { name: "改用到这里" }).click();
    await expect(row(page, "view.workspace.edit").getByText("未设置")).toBeVisible();
    await content(page, "keybindings").click({ position: { x: 5, y: 5 } });
    await page.keyboard.press("Alt+Digit1");
    await expect(workspace(page, "动画")).toHaveAttribute("aria-pressed", "true");
  });

  test("Enter confirms moving a key", async ({ page }) => {
    await openShortcuts(page);
    const id = "view.workspace.animate";
    await startRecording(page, id);
    await page.keyboard.press("Alt+Digit1");
    await expect(row(page, id).getByRole("button", { name: "改用到这里" })).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(row(page, "view.workspace.edit").getByText("未设置")).toBeVisible();
  });

  test("the keys of keyboard navigation are refused", async ({ page }) => {
    await openShortcuts(page);
    const id = "view.open.timeline";
    await startRecording(page, id);
    await page.keyboard.press("Tab");
    await expect(row(page, id).getByText("Tab 要留给键盘导航，不能用作快捷键。")).toBeVisible();
    await page.keyboard.press("KeyJ");
    await expect(row(page, id).locator("kbd", { hasText: /^J$/ })).toBeVisible();
  });

  test("a key can be removed and the default restored", async ({ page }) => {
    await openShortcuts(page);
    const id = "view.workspace.edit";
    await row(page, id).getByRole("button", { name: "删除快捷键 Alt+1" }).click();
    await expect(row(page, id).getByText("未设置")).toBeVisible();
    await row(page, id).getByRole("button", { name: "恢复默认" }).click();
    await expect(row(page, id).locator("kbd")).toHaveText("Alt+1");
    await expect(row(page, id).getByRole("button", { name: "恢复默认" })).toHaveCount(0);
  });

  test("everything can be reset at once", async ({ page }) => {
    await openShortcuts(page);
    const resetAll = page.getByRole("button", { name: "全部恢复默认" });
    await expect(resetAll).toBeDisabled();
    await row(page, "view.workspace.edit")
      .getByRole("button", { name: /^删除快捷键/ })
      .click();
    await startRecording(page, "view.open.timeline");
    await page.keyboard.press("KeyJ");
    await resetAll.click();
    await expect(row(page, "view.workspace.edit").locator("kbd")).toHaveText("Alt+1");
    await expect(row(page, "view.open.timeline").getByText("未设置")).toBeVisible();
    await expect(resetAll).toBeDisabled();
  });

  test("changes survive a reload", async ({ page }) => {
    await openShortcuts(page);
    await startRecording(page, "view.workspace.audio");
    await page.keyboard.press("KeyJ");
    await expect
      .poll(() => page.evaluate((key) => localStorage.getItem(key), KEYS_SETTING))
      .toContain("view.workspace.audio");
    await page.reload();
    await expect(tab(page, "preview")).toBeVisible();
    await page.keyboard.press("KeyJ");
    await expect(workspace(page, "音频")).toHaveAttribute("aria-pressed", "true");
  });

  test("broken settings fall back to the defaults and say so", async ({ page }) => {
    await page.evaluate((key) => localStorage.setItem(key, "{not json"), KEYS_SETTING);
    await page.reload();
    await expect(tab(page, "preview")).toBeVisible();
    await expect(page.getByText("快捷键设置无法读取，已恢复默认。")).toBeVisible();
    await page.keyboard.press("Alt+Digit2");
    await expect(workspace(page, "动画")).toHaveAttribute("aria-pressed", "true");
  });

  test("the list can be searched by name and by key", async ({ page }) => {
    await openShortcuts(page);
    const search = page.getByLabel("搜索命令或快捷键");
    await search.fill("alt+2");
    await expect(page.locator("[data-action]")).toHaveCount(1);
    await expect(row(page, "view.workspace.animate")).toBeVisible();
    await search.fill("时间轴");
    await expect(page.locator("[data-action]")).toHaveCount(1);
    await search.fill("没有这个");
    await expect(content(page, "keybindings").getByText("没有匹配的命令")).toBeVisible();
  });

  test("the search box of the list keeps plain keys for itself", async ({ page }) => {
    await openShortcuts(page);
    await startRecording(page, "view.workspace.animate");
    await page.keyboard.press("KeyJ");
    const search = page.getByLabel("搜索命令或快捷键");
    await search.click();
    await page.keyboard.type("j");
    await expect(search).toHaveValue("j");
    await expect(workspace(page, "剪辑")).toHaveAttribute("aria-pressed", "true");
  });
});
