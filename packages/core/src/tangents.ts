import { isAnimation, type Animation, type Key, type PropertyValue } from "@animaquill/schema";
import { MAX_SPLIT_Y, MIN_SPLIT_Y, secondsOf } from "./curve.ts";

/**
 * Handles that the editor works out by itself, for keys that say `tangent: "auto"`. A project
 * only stores what the handles are, and the curve only goes by that: `tangent` says how the editor
 * changes them. So whatever the editor does to keys, it works out the handles of automatic keys
 * again with this, from where the keys around them are.
 *
 * The curve goes smoothly through a key, and it never swings past the keys around it: a peak, a
 * valley and the first and last keys are flat, as Blender's "auto clamped" does.
 */

/** How far an automatic handle reaches into its stretch, as in After Effects and Blender. */
export const AUTO_REACH = 1 / 3;
/** Handles are numbers that people read in project files. */
const DIGITS = 6;

const tidy = (value: number): number => {
  const short = Number(value.toFixed(DIGITS));
  return short === 0 ? 0 : short;
};

const withinReach = (y: number) => Math.min(Math.max(y, MIN_SPLIT_Y), MAX_SPLIT_Y);

const same = (a: readonly number[] | undefined, b: readonly number[]) =>
  a?.[0] === b[0] && a?.[1] === b[1];

/**
 * How steep the curve is at a key, in units per second. Between a rise and a rise it is the slope
 * from one neighbour to the other, as far as that does not take the curve past either of them.
 */
function slopeAt(times: Float64Array, values: Float64Array, index: number): number {
  if (index === 0 || index === times.length - 1) return 0;
  const [before, at, after] = [index - 1, index, index + 1];
  const comingIn =
    ((values[at] as number) - (values[before] as number)) /
    ((times[at] as number) - (times[before] as number));
  const goingOn =
    ((values[after] as number) - (values[at] as number)) /
    ((times[after] as number) - (times[at] as number));
  // A peak, a valley, or a stretch that does not change: anything else would swing past it.
  if (!(comingIn * goingOn > 0)) return 0;
  const through =
    ((values[after] as number) - (values[before] as number)) /
    ((times[after] as number) - (times[before] as number));
  // With handles a third of the way in, three times the gentler slope ends right on a neighbour.
  const limit = 3 * Math.min(Math.abs(comingIn), Math.abs(goingOn));
  return Math.sign(through) * Math.min(Math.abs(through), limit);
}

/** Whether a property has keys whose handles the editor works out. */
export const hasAutoTangents = (value: PropertyValue | undefined): value is Animation =>
  value !== undefined && isAnimation(value) && value.keys.some((key) => key.tangent === "auto");

const isNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

/**
 * The numbers of the keys, one row per part: one row for a number, and one per part for a vector.
 * Undefined for anything else, and for vectors whose keys do not all have the same parts.
 */
function partsOf(keys: readonly Key[]): readonly Float64Array[] | undefined {
  if (keys.every(({ value }) => isNumber(value))) {
    return [Float64Array.from(keys, ({ value }) => value as number)];
  }
  const first = keys[0]?.value;
  if (!Array.isArray(first) || first.length === 0) return undefined;
  const width = first.length;
  const vectors = keys.every(
    ({ value }) => Array.isArray(value) && value.length === width && value.every(isNumber),
  );
  if (!vectors) return undefined;
  return Array.from({ length: width }, (_, part) =>
    Float64Array.from(keys, ({ value }) => (value as readonly number[])[part] as number),
  );
}

/**
 * Where the automatic handle on one side of a key goes, as a share of the change of its stretch.
 * The parts of a vector share their handles, so each part says where it wants it, the way a number
 * would, and the handle goes to the average of that, weighed by how far each part goes in the
 * stretch. A part that does not change there gets no say, as it stays flat with any handle. A part
 * that changes the most has the most say: that is what people see moving. All parts in their own
 * units would make a part that moves little as important as one that moves a lot. One part, or
 * parts that all go the same way, come out exactly as a number. A peak or a valley in every part is
 * flat, and where parts disagree the handle ends up in between.
 */
function autoShare(
  times: Float64Array,
  parts: readonly Float64Array[],
  slopes: readonly number[],
  index: number,
  side: "in" | "out",
): number {
  const from = side === "out" ? index : index - 1;
  const length = (times[from + 1] as number) - (times[from] as number);
  let weighed = 0;
  let weights = 0;
  parts.forEach((values, part) => {
    const change = (values[from + 1] as number) - (values[from] as number);
    if (change === 0) return;
    const reach = ((slopes[part] as number) * length * AUTO_REACH) / change;
    const share = withinReach(side === "out" ? reach : 1 - reach);
    weighed += Math.abs(change) * share;
    weights += Math.abs(change);
  });
  if (weights === 0) return side === "out" ? 0 : 1;
  return withinReach(weighed / weights);
}

/**
 * The keys with the handles of automatic keys worked out, on the sides that are beziers: a key
 * that leaves as a straight line or holds keeps doing that. The same object when nothing changes,
 * which is also what comes of values that are neither numbers nor vectors, or of keys out of order.
 */
export function withAutoTangents(animation: Animation): Animation {
  const { keys } = animation;
  if (!keys.some((key) => key.tangent === "auto")) return animation;
  const times = Float64Array.from(keys, ({ time }) => secondsOf(time));
  const parts = partsOf(keys);
  const ordered = times.every((time, index) => index === 0 || time > (times[index - 1] as number));
  if (!parts || !ordered) return animation;
  let changed: Key[] | undefined;
  keys.forEach((key, index) => {
    if (key.tangent !== "auto") return;
    const slopes = parts.map((values) => slopeAt(times, values, index));
    let next = key;
    if (index < keys.length - 1 && key.interp === "bezier") {
      const y = autoShare(times, parts, slopes, index, "out");
      const out = [tidy(AUTO_REACH), tidy(y)] as [number, number];
      if (!same(key.out, out)) next = { ...next, out };
    }
    const before = keys[index - 1];
    if (before?.interp === "bezier") {
      const y = autoShare(times, parts, slopes, index, "in");
      const arrival = [tidy(1 - AUTO_REACH), tidy(y)] as [number, number];
      if (!same(key.in, arrival)) next = { ...next, in: arrival };
    }
    if (next !== key) (changed ??= [...keys])[index] = next;
  });
  return changed ? { ...animation, keys: changed } : animation;
}
