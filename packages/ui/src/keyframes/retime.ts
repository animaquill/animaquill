import {
  clipOffset,
  clipStart,
  retimedTime,
  type ClipState,
  type ClockFrames,
  type ClipPropertyEdit,
} from "@animaquill/core";
import {
  ZERO,
  add,
  compare,
  divide,
  formatTime,
  fromSeconds,
  multiply,
  parseTime,
  rational,
  subtract,
  toSeconds,
  type Rational,
} from "@animaquill/schema";
import {
  hasMoved,
  landOn,
  type Gesture,
  type Landing,
  type Pointer,
} from "../timeline/gestures.ts";
import type { TimelineModel } from "../timeline/model.ts";
import { snapPointsOf, type SnapPoints } from "../timeline/snap.ts";
import type { KeyGestureHost, MovingChannel } from "./gestures.ts";
import { KeySelection, type KeyRef } from "./selection.ts";

/** Without snapping an edge can go anywhere, to the millisecond, as keys can. */
const FREE_STEPS_PER_SECOND = 1000;
/** Stretching more keys than this only shows on the keys until the mouse lets go. */
const MAX_KEYS_IN_PICTURE = 2000;

/** Which edge of the box around the selected keys. */
export type RetimeSide = "start" | "end";

/** Where the selected keys are on the timeline, from the earliest to the latest. */
export interface RetimeSpan {
  readonly first: Rational;
  readonly last: Rational;
  readonly firstSeconds: number;
  readonly lastSeconds: number;
}

/**
 * How a box drag shows on the keys, on the timeline: the edge that was at `edge` is at `to`, the
 * one at `anchor` stays, and everything in between goes in proportion. With `frames` each key goes
 * to the nearest frame, as the command does.
 */
export interface RetimePreview {
  readonly anchor: number;
  readonly edge: number;
  readonly to: number;
  readonly frames: boolean;
}

/** Where a key at `seconds` on the timeline shows while a box is dragged. */
export function retimedSeconds(preview: RetimePreview, seconds: number, fps: number): number {
  const { anchor, edge, to, frames } = preview;
  const moved = anchor + ((seconds - anchor) * (to - anchor)) / (edge - anchor);
  return frames ? Math.round(moved * fps) / fps : moved;
}

type ClipOf = (clip: string) => ClipState | undefined;

/** From the timeline to the clock of a clip: add this. */
const shiftOf = (clip: ClipState): Rational => subtract(clipOffset(clip), clipStart(clip));

/**
 * The span of the selected keys that can change, on the timeline, when they are at two moments or
 * more: one moment has nothing to stretch.
 */
export function retimeSpanOf(
  channels: readonly MovingChannel[],
  clipOf: ClipOf,
): RetimeSpan | undefined {
  let first: Rational | undefined;
  let last: Rational | undefined;
  for (const { clip, times } of channels) {
    const state = clipOf(clip);
    if (!state) continue;
    const shift = shiftOf(state);
    for (const time of times) {
      const moment = subtract(parseTime(time), shift);
      if (!first || compare(moment, first) < 0) first = moment;
      if (!last || compare(moment, last) > 0) last = moment;
    }
  }
  if (!first || !last || compare(first, last) === 0) return undefined;
  return { first, last, firstSeconds: toSeconds(first), lastSeconds: toSeconds(last) };
}

/** The frames of the project on the clock of a clip. */
const framesOf = (clip: ClipState, rate: Rational): ClockFrames => ({ rate, shift: shiftOf(clip) });

/**
 * The edits that map `from` onto `to`, both on the timeline, for each property: each on the clock
 * of its own clip, by the same share.
 */
export function retimeEdits(
  channels: readonly MovingChannel[],
  clipOf: ClipOf,
  from: readonly [Rational, Rational],
  to: readonly [Rational, Rational],
  frames: boolean,
): readonly ClipPropertyEdit[] {
  return channels.flatMap(({ clip, path, times }): ClipPropertyEdit[] => {
    const state = clipOf(clip);
    if (!state) return [];
    const shift = shiftOf(state);
    const clock = (moment: Rational) => formatTime(add(moment, shift));
    return [
      {
        owner: { clip },
        path,
        op: "retimeKeys",
        times: [...times],
        from: [clock(from[0]), clock(from[1])],
        to: [clock(to[0]), clock(to[1])],
        ...(frames && { frames: true as const }),
      },
    ];
  });
}

/** What is selected after `retimeEdits`: the moved keys where they went, the rest as it was. */
export function retimedSelection(
  selection: KeySelection,
  channels: readonly MovingChannel[],
  clipOf: ClipOf,
  from: readonly [Rational, Rational],
  to: readonly [Rational, Rational],
  rate: Rational | undefined,
): KeySelection {
  const leaving = new Set<string>();
  const moved: KeyRef[] = [];
  for (const { clip, path, times } of channels) {
    const state = clipOf(clip);
    if (!state) continue;
    const shift = shiftOf(state);
    const clockFrom = [add(from[0], shift), add(from[1], shift)] as const;
    const clockTo = [add(to[0], shift), add(to[1], shift)] as const;
    const frames = rate && framesOf(state, rate);
    for (const time of times) {
      leaving.add(`${clip} ${path} ${time}`);
      const landed = retimedTime(parseTime(time), clockFrom, clockTo, frames);
      moved.push({ clip, path, time: formatTime(landed) });
    }
  }
  const staying = [...selection].filter(
    ({ clip, path, time }) => !leaving.has(`${clip} ${path} ${time}`),
  );
  return KeySelection.of([...staying, ...moved]);
}

/**
 * How close the edges can come, so that keys of one property stay at least a frame apart: the
 * closest two of them are that much of the whole span. At least a frame either way.
 */
export function shortestSpan(
  channels: readonly MovingChannel[],
  { first, last }: RetimeSpan,
  rate: Rational,
): Rational {
  const frame = divide(rational(1n), rate);
  let closest: Rational | undefined;
  for (const { times } of channels) {
    const sorted = times.map(parseTime).toSorted(compare);
    for (let index = 1; index < sorted.length; index += 1) {
      const gap = subtract(sorted[index] as Rational, sorted[index - 1] as Rational);
      if (compare(gap, ZERO) > 0 && (!closest || compare(gap, closest) < 0)) closest = gap;
    }
  }
  if (!closest) return frame;
  const { n, d } = divide(subtract(last, first), closest);
  const frames = (n + d - 1n) / d;
  return multiply(frame, rational(frames > 0n ? frames : 1n));
}

/**
 * How far to the left the dragged edge can go, so that no key goes before the clock of its clip
 * starts: a key that is a share `u` of the way from the anchor to the edge is at
 * `anchor + u · (edge − anchor)`.
 */
function lowestEdge(
  channels: readonly MovingChannel[],
  clipOf: ClipOf,
  anchor: Rational,
  edge: Rational,
): Rational | undefined {
  let lowest: Rational | undefined;
  const width = subtract(edge, anchor);
  for (const { clip, times } of channels) {
    const state = clipOf(clip);
    if (!state) continue;
    const shift = shiftOf(state);
    // Where the clock is 0, on the timeline.
    const zero = subtract(ZERO, shift);
    for (const time of times) {
      const share = divide(subtract(subtract(parseTime(time), shift), anchor), width);
      if (compare(share, ZERO) <= 0) continue;
      const bound = add(anchor, divide(subtract(zero, anchor), share));
      if (!lowest || compare(bound, lowest) > 0) lowest = bound;
    }
  }
  return lowest;
}

const maxOf = (a: Rational, b: Rational) => (compare(a, b) >= 0 ? a : b);

/** The first frame at or after a moment. */
function frameAtOrAfter(moment: Rational, rate: Rational): Rational {
  const { n, d } = multiply(moment, rate);
  const whole = n / d + (n > 0n && n % d !== 0n ? 1n : 0n);
  return divide(rational(whole), rate);
}

/**
 * Drags an edge of the box around the selected keys: all of them stretch or squeeze in time from
 * the other edge, and past it they turn around. The edge lands on a frame or on what it snaps to,
 * and the keys go to the nearest frame; with Alt nothing snaps, and the keys go exactly where the
 * share puts them. It stops where two keys of one property would come closer than a frame, and
 * where a key would go before the clock of its clip starts. Back where it was it sticks, and that
 * writes nothing; one drag is one step.
 */
export class RetimeGesture implements Gesture {
  readonly reachesRows = true;
  readonly #host: KeyGestureHost;
  readonly #channels: readonly MovingChannel[];
  readonly #anchor: Rational;
  readonly #edge: Rational;
  readonly #anchorSeconds: number;
  readonly #edgeSeconds: number;
  readonly #press: Pointer;
  readonly #pressTime: number;
  readonly #points: SnapPoints;
  readonly #shortest: Rational;
  readonly #lowest: Rational | undefined;
  readonly #inPicture: boolean;
  #dragging = false;
  #gone = false;
  #landing: { readonly to: Rational; readonly frames: boolean } | undefined;

  constructor(host: KeyGestureHost, side: RetimeSide, span: RetimeSpan, press: Pointer) {
    this.#host = host;
    this.#press = press;
    this.#pressTime = host.timeAt(press.x);
    this.#channels = host.moving();
    const start = side === "start";
    this.#anchor = start ? span.last : span.first;
    this.#edge = start ? span.first : span.last;
    this.#anchorSeconds = toSeconds(this.#anchor);
    this.#edgeSeconds = toSeconds(this.#edge);
    this.#points = snapPointsOf(host.model, host.frame, new Set(), host.snapTargets());
    const { exact } = host.model.rate;
    this.#shortest = shortestSpan(this.#channels, span, exact);
    this.#lowest = lowestEdge(this.#channels, this.#clipOf, this.#anchor, this.#edge);
    const keys = this.#channels.reduce((sum, { times }) => sum + times.length, 0);
    this.#inPicture = keys <= MAX_KEYS_IN_PICTURE;
  }

  #clipOf = (clip: string): ClipState | undefined => this.#host.model.boxes.get(clip)?.clip;

  move(pointer: Pointer): void {
    if (this.#gone || (!this.#dragging && !hasMoved(this.#press, pointer))) return;
    this.#dragging = true;
    const wanted = this.#edgeSeconds + this.#host.timeAt(pointer.x) - this.#pressTime;
    const landing = this.#land(pointer, wanted);
    const frames = !pointer.alt;
    const to = this.#within(landing.exact(), frames);
    const previous = this.#landing;
    this.#landing = { to, frames };
    const toSecondsNow = toSeconds(to);
    const snap = compare(to, landing.exact()) === 0 ? landing.line : undefined;
    this.#host.show({
      retime: {
        anchor: this.#anchorSeconds,
        edge: this.#edgeSeconds,
        to: toSecondsNow,
        frames,
      },
      ...(snap === undefined ? {} : { snap }),
    });
    if (previous && compare(previous.to, to) === 0 && previous.frames === frames) return;
    if (compare(to, this.#edge) === 0) {
      this.#host.cancelPreview();
      return;
    }
    if (!this.#inPicture) return;
    if (!this.#allThere()) {
      this.#stop();
      return;
    }
    this.#host.preview(this.#edits(to, frames));
  }

  #land(pointer: Pointer, wanted: number): Landing {
    const start = this.#edgeSeconds;
    const within = this.#host.snapDistance(pointer);
    // Back where it was, it sticks: the easiest way to change one's mind.
    if (Math.abs(wanted - start) < Math.max(within, Number.EPSILON)) {
      return { seconds: start, exact: () => this.#edge, line: start };
    }
    if (pointer.alt) {
      const seconds = Math.round(wanted * FREE_STEPS_PER_SECOND) / FREE_STEPS_PER_SECOND;
      return { seconds, exact: () => fromSeconds(seconds) };
    }
    return landOn(this.#host, wanted, this.#points.nearest(wanted, within));
  }

  /**
   * Where the edge can be: not before a key would leave the clock of its clip, and not closer to the
   * other edge than the shortest span, either side of it.
   */
  #within(wanted: Rational, frames: boolean): Rational {
    if (compare(wanted, this.#edge) === 0) return wanted;
    const { exact: rate } = this.#host.model.rate;
    const lowest = this.#lowest && (frames ? frameAtOrAfter(this.#lowest, rate) : this.#lowest);
    let to = lowest ? maxOf(wanted, lowest) : wanted;
    const anchor = this.#anchor;
    const away = subtract(to, anchor);
    const shortest = this.#shortest;
    const absolute = compare(away, ZERO) < 0 ? subtract(ZERO, away) : away;
    if (compare(absolute, shortest) < 0) {
      // On the side it is on, or else the side the edge started on.
      const side = compare(away, ZERO) !== 0 ? compare(away, ZERO) : compare(this.#edge, anchor);
      to = side > 0 ? add(anchor, shortest) : subtract(anchor, shortest);
      if (lowest && compare(to, lowest) < 0) to = add(anchor, shortest);
    }
    return to;
  }

  #edits(to: Rational, frames: boolean): readonly ClipPropertyEdit[] {
    const from = [this.#anchor, this.#edge] as const;
    return retimeEdits(this.#channels, this.#clipOf, from, [this.#anchor, to], frames);
  }

  /** Whether every key that moves is still there. Commands would say so too, less clearly. */
  #allThere(): boolean {
    return this.#channels.every(({ clip, path, times }) => {
      const keys = this.#host.keysOf(clip, path);
      if (!keys) return false;
      const there = new Set(keys.map(({ time }) => time));
      return times.every((time) => there.has(time));
    });
  }

  #stop(): void {
    this.#gone = true;
    this.#host.cancelPreview();
    this.#host.show(undefined);
    this.#host.gone();
  }

  end(pointer: Pointer): void {
    if (this.#gone || !this.#dragging) {
      if (!this.#gone) this.#host.show(undefined);
      return;
    }
    this.move(pointer);
    if (this.#gone) return;
    this.#host.show(undefined);
    const landing = this.#landing;
    if (!landing || compare(landing.to, this.#edge) === 0) {
      this.#host.cancelPreview();
      return;
    }
    if (!this.#allThere()) {
      this.#stop();
      return;
    }
    const { to, frames } = landing;
    const from = [this.#anchor, this.#edge] as const;
    const onto = [this.#anchor, to] as const;
    const rate = frames ? this.#host.model.rate.exact : undefined;
    const selection = retimedSelection(
      this.#host.selection,
      this.#channels,
      this.#clipOf,
      from,
      onto,
      rate,
    );
    if (!this.#host.commit(this.#edits(to, frames), selection)) this.#host.cancelPreview();
  }

  cancel(): void {
    this.#host.cancelPreview();
    this.#host.show(undefined);
  }

  isStale(model: TimelineModel): boolean {
    return this.#channels.some(({ clip }) => !model.boxes.has(clip));
  }
}
