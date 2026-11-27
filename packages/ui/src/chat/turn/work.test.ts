import type { RunningTask, ToolCallEntry, ToolEntry } from "@animaquill/agent";
import { createInstance } from "i18next";
import { beforeAll, describe, expect, it } from "vitest";
import zh from "../../i18n/zh-CN.json";
import type { Names, Say } from "../toolSummary.ts";
import type { Step } from "../turns.ts";
import { finalFailures, phaseOf, QUIET_MS, workDone, type PhaseInput } from "./work.ts";

let say: Say;
beforeAll(async () => {
  const i18n = createInstance();
  await i18n.init({ lng: "zh-CN", resources: { "zh-CN": { translation: zh } } });
  say = i18n.t.bind(i18n) as unknown as Say;
});

const NOW = 1_000_000;
const names: Names = {
  timeline: () => undefined,
  object: (id) => (id === "clip_1" ? "标题" : undefined),
};
const running = (more: Partial<RunningTask> = {}): RunningTask => ({
  task: "t1",
  startedAt: NOW - 14_000,
  tool: undefined,
  retry: undefined,
  ...more,
});
const input = (more: Partial<PhaseInput> = {}): PhaseInput => ({
  running: running(),
  live: "waiting",
  heardAt: NOW - 1000,
  look: { kind: "idle" },
  approving: undefined,
  now: NOW,
  names,
  ...more,
});
const tool = (name: string, args: Record<string, unknown> = {}) => ({
  id: "c1",
  name,
  args,
  startedAt: NOW - 500,
});

describe("what a running turn says of itself (all the states RunState had)", () => {
  it("the model: waited on, thinking, writing", () => {
    expect(phaseOf(say, input())).toMatchObject({ kind: "waiting", text: "等模型回答…" });
    expect(phaseOf(say, input({ live: "thinking" })).text).toBe("正在想…");
    expect(phaseOf(say, input({ live: "writing" })).text).toBe("正在写回答…");
  });

  it("a tool, by what it does now; a change by the object it changes, where it is named", () => {
    expect(phaseOf(say, input({ running: running({ tool: tool("aq_timeline_read") }) })).text).toBe(
      "正在读时间轴…",
    );
    const ops = (operations: unknown[]) =>
      phaseOf(say, input({ running: running({ tool: tool("aq_edit", { operations }) }) })).text;
    expect(ops([{ op: "set", clip: "clip_1" }])).toBe("正在改「标题」…");
    expect(
      ops([
        { op: "set", clip: "clip_1" },
        { op: "move", clip: "clip_2" },
      ]),
    ).toBe("正在改「标题」等（2 个操作）…");
    expect(ops([{ op: "set", clip: "clip_9" }, { op: "move" }])).toBe("正在改项目（2 个操作）…");
  });

  it("looking at frames: how far, and what it waits for, in yellow", () => {
    const look = (state: PhaseInput["look"]) =>
      phaseOf(say, input({ running: running({ tool: tool("aq_render_frames") }), look: state }));
    expect(look({ kind: "idle" }).text).toBe("正在看画面…");
    expect(look({ kind: "rendering", done: 1, total: 4 }).text).toBe("正在看画面（2/4）…");
    expect(look({ kind: "playing" })).toMatchObject({
      kind: "lookWaits",
      tone: "warn",
      text: "你在播放，AI 等你停下再看画面",
    });
    expect(look({ kind: "exporting" }).text).toBe("正在导出，AI 等导出完再看画面");
    expect(look({ kind: "hidden" }).text).toBe("等你回到这个页面才能看画面");
  });

  it("a busy service: waits to try again, with which try and how long", () => {
    const phase = phaseOf(
      say,
      input({
        running: running({
          retry: {
            attempt: 2,
            of: 5,
            at: NOW + 7_200,
            failure: { kind: "rate", message: "429 Too Many Requests" },
          },
        }),
      }),
    );
    expect(phase).toMatchObject({
      kind: "retry",
      tone: "warn",
      text: "服务太忙（429），正在重试 2/5 · 8 秒后",
    });
  });

  it("a change that waits for people, in blue, with how many places", () => {
    expect(
      phaseOf(say, input({ running: running({ tool: tool("aq_edit") }), approving: 3 })),
    ).toMatchObject({ kind: "approve", tone: "accent", text: "等你允许改 3 处" });
  });

  it("summing up the earlier conversation", () => {
    expect(phaseOf(say, input({ running: running({ compacting: true }) })).text).toBe(
      "正在压缩较早的对话…",
    );
  });

  it("quiet for a minute while no tool runs: says so, in yellow; not while a tool runs", () => {
    const quiet = input({ heardAt: NOW - QUIET_MS - 5000 });
    expect(phaseOf(say, quiet)).toMatchObject({
      kind: "quiet",
      tone: "warn",
      text: "模型 65 秒没有回应",
    });
    expect(phaseOf(say, { ...quiet, running: running({ tool: tool("aq_search") }) }).kind).toBe(
      "tool",
    );
    // Never heard: not quiet.
    expect(phaseOf(say, input({ heardAt: 0 })).kind).toBe("waiting");
  });
});

const call = (id: string, name: string): ToolCallEntry => ({ id, name, args: {} });
const result = (
  id: string,
  name: string,
  ok: boolean,
  more: Partial<ToolEntry> = {},
): ToolEntry => ({
  role: "tool",
  call: id,
  name,
  ok,
  text: ok ? "ok" : "error invalid-params: no",
  at: 0,
  ...more,
});
const step = (id: string, name: string, ok: boolean | undefined): Step => ({
  kind: "tool",
  id,
  call: call(id, name),
  result: ok === undefined ? undefined : result(id, name, ok),
});

describe("the line of a turn that is over", () => {
  it("counts a failure only where no later call of the same tool went through", () => {
    expect(
      finalFailures([
        step("1", "aq_edit", false),
        step("2", "aq_timeline_read", true),
        step("3", "aq_edit", true),
      ]),
    ).toBe(0);
    expect(finalFailures([step("1", "aq_edit", true), step("2", "aq_edit", false)])).toBe(1);
    // Held back, not failed: people asked for a plan first.
    const held: Step = {
      kind: "tool",
      id: "h",
      call: call("h", "aq_edit"),
      result: result("h", "aq_edit", false, { text: "error plan-first: no" }),
    };
    expect(finalFailures([held])).toBe(0);
  });

  it("says how long it took, how many steps, how many places, what failed for good", () => {
    const steps = [step("1", "aq_edit", false), step("2", "aq_search", true)];
    expect(workDone(say, { ms: 8_400, tools: 2, steps }, 3, false)).toEqual({
      time: "想了 8.4 秒",
      steps: "做了 2 步",
      changed: "改了 3 处",
      failed: "1 步没成",
    });
    // Stopped: no time; nothing changed, nothing said of it.
    expect(workDone(say, { ms: 8_400, tools: 0, steps: [] }, 0, true)).toEqual({
      time: undefined,
      steps: undefined,
      changed: undefined,
      failed: undefined,
    });
  });
});
