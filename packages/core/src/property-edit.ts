import {
  Id,
  PropertyPath,
  PropertyValue,
  Time,
  Value,
  compare,
  isAnimation,
  parseTime,
  type Animation,
  type Key,
  type Rational,
} from "@animaquill/schema";
import { z } from "zod";
import { fail } from "./draft.ts";

/** Whose property it is. Tracks and effects get their own shape of this later. */
const Target = { owner: z.strictObject({ clip: Id }), path: PropertyPath };

/**
 * One change to one property. Times are readings of the clock of the clip, like the keys themselves.
 *
 * - `write` is what a control does: with keys it writes a key at `time`, otherwise it changes the value.
 * - `setKey` writes a key, also on a property that had none.
 * - `removeKey` takes one away. The last one leaves its value behind.
 * - `set` replaces the whole property, `clear` takes it away.
 */
export const PropertyEdit = z.discriminatedUnion("op", [
  z.strictObject({ ...Target, op: z.literal("write"), time: Time, value: Value }),
  z.strictObject({ ...Target, op: z.literal("setKey"), time: Time, value: Value }),
  z.strictObject({ ...Target, op: z.literal("removeKey"), time: Time }),
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
      : keys.toSpliced(index, 0, { time, value }),
  };
}

function withoutKey(value: PropertyValue | undefined, time: string): PropertyValue {
  const moment = parseTime(time);
  const keys = value !== undefined && isAnimation(value) ? value.keys : [];
  const index = firstKeyFrom(keys, moment);
  const there = keys[index];
  if (!isAt(there, moment)) return fail("not-found", `这个时刻没有关键帧：${time}`);
  if (keys.length === 1) return there.value;
  return { ...(value as Animation), keys: keys.toSpliced(index, 1) };
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
    case "set":
      return edit.value;
    case "clear":
      return undefined;
  }
}
