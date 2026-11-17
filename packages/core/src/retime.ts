import {
  add,
  compare,
  divide,
  formatTime,
  multiply,
  parseTime,
  rational,
  subtract,
  type Animation,
  type Key,
  type Rational,
} from "@animaquill/schema";
import { fail } from "./draft.ts";

/** What `retimeKeys` takes, without whose property it is. */
export interface RetimeKeys {
  readonly times: readonly string[];
  readonly from: readonly [string, string];
  readonly to: readonly [string, string];
  readonly frames?: true | undefined;
}

/** The frames of the project on the clock of a clip: the clock is the timeline plus `shift`. */
export interface ClockFrames {
  /** Frames per second. */
  readonly rate: Rational;
  readonly shift: Rational;
}

export interface Retimed {
  readonly value: Animation;
  /** Keys that were not asked to move and gave way to one that landed on them, by their time. */
  readonly removed: readonly string[];
}

/** The fields that say how a key goes on to the next one. How it arrives (`in`) is apart. */
type Leaving = Pick<Key, "interp" | "out" | "spring" | "preset" | "presetParams">;

const DEFAULT_ARRIVAL: readonly [number, number] = [1, 1];

/**
 * Handles are floats, and `1 - (1 - x)` is not always `x` again. Up to twelve decimals it is, once
 * the result is rounded there, which is far finer than anything that shows; the editor writes six.
 */
const REVERSED_DIGITS = 12;

function flipped(value: number): number {
  const result = Number((1 - value).toFixed(REVERSED_DIGITS));
  return result === 0 ? 0 : result;
}

/** A bezier handle of a stretch played backwards: from the other end, the other way up. */
const flippedHandle = ([x, y]: readonly [number, number]): [number, number] => [
  flipped(x),
  flipped(y),
];

const isDefaultArrival = ([x, y]: readonly [number, number]) =>
  x === DEFAULT_ARRIVAL[0] && y === DEFAULT_ARRIVAL[1];

/** Names that say which end they ease, and the name for the other end. */
const OTHER_END: Readonly<Record<string, string>> = {
  elasticIn: "elasticOut",
  elasticOut: "elasticIn",
  bounceIn: "bounceOut",
  bounceOut: "bounceIn",
  stepsStart: "stepsEnd",
  stepsEnd: "stepsStart",
};

/** The preset that plays a preset backwards: the same one for what eases both ends alike. */
export const reversedPreset = (name: string): string => OTHER_END[name] ?? name;

function leavingOf(key: Key): Leaving {
  const { interp, out, spring, preset, presetParams } = key;
  return {
    ...(interp !== undefined && { interp }),
    ...(out !== undefined && { out }),
    ...(spring !== undefined && { spring }),
    ...(preset !== undefined && { preset }),
    ...(presetParams !== undefined && { presetParams }),
  };
}

/** A key with another way of going on and of arriving, all else as it is. */
function withEnds(key: Key, leaving: Leaving, arrival: Key["in"]): Key {
  const {
    interp: _interp,
    out: _out,
    spring: _spring,
    preset: _preset,
    presetParams: _presetParams,
    in: _in,
    ...rest
  } = key;
  return { ...rest, ...(arrival !== undefined && { in: arrival }), ...leaving };
}

/**
 * A stretch from A to B played from B to A. The easing belongs to the key that a stretch leaves, so
 * it goes from A to B, and what B arrived with goes to A. A bezier becomes its reverse, which plays
 * back exactly; a preset swaps its ends. Linear stays. Holding still holds, until the key it goes to,
 * and a spring keeps what it is: it cannot be played backwards, only start again from the other end.
 * What a key does not use stays as it is, so that reversing twice gives back what was there.
 */
function reversedStretch(
  leaving: Leaving,
  arrival: Key["in"],
): { readonly leaving: Leaving; readonly arrival: Key["in"] } {
  if (leaving.interp === "bezier" && leaving.out) {
    const back = flippedHandle(leaving.out);
    return {
      leaving: { interp: "bezier", out: flippedHandle(arrival ?? DEFAULT_ARRIVAL) },
      arrival: isDefaultArrival(back) ? undefined : back,
    };
  }
  if (leaving.interp === "preset" && leaving.preset !== undefined) {
    return { leaving: { ...leaving, preset: reversedPreset(leaving.preset) }, arrival };
  }
  return { leaving, arrival };
}

/** Rounds to the nearest whole number, halves up, exactly. */
function nearestWhole({ n, d }: Rational): bigint {
  const twice = 2n * n + d;
  const denominator = 2n * d;
  const whole = twice / denominator;
  return twice < 0n && twice % denominator !== 0n ? whole - 1n : whole;
}

/** The nearest frame of the project to a reading of the clock of a clip. */
function onFrame(moment: Rational, { rate, shift }: ClockFrames): Rational {
  const frame = nearestWhole(multiply(subtract(moment, shift), rate));
  return add(divide(rational(frame), rate), shift);
}

const timeOf = (key: Key) => parseTime(key.time);

/** Where `[a, b]` going to `[c, d]` takes a moment. */
export function retimedMoment(
  moment: Rational,
  [a, b]: readonly [Rational, Rational],
  [c, d]: readonly [Rational, Rational],
): Rational {
  return add(c, divide(multiply(subtract(moment, a), subtract(d, c)), subtract(b, a)));
}

/** Where a key at a moment goes: mapped, and then onto the nearest frame when there are frames. */
export function retimedTime(
  moment: Rational,
  from: readonly [Rational, Rational],
  to: readonly [Rational, Rational],
  frames?: ClockFrames,
): Rational {
  const exact = retimedMoment(moment, from, to);
  return frames ? onFrame(exact, frames) : exact;
}

/**
 * Stretches, squeezes, moves or reverses keys in time: `from` goes to `to`, and everything in
 * between along with it, exactly. With `frames` each one then goes to the nearest frame of the
 * project. Values stay. Two of them landing on one moment is refused; another key where one lands
 * gives way to it, and is in `removed`. When the order turns around, the easing turns with it (see
 * `reversedStretch`), and when all keys of a property turn around, so do `before` and `after`.
 * Shaking goes by the clock of the clip and belongs to no key, so it stays as it is.
 */
export function retimeKeys(
  animation: Animation | undefined,
  { times, from, to, frames }: RetimeKeys,
  path: string,
  clockFrames: ClockFrames | undefined,
): Retimed {
  const keys = animation?.keys ?? [];
  const [a, b] = [parseTime(from[0]), parseTime(from[1])];
  const [c, d] = [parseTime(to[0]), parseTime(to[1])];
  if (compare(a, b) === 0 || compare(c, d) === 0)
    fail("invalid-value", { rule: "retime-span", path });
  if (frames && !clockFrames) throw new Error("retimeKeys on frames needs the frames of the clip");
  const chosen = new Set<number>();
  for (const time of times) {
    const index = indexOf(keys, time);
    if (chosen.has(index)) fail("invalid-value", { rule: "key-moved-twice", time });
    chosen.add(index);
  }
  const indices = [...chosen].toSorted((x, y) => x - y);
  const moved = indices.map((index) => {
    const key = keys[index] as Key;
    const moment = retimedTime(timeOf(key), [a, b], [c, d], frames ? clockFrames : undefined);
    // A key that stays where it is keeps how its time is written.
    return compare(moment, timeOf(key)) === 0 ? key : { ...key, time: formatTime(moment) };
  });
  const reversed = compare(b, a) > 0 !== compare(d, c) > 0;
  const eased = reversed ? reversedEases(moved) : moved;
  const landed = eased
    .map((key) => ({ key, moment: timeOf(key) }))
    .toSorted((x, y) => compare(x.moment, y.moment));
  for (let index = 1; index < landed.length; index += 1) {
    const { key, moment } = landed[index] as (typeof landed)[number];
    if (compare(moment, (landed[index - 1] as (typeof landed)[number]).moment) === 0) {
      fail("invalid-value", { rule: "keys-collide", path, time: key.time });
    }
  }
  const staying = keys.filter((_key, index) => !chosen.has(index));
  const removed: string[] = [];
  const result: Key[] = [];
  let next = 0;
  for (const { key, moment } of landed) {
    while (next < staying.length && compare(timeOf(staying[next] as Key), moment) < 0) {
      result.push(staying[next] as Key);
      next += 1;
    }
    const there = staying[next];
    if (there && compare(timeOf(there), moment) === 0) {
      removed.push(there.time);
      next += 1;
    }
    result.push(key);
  }
  for (; next < staying.length; next += 1) result.push(staying[next] as Key);
  const all = animation ?? { keys: [] };
  const turned = reversed && staying.length === 0 ? swappedEnds(all) : all;
  return { value: { ...turned, keys: result }, removed };
}

function indexOf(keys: readonly Key[], time: string): number {
  const moment = parseTime(time);
  let low = 0;
  let high = keys.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (compare(timeOf(keys[middle] as Key), moment) < 0) low = middle + 1;
    else high = middle;
  }
  const key = keys[low];
  return key && compare(timeOf(key), moment) === 0
    ? low
    : fail("not-found", { kind: "key", id: time });
}

/**
 * The easing of keys whose order turned around, given in their old order. Each stretch between two
 * of them that follow each other goes the other way. The first of them ends up last, and goes on as
 * the last one did; the last one arrives as the first one did. So reversing twice changes nothing.
 * Keys in between that do not move do not count: what goes on to one of them is a guess either way.
 */
function reversedEases(keys: readonly Key[]): readonly Key[] {
  const count = keys.length;
  if (count < 2) return keys;
  const leaving: Leaving[] = keys.map(leavingOf);
  const arriving: Key["in"][] = keys.map((key) => key.in);
  const result = keys.map((key) => ({ key, leaving: leavingOf(key), arrival: key.in }));
  for (let index = 1; index < count; index += 1) {
    const back = reversedStretch(leaving[index - 1] as Leaving, arriving[index]);
    (result[index] as (typeof result)[number]).leaving = back.leaving;
    (result[index - 1] as (typeof result)[number]).arrival = back.arrival;
  }
  (result[0] as (typeof result)[number]).leaving = leaving[count - 1] as Leaving;
  (result[count - 1] as (typeof result)[number]).arrival = arriving[0];
  return result.map(({ key, leaving: goes, arrival }) => withEnds(key, goes, arrival));
}

/** What happens before the first key happens after the last one now, and the other way round. */
function swappedEnds(animation: Animation): Animation {
  const { before, after, ...rest } = animation;
  return {
    ...rest,
    ...(after !== undefined && { before: after }),
    ...(before !== undefined && { after: before }),
  };
}
