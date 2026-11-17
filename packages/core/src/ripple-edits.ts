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
  trimClip,
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

const NONE: ReadonlySet<string> = new Set();

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
  const together = joinsTogether(timelineOf(draft, timeline));
  const closed = closeRoom(draft, timeline, spans, tracks);
  return { ...closed, joinsRemoved: followJoins(draft, timeline, together) };
}

/** As `closeGaps`, apart from joins: whoever calls it follows them, see `followJoins`. */
export function closeRoom(
  draft: Draft,
  timeline: string,
  spans: readonly Span[],
  tracks: RippleTracks,
  aside: ReadonlySet<string> = NONE,
): Omit<Rippled, "joinsRemoved"> {
  const target = timelineOf(draft, timeline);
  const gaps = mergeSpans(spans);
  const listed = isRippling(tracks);
  // Clips `aside` take no part at all, such as those that a ripple trim changes itself.
  const rippling = (clip: ClipState) => !aside.has(clip.id) && listed(clip);
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
      (clip) => !aside.has(clip.id) && !listed(clip) && compare(clipEnd(clip), first.from) > 0,
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
  const reach = reachOf(timelineOf(draft, timeline));
  extendToFit(draft, timeline, compare(reach, length) < 0 ? reach : length);
  return { moved, sectionsRemoved };
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
 * Clips `aside` take no part at all, such as those that a move puts there. Sections and markers
 * make room too, see `openingPlan`, when all of the timeline from `at` on moves; and in any case the
 * timeline ends no earlier than what is on it. Taking the same stretch out again with `closeGaps`
 * puts every clip back where it was, apart from the cuts and joins across `at`.
 */
export function openGap(
  draft: Draft,
  timeline: string,
  at: Rational,
  length: Rational,
  tracks: RippleTracks,
  aside: ReadonlySet<string> = NONE,
): Opened {
  const together = joinsTogether(timelineOf(draft, timeline));
  const opened = openRoom(draft, timeline, at, length, tracks, aside);
  return { ...opened, joinsRemoved: followJoins(draft, timeline, together) };
}

/** As `openGap`, apart from joins: whoever calls it follows them, see `followJoins`. */
export function openRoom(
  draft: Draft,
  timeline: string,
  at: Rational,
  length: Rational,
  tracks: RippleTracks,
  aside: ReadonlySet<string> = NONE,
): Omit<Opened, "joinsRemoved"> {
  const target = timelineOf(draft, timeline);
  const rippling = isRippling(tracks);
  const takesPart = (clip: ClipState) => !aside.has(clip.id) && rippling(clip);
  const crossing = (clip: ClipState) =>
    compare(clipStart(clip), at) < 0 && compare(clipEnd(clip), at) > 0;
  const links = new PieceLinks();
  for (const clip of Object.values(target.clips)) {
    if (takesPart(clip) && crossing(clip)) links.expect(clip.link, at);
  }
  const moved: string[] = [];
  const split: { clip: string; piece: string }[] = [];
  const later = (clip: string, from: Rational) =>
    draft.set([...clipPath(timeline, clip), "start"], formatTime(add(from, length)));
  // Cuts first, while what is on each side is still next to it, so that joins there fit the parts.
  for (const clip of Object.values(target.clips)) {
    if (!takesPart(clip) || !crossing(clip)) continue;
    const piece = newId("clip");
    splitClip(draft, timeline, clip, at, piece, links.linkFor(clip.link, at));
    split.push({ clip: clip.id, piece });
  }
  for (const clip of Object.values(target.clips)) {
    if (!takesPart(clip) || compare(clipStart(clip), at) < 0) continue;
    later(clip.id, clipStart(clip));
    moved.push(clip.id);
  }
  for (const { piece } of split) later(piece, at);
  // As `closeGaps`: sections and markers make room only when all of the timeline from `at` on
  // moves. Past the end there is nothing to make room in.
  const stays = Object.values(target.clips).some(
    (clip) => !aside.has(clip.id) && !rippling(clip) && compare(clipEnd(clip), at) > 0,
  );
  if (!stays && compare(at, timelineLength(target)) <= 0) {
    applyGapPlan(draft, timeline, openingPlan(timelineOf(draft, timeline), at, length));
  }
  // What moved on can end past the end, when sections stayed or it was there already.
  extendToFit(draft, timeline, reachOf(timelineOf(draft, timeline)));
  return { moved, split };
}

/** Where the last clip of a timeline ends. */
function reachOf(timeline: TimelineState): Rational {
  let reach = ZERO;
  for (const clip of Object.values(timeline.clips)) {
    const end = clipEnd(clip);
    if (compare(end, reach) > 0) reach = end;
  }
  return reach;
}

/** What a ripple trim did, apart from the trim: see `rippleTrim`. */
export interface RippleTrimmed extends Rippled {
  readonly split: readonly { readonly clip: string; readonly piece: string }[];
}

/**
 * Trims clips as a ripple trim does in an editor. The first clip has the edge that moves, and the
 * moment it moves from is where the ripple is: on the tracks that ripple (and those of the clips),
 * what starts there or later moves along by as much as the clip gets longer or shorter. Time that
 * goes is taken out as `closeRoom` does, which fails with `ripple-blocked` when something is in it;
 * time that comes is put in as `openRoom` does. The other clips, such as the sound linked to a
 * picture that is longer or shorter than it, have the same edge trimmed by the same amount, so that
 * they stay in step: they are neither cut nor pushed. At the start, every clip stays where it starts
 * and what it shows moves instead. A partner of theirs that is across the moment where time comes
 * in and is not among them would be cut and pushed out of step, so that fails with
 * `ripple-blocked`; so does a clip on their tracks that a clip growing would run into. A join at an
 * edge that moves stays where its clips are together again, shorter where it has to be.
 */
export function rippleTrim(
  draft: Draft,
  timeline: string,
  clips: readonly string[],
  edge: "start" | "end",
  to: Rational,
  tracks: RippleTracks,
): RippleTrimmed {
  const before = timelineOf(draft, timeline);
  const fresh = (id: string) => timelineOf(draft, timeline).clips[id] as ClipState;
  const [first] = clips;
  const none = { moved: [], split: [], joinsRemoved: [], sectionsRemoved: [] };
  if (first === undefined) return none;
  const main = fresh(first);
  const at = edge === "end" ? clipEnd(main) : clipStart(main);
  // How much longer the clips get: less than zero for shorter.
  const by = edge === "end" ? subtract(to, at) : subtract(at, to);
  if (compare(by, ZERO) === 0) return none;
  const together = joinsTogether(before);
  const ownTracks = tracks && [...new Set([...tracks, ...clips.map((id) => fresh(id).track)])];
  const rippling = isRippling(ownTracks);
  const trimmed = new Set(clips);
  const wasSpans = new Map(clips.map((id) => [id, spanOf(fresh(id))]));

  const growing = compare(by, ZERO) > 0;
  // Partners that are not trimmed must not come out of step with those that are. One across the
  // moment would be cut and pushed. At the end, what the trimmed clips show stays where it is, so
  // a partner at the same time as one of them that moves along comes apart from it; at the start,
  // what they show moves along, so one at the same time that stays comes apart.
  const groupOf = new Map<string, Span[]>();
  for (const id of clips) {
    const { link } = fresh(id);
    if (link !== undefined) groupOf.set(link, [...(groupOf.get(link) ?? []), spanOf(fresh(id))]);
  }
  const astray = Object.values(before.clips).filter((clip) => {
    const spans = clip.link === undefined ? undefined : groupOf.get(clip.link);
    if (!spans || trimmed.has(clip.id)) return false;
    const takesPart = rippling(clip);
    if (
      growing &&
      takesPart &&
      compare(clipStart(clip), at) < 0 &&
      compare(clipEnd(clip), at) > 0
    ) {
      return true;
    }
    const moves = takesPart && compare(clipStart(clip), at) >= 0;
    if (moves === (edge === "start")) return false;
    const own = spanOf(clip);
    return spans.some((span) => compare(span.from, own.to) < 0 && compare(own.from, span.to) < 0);
  });
  if (astray.length > 0) blocked(astray);

  /** Each clip one edge further, as long as it is: at the start it stays where it starts. */
  const trimEach = () => {
    for (const id of clips) {
      const clip = fresh(id);
      const { from, to: end } = spanOf(clip);
      if (edge === "end") {
        trimClip(draft, timeline, clip, { from, to: add(end, by) }, true);
      } else if (growing) {
        // Later by as much, and then back to where it starts with what it shows in front.
        draft.set([...clipPath(timeline, id), "start"], formatTime(add(from, by)));
        trimClip(draft, timeline, fresh(id), { from, to: add(end, by) }, true);
      } else {
        trimClip(draft, timeline, clip, { from: subtract(from, by), to: end }, true);
        draft.set([...clipPath(timeline, id), "start"], formatTime(from));
      }
    }
  };

  let moved: readonly string[] = [];
  let split: readonly { clip: string; piece: string }[] = [];
  let sectionsRemoved: readonly string[] = [];
  if (growing) {
    const opened = openRoom(draft, timeline, at, by, ownTracks, trimmed);
    ({ moved, split } = opened);
    trimEach();
  } else {
    trimEach();
    const length = subtract(ZERO, by);
    const gap =
      edge === "end" ? { from: subtract(at, length), to: at } : { from: at, to: add(at, length) };
    const closed = closeRoom(draft, timeline, [gap], ownTracks, trimmed);
    ({ moved, sectionsRemoved } = closed);
  }

  // A trimmed clip must not run into what is on its track now, another trimmed one too: what they
  // share with each other may not grow.
  const pieces = new Map(split.map(({ clip, piece }) => [piece, clip]));
  const now = timelineOf(draft, timeline);
  const shared = (a: Span, b: Span) => {
    const from = compare(a.from, b.from) >= 0 ? a.from : b.from;
    const end = compare(a.to, b.to) <= 0 ? a.to : b.to;
    return compare(end, from) > 0 ? subtract(end, from) : ZERO;
  };
  const inTheWay = Object.values(now.clips).filter((clip) => {
    const was = before.clips[pieces.get(clip.id) ?? clip.id];
    return clips.some((id) => {
      const grown = fresh(id);
      if (id === clip.id || grown.track !== clip.track) return false;
      const old = was ? shared(wasSpans.get(id) as Span, spanOf(was)) : ZERO;
      return compare(shared(spanOf(grown), spanOf(clip)), old) > 0;
    });
  });
  if (inTheWay.length > 0) blocked(inTheWay);

  extendToFit(draft, timeline, reachOf(timelineOf(draft, timeline)));
  const joinsRemoved = followJoins(draft, timeline, together);
  return { moved, split, joinsRemoved, sectionsRemoved };
}

function blocked(clips: readonly ClipState[]): never {
  const ordered = clips.toSorted((a, b) => compare(clipStart(a), clipStart(b)));
  return fail("ripple-blocked", {
    clips: ordered.map((clip) => named(clip)),
    tracks: [...new Set(ordered.map(({ track }) => track))],
  });
}
