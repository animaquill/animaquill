import { BUILT_IN_PROPERTIES } from "@animaquill/schema/properties";
import { clampToUnit, numberAt, type Channel } from "./curve.ts";
import type { RenderLayer, RenderPlan } from "./render-plan.ts";

/**
 * How the world ends up on the picture. The editor page and the compositor both work with these, so
 * what is drawn and what people point at stay the same. Like curve.ts this has to be cheap to load
 * in a sandbox.
 */

/** Part of the format: the short side of the stage, in world units, whatever gets rendered. */
export const STAGE_SHORT_SIDE = 1080;

export interface Size {
  readonly width: number;
  readonly height: number;
}

export interface Rect extends Size {
  readonly x: number;
  readonly y: number;
}

/** As in Canvas: x′ = a·x + c·y + e, and y′ = b·x + d·y + f. */
export type Matrix = readonly [a: number, b: number, c: number, d: number, e: number, f: number];

/** How media goes in its clip box. */
export interface Fitted {
  /** The part of the media that shows, in its pixels. */
  readonly source: Rect;
  /**
   * From pixels of the media to the box. A drawing library works with less precise numbers than this
   * file, so all steps from media to picture go into one matrix and get rounded once: drawn in steps,
   * a scale that is no round number lands a little elsewhere than it used to.
   */
  readonly matrix: Matrix;
}

const defaultOf = (path: string) => BUILT_IN_PROPERTIES[path]?.default as number;

const DEFAULTS = {
  x: defaultOf("transform.x"),
  y: defaultOf("transform.y"),
  anchorX: defaultOf("transform.anchorX"),
  anchorY: defaultOf("transform.anchorY"),
  scale: defaultOf("transform.scale"),
  rotation: defaultOf("transform.rotation"),
  opacity: defaultOf("opacity"),
};

const radians = (degrees: number) => (degrees * Math.PI) / 180;

/** World units per pixel of a picture of this size. Both directions share it: nothing stretches. */
const unitsPerPixel = ({ width, height }: Size) => STAGE_SHORT_SIDE / Math.min(width, height);

/** How much of the world a format shows: a resolution changes pixels, not what is in the picture. */
export function stageOf(format: Size): Size {
  const units = unitsPerPixel(format);
  return { width: format.width * units, height: format.height * units };
}

/** First `second`, then `first`. */
export const multiply = (first: Matrix, second: Matrix): Matrix => {
  const [a, b, c, d, e, f] = first;
  const [a2, b2, c2, d2, e2, f2] = second;
  return [
    a * a2 + c * b2,
    b * a2 + d * b2,
    a * c2 + c * d2,
    b * c2 + d * d2,
    a * e2 + c * f2 + e,
    b * e2 + d * f2 + f,
  ];
};

/**
 * Moments this close are the same moment. Times are floats, and `1/30 + 5/30` is a little less than
 * `6/30`: without this a clip that starts on a frame would start one frame late, and a video would
 * show the frame before the right one.
 */
export const TIME_TOLERANCE = 1e-6;

/** What the clock of a clip reads at a moment on the timeline. */
export const clockOf = (layer: Pick<RenderLayer, "offset" | "start">, time: number): number =>
  layer.offset + time - layer.start;

/**
 * From world units to pixels of the picture. Without a camera it stands still in the middle of the
 * stage, looking at all of it. A camera only changes what comes in here.
 */
export function viewMatrix(
  plan: Pick<RenderPlan, "width" | "height" | "camera">,
  time: number,
): Matrix {
  const { camera, width, height } = plan;
  const x = numberAt(camera["camera.x"], time, 0);
  const y = numberAt(camera["camera.y"], time, 0);
  const zoom = numberAt(camera["camera.zoom"], time, 1);
  const turn = radians(numberAt(camera["camera.rotation"], time, 0));
  const pixels = zoom / unitsPerPixel({ width, height });
  const a = Math.cos(turn) * pixels;
  // The world turns the other way than the camera.
  const b = -Math.sin(turn) * pixels;
  return [a, b, -b, a, width / 2 - (a * x - b * y), height / 2 - (b * x + a * y)];
}

/** A curve can run past zero on its way somewhere, and a box cannot. */
const sizeAt = (channel: Channel | undefined, clock: number) =>
  channel && Math.max(numberAt(channel, clock, 0), 0);

/**
 * The clip box at a moment, in world units. Without a size it follows the stage, so that a clip
 * stays full size in every format, or with `fixed` it is as large as the media. A size in one
 * direction takes the other from the shape of the media. A plain color has no shape of its own.
 */
export function boxOf(
  layer: Pick<RenderLayer, "fit" | "channels" | "offset" | "start">,
  time: number,
  natural: Size | undefined,
  stage: Size,
): Size {
  const clock = clockOf(layer, time);
  const width = sizeAt(layer.channels["transform.width"], clock);
  const height = sizeAt(layer.channels["transform.height"], clock);
  if (width === undefined && height === undefined) {
    return layer.fit === "fixed" && natural ? natural : stage;
  }
  const shape = natural ?? stage;
  const ratio = shape.width / shape.height;
  return {
    width: width ?? (height as number) * ratio,
    height: height ?? (width as number) / ratio,
  };
}

/**
 * From the clip box to the world: take off the anchor, scale, turn, and put it at x and y. The order
 * is part of the format. The box runs from 0, 0 to its size.
 */
export function layerMatrix(layer: RenderLayer, time: number, box: Size): Matrix {
  const { channels } = layer;
  const clock = clockOf(layer, time);
  const x = numberAt(channels["transform.x"], clock, DEFAULTS.x);
  const y = numberAt(channels["transform.y"], clock, DEFAULTS.y);
  const anchorX = numberAt(channels["transform.anchorX"], clock, DEFAULTS.anchorX) * box.width;
  const anchorY = numberAt(channels["transform.anchorY"], clock, DEFAULTS.anchorY) * box.height;
  const scale = numberAt(channels["transform.scale"], clock, DEFAULTS.scale);
  const turn = radians(numberAt(channels["transform.rotation"], clock, DEFAULTS.rotation));
  const a = Math.cos(turn) * scale;
  const b = Math.sin(turn) * scale;
  return [a, b, -b, a, x - (a * anchorX - b * anchorY), y - (b * anchorX + a * anchorY)];
}

/**
 * Where the media goes in its box. `contain` shows all of it, `cover` fills the box and leaves out
 * what sticks out on both sides, and `fixed` fills the box whatever the shape.
 */
export function fitIn(fit: RenderLayer["fit"], natural: Size, box: Size): Fitted {
  const whole = { x: 0, y: 0, width: natural.width, height: natural.height };
  const wide = box.width / natural.width;
  const tall = box.height / natural.height;
  if (fit === "fixed") return { source: whole, matrix: [wide, 0, 0, tall, 0, 0] };
  const scale = fit === "cover" ? Math.max(wide, tall) : Math.min(wide, tall);
  const x = (box.width - natural.width * scale) / 2;
  const y = (box.height - natural.height * scale) / 2;
  const matrix: Matrix = [scale, 0, 0, scale, x, y];
  if (fit === "contain") return { source: whole, matrix };
  const width = box.width / scale;
  const height = box.height / scale;
  const source = { x: -x / scale, y: -y / scale, width, height };
  return { source, matrix };
}

/** How much of a layer shows: its opacity, and its fades on top of that. Canvas ignores too much. */
export function opacityAt(layer: RenderLayer, time: number): number {
  const { fades, start, end } = layer;
  const opacity = numberAt(layer.channels["opacity"], clockOf(layer, time), DEFAULTS.opacity);
  const fadeIn = fades.in > 0 ? clampToUnit((time - start) / fades.in) : 1;
  const fadeOut = fades.out > 0 ? clampToUnit((end - time) / fades.out) : 1;
  return clampToUnit(opacity) * fadeIn * fadeOut;
}
