import {
  BUILT_IN_TRANSITIONS,
  Duration,
  Id,
  JOIN_ALIGNS,
  Join,
  TransitionCurve,
  TransitionShape,
  ZERO,
  compare,
  describeMissing,
  describeUnsupported,
  findTransition,
  formatTime,
  isSupported,
  mediaOfTrack,
  newId,
  parseTime,
  type JoinAlign,
  type Rational,
} from "@animaquill/schema";
import { z } from "zod";
import { joinPath, timelineOf } from "./clip-edits.ts";
import { fail, type Draft } from "./draft.ts";
import {
  chooseAlign,
  joinFits,
  joinedEndsOf,
  longestJoin,
  placedJoins,
  wholeJoin,
  type JoinedEnds,
} from "./joins.ts";
import {
  clipEnd,
  clipStart,
  entryOf,
  type ClipState,
  type JoinTransition,
  type TimelineState,
  type TrackState,
} from "./model.ts";
import { deepEqual } from "./patch.ts";

/**
 * The commands of joins, the transitions on the cut between two clips that follow each other on a
 * track. A join is one value apart from where it is, see `JoinState`: what it is, how long it
 * takes, how it goes and where around the cut. What a command checks is only what it changes, so
 * that a join that a file left wrong can always get another length, or go.
 */

const Align = z.enum(JOIN_ALIGNS);

/** Puts a join on the cut between two clips. What it is goes as in a file, see the project format. */
export const JoinAdd = TransitionShape.extend({
  timeline: Id,
  id: Id.optional(),
  from: Id,
  to: Id,
  /** Without it the transition takes as long as it says it does, or as long as fits, if less. */
  duration: Duration.optional(),
  /** Without it the editor picks by what the clips have past the cut. */
  align: Align.optional(),
});

/**
 * Changes a join. Naming what it is takes the place of all of that: one that is a `type` becomes
 * another `type`, and a variant goes unless it is named again. Null takes a field away.
 */
export const JoinUpdate = z.strictObject({
  timeline: Id,
  join: Id,
  changes: TransitionShape.partial().extend({
    variant: Id.nullable().optional(),
    curve: TransitionCurve.nullable().optional(),
    align: Align.nullable().optional(),
  }),
});

/** Takes joins away. That always works, also for what only some of one is left of. */
export const JoinRemove = z.strictObject({ timeline: Id, joins: z.array(Id).min(1) });

/** A locked track protects its joins from everyone, also from AI tasks. */
function editableTrack(timeline: TimelineState, id: string | undefined): TrackState | undefined {
  const track = id === undefined ? undefined : entryOf(timeline.tracks, id);
  if (track?.locked) fail("track-locked", `轨道已锁定：${track.name ?? id}`);
  return track;
}

/** What a join is, checked: one thing it names, a length and a speed curve the format has. */
function checked(join: Record<string, unknown>): JoinTransition {
  const result = Join.safeParse(join);
  if (!result.success) {
    const issue = result.error.issues[0];
    const where = issue?.path.join(".");
    fail("invalid-value", where ? `${where}：${issue?.message}` : `${issue?.message}`);
  }
  const { id: _id, from: _from, to: _to, ...transition } = result.data as Join;
  return transition;
}

/** A join that comes to a cut has to be one that this editor does there, so that it does it. */
function checkDone(track: TrackState, transition: JoinTransition): void {
  if (track.kind === "caption") fail("wrong-track", "字幕轨道不能放衔接转场");
  const media = mediaOfTrack(track.kind);
  const found = findTransition(transition, media, "join");
  if (found.kind === "missing") fail("transition-missing", describeMissing(found.why));
  else if (!isSupported(found, media, "join")) {
    fail("transition-unsupported", describeUnsupported(found.type, media, "join"));
  }
}

/** How long a transition is when it is put somewhere, as it says itself. */
function defaultLength(track: TrackState, transition: Record<string, unknown>): Rational {
  const { type } = transition as { readonly type?: string };
  const own = BUILT_IN_TRANSITIONS[mediaOfTrack(track.kind)];
  const spec = type !== undefined && Object.hasOwn(own, type) ? own[type] : undefined;
  return parseTime(spec?.duration ?? "0.5");
}

/** The two clips of a cut, as they have to be for a join: on one track, the first ending where the second starts. */
function cutBetween(target: TimelineState, from: string, to: string) {
  const before = entryOf(target.clips, from) ?? fail("not-found", `没有这个片段：${from}`);
  const after = entryOf(target.clips, to) ?? fail("not-found", `没有这个片段：${to}`);
  if (from === to) fail("invalid-value", "衔接转场的两边要是两个片段");
  if (before.track !== after.track) fail("not-adjacent", "衔接转场的两个片段要在同一条轨道上");
  if (compare(clipEnd(before), clipStart(after)) !== 0) {
    fail("not-adjacent", "两个片段之间有空隙，先把它们接上，才能加衔接转场");
  }
  return { before, after };
}

/** The join that this cut has already, which is the one there: another one would do nothing. */
function joinOnCut(target: TimelineState, from: ClipState, to: ClipState): string | undefined {
  for (const [id, { join, place }] of placedJoins(target)) {
    const shares = join.from === from.id || join.to === to.id;
    if (shares && (place.kind === "cut" || place.kind === "hidden")) return id;
  }
  return undefined;
}

function checkFits(
  joined: JoinedEnds,
  from: ClipState,
  to: ClipState,
  duration: Rational,
  align: JoinAlign | undefined,
): void {
  if (joinFits(joined, from, to, duration, align)) return;
  const longest = longestJoin(joined, from, to, align);
  fail("transition-too-long", `衔接转场太长，这里最长 ${formatTime(longest)} 秒`);
}

export function addJoin(draft: Draft, params: z.output<typeof JoinAdd>) {
  const { timeline, id: wanted, from, to, duration, align, ...reference } = params;
  const target = timelineOf(draft, timeline);
  const { before, after } = cutBetween(target, from, to);
  const track =
    editableTrack(target, before.track) ?? fail("not-found", `没有这条轨道：${before.track}`);
  const taken = joinOnCut(target, before, after);
  if (taken !== undefined) {
    fail("join-taken", `这个剪切点已经有衔接转场了：${taken}，要换成别的用 join.update`);
  }
  const id = wanted ?? newId("join");
  if (entryOf(target.joins, id)) fail("id-taken", `这个 ID 已经有衔接转场了：${id}`);
  const joined = joinedEndsOf(target);
  let length = duration === undefined ? defaultLength(track, reference) : parseTime(duration);
  const place = align ?? chooseAlign(draft.state, before, after, length);
  if (duration === undefined) {
    // What it says it takes, or as much as there is room for.
    const longest = longestJoin(joined, before, after, place);
    if (compare(length, longest) > 0) length = longest;
    if (compare(length, ZERO) <= 0) fail("transition-too-long", "这个剪切点两边没有地方放衔接转场");
  }
  const transition = checked({
    id,
    from,
    to,
    ...reference,
    duration: formatTime(length),
    ...(place === "center" ? {} : { align: place }),
  });
  checkDone(track, transition);
  checkFits(joined, before, after, length, place);
  draft.set(joinPath(timeline, id), { track: track.id, from, to, transition });
  return { id, align: place };
}

const REFERENCE = ["type", "transition", "library", "resource", "variant"] as const;

export function updateJoin(
  draft: Draft,
  { timeline, join: id, changes }: z.output<typeof JoinUpdate>,
) {
  const target = timelineOf(draft, timeline);
  const join = entryOf(target.joins, id) ?? fail("not-found", `没有这个衔接转场：${id}`);
  editableTrack(target, join.track);
  const current = join.transition ?? fail("not-found", `这个衔接转场不完整：${id}`);
  const next: Record<string, unknown> = { ...current };
  const renamed = REFERENCE.some((field) => field !== "variant" && changes[field] !== undefined);
  // What it is goes as a whole, so that it never names two things.
  if (renamed) for (const field of REFERENCE) delete next[field];
  for (const [field, value] of Object.entries(changes)) {
    if (value === null) delete next[field];
    else if (value !== undefined) next[field] = value;
  }
  if (next["align"] === "center") delete next["align"];
  const transition = checked({ id, from: join.from ?? id, to: join.to ?? id, ...next });
  if (deepEqual(transition, current)) return;
  const sameThing = REFERENCE.every((field) => transition[field] === current[field]);
  const track = join.track === undefined ? undefined : entryOf(target.tracks, join.track);
  // One that is there already can always get another length or speed. Something else in its
  // place has to be what this editor does.
  if (!sameThing) {
    if (!track) fail("not-found", `没有这条轨道：${join.track}`);
    else checkDone(track, transition);
  }
  const whole = wholeJoin(id, join);
  const from = whole && entryOf(target.clips, whole.from);
  const to = whole && entryOf(target.clips, whole.to);
  // Where its clips are no longer next to each other, there is no room to speak of.
  if (from && to && from.track === to.track && compare(clipEnd(from), clipStart(to)) === 0) {
    const joined = joinedEndsOf(target);
    const length = parseTime(transition.duration);
    const fits = joinFits(joined, from, to, length, transition.align);
    // Never more than before: a file can leave one that is too long, which has to stay changeable.
    const was = joinFits(joined, from, to, parseTime(current.duration), current.align);
    const grows =
      compare(length, parseTime(current.duration)) > 0 || transition.align !== current.align;
    if (!fits && (was || grows)) checkFits(joined, from, to, length, transition.align);
  }
  draft.set([...joinPath(timeline, id), "transition"], transition);
}

export function removeJoins(draft: Draft, { timeline, joins }: z.output<typeof JoinRemove>) {
  const target = timelineOf(draft, timeline);
  for (const id of joins) {
    const join = entryOf(target.joins, id) ?? fail("not-found", `没有这个衔接转场：${id}`);
    editableTrack(target, join.track);
  }
  for (const id of new Set(joins)) draft.delete(joinPath(timeline, id));
}
