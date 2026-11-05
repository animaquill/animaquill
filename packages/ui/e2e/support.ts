import { expect, test as base, type Page } from "@playwright/test";

export { expect };

export const tab = (page: Page, type: string) => page.locator(`[data-tab="${type}"]`);
export const content = (page: Page, type: string) => page.locator(`[data-panel="${type}"]`);
export const group = (page: Page, type: string) =>
  page.locator(".dv-groupview").filter({ has: tab(page, type) });

/** Opens the editor for every test and fails it when anything was logged as an error. */
export const test = base.extend<{ problems: string[] }>({
  problems: [
    async ({ page }, use) => {
      const problems: string[] = [];
      page.on("pageerror", (error) => problems.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error") problems.push(message.text());
      });
      await page.goto("/");
      await expect(tab(page, "preview")).toBeVisible();
      await use(problems);
      expect(problems).toEqual([]);
    },
    { auto: true },
  ],
});
