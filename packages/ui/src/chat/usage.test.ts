import type { AnswerUsage, AssistantEntry, ChatEntry } from "@animaquill/agent";
import { describe, expect, it } from "vitest";
import { cacheShare, contextLevel, contextOf, dollars, percent, tokens, usageOf } from "./usage.ts";

const answer = (usage?: AnswerUsage): AssistantEntry => ({
  role: "assistant",
  text: "",
  calls: [],
  at: 0,
  end: "done",
  service: "anthropic",
  protocol: "anthropic-messages",
  model: "m",
  ...(usage && { usage }),
});
const used = (input: number, output: number, more: Partial<AnswerUsage> = {}): AnswerUsage => ({
  input,
  output,
  cacheRead: 0,
  cacheWrite: 0,
  ...more,
});

describe("what a conversation took", () => {
  it("adds up the tokens and the cost of every answer", () => {
    const entries: ChatEntry[] = [
      { role: "user", text: "x", at: 0, task: "t" },
      answer(used(1000, 100, { cacheRead: 4000, cost: 0.01 })),
      answer(used(200, 50, { cacheWrite: 300, cost: 0.002 })),
    ];
    const total = usageOf(entries);
    expect(total).toMatchObject({ answers: 2, input: 1200, output: 150, cacheRead: 4000 });
    expect(total.cacheWrite).toBe(300);
    expect(total.cost).toBeCloseTo(0.012);
    expect(cacheShare(total)).toBeCloseTo(4000 / 5500);
  });

  it("leaves out an answer that counted nothing, such as one that failed", () => {
    const entries = [answer(used(1000, 10, { window: 100_000, cost: 0.1 })), answer(used(0, 0))];
    expect(usageOf(entries)).toMatchObject({ answers: 1, cost: 0.1 });
    expect(contextOf(entries)?.share).toBe(0.01);
    expect(contextOf([answer(used(0, 0))])).toBeUndefined();
  });

  it("has no cost once one answer did not know its price, and none without usage", () => {
    expect(usageOf([answer(used(10, 1, { cost: 0.5 })), answer(used(10, 1))]).cost).toBeUndefined();
    expect(usageOf([answer()])).toMatchObject({ answers: 0, cost: undefined });
  });

  it("tells how full the context is from the newest request, in and out of the cache", () => {
    const entries = [
      answer(used(1000, 10, { window: 200_000 })),
      answer(used(6000, 10, { cacheRead: 70_000, window: 200_000 })),
      answer(),
    ];
    const context = contextOf(entries);
    expect(context).toEqual({ used: 76_000, window: 200_000, share: 0.38 });
    expect(percent(context?.share ?? 0)).toBe("38%");
    expect(contextOf([answer(used(500, 1))])).toEqual({
      used: 500,
      window: undefined,
      share: undefined,
    });
    expect(contextOf([answer()])).toBeUndefined();
  });

  it("turns yellow from 70% and red from 90%", () => {
    expect(contextLevel(0.69)).toBe("ok");
    expect(contextLevel(0.7)).toBe("warn");
    expect(contextLevel(0.9)).toBe("full");
    expect(contextLevel(undefined)).toBe("ok");
  });

  it("writes counts and sums short", () => {
    expect([950, 1300, 1000, 12_345, 272_000, 1_200_000].map(tokens)).toEqual([
      "950",
      "1.3k",
      "1k",
      "12k",
      "272k",
      "1.2M",
    ]);
    expect([0, 0.00423, 0.0255, 0.12, 1.271].map(dollars)).toEqual([
      "$0",
      "$0.0042",
      "$0.03",
      "$0.12",
      "$1.27",
    ]);
    expect(percent(0.001)).toBe("1%");
  });
});
