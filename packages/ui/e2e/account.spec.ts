import type { Page } from "@playwright/test";
import { editorTab, LOADING, lines, openFile } from "./code-support.ts";
import { field, placeImage, typeInto } from "./property-helpers.ts";
import { importFolder, projectFolder } from "./scene-support.ts";
import { createProject, devPageOnly, expect, tab, test } from "./support.ts";

/**
 * The account menu, where the host has accounts. The development page has a fake one with
 * `?account=fake`, see dev/account.ts: signing in there leaves the page and comes back, the way it
 * does through GitHub.
 */

const header = (page: Page) => page.locator("header");
const signIn = (page: Page) => header(page).getByRole("button", { name: "登录", exact: true });
const accountMenu = (page: Page) => header(page).getByRole("button", { name: "账号：octo" });
const trials = (page: Page) =>
  page.getByRole("group", { name: "试改", exact: true }).getByRole("status");

/** Dialogs the browser shows, such as the one that asks whether to leave the page. */
const browserDialogs = (page: Page) => {
  const seen: string[] = [];
  page.on("dialog", (dialog) => {
    seen.push(dialog.type());
    void dialog.dismiss();
  });
  return seen;
};

devPageOnly("no accounts, and a fake one with ?account=fake");

test("is not there where the host has no accounts", async ({ page }) => {
  await expect(tab(page, "preview")).toBeVisible();
  await expect(signIn(page)).toHaveCount(0);
  await expect(header(page).getByRole("button", { name: /^账号/ })).toHaveCount(0);
});

test.describe("where the host has accounts", () => {
  test.use({ withProject: false });

  test.beforeEach(async ({ page }) => {
    await page.goto("/?account=fake");
  });

  test("signing in comes back to the project, with what was being tried", async ({ page }) => {
    await createProject(page);
    await placeImage(page);
    await typeInto(field(page, "位置 X"), "-500");
    await expect(trials(page)).toHaveText("试改 1 处");
    const dialogs = browserDialogs(page);

    await signIn(page).click();
    await expect(accountMenu(page)).toBeVisible();
    await expect(page.getByText("已登录：octo。要把项目存到 GitHub")).toBeVisible();
    // The same project, and what was being tried with it.
    await expect(tab(page, "preview")).toBeVisible();
    await expect(page).toHaveTitle("测试项目 - AnimaQuill");
    await expect(trials(page)).toHaveText("试改 1 处");
    expect(dialogs).toEqual([]);
  });

  test("signing in brings code that was not saved back, without asking", async ({ page }) => {
    const sources = { "index.html": "<!doctype html>\n<p>你好</p>\n", "a.js": "one\n" };
    await importFolder(page, projectFolder({ a: sources }, [{}]));
    await openFile(page, "a.js");
    await lines(page).click();
    await page.keyboard.press("Control+Home");
    await page.keyboard.type("mine-");
    const dialogs = browserDialogs(page);

    // Straight away: what was typed has to be on the device before the page goes.
    await signIn(page).click();
    await expect(accountMenu(page)).toBeVisible();
    await expect(page.getByText("找回了 1 个没保存的文件")).toBeVisible(LOADING);
    await tab(page, "code").click();
    await expect(editorTab(page, "● a.js")).toBeVisible();
    await expect(lines(page)).toContainText("mine-one", LOADING);
    expect(dialogs).toEqual([]);
  });

  test("the menu installs the App, and signs out", async ({ page }) => {
    await createProject(page);
    await signIn(page).click();
    await accountMenu(page).click();
    const menu = page.getByRole("menu", { name: "账号：octo" });
    await expect(menu.getByRole("menuitem", { name: "账号：octo" })).toBeDisabled();
    await menu.getByRole("menuitem", { name: "GitHub App：去安装" }).click();

    await expect(page.getByText("已登录：octo", { exact: true })).toBeVisible();
    await expect(tab(page, "preview")).toBeVisible();
    await accountMenu(page).click();
    await expect(menu.getByRole("menuitem", { name: "GitHub App：已安装" })).toBeDisabled();
    await menu.getByRole("menuitem", { name: "退出登录" }).click();
    await expect(signIn(page)).toBeVisible();
    await expect(page.getByText("已退出登录。")).toBeVisible();
    await expect(tab(page, "preview")).toBeVisible();
  });
});
