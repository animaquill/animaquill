import { clipStart, effectObjectId, effectsOf, type ClipEffect } from "@animaquill/core";
import {
  ZERO,
  add,
  compare,
  parseTime,
  subtract,
  toSeconds,
  type Rational,
} from "@animaquill/schema";
import { frameAt, frameTime, type FrameRate } from "../timeline/frames.ts";
import type { Gesture, Pointer } from "../timeline/gestures.ts";
import type { ClipBox } from "../timeline/model.ts";
import type { Theme } from "../timeline/stage-painter.ts";
import type { Lane } from "./lanes.ts";

/**
 * When the effects of a clip work, on the timeline itself: with a clip open there, each effect has a
 * thin bar in its row, under the clip, from where it starts to where it ends. Dragging an end of it
 * moves that end, dragging the rest moves all of it, to whole frames, and letting go is one step.
 * See docs/design/resource-panels.md, section 7. Nothing here touches the DOM.
 */

/** How high the bar is, at the bottom of the row of its effect, out of the way of its keys. */
export const RANGE_BAR_HEIGHT = 5;
/** How far up from the bottom of the row a press is about the bar. */
const RANGE_REACH_Y = 10;
/** How close to an end of the bar a press moves that end, in pixels. */
const END_REACH = 5;
/** The least a bar is wide on screen, so that one that works nowhere can still be found. */
const MIN_BAR_WIDTH = 4;

/** The effect that a row is about, with its clip, when it is about one. */
export function effectOfLane(
  lane: Lane,
): { readonly box: ClipBox; readonly effect: ClipEffect } | undefined {
  const { node, box } = lane;
  if (node.kind !== "object" || !box) return undefined;
  const effect = effectsOf(box.clip).find(({ id }) => effectObjectId(id) === node.object.id);
  return effect && { box, effect };
}

/** When an effect works, exactly, from the start of its clip, within it. */
export function rangeOf(
  box: ClipBox,
  effect: Pick<ClipEffect, "start" | "end">,
): { readonly from: Rational; readonly to: Rational } {
  const length = parseTime(box.clip.duration);
  const within = (time: Rational) => (compare(time, length) > 0 ? length : time);
  return {
    from: effect.start === undefined ? ZERO : within(parseTime(effect.start)),
    to: effect.end === undefined ? length : within(parseTime(effect.end)),
  };
}

/** Which part of a bar a press takes: an end, or all of it. */
export type RangePart = "start" | "end" | "move";

/** What is dragged, and where it is so far: from the start of the clip. */
export interface RangePreview {
  readonly clip: string;
  readonly effect: string;
  readonly from: Rational;
  readonly to: Rational;
}

/** What a drag of a bar needs from where it is. */
export interface RangeHost {
  readonly rate: FrameRate;
  timeAt(x: number): number;
  show(preview: RangePreview | undefined): void;
  /** Writes it, as one step. Undefined is the start or the end of the clip, as long as it is. */
  commit(clip: string, effect: string, from: Rational | undefined, to: Rational | undefined): void;
}

/**
 * Where a drag puts a bar, from where the pointer went since the press: an end goes to the frame
 * under it and no further than a frame from the other end, a whole bar keeps its length and stays
 * within the clip, starting on a frame.
 */
export function draggedRange(
  box: ClipBox,
  range: { readonly from: Rational; readonly to: Rational },
  part: RangePart,
  moved: number,
  rate: FrameRate,
): { readonly from: Rational; readonly to: Rational } {
  const start = clipStart(box.clip);
  const length = parseTime(box.clip.duration);
  const frame = frameTime(1, rate);
  /** A moment of the clip on the frame of the timeline nearest to it. */
  const onFrame = (seconds: number) =>
    subtract(frameTime(frameAt(toSeconds(start) + seconds, rate), rate), start);
  const atLeast = (value: Rational, least: Rational) => (compare(value, least) < 0 ? least : value);
  const atMost = (value: Rational, most: Rational) => (compare(value, most) > 0 ? most : value);
  if (part === "start") {
    const from = onFrame(toSeconds(range.from) + moved);
    return { from: atLeast(atMost(from, subtract(range.to, frame)), ZERO), to: range.to };
  }
  if (part === "end") {
    const to = onFrame(toSeconds(range.to) + moved);
    return { from: range.from, to: atMost(atLeast(to, add(range.from, frame)), length) };
  }
  const span = subtract(range.to, range.from);
  let from = atLeast(onFrame(toSeconds(range.from) + moved), ZERO);
  if (compare(add(from, span), length) > 0) from = subtract(length, span);
  return { from: atLeast(from, ZERO), to: add(atLeast(from, ZERO), span) };
}

/** Where the bar of a row is on screen, in pixels, or nothing for a row of no effect. */
export function barOf(
  lane: Lane,
  y: number,
  xAt: (seconds: number) => number,
  preview: RangePreview | undefined,
):
  | {
      readonly left: number;
      readonly right: number;
      readonly top: number;
      readonly box: ClipBox;
      readonly effect: ClipEffect;
    }
  | undefined {
  const found = effectOfLane(lane);
  if (!found) return undefined;
  const { box, effect } = found;
  const dragged = preview?.clip === box.id && preview.effect === effect.id ? preview : undefined;
  const { from, to } = dragged ?? rangeOf(box, effect);
  const left = xAt(box.start + toSeconds(from));
  const right = Math.max(xAt(box.start + toSeconds(to)), left + MIN_BAR_WIDTH);
  return { left, right, top: y + lane.keyHeight - RANGE_BAR_HEIGHT - 2, box, effect };
}

/** Which part of the bar of a row is under a point on screen, if any. */
export function partAt(
  bar: { readonly left: number; readonly right: number; readonly top: number },
  x: number,
  y: number,
): RangePart | undefined {
  if (y < bar.top + RANGE_BAR_HEIGHT - RANGE_REACH_Y || y > bar.top + RANGE_BAR_HEIGHT + 2) {
    return undefined;
  }
  if (x < bar.left - END_REACH || x > bar.right + END_REACH) return undefined;
  const reach = Math.min(END_REACH, (bar.right - bar.left) / 3);
  if (x <= bar.left + reach) return "start";
  if (x >= bar.right - reach) return "end";
  return "move";
}

/** The cursor over a part of a bar. */
export const cursorOfPart = (part: RangePart): string => (part === "move" ? "grab" : "ew-resize");

/** Moves a part of the bar of an effect while the pointer does, and writes it when it lets go. */
export class RangeGesture implements Gesture {
  readonly #host: RangeHost;
  readonly #box: ClipBox;
  readonly #effect: ClipEffect;
  readonly #part: RangePart;
  readonly #range: { readonly from: Rational; readonly to: Rational };
  readonly #startX: number;
  #current: { readonly from: Rational; readonly to: Rational };

  constructor(
    host: RangeHost,
    box: ClipBox,
    effect: ClipEffect,
    part: RangePart,
    pointer: Pointer,
  ) {
    this.#host = host;
    this.#box = box;
    this.#effect = effect;
    this.#part = part;
    this.#range = rangeOf(box, effect);
    this.#current = this.#range;
    this.#startX = pointer.x;
  }

  move(pointer: Pointer): void {
    const host = this.#host;
    const moved = host.timeAt(pointer.x) - host.timeAt(this.#startX);
    this.#current = draggedRange(this.#box, this.#range, this.#part, moved, host.rate);
    host.show({ clip: this.#box.id, effect: this.#effect.id, ...this.#current });
  }

  end(pointer: Pointer): void {
    this.move(pointer);
    this.#host.show(undefined);
    const { from, to } = this.#current;
    const same = compare(from, this.#range.from) === 0 && compare(to, this.#range.to) === 0;
    if (same) return;
    const length = parseTime(this.#box.clip.duration);
    // At the edges of the clip, it works from its start or up to its end, as long as it is.
    this.#host.commit(
      this.#box.id,
      this.#effect.id,
      compare(from, ZERO) <= 0 ? undefined : from,
      compare(to, length) >= 0 ? undefined : to,
    );
  }

  cancel(): void {
    this.#host.show(undefined);
  }
}

/** Draws the bars of the effects of the rows on screen, over them. */
export function paintRangeBars(
  context: CanvasRenderingContext2D,
  theme: Theme,
  lanes: readonly Lane[],
  place: {
    screenY(laneTop: number): number;
    xAt(seconds: number): number;
    readonly preview: RangePreview | undefined;
  },
): void {
  context.save();
  for (const lane of lanes) {
    const bar = barOf(
      lane,
      place.screenY(lane.top),
      (seconds) => place.xAt(seconds),
      place.preview,
    );
    if (!bar) continue;
    context.globalAlpha = bar.effect.enabled === false ? 0.4 : 1;
    context.fillStyle = theme.effect;
    context.beginPath();
    context.roundRect(bar.left, bar.top, bar.right - bar.left, RANGE_BAR_HEIGHT, 2);
    context.fill();
    // The ends, which drag on their own.
    context.fillStyle = "#ffffffcc";
    context.fillRect(bar.left, bar.top, 2, RANGE_BAR_HEIGHT);
    context.fillRect(bar.right - 2, bar.top, 2, RANGE_BAR_HEIGHT);
  }
  context.restore();
}
