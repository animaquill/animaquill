import {
  ZERO,
  add,
  compare,
  formatTime,
  parseTime,
  subtract,
  toSeconds,
  type Rational,
} from "@animaquill/schema";
import { frameAt, frameTime } from "./frames.ts";
import { hasMoved, type Gesture, type GestureHost, type Pointer } from "./gestures.ts";
import type { MarkerBox } from "./markers.ts";
import type { TimelineModel } from "./model.ts";
import { snapPointsOf, type SnapPoints } from "./snap.ts";

/** What a drag takes of a marker: all of it, or the end of one with a duration. */
export type MarkerPart = "body" | "end";

interface Landed {
  readonly exact: Rational;
  readonly snap?: number | undefined;
}

/**
 * Moves a marker, or the end of one with a duration, which then gets longer or shorter. It lands on
 * frames or on what it snaps to: clips, the playhead, sections and the other markers. A marker that
 * is not on a frame stays where it is when it is let go of on its own frame, so a drag back to
 * where it was leaves nothing behind. The project changes once, when the mouse lets go.
 */
export class MarkerGesture implements Gesture {
  readonly #host: GestureHost;
  readonly #box: MarkerBox;
  readonly #part: MarkerPart;
  readonly #press: Pointer;
  readonly #points: SnapPoints;
  readonly #start: Rational;
  readonly #duration: Rational | undefined;
  #landed: Landed | undefined;

  constructor(host: GestureHost, box: MarkerBox, part: MarkerPart, press: Pointer) {
    this.#host = host;
    this.#box = box;
    const { duration } = box.marker;
    this.#part = duration === undefined ? "body" : part;
    this.#press = press;
    this.#points = snapPointsOf(host.model, host.frame, new Set(), [], box.id);
    this.#start = parseTime(box.marker.time);
    this.#duration = duration === undefined ? undefined : parseTime(duration);
  }

  /** The moment nearest to `seconds`: what it snaps to, or its frame, where `own` keeps its place. */
  #land(seconds: number, pointer: Pointer, own: Rational): Landed {
    const { rate } = this.#host.model;
    const point = this.#points.nearest(seconds, this.#host.snapDistance(pointer));
    if (point) return { exact: point.exact(), snap: point.seconds };
    const frame = frameAt(seconds, rate);
    return { exact: frame === frameAt(toSeconds(own), rate) ? own : frameTime(frame, rate) };
  }

  move(pointer: Pointer): void {
    if (!this.#landed && !hasMoved(this.#press, pointer)) return;
    const landed = this.#part === "end" ? this.#endAt(pointer) : this.#startAt(pointer);
    this.#landed = landed;
    const { id } = this.#box;
    const seconds = toSeconds(landed.exact);
    const duration = this.#duration && toSeconds(this.#duration);
    const marker =
      this.#part === "end"
        ? { id, time: this.#box.time, end: seconds }
        : { id, time: seconds, end: duration === undefined ? undefined : seconds + duration };
    this.#host.setPreview({ marker, ...(landed.snap !== undefined && { snap: landed.snap }) });
  }

  /** Where the whole marker goes. With a duration, whichever end comes nearer to something sticks. */
  #startAt(pointer: Pointer): Landed {
    const { model } = this.#host;
    const moved = this.#host.timeAt(pointer.x) - this.#host.timeAt(this.#press.x);
    let landed = this.#land(this.#box.time + moved, pointer, this.#start);
    const duration = this.#duration;
    if (duration && this.#box.end !== undefined) {
      const end = this.#land(this.#box.end + moved, pointer, add(this.#start, duration));
      const off = (snap: number | undefined, from: number) =>
        snap === undefined ? Number.POSITIVE_INFINITY : Math.abs(snap - from - moved);
      if (off(end.snap, this.#box.end) < off(landed.snap, this.#box.time)) {
        landed = { exact: subtract(end.exact, duration), snap: end.snap };
      }
    }
    // Not before the start of the timeline, nor after its last frame.
    if (compare(landed.exact, ZERO) < 0) return { exact: ZERO };
    const last = frameTime(Math.max(frameAt(model.duration, model.rate) - 1, 0), model.rate);
    return compare(landed.exact, last) > 0 ? { exact: last } : landed;
  }

  /** Where the end of a marker with a duration goes: a frame after its start at least. */
  #endAt(pointer: Pointer): Landed {
    const { rate } = this.#host.model;
    const own = add(this.#start, this.#duration ?? ZERO);
    const end = this.#land(this.#host.timeAt(pointer.x), pointer, own);
    const least = add(this.#start, frameTime(1, rate));
    return compare(end.exact, least) < 0 ? { exact: least } : end;
  }

  end(pointer: Pointer): void {
    if (this.#landed) this.move(pointer);
    this.#host.setPreview(undefined);
    const landed = this.#landed;
    if (!landed) return;
    const params = { timeline: this.#host.model.id, marker: this.#box.id };
    if (this.#part === "end") {
      const duration = subtract(landed.exact, this.#start);
      if (this.#duration && compare(duration, this.#duration) === 0) return;
      const changes = { duration: formatTime(duration) };
      this.#host.run([{ type: "marker.update", params: { ...params, changes } }]);
      return;
    }
    if (compare(landed.exact, this.#start) === 0) return;
    const changes = { time: formatTime(landed.exact) };
    this.#host.run([{ type: "marker.update", params: { ...params, changes } }]);
  }

  cancel(): void {
    this.#host.setPreview(undefined);
  }

  isStale(model: TimelineModel): boolean {
    return !Object.hasOwn(model.state.markers, this.#box.id);
  }
}
