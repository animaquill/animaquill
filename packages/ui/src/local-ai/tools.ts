/** Who an AI tool on this computer is, as MCP says it (`clientInfo`). */
export interface ToolClient {
  readonly name: string;
  readonly version?: string | undefined;
}

/** The AI tools the editor knows by name; any other goes by the name it gives itself. */
export type KnownTool = "claudeCode" | "codex" | "cursor" | "vscode" | "claudeDesktop";

/**
 * Which AI tool a client is, by the name it gives itself in `initialize`. Claude Code says
 * "claude-code", Cursor "cursor-vscode", Claude's apps "claude-ai"; the others as their names go.
 */
export function knownTool(client: ToolClient | undefined): KnownTool | undefined {
  const name = client?.name.toLowerCase() ?? "";
  if (name.includes("claude-code") || name.includes("claude code")) return "claudeCode";
  if (name.includes("codex")) return "codex";
  if (name.includes("cursor")) return "cursor";
  if (name.includes("visual studio code") || name.includes("vscode") || name === "vs code") {
    return "vscode";
  }
  if (name.startsWith("claude")) return "claudeDesktop";
  return undefined;
}

/** An AI tool connected to the project open in this window. */
export interface ToolConnection {
  readonly session: string;
  readonly client: ToolClient | undefined;
  readonly startedAt: number;
}

/** Who changed the project lately, as the settings list it. */
export interface ToolUse {
  readonly client: ToolClient | undefined;
  readonly lastAt: number;
  readonly batches: number;
}
