import type { Page } from "@playwright/test";
import { devPageOnly, editorReady, expect, tab, test } from "./support.ts";

/**
 * The title bar at every width: nothing in it lies over anything else, everything stays inside the
 * bar, and every menu can be opened. The widest it gets is the offline mode of a site with a
 * backend, where "登录" is there besides everything else, with a project open. Pictures go to the
 * output.
 */

devPageOnly("a backend in the tab, with ?account=fake&cloud=fake");
test.use({ withProject: false });

const WIDTHS = [320, 390, 480, 640, 800, 1024, 1280, 1440];

async function offlineWithProject(page: Page) {
  await page.addInitScript(() => {
    if (window !== window.top) return;
    if (sessionStorage.getItem("animaquill.fakeAccount") === null)
      sessionStorage.setItem(
        "animaquill.fakeAccount",
        JSON.stringify({ signedIn: false, installed: true }),
      );
  });
  await page.goto("/offline?account=fake&cloud=fake");
  await editorReady(page);
  await page.getByRole("button", { name: "新建项目" }).first().click();
  await page.getByRole("textbox", { name: "项目名称" }).fill("顶栏");
  await page.keyboard.press("Enter");
  await expect(tab(page, "preview")).toBeVisible();
}

/** The boxes of what can be seen in the bar, each thing that is pressed or read on its own. */
const parts = (page: Page) =>
  page
    .locator("header")
    .first()
    .evaluate((bar) => {
      const seen = [...bar.querySelectorAll("button, a, [data-title-part]")].filter((element) => {
        const box = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return box.width > 0 && box.height > 0 && style.visibility !== "hidden";
      });
      // The outermost only: a button inside another part is that part.
      return seen
        .filter((element) => !seen.some((other) => other !== element && other.contains(element)))
        .map((element) => {
          const box = element.getBoundingClientRect();
          return {
            name: element.getAttribute("aria-label") ?? element.textContent?.trim() ?? "",
            left: box.left,
            right: box.right,
          };
        });
    });

test("the title bar: nothing over anything else at any width, every menu within reach", async ({
  page,
}) => {
  // Every width from 320 to 1440, with every menu opened: a quarter of a minute where it is quick.
  test.setTimeout(120_000);
  await offlineWithProject(page);
  await expect(page.locator("header").getByRole("button", { name: "登录" })).toBeVisible();
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 800 });
    await page.waitForTimeout(100);
    const boxes = await parts(page);
    // Inside the bar. The page itself may be wider than a phone: that is the editor's, not the bar's.
    const bar = await page.locator("header").first().boundingBox();
    for (const box of boxes) {
      expect(box.left, `${box.name} at ${width}`).toBeGreaterThanOrEqual(bar!.x);
      expect(box.right, `${box.name} at ${width}`).toBeLessThanOrEqual(bar!.x + bar!.width);
    }
    const sorted = boxes.toSorted((a, b) => a.left - b.left);
    for (let at = 1; at < sorted.length; at += 1) {
      const [before, after] = [sorted[at - 1]!, sorted[at]!];
      expect(
        after.left,
        `${after.name} over ${before.name} at ${width}: ${JSON.stringify(sorted)}`,
      ).toBeGreaterThanOrEqual(before.right - 0.5);
    }
    // The last menu opens: from the bar, or where it is narrow, from the menus in one.
    const help = page.locator("header").getByRole("button", { name: "帮助", exact: true });
    if (await help.isVisible()) {
      await help.click();
      await expect(page.getByRole("menu")).toBeVisible();
    } else {
      expect(width).toBeLessThanOrEqual(560);
      await page.locator("header").getByRole("button", { name: "菜单" }).click();
      await page
        .getByRole("menu", { name: "菜单" })
        .getByRole("menuitem", { name: "帮助" })
        .click();
      await expect(page.getByRole("menu", { name: "帮助" })).toBeVisible();
      await page.screenshot({
        path: test.info().outputPath(`title-${width}-menus.png`),
        clip: { x: 0, y: 0, width, height: 400 },
      });
    }
    // From a menu inside another, the first Escape goes back to it.
    for (let escapes = 0; escapes < 3 && (await page.getByRole("menu").count()) > 0; escapes++)
      await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);
    await page.locator("header").getByRole("button", { name: "命令面板" }).click();
    await expect(page.getByRole("combobox", { name: "命令面板" })).toBeVisible();
    await page.keyboard.press("Escape");
    await page.screenshot({
      path: test.info().outputPath(`title-${width}.png`),
      clip: { x: 0, y: 0, width, height: 40 },
    });
  }
});

const all = (page: Page) => page.locator("header").getByRole("button", { name: "菜单" });
const inAll = (page: Page, name: string) =>
  page.getByRole("menu", { name: "菜单" }).getByRole("menuitem", { name, exact: true });
const help = (page: Page) => page.getByRole("menu", { name: "帮助" });

test("on a phone the menu of an item takes the place of the menu, and only a click opens it", async ({
  page,
}) => {
  await offlineWithProject(page);
  await page.setViewportSize({ width: 390, height: 800 });
  await all(page).click();
  const item = inAll(page, "帮助");
  await expect(item).toHaveAttribute("aria-haspopup", "menu");
  // The pointer resting on it opens nothing: what is under the pointer stays what it was.
  await item.hover();
  await page.waitForTimeout(400);
  await expect(help(page)).toHaveCount(0);
  await expect(item).toHaveAttribute("aria-expanded", "false");

  // A double click opens it, and the second click is not taken by what is now under the pointer.
  const before = page.url();
  await item.dblclick();
  await expect(help(page)).toBeVisible();
  await expect(page.getByRole("menu", { name: "菜单" })).toBeHidden();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(page.url()).toBe(before);
  // In place of the menu, inside the window, with the way back on top.
  const box = (await help(page).boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  const back = help(page).getByRole("menuitem").first();
  await expect(back).toHaveText("帮助");
  await expect(back).toHaveAccessibleDescription("返回上一级");
  await page.screenshot({
    path: test.info().outputPath("title-390-in-place.png"),
    clip: { x: 0, y: 0, width: 390, height: 400 },
  });

  // Back by the row on top. What is under the pointer then is where the menu is, as in any menu.
  await back.click();
  await expect(help(page)).toHaveCount(0);
  await expect(item).toHaveAttribute("aria-expanded", "false");
  await page.mouse.move(380, 790);
  await item.focus();

  // By the keyboard: → in, to its first item, ← and Esc back to the item, Esc again closes.
  await page.keyboard.press("ArrowRight");
  await expect(help(page)).toBeVisible();
  await expect(help(page).getByRole("menuitem").nth(1)).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(back).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(item).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(help(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(item).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(all(page)).toBeFocused();
});

test("where there is room the menu of an item opens beside it as the mouse rests on it", async ({
  page,
}) => {
  await offlineWithProject(page);
  await page.setViewportSize({ width: 560, height: 800 });
  await all(page).click();
  const item = inAll(page, "帮助");
  await item.hover();
  await expect(help(page)).toBeVisible();
  await expect(item).toHaveAttribute("aria-expanded", "true");
  // Beside it, not over it, and the menu it came from is still there.
  const [parent, child] = [(await item.boundingBox())!, (await help(page).boundingBox())!];
  expect(child.x).toBeGreaterThanOrEqual(parent.x + parent.width);
  await expect(page.getByRole("menu", { name: "菜单" })).toBeVisible();
  await expect(help(page).getByRole("menuitem", { name: "帮助" })).toHaveCount(0);
  // Into it, on the way crossing nothing: it stays.
  await help(page).getByRole("menuitem").first().hover();
  await page.waitForTimeout(300);
  await expect(help(page)).toBeVisible();
  // Resting on another item closes it.
  await inAll(page, "文件").hover();
  await expect(page.getByRole("menu", { name: "文件" })).toBeVisible();
  await expect(help(page)).toHaveCount(0);
  await page.screenshot({
    path: test.info().outputPath("title-560-beside.png"),
    clip: { x: 0, y: 0, width: 560, height: 400 },
  });
  // Esc goes back to the item, then closes.
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
});
