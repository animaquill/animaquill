import type { Locator, Page } from "@playwright/test";
import { expect } from "./support.ts";

/**
 * The start page, "作品墙", as tests go through it: a side bar of views and groups, and on the right
 * the cards of the projects of the view, see the design of the start page of AnimaQuill Cloud, 6.
 */

/** The side bar. */
export const sidebar = (page: Page) => page.getByRole("navigation", { name: "项目分类" });

/** Goes to a view of the side bar: "最近打开", "全部项目", "收藏", or a group by its name. */
export async function showView(page: Page, name: string) {
  const item = sidebar(page).getByRole("button", { name: new RegExp(`^${name}\\s*\\d*$`) });
  await item.click();
  await expect(item).toHaveAttribute("aria-current", "page");
}

/** The projects the view lists, or those under "你的云端项目" of the welcome. */
export const projectList = (page: Page, name = "项目") =>
  page.getByRole("main").getByRole("list", { name, exact: true });

/** The card of a project in the view, by its name exactly. */
export const projectCard = (page: Page, name: string): Locator =>
  page
    .getByRole("main")
    .locator("li[data-project]")
    .filter({ has: page.getByText(name, { exact: true }) });

/** Opens a project by its card, as people click it. */
export const openCard = (page: Page, name: string) =>
  projectCard(page, name).locator("a, button").first().click();

/** Chooses an item of the menu of a card. */
export async function cardMenu(page: Page, name: string, item: string) {
  await projectCard(page, name)
    .getByRole("button", { name: `“${name}”的更多操作` })
    .click();
  await page.getByRole("menu").getByRole("menuitem", { name: item, exact: true }).click();
}

/** Shows the projects of the platform, or the folders, or all of them. */
export const filterTo = (page: Page, name: "全部" | "云端" | "本地") =>
  page.getByRole("group", { name: "筛选" }).getByRole("button", { name, exact: true }).click();

/** What the line of a card says, such as "云端 · 只在这个浏览器里". */
export const statusOf = (page: Page, name: string) =>
  projectCard(page, name).locator("[data-tone]").first();

/** The start page is there, without a single project on it. */
export async function noProjects(page: Page) {
  await expect(sidebar(page)).toBeVisible();
  await expect(page.getByRole("main").locator("li[data-project]")).toHaveCount(0);
}

/** What the menu of a card offers, read and closed again. */
export async function cardMenuItems(page: Page, name: string): Promise<string[]> {
  await projectCard(page, name)
    .getByRole("button", { name: `“${name}”的更多操作` })
    .click();
  const items = await page.getByRole("menu").getByRole("menuitem").allInnerTexts();
  await page.keyboard.press("Escape");
  return items;
}
