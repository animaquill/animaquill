import type { TimelineEditor } from "./editor.ts";
import type { Pointer } from "./gestures.ts";

/** A finger moves a little even when it means to stay. */
const TAP_REACH = 10;
const LONG_PRESS_MS = 400;
/** Below this speed, in pixels per millisecond, a swipe just stops. */
const MIN_GLIDE = 0.15;
const MAX_GLIDE = 3;
const GLIDE_DECAY = 0.95;
const FRAME_MS = 16;

export interface TouchEnvironment {
  /** Timers, so that tests decide when time passes. */
  later(run: () => void, milliseconds: number): () => void;
  nextFrame(run: () => void): () => void;
  now(): number;
  /** The menu of whatever is at a place. */
  openMenu(pointer: Pointer): void;
}

interface Finger {
  x: number;
  y: number;
}

type Mode =
  /** One finger, and it could still become a tap, a swipe or a long press. */
  | "waiting"
  | "swiping"
  /** The editor has it, as if it were the mouse. */
  | "editing"
  | "pinching"
  /** It has done what it was for. Whatever fingers do next waits until they are all gone. */
  | "over";

const pointerAt = ({ x, y }: Finger): Pointer => ({ x, y, shift: false, alt: false, mod: false });

/**
 * A finger on the timeline. It has to do two jobs that a mouse does with different buttons: moving
 * the view and moving clips. So a finger moves the view, unless it starts on a selected clip, which
 * it picks up right away. A long press picks up any other clip. Two fingers zoom in the direction
 * they spread, and move the view. The buttons stay as they are: this is only about the gestures.
 */
export class TouchController {
  readonly #editor: TimelineEditor;
  readonly #environment: TouchEnvironment;
  readonly #fingers = new Map<number, Finger>();
  #mode: Mode = "over";
  #start: Finger = { x: 0, y: 0 };
  #stopTimer = () => {};
  #stopGlide = () => {};
  #axis: "x" | "y" | undefined;
  #velocity = { x: 0, y: 0 };
  #lastMove = 0;
  /** A clip was picked up by a long press, and if it stays put that means its menu. */
  #pickedUp = false;
  #moved = false;
  #pinch: { spread: number; center: Finger; axis: "x" | "y" } | undefined;

  constructor(editor: TimelineEditor, environment: TouchEnvironment) {
    this.#editor = editor;
    this.#environment = environment;
  }

  down(id: number, x: number, y: number): void {
    this.#stopGlide();
    this.#fingers.set(id, { x, y });
    if (this.#fingers.size === 1) this.#firstFinger({ x, y });
    else if (this.#fingers.size === 2) this.#secondFinger();
  }

  move(id: number, x: number, y: number): void {
    const finger = this.#fingers.get(id);
    if (!finger) return;
    const dx = x - finger.x;
    const dy = y - finger.y;
    finger.x = x;
    finger.y = y;
    if (this.#mode === "pinching") {
      this.#pinchMoved();
      return;
    }
    if (this.#mode === "editing") {
      this.#moved ||= this.#hasLeftStart(finger);
      this.#editor.drag(pointerAt(finger));
      return;
    }
    if (this.#mode === "waiting" && this.#hasLeftStart(finger)) {
      this.#stopTimer();
      this.#mode = "swiping";
      this.#axis = Math.abs(x - this.#start.x) > Math.abs(y - this.#start.y) ? "x" : "y";
      this.#lastMove = this.#environment.now();
    }
    if (this.#mode === "swiping") this.#swipe(dx, dy);
  }

  up(id: number): void {
    const finger = this.#fingers.get(id);
    if (!finger) return;
    this.#fingers.delete(id);
    this.#stopTimer();
    if (this.#mode === "pinching") {
      this.#mode = "over";
    } else if (this.#fingers.size === 0) {
      this.#lastFingerUp(finger);
    }
  }

  cancel(id: number): void {
    this.#fingers.delete(id);
    this.#stopTimer();
    this.#editor.cancelDrag();
    this.#mode = "over";
  }

  #hasLeftStart({ x, y }: Finger): boolean {
    return Math.hypot(x - this.#start.x, y - this.#start.y) >= TAP_REACH;
  }

  #firstFinger(finger: Finger): void {
    this.#start = { ...finger };
    this.#pickedUp = false;
    this.#moved = false;
    const pointer = pointerAt(finger);
    const hit = this.#editor.hitAt(pointer);
    const { selection, tool } = this.#editor.getSnapshot();
    const onSelected = hit.kind === "clip" && selection.has(hit.box.id) && tool === "select";
    if (hit.kind === "ruler" || hit.kind === "end" || onSelected) {
      this.#mode = "editing";
      this.#editor.press(pointer);
      return;
    }
    this.#mode = "waiting";
    this.#stopTimer = this.#environment.later(() => this.#longPress(), LONG_PRESS_MS);
  }

  #longPress(): void {
    if (this.#mode !== "waiting") return;
    const pointer = pointerAt(this.#start);
    const hit = this.#editor.hitAt(pointer);
    if (hit.kind === "clip" && !hit.row.track.locked) {
      this.#editor.selectOnly(hit.box.id);
      this.#editor.press(pointer);
      this.#mode = "editing";
      this.#pickedUp = true;
    } else {
      this.#environment.openMenu(pointer);
      this.#mode = "over";
    }
  }

  /** A second finger while a clip is on the move is a hand resting on the screen. */
  #secondFinger(): void {
    if (this.#mode === "editing" && this.#editor.preview) return;
    this.#stopTimer();
    this.#editor.cancelDrag();
    const [a, b] = [...this.#fingers.values()] as [Finger, Finger];
    const wide = Math.abs(a.x - b.x) >= Math.abs(a.y - b.y);
    this.#pinch = { spread: spreadOf(a, b), center: centerOf(a, b), axis: wide ? "x" : "y" };
    this.#mode = "pinching";
  }

  #pinchMoved(): void {
    const pinch = this.#pinch;
    const [a, b] = [...this.#fingers.values()] as [Finger, Finger | undefined];
    if (!pinch || !b) return;
    const editor = this.#editor;
    const center = centerOf(a, b);
    const spread = spreadOf(a, b);
    const factor = spread / Math.max(pinch.spread, 1);
    if (pinch.axis === "x") editor.zoomAround(center.x, factor);
    else editor.zoomRowsAround(center.y, factor);
    editor.setScroll(
      editor.scrollX - (center.x - pinch.center.x),
      editor.scrollY - (center.y - pinch.center.y),
    );
    this.#pinch = { ...pinch, spread, center };
  }

  #swipe(dx: number, dy: number): void {
    const editor = this.#editor;
    const x = this.#axis === "y" ? 0 : dx;
    const y = this.#axis === "x" ? 0 : dy;
    editor.setScroll(editor.scrollX - x, editor.scrollY - y);
    const now = this.#environment.now();
    const elapsed = Math.max(now - this.#lastMove, 1);
    const limit = (speed: number) => Math.max(Math.min(speed, MAX_GLIDE), -MAX_GLIDE);
    this.#velocity = { x: limit(x / elapsed), y: limit(y / elapsed) };
    this.#lastMove = now;
  }

  #lastFingerUp(finger: Finger): void {
    const pointer = pointerAt(finger);
    if (this.#mode === "waiting") {
      this.#editor.press(pointer);
      this.#editor.release(pointer);
    } else if (this.#mode === "editing") {
      this.#editor.release(pointer);
      if (this.#pickedUp && !this.#moved) this.#environment.openMenu(pointer);
    } else if (this.#mode === "swiping") {
      this.#glide();
    }
    this.#mode = "over";
  }

  /** A swipe carries on for a moment, like a list on a phone. */
  #glide(): void {
    let { x, y } = this.#velocity;
    const step = () => {
      if (Math.hypot(x, y) < MIN_GLIDE) return;
      const editor = this.#editor;
      editor.setScroll(editor.scrollX - x * FRAME_MS, editor.scrollY - y * FRAME_MS);
      x *= GLIDE_DECAY;
      y *= GLIDE_DECAY;
      this.#stopGlide = this.#environment.nextFrame(step);
    };
    this.#stopGlide = this.#environment.nextFrame(step);
  }
}

const spreadOf = (a: Finger, b: Finger) => Math.hypot(a.x - b.x, a.y - b.y);
const centerOf = (a: Finger, b: Finger): Finger => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
