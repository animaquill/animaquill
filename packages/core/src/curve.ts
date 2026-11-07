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
export type Handles = readonly [number, number, number, number];

/**
 * How far along the curve of a CSS `cubic-bezier` a share of the time is. Handles stay within 0 and 1
 * in x, so there is one answer. Newton finds it in a few steps, unless the curve is flat right there.
 * Halving always finds it.
 */
function parameterAt(x1: number, x2: number, time: number): number {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const xAt = (s: number) => ((ax * s + bx) * s + cx) * s;

  let s = time;
  for (let step = 0; step < 8; step += 1) {
    const miss = xAt(s) - time;
    if (Math.abs(miss) < 1e-10) return s;
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
  return s;
}

/** How far along a CSS `cubic-bezier` is when a share of the time has passed. */
export function bezierProgress(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  time: number,
): number {
  if (time <= 0) return 0;
  if (time >= 1) return 1;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const s = parameterAt(x1, x2, time);
  return ((ay * s + by) * s + cy) * s;
}

/** A key as a point: seconds on the clock of its clip, and a number. */
export interface KeyPoint {
  readonly time: number;
  readonly value: number;
}

/**
 * How far up and down a handle that a new key writes may reach, as a share of the change between its
 * keys. The usual easings stay within this, overshooting ones too. A handle that reaches further
 * turns any later change of a value into a swing that goes far past both keys.
 */
export const MIN_SPLIT_Y = -1;
export const MAX_SPLIT_Y = 2;
/** How close two curves have to be to count as one, in shares of time and of the change. */
const SAME_CURVE = 1e-9;

interface Point {
  readonly t: number;
  readonly v: number;
}

const lerp = (a: Point, b: Point, share: number): Point => ({
  t: a.t + (b.t - a.t) * share,
  v: a.v + (b.v - a.v) * share,
});

/** The parameter of a CSS `cubic-bezier` at a share of the time, as close as floats go. */
function preciseParameterAt(x1: number, x2: number, time: number): number {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const xAt = (s: number) => ((ax * s + bx) * s + cx) * s;
  let low = 0;
  let high = 1;
  for (let step = 0; step < 64 && high - low > Number.EPSILON; step += 1) {
    const middle = (low + high) / 2;
    if (xAt(middle) < time) low = middle;
    else high = middle;
  }
  return (low + high) / 2;
}

/** How far a short decimal can be from what a join works out, and still be what people wrote. */
const JOIN_REACH = 1e-9;
/** Handles as people write them have a few digits. What took more stays as it came out. */
const TIDY_DIGITS = 6;
/** What floats lose in a cut and a join, in shares of a stretch. */
const FLOAT_NOISE = 1e-11;

/**
 * The shortest decimal of a few digits within reach of a number, so that what went through a cut
 * and a join comes back as it was written: 0.42 and not 0.42000000000000004.
 */
function tidy(value: number): number {
  for (let digits = 0; digits <= TIDY_DIGITS; digits += 1) {
    const short = Number(value.toFixed(digits));
    if (Math.abs(short - value) <= JOIN_REACH) return short === 0 ? 0 : short;
  }
  return value;
}

/** A point that steers a curve, as a handle: in shares of the time and of the change of its stretch. */
function handleOf(
  at: Point,
  from: Point,
  length: number,
  change: number,
): readonly [number, number] {
  return [(at.t - from.t) / length, (at.v - from.v) / change];
}

/** Whether a stretch writes handles that a key can hold and that do not swing far. */
function fits([x1, y1, x2, y2]: Handles): boolean {
  const xs = x1 >= -SAME_CURVE && x1 <= 1 + SAME_CURVE && x2 >= -SAME_CURVE && x2 <= 1 + SAME_CURVE;
  const inReach = (y: number) => y >= MIN_SPLIT_Y - SAME_CURVE && y <= MAX_SPLIT_Y + SAME_CURVE;
  return xs && inReach(y1) && inReach(y2);
}

/** What a cut writes keeps all of its digits, so that a join can give back what was there. */
const written = ([x1, y1, x2, y2]: Handles): Handles => [clampToUnit(x1), y1, clampToUnit(x2), y2];

/** The points that steer a `cubic-bezier` from one key to the next, in seconds and values. */
function controlsOf(from: KeyPoint, to: KeyPoint, [x1, y1, x2, y2]: Handles): readonly Point[] {
  const length = to.time - from.time;
  const change = to.value - from.value;
  return [
    { t: from.time, v: from.value },
    { t: from.time + x1 * length, v: from.value + y1 * change },
    { t: from.time + x2 * length, v: from.value + y2 * change },
    { t: to.time, v: to.value },
  ];
}

/** Whether a change of value is too small to carry a shape, next to the numbers around it. */
const isFlat = (change: number, scale: number) => Math.abs(change) <= SAME_CURVE * scale;

/**
 * A key that goes in between two keys of a bezier, as the two beziers on either side of it. The
 * curve is cut where the key is, in seconds and values: what steers it from the keys that are
 * there stays where it was, and what steers it next to the new key goes along with the value of
 * that key. So a key with the value that was there leaves the curve as it was, and one with another
 * value bends it there. Undefined when that takes a handle a key cannot hold, or one that reaches
 * further than `MIN_SPLIT_Y` and `MAX_SPLIT_Y`: then the keys around it had better stay as they are.
 */
export function splitBezier(
  from: KeyPoint,
  to: KeyPoint,
  handles: Handles,
  at: KeyPoint,
): { readonly before: Handles; readonly after: Handles } | undefined {
  const length = to.time - from.time;
  const share = (at.time - from.time) / length;
  // What reaches that far already is left alone, so that whatever comes of it can be joined again.
  if (!(length > 0) || !(share > 0 && share < 1) || !fits(handles)) return undefined;
  const [p0, p1, p2, p3] = controlsOf(from, to, handles) as [Point, Point, Point, Point];
  const s = preciseParameterAt(handles[0], handles[2], share);
  const q1 = lerp(p0, p1, s);
  const q2 = lerp(p1, p2, s);
  const q3 = lerp(p2, p3, s);
  const r1 = lerp(q1, q2, s);
  const r2 = lerp(q2, q3, s);
  const shift = at.value - lerp(r1, r2, s).v;
  const middle: Point = { t: at.time, v: at.value };
  const scale = Math.max(...[p0, p1, p2, p3, middle].map(({ v }) => Math.abs(v)), 1);
  const before = at.value - from.value;
  const after = to.value - at.value;
  // A stretch that does not change has no shape to keep, and one that would not has none to take.
  const flat = [to.value - from.value, before, after].some((change) => isFlat(change, scale));
  if (flat) return undefined;
  const left: Handles = [
    ...handleOf(q1, p0, at.time - from.time, before),
    ...handleOf({ t: r1.t, v: r1.v + shift }, p0, at.time - from.time, before),
  ];
  const right: Handles = [
    ...handleOf({ t: r2.t, v: r2.v + shift }, middle, to.time - at.time, after),
    ...handleOf(q3, middle, to.time - at.time, after),
  ];
  if (!fits(left) || !fits(right)) return undefined;
  return { before: written(left), after: written(right) };
}

/**
 * Two beziers on either side of a key as one, for when that key goes: the curve it was cut from,
 * as far as it was cut from one, and as far as that reaches no further than a cut may. A key that
 * `splitBezier` put in comes out again without a trace, whatever value it went in with. Undefined
 * for anything else.
 */
export function joinBezier(
  from: KeyPoint,
  middle: KeyPoint,
  to: KeyPoint,
  before: Handles,
  after: Handles,
): Handles | undefined {
  const length = to.time - from.time;
  const change = to.value - from.value;
  const share = (middle.time - from.time) / length;
  if (!(length > 0) || !(share > 0 && share < 1)) return undefined;
  const scale = Math.max(Math.abs(from.value), Math.abs(middle.value), Math.abs(to.value), 1);
  if (isFlat(change, scale)) return undefined;
  const [p0, q1, r1] = controlsOf(from, middle, before) as [Point, Point, Point];
  const [, r2, q3, p3] = controlsOf(middle, to, after) as [Point, Point, Point, Point];
  // Where the key is along the line between the two handles next to it is how far along it was cut.
  if (!(r2.t - r1.t > SAME_CURVE * length)) return undefined;
  const s = (middle.time - r1.t) / (r2.t - r1.t);
  if (!(s > 0 && s < 1)) return undefined;
  const p1 = { t: p0.t + (q1.t - p0.t) / s, v: p0.v + (q1.v - p0.v) / s };
  const p2 = { t: p3.t + (q3.t - p3.t) / (1 - s), v: p3.v + (q3.v - p3.v) / (1 - s) };
  const joined: Handles = [
    (p1.t - p0.t) / length,
    (p1.v - p0.v) / change,
    (p2.t - p0.t) / length,
    (p2.v - p0.v) / change,
  ];
  const [x1, y1, x2, y2] = joined;
  // How far cutting a curve again lands from the two that are there. What was cut from it lands
  // right on them, so a few digits that do that are what people wrote, and all of them are not.
  const missOf = (handles: Handles) => {
    const again = fits(handles) ? splitBezier(from, to, handles, middle) : undefined;
    if (!again) return Number.POSITIVE_INFINITY;
    const sides = [...again.before, ...again.after];
    return Math.max(
      ...[...before, ...after].map((value, index) => Math.abs(value - (sides[index] as number))),
    );
  };
  const short = written([tidy(x1), tidy(y1), tidy(x2), tidy(y2)]);
  const whole = written(joined);
  const shortMiss = missOf(short);
  const wholeMiss = missOf(whole);
  // What floats lose on the way is far less than what tidying moves a number that needs its digits.
  const [handles, miss] =
    shortMiss <= wholeMiss + FLOAT_NOISE ? [short, shortMiss] : [whole, wholeMiss];
  return miss <= SAME_CURVE * 100 ? handles : undefined;
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
export function secondsOf(time: string): number {
  if (!TIME_PATTERN.test(time)) return Number.NaN;
  return time.includes("/") ? toSeconds(parseTime(time)) : Number(time);
}

function shapeOf(key: Key, mixes: boolean): number {
  if (!mixes || key.interp === "hold") return HOLD;
  return key.interp === "bezier" && key.out ? BEZIER : LINEAR;
}

/** Whether values of a type change gradually from one key to the next. */
export const canMix = (type: ValueType): boolean => VALUE_TYPES[type].mix !== undefined;

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
