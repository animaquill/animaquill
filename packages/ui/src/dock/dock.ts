import type {
  AddPanelOptions,
  DockviewApi,
  DockviewGroupPanel,
  IDockviewPanel,
  SerializedDockview,
} from "dockview-react";
import type { TFunction } from "i18next";
import type { Dock, LayoutNode, PanelNeighbours } from "../workbench/layout.ts";
import type { PanelArea, PanelDefinition, PanelRegistry } from "../workbench/panels.ts";
import type { TabStrips } from "./strips.ts";
import {
  PANEL_COMPONENT,
  toDockviewState,
  type DockState,
  type PanelParams,
} from "./toDockview.ts";

const SIDE_WIDTH = 280;
const BOTTOM_HEIGHT = 260;

/** A panel shared by two layouts stays as it is, so switching does not restart a preview. */
const REUSE_PANELS = { reuseExistingPanels: true };

const typeOf = (panel: IDockviewPanel): string => (panel.params as unknown as PanelParams).type;

function assertUsable(state: unknown): asserts state is DockState {
  const { dockview, unpinned } = (state ?? {}) as Partial<DockState>;
  if (typeof dockview !== "object" || dockview === null) throw new Error("No dock in saved layout");
  if (!Array.isArray(unpinned) || unpinned.some((id) => typeof id !== "string")) {
    throw new Error("No strips in saved layout");
  }
  const { panels } = dockview as Partial<SerializedDockview>;
  if (typeof panels !== "object" || panels === null) throw new Error("No panels in saved layout");
  for (const panel of Object.values(panels)) {
    const type = (panel.params as Partial<PanelParams> | undefined)?.type;
    if (panel.contentComponent !== PANEL_COMPONENT || typeof type !== "string") {
      throw new Error(`Not one of our panels: ${panel.id}`);
    }
  }
}

/** Connects the workbench to dockview. Nothing outside this folder uses dockview's model. */
export function createDock(
  api: DockviewApi,
  panels: PanelRegistry,
  strips: TabStrips,
  t: TFunction,
): Dock {
  // Only tabs can be dragged. Dockview would also move a whole group by the rest of its tab strip.
  api.onWillDragGroup((event) => event.nativeEvent.preventDefault());
  // A group that comes later may get the id of one that went.
  api.onDidRemoveGroup((group) => strips.forget(group.id));

  const facts = {
    title: (type: string) => panels.get(type)?.title(t) ?? t("panel.unknown.title"),
    keepAlive: (type: string) => panels.get(type)?.keepAlive === true,
  };

  const groupOf = (area: PanelArea): DockviewGroupPanel | undefined =>
    api.panels.find((panel) => panels.get(typeOf(panel))?.area === area)?.group;

  /** Next to the panels of the same area, or else in the place that area has in a new layout. */
  const placement = (area: PanelArea): Partial<AddPanelOptions> => {
    const neighbour = groupOf(area);
    if (neighbour) return { position: { referenceGroup: neighbour } };
    switch (area) {
      case "left":
        return { position: { direction: "left" }, initialWidth: SIDE_WIDTH };
      case "right":
        return { position: { direction: "right" }, initialWidth: SIDE_WIDTH };
      case "bottom":
        return { position: { direction: "below" }, initialHeight: BOTTOM_HEIGHT };
      case "center": {
        const left = groupOf("left");
        if (left) return { position: { referenceGroup: left, direction: "right" } };
        const right = groupOf("right");
        if (right) return { position: { referenceGroup: right, direction: "left" } };
        const bottom = groupOf("bottom");
        if (bottom) return { position: { referenceGroup: bottom, direction: "above" } };
        return {};
      }
    }
  };

  const besideOf = ({ beside }: PanelDefinition): Partial<AddPanelOptions> | undefined => {
    const panel = beside === undefined ? undefined : api.getPanel(beside);
    return panel && { position: { referenceGroup: panel.group, direction: "right" } };
  };

  /** Between the nearest neighbour that is there, in its group. */
  const between = ({ before, after }: PanelNeighbours): Partial<AddPanelOptions> | undefined => {
    for (const [types, offset] of [
      [before, 1],
      [after, 0],
    ] as const) {
      for (const type of types) {
        const panel = api.getPanel(type);
        if (!panel) continue;
        const index = panel.group.panels.indexOf(panel) + offset;
        return { position: { referenceGroup: panel.group, index } };
      }
    }
    return undefined;
  };

  const addPanel = (
    definition: PanelDefinition,
    where: Partial<AddPanelOptions>,
    quiet = false,
  ) => {
    api.addPanel({
      id: definition.type,
      title: facts.title(definition.type),
      component: PANEL_COMPONENT,
      params: { type: definition.type } satisfies PanelParams,
      ...(definition.keepAlive ? { renderer: "always" as const } : {}),
      ...(quiet && { inactive: true }),
      ...where,
    });
  };

  return {
    arrange(layout: LayoutNode | undefined) {
      if (!layout) {
        api.clear();
        strips.reset([]);
        return;
      }
      const { dockview, unpinned } = toDockviewState(layout, api.width, api.height, facts);
      api.fromJSON(dockview, REUSE_PANELS);
      strips.reset(unpinned);
    },
    restore(state) {
      assertUsable(state);
      api.fromJSON(state.dockview, REUSE_PANELS);
      strips.reset(state.unpinned);
      // The saved titles may come from another language.
      for (const panel of api.panels) panel.api.setTitle(facts.title(typeOf(panel)));
    },
    serialize: (): DockState => ({
      dockview: api.toJSON(),
      unpinned: strips.unpinnedOf(api.groups),
    }),
    open(type) {
      const existing = api.getPanel(type);
      if (existing) {
        existing.api.setActive();
        return;
      }
      const definition = panels.get(type);
      if (!definition) return;
      addPanel(definition, besideOf(definition) ?? placement(definition.area));
    },
    add(type, neighbours) {
      const definition = panels.get(type);
      if (!definition || api.getPanel(type)) return;
      addPanel(definition, between(neighbours) ?? placement(definition.area), true);
    },
    items: () => api.panels.map((panel) => ({ type: typeOf(panel), visible: panel.api.isVisible })),
    active: () => (api.activePanel ? typeOf(api.activePanel) : undefined),
    onChange(listener) {
      const subscriptions = [api.onDidLayoutChange(listener), api.onDidActivePanelChange(listener)];
      // Dockview does not count the side of the tabs as a change of the layout.
      const stopStrips = strips.subscribe(listener);
      return () => {
        subscriptions.forEach((subscription) => subscription.dispose());
        stopStrips();
      };
    },
  };
}
