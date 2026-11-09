import type { TransitionImplementation, TransitionNotDone } from "@animaquill/core";
import type { Point } from "@animaquill/core/view";

/** Where a transition is: at the start of a clip, at its end, or on the cut between two. */
export type TransitionUse = TransitionNotDone["use"];

/** What a transition gets as it is: a value for each of its properties. */
export type TransitionValues = NonNullable<TransitionImplementation["values"]>;

/**
 * The code of a transition, the way any transition is written: a module that gets ready once with
 * `aq` at hand, and says with `aq.render` what draws a frame.
 * The ones that come with the editor are written that way, with nothing that code from elsewhere
 * could not do, and run right here in the compositor because they are the editor's own: the
 * pictures do not have to go anywhere. Code from elsewhere gets `ImageBitmap`s in a sandbox. Here
 * it gets the pictures of the layers as the compositor has them: both go into `drawImage` and
 * `texImage2D` the same way, and code leaves them as they are.
 */
export type TransitionPicture = ImageBitmap | OffscreenCanvas;

/** The corners of a clip box on the picture, in pixels, clockwise from the top left. */
export type Corners = readonly [Point, Point, Point, Point];

/** What the code of a transition gets for each frame. */
export interface TransitionFrame {
  /** The two sides, each a whole picture. Nothing on a side is a picture where nothing shows. */
  readonly from: TransitionPicture;
  readonly to: TransitionPicture;
  /** How far it got, after the speed curve: 0 to 1, or past that for one that may overshoot. */
  readonly progress: number;
  /** Seconds since it started. */
  readonly time: number;
  /** How long it takes, in seconds, as far as there is room for it. */
  readonly duration: number;
  readonly use: TransitionUse;
  /** Where the clip boxes of the sides are, or null for nothing, or for more than one clip. */
  readonly boxes: { readonly from: Corners | null; readonly to: Corners | null };
  /** What people set for its properties, with the defaults for the rest. They have no keys. */
  readonly values: TransitionValues;
  /** Pixels of the picture, which the canvas and both sides have. */
  readonly width: number;
  readonly height: number;
  /** Pixels per unit of the world: fewer while the preview draws with fewer pixels. */
  readonly pixelRatio: number;
  /** Where the frame goes. Each frame paints all of it, with premultiplied colors. */
  readonly canvas: OffscreenCanvas;
}

/** What code gets as `aq`. */
export interface TransitionHost {
  readonly canvas: OffscreenCanvas;
  /** What draws a frame. When it returns, the canvas is the frame. The last one said counts. */
  render(draw: (frame: TransitionFrame) => void): void;
  /**
   * A clear canvas of this size for steps in between, while a frame gets drawn: it goes back when
   * the frame is done, and its memory goes once frames stop taking it for a while. Code that keeps
   * canvases of its own keeps their memory as long as it runs.
   */
  scratch(width: number, height: number): OffscreenCanvas;
}

/** The code of a transition, which runs once with `aq`, like the top of a module. */
export type TransitionCode = (aq: TransitionHost) => void;

/** A share, as the canvas takes one: it leaves the one before in place for anything else. */
export const share = (value: number): number =>
  Number.isFinite(value) ? Math.min(Math.max(value, 0), 1) : 0;

/** Which way each direction goes, as x and y, with y down as on the screen. */
const DIRECTIONS: Readonly<Record<string, readonly [number, number]>> = {
  left: [-1, 0],
  right: [1, 0],
  up: [0, -1],
  down: [0, 1],
};

/** Which way something goes, as x and y of length one, from the `direction` of a transition. */
export function directionOf(value: unknown): readonly [number, number] {
  const known = typeof value === "string" && Object.hasOwn(DIRECTIONS, value);
  return known ? (DIRECTIONS[value] as readonly [number, number]) : [1, 0];
}

/** Gets a canvas ready for a new frame: nothing on it, and nothing left of the one before. */
export function clear(
  context: OffscreenCanvasRenderingContext2D,
  width: number,
  height: number,
): void {
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.globalCompositeOperation = "source-over";
  context.globalAlpha = 1;
  context.clearRect(0, 0, width, height);
}

/** A 2D context, which every canvas has one way or another. */
export function contextOf(canvas: OffscreenCanvas): OffscreenCanvasRenderingContext2D {
  const context = canvas.getContext("2d");
  if (!context) throw new Error("No 2D context");
  return context;
}
