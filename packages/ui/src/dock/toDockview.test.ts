import type { SerializedDockview } from "dockview-react";
import { describe, expect, it } from "vitest";
import type { LayoutNode } from "../workbench/layout.ts";
import { layouts } from "../workbench/layouts.ts";
import { toDockviewState as toDockState } from "./toDockview.ts";

const tabs = (...panels: string[]): LayoutNode => ({ kind: "tabs", panels });
const facts = { title: (type: string) => `title of ${type}`, keepAlive: () => false };

type GridNode = SerializedDockview["grid"]["root"];

const toDockviewState = (...args: Parameters<typeof toDockState>) => toDockState(...args).dockview;

function childrenOf(node: GridNode): GridNode[] {
  return node.type === "branch" ? (node.data as GridNode[]) : [];
}

describe("toDockviewState", () => {
  it("divides the space by share and fills it exactly", () => {
    const state = toDockviewState(
      {
        kind: "split",
        direction: "row",
        children: [
          [1, tabs("a")],
          [1, tabs("b")],
          [1, tabs("c")],
        ],
      },
      1000,
      500,
      facts,
    );
    const sizes = childrenOf(state.grid.root).map((child) => child.size);
    expect(sizes).toEqual([333, 333, 334]);
    expect(state.grid.orientation).toBe("HORIZONTAL");
    expect(state.grid.root.size).toBe(500);
  });

  it("alternates direction down the tree", () => {
    const state = toDockviewState(
      {
        kind: "split",
        direction: "column",
        children: [
          [
            3,
            {
              kind: "split",
              direction: "row",
              children: [
                [1, tabs("a")],
                [3, tabs("b")],
              ],
            },
          ],
          [1, tabs("c")],
        ],
      },
      800,
      400,
      facts,
    );
    expect(state.grid.orientation).toBe("VERTICAL");
    const [top, bottom] = childrenOf(state.grid.root);
    expect(top?.size).toBe(300);
    expect(bottom?.size).toBe(100);
    expect(childrenOf(top as GridNode).map((child) => child.size)).toEqual([200, 600]);
  });

  it("refuses a split that runs along its parent, which dockview cannot show", () => {
    const nested: LayoutNode = {
      kind: "split",
      direction: "row",
      children: [
        [
          1,
          {
            kind: "split",
            direction: "row",
            children: [[1, tabs("a")]],
          },
        ],
      ],
    };
    expect(() => toDockviewState(nested, 100, 100, facts)).toThrow();
  });

  it("wraps a single group, because the grid root must be a branch", () => {
    const state = toDockviewState(tabs("a", "b"), 400, 300, facts);
    expect(state.grid.root.type).toBe("branch");
    expect(Object.keys(state.panels)).toEqual(["a", "b"]);
  });

  it("shows the first tab of a group and focuses the largest group", () => {
    const state = toDockviewState(
      {
        kind: "split",
        direction: "row",
        children: [
          [1, tabs("small")],
          [3, tabs("large", "behind")],
        ],
      },
      400,
      300,
      facts,
    );
    const large = childrenOf(state.grid.root)[1]?.data as { id: string; activeView: string };
    expect(large.activeView).toBe("large");
    expect(state.activeGroup).toBe(large.id);
  });

  it("shows the tab a group asks for", () => {
    const state = toDockviewState(
      { kind: "tabs", panels: ["a", "b"], active: "b" },
      400,
      300,
      facts,
    );
    const group = childrenOf(state.grid.root)[0]?.data as { activeView: string };
    expect(group.activeView).toBe("b");
  });

  it("marks only the panels that must stay alive", () => {
    const state = toDockviewState(tabs("a", "b"), 400, 300, {
      ...facts,
      keepAlive: (type) => type === "a",
    });
    expect(state.panels["a"]?.renderer).toBe("always");
    expect(state.panels["b"]).not.toHaveProperty("renderer");
  });

  it("gives every panel a title for screen readers", () => {
    const state = toDockviewState(tabs("a"), 400, 300, facts);
    expect(state.panels["a"]?.title).toBe("title of a");
  });

  it.each(layouts.map((layout) => [layout.id, layout.layout] as const))(
    "can build layout %s",
    (_, layout) => {
      expect(() => toDockviewState(layout, 1392, 843, facts)).not.toThrow();
    },
  );

  it("puts tabs down a side, and says which groups show their names", () => {
    const { dockview, strips } = toDockState(
      {
        kind: "split",
        direction: "row",
        children: [
          [1, { kind: "tabs", panels: ["a"], strip: "left" }],
          [1, { kind: "tabs", panels: ["b"] }],
          [1, { kind: "tabs", panels: ["c"], strip: "right", pinned: true }],
          // Tabs across the top always show their names, so that says nothing.
          [1, { kind: "tabs", panels: ["d"], strip: "top", pinned: true }],
        ],
      },
      400,
      300,
      facts,
    );
    const groups = childrenOf(dockview.grid.root).map(
      (child) => child.data as { id: string; headerPosition?: string },
    );
    expect(groups.map((group) => group.headerPosition)).toEqual([
      "left",
      undefined,
      "right",
      undefined,
    ]);
    expect(strips).toEqual({ [groups[2]?.id ?? ""]: { pinned: true } });
  });
});
