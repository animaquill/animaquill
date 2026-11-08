import {
  ZERO,
  add,
  compare,
  edgeLength,
  joinParts,
  parseTime,
  placeJoins,
  subtract,
  toSeconds,
  type JoinAlign,
  type JoinPlace,
  type JoinSides,
  type Rational,
} from "@animaquill/schema";
import {
  clipOffset,
  entryOf,
  sourceLength,
  type ClipState,
  type JoinState,
  type JoinTransition,
  type ProjectState,
  type TimelineState,
} from "./model.ts";

/**
 * Joins: transitions on the cut between two clips that follow each other on a track. Where they
 * are, how much of each clip they take, and what the clips have to show past the cut. Nothing here
 * changes anything: commands, the render plan and the timeline all go by these, so that they never
 * disagree about a join.
 */

/** A join with all of its fields. Two windows at once can leave only some of them, see JoinState. */
export interface WholeJoin {
  readonly id: string;
  readonly track: string;
  readonly from: string;
  readonly to: string;
  readonly transition: JoinTransition;
}

/** A join as a whole, or nothing for what is only some of one. */
export function wholeJoin(id: string, join: JoinState | undefined): WholeJoin | undefined {
  if (!join) return undefined;
  const { track, from, to, transition } = join;
  if (track === undefined || from === undefined || to === undefined || !transition)
    return undefined;
  return { id, track, from, to, transition };
}

/** The whole joins of a timeline, by track and then by id. */
function joinsByTrack(timeline: TimelineState): ReadonlyMap<string, Map<string, WholeJoin>> {
  const byTrack = new Map<string, Map<string, WholeJoin>>();
  for (const [id, state] of Object.entries(timeline.joins ?? {})) {
    const join = wholeJoin(id, state);
    if (!join) continue;
    const joins = byTrack.get(join.track) ?? new Map<string, WholeJoin>();
    byTrack.set(join.track, joins.set(id, join));
  }
  return byTrack;
}

/** A join and where it is. */
export interface PlacedJoin {
  readonly join: WholeJoin;
  readonly place: JoinPlace;
}

/**
 * Where every whole join of a timeline is, by `placeJoins`: only clips on the track of a join count
 * as its sides. The problems of a file go by the same rule, so they say the same.
 */
export function placedJoins(timeline: TimelineState): ReadonlyMap<string, PlacedJoin> {
  const placed = new Map<string, PlacedJoin>();
  for (const [track, joins] of joinsByTrack(timeline)) {
    const clipOf = (id: string) => {
      const clip = entryOf(timeline.clips, id);
      return clip?.track === track ? clip : undefined;
    };
    for (const [id, place] of placeJoins(joins as ReadonlyMap<string, JoinSides>, clipOf)) {
      placed.set(id, { join: joins.get(id) as WholeJoin, place });
    }
  }
  return placed;
}

/** A join that does what it says: on the cut between its two clips, which both show. */
export interface JoinInEffect {
  readonly id: string;
  readonly track: string;
  readonly from: ClipState;
  readonly to: ClipState;
  readonly transition: JoinTransition;
  /** The cut, exactly. */
  readonly at: Rational;
}

/**
 * The joins of a timeline that do something, by `placeJoins`, as the problems of a file have them
 * too: a join whose sides are apart, or one of them hidden, does nothing.
 */
export function joinsInEffect(timeline: TimelineState): readonly JoinInEffect[] {
  const found: JoinInEffect[] = [];
  for (const [id, { join, place }] of placedJoins(timeline)) {
    if (place.kind !== "cut") continue;
    const from = entryOf(timeline.clips, join.from) as ClipState;
    const to = entryOf(timeline.clips, join.to) as ClipState;
    found.push({ id, track: join.track, from, to, transition: join.transition, at: place.at });
  }
  return found;
}

/**
 * The edges of clips where a join is, as `<clip> enter` and `<clip> exit`: a join wins over the
 * transition at either of its ends.
 */
export function joinedEdges(timeline: TimelineState): ReadonlySet<string> {
  const joined = new Set<string>();
  for (const { from, to } of joinsInEffect(timeline)) {
    joined.add(`${from.id} exit`).add(`${to.id} enter`);
  }
  return joined;
}

/**
 * How much of a join is before its cut and how much after, as `align` says, each part no longer
 * than the clip on its side: the clip before the cut goes on for what is after it, and the clip
 * after it starts early by what is before it. Its progress still goes from 0 to 1 over the two.
 */
export function partsOf({
  from,
  to,
  transition,
}: Pick<JoinInEffect, "from" | "to" | "transition">): readonly [Rational, Rational] {
  const [before, after] = joinParts(parseTime(transition.duration), transition.align);
  return [edgeLength(before, parseTime(from.duration)), edgeLength(after, parseTime(to.duration))];
}

/** The stretch of the timeline that a join takes, exactly: its parts around the cut. */
export function spanOfJoin(join: JoinInEffect): { readonly from: Rational; readonly to: Rational } {
  const [before, after] = partsOf(join);
  return { from: subtract(join.at, before), to: add(join.at, after) };
}

/** Seconds on the timeline that a join takes, see `spanOfJoin`. */
export function joinSpan(join: JoinInEffect): readonly [number, number] {
  const { from, to } = spanOfJoin(join);
  return [toSeconds(from), toSeconds(to)];
}

/** An end of a clip. */
export type ClipEnd = "start" | "end";

/** What takes an end of a clip, by clip: the join there, with how much of the clip it takes. */
export interface JoinedEnds {
  readonly start: ReadonlyMap<string, { readonly join: JoinInEffect; readonly length: Rational }>;
  readonly end: ReadonlyMap<string, { readonly join: JoinInEffect; readonly length: Rational }>;
}

/** The joins at the ends of clips, by clip. Worked out once for many questions about one state. */
export function joinedEndsOf(timeline: TimelineState): JoinedEnds {
  const start = new Map<string, { readonly join: JoinInEffect; readonly length: Rational }>();
  const end = new Map<string, { readonly join: JoinInEffect; readonly length: Rational }>();
  for (const join of joinsInEffect(timeline)) {
    const [before, after] = partsOf(join);
    end.set(join.from.id, { join, length: before });
    start.set(join.to.id, { join, length: after });
  }
  return { start, end };
}

/** How long a transition at an edge of a clip is, or nothing when it cannot be read. */
function edgeLengthOf(clip: ClipState, edge: "enter" | "exit"): Rational {
  const transition = clip[edge];
  if (!transition) return ZERO;
  try {
    return edgeLength(parseTime(transition.duration), parseTime(clip.duration));
  } catch {
    return ZERO;
  }
}

/**
 * How much of a clip what is in effect at one of its ends takes: a join there wins over the
 * transition of the clip itself.
 */
export function takenAt(joined: JoinedEnds, clip: ClipState, end: ClipEnd): Rational {
  const join = joined[end].get(clip.id);
  if (join) return join.length;
  return edgeLengthOf(clip, end === "start" ? "enter" : "exit");
}

const OTHER_END: Readonly<Record<ClipEnd, ClipEnd>> = { start: "end", end: "start" };

/** How much of a clip a join at one of its ends can take: all that the other end leaves. */
export function roomAt(joined: JoinedEnds, clip: ClipState, end: ClipEnd): Rational {
  const left = subtract(parseTime(clip.duration), takenAt(joined, clip, OTHER_END[end]));
  return compare(left, ZERO) > 0 ? left : ZERO;
}

const atMost = (value: Rational, limit: Rational) => (compare(value, limit) > 0 ? limit : value);

/**
 * How long a join between two clips can be where it is around the cut, so that each part leaves
 * the other end of its clip what is there: half of it on each side, or all of it on one.
 */
export function longestJoin(
  joined: JoinedEnds,
  from: ClipState,
  to: ClipState,
  align: JoinAlign | undefined,
): Rational {
  const before = roomAt(joined, from, "end");
  const after = roomAt(joined, to, "start");
  if (align === "before") return before;
  if (align === "after") return after;
  const half = atMost(before, after);
  return add(half, half);
}

/** Whether a join of this length fits where it is: see `longestJoin`. */
export function joinFits(
  joined: JoinedEnds,
  from: ClipState,
  to: ClipState,
  duration: Rational,
  align: JoinAlign | undefined,
): boolean {
  const [before, after] = joinParts(duration, align);
  return (
    compare(before, roomAt(joined, from, "end")) <= 0 &&
    compare(after, roomAt(joined, to, "start")) <= 0
  );
}

/**
 * Whether a clip shows the same at any moment, so that it has as much past its edges as anybody
 * wants. Anything unknown is taken to have a beginning, to be safe.
 */
const isTimeless = ({ source }: ClipState) =>
  source.kind === "color" || source.kind === "image" || source.kind === "caption";

/**
 * How much a clip has to show past one of its edges, for a join: the part of its file before its
 * start or after its end, where its clock still reads something it has. Undefined is no end to it,
 * as for a picture, or a scene after its end. A scene has nothing before its clock reads zero.
 */
export function handleOf(
  state: ProjectState,
  clip: ClipState,
  side: "before" | "after",
): Rational | undefined {
  if (isTimeless(clip)) return undefined;
  if (side === "before") return clipOffset(clip);
  const length = sourceLength(state, clip);
  if (length === undefined) return undefined;
  const used = add(clipOffset(clip), parseTime(clip.duration));
  const left = subtract(length, used);
  return compare(left, ZERO) > 0 ? left : ZERO;
}

/**
 * Where a join goes around its cut when nobody says, by what the clips have past it: in the middle
 * when both have enough, on the side of the one that has, so that as little as possible of it shows
 * a frame that stands still. Of two that come to the same, the middle when both clips have
 * something past the cut, or else the side that has.
 */
export function chooseAlign(
  state: ProjectState,
  from: ClipState,
  to: ClipState,
  duration: Rational,
): JoinAlign {
  const after = handleOf(state, from, "after");
  const before = handleOf(state, to, "before");
  const short = (need: Rational, have: Rational | undefined) =>
    have === undefined || compare(have, need) >= 0 ? ZERO : subtract(need, have);
  const [half, rest] = joinParts(duration, "center");
  const still: Readonly<Record<JoinAlign, Rational>> = {
    center: add(short(half, after), short(rest, before)),
    after: short(duration, after),
    before: short(duration, before),
  };
  const has = (handle: Rational | undefined) => handle === undefined || compare(handle, ZERO) > 0;
  const order: readonly JoinAlign[] =
    has(after) === has(before)
      ? ["center", "after", "before"]
      : has(after)
        ? ["after", "center", "before"]
        : ["before", "center", "after"];
  return order.reduce((best, align) => (compare(still[align], still[best]) < 0 ? align : best));
}

/**
 * Where a clip shows something that stands still during a join, in seconds on the timeline: before
 * the first frame of its file, or after its last one. A picture never does, and a scene stays on its
 * first frame before its clock reads zero and goes on after its end.
 */
export function stillDuring(
  state: ProjectState,
  join: JoinInEffect,
): readonly { readonly from: number; readonly to: number }[] {
  const span = spanOfJoin(join);
  const still: { from: number; to: number }[] = [];
  const before = handleOf(state, join.to, "before");
  if (before !== undefined) {
    // The clock of the clip after the cut reads zero here.
    const zero = subtract(parseTime(join.to.start), before);
    if (compare(zero, span.from) > 0) {
      const end = compare(zero, join.at) < 0 ? zero : join.at;
      still.push({ from: toSeconds(span.from), to: toSeconds(end) });
    }
  }
  const after = handleOf(state, join.from, "after");
  if (after !== undefined) {
    // The clip before the cut runs out of its file here.
    const last = add(join.at, after);
    if (compare(last, span.to) < 0) {
      const start = compare(last, join.at) > 0 ? last : join.at;
      still.push({ from: toSeconds(start), to: toSeconds(span.to) });
    }
  }
  return still;
}
