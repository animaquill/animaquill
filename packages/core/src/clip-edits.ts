import {
  ZERO,
  add,
  compare,
  formatTime,
  isAnimation,
  joinParts,
  newId,
  parseTime,
  subtract,
  type Animation,
  type Overrides,
  type PropertyValue,
  type Rational,
  type Transition,
} from "@animaquill/schema";
import { fail, type Draft } from "./draft.ts";
import { placedJoins, wholeJoin, type WholeJoin } from "./joins.ts";
import {
  clipEnd,
  clipOffset,
  clipStart,
  entryOf,
  orderedSections,
  timelineLength,
  type ClipState,
  type TimelineState,
} from "./model.ts";

interface CaptionWord {
  readonly text: string;
  readonly time: string;
}

/** A stretch of a timeline. */
export interface Span {
  readonly from: Rational;
  readonly to: Rational;
}

export const timelinePath = (timeline: string) => ["timelines", timeline];
export const clipPath = (timeline: string, clip: string) => ["timelines", timeline, "clips", clip];
export const joinPath = (timeline: string, join: string) => ["timelines", timeline, "joins", join];

export function timelineOf(draft: Draft, id: string): TimelineState {
  return entryOf(draft.state.timelines, id) ?? fail("not-found", `没有这条时间轴：${id}`);
}

export const spanOf = (clip: ClipState): Span => ({ from: clipStart(clip), to: clipEnd(clip) });

const clipsOn = (timeline: TimelineState, track: string) =>
  Object.values(timeline.clips).filter((clip) => clip.track === track);

const overlap = (a: Span, b: Span) => compare(a.to, b.from) > 0 && compare(a.from, b.to) < 0;

/** The first of spans in time order that ends after a moment. */
function firstEndingAfter(spans: readonly Span[], moment: Rational): number {
  let low = 0;
  let high = spans.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (compare((spans[middle] as Span).to, moment) > 0) high = middle;
    else low = middle + 1;
  }
  return low;
}

/**
 * The clips of a track that are in the way, each with what it is in the way of. Spans have to be in
 * time order and apart from each other. Moving thousands of clips at once has to stay quick, so
 * this looks at every clip once instead of comparing everything with everything.
 */
function clipsInTheWay(
  timeline: TimelineState,
  track: string,
  spans: readonly Span[],
  moving: ReadonlySet<string>,
): readonly { readonly clip: ClipState; readonly spans: readonly Span[] }[] {
  return clipsOn(timeline, track).flatMap((clip) => {
    if (moving.has(clip.id)) return [];
    const own = spanOf(clip);
    const touched: Span[] = [];
    for (let index = firstEndingAfter(spans, own.from); index < spans.length; index++) {
      const span = spans[index] as Span;
      if (compare(span.from, own.to) >= 0) break;
      touched.push(span);
    }
    return touched.length > 0 ? [{ clip, spans: touched }] : [];
  });
}

/** Two clips cannot share a moment on a track: which one would show? */
export function assertFree(
  timeline: TimelineState,
  track: string,
  spans: readonly Span[],
  moving: ReadonlySet<string>,
): void {
  const [first] = clipsInTheWay(timeline, track, spans, moving);
  if (first) fail("overlap", `这里已经有片段了：${first.clip.name ?? first.clip.id}`);
}

/** Takes clips away, and the joins they are a side of: a join goes between two clips or nowhere. */
export function removeClips(draft: Draft, timeline: string, clips: readonly string[]): void {
  const removed = new Set(clips);
  const { joins } = timelineOf(draft, timeline);
  for (const id of clips) draft.delete(clipPath(timeline, id));
  for (const [id, { from, to }] of Object.entries(joins ?? {})) {
    const isSide = (clip: string | undefined) => clip !== undefined && removed.has(clip);
    if (isSide(from) || isSide(to)) draft.delete(joinPath(timeline, id));
  }
}

/**
 * Whether a clip shows something before its clock reads zero. A picture looks the same at any
 * moment. Everything else has a beginning, and anything unknown is treated that way to be safe.
 */
const isTimeless = (clip: ClipState) =>
  clip.source.kind === "color" || clip.source.kind === "image" || clip.source.kind === "caption";

function laterKeys(animation: Animation, by: Rational): Animation {
  const keys = animation.keys.map((key) => ({
    ...key,
    time: formatTime(add(parseTime(key.time), by)),
  }));
  return { ...animation, keys };
}

/** A value at another place on the clock of its clip. Only keys have a place. */
export const laterValue = (value: PropertyValue, by: Rational): PropertyValue =>
  isAnimation(value) ? laterKeys(value, by) : value;

const laterProperties = <T extends Readonly<Record<string, PropertyValue>>>(
  properties: T,
  by: Rational,
): T =>
  Object.fromEntries(
    Object.entries(properties).map(([path, value]) => [
      path,
      isAnimation(value) ? laterKeys(value, by) : value,
    ]),
  ) as T;

/**
 * Moves everything on the clock of a clip later. Only needed when a clip grows past the point where
 * its clock reads zero, which is the one thing its clock cannot do by itself.
 */
function moveClockForward(draft: Draft, timeline: string, clip: ClipState, by: Rational): void {
  draft.note({ kind: "clock", clip: clip.id, by: formatTime(by) });
  const path = clipPath(timeline, clip.id);
  for (const [name, value] of Object.entries(clip.properties ?? {})) {
    if (isAnimation(value)) draft.set([...path, "properties", name], laterKeys(value, by));
  }
  if (clip.effects) {
    const effects = clip.effects.map((effect) =>
      effect.properties
        ? { ...effect, properties: laterProperties(effect.properties, by) }
        : effect,
    );
    draft.set([...path, "effects"], effects);
  }
  const { source } = clip;
  if (source.kind === "caption" && Array.isArray(source.words)) {
    const words = (source.words as readonly CaptionWord[]).map((word) => ({
      ...word,
      time: formatTime(add(parseTime(word.time), by)),
    }));
    draft.set([...path, "source"], { ...source, words });
  }
  forEachOverride(draft, timeline, clip.id, (changes, overridePath) => {
    for (const [name, change] of Object.entries(changes.properties ?? {})) {
      const later = (value: PropertyValue | undefined) =>
        value !== undefined && isAnimation(value) ? laterKeys(value, by) : value;
      if (isAnimation(change.value) || (change.base && isAnimation(change.base))) {
        draft.set([...overridePath, "properties", name], {
          value: later(change.value),
          ...(change.base === undefined ? {} : { base: later(change.base) }),
        });
      }
    }
  });
}

/** How far a clip that went from one state to the other would have moved its clock forward. */
function movedForward(was: ClipState, now: ClipState): Rational {
  const offset = add(clipOffset(was), subtract(clipStart(now), clipStart(was)));
  const grewPastZero =
    isTimeless(now) &&
    was.duration !== now.duration &&
    compare(offset, ZERO) < 0 &&
    compare(clipOffset(now), ZERO) === 0;
  return grewPastZero ? subtract(ZERO, offset) : ZERO;
}

/**
 * Whether two states of a clip look like its clock moved: by growing past zero, or by taking that
 * back. Only a hint, because a clip can get there in other ways, and its keys stay where they are
 * then. Who has seen it happen knows: see `ClipFact`.
 */
export const looksLikeClockMoved = (was: ClipState, now: ClipState): boolean =>
  compare(movedForward(was, now), ZERO) !== 0 || compare(movedForward(now, was), ZERO) !== 0;

type ClipChanges = NonNullable<Overrides["clips"]>[string];

/** What the versions of a timeline change about a clip. */
function forEachOverride(
  draft: Draft,
  timeline: string,
  clip: string,
  visit: (changes: ClipChanges, path: readonly string[], version: string) => void,
): void {
  for (const [version, override] of Object.entries(timelineOf(draft, timeline).overrides)) {
    const changes = entryOf(override.clips, clip);
    if (changes) {
      const path = [...timelinePath(timeline), "overrides", version, "clips", clip];
      visit(changes, path, version);
    }
  }
}

function setOffset(draft: Draft, timeline: string, clip: ClipState, offset: Rational): void {
  const path = [...clipPath(timeline, clip.id), "offset"];
  if (compare(offset, ZERO) !== 0) draft.set(path, formatTime(offset));
  else if (clip.offset !== undefined) draft.delete(path);
}

/** How long a transition is, or undefined when there is none or its length cannot be read. */
function lengthOf(transition: Transition | undefined): Rational | undefined {
  if (transition === undefined) return undefined;
  try {
    return parseTime(transition.duration);
  } catch {
    return undefined;
  }
}

const atMost = (value: Rational, limit: Rational) => (compare(value, limit) > 0 ? limit : value);

/** The transitions at the start and the end of a clip, by the field that holds each. */
export type Edge = "enter" | "exit";

/** Joins at the edges of a clip that stay there through a change, by the edge they win over. */
export type JoinedEdges = Partial<Record<Edge, WholeJoin>>;

/** How much of a clip a join takes, as it says, before anything gets shorter to fit. */
function partIn(join: WholeJoin, clip: string): Rational {
  const [before, after] = joinParts(parseTime(join.transition.duration), join.transition.align);
  return join.from === clip ? before : after;
}

/**
 * Makes a join take no more of a clip than this, where it is around its cut: a join in the middle
 * gets shorter on both sides, so that it stays in the middle. One of no time goes.
 */
function shortenJoin(
  draft: Draft,
  timeline: string,
  join: WholeJoin,
  clip: string,
  length: Rational,
): void {
  if (compare(partIn(join, clip), length) <= 0) return;
  const { align } = join.transition;
  const wanted = align === "before" || align === "after" ? length : add(length, length);
  const path = joinPath(timeline, join.id);
  if (compare(wanted, ZERO) <= 0) draft.delete(path);
  else draft.set([...path, "transition"], { ...join.transition, duration: formatTime(wanted) });
}

/**
 * Shortens the transitions at the edges of a clip that got too short for them, as video editors
 * do: first the one at the edge that moved, then the other one, so that what is left of the clip
 * goes in and out as it did. A transition of no time goes. What fits, or cannot be read, stays as
 * it is. Only the length changes: each is one value, which this writes as a whole. A join that
 * stays at an edge takes it instead of the transition of the clip there, and gets shorter the same
 * way: that transition does nothing while the join is there, so it stays as it is.
 */
export function fitTransitions(
  draft: Draft,
  timeline: string,
  clip: Pick<ClipState, "id" | Edge>,
  duration: Rational,
  moved: "start" | "end",
  joined: JoinedEdges = {},
): void {
  const lengthAt = (edge: Edge) => {
    const join = joined[edge];
    return join ? partIn(join, clip.id) : lengthOf(clip[edge]);
  };
  const enter = lengthAt("enter");
  const exit = lengthAt("exit");
  if (!enter && !exit) return;
  const total = add(enter ?? ZERO, exit ?? ZERO);
  if (compare(total, duration) <= 0) return;
  const [near, far]: [Edge, Edge] = moved === "start" ? ["enter", "exit"] : ["exit", "enter"];
  const lengths: Record<Edge, Rational> = { enter: enter ?? ZERO, exit: exit ?? ZERO };
  const kept = atMost(lengths[far], duration);
  const shortened = { [far]: kept, [near]: atMost(lengths[near], subtract(duration, kept)) };
  const path = clipPath(timeline, clip.id);
  for (const edge of [near, far]) {
    const length = shortened[edge] as Rational;
    if (compare(length, lengths[edge]) === 0) continue;
    const join = joined[edge];
    if (join) {
      shortenJoin(draft, timeline, join, clip.id, length);
      continue;
    }
    const transition = clip[edge];
    if (transition === undefined) continue;
    if (compare(length, ZERO) <= 0) draft.delete([...path, edge]);
    else draft.set([...path, edge], { ...transition, duration: formatTime(length) });
  }
}

/** The joins in effect at the edges of a clip, by the edge they win over. */
function joinsAtEdgesOf(timeline: TimelineState, clip: string): JoinedEdges {
  const joined: { enter?: WholeJoin; exit?: WholeJoin } = {};
  for (const { join, place } of placedJoins(timeline).values()) {
    if (place.kind !== "cut") continue;
    if (join.to === clip) joined.enter = join;
    if (join.from === clip) joined.exit = join;
  }
  return joined;
}

/**
 * Moves the edges of a clip. Its content stays where it is on the timeline, and so do keys: they are
 * on the clock of the clip, which only has to read differently at the new first frame. Transitions
 * at its edges go along with them, and get shorter when they no longer fit: see `fitTransitions`.
 * A join at an edge that moves no longer has its two clips next to each other, see `followJoins`.
 */
export function trimClip(draft: Draft, timeline: string, clip: ClipState, span: Span): void {
  const path = clipPath(timeline, clip.id);
  const moved = subtract(span.from, clipStart(clip));
  const { enter, exit } = joinsAtEdgesOf(timelineOf(draft, timeline), clip.id);
  const startStays = compare(moved, ZERO) === 0;
  const endStays = compare(span.to, clipEnd(clip)) === 0;
  const joined = { ...(startStays && enter && { enter }), ...(endStays && exit && { exit }) };
  // Only what changes gets written. Somebody else can move this clip while its end is trimmed.
  if (!startStays) {
    const offset = add(clipOffset(clip), moved);
    if (compare(offset, ZERO) >= 0) {
      setOffset(draft, timeline, clip, offset);
    } else {
      if (!isTimeless(clip)) fail("source-start", `已经到内容的开头了：${clip.name ?? clip.id}`);
      moveClockForward(draft, timeline, clip, subtract(ZERO, offset));
      setOffset(draft, timeline, clip, ZERO);
    }
    draft.set([...path, "start"], formatTime(span.from));
  }
  const length = subtract(span.to, span.from);
  const duration = formatTime(length);
  if (duration !== clip.duration) draft.set([...path, "duration"], duration);
  fitTransitions(draft, timeline, clip, length, startStays ? "end" : "start", joined);
}

/** Whether two clips are one after the other on a track, exactly. */
const nextTo = (from: ClipState | undefined, to: ClipState | undefined, track?: string) =>
  from !== undefined &&
  to !== undefined &&
  from.id !== to.id &&
  from.track === to.track &&
  (track === undefined || from.track === track) &&
  compare(clipEnd(from), clipStart(to)) === 0;

/**
 * The joins whose clips are next to each other on their track, by id, before a change that can take
 * them apart: what `followJoins` looks at afterwards. A hidden side makes no difference to that.
 */
export function joinsTogether(timeline: TimelineState): readonly string[] {
  const together: string[] = [];
  for (const [id, state] of Object.entries(timeline.joins ?? {})) {
    const join = wholeJoin(id, state);
    const sides = join && [entryOf(timeline.clips, join.from), entryOf(timeline.clips, join.to)];
    if (join && sides && nextTo(sides[0], sides[1], join.track)) together.push(id);
  }
  return together;
}

/**
 * What a change did to joins whose clips were next to each other: a join goes along while both of
 * them still are, also to another track, and goes in the same step when they no longer are. That
 * can be taken back as a whole. Joins that two windows or a file left between clips that are apart
 * are not about this: they stay as they are, doing nothing, until somebody fixes them. Says which
 * joins went.
 */
export function followJoins(
  draft: Draft,
  timeline: string,
  together: readonly string[],
): readonly string[] {
  const gone: string[] = [];
  for (const id of together) {
    const now = timelineOf(draft, timeline);
    // One that went along with a clip of it is no matter.
    const join = wholeJoin(id, entryOf(now.joins, id));
    if (!join) continue;
    const from = entryOf(now.clips, join.from);
    const to = entryOf(now.clips, join.to);
    if (from && nextTo(from, to)) {
      if (from.track !== join.track) draft.set([...joinPath(timeline, id), "track"], from.track);
      continue;
    }
    draft.delete(joinPath(timeline, id));
    gone.push(id);
  }
  return gone;
}

/**
 * Cuts one clip in two, and returns the id of the part after the cut. Both parts keep all keys: on
 * the clock of the clip they are in the same place as before, so nothing has to be calculated. The
 * part before keeps the transition at the start and the part after the one at the end, each as long
 * as the part can take, and a join from the clip goes from the part after the cut.
 */
export function splitClip(
  draft: Draft,
  timeline: string,
  clip: ClipState,
  at: Rational,
  rightId: string,
  rightLink?: string,
): void {
  const { enter, exit } = joinsAtEdgesOf(timelineOf(draft, timeline), clip.id);
  const { enter: _enter, offset: _offset, ...rest } = clip;
  const offset = add(clipOffset(clip), subtract(at, clipStart(clip)));
  const rightLength = subtract(clipEnd(clip), at);
  draft.note({ kind: "cut", clip: clip.id, piece: rightId });
  draft.set(clipPath(timeline, rightId), {
    ...rest,
    id: rightId,
    start: formatTime(at),
    duration: formatTime(rightLength),
    offset: formatTime(offset),
    ...(rightLink === undefined ? {} : { link: rightLink }),
  });
  for (const [id, join] of Object.entries(timelineOf(draft, timeline).joins ?? {})) {
    if (join.from === clip.id) draft.set([...joinPath(timeline, id), "from"], rightId);
  }
  const right = { ...rest, id: rightId };
  const leaving = exit && { exit: { ...exit, from: rightId } };
  fitTransitions(draft, timeline, right, rightLength, "start", leaving);
  // What a version changes goes for both parts, apart from where they are.
  forEachOverride(draft, timeline, clip.id, (changes, _path, version) => {
    const { start: _start, duration: _duration, offset: _changed, ...shared } = changes;
    if (Object.keys(shared).length === 0) return;
    const target = [...timelinePath(timeline), "overrides", version, "clips", rightId];
    draft.set(target, shared);
  });
  const path = clipPath(timeline, clip.id);
  const leftLength = subtract(at, clipStart(clip));
  draft.set([...path, "duration"], formatTime(leftLength));
  if (clip.exit !== undefined) draft.delete([...path, "exit"]);
  const { exit: _exit, ...left } = clip;
  fitTransitions(draft, timeline, left, leftLength, "end", enter && { enter });
}

/** Takes away the part of a clip under a span. What comes after a cut is not looked at again. */
function cutOut(draft: Draft, timeline: string, id: string, span: Span): void {
  const clip = entryOf(timelineOf(draft, timeline).clips, id);
  if (!clip || !overlap(spanOf(clip), span)) return;
  const { from, to } = spanOf(clip);
  const before = compare(from, span.from) < 0;
  const after = compare(to, span.to) > 0;
  if (before && after) {
    splitClip(draft, timeline, clip, span.to, newId("clip"));
    const left = entryOf(timelineOf(draft, timeline).clips, id) as ClipState;
    trimClip(draft, timeline, left, { from, to: span.from });
  } else if (before) {
    trimClip(draft, timeline, clip, { from, to: span.from });
  } else if (after) {
    trimClip(draft, timeline, clip, { from: span.to, to });
  } else {
    removeClips(draft, timeline, [id]);
  }
}

/**
 * Makes room on a track, the way dropping clips does in an editor: what is under them goes. A clip
 * can be under several of them. From the last one back, what stays keeps its id.
 */
export function clearSpans(
  draft: Draft,
  timeline: string,
  track: string,
  spans: readonly Span[],
  moving: ReadonlySet<string>,
): void {
  for (const { clip, spans: touched } of clipsInTheWay(
    timelineOf(draft, timeline),
    track,
    spans,
    moving,
  )) {
    for (const span of touched.toReversed()) cutOut(draft, timeline, clip.id, span);
  }
}

/** A timeline is as long as its sections, so something placed past the end makes the last longer. */
export function extendToFit(draft: Draft, timeline: string, end: Rational): void {
  const target = timelineOf(draft, timeline);
  const missing = subtract(end, timelineLength(target));
  const last = orderedSections(target).at(-1);
  if (compare(missing, ZERO) <= 0 || !last) return;
  const path = [...timelinePath(timeline), "sections", last.id, "duration"];
  draft.set(path, formatTime(add(parseTime(last.duration), missing)));
}
