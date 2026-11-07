import {
  BUILT_IN_PROPERTIES,
  add,
  compare,
  isAnimation,
  subtract,
  toSeconds,
  type Animation,
  type ObjectDescriptor,
  type PropertySpec,
  type Rational,
  type Value,
  type ValueType,
} from "@animaquill/schema";
import { sample } from "./curve.ts";
import {
  clipEnd,
  clipOffset,
  clipStart,
  entryOf,
  orderedTracks,
  type ClipState,
  type TimelineState,
  type TrackState,
} from "./model.ts";
import { objectsOf } from "./objects.ts";
import { channelOf, effectiveProperties } from "./render-plan.ts";

/**
 * Everything that can have keys, as one tree: track, clip, object (as deep as it goes), group and
 * property. The keyframe editor and tools for AI read this. It says what there is and where, and
 * nothing here knows about a screen.
 */

/** What one row of the tree shows, which goes by the type of the value. */
export interface RowShape {
  /** Where the clip keeps the value. Rows of the parts of a vector share the path of the vector. */
  readonly path: string;
  /** Which part of the value this row is about, when it is about one part. */
  readonly component?: { readonly index: number; readonly name: string };
  /**
   * What the keys sit on. `segments` is for what does not change gradually: there is one value from
   * one key to the next, and that is the thing to show.
   */
  readonly band: "keys" | "segments";
  /** What opening the row shows. `value` is a curve of the numbers themselves. */
  readonly curve: "value" | "none";
  /** What is next to the name. */
  readonly readout: "number" | "value";
}

type Shape = Pick<RowShape, "band" | "curve" | "readout">;

const GRADUAL: Shape = { band: "keys", curve: "value", readout: "number" };
const STEPPED: Shape = { band: "segments", curve: "none", readout: "value" };

/** A new type of value is a new line here, and the compiler asks for it. */
const SHAPES: Readonly<Record<ValueType, Shape>> = {
  number: GRADUAL,
  angle: GRADUAL,
  boolean: STEPPED,
  choice: STEPPED,
  text: STEPPED,
  asset: STEPPED,
};

/**
 * The rows of a property. The first one stands for all of it. A vector also has a row for each part,
 * which is a view of the same channel: its keys are the keys of the vector.
 */
export function rowsOf(spec: PropertySpec): readonly RowShape[] {
  const shape = SHAPES[spec.type];
  const whole: RowShape = { path: spec.path, ...shape };
  const parts = (spec.components ?? []).map((name, index): RowShape => ({
    ...whole,
    component: { index, name },
  }));
  return [whole, ...parts];
}

export interface PropertyNode {
  readonly kind: "property";
  readonly id: string;
  readonly clip: string;
  readonly spec: PropertySpec;
  readonly rows: readonly RowShape[];
}

export interface GroupNode {
  readonly kind: "group";
  readonly id: string;
  readonly clip: string;
  readonly group: string;
  readonly children: readonly PropertyNode[];
}

export type ClipChild = ObjectNode | GroupNode | PropertyNode;

export interface ObjectNode {
  readonly kind: "object";
  readonly id: string;
  readonly clip: string;
  readonly object: ObjectDescriptor;
  readonly children: readonly ClipChild[];
  /** Channels nobody describes. They do nothing, and they stay in sight so that it shows. */
  readonly orphans?: true;
}

export interface ClipNode {
  readonly kind: "clip";
  readonly id: string;
  readonly clip: string;
  readonly children: readonly ClipChild[];
}

export interface TrackNode {
  readonly kind: "track";
  readonly id: string;
  readonly track: string;
  readonly children: readonly ClipNode[];
}

export type TreeNode = TrackNode | ClipNode | ClipChild;

/** Deeper than this a description is broken or hostile, and it would only slow the list down. */
const MAX_OBJECT_DEPTH = 32;

export interface ObjectForest {
  /** Objects in their order, with what belongs to each of them by `children`. */
  readonly roots: readonly ObjectTree[];
  /** Objects that went to the top because their parent makes no sense. */
  readonly detached: readonly string[];
}

export interface ObjectTree {
  readonly object: ObjectDescriptor;
  readonly children: readonly ObjectTree[];
}

/**
 * Puts a flat list of objects in order. It comes from project code, so it can be anything: a parent
 * that is not there, or a circle, or more levels than make sense. Each of those puts an object at the
 * top instead of losing it. The first object of an id counts.
 */
export function objectForest(objects: readonly ObjectDescriptor[]): ObjectForest {
  const byId = new Map<string, ObjectDescriptor>();
  for (const object of objects) if (!byId.has(object.id)) byId.set(object.id, object);
  const below = new Map<string, ObjectDescriptor[]>();
  // A queue that only grows, read from the front: thousands of objects at the top are common.
  const waiting: ObjectDescriptor[] = [];
  let next = 0;
  const detached: string[] = [];
  for (const object of byId.values()) {
    const { parent } = object;
    if (parent !== undefined && parent !== object.id && byId.has(parent)) {
      let children = below.get(parent);
      if (!children) below.set(parent, (children = []));
      children.push(object);
    } else {
      if (parent !== undefined) detached.push(object.id);
      waiting.push(object);
    }
  }
  const placed = new Set<string>();
  const grow = (object: ObjectDescriptor, depth: number): ObjectTree => {
    placed.add(object.id);
    const children = (below.get(object.id) ?? []).filter(({ id }) => !placed.has(id));
    if (depth < MAX_OBJECT_DEPTH) {
      return { object, children: children.map((child) => grow(child, depth + 1)) };
    }
    for (const child of children) {
      detached.push(child.id);
      waiting.push(child);
    }
    return { object, children: [] };
  };
  const roots: ObjectTree[] = [];
  const growWaiting = () => {
    for (; next < waiting.length; next += 1) roots.push(grow(waiting[next] as ObjectDescriptor, 1));
  };
  growWaiting();
  // All that nothing leads to goes around in a circle, or hangs from one.
  for (const object of byId.values()) {
    if (placed.has(object.id)) continue;
    detached.push(object.id);
    waiting.push(object);
    growWaiting();
  }
  return { roots, detached };
}

const propertyNode = (clip: string, prefix: string, spec: PropertySpec): PropertyNode => ({
  kind: "property",
  id: `${prefix}/${spec.path}`,
  clip,
  spec,
  rows: rowsOf(spec),
});

/** Properties in their order. A group shows up where its first property is. */
function propertyNodes(
  clip: string,
  prefix: string,
  specs: readonly PropertySpec[],
): readonly (GroupNode | PropertyNode)[] {
  const nodes: (GroupNode | PropertyNode)[] = [];
  const groups = new Map<string, PropertyNode[]>();
  for (const spec of specs) {
    if (spec.animatable === false) continue;
    const node = propertyNode(clip, prefix, spec);
    const { group } = spec;
    if (group === undefined) {
      nodes.push(node);
      continue;
    }
    const members = groups.get(group);
    if (members) {
      members.push(node);
      continue;
    }
    const children = [node];
    groups.set(group, children);
    nodes.push({ kind: "group", id: `${prefix}/group:${group}`, clip, group, children });
  }
  return nodes;
}

function objectNode(clip: string, prefix: string, tree: ObjectTree): ObjectNode {
  const id = `${prefix}/object:${tree.object.id}`;
  return {
    kind: "object",
    id,
    clip,
    object: tree.object,
    children: [
      ...propertyNodes(clip, id, tree.object.properties),
      ...tree.children
        .map((child) => objectNode(clip, id, child))
        .filter((node) => node.children.length > 0),
    ],
  };
}

/** The picture of a clip is the clip itself, so its properties do not need a level of their own. */
const isClipItself = (object: ObjectDescriptor) => object.type === "clip.visual";

/** What a value looks like, for a channel without a description. */
function guessedType(value: Value | undefined): ValueType {
  if (typeof value === "number") return "number";
  return typeof value === "boolean" ? "boolean" : "text";
}

function orphanSpec(path: string, { keys }: Animation): PropertySpec {
  const known = Object.hasOwn(BUILT_IN_PROPERTIES, path) ? BUILT_IN_PROPERTIES[path] : undefined;
  return known ?? { path, type: guessedType(keys[0]?.value) };
}

/** Keys that no object describes, which is what is left of a renamed object for example. */
function orphansOf(
  clip: ClipState,
  described: ReadonlySet<string>,
  prefix: string,
): ObjectNode | undefined {
  const specs = Object.entries(effectiveProperties(clip)).flatMap(([path, stored]) =>
    described.has(path) || !isAnimation(stored) ? [] : [orphanSpec(path, stored)],
  );
  if (specs.length === 0) return undefined;
  const object = { id: "orphans", properties: specs };
  const id = `${prefix}/object:orphans`;
  const children = specs.map((spec) => propertyNode(clip.id, id, spec));
  return { kind: "object", id, clip: clip.id, object, children, orphans: true };
}

const allSpecs = ({ object, children }: ObjectTree): readonly PropertySpec[] => [
  ...object.properties,
  ...children.flatMap(allSpecs),
];

function buildClipNode(clip: ClipState, objects: readonly ObjectDescriptor[]): ClipNode {
  const id = clip.id;
  const { roots } = objectForest(objects);
  const children = roots.flatMap((tree): readonly ClipChild[] => {
    if (isClipItself(tree.object)) {
      return [
        ...propertyNodes(id, id, tree.object.properties),
        ...tree.children.map((child) => objectNode(id, id, child)),
      ];
    }
    const node = objectNode(id, id, tree);
    return node.children.length > 0 ? [node] : [];
  });
  const described = new Set(
    roots.flatMap(allSpecs).flatMap(({ path, animatable }) => (animatable === false ? [] : [path])),
  );
  const orphans = orphansOf(clip, described, id);
  return { kind: "clip", id, clip: id, children: orphans ? [...children, orphans] : children };
}

/** Unchanged clips keep their identity, so a list of thousands costs nothing the second time. */
const nodes = new WeakMap<ClipState, ClipNode>();

/** What can be animated on a clip, which comes from its objects unless they are given. */
export function clipNodeOf(clip: ClipState, objects?: readonly ObjectDescriptor[]): ClipNode {
  if (objects) return buildClipNode(clip, objects);
  const known = nodes.get(clip);
  if (known) return known;
  const node = buildClipNode(clip, objectsOf(clip));
  nodes.set(clip, node);
  return node;
}

/** What the paths below something are, in the order of the tree. */
const paths = new WeakMap<TreeNode, readonly string[]>();

export function pathsBelow(node: TreeNode): readonly string[] {
  if (node.kind === "property") return [node.spec.path];
  const known = paths.get(node);
  if (known) return known;
  const below = (node.children as readonly TreeNode[]).flatMap(pathsBelow);
  paths.set(node, below);
  return below;
}

/** Whether the picture of a moment has this clip in it. The end belongs to what comes next. */
export const clipIsHere = (clip: ClipState, moment: Rational): boolean =>
  clip.hidden !== true &&
  compare(moment, clipStart(clip)) >= 0 &&
  compare(moment, clipEnd(clip)) < 0;

const isTrue = (value: Value | undefined) =>
  value === true || (typeof value === "number" && value > 0);

/** Whether a property says that its object is there. Without a value it does not say otherwise. */
function isPresent(object: ObjectDescriptor, clip: ClipState, clock: number): boolean {
  const spec = object.properties.find(({ path }) => path === object.presence);
  if (!spec) return true;
  const stored = entryOf(effectiveProperties(clip), spec.path);
  const channel = stored === undefined ? undefined : channelOf(stored, spec.type);
  if (channel) return isTrue(sample(channel, clock));
  return spec.default === undefined || isTrue(spec.default);
}

/**
 * Whether an object of a clip is there at a reading of the clock of the clip. It does not say
 * anything about the clip, or about the parents of the object.
 */
export function objectIsHere(object: ObjectDescriptor, clip: ClipState, clock: number): boolean {
  const { spans } = object;
  if (spans && !spans.some(([from, to]) => clock >= from && clock < to)) return false;
  return isPresent(object, clip, clock);
}

/** What the keyframe editor lists. */
export type ListRange = "here" | "all" | "keyed";

export interface ListFilter {
  readonly range: ListRange;
  /** The moment `here` is about, on the timeline. */
  readonly moment: Rational;
  /** What stays wherever the moment is, with all that is under it: people asked for it. */
  readonly always?: (id: string) => boolean;
  /** What people are looking for. A name that fits brings what is under it along. */
  readonly matches?: (node: TreeNode) => boolean;
}

interface Listing {
  readonly filter: ListFilter;
  readonly clip: ClipState;
  /** A number is good enough here: nothing gets saved or cut by it. */
  readonly clock: number;
  /** Whether the clip is not there at the moment people look at. */
  readonly away: boolean;
}

/** What people asked for shows wherever the moment is, and whether it has keys or not. */
const anywhere = (listing: Listing): Listing => ({
  ...listing,
  filter: { ...listing.filter, range: "all" },
  away: false,
});

const hasKeys = (clip: ClipState, path: string) => {
  const value = entryOf(effectiveProperties(clip), path);
  return value !== undefined && isAnimation(value);
};

function listedProperty(
  node: PropertyNode,
  listing: Listing,
  found: boolean,
): PropertyNode | undefined {
  const { filter, clip, away } = listing;
  if (away) return undefined;
  if (filter.range === "keyed" && !hasKeys(clip, node.spec.path)) return undefined;
  return found || !filter.matches || filter.matches(node) ? node : undefined;
}

/** The same list when nothing went: what is unchanged keeps its identity all the way up. */
function listedChildren<T extends ClipChild>(
  children: readonly T[],
  listing: Listing,
  found: boolean,
): readonly T[] {
  const kept = children.flatMap((child) => {
    const node = listedChild(child, listing, found);
    return node ? [node as T] : [];
  });
  return kept.length === children.length && kept.every((node, i) => node === children[i])
    ? children
    : kept;
}

function listedChild(node: ClipChild, listing: Listing, inherited: boolean): ClipChild | undefined {
  const { filter, clip, clock } = listing;
  const here = filter.always?.(node.id) ? anywhere(listing) : listing;
  if (node.kind === "property") return listedProperty(node, here, inherited);
  const found = inherited || filter.matches?.(node) === true;
  const orphans = node.kind === "object" && node.orphans;
  const isGone =
    node.kind === "object" &&
    !orphans &&
    here.filter.range === "here" &&
    !objectIsHere(node.object, clip, clock);
  const below = orphans ? { ...here, away: false } : isGone ? { ...here, away: true } : here;
  const children = listedChildren<ClipChild>(node.children, below, found);
  if (children.length === 0) return undefined;
  return children === node.children ? node : ({ ...node, children } as ClipChild);
}

/** Whether a clip has keys that nothing describes. */
export const hasOrphans = ({ children }: ClipNode): boolean =>
  children.some((child) => child.kind === "object" && child.orphans === true);

/** A clip as far as it gets listed, or undefined when nothing of it does. */
export function listedClip(
  node: ClipNode,
  clip: ClipState,
  filter: ListFilter,
): ClipNode | undefined {
  if (node.children.length === 0) return undefined;
  if (filter.range === "all" && !filter.matches) return node;
  const isAboutNow = filter.range === "here";
  const away = isAboutNow && !clipIsHere(clip, filter.moment);
  const clock = isAboutNow
    ? toSeconds(add(clipOffset(clip), subtract(filter.moment, clipStart(clip))))
    : 0;
  const listing = { filter, clip, clock, away };
  const found = filter.matches?.(node) === true;
  const here = filter.always?.(node.id) ? anywhere(listing) : listing;
  const children = listedChildren(node.children, here, found);
  if (children.length === 0) return undefined;
  return children === node.children ? node : { ...node, children };
}

/** A track with the clips of it that get listed. Clips come in the order they should show in. */
export function listedTrack(
  track: Pick<TrackState, "id">,
  clips: readonly ClipState[],
  filter: ListFilter,
): TrackNode | undefined {
  const children = clips.flatMap((clip) => {
    const node = listedClip(clipNodeOf(clip), clip, filter);
    return node ? [node] : [];
  });
  if (children.length === 0) return undefined;
  return { kind: "track", id: `track:${track.id}`, track: track.id, children };
}

/** The tree of a timeline, as far as a filter lists it. */
export function propertyTree(timeline: TimelineState, filter: ListFilter): readonly TrackNode[] {
  const clips = Object.values(timeline.clips).toSorted((a, b) =>
    compare(clipStart(a), clipStart(b)),
  );
  return orderedTracks(timeline).flatMap((track) => {
    const node = listedTrack(
      track,
      clips.filter((clip) => clip.track === track.id),
      filter,
    );
    return node ? [node] : [];
  });
}
