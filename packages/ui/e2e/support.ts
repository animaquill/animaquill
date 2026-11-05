import { expect, test as base, type Page } from "@playwright/test";

export { expect };

export const tab = (page: Page, type: string) => page.locator(`[data-tab="${type}"]`);
export const content = (page: Page, type: string) => page.locator(`[data-panel="${type}"]`);
export const group = (page: Page, type: string) =>
  page.locator(".dv-groupview").filter({ has: tab(page, type) });

/** Creates a project the way people do. */
export async function createProject(page: Page, name = "测试项目") {
  await page.getByRole("button", { name: "新建项目" }).click();
  await page.getByRole("textbox", { name: "项目名称" }).fill(name);
  await page.keyboard.press("Enter");
  await expect(tab(page, "preview")).toBeVisible();
}

/**
 * Opens the editor for every test, with a project unless the test says otherwise, and fails the
 * test when anything was logged as an error.
 */
export const test = base.extend<{ problems: string[]; withProject: boolean }>({
  withProject: [true, { option: true }],
  problems: [
    async ({ page, withProject }, use) => {
      const problems: string[] = [];
      page.on("pageerror", (error) => problems.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error") problems.push(message.text());
      });
      await page.goto("/");
      if (withProject) await createProject(page);
      await use(problems);
      expect(problems).toEqual([]);
    },
    { auto: true },
  ],
});
