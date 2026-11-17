import { clipEnd, clipOffset, clipStart, type ClipState, type HeldClip } from "@animaquill/core";
import {
  ZERO,
  add,
  compare,
  formatTime,
  subtract,
  toSeconds,
  type Rational,
} from "@animaquill/schema";
import { framesIn, frameTime, lastFrameBefore, type FrameRate } from "./frames.ts";
import {
  hasMoved,
  landOn,
  type Gesture,
  type GestureHost,
  type Pointer,
  type PreviewClip,
} from "./gestures.ts";
import type { ClipBox, Row, TimelineModel } from "./model.ts";
import { snapPointsOf, type SnapPoints } from "./snap.ts";

/*
 * The slip, slide and roll tools, as in Premiere: they keep how much time the clips take together
 * and change what they show or where they cut. While a drag goes on, the timeline shows where the
 * clips would be, how many frames it went, and the preview shows the frame at the edit, from a
 * plan that holds the clips there (`HeldPreview`); the project changes once, when it ends.
 */

/** A clip and the row it is on. */
export interface Placed {
  readonly box: ClipBox;
  readonly row: Row;
}

/** Colours, pictures and captions look the same at any moment, and have no beginning. */
const isTimeless = ({ source }: ClipState) =>
  source.kind === "color" || source.kind === "image" || source.kind === "caption";

/**
 * The linked partners of a clip that go along: those on other tracks at the same time, apart from
 * locked ones, wherever their edges are, as a sound that starts before its picture. None with Alt.
 */
export function partnersOf(model: TimelineModel, box: ClipBox, alone: boolean): readonly Placed[] {
  const { link } = box.clip;
  if (alone || link === undefined) return [];
  return (model.links.get(link) ?? []).flatMap((id) => {
    const other = model.boxes.get(id);
    const row = model.rowOfClip.get(id);
    if (!other || !row || id === box.id || row.track.locked) return [];
    const together =
      other.clip.track !== box.clip.track &&
      compare(clipStart(other.clip), clipEnd(box.clip)) < 0 &&
      compare(clipStart(box.clip), clipEnd(other.clip)) < 0;
    return together ? [{ box: other, row }] : [];
  });
}

/** How far an edit can go either way, exactly. Without a side, it can go as far as it likes. */
export class Bounds {
  #low: Rational | undefined;
  #high: Rational | undefined;

  atLeast(value: Rational): void {
    if (this.#low === undefined || compare(value, this.#low) > 0) this.#low = value;
  }

  atMost(value: Rational): void {
    if (this.#high === undefined || compare(value, this.#high) < 0) this.#high = value;
  }

  /** The nearest amount within them. Where they cross, it can go nowhere. */
  clamp(by: Rational): Rational {
    const low = this.#low;
    const high = this.#high;
    if (low && high && compare(low, high) > 0) return ZERO;
    if (low && compare(by, low) < 0) return low;
    if (high && compare(by, high) > 0) return high;
    return by;
  }
}

/** The other clips of a row right before and after a clip, if any touch it, exactly. */
function neighboursOf(row: Row, box: ClipBox, aside: ReadonlySet<string>) {
  const start = clipStart(box.clip);
  const end = clipEnd(box.clip);
  let before: ClipBox | undefined;
  let after: ClipBox | undefined;
  /** Where the clip can go when nothing is right next to it: the end of what is before... */
  let previousEnd = ZERO;
  /** ...and the start of what is after. */
  let nextStart: Rational | undefined;
  for (const other of row.clips) {
    if (other.id === box.id || aside.has(other.id)) continue;
    const from = clipStart(other.clip);
    const to = clipEnd(other.clip);
    if (compare(to, start) === 0) before = other;
    else if (compare(from, end) === 0) after = other;
    if (compare(to, start) <= 0 && compare(to, previousEnd) > 0) previousEnd = to;
    if (compare(from, end) >= 0 && (nextStart === undefined || compare(from, nextStart) < 0)) {
      nextStart = from;
    }
  }
  return { before, after, previousEnd, nextStart };
}

const lengthOf = (clip: ClipState) => subtract(clipEnd(clip), clipStart(clip));

/** A clip as a drag holds it: its exact times, for the picture. */
function heldOf(clip: ClipState, start: Rational, end: Rational, offset: Rational): HeldClip {
  return {
    start: formatTime(start),
    duration: formatTime(subtract(end, start)),
    ...(compare(offset, ZERO) === 0 ? {} : { offset: formatTime(offset) }),
  };
}

const ONE_FRAME = (rate: FrameRate) => frameTime(1, rate);

/**
 * Slips a clip and its partners: they stay where they are and as long, and what they show goes along
 * with the pointer, as film under a window. The picture shows the first frame of the clip, or its
 * last while the pointer is over its second half.
 */
export class SlipGesture implements Gesture {
  readonly #host: GestureHost;
  readonly #box: ClipBox;
  readonly #row: Row;
  readonly #press: Pointer;
  readonly #items: readonly Placed[];
  readonly #bounds = new Bounds();
  #by: Rational | undefined;

  constructor(host: GestureHost, box: ClipBox, row: Row, press: Pointer) {
    this.#host = host;
    this.#box = box;
    this.#row = row;
    this.#press = press;
    this.#items = [{ box, row }, ...partnersOf(host.model, box, press.alt)];
    for (const { box: item } of this.#items) {
      const { clip } = item;
      const offset = clipOffset(clip);
      if (!isTimeless(clip)) this.#bounds.atLeast(subtract(ZERO, offset));
      const length = host.sourceLength(clip);
      if (length) this.#bounds.atMost(subtract(length, add(offset, lengthOf(clip))));
    }
  }

  move(pointer: Pointer): void {
    if (this.#by === undefined && !hasMoved(this.#press, pointer)) return;
    const { model } = this.#host;
    const moved = this.#host.timeAt(pointer.x) - this.#host.timeAt(this.#press.x);
    // What it shows follows the pointer: later on its clock is to the left.
    const by = this.#bounds.clamp(frameTime(-Math.round(moved * model.rate.fps), model.rate));
    this.#by = by;
    const held = new Map<string, HeldClip>();
    for (const { box } of this.#items) {
      const { clip } = box;
      held.set(box.id, heldOf(clip, clipStart(clip), clipEnd(clip), add(clipOffset(clip), by)));
    }
    const { start, end } = this.#box;
    const seconds =
      this.#host.timeAt(pointer.x) > (start + end) / 2
        ? lastFrameBefore(clipEnd(this.#box.clip), model.rate)
        : start;
    const clips = new Map<string, PreviewClip>(
      this.#items.map(({ box, row }) => [box.id, { row, start: box.start, end: box.end }]),
    );
    this.#host.setPreview({
      clips,
      held: { clips: held, seconds },
      delta: {
        row: this.#row,
        seconds: (start + end) / 2,
        frames: -framesIn(by, model.rate),
      },
    });
  }

  end(pointer: Pointer): void {
    this.move(pointer);
    const by = this.#by;
    if (by !== undefined && compare(by, ZERO) !== 0) {
      const clips = this.#items.map(({ box }) => box.id);
      this.#host.run([
        { type: "clip.slip", params: { timeline: this.#host.model.id, clips, by: formatTime(by) } },
      ]);
    }
    this.#host.setPreview(undefined);
  }

  cancel(): void {
    this.#host.setPreview(undefined);
  }

  isStale(model: TimelineModel): boolean {
    return this.#items.some(({ box }) => !model.boxes.has(box.id));
  }
}

/** A clip that slides, and what is right next to it on its row. */
interface Sliding extends Placed {
  readonly before: ClipBox | undefined;
  readonly after: ClipBox | undefined;
}

/**
 * Slides a clip and its partners: they move as they are, and the clips right before and after
 * them on their rows give and take the time. The picture shows the first frame of the clip where
 * it would start: the frame right after the cut before it.
 */
export class SlideGesture implements Gesture {
  readonly #host: GestureHost;
  readonly #box: ClipBox;
  readonly #row: Row;
  readonly #press: Pointer;
  readonly #items: readonly Sliding[];
  readonly #bounds = new Bounds();
  readonly #points: SnapPoints;
  #by: Rational | undefined;

  constructor(host: GestureHost, box: ClipBox, row: Row, press: Pointer) {
    this.#host = host;
    this.#box = box;
    this.#row = row;
    this.#press = press;
    const { model } = host;
    const placed = [{ box, row }, ...partnersOf(model, box, press.alt)];
    const sliding = new Set(placed.map((item) => item.box.id));
    const frame = ONE_FRAME(model.rate);
    this.#items = placed.map((item) => {
      const { before, after, previousEnd, nextStart } = neighboursOf(item.row, item.box, sliding);
      const start = clipStart(item.box.clip);
      const end = clipEnd(item.box.clip);
      // Earlier: what is before gets shorter, or the empty time does; what is after starts earlier.
      if (before) this.#bounds.atLeast(subtract(frame, lengthOf(before.clip)));
      else this.#bounds.atLeast(subtract(previousEnd, start));
      if (after && !isTimeless(after.clip))
        this.#bounds.atLeast(subtract(ZERO, clipOffset(after.clip)));
      // Later: what is after gets shorter, or the empty time does; what is before ends later.
      if (after) this.#bounds.atMost(subtract(lengthOf(after.clip), frame));
      else if (nextStart !== undefined) this.#bounds.atMost(subtract(nextStart, end));
      const length = before && host.sourceLength(before.clip);
      if (before && length) {
        this.#bounds.atMost(subtract(length, add(clipOffset(before.clip), lengthOf(before.clip))));
      }
      return { ...item, before, after };
    });
    const except = new Set(
      this.#items.flatMap(({ box: item, before, after }) =>
        [item, before, after].flatMap((each) => (each ? [each.id] : [])),
      ),
    );
    this.#points = snapPointsOf(model, host.frame, except);
  }

  move(pointer: Pointer): void {
    if (this.#by === undefined && !hasMoved(this.#press, pointer)) return;
    const host = this.#host;
    const { model } = host;
    const moved = host.timeAt(pointer.x) - host.timeAt(this.#press.x);
    const box = this.#box;
    const within = host.snapDistance(pointer);
    // Its start, or else its end, sticks to what is near; back where it was is nearest of all.
    const wantedStart = box.start + moved;
    const length = box.end - box.start;
    const home = Math.abs(moved) < within;
    const startPoint = home ? undefined : this.#points.nearest(wantedStart, within);
    const endPoint =
      home || startPoint ? undefined : this.#points.nearest(wantedStart + length, within);
    const landing = landOn(host, wantedStart, startPoint);
    let by = home ? ZERO : subtract(landing.exact(), clipStart(box.clip));
    if (endPoint) by = subtract(endPoint.exact(), clipEnd(box.clip));
    by = this.#bounds.clamp(by);
    this.#by = by;
    const shift = toSeconds(by);
    const clips = new Map<string, PreviewClip>();
    const held = new Map<string, HeldClip>();
    for (const { box: item, row, before, after } of this.#items) {
      const { clip } = item;
      clips.set(item.id, { row, start: item.start + shift, end: item.end + shift });
      held.set(
        item.id,
        heldOf(clip, add(clipStart(clip), by), add(clipEnd(clip), by), clipOffset(clip)),
      );
      if (before) {
        const end = add(clipEnd(before.clip), by);
        clips.set(before.id, { row, start: before.start, end: before.end + shift });
        held.set(
          before.id,
          heldOf(before.clip, clipStart(before.clip), end, clipOffset(before.clip)),
        );
      }
      if (after) {
        const start = add(clipStart(after.clip), by);
        const offset = add(clipOffset(after.clip), by);
        clips.set(after.id, { row, start: after.start + shift, end: after.end });
        held.set(after.id, heldOf(after.clip, start, clipEnd(after.clip), offset));
      }
    }
    const snapped = !home && (startPoint ?? endPoint);
    host.setPreview({
      clips,
      held: { clips: held, seconds: toSeconds(add(clipStart(box.clip), by)) },
      delta: {
        row: this.#row,
        seconds: (box.start + box.end) / 2 + shift,
        frames: framesIn(by, model.rate),
      },
      ...(snapped ? { snap: snapped.seconds } : {}),
    });
  }

  end(pointer: Pointer): void {
    this.move(pointer);
    const by = this.#by;
    if (by !== undefined && compare(by, ZERO) !== 0) {
      const clips = this.#items.map(({ box }) => box.id);
      this.#host.run([
        {
          type: "clip.slide",
          params: { timeline: this.#host.model.id, clips, by: formatTime(by) },
        },
      ]);
    }
    this.#host.setPreview(undefined);
  }

  cancel(): void {
    this.#host.setPreview(undefined);
  }

  isStale(model: TimelineModel): boolean {
    return this.#items.some(
      ({ box, before, after }) =>
        !model.boxes.has(box.id) ||
        (before && !model.boxes.has(before.id)) ||
        (after && !model.boxes.has(after.id)),
    );
  }
}

/** A cut that rolls: the clip that ends there, the one that starts there, or both. */
interface Cut {
  readonly row: Row;
  /** The edge that is dragged, or that of a partner. */
  readonly edge: { readonly clip: string; readonly edge: "start" | "end" };
  readonly left: ClipBox | undefined;
  readonly right: ClipBox | undefined;
  readonly at: Rational;
}

/**
 * Rolls the cut at an edge of a clip, as the roll tool of Premiere: the clip on the other side of
 * it gets as much shorter as this one gets longer. Partners roll their own edges by as much. With
 * nothing on the other side, it is a trim up to what is there. The picture shows the frame right
 * after the cut, where it would be.
 */
export class RollGesture implements Gesture {
  readonly #host: GestureHost;
  readonly #row: Row;
  readonly #press: Pointer;
  readonly #cuts: readonly Cut[];
  readonly #bounds = new Bounds();
  readonly #points: SnapPoints;
  #by: Rational | undefined;

  constructor(host: GestureHost, box: ClipBox, row: Row, edge: "start" | "end", press: Pointer) {
    this.#host = host;
    this.#row = row;
    this.#press = press;
    const { model } = host;
    const placed = [{ box, row }, ...partnersOf(model, box, press.alt)];
    const frame = ONE_FRAME(model.rate);
    this.#cuts = placed.map((item) => {
      const at = edge === "end" ? clipEnd(item.box.clip) : clipStart(item.box.clip);
      const facing = item.row.clips.find(
        (other) =>
          other.id !== item.box.id &&
          compare(edge === "end" ? clipStart(other.clip) : clipEnd(other.clip), at) === 0,
      );
      const left = edge === "end" ? item.box : facing;
      const right = edge === "end" ? facing : item.box;
      return { row: item.row, edge: { clip: item.box.id, edge }, left, right, at };
    });
    for (const { row: own, left, right, at } of this.#cuts) {
      const aside = new Set([left?.id, right?.id].filter((id): id is string => id !== undefined));
      if (left) {
        this.#bounds.atLeast(subtract(frame, lengthOf(left.clip)));
        const length = host.sourceLength(left.clip);
        if (length) {
          this.#bounds.atMost(subtract(length, add(clipOffset(left.clip), lengthOf(left.clip))));
        }
      } else {
        const { previousEnd } = neighboursOf(own, right as ClipBox, aside);
        this.#bounds.atLeast(subtract(previousEnd, at));
      }
      if (right) {
        this.#bounds.atMost(subtract(lengthOf(right.clip), frame));
        if (!isTimeless(right.clip)) this.#bounds.atLeast(subtract(ZERO, clipOffset(right.clip)));
      } else {
        const { nextStart } = neighboursOf(own, left as ClipBox, aside);
        if (nextStart !== undefined) this.#bounds.atMost(subtract(nextStart, at));
      }
    }
    const except = new Set(
      this.#cuts
        .flatMap(({ left, right }) => [left?.id, right?.id])
        .filter((id) => id !== undefined),
    );
    this.#points = snapPointsOf(model, host.frame, except as ReadonlySet<string>);
  }

  move(pointer: Pointer): void {
    if (this.#by === undefined && !hasMoved(this.#press, pointer)) return;
    const host = this.#host;
    const { model } = host;
    const [main] = this.#cuts;
    if (!main) return;
    const from = toSeconds(main.at);
    const wanted = from + host.timeAt(pointer.x) - host.timeAt(this.#press.x);
    const within = host.snapDistance(pointer);
    const home = Math.abs(wanted - from) < within;
    const point = home ? undefined : this.#points.nearest(wanted, within);
    const landing = landOn(host, wanted, point);
    const by = this.#bounds.clamp(home ? ZERO : subtract(landing.exact(), main.at));
    this.#by = by;
    const shift = toSeconds(by);
    const clips = new Map<string, PreviewClip>();
    const held = new Map<string, HeldClip>();
    for (const { row, left, right } of this.#cuts) {
      if (left) {
        const { clip } = left;
        clips.set(left.id, { row, start: left.start, end: left.end + shift });
        held.set(left.id, heldOf(clip, clipStart(clip), add(clipEnd(clip), by), clipOffset(clip)));
      }
      if (right) {
        const { clip } = right;
        const start = add(clipStart(clip), by);
        clips.set(right.id, { row, start: right.start + shift, end: right.end });
        held.set(right.id, heldOf(clip, start, clipEnd(clip), add(clipOffset(clip), by)));
      }
    }
    const cut = toSeconds(add(main.at, by));
    host.setPreview({
      clips,
      held: { clips: held, seconds: cut },
      delta: { row: this.#row, seconds: cut, frames: framesIn(by, model.rate) },
      ...(point && !home ? { snap: point.seconds } : {}),
    });
  }

  end(pointer: Pointer): void {
    this.move(pointer);
    const by = this.#by;
    const [main] = this.#cuts;
    if (by !== undefined && main && compare(by, ZERO) !== 0) {
      const params = {
        timeline: this.#host.model.id,
        edges: this.#cuts.map(({ edge }) => edge),
        at: formatTime(add(main.at, by)),
      };
      this.#host.run([{ type: "clip.roll", params }]);
    }
    this.#host.setPreview(undefined);
  }

  cancel(): void {
    this.#host.setPreview(undefined);
  }

  isStale(model: TimelineModel): boolean {
    return this.#cuts.some(
      ({ left, right }) =>
        (left && !model.boxes.has(left.id)) || (right && !model.boxes.has(right.id)),
    );
  }
}
