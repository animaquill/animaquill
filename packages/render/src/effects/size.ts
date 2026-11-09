import type { Matrix } from "@animaquill/core/view";

/** The most pixels a side of the picture of a box for effects gets: what canvases can still have. */
export const MAX_EFFECT_SIDE = 8192;
/** The most pixels it gets in all, as so many pictures: a clip zoomed far in needs no more. */
const MAX_EFFECT_PICTURES = 4;

/**
 * How large the picture of a box is that its effects work on: as large as the box is on the
 * picture, in pixels, so that an effect is as sharp as the rest. A box far larger than the picture
 * gets fewer pixels, at most four pictures' worth and never more than a canvas can have, and its
 * effects see that in their `pixelRatio`, so they look the same, only coarser.
 */
export function effectInputSize(
  toPicture: Matrix,
  box: { readonly width: number; readonly height: number },
  picture: { readonly width: number; readonly height: number },
): { readonly width: number; readonly height: number } {
  const [a, b] = toPicture;
  // Every way the same: units of the world are square, and so are the scales of clips.
  let scale = Math.hypot(a, b);
  const most = MAX_EFFECT_PICTURES * Math.max(picture.width * picture.height, 1);
  const area = box.width * box.height * scale * scale;
  if (area > most) scale *= Math.sqrt(most / area);
  const side = Math.max(box.width, box.height) * scale;
  if (side > MAX_EFFECT_SIDE) scale *= MAX_EFFECT_SIDE / side;
  const width = Math.min(Math.max(Math.round(box.width * scale), 1), MAX_EFFECT_SIDE);
  const height = Math.min(Math.max(Math.round(box.height * scale), 1), MAX_EFFECT_SIDE);
  return { width, height };
}
