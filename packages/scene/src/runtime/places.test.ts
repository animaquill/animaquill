import { describe, expect, it } from "vitest";
import { ClipValues, CodeObjects } from "./content.ts";
import { ObjectPlaces } from "./places.ts";

const ramp = (from: number, to: number) => ({
  keys: [
    { time: "0", value: from },
    { time: "2", value: to },
  ],
});

function setup(initial?: Record<string, unknown>) {
  const objects = new CodeObjects(
    new ClipValues(initial),
    () => 0,
    () => {},
  );
  const places = new ObjectPlaces();
  const register = (id: string, options: Record<string, unknown>) => {
    const object = objects.register(id, options, () => {});
    places.note(object, options);
    return object;
  };
  return { places, register };
}

describe("where code objects say they are", () => {
  it("is what their functions say of their values at a moment, in the order they said it", () => {
    const { places, register } = setup({ "object.arm.x": ramp(0, 100) });
    register("arm", {
      properties: { x: 0 },
      bounds: (v: { x: number }) => [v.x - 10, 0, 20, 20],
      handles: (v: { x: number }) => [{ kind: "move", id: "m", at: [v.x, 0], bind: { x: "x" } }],
    });
    register("plain", { properties: { y: 0 } });
    expect(places.at(1, () => {})).toEqual([
      {
        object: "arm",
        bounds: [40, 0, 20, 20],
        handles: [{ kind: "move", id: "m", at: [50, 0], bind: { x: "x" } }],
      },
    ]);
  });

  it("goes by the latest functions, also of code that registers on every frame", () => {
    const { places, register } = setup();
    const options = (at: number) => ({
      properties: { x: 0 },
      handles: () => [{ kind: "move", id: "m", at: [at, 0], bind: { x: "x" } }],
    });
    register("arm", options(1));
    register("arm", options(2));
    expect(places.at(0, () => {})[0]?.handles).toEqual([
      { kind: "move", id: "m", at: [2, 0], bind: { x: "x" } },
    ]);
    register("arm", { properties: { x: 0 } });
    expect(places.at(0, () => {})).toEqual([]);
  });

  it("has nothing for an object that did not register", () => {
    const { places, register } = setup();
    register("名字", { properties: { x: 0 }, handles: () => [] });
    expect(places.at(0, () => {})).toEqual([]);
  });

  it("leaves out what a function that throws was for, and says why", () => {
    const { places, register } = setup();
    const failures: unknown[] = [];
    register("arm", {
      properties: { x: 0 },
      bounds: () => [0, 0, 1, 1],
      handles: () => {
        throw new Error("no handles");
      },
    });
    expect(places.at(0, (error) => failures.push(error))).toEqual([
      { object: "arm", bounds: [0, 0, 1, 1] },
    ]);
    expect(failures).toHaveLength(1);
  });

  it("gives code a copy of the values, which changes nothing for anybody else", () => {
    const { places, register } = setup();
    const arm = register("arm", {
      properties: { x: 5 },
      handles: (v: { x: number }) => {
        v.x = 999;
        return [];
      },
    });
    places.at(0, () => {});
    expect(arm.at(0)).toEqual({ x: 5 });
  });
});
