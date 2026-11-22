import type { Page } from "@playwright/test";
import { devPageOnly, expect, tab, test } from "./support.ts";

/**
 * The account menu, where the host has accounts. The development page has a fake one with
 * `?account=fake`, see dev/account.ts: signing in there leaves the page and comes back, the way it
 * does through GitHub. The entry page and the two modes are in modes.spec.ts.
 */

const header = (page: Page) => page.locator("header");
const signIn = (page: Page) => header(page).getByRole("button", { name: "登录", exact: true });
const accountMenu = (page: Page) => header(page).getByRole("button", { name: "账号：octo" });

devPageOnly("no accounts, and a fake one with ?account=fake");

test("is not there where the host has no accounts", async ({ page }) => {
  await expect(tab(page, "preview")).toBeVisible();
  await expect(signIn(page)).toHaveCount(0);
  await expect(header(page).getByRole("button", { name: /^账号/ })).toHaveCount(0);
});

test.describe("where the host has accounts", () => {
  test.use({ withProject: false });

  test.beforeEach(async ({ page }) => {
    // Signed in, with the App not installed yet: the site of the online mode.
    await page.addInitScript(() => {
      if (window !== window.top) return;
      if (sessionStorage.getItem("animaquill.fakeAccount") === null)
        sessionStorage.setItem(
          "animaquill.fakeAccount",
          JSON.stringify({ signedIn: true, installed: false }),
        );
    });
    await page.goto("/?account=fake");
  });

  test("the menu installs the App, and signs out, back to the address of the site", async ({
    page,
  }) => {
    await accountMenu(page).click();
    const menu = page.getByRole("menu", { name: "账号：octo" });
    await expect(menu.getByRole("menuitem", { name: "账号：octo" })).toBeDisabled();
    await expect(menu.getByRole("menuitem", { name: "切换到离线模式" })).toBeVisible();
    await menu.getByRole("menuitem", { name: "GitHub App：去安装" }).click();

    await expect(page.getByText("已登录：octo", { exact: true })).toBeVisible();
    await accountMenu(page).click();
    await expect(menu.getByRole("menuitem", { name: "GitHub App：已安装" })).toBeDisabled();
    await menu.getByRole("menuitem", { name: "退出登录" }).click();
    // Back to the entry page of the site.
    await expect(page).toHaveURL((url) => url.pathname === "/");
    await expect(page.getByTestId("entry")).toBeVisible();
  });
});
