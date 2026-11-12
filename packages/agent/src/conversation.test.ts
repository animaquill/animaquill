import { ProjectStore, aiTask } from "@animaquill/core";
import { createProject } from "@animaquill/schema";
import { describe, expect, it } from "vitest";
import { Conversation, type TaskTarget } from "./conversation.ts";
import type { FakeEndpoint } from "./pi.ts";
import { allTools } from "./tools.ts";

function setup(fake: FakeEndpoint["fake"], maxToolCalls = 50) {
  const store = ProjectStore.create(createProject({ name: "对话" }));
  let seen: number | undefined;
  let count = 0;
  const conversation = new Conversation({
    system: "test",
    newTask: () => `t${++count}`,
    tools: (task) => {
      seen = store.revision;
      return allTools({
        store: () => store,
        task,
        selection: () => undefined,
        seen: () => seen,
        saw: (revision) => (seen = revision),
      });
    },
  });
  const endpoint: FakeEndpoint = { fake };
  const target: TaskTarget = { endpoint, key: async () => undefined, maxToolCalls };
  const markers = () => Object.values(store.getState().timelines.main?.markers ?? {});
  return { store, conversation, target, endpoint, markers };
}

const addMarker = (time: string) => ({
  name: "marker_add",
  args: { timeline: "main", time },
});

describe("a conversation", () => {
  it("changes the project with a task that can be taken back as a whole", async () => {
    const { store, conversation, target, markers } = setup([
      { calls: [addMarker("1"), addMarker("2")] },
      { calls: [{ name: "project_rename", args: { name: "AI 起的名字" } }] },
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
      "tool",
      "assistant",
      "tool",
      "assistant",
    ]);
    expect(conversation.resultsOf("t1").size).toBe(3);

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
    expect(results[2]?.text).toMatch(/上限（2 次）/);
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
});
