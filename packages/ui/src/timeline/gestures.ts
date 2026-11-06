import { clipEnd, clipOffset, clipStart, type CommandCall } from "@animaquill/core";
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
import { frameAt, frameSeconds, frameTime } from "./frames.ts";
import {
  clipAt,
  forEachBetween,
  isInsideClip,
  type ClipBox,
  type Row,
  type TimelineModel,
} from "./model.ts";
import { snapPointsOf, type SnapPoint, type SnapPoints } from "./snap.ts";

/** Where the pointer is, in pixels from the top left of the timeline area. */
export interface Pointer {
  readonly x: number;
  readonly y: number;
  readonly shift: boolean;
  readonly alt: boolean;
  readonly mod: boolean;
}

/** A clip somewhere else than it is. */
export interface PreviewClip {
  readonly row: Row;
  readonly start: number;
  readonly end: number;
}

/** A stretch of a track that is about to be overwritten. */
export interface CoveredSpan {
  readonly row: Row;
  readonly from: number;
  readonly to: number;
}

/** An area of the timeline: seconds across, pixels from the top of the first row down. */
export interface Marquee {
  readonly from: number;
  readonly to: number;
  readonly top: number;
  readonly bottom: number;
}

/** What a drag would do. Nothing of it is in the project until the drag ends. */
export interface Preview {
  readonly clips?: ReadonlyMap<string, PreviewClip>;
  readonly covered?: readonly CoveredSpan[];
  /** Where something snapped, for the line that shows it. */
  readonly snap?: number;
  readonly marquee?: Marquee;
  /** The end of the timeline while it is being dragged. */
  readonly end?: number;
}

/** Something people do with the mouse, from pressing the button to letting go. */
export interface Gesture {
  move(pointer: Pointer): void;
  end(pointer: Pointer): void;
  /** Goes away without leaving a trace. */
  cancel(): void;
  /** Whether a change in the project pulled the ground from under this drag. */
  isStale?(model: TimelineModel): boolean;
  /** Whether it is about rows, so that the view should scroll through them along the way. */
  readonly reachesRows?: boolean;
}

/** What gestures need from the timeline. */
export interface GestureHost {
  readonly model: TimelineModel;
  readonly frame: number;
  readonly selection: ReadonlySet<string>;
  timeAt(x: number): number;
  /** The distance from the top of the first row. */
  laneAt(y: number): number;
  /** How close in seconds something has to be to snap. Zero when it should not. */
  snapDistance(pointer: Pointer): number;
  setPreview(preview: Preview | undefined): void;
  select(clips: ReadonlySet<string>): void;
  seek(frame: number): void;
  run(calls: readonly CommandCall[]): boolean;
}

/** A press is a click until the pointer has moved this far, so that a click never moves a clip. */
const DRAG_THRESHOLD = 4;

/** Where something ends up: on a frame, or exactly on what it snapped to. */
interface Landing {
  readonly seconds: number;
  exact(): Rational;
  /** Where to show that it snapped. */
  readonly line?: number;
}

function landOn(host: GestureHost, seconds: number, point: SnapPoint | undefined): Landing {
  if (point) return { seconds: point.seconds, exact: () => point.exact(), line: point.seconds };
  const { rate } = host.model;
  const frame = frameAt(seconds, rate);
  return { seconds: frameSeconds(frame, rate), exact: () => frameTime(frame, rate) };
}

const lineOf = ({ line }: Landing) => (line === undefined ? {} : { snap: line });

const hasMoved = (press: Pointer, pointer: Pointer) =>
  Math.hypot(pointer.x - press.x, pointer.y - press.y) >= DRAG_THRESHOLD;

const rowsOfKind = (model: TimelineModel, kind: string) =>
  model.rows.filter((row) => row.track.kind === kind);

/** The row of a kind that a height is closest to, so that dragging past the edge still works. */
function nearestRow(rows: readonly Row[], lane: number): Row | undefined {
  let best: Row | undefined;
  let distance = Number.POSITIVE_INFINITY;
  for (const row of rows) {
    const away = Math.abs(lane - (row.top + row.height / 2));
    if (away < distance) [best, distance] = [row, away];
  }
  return best;
}

/** Moves the selected clips together. What they land on is overwritten, as in other editors. */
export class MoveGesture implements Gesture {
  readonly reachesRows = true;
  readonly #host: GestureHost;
  readonly #grabbed: ClipBox;
  readonly #row: Row;
  readonly #press: Pointer;
  readonly #grabTime: number;
  readonly #moving: readonly { readonly box: ClipBox; readonly row: Row }[];
  readonly #ids: ReadonlySet<string>;
  readonly #points: SnapPoints;
  readonly #sameKind: readonly Row[];
  /** Moving the first clip to the start of the timeline stops all of them. */
  readonly #earliest: number;
  readonly #onClick: () => void;
  #dragging = false;
  #shift = 0;
  #landing: Landing | undefined;

  constructor(host: GestureHost, grabbed: ClipBox, row: Row, press: Pointer, onClick: () => void) {
    this.#host = host;
    this.#grabbed = grabbed;
    this.#row = row;
    this.#press = press;
    this.#grabTime = host.timeAt(press.x);
    this.#onClick = onClick;
    const { model, selection } = host;
    this.#moving = [...selection].flatMap((id) => {
      const box = model.boxes.get(id);
      const home = model.rowOfClip.get(id);
      return box && home && !home.track.locked ? [{ box, row: home }] : [];
    });
    this.#ids = new Set(this.#moving.map(({ box }) => box.id));
    this.#points = snapPointsOf(model, host.frame, this.#ids);
    this.#sameKind = rowsOfKind(model, row.track.kind);
    this.#earliest = Math.min(...this.#moving.map(({ box }) => box.start));
  }

  move(pointer: Pointer): void {
    if (!this.#dragging && !hasMoved(this.#press, pointer)) return;
    this.#dragging = true;
    this.#shift = this.#allowedShift(pointer);
    this.#landing = this.#land(pointer);
    this.#showPreview();
  }

  end(pointer: Pointer): void {
    if (!this.#dragging) {
      this.#onClick();
      return;
    }
    this.move(pointer);
    this.#commit();
    this.#host.setPreview(undefined);
  }

  /** Before the preview goes: the view may have scrolled to a place only the preview reaches. */
  #commit(): void {
    const landing = this.#landing;
    if (!landing) return;
    const delta = subtract(landing.exact(), clipStart(this.#grabbed.clip));
    const unchanged = compare(delta, ZERO) === 0 && this.#shift === 0;
    if (unchanged) return;
    const clips = this.#moving.map(({ box, row }) => {
      const target = this.#targetRow(row);
      return {
        clip: box.id,
        start: formatTime(add(clipStart(box.clip), delta)),
        ...(target === row ? {} : { track: target.id }),
      };
    });
    this.#host.run([
      {
        type: "clip.move",
        params: { timeline: this.#host.model.id, clips, overlap: "overwrite" },
      },
    ]);
  }

  cancel(): void {
    this.#host.setPreview(undefined);
  }

  isStale(model: TimelineModel): boolean {
    return [...this.#ids].some((id) => !model.boxes.has(id));
  }

  /** Rows of other kinds stay: a picture cannot land on a sound track. */
  #targetRow(row: Row): Row {
    if (row.track.kind !== this.#row.track.kind) return row;
    return this.#sameKind[this.#sameKind.indexOf(row) + this.#shift] ?? row;
  }

  /** How many rows to move. A place some clip cannot go is not taken, and the last one stays. */
  #allowedShift(pointer: Pointer): number {
    const wanted = nearestRow(this.#sameKind, this.#host.laneAt(pointer.y));
    if (!wanted) return this.#shift;
    const shift = this.#sameKind.indexOf(wanted) - this.#sameKind.indexOf(this.#row);
    const fits = this.#moving.every(({ row }) => {
      if (row.track.kind !== this.#row.track.kind) return true;
      const target = this.#sameKind[this.#sameKind.indexOf(row) + shift];
      return target !== undefined && !target.track.locked && (target === row || !target.gone);
    });
    return fits ? shift : this.#shift;
  }

  #land(pointer: Pointer): Landing {
    const { start, end } = this.#grabbed;
    const lowest = start - this.#earliest;
    const wanted = start + this.#host.timeAt(pointer.x) - this.#grabTime;
    const within = this.#host.snapDistance(pointer);
    const byStart = this.#points.nearest(wanted, within);
    const byEnd = this.#points.nearest(wanted + end - start, within);
    const startGap = byStart ? Math.abs(byStart.seconds - wanted) : Number.POSITIVE_INFINITY;
    const endGap = byEnd
      ? Math.abs(byEnd.seconds - (wanted + end - start))
      : Number.POSITIVE_INFINITY;
    if (byEnd && endGap < startGap && byEnd.seconds - (end - start) >= lowest) {
      const seconds = byEnd.seconds - (end - start);
      const exact = () => subtract(byEnd.exact(), parseTime(this.#grabbed.clip.duration));
      return { seconds, exact, line: byEnd.seconds };
    }
    const landing = landOn(this.#host, wanted, byStart);
    // Off the frame grid is fine for a clip, but not in front of the start.
    return landing.seconds < lowest
      ? { seconds: lowest, exact: () => this.#earliestLanding() }
      : landing;
  }

  /** The start of the grabbed clip when the earliest clip of the selection is at zero. */
  #earliestLanding(): Rational {
    const first = this.#moving.reduce((a, b) => (a.box.start <= b.box.start ? a : b));
    return subtract(clipStart(this.#grabbed.clip), clipStart(first.box.clip));
  }

  #showPreview(): void {
    const landing = this.#landing;
    if (!landing) return;
    const delta = landing.seconds - this.#grabbed.start;
    const clips = new Map<string, PreviewClip>();
    const covered: CoveredSpan[] = [];
    for (const { box, row } of this.#moving) {
      const target = this.#targetRow(row);
      const start = box.start + delta;
      const end = box.end + delta;
      clips.set(box.id, { row: target, start, end });
      forEachBetween(target, start, end, (other) => {
        if (this.#ids.has(other.id)) return;
        const from = Math.max(start, other.start);
        const to = Math.min(end, other.end);
        covered.push({ row: target, from, to });
      });
    }
    this.#host.setPreview({ clips, covered, ...lineOf(landing) });
  }
}

/** Moves one edge of a clip. Unlike a move, it stops at its neighbours. */
export class TrimGesture implements Gesture {
  readonly #host: GestureHost;
  readonly #box: ClipBox;
  readonly #row: Row;
  readonly #edge: "start" | "end";
  readonly #press: Pointer;
  readonly #grabTime: number;
  readonly #points: SnapPoints;
  readonly #lower: SnapPoint;
  readonly #upper: SnapPoint;
  #landing: Landing | undefined;

  constructor(host: GestureHost, box: ClipBox, row: Row, edge: "start" | "end", press: Pointer) {
    this.#host = host;
    this.#box = box;
    this.#row = row;
    this.#edge = edge;
    this.#press = press;
    this.#grabTime = host.timeAt(press.x);
    this.#points = snapPointsOf(host.model, host.frame, new Set([box.id]));
    [this.#lower, this.#upper] = this.#limits();
  }

  /** Where this edge can go. A kind of clip that has a beginning cannot go past it. */
  #limits(): readonly [SnapPoint, SnapPoint] {
    const { clip, start, end } = this.#box;
    const { rate } = this.#host.model;
    const index = this.#row.clips.indexOf(this.#box);
    const before = this.#row.clips[index - 1];
    const after = this.#row.clips[index + 1];
    const frame = frameTime(1, rate);
    if (this.#edge === "end") {
      const lower = {
        seconds: start + 1 / rate.fps,
        exact: () => add(clipStart(clip), frame),
      };
      const upper = after
        ? { seconds: after.start, exact: () => clipStart(after.clip) }
        : { seconds: Number.POSITIVE_INFINITY, exact: () => ZERO };
      return [lower, upper];
    }
    const upper = {
      seconds: end - 1 / rate.fps,
      exact: () => subtract(clipEnd(clip), frame),
    };
    const source = clip.source.kind;
    const timeless = source === "color" || source === "image" || source === "caption";
    const beginning = timeless ? ZERO : subtract(clipStart(clip), clipOffset(clip));
    const floor =
      compare(beginning, ZERO) < 0
        ? { seconds: 0, exact: () => ZERO }
        : { seconds: toSeconds(beginning), exact: () => beginning };
    const neighbour = before && before.end > floor.seconds ? before : undefined;
    const lower = neighbour
      ? { seconds: neighbour.end, exact: () => clipEnd(neighbour.clip) }
      : floor;
    return [lower, upper];
  }

  move(pointer: Pointer): void {
    if (!this.#landing && !hasMoved(this.#press, pointer)) return;
    const wanted = this.#box[this.#edge] + this.#host.timeAt(pointer.x) - this.#grabTime;
    const point = this.#points.nearest(wanted, this.#host.snapDistance(pointer));
    const landing = landOn(this.#host, wanted, point);
    this.#landing = this.#clamped(landing);
    const { start, end } = this.#box;
    const { seconds } = this.#landing;
    const moved = this.#edge === "start" ? { start: seconds, end } : { start, end: seconds };
    this.#host.setPreview({
      clips: new Map([[this.#box.id, { row: this.#row, ...moved }]]),
      ...lineOf(this.#landing),
    });
  }

  end(pointer: Pointer): void {
    this.move(pointer);
    this.#commit();
    this.#host.setPreview(undefined);
  }

  #commit(): void {
    const landing = this.#landing;
    if (!landing) return;
    const { clip } = this.#box;
    const current = this.#edge === "start" ? clipStart(clip) : clipEnd(clip);
    const exact = landing.exact();
    if (compare(exact, current) === 0) return;
    this.#host.run([
      {
        type: "clip.trim",
        params: {
          timeline: this.#host.model.id,
          clip: clip.id,
          [this.#edge]: formatTime(exact),
        },
      },
    ]);
  }

  cancel(): void {
    this.#host.setPreview(undefined);
  }

  isStale(model: TimelineModel): boolean {
    return !model.boxes.has(this.#box.id);
  }

  #clamped(landing: Landing): Landing {
    const limit = ({ seconds, exact }: SnapPoint) => ({ seconds, exact });
    if (landing.seconds <= this.#lower.seconds) return limit(this.#lower);
    if (landing.seconds >= this.#upper.seconds) return limit(this.#upper);
    return landing;
  }
}

/** Draws a box around clips to select them. It adds to the selection when asked to. */
export class MarqueeGesture implements Gesture {
  readonly reachesRows = true;
  readonly #host: GestureHost;
  readonly #before: ReadonlySet<string>;
  readonly #base: ReadonlySet<string>;
  readonly #fromTime: number;
  readonly #fromLane: number;
  readonly #press: Pointer;
  #active = false;

  constructor(host: GestureHost, press: Pointer) {
    this.#host = host;
    this.#press = press;
    this.#before = host.selection;
    this.#base = press.shift || press.mod ? host.selection : new Set();
    this.#fromTime = host.timeAt(press.x);
    this.#fromLane = host.laneAt(press.y);
    if (!press.shift && !press.mod) host.select(new Set());
  }

  move(pointer: Pointer): void {
    if (!this.#active && !hasMoved(this.#press, pointer)) return;
    this.#active = true;
    const time = this.#host.timeAt(pointer.x);
    const lane = this.#host.laneAt(pointer.y);
    const marquee: Marquee = {
      from: Math.min(time, this.#fromTime),
      to: Math.max(time, this.#fromTime),
      top: Math.min(lane, this.#fromLane),
      bottom: Math.max(lane, this.#fromLane),
    };
    const selected = new Set(this.#base);
    for (const row of this.#host.model.rows) {
      if (row.top + row.height <= marquee.top || row.top >= marquee.bottom) continue;
      forEachBetween(row, marquee.from, marquee.to, (box) => selected.add(box.id));
    }
    this.#host.select(selected);
    this.#host.setPreview({ marquee });
  }

  end(): void {
    this.#host.setPreview(undefined);
  }

  cancel(): void {
    this.#host.select(this.#before);
    this.#host.setPreview(undefined);
  }
}

/** Moves the playhead. It goes through every frame, unless asked to stick to edits. */
export class ScrubGesture implements Gesture {
  readonly #host: GestureHost;
  readonly #points: SnapPoints;
  readonly #before: number;

  constructor(host: GestureHost, press: Pointer) {
    this.#host = host;
    this.#before = host.frame;
    this.#points = snapPointsOf(host.model, host.frame, new Set());
    this.move(press);
  }

  move(pointer: Pointer): void {
    const { rate } = this.#host.model;
    const seconds = Math.max(this.#host.timeAt(pointer.x), 0);
    const within = pointer.shift ? this.#host.snapDistance({ ...pointer, alt: false }) : 0;
    const point = this.#points.nearest(seconds, within);
    this.#host.seek(frameAt(point?.seconds ?? seconds, rate));
  }

  end(pointer: Pointer): void {
    this.move(pointer);
  }

  cancel(): void {
    this.#host.seek(this.#before);
  }
}

/** Drags the end of the timeline. A clip cannot end up behind it. */
export class EndGesture implements Gesture {
  readonly #host: GestureHost;
  readonly #points: SnapPoints;
  readonly #lower: SnapPoint;
  readonly #section: { readonly id: string; readonly start: Rational };
  readonly #press: Pointer;
  #landing: Landing | undefined;

  constructor(host: GestureHost, section: { id: string; start: Rational }, press: Pointer) {
    this.#host = host;
    this.#section = section;
    this.#press = press;
    this.#points = snapPointsOf(host.model, host.frame, new Set());
    this.#lower = this.#limit();
  }

  /** The last moment anything shows, and the last section needs some length of its own. */
  #limit(): SnapPoint {
    const { model } = this.#host;
    const { rate } = model;
    const start = this.#section.start;
    let last: SnapPoint = {
      seconds: toSeconds(start) + 1 / rate.fps,
      exact: () => add(start, frameTime(1, rate)),
    };
    for (const box of model.boxes.values()) {
      if (box.end > last.seconds) last = { seconds: box.end, exact: () => clipEnd(box.clip) };
    }
    return last;
  }

  move(pointer: Pointer): void {
    if (!this.#landing && !hasMoved(this.#press, pointer)) return;
    const wanted = this.#host.timeAt(pointer.x);
    const point = this.#points.nearest(wanted, this.#host.snapDistance(pointer));
    const landing = landOn(this.#host, wanted, point);
    const { seconds, exact } = this.#lower;
    this.#landing = landing.seconds <= seconds ? { seconds, exact } : landing;
    this.#host.setPreview({ end: this.#landing.seconds, ...lineOf(this.#landing) });
  }

  end(pointer: Pointer): void {
    this.move(pointer);
    this.#commit();
    this.#host.setPreview(undefined);
  }

  #commit(): void {
    const landing = this.#landing;
    if (!landing) return;
    const { model } = this.#host;
    const duration = subtract(landing.exact(), this.#section.start);
    const current = model.state.sections[this.#section.id]?.duration;
    if (current === formatTime(duration)) return;
    this.#host.run([
      {
        type: "section.update",
        params: {
          timeline: model.id,
          section: this.#section.id,
          duration: formatTime(duration),
        },
      },
    ]);
  }

  cancel(): void {
    this.#host.setPreview(undefined);
  }
}

/** Where a cut would go: on a frame, or on the playhead when that is close. */
export function cutAt(host: GestureHost, pointer: Pointer): Landing {
  const { model, frame } = host;
  const seconds = Math.max(host.timeAt(pointer.x), 0);
  const playhead: SnapPoint = {
    seconds: frameSeconds(frame, model.rate),
    exact: () => frameTime(frame, model.rate),
  };
  const near = Math.abs(playhead.seconds - seconds) < host.snapDistance(pointer);
  return landOn(host, seconds, near ? playhead : undefined);
}

/** Clicks with the razor. With Shift it cuts through every track that can be changed. */
export class RazorGesture implements Gesture {
  readonly #host: GestureHost;
  readonly #targets: readonly Row[];

  constructor(host: GestureHost, row: Row, press: Pointer) {
    this.#host = host;
    this.#targets = press.shift ? host.model.rows : [row];
  }

  move(): void {}

  end(pointer: Pointer): void {
    const { seconds, exact } = cutAt(this.#host, pointer);
    const moment = exact();
    const at = formatTime(moment);
    const { model } = this.#host;
    const seenLinks = new Set<string>();
    const calls = this.#targets.flatMap((row) => {
      const box = row.track.locked ? undefined : clipAt(row, seconds);
      if (!box || !isInsideClip(box.clip, moment)) return [];
      const { link } = box.clip;
      if (link !== undefined && seenLinks.has(link)) return [];
      if (link !== undefined) seenLinks.add(link);
      return [{ type: "clip.split", params: { timeline: model.id, clip: box.id, at } }];
    });
    if (calls.length > 0) this.#host.run(calls);
  }

  cancel(): void {}
}
