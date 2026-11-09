import type { PlannedEffect } from "@animaquill/core";
import type { EffectFrame } from "./code.ts";
import { effectCodeOf } from "./built-in.ts";
import { Pool } from "../compose.ts";

/** An effect of code that comes with the editor, with its own canvas, see code.ts. */
interface Instance {
  readonly canvas: OffscreenCanvas;
  draw(frame: EffectFrame): void;
}

interface Buffer {
  readonly canvas: OffscreenCanvas;
  readonly context: OffscreenCanvasRenderingContext2D;
}

/** An effect at a moment, with what it takes then. */
export interface EffectStep {
  readonly effect: PlannedEffect;
  readonly values: Readonly<Record<string, unknown>>;
}

/** Frames without taking it after which a canvas for effects goes, to give back its memory. */
const KEEP_FRAMES = 300;

function letGo(canvas: OffscreenCanvas): void {
  canvas.width = 0;
  canvas.height = 0;
}

/**
 * Runs the effects of a layer one after the other, each on what the one before made, starting with
 * what the clip shows in its box. Each kind of effect has canvases of its own, which frames take and
 * give back; what no frame took for a while goes with its memory. Code that fails to get ready, or
 * to draw, is left out, and says so once: it is the editor's own, so that is a bug, and the picture
 * goes on without it rather than stop.
 */
export class EffectRunner {
  readonly #buffers = new Pool<Buffer>(({ canvas }) => letGo(canvas));
  readonly #instances = new Map<string, Pool<Instance>>();
  readonly #broken = new Set<string>();
  #frame = 0;

  /** A clear canvas of this size to draw what a clip shows into, for this frame. */
  input(width: number, height: number): Buffer {
    const buffer = this.#buffers.take(this.#frame, () => {
      const canvas = new OffscreenCanvas(width, height);
      const context = canvas.getContext("2d");
      if (!context) throw new Error("No 2D context");
      return { canvas, context };
    });
    const { canvas, context } = buffer;
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    } else {
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.globalCompositeOperation = "source-over";
      context.globalAlpha = 1;
      context.clearRect(0, 0, width, height);
    }
    return buffer;
  }

  /** Gives back what `input` lent, once what is on it is drawn. */
  giveBack(buffer: Buffer): void {
    this.#buffers.give(buffer);
  }

  /**
   * The effects on a picture, in their order. Gives what the last one made, and something to call
   * once that is drawn. With nothing to do it gives the picture as it is.
   */
  run(
    steps: readonly EffectStep[],
    input: OffscreenCanvas,
    common: Pick<EffectFrame, "time" | "pixelRatio">,
  ): { readonly canvas: OffscreenCanvas; readonly done: () => void } {
    const { width, height } = input;
    let current = input;
    const taken: (() => void)[] = [];
    for (const { effect, values } of steps) {
      const instance = this.#instance(effect.type, width, height);
      if (!instance) continue;
      try {
        instance.draw({
          input: current,
          values,
          width,
          height,
          canvas: instance.canvas,
          ...common,
        });
      } catch (error) {
        this.#break(effect.type, error);
        instance.done();
        continue;
      }
      // What the one before made is no longer needed, unless it is the input, which the caller has.
      taken.forEach((give) => give());
      taken.length = 0;
      taken.push(instance.done);
      current = instance.canvas;
    }
    return { canvas: current, done: () => taken.forEach((give) => give()) };
  }

  #break(type: string, error: unknown): void {
    if (this.#broken.has(type)) return;
    this.#broken.add(type);
    console.error(`The effect ${type} failed, and is left out`, error);
  }

  /** The code of an effect that is free for this frame, on a canvas of this size. */
  #instance(
    type: string,
    width: number,
    height: number,
  ): (Instance & { readonly done: () => void }) | undefined {
    const code = effectCodeOf(type);
    if (!code || this.#broken.has(type)) return undefined;
    let pool = this.#instances.get(type);
    if (!pool) {
      pool = new Pool<Instance>(({ canvas }) => letGo(canvas));
      this.#instances.set(type, pool);
    }
    let instance: Instance;
    try {
      instance = pool.take(this.#frame, () => {
        const canvas = new OffscreenCanvas(width, height);
        let draw: ((frame: EffectFrame) => void) | undefined;
        code({
          canvas,
          render: (given) => {
            draw = given;
          },
        });
        return { canvas, draw: (frame) => draw?.(frame) };
      });
    } catch (error) {
      this.#break(type, error);
      return undefined;
    }
    const { canvas } = instance;
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    const owner = pool;
    return { ...instance, done: () => owner.give(instance) };
  }

  /** What one frame took is free for the next. What no frame took for a while goes. */
  end(): void {
    this.#frame += 1;
    this.#buffers.end(this.#frame, KEEP_FRAMES);
    for (const [type, pool] of this.#instances) {
      pool.end(this.#frame, KEEP_FRAMES);
      if (pool.size === 0) this.#instances.delete(type);
    }
  }
}
