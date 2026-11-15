import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  Server,
  inputRequired,
  inputResponse,
  type ClientCapabilities,
  type Implementation,
  type ServerContext,
  type Transport,
} from "@modelcontextprotocol/server";
import { serveStdio, type StdioServerHandle } from "@modelcontextprotocol/server/stdio";
import { mcpInstructions, mcpToolsOf, type ToolResult } from "@animaquill/tools";
import { FolderTools } from "./host.ts";

/**
 * `animaquill mcp`: the tools of AnimaQuill for AI tools on this computer (Claude Code, Codex,
 * Cursor, VS Code, Claude Desktop), over stdio only, on a project folder. It speaks MCP from
 * 2024-11-05 to 2026-07-28 through the official SDK: an `initialize` handshake for clients of 2025,
 * `server/discover` and the envelope of each request for those of 2026. It answers what it is at
 * once and opens the project meanwhile, as Codex gives a server 10 seconds to start.
 */

/** How long a client may keep the list: it is the same for every project of this version. */
const LIST_TTL_MS = 60 * 60 * 1000;

type ObjectSchema = { readonly type: "object" } & Record<string, unknown>;

const asResult = ({ text, isError }: ToolResult) => ({
  content: [{ type: "text" as const, text }],
  isError,
});

/** Who the client is and what it can do: from the envelope of a request, or from `initialize`. */
function clientOf(server: Server, ctx: ServerContext) {
  const envelope = (ctx.mcpReq.envelope ?? {}) as Record<string, unknown>;
  const info =
    (envelope[CLIENT_INFO_META_KEY] as Implementation | undefined) ?? server.getClientVersion();
  const capabilities =
    (envelope[CLIENT_CAPABILITIES_META_KEY] as ClientCapabilities | undefined) ??
    server.getClientCapabilities();
  return { info, capabilities };
}

/** Whether the client asks people with a form: what `aq_propose` needs where there is no editor. */
const asksWithForms = (capabilities: ClientCapabilities | undefined): boolean => {
  const elicitation = capabilities?.elicitation as Record<string, unknown> | undefined;
  // An empty object is the form, from before there were modes.
  return (
    elicitation !== undefined && (Object.keys(elicitation).length === 0 || "form" in elicitation)
  );
};

interface Question {
  readonly question: string;
  readonly options: readonly { readonly label: string; readonly detail?: string }[];
  readonly allow_other?: boolean;
}

/** The question of `aq_propose` as a form: one choice, and words of their own where it allows. */
function formOf({ question, options, allow_other }: Question) {
  return inputRequired.elicit({
    message: question,
    requestedSchema: {
      type: "object",
      properties: {
        choice: {
          type: "string",
          title: "Choice",
          oneOf: options.map(({ label, detail }) => ({
            const: label,
            title: detail ? `${label}: ${detail}` : label,
          })),
        },
        ...(allow_other && {
          other: { type: "string", title: "Something else", maxLength: 500 },
        }),
      },
      ...(!allow_other && { required: ["choice"] }),
    },
  });
}

/** What the user answered in the form, as the result of `aq_propose`. */
function answerOf(question: Question, content: Record<string, unknown> | undefined): string {
  const other = typeof content?.other === "string" ? content.other.trim() : "";
  if (other !== "") return `the user answered in their own words: ${JSON.stringify(other)}`;
  const choice = question.options.find(({ label }) => label === content?.choice);
  return choice
    ? `the user chose ${JSON.stringify(choice.label)}`
    : "the user sent the form without choosing";
}

/**
 * Asks the question of `aq_propose`. The turn belongs to the AI tool, so nothing waits in the editor:
 * the client asks with a form where it can, and otherwise the question is the model's to put.
 */
function propose(tools: FolderTools, server: Server, args: unknown, ctx: ServerContext) {
  const tool = tools.tools.find(({ name }) => name === "aq_propose");
  const invalid = tool?.validate(args);
  if (invalid) return asResult(invalid);
  const question = args as Question;
  if (!asksWithForms(clientOf(server, ctx).capabilities)) {
    return asResult({
      text: "This client cannot show a question card here: the question reaches the user only in your reply, and their answer comes as their next message.",
      isError: false,
    });
  }
  const response = inputResponse(ctx.mcpReq.inputResponses, "answer");
  if (response.kind === "missing")
    return inputRequired({ inputRequests: { answer: formOf(question) } });
  if (response.kind !== "elicit" || response.action !== "accept") {
    return asResult({ text: "the user declined to answer", isError: false });
  }
  return asResult({ text: answerOf(question, response.content), isError: false });
}

/** One server for one connection, around the tools of one project folder. */
export function serverOf(tools: FolderTools, version: string): Server {
  const server = new Server(
    { name: "animaquill", title: "AnimaQuill", version },
    {
      capabilities: { tools: {} },
      instructions: mcpInstructions("folder"),
      cacheHints: { "tools/list": { ttlMs: LIST_TTL_MS, cacheScope: "public" } },
    },
  );
  const list = mcpToolsOf(tools.tools);
  server.setRequestHandler("tools/list", () => ({
    // Every schema of the toolset is an object: the type says only that it is JSON.
    tools: list.map((tool) => ({ ...tool, inputSchema: tool.inputSchema as ObjectSchema })),
  }));
  server.setRequestHandler("tools/call", async (request, ctx) => {
    tools.named(clientOf(server, ctx).info);
    const { name, arguments: args = {} } = request.params;
    if (name === "aq_propose") return propose(tools, server, args, ctx);
    return asResult(await tools.call(name, args));
  });
  return server;
}

export interface McpOptions {
  readonly tools: FolderTools;
  readonly version: string;
  /** Another transport than the stdio of this process, for tests. */
  readonly transport?: Transport;
}

/** Serves MCP on stdio until the client goes, then takes away what says it is connected. */
export function serveMcp({ tools, version, transport }: McpOptions): StdioServerHandle {
  // The project opens while the client gets to know the server.
  void tools.open();
  return serveStdio(() => serverOf(tools, version), {
    ...(transport && { transport }),
    onerror: (error) => console.error(error),
  });
}
