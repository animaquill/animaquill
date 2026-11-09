import type { DockviewGroupPanel } from "dockview-react";
import type { TabStrip } from "../workbench/layout.ts";
import { Emitter } from "../workbench/emitter.ts";

/** How a strip of tabs down a side looks, as it is saved: only what differs from the default. */
export interface SavedLook {
  /** Names next to the icons all the time. Only icons when left out. */
  readonly pinned?: true;
  /** Without it, the names of a strip of icons do not come out under the mouse. */
  readonly peek?: false;
  /** How wide a pinned strip is, in pixels. The default width when left out. */
  readonly width?: number;
}

export interface StripLook {
  readonly pinned: boolean;
  readonly peek: boolean;
  readonly width: number | undefined;
}

/** As wide as an icon of a strip with some room around it. Matches `--aq-strip-icons`. */
export const ICONS_WIDTH = 44;
/** As wide as a pinned strip is unless people make it wider or narrower. Matches CSS. */
export const DEFAULT_WIDTH = 132;
/** A pinned strip has room for at least a short name. */
export const MIN_WIDTH = 96;
export const MAX_WIDTH = 360;

export const clampWidth = (width: number): number =>
  Math.round(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, width)));

/** Takes what a saved layout says about strips. Undefined when it is not that. */
export function parseLooks(value: unknown): Record<string, SavedLook> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const looks: Record<string, SavedLook> = {};
  for (const [id, look] of Object.entries(value)) {
    if (typeof look !== "object" || look === null) return undefined;
    const { pinned, peek, width } = look as Record<string, unknown>;
    looks[id] = {
      ...(pinned === true && { pinned: true as const }),
      ...(peek === false && { peek: false as const }),
      ...(typeof width === "number" && Number.isFinite(width) && { width: clampWidth(width) }),
    };
  }
  return looks;
}

/**
 * How each group shows its tabs. Dockview keeps which side they are on, and saves it with the
 * group. How a strip down a side looks is ours, kept by the id of the group.
 */
export class TabStrips {
  readonly #emitter = new Emitter();
  #looks = new Map<string, SavedLook>();
  /** The group whose names stay in after a click on one of its icons, until the mouse leaves. */
  #resting: string | undefined;
  #revision = 0;

  subscribe = this.#emitter.subscribe;
  /** Changes with every change of any strip. */
  getSnapshot = (): number => this.#revision;

  stripOf(group: DockviewGroupPanel): TabStrip {
    const position = group.api.getHeaderPosition();
    return position === "left" || position === "right" ? position : "top";
  }

  lookOf(group: DockviewGroupPanel): StripLook {
    const look = this.#looks.get(group.id) ?? {};
    return { pinned: look.pinned === true, peek: look.peek !== false, width: look.width };
  }

  /** Tabs across the top always show their names. */
  isPinned(group: DockviewGroupPanel): boolean {
    return this.stripOf(group) === "top" || this.lookOf(group).pinned;
  }

  setStrip(group: DockviewGroupPanel, strip: TabStrip): void {
    if (this.stripOf(group) === strip) return;
    group.api.setHeaderPosition(strip);
    this.#changed();
  }

  setPinned(group: DockviewGroupPanel, pinned: boolean): void {
    this.#set(group, { pinned });
  }

  setPeek(group: DockviewGroupPanel, peek: boolean): void {
    this.#set(group, { peek });
  }

  /** Pinned at a width, or back to only icons, as dragging the edge of the strip says. */
  setWidth(group: DockviewGroupPanel, pinned: boolean, width?: number): void {
    this.#set(group, { pinned, ...(width !== undefined && { width: clampWidth(width) }) });
  }

  /**
   * After a click on an icon people want to see what it switched to, not the names over it. Not
   * saved: it lasts until the mouse leaves the strip.
   */
  rest(group: DockviewGroupPanel | undefined): void {
    const id = group && !this.isPinned(group) ? group.id : undefined;
    if (id === this.#resting) return;
    this.#resting = id;
    this.#changed();
  }

  isResting(group: DockviewGroupPanel): boolean {
    return this.#resting === group.id;
  }

  /** Quietly: the group is gone, and its going is a change of its own. */
  forget(id: string): void {
    this.#looks.delete(id);
  }

  /** What there is to save about these groups. */
  looksOf(groups: readonly DockviewGroupPanel[]): Record<string, SavedLook> {
    const looks: Record<string, SavedLook> = {};
    for (const group of groups) {
      const look = this.#looks.get(group.id);
      if (look && Object.keys(look).length > 0) looks[group.id] = look;
    }
    return looks;
  }

  /** After a whole new arrangement. */
  reset(looks: Readonly<Record<string, SavedLook>>): void {
    this.#looks = new Map(Object.entries(looks));
    this.#changed();
  }

  #set(group: DockviewGroupPanel, change: Partial<StripLook>): void {
    const before = this.lookOf(group);
    const now = { ...before, ...change };
    if (now.pinned === before.pinned && now.peek === before.peek && now.width === before.width) {
      return;
    }
    this.#looks.set(group.id, {
      ...(now.pinned && { pinned: true as const }),
      ...(!now.peek && { peek: false as const }),
      ...(now.width !== undefined && { width: now.width }),
    });
    this.#changed();
  }

  #changed(): void {
    this.#revision += 1;
    this.#emitter.emit();
  }
}
