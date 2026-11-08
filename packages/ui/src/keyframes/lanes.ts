import {
  componentSpecOf,
  pathsBelow,
  type ClipNode,
  type PropertyNode,
  type RowShape,
  type TrackNode,
  type TreeNode,
} from "@animaquill/core";
import type { PropertySpec } from "@animaquill/schema";
import type { ClipBox, Row, TimelineModel } from "../timeline/model.ts";

/** One row of keys: the height of a control, so that values and keys line up. */
export const LANE_HEIGHT = 24;
/** A row made taller to work on its curve, until people pull its edge to another height. */
export const DEFAULT_TALL_HEIGHT = 120;
export const MIN_TALL_HEIGHT = 40;
export const MAX_TALL_HEIGHT = 480;

/** Which part of a vector a row is about. */
export type LanePart = NonNullable<RowShape["component"]>;

/** One row of the list of what has keys, with where it is. */
export interface Lane {
  readonly id: string;
  readonly node: TreeNode;
  /**
   * The part of a vector this row is about, under the row of the vector. It is a view of the same
   * channel: the same keys, and the curve of that one number.
   */
  readonly component?: LanePart;
  /** How far it is in, for showing that it belongs to what is above it. */
  readonly depth: number;
  /** The distance from the top of the first lane. */
  readonly top: number;
  /** All of it. A row of a number is the curve of it, from top to bottom. */
  readonly height: number;
  /**
   * The height of a row, which is `LANE_HEIGHT` unless the rows were made taller. A row that was
   * made taller on its own has its name and value in this much at the top.
   */
  readonly keyHeight: number;
  /** Made taller on its own, to work on its curve. */
  readonly tall: boolean;
  /** The group it is in, which is what tells its X and Y from those of other groups. */
  readonly group: string | undefined;
  readonly open: boolean;
  readonly canOpen: boolean;
  readonly row: Row;
  /** The clip this is about. A track is about the clips in `listed`. */
  readonly box: ClipBox | undefined;
  /** The properties it shows, by clip. */
  readonly listed: ReadonlyMap<string, readonly string[]>;
}

/** What is open is up to the view. */
export interface LaneRules {
  isOpen(node: TreeNode): boolean;
  /**
   * How tall a row is that was made taller on its own: a property, or a part of a vector. Undefined
   * for one that is not.
   */
  tallHeight(node: PropertyNode, component?: number): number | undefined;
}

/** The rows of the parts of a vector, which is all that a property has under it. */
const partsOf = (node: PropertyNode): readonly LanePart[] =>
  node.rows.flatMap(({ component }) => (component ? [component] : []));

/** A property is a row of its own: what it shows is in the row. A vector has its parts under it. */
const canOpen = (node: TreeNode) =>
  node.kind === "property" ? partsOf(node).length > 0 : node.children.length > 0;

/**
 * What the values of a lane are: those of its property, or for a part of a vector a number in the
 * same units. Undefined for what is not a property.
 */
export function specOfLane({ node, component }: Lane): PropertySpec | undefined {
  if (node.kind !== "property") return undefined;
  return component ? componentSpecOf(node.spec) : node.spec;
}

/** The id of the row of a part of a vector, next to the id of the vector. */
export const partLaneId = (node: PropertyNode, index: number): string => `${node.id}#${index}`;

interface Placing {
  readonly lanes: Lane[];
  readonly rules: LaneRules;
  readonly model: TimelineModel;
  readonly keyHeight: number;
  row: Row;
  top: number;
}

function place(
  placing: Placing,
  node: TreeNode,
  depth: number,
  box: ClipBox | undefined,
  listed: ReadonlyMap<string, readonly string[]>,
  group?: string,
): void {
  const { rules, lanes } = placing;
  const open = rules.isOpen(node) && canOpen(node);
  const parts = node.kind === "property" ? partsOf(node) : [];
  // A vector stands for all of its parts, and the curves are in their rows.
  const tall = node.kind === "property" && parts.length === 0 ? rules.tallHeight(node) : undefined;
  const height = Math.max(tall ?? 0, placing.keyHeight);
  lanes.push({
    id: node.id,
    node,
    depth,
    top: placing.top,
    height,
    keyHeight: placing.keyHeight,
    tall: tall !== undefined,
    group,
    open,
    canOpen: canOpen(node),
    row: placing.row,
    box,
    listed,
  });
  placing.top += height;
  if (!open) return;
  if (node.kind === "property") {
    for (const component of parts)
      placePart(placing, node, component, depth + 1, box, listed, group);
    return;
  }
  for (const child of node.children) {
    const clipBox = child.kind === "clip" ? placing.model.boxes.get(child.clip) : box;
    if (clipBox) {
      const own = new Map([[clipBox.id, pathsBelow(child)]]);
      place(
        placing,
        child,
        depth + 1,
        clipBox,
        own,
        node.kind === "group" ? node.group : undefined,
      );
    }
  }
}

/** The row of a part of a vector, which has the keys of the vector and the curve of the part. */
function placePart(
  placing: Placing,
  node: PropertyNode,
  component: LanePart,
  depth: number,
  box: ClipBox | undefined,
  listed: ReadonlyMap<string, readonly string[]>,
  group: string | undefined,
): void {
  const tall = placing.rules.tallHeight(node, component.index);
  const height = Math.max(tall ?? 0, placing.keyHeight);
  placing.lanes.push({
    id: partLaneId(node, component.index),
    node,
    component,
    depth,
    top: placing.top,
    height,
    keyHeight: placing.keyHeight,
    tall: tall !== undefined,
    group,
    open: false,
    canOpen: false,
    row: placing.row,
    box,
    listed,
  });
  placing.top += height;
}

/** The lanes of some tracks, one under the other, from a height on. */
export function lanesOfTracks(
  model: TimelineModel,
  tracks: readonly TrackNode[],
  rules: LaneRules,
  keyHeight = LANE_HEIGHT,
): readonly Lane[] {
  const lanes: Lane[] = [];
  const [first] = model.rows;
  if (!first) return lanes;
  const placing: Placing = { lanes, rules, model, keyHeight, row: first, top: 0 };
  const rows = new Map(model.rows.map((row) => [row.id, row]));
  for (const track of tracks) {
    const row = rows.get(track.track);
    if (!row) continue;
    placing.row = row;
    const listed = new Map(track.children.map((child) => [child.clip, pathsBelow(child)]));
    place(placing, track, 0, undefined, listed);
  }
  return lanes;
}

/** The lanes of one clip, from a height on. */
export function lanesOfClip(
  model: TimelineModel,
  node: ClipNode,
  row: Row,
  top: number,
  rules: LaneRules,
): readonly Lane[] {
  const box = model.boxes.get(node.clip);
  if (!box) return [];
  const lanes: Lane[] = [];
  const own = new Map([[box.id, pathsBelow(node)]]);
  place({ lanes, rules, model, keyHeight: LANE_HEIGHT, row, top }, node, 0, box, own);
  return lanes;
}

/** The lane at a height. */
export function laneAt(lanes: readonly Lane[], y: number): Lane | undefined {
  let low = 0;
  let high = lanes.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const lane = lanes[middle] as Lane;
    if (y < lane.top) high = middle - 1;
    else if (y >= lane.top + lane.height) low = middle + 1;
    else return lane;
  }
  return undefined;
}

/** The first lane that reaches below a height. */
export function firstLaneBelow(lanes: readonly Lane[], y: number): number {
  let low = 0;
  let high = lanes.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    const lane = lanes[middle] as Lane;
    if (lane.top + lane.height > y) high = middle;
    else low = middle + 1;
  }
  return low;
}
