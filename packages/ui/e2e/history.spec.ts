import type { Page } from "@playwright/test";
import { content, expect, tab, test } from "./support.ts";

/**
 * The last operation in the status bar, and the list of the latest ones behind it: taking back what
 * people did here up to a step, doing it again, and what another window did, which only that
 * window takes back.
 */

const status = (page: Page) =>
  page.getByRole("contentinfo").getByRole("button", { name: /^上次的操作：/ });
const bubble = (page: Page) => page.getByRole("dialog", { name: "最近的操作" });
const items = (page: Page) =>
  bubble(page).getByRole("list", { name: "最近的操作" }).getByRole("listitem");
const clips = (page: Page) => content(page, "timeline").getByRole("option");

async function newScene(page: Page) {
  await tab(page, "assets").click();
  await content(page, "assets").getByRole("button", { name: "新建场景" }).click();
}

async function rename(page: Page, name: string) {
  await page.getByRole("contentinfo").getByRole("button", { name: "测试项目" }).click();
  await page.getByRole("textbox", { name: "项目名称" }).fill(name);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("contentinfo").getByRole("button", { name })).toBeVisible();
}

test("names the last operation, and takes back up to one of the list, and does it again", async ({
  page,
}) => {
  await expect(status(page)).toHaveAccessibleName("上次的操作：还没有操作");
  await newScene(page);
  await expect(clips(page)).toHaveCount(1);
  await expect(status(page)).toHaveAccessibleName("上次的操作：新建场景");
  await newScene(page);
  await expect(clips(page)).toHaveCount(2);
  await rename(page, "改过的名字");
  await expect(status(page)).toHaveAccessibleName("上次的操作：改项目名");

  await status(page).click();
  await expect(items(page)).toHaveCount(3);
  await expect(items(page).nth(0)).toContainText("改项目名");
  await expect(items(page).nth(0)).toContainText("你");
  await expect(items(page).nth(2)).toContainText("新建场景");
  await bubble(page).screenshot({ path: test.info().outputPath("history-list.png") });

  // Up to the first one: all three go back, the last one first, and the list says so.
  await items(page).nth(2).getByRole("button", { name: "撤销到这里" }).click();
  await expect(clips(page)).toHaveCount(0);
  await expect(
    page.getByRole("contentinfo").getByRole("button", { name: "测试项目" }),
  ).toBeVisible();
  for (const index of [0, 1, 2]) {
    await expect(items(page).nth(index)).toHaveAttribute("data-undone", "true");
  }
  // What was taken back last comes back first.
  await expect(items(page).getByRole("button", { name: "重做" })).toHaveCount(1);
  await expect(items(page).nth(0)).toContainText("先重做后撤销的那几步");
  await bubble(page).screenshot({ path: test.info().outputPath("history-undone.png") });
  await items(page).nth(2).getByRole("button", { name: "重做" }).click();
  await expect(clips(page)).toHaveCount(1);
  await expect(items(page).nth(2)).not.toHaveAttribute("data-undone");
  await expect(items(page).nth(1).getByRole("button", { name: "重做" })).toBeVisible();

  // Something new: what was taken back cannot be done again, and goes from the list.
  await page.keyboard.press("Escape");
  await expect(bubble(page)).toHaveCount(0);
  await newScene(page);
  await expect(clips(page)).toHaveCount(2);
  await status(page).click();
  await expect(items(page)).toHaveCount(2);
  await expect(items(page).getByRole("button", { name: "撤销到这里" })).toHaveCount(2);
});

test("lists what another window did, which that window takes back", async ({ page }) => {
  const other = await page.context().newPage();
  await other.goto(page.url());
  await expect(tab(other, "preview")).toBeVisible();
  await newScene(other);
  await expect(clips(other)).toHaveCount(1);
  await expect(clips(page)).toHaveCount(1);
  await expect(status(page)).toHaveAccessibleName("上次的操作：其他窗口的改动");
  await status(page).click();
  await expect(items(page).nth(0)).toContainText("其他窗口");
  await expect(items(page).nth(0)).toContainText("其他窗口的改动要在那个窗口撤销");
  await expect(items(page).getByRole("button")).toHaveCount(0);
  await bubble(page).screenshot({ path: test.info().outputPath("history-other-window.png") });

  // The other window has it as its own.
  await status(other).click();
  await items(other).nth(0).getByRole("button", { name: "撤销到这里" }).click();
  await expect(clips(other)).toHaveCount(0);
  await expect(clips(page)).toHaveCount(0);
});
