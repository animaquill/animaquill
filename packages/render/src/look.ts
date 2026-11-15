import { transformPoint, type Matrix } from "@animaquill/core/view";

/**
 * What the compositor draws on a picture for AI and works out of it, without a page: where a box of
 * the world lands on the picture, how an overview is laid out, and which pixels differ from the
 * picture before. The drawing and encoding around these is in `compositor.ts`.
 */

/**
 * How far a channel may differ, of 255, and the pixel still be the same: the same renderer gives
 * the same picture to the bit, and other renderers within 2 (rendering.md 2); a little more keeps
 * the edges of text and video that a decoder rounds otherwise from counting.
 */
export const DIFF_THRESHOLD = 8;

/** Where a box of the world is on the picture, as the box around its corners. */
export function markRect(
  view: Matrix,
  box: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
): { readonly x: number; readonly y: number; readonly width: number; readonly height: number } {
  const corners = [
    { x: box.x, y: box.y },
    { x: box.x + box.width, y: box.y },
    { x: box.x + box.width, y: box.y + box.height },
    { x: box.x, y: box.y + box.height },
  ].map((point) => transformPoint(view, point));
  const xs = corners.map(({ x }) => x);
  const ys = corners.map(({ y }) => y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

/** Room between the cells of an overview, in pixels. */
export const SHEET_GAP = 4;

/** How large an overview of `count` cells of a size is, `columns` wide. */
export function sheetSize(
  count: number,
  columns: number,
  cell: { readonly width: number; readonly height: number },
): { readonly width: number; readonly height: number; readonly rows: number } {
  const across = Math.max(1, Math.min(columns, count));
  const rows = Math.max(1, Math.ceil(count / across));
  return {
    width: across * cell.width + (across - 1) * SHEET_GAP,
    height: rows * cell.height + (rows - 1) * SHEET_GAP,
    rows,
  };
}

/** Which pixels of two pictures of one size differ, and the box around them. */
export function diffPixels(
  before: Uint8ClampedArray,
  after: Uint8ClampedArray,
  width: number,
  height: number,
  threshold = DIFF_THRESHOLD,
): {
  readonly ratio: number;
  readonly box?: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  readonly changed: Uint8Array;
} {
  const changed = new Uint8Array(width * height);
  let count = 0;
  let left = width;
  let top = height;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const pixel = y * width + x;
      const at = pixel * 4;
      const most = Math.max(
        Math.abs((before[at] ?? 0) - (after[at] ?? 0)),
        Math.abs((before[at + 1] ?? 0) - (after[at + 1] ?? 0)),
        Math.abs((before[at + 2] ?? 0) - (after[at + 2] ?? 0)),
      );
      if (most <= threshold) continue;
      changed[pixel] = 1;
      count += 1;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
    }
  }
  const ratio = width * height > 0 ? count / (width * height) : 0;
  return {
    ratio,
    ...(count > 0 && {
      box: { x: left, y: top, width: right - left + 1, height: bottom - top + 1 },
    }),
    changed,
  };
}

/** The picture now, grey and dim, with the pixels that changed red on it. */
export function diffPicture(
  after: Uint8ClampedArray,
  changed: Uint8Array,
): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(new ArrayBuffer(after.length));
  for (let pixel = 0; pixel < changed.length; pixel += 1) {
    const at = pixel * 4;
    const grey =
      0.3 *
      ((after[at] ?? 0) * 0.299 + (after[at + 1] ?? 0) * 0.587 + (after[at + 2] ?? 0) * 0.114);
    if (changed[pixel]) {
      out[at] = 255;
      out[at + 1] = 48 + grey * 0.4;
      out[at + 2] = 48 + grey * 0.4;
    } else {
      out[at] = grey;
      out[at + 1] = grey;
      out[at + 2] = grey;
    }
    out[at + 3] = 255;
  }
  return out;
}
