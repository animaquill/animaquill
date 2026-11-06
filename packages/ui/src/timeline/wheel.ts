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

const LINE = 16;
const NOTCH = 120;
/** After this long without an event the next one starts a new movement. */
const PAUSE_MS = 200;
const MOUSE_ZOOM = 0.002;
/** Fingers report small steps, many of them, and a pinch arrives the same way. */
const TRACKPAD_ZOOM = 0.01;
/** Less than this says nothing yet about the direction of a swipe. */
const AXIS_THRESHOLD = 2;

/**
 * Browsers report a mouse wheel and a trackpad as the same event, and they want opposite things. A
 * wheel has one axis, which goes along the timeline, and Shift makes it go up and down. Fingers have
 * two axes, so they simply move the view the way they go, and a pinch zooms.
 *
 * The device shows in the steps. A mouse with a free-spinning wheel looks like a trackpad, and then
 * the wheel scrolls up and down, which is a mild way to be wrong.
 */
export class WheelInterpreter {
  #device: "mouse" | "trackpad" | undefined;
  #axis: "x" | "y" | undefined;
  #last = Number.NEGATIVE_INFINITY;

  /** What the last event was taken for. */
  get device(): "mouse" | "trackpad" | undefined {
    return this.#device;
  }

  /** `forced` is for people who said what they use, because the steps can be misleading. */
  read(input: WheelInput, forced?: "mouse" | "trackpad"): WheelAction {
    if (input.time - this.#last > PAUSE_MS) {
      this.#device = undefined;
      this.#axis = undefined;
    }
    this.#last = input.time;
    const isNotch =
      input.lines ||
      (input.wheelDelta !== 0 &&
        input.wheelDelta % NOTCH === 0 &&
        (input.deltaX === 0 || input.deltaY === 0));
    // Fingers can take a step that looks like a notch, but a wheel never takes one that does not.
    if (forced) this.#device = forced;
    else if (!isNotch) this.#device = "trackpad";
    else this.#device ??= "mouse";
    return this.#device === "mouse" ? this.#mouse(input) : this.#trackpad(input);
  }

  #mouse({ deltaX, deltaY, lines, ctrl, alt, shift }: WheelInput): WheelAction {
    const scale = lines ? LINE : 1;
    // With Shift held, browsers on Windows report the wheel as going sideways.
    const amount = (deltaY || deltaX) * scale;
    if (ctrl || alt) return zoom(shift, Math.exp(-amount * MOUSE_ZOOM));
    return shift ? { kind: "scroll", dx: 0, dy: amount } : { kind: "scroll", dx: amount, dy: 0 };
  }

  #trackpad({ deltaX, deltaY, ctrl, alt, shift }: WheelInput): WheelAction {
    // Browsers report a pinch as the wheel with Ctrl held.
    if (ctrl || alt) return zoom(shift, Math.exp(-(deltaY || deltaX) * TRACKPAD_ZOOM));
    // A swipe along the timeline should not wander between the tracks, and the other way around.
    if (!this.#axis && Math.abs(deltaX) + Math.abs(deltaY) >= AXIS_THRESHOLD) {
      this.#axis = Math.abs(deltaX) > Math.abs(deltaY) ? "x" : "y";
    }
    return {
      kind: "scroll",
      dx: this.#axis === "y" ? 0 : deltaX,
      dy: this.#axis === "x" ? 0 : deltaY,
    };
  }
}

const zoom = (rows: boolean, factor: number): WheelAction =>
  rows ? { kind: "zoomRows", factor } : { kind: "zoom", factor };
