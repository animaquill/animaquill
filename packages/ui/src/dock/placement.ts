import { SIZE_ORDER, type PanelArea, type PanelSize } from "../workbench/panels.ts";

/** A group of tabs as placing a panel sees it. */
export interface PlacementGroup {
  readonly id: string;
  /** The types of its tabs. */
  readonly panels: readonly string[];
  /** When one of its tabs was last switched to. Undefined when none has been in this window. */
  readonly used: number | undefined;
  readonly width: number;
  readonly height: number;
  /** Where it comes in the layout, left to right and top to bottom: the lower, the earlier. */
  readonly order: number;
}

/** The panel to place. */
export interface PlacedPanel {
  readonly type: string;
  readonly sizes: readonly PanelSize[];
  readonly area: PanelArea;
  /** Opens in a column of its own to the right of this panel, when it is there. */
  readonly beside?: string | undefined;
}

export type Placement =
  /** It is there already: only switch to it. */
  | { readonly kind: "there"; readonly group: string }
  /** In a new column to the right of this group. */
  | { readonly kind: "beside"; readonly group: string }
  /** As the last tab of this group. */
  | { readonly kind: "into"; readonly group: string }
  /** In a new group where its area is in a new layout. */
  | { readonly kind: "new"; readonly area: PanelArea };

/** How much of a group has room of this kind: the share of its tabs made for it. */
function shareOf(group: PlacementGroup, size: PanelSize, sizesOf: SizesOf): number {
  if (group.panels.length === 0) return 0;
  const made = group.panels.filter((type) => sizesOf(type).includes(size)).length;
  return made / group.panels.length;
}

const roomOf = (group: PlacementGroup, size: PanelSize): number =>
  size === "large" ? group.width * group.height : size === "tall" ? group.height : group.width;

/** The kinds of room a panel in a layout is made for; nothing for one that is not known. */
export type SizesOf = (type: string) => readonly PanelSize[];

/**
 * Where a panel opens (docs/design/settings-and-properties.md of AnimaQuill Cloud, 11.4). A group
 * is of each kind its tabs are made for, whatever its shape: what people put in it says best what
 * they use it for. The kinds of the panel are tried large, tall, wide; among the groups of a kind,
 * the one with the larger share of it wins, then the one used last, then the one with the more room
 * of that kind, then the earlier one.
 */
export function placePanel(
  panel: PlacedPanel,
  groups: readonly PlacementGroup[],
  sizesOf: SizesOf,
): Placement {
  const home = groups.find((group) => group.panels.includes(panel.type));
  if (home) return { kind: "there", group: home.id };
  if (panel.beside !== undefined) {
    const partner = groups.find((group) => group.panels.includes(panel.beside ?? ""));
    if (partner) return { kind: "beside", group: partner.id };
  }
  for (const size of SIZE_ORDER) {
    if (!panel.sizes.includes(size)) continue;
    const scored = groups
      .map((group) => ({ group, share: shareOf(group, size, sizesOf) }))
      .filter(({ share }) => share > 0);
    const best = scored.reduce<(typeof scored)[number] | undefined>(
      (sofar, next) => (sofar && compare(sofar, next, size) <= 0 ? sofar : next),
      undefined,
    );
    if (best) return { kind: "into", group: best.group.id };
  }
  return { kind: "new", area: panel.area };
}

/** Below zero when `a` is the better place. */
function compare(
  a: { group: PlacementGroup; share: number },
  b: { group: PlacementGroup; share: number },
  size: PanelSize,
): number {
  if (a.share !== b.share) return b.share - a.share;
  const used = (b.group.used ?? -Infinity) - (a.group.used ?? -Infinity);
  if (used !== 0 && !Number.isNaN(used)) return used;
  const room = roomOf(b.group, size) - roomOf(a.group, size);
  if (room !== 0) return room;
  return a.group.order - b.group.order;
}
