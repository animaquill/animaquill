import { isAnimation, type ValueType } from "@animaquill/schema/properties";
import { TIME_PATTERN, parseTime, toSeconds } from "@animaquill/schema/time";
import type { Animation, Key, PropertyValue, Value } from "@animaquill/schema";

/**
 * How values change over time. A curve is worked out where it is needed, in the compositor, a scene
 * or the editor page, instead of being sent to them frame by frame, so this file has to be cheap to
 * load there: nothing here may bring in Yjs or Zod. The rules are part of the project format.
 */

/** A moment that lands on a frame can come out a little off, which must not cost a frame. */
const TOLERANCE = 1e-9;

type Extrapolation = NonNullable<Animation["before"]>;

/** How one key gets to the next. */
const LINEAR = 0;
const HOLD = 1;
const BEZIER = 2;

/** A property that stays the same. */
export interface StillChannel {
  readonly kind: "still";
  readonly value: Value;
}

/**
 * A property with keys, prepared to be read many times. Everything in it is plain data, because it
 * goes to the sandboxes as it is.
 */
export interface CurveChannel {
  readonly kind: "curve";
  readonly type: ValueType;
  /** Seconds on the clock of the clip, in order. */
  readonly times: Float64Array;
  readonly values: Float64Array | readonly Value[];
  /** How each key gets to the next one. */
  readonly shapes: Uint8Array;
  /** Four numbers for every key but the last, as soon as one of them is a bezier. */
  readonly handles: Float64Array;
  readonly before: Extrapolation;
  readonly after: Extrapolation;
  /** Where the clock was last, since playing moves on to the next key at most. Only saves time. */
  segment: number;
}

export type Channel = StillChannel | CurveChannel;

/** The channels of something, by property path. */
export type Channels = Readonly<Record<string, Channel>>;

interface TypeRule {
  /** Whether a stored value is one of these. */
  readonly accepts: (value: Value) => boolean;
  /** Part of the way from one value to another. Without it a value stays until the next key. */
  readonly mix?: (from: Value, to: Value, progress: number) => Value;
  /** Stored as a list of floats. */
  readonly numeric?: boolean;
}

const NUMBER: TypeRule = {
  accepts: (value) => typeof value === "number" && Number.isFinite(value),
  mix: (from, to, progress) => (from as number) + ((to as number) - (from as number)) * progress,
  numeric: true,
};

const isObject = (value: Value) => typeof value === "object" && !Array.isArray(value);

/**
 * What every kind of value does. Easing does not depend on the type: progress from 0 to 1 is worked
 * out first, and only `mix` knows what it means, so a new type is a new line here.
 */
export const VALUE_TYPES: Readonly<Record<ValueType, TypeRule>> = {
  number: NUMBER,
  /** Straight, not the short way around, so that a key can turn something twice. */
  angle: NUMBER,
  boolean: { accepts: (value) => typeof value === "boolean" },
  choice: { accepts: (value) => typeof value === "string" },
  text: { accepts: (value) => typeof value === "string" || isObject(value) },
  asset: { accepts: isObject },
};

export const clampToUnit = (value: number): number => Math.min(Math.max(value, 0), 1);

/** As in CSS: x1, y1, x2, y2. */
type Handles = readonly [number, number, number, number];

/**
 * How far along a CSS `cubic-bezier` is when a share of the time has passed. Handles stay within 0
 * and 1 in x, so there is one answer. Newton finds it in a few steps, unless the curve is flat right
 * there. Halving always finds it.
 */
export function bezierProgress(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  time: number,
): number {
  if (time <= 0) return 0;
  if (time >= 1) return 1;
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const xAt = (s: number) => ((ax * s + bx) * s + cx) * s;
  const yAt = (s: number) => ((ay * s + by) * s + cy) * s;

  let s = time;
  for (let step = 0; step < 8; step += 1) {
    const miss = xAt(s) - time;
    if (Math.abs(miss) < 1e-10) return yAt(s);
    const slope = (3 * ax * s + 2 * bx) * s + cx;
    if (Math.abs(slope) < 1e-7) break;
    s -= miss / slope;
    if (s < 0 || s > 1) break;
  }
  let low = 0;
  let high = 1;
  s = time;
  for (let step = 0; step < 40; step += 1) {
    if (xAt(s) < time) low = s;
    else high = s;
    s = (low + high) / 2;
  }
  return yAt(s);
}

/**
 * How steep a bezier leaves its start, in progress per share of time. A handle can sit right on the
 * point, and then the other one decides. Straight up has no number to go on with, so it counts as
 * flat, which is what browsers do too.
 */
function slopeAtStart(x1: number, y1: number, x2: number, y2: number): number {
  if (x1 > 0) return y1 / x1;
  if (y1 === 0 && x2 > 0) return y2 / x2;
  return y1 === 0 && y2 === 0 ? 1 : 0;
}

function slopeAtEnd(x1: number, y1: number, x2: number, y2: number): number {
  if (x2 < 1) return (y2 - 1) / (x2 - 1);
  if (y2 === 1 && x1 < 1) return (y1 - 1) / (x1 - 1);
  return y2 === 1 && y1 === 1 ? 1 : 0;
}

/** Decimals are the common case, and thousands of keys go through here at once. */
function secondsOf(time: string): number {
  if (!TIME_PATTERN.test(time)) return Number.NaN;
  return time.includes("/") ? toSeconds(parseTime(time)) : Number(time);
}

function shapeOf(key: Key, mixes: boolean): number {
  if (!mixes || key.interp === "hold") return HOLD;
  return key.interp === "bezier" && key.out ? BEZIER : LINEAR;
}

/** Keys are checked when they get written. These are the things that would break the search. */
function timesOf(keys: readonly Key[]): Float64Array | undefined {
  const times = new Float64Array(keys.length);
  let last = Number.NEGATIVE_INFINITY;
  for (const [index, key] of keys.entries()) {
    const time = secondsOf(key.time);
    if (!(time >= last)) return undefined;
    times[index] = time;
    last = time;
  }
  return times;
}

/** Shared, because a copy for a sandbox has to go through every array it finds. */
const NO_HANDLES = new Float64Array(0);

function handlesOf(keys: readonly Key[], shapes: Uint8Array): Float64Array {
  if (!shapes.includes(BEZIER)) return NO_HANDLES;
  const handles = new Float64Array(shapes.length * 4);
  shapes.forEach((shape, index) => {
    if (shape !== BEZIER) return;
    const [x1 = 0, y1 = 0] = (keys[index] as Key).out ?? [];
    const [x2 = 1, y2 = 1] = (keys[index + 1] as Key).in ?? [];
    handles.set([x1, y1, x2, y2], index * 4);
  });
  return handles;
}

/** Going around needs something to go around, and going on needs numbers. */
function extrapolationOf(
  mode: Extrapolation | undefined,
  times: Float64Array,
  numeric: boolean,
): Extrapolation {
  const period = (times.at(-1) as number) - (times[0] as number);
  if (mode === undefined || (mode === "continue" && !numeric)) return "hold";
  return period > 0 ? mode : "hold";
}

/**
 * Prepares a property to be read. Undefined when it has no value, and when the value is not of this
 * type: such a property does nothing, and stays in the project as it is.
 */
export function compileChannel(
  value: PropertyValue | undefined,
  type: ValueType,
): Channel | undefined {
  if (value === undefined) return undefined;
  const rule = VALUE_TYPES[type];
  if (!isAnimation(value)) return rule.accepts(value) ? { kind: "still", value } : undefined;
  const { keys } = value;
  const [first] = keys;
  if (!first || !keys.every((key) => rule.accepts(key.value))) return undefined;
  if (keys.length === 1) return { kind: "still", value: first.value };
  const times = timesOf(keys);
  if (!times) return undefined;
  const numeric = rule.numeric === true;
  const shapes = Uint8Array.from(keys.slice(0, -1), (key) => shapeOf(key, rule.mix !== undefined));
  return {
    kind: "curve",
    type,
    times,
    values: numeric
      ? Float64Array.from(keys, (key) => key.value as number)
      : keys.map((key) => key.value),
    shapes,
    handles: handlesOf(keys, shapes),
    before: extrapolationOf(value.before, times, numeric),
    after: extrapolationOf(value.after, times, numeric),
    segment: 0,
  };
}

/** The last key at or before a moment. The clock has to be within the keys. */
function segmentAt(channel: CurveChannel, clock: number): number {
  const { times, segment } = channel;
  const moment = clock + TOLERANCE;
  const last = times.length - 1;
  const isIn = (index: number) =>
    (times[index] as number) <= moment && (index === last || moment < (times[index + 1] as number));
  if (isIn(segment)) return segment;
  if (segment < last && isIn(segment + 1)) {
    channel.segment = segment + 1;
    return segment + 1;
  }
  let low = 0;
  let high = last;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if ((times[middle] as number) <= moment) low = middle;
    else high = middle - 1;
  }
  channel.segment = low;
  return low;
}

const handlesAt = (handles: Float64Array, index: number): Handles => [
  handles[index * 4] as number,
  handles[index * 4 + 1] as number,
  handles[index * 4 + 2] as number,
  handles[index * 4 + 3] as number,
];

function within(channel: CurveChannel, clock: number): Value {
  const { times, values, shapes, handles, type } = channel;
  const index = segmentAt(channel, clock);
  const from = values[index] as Value;
  const shape = shapes[index];
  if (shape === undefined || shape === HOLD) return from;
  const start = times[index] as number;
  const length = (times[index + 1] as number) - start;
  const share = length > 0 ? clampToUnit((clock - start) / length) : 0;
  const progress = shape === BEZIER ? bezierProgress(...handlesAt(handles, index), share) : share;
  const { mix } = VALUE_TYPES[type];
  return mix ? mix(from, values[index + 1] as Value, progress) : from;
}

/** Where a time falls within a period, counting a moment right before its end as the next start. */
function phaseOf(elapsed: number, period: number): number {
  const phase = elapsed - Math.floor(elapsed / period) * period;
  return period - phase <= TOLERANCE ? 0 : phase;
}

/** The moment within the keys that stands for a moment outside of them. */
function wrapped(channel: CurveChannel, clock: number, mode: "loop" | "pingpong"): number {
  const first = channel.times[0] as number;
  const period = (channel.times.at(-1) as number) - first;
  if (mode === "loop") return first + phaseOf(clock - first, period);
  const phase = phaseOf(clock - first, period * 2);
  return first + (phase > period ? period * 2 - phase : phase);
}

/** How fast a number changes in the segment at one end of the keys, in units per second. */
function speedAtEnd(channel: CurveChannel, index: number, end: "start" | "end"): number {
  const { times, values, shapes, handles } = channel;
  const shape = shapes[index];
  if (shape === undefined || shape === HOLD) return 0;
  const length = (times[index + 1] as number) - (times[index] as number);
  if (length <= 0) return 0;
  const speed = ((values[index + 1] as number) - (values[index] as number)) / length;
  if (shape !== BEZIER) return speed;
  const slope = end === "start" ? slopeAtStart : slopeAtEnd;
  return speed * slope(...handlesAt(handles, index));
}

/** The value of a channel at a reading of its clock. */
export function sample(channel: Channel, clock: number): Value {
  if (channel.kind === "still") return channel.value;
  const { times, values, shapes, before, after } = channel;
  const lastIndex = times.length - 1;
  const first = times[0] as number;
  const last = times[lastIndex] as number;
  if (clock < first - TOLERANCE) {
    if (before === "hold") return values[0] as Value;
    if (before === "continue") {
      return (values[0] as number) + speedAtEnd(channel, 0, "start") * (clock - first);
    }
    return within(channel, wrapped(channel, clock, before));
  }
  if (clock > last + TOLERANCE) {
    if (after === "hold") return values[lastIndex] as Value;
    if (after === "continue") {
      const speed = speedAtEnd(channel, shapes.length - 1, "end");
      return (values[lastIndex] as number) + speed * (clock - last);
    }
    return within(channel, wrapped(channel, clock, after));
  }
  return within(channel, clock);
}

/** A number from a channel that may not be there. */
export function numberAt(channel: Channel | undefined, clock: number, fallback: number): number {
  if (!channel) return fallback;
  const value = sample(channel, clock);
  return typeof value === "number" ? value : fallback;
}
