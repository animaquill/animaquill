import {
  ZERO,
  add,
  compare,
  formatTime,
  isAnimation,
  newId,
  parseTime,
  subtract,
  type Animation,
  type Overrides,
  type PropertyValue,
  type Rational,
} from "@animaquill/schema";
import { fail, type Draft } from "./draft.ts";
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

/** Takes clips away, and with them the side of a transition that was theirs. */
export function removeClips(draft: Draft, timeline: string, clips: readonly string[]): void {
  const removed = new Set(clips);
  const { transitions } = timelineOf(draft, timeline);
  for (const id of clips) draft.delete(clipPath(timeline, id));
  for (const transition of Object.values(transitions)) {
    const path = [...timelinePath(timeline), "transitions", transition.id];
    const from = transition.from && removed.has(transition.from);
    const to = transition.to && removed.has(transition.to);
    if (!from && !to) continue;
    const keepsSide = (!from && transition.from) || (!to && transition.to);
    if (!keepsSide) draft.delete(path);
    else draft.delete([...path, from ? "from" : "to"]);
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

/** A fade as it is saved, or undefined when there is none or it cannot be read. */
function fadeLength(time: string | undefined): Rational | undefined {
  if (time === undefined) return undefined;
  try {
    return parseTime(time);
  } catch {
    return undefined;
  }
}

const atMost = (value: Rational, limit: Rational) => (compare(value, limit) > 0 ? limit : value);

/**
 * Shortens the fades of a clip that got too short for them, as video editors do: first the fade at
 * the edge that moved, then the other one, so that what is left of the clip fades as it did. A fade
 * of nothing goes. What fits, or cannot be read, stays as it is.
 */
function fitFades(
  draft: Draft,
  path: readonly string[],
  clip: Pick<ClipState, "fadeIn" | "fadeOut">,
  duration: Rational,
  moved: "start" | "end",
): void {
  const fadeIn = fadeLength(clip.fadeIn);
  const fadeOut = fadeLength(clip.fadeOut);
  if (!fadeIn && !fadeOut) return;
  const total = add(fadeIn ?? ZERO, fadeOut ?? ZERO);
  if (compare(total, duration) <= 0) return;
  type Field = "fadeIn" | "fadeOut";
  const [near, far]: [Field, Field] =
    moved === "start" ? ["fadeIn", "fadeOut"] : ["fadeOut", "fadeIn"];
  const lengths: Record<Field, Rational> = { fadeIn: fadeIn ?? ZERO, fadeOut: fadeOut ?? ZERO };
  const kept = atMost(lengths[far], duration);
  const shortened = { [far]: kept, [near]: atMost(lengths[near], subtract(duration, kept)) };
  for (const field of [near, far]) {
    if (clip[field] === undefined) continue;
    const length = shortened[field] as Rational;
    if (compare(length, lengths[field]) === 0) continue;
    if (compare(length, ZERO) <= 0) draft.delete([...path, field]);
    else draft.set([...path, field], formatTime(length));
  }
}

/**
 * Moves the edges of a clip. Its content stays where it is on the timeline, and so do keys: they are
 * on the clock of the clip, which only has to read differently at the new first frame. Fades that
 * no longer fit get shorter, see `fitFades`.
 */
export function trimClip(draft: Draft, timeline: string, clip: ClipState, span: Span): void {
  const path = clipPath(timeline, clip.id);
  const moved = subtract(span.from, clipStart(clip));
  // Only what changes gets written. Somebody else can move this clip while its end is trimmed.
  if (compare(moved, ZERO) !== 0) {
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
  fitFades(draft, path, clip, length, compare(moved, ZERO) !== 0 ? "start" : "end");
}

/**
 * Cuts one clip in two, and returns the id of the part after the cut. Both parts keep all keys: on
 * the clock of the clip they are in the same place as before, so nothing has to be calculated. The
 * part before keeps the fade in and the part after the fade out, each as long as the part can take.
 */
export function splitClip(
  draft: Draft,
  timeline: string,
  clip: ClipState,
  at: Rational,
  rightId: string,
  rightLink?: string,
): void {
  const { fadeIn: _fadeIn, offset: _offset, ...rest } = clip;
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
  fitFades(draft, clipPath(timeline, rightId), rest, rightLength, "start");
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
  if (clip.fadeOut !== undefined) draft.delete([...path, "fadeOut"]);
  const { fadeOut: _fadeOut, ...left } = clip;
  fitFades(draft, path, left, leftLength, "end");
  for (const transition of Object.values(timelineOf(draft, timeline).transitions)) {
    if (transition.from === clip.id) {
      const transitionPath = [...timelinePath(timeline), "transitions", transition.id];
      draft.set([...transitionPath, "from"], rightId);
    }
  }
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
