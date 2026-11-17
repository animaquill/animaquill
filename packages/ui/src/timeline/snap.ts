import { clipEnd, clipStart, timelineLength } from "@animaquill/core";
import { ZERO, add, parseTime, type Rational } from "@animaquill/schema";
import { frameSeconds, frameTime } from "./frames.ts";
import type { TimelineModel } from "./model.ts";

/** Something an edge can stick to. The exact time is what makes two clips really touch. */
export interface SnapPoint {
  readonly seconds: number;
  exact(): Rational;
}

/** Everything that can be snapped to during one drag, for finding the nearest point quickly. */
export class SnapPoints {
  readonly #points: readonly SnapPoint[];

  constructor(points: readonly SnapPoint[]) {
    this.#points = points.toSorted((a, b) => a.seconds - b.seconds);
  }

  /** The nearest point closer than `within`. */
  nearest(seconds: number, within: number): SnapPoint | undefined {
    let low = 0;
    let high = this.#points.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if ((this.#points[middle] as SnapPoint).seconds < seconds) low = middle + 1;
      else high = middle;
    }
    const after = this.#points[low];
    const before = this.#points[low - 1];
    const distance = (point: SnapPoint | undefined) =>
      point ? Math.abs(point.seconds - seconds) : Number.POSITIVE_INFINITY;
    const best = distance(before) < distance(after) ? before : after;
    return distance(best) < within ? best : undefined;
  }
}

/**
 * What people expect edges to stick to: other clips, the playhead, both ends of the timeline, the
 * boundaries of sections and markers, both ends of one with a duration. A marker that is being
 * dragged is not something to stick to.
 */
export function snapPointsOf(
  model: TimelineModel,
  frame: number,
  except: ReadonlySet<string>,
  more: readonly SnapPoint[] = [],
  exceptMarker?: string,
): SnapPoints {
  const points: SnapPoint[] = [
    ...more,
    { seconds: 0, exact: () => ZERO },
    { seconds: model.duration, exact: () => timelineLength(model.state) },
    { seconds: frameSeconds(frame, model.rate), exact: () => frameTime(frame, model.rate) },
  ];
  for (const section of model.sections.slice(0, -1)) {
    points.push({ seconds: section.end, exact: () => section.endExact });
  }
  for (const { id, marker, time, end } of model.markers) {
    if (id === exceptMarker) continue;
    const start = parseTime(marker.time);
    points.push({ seconds: time, exact: () => start });
    const { duration } = marker;
    if (end !== undefined && duration !== undefined) {
      points.push({ seconds: end, exact: () => add(start, parseTime(duration)) });
    }
  }
  for (const box of model.boxes.values()) {
    if (except.has(box.id)) continue;
    points.push(
      { seconds: box.start, exact: () => clipStart(box.clip) },
      { seconds: box.end, exact: () => clipEnd(box.clip) },
    );
  }
  return new SnapPoints(points);
}
