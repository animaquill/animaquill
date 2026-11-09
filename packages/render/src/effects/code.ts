/**
 * The code of an effect, the way any effect is written: a module that gets ready once with `aq` at
 * hand, and says with `aq.render` what draws a frame. It is the same as for transitions (see
 * ../transitions/code.ts), with one picture instead of two. The ones that come with the editor run
 * right here in the compositor, because they are the editor's own: the pictures do not have to go
 * anywhere. Code from elsewhere gets `ImageBitmap`s in a sandbox.
 */
export type EffectPicture = ImageBitmap | OffscreenCanvas;

/** What the code of an effect gets for each frame. */
export interface EffectFrame {
  /**
   * What the clip shows in its box, with what the effects before this one made of it: as large as
   * the box is on the picture, with premultiplied colors.
   */
  readonly input: EffectPicture;
  /** What each parameter is at this moment, after its keys, by parameter. */
  readonly values: Readonly<Record<string, unknown>>;
  /** What the clock of the clip reads. */
  readonly time: number;
  /** Pixels of the input, which the canvas has too. */
  readonly width: number;
  readonly height: number;
  /**
   * Pixels per unit of the world in the box: fewer while the preview draws with fewer pixels, and
   * fewer for a clip that is scaled down. Code that goes by it looks the same at any size.
   */
  readonly pixelRatio: number;
  /** Where the frame goes. Each frame paints all of it, with premultiplied colors. */
  readonly canvas: OffscreenCanvas;
}

/** What code gets as `aq`. */
export interface EffectHost {
  readonly canvas: OffscreenCanvas;
  /** What draws a frame. When it returns, the canvas is the frame. The last one said counts. */
  render(draw: (frame: EffectFrame) => void): void;
}

/** The code of an effect, which runs once with `aq`, like the top of a module. */
export type EffectCode = (aq: EffectHost) => void;

/** A number that a parameter has, or what stands in for it where it has none. */
export const numberOf = (values: EffectFrame["values"], name: string, fallback = 0): number => {
  const value = values[name];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
};

/** A 2D context, which every canvas has one way or another. */
export function contextOf(canvas: OffscreenCanvas): OffscreenCanvasRenderingContext2D {
  const context = canvas.getContext("2d");
  if (!context) throw new Error("No 2D context");
  return context;
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
  context.filter = "none";
  context.clearRect(0, 0, width, height);
}

/**
 * An effect that is a filter of the canvas, as CSS has it, from what the parameters are. The filter
 * works on the colors without their transparency, and puts it back, which is what the format says.
 * A canvas without filters would leave the picture as it is and say nothing, so it says so.
 */
export function filterEffect(
  filterOf: (values: EffectFrame["values"], frame: EffectFrame) => string,
): EffectCode {
  return (aq) => {
    const context = contextOf(aq.canvas);
    if (typeof context.filter !== "string") throw new Error("This browser has no canvas filters");
    aq.render((frame) => {
      const { input, values, width, height } = frame;
      clear(context, width, height);
      context.filter = filterOf(values, frame);
      context.drawImage(input, 0, 0);
      context.filter = "none";
    });
  };
}
