import { filterEffect, numberOf } from "./code.ts";

/**
 * 模糊: a Gaussian blur whose standard deviation is the radius, in world units of the box, as CSS
 * `blur()`. Outside the box there is nothing, so the edges of the box get softer as well. The canvas
 * does it on the graphics card, which takes few milliseconds also at 4K.
 */
const blur = filterEffect(
  (values, { pixelRatio }) => `blur(${Math.max(numberOf(values, "radius") * pixelRatio, 0)}px)`,
);

export default blur;
