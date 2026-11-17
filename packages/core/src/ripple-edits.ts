import {
  ZERO,
  add,
  newId,
  compare,
  divide,
  formatTime,
  parseTime,
  rational,
  subtract,
  type Rational,
} from "@animaquill/schema";
import {
  PieceLinks,
  clipPath,
  cutOut,
  expectCut,
  extendToFit,
  splitClip,
  followJoins,
  joinsTogether,
  spanOf,
  timelineOf,
  type Span,
} from "./clip-edits.ts";
import type { Draft } from "./draft.ts";
import { fail, named } from "./failures.ts";
import {
  clipEnd,
  clipStart,
  entryOf,
  projectFrameRate,
  timelineLength,
  type ClipState,
  type TimelineState,
} from "./model.ts";
import { applyGapPlan, closingPlan, openingPlan } from "./section-edits.ts";

/*
 * Ripple edits: taking stretches out of a timeline, so that what comes after them moves back by as
 * much. On the tracks that ripple, which are all of them unless the edit names some (the editor
 * leaves out those that people locked), the stretches have to be empty, or nothing happens:
 * moving one track and not another would take apart what belongs together in time. Sections and
 * markers move back with what is on the timeline.
 */

/** What a ripple edit moved and took away along with it. */
export interface Rippled {
  /** Clips that moved back, by id. */
  readonly moved: readonly string[];
  readonly joinsRemoved: readonly string[];
  readonly sectionsRemoved: readonly string[];
}

/** Which clips a ripple edit is about: those on the tracks it names, or all of them. */
export type RippleTracks = readonly string[] | undefined;

const isRippling = (tracks: RippleTracks) => {
  const listed = tracks && new Set(tracks);
  return (clip: ClipState) => listed === undefined || listed.has(clip.track);
};

/**
 * Tracks that an edit names have to be there. A track that is gone can still have clips that two
 * people at once left behind, and those can ripple too.
 */
export function checkTracks(timeline: TimelineState, tracks: RippleTracks): void {
  if (tracks === undefined) return;
  const ofClips = new Set(Object.values(timeline.clips).map(({ track }) => track));
  for (const track of tracks) {
    if (!entryOf(timeline.tracks, track) && !ofClips.has(track)) {
      fail("not-found", { kind: "track", id: track });
    }
  }
}

/**
 * Stretches in time order, those that overlap or touch as one: taking out a moment twice is
 * taking it out once.
 */
export function mergeSpans(spans: readonly Span[]): readonly Span[] {
  const sorted = spans.toSorted((a, b) => compare(a.from, b.from));
  const merged: Span[] = [];
  for (const span of sorted) {
    const last = merged.at(-1);
    if (last && compare(span.from, last.to) <= 0) {
      if (compare(span.to, last.to) > 0)
        merged[merged.length - 1] = { from: last.from, to: span.to };
    } else merged.push(span);
  }
  return merged;
}

/** Checks that a stretch starts before it ends and is within the timeline. */
export function checkSpan(timeline: TimelineState, span: Span, path: string, toPath = path): void {
  if (compare(span.from, span.to) >= 0) {
    fail("invalid-value", {
      rule: "range-backwards",
      path,
      from: formatTime(span.from),
      to: formatTime(span.to),
    });
  }
  const length = timelineLength(timeline);
  if (compare(span.to, length) > 0) {
    fail("invalid-value", {
      rule: "range-outside",
      path: toPath,
      to: formatTime(span.to),
      length: formatTime(length),
    });
  }
}

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

const ONE = rational(1n);

/** One frame of the project: the shortest a section can be. */
function oneFrame(draft: Draft): Rational {
  try {
    const rate = parseTime(projectFrameRate(draft.state.manifest));
    if (rate.n > 0n) return divide(ONE, rate);
  } catch {
    // A rate that is no rate is a problem of the format; a thirtieth of a second does then.
  }
  return rational(1n, 30n);
}

/**
 * Takes stretches out of a timeline: clips on the tracks that ripple that start at the end of one
 * or later move back by as much, and by all of those before them together. On those tracks, the
 * stretches have to be empty, or this fails with `ripple-blocked` and writes nothing. Sections
 * and markers move back with the timeline, see `closingPlan`, but only when all of it moves: a
 * track that does not ripple and has something after the first stretch keeps them where they are.
 * Joins go along while their clips stay together. A clip on a track that does not ripple and now ends past the end of the timeline makes
 * its last section longer again, as far as it was. Stretches go through `mergeSpans` first.
 */
export function closeGaps(
  draft: Draft,
  timeline: string,
  spans: readonly Span[],
  tracks: RippleTracks,
): Rippled {
  const target = timelineOf(draft, timeline);
  const gaps = mergeSpans(spans);
  const rippling = isRippling(tracks);
  const clips = Object.values(target.clips).filter(rippling);

  const blocking = clips.filter((clip) => {
    const { from, to } = spanOf(clip);
    const gap = gaps[firstEndingAfter(gaps, from)];
    return gap !== undefined && compare(gap.from, to) < 0;
  });
  if (blocking.length > 0) {
    const ordered = blocking.toSorted((a, b) => compare(clipStart(a), clipStart(b)));
    fail("ripple-blocked", {
      clips: ordered.map((clip) => named(clip)),
      tracks: [...new Set(ordered.map(({ track }) => track))],
    });
  }

  // How far back what starts after each gap goes: all gaps up to it together.
  const back: Rational[] = [];
  let total = ZERO;
  for (const { from, to } of gaps) {
    total = add(total, subtract(to, from));
    back.push(total);
  }
  const length = timelineLength(target);
  const together = joinsTogether(target);
  const moved: string[] = [];
  for (const clip of clips) {
    // The gaps that end at its start or before, which are all those before it.
    const after = firstEndingAfter(gaps, clipStart(clip));
    if (after === 0) continue;
    const by = back[after - 1] as Rational;
    draft.set([...clipPath(timeline, clip.id), "start"], formatTime(subtract(clipStart(clip), by)));
    moved.push(clip.id);
  }

  // Sections and markers are about the whole timeline: they move only when all of it from the
  // first gap on moves, with no track that stays there and has something after that moment.
  const first = gaps[0];
  const stays =
    first !== undefined &&
    Object.values(target.clips).some(
      (clip) => !rippling(clip) && compare(clipEnd(clip), first.from) > 0,
    );
  // From the last gap back, so that each is still where it was.
  const least = oneFrame(draft);
  const sectionsRemoved: string[] = [];
  for (const { from, to } of stays ? [] : gaps.toReversed()) {
    const plan = closingPlan(timelineOf(draft, timeline), from, to, least);
    applyGapPlan(draft, timeline, plan);
    sectionsRemoved.push(...plan.removed);
  }

  // What stayed where it was can now be past the end, which must not cut it off.
  let reach = ZERO;
  for (const clip of Object.values(timelineOf(draft, timeline).clips)) {
    const end = clipEnd(clip);
    if (compare(end, reach) > 0) reach = end;
  }
  extendToFit(draft, timeline, compare(reach, length) < 0 ? reach : length);

  const joinsRemoved = followJoins(draft, timeline, together);
  return { moved, joinsRemoved, sectionsRemoved };
}

/** What taking a stretch out of tracks did to the clips on them. */
export interface Lifted {
  /** Clips that were all in there, by id. */
  readonly removed: readonly string[];
  /** Clips that went on before and after it, which are two parts now: the clip and its piece. */
  readonly split: readonly { readonly clip: string; readonly piece: string }[];
}

/**
 * Takes away what is on tracks in a stretch of time, as lifting does in an editor: clips all in
 * there go, clips across an end of it lose that part, and clips across all of it become two parts,
 * the one after it with a new id. Linked parts after the cut get a link of their own, see
 * `PieceLinks`. The stretch stays, empty.
 */
export function liftSpan(draft: Draft, timeline: string, span: Span, tracks: RippleTracks): Lifted {
  const rippling = isRippling(tracks);
  const touched = Object.values(timelineOf(draft, timeline).clips).filter((clip) => {
    if (!rippling(clip)) return false;
    return compare(clipStart(clip), span.to) < 0 && compare(clipEnd(clip), span.from) > 0;
  });
  const links = new PieceLinks();
  for (const clip of touched) expectCut(clip, span, links);
  const removed: string[] = [];
  const split: { clip: string; piece: string }[] = [];
  for (const clip of touched) {
    const what = cutOut(draft, timeline, clip.id, span, links);
    if (what?.kind === "removed") removed.push(clip.id);
    else if (what?.kind === "split") split.push({ clip: clip.id, piece: what.piece });
  }
  return { removed, split };
}

/** What putting a stretch into a timeline did: which clips moved on, and which it cut in two. */
export interface Opened {
  readonly moved: readonly string[];
  readonly split: readonly { readonly clip: string; readonly piece: string }[];
  readonly joinsRemoved: readonly string[];
}

/**
 * Puts a stretch of `length` into a timeline at `at`, as inserting does in an editor: on the tracks
 * that ripple, clips from `at` on move on by as much, and a clip across `at` is cut there, its part
 * after the cut moving on with them (linked parts get a link of their own, see `PieceLinks`).
 * Sections and markers make room too, see `openingPlan`, when all of the timeline from `at` on moves. Taking the same stretch out again with
 * `closeGaps` puts everything back where it was, apart from the cuts and joins across `at`.
 */
export function openGap(
  draft: Draft,
  timeline: string,
  at: Rational,
  length: Rational,
  tracks: RippleTracks,
): Opened {
  const target = timelineOf(draft, timeline);
  const rippling = isRippling(tracks);
  const together = joinsTogether(target);
  const crossing = (clip: ClipState) =>
    compare(clipStart(clip), at) < 0 && compare(clipEnd(clip), at) > 0;
  const links = new PieceLinks();
  for (const clip of Object.values(target.clips)) {
    if (rippling(clip) && crossing(clip)) links.expect(clip.link, at);
  }
  const moved: string[] = [];
  const split: { clip: string; piece: string }[] = [];
  const later = (clip: string, from: Rational) =>
    draft.set([...clipPath(timeline, clip), "start"], formatTime(add(from, length)));
  for (const clip of Object.values(target.clips)) {
    if (!rippling(clip)) continue;
    if (compare(clipStart(clip), at) >= 0) {
      later(clip.id, clipStart(clip));
      moved.push(clip.id);
    } else if (crossing(clip)) {
      const piece = newId("clip");
      splitClip(draft, timeline, clip, at, piece, links.linkFor(clip.link, at));
      later(piece, at);
      split.push({ clip: clip.id, piece });
    }
  }
  // As `closeGaps`: sections and markers make room only when all of the timeline from `at` on moves.
  // Then nothing makes the timeline longer either, and what moved on can end past its end. Nothing
  // uses this yet: insert (P3b) has to make room for that first, as `extendToFit` does for drops.
  const stays = Object.values(target.clips).some(
    (clip) => !rippling(clip) && compare(clipEnd(clip), at) > 0,
  );
  if (!stays) applyGapPlan(draft, timeline, openingPlan(timelineOf(draft, timeline), at, length));
  return { moved, split, joinsRemoved: followJoins(draft, timeline, together) };
}
