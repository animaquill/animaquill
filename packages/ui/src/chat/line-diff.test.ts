import { describe, expect, it } from "vitest";
import { diffLines, hunksOf, linesOf } from "./line-diff.ts";

const signs = (before: string, after: string, most?: number) =>
  diffLines(before, after, most).map(({ kind, text }) =>
    kind === "same" ? ` ${text}` : kind === "added" ? `+${text}` : `-${text}`,
  );

/** What the lines of one side come back to. */
const side = (before: string, after: string, which: "before" | "after") =>
  diffLines(before, after)
    .filter(({ kind }) => kind === "same" || kind === (which === "before" ? "removed" : "added"))
    .map(({ text }) => text);

describe("lines compared", () => {
  it("are what stayed, went and came, with their numbers on each side", () => {
    expect(signs("a\nb\nc\n", "a\nx\nc\n")).toEqual([" a", "-b", "+x", " c"]);
    const [, gone, came] = diffLines("a\nb\nc\n", "a\nx\nc\n");
    expect(gone).toEqual({ kind: "removed", text: "b", before: 2 });
    expect(came).toEqual({ kind: "added", text: "x", after: 2 });
  });

  it("make a new file all new lines and a removed one all gone", () => {
    expect(signs("", "a\nb")).toEqual(["+a", "+b"]);
    expect(signs("a\nb\n", "")).toEqual(["-a", "-b"]);
    expect(signs("", "")).toEqual([]);
  });

  it("find the fewest changes, also in the middle of others", () => {
    expect(signs("a\nb\nc\nd\ne", "a\nc\nd\nx\ne")).toEqual([" a", "-b", " c", " d", "+x", " e"]);
  });

  it("give back both texts, whatever they are", () => {
    let seed = 7;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    const text = () =>
      Array.from(
        { length: Math.floor(random() * 12) },
        () => "abcd"[Math.floor(random() * 4)],
      ).join("\n");
    for (let round = 0; round < 300; round++) {
      const before = text();
      const after = text();
      expect(side(before, after, "before")).toEqual(linesOf(before));
      expect(side(before, after, "after")).toEqual(linesOf(after));
    }
  });

  it("call it all gone and all new where it takes too many changes", () => {
    expect(signs("a\nb\nc", "x\ny\nz", 2)).toEqual(["-a", "-b", "-c", "+x", "+y", "+z"]);
  });
});

describe("pieces of a comparison", () => {
  it("have two lines around each change, and come apart where more is between", () => {
    const before = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n");
    const after = before.replace("line 3", "LINE 3").replace("line 15", "LINE 15");
    const hunks = hunksOf(diffLines(before, after));
    expect(hunks).toHaveLength(2);
    expect(hunks[0]?.map(({ text }) => text)).toEqual([
      "line 1",
      "line 2",
      "line 3",
      "LINE 3",
      "line 4",
      "line 5",
    ]);
    expect(hunks[1]?.[0]).toMatchObject({ text: "line 13", before: 13, after: 13 });
  });

  it("are none where nothing changed", () => {
    expect(hunksOf(diffLines("a\nb", "a\nb"))).toEqual([]);
  });
});
