import { ProblemSet, ProjectStore, aiTask } from "@animaquill/core";
import { createProject } from "@animaquill/schema";
import { CallerState, createToolset } from "@animaquill/tools";
import { toolSpecsOf } from "./assistant.ts";
import { describe, expect, it } from "vitest";
import { Conversation, type TaskTarget } from "./conversation.ts";
import type { FakeEndpoint } from "./pi.ts";

function setup(fake: FakeEndpoint["fake"], maxToolCalls = 50) {
  const store = ProjectStore.create(createProject({ name: "对话" }));
  let count = 0;
  const caller = new CallerState();
  /** How long each try again waited: a clock of its own, which goes on right away. */
  const waited: number[] = [];
  const conversation = new Conversation({
    newTask: () => `t${++count}`,
    onAnswer: () => caller.beginAnswer(),
    wait: async (ms) => {
      waited.push(ms);
    },
  });
  const endpoint: FakeEndpoint = { fake };
  const target: TaskTarget = {
    endpoint,
    key: async () => undefined,
    maxToolCalls,
    system: "test",
    tools: (task) =>
      toolSpecsOf(
        createToolset(
          { store: () => store, origin: () => aiTask(task), problems: () => new ProblemSet() },
          caller,
        ),
      ),
  };
  const markers = () => Object.values(store.getState().timelines.main?.markers ?? {});
  return { store, conversation, target, endpoint, markers, waited };
}

const addMarker = (time: string) => ({
  name: "aq_edit",
  args: { operations: [{ op: "marker.add", timeline: "main", time }] },
});

describe("a conversation", () => {
  it("changes the project with a task that can be taken back as a whole", async () => {
    const { store, conversation, target, markers } = setup([
      { calls: [{ name: "aq_project_status", args: {} }] },
      { calls: [addMarker("1"), addMarker("2")] },
      {
        calls: [
          {
            name: "aq_edit",
            args: { operations: [{ op: "project.rename", name: "AI 起的名字" }] },
          },
        ],
      },
      { text: "加了两个标记，也改了名字。" },
    ]);
    const outcome = await conversation.send("加两个标记", target);
    expect(outcome).toEqual({ task: "t1", end: "done" });
    expect(markers()).toHaveLength(2);
    expect(store.getState().manifest.name).toBe("AI 起的名字");
    const { entries, running } = conversation.getSnapshot();
    expect(running).toBeUndefined();
    expect(entries.map((entry) => entry.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
      "tool",
      "tool",
      "assistant",
      "tool",
      "assistant",
    ]);
    expect(conversation.resultsOf("t1").size).toBe(4);

    expect(store.undoOrigin(aiTask("t1")).ok).toBe(true);
    expect(markers()).toHaveLength(0);
    expect(store.getState().manifest.name).toBe("对话");
  });

  it("stops a task that calls more tools than it may", async () => {
    const forever = () => ({ calls: [addMarker("1")] });
    const { conversation, target, markers, endpoint } = setup(
      Array.from({ length: 20 }, () => forever),
      3,
    );
    const outcome = await conversation.send("一直加", target);
    expect(outcome?.end).toBe("limit");
    expect(markers()).toHaveLength(3);
    expect(endpoint.requests).toBe(3);
  });

  it("counts the calls of one answer against the limit too", async () => {
    const { conversation, target, markers } = setup(
      [{ calls: [addMarker("1"), addMarker("2"), addMarker("3"), addMarker("4")] }, { text: "x" }],
      2,
    );
    const outcome = await conversation.send("加四个", target);
    expect(outcome?.end).toBe("limit");
    expect(markers()).toHaveLength(2);
    const results = [...conversation.resultsOf("t1").values()];
    expect(results.map((result) => result.ok)).toEqual([true, true, false, false]);
    expect(results[2]?.text).toMatch(/^error limit: this task has called tools 2 times/);
  });

  it("runs one task at a time, and stops when asked", async () => {
    const { conversation, target } = setup([{ text: "慢慢说。".repeat(300) }]);
    (target.endpoint as FakeEndpoint).charactersPerSecond = 200;
    const sending = conversation.send("说点什么", target);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(conversation.running).toBe(true);
    expect(await conversation.send("再说", target)).toBeUndefined();
    conversation.stop();
    expect((await sending)?.end).toBe("stopped");
    expect(conversation.running).toBe(false);
  });

  it("tells a failure of the service by its kind", async () => {
    const { conversation, target } = setup([{ error: "TypeError: Failed to fetch" }]);
    const outcome = await conversation.send("你好", target);
    expect(outcome?.end).toBe("failed");
    expect(outcome?.failure?.kind).toBe("network");
  });

  it("tries a busy service again by itself, waiting 2, 4 and 8 seconds", async () => {
    const { conversation, target, endpoint, waited } = setup([
      { error: "429 rate_limit_error: too many requests" },
      { error: "529 overloaded_error: Overloaded" },
      { text: "好了。" },
    ]);
    const outcome = await conversation.send("你好", target);
    expect(outcome).toEqual({ task: "t1", end: "done" });
    expect(waited).toEqual([2000, 4000]);
    expect(endpoint.requests).toBe(3);
    // The failures that passed are not kept: the task reads as if it went through at once.
    const roles = conversation.getSnapshot().entries.map((entry) => entry.role);
    expect(roles).toEqual(["user", "assistant"]);
  });

  it("gives up after three tries again, and keeps the last failure", async () => {
    const busy = { error: "503 service unavailable" };
    const { conversation, target, endpoint, waited } = setup([busy, busy, busy, busy, busy]);
    const outcome = await conversation.send("你好", target);
    expect(outcome?.end).toBe("failed");
    expect(outcome?.failure?.kind).toBe("server");
    expect(waited).toEqual([2000, 4000, 8000]);
    expect(endpoint.requests).toBe(4);
    const answers = conversation
      .getSnapshot()
      .entries.filter((entry) => entry.role === "assistant");
    expect(answers).toHaveLength(1);
    expect(conversation.failedTask()).toBe("t1");
  });

  it("waits as long as the service asks", async () => {
    const { conversation, target, waited } = setup([
      { error: "429 Too Many Requests, retry-after: 7" },
      { text: "好。" },
    ]);
    await conversation.send("你好", target);
    expect(waited).toEqual([7000]);
  });

  it("does not try a wrong key or an account out of credit again", async () => {
    const { conversation, target, waited } = setup([
      { error: "401 authentication_error: invalid x-api-key" },
    ]);
    expect((await conversation.send("你好", target))?.failure?.kind).toBe("key");
    const second = setup([{ error: "429 insufficient_quota: You exceeded your current quota" }]);
    expect((await second.conversation.send("你好", second.target))?.end).toBe("failed");
    expect([...waited, ...second.waited]).toEqual([]);
  });

  it("tries a failed task again as the same task, from where it was", async () => {
    const { store, conversation, target, markers } = setup([
      { calls: [addMarker("1")] },
      { error: "401 invalid x-api-key" },
      { text: "接着做完了。" },
    ]);
    expect((await conversation.send("加一个标记", target))?.end).toBe("failed");
    expect(markers()).toHaveLength(1);
    const outcome = await conversation.retry(target);
    expect(outcome).toEqual({ task: "t1", end: "done" });
    expect(conversation.tasks).toEqual(["t1"]);
    expect(conversation.failedTask()).toBeUndefined();
    // Still one task: all of it goes back at once.
    expect(store.undoOrigin(aiTask("t1")).ok).toBe(true);
    expect(markers()).toHaveLength(0);
    expect(await conversation.retry(target)).toBeUndefined();
  });

  it("keeps how many tokens each answer took, without a price for a model pi does not list", async () => {
    const { conversation, target } = setup([{ text: "说了一句。" }]);
    await conversation.send("说一句", target);
    const answer = conversation.getSnapshot().entries.find((entry) => entry.role === "assistant");
    expect(answer?.role === "assistant" && answer.usage?.output).toBeGreaterThan(0);
    expect(answer?.role === "assistant" && answer.usage?.cost).toBeUndefined();
    expect(answer?.role === "assistant" && answer.endedAt).toBeGreaterThanOrEqual(answer?.at ?? 0);
  });

  it("streams the words of an answer outside the snapshot", async () => {
    const { conversation, target } = setup([{ text: "一个字一个字地说。".repeat(20) }]);
    (target.endpoint as FakeEndpoint).charactersPerSecond = 2000;
    let snapshots = 0;
    let pieces = 0;
    conversation.subscribe(() => (snapshots += 1));
    conversation.live.subscribe(() => (pieces += 1));
    await conversation.send("说话", target);
    expect(pieces).toBeGreaterThan(20);
    expect(snapshots).toBeLessThan(6);
  });
});
