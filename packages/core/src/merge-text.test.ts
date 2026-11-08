import { describe, expect, it } from "vitest";
import { randomFrom, type Random } from "./fuzz-support.ts";
import { linesOf, matchLines, mergeText, type MergedText } from "./merge-text.ts";

const text = (...lines: string[]) => lines.map((line) => `${line}\n`).join("");

describe("lines", () => {
  it("give the text back, also without a last line break", () => {
    for (const each of ["", "a", "a\n", "a\nb", "a\r\nb\r\n", "\n\n"]) {
      expect(linesOf(each).join("")).toBe(each);
    }
    expect(linesOf("a\nb")).toEqual(["a\n", "b"]);
  });
});

/** How long a longest common subsequence is, the slow way. */
function longest(a: readonly number[], b: readonly number[]): number {
  const table = Array.from({ length: a.length + 1 }, () =>
    Array.from({ length: b.length + 1 }, () => 0),
  );
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const row = table[i] as number[];
      const above = table[i - 1] as number[];
      row[j] =
        a[i - 1] === b[j - 1]
          ? (above[j - 1] as number) + 1
          : Math.max(above[j] as number, row[j - 1] as number);
    }
  }
  return (table[a.length] as number[])[b.length] as number;
}

describe("matching lines", () => {
  it("finds a longest common subsequence", () => {
    const random = randomFrom(7);
    for (let round = 0; round < 3000; round++) {
      const of = () => Array.from({ length: random.int(14) }, () => random.int(1 + random.int(5)));
      const a = of();
      const b = of();
      const match = matchLines(a, b);
      let last = -1;
      let count = 0;
      match.forEach((j, i) => {
        if (j < 0) return;
        expect(a[i], `round ${round}`).toBe(b[j]);
        expect(j, `round ${round}`).toBeGreaterThan(last);
        last = j;
        count++;
      });
      expect(count, `${JSON.stringify([a, b])}`).toBe(longest(a, b));
    }
  });

  it("is quick about long texts with a few changes", () => {
    const a = Array.from({ length: 200_000 }, (_, index) => index);
    const b = a.filter((index) => index % 50_000 !== 7).concat([-1]);
    const match = matchLines(a, b);
    expect(match.filter((j) => j >= 0).length).toBe(b.length - 1);
  });

  it("finds what stays among thousands of changes, as after a formatter went over the code", () => {
    const a = Array.from({ length: 30_000 }, (_, index) => index);
    const b = a.map((index) => (index % 4 === 0 ? -index - 1 : index));
    const match = matchLines(a, b);
    expect(match.filter((j) => j >= 0).length).toBe(a.length - a.length / 4);
  });

  it("keeps up with thousands of lines that moved, which are on both sides", () => {
    const lines = (count: number) =>
      Array.from({ length: count }, (_, index) => `const a${index} = ${index};\n`);
    const base = lines(20_000);
    // Somebody moved every eighth line to the end: 2500 lines that are still there.
    const theirs = [
      ...base.filter((_, index) => index % 8 !== 3),
      ...base.filter((_, index) => index % 8 === 3),
    ];
    const ours = [...base];
    ours[10_000] = "// 编辑器\n";
    const merged = mergeText(base.join(""), ours.join(""), theirs.join(""));
    expect(merged.conflicts).toEqual([]);
    expect(merged.text).toBe(
      theirs.map((line) => (line === base[10_000] ? ours[10_000] : line)).join(""),
    );
  });

  it("gives up on what is too far apart, soon, and finds little there", () => {
    // The same lines in another order: nothing to leave out, and no few changes to find.
    const random = randomFrom(3);
    const a = Array.from({ length: 60_000 }, (_, index) => index);
    const b = a.toSorted(() => random.int(3) - 1);
    const started = performance.now();
    const match = matchLines(a, b);
    expect(performance.now() - started).toBeLessThan(5000);
    expect(match.filter((j) => j >= 0).length).toBeLessThan(a.length / 2);
  });
});

describe("merging text", () => {
  it("takes the side that changed", () => {
    const base = text("a", "b", "c");
    expect(mergeText(base, base, text("a", "x", "c"))).toEqual({
      text: text("a", "x", "c"),
      conflicts: [],
    });
    expect(mergeText(base, text("a", "x", "c"), base).text).toBe(text("a", "x", "c"));
    expect(mergeText(base, text("x"), text("x")).text).toBe(text("x"));
  });

  it("takes both sides where they changed different lines", () => {
    const base = text("a", "b", "c", "d", "e");
    const merged = mergeText(
      base,
      text("A", "b", "c", "d", "e"),
      text("a", "b", "c", "d", "E", "f"),
    );
    expect(merged).toEqual({ text: text("A", "b", "c", "d", "E", "f"), conflicts: [] });
    const deleted = mergeText(base, text("a", "c", "d", "e"), text("a", "b", "c", "d", "x", "e"));
    expect(deleted.text).toBe(text("a", "c", "d", "x", "e"));
  });

  it("takes a change both made once", () => {
    const base = text("a", "b", "c");
    const merged = mergeText(base, text("a", "x", "c", "y"), text("a", "x", "c"));
    expect(merged).toEqual({ text: text("a", "x", "c", "y"), conflicts: [] });
  });

  it("keeps ours where both changed the same lines, and says where", () => {
    const base = text("a", "b", "c", "d");
    const merged = mergeText(base, text("a", "OURS", "c", "d"), text("a", "THEIRS", "c", "D"));
    expect(merged).toEqual({
      text: text("a", "OURS", "c", "D"),
      conflicts: [
        {
          at: { from: 1, to: 2 },
          base: { from: 1, to: 2 },
          ours: { from: 1, to: 2 },
          theirs: { from: 1, to: 2 },
        },
      ],
    });
  });

  it("keeps ours where both put something new in the same place", () => {
    const merged = mergeText(text("a", "b"), text("a", "x", "b"), text("a", "y", "b"));
    expect(merged.text).toBe(text("a", "x", "b"));
    expect(merged.conflicts).toEqual([
      {
        at: { from: 1, to: 2 },
        base: { from: 1, to: 1 },
        ours: { from: 1, to: 2 },
        theirs: { from: 1, to: 2 },
      },
    ]);
  });

  it("keeps ours where one side took away what the other changed", () => {
    const merged = mergeText(text("a", "b", "c"), text("a", "c"), text("a", "B", "c"));
    expect(merged.text).toBe(text("a", "c"));
    expect(merged.conflicts).toEqual([
      {
        at: { from: 1, to: 1 },
        base: { from: 1, to: 2 },
        ours: { from: 1, to: 1 },
        theirs: { from: 1, to: 2 },
      },
    ]);
  });

  it("brings in what a formatter changed all over, around the line the editor changed", () => {
    const base = Array.from({ length: 10_000 }, (_, index) => `const a${index} = ${index};`);
    const theirs = base.map((line, index) => (index % 5 === 0 ? line.replace(" = ", "=") : line));
    const ours = [...base];
    ours[5002] = "// 编辑器";
    const merged = mergeText(text(...base), text(...ours), text(...theirs));
    expect(merged.conflicts).toEqual([]);
    const expected = theirs.map((line, index) => (index === 5002 ? "// 编辑器" : line));
    expect(merged.text).toBe(text(...expected));
  });

  it("goes by whole lines, with what ends them", () => {
    const merged = mergeText("a\r\nb\r\nc\r\nd", "a\r\nB\r\nc\r\nd", "a\r\nb\r\nc\r\nd\n");
    expect(merged).toEqual({ text: "a\r\nB\r\nc\r\nd\n", conflicts: [] });
    expect(mergeText("", "a\n", "b\n").text).toBe("a\n");
  });

  it("counts changes right next to each other as one, which both sides changed", () => {
    const merged = mergeText(text("a", "b", "c"), text("a", "B", "c"), text("a", "b", "C"));
    expect(merged.text).toBe(text("a", "B", "c"));
    expect(merged.conflicts).toHaveLength(1);
  });
});

/** Lines that are each different, so that where each one went says what happened. */
function edited(lines: readonly string[], random: Random, side: string): string[] {
  const next = [...lines];
  let made = 0;
  for (let count = random.int(5); count > 0; count--) {
    const at = random.int(next.length + 1);
    const roll = random.int(3);
    if (roll === 0 && next.length > 0) next.splice(Math.min(at, next.length - 1), 1);
    else if (roll === 1 && next.length > 0)
      next[Math.min(at, next.length - 1)] = `${side}${made++}`;
    else next.splice(at, 0, ...Array.from({ length: 1 + random.int(2) }, () => `${side}${made++}`));
  }
  return next;
}

const asText = (lines: readonly string[]) => lines.map((line) => `${line}\n`).join("");
const fromText = (each: string) => linesOf(each).map((line) => line.slice(0, -1));

function inOrder(of: readonly string[], within: readonly string[]): boolean {
  let at = 0;
  for (const line of within) if (line === of[at]) at++;
  return at === of.length;
}

describe("merging text, at random", () => {
  it("keeps all of ours, takes theirs where it can, and says where it could not", () => {
    const random = randomFrom(11);
    let conflicted = 0;
    let clean = 0;
    for (let round = 0; round < 4000; round++) {
      const base = Array.from({ length: random.int(12) }, (_, index) => `b${index}`);
      const ours = edited(base, random, "o");
      const theirs = edited(base, random, "t");
      const merged: MergedText = mergeText(asText(base), asText(ours), asText(theirs));
      const result = fromText(merged.text);
      const where = `round ${round}: ${JSON.stringify({ base, ours, theirs, result })}`;
      const inBase = new Set(base);
      const has = new Set(result);
      // Nothing of ours is lost: what it put in is there in its order, and what it took out is not.
      expect(
        inOrder(
          ours.filter((line) => !inBase.has(line)),
          result,
        ),
        where,
      ).toBe(true);
      for (const line of base) if (!ours.includes(line)) expect(has.has(line), where).toBe(false);
      // Lines come from somewhere.
      for (const line of result) {
        expect(inBase.has(line) || ours.includes(line) || theirs.includes(line), where).toBe(true);
      }
      // What a conflict says is where ours is.
      const lines = linesOf(merged.text);
      const mine = linesOf(asText(ours));
      for (const { at, ours: range } of merged.conflicts) {
        expect(lines.slice(at.from, at.to), where).toEqual(mine.slice(range.from, range.to));
      }
      if (merged.conflicts.length > 0) {
        conflicted++;
        continue;
      }
      clean++;
      // Without a conflict all of theirs is there too.
      expect(
        inOrder(
          theirs.filter((line) => !inBase.has(line)),
          result,
        ),
        where,
      ).toBe(true);
      for (const line of base) if (!theirs.includes(line)) expect(has.has(line), where).toBe(false);
      // And it does not matter which side is ours.
      const other = mergeText(asText(base), asText(theirs), asText(ours));
      if (other.conflicts.length === 0) expect(other.text, where).toBe(merged.text);
    }
    expect(conflicted).toBeGreaterThan(200);
    expect(clean).toBeGreaterThan(200);
  });
});
