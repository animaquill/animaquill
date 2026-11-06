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
  return draft.state.timelines[id] ?? fail("not-found", `没有这条时间轴：${id}`);
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

type ClipChanges = NonNullable<Overrides["clips"]>[string];

/** What the versions of a timeline change about a clip. */
function forEachOverride(
  draft: Draft,
  timeline: string,
  clip: string,
  visit: (changes: ClipChanges, path: readonly string[], version: string) => void,
): void {
  for (const [version, override] of Object.entries(timelineOf(draft, timeline).overrides)) {
    const changes = override.clips?.[clip];
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

/**
 * Moves the edges of a clip. Its content stays where it is on the timeline, and so do keys: they are
 * on the clock of the clip, which only has to read differently at the new first frame.
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
  const duration = formatTime(subtract(span.to, span.from));
  if (duration !== clip.duration) draft.set([...path, "duration"], duration);
}

/**
 * Cuts one clip in two, and returns the id of the part after the cut. Both parts keep all keys: on
 * the clock of the clip they are in the same place as before, so nothing has to be calculated.
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
  draft.set(clipPath(timeline, rightId), {
    ...rest,
    id: rightId,
    start: formatTime(at),
    duration: formatTime(subtract(clipEnd(clip), at)),
    offset: formatTime(offset),
    ...(rightLink === undefined ? {} : { link: rightLink }),
  });
  // What a version changes goes for both parts, apart from where they are.
  forEachOverride(draft, timeline, clip.id, (changes, _path, version) => {
    const { start: _start, duration: _duration, offset: _changed, ...shared } = changes;
    if (Object.keys(shared).length === 0) return;
    const target = [...timelinePath(timeline), "overrides", version, "clips", rightId];
    draft.set(target, shared);
  });
  const path = clipPath(timeline, clip.id);
  draft.set([...path, "duration"], formatTime(subtract(at, clipStart(clip))));
  if (clip.fadeOut !== undefined) draft.delete([...path, "fadeOut"]);
  for (const transition of Object.values(timelineOf(draft, timeline).transitions)) {
    if (transition.from === clip.id) {
      const transitionPath = [...timelinePath(timeline), "transitions", transition.id];
      draft.set([...transitionPath, "from"], rightId);
    }
  }
}

/** Takes away the part of a clip under a span. What comes after a cut is not looked at again. */
function cutOut(draft: Draft, timeline: string, id: string, span: Span): void {
  const clip = timelineOf(draft, timeline).clips[id];
  if (!clip || !overlap(spanOf(clip), span)) return;
  const { from, to } = spanOf(clip);
  const before = compare(from, span.from) < 0;
  const after = compare(to, span.to) > 0;
  if (before && after) {
    splitClip(draft, timeline, clip, span.to, newId("clip"));
    const left = timelineOf(draft, timeline).clips[id] as ClipState;
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
