import {
  AUTO_REACH,
  MAX_SPLIT_Y,
  MIN_SPLIT_Y,
  secondsOf,
  withAutoTangents,
} from "@animaquill/core";
import type { Key } from "@animaquill/schema";

/**
 * The handles of a key, as people drag them. A key has one on each side: `in` steers the stretch
 * that arrives at it and `out` the one that leaves it, both as shares of their stretch, as in CSS.
 * A straight stretch has them where a bezier would be straight. A stretch that holds has none.
 */

export type HandleSide = "in" | "out";
export type TangentMode = "auto" | "aligned" | "broken";

/** A place on a curve: seconds on the clock of the clip, and a value of the property. */
export interface CurvePoint {
  readonly t: number;
  readonly v: number;
}

type Share = readonly [number, number];

/** Where a bezier has its handles to be a straight line. */
const LINE_OUT: Share = [AUTO_REACH, AUTO_REACH];
const LINE_IN: Share = [1 - AUTO_REACH, 1 - AUTO_REACH];
/** What a key arrives with when it does not say. */
const ARRIVAL: Share = [1, 1];
/** Handles keep a millionth of their stretch, which is a pixel of a very long one. */
const DIGITS = 6;
/** Directions this close count as one line. */
const ALIGNED_SINE = 0.01;
const TINY = 1e-12;

const timeOf = (key: Key) => secondsOf(key.time);
const valueOf = (key: Key) => key.value as number;
const isBezier = (key: Key) => key.interp === "bezier" && key.out !== undefined;
const clamp = (value: number, low: number, high: number) => Math.min(Math.max(value, low), high);
const fixed = (value: number, digits: number) => {
  const short = Number(value.toFixed(digits));
  return short === 0 ? 0 : short;
};

/** The keys at the ends of the stretch a handle steers, or undefined where it holds or ends. */
export function stretchOf(
  keys: readonly Key[],
  index: number,
  side: HandleSide,
): { readonly from: number; readonly to: number } | undefined {
  const from = side === "out" ? index : index - 1;
  const start = keys[from];
  const end = keys[from + 1];
  if (from < 0 || !start || !end || start.interp === "hold") return undefined;
  if (typeof start.value !== "number" || typeof end.value !== "number") return undefined;
  return timeOf(end) > timeOf(start) ? { from, to: from + 1 } : undefined;
}

/** A handle as a share of its stretch, also where the stretch is straight. */
export function shareOf(keys: readonly Key[], index: number, side: HandleSide): Share | undefined {
  const stretch = stretchOf(keys, index, side);
  if (!stretch) return undefined;
  const start = keys[stretch.from] as Key;
  if (!isBezier(start)) return side === "out" ? LINE_OUT : LINE_IN;
  if (side === "out") return start.out as Share;
  return (keys[stretch.to] as Key).in ?? ARRIVAL;
}

/** Where a handle is, on the clock of its clip and in the units of its property. */
export function handlePoint(
  keys: readonly Key[],
  index: number,
  side: HandleSide,
): CurvePoint | undefined {
  const stretch = stretchOf(keys, index, side);
  const share = shareOf(keys, index, side);
  if (!stretch || !share) return undefined;
  const start = keys[stretch.from] as Key;
  const end = keys[stretch.to] as Key;
  const length = timeOf(end) - timeOf(start);
  const change = valueOf(end) - valueOf(start);
  return { t: timeOf(start) + share[0] * length, v: valueOf(start) + share[1] * change };
}

/**
 * The other point that steers the stretch of a handle: where the curve heads when the handle sits
 * right on its key, which is the way to show such a handle.
 */
export function farPoint(
  keys: readonly Key[],
  index: number,
  side: HandleSide,
): CurvePoint | undefined {
  return side === "out" ? handlePoint(keys, index + 1, "in") : handlePoint(keys, index - 1, "out");
}

const pointOfKey = (key: Key): CurvePoint => ({ t: timeOf(key), v: valueOf(key) });

/** How far the stretches on either side of a key reach, to compare directions in. */
function unitsAt(keys: readonly Key[], index: number): CurvePoint {
  const key = keys[index] as Key;
  const before = keys[index - 1] ?? key;
  const after = keys[index + 1] ?? key;
  const t = timeOf(after) - timeOf(before) || 1;
  const v = Math.abs(valueOf(key) - valueOf(before)) + Math.abs(valueOf(after) - valueOf(key)) || 1;
  return { t, v };
}

/** Whether the two handles of a key are on one line through it, on either side. */
function isAligned(keys: readonly Key[], index: number): boolean {
  const before = handlePoint(keys, index, "in");
  const after = handlePoint(keys, index, "out");
  if (!before || !after) return false;
  const key = pointOfKey(keys[index] as Key);
  const units = unitsAt(keys, index);
  const a = { t: (before.t - key.t) / units.t, v: (before.v - key.v) / units.v };
  const b = { t: (after.t - key.t) / units.t, v: (after.v - key.v) / units.v };
  const lengths = Math.hypot(a.t, a.v) * Math.hypot(b.t, b.v);
  if (lengths < TINY) return false;
  const sine = (a.t * b.v - a.v * b.t) / lengths;
  return Math.abs(sine) < ALIGNED_SINE && a.t * b.t + a.v * b.v < 0;
}

/**
 * How a key changes its handles. What it says, or else what it looks like: a key that goes through
 * smoothly stays smooth, and a corner stays a corner.
 */
export function tangentOf(keys: readonly Key[], index: number): TangentMode {
  const { tangent } = keys[index] as Key;
  if (tangent) return tangent;
  return isAligned(keys, index) ? "aligned" : "broken";
}

/** The keys that change, by index. What is not in it stays as it is. */
export type ChangedKeys = Map<number, Key>;

const keyIn = (keys: readonly Key[], changed: ChangedKeys, index: number) =>
  changed.get(index) ?? (keys[index] as Key);

/** Without what says how a key goes on, as when a new way of going on replaces it. */
function plain(key: Key): Key {
  const { interp: _interp, out: _out, preset: _preset, spring: _spring, ...rest } = key;
  return rest;
}

/** Puts one handle where it goes. A straight stretch becomes a bezier that it was a line of. */
function setShare(
  keys: readonly Key[],
  changed: ChangedKeys,
  index: number,
  side: HandleSide,
  share: Share,
): void {
  const now = (at: number) => keyIn(keys, changed, at);
  const from = side === "out" ? index : index - 1;
  const start = now(from);
  const end = now(from + 1);
  const wasBezier = isBezier(start);
  const lineOut = LINE_OUT.map((value) => fixed(value, DIGITS)) as [number, number];
  const lineIn = LINE_IN.map((value) => fixed(value, DIGITS)) as [number, number];
  // What steers the start of a stretch that was a bezier already stays as it is, unwritten.
  if (side === "out" || !wasBezier) {
    const out = side === "out" ? [...share] : lineOut;
    changed.set(from, { ...(wasBezier ? start : plain(start)), interp: "bezier", out } as Key);
  }
  if (side === "in") changed.set(from + 1, { ...end, in: [...share] as [number, number] });
  else if (!wasBezier) changed.set(from + 1, { ...end, in: lineIn });
}

/** Whether the stretch a handle steers does not change, which leaves it no other way than flat. */
function isFlat(keys: readonly Key[], index: number, side: HandleSide): boolean {
  const stretch = stretchOf(keys, index, side);
  if (!stretch) return false;
  const change = valueOf(keys[stretch.to] as Key) - valueOf(keys[stretch.from] as Key);
  return Math.abs(change) < TINY;
}

/** Flat, the way a curve goes on along a stretch that does not change. */
const LEVEL: CurvePoint = { t: 1, v: 0 };

/**
 * Where the handle on one side goes for the curve to leave its key in a direction, given as the way
 * the curve goes on. It keeps how far it reaches in time, or a third of its stretch where it has
 * no reach to keep. Undefined where the stretch cannot take a direction: it holds, or it is flat.
 */
function shareAlong(
  keys: readonly Key[],
  changed: ChangedKeys,
  index: number,
  side: HandleSide,
  direction: CurvePoint,
): Share | undefined {
  const now = (at: number) => keyIn(keys, changed, at);
  const current = [...keys];
  for (const [at, key] of changed) current[at] = key;
  const stretch = stretchOf(current, index, side);
  const share = shareOf(current, index, side);
  if (!stretch || !share) return undefined;
  const start = now(stretch.from);
  const end = now(stretch.to);
  const length = timeOf(end) - timeOf(start);
  const change = valueOf(end) - valueOf(start);
  if (Math.abs(change) < TINY) return undefined;
  const vertical = Math.abs(direction.t) < TINY;
  if (side === "out") {
    const x = fixed(vertical ? 0 : share[0] > TINY ? share[0] : AUTO_REACH, DIGITS);
    const reach = vertical
      ? Math.sign(direction.v) * Math.abs(change) * AUTO_REACH
      : (x * length * direction.v) / direction.t;
    return [x, fixed(clamp(reach / change, MIN_SPLIT_Y, MAX_SPLIT_Y), DIGITS)];
  }
  const x = fixed(vertical ? 1 : share[0] < 1 - TINY ? share[0] : 1 - AUTO_REACH, DIGITS);
  const reach = vertical
    ? -Math.sign(direction.v) * Math.abs(change) * AUTO_REACH
    : ((x - 1) * length * direction.v) / direction.t;
  return [x, fixed(clamp((change + reach) / change, MIN_SPLIT_Y, MAX_SPLIT_Y), DIGITS)];
}

export interface HandleDrag {
  readonly keys: readonly Key[];
  readonly index: number;
  readonly side: HandleSide;
  /** Where the pointer is, on the clock of the clip and in the units of the property. */
  readonly to: CurvePoint;
  /** Aligned takes the other handle along on one line, broken leaves it where it is. */
  readonly mode: "aligned" | "broken";
}

export interface DraggedHandle {
  readonly changed: ChangedKeys;
  /** The handle stopped at what a key can hold, before it got to the pointer. */
  readonly clamped: boolean;
}

/**
 * What a drag of a handle does to keys: the handle goes where the pointer is, as far as a handle
 * can go, and the key remembers how it went. Undefined for a handle that is not there.
 */
export function dragHandle({ keys, index, side, to, mode }: HandleDrag): DraggedHandle | undefined {
  const stretch = stretchOf(keys, index, side);
  const current = shareOf(keys, index, side);
  if (!stretch || !current) return undefined;
  const start = keys[stretch.from] as Key;
  const end = keys[stretch.to] as Key;
  const length = timeOf(end) - timeOf(start);
  const change = valueOf(end) - valueOf(start);
  const other: HandleSide = side === "out" ? "in" : "out";
  // On a line with a stretch on the other side that does not change, the handle is flat too.
  const level = mode === "aligned" && isFlat(keys, index, other);
  const wantedX = (to.t - timeOf(start)) / length;
  const wantedY = (to.v - valueOf(start)) / change;
  const flatY = side === "out" ? 0 : 1;
  // A stretch that does not change cannot bend: its handles only move along it.
  const y = Math.abs(change) < TINY ? current[1] : level ? flatY : wantedY;
  const x = clamp(wantedX, 0, 1);
  const within = clamp(y, MIN_SPLIT_Y, MAX_SPLIT_Y);
  const clamped =
    Math.abs(x - wantedX) > 1e-9 || (Math.abs(change) >= TINY && Math.abs(within - wantedY) > 1e-9);
  const changed: ChangedKeys = new Map();
  setShare(keys, changed, index, side, [fixed(x, DIGITS), fixed(within, DIGITS)]);
  if (mode === "aligned") {
    const key = keyIn(keys, changed, index);
    const now = [...keys];
    for (const [at, one] of changed) now[at] = one;
    const point = handlePoint(now, index, side) as CurvePoint;
    // The way the curve goes on, which the handle that comes in points away from.
    const sign = side === "out" ? 1 : -1;
    const direction = isFlat(keys, index, side)
      ? LEVEL
      : { t: (point.t - timeOf(key)) * sign, v: (point.v - valueOf(key)) * sign };
    const moved = Math.hypot(direction.t / length, direction.v / (Math.abs(change) || 1)) > TINY;
    const share = moved ? shareAlong(keys, changed, index, other, direction) : undefined;
    if (share) setShare(keys, changed, index, other, share);
  }
  const key = keyIn(keys, changed, index);
  changed.set(index, { ...key, tangent: mode });
  return { changed, clamped };
}

/** Both handles of a key on one line, which goes the average way of the two. */
function alignAt(keys: readonly Key[], changed: ChangedKeys, index: number): void {
  const current = [...keys];
  for (const [at, one] of changed) current[at] = one;
  const before = handlePoint(current, index, "in");
  const after = handlePoint(current, index, "out");
  if (!before || !after) return;
  const key = pointOfKey(current[index] as Key);
  const units = unitsAt(current, index);
  const unit = (point: CurvePoint, sign: number) => {
    const t = ((point.t - key.t) / units.t) * sign;
    const v = ((point.v - key.v) / units.v) * sign;
    const length = Math.hypot(t, v);
    return length < TINY ? { t: 0, v: 0 } : { t: t / length, v: v / length };
  };
  const a = unit(before, -1);
  const b = unit(after, 1);
  let t = a.t + b.t;
  let v = a.v + b.v;
  if (Math.hypot(t, v) < TINY) {
    // Pointing the same way: the line from one neighbour to the other is as good as any.
    const first = pointOfKey(current[index - 1] as Key);
    const last = pointOfKey(current[index + 1] as Key);
    t = (last.t - first.t) / units.t;
    v = (last.v - first.v) / units.v;
  }
  // Next to a stretch that does not change, the only line through the key is flat.
  const level = isFlat(current, index, "in") || isFlat(current, index, "out");
  const direction = level ? LEVEL : { t: t * units.t, v: v * units.v };
  for (const side of ["in", "out"] as const) {
    const share = shareAlong(keys, changed, index, side, direction);
    const now = shareOf(current, index, side);
    const same = share && now && share[0] === now[0] && share[1] === now[1];
    if (share && !same) setShare(keys, changed, index, side, share);
  }
}

/**
 * What saying how keys change their handles does: aligned puts both on one line, automatic works
 * them out, and broken only says so. None of it changes how keys go on: a key that holds or goes
 * straight keeps doing that, and `tangent` is about its handles when it is a bezier.
 */
export function withTangent(
  keys: readonly Key[],
  indices: readonly number[],
  mode: TangentMode,
): ChangedKeys {
  const changed: ChangedKeys = new Map();
  for (const index of indices) {
    if (!keys[index] || typeof keys[index]?.value !== "number") continue;
    if (mode === "aligned") alignAt(keys, changed, index);
    const key = keyIn(keys, changed, index);
    if (key.tangent !== mode || changed.has(index)) changed.set(index, { ...key, tangent: mode });
  }
  if (mode !== "auto") return changed;
  const current = [...keys];
  for (const [at, one] of changed) current[at] = one;
  const worked = withAutoTangents({ keys: current }).keys;
  worked.forEach((key, at) => {
    if (key !== current[at]) changed.set(at, key);
  });
  return changed;
}
