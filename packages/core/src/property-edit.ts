import {
  Handle,
  Id,
  Key,
  PropertyPath,
  PropertyValue,
  Time,
  Value,
  compare,
  isAnimation,
  parseTime,
  toSeconds,
  type Animation,
  type Rational,
} from "@animaquill/schema";
import { z } from "zod";
import { joinBezier, splitBezier, type Handles, type KeyPoint } from "./curve.ts";
import { fail } from "./draft.ts";

/** Whose property it is. Tracks and effects get their own shape of this later. */
const Target = { owner: z.strictObject({ clip: Id }), path: PropertyPath };

/** How a key gets to the next one. A bezier says how it leaves, and how it arrives at the next. */
export const KeyEase = z.discriminatedUnion("interp", [
  z.strictObject({ interp: z.literal("linear") }),
  z.strictObject({ interp: z.literal("hold") }),
  z.strictObject({ interp: z.literal("bezier"), out: Handle, in: Handle.optional() }),
]);

export type KeyEase = z.output<typeof KeyEase>;

const KeyMove = z.strictObject({ from: Time, to: Time });

/**
 * One change to one property. Times are readings of the clock of the clip, like the keys themselves.
 *
 * - `write` is what a control does: with keys it writes a key at `time`, otherwise it changes the value.
 * - `setKey` writes a key, also on a property that had none.
 * - `removeKey` takes one away. The last one leaves its value behind.
 * - `moveKey` moves keys together, so that one can go where another one leaves. A key that stays where
 *   one lands goes. They take their easing along.
 * - `setInterp` says how keys get to the next one, which for a bezier also goes for how it arrives.
 * - `putKeys` puts whole keys in, instead of what is at those moments. A plain value gives way.
 * - `set` replaces the whole property, `clear` takes it away.
 */
export const PropertyEdit = z.discriminatedUnion("op", [
  z.strictObject({ ...Target, op: z.literal("write"), time: Time, value: Value }),
  z.strictObject({ ...Target, op: z.literal("setKey"), time: Time, value: Value }),
  z.strictObject({ ...Target, op: z.literal("removeKey"), time: Time }),
  z.strictObject({ ...Target, op: z.literal("moveKey"), moves: z.array(KeyMove).min(1) }),
  z.strictObject({
    ...Target,
    op: z.literal("setInterp"),
    times: z.array(Time).min(1),
    ease: KeyEase,
  }),
  z.strictObject({ ...Target, op: z.literal("putKeys"), keys: z.array(Key).min(1) }),
  z.strictObject({ ...Target, op: z.literal("set"), value: PropertyValue }),
  z.strictObject({ ...Target, op: z.literal("clear") }),
]);

export type PropertyEdit = z.output<typeof PropertyEdit>;

type WithoutTarget<T> = T extends unknown ? Omit<T, "owner" | "path"> : never;

/** What an edit does to a value, wherever that value is. */
export type ValueEdit = WithoutTarget<PropertyEdit>;

/** The first key at or after a moment. */
export function firstKeyFrom(keys: readonly Key[], moment: Rational): number {
  let low = 0;
  let high = keys.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (compare(parseTime((keys[middle] as Key).time), moment) < 0) low = middle + 1;
    else high = middle;
  }
  return low;
}

export const isAt = (key: Key | undefined, moment: Rational): key is Key =>
  key !== undefined && compare(parseTime(key.time), moment) === 0;

const DEFAULT_ARRIVAL = [1, 1] as const;

/** A key as a point of its curve, when it is a number there. */
function pointOf({ time, value }: Key): KeyPoint | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? { time: toSeconds(parseTime(time)), value }
    : undefined;
}

/** The handles of the bezier that leaves a key, or undefined when it does not leave as one. */
function bezierFrom(from: Key, to: Key): Handles | undefined {
  if (from.interp !== "bezier" || !from.out) return undefined;
  const [x2, y2] = to.in ?? DEFAULT_ARRIVAL;
  return [from.out[0], from.out[1], x2, y2];
}

/** How a key arrives, without writing what it would do anyway, give or take what floats lose. */
function arrivingAs(key: Key, [x, y]: readonly [number, number]): Key {
  const near = (a: number, b: number) => Math.abs(a - b) <= 1e-12;
  if (key.in === undefined && near(x, DEFAULT_ARRIVAL[0]) && near(y, DEFAULT_ARRIVAL[1]))
    return key;
  return { ...key, in: [x, y] };
}

/**
 * A key that goes in keeps what a bezier looks like where it holds the value that was there, and
 * bends it where it holds another one, as far as `splitBezier` can. Everywhere else a new key is
 * linear, and the keys around it stay as they are, so that taking it away again leaves what was there.
 */
function keysWith(keys: readonly Key[], index: number, added: Key): readonly Key[] {
  const before = keys[index - 1];
  const after = keys[index];
  const handles = before && after ? bezierFrom(before, after) : undefined;
  const points = before && after ? [pointOf(before), pointOf(after), pointOf(added)] : [];
  const [from, to, at] = points;
  const halves = handles && from && to && at ? splitBezier(from, to, handles, at) : undefined;
  if (!before || !after || !halves) return keys.toSpliced(index, 0, added);
  const [x1, y1, x2, y2] = halves.before;
  const [x3, y3, x4, y4] = halves.after;
  return keys.toSpliced(
    index - 1,
    2,
    { ...before, out: [x1, y1] },
    { ...added, in: [x2, y2], interp: "bezier", out: [x3, y3] },
    arrivingAs(after, [x4, y4]),
  );
}

/** The keys without one, which takes the bezier that was cut there back to what it was before. */
function keysWithout(keys: readonly Key[], index: number): readonly Key[] {
  const before = keys[index - 1];
  const key = keys[index] as Key;
  const after = keys[index + 1];
  const left = before ? bezierFrom(before, key) : undefined;
  const right = after ? bezierFrom(key, after) : undefined;
  const points = before && after ? [pointOf(before), pointOf(key), pointOf(after)] : [];
  const [from, middle, to] = points;
  const joined =
    left && right && from && middle && to ? joinBezier(from, middle, to, left, right) : undefined;
  if (!before || !after || !joined) return keys.toSpliced(index, 1);
  const [x1, y1, x2, y2] = joined;
  return keys.toSpliced(index - 1, 3, { ...before, out: [x1, y1] }, arrivingAs(after, [x2, y2]));
}

/** A key that is there keeps how it goes on, so changing its value does not change the easing. */
function withKey(animation: Animation, time: string, value: Value): Animation {
  const moment = parseTime(time);
  const { keys } = animation;
  const index = firstKeyFrom(keys, moment);
  const there = keys[index];
  return {
    ...animation,
    keys: isAt(there, moment)
      ? keys.with(index, { ...there, value })
      : (keysWith(keys, index, { time, value }) as Key[]),
  };
}

function indexOfKey(keys: readonly Key[], time: string): number {
  const moment = parseTime(time);
  const index = firstKeyFrom(keys, moment);
  return isAt(keys[index], moment) ? index : fail("not-found", { kind: "key", id: time });
}

function withoutKey(value: PropertyValue | undefined, time: string): PropertyValue {
  const keys = value !== undefined && isAnimation(value) ? value.keys : [];
  const index = indexOfKey(keys, time);
  if (keys.length === 1) return (keys[index] as Key).value;
  return { ...(value as Animation), keys: keysWithout(keys, index) as Key[] };
}

/** New keys among those that stay. Where one comes down on a key that stays, the new one is what is left. */
function placed(staying: readonly Key[], added: readonly Key[]): readonly Key[] {
  const timed = added
    .map((key) => ({ key, moment: parseTime(key.time) }))
    .toSorted((a, b) => compare(a.moment, b.moment));
  const keys: Key[] = [];
  let from = 0;
  timed.forEach(({ key, moment }, index) => {
    const previous = timed[index - 1];
    if (previous && compare(previous.moment, moment) === 0) {
      fail("invalid-value", { rule: "key-taken", time: key.time });
    }
    const at = firstKeyFrom(staying, moment);
    for (let next = from; next < at; next += 1) keys.push(staying[next] as Key);
    keys.push(key);
    from = isAt(staying[at], moment) ? at + 1 : at;
  });
  for (let next = from; next < staying.length; next += 1) keys.push(staying[next] as Key);
  return keys;
}

function withKeysMoved(
  animation: Animation | undefined,
  moves: readonly z.output<typeof KeyMove>[],
): Animation {
  const keys = animation?.keys ?? [];
  const leaving = new Set<number>();
  const moved = moves.map(({ from, to }) => {
    const index = indexOfKey(keys, from);
    if (leaving.has(index)) fail("invalid-value", { rule: "key-moved-twice", time: from });
    leaving.add(index);
    return { ...(keys[index] as Key), time: to };
  });
  const staying = keys.filter((_key, index) => !leaving.has(index));
  return { ...(animation as Animation), keys: placed(staying, moved) as Key[] };
}

/** Only what is about how a key goes on: how it arrives is about the stretch before it. */
function eased(key: Key, ease: KeyEase): Key {
  const { interp: _interp, out: _out, preset: _preset, spring: _spring, ...rest } = key;
  if (ease.interp === "linear") return rest;
  if (ease.interp === "hold") return { ...rest, interp: "hold" };
  return { ...rest, interp: "bezier", out: ease.out };
}

function arriving(key: Key, ease: KeyEase): Key {
  const { in: _in, ...rest } = key;
  return ease.interp === "bezier" && ease.in ? { ...rest, in: ease.in } : rest;
}

function withEase(
  animation: Animation | undefined,
  times: readonly string[],
  ease: KeyEase,
): Animation {
  const keys = [...(animation?.keys ?? [])];
  for (const time of times) {
    const index = indexOfKey(keys, time);
    keys[index] = eased(keys[index] as Key, ease);
    const next = keys[index + 1];
    if (next) keys[index + 1] = arriving(next, ease);
  }
  return { ...(animation as Animation), keys };
}

const NO_KEYS: Animation = { keys: [] };

/**
 * What a property holds after an edit, and undefined when nothing is left of it. Previewing, trying
 * out and writing all come through here, so what people see is what gets saved. Fails when an edit
 * is about a key that is not there.
 */
export function applyEdit(
  value: PropertyValue | undefined,
  edit: ValueEdit,
): PropertyValue | undefined {
  const keyed = value !== undefined && isAnimation(value) ? value : undefined;
  switch (edit.op) {
    case "write":
      return keyed ? withKey(keyed, edit.time, edit.value) : edit.value;
    case "setKey":
      return withKey(keyed ?? NO_KEYS, edit.time, edit.value);
    case "removeKey":
      return withoutKey(value, edit.time);
    case "moveKey":
      return withKeysMoved(keyed, edit.moves);
    case "setInterp":
      return withEase(keyed, edit.times, edit.ease);
    case "putKeys":
      return { ...(keyed ?? NO_KEYS), keys: placed(keyed?.keys ?? [], edit.keys) as Key[] };
    case "set":
      return edit.value;
    case "clear":
      return undefined;
  }
}
