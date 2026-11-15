/**
 * What the guide to the AI tools on this computer gives people to copy, and the links that add
 * the local MCP to a tool in one click (docs/design/mcp.md, 6.16a). Each as the tool's own
 * documentation has it, checked 2026-11-15 (guide.test.ts names where):
 *
 * - Claude Code: plugins from a marketplace, and `claude mcp add` (code.claude.com/docs/en/
 *   plugin-marketplaces, /mcp). Its documentation says nothing of `cmd /c` on Windows any more.
 * - Codex: `codex mcp add <name> -- <command>` (learn.chatgpt.com/docs/extend/mcp). It waits 10
 *   seconds for a server to start, which a first `npx` may not make.
 * - Cursor: `cursor://anysphere.cursor-deeplink/mcp/install?name=…&config=<base64 of the server>`
 *   (cursor.com/docs/mcp/install-links), and `mcpServers` in `~/.cursor/mcp.json`.
 * - VS Code: `vscode:mcp/install?<the server as JSON, URL-encoded>` with its `name`
 *   (code.visualstudio.com/api/extension-guides/ai/mcp), and `code --add-mcp '<JSON>'`.
 * - Claude's desktop app: `mcpServers` in `claude_desktop_config.json`, where the documentation
 *   has the same `npx` on Windows (modelcontextprotocol.io/docs/develop/connect-local-servers).
 */

export type GuideTool = "claudeCode" | "codex" | "cursor" | "vscode" | "claudeDesktop" | "other";
export const GUIDE_TOOLS: readonly GuideTool[] = [
  "claudeCode",
  "codex",
  "cursor",
  "vscode",
  "claudeDesktop",
  "other",
];
export const isGuideTool = (value: unknown): value is GuideTool =>
  GUIDE_TOOLS.includes(value as GuideTool);

export type GuideSystem = "windows" | "mac" | "linux";
export const GUIDE_SYSTEMS: readonly GuideSystem[] = ["windows", "mac", "linux"];

/** What the MCP is called in each tool, and how it starts. */
export const SERVER_NAME = "animaquill";
export const SERVER_COMMAND = "npx";
export const SERVER_ARGS: readonly string[] = ["-y", "animaquill@latest", "mcp"];
const SERVER_LINE = `${SERVER_COMMAND} ${SERVER_ARGS.join(" ")}`;

export const NODE_DOWNLOAD = "https://nodejs.org/";

export const COMMANDS = {
  nodeVersion: "node -v",
  marketplace: "claude plugin marketplace add animaquill/animaquill",
  plugin: "claude plugin install animaquill@animaquill",
  claudeServer: `claude mcp add --scope user ${SERVER_NAME} -- ${SERVER_LINE}`,
  claude: "claude",
  codexServer: `codex mcp add ${SERVER_NAME} -- ${SERVER_LINE}`,
  /** Where the first `npx` is too slow for Codex: installed once, it starts at once. */
  installGlobally: "npm install -g animaquill",
  codexInstalled: `codex mcp add ${SERVER_NAME} -- animaquill mcp`,
  codex: "codex",
  other: SERVER_LINE,
  check: "npx animaquill check",
  describe: "npx animaquill describe",
} as const;

/** The manual on a topic, with what stands for the topic. */
export const guideCommand = (topic: string): string => `npx animaquill guide ${topic}`;

/** `--project` with a folder, as a shell takes it. */
export const otherWithProject = (path: string): string => `${SERVER_LINE} --project "${path}"`;

const server = () => ({ command: SERVER_COMMAND, args: [...SERVER_ARGS] });

/** A link that adds the MCP to Cursor: the server itself, without its name, in base64. */
export function cursorLink(): string {
  const config = btoa(JSON.stringify(server()));
  return `cursor://anysphere.cursor-deeplink/mcp/install?name=${SERVER_NAME}&config=${encodeURIComponent(config)}`;
}

/** What goes into `~/.cursor/mcp.json`. */
export const cursorJson = (): string =>
  JSON.stringify({ mcpServers: { [SERVER_NAME]: server() } }, null, 2);

const vscodeServer = () => ({ name: SERVER_NAME, type: "stdio", ...server() });

/** A link that adds the MCP to VS Code: the server with its name, as URL-encoded JSON. */
export const vscodeLink = (): string =>
  `vscode:mcp/install?${encodeURIComponent(JSON.stringify(vscodeServer()))}`;

/**
 * VS Code's command line, for the shells that keep single quotes as they are. The command prompt of
 * Windows does not: there the link does it.
 */
export const vscodeCommand = (): string => `code --add-mcp '${JSON.stringify(vscodeServer())}'`;

/** A path as people copy it: Windows' "复制为路径" puts it in quotes. */
export const cleanPath = (pasted: string): string =>
  pasted
    .trim()
    .replace(/^["']+|["']+$/g, "")
    .trim();

/** What goes into the configuration of Claude's desktop app, for the project at `path`. */
export function desktopConfig(path: string): string {
  const args = [...SERVER_ARGS, "--project", path];
  return JSON.stringify(
    { mcpServers: { [SERVER_NAME]: { command: SERVER_COMMAND, args } } },
    null,
    2,
  );
}

/** Where Claude's desktop app keeps its configuration. */
export const DESKTOP_CONFIG: Readonly<Record<GuideSystem, string>> = {
  windows: "%APPDATA%\\Claude\\claude_desktop_config.json",
  mac: "~/Library/Application Support/Claude/claude_desktop_config.json",
  linux: "~/.config/Claude/claude_desktop_config.json",
};

/** The system of this computer, from what the browser says about it. */
export function systemOf(platform: string): GuideSystem {
  const name = platform.toLowerCase();
  if (name.includes("win")) return "windows";
  if (name.includes("mac") || name.includes("iphone") || name.includes("ipad")) return "mac";
  return "linux";
}

/** What the browser says the system is. */
export function systemHere(): GuideSystem {
  const data = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData;
  return systemOf(data?.platform || navigator.platform || navigator.userAgent);
}
