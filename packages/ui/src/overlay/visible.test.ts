import { describe, expect, it } from "vitest";
import { visibleCircle, visibleLines } from "./visible.ts";

const area = { x: 0, y: 0, width: 960, height: 540 };

const inside = ({ x, y }: { x: number; y: number }, margin = 1e-6) =>
  x >= area.x - margin &&
  y >= area.y - margin &&
  x <= area.x + area.width + margin &&
  y <= area.y + area.height + margin;

describe("what of a line is on the picture", () => {
  it("is all of a line inside it", () => {
    const points = [
      { x: 10, y: 10 },
      { x: 100, y: 50 },
      { x: 200, y: 10 },
    ];
    expect(visibleLines(points, area, false)).toEqual([points]);
  });

  it("is cut at the edges, however far the line goes", () => {
    const lines = visibleLines(
      [
        { x: -1e6, y: 270 },
        { x: 1e6, y: 270 },
      ],
      area,
      false,
    );
    expect(lines).toHaveLength(1);
    const [start, end] = lines[0] ?? [];
    expect(start?.x).toBeCloseTo(0, 6);
    expect(end?.x).toBeCloseTo(960, 6);
    expect(start?.y).toBe(270);
    expect(end?.y).toBe(270);
  });

  it("goes in pieces where it leaves and comes back, and is nothing outside", () => {
    const lines = visibleLines(
      [
        { x: 100, y: 100 },
        { x: 100, y: -100 },
        { x: 300, y: -100 },
        { x: 300, y: 100 },
      ],
      area,
      false,
    );
    expect(lines).toHaveLength(2);
    expect(
      visibleLines(
        [
          { x: -10, y: -10 },
          { x: -500, y: 900 },
        ],
        area,
        false,
      ),
    ).toEqual([]);
  });

  it("closes a shape that goes around", () => {
    const square = [
      { x: 10, y: 10 },
      { x: 20, y: 10 },
      { x: 20, y: 20 },
      { x: 10, y: 20 },
    ];
    const [line] = visibleLines(square, area, true);
    expect(line?.at(-1)).toEqual({ x: 10, y: 10 });
  });
});

describe("what of a circle is on the picture", () => {
  it("is all of one inside it", () => {
    expect(visibleCircle({ x: 480, y: 270 }, 50, area)).toBe("whole");
  });

  it("is nothing of one around the picture or away from it", () => {
    expect(visibleCircle({ x: 480, y: 270 }, 5000, area)).toEqual([]);
    expect(visibleCircle({ x: 5000, y: 5000 }, 100, area)).toEqual([]);
    expect(visibleCircle({ x: 480, y: 270 }, 0, area)).toEqual([]);
  });

  it("is the arcs on it, as lines of a few points, however large the circle", () => {
    const arcs = visibleCircle({ x: 480, y: 1e6 + 300 }, 1e6, area);
    if (arcs === "whole") throw new Error("not whole");
    expect(arcs).toHaveLength(1);
    const [arc] = arcs;
    expect(arc?.length).toBeLessThan(400);
    for (const point of arc ?? []) expect(inside(point, 1)).toBe(true);
    const ys = (arc ?? []).map(({ y }) => y);
    expect(Math.min(...ys)).toBeCloseTo(300, 0);
  });

  it("is each arc of one that goes in and out", () => {
    const arcs = visibleCircle({ x: 0, y: 270 }, 200, area);
    if (arcs === "whole") throw new Error("not whole");
    expect(arcs).toHaveLength(1);
    for (const point of arcs[0] ?? []) expect(inside(point, 1)).toBe(true);
    const corner = visibleCircle({ x: 960, y: 540 }, 100, area);
    if (corner === "whole") throw new Error("not whole");
    expect(corner).toHaveLength(1);
  });
});
