import { ZERO, add, compare, formatTime, subtract, type Rational } from "@animaquill/schema";
import {
  clipPath,
  extendToFit,
  followJoins,
  isTimeless,
  joinsAtEdges,
  joinsTogether,
  moveClockForward,
  setOffset,
  spanOf,
  timelineOf,
  trimClip,
  type Span,
} from "./clip-edits.ts";
import { fail, type Draft } from "./draft.ts";
import { nameOf, named } from "./failures.ts";
import {
  clipEnd,
  clipOffset,
  clipStart,
  entryOf,
  sourceLength,
  type ClipState,
  type TimelineState,
} from "./model.ts";

/*
 * Slip, slide and roll, as video editors have them: edits that change what clips show or where
 * their edges are, and keep the time they take together as it is. None of them moves anything
 * else, and none of them puts a clip on another: what clips share on a track may not grow.
 */

function clipIn(timeline: TimelineState, id: string): ClipState {
  return entryOf(timeline.clips, id) ?? fail("not-found", { kind: "clip", id });
}

/** How much two stretches share, or zero. */
function shared(a: Span, b: Span): Rational {
  const from = compare(a.from, b.from) >= 0 ? a.from : b.from;
  const to = compare(a.to, b.to) <= 0 ? a.to : b.to;
  return compare(to, from) > 0 ? subtract(to, from) : ZERO;
}

/** The first of spans in time order, apart from each other, that ends after a moment. */
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

/** Stretches in time order, those that overlap or touch as one. */
function merged(spans: readonly Span[]): readonly Span[] {
  const sorted = spans.toSorted((a, b) => compare(a.from, b.from));
  const out: Span[] = [];
  for (const span of sorted) {
    const last = out.at(-1);
    if (last && compare(span.from, last.to) <= 0) {
      if (compare(span.to, last.to) > 0) out[out.length - 1] = { from: last.from, to: span.to };
    } else out.push(span);
  }
  return out;
}

/**
 * Fails with `overlap` when clips at the places an edit gives them (`placed`, by id) would share
 * more time with another clip of their track than they did: sounds can be on top of each other
 * already, which is no matter as long as it does not grow. Only clips under where the placed ones
 * go can be in the way, so the others of the track are looked at once each, and then those go in
 * the order they start, with what is still going on at that moment.
 */
export function checkNoNewOverlap(
  timeline: TimelineState,
  placed: ReadonlyMap<string, Span>,
): void {
  const byTrack = new Map<string, Span[]>();
  for (const [id, span] of placed) {
    const { track } = clipIn(timeline, id);
    const spans = byTrack.get(track);
    if (spans) spans.push(span);
    else byTrack.set(track, [span]);
  }
  for (const [track, spans] of byTrack) {
    const reach = merged(spans);
    const items = Object.values(timeline.clips).flatMap((clip) => {
      if (clip.track !== track) return [];
      const is = placed.get(clip.id);
      if (is) return [{ clip, was: spanOf(clip), is }];
      const was = spanOf(clip);
      const under = reach[firstEndingAfter(reach, was.from)];
      return under && compare(under.from, was.to) < 0 ? [{ clip, was, is: was }] : [];
    });
    items.sort((a, b) => compare(a.is.from, b.is.from));
    let going: typeof items = [];
    for (const item of items) {
      going = going.filter((other) => compare(other.is.to, item.is.from) > 0);
      for (const other of going) {
        if (!placed.has(item.clip.id) && !placed.has(other.clip.id)) continue;
        if (compare(shared(item.is, other.is), shared(item.was, other.was)) > 0) {
          const [a, b] = placed.has(item.clip.id) ? [item, other] : [other, item];
          fail("overlap", { clips: [named(a.clip), named(b.clip)] });
        }
      }
      going.push(item);
    }
  }
}

/** Where a clock reads at the end of a clip at a span, and whether its media goes on that long. */
function checkSource(draft: Draft, clip: ClipState, span: Span): void {
  const offset = add(clipOffset(clip), subtract(span.from, clipStart(clip)));
  if (compare(offset, ZERO) < 0 && !isTimeless(clip)) {
    fail("source-start", { clip: clip.id, ...nameOf(clip) });
  }
  const length = sourceLength(draft.state, clip);
  const clockAtEnd = add(clipOffset(clip), subtract(span.to, clipStart(clip)));
  if (length && compare(clockAtEnd, length) > 0) {
    fail("source-end", { clip: clip.id, ...nameOf(clip) });
  }
}

function checkSpan(clip: ClipState, span: Span): void {
  if (compare(span.from, ZERO) < 0) fail("invalid-value", { rule: "before-zero", clip: clip.id });
  if (compare(span.to, span.from) <= 0) {
    fail("invalid-value", { rule: "end-before-start", clip: clip.id });
  }
}

/**
 * Trims clips to new spans at once. The joins at their edges are those of before any of them
 * moved, because two clips next to each other that both change are apart in between; a join whose
 * clips still touch afterwards stays, shorter where it has to be (see `followJoins`).
 */
function trimAll(draft: Draft, timeline: string, spans: ReadonlyMap<string, Span>): void {
  const joined = joinsAtEdges(timelineOf(draft, timeline));
  for (const [id, span] of spans) {
    const clip = timelineOf(draft, timeline).clips[id] as ClipState;
    trimClip(draft, timeline, clip, span, true, joined.get(id) ?? {});
  }
}

const keyOf = ({ n, d }: Rational) => `${n}/${d}`;

/** Clips by a moment of theirs, exactly. */
function byMoment(
  clips: readonly ClipState[],
  moment: (clip: ClipState) => Rational,
): ReadonlyMap<string, readonly ClipState[]> {
  const found = new Map<string, ClipState[]>();
  for (const clip of clips) {
    const key = keyOf(moment(clip));
    const list = found.get(key);
    if (list) list.push(clip);
    else found.set(key, [clip]);
  }
  return found;
}

const latestEnd = (spans: Iterable<Span>) => {
  let end = ZERO;
  for (const span of spans) if (compare(span.to, end) > 0) end = span.to;
  return end;
};

/**
 * Slips clips: each stays where it is and as long, and shows what is `by` later on its clock (earlier
 * for less than zero), as if the content went the other way under its frame. Keys are on the clock
 * and go along with what it shows. Media with a beginning cannot slip to before it, nor video or
 * sound past its end; colours, images and captions show the same at any moment, and when their
 * clock would start before zero it moves forward instead, keys and words with it.
 */
export function slipClips(
  draft: Draft,
  timeline: string,
  ids: readonly string[],
  by: Rational,
): void {
  const target = timelineOf(draft, timeline);
  const clips = ids.map((id) => clipIn(target, id));
  for (const clip of clips) {
    const span = spanOf(clip);
    // The same as its frame going by as much over content that stays.
    checkSource(draft, clip, { from: add(span.from, by), to: add(span.to, by) });
  }
  if (compare(by, ZERO) === 0) return;
  for (const clip of clips) {
    const offset = add(clipOffset(clip), by);
    if (compare(offset, ZERO) >= 0) {
      setOffset(draft, timeline, clip, offset);
      continue;
    }
    moveClockForward(draft, timeline, clip, subtract(ZERO, offset));
    setOffset(draft, timeline, timelineOf(draft, timeline).clips[clip.id] as ClipState, ZERO);
  }
}

/**
 * Slides clips: they move by `by` as they are, and the clips right next to them on their track
 * give and take that time, the one before at its end and the one after at its start, so that all
 * of them together cover what they did. Selected clips next to each other on a track slide as one
 * block. Where a block has empty time on a side, that gets longer or shorter instead, and a clip
 * past it is in the way (`overlap`); so is a clip next to it that would have no time left. The
 * clips that give time cannot start before their media nor end after it. Joins at the edges stay:
 * their clips still touch.
 */
export function slideClips(
  draft: Draft,
  timeline: string,
  ids: readonly string[],
  by: Rational,
): readonly string[] {
  const target = timelineOf(draft, timeline);
  const sliding = new Set(ids);
  const clips = ids.map((id) => clipIn(target, id));
  if (compare(by, ZERO) === 0) return [];

  const byTrack = new Map<string, ClipState[]>();
  for (const clip of clips) {
    const own = byTrack.get(clip.track);
    if (own) own.push(clip);
    else byTrack.set(clip.track, [clip]);
  }
  const placed = new Map<string, Span>();
  // What the clips next to the blocks become: each edge that touches a block moves with it.
  const given = new Map<string, { from: Rational; to: Rational }>();
  for (const [track, own] of byTrack) {
    const blocks: { first: ClipState; from: Rational; to: Rational }[] = [];
    for (const clip of own.toSorted((a, b) => compare(clipStart(a), clipStart(b)))) {
      const last = blocks.at(-1);
      if (last && compare(clipStart(clip), last.to) <= 0) {
        if (compare(clipEnd(clip), last.to) > 0) last.to = clipEnd(clip);
      } else blocks.push({ first: clip, from: clipStart(clip), to: clipEnd(clip) });
    }
    const others = Object.values(target.clips).filter(
      (clip) => clip.track === track && !sliding.has(clip.id),
    );
    const ending = byMoment(others, clipEnd);
    const starting = byMoment(others, clipStart);
    const give = (other: ClipState, edge: "from" | "to") => {
      const span = given.get(other.id) ?? { from: clipStart(other), to: clipEnd(other) };
      span[edge] = add(span[edge], by);
      given.set(other.id, span);
    };
    for (const block of blocks) {
      for (const other of ending.get(keyOf(block.from)) ?? []) give(other, "to");
      for (const other of starting.get(keyOf(block.to)) ?? []) give(other, "from");
    }
  }
  for (const clip of clips) {
    const span = { from: add(clipStart(clip), by), to: add(clipEnd(clip), by) };
    checkSpan(clip, span);
    placed.set(clip.id, span);
  }
  for (const [id, span] of given) {
    const clip = clipIn(target, id);
    if (compare(span.to, span.from) <= 0) {
      const block = clips.find((each) => each.track === clip.track) as ClipState;
      fail("overlap", { clips: [named(block), named(clip)] });
    }
    checkSource(draft, clip, span);
    placed.set(id, span);
  }
  checkNoNewOverlap(target, placed);

  const together = joinsTogether(target);
  // The clips that give time first, while the blocks are still next to them.
  trimAll(draft, timeline, given);
  for (const clip of clips) {
    const span = placed.get(clip.id) as Span;
    draft.set([...clipPath(timeline, clip.id), "start"], formatTime(span.from));
  }
  extendToFit(draft, timeline, latestEnd(placed.values()));
  return followJoins(draft, timeline, together);
}

/** An edge of a clip that a roll moves. */
export interface RolledEdge {
  readonly clip: string;
  readonly edge: "start" | "end";
}

/**
 * Rolls edits: the first edge goes to `at`, and the others by as much, such as the sound linked to
 * a picture; the clip right next to each edge on its track has its edge there go along, so that
 * the two together are as long as before. An edge with nothing right next to it is trimmed as
 * `clip.trim` does, and may not run into anything. Neither clip can start before its media nor
 * end after it. A join on the cut goes along, shorter where it has to be.
 */
export function rollEdges(
  draft: Draft,
  timeline: string,
  edges: readonly RolledEdge[],
  at: Rational,
): readonly string[] {
  const target = timelineOf(draft, timeline);
  const edgeOf = (clip: ClipState, edge: "start" | "end") =>
    edge === "start" ? clipStart(clip) : clipEnd(clip);
  const [first] = edges;
  if (first === undefined) return [];
  for (const { clip } of edges) clipIn(target, clip);
  const by = subtract(at, edgeOf(clipIn(target, first.clip), first.edge));
  if (compare(by, ZERO) === 0) return [];

  const moving = new Map<string, { start: boolean; end: boolean }>();
  const mark = (id: string, edge: "start" | "end") => {
    const marks = moving.get(id) ?? { start: false, end: false };
    marks[edge] = true;
    moving.set(id, marks);
  };
  const tracks = new Set(edges.map(({ clip }) => clipIn(target, clip).track));
  const all = Object.values(target.clips).filter((clip) => tracks.has(clip.track));
  const edgesAt = { start: byMoment(all, clipStart), end: byMoment(all, clipEnd) };
  for (const { clip: id, edge } of edges) {
    const clip = clipIn(target, id);
    mark(id, edge);
    const facing = edge === "end" ? "start" : "end";
    for (const other of edgesAt[facing].get(keyOf(edgeOf(clip, edge))) ?? []) {
      if (other.id !== id && other.track === clip.track) mark(other.id, facing);
    }
  }
  const spans = new Map<string, Span>();
  for (const [id, marks] of moving) {
    const clip = clipIn(target, id);
    const span = {
      from: marks.start ? add(clipStart(clip), by) : clipStart(clip),
      to: marks.end ? add(clipEnd(clip), by) : clipEnd(clip),
    };
    checkSpan(clip, span);
    checkSource(draft, clip, span);
    spans.set(id, span);
  }
  checkNoNewOverlap(target, spans);

  const together = joinsTogether(target);
  trimAll(draft, timeline, spans);
  extendToFit(draft, timeline, latestEnd(spans.values()));
  return followJoins(draft, timeline, together);
}
