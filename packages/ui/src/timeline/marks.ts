import type { FrameRate } from "./frames.ts";

/**
 * The part of the timeline people marked with in and out, as frames: the out frame is part of it,
 * as in Premiere. It belongs to the window, like the playhead, and is no part of the project.
 */
export interface Marks {
  readonly in?: number;
  readonly out?: number;
}

export const NO_MARKS: Marks = {};

export const hasMarks = (marks: Marks): boolean =>
  marks.in !== undefined || marks.out !== undefined;

/** An in after the out takes the out away, and an out before the in the in: as in Premiere. */
export function withIn(marks: Marks, frame: number): Marks {
  return marks.out !== undefined && marks.out < frame ? { in: frame } : { ...marks, in: frame };
}

export function withOut(marks: Marks, frame: number): Marks {
  return marks.in !== undefined && marks.in > frame ? { out: frame } : { ...marks, out: frame };
}

export function without(marks: Marks, end: "in" | "out"): Marks {
  const { [end]: _gone, ...rest } = marks;
  return rest;
}

export const sameMarks = (a: Marks, b: Marks): boolean => a.in === b.in && a.out === b.out;

/**
 * Where the marked part starts and ends on the timeline, in frames: the end is where the out frame
 * ends. Without an in it starts at the start, without an out it ends at the end.
 */
export function markedFrames(
  marks: Marks,
  lastFrame: number,
): { readonly from: number; readonly to: number } | undefined {
  if (!hasMarks(marks)) return undefined;
  return { from: marks.in ?? 0, to: marks.out === undefined ? lastFrame : marks.out + 1 };
}

interface SavedMarks {
  readonly in?: number;
  readonly out?: number;
}

const isFrame = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

/** Seconds, so that marks stay at their moment when the frame rate changes. */
export function marksText(marks: Marks, rate: FrameRate): string {
  const saved: SavedMarks = {
    ...(marks.in !== undefined && { in: marks.in / rate.fps }),
    ...(marks.out !== undefined && { out: marks.out / rate.fps }),
  };
  return JSON.stringify(saved);
}

export function parseMarks(text: string | undefined, rate: FrameRate): Marks {
  if (text === undefined) return NO_MARKS;
  try {
    const saved = JSON.parse(text) as Partial<SavedMarks> | null;
    const frame = (seconds: unknown) =>
      isFrame(seconds) ? Math.round(seconds * rate.fps) : undefined;
    const from = frame(saved?.in);
    const to = frame(saved?.out);
    if (from !== undefined && to !== undefined && to < from) return NO_MARKS;
    return {
      ...(from !== undefined && { in: from }),
      ...(to !== undefined && { out: to }),
    };
  } catch {
    return NO_MARKS;
  }
}
