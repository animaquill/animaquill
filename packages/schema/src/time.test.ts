import { describe, expect, it } from "vitest";
import {
  add,
  compare,
  divide,
  formatTime,
  fromSeconds,
  multiply,
  normalizeTime,
  parseTime,
  rational,
  subtract,
  toSeconds,
} from "./time.ts";

const t = parseTime;
const text = formatTime;

describe("reading and writing", () => {
  it.each([
    ["12.5", "12.5"],
    ["25/2", "12.5"],
    ["12.50", "12.5"],
    ["0012", "12"],
    ["12/1", "12"],
    ["0", "0"],
    ["0.0", "0"],
    ["-0", "0"],
    ["-1.5", "-1.5"],
    ["-3/2", "-1.5"],
    ["1/3", "1/3"],
    ["2/6", "1/3"],
    ["1001/30000", "1001/30000"],
    ["1/48000", "1/48000"],
    ["1/1024", "1/1024"],
    ["1/512", "0.001953125"],
    ["0.000000001", "0.000000001"],
    ["0.0000000001", "1/10000000000"],
  ])("writes %s as %s", (input, output) => {
    expect(text(t(input))).toBe(output);
    expect(normalizeTime(input)).toBe(output);
  });

  it("gives every value exactly one spelling, which reads back as the same value", () => {
    for (const input of ["1/3", "12.5", "1001/30000", "7", "-2/3", "0.1"]) {
      const once = text(t(input));
      expect(text(t(once))).toBe(once);
      expect(compare(t(once), t(input))).toBe(0);
    }
  });

  it.each(["", "abc", "1/0", "1/00", "1.5/2", "1/2/3", ".5", "5.", "1e3", " 1", "1 ", "+1", "--1"])(
    "refuses %j",
    (input) => {
      expect(() => t(input)).toThrow();
      expect(normalizeTime(input)).toBe(input);
    },
  );

  it("keeps huge values exact", () => {
    const big = "123456789012345678901234567891/7";
    expect(text(t(big))).toBe(big);
  });
});

describe("arithmetic", () => {
  it("is exact where floats are not", () => {
    expect(text(add(t("0.1"), t("0.2")))).toBe("0.3");
    expect(0.1 + 0.2).not.toBe(0.3);
  });

  it("does not drift over many frames at 29.97", () => {
    const frame = t("1001/30000");
    let total = t("0");
    for (let i = 0; i < 108000; i++) total = add(total, frame);
    expect(text(total)).toBe("3603.6");
  });

  it("adds, subtracts, multiplies and divides", () => {
    expect(text(subtract(t("1"), t("1/3")))).toBe("2/3");
    expect(text(multiply(t("1001/30000"), t("30")))).toBe("1.001");
    expect(text(divide(t("1"), t("1/3")))).toBe("3");
  });

  it("orders values", () => {
    expect(compare(t("1/3"), t("0.34"))).toBeLessThan(0);
    expect(compare(t("0.34"), t("1/3"))).toBeGreaterThan(0);
    expect(compare(t("2/6"), t("1/3"))).toBe(0);
  });

  it("keeps fractions reduced with a positive denominator", () => {
    expect(rational(2n, -4n)).toEqual({ n: -1n, d: 2n });
    expect(rational(0n, 5n)).toEqual({ n: 0n, d: 1n });
    expect(() => rational(1n, 0n)).toThrow();
  });
});

describe("seconds", () => {
  it("converts for drawing", () => {
    expect(toSeconds(t("12.5"))).toBe(12.5);
    expect(toSeconds(t("1/3"))).toBeCloseTo(0.3333333, 6);
  });

  it("takes the decimal people mean, not the binary noise", () => {
    expect(text(fromSeconds(0.1))).toBe("0.1");
    expect(text(fromSeconds(4.163))).toBe("4.163");
    expect(text(fromSeconds(0.1 + 0.2))).toBe("0.3");
  });

  it("refuses what is not a number", () => {
    expect(() => fromSeconds(Number.NaN)).toThrow();
    expect(() => fromSeconds(Number.POSITIVE_INFINITY)).toThrow();
  });
});
