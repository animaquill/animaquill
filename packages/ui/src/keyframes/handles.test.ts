import { MAX_SPLIT_Y, MIN_SPLIT_Y, compileChannel, sample } from "@animaquill/core";
import { Animation, type Key } from "@animaquill/schema";
import { describe, expect, it } from "vitest";
import {
  dragHandle,
  handlePoint,
  shareOf,
  tangentOf,
  withTangent,
  type ChangedKeys,
  type CurvePoint,
  type HandleSide,
} from "./handles.ts";

/** Keys at 0, 1 and 3 seconds with the values 0, 10 and 30, all straight. */
const line: readonly Key[] = [
  { time: "0", value: 0 },
  { time: "1", value: 10 },
  { time: "3", value: 30 },
];

/** A peak: up and down again. */
const peak: readonly Key[] = [
  { time: "0", value: 0 },
  { time: "1", value: 10 },
  { time: "2", value: 0 },
];

const applied = (keys: readonly Key[], changed: ChangedKeys): Key[] => {
  const all = [...keys];
  for (const [index, key] of changed) all[index] = key;
  return all;
};

const drag = (
  keys: readonly Key[],
  index: number,
  side: HandleSide,
  to: CurvePoint,
  mode: "aligned" | "broken" = "broken",
) => {
  const dragged = dragHandle({ keys, index, side, to, mode });
  if (!dragged) throw new Error("no handle");
  return { ...dragged, keys: applied(keys, dragged.changed) };
};

/** How steep a handle leaves its key, in units per second. */
const slopeOf = (keys: readonly Key[], index: number, side: HandleSide) => {
  const point = handlePoint(keys, index, side) as CurvePoint;
  const key = keys[index] as Key;
  return (point.v - (key.value as number)) / (point.t - Number(key.time));
};

describe("a handle", () => {
  it("of a straight stretch is where a bezier would be straight, and a hold has none", () => {
    const [x1 = 0, y1 = 0] = shareOf(line, 0, "out") ?? [];
    const [x2 = 0, y2 = 0] = shareOf(line, 1, "in") ?? [];
    for (const [share, expected] of [
      [x1, 1 / 3],
      [y1, 1 / 3],
      [x2, 2 / 3],
      [y2, 2 / 3],
    ]) {
      expect(share).toBeCloseTo(expected as number, 12);
    }
    const point = handlePoint(line, 1, "out");
    expect(point?.t).toBeCloseTo(1 + 2 / 3, 12);
    expect(point?.v).toBeCloseTo(10 + 20 / 3, 12);
    expect(handlePoint(line, 0, "in")).toBeUndefined();
    expect(handlePoint(line, 2, "out")).toBeUndefined();
    const holding = [{ ...(line[0] as Key), interp: "hold" as const }, ...line.slice(1)];
    expect(handlePoint(holding, 0, "out")).toBeUndefined();
    expect(handlePoint(holding, 1, "in")).toBeUndefined();
  });

  it("goes where the pointer is, as a share of its stretch, and makes the stretch a bezier", () => {
    const { keys, clamped } = drag(line, 0, "out", { t: 0.25, v: 8 });
    expect(clamped).toBe(false);
    expect(keys[0]).toMatchObject({ interp: "bezier", out: [0.25, 0.8], tangent: "broken" });
    // The other end of the stretch stays where it showed, so it is still straight there.
    expect(keys[1]?.in).toEqual([0.666667, 0.666667]);
    // The curve is what the handle says: it rises fast and eases into the next key.
    const channel = compileChannel({ keys }, "number");
    if (!channel) throw new Error("no channel");
    expect(sample(channel, 0.25) as number).toBeGreaterThan(2.5 + 1);
    expect(sample(channel, 2) as number).toBeCloseTo(20, 9);
    // A drag of the handle that comes in changes the stretch before the key.
    const back = drag(line, 1, "in", { t: 0.9, v: 4 });
    expect(back.keys[0]).toMatchObject({ interp: "bezier", out: [0.333333, 0.333333] });
    expect(back.keys[1]?.in).toEqual([0.9, 0.4]);
    expect(back.keys[2]).toBe(line[2]);
  });

  it("stops at what a key can hold, and says so", () => {
    const late = drag(line, 0, "out", { t: 5, v: 5 });
    expect(late.clamped).toBe(true);
    expect(late.keys[0]?.out).toEqual([1, 0.5]);
    const early = drag(line, 1, "in", { t: -2, v: 10 });
    expect(early.clamped).toBe(true);
    expect(early.keys[1]?.in?.[0]).toBe(0);
    const high = drag(line, 0, "out", { t: 0.5, v: 1000 });
    expect(high.clamped).toBe(true);
    expect(high.keys[0]?.out).toEqual([0.5, MAX_SPLIT_Y]);
    const low = drag(line, 0, "out", { t: 0.5, v: -1000 });
    expect(low.keys[0]?.out).toEqual([0.5, MIN_SPLIT_Y]);
    // What it holds is what a project can take.
    expect(Animation.safeParse({ keys: low.keys }).success).toBe(true);
    expect(Animation.safeParse({ keys: high.keys }).success).toBe(true);
  });

  it("only moves along a stretch that does not change, which has nothing to bend", () => {
    const flat: Key[] = [
      { time: "0", value: 5, interp: "bezier", out: [0.2, 0.7] },
      { time: "1", value: 5 },
    ];
    const { keys } = drag(flat, 0, "out", { t: 0.6, v: 900 });
    expect(keys[0]?.out).toEqual([0.6, 0.7]);
  });

  it("broken leaves the other handle where it is", () => {
    const { keys } = drag(line, 1, "out", { t: 1.5, v: 30 }, "broken");
    expect(keys[1]?.in).toBeUndefined();
    expect(keys[0]).toBe(line[0]);
    expect(keys[1]).toMatchObject({ tangent: "broken", interp: "bezier", out: [0.25, 1] });
  });

  it("aligned takes the other handle along on one line through the key, as far as it reached", () => {
    const { keys } = drag(line, 1, "out", { t: 1.5, v: 30 }, "aligned");
    expect(keys[1]?.tangent).toBe("aligned");
    // The other handle keeps how far it reached in time, and turns to the same slope.
    expect(keys[1]?.in?.[0]).toBeCloseTo(2 / 3, 5);
    expect(slopeOf(keys, 1, "in")).toBeCloseTo(slopeOf(keys, 1, "out"), 3);
    expect(slopeOf(keys, 1, "out")).toBeCloseTo(40, 6);
    // The stretch before became a bezier that still leaves its key as a line would.
    expect(keys[0]).toMatchObject({ interp: "bezier", out: [0.333333, 0.333333] });
    // The other way round as well.
    const back = drag(line, 1, "in", { t: 0.5, v: 10 }, "aligned");
    expect(slopeOf(back.keys, 1, "out")).toBeCloseTo(0, 6);
    expect(slopeOf(back.keys, 1, "in")).toBeCloseTo(0, 6);
  });

  it("aligned gives a handle right on its key a third of its stretch to reach", () => {
    const eased: Key[] = [
      { time: "0", value: 0, interp: "bezier", out: [0.42, 0] },
      { time: "1", value: 10, interp: "bezier", out: [0, 0] },
      { time: "2", value: 0 },
    ];
    const { keys } = drag(eased, 1, "in", { t: 0.5, v: 5 }, "aligned");
    expect(keys[1]?.out?.[0]).toBeCloseTo(1 / 3, 5);
    expect(slopeOf(keys, 1, "out")).toBeCloseTo(slopeOf(keys, 1, "in"), 3);
  });

  it("is not there to drag where nothing is steered", () => {
    expect(
      dragHandle({ keys: line, index: 0, side: "in", to: { t: 0, v: 0 }, mode: "broken" }),
    ).toBeUndefined();
  });
});

describe("how a key changes its handles", () => {
  it("is what it says, or else what it looks like: smooth stays smooth, a corner a corner", () => {
    expect(tangentOf(line, 1)).toBe("aligned");
    expect(tangentOf(peak, 1)).toBe("broken");
    expect(tangentOf([{ ...(line[0] as Key) }, { ...(line[1] as Key), tangent: "auto" }], 1)).toBe(
      "auto",
    );
    // An end has one handle, and nothing to be on a line with.
    expect(tangentOf(line, 0)).toBe("broken");
  });

  it("aligned puts the two handles of a corner on one line", () => {
    const keys = applied(peak, withTangent(peak, [1], "aligned"));
    expect(keys[1]?.tangent).toBe("aligned");
    expect(slopeOf(keys, 1, "in")).toBeCloseTo(0, 6);
    expect(slopeOf(keys, 1, "out")).toBeCloseTo(0, 6);
    // Without saying so it now looks aligned as well.
    const unsaid = keys.map(({ tangent: _tangent, ...rest }) => rest);
    expect(tangentOf(unsaid, 1)).toBe("aligned");
  });

  it("automatic works out what is a bezier, and leaves how keys go on as it is", () => {
    const holding: Key[] = [
      { time: "0", value: 0 },
      { time: "1", value: 10, interp: "hold" },
      { time: "3", value: 30 },
    ];
    const kept = applied(holding, withTangent(holding, [1], "auto"));
    expect(kept).toEqual([holding[0], { ...holding[1], tangent: "auto" }, holding[2]]);
    const curved: Key[] = [
      { time: "0", value: 0, interp: "bezier", out: [0.5, 0.5] },
      { time: "1", value: 10, interp: "bezier", out: [0.9, 0.1] },
      { time: "3", value: 30 },
    ];
    const keys = applied(curved, withTangent(curved, [1], "auto"));
    expect(keys[1]).toMatchObject({ tangent: "auto", interp: "bezier" });
    expect(slopeOf(keys, 1, "in")).toBeCloseTo(slopeOf(keys, 1, "out"), 3);
    expect(slopeOf(keys, 1, "out")).toBeGreaterThan(0);
    expect(keys[0]).toEqual(curved[0]);
  });

  it("aligned next to a stretch that does not change is flat on both sides, and stays so", () => {
    const flat: Key[] = [
      { time: "0", value: 0 },
      { time: "1", value: 10 },
      { time: "2", value: 10 },
    ];
    const keys = applied(flat, withTangent(flat, [1], "aligned"));
    expect(slopeOf(keys, 1, "in")).toBeCloseTo(0, 9);
    expect(slopeOf(keys, 1, "out")).toBeCloseTo(0, 9);
    expect(
      tangentOf(
        keys.map(({ tangent: _tangent, ...rest }) => rest),
        1,
      ),
    ).toBe("aligned");
    // Once it is so, saying it again changes nothing.
    const again = withTangent(keys, [1], "aligned");
    expect(applied(keys, again)).toEqual(keys);
  });

  it("aligned next to a stretch that does not change keeps a dragged handle flat, and says so", () => {
    const flat: Key[] = [
      { time: "0", value: 0 },
      { time: "1", value: 10, tangent: "aligned" },
      { time: "2", value: 10 },
    ];
    const { keys, clamped } = drag(flat, 1, "in", { t: 0.7, v: 4 }, "aligned");
    expect(clamped).toBe(true);
    expect(slopeOf(keys, 1, "in")).toBeCloseTo(0, 9);
    expect(keys[1]?.in?.[0]).toBeCloseTo(0.7, 9);
  });

  it("a stretch that was a bezier already keeps its start as it is", () => {
    const curved: Key[] = [
      { time: "0", value: 0, interp: "bezier", out: [0.2, 0.1] },
      { time: "1", value: 10 },
      { time: "3", value: 30 },
    ];
    const dragged = dragHandle({
      keys: curved,
      index: 1,
      side: "in",
      to: { t: 0.5, v: 5 },
      mode: "broken",
    });
    expect([...(dragged?.changed.keys() ?? [])]).toEqual([1]);
  });

  it("goes to a millionth of its stretch, as a handle that is worked out", () => {
    const { keys } = drag(line, 0, "out", { t: 0.1234567, v: 1.2345678 });
    expect(keys[0]?.out).toEqual([0.123457, 0.123457]);
  });

  it("broken only says so", () => {
    const changed = withTangent(line, [1], "broken");
    expect([...changed.keys()]).toEqual([1]);
    expect(changed.get(1)).toEqual({ ...line[1], tangent: "broken" });
  });
});
