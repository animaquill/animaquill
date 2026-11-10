import { clear, contextOf, numberOf, type EffectCode } from "./code.ts";

/** How far out a Gaussian blur reaches, in standard deviations, as the canvas does it. */
const REACH = 3;

/**
 * How a blur that repeats the edge pixels gets its picture ready: the input with `pad` pixels more
 * on each side, which repeat its edge pixels, drawn `scale` times as large. That is 1, unless the
 * picture with its border would be far larger than the input: then it is drawn smaller, which only
 * happens for a blur so wide that nobody can see the difference, and keeps the memory in bounds.
 */
export interface ExtendedBlur {
  readonly pad: number;
  readonly scale: number;
  /** Pixels of the picture with its border, at its scale. */
  readonly width: number;
  readonly height: number;
}

/** Pixels the picture with its border may have, against those of the input. */
const BUDGET_SHARE = 2;
/** What a small input may have anyway: a small clip can have a wide blur as well. */
const BUDGET_LEAST = 1 << 22;

export function extendedBlur(width: number, height: number, sigma: number): ExtendedBlur {
  const pad = Math.ceil(REACH * sigma) + 1;
  const outer = (width + 2 * pad) * (height + 2 * pad);
  const budget = Math.max(BUDGET_SHARE * width * height, BUDGET_LEAST);
  const scale = Math.min(1, Math.sqrt(budget / outer));
  return {
    pad,
    scale,
    width: Math.ceil((width + 2 * pad) * scale),
    height: Math.ceil((height + 2 * pad) * scale),
  };
}

interface Scratch {
  readonly canvas: OffscreenCanvas;
  readonly context: OffscreenCanvasRenderingContext2D;
}

function scratch(): Scratch {
  const canvas = new OffscreenCanvas(1, 1);
  return { canvas, context: contextOf(canvas) };
}

/** A canvas of this size with nothing on it and nothing left of the frame before. */
function ready({ canvas, context }: Scratch, width: number, height: number): void {
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  clear(context, width, height);
}

/**
 * Draws the input with a border of `pad` pixels that repeat its edge pixels, the corners filling
 * theirs: what a blur with the edge repeated sees outside the box. The border takes rows and
 * columns of one pixel, stretched without smoothing, so each of them is that edge pixel exactly.
 */
function drawExtended(
  context: OffscreenCanvasRenderingContext2D,
  input: CanvasImageSource,
  width: number,
  height: number,
  { pad, scale }: ExtendedBlur,
): void {
  context.setTransform(scale, 0, 0, scale, 0, 0);
  context.imageSmoothingEnabled = scale !== 1;
  context.imageSmoothingQuality = "medium";
  context.drawImage(input, pad, pad);
  context.imageSmoothingEnabled = false;
  const right = width - 1;
  const bottom = height - 1;
  const far = pad + width;
  const low = pad + height;
  // Sides: left, right, top, bottom.
  context.drawImage(input, 0, 0, 1, height, 0, pad, pad, height);
  context.drawImage(input, right, 0, 1, height, far, pad, pad, height);
  context.drawImage(input, 0, 0, width, 1, pad, 0, width, pad);
  context.drawImage(input, 0, bottom, width, 1, pad, low, width, pad);
  // Corners, from the corner pixels.
  context.drawImage(input, 0, 0, 1, 1, 0, 0, pad, pad);
  context.drawImage(input, right, 0, 1, 1, far, 0, pad, pad);
  context.drawImage(input, 0, bottom, 1, 1, 0, low, pad, pad);
  context.drawImage(input, right, bottom, 1, 1, far, low, pad, pad);
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.imageSmoothingEnabled = true;
}

/**
 * 模糊: a Gaussian blur whose standard deviation is the radius, in world units of the box, as CSS
 * `blur()`. Outside the box are its edge pixels over again (`edge` is `extend`), so that a picture
 * that fills the stage keeps its edges as they are, or nothing (`transparent`), so that the edges of
 * the box get softer as well. The canvas blurs on the graphics card, which takes few milliseconds
 * also at 4K; the border costs a copy of the picture a little larger than it.
 */
const blur: EffectCode = (aq) => {
  const context = contextOf(aq.canvas);
  if (typeof context.filter !== "string") throw new Error("This browser has no canvas filters");
  // Only for the edge repeated, and kept from frame to frame: making them anew costs more.
  let extended: Scratch | undefined;
  let smaller: Scratch | undefined;
  aq.render(({ input, values, width, height, pixelRatio }) => {
    clear(context, width, height);
    const sigma = Math.max(numberOf(values, "radius") * pixelRatio, 0);
    if (sigma === 0 || values["edge"] === "transparent") {
      context.filter = sigma === 0 ? "none" : `blur(${sigma}px)`;
      context.drawImage(input, 0, 0);
      context.filter = "none";
      return;
    }
    const plan = extendedBlur(width, height, sigma);
    extended ??= scratch();
    ready(extended, plan.width, plan.height);
    drawExtended(extended.context, input, width, height, plan);
    if (plan.scale === 1) {
      context.filter = `blur(${sigma}px)`;
      context.drawImage(extended.canvas, -plan.pad, -plan.pad);
      context.filter = "none";
      return;
    }
    // Blurred where it is smaller, then drawn as large as the box again.
    smaller ??= scratch();
    ready(smaller, plan.width, plan.height);
    smaller.context.filter = `blur(${sigma * plan.scale}px)`;
    smaller.context.drawImage(extended.canvas, 0, 0);
    smaller.context.filter = "none";
    context.imageSmoothingQuality = "medium";
    const across = plan.width / plan.scale;
    const down = plan.height / plan.scale;
    context.drawImage(smaller.canvas, -plan.pad, -plan.pad, across, down);
  });
};

export default blur;
