import type { Page } from "@playwright/test";
import { content, expect, tab } from "./support.ts";

/** Working with files and the code editor, the way people do. */

export const files = (page: Page) => content(page, "files");
export const code = (page: Page) => content(page, "code");
/** By the name in the row. The accessible name can have more, like saying that it is an entry. */
export const row = (page: Page, name: string) =>
  files(page)
    .getByRole("treeitem")
    .filter({ has: page.getByText(name, { exact: true }) });
export const editorTab = (page: Page, name: string) => code(page).getByRole("tab", { name });
export const lines = (page: Page) => code(page).locator(".view-lines");

export async function openFile(page: Page, name: string): Promise<void> {
  await tab(page, "files").click();
  await row(page, name).click();
  await expect(lines(page)).toBeVisible(LOADING);
  await expect(editorTab(page, name)).toHaveAttribute("aria-selected", "true");
}

/** Puts the cursor in the editor and replaces everything, the way people do. */
export async function replaceAll(page: Page, typed: string): Promise<void> {
  await lines(page).click();
  await page.keyboard.press("Control+a");
  await page.keyboard.press("Delete");
  // Typing brackets and quotes one by one gets closed for you, which is not what this is about.
  await page.keyboard.insertText(typed);
}

export const save = (page: Page) => page.keyboard.press("Control+s");

/** The editor and its workers are large, which takes a while the first time in a busy browser. */
export const LOADING = { timeout: 30000 };
