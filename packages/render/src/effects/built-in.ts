import blur from "./blur.ts";
import type { EffectCode } from "./code.ts";
import { brightness, contrast, saturation } from "./color.ts";
import crop from "./crop.ts";
import temperature from "./temperature.ts";

export type { EffectCode, EffectFrame, EffectHost } from "./code.ts";
export { temperatureGains } from "./temperature.ts";

/**
 * The code of the effects that come with the editor, by name, as the project format has them.
 * What is not here is left out of the picture, which the plan says already: see `PlannedEffect`.
 */
export const BUILT_IN_EFFECT_CODE: Readonly<Record<string, EffectCode>> = {
  brightness,
  contrast,
  saturation,
  temperature,
  blur,
  crop,
};

export const effectCodeOf = (type: string): EffectCode | undefined =>
  Object.hasOwn(BUILT_IN_EFFECT_CODE, type) ? BUILT_IN_EFFECT_CODE[type] : undefined;
