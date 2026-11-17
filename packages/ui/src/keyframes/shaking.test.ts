import type { TFunction } from "i18next";
import { describe, expect, it, vi } from "vitest";
import type { MenuItem } from "../app/Menu.tsx";
import {
  anotherSeed,
  defaultAmountOf,
  extendMenuGroup,
  shakingOf,
  type PropertyMenuState,
} from "./shaking.ts";

const t = ((key: string) => key) as unknown as TFunction;

function menu(change: Partial<PropertyMenuState> = {}) {
  const state: PropertyMenuState = {
    type: "number",
    extend: { before: "hold", after: "loop" },
    shaking: false,
    changeable: true,
    hasValue: true,
    setExtend: vi.fn(),
    shake: vi.fn(),
    ...change,
  };
  const items = extendMenuGroup(t, state);
  const byId = (id: string) => items.find((item) => item.id === id);
  const modes = (side: string) => byId(side)?.items?.[0] ?? [];
  const ticked = (side: string) =>
    modes(side)
      .filter((item: MenuItem) => item.selected)
      .map(({ id }) => id);
  return { state, items, byId, modes, ticked };
}

describe("the menu of the row of a property", () => {
  it("ticks what each end does now, and follows a change", () => {
    expect(menu().ticked("before")).toEqual(["before-hold"]);
    expect(menu().ticked("after")).toEqual(["after-loop"]);
    const changed = menu({ extend: { before: "pingpong", after: "continue" } });
    expect(changed.ticked("before")).toEqual(["before-pingpong"]);
    expect(changed.ticked("after")).toEqual(["after-continue"]);
  });

  it("has the four ways for numbers and angles, in their order, and sets the one chosen", () => {
    for (const type of ["number", "angle"] as const) {
      const { modes } = menu({ type });
      expect(modes("after").map(({ id }) => id)).toEqual([
        "after-hold",
        "after-loop",
        "after-pingpong",
        "after-continue",
      ]);
    }
    const { modes, state } = menu();
    modes("before")
      .find(({ id }) => id === "before-pingpong")
      ?.run();
    expect(state.setExtend).toHaveBeenCalledWith("before", "pingpong");
  });

  it("offers going on and shaking only where they do something", () => {
    for (const type of ["vec2", "vec3", "numbers"] as const) {
      const { modes, byId } = menu({ type });
      expect(modes("before").map(({ id }) => id)).not.toContain("before-continue");
      expect(byId("noise")).toBeDefined();
    }
    for (const type of ["color", "boolean", "choice", "text", "asset"] as const) {
      const { modes, byId } = menu({ type });
      expect(modes("after").map(({ id }) => id)).toEqual([
        "after-hold",
        "after-loop",
        "after-pingpong",
      ]);
      expect(byId("noise")).toBeUndefined();
    }
    expect(menu({ type: "angle" }).byId("noise")).toBeDefined();
  });

  it("cannot say what keys do at their ends without keys, nor change a clip that cannot change", () => {
    const keyless = menu({ extend: undefined });
    expect(keyless.byId("before")?.disabled).toBe(true);
    expect(keyless.byId("after")?.disabled).toBe(true);
    // Shaking puts a key in.
    expect(keyless.byId("noise")?.disabled).toBe(false);
    const locked = menu({ changeable: false });
    expect(locked.byId("before")?.disabled).toBe(true);
    expect(locked.byId("noise")?.disabled).toBe(true);
    expect(menu({ extend: undefined, hasValue: false }).byId("noise")?.disabled).toBe(true);
    const { byId, state } = menu();
    byId("noise")?.run();
    expect(state.shake).toHaveBeenCalled();
  });
});

describe("shaking", () => {
  it("reads as the format means it, without a frequency once a second", () => {
    expect(shakingOf(undefined)).toBeUndefined();
    expect(shakingOf({ keys: [{ time: "0", value: 1 }] })).toBeUndefined();
    expect(
      shakingOf({
        keys: [{ time: "0", value: 1 }],
        modifiers: [{ type: "noise", amount: 3, seed: 7 }],
      }),
    ).toEqual({ amount: 3, frequency: 1, seed: 7 });
  });

  it("new dice are always another seed", () => {
    expect(anotherSeed(5, () => 5 / 999_999)).not.toBe(5);
    expect(anotherSeed(0, () => 0)).toBe(1);
    for (let seed = 0; seed < 50; seed += 1) {
      const next = anotherSeed(seed);
      expect(next).not.toBe(seed);
      expect(Number.isInteger(next) && next >= 0 && next < 1_000_000).toBe(true);
    }
  });

  it("starts as far as the unit makes it show", () => {
    expect(defaultAmountOf({ path: "transform.x", type: "number", unit: "world" })).toBe(20);
    expect(defaultAmountOf({ path: "transform.rotation", type: "angle", unit: "deg" })).toBe(5);
    expect(defaultAmountOf({ path: "opacity", type: "number", unit: "ratio" })).toBe(0.05);
    expect(defaultAmountOf({ path: "param.size", type: "number", min: 0, max: 200 })).toBe(10);
    expect(defaultAmountOf({ path: "param.n", type: "number" })).toBe(1);
  });
});
