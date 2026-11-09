import { parseTime, type Rational } from "@animaquill/schema";
import type { ClipState } from "@animaquill/core";
import { describe, expect, it } from "vitest";
import { frameRate } from "../timeline/frames.ts";
import type { ClipBox } from "../timeline/model.ts";
import { draggedRange, partAt, rangeOf } from "./effect-ranges.ts";

const rate = frameRate("30");

/** A clip from 2 to 6 seconds on the timeline. */
const box = {
  id: "c",
  start: 2,
  end: 6,
  clip: {
    id: "c",
    track: "v",
    start: "2",
    duration: "4",
    source: { kind: "color", color: "#000000" },
  } as ClipState,
} as ClipBox;

const time = (value: string): Rational => parseTime(value);
const seconds = ({ from, to }: { from: Rational; to: Rational }) => [
  Number(from.n) / Number(from.d),
  Number(to.n) / Number(to.d),
];

describe("the bar of when an effect works", () => {
  it("is all of the clip without saying, and never past it", () => {
    expect(seconds(rangeOf(box, {}))).toEqual([0, 4]);
    expect(seconds(rangeOf(box, { start: "1", end: "9" }))).toEqual([1, 4]);
  });

  it("moves an end to whole frames, and no closer than a frame to the other end", () => {
    const range = { from: time("1"), to: time("3") };
    expect(seconds(draggedRange(box, range, "start", 0.51, rate))).toEqual([1.5, 3]);
    expect(seconds(draggedRange(box, range, "start", 5, rate))[0]).toBeCloseTo(3 - 1 / 30);
    expect(seconds(draggedRange(box, range, "start", -5, rate))).toEqual([0, 3]);
    expect(seconds(draggedRange(box, range, "end", 9, rate))).toEqual([1, 4]);
    expect(seconds(draggedRange(box, range, "end", -9, rate))[1]).toBeCloseTo(1 + 1 / 30);
  });

  it("moves as a whole within the clip, as long as it was", () => {
    const range = { from: time("1"), to: time("3") };
    expect(seconds(draggedRange(box, range, "move", 0.5, rate))).toEqual([1.5, 3.5]);
    expect(seconds(draggedRange(box, range, "move", 3, rate))).toEqual([2, 4]);
    expect(seconds(draggedRange(box, range, "move", -3, rate))).toEqual([0, 2]);
  });

  it("takes a press at an end as that end, and in between as all of it", () => {
    const bar = { left: 100, right: 200, top: 50 };
    const y = 52;
    expect(partAt(bar, 98, y)).toBe("start");
    expect(partAt(bar, 150, y)).toBe("move");
    expect(partAt(bar, 203, y)).toBe("end");
    expect(partAt(bar, 120, 20)).toBeUndefined();
    expect(partAt(bar, 300, y)).toBeUndefined();
  });
});
