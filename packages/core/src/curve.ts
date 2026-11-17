import {
  COLOR_PATTERN,
  EASE_PRESET_NAMES,
  STEP_PRESETS,
  VECTOR_LENGTHS,
  isAnimation,
  type ValueType,
} from "@animaquill/schema/properties";
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
const SPRING = 3;
const PRESET = 4;

/** What `shapes` of a channel hold, for drawing a curve the way it is worked out. */
export const SHAPE = {
  linear: LINEAR,
  hold: HOLD,
  bezier: BEZIER,
  spring: SPRING,
  preset: PRESET,
} as const;

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
  /**
   * Four numbers for every key but the last, as soon as one of them is a bezier, a spring or a
   * preset: the handles x1, y1, x2, y2 of a bezier; ω0 and ζ of a spring; for a preset its place in
   * `EASE_PRESET_NAMES`, then amplitude, period and steps.
   */
  readonly params: Float64Array;
  readonly before: Extrapolation;
  readonly after: Extrapolation;
  /** Shaking on top, three numbers each: amount, frequency and seed. Empty for none. */
  readonly noise: Float64Array;
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

type Rgba = readonly [red: number, green: number, blue: number, alpha: number];

/** A color as shares of 0 to 1, as it is written: in sRGB. */
function rgbaOf(color: string): Rgba {
  const part = (at: number) => Number.parseInt(color.slice(at, at + 2), 16) / 255;
  return [part(1), part(3), part(5), color.length === 9 ? part(7) : 1];
}

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toGamma = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);

/** Oklab, by Björn Ottosson: a straight line in it looks like an even change of color. */
function oklabOf([red, green, blue]: Rgba): readonly [number, number, number] {
  const [r, g, b] = [toLinear(red), toLinear(green), toLinear(blue)];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function rgbOf([lightness, a, b]: readonly [number, number, number]): readonly number[] {
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map(toGamma);
}

const byte = (share: number) =>
  Math.round(Math.min(Math.max(share, 0), 1) * 255)
    .toString(16)
    .padStart(2, "0");

/**
 * Part of the way from one color to another, in Oklab, with what shows through weighed the way CSS
 * does it: a color that cannot be seen lends its neighbour nothing but how much shows. Comes out as
 * `#rrggbb` when nothing shows through.
 */
export function mixColors(from: string, to: string, progress: number): string {
  if (progress <= 0) return from;
  if (progress >= 1) return to;
  const a = rgbaOf(from);
  const b = rgbaOf(to);
  const alpha = a[3] + (b[3] - a[3]) * progress;
  if (alpha <= 0) return "#00000000";
  const labA = oklabOf(a);
  const labB = oklabOf(b);
  const lab = labA.map((value, index) => {
    const weighedA = value * a[3];
    const weighedB = (labB[index] as number) * b[3];
    return (weighedA + (weighedB - weighedA) * progress) / alpha;
  }) as unknown as readonly [number, number, number];
  const rgb = rgbOf(lab).map(byte).join("");
  const shown = byte(alpha);
  return shown === "ff" ? `#${rgb}` : `#${rgb}${shown}`;
}

const isColor = (value: Value): value is string =>
  typeof value === "string" && COLOR_PATTERN.test(value);

const COLOR: TypeRule = {
  accepts: isColor,
  mix: (from, to, progress) => mixColors(from as string, to as string, progress),
};

const isNumberList = (value: Value): value is number[] =>
  Array.isArray(value) && value.every((part) => typeof part === "number" && Number.isFinite(part));

/** Each number on its own. Lists that are not as long as each other stay until the next key. */
function mixNumbers(from: Value, to: Value, progress: number): Value {
  const a = from as readonly number[];
  const b = to as readonly number[];
  if (a.length !== b.length) return from;
  return a.map((part, index) => part + ((b[index] as number) - part) * progress);
}

/** A vector has as many numbers as it says, all of them changing with one easing. */
const vector = (length: number | undefined): TypeRule => ({
  accepts: (value) => isNumberList(value) && (length === undefined || value.length === length),
  mix: mixNumbers,
});

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
  color: COLOR,
  vec2: vector(VECTOR_LENGTHS.vec2),
  vec3: vector(VECTOR_LENGTHS.vec3),
  vec4: vector(VECTOR_LENGTHS.vec4),
  numbers: vector(undefined),
};

/** Whether a stored value is one of a type. */
export const accepts = (type: ValueType, value: Value): boolean => VALUE_TYPES[type].accepts(value);

/** Whether values of a type are one number, which is what has a curve of its own. */
export const isNumeric = (type: ValueType): boolean => VALUE_TYPES[type].numeric === true;

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

/** Where a preset is in `EASE_PRESET_NAMES`, or -1 for a name this editor does not know. */
const presetIndexOf = (name: string | undefined): number =>
  name === undefined ? -1 : (EASE_PRESET_NAMES as readonly string[]).indexOf(name);

/** Whether a preset of a key can be worked out: a name of the table, with what it needs. */
export function knowsPreset(key: Pick<Key, "preset" | "presetParams">): boolean {
  if (presetIndexOf(key.preset) < 0) return false;
  const steps = key.presetParams?.steps;
  return (
    !STEP_PRESETS.has(key.preset as string) || (Number.isInteger(steps) && (steps as number) > 0)
  );
}

const isSpring = (spring: Key["spring"]): spring is NonNullable<Key["spring"]> =>
  spring !== undefined &&
  spring.stiffness > 0 &&
  Number.isFinite(spring.stiffness) &&
  spring.damping >= 0 &&
  Number.isFinite(spring.damping) &&
  (spring.mass === undefined || (spring.mass > 0 && Number.isFinite(spring.mass)));

/** A spring or a preset that cannot be worked out goes linearly, as the format says. */
function shapeOf(key: Key, mixes: boolean): number {
  if (!mixes || key.interp === "hold") return HOLD;
  if (key.interp === "bezier" && key.out) return BEZIER;
  if (key.interp === "spring" && isSpring(key.spring)) return SPRING;
  if (key.interp === "preset" && knowsPreset(key)) return PRESET;
  return LINEAR;
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
const NO_PARAMS = new Float64Array(0);
const NO_NOISE = new Float64Array(0);

/** What a preset takes when it does not say: see the project format. */
const AMPLITUDE = 1;
const PERIOD = 0.3;

/** The numbers of each stretch that has any, see `CurveChannel.params`. */
function paramsOf(keys: readonly Key[], shapes: Uint8Array): Float64Array {
  if (shapes.every((shape) => shape === LINEAR || shape === HOLD)) return NO_PARAMS;
  const params = new Float64Array(shapes.length * 4);
  shapes.forEach((shape, index) => {
    const key = keys[index] as Key;
    if (shape === BEZIER) {
      const [x1 = 0, y1 = 0] = key.out ?? [];
      const [x2 = 1, y2 = 1] = (keys[index + 1] as Key).in ?? [];
      params.set([x1, y1, x2, y2], index * 4);
    } else if (shape === SPRING) {
      const { stiffness, damping, mass = 1 } = key.spring as NonNullable<Key["spring"]>;
      params.set(
        [Math.sqrt(stiffness / mass), damping / (2 * Math.sqrt(stiffness * mass)), 0, 0],
        index * 4,
      );
    } else if (shape === PRESET) {
      const { amplitude = AMPLITUDE, period = PERIOD, steps = 1 } = key.presetParams ?? {};
      params.set([presetIndexOf(key.preset), amplitude, period, steps], index * 4);
    }
  });
  return params;
}

/** Types whose values are numbers that shaking can add to, one each. */
const SHAKES: ReadonlySet<ValueType> = new Set<ValueType>([
  "number",
  "angle",
  "vec2",
  "vec3",
  "vec4",
  "numbers",
]);

/** Whether shaking (`noise`) does something to values of a type. */
export const canShake = (type: ValueType): boolean => SHAKES.has(type);

function noiseOf(value: Animation, type: ValueType): Float64Array {
  const noises = (value.modifiers ?? []).filter(
    (modifier) =>
      modifier.type === "noise" &&
      Number.isFinite(modifier.amount) &&
      Number.isInteger(modifier.seed) &&
      (modifier.frequency === undefined ||
        (modifier.frequency > 0 && Number.isFinite(modifier.frequency))),
  );
  if (noises.length === 0 || !canShake(type)) return NO_NOISE;
  return Float64Array.from(
    noises.flatMap(({ amount, frequency = 1, seed }) => [amount, frequency, seed]),
  );
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
  const noise = noiseOf(value, type);
  if (keys.length === 1 && noise.length === 0) return { kind: "still", value: first.value };
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
    params: paramsOf(keys, shapes),
    before: extrapolationOf(value.before, times, numeric),
    after: extrapolationOf(value.after, times, numeric),
    noise,
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

const handlesAt = (params: Float64Array, index: number): Handles => [
  params[index * 4] as number,
  params[index * 4 + 1] as number,
  params[index * 4 + 2] as number,
  params[index * 4 + 3] as number,
];

const TAU = 2 * Math.PI;

/** Penner's elastic easing out, with ends that are exactly 0 and 1. */
function elasticOut(s: number, amplitude: number, period: number): number {
  if (s <= 0) return 0;
  if (s >= 1) return 1;
  const shift = (period / TAU) * Math.asin(1 / amplitude);
  return 1 + amplitude * 2 ** (-10 * s) * Math.sin(((s - shift) * TAU) / period);
}

const elasticIn = (s: number, amplitude: number, period: number) =>
  1 - elasticOut(1 - s, amplitude, period);

const BOUNCE = 7.5625;
const BOUNCE_WIDTH = 2.75;

/** Penner's bounce out: four parabolas, with ends that are exactly 0 and 1. */
function bounceOut(s: number): number {
  if (s <= 0) return 0;
  if (s >= 1) return 1;
  if (s < 1 / BOUNCE_WIDTH) return BOUNCE * s * s;
  if (s < 2 / BOUNCE_WIDTH) {
    const u = s - 1.5 / BOUNCE_WIDTH;
    return BOUNCE * u * u + 0.75;
  }
  if (s < 2.5 / BOUNCE_WIDTH) {
    const u = s - 2.25 / BOUNCE_WIDTH;
    return BOUNCE * u * u + 0.9375;
  }
  const u = s - 2.625 / BOUNCE_WIDTH;
  return BOUNCE * u * u + 0.984375;
}

const bounceIn = (s: number) => 1 - bounceOut(1 - s);

/** How far along a preset of the project format is when a share `s` of its stretch has passed. */
export function presetProgress(
  preset: number,
  amplitude: number,
  period: number,
  steps: number,
  s: number,
): number {
  if (s <= 0) return 0;
  if (s >= 1) return 1;
  const a = Math.max(amplitude, 1);
  switch (EASE_PRESET_NAMES[preset]) {
    case "elasticOut":
      return elasticOut(s, a, period);
    case "elasticIn":
      return elasticIn(s, a, period);
    case "elasticInOut":
      return s < 0.5 ? elasticIn(2 * s, a, period) / 2 : 0.5 + elasticOut(2 * s - 1, a, period) / 2;
    case "bounceOut":
      return bounceOut(s);
    case "bounceIn":
      return bounceIn(s);
    case "bounceInOut":
      return s < 0.5 ? bounceIn(2 * s) / 2 : 0.5 + bounceOut(2 * s - 1) / 2;
    case "stepsEnd":
      return Math.floor(s * steps + TOLERANCE) / steps;
    case "stepsStart":
      return Math.min(1, (Math.floor(s * steps + TOLERANCE) + 1) / steps);
    default:
      return s;
  }
}

/**
 * How far along a damped spring that starts at rest is, `seconds` after it lets go, from 0 towards
 * 1: `omega` is ω0 = √(stiffness / mass), `zeta` is ζ = damping / (2 √(stiffness · mass)).
 */
export function springProgress(omega: number, zeta: number, seconds: number): number {
  if (seconds <= 0) return 0;
  if (zeta < 1) {
    const damped = omega * Math.sqrt(1 - zeta * zeta);
    return (
      1 -
      Math.exp(-zeta * omega * seconds) *
        (Math.cos(damped * seconds) + ((zeta * omega) / damped) * Math.sin(damped * seconds))
    );
  }
  if (zeta === 1) return 1 - Math.exp(-omega * seconds) * (1 + omega * seconds);
  const spread = zeta + Math.sqrt(zeta * zeta - 1);
  const slow = -omega / spread;
  const fast = -omega * spread;
  return 1 - (fast * Math.exp(slow * seconds) - slow * Math.exp(fast * seconds)) / (fast - slow);
}

/**
 * How far from one key to the next a stretch of a channel is, `elapsed` seconds after its key, as
 * the progress that values mix by: 0 at its key, and past 0 or 1 where a curve overshoots.
 */
export function segmentProgress(channel: CurveChannel, index: number, elapsed: number): number {
  const { times, shapes, params } = channel;
  const shape = shapes[index];
  if (shape === undefined || shape === HOLD) return 0;
  if (shape === SPRING) {
    return springProgress(params[index * 4] as number, params[index * 4 + 1] as number, elapsed);
  }
  const length = (times[index + 1] as number) - (times[index] as number);
  const share = length > 0 ? clampToUnit(elapsed / length) : 0;
  if (shape === BEZIER) return bezierProgress(...handlesAt(params, index), share);
  if (shape === PRESET) {
    const at = index * 4;
    return presetProgress(
      params[at] as number,
      params[at + 1] as number,
      params[at + 2] as number,
      params[at + 3] as number,
      share,
    );
  }
  return share;
}

function within(channel: CurveChannel, clock: number): Value {
  const { times, values, shapes, type } = channel;
  const index = segmentAt(channel, clock);
  const from = values[index] as Value;
  const shape = shapes[index];
  if (shape === undefined || shape === HOLD) return from;
  const progress = segmentProgress(channel, index, clock - (times[index] as number));
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

/**
 * How fast a number changes in the segment at one end of the keys, in units per second. A spring
 * and a preset count as still there: they come to rest, or go in steps.
 */
function speedAtEnd(channel: CurveChannel, index: number, end: "start" | "end"): number {
  const { times, values, shapes, params } = channel;
  const shape = shapes[index];
  if (shape === undefined || shape === HOLD || shape === SPRING || shape === PRESET) return 0;
  const length = (times[index + 1] as number) - (times[index] as number);
  if (length <= 0) return 0;
  const speed = ((values[index + 1] as number) - (values[index] as number)) / length;
  if (shape !== BEZIER) return speed;
  const slope = end === "start" ? slopeAtStart : slopeAtEnd;
  return speed * slope(...handlesAt(params, index));
}

/** The value of the keys at a reading of the clock, before shaking. */
function keyedAt(channel: CurveChannel, clock: number): Value {
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

/** murmur3's finalizer: 32 bits in, 32 well mixed bits out, as an unsigned integer. */
function fmix32(input: number): number {
  let h = input;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** The slope of the noise at a whole number `k`, from −1 to 1. Both go to 32 bits first. */
const slopeAt = (seed: number, k: number) => fmix32(Math.imul(k, 0x9e3779b1) ^ seed) / 2 ** 31 - 1;

/**
 * One-dimensional gradient noise, as the project format defines it to the bit: from −1 to 1, 0 on
 * whole numbers, smooth everywhere, the same for the same seed anywhere.
 */
export function noiseAt(seed: number, x: number): number {
  const whole = Math.floor(x);
  const f = x - whole;
  const a = slopeAt(seed, whole) * f;
  const b = slopeAt(seed, whole + 1) * (f - 1);
  const fade = f * f * f * (f * (f * 6 - 15) + 10);
  return 2 * (a + (b - a) * fade);
}

/** How far the shaking of a channel moves a number of it (its `part`, 0 for a number) at a moment. */
export function shakeAt(noise: Float64Array, part: number, clock: number): number {
  let sum = 0;
  for (let at = 0; at < noise.length; at += 3) {
    const amount = noise[at] as number;
    const seed = (noise[at + 2] as number) + part;
    sum += amount * noiseAt(seed, clock * (noise[at + 1] as number));
  }
  return sum;
}

/** The value of a channel at a reading of its clock. */
export function sample(channel: Channel, clock: number): Value {
  if (channel.kind === "still") return channel.value;
  const value = keyedAt(channel, clock);
  const { noise } = channel;
  if (noise.length === 0) return value;
  if (typeof value === "number") return value + shakeAt(noise, 0, clock);
  if (!Array.isArray(value)) return value;
  return (value as readonly number[]).map((part, index) => part + shakeAt(noise, index, clock));
}

/** A number from a channel that may not be there. */
export function numberAt(channel: Channel | undefined, clock: number, fallback: number): number {
  if (!channel) return fallback;
  const value = sample(channel, clock);
  return typeof value === "number" ? value : fallback;
}
