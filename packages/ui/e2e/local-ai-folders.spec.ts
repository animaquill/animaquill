/**
 * The AI tools on this computer (docs/design/mcp.md of AnimaQuill Cloud, 6.16a), as people meet
 * them in the editor with a project folder: the guide and its ways in, and the settings. What AI
 * tools do through `animaquill mcp`, which runs their calls in the editor (docs/design/
 * online-offline.md 5), is in packages/local/e2e/mcp.spec.ts.
 */
import type { Page } from "@playwright/test";
import { openSettingsPage, settingsOf } from "./ai-support.ts";
import { openDropped, projectOnDisk } from "./folder-support.ts";
import { content, expect, test } from "./support.ts";

/** Pictures of what people see, kept with the results of the test. */
const shot = (page: Page, name: string) =>
  page.screenshot({ path: test.info().outputPath(`${name}.png`) });

const guide = (page: Page) => page.getByTestId("local-ai-guide");

test.use({
  folders: true,
  withProject: false,
  launchOptions: { args: ["--enable-experimental-web-platform-features"] },
});

test.describe("with a project folder", () => {
  test("the guide says where the project is, gives what to copy, and sees who connects", async ({
    page,
    context,
  }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.setViewportSize({ width: 1440, height: 900 });
    const disk = projectOnDisk();
    await openDropped(page, disk);
    await page.getByRole("button", { name: "帮助" }).click();
    await page.getByRole("menu").getByRole("menuitem", { name: "连接电脑上的 AI 工具" }).click();
    const shown = guide(page);
    await expect(shown.getByTestId("local-ai-project")).toHaveText(
      "这个项目在文件夹「原子」里，AI 工具在这个文件夹里启动",
    );
    // Claude Code first, with the commands its documentation has.
    const panel = shown.getByTestId("local-ai-panel");
    await expect(panel).toContainText("claude plugin marketplace add animaquill/animaquill");
    await expect(panel).toContainText("claude plugin install animaquill@animaquill");
    await shown.getByRole("radio", { name: "Windows" }).click();
    await expect(panel).toContainText("在资源管理器里打开「原子」文件夹，在地址栏输入 cmd 回车");
    await shot(page, "guide-claude-code");
    await shown.getByRole("radio", { name: "macOS" }).click();
    await expect(panel).toContainText("打开终端，输入 cd 加一个空格，把「原子」文件夹拖进终端窗口");
    await panel
      .getByRole("button", { name: "复制 claude plugin install animaquill@animaquill" })
      .click();
    await expect(panel.getByRole("button", { name: /animaquill@animaquill/ })).toHaveText("已复制");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      "claude plugin install animaquill@animaquill",
    );
    await shown.getByRole("tab", { name: "Codex" }).click();
    await expect(panel).toContainText("codex mcp add animaquill -- npx -y animaquill@latest mcp");
    await shot(page, "guide-codex");
    await shown.getByRole("tab", { name: "Cursor" }).click();
    const cursor = await shown.getByTestId("local-ai-add-cursor").getAttribute("href");
    const config = new URL(cursor ?? "").searchParams.get("config") ?? "";
    expect(cursor).toMatch(
      /^cursor:\/\/anysphere\.cursor-deeplink\/mcp\/install\?name=animaquill&/,
    );
    expect(JSON.parse(Buffer.from(config, "base64").toString())).toEqual({
      command: "npx",
      args: ["-y", "animaquill@latest", "mcp"],
    });
    await shown.getByRole("tab", { name: "VS Code" }).click();
    const vscode = await shown.getByTestId("local-ai-add-vscode").getAttribute("href");
    expect(
      JSON.parse(decodeURIComponent((vscode ?? "").replace("vscode:mcp/install?", ""))),
    ).toEqual({
      name: "animaquill",
      type: "stdio",
      command: "npx",
      args: ["-y", "animaquill@latest", "mcp"],
    });
    await shown.getByRole("tab", { name: "Claude 桌面版" }).click();
    await shown.getByRole("textbox", { name: "项目文件夹的路径" }).fill('"C:\\片子\\原子"');
    await expect(panel).toContainText('"--project",\n        "C:\\\\片子\\\\原子"');
    // The tool picked last comes first next time.
    await shown.getByRole("tab", { name: "Codex" }).click();
    await shown.getByRole("button", { name: "关闭" }).last().click();
    await expect(shown).toBeHidden();

    // From the settings, where the tools that wrote are listed too.
    await openSettingsPage(page, "电脑上的 AI 工具");
    await settingsOf(page).getByTestId("local-ai-wizard").click();
    await expect(settingsOf(page)).toBeHidden();
    await expect(shown.getByRole("tab", { name: "Codex" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    const status = shown.getByTestId("local-ai-connected");
    await expect(status).toHaveText("还没有工具连着这个项目");
    // Connecting, where no AI tool runs: it says so, and keeps looking. That it connects to one is
    // in packages/local/e2e/mcp.spec.ts, with `animaquill mcp` itself.
    await page.evaluate(() => localStorage.setItem("animaquill.mcp.ports", "47390:2"));
    await shown.getByTestId("local-ai-connect-button").click();
    // Why, as far as the browser tells: none runs, or (the test browser, which asks nobody) it does
    // not let the page at this computer, with where to change that.
    await expect(shown.getByTestId("local-ai-connect-status")).toHaveText(
      /^(电脑上还没有 AI 工具在运行|Chrome 挡了这个网站访问这台设备上的应用：点地址栏左边的图标 › 网站设置)/,
    );
    await shot(page, "guide-folder");
    // AGENTS.md: the project has one, which opens in the code tab.
    await shown.getByTestId("local-ai-agents").locator("summary").click();
    await shown.getByTestId("local-ai-agents").getByRole("button", { name: "打开" }).click();
    await expect(shown).toBeHidden();
    await expect(content(page, "code")).toContainText("给 AI 的说明", { timeout: 10_000 });
    {
      // Narrow, the menus are in one.
      await page.setViewportSize({ width: 390, height: 844 });
      await page.locator("header").getByRole("button", { name: "菜单" }).click();
      await page
        .getByRole("menu", { name: "菜单" })
        .getByRole("menuitem", { name: "帮助" })
        .click();
      await page
        .getByRole("menu", { name: "帮助" })
        .getByRole("menuitem", { name: "连接电脑上的 AI 工具" })
        .click();
      await shot(page, "guide-390");
    }
  });
});
