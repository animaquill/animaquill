import { applyEdit, secondsOf, withAutoTangents, type PropertyEdit } from "@animaquill/core";
import {
  compare,
  isAnimation,
  parseTime,
  type Animation,
  type Key,
  type PropertySpec,
  type PropertyValue,
} from "@animaquill/schema";
import { numberAt, tidy } from "./numbers.ts";

/**
 * What keeps the picture still when the anchor of a clip moves: the position moves along, on every
 * frame. The position has to move by as much as the anchor moved in the world, which is a share of
 * the box, turned and scaled. Where the anchor has keys, what it moved by changes over time, and so
 * does what the position has to move by. This works it out for one direction of the position, from
 * the properties as they are now.
 *
 * It is exact on every frame as long as nothing turns, scales or changes the size of the box over
 * time: then the position is one curve plus shares of others. It comes out as keys at the keys of
 * the anchor, with their easing where that says it all, and with a key on every frame of a stretch
 * where nothing else would come out right.
 */

/** A moment a frame of the clip is drawn at: exactly, and on its clock in seconds. */
export interface FrameMoment {
  readonly time: string;
  readonly clock: number;
}

/** One direction of the anchor, before and after it moved. */
export interface AnchorSide {
  readonly spec: PropertySpec;
  readonly before: PropertyValue | undefined;
  readonly after: PropertyValue | undefined;
  /** Where the move wrote a key, which is where it changed the curve. Nothing without keys. */
  readonly at: string | undefined;
  /** How far one direction of the position goes for a share of the anchor in this one. */
  readonly perShare: number;
}

/** One direction of the position, as it is now. */
export interface PositionSide {
  readonly clip: string;
  readonly path: string;
  readonly spec: PropertySpec;
  readonly stored: PropertyValue | undefined;
  /** Writes a value where the properties tab would, for a position without keys. */
  readonly write: (value: number) => PropertyEdit;
}

export interface AnchorMove {
  /** The clock of the clip where the anchor moved. */
  readonly clock: number;
  readonly x: AnchorSide;
  readonly y: AnchorSide;
  /** The frames of the clip from one reading of its clock to another, as far as it shows. */
  readonly frames: (from: number, to: number) => readonly FrameMoment[];
}

/** Below this a difference of a position is float noise, in world units. */
const NOISE = 1e-4;
/** A share this small moves nothing. */
const NOTHING = 1e-12;

const keysOf = (value: PropertyValue | undefined): readonly Key[] =>
  value !== undefined && isAnimation(value) ? value.keys : [];

/** The same moment, however it is written. */
function momentOf(time: string): string {
  const { n, d } = parseTime(time);
  return `${n}/${d}`;
}

const byTime = (a: { readonly time: string }, b: { readonly time: string }) =>
  compare(parseTime(a.time), parseTime(b.time));

/** What a key says about how it goes on and arrives: the rest of a key is its time and value. */
function easingOf(key: Key): Omit<Key, "time" | "value"> {
  // A handle the editor works out itself would not be the one that comes out right.
  const { time: _time, value: _value, tangent: _tangent, ...easing } = key;
  return easing;
}

/** How far a move of the anchor moves the position at a reading of the clock. */
function shiftAt(move: AnchorMove, clock: number, only?: readonly AnchorSide[]): number {
  let shift = 0;
  for (const side of only ?? [move.x, move.y]) {
    if (Math.abs(side.perShare) <= NOTHING) continue;
    const after = numberAt(side.after, side.spec, clock) ?? 0;
    const before = numberAt(side.before, side.spec, clock) ?? 0;
    shift += side.perShare * (after - before);
  }
  return shift;
}

/**
 * Where a move of keys of the anchor makes a difference: from the key before the one it wrote to the
 * key after it. Without one on either side, or for a curve that loops, it goes on that way.
 */
function reachOf(keyed: readonly AnchorSide[]): readonly [number, number] {
  let low = Number.POSITIVE_INFINITY;
  let high = Number.NEGATIVE_INFINITY;
  for (const { after, at } of keyed) {
    const keys = keysOf(after);
    const animation = after as Animation;
    const index =
      at === undefined ? -1 : keys.findIndex(({ time }) => momentOf(time) === momentOf(at));
    const previous = (animation.before ?? "hold") === "hold" ? keys[index - 1] : undefined;
    const next = (animation.after ?? "hold") === "hold" ? keys[index + 1] : undefined;
    const known = index >= 0;
    low = Math.min(low, known && previous ? secondsOf(previous.time) : Number.NEGATIVE_INFINITY);
    high = Math.max(high, known && next ? secondsOf(next.time) : Number.POSITIVE_INFINITY);
  }
  return [low, high];
}

/** Whether one key followed another in keys, before a move. */
function wereNeighbours(keys: readonly Key[], from: string, to: string): boolean {
  const index = keys.findIndex(({ time }) => momentOf(time) === momentOf(from));
  const next = keys[index + 1];
  return index >= 0 && next !== undefined && momentOf(next.time) === momentOf(to);
}

/**
 * The keys of the anchor, as keys of the position: at the same moments, with the values the position
 * needs there. A stretch that was there before goes as the anchor goes, so it keeps the easing. One
 * that a new key cut out of a bezier changes only by how far that key moved: it takes the handles in
 * time and none in value.
 */
function mirrored(keyed: readonly AnchorSide[], value: (clock: number) => number): Animation {
  const found = new Map<
    string,
    { readonly key: Key; readonly side: AnchorSide; readonly index: number }
  >();
  for (const side of keyed) {
    keysOf(side.after).forEach((key, index) => {
      const moment = momentOf(key.time);
      if (!found.has(moment)) found.set(moment, { key, side, index });
    });
  }
  const keys = [...found.values()]
    .map(({ key, side, index }): Key => {
      const own = keysOf(side.after);
      const before = keysOf(side.before);
      const next = own[index + 1];
      const previous = own[index - 1];
      const { out, in: arrives, ...easing } = easingOf(key);
      const cut = (from: Key | undefined, to: Key | undefined) =>
        from !== undefined && to !== undefined && !wereNeighbours(before, from.time, to.time);
      const leaves = out && (cut(key, next) ? ([out[0], 0] as const) : out);
      const comes =
        previous?.interp === "bezier" && cut(previous, key)
          ? ([arrives?.[0] ?? 1, 1] as const)
          : arrives;
      return {
        ...easing,
        ...(leaves && { out: [leaves[0], leaves[1]] }),
        ...(comes && { in: [comes[0], comes[1]] }),
        time: key.time,
        value: value(secondsOf(key.time)),
      };
    })
    .toSorted(byTime);
  const source = keyed[0]?.after as Animation;
  return {
    keys,
    ...(source.before && { before: source.before }),
    ...(source.after && { after: source.after }),
  };
}

/** The last of some sorted readings of a clock at or before another one, or -1 for none. */
function lastAtOrBefore(clocks: readonly number[], clock: number): number {
  let low = 0;
  let high = clocks.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if ((clocks[middle] as number) <= clock + 1e-9) low = middle + 1;
    else high = middle;
  }
  return low - 1;
}

/**
 * Keys that come out as they should on every frame: a stretch between two keys, or past the first
 * or the last, that does not gets a key on each of its frames, which go straight from one to the next.
 */
function onEveryFrame(
  animation: Animation,
  value: (clock: number) => number,
  frames: readonly FrameMoment[],
  spec: PropertySpec,
): Animation {
  const worked = withAutoTangents(animation);
  const clocks = worked.keys.map(({ time }) => secondsOf(time));
  const broken = new Set<number>();
  for (const { clock } of frames) {
    const off = Math.abs((numberAt(worked, spec, clock) ?? 0) - value(clock)) > NOISE;
    if (off) broken.add(lastAtOrBefore(clocks, clock));
  }
  if (broken.size === 0) return worked;
  const taken = new Set(worked.keys.map(({ time }) => momentOf(time)));
  const added: Key[] = [];
  for (const { time, clock } of frames) {
    if (!broken.has(lastAtOrBefore(clocks, clock)) || taken.has(momentOf(time))) continue;
    added.push({ time, value: tidy(value(clock), spec) });
  }
  const straight = worked.keys.map((key, index) => {
    if (!broken.has(index) && !broken.has(index - 1)) return key;
    const { interp: _i, out: _o, in: _n, preset: _p, spring: _s, tangent: _t, ...rest } = key;
    return rest;
  });
  const { before, after, ...rest } = worked;
  return {
    ...rest,
    keys: [...straight, ...added].toSorted(byTime),
    ...(before && !broken.has(-1) && { before }),
    ...(after && !broken.has(worked.keys.length - 1) && { after }),
  };
}

/**
 * What one direction of the position needs, so that the picture stays where it is on every frame
 * when the anchor moves: see the top of this file. Only keys that change are written.
 */
export function compensation(position: PositionSide, move: AnchorMove): readonly PropertyEdit[] {
  const { clip, path, spec, stored } = position;
  const target = { owner: { clip }, path };
  const keyed = [move.x, move.y].filter(
    (side) => Math.abs(side.perShare) > NOTHING && keysOf(side.after).length > 0,
  );
  const own = keysOf(stored);
  // What moved without keys moved everywhere, and keyed what did not move stays where it was.
  const steady = shiftAt(
    move,
    move.clock,
    [move.x, move.y].filter((side) => !keyed.includes(side)),
  );
  if (keyed.length === 0) {
    if (Math.abs(steady) <= NOISE) return [];
    if (own.length === 0) {
      const now = numberAt(stored, spec, move.clock) ?? 0;
      return [position.write(tidy(now + steady, spec))];
    }
    const keys = own.flatMap((key) =>
      typeof key.value === "number" ? [{ ...key, value: tidy(key.value + steady, spec) }] : [],
    );
    return [{ ...target, op: "putKeys", keys }];
  }
  const value = (clock: number) => (numberAt(stored, spec, clock) ?? 0) + shiftAt(move, clock);
  const [low, high] = reachOf(keyed);
  const frames = move.frames(low, high);
  if (own.length === 0) {
    const keys = mirrored(keyed, (clock) => tidy(value(clock), spec));
    return [{ ...target, op: "set", value: onEveryFrame(keys, value, frames, spec) }];
  }
  // Its own keys go where the anchor moved, and by what moved everywhere elsewhere. Keys of the
  // anchor where it moved go in as well, which keeps the rest of the curve as it was.
  const inside = (clock: number) => clock > low - 1e-9 && clock < high + 1e-9;
  const updated = own.map((key) => {
    if (typeof key.value !== "number") return key;
    const clock = secondsOf(key.time);
    return { ...key, value: tidy(inside(clock) ? value(clock) : key.value + steady, spec) };
  });
  let candidate: PropertyValue | undefined = { ...(stored as Animation), keys: updated };
  const taken = new Set(own.map(({ time }) => momentOf(time)));
  for (const side of keyed) {
    for (const { time } of keysOf(side.after)) {
      const clock = secondsOf(time);
      if (!inside(clock) || taken.has(momentOf(time))) continue;
      taken.add(momentOf(time));
      candidate = applyEdit(candidate, { op: "setKey", time, value: tidy(value(clock), spec) });
    }
  }
  const exact = onEveryFrame(candidate as Animation, value, frames, spec);
  const before = new Map(own.map((key) => [momentOf(key.time), JSON.stringify(key)]));
  const keys = exact.keys.filter((key) => before.get(momentOf(key.time)) !== JSON.stringify(key));
  return keys.length === 0 ? [] : [{ ...target, op: "putKeys", keys }];
}
