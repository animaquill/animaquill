/**
 * AI tools on this computer through `animaquill mcp`, whose calls run in the editor that has the
 * project open (docs/design/online-offline.md of AnimaQuill Cloud, 5): the real server, started by
 * an MCP client as Claude Code and Codex start it, its relay, and the editor of `npx animaquill`,
 * which connects to the relay once people ask for it in the guide. Each test has ports of its own
 * (`ANIMAQUILL_RELAY_PORTS`, and `animaquill.mcp.ports` in the page), and a home of its own for the
 * identity of the relay.
 */
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type { Page } from "@playwright/test";
import { footer, openDropped, projectOnDisk } from "../../ui/e2e/folder-support.ts";
import { chooseFromMenu, expect, test } from "../../ui/e2e/support.ts";

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

test.use({ devPage: false, folders: true, withProject: false });

/** Ports of the test's own: none of another worker's, nor the ones people's relays have. */
const portsOf = (worker: number, index: number) => ({
  first: 48_500 + worker * 40 + index * 8,
  count: 4,
});

interface Tools {
  readonly home: string;
  /** What the browser was asked to open, one address a line: see `ANIMAQUILL_OPEN`. */
  readonly opened: string;
  readonly ports: { readonly first: number; readonly count: number };
  readonly clients: Client[];
}

/** An AI tool that starts `animaquill mcp`, in a folder, as Claude Code or Codex does. */
async function startTool(
  tools: Tools & { readonly opener: string },
  name: string,
  cwd: string,
  args: readonly string[] = [],
): Promise<Client> {
  const client = new Client({ name, version: "9.9.9" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [CLI, "mcp", ...args],
      cwd,
      env: {
        ...(process.env as Record<string, string>),
        ANIMAQUILL_HOME: tools.home,
        ANIMAQUILL_RELAY_PORTS: `${tools.ports.first}:${tools.ports.count}`,
        ANIMAQUILL_TEST: "1",
        ANIMAQUILL_OPEN: tools.opener,
      },
      stderr: "ignore",
    }),
  );
  tools.clients.push(client);
  // The first call of a client finds the relay, or makes it.
  await client.listTools();
  return client;
}

function toolsFor(worker: number, index: number): Tools & { readonly opener: string } {
  const home = mkdtempSync(join(tmpdir(), "animaquill-home-"));
  const opened = join(home, "opened.txt");
  // In place of the browser: notes the address it gets.
  const opener = join(home, "open.cjs");
  writeFileSync(
    opener,
    `#!/usr/bin/env node\nrequire("node:fs").appendFileSync(${JSON.stringify(opened)}, process.argv[2] + "\\n");\n`,
  );
  chmodSync(opener, 0o755);
  return { home, opened, opener, ports: portsOf(worker, index), clients: [] };
}

const openedIn = (tools: Tools) =>
  existsSync(tools.opened) ? readFileSync(tools.opened, "utf8").split("\n").filter(Boolean) : [];

const textOf = (result: unknown) =>
  (result as { content: { type: string; text?: string }[] }).content.findLast(
    ({ type }) => type === "text",
  )?.text ?? "";

const guide = (page: Page) => page.getByTestId("local-ai-guide");

/** Connects the editor from the guide, as people do, and closes the guide. */
async function connectEditor(page: Page, tools: Tools): Promise<void> {
  await page.evaluate(
    (ports) => localStorage.setItem("animaquill.mcp.ports", ports),
    `${tools.ports.first}:${tools.ports.count}`,
  );
  await chooseFromMenu(page, "帮助", "连接电脑上的 AI 工具");
  await guide(page).getByTestId("local-ai-connect-button").click();
  await expect(guide(page).getByTestId("local-ai-connect")).toContainText(
    "已连接电脑上的 AI 工具",
    { timeout: 15_000 },
  );
}

test.describe("AI tools on this computer", () => {
  test("run every tool in the editor that has the project, two at once, each a batch of its own", async ({
    page,
  }, info) => {
    test.slow();
    const tools = toolsFor(info.workerIndex, 0);
    try {
      const disk = projectOnDisk();
      await openDropped(page, disk);
      const claude = await startTool(tools, "claude-code", disk);
      const elsewhere = mkdtempSync(join(tmpdir(), "animaquill-elsewhere-"));
      const codex = await startTool(tools, "codex-mcp-client", elsewhere, ["--project", disk]);
      await connectEditor(page, tools);
      await expect(guide(page).getByTestId("local-ai-connected")).toContainText(
        /(Claude Code|Codex) 连着这个项目/,
        { timeout: 15_000 },
      );
      await guide(page).getByRole("button", { name: "好了" }).click();

      const call = async (client: Client, name: string, args: Record<string, unknown>) => {
        const result = await client.callTool({ name, arguments: args });
        expect(result.isError, `${name}: ${textOf(result)}`).toBeFalsy();
        return { text: textOf(result), result };
      };
      // Every tool of the list, through MCP, in the editor.
      const { tools: listed } = await claude.listTools();
      expect(listed).toHaveLength(17);
      const status = await call(claude, "aq_project_status", {});
      expect(status.text).toMatch(/^project: "原子是什么" \(offline, the folder .+\)\n/);
      const timeline = await call(claude, "aq_timeline_read", { timeline: "main" });
      const clip = /\b(clip_[a-z0-9_]+)/.exec(timeline.text)?.[1] ?? "";
      await call(claude, "aq_object_read", { ids: [clip], timeline: "main" });
      await call(claude, "aq_search", { query: "title" });
      const file = await call(claude, "aq_file_read", { path: "scenes/title/index.html" });
      expect(file.text).toContain("<");
      // What the editor shows: there is an editor now.
      await call(claude, "aq_selection_read", { at: "now" });
      await call(claude, "aq_guide", { topic: "ops/clip.move" });
      await call(claude, "aq_edit", {
        operations: [{ op: "clip.update", timeline: "main", clip, changes: { name: "AI 改的" } }],
      });
      await expect(page.getByText(/^Claude Code：/)).toBeVisible({ timeout: 15_000 });
      await call(claude, "aq_file_write", { path: "code/ai.js", text: "export const a = 1;\n" });
      await call(claude, "aq_file_edit", {
        path: "code/ai.js",
        edits: [{ old_text: "a = 1", new_text: "a = 2" }],
      });
      const plan = await call(claude, "aq_propose", {
        kind: "plan",
        title: "片头",
        steps: [{ text: "淡入" }],
      });
      expect(plan.text).toMatch(/no plan card/);
      // Seeing and hearing, which only an editor can.
      const frames = await claude.callTool({
        name: "aq_render_frames",
        arguments: { timeline: "main", times: ["0"] },
      });
      expect(textOf(frames)).not.toMatch(/not-available|editor-hidden/);
      const heard = await claude.callTool({
        name: "aq_audio_analyze",
        arguments: { timeline: "main", range: { from: "0", to: "2" } },
      });
      expect(textOf(heard)).not.toMatch(/not-available/);
      await call(claude, "aq_check_run", {});

      // Another tool, another batch: taken back on its own, and the first one's stays.
      await call(codex, "aq_timeline_read", { timeline: "main" });
      // Each sees the other, and words go to the other with its next call, marked as not the user's.
      const others = await call(claude, "aq_agents_list", {});
      const codexName = /"([^"]+)" \(tool\)/.exec(others.text)?.[1] ?? "";
      expect(codexName).not.toBe("");
      const sent = await call(claude, "aq_send", { to: codexName, message: "我在改片段，别动它" });
      expect(sent.text).toContain("it is an AI tool, which reads it with its next call");
      const second = await codex.callTool({
        name: "aq_edit",
        arguments: { operations: [{ op: "project.rename", name: "Codex 改的" }] },
      });
      expect(second.isError, textOf(second)).toBeFalsy();
      expect(textOf(second)).toContain("It is not the user");
      expect(textOf(second)).toContain("我在改片段，别动它");
      // An AI tool cannot say when it is idle.
      const notify = await claude.callTool({
        name: "aq_agents_notify",
        arguments: { to: codexName },
      });
      expect(textOf(notify)).toMatch(/^error not-available/);
      const told = page.getByText(/^Codex：/);
      await expect(told).toBeVisible({ timeout: 15_000 });
      await expect(footer(page).getByText("Codex 改的")).toBeVisible();
      await page
        .locator("[data-notifications] > div > div", { hasText: /^Codex：/ })
        .getByRole("button", { name: "撤销这次" })
        .click();
      await expect(footer(page).getByText("原子是什么")).toBeVisible();
      // In the folder too, as the editor writes it.
      await expect
        .poll(() => JSON.parse(readFileSync(join(disk, "animaquill.json"), "utf8")).name)
        .toBe("原子是什么");
      const after = await call(claude, "aq_object_read", { ids: [clip], timeline: "main" });
      expect(after.text).toContain("AI 改的");
    } finally {
      await Promise.all(tools.clients.map((client) => client.close()));
    }
  });

  test("a page that opens connects to nothing, and frames wait for the editor in front", async ({
    page,
  }, info) => {
    const tools = toolsFor(info.workerIndex, 1);
    // Every WebSocket the page makes, from before it starts.
    await page.addInitScript(() => {
      const made: string[] = [];
      (window as unknown as { madeSockets: string[] }).madeSockets = made;
      const Native = window.WebSocket;
      window.WebSocket = class extends Native {
        constructor(url: string | URL, protocols?: string | string[]) {
          made.push(String(url));
          super(url, protocols);
        }
      } as typeof WebSocket;
    });
    try {
      const disk = projectOnDisk();
      const claude = await startTool(tools, "claude-code", disk);
      await page.reload();
      await openDropped(page, disk);
      await page.waitForTimeout(2_500);
      const made = () =>
        page.evaluate(() => (window as unknown as { madeSockets: string[] }).madeSockets);
      expect((await made()).filter((url) => url.includes("127.0.0.1"))).toEqual([]);
      const nothing = await claude.callTool({ name: "aq_project_status", arguments: {} });
      expect(textOf(nothing)).toMatch(/^error editor-not-open: /);
      await connectEditor(page, tools);
      await guide(page)
        .getByRole("button", { name: /好了|关闭/ })
        .last()
        .click();
      // In the background: reading goes on, frames do not.
      await page.evaluate(() => {
        Object.defineProperty(document, "visibilityState", { get: () => "hidden" });
        document.dispatchEvent(new Event("visibilitychange"));
      });
      const read = await claude.callTool({
        name: "aq_timeline_read",
        arguments: { timeline: "main" },
      });
      expect(read.isError, textOf(read)).toBeFalsy();
      const frames = await claude.callTool({
        name: "aq_render_frames",
        arguments: { timeline: "main", times: ["0"] },
      });
      expect(textOf(frames)).toMatch(/^error editor-hidden: /m);
    } finally {
      await Promise.all(tools.clients.map((client) => client.close()));
    }
  });

  test("open the editor on the folder that none has open, once, and run there once it is", async ({
    page,
  }, info) => {
    test.slow();
    const tools = toolsFor(info.workerIndex, 2);
    try {
      const disk = projectOnDisk();
      await openDropped(page, disk);
      const id = JSON.parse(readFileSync(join(disk, "animaquill.json"), "utf8")).id as string;
      const claude = await startTool(tools, "claude-code", disk);
      // Connected once: the relay knows which site the editor is on.
      await connectEditor(page, tools);
      // And no editor any more.
      const editor = new URL(page.url());
      await page.goto("about:blank");
      const said: string[] = [];
      const waited = await claude.callTool(
        { name: "aq_project_status", arguments: {} },
        { onprogress: (progress) => said.push(progress.message ?? ""), timeout: 60_000 },
      );
      expect(textOf(waited)).toMatch(/^error editor-opening: .*being opened in the browser/);
      expect(said.join("\n")).toMatch(/opening the AnimaQuill editor/);
      const [address] = openedIn(tools);
      const expected = new URL("/offline", editor.origin);
      expected.searchParams.set("open", id);
      expected.searchParams.set("name", "原子是什么");
      expect(address).toBe(expected.href);
      // Once a session.
      await claude.callTool({ name: "aq_project_status", arguments: {} }, { timeout: 60_000 });
      expect(openedIn(tools)).toHaveLength(1);
      // The browser opens it: the folder opens, and the address forgets what it was for.
      await page.goto(address ?? "");
      await expect(footer(page).getByText("原子是什么")).toBeVisible({ timeout: 15_000 });
      expect(new URL(page.url()).searchParams.has("open")).toBe(false);
      await connectEditor(page, tools);
      const ran = await claude.callTool({ name: "aq_project_status", arguments: {} });
      expect(ran.isError, textOf(ran)).toBeFalsy();
    } finally {
      await Promise.all(tools.clients.map((client) => client.close()));
    }
  });

  test("tell the editor that is open what they wait for, once for two, and open nothing", async ({
    page,
  }, info) => {
    test.slow();
    const tools = toolsFor(info.workerIndex, 3);
    try {
      const disk = projectOnDisk();
      await openDropped(page, disk);
      const claude = await startTool(tools, "claude-code", disk);
      const codex = await startTool(tools, "codex-mcp-client", disk);
      // The editor goes back to its start page, connected.
      await page.goto("/offline");
      await connectEditor(page, tools);
      await guide(page)
        .getByRole("button", { name: /好了|关闭/ })
        .last()
        .click();
      const calls = [claude, codex].map((client) =>
        client.callTool({ name: "aq_project_status", arguments: {} }, { timeout: 60_000 }),
      );
      const notice = page.locator("[data-notifications] > div > div", {
        hasText: "2 个 AI 工具在等「原子是什么」",
      });
      await expect(notice).toBeVisible({ timeout: 15_000 });
      await expect(
        page.locator("[data-notifications] > div > div", { hasText: "在等「原子是什么」" }),
      ).toHaveCount(1);
      await notice.getByRole("button", { name: "打开" }).click();
      await expect(footer(page).getByText("原子是什么")).toBeVisible({ timeout: 15_000 });
      for (const result of await Promise.all(calls))
        expect(result.isError, textOf(result)).toBeFalsy();
      await expect(notice).toBeHidden();
      expect(openedIn(tools)).toEqual([]);
    } finally {
      await Promise.all(tools.clients.map((client) => client.close()));
    }
  });
});
