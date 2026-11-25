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
      // By the keyboard: where it is this narrow, the menu of the help opens over the item that
      // opens it as soon as the pointer is on it, so a click would land on what is in the menu, or,
      // as it did on a slow runner (CI), wait for ever for the item that is now covered.
      const item = page.getByRole("menu", { name: "菜单" }).getByRole("menuitem", { name: "帮助" });
      await item.focus();
      await page.keyboard.press("ArrowRight");
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
