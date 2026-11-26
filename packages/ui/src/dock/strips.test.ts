import type { DockviewGroupPanel } from "dockview-react";
import { describe, expect, it, vi } from "vitest";
import type { SerializedDockview } from "dockview-react";
import {
  ICONS_WIDTH,
  MAX_WIDTH,
  MIN_WIDTH,
  OPEN_MIN_WIDTH,
  TabStrips,
  canCollapse,
  parseLooks,
} from "./strips.ts";

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
    expect(strips.lookOf(groupOn("a"))).toEqual({
      pinned: false,
      peek: true,
      width: undefined,
      peekWidth: undefined,
      collapsed: undefined,
    });
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
    expect(strips.lookOf(a)).toMatchObject({ pinned: false, peek: true, width: 180 });
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

describe("names that come out", () => {
  it("have a width of their own, which leaves the strip as it is", () => {
    const strips = new TabStrips();
    const a = groupOn("a");
    strips.setWidth(a, true, 150);
    strips.setPinned(a, false);
    strips.setPeekWidth(a, 220.6);
    expect(strips.lookOf(a)).toEqual({ pinned: false, peek: true, width: 150, peekWidth: 221 });
    expect(strips.looksOf([a])).toEqual({ a: { width: 150, peekWidth: 221 } });
    strips.setPeekWidth(a, 1);
    expect(strips.lookOf(a).peekWidth).toBe(MIN_WIDTH);
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
        a: { pinned: true, peek: false, width: 150.4, peekWidth: 200 },
        b: { pinned: "yes", width: 99999 },
      }),
    ).toEqual({
      a: { pinned: true, peek: false, width: 150, peekWidth: 200 },
      b: { width: MAX_WIDTH },
    });
  });

  it.each([
    ["a list", []],
    ["nothing", null],
    ["not a look", { a: 3 }],
  ])("are refused when they are %s", (_, value) => {
    expect(parseLooks(value)).toBeUndefined();
  });
});

/** A group that dockview sizes, which says what it was asked. */
function sizedGroup(id: string, width: number, side: "left" | "right" = "left") {
  const asked: { constraints: unknown[]; sizes: unknown[] } = { constraints: [], sizes: [] };
  let now = width;
  const group = {
    id,
    get width() {
      return now;
    },
    api: {
      getHeaderPosition: () => side,
      setHeaderPosition: () => {},
      setConstraints: (value: unknown) => asked.constraints.push(value),
      setSize: (value: { width: number }) => {
        asked.sizes.push(value);
        now = value.width;
      },
    },
  } as unknown as DockviewGroupPanel;
  return { group, asked };
}

const leaf = (id: string) => ({ type: "leaf", size: 1, data: { id, views: [] } });
const branch = (...data: unknown[]) => ({ type: "branch", size: 1, data });
const grid = (orientation: "HORIZONTAL" | "VERTICAL", root: unknown) =>
  ({ root, orientation, width: 1000, height: 800 }) as unknown as SerializedDockview["grid"];

describe("folding a group up to its strip", () => {
  it("is only for a group that can get narrower on its own", () => {
    // As the layout "edit": a row of three above the timeline, which is as wide as the window.
    const edit = grid(
      "VERTICAL",
      branch(branch(leaf("left"), leaf("preview"), leaf("right")), leaf("timeline")),
    );
    expect(canCollapse(edit, "left")).toBe(true);
    expect(canCollapse(edit, "right")).toBe(true);
    expect(canCollapse(edit, "timeline")).toBe(false);
    // Two above each other in a column: they share its width.
    const stacked = grid("HORIZONTAL", branch(branch(leaf("a"), leaf("b")), leaf("c")));
    expect(canCollapse(stacked, "a")).toBe(false);
    expect(canCollapse(stacked, "c")).toBe(true);
    // Alone in a column of its own, the column is it.
    const alone = grid("HORIZONTAL", branch(branch(leaf("a")), leaf("c")));
    expect(canCollapse(alone, "a")).toBe(true);
    expect(canCollapse(grid("HORIZONTAL", branch(leaf("only"))), "only")).toBe(false);
    expect(canCollapse(edit, "gone")).toBe(false);
  });

  it("keeps its strip as wide as it is, and gives the width back when it opens", () => {
    const strips = new TabStrips();
    const { group, asked } = sizedGroup("a", 300);
    strips.attach({
      toJSON: () => ({ grid: grid("HORIZONTAL", branch(leaf("a"), leaf("b"))) }),
    } as never);
    strips.toggleCollapsed(group);
    expect(strips.isCollapsed(group)).toBe(true);
    expect(asked.constraints.at(-1)).toEqual({
      minimumWidth: ICONS_WIDTH,
      maximumWidth: ICONS_WIDTH,
    });
    expect(group.width).toBe(ICONS_WIDTH);
    expect(strips.looksOf([group])).toEqual({ a: { collapsed: 300 } });
    // Names that show all the time make the strip, and the group with it, wider.
    strips.setWidth(group, true, 150);
    expect(group.width).toBe(150);
    strips.toggleCollapsed(group);
    expect(strips.isCollapsed(group)).toBe(false);
    expect(asked.constraints.at(-1)).toMatchObject({ minimumWidth: OPEN_MIN_WIDTH });
    expect(group.width).toBe(300);
    expect(parseLooks({ a: { collapsed: 300.4 }, b: { collapsed: -1 } })).toEqual({
      a: { collapsed: 300 },
      b: {},
    });
  });

  it("does not happen to tabs across the top, and opens when they go there", () => {
    const strips = new TabStrips();
    strips.attach({
      toJSON: () => ({ grid: grid("HORIZONTAL", branch(leaf("a"), leaf("b"))) }),
    } as never);
    let side = "left";
    const { group } = sizedGroup("a", 300);
    (group.api as { getHeaderPosition: () => string }).getHeaderPosition = () => side;
    (group.api as { setHeaderPosition: (next: string) => void }).setHeaderPosition = (next) =>
      (side = next);
    strips.collapse(group);
    strips.setStrip(group, "top");
    expect(strips.isCollapsed(group)).toBe(false);
    expect(strips.canCollapse(group)).toBe(false);
  });
});
