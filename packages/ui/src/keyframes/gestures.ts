import { secondsOf, type PropertyEdit } from "@animaquill/core";
import {
  ZERO,
  add,
  compare,
  formatTime,
  fromSeconds,
  parseTime,
  subtract,
  toSeconds,
  type Rational,
} from "@animaquill/schema";
import {
  hasMoved,
  landOn,
  type Gesture,
  type Landing,
  type Marquee,
  type Pointer,
} from "../timeline/gestures.ts";
import type { TimelineModel } from "../timeline/model.ts";
import { snapPointsOf, type SnapPoint, type SnapPoints } from "../timeline/snap.ts";
import { KeySelection, NO_KEYS, type KeyRef } from "./selection.ts";

/** Without snapping a key can go anywhere, to the millisecond. */
const FREE_STEPS_PER_SECOND = 1000;
/** Moving more keys than this only shows on the keys until the mouse lets go. */
const MAX_KEYS_IN_PICTURE = 2000;

/** What a drag would do. Nothing of it is in the project until the drag ends. */
export interface KeyPreview {
  /** How far the selected keys go, in seconds. */
  readonly shift?: number;
  /** Where something snapped, for the line that shows it. */
  readonly snap?: number;
  readonly marquee?: Marquee;
}

/** The selected keys of one property that can move. */
export interface MovingChannel {
  readonly clip: string;
  readonly path: string;
  readonly times: readonly string[];
}

/** What gestures on keys need from where they happen. */
export interface KeyGestureHost {
  readonly model: TimelineModel;
  readonly frame: number;
  readonly selection: KeySelection;
  readonly multiSelecting: boolean;
  timeAt(x: number): number;
  laneAt(y: number): number;
  snapDistance(pointer: Pointer): number;
  /** Other keys and such to stick to, on top of what clips offer. */
  snapTargets(): readonly SnapPoint[];
  moving(): readonly MovingChannel[];
  keysIn(marquee: Marquee): readonly KeyRef[];
  select(selection: KeySelection): void;
  show(preview: KeyPreview | undefined): void;
  /** Shows what these would do in the picture. */
  preview(edits: readonly PropertyEdit[]): void;
  cancelPreview(): void;
  /** Writes them as one step, with what is selected afterwards. */
  commit(edits: readonly PropertyEdit[], selection: KeySelection): boolean;
}

/** Where keys go when they all move by the same time. */
export function moveEdits(
  channels: readonly MovingChannel[],
  by: Rational,
): readonly PropertyEdit[] {
  return channels.map(({ clip, path, times }) => ({
    owner: { clip },
    path,
    op: "moveKey",
    moves: times.map((time) => ({ from: time, to: formatTime(add(parseTime(time), by)) })),
  }));
}

/** The keys that `edits` from `moveEdits` move to, instead of where they are. */
export function movedSelection(
  selection: KeySelection,
  channels: readonly MovingChannel[],
  by: Rational,
): readonly KeyRef[] {
  const moved = channels.flatMap(({ clip, path, times }) =>
    times.map((time) => ({ clip, path, time })),
  );
  const leaving = new Set(moved.map(({ clip, path, time }) => `${clip} ${path} ${time}`));
  const staying = [...selection].filter(
    ({ clip, path, time }) => !leaving.has(`${clip} ${path} ${time}`),
  );
  return [
    ...staying,
    ...moved.map((key) => ({ ...key, time: formatTime(add(parseTime(key.time), by)) })),
  ];
}

/** How many seconds the earliest of some keys is on its clock, which is as far back as they go. */
function earliest(channels: readonly MovingChannel[]): Rational {
  let first: string | undefined;
  let seconds = Number.POSITIVE_INFINITY;
  for (const { times } of channels) {
    for (const time of times) {
      const at = secondsOf(time);
      if (at < seconds) [first, seconds] = [time, at];
    }
  }
  return first === undefined ? ZERO : parseTime(first);
}

/** The key that is being held, on the timeline. */
export interface Grabbed {
  readonly seconds: number;
  exact(): Rational;
}

/**
 * Moves the selected keys together. What is grabbed lands on a frame or on what it snaps to, and the
 * others keep their distance to it. Nothing goes before the start of the clock of its clip. Back
 * where it came from it sticks, which is the easiest way to change one's mind.
 */
export class KeyMoveGesture implements Gesture {
  readonly reachesRows = true;
  readonly #host: KeyGestureHost;
  readonly #grabbed: Grabbed;
  readonly #press: Pointer;
  readonly #grabTime: number;
  readonly #channels: readonly MovingChannel[];
  readonly #points: SnapPoints;
  readonly #inPicture: boolean;
  /** Going further back than this takes the earliest key before its clock starts. */
  readonly #lowest: Rational;
  readonly #onClick: () => void;
  #dragging = false;
  #landing: Landing | undefined;

  constructor(host: KeyGestureHost, grabbed: Grabbed, press: Pointer, onClick: () => void) {
    this.#host = host;
    this.#grabbed = grabbed;
    this.#press = press;
    this.#onClick = onClick;
    this.#grabTime = host.timeAt(press.x);
    this.#channels = host.moving();
    this.#points = snapPointsOf(host.model, host.frame, new Set(), host.snapTargets());
    this.#lowest = subtract(grabbed.exact(), earliest(this.#channels));
    const keys = this.#channels.reduce((sum, { times }) => sum + times.length, 0);
    this.#inPicture = keys <= MAX_KEYS_IN_PICTURE;
  }

  move(pointer: Pointer): void {
    if (!this.#dragging && !hasMoved(this.#press, pointer)) return;
    this.#dragging = true;
    const landing = this.#land(pointer);
    const shift = landing.seconds - this.#grabbed.seconds;
    const previous = this.#landing;
    this.#landing = landing;
    this.#host.show({ shift, ...(landing.line === undefined ? {} : { snap: landing.line }) });
    if (!this.#inPicture || previous?.seconds === landing.seconds) return;
    if (shift === 0) this.#host.cancelPreview();
    else this.#host.preview(moveEdits(this.#channels, this.#by(landing)));
  }

  #by(landing: Landing): Rational {
    return subtract(landing.exact(), this.#grabbed.exact());
  }

  #land(pointer: Pointer): Landing {
    const start = this.#grabbed.seconds;
    const wanted = start + this.#host.timeAt(pointer.x) - this.#grabTime;
    const within = this.#host.snapDistance(pointer);
    if (Math.abs(wanted - start) < within) {
      return { seconds: start, exact: () => this.#grabbed.exact(), line: start };
    }
    const lowest = toSeconds(this.#lowest);
    const landing = pointer.alt
      ? this.#anywhere(wanted)
      : landOn(this.#host, wanted, this.#points.nearest(wanted, within));
    return landing.seconds < lowest ? { seconds: lowest, exact: () => this.#lowest } : landing;
  }

  /** Off the grid of frames, for what does not have to be on it. */
  #anywhere(wanted: number): Landing {
    const seconds = Math.round(wanted * FREE_STEPS_PER_SECOND) / FREE_STEPS_PER_SECOND;
    return { seconds, exact: () => fromSeconds(Math.max(seconds, 0)) };
  }

  end(pointer: Pointer): void {
    if (!this.#dragging) {
      this.#onClick();
      return;
    }
    this.move(pointer);
    this.#commit();
    this.#host.show(undefined);
  }

  #commit(): void {
    const landing = this.#landing;
    const by = landing && this.#by(landing);
    if (!by || compare(by, ZERO) === 0) {
      this.#host.cancelPreview();
      return;
    }
    const moved = KeySelection.of(movedSelection(this.#host.selection, this.#channels, by));
    if (!this.#host.commit(moveEdits(this.#channels, by), moved)) this.#host.cancelPreview();
  }

  cancel(): void {
    this.#host.cancelPreview();
    this.#host.show(undefined);
  }

  isStale(model: TimelineModel): boolean {
    return this.#channels.some(({ clip }) => !model.boxes.has(clip));
  }
}

/**
 * Draws a box around keys to select them. It adds to the selection when asked to. With `onClick` it
 * starts on something that a click means something for, and the selection stays until it is clear
 * which of the two it is.
 */
export class KeyMarqueeGesture implements Gesture {
  readonly reachesRows = true;
  readonly #host: KeyGestureHost;
  readonly #before: KeySelection;
  readonly #base: KeySelection;
  readonly #fromTime: number;
  readonly #fromLane: number;
  readonly #press: Pointer;
  readonly #onClick: (() => void) | undefined;
  #active = false;

  constructor(host: KeyGestureHost, press: Pointer, onClick?: () => void) {
    this.#host = host;
    this.#press = press;
    this.#onClick = onClick;
    this.#before = host.selection;
    const adding = press.shift || press.mod || host.multiSelecting;
    this.#base = adding ? host.selection : NO_KEYS;
    this.#fromTime = host.timeAt(press.x);
    this.#fromLane = host.laneAt(press.y);
    if (!adding && !onClick) host.select(NO_KEYS);
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
    this.#host.select(this.#base.with(this.#host.keysIn(marquee)));
    this.#host.show({ marquee });
  }

  end(): void {
    if (!this.#active) this.#onClick?.();
    this.#host.show(undefined);
  }

  cancel(): void {
    this.#host.select(this.#before);
    this.#host.show(undefined);
  }
}

/** Pulls the bottom of a curve. */
export class CurveHeightGesture implements Gesture {
  readonly #resize: (height: number) => void;
  readonly #before: number;
  readonly #fromY: number;

  constructor(resize: (height: number) => void, before: number, press: Pointer) {
    this.#resize = resize;
    this.#before = before;
    this.#fromY = press.y;
  }

  move(pointer: Pointer): void {
    this.#resize(this.#before + pointer.y - this.#fromY);
  }

  end(pointer: Pointer): void {
    this.move(pointer);
  }

  cancel(): void {
    this.#resize(this.#before);
  }
}
