import type { TFunction } from "i18next";
import type { ComponentType } from "react";
import type { KeyCombo } from "./keys.ts";

/** Where a panel opens when no layout says otherwise. */
export type PanelArea = "left" | "center" | "right" | "bottom";

/**
 * What room a panel is made for: a large area (`large`, such as the preview or code), height
 * (`tall`, a column of things) or width (`wide`, things along time). A new panel goes into a group
 * of the same kind, see `dock/placement.ts`.
 */
export type PanelSize = "large" | "tall" | "wide";

/** The order kinds are tried in, whatever order a panel names them in. */
export const SIZE_ORDER: readonly PanelSize[] = ["large", "tall", "wide"];

const AREA_SIZES: Record<PanelArea, readonly PanelSize[]> = {
  center: ["large"],
  left: ["tall"],
  right: ["tall"],
  bottom: ["wide"],
};

/** The kinds of room a panel is made for: what it says, or else what its area suggests. */
export const sizesOf = (panel: Pick<PanelDefinition, "sizes" | "area">): readonly PanelSize[] =>
  panel.sizes && panel.sizes.length > 0 ? panel.sizes : AREA_SIZES[panel.area];

export interface PanelDefinition {
  /** Saved layouts refer to this name, so it must never change. */
  readonly type: string;
  readonly title: (t: TFunction) => string;
  readonly icon: ComponentType<{ size?: number; className?: string | undefined }>;
  readonly area: PanelArea;
  /** What room it is made for. Left out, it follows from the area. */
  readonly sizes?: readonly PanelSize[];
  readonly component: ComponentType;
  /**
   * The real content comes later, and the panel only says so. Until it is ready, it is in no menu,
   * command or list of keys, and opens nowhere; layouts keep its place without showing it.
   */
  readonly planned?: boolean;
  /** Default keys that open this panel. */
  readonly keys?: readonly KeyCombo[];
  /** Keep the content in place while the tab is hidden or dragged. An iframe would reload otherwise. */
  readonly keepAlive?: boolean;
  /**
   * Opens next to this panel instead of in its place, when that is what the two are for. Code on
   * top of the preview would hide the one thing people want to see change.
   */
  readonly beside?: string;
}

/**
 * Panels there are no more, which saved layouts may still have: they are left out as a layout is
 * put back, and the rest of it stays as people arranged it. The settings and their keys became a
 * dialog (docs/design/settings-and-properties.md of AnimaQuill Cloud, 4.1).
 */
export const RETIRED_PANELS: readonly string[] = ["settings", "keybindings"];

export class PanelRegistry {
  readonly #panels = new Map<string, PanelDefinition>();

  register(panel: PanelDefinition): void {
    if (this.#panels.has(panel.type)) throw new Error(`Panel already registered: ${panel.type}`);
    this.#panels.set(panel.type, panel);
  }

  get(type: string): PanelDefinition | undefined {
    return this.#panels.get(type);
  }

  list(): readonly PanelDefinition[] {
    return [...this.#panels.values()];
  }

  /** The panels that layouts show. */
  ready(): ReadonlySet<string> {
    return new Set(this.list().flatMap((panel) => (panel.planned ? [] : [panel.type])));
  }
}
