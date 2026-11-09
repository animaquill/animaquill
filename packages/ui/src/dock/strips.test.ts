import type { DockviewGroupPanel } from "dockview-react";
import { describe, expect, it, vi } from "vitest";
import { MAX_WIDTH, MIN_WIDTH, TabStrips, parseLooks } from "./strips.ts";

function groupOn(id: string, side: "top" | "left" | "right" = "left") {
  let position: string = side;
  return {
    id,
    api: {
      getHeaderPosition: () => position,
      setHeaderPosition: (next: string) => (position = next),
    },
  } as unknown as DockviewGroupPanel;
}

describe("strips down a side", () => {
  it("show only icons, with names under the mouse, unless told otherwise", () => {
    const strips = new TabStrips();
    expect(strips.lookOf(groupOn("a"))).toEqual({ pinned: false, peek: true, width: undefined });
    expect(strips.isPinned(groupOn("a"))).toBe(false);
    expect(strips.isPinned(groupOn("b", "top"))).toBe(true);
  });

  it("save only what differs, and only for the groups there are", () => {
    const strips = new TabStrips();
    const a = groupOn("a");
    const b = groupOn("b");
    strips.setPinned(a, true);
    strips.setPeek(b, false);
    strips.setWidth(groupOn("gone"), true, 200);
    expect(strips.looksOf([a, b, groupOn("c")])).toEqual({
      a: { pinned: true },
      b: { peek: false },
    });
  });

  it("keep their width when they go back to icons, for when they are pinned again", () => {
    const strips = new TabStrips();
    const a = groupOn("a");
    strips.setWidth(a, true, 180);
    strips.setWidth(a, false);
    expect(strips.lookOf(a)).toEqual({ pinned: false, peek: true, width: 180 });
    strips.setPinned(a, true);
    expect(strips.lookOf(a).width).toBe(180);
  });

  it("keep a width between what shows a name and what still fits", () => {
    const strips = new TabStrips();
    const a = groupOn("a");
    strips.setWidth(a, true, 10);
    expect(strips.lookOf(a).width).toBe(MIN_WIDTH);
    strips.setWidth(a, true, 5000);
    expect(strips.lookOf(a).width).toBe(MAX_WIDTH);
  });

  it("say when something changed, and only then", () => {
    const strips = new TabStrips();
    const listener = vi.fn();
    strips.subscribe(listener);
    const a = groupOn("a");
    strips.setPinned(a, false);
    strips.setStrip(a, "left");
    expect(listener).not.toHaveBeenCalled();
    strips.setStrip(a, "right");
    strips.setPeek(a, false);
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

describe("a strip that was clicked", () => {
  it("rests until told otherwise, only when it shows icons, and is not saved", () => {
    const strips = new TabStrips();
    const a = groupOn("a");
    const pinned = groupOn("b");
    strips.setPinned(pinned, true);
    strips.rest(pinned);
    expect(strips.isResting(pinned)).toBe(false);
    strips.rest(a);
    expect(strips.isResting(a)).toBe(true);
    expect(strips.looksOf([a])).toEqual({});
    const listener = vi.fn();
    strips.subscribe(listener);
    strips.rest(undefined);
    expect(strips.isResting(a)).toBe(false);
    expect(listener).toHaveBeenCalledOnce();
  });
});

describe("saved looks", () => {
  it("keep what they can use", () => {
    expect(
      parseLooks({
        a: { pinned: true, peek: false, width: 150.4 },
        b: { pinned: "yes", width: 99999 },
      }),
    ).toEqual({ a: { pinned: true, peek: false, width: 150 }, b: { width: MAX_WIDTH } });
  });

  it.each([
    ["a list", []],
    ["nothing", null],
    ["not a look", { a: 3 }],
  ])("are refused when they are %s", (_, value) => {
    expect(parseLooks(value)).toBeUndefined();
  });
});
