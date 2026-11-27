import type { ChatEntry } from "@animaquill/agent";
import { describe, expect, it } from "vitest";
import { MAX_ROUNDS, distinctNames, lastAnswerOf, roundsOf } from "./relay.ts";

const from = { id: "c2", name: "配乐", kind: "chat" as const };
const user = (text: string, by?: typeof from): ChatEntry => ({
  role: "user",
  text,
  at: 0,
  task: text,
  ...(by && { from: by }),
});
const answer = (text: string): ChatEntry => ({
  role: "assistant",
  text,
  calls: [],
  at: 0,
  end: "done",
  service: "s",
  protocol: "p",
  model: "m",
});

describe("rounds with other conversations", () => {
  it("count the turns others started since people last said something", () => {
    const others = Array.from({ length: MAX_ROUNDS }, (_, at) => [
      user(`${at}`, from),
      answer("回"),
    ]);
    expect(roundsOf([user("人说的"), answer("好"), ...others.flat()])).toEqual({
      rounds: MAX_ROUNDS,
      with: from,
    });
    // People said something: it counts from there.
    expect(roundsOf([...others.flat(), user("人又说了"), answer("好"), user("x", from)])).toEqual({
      rounds: 1,
      with: from,
    });
    expect(roundsOf([user("人说的")]).rounds).toBe(0);
  });

  it("give the last words of an answer, and names that tell each one apart", () => {
    expect(lastAnswerOf([answer("一"), answer("最后一句"), answer("")])).toBe("最后一句");
    expect(lastAnswerOf([answer("长".repeat(400))]).length).toBe(300);
    expect(distinctNames([{ name: "配乐" }, { name: "开场" }, { name: "配乐" }])).toEqual([
      { name: "配乐" },
      { name: "开场" },
      { name: "配乐（2）" },
    ]);
  });
});
