import type {
  AddPanelOptions,
  DockviewApi,
  DockviewGroupPanel,
  IDockviewPanel,
  SerializedDockview,
} from "dockview-react";
import type { TFunction } from "i18next";
import type { Dock, LayoutNode } from "../workbench/layout.ts";
import type { PanelArea, PanelRegistry } from "../workbench/panels.ts";
import { PANEL_COMPONENT, toDockviewState, type PanelParams } from "./toDockview.ts";

const SIDE_WIDTH = 280;
const BOTTOM_HEIGHT = 260;

/** A panel shared by two workspaces stays as it is, so switching does not restart a preview. */
const REUSE_PANELS = { reuseExistingPanels: true };

const typeOf = (panel: IDockviewPanel): string => (panel.params as unknown as PanelParams).type;

function assertUsable(state: unknown): asserts state is SerializedDockview {
  const { panels } = state as Partial<SerializedDockview>;
  if (typeof panels !== "object" || panels === null) throw new Error("No panels in saved layout");
  for (const panel of Object.values(panels)) {
    const type = (panel.params as Partial<PanelParams> | undefined)?.type;
    if (panel.contentComponent !== PANEL_COMPONENT || typeof type !== "string") {
      throw new Error(`Not one of our panels: ${panel.id}`);
    }
  }
}

/** Connects the workbench to dockview. Nothing outside this folder uses dockview's model. */
export function createDock(api: DockviewApi, panels: PanelRegistry, t: TFunction): Dock {
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

  return {
    arrange(layout: LayoutNode) {
      api.fromJSON(toDockviewState(layout, api.width, api.height, facts), REUSE_PANELS);
    },
    restore(state) {
      assertUsable(state);
      api.fromJSON(state, REUSE_PANELS);
      // The saved titles may come from another language.
      for (const panel of api.panels) panel.api.setTitle(facts.title(typeOf(panel)));
    },
    serialize: () => api.toJSON(),
    open(type) {
      const existing = api.getPanel(type);
      if (existing) {
        existing.api.setActive();
        return;
      }
      const definition = panels.get(type);
      if (!definition) return;
      api.addPanel({
        id: type,
        title: facts.title(type),
        component: PANEL_COMPONENT,
        params: { type } satisfies PanelParams,
        ...(definition.keepAlive ? { renderer: "always" as const } : {}),
        ...placement(definition.area),
      });
    },
    items: () => api.panels.map((panel) => ({ type: typeOf(panel), visible: panel.api.isVisible })),
    onChange(listener) {
      const subscriptions = [api.onDidLayoutChange(listener), api.onDidActivePanelChange(listener)];
      return () => subscriptions.forEach((subscription) => subscription.dispose());
    },
  };
}
