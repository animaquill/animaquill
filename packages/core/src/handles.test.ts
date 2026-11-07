import type { ObjectDescriptor } from "@animaquill/schema";
import { describe, expect, it } from "vitest";
import {
  HANDLE_LIMITS,
  MIN_SCALE_FACTOR,
  readHandles,
  solveHandle,
  turnBetween,
  type GrabHandle,
  type HandleDrag,
} from "./handles.ts";

const arm: ObjectDescriptor = {
  id: "arm",
  properties: [
    { path: "x", type: "number", default: 0 },
    { path: "y", type: "number", default: 0 },
    { path: "rotation", type: "angle", default: 0 },
    { path: "length", type: "number", default: 100, min: 0 },
    { path: "tint", type: "color", default: "#ffffff" },
    { path: "visible", type: "boolean", default: true },
  ],
};

const rig: ObjectDescriptor = { id: "rig.hand", properties: [{ path: "x", type: "number" }] };

const read = (raw: unknown) => readHandles(raw, [arm, rig]);
const one = (handle: unknown) => read([{ object: "arm", handles: [handle] }]);
const codes = (raw: unknown) => read(raw).problems.map(({ code }) => code);

describe("what a scene says about handles", () => {
  it("keeps every kind that works, as new data", () => {
    const raw = [
      {
        object: "arm",
        bounds: [-60, -300, 120, 320],
        handles: [
          { kind: "move", id: "base", at: [10, 20], bind: { x: "x", y: "y" } },
          { kind: "rotate", id: "turn", at: [10, 20], radius: 80, bind: "rotation" },
          { kind: "scale", id: "tip", at: [110, 20], center: [10, 20], bind: "length" },
          { kind: "scale", id: "both", at: [5, 5], center: [0, 0], bind: { x: "x", y: "y" } },
          {
            kind: "line",
            points: [
              [0, 0],
              [10, 10],
            ],
          },
          {
            kind: "polyline",
            points: [
              [0, 0],
              [10, 10],
              [20, 0],
            ],
          },
          { kind: "circle", at: [0, 0], radius: 40 },
        ],
      },
    ];
    const { objects, problems } = read(raw);
    expect(problems).toEqual([]);
    expect(objects).toEqual(raw);
    const [first] = raw[0]?.handles ?? [];
    (first as { at: number[] }).at[0] = 999;
    expect(objects[0]?.handles[0]).toMatchObject({ at: [10, 20] });
  });

  it("only lets a handle bind numbers of its own object", () => {
    const binds = [
      "transform.x",
      "object.other.x",
      "other.x",
      "tint",
      "visible",
      "missing",
      "__proto__",
      "constructor",
      { x: "transform.x" },
      { x: "x", y: "tint" },
      {},
      7,
    ];
    for (const bind of binds) {
      const { objects, problems } = one({ kind: "move", id: "m", at: [0, 0], bind });
      expect(objects, JSON.stringify(bind)).toEqual([]);
      expect(problems).toEqual([{ code: "handle-bind", target: "arm.m" }]);
    }
    expect(one({ kind: "rotate", id: "r", at: [0, 0], radius: 5, bind: "tint" }).problems).toEqual([
      { code: "handle-bind", target: "arm.r" },
    ]);
  });

  it("takes no handles for an object that did not register, or for one twice", () => {
    const move = { kind: "move", id: "m", at: [0, 0], bind: { x: "x" } };
    const { objects, problems } = read([
      { object: "ghost", handles: [move] },
      { object: "arm", handles: [move] },
      { object: "arm", handles: [move] },
      { object: "rig.hand", handles: [move] },
      { object: "__proto__", handles: [move] },
    ]);
    expect(objects.map(({ object }) => object)).toEqual(["arm", "rig.hand"]);
    expect(problems).toEqual([
      { code: "handle-object", target: "ghost" },
      { code: "handle-object", target: "arm" },
      { code: "handle-object", target: "__proto__" },
    ]);
  });

  it("says which kinds are not there yet, and which are no kind at all", () => {
    for (const kind of ["custom", "move3d", "rotate3d"]) {
      expect(one({ kind, id: "c", at: [0, 0] }).problems).toEqual([
        { code: "handle-kind", target: `arm.${kind}` },
      ]);
    }
    expect(one({ kind: "<img src=x>", id: "c" }).problems).toEqual([
      { code: "handle-kind", target: "arm.?" },
    ]);
  });

  it("needs an id that a path can hold, once in an object", () => {
    const move = (id: unknown) => ({ kind: "move", id, at: [0, 0], bind: { x: "x" } });
    expect(codes([{ object: "arm", handles: [move("a.b"), move(""), move(3)] }])).toEqual([
      "handle-id",
      "handle-id",
      "handle-id",
    ]);
    const { objects, problems } = read([{ object: "arm", handles: [move("a"), move("a")] }]);
    expect(objects[0]?.handles).toHaveLength(1);
    expect(problems).toEqual([{ code: "handle-id", target: "arm.a" }]);
  });

  it("only takes places that are numbers, and not too far away", () => {
    const places = [[Number.NaN, 0], [0, Infinity], [0], [0, 0, 0], "0,0", [2e6, 0], ["1", 2]];
    for (const at of places) {
      expect(
        codes([{ object: "arm", handles: [{ kind: "move", id: "m", at, bind: { x: "x" } }] }]),
      ).toEqual(["handle-point"]);
    }
    for (const radius of [0, -5, Number.NaN, 2e6]) {
      expect(codes([{ object: "arm", handles: [{ kind: "circle", at: [0, 0], radius }] }])).toEqual(
        ["handle-point"],
      );
    }
    const noCenter = { kind: "scale", id: "s", at: [1, 1], bind: "length" };
    expect(one(noCenter).problems).toEqual([{ code: "handle-point", target: "arm.s" }]);
    expect(codes([{ object: "arm", handles: [{ kind: "line", points: [[0, 0]] }] }])).toEqual([
      "handle-point",
    ]);
  });

  it("drops bounds that are no box, and keeps the handles", () => {
    const move = { kind: "move", id: "m", at: [0, 0], bind: { x: "x" } };
    for (const bounds of [[0, 0, -1, 5], [0, 0, 5], [0, 0, 5, Number.NaN], "box"]) {
      const { objects, problems } = read([{ object: "arm", bounds, handles: [move] }]);
      expect(objects).toEqual([{ object: "arm", handles: [move] }]);
      expect(problems).toEqual([{ code: "handle-bounds", target: "arm" }]);
    }
  });

  it("cuts down what is too much, keeps what came first, and says so", () => {
    const many = Array.from({ length: HANDLE_LIMITS.handles + 5 }, (_, index) => ({
      kind: "move",
      id: `m${index}`,
      at: [index, 0],
      bind: { x: "x" },
    }));
    const { objects, problems } = read([{ object: "arm", handles: many }]);
    expect(objects[0]?.handles).toHaveLength(HANDLE_LIMITS.handles);
    expect(objects[0]?.handles[0]).toMatchObject({ id: "m0" });
    expect(problems).toEqual([{ code: "handles-too-many", target: "handles" }]);

    const point = (index: number) => [index, index];
    const long = Array.from({ length: HANDLE_LIMITS.points + 10 }, (_, index) => point(index));
    const lines = read([
      {
        object: "arm",
        handles: [
          { kind: "polyline", points: long },
          { kind: "line", points: long.slice(0, 2) },
        ],
      },
    ]);
    const kept = lines.objects[0]?.handles ?? [];
    expect(kept).toHaveLength(1);
    expect((kept[0] as { readonly points: readonly unknown[] }).points).toHaveLength(
      HANDLE_LIMITS.points,
    );
    expect(lines.problems).toEqual([{ code: "handles-too-many", target: "points" }]);

    const objects2 = Array.from({ length: HANDLE_LIMITS.objects + 1 }, () => ({ object: "arm" }));
    expect(codes(objects2)).toContain("handles-too-many");
  });

  it("is nothing for what is no list", () => {
    for (const raw of [undefined, null, 7, "x", { object: "arm" }]) {
      expect(read(raw)).toEqual({ objects: [], problems: [] });
    }
  });

  it("reads what has a prototype of its own as nothing of that", () => {
    const sneaky = Object.create({ kind: "move", id: "m", at: [0, 0], bind: { x: "x" } });
    expect(read([{ object: "arm", handles: [sneaky] }]).objects).toEqual([]);
  });
});

const drag = (extra: Partial<HandleDrag> = {}): HandleDrag => ({
  from: [0, 0],
  to: [0, 0],
  turned: 0,
  shift: false,
  ...extra,
});

const values: Readonly<Record<string, number>> = { x: 10, y: 20, rotation: 30, length: 100 };
const start = (bind: string) => values[bind];
const solved = (handle: GrabHandle, moved: Partial<HandleDrag>) =>
  Object.fromEntries(solveHandle(handle, drag(moved), start));

describe("what dragging a handle does", () => {
  const move: GrabHandle = { kind: "move", id: "m", at: [0, 0], bind: { x: "x", y: "y" } };

  it("adds how far a move went", () => {
    expect(solved(move, { from: [5, 5], to: [8, 1] })).toEqual({ x: 13, y: 16 });
  });

  it("keeps a move to the way it went further with Shift", () => {
    expect(solved(move, { from: [0, 0], to: [8, 3], shift: true })).toEqual({ x: 18, y: 20 });
    expect(solved(move, { from: [0, 0], to: [-2, -9], shift: true })).toEqual({ x: 10, y: 11 });
  });

  it("only changes what it binds, and what there is a value for", () => {
    const onlyX: GrabHandle = { kind: "move", id: "m", at: [0, 0], bind: { x: "x" } };
    expect(solved(onlyX, { to: [4, 4] })).toEqual({ x: 14 });
    const missing: GrabHandle = { kind: "move", id: "m", at: [0, 0], bind: { x: "gone" } };
    expect(solved(missing, { to: [4, 4] })).toEqual({});
  });

  it("adds how far a rotate handle went around, which can be more than a turn", () => {
    const rotate: GrabHandle = {
      kind: "rotate",
      id: "r",
      at: [0, 0],
      radius: 10,
      bind: "rotation",
    };
    expect(solved(rotate, { turned: 47 })).toEqual({ rotation: 77 });
    expect(solved(rotate, { turned: 720 })).toEqual({ rotation: 750 });
    expect(solved(rotate, { turned: 47, shift: true })).toEqual({ rotation: 75 });
    expect(solved(rotate, { turned: -25, shift: true })).toEqual({ rotation: 0 });
    expect(solved(rotate, { turned: -38, shift: true })).toEqual({ rotation: -15 });
  });

  it("multiplies by how much further from the middle the pointer got", () => {
    const scale: GrabHandle = {
      kind: "scale",
      id: "s",
      at: [100, 0],
      center: [0, 0],
      bind: "length",
    };
    expect(solved(scale, { from: [100, 0], to: [150, 0] }).length).toBeCloseTo(150, 9);
    // What goes sideways does not count.
    expect(solved(scale, { from: [100, 0], to: [50, 80] }).length).toBeCloseTo(50, 9);
    // Grabbed beside the handle, it starts from there and does not jump.
    expect(solved(scale, { from: [90, 3], to: [90, 3] }).length).toBeCloseTo(100, 9);
  });

  it("stops before nothing, which nothing could scale back from", () => {
    const scale: GrabHandle = {
      kind: "scale",
      id: "s",
      at: [100, 0],
      center: [0, 0],
      bind: "length",
    };
    expect(solved(scale, { from: [100, 0], to: [-300, 0] }).length).toBeCloseTo(
      100 * MIN_SCALE_FACTOR,
      9,
    );
  });

  it("scales each direction by its own with two properties, and both together with Shift", () => {
    const both: GrabHandle = {
      kind: "scale",
      id: "s",
      at: [10, 10],
      center: [0, 0],
      bind: { x: "x", y: "y" },
    };
    const free = solved(both, { from: [10, 10], to: [20, 15] });
    expect(free.x).toBeCloseTo(20, 9);
    expect(free.y).toBeCloseTo(30, 9);
    const kept = solved(both, { from: [10, 10], to: [20, 15], shift: true });
    expect(kept.x).toBeCloseTo(17.5, 9);
    expect(kept.y).toBeCloseTo(35, 9);
  });

  it("leaves a direction alone where the handle starts on the line through the middle", () => {
    const both: GrabHandle = {
      kind: "scale",
      id: "s",
      at: [10, 0],
      center: [0, 0],
      bind: { x: "x", y: "y" },
    };
    expect(solved(both, { from: [10, 0], to: [20, 30] })).toEqual({ x: 20, y: 20 });
  });
});

describe("how far a pointer goes around", () => {
  it("is clockwise when y goes down", () => {
    expect(turnBetween([0, 0], [10, 0], [0, 10])).toBeCloseTo(90, 9);
    expect(turnBetween([0, 0], [10, 0], [0, -10])).toBeCloseTo(-90, 9);
  });

  it("goes the short way across the back", () => {
    expect(turnBetween([0, 0], [-10, 1], [-10, -1])).toBeCloseTo(11.42, 2);
    expect(turnBetween([0, 0], [-10, -1], [-10, 1])).toBeCloseTo(-11.42, 2);
  });

  it("adds up to turns in steps", () => {
    let turned = 0;
    let last: readonly [number, number] = [10, 0];
    for (let step = 1; step <= 16; step += 1) {
      const angle = (step * Math.PI) / 4;
      const now = [10 * Math.cos(angle), 10 * Math.sin(angle)] as const;
      turned += turnBetween([0, 0], last, now);
      last = now;
    }
    expect(turned).toBeCloseTo(720, 9);
  });

  it("is nothing for a place that is no place", () => {
    expect(turnBetween([0, 0], [Number.NaN, 0], [5, 5])).toBe(0);
  });
});
