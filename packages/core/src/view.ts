import { builtInEffect, effectPath } from "@animaquill/schema/effects";
import { BUILT_IN_PROPERTIES } from "@animaquill/schema/properties";
import type { Value } from "@animaquill/schema";
import { bezierProgress, clampToUnit, numberAt, sample, type Channel } from "./curve.ts";
import type { PlannedEffect, PlannedTransition, RenderLayer, RenderPlan } from "./render-plan.ts";

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

export interface Point {
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

/** Where a point ends up. */
export const transformPoint = ([a, b, c, d, e, f]: Matrix, { x, y }: Point): Point => ({
  x: a * x + c * y + e,
  y: b * x + d * y + f,
});

/**
 * The way back: from where something is shown to where it is, as for a pointer on the picture.
 * Undefined for what squeezes everything onto a line or a point, like a scale of 0, which nothing
 * can undo.
 */
export function invert([a, b, c, d, e, f]: Matrix): Matrix | undefined {
  const determinant = a * d - b * c;
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12) return undefined;
  return [
    d / determinant,
    -b / determinant,
    -c / determinant,
    a / determinant,
    (c * f - d * e) / determinant,
    (b * e - a * f) / determinant,
  ];
}

/**
 * Moments this close are the same moment. Times are floats, and `1/30 + 5/30` is a little less than
 * `6/30`: without this a clip that starts on a frame would start one frame late, and a video would
 * show the frame before the right one.
 */
export const TIME_TOLERANCE = 1e-6;

/** Whether a layer is in the picture at a moment. Its end belongs to what comes after it. */
export const showsAt = (
  { start, end }: Pick<RenderLayer, "start" | "end">,
  seconds: number,
): boolean => seconds >= start - TIME_TOLERANCE && seconds < end - TIME_TOLERANCE;

/** Where a layer is in the picture: its clip, and what a join has it show past that. */
export const rangeOf = ({
  start,
  end,
  shows,
}: Pick<RenderLayer, "start" | "end" | "shows">): Pick<RenderLayer, "start" | "end"> =>
  shows ? { start: Math.min(shows.from, start), end: Math.max(shows.to, end) } : { start, end };

/** Whether a layer is in the picture at a moment, also past its clip for a join. */
export const isShownAt = (
  layer: Pick<RenderLayer, "start" | "end" | "shows">,
  seconds: number,
): boolean => showsAt(rangeOf(layer), seconds);

/**
 * The last frame a scene can be on, years into it. A clip can say anything about its clock, and
 * what is not a safe integer cannot even be asked for.
 */
export const MAX_SCENE_FRAME = 2 ** 31 - 1;

/** What frame a scene is on when the clock of its clip reads this. */
export function sceneFrameOf(
  clock: number,
  { num, den }: { readonly num: number; readonly den: number },
): number {
  const frame = Math.floor((clock * num) / den + TIME_TOLERANCE);
  return Number.isNaN(frame) ? 0 : Math.min(Math.max(frame, 0), MAX_SCENE_FRAME);
}

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

/** What puts a clip box in the world, at one moment. */
export interface Transform {
  /** Where the anchor is, in world units. */
  readonly x: number;
  readonly y: number;
  /** Which point of the box the anchor is, as shares of it. */
  readonly anchorX: number;
  readonly anchorY: number;
  readonly scale: number;
  /** Degrees, clockwise. */
  readonly rotation: number;
}

/** The transform of a layer at a moment on the timeline. */
export function transformAt(
  layer: Pick<RenderLayer, "channels" | "offset" | "start">,
  time: number,
): Transform {
  const { channels } = layer;
  const clock = clockOf(layer, time);
  return {
    x: numberAt(channels["transform.x"], clock, DEFAULTS.x),
    y: numberAt(channels["transform.y"], clock, DEFAULTS.y),
    anchorX: numberAt(channels["transform.anchorX"], clock, DEFAULTS.anchorX),
    anchorY: numberAt(channels["transform.anchorY"], clock, DEFAULTS.anchorY),
    scale: numberAt(channels["transform.scale"], clock, DEFAULTS.scale),
    rotation: numberAt(channels["transform.rotation"], clock, DEFAULTS.rotation),
  };
}

/**
 * From a clip box to the world: take off the anchor, scale, turn, and put it at x and y. The order
 * is part of the format. The box runs from 0, 0 to its size.
 */
export function matrixOf(transform: Transform, box: Size): Matrix {
  const { x, y, scale } = transform;
  const anchorX = transform.anchorX * box.width;
  const anchorY = transform.anchorY * box.height;
  const turn = radians(transform.rotation);
  const a = Math.cos(turn) * scale;
  const b = Math.sin(turn) * scale;
  return [a, b, -b, a, x - (a * anchorX - b * anchorY), y - (b * anchorX + a * anchorY)];
}

/** From the clip box of a layer to the world, at a moment: see `matrixOf`. */
export function layerMatrix(layer: RenderLayer, time: number, box: Size): Matrix {
  return matrixOf(transformAt(layer, time), box);
}

/**
 * The size a scene lays itself out in: its clip box where its clip starts. A scene is a page, which
 * needs some room to be one.
 */
export function sceneViewOf(
  layer: Pick<RenderLayer, "fit" | "channels" | "offset" | "start">,
  stage: Size,
): Size {
  const box = boxOf(layer, layer.start, undefined, stage);
  return { width: Math.max(box.width, 1), height: Math.max(box.height, 1) };
}

/**
 * From the coordinates of a scene to its clip box. A scene has its origin in the middle of its box,
 * and a unit of it is a CSS pixel of its page, which a box of another size than the one it was laid
 * out for stretches along with the picture.
 */
export function sceneMatrix(view: Size, box: Size): Matrix {
  return [box.width / view.width, 0, 0, box.height / view.height, box.width / 2, box.height / 2];
}

/**
 * What part of its box a picture covers, in units of the box. Contained media leaves bars on two
 * sides, everything else fills its box.
 */
export function pictureIn(fit: RenderLayer["fit"], natural: Size | undefined, box: Size): Rect {
  const whole = { x: 0, y: 0, width: box.width, height: box.height };
  if (fit !== "contain" || !natural || natural.width <= 0 || natural.height <= 0) return whole;
  const [scale, , , , x, y] = fitIn(fit, natural, box).matrix;
  return { x, y, width: natural.width * scale, height: natural.height * scale };
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

/** How much of a layer shows by its opacity. Canvas ignores too much. Transitions come after it. */
export function opacityAt(layer: RenderLayer, time: number): number {
  const opacity = numberAt(layer.channels["opacity"], clockOf(layer, time), DEFAULTS.opacity);
  return clampToUnit(opacity);
}

/**
 * How far a transition has got at a moment: its speed curve over its time, from 0 before it to 1
 * after it. Without a curve that is the share of its time that has passed. A curve that goes past
 * 0 and 1 stops there, which only a transition that may overshoot does not do.
 */
export function progressAt(
  transition: Pick<PlannedTransition, "start" | "duration" | "curve" | "overshoot">,
  time: number,
): number {
  const { start, duration, curve } = transition;
  if (!(duration > 0)) return time < start ? 0 : 1;
  const share = clampToUnit((time - start) / duration);
  if (!curve) return share;
  // The format keeps curves in reach, but what comes out of one is never anything but a number.
  const curved = bezierProgress(...curve, share);
  if (!Number.isFinite(curved)) return share;
  return transition.overshoot ? curved : clampToUnit(curved);
}

/**
 * Whether a transition at an edge of a layer is a fade, which is the picture of the layer times
 * its progress: the compositor draws that with less opacity, and what it cannot do is one too.
 */
export const isFade = (transition: Pick<PlannedTransition, "how">): boolean =>
  transition.how.type === "fade";

/** What is left of a transition at a moment: 1 − progress, as a fade out has always worked it out. */
function leftAt(transition: PlannedTransition, time: number): number {
  const { end, duration, curve } = transition;
  if (curve || !(duration > 0)) return 1 - progressAt(transition, time);
  return clampToUnit((end - time) / duration);
}

/**
 * How much of a layer shows at a moment: its opacity, times the progress of a fade in and times what
 * is left of a fade out. What this editor cannot do shows as a fade. Any other transition at an edge
 * gets the picture of the layer to work on, which this is the opacity of. Where both are fades at
 * once, the exit fades what the enter made, which comes to the same as one after the other.
 * Multiplied in this order, it is to the last bit what fades always were.
 */
export function shownAt(layer: RenderLayer, time: number): number {
  let shown = opacityAt(layer, time);
  if (layer.enter && isFade(layer.enter)) shown *= progressAt(layer.enter, time);
  if (layer.exit && isFade(layer.exit)) shown *= leftAt(layer.exit, time);
  return shown;
}

/** What is left of a fade out at a moment, for a picture that something else made first. */
export const fadeLeftAt = (transition: PlannedTransition, time: number): number =>
  leftAt(transition, time);

/**
 * A transition of a layer at a moment that this editor cannot do. An export stops there, instead of
 * putting a fade in the file where the project says something else.
 */
export function missingTransitionAt(
  layer: Pick<RenderLayer, "enter" | "exit">,
  time: number,
): PlannedTransition | undefined {
  return [layer.enter, layer.exit].find(
    (transition) =>
      transition?.missing === true &&
      time >= transition.start - TIME_TOLERANCE &&
      time < transition.end - TIME_TOLERANCE,
  );
}

/** How a layer goes onto what is below it, at a moment. See `blend` in the project format. */
export type BlendMode = "normal" | "multiply" | "screen" | "overlay" | "darken" | "lighten" | "add";

const BLEND_MODES: ReadonlySet<string> = new Set(
  (BUILT_IN_PROPERTIES["blend"]?.options ?? []) as readonly string[],
);

/** The blend mode of a layer at a moment, `normal` where it says nothing that is one. */
export function blendAt(layer: Pick<RenderLayer, "channels" | "offset" | "start">, time: number) {
  const channel = layer.channels["blend"];
  const value = channel ? sample(channel, clockOf(layer, time)) : undefined;
  return (typeof value === "string" && BLEND_MODES.has(value) ? value : "normal") as BlendMode;
}

/** What an effect of a layer takes at a moment, by parameter, and whether that changes anything. */
export interface EffectValues {
  readonly values: Readonly<Record<string, Value>>;
  /** Every parameter is at its default, where an effect leaves the picture as it is. */
  readonly idle: boolean;
}

/**
 * What an effect of a layer takes at a moment: each parameter from its channel, or else its default.
 * A number past the limits of its parameter counts as the limit.
 */
export function effectValuesAt(
  layer: Pick<RenderLayer, "channels" | "offset" | "start">,
  effect: PlannedEffect,
  time: number,
): EffectValues {
  const spec = effect.missing ? undefined : builtInEffect(effect.type);
  const clock = clockOf(layer, time);
  const values: Record<string, Value> = {};
  let idle = true;
  for (const parameter of spec?.properties ?? []) {
    const channel = layer.channels[effectPath(effect.id, parameter.path)];
    let value = channel ? sample(channel, clock) : parameter.default;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) value = parameter.default;
      else value = Math.min(Math.max(value, parameter.min ?? -Infinity), parameter.max ?? Infinity);
    }
    if (value === undefined) continue;
    values[parameter.path] = value;
    if (value !== parameter.default) idle = false;
  }
  return { values, idle };
}
