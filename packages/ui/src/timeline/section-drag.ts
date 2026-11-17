import { add, compare, formatTime, subtract, toSeconds, type Rational } from "@animaquill/schema";
import { frameAt, frameTime } from "./frames.ts";
import { hasMoved, type Gesture, type GestureHost, type Pointer } from "./gestures.ts";
import type { SectionBox } from "./markers.ts";
import type { TimelineModel } from "./model.ts";
import { snapPointsOf, type SnapPoints } from "./snap.ts";

/**
 * Drags the boundary between a section and the next: one gets longer and the other shorter, and
 * the length of the timeline and everything on it stay. It lands on frames or on what it snaps to,
 * its own place among them, and each section keeps a frame at least. The project changes once,
 * when the mouse lets go, and not at all when the boundary is back where it was.
 */
export class BoundaryGesture implements Gesture {
  readonly #host: GestureHost;
  readonly #before: SectionBox;
  readonly #after: SectionBox;
  readonly #press: Pointer;
  readonly #points: SnapPoints;
  #at: Rational | undefined;

  constructor(host: GestureHost, before: SectionBox, after: SectionBox, press: Pointer) {
    this.#host = host;
    this.#before = before;
    this.#after = after;
    this.#press = press;
    this.#points = snapPointsOf(host.model, host.frame, new Set());
  }

  move(pointer: Pointer): void {
    if (this.#at === undefined && !hasMoved(this.#press, pointer)) return;
    const { rate } = this.#host.model;
    const seconds = this.#host.timeAt(pointer.x);
    const point = this.#points.nearest(seconds, this.#host.snapDistance(pointer));
    let at = point ? point.exact() : frameTime(frameAt(seconds, rate), rate);
    const own = this.#before.endExact;
    if (!point && frameAt(seconds, rate) === frameAt(toSeconds(own), rate)) at = own;
    const frame = frameTime(1, rate);
    const lowest = add(this.#before.startExact, frame);
    const highest = subtract(this.#after.endExact, frame);
    if (compare(at, lowest) < 0) at = lowest;
    if (compare(at, highest) > 0) at = highest;
    this.#at = at;
    const shown = toSeconds(at);
    const snapped = point !== undefined && Math.abs(point.seconds - shown) < 1e-9;
    this.#host.setPreview({
      boundary: { section: this.#before.id, seconds: shown },
      ...(snapped && { snap: point.seconds }),
    });
  }

  end(pointer: Pointer): void {
    if (this.#at !== undefined) this.move(pointer);
    this.#host.setPreview(undefined);
    const at = this.#at;
    if (at === undefined || compare(at, this.#before.endExact) === 0) return;
    const params = { timeline: this.#host.model.id, section: this.#before.id, at: formatTime(at) };
    this.#host.run([{ type: "section.moveBoundary", params }]);
  }

  cancel(): void {
    this.#host.setPreview(undefined);
  }

  isStale(model: TimelineModel): boolean {
    const sections = model.sections.map(({ id }) => id);
    const index = sections.indexOf(this.#before.id);
    return index < 0 || sections[index + 1] !== this.#after.id;
  }
}
