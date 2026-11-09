import { describe, expect, it } from "vitest";
import type { ChatEntry, ToolEntry } from "./entries.ts";
import { runTask, type FakeEndpoint, type RunEvent, type ToolSpec } from "./pi.ts";

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
  run: async (args) => `已加在 ${String(args.at)}`,
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
    const strict: ToolSpec = { ...echo, run: async () => ((ran = true), "ran") };
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
