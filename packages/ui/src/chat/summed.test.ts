import type { ChatEntry, SummaryEntry } from "@animaquill/agent";
import { describe, expect, it } from "vitest";
import { summariesByTurn } from "./ChatPanel.tsx";

const user = (task: string): ChatEntry => ({ role: "user", text: task, task, at: 0 });
const summed = (through: number): SummaryEntry => ({
  role: "summary",
  kind: "summary",
  through,
  text: "…",
  count: through,
  before: 9,
  after: 3,
  by: "auto",
  at: 0,
});

describe("where the line of a summary shows", () => {
  it("before the turn where what it sums up ends, or the first after it", () => {
    // Through 1 is the turn of t2; through 4 is inside the turn of t3, at an answer.
    const answer: ChatEntry = {
      role: "assistant",
      text: "",
      calls: [],
      at: 0,
      end: "done",
      service: "s",
      protocol: "p",
      model: "m",
    };
    const entries: ChatEntry[] = [user("t1"), user("t2"), summed(1), user("t3"), answer, summed(4)];
    const found = summariesByTurn(entries);
    expect(found.get("t2")?.map(({ through }) => through)).toEqual([1]);
    expect(found.get("t3")?.map(({ through }) => through)).toEqual([4]);
    expect(found.has("t1")).toBe(false);
    const fresh = summariesByTurn([summed(0), user("t1")]);
    expect(fresh.get("t1")).toHaveLength(1);
    // A new conversation from the summary of another, before anybody wrote in it: at the top.
    expect(summariesByTurn([summed(0)]).get("")).toHaveLength(1);
  });
});
