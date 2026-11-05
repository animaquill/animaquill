import { describe, expect, it } from "vitest";
import { fuzzyMatch } from "./fuzzy.ts";

const score = (query: string, text: string) => fuzzyMatch(query, text)?.score ?? -Infinity;

describe("fuzzyMatch", () => {
  it("finds characters in order, with gaps", () => {
    expect(fuzzyMatch("时轴", "打开选项卡：时间轴")?.positions).toEqual([6, 8]);
  });

  it("does not match characters out of order", () => {
    expect(fuzzyMatch("轴时", "时间轴")).toBeUndefined();
  });

  it("does not match what is not there", () => {
    expect(fuzzyMatch("音频", "时间轴")).toBeUndefined();
  });

  it("matches everything with an empty query", () => {
    expect(fuzzyMatch("", "时间轴")).toEqual({ score: 0, positions: [] });
    expect(fuzzyMatch("   ", "时间轴")).toEqual({ score: 0, positions: [] });
  });

  it("ignores case and spaces in the query", () => {
    expect(fuzzyMatch("AI", "切换工作区：ai")).toBeDefined();
    expect(fuzzyMatch("打开 时间", "打开选项卡：时间轴")).toBeDefined();
  });

  it("prefers characters next to each other", () => {
    expect(score("时间", "打开时间轴")).toBeGreaterThan(score("时间", "时长和空间"));
  });

  it("prefers the start of a word", () => {
    expect(score("t", "view.timeline")).toBeGreaterThan(score("t", "view.at"));
    expect(score("时", "打开：时间轴")).toBeGreaterThan(score("时", "打开时间轴"));
  });

  it("finds the best place, not the first one", () => {
    expect(fuzzyMatch("ab", "a xab")?.positions).toEqual([3, 4]);
  });

  it("prefers an earlier match when nothing else differs", () => {
    expect(score("时", "时间轴")).toBeGreaterThan(score("时", "和时间轴"));
  });

  it("counts characters, not UTF-16 units", () => {
    expect(fuzzyMatch("b", "😀b")?.positions).toEqual([1]);
  });
});
