/**
 * What goes out against what the settings show of it, from the second review of model packs: the
 * full text of a pack and the requests, word for word; the ids of calls replayed to another
 * service; reasoning "off". Fetch is stubbed: no service is called.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CallerState,
  checkPack,
  createToolset,
  previewOf,
  usePack,
  type ModelPack,
} from "@animaquill/tools";
import { aiTask, ProblemSet } from "@animaquill/core";
import { browserSystemPrompt, toolSpecsOf } from "./assistant.ts";
import type { ChatEntry } from "./entries.ts";
import { runTask, type Endpoint, type CallSettings, type ToolSpec } from "./pi.ts";

// oxlint-disable-next-line no-explicit-any -- bodies of requests
type Body = Record<string, any>;

const CLAUDE: Endpoint = {
  service: "anthropic",
  protocol: "anthropic-messages",
  baseUrl: "https://api.anthropic.com",
  model: "claude-opus-4-5",
  catalog: "anthropic",
};
const DEEPSEEK: Endpoint = {
  service: "deepseek",
  protocol: "openai-completions",
  baseUrl: "https://api.deepseek.com",
  model: "deepseek-v4-pro",
  catalog: "deepseek",
};

function stub() {
  const sent: Body[] = [];
  vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body ?? "{}")));
    return new Response('{"error":{"type":"x","message":"stub"}}', { status: 400 });
  });
  return sent;
}

async function once(
  endpoint: Endpoint,
  options: {
    system?: string;
    tools?: readonly ToolSpec[];
    call?: CallSettings;
    history?: ChatEntry[];
  },
) {
  const sent = stub();
  await runTask({
    endpoint,
    key: async () => "sk-test",
    system: options.system ?? "S",
    tools: options.tools ?? [],
    ...(options.call && { call: options.call }),
    history: options.history ?? [],
    prompt: "hi",
    signal: new AbortController().signal,
    onEvent: () => {},
  }).catch(() => undefined);
  return sent[0] ?? {};
}

const pack = (manifest: Record<string, unknown>): ModelPack => {
  const { pack: made, problems } = checkPack(
    new Map([
      [
        "pack.json",
        JSON.stringify({ format: 1, id: "m/p", name: "P", version: "1.0.0", ...manifest }),
      ],
    ]),
  );
  if (!made) throw new Error(JSON.stringify(problems));
  return made;
};

describe("全文（previewOf）和真正发出去的", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("[挡住] Anthropic 和 OpenAI 兼容两种请求里，系统提示和每个工具的说明逐字一样，参数的说明也一样", async () => {
    const steady = pack({
      results: "concise",
      system: { extra: "Keep batches small.", guard: { append: "- And be kind." } },
      tools: { aq_search: { description: { append: "Search first." } } },
    });
    for (const [endpoint, model] of [
      [CLAUDE, "claude-opus-4-5"],
      [DEEPSEEK, "deepseek-v4-pro"],
    ] as const) {
      const use = usePack(steady, model);
      // Made as ChatSession makes them: the words of the tools do not depend on the host.
      const host = {
        store: () => undefined,
        origin: () => aiTask("t"),
        problems: () => new ProblemSet(),
        selection: () => undefined,
      };
      const tools = toolSpecsOf(
        createToolset(host, new CallerState(), use.texts, { results: use.results }),
      );
      const body = await once(endpoint, { system: browserSystemPrompt(use.texts), tools });
      const preview = previewOf(steady, model);
      if (endpoint === CLAUDE) {
        const system = (body.system as Body[]).map((block) => block.text).join("");
        expect(system).toBe(preview.system);
        const sentTools = (body.tools as Body[]).filter(
          (tool) => !String(tool.name).startsWith("__pi_"),
        );
        expect(sentTools.map((tool) => tool.name)).toEqual(preview.tools.map((tool) => tool.name));
        for (const [index, tool] of preview.tools.entries()) {
          expect(sentTools[index]?.description).toBe(tool.description);
          // Anthropic's request has the parameters in its own shape (pi converts them): the
          // words of each parameter are the same.
          const said = (schema: unknown) =>
            JSON.stringify(schema)
              .match(/"description":"(?:[^"\\]|\\.)*"/g)
              ?.toSorted();
          expect(said(sentTools[index]?.input_schema)).toEqual(said(tool.inputSchema));
        }
      } else {
        const messages = body.messages as Body[];
        expect(messages[0]?.content).toBe(preview.system);
        const sentTools = body.tools as Body[];
        for (const [index, tool] of preview.tools.entries()) {
          expect(sentTools[index]?.function.description).toBe(tool.description);
          // OpenAI's chat completions take the parameters as they are.
          expect(sentTools[index]?.function.parameters).toEqual(tool.inputSchema);
        }
      }
    }
  });
});

describe("回放的调用 id", () => {
  afterEach(() => vi.unstubAllGlobals());
  const history: ChatEntry[] = [
    { role: "user", text: "加个标记", at: 1 } as ChatEntry,
    {
      role: "assistant",
      text: "",
      calls: [{ id: "call_1|fc_1", name: "echo", args: { at: "1" } }],
      at: 2,
      end: "tools",
      service: "openai",
      protocol: "openai-responses",
      model: "gpt-6.1-sol",
    } as ChatEntry,
    { role: "tool", call: "call_1|fc_1", name: "echo", ok: true, text: "好", at: 3 } as ChatEntry,
    {
      role: "assistant",
      text: "好了",
      calls: [],
      at: 4,
      end: "done",
      service: "openai",
      protocol: "openai-responses",
      model: "gpt-6.1-sol",
    } as ChatEntry,
  ];
  const echo: ToolSpec = {
    name: "echo",
    label: "echo",
    description: "e",
    parameters: { type: "object", properties: { at: { type: "string" } } },
    run: async () => ({ text: "x", isError: false }),
  };

  it("[挡住] 换到 Anthropic：tool_use 和 tool_result 的 id 一致，没有 |", async () => {
    const body = await once(CLAUDE, { tools: [echo], history });
    const text = JSON.stringify(body.messages);
    const use = text.match(/"tool_use","id":"([^"]+)"/)?.[1];
    const result = text.match(/"tool_use_id":"([^"]+)"/)?.[1];
    expect(use).toBe(result);
    expect(use).not.toContain("|");
  });

  it("[挡住] 换到 OpenAI 兼容（DeepSeek）：tool_calls 的 id 和 tool 消息的 id 一致", async () => {
    const body = await once(DEEPSEEK, { tools: [echo], history });
    const messages = body.messages as Body[];
    const call = messages.find((message) => message.tool_calls)?.tool_calls[0]?.id;
    const result = messages.find((message) => message.role === "tool")?.tool_call_id;
    expect(call).toBe(result);
  });
});

describe("推理“关”", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("[挡住] 能关的模型照样关（Claude Opus 4.5：thinking disabled）", async () => {
    const off = await once(CLAUDE, { call: { reasoning: "off" } });
    expect(off.thinking).toEqual({ type: "disabled" });
    const high = await once(CLAUDE, { call: { reasoning: "high" } });
    expect(high.thinking?.type).not.toBe("disabled");
  });
});
