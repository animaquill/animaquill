import type { TFunction } from "i18next";
import type { ComponentType } from "react";
import type { KeyCombo } from "./keys.ts";

/** Where a panel opens when no layout says otherwise. */
export type PanelArea = "left" | "center" | "right" | "bottom";

export interface PanelDefinition {
  /** Saved layouts refer to this name, so it must never change. */
  readonly type: string;
  readonly title: (t: TFunction) => string;
  readonly icon: ComponentType<{ size?: number; className?: string | undefined }>;
  readonly area: PanelArea;
  readonly component: ComponentType;
  /**
   * The real content comes later, and the panel only says so. Layouts keep its place without
   * showing it, until it is ready.
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
