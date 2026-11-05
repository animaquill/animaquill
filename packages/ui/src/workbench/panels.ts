import type { TFunction } from "i18next";
import type { ComponentType } from "react";

/** Where a panel opens when no layout says otherwise. */
export type PanelArea = "left" | "center" | "right" | "bottom";

export interface PanelDefinition {
  /** Saved layouts refer to this name, so it must never change. */
  readonly type: string;
  readonly title: (t: TFunction) => string;
  readonly icon: ComponentType<{ size?: number }>;
  readonly area: PanelArea;
  readonly component: ComponentType;
  /** Show a shortcut in the activity bar. */
  readonly activity?: boolean;
  /** Keep the content in place while the tab is hidden or dragged. An iframe would reload otherwise. */
  readonly keepAlive?: boolean;
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
}
