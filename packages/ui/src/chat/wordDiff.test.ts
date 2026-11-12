import { describe, expect, it } from "vitest";
import { wordDiff } from "./wordDiff.ts";

describe("wordDiff", () => {
  it("marks words put in and taken out, whole words only", () => {
    expect(
      wordDiff("Read it before you change it.", "Read it before you change it. Finish."),
    ).toEqual([
      { kind: "same", text: "Read it before you change it." },
      { kind: "in", text: " Finish." },
    ]);
    expect(wordDiff("API keys, passwords or tokens", "API keys")).toEqual([
      { kind: "same", text: "API " },
      { kind: "out", text: "keys, passwords or tokens" },
      { kind: "in", text: "keys" },
    ]);
    expect(wordDiff("one two three", "one 2 three")).toEqual([
      { kind: "same", text: "one " },
      { kind: "out", text: "two" },
      { kind: "in", text: "2" },
      { kind: "same", text: " three" },
    ]);
  });

  it("gives back both texts whole: what is left of the first and of the second", () => {
    const before = "a b c d e f g".repeat(3);
    const after = "a x c d y f g z".repeat(2);
    const runs = wordDiff(before, after);
    const left = runs
      .filter(({ kind }) => kind !== "in")
      .map(({ text }) => text)
      .join("");
    const right = runs
      .filter(({ kind }) => kind !== "out")
      .map(({ text }) => text)
      .join("");
    expect(left).toBe(before);
    expect(right).toBe(after);
  });

  it("does not build a huge table for long texts that differ throughout", () => {
    const before = Array.from({ length: 3000 }, (_, index) => `a${index}`).join(" ");
    const after = Array.from({ length: 3000 }, (_, index) => `b${index}`).join(" ");
    expect(wordDiff(before, after)).toEqual([
      { kind: "out", text: before },
      { kind: "in", text: after },
    ]);
  });
});
