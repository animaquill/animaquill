import { builtInEffect } from "@animaquill/schema";
import { effectCodeOf, type EffectFrame } from "@animaquill/render/effects";
import { PREVIEW_HEIGHT, PREVIEW_WIDTH } from "./transition-preview.ts";

/**
 * The small pictures of effects in their tab: a sample picture with the effect on it, drawn by the
 * same code the compositor runs. Still, each one shows what it does at some strength; under the
 * pointer the strength goes back and forth, from nothing to that and on to the other side. The
 * editor's own code is trusted, so it runs right here, one canvas for each kind of effect.
 */

/** The background where an effect leaves nothing, as transparent shows on the timeline. */
const NOTHING = "#1b1d22";

/** How long one way back and forth takes, in milliseconds. */
export const SWING_MS = 2400;

/**
 * What each parameter is at a point of the swing, from −1 to 1: how far a sample goes, so that
 * what an effect does is plain to see on a small picture, and never more than it should.
 */
const REACH: Readonly<Record<string, Readonly<Record<string, number>>>> = {
  brightness: { brightness: 0.6 },
  contrast: { contrast: 0.8 },
  saturation: { saturation: 1 },
  temperature: { temperature: 1 },
  blur: { radius: 6 },
  crop: { left: 0.2, top: 0.15, right: 0.2, bottom: 0.15 },
};

/** Parameters that only go one way: they are at nothing at the start of a swing. */
const ONE_WAY = new Set(["radius", "left", "top", "right", "bottom"]);

/** Where the still picture of an effect is, as a point of the swing. */
export const STILL_SWING = 0.75;

/** Where a swing is at a moment: up, back, down and back again, from 0 to 1 and round. */
export const swingAt = (elapsedMs: number): number => (((elapsedMs / SWING_MS) % 1) + 1) % 1;

/** What the parameters of an effect are at a point of its swing. */
export function valuesAt(type: string, swing: number): Readonly<Record<string, number>> {
  const wave = Math.sin(swing * Math.PI * 2);
  const reach = REACH[type] ?? {};
  return Object.fromEntries(
    Object.entries(reach).map(([name, most]) => [
      name,
      ONE_WAY.has(name) ? (most * (1 - Math.cos(swing * Math.PI * 2))) / 2 : most * wave,
    ]),
  );
}

interface Runner {
  readonly canvas: OffscreenCanvas;
  draw: ((frame: EffectFrame) => void) | undefined;
}

/** The sample: a sky, a sun, ground and a figure, which shows colors, edges and detail. */
function sample(): OffscreenCanvas {
  const canvas = new OffscreenCanvas(PREVIEW_WIDTH, PREVIEW_HEIGHT);
  const context = canvas.getContext("2d");
  if (!context) return canvas;
  const sky = context.createLinearGradient(0, 0, 0, PREVIEW_HEIGHT);
  sky.addColorStop(0, "#3b6fd1");
  sky.addColorStop(1, "#f2b46b");
  context.fillStyle = sky;
  context.fillRect(0, 0, PREVIEW_WIDTH, PREVIEW_HEIGHT);
  context.fillStyle = "#ffe08a";
  context.beginPath();
  context.arc(PREVIEW_WIDTH * 0.72, PREVIEW_HEIGHT * 0.38, PREVIEW_HEIGHT * 0.16, 0, Math.PI * 2);
  context.fill();
  context.fillStyle = "#2f7d4a";
  context.fillRect(0, PREVIEW_HEIGHT * 0.7, PREVIEW_WIDTH, PREVIEW_HEIGHT * 0.3);
  context.fillStyle = "#c2412d";
  context.fillRect(
    PREVIEW_WIDTH * 0.22,
    PREVIEW_HEIGHT * 0.42,
    PREVIEW_WIDTH * 0.12,
    PREVIEW_HEIGHT * 0.3,
  );
  context.fillStyle = "#ffffff";
  context.fillRect(
    PREVIEW_WIDTH * 0.25,
    PREVIEW_HEIGHT * 0.48,
    PREVIEW_WIDTH * 0.06,
    PREVIEW_HEIGHT * 0.08,
  );
  return canvas;
}

class EffectPreviews {
  #sample: OffscreenCanvas | undefined;
  readonly #runners = new Map<string, Runner | null>();

  /** Whether this browser can draw them at all. Without, the tab shows names only. */
  get works(): boolean {
    return typeof OffscreenCanvas === "function";
  }

  /**
   * Draws an effect at a point of its swing onto a canvas of the page. Says whether it could: one
   * that this editor does not have, or cannot run here, draws nothing.
   */
  draw(target: HTMLCanvasElement, type: string, swing: number): boolean {
    const context = target.getContext("2d");
    if (!context || !this.works || !builtInEffect(type)) return false;
    const runner = this.#runnerOf(type);
    if (!runner) return false;
    const input = (this.#sample ??= sample());
    try {
      runner.draw?.({
        input,
        values: valuesAt(type, swing),
        time: 0,
        width: PREVIEW_WIDTH,
        height: PREVIEW_HEIGHT,
        pixelRatio: 1,
        canvas: runner.canvas,
      });
    } catch (error) {
      console.warn("A preview of an effect could not be drawn", error);
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

  /** The code of a kind of effect, ready on a canvas of its own, as the compositor has it. */
  #runnerOf(type: string): Runner | undefined {
    const known = this.#runners.get(type);
    if (known !== undefined) return known ?? undefined;
    const code = effectCodeOf(type);
    const made: Runner = {
      canvas: new OffscreenCanvas(PREVIEW_WIDTH, PREVIEW_HEIGHT),
      draw: undefined,
    };
    try {
      code?.({
        canvas: made.canvas,
        render: (draw) => {
          made.draw = draw;
        },
      });
    } catch (error) {
      console.warn("An effect could not get ready for its preview", error);
      this.#runners.set(type, null);
      return undefined;
    }
    this.#runners.set(type, code ? made : null);
    return code ? made : undefined;
  }
}

/** One for the page: the canvases are the same for every tab. */
export const effectPreviews = new EffectPreviews();
