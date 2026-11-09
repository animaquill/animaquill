import {
  clipEnd,
  clipOffset,
  clipStart,
  longestJoin,
  takenAt,
  type ClipState,
  type CommandCall,
  type WholeJoin,
} from "@animaquill/core";
import {
  ZERO,
  add,
  compare,
  formatTime,
  newId,
  parseTime,
  rational,
  subtract,
  toSeconds,
  type Rational,
} from "@animaquill/schema";
import { frameAt, frameSeconds, frameTime } from "./frames.ts";
import {
  clipAt,
  edgesOf,
  forEachBetween,
  isInsideClip,
  type ClipBox,
  type Edge,
  type JoinBox,
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
  /** Clips stay where they are, and what `clips` shows are copies. */
  readonly copying?: boolean;
  /** How long a transition at an edge of a clip is while its handle is dragged, in seconds. */
  readonly transition?: { readonly clip: string; readonly edge: Edge; readonly seconds: number };
  /** Where a join is while an edge of it is dragged, in seconds. */
  readonly join?: { readonly id: string; readonly start: number; readonly end: number };
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
  /** Whether a drop covers what is in the way. Otherwise it goes to the nearest free place. */
  readonly overwriting: boolean;
  /** Whether clicks add to the selection. */
  readonly multiSelecting: boolean;
  timeAt(x: number): number;
  /** The distance from the top of the first row. */
  laneAt(y: number): number;
  /** How close in seconds something has to be to snap. Zero when it should not. */
  snapDistance(pointer: Pointer): number;
  /** How far the clock of a clip can run. */
  sourceLength(clip: ClipState): Rational | undefined;
  setPreview(preview: Preview | undefined): void;
  select(clips: ReadonlySet<string>): void;
  /** Selects the transition at an edge of a clip, instead of clips. */
  selectTransition(clip: string, edge: Edge): void;
  /** Selects a join, instead of clips. */
  selectJoin(join: string): void;
  seek(frame: number): void;
  run(calls: readonly CommandCall[]): boolean;
}

/** A press is a click until the pointer has moved this far, so that a click never moves a clip. */
const DRAG_THRESHOLD = 4;
/** Clips that touch differ by this much as floats, and that is no overlap. */
const TOUCHING = 1e-9;
/** How many clips a search for a free place jumps over before it gives up. */
const MAX_JUMPS = 500;

/** Where something ends up: on a frame, or exactly on what it snapped to. */
export interface Landing {
  readonly seconds: number;
  exact(): Rational;
  /** Where to show that it snapped. */
  readonly line?: number;
}

export function landOn(
  host: Pick<GestureHost, "model">,
  seconds: number,
  point: SnapPoint | undefined,
): Landing {
  if (point) return { seconds: point.seconds, exact: () => point.exact(), line: point.seconds };
  const { rate } = host.model;
  const frame = frameAt(seconds, rate);
  return { seconds: frameSeconds(frame, rate), exact: () => frameTime(frame, rate) };
}

const lineOf = ({ line }: Landing) => (line === undefined ? {} : { snap: line });

export const hasMoved = (press: Pointer, pointer: Pointer): boolean =>
  Math.hypot(pointer.x - press.x, pointer.y - press.y) >= DRAG_THRESHOLD;

/** A clip at a place it could go to. */
export interface Placed {
  readonly row: Row;
  readonly start: number;
  readonly end: number;
  exactStart(): Rational;
  exactEnd(): Rational;
}

/** How far clips have to go to be free of others, and where they then touch something. */
export interface FreeShift {
  readonly seconds: number;
  exact(): Rational;
  readonly contact?: number;
}

function firstClash(
  placed: readonly Placed[],
  ignored: ReadonlySet<string>,
  shift: number,
): { readonly item: Placed; readonly other: ClipBox } | undefined {
  for (const item of placed) {
    let other: ClipBox | undefined;
    const from = item.start + shift + TOUCHING;
    const to = item.end + shift - TOUCHING;
    forEachBetween(item.row, from, to, (box) => {
      if (!ignored.has(box.id)) other ??= box;
    });
    if (other) return { item, other };
  }
  return undefined;
}

/**
 * The shortest way in one direction to a place where all of these fit. Jumps from clip to clip, so
 * it only looks at what is really in the way. Undefined when it gives up.
 */
export function freeShift(
  placed: readonly Placed[],
  ignored: ReadonlySet<string>,
  direction: 1 | -1,
): FreeShift | undefined {
  let found: FreeShift = { seconds: 0, exact: () => ZERO };
  for (let jump = 0; jump < MAX_JUMPS; jump++) {
    const clash = firstClash(placed, ignored, found.seconds);
    if (!clash) return found;
    const { item, other } = clash;
    found =
      direction > 0
        ? {
            seconds: other.end - item.start,
            exact: () => subtract(clipEnd(other.clip), item.exactStart()),
            contact: other.end,
          }
        : {
            seconds: other.start - item.end,
            exact: () => subtract(clipStart(other.clip), item.exactEnd()),
            contact: other.start,
          };
  }
  return undefined;
}

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

/**
 * Moves the selected clips together, or copies them with Ctrl held. What is in the way stays: they
 * go to the nearest free place, unless people turned on overwriting.
 */
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
  #copying = false;
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
    this.#copying = pointer.mod;
    this.#shift = this.#allowedShift(pointer);
    this.#landing = this.#avoidOthers(this.#land(pointer)) ?? this.#landing;
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
    if (this.#copying) this.#commitCopies(delta);
    else this.#commitMove(delta);
  }

  #overlap() {
    return this.#host.overwriting ? { overlap: "overwrite" } : {};
  }

  #commitMove(delta: Rational): void {
    const clips = this.#moving.map(({ box, row }) => {
      const target = this.#targetRow(row);
      return {
        clip: box.id,
        start: formatTime(add(clipStart(box.clip), delta)),
        ...(target === row ? {} : { track: target.id }),
      };
    });
    const { id: timeline } = this.#host.model;
    this.#host.run([{ type: "clip.move", params: { timeline, clips, ...this.#overlap() } }]);
  }

  #commitCopies(delta: Rational): void {
    const copies = copiesOf(this.#moving.map(({ box }) => box.clip));
    const calls = this.#moving.map(({ box, row }, index) => {
      const copy = copies[index] as ClipCopy;
      const clip = { ...copy, start: formatTime(add(clipStart(box.clip), delta)) };
      const { id: timeline } = this.#host.model;
      const track = this.#targetRow(row).id;
      return { type: "clip.add", params: { timeline, track, clip, ...this.#overlap() } };
    });
    const originals = this.#moving.map(({ box }) => box.id);
    const { model } = this.#host;
    const joins = copiedJoins(model.id, joinsAmong(model, originals), originals, copies);
    if (this.#host.run([...calls, ...joins])) {
      this.#host.select(new Set(copies.map(({ id }) => id)));
    }
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
    // Back where it came from is the easiest way to change one's mind.
    if (!this.#copying && Math.abs(wanted - start) < within) {
      return { seconds: start, exact: () => clipStart(this.#grabbed.clip), line: start };
    }
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

  /** The nearest place from a landing where nothing gets covered. */
  #avoidOthers(landing: Landing): Landing | undefined {
    if (this.#host.overwriting) return landing;
    const delta = landing.seconds - this.#grabbed.start;
    const exactDelta = () => subtract(landing.exact(), clipStart(this.#grabbed.clip));
    const placed = this.#moving.map(({ box, row }): Placed => ({
      row: this.#targetRow(row),
      start: box.start + delta,
      end: box.end + delta,
      exactStart: () => add(clipStart(box.clip), exactDelta()),
      exactEnd: () => add(clipEnd(box.clip), exactDelta()),
    }));
    const ignored = this.#copying ? new Set<string>() : this.#ids;
    const later = freeShift(placed, ignored, 1);
    if (later?.seconds === 0) return landing;
    const earlier = freeShift(placed, ignored, -1);
    const lowest = this.#grabbed.start - this.#earliest;
    const canGoBack = earlier && landing.seconds + earlier.seconds >= lowest - TOUCHING;
    const shift = canGoBack && (!later || -earlier.seconds < later.seconds) ? earlier : later;
    if (!shift) return undefined;
    return {
      seconds: landing.seconds + shift.seconds,
      exact: () => add(landing.exact(), shift.exact()),
      ...(shift.contact === undefined ? {} : { line: shift.contact }),
    };
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
      if (!this.#host.overwriting) continue;
      forEachBetween(target, start, end, (other) => {
        if (!this.#copying && this.#ids.has(other.id)) return;
        const from = Math.max(start, other.start);
        const to = Math.min(end, other.end);
        covered.push({ row: target, from, to });
      });
    }
    const copying = this.#copying ? { copying: true } : {};
    this.#host.setPreview({ clips, covered, ...copying, ...lineOf(landing) });
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
  /** Linked clips that end at the same place go along. */
  readonly #partners: readonly { readonly box: ClipBox; readonly row: Row }[];
  #landing: Landing | undefined;

  constructor(host: GestureHost, box: ClipBox, row: Row, edge: "start" | "end", press: Pointer) {
    this.#host = host;
    this.#box = box;
    this.#row = row;
    this.#edge = edge;
    this.#press = press;
    this.#grabTime = host.timeAt(press.x);
    this.#partners = this.#findPartners();
    this.#points = snapPointsOf(
      host.model,
      host.frame,
      new Set([box.id, ...this.#partners.map((partner) => partner.box.id)]),
    );
    const limits = [{ box, row }, ...this.#partners].map((item) =>
      this.#limits(item.box, item.row),
    );
    this.#lower = limits.map(([lower]) => lower).reduce((a, b) => (a.seconds >= b.seconds ? a : b));
    this.#upper = limits
      .map(([, upper]) => upper)
      .reduce((a, b) => (a.seconds <= b.seconds ? a : b));
  }

  #findPartners(): readonly { readonly box: ClipBox; readonly row: Row }[] {
    const { model } = this.#host;
    const { clip } = this.#box;
    const here = this.#exactEdge();
    const edgeOf = (other: ClipState) => (this.#edge === "start" ? clipStart : clipEnd)(other);
    const ids = clip.link === undefined ? [] : (model.links.get(clip.link) ?? []);
    return ids.flatMap((id) => {
      const box = model.boxes.get(id);
      const row = model.rowOfClip.get(id);
      const usable = box && row && id !== clip.id && !row.track.locked;
      return usable && compare(edgeOf(box.clip), here) === 0 ? [{ box, row }] : [];
    });
  }

  /** Where this edge can go. A kind of clip that has a beginning cannot go past it. */
  #limits(box: ClipBox, row: Row): readonly [SnapPoint, SnapPoint] {
    const { clip, start, end } = box;
    const { rate } = this.#host.model;
    const index = row.clips.indexOf(box);
    const before = row.clips[index - 1];
    const after = row.clips[index + 1];
    const frame = frameTime(1, rate);
    if (this.#edge === "end") {
      const lower = {
        seconds: start + 1 / rate.fps,
        exact: () => add(clipStart(clip), frame),
      };
      const neighbour = after
        ? { seconds: after.start, exact: () => clipStart(after.clip) }
        : { seconds: Number.POSITIVE_INFINITY, exact: () => ZERO };
      const length = this.#host.sourceLength(clip);
      if (!length) return [lower, neighbour];
      const contentEnd = add(clipStart(clip), subtract(length, clipOffset(clip)));
      const seconds = toSeconds(contentEnd);
      const content = { seconds, exact: () => contentEnd };
      return [lower, seconds < neighbour.seconds ? content : neighbour];
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
    const edge = this.#box[this.#edge];
    const wanted = edge + this.#host.timeAt(pointer.x) - this.#grabTime;
    const within = this.#host.snapDistance(pointer);
    // Back where it came from is the easiest way to change one's mind.
    const point =
      Math.abs(wanted - edge) < within
        ? { seconds: edge, exact: () => this.#exactEdge() }
        : this.#points.nearest(wanted, within);
    const landing = landOn(this.#host, wanted, point);
    this.#landing = this.#clamped(landing);
    const { start, end } = this.#box;
    const { seconds } = this.#landing;
    const moved = this.#edge === "start" ? { start: seconds, end } : { start, end: seconds };
    const clips = new Map([[this.#box.id, { row: this.#row, ...moved }]]);
    for (const partner of this.#partners) {
      const { box, row } = partner;
      const own =
        this.#edge === "start"
          ? { start: seconds, end: box.end }
          : { start: box.start, end: seconds };
      clips.set(box.id, { row, ...own });
    }
    this.#host.setPreview({ clips, ...lineOf(this.#landing) });
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
    const exact = landing.exact();
    if (compare(exact, this.#exactEdge()) === 0) return;
    const ids = [clip.id, ...this.#partners.map(({ box }) => box.id)];
    this.#host.run(
      ids.map((id) => ({
        type: "clip.trim",
        params: { timeline: this.#host.model.id, clip: id, [this.#edge]: formatTime(exact) },
      })),
    );
  }

  cancel(): void {
    this.#host.setPreview(undefined);
  }

  isStale(model: TimelineModel): boolean {
    return !model.boxes.has(this.#box.id);
  }

  #exactEdge(): Rational {
    const { clip } = this.#box;
    return this.#edge === "start" ? clipStart(clip) : clipEnd(clip);
  }

  #clamped(landing: Landing): Landing {
    const limit = ({ seconds, exact }: SnapPoint) => ({ seconds, exact });
    if (landing.seconds <= this.#lower.seconds) return limit(this.#lower);
    if (landing.seconds >= this.#upper.seconds) return limit(this.#upper);
    return landing;
  }
}

const OTHER_EDGE: Readonly<Record<Edge, Edge>> = { enter: "exit", exit: "enter" };

/** How long a transition is, exactly. What cannot be read counts as none, as it does in the picture. */
function exactLength(clip: ClipState, edge: Edge): Rational {
  const transition = clip[edge];
  if (transition === undefined) return ZERO;
  try {
    const length = parseTime(transition.duration);
    return compare(length, ZERO) > 0 ? length : ZERO;
  } catch {
    return ZERO;
  }
}

/**
 * How long the transition at an edge of a clip can be: all of it, apart from the other edge, which
 * a join takes instead of the transition there where one is.
 */
export function longestTransition(
  clip: ClipState,
  edge: Edge,
  model?: Pick<TimelineModel, "ends">,
): Rational {
  const otherEdge = OTHER_EDGE[edge];
  const other = model
    ? takenAt(model.ends, clip, otherEdge === "enter" ? "start" : "end")
    : exactLength(clip, otherEdge);
  const raw = exactLength(clip, otherEdge);
  const taken = compare(other, raw) > 0 ? other : raw;
  const room = subtract(parseTime(clip.duration), taken);
  return compare(room, ZERO) > 0 ? room : ZERO;
}

/**
 * Cuts a clip at a moment, with the clips linked to it, apart from those on locked tracks: they stay
 * whole, and keep their link.
 */
export function splitCall(model: TimelineModel, clip: ClipState, at: string): CommandCall {
  const linked = clip.link === undefined ? [] : (model.links.get(clip.link) ?? []);
  const keep = linked.filter((id) => model.rowOfClip.get(id)?.track.locked === true);
  const params = { timeline: model.id, clip: clip.id, at, ...(keep.length > 0 && { keep }) };
  return { type: "clip.split", params };
}

/**
 * What makes the transition at an edge of a clip this long, or nothing when it stays as it is. One
 * that is not there yet is a fade. A transition of no time is none, and goes from the clip.
 */
export function transitionCall(
  timeline: string,
  clip: ClipState,
  edge: Edge,
  length: Rational,
  model?: Pick<TimelineModel, "ends">,
): CommandCall | undefined {
  const longest = longestTransition(clip, edge, model);
  const limited =
    compare(length, ZERO) < 0 ? ZERO : compare(length, longest) > 0 ? longest : length;
  const current = clip[edge];
  const params = { timeline, clip: clip.id };
  if (compare(limited, ZERO) === 0) {
    if (current === undefined) return undefined;
    return { type: "clip.setTransition", params: { ...params, [edge]: null } };
  }
  if (current !== undefined && compare(limited, exactLength(clip, edge)) === 0) return undefined;
  const duration = formatTime(limited);
  const transition = current ? { ...current, duration } : { type: "fade", duration };
  return { type: "clip.setTransition", params: { ...params, [edge]: transition } };
}

/**
 * Drags the handle at a top corner of a clip, where its transition at that edge ends, as with the
 * fades of most video editors: without a transition there yet, it pulls a fade out of the corner. It
 * goes by frames, or to what it snaps to, and never past the transition at the other edge.
 */
export class TransitionGesture implements Gesture {
  readonly #host: GestureHost;
  readonly #box: ClipBox;
  readonly #edge: Edge;
  readonly #press: Pointer;
  readonly #grabTime: number;
  readonly #points: SnapPoints;
  #length: Landing | undefined;

  constructor(host: GestureHost, box: ClipBox, edge: Edge, press: Pointer) {
    this.#host = host;
    this.#box = box;
    this.#edge = edge;
    this.#press = press;
    this.#grabTime = host.timeAt(press.x);
    this.#points = snapPointsOf(host.model, host.frame, new Set([box.id]));
  }

  move(pointer: Pointer): void {
    if (!this.#length && !hasMoved(this.#press, pointer)) return;
    const { clip, start, end } = this.#box;
    const edges = edgesOf(clip);
    const entering = this.#edge === "enter";
    const handle = entering ? start + edges.enter : end - edges.exit;
    const wanted = handle + this.#host.timeAt(pointer.x) - this.#grabTime;
    const point = this.#points.nearest(wanted, this.#host.snapDistance(pointer));
    const length = point
      ? this.#snapped(point)
      : this.#onFrames(entering ? wanted - start : end - wanted);
    this.#length = this.#limited(length);
    const transition = { clip: this.#box.id, edge: this.#edge, seconds: this.#length.seconds };
    const line = this.#length.line === undefined ? {} : { snap: this.#length.line };
    this.#host.setPreview({ transition, ...line });
  }

  end(pointer: Pointer): void {
    this.move(pointer);
    const length = this.#length;
    if (length) {
      const { model } = this.#host;
      const call = transitionCall(model.id, this.#box.clip, this.#edge, length.exact(), model);
      if (call && this.#host.run([call]) && compare(length.exact(), ZERO) > 0) {
        this.#host.selectTransition(this.#box.id, this.#edge);
      }
    }
    this.#host.setPreview(undefined);
  }

  cancel(): void {
    this.#host.setPreview(undefined);
  }

  isStale(model: TimelineModel): boolean {
    return !model.boxes.has(this.#box.id);
  }

  /** A whole number of frames from the edge, which is what people see in the preview. */
  #onFrames(seconds: number): Landing {
    const { rate } = this.#host.model;
    const frames = Math.max(Math.round(seconds * rate.fps), 0);
    return { seconds: frameSeconds(frames, rate), exact: () => frameTime(frames, rate) };
  }

  #snapped(point: SnapPoint): Landing {
    const { clip, start, end } = this.#box;
    return this.#edge === "enter"
      ? {
          seconds: point.seconds - start,
          exact: () => subtract(point.exact(), clipStart(clip)),
          line: point.seconds,
        }
      : {
          seconds: end - point.seconds,
          exact: () => subtract(clipEnd(clip), point.exact()),
          line: point.seconds,
        };
  }

  #limited(length: Landing): Landing {
    const longest = longestTransition(this.#box.clip, this.#edge, this.#host.model);
    if (length.seconds <= 0) return { seconds: 0, exact: () => ZERO };
    if (length.seconds >= toSeconds(longest))
      return { seconds: toSeconds(longest), exact: () => longest };
    return length;
  }
}

/**
 * Drags an edge of a join, which changes how long it is. In the middle of its cut both edges go,
 * so that it stays in the middle; otherwise the edge away from the cut goes. It goes by frames, or
 * to what it snaps to, and never past what the clips leave room for. Dragged to nothing, it goes.
 */
export class JoinGesture implements Gesture {
  readonly #host: GestureHost;
  readonly #join: JoinBox;
  readonly #edge: "start" | "end";
  readonly #press: Pointer;
  readonly #grabTime: number;
  readonly #points: SnapPoints;
  /** How long the part on the side of the edge is: half of it in the middle of the cut. */
  #part: Landing | undefined;

  constructor(host: GestureHost, join: JoinBox, edge: "start" | "end", press: Pointer) {
    this.#host = host;
    this.#join = join;
    this.#edge = edge;
    this.#press = press;
    this.#grabTime = host.timeAt(press.x);
    this.#points = snapPointsOf(host.model, host.frame, new Set());
  }

  get #centered(): boolean {
    const { align } = this.#join.join.transition;
    return align !== "before" && align !== "after";
  }

  move(pointer: Pointer): void {
    if (!this.#part && !hasMoved(this.#press, pointer)) return;
    const { at, start, end } = this.#join;
    const before = this.#edge === "start";
    const wanted = (before ? start : end) + this.#host.timeAt(pointer.x) - this.#grabTime;
    const point = this.#points.nearest(wanted, this.#host.snapDistance(pointer));
    const cut = () => clipStart(this.#join.to.clip);
    const part: Landing = point
      ? {
          seconds: before ? at - point.seconds : point.seconds - at,
          exact: () => (before ? subtract(cut(), point.exact()) : subtract(point.exact(), cut())),
          line: point.seconds,
        }
      : this.#onFrames(before ? at - wanted : wanted - at);
    this.#part = this.#limited(part);
    const seconds = this.#part.seconds;
    const shown = this.#centered
      ? { start: at - seconds, end: at + seconds }
      : before
        ? { start: at - seconds, end: at }
        : { start: at, end: at + seconds };
    const line = this.#part.line === undefined ? {} : { snap: this.#part.line };
    this.#host.setPreview({ join: { id: this.#join.id, ...shown }, ...line });
  }

  end(pointer: Pointer): void {
    this.move(pointer);
    this.#commit();
    this.#host.setPreview(undefined);
  }

  #commit(): void {
    const part = this.#part;
    if (!part) return;
    const exact = part.exact();
    const length = this.#centered ? add(exact, exact) : exact;
    const { model } = this.#host;
    const { id } = this.#join;
    if (compare(length, ZERO) <= 0) {
      this.#host.run([{ type: "join.remove", params: { timeline: model.id, joins: [id] } }]);
      return;
    }
    if (formatTime(length) === this.#join.join.transition.duration) return;
    const changes = { duration: formatTime(length) };
    if (
      this.#host.run([{ type: "join.update", params: { timeline: model.id, join: id, changes } }])
    ) {
      this.#host.selectJoin(id);
    }
  }

  cancel(): void {
    this.#host.setPreview(undefined);
  }

  isStale(model: TimelineModel): boolean {
    return !model.joins.has(this.#join.id);
  }

  /** A whole number of frames from the cut, which is what people see in the preview. */
  #onFrames(seconds: number): Landing {
    const { rate } = this.#host.model;
    const frames = Math.max(Math.round(seconds * rate.fps), 0);
    return { seconds: frameSeconds(frames, rate), exact: () => frameTime(frames, rate) };
  }

  #limited(part: Landing): Landing {
    const { from, to, join } = this.#join;
    const longest = longestJoin(this.#host.model.ends, from.clip, to.clip, join.transition.align);
    const most = this.#centered ? rational(longest.n, longest.d * 2n) : longest;
    if (part.seconds <= 0) return { seconds: 0, exact: () => ZERO };
    if (part.seconds >= toSeconds(most)) return { seconds: toSeconds(most), exact: () => most };
    return part;
  }
}

/**
 * Draws a box around clips to select them. It adds to the selection when asked to. A box is for
 * doing something with clips, so locked ones stay out of it. With `onClick` it starts on something
 * that a click means something for, and the selection stays until it is clear which of the two it
 * is.
 */
/**
 * A press on the block of a transition. A click selects the transition, and a drag is what it is
 * from anywhere else on the clip: the clip moves, or a copy of it. The clip only gets selected once
 * the drag starts, so that a click goes straight from the transition to the transition.
 */
export class TransitionPressGesture implements Gesture {
  readonly reachesRows = true;
  readonly #press: Pointer;
  readonly #drag: () => Gesture;
  readonly #onClick: () => void;
  #moving: Gesture | undefined;

  constructor(press: Pointer, drag: () => Gesture, onClick: () => void) {
    this.#press = press;
    this.#drag = drag;
    this.#onClick = onClick;
  }

  move(pointer: Pointer): void {
    if (!this.#moving && !hasMoved(this.#press, pointer)) return;
    this.#moving ??= this.#drag();
    this.#moving.move(pointer);
  }

  end(pointer: Pointer): void {
    if (this.#moving) this.#moving.end(pointer);
    else this.#onClick();
  }

  cancel(): void {
    this.#moving?.cancel();
  }

  isStale(model: TimelineModel): boolean {
    return this.#moving?.isStale?.(model) ?? false;
  }
}

export class MarqueeGesture implements Gesture {
  readonly reachesRows = true;
  readonly #host: GestureHost;
  readonly #before: ReadonlySet<string>;
  readonly #base: ReadonlySet<string>;
  readonly #fromTime: number;
  readonly #fromLane: number;
  readonly #press: Pointer;
  readonly #onClick: (() => void) | undefined;
  #active = false;

  constructor(host: GestureHost, press: Pointer, onClick?: () => void) {
    this.#host = host;
    this.#press = press;
    this.#onClick = onClick;
    this.#before = host.selection;
    const adding = press.shift || press.mod || host.multiSelecting;
    this.#base = adding ? host.selection : new Set();
    this.#fromTime = host.timeAt(press.x);
    this.#fromLane = host.laneAt(press.y);
    if (!adding && !onClick) host.select(new Set());
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
      if (row.track.locked) continue;
      forEachBetween(row, marquee.from, marquee.to, (box) => selected.add(box.id));
    }
    this.#host.select(selected);
    this.#host.setPreview({ marquee });
  }

  end(): void {
    if (!this.#active) this.#onClick?.();
    this.#host.setPreview(undefined);
  }

  cancel(): void {
    this.#host.select(this.#before);
    this.#host.setPreview(undefined);
  }
}

/** What it takes to move the playhead by hand. */
export type ScrubHost = Pick<GestureHost, "model" | "frame" | "timeAt" | "snapDistance" | "seek">;

/** Moves the playhead. It goes through every frame, unless asked to stick to edits. */
export class ScrubGesture implements Gesture {
  readonly #host: ScrubHost;
  readonly #points: SnapPoints;
  readonly #before: number;

  constructor(host: ScrubHost, press: Pointer) {
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

export type ClipCopy = Omit<ClipState, "track">;

/**
 * The joins on the cuts between clips of a timeline that are all in a set, as they are: what comes
 * along when those clips get copied. One that another join keeps from its cut does nothing, and
 * stays behind.
 */
export function joinsAmong(model: TimelineModel, clips: Iterable<string>): readonly WholeJoin[] {
  const among = new Set(clips);
  return [...model.joins.values()].flatMap(({ join, trouble }) =>
    trouble !== "taken" && among.has(join.from) && among.has(join.to) ? [join] : [],
  );
}

/**
 * The joins between clips that get copied together, for their copies, which keep where they are
 * to each other: each goes along with a new id, as it was. Where it does not fit, it gets shorter,
 * see `copied` of `join.add`, so that it never stops the copies from coming.
 */
export function copiedJoins(
  timeline: string,
  joins: readonly WholeJoin[],
  clips: readonly string[],
  copies: readonly { readonly id: string }[],
): readonly CommandCall[] {
  const copyOf = new Map(clips.map((id, index) => [id, copies[index]?.id]));
  return joins.flatMap((join) => {
    const from = copyOf.get(join.from);
    const to = copyOf.get(join.to);
    if (from === undefined || to === undefined) return [];
    const { align, ...transition } = join.transition;
    const where = { align: align ?? "center", copied: true };
    return [{ type: "join.add", params: { timeline, from, to, ...transition, ...where } }];
  });
}

/** Clips as new clips. Copies that were linked stay linked to each other, not to the originals. */
export function copiesOf(clips: readonly ClipState[]): readonly ClipCopy[] {
  const links = new Map<string, string>();
  return clips.map(({ track: _track, ...clip }) => {
    const { link } = clip;
    if (link === undefined) return { ...clip, id: newId("clip") };
    if (!links.has(link)) links.set(link, newId("link"));
    return { ...clip, id: newId("clip"), link: links.get(link) as string };
  });
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
      return [splitCall(model, box.clip, at)];
    });
    if (calls.length > 0) this.#host.run(calls);
  }

  cancel(): void {}
}
