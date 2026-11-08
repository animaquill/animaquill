import type { ObjectDescriptor, PropertySpec } from "@animaquill/schema/properties";
import { isIdPart, isObjectId } from "./registration.ts";

/**
 * Handles on the picture: what an object says people can grab there, and what dragging one does to
 * its properties. The editor draws them, finds what the pointer is on and works out the values, so
 * they work the same for every object, go on working while a scene hangs, and the code of a project
 * never gets to see the pointer. Built-in objects describe theirs in the coordinates of the world,
 * the code of a scene in those of its scene. What comes from a scene is data to check, see
 * `readHandles`. Nothing here may bring in Yjs or Zod: the scene runtime loads this.
 */

/** A place, in the coordinates of whoever describes it. */
export type HandlePoint = readonly [x: number, y: number];

/** A property for each direction. One of them is enough. */
export interface AxisBind {
  readonly x?: string;
  readonly y?: string;
}

export type HandleSpec =
  /** Dragging adds how far the pointer went to one property for each direction. */
  | {
      readonly kind: "move";
      readonly id: string;
      readonly at: HandlePoint;
      readonly bind: AxisBind;
    }
  /**
   * Dragging adds how far the pointer went around `at` to a property, in degrees, clockwise. It
   * shows on a ring of `radius` around `at`, in the direction of the value.
   */
  | {
      readonly kind: "rotate";
      readonly id: string;
      readonly at: HandlePoint;
      readonly radius: number;
      readonly bind: string;
    }
  /**
   * Dragging multiplies a property by how much further from `center` the pointer is than where it
   * started, along the line from `center` to `at`. With a property for each direction, each one goes
   * by its own direction, and Shift keeps them together.
   */
  | {
      readonly kind: "scale";
      readonly id: string;
      readonly at: HandlePoint;
      readonly center: HandlePoint;
      readonly bind: string | AxisBind;
    }
  /** These only show: lines through points, and a circle. */
  | { readonly kind: "line" | "polyline"; readonly points: readonly HandlePoint[] }
  | { readonly kind: "circle"; readonly at: HandlePoint; readonly radius: number };

/** What can be dragged. */
export type GrabHandle = Extract<HandleSpec, { readonly id: string }>;

/** What a code object says about where it is and what can be grabbed of it. */
export interface ObjectHandles {
  /** The id it registered with: its properties are `object.<id>.<property>`. */
  readonly object: string;
  /** x, y, width and height in the coordinates of its scene. */
  readonly bounds?: readonly [number, number, number, number];
  readonly handles: readonly HandleSpec[];
}

/**
 * What a scene can say at once. Handles are worked out again whenever a value changes while somebody
 * drags, and every time they cross into the editor, so this is about what a person can make use of,
 * and keeps that small.
 */
export const HANDLE_LIMITS = {
  /** Objects that say anything about where they are. */
  objects: 64,
  /** Handles of all objects together, what only shows included. */
  handles: 64,
  /** Points of all lines together. */
  points: 256,
  /**
   * How far from the middle a place or a radius can be in any case, in units. A scene gets less than
   * that, by the size of its picture: see `handleReach`.
   */
  reach: 1e5,
} as const;

/** How many times the size of its picture the handles of a scene can reach from its middle. */
export const HANDLE_REACH_PICTURES = 10;

/**
 * How far from the middle of a scene its handles can be, and how large a circle can be: some times
 * the long side of its picture, which is far more than anybody can grab, and keeps what gets drawn
 * of them in proportion to the picture.
 */
export function handleReach({
  width,
  height,
}: {
  readonly width: number;
  readonly height: number;
}) {
  const side = Math.max(width, height, 1);
  return Math.min(side * HANDLE_REACH_PICTURES, HANDLE_LIMITS.reach);
}

/** Each of these is a code of a problem of the scene too, so they say what they are about. */
export type HandleProblemCode =
  /** Handles for an object that did not register. */
  | "handle-object"
  /** No such kind of handle, or not one that works yet: `custom` and 3D. */
  | "handle-kind"
  /** A handle without an id that a path can hold, or a second one with the same id. */
  | "handle-id"
  /** What it binds is no number of the object itself. */
  | "handle-bind"
  /** A place or a size that is no number, or too far away. */
  | "handle-point"
  | "handle-bounds"
  /** More than there is room for. What came first stays. */
  | "handles-too-many";

export interface HandleProblem {
  readonly code: HandleProblemCode;
  /** An object, or an object and a handle, as `arm.r`. */
  readonly target?: string;
}

const isPlainObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const field = (value: unknown, name: string): unknown =>
  isPlainObject(value) && Object.hasOwn(value, name) ? value[name] : undefined;

const isPlace = (value: unknown, reach: number): value is number =>
  typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= reach;

function pointOf(value: unknown, reach: number): HandlePoint | undefined {
  if (!Array.isArray(value) || value.length !== 2) return undefined;
  const [x, y] = value as unknown[];
  return isPlace(x, reach) && isPlace(y, reach) ? [x, y] : undefined;
}

const isRadius = (value: unknown, reach: number): value is number =>
  isPlace(value, reach) && value > 0;

/** Kinds that are part of the design but do not work yet. They are said to be missing, not wrong. */
const LATER = new Set(["custom", "move3d", "rotate3d"]);

type Report = (code: HandleProblemCode, target?: string) => void;

/** Only numbers can be worked out from where a pointer is. */
const isNumber = (spec: PropertySpec | undefined) =>
  spec?.type === "number" || spec?.type === "angle";

interface Room {
  handles: number;
  points: number;
}

interface Reading {
  readonly object: string;
  readonly properties: ReadonlyMap<string, PropertySpec>;
  readonly ids: Set<string>;
  readonly room: Room;
  readonly reach: number;
  readonly report: Report;
}

function bindOf(raw: unknown, reading: Reading): string | undefined {
  return isIdPart(raw) && isNumber(reading.properties.get(raw)) ? raw : undefined;
}

function axesOf(raw: unknown, reading: Reading): AxisBind | undefined {
  if (!isPlainObject(raw)) return undefined;
  const x = field(raw, "x");
  const y = field(raw, "y");
  const boundX = x === undefined ? undefined : bindOf(x, reading);
  const boundY = y === undefined ? undefined : bindOf(y, reading);
  if ((x !== undefined && !boundX) || (y !== undefined && !boundY)) return undefined;
  if (!boundX && !boundY) return undefined;
  return { ...(boundX && { x: boundX }), ...(boundY && { y: boundY }) };
}

/** One handle that can be grabbed, or undefined with the reason said. */
function readGrab(
  raw: unknown,
  kind: GrabHandle["kind"],
  reading: Reading,
): GrabHandle | undefined {
  const { object, ids, reach, report } = reading;
  const id = field(raw, "id");
  if (!isIdPart(id) || ids.has(id)) {
    report("handle-id", `${object}.${typeof id === "string" ? id.slice(0, 64) : "?"}`);
    return undefined;
  }
  const where = `${object}.${id}`;
  const at = pointOf(field(raw, "at"), reach);
  if (!at) {
    report("handle-point", where);
    return undefined;
  }
  const rawBind = field(raw, "bind");
  let handle: GrabHandle | undefined;
  if (kind === "move") {
    const bind = axesOf(rawBind, reading);
    handle = bind && { kind, id, at, bind };
  } else if (kind === "rotate") {
    const radius = field(raw, "radius");
    if (!isRadius(radius, reach)) {
      report("handle-point", where);
      return undefined;
    }
    const bind = bindOf(rawBind, reading);
    handle = bind === undefined ? undefined : { kind, id, at, radius, bind };
  } else {
    const center = pointOf(field(raw, "center"), reach);
    if (!center) {
      report("handle-point", where);
      return undefined;
    }
    const bind = typeof rawBind === "string" ? bindOf(rawBind, reading) : axesOf(rawBind, reading);
    handle = bind === undefined ? undefined : { kind, id, at, center, bind };
  }
  if (!handle) report("handle-bind", where);
  else ids.add(id);
  return handle;
}

/** A handle that only shows. What has too many points keeps as many as there is room for. */
function readShape(raw: unknown, kind: string, reading: Reading): HandleSpec | undefined {
  const { object, room, reach, report } = reading;
  if (kind === "circle") {
    const at = pointOf(field(raw, "at"), reach);
    const radius = field(raw, "radius");
    if (at && isRadius(radius, reach)) return { kind, at, radius };
    report("handle-point", object);
    return undefined;
  }
  if (room.points < 2) {
    report("handles-too-many", "points");
    return undefined;
  }
  const given = field(raw, "points");
  const list = Array.isArray(given) ? given : [];
  const points: HandlePoint[] = [];
  for (const entry of list) {
    const point = pointOf(entry, reach);
    if (!point) {
      report("handle-point", object);
      return undefined;
    }
    if (points.length >= room.points) {
      report("handles-too-many", "points");
      break;
    }
    points.push(point);
  }
  const fits = kind === "line" ? points.length === 2 : points.length >= 2;
  if (!fits) {
    report("handle-point", object);
    return undefined;
  }
  room.points -= points.length;
  return { kind: kind as "line" | "polyline", points };
}

function readHandle(raw: unknown, reading: Reading): HandleSpec | undefined {
  const kind = field(raw, "kind");
  if (kind === "move" || kind === "rotate" || kind === "scale") return readGrab(raw, kind, reading);
  if (kind === "line" || kind === "polyline" || kind === "circle") {
    return readShape(raw, kind, reading);
  }
  const named = typeof kind === "string" ? kind.slice(0, 64) : "?";
  reading.report("handle-kind", `${reading.object}.${LATER.has(named) ? named : "?"}`);
  return undefined;
}

function readBounds(raw: unknown, reach: number): ObjectHandles["bounds"] {
  if (!Array.isArray(raw) || raw.length !== 4) return undefined;
  const [x, y, width, height] = raw as unknown[];
  const fits =
    isPlace(x, reach) && isPlace(y, reach) && isPlace(width, reach) && isPlace(height, reach);
  return fits && width >= 0 && height >= 0 ? [x, y, width, height] : undefined;
}

export interface ReadHandles {
  readonly objects: readonly ObjectHandles[];
  readonly problems: readonly HandleProblem[];
}

/** The most problems one reading reports. Each one is said once anyway. */
const MAX_PROBLEMS = 50;

/**
 * Reads what a scene says about where its objects are and what can be grabbed of them, against what
 * it registered: a handle can only bind numbers of its own object, which keeps it away from other
 * objects, other clips and the transform of its clip. What comes out is new data that only has what
 * makes sense, cut down to `HANDLE_LIMITS` and to `reach`, see `handleReach`, and every problem
 * says what got left out.
 */
export function readHandles(
  raw: unknown,
  registered: readonly ObjectDescriptor[],
  reach: number = HANDLE_LIMITS.reach,
): ReadHandles {
  const problems: HandleProblem[] = [];
  const seen = new Set<string>();
  const report: Report = (code, target) => {
    const key = `${code} ${target ?? ""}`;
    if (seen.has(key) || problems.length >= MAX_PROBLEMS) return;
    seen.add(key);
    problems.push(target === undefined ? { code } : { code, target });
  };
  if (!Array.isArray(raw)) return { objects: [], problems };
  const known = new Map(registered.map((object) => [object.id, object]));
  const room: Room = { handles: HANDLE_LIMITS.handles, points: HANDLE_LIMITS.points };
  const objects: ObjectHandles[] = [];
  const done = new Set<string>();
  if (raw.length > HANDLE_LIMITS.objects) report("handles-too-many", "objects");
  for (const entry of raw.slice(0, HANDLE_LIMITS.objects)) {
    const id = field(entry, "object");
    const descriptor = isObjectId(id) ? known.get(id) : undefined;
    if (!descriptor || done.has(descriptor.id)) {
      report("handle-object", typeof id === "string" ? id.slice(0, 200) : undefined);
      continue;
    }
    done.add(descriptor.id);
    const reading: Reading = {
      object: descriptor.id,
      properties: new Map(descriptor.properties.map((spec) => [spec.path, spec])),
      ids: new Set(),
      room,
      reach: Math.min(reach, HANDLE_LIMITS.reach),
      report,
    };
    const rawBounds = field(entry, "bounds");
    const bounds = rawBounds === undefined ? undefined : readBounds(rawBounds, reading.reach);
    if (rawBounds !== undefined && !bounds) report("handle-bounds", descriptor.id);
    const given = field(entry, "handles");
    const list = Array.isArray(given) ? given : [];
    const handles: HandleSpec[] = [];
    for (const one of list) {
      if (room.handles <= 0) {
        report("handles-too-many", "handles");
        break;
      }
      const handle = readHandle(one, reading);
      if (!handle) continue;
      handles.push(handle);
      room.handles -= 1;
    }
    if (handles.length > 0 || bounds) {
      objects.push({ object: descriptor.id, ...(bounds && { bounds }), handles });
    }
  }
  return { objects, problems };
}

/** What a drag has done so far, in the coordinates of its handle. */
export interface HandleDrag {
  /** Where the pointer went down. */
  readonly from: HandlePoint;
  /** Where it is now. */
  readonly to: HandlePoint;
  /** How far it went around the middle of a rotate handle, in degrees, which can be turns. */
  readonly turned: number;
  /** A move keeps to one direction, a turn to steps of `ROTATE_STEP`, a scale to both directions. */
  readonly shift: boolean;
}

/** What Shift turns in, in degrees. */
export const ROTATE_STEP = 15;

/**
 * However far the pointer goes past the middle, a scale stops at this share of what it was: past
 * nothing it would turn things inside out, and nothing could never be scaled back.
 */
export const MIN_SCALE_FACTOR = 0.01;

/** How far a point is around a middle, in degrees, clockwise when y goes down. */
const angleOf = ([cx, cy]: HandlePoint, [x, y]: HandlePoint) =>
  (Math.atan2(y - cy, x - cx) * 180) / Math.PI;

/** How far the pointer went around a middle from one place to the next, the short way, in degrees. */
export function turnBetween(center: HandlePoint, from: HandlePoint, to: HandlePoint): number {
  const turn = angleOf(center, to) - angleOf(center, from);
  if (!Number.isFinite(turn)) return 0;
  return turn - 360 * Math.round(turn / 360);
}

/** Only the direction it went further in, as people expect of Shift. */
export function straightened(dx: number, dy: number, shift: boolean): HandlePoint {
  if (!shift) return [dx, dy];
  return Math.abs(dx) >= Math.abs(dy) ? [dx, 0] : [0, dy];
}

/** Nearly nothing, next to the numbers around it. */
const TINY = 1e-9;

/** How far along a direction the pointer got, as a share of where it started on it. */
function shareAlong(center: HandlePoint, along: HandlePoint, from: HandlePoint, to: HandlePoint) {
  const [cx, cy] = center;
  const ux = along[0] - cx;
  const uy = along[1] - cy;
  const start = (from[0] - cx) * ux + (from[1] - cy) * uy;
  if (!(Math.abs(start) > TINY * (ux * ux + uy * uy))) return 1;
  return ((to[0] - cx) * ux + (to[1] - cy) * uy) / start;
}

function shareOnAxis(center: number, from: number, to: number): number {
  const start = from - center;
  return Math.abs(start) > TINY * Math.max(Math.abs(from), Math.abs(center), 1)
    ? (to - center) / start
    : 1;
}

const atLeast = (factor: number) => Math.max(factor, MIN_SCALE_FACTOR);

/**
 * What a drag comes to: the new values of what a handle binds, by what it calls them. Values that
 * are not there to start from stay out, and so does what does not move. Limits are for whoever
 * writes, which knows the properties.
 */
export function solveHandle(
  handle: GrabHandle,
  drag: HandleDrag,
  start: (bind: string) => number | undefined,
): ReadonlyMap<string, number> {
  const values = new Map<string, number>();
  const set = (bind: string | undefined, value: (from: number) => number) => {
    const from = bind === undefined ? undefined : start(bind);
    if (bind !== undefined && from !== undefined) values.set(bind, value(from));
  };
  const { from, to, shift } = drag;
  if (handle.kind === "move") {
    const [dx, dy] = straightened(to[0] - from[0], to[1] - from[1], shift);
    set(handle.bind.x, (value) => value + dx);
    set(handle.bind.y, (value) => value + dy);
  } else if (handle.kind === "rotate") {
    set(handle.bind, (value) => {
      const turned = value + drag.turned;
      return shift ? Math.round(turned / ROTATE_STEP) * ROTATE_STEP : turned;
    });
  } else {
    const { center, at, bind } = handle;
    const together = atLeast(shareAlong(center, at, from, to));
    if (typeof bind === "string") set(bind, (value) => value * together);
    else {
      const x = shift ? together : atLeast(shareOnAxis(center[0], from[0], to[0]));
      const y = shift ? together : atLeast(shareOnAxis(center[1], from[1], to[1]));
      set(bind.x, (value) => value * x);
      set(bind.y, (value) => value * y);
    }
  }
  return values;
}
