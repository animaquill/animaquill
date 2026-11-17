import { bezierProgress, fadeGainAt, type SoundFade } from "@animaquill/core";
import {
  findTransition,
  type SpeedCurve,
  type TransitionMedia,
  type TransitionUse,
} from "@animaquill/schema";
import { codeOf } from "@animaquill/render/transitions";
import type { TransitionFrame, TransitionHost } from "@animaquill/render/transitions";
import type { TransitionName } from "../timeline/transition-place.ts";

/**
 * The small pictures of transitions in their tab: two sample pictures, from one to the other the
 * way the transition goes, drawn by the same code the compositor runs. The editor's own code is
 * trusted, so it runs right here, as it does in the compositor, and not in a sandbox for each
 * picture: one canvas for each kind of transition, shared by all pictures of it. Only the picture
 * under the pointer moves; the others are drawn once.
 */

/** Pixels of a picture, 16:9. Small, so that a frame costs next to nothing. */
export const PREVIEW_WIDTH = 160;
export const PREVIEW_HEIGHT = 90;

/** How far along a still picture shows a transition: mostly there, so the way it goes shows. */
export const STILL_PROGRESS = 0.45;

/** How long the start and the end stand still in a loop, in milliseconds. */
const HOLD_MS = 350;
/** A transition plays at least this long in a loop, so that a short one can be seen. */
const SHORTEST_RUN_MS = 800;

/** Where a loop is at a moment, as a share before its speed curve: holds, runs, holds again. */
export function loopShare(elapsedMs: number, seconds: number): number {
  const run = Math.max(seconds * 1000, SHORTEST_RUN_MS);
  const cycle = HOLD_MS + run + HOLD_MS;
  const at = (((elapsedMs % cycle) + cycle) % cycle) - HOLD_MS;
  return Math.min(Math.max(at / run, 0), 1);
}

/** How far a transition got at a share of its time, along its speed curve. */
export const progressOf = (share: number, curve: SpeedCurve | undefined): number =>
  curve ? bezierProgress(...curve, share) : share;

/** The background where neither side shows anything, as transparent shows on the timeline. */
const NOTHING = "#1b1d22";

interface Runner {
  readonly canvas: OffscreenCanvas;
  draw: ((frame: TransitionFrame) => void) | undefined;
}

interface Samples {
  readonly from: OffscreenCanvas;
  readonly to: OffscreenCanvas;
  readonly nothing: OffscreenCanvas;
}

/** A side of the samples: a gradient with a shape, so that movement and mixing both show. */
function sample(colors: readonly [string, string], shape: "circle" | "triangle"): OffscreenCanvas {
  const canvas = new OffscreenCanvas(PREVIEW_WIDTH, PREVIEW_HEIGHT);
  const context = canvas.getContext("2d");
  if (!context) return canvas;
  const gradient = context.createLinearGradient(0, 0, PREVIEW_WIDTH, PREVIEW_HEIGHT);
  gradient.addColorStop(0, colors[0]);
  gradient.addColorStop(1, colors[1]);
  context.fillStyle = gradient;
  context.fillRect(0, 0, PREVIEW_WIDTH, PREVIEW_HEIGHT);
  context.fillStyle = "#ffffffe6";
  context.beginPath();
  if (shape === "circle") {
    context.arc(PREVIEW_WIDTH * 0.32, PREVIEW_HEIGHT * 0.5, PREVIEW_HEIGHT * 0.24, 0, Math.PI * 2);
  } else {
    context.moveTo(PREVIEW_WIDTH * 0.68, PREVIEW_HEIGHT * 0.24);
    context.lineTo(PREVIEW_WIDTH * 0.82, PREVIEW_HEIGHT * 0.76);
    context.lineTo(PREVIEW_WIDTH * 0.54, PREVIEW_HEIGHT * 0.76);
    context.closePath();
  }
  context.fill();
  return canvas;
}

/** The colors of the two sides, as their sample pictures have them. */
const SIDE_COLORS = { from: "#5ab0d6", to: "#e8b04a" } as const;

/**
 * A transition of sound, which has no picture: how loud each side is over its progress, the side
 * before the cut going down and the one after it coming up, with where it is now.
 */
function drawGain(
  target: HTMLCanvasElement,
  context: CanvasRenderingContext2D,
  name: TransitionName,
  use: TransitionUse,
  progress: number,
): boolean {
  const found = findTransition(name, "sound", use);
  if (found.kind !== "built-in") return false;
  const { width, height } = target;
  const pad = height * 0.16;
  const x = (share: number) => pad + share * (width - 2 * pad);
  const y = (gain: number) => height - pad - gain * (height - 2 * pad);
  const shape = found.type === "fade-linear" ? "gain" : "power";
  const fade = (way: SoundFade["way"]): SoundFade => ({
    use,
    way,
    shape,
    start: 0,
    end: 1,
    duration: 1,
  });
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.globalAlpha = 1;
  context.globalCompositeOperation = "source-over";
  context.fillStyle = NOTHING;
  context.fillRect(0, 0, width, height);
  const sides: (readonly [SoundFade["way"], string])[] = [];
  if (use !== "enter") sides.push(["out", SIDE_COLORS.from]);
  if (use !== "exit") sides.push(["in", SIDE_COLORS.to]);
  context.lineWidth = Math.max(2, height / 30);
  for (const [way, color] of sides) {
    context.strokeStyle = color;
    context.beginPath();
    for (let step = 0; step <= 32; step += 1) {
      const share = step / 32;
      const gain = fadeGainAt(fade(way), share);
      if (step === 0) context.moveTo(x(share), y(gain));
      else context.lineTo(x(share), y(gain));
    }
    context.stroke();
  }
  context.strokeStyle = "#ffffffb3";
  context.lineWidth = 1;
  context.beginPath();
  context.moveTo(x(progress), pad / 2);
  context.lineTo(x(progress), height - pad / 2);
  context.stroke();
  return true;
}

class TransitionPreviews {
  #samples: Samples | undefined;
  readonly #runners = new Map<string, Runner>();
  readonly #scratches = new Map<string, OffscreenCanvas>();

  /** Whether this browser can draw them at all. Without, the tab shows names only. */
  get works(): boolean {
    return typeof OffscreenCanvas === "function";
  }

  /**
   * Draws a transition at a point of its progress onto a canvas of the page, as it goes on
   * pictures or on sound. Says whether it could: one that this editor does not have draws nothing.
   */
  draw(
    target: HTMLCanvasElement,
    name: TransitionName,
    use: TransitionUse,
    progress: number,
    media: TransitionMedia = "picture",
  ): boolean {
    const context = target.getContext("2d");
    if (!context || !this.works || name.type === undefined) return false;
    if (media === "sound") return drawGain(target, context, name, use, progress);
    const found = findTransition(name, "picture", use);
    if (found.kind !== "built-in") return false;
    const runner = this.#runnerOf(found.type);
    const samples = (this.#samples ??= {
      from: sample(["#2b5fa8", "#5ab0d6"], "circle"),
      to: sample(["#c2571f", "#e8b04a"], "triangle"),
      nothing: new OffscreenCanvas(PREVIEW_WIDTH, PREVIEW_HEIGHT),
    });
    try {
      runner.draw?.({
        from: use === "enter" ? samples.nothing : samples.from,
        to: use === "exit" ? samples.nothing : samples.to,
        progress,
        time: progress,
        duration: 1,
        use,
        boxes: { from: null, to: null },
        values: found.values,
        width: PREVIEW_WIDTH,
        height: PREVIEW_HEIGHT,
        pixelRatio: 1,
        canvas: runner.canvas,
      });
    } catch (error) {
      console.warn("A preview of a transition could not be drawn", error);
      return false;
    }
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.globalAlpha = 1;
    context.globalCompositeOperation = "source-over";
    context.fillStyle = NOTHING;
    context.fillRect(0, 0, target.width, target.height);
    context.drawImage(runner.canvas, 0, 0, target.width, target.height);
    return true;
  }

  /** The code of a kind of transition, ready on a canvas of its own, as the compositor has it. */
  #runnerOf(type: string): Runner {
    let runner = this.#runners.get(type);
    if (runner) return runner;
    const made: Runner = {
      canvas: new OffscreenCanvas(PREVIEW_WIDTH, PREVIEW_HEIGHT),
      draw: undefined,
    };
    const host: TransitionHost = {
      canvas: made.canvas,
      render: (draw) => {
        made.draw = draw;
      },
      // Each step draws all of what it takes, so one canvas of a size is enough for all of them.
      scratch: (width, height) => {
        const key = `${width}x${height}`;
        let scratch = this.#scratches.get(key);
        if (!scratch) {
          scratch = new OffscreenCanvas(width, height);
          this.#scratches.set(key, scratch);
        }
        scratch.getContext("2d")?.clearRect(0, 0, width, height);
        return scratch;
      },
    };
    codeOf(type)(host);
    runner = made;
    this.#runners.set(type, runner);
    return runner;
  }
}

/** One for the page: the canvases are the same for every tab. */
export const transitionPreviews = new TransitionPreviews();
