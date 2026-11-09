import type { Orientation, SerializedDockview } from "dockview-react";
import type { LayoutNode } from "../workbench/layout.ts";

/** Every panel goes through one component, so that an unknown type cannot break the dock. */
export const PANEL_COMPONENT = "panel";

export interface PanelParams {
  readonly type: string;
}

type GridNode = SerializedDockview["grid"]["root"];
type GroupState = Exclude<GridNode["data"], readonly unknown[]>;

const ROW = "HORIZONTAL" as Orientation;
const COLUMN = "VERTICAL" as Orientation;

/** What the dock saves: the state of dockview, and which groups show only the icons of their tabs. */
export interface DockState {
  readonly dockview: SerializedDockview;
  readonly unpinned: readonly string[];
}

export interface PanelFacts {
  title(type: string): string;
  keepAlive(type: string): boolean;
}

/** Builds the state the dock would have saved for this layout, sized for the given area. */
export function toDockviewState(
  layout: LayoutNode,
  width: number,
  height: number,
  facts: PanelFacts,
): DockState {
  const panels: SerializedDockview["panels"] = {};
  const unpinned: string[] = [];
  let groups = 0;
  let largest = { id: "", area: -1 };

  const build = (node: LayoutNode, w: number, h: number, inRow: boolean): GridNode => {
    const size = inRow ? w : h;
    if (node.kind === "tabs") {
      const id = `group-${++groups}`;
      if (w * h > largest.area) largest = { id, area: w * h };
      for (const type of node.panels) {
        panels[type] = {
          id: type,
          title: facts.title(type),
          contentComponent: PANEL_COMPONENT,
          params: { type } satisfies PanelParams,
          ...(facts.keepAlive(type) ? { renderer: "always" as const } : {}),
        };
      }
      const data: GroupState = { id, views: [...node.panels] };
      const active = node.active !== undefined && node.panels.includes(node.active);
      const shown = active ? node.active : node.panels[0];
      if (shown) data.activeView = shown;
      if (node.strip === "left" || node.strip === "right") {
        data.headerPosition = node.strip;
        if (node.pinned === false) unpinned.push(id);
      }
      return { type: "leaf", size, data };
    }

    const isRow = node.direction === "row";
    if (isRow === inRow) throw new Error("A split must run across its parent");
    const extent = isRow ? w : h;
    const total = node.children.reduce((sum, [share]) => sum + share, 0);
    let used = 0;
    const data = node.children.map(([share, child], index) => {
      const last = index === node.children.length - 1;
      const childExtent = last ? extent - used : Math.round((extent * share) / total);
      used += childExtent;
      return build(child, isRow ? childExtent : w, isRow ? h : childExtent, isRow);
    });
    return { type: "branch", size, data };
  };

  const top: LayoutNode =
    layout.kind === "split" ? layout : { kind: "split", direction: "row", children: [[1, layout]] };
  const isRow = top.kind === "split" && top.direction === "row";
  const root = build(top, width, height, !isRow);
  return {
    dockview: {
      grid: { root, width, height, orientation: isRow ? ROW : COLUMN },
      panels,
      activeGroup: largest.id,
    },
    unpinned,
  };
}
