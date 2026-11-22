import type { Page } from "@playwright/test";
import { expect, tab } from "./support.ts";

/**
 * What the tests of the real sites (deploy/test of AnimaQuill Cloud) do in the online mode, see
 * docs/design/online-offline.md of AnimaQuill Cloud, 1: the entry page, and a new project, which is
 * always one of the platform.
 */

/** The "用 GitHub 登录" of the entry page, which is what the site shows before anybody signed in. */
export const entrySignIn = (page: Page) =>
  page.getByTestId("entry").getByRole("button", { name: "用 GitHub 登录" });

/**
 * Makes a project of the platform in the dialog of the start page, with a repository of this name
 * (or the one its name makes), and goes into it once its repository has the first copy.
 */
export async function createOnline(
  page: Page,
  repository?: string,
  name = "测试项目",
  timeout = 60_000,
) {
  await page.getByRole("button", { name: "新建项目" }).first().click();
  const box = page.locator("dialog[data-create-phase]");
  await box.getByRole("textbox", { name: "项目名称" }).fill(name);
  if (repository !== undefined) {
    // The name of the repository follows the name of the project until people type their own: the
    // page may still be on its way to the one it derived when this is typed.
    const field = box.getByRole("textbox", { name: "仓库名" });
    await expect(async () => {
      await field.fill(repository);
      await expect(field).toHaveValue(repository, { timeout: 500 });
    }).toPass();
  }
  await box.getByRole("button", { name: /^(新建|再试一次)$/ }).click();
  await expect(box).toHaveAttribute("data-create-phase", /archiving|done/, { timeout });
  await box.getByRole("button", { name: /^(关闭|完成)$/ }).click();
  await expect(box).toHaveCount(0);
  await expect(tab(page, "preview")).toBeVisible();
}
