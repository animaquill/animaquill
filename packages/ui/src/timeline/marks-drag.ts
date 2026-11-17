import { frameAt, frameSeconds } from "./frames.ts";
import { hasMoved, type Gesture, type GestureHost, type Pointer } from "./gestures.ts";
import type { Marks } from "./marks.ts";
import { snapPointsOf, type SnapPoints } from "./snap.ts";

/** What a drag on the ruler takes of the marks: an end, or both together by the band between. */
export type MarksPart = "in" | "out" | "both";

/**
 * Drags the in, the out or both. They land on frames, or on what they snap to: the playhead, clip
 * edges, the start and the end. A click without a drag moves the playhead, as on the rest of the
 * ruler. The marks belong to the window, so the drag changes them as it goes, and letting go of
 * them where they were leaves nothing behind.
 */
export class MarksGesture implements Gesture {
  readonly #host: GestureHost;
  readonly #part: MarksPart;
  readonly #before: Marks;
  readonly #set: (marks: Marks) => void;
  readonly #press: Pointer;
  readonly #points: SnapPoints;
  #moved = false;

  constructor(
    host: GestureHost,
    part: MarksPart,
    marks: Marks,
    set: (marks: Marks) => void,
    press: Pointer,
  ) {
    this.#host = host;
    this.#part = part;
    this.#before = marks;
    this.#set = set;
    this.#press = press;
    this.#points = snapPointsOf(host.model, host.frame, new Set());
  }

  get #last(): number {
    const { model } = this.#host;
    return frameAt(model.duration, model.rate);
  }

  /** The frame nearest to a moment, or what it snaps to, and where it snapped. */
  #land(seconds: number, pointer: Pointer): { frame: number; snap?: number | undefined } {
    const point = this.#points.nearest(seconds, this.#host.snapDistance(pointer));
    const { rate } = this.#host.model;
    return point
      ? { frame: frameAt(point.seconds, rate), snap: point.seconds }
      : { frame: frameAt(seconds, rate) };
  }

  move(pointer: Pointer): void {
    if (!this.#moved && !hasMoved(this.#press, pointer)) return;
    this.#moved = true;
    const marks = this.#marksAt(pointer);
    this.#set(marks.marks);
    this.#host.setPreview(marks.snap === undefined ? undefined : { snap: marks.snap });
  }

  #marksAt(pointer: Pointer): { marks: Marks; snap?: number | undefined } {
    const before = this.#before;
    const last = this.#last;
    const seconds = this.#host.timeAt(pointer.x);
    if (this.#part === "in") {
      const { frame, snap } = this.#land(seconds, pointer);
      const top = Math.min(before.out ?? last - 1, last - 1);
      return { marks: { ...before, in: clampFrame(frame, 0, Math.max(top, 0)) }, snap };
    }
    if (this.#part === "out") {
      // The handle of the out is where its frame ends.
      const { frame, snap } = this.#land(seconds, pointer);
      const bottom = before.in ?? 0;
      return {
        marks: { ...before, out: clampFrame(frame - 1, bottom, Math.max(last - 1, bottom)) },
        snap,
      };
    }
    return this.#shifted(pointer);
  }

  /** Both ends by the same number of frames, snapping whichever end is nearer to something. */
  #shifted(pointer: Pointer): { marks: Marks; snap?: number | undefined } {
    const { model } = this.#host;
    const { rate } = model;
    const before = this.#before;
    const last = this.#last;
    // Only the ends that are there move: without an in, what is marked still starts at the start.
    const ends = [
      ...(before.in === undefined ? [] : [before.in]),
      ...(before.out === undefined ? [] : [before.out + 1]),
    ];
    const lowest = before.in ?? before.out ?? 0;
    const highest = before.out ?? before.in ?? 0;
    const moved = this.#host.timeAt(pointer.x) - this.#host.timeAt(this.#press.x);
    let by = frameAt(moved, rate);
    let snap: number | undefined;
    const reach = this.#host.snapDistance(pointer);
    const near = ends
      .flatMap((frame) => {
        const wanted = frameSeconds(frame, rate) + moved;
        const point = this.#points.nearest(wanted, reach);
        return point ? [{ point, frame, distance: Math.abs(point.seconds - wanted) }] : [];
      })
      .toSorted((a, b) => a.distance - b.distance)[0];
    if (near) {
      by = frameAt(near.point.seconds, rate) - near.frame;
      snap = near.point.seconds;
    }
    by = clampFrame(by, -lowest, last - 1 - highest);
    const marks: Marks = {
      ...(before.in !== undefined && { in: before.in + by }),
      ...(before.out !== undefined && { out: before.out + by }),
    };
    return { marks, ...(snap !== undefined && by !== 0 && { snap }) };
  }

  end(pointer: Pointer): void {
    if (this.#moved) this.move(pointer);
    else this.#host.seek(frameAt(Math.max(this.#host.timeAt(pointer.x), 0), this.#host.model.rate));
    this.#host.setPreview(undefined);
  }

  cancel(): void {
    this.#set(this.#before);
    this.#host.setPreview(undefined);
  }
}

const clampFrame = (frame: number, low: number, high: number) =>
  Math.min(Math.max(frame, low), Math.max(low, high));
