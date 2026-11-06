import { describe, expect, it } from "vitest";
import { ZERO, parseTime } from "@animaquill/schema";
import { SnapPoints } from "./snap.ts";

const at = (...moments: number[]) =>
  new SnapPoints(moments.map((seconds) => ({ seconds, exact: () => ZERO })));

describe("snapping", () => {
  it("finds the nearest point", () => {
    expect(at(1, 2, 3).nearest(2.2, 1)?.seconds).toBe(2);
    expect(at(1, 2, 3).nearest(2.8, 1)?.seconds).toBe(3);
  });

  it("finds nothing further away than it should look", () => {
    expect(at(1).nearest(2, 0.5)).toBeUndefined();
  });

  it("works past both ends", () => {
    expect(at(1, 2).nearest(0.9, 0.5)?.seconds).toBe(1);
    expect(at(1, 2).nearest(2.1, 0.5)?.seconds).toBe(2);
  });

  it("does not need sorted points", () => {
    expect(at(3, 1, 2).nearest(1.1, 0.5)?.seconds).toBe(1);
  });

  it("copes with nothing to snap to", () => {
    expect(at().nearest(1, 1)).toBeUndefined();
  });

  it("keeps the exact time of a point", () => {
    const exact = parseTime("1001/30000");
    const points = new SnapPoints([{ seconds: 0.033, exact: () => exact }]);
    expect(points.nearest(0.03, 1)?.exact()).toBe(exact);
  });
});
