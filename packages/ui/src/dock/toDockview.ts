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

export interface PanelFacts {
  title(type: string): string;
  keepAlive(type: string): boolean;
}

/** Builds the state dockview would have saved for this layout, sized for the given area. */
export function toDockviewState(
  layout: LayoutNode,
  width: number,
  height: number,
  facts: PanelFacts,
): SerializedDockview {
  const panels: SerializedDockview["panels"] = {};
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
      if (node.panels[0]) data.activeView = node.panels[0];
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
    grid: { root, width, height, orientation: isRow ? ROW : COLUMN },
    panels,
    activeGroup: largest.id,
  };
}
