/**
 * The AI tools on this computer (docs/design/mcp.md of AnimaQuill Cloud, 6.16a), as people meet
 * them in the editor: the guide and its ways in, the settings and the project properties, and what
 * an AI tool writes into the project folder through `animaquill mcp`, which the tests here write
 * themselves, the note of its batch first, as packages/local/src/mcp/notes.ts does. That the local
 * MCP itself writes them so is in packages/local/e2e/local.spec.ts.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { openSettingsPage, settingsOf } from "./ai-support.ts";
import { footer, openDropped, projectOnDisk, text } from "./folder-support.ts";
import { content, expect, test } from "./support.ts";

/** Pictures of what people see, kept with the results of the test. */
const shot = (page: Page, name: string) =>
  page.screenshot({ path: test.info().outputPath(`${name}.png`) });

const guide = (page: Page) => page.getByTestId("local-ai-guide");
const hashOf = (value: string) => createHash("sha256").update(value).digest("hex");
const MAIN = "timelines/main/timeline.json";

/** Says that an AI tool is connected to the folder, as `ConnectionFile` of the local MCP does. */
function connect(disk: string, session = "abcdef012345", aliveAt = Date.now()): void {
  mkdirSync(join(disk, ".animaquill/mcp"), { recursive: true });
  writeFileSync(
    join(disk, `.animaquill/mcp/${session}.json`),
    JSON.stringify({
      format: 1,
      session,
      client: { name: "claude-code", version: "2.1.0" },
      pid: 1,
      startedAt: aliveAt - 60_000,
      aliveAt,
    }),
  );
}

/** Writes files as an AI tool's batch: the note of the batch, then the files. */
function toolWrites(
  disk: string,
  batch: string,
  files: Record<string, string>,
  client = "claude-code",
): void {
  mkdirSync(join(disk, ".animaquill/batches"), { recursive: true });
  const notePath = join(disk, `.animaquill/batches/${batch}.json`);
  let known: Record<string, string> = {};
  let startedAt = Date.now();
  try {
    const before = JSON.parse(readFileSync(notePath, "utf8"));
    known = before.files;
    startedAt = before.startedAt;
  } catch {
    // A new batch.
  }
  const hashes = Object.fromEntries(Object.entries(files).map(([path, t]) => [path, hashOf(t)]));
  writeFileSync(
    notePath,
    JSON.stringify({
      format: 1,
      batch,
      session: "abcdef012345",
      client: { name: client, version: "2.1.0" },
      startedAt,
      updatedAt: Date.now(),
      files: { ...known, ...hashes },
    }),
  );
  for (const [path, value] of Object.entries(files)) writeFileSync(join(disk, path), value);
}

/** The main timeline with the title clip named anew. */
function titleNamed(disk: string, name: string): string {
  const document = JSON.parse(text(disk, MAIN));
  const clip = document.tracks[0].clips.find((each: { id: string }) => each.id === "clip_title");
  clip.name = name;
  return `${JSON.stringify(document, null, 4)}\n`;
}

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
    await expect(shown.getByTestId("local-ai-project")).toHaveText("这个项目在文件夹「原子」里");
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
    await shot(page, "guide-folder");
    connect(disk);
    await expect(status).toContainText("Claude Code 连着这个项目", { timeout: 10_000 });
    await expect(shown.getByRole("button", { name: "好了" })).toBeVisible();
    await shot(page, "guide-connected");
    // One that said nothing for two minutes is gone.
    connect(disk, "abcdef012345", Date.now() - 3 * 60 * 1000);
    await expect(status).toHaveText("还没有工具连着这个项目", { timeout: 10_000 });
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

  test("what an AI tool writes comes in as its batch: told, marked, listed and taken back as one", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const disk = projectOnDisk();
    await openDropped(page, disk);
    connect(disk);
    toolWrites(disk, "b1", { [MAIN]: titleNamed(disk, "AI 改的标题") });
    const notice = page.getByText("Claude Code：把片段「标题」改名为「AI 改的标题」", {
      exact: true,
    });
    await expect(notice).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("外面改了")).toHaveCount(0);
    // Who is connected, where the status bar says how the folder is.
    await footer(page).getByRole("status").filter({ hasText: "已保存" }).hover();
    await expect(page.getByRole("tooltip")).toContainText("Claude Code 连着（");
    await shot(page, "status-connected");
    await page.mouse.move(700, 300);
    // The clips it changed stand out on the timeline.
    await expect(page.locator('[data-ai-changed][role="option"]')).toHaveCount(1);
    // More of the same batch: the same notice counts on.
    const scene = text(disk, "scenes/title/index.html");
    toolWrites(disk, "b1", { "scenes/title/index.html": `${scene}\n<!-- AI -->\n` });
    await expect(
      page.getByText("Claude Code：把片段「标题」改名为「AI 改的标题」等 2 处", { exact: true }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/^Claude Code：/)).toHaveCount(1);
    await shot(page, "notice");
    // The status bar says who is connected, and lists the batch as one.
    await footer(page)
      .getByRole("button", { name: /^上次的操作/ })
      .click();
    const item = page.getByRole("listitem", { name: "Claude Code 改了 2 处" });
    await expect(item).toBeVisible();
    await expect(item).toContainText("电脑上的 AI");
    await expect(footer(page).getByRole("button", { name: /^上次的操作/ })).toHaveText(
      "Claude Code 改了 2 处",
    );
    await shot(page, "history");
    await item.getByRole("button", { name: "撤销这次" }).click();
    await expect.poll(() => text(disk, MAIN)).not.toContain("AI 改的标题");
    await expect.poll(() => text(disk, "scenes/title/index.html")).toBe(scene);
    await expect(page.locator('[data-ai-changed][role="option"]')).toHaveCount(0);
    // The settings list who wrote to this project.
    await page.keyboard.press("Escape");
    await openSettingsPage(page, "电脑上的 AI 工具");
    await expect(settingsOf(page).getByTestId("local-ai-uses")).toContainText(
      "Claude Code · 连着 · 1 次任务",
    );
    await shot(page, "settings");
  });

  test("what an AI tool wrote while the editor was not there comes in once it is, as one batch", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const disk = projectOnDisk();
    await openDropped(page, disk);
    await page.goto("about:blank");
    toolWrites(disk, "b2", { [MAIN]: titleNamed(disk, "你不在时改的") }, "codex-mcp-client");
    await page.goBack();
    const notice = page.getByText("你不在时，Codex 改了 1 个文件，已并入");
    await expect(notice).toBeVisible({ timeout: 20_000 });
    await shot(page, "while-away");
    await page.locator("[data-notifications]").getByRole("button", { name: "撤销这次" }).click();
    await expect.poll(() => text(disk, MAIN)).not.toContain("你不在时改的");
  });
});
