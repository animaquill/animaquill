import {
  add,
  isAnimation,
  parseTime,
  subtract,
  type PropertyValue,
  type Rational,
} from "@animaquill/schema";
import {
  clipEnd,
  clipOffset,
  clipStart,
  orderedSections,
  projectFrameRate,
  type ClipState,
  type ProjectState,
} from "../model.ts";
import { withId, type ProjectProblem } from "./model.ts";

/**
 * Times that are not on a frame of the editing frame rate. Times are exact seconds, so changing the
 * frame rate moves nothing (docs/design/settings-and-properties.md of AnimaQuill Cloud, 5.3); what
 * was on the frames of the old rate can then be between two of the new one. Playing and exporting
 * do not mind, and an export does not stop for it; dragging lands on the frames of the new rate.
 * One problem a clip (its edges and keys, on the timeline), and one a timeline for the ends of its
 * sections and its markers.
 */
export const TIMING_CODES = ["time-off-grid"] as const;

/** Whether a time is a whole number of frames of a rate: time × fps is whole. */
function onGrid(time: Rational, fps: Rational): boolean {
  return (time.n * fps.n) % (time.d * fps.d) === 0n;
}

const counted = new WeakMap<ClipState, { readonly fps: string; readonly count: number }>();

/** How many times of a clip are off the frames: its start, its end, the moments of its keys. */
function offGridOf(clip: ClipState, fps: string, rate: Rational): number {
  const known = counted.get(clip);
  if (known?.fps === fps) return known.count;
  let count = 0;
  try {
    const start = clipStart(clip);
    if (!onGrid(start, rate)) count += 1;
    if (!onGrid(clipEnd(clip), rate)) count += 1;
    // A key is at a reading of the clip's clock: the clip starts at `offset`.
    const shift = subtract(start, clipOffset(clip));
    const keys = new Set<string>();
    for (const value of Object.values(clip.properties ?? {}) as PropertyValue[]) {
      if (!isAnimation(value)) continue;
      for (const key of value.keys) keys.add(key.time);
    }
    for (const time of keys) if (!onGrid(add(shift, parseTime(time)), rate)) count += 1;
  } catch {
    // A time that is no time is a problem of the format, not this one.
  }
  counted.set(clip, { fps, count });
  return count;
}

export function timingProblems(state: ProjectState): readonly ProjectProblem[] {
  const fps = projectFrameRate(state.manifest);
  let rate: Rational;
  try {
    rate = parseTime(fps);
  } catch {
    return [];
  }
  if (rate.n <= 0n) return [];
  const problems: ProjectProblem[] = [];
  for (const [timeline, content] of Object.entries(state.timelines)) {
    for (const clip of Object.values(content.clips)) {
      const count = offGridOf(clip, fps, rate);
      if (count === 0) continue;
      problems.push(
        withId({
          source: "timing",
          severity: "warning",
          code: "time-off-grid",
          params: { count, fps },
          subject: { kind: "clip", id: clip.id, timeline },
        }),
      );
    }
    let count = 0;
    try {
      let end: Rational = parseTime("0");
      for (const section of orderedSections(content)) {
        end = add(end, parseTime(section.duration));
        if (!onGrid(end, rate)) count += 1;
      }
      for (const marker of Object.values(content.markers)) {
        if (!onGrid(parseTime(marker.time), rate)) count += 1;
      }
    } catch {
      // As above.
    }
    if (count > 0)
      problems.push(
        withId({
          source: "timing",
          severity: "warning",
          code: "time-off-grid",
          params: { count, fps },
          subject: { kind: "timeline", id: timeline },
        }),
      );
  }
  return problems;
}
