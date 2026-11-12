/**
 * What goes out to GPT-6.1 Sol through the "openai" service (OpenAI's Responses), with fetch
 * stubbed: no key, no call to OpenAI. From the check of GPT-6.1 Sol on 2026-11-12.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatEntry } from "./entries.ts";
import { builtinPacks, choosePack, usePack } from "@animaquill/tools";
import { runTask, type CallSettings, type Endpoint, type RunEvent, type ToolSpec } from "./pi.ts";

// oxlint-disable-next-line no-explicit-any -- the bodies of requests, as JSON
type Body = Record<string, any>;

const SOL: Endpoint = {
  service: "openai",
  protocol: "openai-responses",
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-6.1-sol",
  catalog: "openai",
};

const echo: ToolSpec = {
  name: "marker_add",
  label: "marker.add",
  description: "加标记",
  parameters: {
    type: "object",
    properties: { at: { type: "string" } },
    required: ["at"],
    additionalProperties: false,
  },
  run: async (args) => ({ text: `已加在 ${String(args.at)}`, isError: false }),
};

const sse = (events: Body[]) =>
  events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");

const usage = {
  input_tokens: 10,
  output_tokens: 5,
  total_tokens: 15,
  input_tokens_details: { cached_tokens: 0 },
  output_tokens_details: { reasoning_tokens: 3 },
};

/** Reasoning (encrypted, as stateless mode returns by default) and one call. */
function callAnswer(n: number): string {
  const reasoning = {
    type: "reasoning",
    id: `rs_${n}`,
    summary: [],
    encrypted_content: `enc_${n}`,
  };
  const call = {
    type: "function_call",
    id: `fc_${n}`,
    call_id: `call_${n}`,
    name: "marker_add",
    arguments: '{"at":"1.5"}',
    status: "completed",
  };
  return sse([
    { type: "response.created", response: { id: `resp_${n}`, status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { ...reasoning } },
    { type: "response.output_item.done", output_index: 0, item: reasoning },
    { type: "response.output_item.added", output_index: 1, item: { ...call, arguments: "" } },
    { type: "response.output_item.done", output_index: 1, item: call },
    {
      type: "response.completed",
      response: { id: `resp_${n}`, status: "completed", output: [reasoning, call], usage },
    },
  ]);
}

function textAnswer(n: number, text: string): string {
  const message = {
    type: "message",
    id: `msg_${n}`,
    role: "assistant",
    status: "completed",
    phase: "final_answer",
    content: [{ type: "output_text", text, annotations: [] }],
  };
  return sse([
    { type: "response.created", response: { id: `resp_${n}`, status: "in_progress", output: [] } },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...message, content: [] },
    },
    { type: "response.output_item.done", output_index: 0, item: message },
    {
      type: "response.completed",
      response: { id: `resp_${n}`, status: "completed", output: [message], usage },
    },
  ]);
}

function stub(answers: string[]) {
  const sent: { url: string; body: Body }[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    sent.push({ url, body: JSON.parse(String(init?.body ?? "{}")) });
    const next = answers.shift();
    if (next === undefined) return new Response("{}", { status: 500 });
    return new Response(next, { status: 200, headers: { "content-type": "text/event-stream" } });
  });
  return sent;
}

async function task(options: { call?: CallSettings; history?: ChatEntry[]; tools?: ToolSpec[] }) {
  const events: RunEvent[] = [];
  const result = await runTask({
    endpoint: SOL,
    key: async () => "sk-test-0123456789abcdef",
    system: "SYSTEM PROMPT",
    tools: options.tools ?? [echo],
    ...(options.call && { call: options.call }),
    history: options.history ?? [],
    prompt: "加个标记",
    signal: new AbortController().signal,
    onEvent: (event) => events.push(event),
  });
  const entries = events.flatMap((event) => (event.type === "entry" ? [event.entry] : []));
  return { result, entries: entries as ChatEntry[] };
}

describe("GPT-6.1 Sol through openai-responses", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("with today's settings (none for this model): the shape of the first request", async () => {
    // No pack for it: the default one, which sets nothing.
    const call = usePack(choosePack("gpt-6.1-sol", builtinPacks()).pack, "gpt-6.1-sol").call;
    expect(call).toEqual({});
    const sent = stub([textAnswer(1, "好")]);
    const { result } = await task({ call });
    expect(result).toEqual({ end: "done" });
    const body = sent[0]!.body;
    expect(sent[0]!.url).toBe("https://api.openai.com/v1/responses");
    expect(body.model).toBe("gpt-6.1-sol");
    expect(body.store).toBe(false);
    expect(body.stream).toBe(true);
    // Nothing the model rejects when it reasons.
    expect(body).not.toHaveProperty("temperature");
    expect(body).not.toHaveProperty("top_p");
    expect(body).not.toHaveProperty("top_logprobs");
    expect(body).not.toHaveProperty("parallel_tool_calls");
    expect(body).not.toHaveProperty("prompt_cache_retention");
    // No effort: the model's default (medium); "none" is never sent, since pi's map has off: null.
    expect(body).not.toHaveProperty("reasoning");
    expect(body).not.toHaveProperty("include");
    // Room for the answer: the catalog's 128000, not the 8192 for unknown models.
    expect(body.max_output_tokens).toBeGreaterThan(100_000);
    // The system prompt as a developer message, first.
    // No top-level tools: pi declares them in an additional_tools item at the head of the input.
    expect(body).not.toHaveProperty("tools");
    expect(body.input[0]).toMatchObject({ type: "additional_tools", role: "developer" });
    expect(body.input[0].tools[0]).toMatchObject({
      type: "function",
      name: "marker_add",
      strict: false,
    });
    // Then the system prompt as a developer message.
    expect(body.input[1]).toEqual({ role: "developer", content: "SYSTEM PROMPT" });
  });

  it("with an effort: reasoning.effort, summary auto, and a configuration_update item", async () => {
    const sent = stub([textAnswer(1, "好")]);
    await task({ call: { reasoning: "high" } });
    const body = sent[0]!.body;
    expect(body.reasoning).toEqual({ effort: "medium", summary: "auto" });
    expect(body.include).toEqual(["reasoning.encrypted_content"]);
    expect(body.input.at(-1)).toEqual({
      type: "configuration_update",
      reasoning: { effort: "high" },
    });
  });

  it("with 'off' or 'minimal': the lowest the model has, low, not its default", async () => {
    const sent = stub([textAnswer(1, "好"), textAnswer(2, "好")]);
    await task({ call: { reasoning: "off" } });
    await task({ call: { reasoning: "minimal" } });
    for (const { body } of sent) {
      expect(body.input.at(-1)).toEqual({
        type: "configuration_update",
        reasoning: { effort: "low" },
      });
    }
  });

  it("within a task: the reasoning item, with its encrypted content, goes back with the call", async () => {
    const sent = stub([callAnswer(1), textAnswer(2, "好了")]);
    const { result } = await task({});
    expect(result).toEqual({ end: "done" });
    expect(sent).toHaveLength(2);
    const input = sent[1]!.body.input as Body[];
    const kinds = input.map((item) => item.type ?? item.role);
    expect(kinds).toEqual([
      "additional_tools",
      "developer",
      "user",
      "reasoning",
      "function_call",
      "function_call_output",
    ]);
    expect(input[3]).toMatchObject({ id: "rs_1", encrypted_content: "enc_1" });
    expect(input[4]).toMatchObject({ id: "fc_1", call_id: "call_1" });
    expect(input[5]).toMatchObject({ call_id: "call_1", output: "已加在 1.5" });
  });

  it("the next message, from our own record: calls go back without the id of their item", async () => {
    stub([callAnswer(1), textAnswer(2, "好了")]);
    const first = await task({});
    const history = [{ role: "user", text: "加个标记", at: 1 } as ChatEntry, ...first.entries];
    // The record keeps the id as pi gave it, with the item after "|".
    const calls = first.entries.flatMap((entry) => (entry.role === "assistant" ? entry.calls : []));
    expect(calls.map(({ id }) => id)).toEqual(["call_1|fc_1"]);
    const sent = stub([textAnswer(3, "又好了")]);
    const next = await task({ history });
    expect(next.result).toEqual({ end: "done" });
    const input = sent[0]!.body.input as Body[];
    // The reasoning item is not in our record, so nothing may point at it: OpenAI refuses an fc_
    // item without the reasoning item it was paired with.
    expect(input.some((item) => item.type === "reasoning")).toBe(false);
    const call = input.find((item) => item.type === "function_call");
    expect(call).toMatchObject({ call_id: "call_1", name: "marker_add" });
    expect(call?.id).toBeUndefined();
    expect(input.find((item) => item.type === "function_call_output")).toMatchObject({
      call_id: "call_1",
      output: "已加在 1.5",
    });
    expect(JSON.stringify(input)).not.toContain("fc_1");
  });
});
