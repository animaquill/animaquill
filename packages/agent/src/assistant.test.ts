import { ProblemSet, ProjectStore, aiTask } from "@animaquill/core";
import { createProject } from "@animaquill/schema";
import { CallerState, createToolset } from "@animaquill/tools";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_DATA, keptData, toolSpecsOf } from "./assistant.ts";
import { callSettingsFor } from "./models.ts";
import type { ChatEntry, ToolEntry } from "./entries.ts";
import { runTask, type Endpoint, type FakeEndpoint, type RunEvent, type ToolSpec } from "./pi.ts";
import type { Protocol } from "./services.ts";

type Node = Record<string, unknown>;

const callers = new WeakMap<readonly ToolSpec[], CallerState>();

function project() {
  const store = ProjectStore.create(createProject({ name: "助手" }));
  const caller = new CallerState();
  const tools = toolSpecsOf(
    createToolset(
      { store: () => store, origin: () => aiTask("t"), problems: () => new ProblemSet() },
      caller,
    ),
  );
  callers.set(tools, caller);
  return { store, caller, tools };
}

/** A new answer of the model, for the caller of these tools. */
const answerOf = (tools: readonly ToolSpec[]) => callers.get(tools)?.beginAnswer();

function run(
  endpoint: FakeEndpoint,
  tools: readonly ToolSpec[],
  extra: Partial<Parameters<typeof runTask>[0]> = {},
) {
  const events: RunEvent[] = [];
  const done = runTask({
    endpoint,
    key: async () => undefined,
    system: "test",
    tools,
    history: [],
    prompt: "go",
    signal: new AbortController().signal,
    onEvent: (event) => events.push(event),
    ...extra,
  });
  const entries = () =>
    events.flatMap((event) => (event.type === "entry" ? [event.entry] : [])) as ChatEntry[];
  return { done, events, entries };
}

const markers = (store: ProjectStore) =>
  Object.values(store.getState().timelines.main?.markers ?? {});

describe("the tools in the agent", () => {
  it("check a call themselves first: the model reads their error, not pi's", async () => {
    const { tools } = project();
    let read: readonly ToolEntry[] = [];
    const endpoint: FakeEndpoint = {
      fake: [
        {
          calls: [
            {
              name: "aq_edit",
              args: { operations: [{ op: "marker.add", timeline: "main", tme: "1" }] },
            },
          ],
        },
        (results) => ((read = results), { text: "好" }),
      ],
    };
    await run(endpoint, tools).done;
    expect(read[0]?.ok).toBe(false);
    expect(read[0]?.text).toContain("error invalid-params in operations[0] (marker.add)");
    expect(read[0]?.text).toContain('unknown parameter "tme"; did you mean "time"?');
  });

  it("hold back the changes after a call that did not fit, in the same answer", async () => {
    const { store, tools } = project();
    const add = (time: unknown) => ({
      name: "aq_edit",
      args: { operations: [{ op: "marker.add", timeline: "main", time }] },
    });
    let read: readonly ToolEntry[] = [];
    const endpoint: FakeEndpoint = {
      fake: [
        { calls: [{ name: "aq_timeline_read", args: {} }] },
        { calls: [add(1), add("2")] },
        (results) => ((read = [...results]), { calls: [add("3")] }),
        { text: "好" },
      ],
    };
    // Each answer begins anew: what failed in one holds back nothing in the next.
    await run(endpoint, tools, { onAnswer: () => answerOf(tools) }).done;
    expect(read.slice(1).map((entry) => entry.text.split("\n")[0])).toEqual([
      "error invalid-params in operations[0] (marker.add)",
      "error not-run: an earlier change in this answer failed, so this one was not run; the same call in a later answer runs. Nothing was written.",
    ]);
    expect(markers(store).map((marker) => marker.time)).toEqual(["3"]);
  });

  it("end the turn after the tools of an answer that asks the user, and keep what they found", async () => {
    const { tools } = project();
    const endpoint: FakeEndpoint = {
      fake: [
        {
          calls: [
            {
              name: "aq_propose",
              args: {
                kind: "question",
                question: "哪种颜色？",
                options: [{ label: "蓝" }, { label: "红" }],
              },
            },
          ],
        },
        { text: "不该到这里" },
      ],
    };
    const { done, entries } = run(endpoint, tools);
    expect((await done).end).toBe("tools");
    expect(endpoint.requests).toBe(1);
    const result = entries().find((entry) => entry.role === "tool");
    expect(result).toMatchObject({
      role: "tool",
      ok: true,
      data: { question: { question: "哪种颜色？" } },
    });
  });

  it("says when each answer begins, and what the model said of its thinking", async () => {
    const { tools } = project();
    let answers = 0;
    const endpoint: FakeEndpoint = {
      fake: [
        { thinking: "先看看时间轴。", calls: [{ name: "aq_timeline_read", args: {} }] },
        { thinking: "  ", text: "看完了" },
      ],
    };
    const { done, events, entries } = run(endpoint, tools, {
      onAnswer: () => (answers += 1),
      stamp: {
        toolset: "2026.1",
        texts: { id: "animaquill/default", version: "2026.1", hash: "h" },
      },
    });
    await done;
    expect(answers).toBe(2);
    expect(
      events
        .filter((event) => event.type === "thinking")
        .map((event) => (event as { delta: string }).delta)
        .join("")
        .trim(),
    ).toBe("先看看时间轴。");
    const said = entries().filter((entry) => entry.role === "assistant");
    expect(said[0]).toMatchObject({
      thinking: "先看看时间轴。",
      toolset: "2026.1",
      texts: { id: "animaquill/default" },
    });
    expect(said[1]).not.toHaveProperty("thinking");
  });
});

/** An earlier conversation, with calls of the tools before these, and its results. */
const OLD: readonly ChatEntry[] = [
  { role: "user", text: "加一个标记", at: 1, task: "a" },
  {
    role: "assistant",
    text: "我加一下。",
    calls: [
      { id: "c1", name: "marker_add", args: { timeline: "main", time: "1" } },
      { id: "c2", name: "project_overview", args: {} },
    ],
    at: 2,
    end: "tools",
    service: "anthropic",
    protocol: "anthropic-messages",
    model: "claude-sonnet-4-5",
  },
  {
    role: "tool",
    call: "c1",
    name: "marker_add",
    ok: true,
    text: '{"ok":true,"result":{"id":"marker_1"}}',
    at: 3,
  },
  { role: "tool", call: "c2", name: "project_overview", ok: false, text: "x".repeat(1000), at: 4 },
  {
    role: "assistant",
    text: "加好了。",
    calls: [],
    at: 5,
    end: "done",
    service: "anthropic",
    protocol: "anthropic-messages",
    model: "claude-sonnet-4-5",
  },
  { role: "user", text: "再读一下", at: 6, task: "b" },
  {
    role: "assistant",
    text: "",
    calls: [
      { id: "c3", name: "aq_timeline_read", args: {} },
      { id: "c4", name: "aq_project_status", args: {} },
    ],
    at: 7,
    end: "tools",
    service: "anthropic",
    protocol: "anthropic-messages",
    model: "claude-sonnet-4-5",
  },
  { role: "tool", call: "c3", name: "aq_timeline_read", ok: true, text: "timeline main", at: 8 },
  { role: "tool", call: "c4", name: "aq_project_status", ok: true, text: "project", at: 9 },
  {
    role: "assistant",
    text: "读完了。",
    calls: [],
    at: 10,
    end: "done",
    service: "anthropic",
    protocol: "anthropic-messages",
    model: "claude-sonnet-4-5",
  },
];

const ENDPOINTS: readonly Endpoint[] = [
  {
    service: "anthropic",
    protocol: "anthropic-messages",
    baseUrl: "https://api.anthropic.com",
    model: "claude-sonnet-4-5",
    catalog: "anthropic",
  },
  {
    service: "openai",
    protocol: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-5",
    catalog: "openai",
  },
];

async function requestOf(
  endpoint: Endpoint,
  history: readonly ChatEntry[],
  extra: Partial<Parameters<typeof runTask>[0]> = {},
) {
  const bodies: Node[] = [];
  vi.stubGlobal("fetch", async (_input: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body ?? "{}")) as Node);
    return new Response("{}", { status: 500 });
  });
  await runTask({
    endpoint,
    key: async () => "sk-test-0123456789abcdef",
    system: "test",
    tools: project().tools,
    history,
    prompt: "继续",
    signal: new AbortController().signal,
    onEvent: () => {},
    ...extra,
  });
  return bodies[0] as Node;
}

/** The messages of a request, as role and a short text of what each holds. */
function shapeOf(protocol: Protocol, body: Node): string[] {
  if (protocol === "anthropic-messages") {
    return (body.messages as Node[]).map((message) => {
      const content = message.content;
      const parts =
        typeof content === "string" ? [{ type: "text", text: content }] : (content as Node[]);
      return `${String(message.role)}: ${parts
        .map((part) =>
          part.type === "text"
            ? `text(${String(part.text).slice(0, 60)})`
            : part.type === "tool_use"
              ? `tool_use(${String(part.name)})`
              : part.type === "tool_result"
                ? `tool_result(${String(part.tool_use_id)})`
                : String(part.type),
        )
        .join(" ")}`;
    });
  }
  return (body.input as Node[]).map((item) => {
    if (item.type === "function_call") return `function_call(${String(item.name)})`;
    if (item.type === "function_call_output")
      return `function_call_output(${String(item.call_id)})`;
    const content = item.content;
    const text = typeof content === "string" ? content : JSON.stringify(content);
    return `${String(item.role)}: ${text.slice(0, 80)}`;
  });
}

describe("an earlier conversation, as it goes to services", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("to Anthropic has calls of tools that are no more as text, and the calls of these as calls", async () => {
    const body = await requestOf(ENDPOINTS[0] as Endpoint, OLD);
    const shape = shapeOf("anthropic-messages", body);
    expect(shape).toEqual([
      "user: text(加一个标记)",
      "assistant: text(我加一下。)",
      expect.stringMatching(/^user: text\(Earlier tool calls with the old tool set/),
      "assistant: text(加好了。)",
      "user: text(再读一下)",
      "assistant: tool_use(aq_timeline_read) tool_use(aq_project_status)",
      "user: tool_result(c3) tool_result(c4)",
      "assistant: text(读完了。)",
      "user: text(继续)",
    ]);
    const text = JSON.stringify(body.messages);
    expect(text).not.toContain('"name":"marker_add"');
    // Results go short: three hundred characters at most.
    expect(text).toContain(`- project_overview {} → error: ${"x".repeat(300)}…`);
    expect(text).toContain('- marker_add {\\"timeline\\":\\"main\\",\\"time\\":\\"1\\"} → ok');
    // The same conversation gives the same request, for the caches of services.
    expect(await requestOf(ENDPOINTS[0] as Endpoint, OLD)).toEqual(body);
  });

  it("to OpenAI the same way", async () => {
    const body = await requestOf(ENDPOINTS[1] as Endpoint, OLD);
    const shape = shapeOf("openai-responses", body);
    expect(shape.join("\n")).not.toContain("function_call(marker_add)");
    expect(shape.filter((line) => line.startsWith("function_call("))).toEqual([
      "function_call(aq_timeline_read)",
      "function_call(aq_project_status)",
    ]);
    expect(shape.join("\n")).toContain("Earlier tool calls with the old tool set");
  });

  it("goes with the settings of the call, and only those", async () => {
    const anthropic = ENDPOINTS[0] as Endpoint;
    const limited = await requestOf(anthropic, [], { call: { maxOutputTokens: 32_000 } });
    expect(limited.max_tokens).toBe(32_000);
    expect(limited.thinking).toEqual({ type: "disabled" });
    // A model that thinks as much as it needs, with a summary of its thinking back. pi 1.5.0 does
    // not pass on another display of thinking: the summary is what it always asks for.
    const thinking = await requestOf({ ...anthropic, model: "claude-fable-5" }, [], {
      call: { reasoning: "medium", anthropic: { thinkingDisplay: "omitted" } },
    });
    expect(thinking.thinking).toMatchObject({ type: "adaptive", display: "summarized" });
    expect(thinking.output_config).toMatchObject({ effort: "medium" });
    const plain = await requestOf(anthropic, []);
    expect(plain.thinking).toEqual({ type: "disabled" });
    expect(plain).not.toHaveProperty("temperature");
  });
});

describe("what a tool found, as a conversation keeps it", () => {
  it("is all of it up to a size, and past it which objects changed", () => {
    const small = {
      changes: [{ kind: "clip", id: "c1", change: "changed", fields: [{ path: "name" }] }],
    };
    expect(keptData(small)).toBe(small);
    const changes = Array.from({ length: 60 }, (_, index) => ({
      kind: "clip",
      id: `c${index}`,
      change: "changed",
      fields: [{ path: "name", before: "x".repeat(40), after: "y".repeat(40) }],
    }));
    const kept = keptData({ summary: "many", changes });
    expect(JSON.stringify(kept).length).toBeLessThanOrEqual(MAX_DATA);
    expect(kept).toMatchObject({
      summary: "many",
      changes: changes.map(({ fields: _fields, ...rest }) => rest),
    });
  });
});

describe("models pi does not know yet", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("get the call settings of their family, by name", () => {
    expect(callSettingsFor("claude-fable-5-2")).toMatchObject({
      reasoning: "high",
      maxOutputTokens: 32_000,
    });
    expect(callSettingsFor("anthropic/claude-sonnet-5-5")).toMatchObject({ reasoning: "medium" });
    expect(callSettingsFor("CLAUDE-OPUS-5-5")).toMatchObject({ reasoning: "medium" });
    expect(callSettingsFor("gpt-5")).toEqual({});
    expect(callSettingsFor("claude-sonnet-4-5")).toEqual({});
  });

  it("go as the closest one pi knows: long answers, and a summary of the thinking", async () => {
    const endpoint: Endpoint = {
      service: "anthropic",
      protocol: "anthropic-messages",
      baseUrl: "https://api.anthropic.com",
      model: "claude-fable-5-2",
      catalog: "anthropic",
    };
    const body = await requestOf(endpoint, [], { call: callSettingsFor(endpoint.model) });
    expect(body.model).toBe("claude-fable-5-2");
    expect(body.max_tokens).toBe(32_000);
    expect(body.thinking).toMatchObject({ type: "adaptive", display: "summarized" });
  });
});
