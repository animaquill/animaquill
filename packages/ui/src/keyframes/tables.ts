import {
  bezierProgress,
  canMix,
  effectiveProperties,
  entryOf,
  secondsOf,
  type ClipState,
} from "@animaquill/core";
import {
  isAnimation,
  type Animation,
  type Key,
  type PropertyValue,
  type ValueType,
} from "@animaquill/schema";

/** Moments on a clock that are this close count as the same one. It is only for finding keys. */
export const SAME_MOMENT = 1e-9;

/** What the shape of a key says: a diamond is linear, a circle eases, a square holds. */
export const KEY_LINEAR = 0;
export const KEY_EASED = 1;
export const KEY_HOLD = 2;
/** More than one at the same moment, in a summary. */
const KEY_MIXED = KEY_LINEAR;

export type KeyMark = typeof KEY_LINEAR | typeof KEY_EASED | typeof KEY_HOLD;

/** Keys as numbers, because a screen of them gets looked at many times per frame. */
export interface KeyTable {
  /** Seconds on the clock of the clip, in order. */
  readonly seconds: Float64Array;
  readonly marks: Uint8Array;
}

function markOf({ interp }: Key): KeyMark {
  if (interp === "hold") return KEY_HOLD;
  return interp === undefined || interp === "linear" ? KEY_LINEAR : KEY_EASED;
}

const tables = new WeakMap<Animation, KeyTable>();
const timeSets = new WeakMap<Animation, ReadonlySet<string>>();

/** Whether keys have a key at a time, as it is written. */
export function hasKeyAt(animation: Animation, time: string): boolean {
  let times = timeSets.get(animation);
  if (!times) {
    times = new Set(animation.keys.map((key) => key.time));
    timeSets.set(animation, times);
  }
  return times.has(time);
}

/** Keys only change by being replaced, so they get worked out once. */
export function keyTableOf(animation: Animation): KeyTable {
  const known = tables.get(animation);
  if (known) return known;
  const { keys } = animation;
  const table = {
    seconds: Float64Array.from(keys, ({ time }) => secondsOf(time)),
    marks: Uint8Array.from(keys, markOf),
  };
  tables.set(animation, table);
  return table;
}

/** What a key looks like in a property of a type: what cannot change gradually only holds. */
export const markFor = (mark: number, type: ValueType): number => (canMix(type) ? mark : KEY_HOLD);

/** The first of some moments in order that is not before a moment. */
export function firstFrom(seconds: Float64Array, moment: number): number {
  let low = 0;
  let high = seconds.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if ((seconds[middle] as number) < moment) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** Where a moment is among some in order, or -1. */
export function indexAt(seconds: Float64Array, moment: number): number {
  const index = firstFrom(seconds, moment - SAME_MOMENT);
  const found = seconds[index];
  return found !== undefined && Math.abs(found - moment) <= SAME_MOMENT ? index : -1;
}

/** The nearest of some moments in order, or -1 when there are none. */
export function nearest(seconds: Float64Array, moment: number): number {
  const index = firstFrom(seconds, moment);
  const after = seconds[index];
  const before = seconds[index - 1];
  if (after === undefined) return before === undefined ? -1 : index - 1;
  if (before === undefined) return index;
  return moment - before <= after - moment ? index - 1 : index;
}

/** The keys of a value, when it has them. */
export const animationIn = (value: PropertyValue | undefined): Animation | undefined =>
  value !== undefined && isAnimation(value) ? value : undefined;

/** All the keys of some properties of a clip as one list, one per moment. */
const summaries = new WeakMap<readonly string[], WeakMap<ClipState, KeyTable>>();

function buildSummary(clip: ClipState, paths: readonly string[]): KeyTable {
  const properties = effectiveProperties(clip);
  const moments: { readonly at: number; readonly mark: number }[] = [];
  for (const path of paths) {
    const animation = animationIn(entryOf(properties, path));
    if (!animation) continue;
    const { seconds, marks } = keyTableOf(animation);
    seconds.forEach((at, index) => moments.push({ at, mark: marks[index] as number }));
  }
  moments.sort((a, b) => a.at - b.at);
  const seconds: number[] = [];
  const marks: number[] = [];
  for (const { at, mark } of moments) {
    const last = seconds.at(-1);
    if (last !== undefined && at - last <= SAME_MOMENT) {
      if (marks.at(-1) !== mark) marks[marks.length - 1] = KEY_MIXED;
    } else {
      seconds.push(at);
      marks.push(mark);
    }
  }
  return { seconds: Float64Array.from(seconds), marks: Uint8Array.from(marks) };
}

/** Clips that do not change keep their identity, so a list of them costs nothing in the next frame. */
export function summaryOf(clip: ClipState, paths: readonly string[]): KeyTable {
  let byClip = summaries.get(paths);
  if (!byClip) summaries.set(paths, (byClip = new WeakMap()));
  const known = byClip.get(clip);
  if (known) return known;
  const summary = buildSummary(clip, paths);
  byClip.set(clip, summary);
  return summary;
}

/** How far a curve goes from top to bottom, also where an easing overshoots. */
export interface CurveRange {
  readonly min: number;
  readonly max: number;
}

const ranges = new WeakMap<Animation, CurveRange>();

/** What an easing can reach between two keys, on a few points of the way. */
function rangeBetween(from: Key, to: Key, range: { min: number; max: number }): void {
  if (from.interp !== "bezier" || !from.out) return;
  const start = from.value as number;
  const change = (to.value as number) - start;
  const [x1, y1] = from.out;
  const [x2, y2] = to.in ?? [1, 1];
  for (let step = 1; step < 8; step += 1) {
    const value = start + change * bezierProgress(x1, y1, x2, y2, step / 8);
    range.min = Math.min(range.min, value);
    range.max = Math.max(range.max, value);
  }
}

/** The range of numbers keys cover. Undefined when they are not numbers. */
export function curveRangeOf(animation: Animation): CurveRange | undefined {
  const known = ranges.get(animation);
  if (known) return known;
  const { keys } = animation;
  if (!keys.every(({ value }) => typeof value === "number")) return undefined;
  const range = { min: Number.POSITIVE_INFINITY, max: Number.NEGATIVE_INFINITY };
  keys.forEach((key, index) => {
    range.min = Math.min(range.min, key.value as number);
    range.max = Math.max(range.max, key.value as number);
    const next = keys[index + 1];
    if (next) rangeBetween(key, next, range);
  });
  ranges.set(animation, range);
  return range;
}
