import { firstKeyFrom, secondsOf, type PropertyEdit } from "@animaquill/core";
import {
  ZERO,
  add,
  compare,
  formatTime,
  fromSeconds,
  parseTime,
  subtract,
  toSeconds,
  type Key,
  type PropertySpec,
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
import {
  dragHandle,
  tangentOf,
  type ChangedKeys,
  type CurvePoint,
  type HandleSide,
} from "./handles.ts";
import { KeySelection, NO_KEYS, type KeyRef } from "./selection.ts";

/** Without snapping a key can go anywhere, to the millisecond. */
const FREE_STEPS_PER_SECOND = 1000;
/** Moving more keys than this only shows on the keys until the mouse lets go. */
const MAX_KEYS_IN_PICTURE = 2000;
/**
 * Up and down this far from where a key was, its value stays: a key that is dragged along the time
 * moves a little up and down as well. This is about the hand, not about snapping, so it is always so.
 */
const VALUE_STICK = 6;
/** Enough for anything a person means, and it keeps float noise out of project files. */
const KEPT_DIGITS = 6;

/** The handle that is being dragged, and whether it got as far as the pointer. */
export interface HandleHint {
  readonly clip: string;
  readonly path: string;
  readonly time: string;
  readonly side: HandleSide;
  readonly clamped: boolean;
  /** Where the pointer is, which the handle would be at but for what it can hold. */
  readonly x: number;
  readonly y: number;
}

/** What a drag would do. Nothing of it is in the project until the drag ends. */
export interface KeyPreview {
  /** How far the selected keys go, in seconds. */
  readonly shift?: number;
  /** How far the selected numbers go up, in their own units, by `clip path`. */
  readonly lift?: ReadonlyMap<string, number>;
  /** Where something snapped, for the line that shows it. */
  readonly snap?: number;
  readonly marquee?: Marquee;
  readonly handle?: HandleHint;
}

/** The selected keys of one property that can move. */
export interface MovingChannel {
  readonly clip: string;
  readonly path: string;
  readonly times: readonly string[];
}

/** The selected keys of a number that go up and down with the mouse, in a row made taller. */
export interface LiftedChannel {
  readonly clip: string;
  readonly path: string;
  readonly spec: PropertySpec;
  /** The keys that go, by time. What they are is read again with every step of the drag. */
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
  /** Keeps rows from shrinking under the mouse while it drags in them, and lets go of that. */
  holdRanges(rows: readonly { readonly clip: string; readonly path: string }[]): void;
  releaseRanges(): void;
  /**
   * The keys of a property as they are now, without what a drag shows on top of them. A drag works
   * from these with every step, so that what changes elsewhere meanwhile stays.
   */
  keysOf(clip: string, path: string): readonly Key[] | undefined;
  /** What a pixel up is worth in the row of a property here right now. */
  perPixel(clip: string, path: string): number | undefined;
  /** What a drag was about went away while it went on: the drag stops, and says so. */
  gone(): void;
}

const byTime = new WeakMap<readonly Key[], ReadonlyMap<string, Key>>();

/** Keys by their time, as they are written. */
function keysByTime(keys: readonly Key[] | undefined): ReadonlyMap<string, Key> {
  if (!keys) return new Map();
  let found = byTime.get(keys);
  if (!found) byTime.set(keys, (found = new Map(keys.map((key) => [key.time, key]))));
  return found;
}

/** Where a key of a time is among keys, or -1. */
export function indexOfTime(keys: readonly Key[], time: string): number {
  const index = firstKeyFrom(keys, parseTime(time));
  return keys[index]?.time === time ? index : -1;
}

/** A value within what its property can hold, as far as it says. */
export const withinSpec = (spec: PropertySpec, value: number): number =>
  Math.min(
    Math.max(value, spec.min ?? Number.NEGATIVE_INFINITY),
    spec.max ?? Number.POSITIVE_INFINITY,
  );

/** How far a value goes for some pixels, in a step that a pixel is worth: no float noise. */
function liftBy(perPixel: number, pixels: number): number {
  if (pixels === 0 || !(perPixel > 0)) return 0;
  const step = 10 ** Math.floor(Math.log10(perPixel));
  return Number((Math.round((pixels * perPixel) / step) * step).toFixed(KEPT_DIGITS));
}

/** Where `lift` of a preview has what one property goes up by. */
export const liftKey = (clip: string, path: string) => `${clip} ${path}`;

/**
 * The edits of keys that go along the time and up and down: they move, and then the numbers among
 * them get their new values, keeping all else about them as it is now. Undefined when one of the
 * keys that go up or down is not there any more.
 */
export function liftEdits(
  channels: readonly MovingChannel[],
  by: Rational,
  lifted: readonly LiftedChannel[],
  lift: ReadonlyMap<string, number>,
  keysOf: (clip: string, path: string) => readonly Key[] | undefined,
): readonly PropertyEdit[] | undefined {
  const moving = compare(by, ZERO) === 0 ? [] : moveEdits(channels, by);
  const valued: PropertyEdit[] = [];
  for (const { clip, path, spec, times } of lifted) {
    const up = lift.get(liftKey(clip, path)) ?? 0;
    if (up === 0) continue;
    const now = keysByTime(keysOf(clip, path));
    const placed: Key[] = [];
    for (const time of times) {
      const key = now.get(time);
      if (!key || typeof key.value !== "number") return undefined;
      const value = Number(withinSpec(spec, key.value + up).toFixed(KEPT_DIGITS));
      placed.push({ ...key, time: formatTime(add(parseTime(time), by)), value });
    }
    valued.push({ owner: { clip }, path, op: "putKeys", keys: placed });
  }
  return [...moving, ...valued];
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
  /** The numbers among them that go up and down, which is none when what was grabbed is not one. */
  readonly #lifted: readonly LiftedChannel[];
  readonly #points: SnapPoints;
  readonly #inPicture: boolean;
  /** Going further back than this takes the earliest key before its clock starts. */
  readonly #lowest: Rational;
  readonly #onClick: () => void;
  /** Where the press was in the rows, which scroll by themselves near an edge. */
  readonly #pressRowY: number;
  #dragging = false;
  #gone = false;
  #landing: Landing | undefined;
  #lift: ReadonlyMap<string, number> = new Map();

  constructor(
    host: KeyGestureHost,
    grabbed: Grabbed,
    press: Pointer,
    onClick: () => void,
    lifted: readonly LiftedChannel[] = [],
  ) {
    this.#host = host;
    this.#grabbed = grabbed;
    this.#press = press;
    this.#onClick = onClick;
    this.#lifted = lifted;
    this.#pressRowY = host.laneAt(press.y);
    this.#grabTime = host.timeAt(press.x);
    this.#channels = host.moving();
    this.#points = snapPointsOf(host.model, host.frame, new Set(), host.snapTargets());
    this.#lowest = subtract(grabbed.exact(), earliest(this.#channels));
    const keys = this.#channels.reduce((sum, { times }) => sum + times.length, 0);
    this.#inPicture = keys <= MAX_KEYS_IN_PICTURE;
  }

  move(pointer: Pointer): void {
    if (this.#gone || (!this.#dragging && !hasMoved(this.#press, pointer))) return;
    if (!this.#dragging) this.#host.holdRanges(this.#lifted);
    this.#dragging = true;
    // Shift keeps it to the way it went furthest: only along the time, or only up and down.
    const across = Math.abs(pointer.x - this.#press.x);
    const down = this.#host.laneAt(pointer.y) - this.#pressRowY;
    const along = !pointer.shift || across >= Math.abs(down);
    const landing = along ? this.#land(pointer) : this.#stay();
    const pixels = (pointer.shift && along) || Math.abs(down) < VALUE_STICK ? 0 : -down;
    const lift = new Map<string, number>();
    for (const { clip, path } of this.#lifted) {
      // As the row is now, which grows to take in a value that goes past it.
      const up = liftBy(this.#host.perPixel(clip, path) ?? 0, pixels);
      if (up !== 0) lift.set(liftKey(clip, path), up);
    }
    const shift = landing.seconds - this.#grabbed.seconds;
    const previous = this.#landing;
    const sameLift = sameValues(lift, this.#lift);
    this.#landing = landing;
    this.#lift = lift;
    if (!this.#inPicture || (previous?.seconds === landing.seconds && sameLift)) {
      this.#show(shift, lift, landing);
      return;
    }
    const by = this.#by(landing);
    const edits = this.#edits(by, lift);
    if (!edits) return;
    this.#show(shift, lift, landing);
    if (compare(by, ZERO) === 0 && lift.size === 0) this.#host.cancelPreview();
    else this.#host.preview(edits);
  }

  #show(shift: number, lift: ReadonlyMap<string, number>, landing: Landing): void {
    this.#host.show({
      shift,
      ...(lift.size > 0 ? { lift } : {}),
      ...(landing.line === undefined ? {} : { snap: landing.line }),
    });
  }

  /** What the drag comes to from the keys as they are now, or nothing after it stopped for that. */
  #edits(by: Rational, lift: ReadonlyMap<string, number>): readonly PropertyEdit[] | undefined {
    const keysOf = (clip: string, path: string) => this.#host.keysOf(clip, path);
    const edits = liftEdits(this.#channels, by, this.#lifted, lift, keysOf);
    if (edits) return edits;
    this.#stop();
    return undefined;
  }

  /** Some of what was dragged is not there any more, because of an undo or another window. */
  #stop(): void {
    this.#gone = true;
    this.#host.cancelPreview();
    this.#host.show(undefined);
    this.#host.releaseRanges();
    this.#host.gone();
  }

  /** Whether every key that moves is still there. Commands would say so too, less clearly. */
  #allThere(): boolean {
    return this.#channels.every(({ clip, path, times }) => {
      const now = keysByTime(this.#host.keysOf(clip, path));
      return times.every((time) => now.has(time));
    });
  }

  #by(landing: Landing): Rational {
    return subtract(landing.exact(), this.#grabbed.exact());
  }

  /** Where it was, for a drag that only goes up and down. */
  #stay(): Landing {
    const start = this.#grabbed.seconds;
    return { seconds: start, exact: () => this.#grabbed.exact() };
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
    if (this.#gone) return;
    if (!this.#dragging) {
      this.#onClick();
      return;
    }
    this.move(pointer);
    if (this.#gone) return;
    this.#commit();
    this.#host.show(undefined);
    this.#host.releaseRanges();
  }

  #commit(): void {
    const landing = this.#landing;
    const by = landing && this.#by(landing);
    const lift = this.#lift;
    if (!by || (compare(by, ZERO) === 0 && lift.size === 0)) {
      this.#host.cancelPreview();
      return;
    }
    if (!this.#allThere()) {
      this.#stop();
      return;
    }
    const edits = this.#edits(by, lift);
    if (!edits) return;
    const moved = KeySelection.of(movedSelection(this.#host.selection, this.#channels, by));
    if (!this.#host.commit(edits, moved)) this.#host.cancelPreview();
  }

  cancel(): void {
    this.#host.cancelPreview();
    this.#host.show(undefined);
    this.#host.releaseRanges();
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

const sameValues = (a: ReadonlyMap<string, number>, b: ReadonlyMap<string, number>) =>
  a.size === b.size && [...a].every(([key, value]) => b.get(key) === value);

/** What a handle drag needs to know about the row it is in. */
export interface HandleGrab {
  readonly clip: string;
  readonly path: string;
  /** The key whose handle it is, by its time, which stays what it is whatever else changes. */
  readonly time: string;
  readonly side: HandleSide;
  /**
   * Where the pointer is on the clock of the clip and in the units of the property, as the row is
   * now: it grows, and the view scrolls. Undefined when the row is not there to say.
   */
  pointAt(pointer: Pointer): CurvePoint | undefined;
}

/**
 * Drags a handle of a key, which bends the curve as in a curve editor. It goes as far as a handle
 * can, and shows when it stops. Alt moves only this handle and Ctrl keeps the other one on a line
 * with it; without either the key does what it says, or what it looks like it does. One drag is
 * one step, and a click changes nothing.
 */
export class HandleGesture implements Gesture {
  readonly #host: KeyGestureHost;
  readonly #grab: HandleGrab;
  readonly #press: Pointer;
  readonly #usual: "aligned" | "broken";
  #dragging = false;
  #gone = false;
  #changed: ChangedKeys | undefined;

  constructor(host: KeyGestureHost, grab: HandleGrab, press: Pointer) {
    this.#host = host;
    this.#grab = grab;
    this.#press = press;
    const keys = host.keysOf(grab.clip, grab.path) ?? [];
    const index = indexOfTime(keys, grab.time);
    const mode = index < 0 ? "broken" : tangentOf(keys, index);
    // Dragging an automatic handle is saying where it goes, as in Blender: it stays on a line.
    this.#usual = mode === "broken" ? "broken" : "aligned";
  }

  move(pointer: Pointer): void {
    if (this.#gone || (!this.#dragging && !hasMoved(this.#press, pointer))) return;
    if (!this.#dragging) this.#host.holdRanges([this.#grab]);
    this.#dragging = true;
    const { clip, path, time, side } = this.#grab;
    // From the keys as they are now, so that only what the handle steers changes.
    const keys = this.#host.keysOf(clip, path);
    const index = keys ? indexOfTime(keys, time) : -1;
    const to = this.#grab.pointAt(pointer);
    const mode = pointer.alt ? "broken" : pointer.mod ? "aligned" : this.#usual;
    const dragged = keys && index >= 0 && to && dragHandle({ keys, index, side, to, mode });
    if (!dragged) {
      this.#stop();
      return;
    }
    this.#changed = dragged.changed;
    const { clamped } = dragged;
    this.#host.show({ handle: { clip, path, time, side, clamped, x: pointer.x, y: pointer.y } });
    this.#host.preview(this.#edits(dragged.changed));
  }

  /** The key, or what the handle steers, is not there any more: an undo, or another window. */
  #stop(): void {
    this.#gone = true;
    this.#changed = undefined;
    this.#host.cancelPreview();
    this.#host.show(undefined);
    this.#host.releaseRanges();
    this.#host.gone();
  }

  #edits(changed: ChangedKeys): readonly PropertyEdit[] {
    const { clip, path } = this.#grab;
    return [{ owner: { clip }, path, op: "putKeys", keys: [...changed.values()] }];
  }

  end(pointer: Pointer): void {
    if (this.#gone) return;
    if (this.#dragging) this.move(pointer);
    if (this.#gone) return;
    const changed = this.#changed;
    if (changed && !this.#host.commit(this.#edits(changed), this.#host.selection)) {
      this.#host.cancelPreview();
    }
    this.#host.show(undefined);
    this.#host.releaseRanges();
  }

  cancel(): void {
    this.#host.cancelPreview();
    this.#host.show(undefined);
    this.#host.releaseRanges();
  }

  isStale(model: TimelineModel): boolean {
    return !model.boxes.has(this.#grab.clip);
  }
}

/**
 * Pulls the bottom of a row that was made taller, from the height it shows. Only a drag changes the
 * height it keeps: a click does nothing, and Escape puts back what it kept before.
 */
export class TallHeightGesture implements Gesture {
  readonly #resize: (height: number) => void;
  readonly #restore: () => void;
  readonly #from: number;
  readonly #press: Pointer;
  #moved = false;

  constructor(resize: (height: number) => void, restore: () => void, from: number, press: Pointer) {
    this.#resize = resize;
    this.#restore = restore;
    this.#from = from;
    this.#press = press;
  }

  move(pointer: Pointer): void {
    if (!this.#moved && !hasMoved(this.#press, pointer)) return;
    this.#moved = true;
    this.#resize(this.#from + pointer.y - this.#press.y);
  }

  end(pointer: Pointer): void {
    this.move(pointer);
  }

  cancel(): void {
    if (this.#moved) this.#restore();
  }
}
