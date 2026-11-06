import type { ClipState, TimelineState } from "@animaquill/core";
import { describe, expect, it } from "vitest";
import { clipAt, buildModel, firstEndingAfter, forEachBetween, rowAt, type Row } from "./model.ts";

const clip = (id: string, track: string, start: string, duration: string): ClipState => ({
  id,
  track,
  start,
  duration,
  source: { kind: "color", color: "#000000" },
});

function timeline(clips: readonly ClipState[], extra: Partial<TimelineState> = {}): TimelineState {
  return {
    name: "主线",
    sections: { s: { id: "s", duration: "10", order: 0 } },
    tracks: {
      v1: { id: "v1", kind: "video", order: 0 },
      a1: { id: "a1", kind: "audio", order: 1 },
      v2: { id: "v2", kind: "video", order: 2 },
      c1: { id: "c1", kind: "caption", order: 3 },
    },
    clips: Object.fromEntries(clips.map((item) => [item.id, item])),
    transitions: {},
    markers: {},
    overrides: {},
    ...extra,
  };
}

const rowOf = (clips: readonly ClipState[]) =>
  buildModel("main", timeline(clips), "30").rows.find(({ id }) => id === "v1") as Row;

describe("rows", () => {
  it("puts captions on top, the front of the picture above the back, sound last", () => {
    const { rows } = buildModel("main", timeline([]), "30");
    expect(rows.map(({ id }) => id)).toEqual(["c1", "v2", "v1", "a1"]);
  });

  it("counts tracks of each kind from the first", () => {
    const { rows } = buildModel("main", timeline([]), "30");
    expect(rows.map(({ number }) => number)).toEqual([1, 2, 1, 1]);
  });

  it("stacks rows without gaps", () => {
    const model = buildModel("main", timeline([]), "30");
    const { rows, height } = model;
    rows.forEach((row, index) => {
      const next = rows[index + 1];
      expect(next?.top ?? height).toBe(row.top + row.height);
    });
    expect(rowAt(model, -1)).toBeUndefined();
    expect(rowAt(model, 0)?.id).toBe("c1");
    expect(rowAt(model, height)).toBeUndefined();
  });

  it("knows the length of the timeline", () => {
    expect(buildModel("main", timeline([]), "30").duration).toBe(10);
  });
});

describe("clips", () => {
  it("sorts a row by time", () => {
    const row = rowOf([clip("b", "v1", "5", "1"), clip("a", "v1", "1", "1")]);
    expect(row.clips.map(({ id }) => id)).toEqual(["a", "b"]);
  });

  it("reads times with no finite decimal", () => {
    const row = rowOf([clip("a", "v1", "1001/30000", "1")]);
    expect(row.clips[0]?.start).toBeCloseTo(0.033_366_7, 6);
  });

  it("does the work for a clip only once", () => {
    const shared = clip("a", "v1", "1", "1");
    const first = rowOf([shared]);
    const second = rowOf([shared]);
    expect(second.clips[0]).toBe(first.clips[0]);
  });

  it("finds what shows between two moments", () => {
    const row = rowOf([
      clip("a", "v1", "0", "1"),
      clip("b", "v1", "2", "1"),
      clip("c", "v1", "4", "1"),
      clip("d", "v1", "6", "1"),
    ]);
    const seen: string[] = [];
    forEachBetween(row, 2.5, 4.5, ({ id }) => seen.push(id));
    expect(seen).toEqual(["b", "c"]);
  });

  it("does not count clips that only touch the range", () => {
    const row = rowOf([clip("a", "v1", "0", "1"), clip("b", "v1", "2", "1")]);
    const seen: string[] = [];
    forEachBetween(row, 1, 2, ({ id }) => seen.push(id));
    expect(seen).toEqual([]);
  });

  it("finds a long clip that started much earlier, behind short ones", () => {
    const row = rowOf([
      clip("long", "v1", "0", "100"),
      clip("short", "v1", "1", "1"),
      clip("later", "v1", "50", "1"),
    ]);
    const seen: string[] = [];
    forEachBetween(row, 10, 20, ({ id }) => seen.push(id));
    expect(seen).toEqual(["long"]);
    expect(firstEndingAfter(row, 10)).toBe(0);
  });

  it("finds the clip under a moment, the later one where two overlap", () => {
    const row = rowOf([clip("a", "v1", "0", "5"), clip("b", "v1", "3", "5")]);
    expect(clipAt(row, 1)?.id).toBe("a");
    expect(clipAt(row, 4)?.id).toBe("b");
    expect(clipAt(row, 8)).toBeUndefined();
    expect(clipAt(row, 7.999)?.id).toBe("b");
  });
});
