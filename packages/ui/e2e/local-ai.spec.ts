/**
 * The guide to the AI tools on this computer (docs/design/mcp.md of AnimaQuill Cloud, 6.16a) where
 * there is no project folder: a project only in the browser, and the start page; its ways in from
 * the chat and the palette; the switch for AGENTS.md of new projects, and the group of the project
 * properties. With a folder, see local-ai-folders.spec.ts.
 */
import type { Page } from "@playwright/test";
import { addAnthropic, leaveSettings, openSettingsPage, settingsOf } from "./ai-support.ts";
import { content, createProject, expect, test } from "./support.ts";

/** Pictures of what people see, kept with the results of the test. */
const shot = (page: Page, name: string) =>
  page.screenshot({ path: test.info().outputPath(`${name}.png`) });

const guide = (page: Page) => page.getByTestId("local-ai-guide");

test.describe("a project only in the browser", () => {
  test("the guide says that a project only in the browser needs one, and opens from the chat", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page
      .getByRole("tab", { name: "聊天" })
      .first()
      .click()
      .catch(() => {});
    await content(page, "chat").getByTestId("chat-onboard-local-ai").click();
    await expect(guide(page).getByTestId("local-ai-project")).toContainText(
      "这个浏览器不能打开电脑上的文件夹，电脑上的 AI 工具改不了这个项目。",
    );
    await expect(guide(page).getByRole("button", { name: "关联文件夹…" })).toHaveCount(0);
    await shot(page, "guide-browser");
    await guide(page).getByRole("button", { name: "关闭" }).last().click();
    // The palette has it too.
    await page.keyboard.press("Control+Shift+KeyP");
    await page.getByRole("combobox", { name: "命令面板" }).fill("连接电脑上的 AI 工具");
    await page.keyboard.press("Enter");
    await expect(guide(page)).toBeVisible();
    await guide(page).getByRole("button", { name: "关闭" }).last().click();
    // And the bubble of models, once there is a service.
    await addAnthropic(page, "sk-ant-test-1234");
    await leaveSettings(page);
    await content(page, "chat").getByTestId("chat-model").click();
    await content(page, "chat").getByTestId("chat-picker-local-ai").click();
    await expect(guide(page)).toBeVisible();
  });
});

test.describe("on the start page", () => {
  test.use({ withProject: false });

  test("new projects start with AGENTS.md unless that is off, and the properties add one", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openSettingsPage(page, "电脑上的 AI 工具");
    const toggle = settingsOf(page).getByRole("switch", {
      name: "新建项目时放一份 AI 说明（AGENTS.md）",
    });
    await expect(toggle).toBeChecked();
    await toggle.uncheck();
    await settingsOf(page).getByRole("button", { name: "关闭设置" }).click();
    await createProject(page, "没有说明的");
    const props = page.getByTestId("project-properties");
    const group = props.getByRole("navigation", { name: "项目属性的分组" });
    await page.locator("header").getByRole("button", { name: "文件", exact: true }).click();
    await page.getByRole("menu").getByRole("menuitem", { name: "项目属性…", exact: true }).click();
    await group.getByRole("button", { name: "给 AI 的说明", exact: true }).click();
    await expect(props.getByTestId("project-agents")).toHaveText("还没有");
    await shot(page, "properties-none");
    await props.getByRole("button", { name: "加一份" }).click();
    await expect(props.getByTestId("project-agents")).toHaveText("已有");
    await shot(page, "properties");
    await props.getByRole("button", { name: "打开" }).click();
    await expect(props).toBeHidden();
    await expect(content(page, "code")).toContainText("Instructions for AI", { timeout: 10_000 });
  });

  test("the guide only says the steps", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByRole("button", { name: "帮助" }).click();
    await page.getByRole("menu").getByRole("menuitem", { name: "连接电脑上的 AI 工具" }).click();
    await expect(guide(page)).toBeVisible();
    await expect(guide(page).getByTestId("local-ai-project")).toHaveCount(0);
    await expect(guide(page).getByTestId("local-ai-panel")).toContainText("项目文件夹");
    await expect(guide(page).getByTestId("local-ai-agents")).toHaveCount(0);
    await expect(guide(page).getByTestId("local-ai-connected")).toHaveCount(0);
    await shot(page, "guide-none");
  });
});
