import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatEntry, ToolEntry } from "./entries.ts";
import {
  knownModels,
  runTask,
  testModel,
  type Endpoint,
  type FakeEndpoint,
  type RunEvent,
  type ToolSpec,
} from "./pi.ts";

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

function run(endpoint: FakeEndpoint, options: Partial<Parameters<typeof runTask>[0]> = {}) {
  const events: RunEvent[] = [];
  const done = runTask({
    endpoint,
    key: async () => "sk-test-0123456789abcdef",
    system: "test",
    tools: [echo],
    history: [],
    prompt: "go",
    signal: new AbortController().signal,
    onEvent: (event) => events.push(event),
    ...options,
  });
  const entries = () =>
    events.flatMap((event) => (event.type === "entry" ? [event.entry] : [])) as ChatEntry[];
  return { done, events, entries };
}

describe("the wrapper of pi", () => {
  it("streams the answer and keeps it in our own shape", async () => {
    const endpoint: FakeEndpoint = { fake: [{ text: "你好，世界" }], charactersPerSecond: 500 };
    const { done, events, entries } = run(endpoint);
    expect(await done).toEqual({ end: "done" });
    const deltas = events.filter((event) => event.type === "text");
    expect(deltas.length).toBeGreaterThan(1);
    expect(entries()).toMatchObject([{ role: "assistant", text: "你好，世界", end: "done" }]);
  });

  it("runs tools, gives their results back, and goes on", async () => {
    let read: readonly ToolEntry[] = [];
    const endpoint: FakeEndpoint = {
      fake: [
        { text: "我加一下。", calls: [{ name: "marker_add", args: { at: "1.5" } }] },
        (results) => {
          read = results;
          return { text: "好了" };
        },
      ],
    };
    const { done, entries } = run(endpoint);
    expect(await done).toEqual({ end: "done" });
    expect(read).toMatchObject([{ name: "marker_add", ok: true, text: "已加在 1.5" }]);
    expect(entries().map((entry) => entry.role)).toEqual(["assistant", "tool", "assistant"]);
    expect(entries()[0]).toMatchObject({ end: "tools", calls: [{ name: "marker_add" }] });
    expect(endpoint.requests).toBe(2);
  });

  it("gives arguments that do not fit back to AI without running the tool", async () => {
    let ran = false;
    const strict: ToolSpec = {
      ...echo,
      run: async () => ((ran = true), { text: "ran", isError: false }),
    };
    let read: readonly ToolEntry[] = [];
    const endpoint: FakeEndpoint = {
      fake: [
        { calls: [{ name: "marker_add", args: { when: "1" } }] },
        (results) => ((read = results), { text: "知道了" }),
      ],
    };
    await run(endpoint, { tools: [strict] }).done;
    expect(ran).toBe(false);
    expect(read[0]?.ok).toBe(false);
    expect(read[0]?.text).toMatch(/at/);
  });

  it("asks before each tool, and can end the task", async () => {
    const endpoint: FakeEndpoint = {
      fake: [
        { calls: [{ name: "marker_add", args: { at: "1" } }] },
        { calls: [{ name: "marker_add", args: { at: "2" } }] },
        { text: "不该到这里" },
      ],
    };
    let asked = 0;
    const { done, entries } = run(endpoint, {
      before: () => (++asked > 1 ? { reason: "够了", stop: true } : undefined),
      enough: () => asked >= 2,
    });
    expect(await done).toEqual({ end: "tools" });
    const results = entries().filter((entry) => entry.role === "tool");
    expect(results.map((entry) => entry.ok)).toEqual([true, false]);
    expect(results[1]?.text).toContain("够了");
    expect(endpoint.requests).toBe(2);
  });

  it("stops when asked, in the middle of an answer", async () => {
    const controller = new AbortController();
    const endpoint: FakeEndpoint = {
      fake: [{ text: "很长的回答。".repeat(200) }],
      charactersPerSecond: 200,
    };
    const { done, events } = run(endpoint, { signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 100));
    controller.abort();
    const started = performance.now();
    expect(await done).toEqual({ end: "stopped" });
    expect(performance.now() - started).toBeLessThan(500);
    expect(events.some((event) => event.type === "text")).toBe(true);
  });

  it("says what went wrong without the key", async () => {
    const endpoint: FakeEndpoint = {
      fake: [{ error: "401 Incorrect API key provided: sk-test-0123456789abcdef" }],
    };
    const { done, entries } = run(endpoint);
    const result = await done;
    expect(result.end).toBe("failed");
    expect(result.error).toContain("401");
    expect(result.error).not.toContain("0123456789abcdef");
    expect(JSON.stringify(entries())).not.toContain("0123456789abcdef");
  });

  it("goes on from a conversation kept in our own shape", async () => {
    const history: ChatEntry[] = [
      { role: "user", text: "加个标记", at: 1, task: "a" },
      {
        role: "assistant",
        text: "",
        calls: [{ id: "call-1", name: "marker_add", args: { at: "1" } }],
        at: 2,
        end: "tools",
        service: "fake",
        protocol: "faux",
        model: "fake",
      },
      { role: "tool", call: "call-1", name: "marker_add", ok: true, text: "已加在 1", at: 3 },
      {
        role: "assistant",
        text: "加好了",
        calls: [],
        at: 4,
        end: "done",
        service: "fake",
        protocol: "faux",
        model: "fake",
      },
      // Stopped halfway: pi leaves it out of what the service gets.
      { role: "user", text: "再加", at: 5, task: "b" },
      {
        role: "assistant",
        text: "",
        calls: [{ id: "call-2", name: "marker_add", args: { at: "2" } }],
        at: 6,
        end: "stopped",
        service: "fake",
        protocol: "faux",
        model: "fake",
      },
    ];
    const endpoint: FakeEndpoint = { fake: [{ text: "接着来" }] };
    const { done } = run(endpoint, { history });
    expect(await done).toEqual({ end: "done" });
  });
});

describe("a service through the relay of the platform", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** What an OpenAI-compatible service streams for an answer. */
  const streamed = (words: readonly string[]) =>
    [
      ...words.map(
        (word) =>
          `data: ${JSON.stringify({
            id: "c",
            object: "chat.completion.chunk",
            created: 1,
            model: "kimi-k2",
            choices: [{ index: 0, delta: { content: word }, finish_reason: null }],
          })}\n\n`,
      ),
      `data: ${JSON.stringify({
        id: "c",
        object: "chat.completion.chunk",
        created: 1,
        model: "kimi-k2",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      })}\n\n`,
      "data: [DONE]\n\n",
    ].join("");

  it("goes to the relay, with what it needs, and is still the service it is", async () => {
    const sent: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      sent.push({
        url,
        headers: new Headers(init?.headers ?? (input instanceof Request ? input.headers : {})),
        body: JSON.parse(String(init?.body ?? "{}")),
      });
      return new Response(streamed(["你好", "，世界"]), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    });
    const endpoint: Endpoint = {
      service: "moonshot",
      protocol: "openai-completions",
      baseUrl: "https://api.moonshot.cn/v1",
      model: "kimi-k2",
      catalog: "moonshotai-cn",
      relay: {
        baseUrl: "https://platform.example/api/llm-relay/https/api.moonshot.cn/v1",
        headers: { "x-animaquill": "1" },
      },
    };
    const events: RunEvent[] = [];
    const result = await runTask({
      endpoint,
      key: async () => "sk-moonshot-0123456789",
      system: "test",
      tools: [echo],
      history: [],
      prompt: "你好",
      signal: new AbortController().signal,
      onEvent: (event) => events.push(event),
    });
    expect(result).toEqual({ end: "done" });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe(
      "https://platform.example/api/llm-relay/https/api.moonshot.cn/v1/chat/completions",
    );
    expect(sent[0]?.headers.get("x-animaquill")).toBe("1");
    expect(sent[0]?.headers.get("authorization")).toBe("Bearer sk-moonshot-0123456789");
    // Moonshot's ways, which pi knows from its address: max_tokens, and no store.
    expect(sent[0]?.body).toHaveProperty("max_tokens");
    expect(sent[0]?.body).not.toHaveProperty("max_completion_tokens");
    expect(sent[0]?.body).not.toHaveProperty("store");
    const entry = events.find((event) => event.type === "entry");
    expect(entry?.type === "entry" && entry.entry).toMatchObject({
      role: "assistant",
      text: "你好，世界",
      service: "moonshot",
    });
  });

  it("goes straight without it, with nothing of the relay", async () => {
    const sent: { url: string; headers: Headers }[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      sent.push({
        url: input instanceof Request ? input.url : String(input),
        headers: new Headers(init?.headers ?? {}),
      });
      return new Response(streamed(["好"]), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    });
    const result = await runTask({
      endpoint: {
        service: "deepseek",
        protocol: "openai-completions",
        baseUrl: "https://api.deepseek.com",
        model: "deepseek-chat",
        catalog: "deepseek",
      },
      key: async () => "sk-deepseek-0123456789",
      system: "test",
      tools: [],
      history: [],
      prompt: "你好",
      signal: new AbortController().signal,
      onEvent: () => {},
    });
    expect(result).toEqual({ end: "done" });
    expect(sent[0]?.url).toBe("https://api.deepseek.com/chat/completions");
    expect(sent[0]?.headers.has("x-animaquill")).toBe(false);
  });

  it("tests a model with a word, the way the chat goes, and says what went wrong without the key", async () => {
    const KEY = "sk-moonshot-0123456789SECRET";
    const sent: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
    let refuse = false;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      sent.push({
        url: input instanceof Request ? input.url : String(input),
        headers: new Headers(init?.headers ?? {}),
        body: JSON.parse(String(init?.body ?? "{}")),
      });
      if (refuse) {
        return new Response(JSON.stringify({ error: { message: `Invalid key ${KEY}` } }), {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(streamed(["OK"]), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    });
    const endpoint: Endpoint = {
      service: "moonshot",
      protocol: "openai-completions",
      baseUrl: "https://api.moonshot.cn/v1",
      model: "kimi-k3",
      catalog: "moonshotai-cn",
      relay: {
        baseUrl: "https://platform.example/api/llm-relay/https/api.moonshot.cn/v1",
        headers: { "x-animaquill": "1" },
      },
    };
    const passed = await testModel(endpoint, KEY);
    expect(passed).toMatchObject({ ok: true, text: "OK" });
    expect(sent[0]?.url).toBe(
      "https://platform.example/api/llm-relay/https/api.moonshot.cn/v1/chat/completions",
    );
    expect(sent[0]?.headers.get("x-animaquill")).toBe("1");
    expect(sent[0]?.body).toMatchObject({ max_tokens: 16 });
    expect(JSON.stringify(sent[0]?.body.messages)).toContain("Reply with OK only.");

    refuse = true;
    const failed = await testModel(endpoint, KEY);
    expect(failed.ok).toBe(false);
    expect(!failed.ok && failed.error).toMatch(/401/);
    expect(JSON.stringify(failed)).not.toContain("SECRET");
    // No retry: one request each.
    expect(sent).toHaveLength(2);
  });

  it("knows what pi knows of models: how much they read, price, thinking and pictures", async () => {
    const models = await knownModels("anthropic", "anthropic-messages");
    const opus = models.find(({ id }) => id === "claude-opus-5-5");
    expect(opus).toMatchObject({
      name: expect.any(String),
      contextWindow: expect.any(Number),
      cost: { input: expect.any(Number), output: expect.any(Number) },
      reasoning: true,
      image: true,
    });
    expect(opus?.levels).toContain("high");
  });
});
