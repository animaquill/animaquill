import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatEntry, ToolEntry } from "./entries.ts";
import { supportedLevels } from "./model-discovery.ts";
import {
  applyModelSettings,
  knownModels,
  piModelOf,
  runTask,
  testModel,
  usageOf,
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
    expect(opus?.maxTokens).toEqual(expect.any(Number));
    expect(opus?.cost).toEqual({
      input: expect.any(Number),
      output: expect.any(Number),
      cacheRead: expect.any(Number),
      cacheWrite: expect.any(Number),
    });
    expect(supportedLevels(opus?.reasoning, opus?.thinkingLevelMap)).toContain("high");
  });
});

describe("what an answer took", () => {
  const usage = {
    input: 1000,
    output: 200,
    cacheRead: 5000,
    cacheWrite: 0,
    totalTokens: 6200,
    cost: { input: 0.003, output: 0.003, cacheRead: 0.0015, cacheWrite: 0, total: 0.0075 },
  };
  const model = { contextWindow: 200_000 } as Parameters<typeof usageOf>[1];

  it("has a price only for a model pi lists as itself, or as the service billed it", () => {
    expect(usageOf(usage, model, "listed")).toEqual({
      input: 1000,
      output: 200,
      cacheRead: 5000,
      cacheWrite: 0,
      cost: 0.0075,
      window: 200_000,
    });
    // A close version: its context is the same, its prices may not be.
    expect(usageOf(usage, model, "relative")).toEqual({
      input: 1000,
      output: 200,
      cacheRead: 5000,
      cacheWrite: 0,
      window: 200_000,
    });
    expect(usageOf(usage, model, "unknown")).toEqual({
      input: 1000,
      output: 200,
      cacheRead: 5000,
      cacheWrite: 0,
    });
    const billed = { ...usage, cost: { ...usage.cost, total: 0.01, totalFromProvider: true } };
    expect(usageOf(billed, model, "unknown").cost).toBe(0.01);
  });
});

describe("what people set of a model, as pi gets it", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("goes onto pi's model field by field, each as pi has it", async () => {
    const base = await piModelOf({
      service: "anthropic",
      protocol: "anthropic-messages",
      baseUrl: "https://api.anthropic.com",
      model: "claude-opus-5-5",
      catalog: "anthropic",
    });
    expect(base.thinkingLevelMap).toBeDefined();
    const model = applyModelSettings(base, {
      name: "Opus 自己的名字",
      reasoning: true,
      image: false,
      contextWindow: 300_000,
      maxTokens: 12_345,
      imageMaxBytes: 2_000_000,
      cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 },
      headers: { "x-team": "video" },
      compat: { forceAdaptiveThinking: true, supportsDeveloperRole: false },
      thinkingLevelMap: { off: null, low: "lo", xhigh: "xhigh", max: null },
    });
    expect(model.name).toBe("Opus 自己的名字");
    expect(model.reasoning).toBe(true);
    expect(model.input).toEqual(["text"]);
    expect(model.contextWindow).toBe(300_000);
    expect(model.maxTokens).toBe(12_345);
    expect(model.inputLimits?.images?.resize?.maxBytes).toBe(2_000_000);
    expect(model.cost).toEqual({ input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 });
    expect(model.headers).toMatchObject({ "x-team": "video" });
    expect(model.compat).toMatchObject({
      forceAdaptiveThinking: true,
      supportsDeveloperRole: false,
    });
    // People's map is the whole of it: nothing of pi's stays.
    expect(model.thinkingLevelMap).toEqual({ off: null, low: "lo", xhigh: "xhigh", max: null });
    // Pictures back on, and nothing set is pi's as it was.
    expect(applyModelSettings(base, { image: true }).input).toEqual(["text", "image"]);
    expect(applyModelSettings(base, undefined)).toBe(base);
    expect(applyModelSettings(base, {})).toEqual(base);
  });

  it("is at its own address, by its own protocol, with its size for a model pi does not know", async () => {
    const model = await piModelOf({
      service: "openai-compatible",
      protocol: "anthropic-messages",
      baseUrl: "https://gateway.example/claude",
      model: "team-model",
      settings: {
        contextWindow: 64_000,
        cost: { input: 1, output: 3, cacheRead: 0, cacheWrite: 0 },
      },
    });
    expect(model).toMatchObject({
      id: "team-model",
      api: "anthropic-messages",
      baseUrl: "https://gateway.example/claude",
      contextWindow: 64_000,
      cost: { input: 1, output: 3, cacheRead: 0, cacheWrite: 0 },
    });
  });

  it("sends the step of reasoning as its map says, with people's headers, also through the relay", async () => {
    const sent: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      sent.push({
        url: input instanceof Request ? input.url : String(input),
        headers: new Headers(init?.headers ?? {}),
        body: JSON.parse(String(init?.body ?? "{}")),
      });
      return new Response(
        `data: ${JSON.stringify({
          id: "c",
          object: "chat.completion.chunk",
          created: 1,
          model: "m",
          choices: [{ index: 0, delta: { content: "好" }, finish_reason: "stop" }],
        })}\n\ndata: [DONE]\n\n`,
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    });
    const settings = {
      reasoning: true,
      thinkingLevelMap: { high: "max-effort" },
      headers: { "x-gateway-team": "video" },
      compat: { thinkingFormat: "openai" as never },
    };
    const go = (relay?: Endpoint["relay"]) =>
      runTask({
        endpoint: {
          service: "openai-compatible",
          protocol: "openai-completions",
          baseUrl: "https://gateway.example/v1",
          model: "team-model",
          settings,
          ...(relay && { relay }),
        },
        key: async () => "sk-gateway-0123456789",
        system: "test",
        tools: [],
        history: [],
        prompt: "你好",
        call: { reasoning: "high" },
        signal: new AbortController().signal,
        onEvent: () => {},
      });
    expect(await go()).toEqual({ end: "done" });
    expect(sent[0]?.url).toBe("https://gateway.example/v1/chat/completions");
    expect(sent[0]?.headers.get("x-gateway-team")).toBe("video");
    expect(sent[0]?.body.reasoning_effort).toBe("max-effort");
    expect(
      await go({
        baseUrl: "https://platform.example/api/llm-relay/https/gateway.example/v1",
        headers: { "x-animaquill": "1" },
        passPrefix: "aq-pass-",
      }),
    ).toEqual({ end: "done" });
    expect(sent[1]?.headers.get("aq-pass-x-gateway-team")).toBe("video");
    // A pack's longest answer is no longer than the model's.
    expect(
      await runTask({
        endpoint: {
          service: "openai-compatible",
          protocol: "openai-completions",
          baseUrl: "https://gateway.example/v1",
          model: "team-model",
          settings: { maxTokens: 777 },
        },
        key: async () => "sk-gateway-0123456789",
        system: "test",
        tools: [],
        history: [],
        prompt: "你好",
        call: { maxOutputTokens: 32_000 },
        signal: new AbortController().signal,
        onEvent: () => {},
      }),
    ).toEqual({ end: "done" });
    const body = sent[2]?.body ?? {};
    expect(body.max_completion_tokens ?? body.max_tokens).toBe(777);
    expect(sent[1]?.headers.has("x-gateway-team")).toBe(false);
    expect(sent[1]?.headers.get("x-animaquill")).toBe("1");
  });
});
