import type { DockviewApi, DockviewGroupPanel, SerializedDockview } from "dockview-react";
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
  /** How wide the names of a strip of icons come out, in pixels. As if pinned when left out. */
  readonly peekWidth?: number;
  /**
   * Folded up to only its strip, as a click on its icon that shows does, as in VS Code: how wide
   * the group was, which it gets back when it opens. Open when left out.
   */
  readonly collapsed?: number;
}

export interface StripLook {
  readonly pinned: boolean;
  readonly peek: boolean;
  readonly width: number | undefined;
  readonly peekWidth: number | undefined;
  readonly collapsed: number | undefined;
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

/** As narrow as a group gets unless it is folded up: dockview's own least width of a group. */
export const OPEN_MIN_WIDTH = 100;
const OPEN_CONSTRAINTS = { minimumWidth: OPEN_MIN_WIDTH, maximumWidth: Number.MAX_SAFE_INTEGER };

type GridNode = SerializedDockview["grid"]["root"];

/**
 * Whether a group can be folded up to its strip on its own: only where it can get narrower without
 * making anything above or below it narrower too, as a column of its own in a row. A group as wide
 * as the window, as the timeline at the bottom, cannot.
 */
export function canCollapse(grid: SerializedDockview["grid"], group: string): boolean {
  const flip = (orientation: string) => (orientation === "HORIZONTAL" ? "VERTICAL" : "HORIZONTAL");
  const path = (
    node: GridNode,
    orientation: string,
  ): { readonly orientation: string; readonly count: number }[] | undefined => {
    if (node.type === "leaf") return (node.data as { id?: string }).id === group ? [] : undefined;
    const children = node.data as readonly GridNode[];
    for (const child of children) {
      const below = path(child, flip(orientation));
      if (below) return [...below, { orientation, count: children.length }];
    }
    return undefined;
  };
  const up = path(grid.root, grid.orientation);
  // From the group upwards: the first branch with others in it says which way they share.
  const shared = up?.find(({ count }) => count > 1);
  return shared?.orientation === "HORIZONTAL";
}

/** Takes what a saved layout says about strips. Undefined when it is not that. */
export function parseLooks(value: unknown): Record<string, SavedLook> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const looks: Record<string, SavedLook> = {};
  for (const [id, look] of Object.entries(value)) {
    if (typeof look !== "object" || look === null) return undefined;
    const { pinned, peek, width, peekWidth, collapsed } = look as Record<string, unknown>;
    looks[id] = {
      ...(pinned === true && { pinned: true as const }),
      ...(peek === false && { peek: false as const }),
      ...(typeof width === "number" && Number.isFinite(width) && { width: clampWidth(width) }),
      ...(typeof peekWidth === "number" &&
        Number.isFinite(peekWidth) && { peekWidth: clampWidth(peekWidth) }),
      ...(typeof collapsed === "number" &&
        Number.isFinite(collapsed) &&
        collapsed > 0 && { collapsed: Math.round(collapsed) }),
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
  #api: DockviewApi | undefined;

  subscribe = this.#emitter.subscribe;
  /** Changes with every change of any strip. */
  getSnapshot = (): number => this.#revision;

  stripOf(group: DockviewGroupPanel): TabStrip {
    const position = group.api.getHeaderPosition();
    return position === "left" || position === "right" ? position : "top";
  }

  lookOf(group: DockviewGroupPanel): StripLook {
    const look = this.#looks.get(group.id) ?? {};
    return {
      pinned: look.pinned === true,
      peek: look.peek !== false,
      width: look.width,
      peekWidth: look.peekWidth,
      collapsed: look.collapsed,
    };
  }

  /** Where folding up asks how groups sit, see `canCollapse`. */
  attach(api: DockviewApi): void {
    this.#api = api;
  }

  isCollapsed(group: DockviewGroupPanel): boolean {
    return this.lookOf(group).collapsed !== undefined;
  }

  /** Whether a click on the icon that shows folds this group up, or opens it. */
  canCollapse(group: DockviewGroupPanel): boolean {
    if (this.stripOf(group) === "top") return false;
    if (this.isCollapsed(group)) return true;
    const api = this.#api;
    return api !== undefined && canCollapse(api.toJSON().grid, group.id);
  }

  /** How wide the strip of a group is: its icons, or its names where they show all the time. */
  stripWidth(group: DockviewGroupPanel): number {
    const look = this.lookOf(group);
    return look.pinned ? (look.width ?? DEFAULT_WIDTH) : ICONS_WIDTH;
  }

  /** Folds a group up to its strip, or opens it again to the width it had. */
  toggleCollapsed(group: DockviewGroupPanel): void {
    if (this.isCollapsed(group)) this.expand(group);
    else this.collapse(group);
  }

  collapse(group: DockviewGroupPanel): void {
    if (this.isCollapsed(group) || !this.canCollapse(group)) return;
    const width = Math.round(group.width);
    this.#set(group, { collapsed: Math.max(width, OPEN_MIN_WIDTH) });
    this.#fit(group);
  }

  expand(group: DockviewGroupPanel): void {
    const back = this.lookOf(group).collapsed;
    if (back === undefined) return;
    this.#set(group, { collapsed: undefined });
    group.api.setConstraints(OPEN_CONSTRAINTS);
    group.api.setSize({ width: back });
  }

  /**
   * Gives the groups that are folded up the width of their strips, which nothing else changes, as
   * after a saved layout comes back: dockview would have them as wide as a group is at least.
   */
  fitCollapsed(): void {
    for (const group of this.#api?.groups ?? []) {
      if (this.isCollapsed(group)) this.#fit(group);
      // A group that dockview kept from before may still have the width of a folded one.
      else group.api.setConstraints(OPEN_CONSTRAINTS);
    }
  }

  #fit(group: DockviewGroupPanel): void {
    const width = this.stripWidth(group);
    group.api.setConstraints({ minimumWidth: width, maximumWidth: width });
    group.api.setSize({ width });
  }

  /** Tabs across the top always show their names. */
  isPinned(group: DockviewGroupPanel): boolean {
    return this.stripOf(group) === "top" || this.lookOf(group).pinned;
  }

  setStrip(group: DockviewGroupPanel, strip: TabStrip): void {
    if (this.stripOf(group) === strip) return;
    // Tabs across the top fold nothing up.
    if (strip === "top") this.expand(group);
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

  /** How wide the names of a strip of icons come out, as dragging the edge they come out to says. */
  setPeekWidth(group: DockviewGroupPanel, width: number): void {
    this.#set(group, { peekWidth: clampWidth(width) });
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
    const same =
      now.pinned === before.pinned &&
      now.peek === before.peek &&
      now.width === before.width &&
      now.peekWidth === before.peekWidth &&
      now.collapsed === before.collapsed;
    if (same) return;
    this.#looks.set(group.id, {
      ...(now.pinned && { pinned: true as const }),
      ...(!now.peek && { peek: false as const }),
      ...(now.width !== undefined && { width: now.width }),
      ...(now.peekWidth !== undefined && { peekWidth: now.peekWidth }),
      ...(now.collapsed !== undefined && { collapsed: now.collapsed }),
    });
    this.#changed();
    // A strip that gets wider or narrower takes its group with it while that is folded up.
    if (now.collapsed !== undefined && before.collapsed !== undefined) this.#fit(group);
  }

  #changed(): void {
    this.#revision += 1;
    this.#emitter.emit();
  }
}
