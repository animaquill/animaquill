import type { ChatEntry, ToolEntry } from "@animaquill/agent";
import { describe, expect, it } from "vitest";
import { PlanDrafts, clockOf, planMessage, planOf, plansIn, type Plan } from "./plan.ts";
import { piecesOf } from "./refs.ts";

const proposed = (call: string, title: string): ToolEntry => ({
  role: "tool",
  call,
  name: "aq_propose",
  ok: true,
  text: "rev x\nThe plan is shown to the user",
  at: 1,
  data: {
    plan: { kind: "plan", title, steps: [{ text: "淡入", from: "0", to: "4" }, { text: "收尾" }] },
  },
});
const user = (text: string, fromPlan?: string): ChatEntry => ({
  role: "user",
  text,
  at: 1,
  task: text,
  ...(fromPlan && { fromPlan }),
});

describe("a plan", () => {
  it("is read from the result of aq_propose, and nothing else is one", () => {
    expect(planOf(proposed("c1", "片头"))).toEqual({
      title: "片头",
      steps: [{ text: "淡入", from: "0", to: "4" }, { text: "收尾" }],
    });
    expect(planOf({ ...proposed("c1", "片头"), ok: false })).toBeUndefined();
    expect(
      planOf({ ...proposed("c1", "片头"), data: { question: { question: "?" } } }),
    ).toBeUndefined();
  });

  it("waits for people when it is the newest; an older one is replaced, one accepted says so", () => {
    const entries = [
      user("一"),
      proposed("c1", "第一版"),
      user("改短一点"),
      proposed("c2", "第二版"),
    ];
    expect([...plansIn(entries)]).toEqual([
      ["c1", "replaced"],
      ["c2", "open"],
    ]);
    expect([...plansIn([...entries, user("按这个做：第二版", "c2")])]).toEqual([
      ["c1", "replaced"],
      ["c2", "accepted"],
    ]);
  });

  it("shows its times as clocks", () => {
    expect(clockOf("0")).toBe("0:00");
    expect(clockOf("4")).toBe("0:04");
    expect(clockOf("62.5")).toBe("1:02.5");
    expect(clockOf("73/6")).toBe("0:12.17");
    expect(clockOf("3600")).toBe("1:00:00");
  });

  it("goes as people's message: changed lines, times as links of the editor, length and style", () => {
    const plan: Plan = {
      title: "片头 30 秒",
      steps: [{ text: "黑底淡入 logo", from: "0", to: "4" }, { text: "  " }, { text: "收尾" }],
      length: "30",
      style: "冷色",
    };
    const text = planMessage(plan, { accept: "按这个做：", length: "时长", style: "风格" }, "main");
    expect(text).toBe(
      [
        "按这个做：片头 30 秒",
        "1. [0:00](aq://time?timeline=main&t=0)–[0:04](aq://time?timeline=main&t=4) 黑底淡入 logo",
        "2. 收尾",
        "时长 [0:30](aq://time?timeline=main&t=30) · 风格 冷色",
      ].join("\n"),
    );
    expect(piecesOf(text).filter((piece) => "ref" in piece)).toHaveLength(3);
  });

  it("keeps the lines people changed in the memory of the window, and reads back only lines", () => {
    const values = new Map<string, string>();
    const memory = {
      read: (key: string) => values.get(key),
      write: (key: string, value: string) => void values.set(key, value),
    };
    const drafts = new PlanDrafts(memory);
    drafts.write("p", "c", "call", [{ text: "改过", from: "0" }]);
    expect(new PlanDrafts(memory).read("p", "c", "call")).toEqual([{ text: "改过", from: "0" }]);
    values.set("chat.plan\np\nc\nbad", '[{"text":1},{"text":"留下","from":"soon"}]');
    expect(new PlanDrafts(memory).read("p", "c", "bad")).toEqual([{ text: "留下" }]);
    drafts.write("p", "c", "call", undefined);
    expect(new PlanDrafts(memory).read("p", "c", "call")).toBeUndefined();
  });
});
