import { filterEffect, numberOf } from "./code.ts";

/** 亮度: the colors times 1 + brightness, as CSS `brightness()`. */
export const brightness = filterEffect(
  (values) => `brightness(${Math.max(1 + numberOf(values, "brightness"), 0)})`,
);

/** 对比度: away from the middle gray by 1 + contrast, or towards it, as CSS `contrast()`. */
export const contrast = filterEffect(
  (values) => `contrast(${Math.max(1 + numberOf(values, "contrast"), 0)})`,
);

/** 饱和度: 1 + saturation of the color around its gray, as CSS `saturate()`. */
export const saturation = filterEffect(
  (values) => `saturate(${Math.max(1 + numberOf(values, "saturation"), 0)})`,
);
