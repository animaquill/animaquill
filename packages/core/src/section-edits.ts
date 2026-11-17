import {
  ZERO,
  add,
  compare,
  formatTime,
  parseTime,
  subtract,
  type Rational,
} from "@animaquill/schema";
import { timelineOf, timelinePath } from "./clip-edits.ts";
import type { Draft } from "./draft.ts";
import { fail } from "./failures.ts";
import { entryOf, orderedSections, timelineLength, type TimelineState } from "./model.ts";

/** A section where it is on the timeline, exactly. Sections lie end to end from zero. */
export interface PlacedSection {
  readonly id: string;
  readonly name?: string | undefined;
  readonly duration: Rational;
  readonly start: Rational;
  readonly end: Rational;
}

/** The sections of a timeline in order, each with where it starts and ends. */
export function placedSections(timeline: TimelineState): readonly PlacedSection[] {
  let start = ZERO;
  return orderedSections(timeline).map(({ id, name, duration }) => {
    const length = parseTime(duration);
    const end = add(start, length);
    const placed = { id, ...(name !== undefined && { name }), duration: length, start, end };
    start = end;
    return placed;
  });
}

const sectionPath = (timeline: string, section: string) => [
  ...timelinePath(timeline),
  "sections",
  section,
];

const versionSectionPath = (timeline: string, version: string, section: string) => [
  ...timelinePath(timeline),
  "overrides",
  version,
  "sections",
  section,
];

const maxOf = (a: Rational, b: Rational) => (compare(a, b) >= 0 ? a : b);
const minOf = (a: Rational, b: Rational) => (compare(a, b) <= 0 ? a : b);

/**
 * Takes a section away and gives its time to the one before it, or to the one after it when it is
 * the first: the other boundaries and the length of the timeline stay, and so does everything on
 * it, because clips and markers are placed by the time of the whole timeline. A version that makes
 * either of the two longer or shorter gets the sum of both as it has them, so that it stays as long
 * as it was too.
 */
export function removeSection(draft: Draft, timeline: string, section: string): void {
  const target = timelineOf(draft, timeline);
  if (!entryOf(target.sections, section)) fail("not-found", { kind: "section", id: section });
  const ordered = orderedSections(target);
  if (ordered.length === 1) fail("last-section", { timeline });
  const index = ordered.findIndex(({ id }) => id === section);
  const gone = ordered[index];
  const into = ordered[index - 1] ?? ordered[index + 1];
  if (!gone || !into) return;
  const both = add(parseTime(into.duration), parseTime(gone.duration));
  for (const [version, override] of Object.entries(target.overrides)) {
    const own = entryOf(override.sections, gone.id)?.duration;
    const other = entryOf(override.sections, into.id)?.duration;
    if (!own && !other) continue;
    const value = add(
      parseTime(other?.value ?? into.duration),
      parseTime(own?.value ?? gone.duration),
    );
    const hasBase = own?.base !== undefined || other?.base !== undefined;
    const base = add(
      parseTime(other?.base ?? into.duration),
      parseTime(own?.base ?? gone.duration),
    );
    draft.set(versionSectionPath(timeline, version, into.id), {
      duration: { value: formatTime(value), ...(hasBase && { base: formatTime(base) }) },
    });
    if (own) draft.delete(versionSectionPath(timeline, version, gone.id));
  }
  draft.set([...sectionPath(timeline, into.id), "duration"], formatTime(both));
  draft.delete(sectionPath(timeline, gone.id));
}

/**
 * Splits the section that a moment is in, there: the first part keeps the section, its name and
 * what versions say of it, and the second is a new one right after it. The moment has to be inside
 * a section, not where one starts or ends.
 */
export function splitSection(
  draft: Draft,
  timeline: string,
  at: Rational,
  id: string,
  name: string | undefined,
): void {
  const target = timelineOf(draft, timeline);
  const length = timelineLength(target);
  if (compare(at, length) >= 0) {
    fail("invalid-value", {
      rule: "time-outside",
      path: "at",
      time: formatTime(at),
      length: formatTime(length),
    });
  }
  const placed = placedSections(target);
  const index = placed.findIndex(
    ({ start, end }) => compare(start, at) < 0 && compare(at, end) < 0,
  );
  const section = placed[index];
  if (!section) fail("invalid-value", { rule: "section-edge", path: "at", time: formatTime(at) });
  const { start, end } = section as PlacedSection;
  const ordered = orderedSections(target);
  const order = (ordered[index] as { order: number }).order;
  const next = ordered[index + 1]?.order;
  draft.set([...sectionPath(timeline, section!.id), "duration"], formatTime(subtract(at, start)));
  draft.set(sectionPath(timeline, id), {
    id,
    ...(name ? { name } : {}),
    duration: formatTime(subtract(end, at)),
    order: next === undefined ? order + 1 : (order + next) / 2,
  });
}

/**
 * Moves the boundary between a section and the one after it to a moment, which stays inside the
 * two: the first gets longer and the second shorter by as much, or the other way round. The
 * length of the timeline stays, and so does everything on it.
 */
export function moveBoundary(draft: Draft, timeline: string, section: string, at: Rational): void {
  const target = timelineOf(draft, timeline);
  const placed = placedSections(target);
  const index = placed.findIndex(({ id }) => id === section);
  const before = placed[index];
  if (!before) fail("not-found", { kind: "section", id: section });
  const after = placed[index + 1];
  if (!after) fail("invalid-value", { rule: "no-next-section", section });
  const { start } = before as PlacedSection;
  const { end } = after as PlacedSection;
  if (compare(at, start) <= 0 || compare(at, end) >= 0) {
    fail("invalid-value", {
      rule: "boundary-outside",
      path: "at",
      time: formatTime(at),
      from: formatTime(start),
      to: formatTime(end),
    });
  }
  draft.set([...sectionPath(timeline, before!.id), "duration"], formatTime(subtract(at, start)));
  draft.set([...sectionPath(timeline, after!.id), "duration"], formatTime(subtract(end, at)));
}

/* What ripple edits do to sections and markers, ahead of the edits themselves. */

/** A marker as a ripple edit leaves it: its new time, and its new duration or none any more. */
export interface MarkerShift {
  readonly time: Rational;
  readonly duration: Rational | undefined;
}

/**
 * What taking a stretch out of a timeline, or putting one in, does to its sections and markers.
 * Only what changes is here.
 */
export interface GapPlan {
  /** New durations, by section. */
  readonly resized: ReadonlyMap<string, Rational>;
  /** Sections that are gone, with what versions say of them. */
  readonly removed: readonly string[];
  readonly markers: ReadonlyMap<string, MarkerShift>;
}

/**
 * Taking `[from, to)` out of a timeline. Sections lose what of them is in there, and those that are
 * all in there go; when that would be all of them, the first stays, one `least` long. Markers after
 * it move back by its length, those in it go to `from`, and a marker that spans part of it gets
 * shorter, or turns into a point at `from` when all of it was in there. Every marker stays.
 */
export function closingPlan(
  timeline: TimelineState,
  from: Rational,
  to: Rational,
  least: Rational,
): GapPlan {
  const resized = new Map<string, Rational>();
  const removed: string[] = [];
  const placed = placedSections(timeline);
  for (const { id, start, end, duration } of placed) {
    const inside = subtract(minOf(end, to), maxOf(start, from));
    if (compare(inside, ZERO) <= 0) continue;
    if (compare(inside, duration) >= 0) removed.push(id);
    else resized.set(id, subtract(duration, inside));
  }
  const first = placed[0];
  if (first && removed.length === placed.length) {
    removed.shift();
    resized.set(first.id, least);
  }
  const length = subtract(to, from);
  const moved = (time: Rational) =>
    compare(time, to) >= 0 ? subtract(time, length) : compare(time, from) > 0 ? from : time;
  const markers = new Map<string, MarkerShift>();
  for (const marker of Object.values(timeline.markers)) {
    const time = parseTime(marker.time);
    const duration = marker.duration === undefined ? undefined : parseTime(marker.duration);
    const start = moved(time);
    const end = duration === undefined ? undefined : moved(add(time, duration));
    const left = end === undefined ? undefined : subtract(end, start);
    const shift = { time: start, duration: left && compare(left, ZERO) > 0 ? left : undefined };
    const same =
      compare(shift.time, time) === 0 &&
      (shift.duration === undefined
        ? duration === undefined
        : duration !== undefined && compare(shift.duration, duration) === 0);
    if (!same) markers.set(marker.id, shift);
  }
  return { resized, removed, markers };
}

/**
 * Putting `length` into a timeline at `at`. The section it goes into gets longer: on a boundary
 * that is the one after it, since what comes in belongs with what follows, and at the end the last
 * one. Markers from `at` on move on by as much, and a marker that spans `at` gets longer.
 */
export function openingPlan(timeline: TimelineState, at: Rational, length: Rational): GapPlan {
  const resized = new Map<string, Rational>();
  const placed = placedSections(timeline);
  const into =
    placed.find(({ start, end }) => compare(start, at) <= 0 && compare(at, end) < 0) ??
    placed.at(-1);
  if (into) resized.set(into.id, add(into.duration, length));
  const markers = new Map<string, MarkerShift>();
  for (const marker of Object.values(timeline.markers)) {
    const time = parseTime(marker.time);
    const duration = marker.duration === undefined ? undefined : parseTime(marker.duration);
    if (compare(time, at) >= 0) {
      markers.set(marker.id, { time: add(time, length), duration });
    } else if (duration !== undefined && compare(add(time, duration), at) > 0) {
      markers.set(marker.id, { time, duration: add(duration, length) });
    }
  }
  return { resized, removed: [], markers };
}

/** Writes a plan. What versions say of sections that went goes with them. */
export function applyGapPlan(draft: Draft, timeline: string, plan: GapPlan): void {
  const target = timelineOf(draft, timeline);
  for (const [id, duration] of plan.resized) {
    draft.set([...sectionPath(timeline, id), "duration"], formatTime(duration));
  }
  for (const id of plan.removed) {
    for (const [version, override] of Object.entries(target.overrides)) {
      if (entryOf(override.sections, id)) draft.delete(versionSectionPath(timeline, version, id));
    }
    draft.delete(sectionPath(timeline, id));
  }
  const markers = [...timelinePath(timeline), "markers"];
  for (const [id, { time, duration }] of plan.markers) {
    draft.set([...markers, id, "time"], formatTime(time));
    if (duration === undefined) {
      if (entryOf(target.markers, id)?.duration !== undefined) {
        draft.delete([...markers, id, "duration"]);
      }
    } else draft.set([...markers, id, "duration"], formatTime(duration));
  }
}
