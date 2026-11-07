import { compare, isAnimation, parseTime, type Key, type PropertyValue } from "@animaquill/schema";
import { numberAt, secondsOf, type Channel } from "./curve.ts";
import { channelOf, type RenderLayer } from "./render-plan.ts";
import {
  boxOf,
  invert,
  matrixOf,
  pictureIn,
  transformAt,
  transformPoint,
  type Matrix,
  type Point,
  type Rect,
  type Size,
  type Transform,
} from "./view.ts";

/**
 * What the editor needs to put the handles of a clip on the picture and to work out what dragging
 * them does: the same box and matrix the compositor draws with, see `view.ts`.
 */

/** Where a clip is in the world at one moment. */
export interface Placement {
  /** The clip box, in world units. */
  readonly box: Size;
  /** What of the box has something in it, in units of the box. */
  readonly picture: Rect;
  /** From the box to the world. */
  readonly matrix: Matrix;
  readonly transform: Transform;
}

/**
 * Where a layer is at a moment, the way the compositor draws it. A scene and a color have no shape
 * of their own, and a picture or a video has the one the project knows of it.
 */
export function placementOf(
  layer: RenderLayer,
  time: number,
  natural: Size | undefined,
  stage: Size,
): Placement {
  const media =
    layer.source.kind === "image" || layer.source.kind === "video" ? natural : undefined;
  const box = boxOf(layer, time, media, stage);
  const transform = transformAt(layer, time);
  return {
    box,
    picture: pictureIn(layer.fit, media, box),
    matrix: matrixOf(transform, box),
    transform,
  };
}

/** The corners of a part of a box in the world, clockwise from the top left. */
export function cornersOf(matrix: Matrix, { x, y, width, height }: Rect): readonly Point[] {
  return [
    { x, y },
    { x: x + width, y },
    { x: x + width, y: y + height },
    { x, y: y + height },
  ].map((point) => transformPoint(matrix, point));
}

/** Whether a point is inside four corners in order, whichever way around they go. */
export function isInside(corners: readonly Point[], { x, y }: Point): boolean {
  let sign = 0;
  for (const [index, from] of corners.entries()) {
    const to = corners[(index + 1) % corners.length] as Point;
    const cross = (to.x - from.x) * (y - from.y) - (to.y - from.y) * (x - from.x);
    if (cross === 0) continue;
    if (sign !== 0 && Math.sign(cross) !== sign) return false;
    sign = Math.sign(cross);
  }
  return sign !== 0;
}

/** The anchor somewhere else, with what keeps the picture where it is. */
export interface Anchored {
  readonly anchorX: number;
  readonly anchorY: number;
  readonly x: number;
  readonly y: number;
}

/**
 * The anchor moved to a point of the world, and the position that keeps the picture still: the box
 * goes where it was, and only what it turns and scales around changes. That position is the point
 * itself. Undefined for a box that shows nothing, where no point is a share of it.
 */
export function anchoredAt({ box, matrix }: Placement, world: Point): Anchored | undefined {
  const back = invert(matrix);
  if (!back || !(box.width > 0) || !(box.height > 0)) return undefined;
  const inBox = transformPoint(back, world);
  return {
    anchorX: inBox.x / box.width,
    anchorY: inBox.y / box.height,
    x: world.x,
    y: world.y,
  };
}

/** Where the points that people put an anchor on are, in the world: corners, middles of sides, and the middle. */
export function anchorStops({ matrix, picture }: Placement): readonly Point[] {
  const { x, y, width, height } = picture;
  const stops: Point[] = [];
  for (const share of [0, 0.5, 1]) {
    for (const other of [0, 0.5, 1]) {
      stops.push(transformPoint(matrix, { x: x + width * share, y: y + height * other }));
    }
  }
  return stops;
}

/** A moment on the path of a clip that has a key of its position. */
export interface PathKey {
  /** As the key writes it, on the clock of the clip. */
  readonly time: string;
  readonly clock: number;
  /** Which of the two directions have a key there. */
  readonly hasX: boolean;
  readonly hasY: boolean;
}

export interface MotionPath {
  /** Where the anchor goes, in the world, in time order. */
  readonly points: readonly Point[];
  /** Where it is at each frame, to show how fast it goes. */
  readonly frames: readonly Point[];
  readonly keys: readonly (PathKey & Point)[];
}

/** More than a path needs to look smooth, and few enough to draw on every move of a drag. */
const MAX_PATH_POINTS = 2000;
const MAX_FRAME_DOTS = 600;

const keysOf = (value: PropertyValue | undefined): readonly Key[] =>
  value !== undefined && isAnimation(value) ? value.keys : [];

/** The keys of both directions, by moment, within a stretch of the clock. */
function pathKeys(x: readonly Key[], y: readonly Key[], from: number, to: number): PathKey[] {
  const all = [
    ...x.map((key) => ({ key, axis: "x" as const })),
    ...y.map((key) => ({ key, axis: "y" as const })),
  ]
    .map((entry) => ({ ...entry, moment: parseTime(entry.key.time) }))
    .toSorted((a, b) => compare(a.moment, b.moment));
  const keys: PathKey[] = [];
  for (const { key, axis, moment } of all) {
    const clock = secondsOf(key.time);
    if (!(clock >= from - 1e-9 && clock <= to + 1e-9)) continue;
    const last = keys.at(-1);
    const hasX = axis === "x";
    if (last && compare(parseTime(last.time), moment) === 0) {
      keys[keys.length - 1] = { ...last, ...(hasX ? { hasX } : { hasY: true }) };
    } else keys.push({ time: key.time, clock, hasX, hasY: !hasX });
  }
  return keys;
}

/**
 * The path the anchor of a clip takes because of keys on its position, from the first key to the
 * last one within the part of the clock that the clip shows. Worked out with `curve.ts`, the way the
 * compositor does. Nothing when neither direction has keys.
 */
export function motionPath(
  x: PropertyValue | undefined,
  y: PropertyValue | undefined,
  shown: { readonly from: number; readonly to: number },
  fps: number,
  fallback: Point,
): MotionPath | undefined {
  const xKeys = keysOf(x);
  const yKeys = keysOf(y);
  if (xKeys.length === 0 && yKeys.length === 0) return undefined;
  const xChannel: Channel | undefined = x === undefined ? undefined : channelOf(x, "number");
  const yChannel: Channel | undefined = y === undefined ? undefined : channelOf(y, "number");
  const at = (clock: number): Point => ({
    x: numberAt(xChannel, clock, fallback.x),
    y: numberAt(yChannel, clock, fallback.y),
  });
  const times = [...xKeys, ...yKeys].map((key) => secondsOf(key.time)).filter(Number.isFinite);
  const from = Math.max(Math.min(...times), shown.from);
  const to = Math.min(Math.max(...times), shown.to);
  const keys = pathKeys(xKeys, yKeys, shown.from, shown.to).map((key) => ({
    ...key,
    ...at(key.clock),
  }));
  if (!(to >= from)) return { points: [], frames: [], keys };
  const step = Math.max((to - from) / MAX_PATH_POINTS, 1 / Math.max(fps, 1) / 4);
  const clocks = new Set<number>();
  for (let clock = from; clock < to; clock += step) clocks.add(clock);
  clocks.add(to);
  for (const key of keys) clocks.add(key.clock);
  const points = [...clocks].toSorted((a, b) => a - b).map(at);
  const frameStep = Math.max(1 / Math.max(fps, 1), (to - from) / MAX_FRAME_DOTS);
  const frames: Point[] = [];
  for (let clock = from; clock <= to + 1e-9; clock += frameStep) frames.push(at(clock));
  return { points, frames, keys };
}
