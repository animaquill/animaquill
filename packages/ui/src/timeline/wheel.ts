/** What the wheel or two fingers on a trackpad ask for. */
export type WheelAction =
  | { readonly kind: "scroll"; readonly dx: number; readonly dy: number }
  | { readonly kind: "zoom"; readonly factor: number }
  | { readonly kind: "zoomRows"; readonly factor: number };

export interface WheelInput {
  readonly deltaX: number;
  readonly deltaY: number;
  /** In lines instead of pixels, which only mice do. */
  readonly lines: boolean;
  /** The older value browsers keep: a notch of a mouse wheel is a multiple of 120. */
  readonly wheelDelta: number;
  readonly ctrl: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
  /** Milliseconds. */
  readonly time: number;
}

/**
 * Where the wheel is: over the time, where the timeline goes along, or over the headers of the
 * tracks or the rows, which are a list that goes up and down. The timeline and the keyframe editor
 * both have the two.
 */
export type WheelArea = "time" | "headers";

const LINE = 16;
const NOTCH = 120;
/** A step this large and whole, without the old value to go by, is a notch too. */
const SMALLEST_NOTCH = 40;
/** After this long without an event the next one starts a new movement. */
const PAUSE_MS = 200;
const MOUSE_ZOOM = 0.002;
/** Fingers report small steps, many of them, and a pinch arrives the same way. */
const TRACKPAD_ZOOM = 0.01;

/**
 * Whether one event looks like a notch of a mouse wheel. The rules, in this order:
 *
 * 1. Counted in lines (or pages): only a wheel does that, Firefox counts its notches so.
 * 2. Both axes at once: a wheel has one, so these are fingers.
 * 3. The old `wheelDelta` is a multiple of 120: a notch, as Chrome and Edge report it.
 * 4. Without that old value, a whole step of 40 pixels or more on one axis: a notch.
 * 5. Anything else, small or fractional steps, are fingers.
 */
export function looksLikeNotch(input: WheelInput): boolean {
  if (input.lines) return true;
  if (input.deltaX !== 0 && input.deltaY !== 0) return false;
  if (input.wheelDelta !== 0) return input.wheelDelta % NOTCH === 0;
  const step = Math.abs(input.deltaX || input.deltaY);
  return Number.isInteger(step) && step >= SMALLEST_NOTCH;
}

/**
 * Browsers report a mouse wheel and a trackpad as the same event, and they want different things.
 * A wheel has one axis: over the time it goes along the timeline, over the headers it goes up and
 * down, and Shift makes it go the other way. Fingers have two axes, so they move the view the way
 * they go, both at once and in any direction, wherever they are. Ctrl or ⌘ (or Alt) zooms: over
 * the time it zooms the time, with Shift the height of the rows; over the headers always the height
 * of the rows. A pinch is the wheel with Ctrl, so it zooms the same way.
 *
 * Which one it is shows in the steps, see `looksLikeNotch`, unless people said in the status bar
 * what they use. One movement is one device: once fingers showed, it stays fingers until a pause,
 * because fingers can take a step that looks like a notch, and a wheel never takes one that does
 * not. A mouse with a free-spinning wheel looks like a trackpad, which is a mild way to be wrong.
 */
export class WheelInterpreter {
  #device: "mouse" | "trackpad" | undefined;
  #last = Number.NEGATIVE_INFINITY;

  /** What the last event was taken for. */
  get device(): "mouse" | "trackpad" | undefined {
    return this.#device;
  }

  /** `forced` is for people who said what they use, because the steps can be misleading. */
  read(input: WheelInput, forced?: "mouse" | "trackpad", area: WheelArea = "time"): WheelAction {
    if (input.time - this.#last > PAUSE_MS) this.#device = undefined;
    this.#last = input.time;
    if (forced) this.#device = forced;
    else if (!looksLikeNotch(input)) this.#device = "trackpad";
    else this.#device ??= "mouse";
    return this.#device === "mouse" ? mouse(input, area) : trackpad(input, area);
  }
}

function mouse(
  { deltaX, deltaY, lines, ctrl, alt, shift }: WheelInput,
  area: WheelArea,
): WheelAction {
  const scale = lines ? LINE : 1;
  // With Shift held, browsers on Windows report the wheel as going sideways.
  const amount = (deltaY || deltaX) * scale;
  if (ctrl || alt) return zoom(shift || area === "headers", Math.exp(-amount * MOUSE_ZOOM));
  const along = area === "time" ? !shift : shift;
  return along ? { kind: "scroll", dx: amount, dy: 0 } : { kind: "scroll", dx: 0, dy: amount };
}

function trackpad({ deltaX, deltaY, ctrl, alt, shift }: WheelInput, area: WheelArea): WheelAction {
  if (ctrl || alt) {
    return zoom(shift || area === "headers", Math.exp(-(deltaY || deltaX) * TRACKPAD_ZOOM));
  }
  return { kind: "scroll", dx: deltaX, dy: deltaY };
}

const zoom = (rows: boolean, factor: number): WheelAction =>
  rows ? { kind: "zoomRows", factor } : { kind: "zoom", factor };

/** What a wheel event says, for `WheelInterpreter`. */
export function wheelInputOf(event: WheelEvent): WheelInput {
  const { wheelDeltaX, wheelDeltaY } = event as WheelEvent & {
    wheelDeltaX?: number;
    wheelDeltaY?: number;
  };
  return {
    deltaX: event.deltaX,
    deltaY: event.deltaY,
    lines: event.deltaMode !== WheelEvent.DOM_DELTA_PIXEL,
    wheelDelta: wheelDeltaY || wheelDeltaX || 0,
    ctrl: event.ctrlKey || event.metaKey,
    alt: event.altKey,
    shift: event.shiftKey,
    time: event.timeStamp,
  };
}
