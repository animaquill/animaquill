import { SPEED_PRESETS, type SpeedCurve } from "@animaquill/schema";

/** What the speed buttons of a transition say. An even speed is no curve at all. */
export type SpeedPreset = "linear" | keyof typeof SPEED_PRESETS;

export const SPEED_PRESET_IDS: readonly SpeedPreset[] = [
  "linear",
  "easeIn",
  "easeOut",
  "easeInOut",
];

/** The curve of a preset, which for an even speed is none. */
export const curveOfPreset = (preset: SpeedPreset): SpeedCurve | undefined =>
  preset === "linear" ? undefined : SPEED_PRESETS[preset];

/** Which preset a curve is, as far as it is one: the project keeps numbers, not names. */
export function presetOf(curve: SpeedCurve | undefined): SpeedPreset | undefined {
  if (!curve || isEven(curve)) return "linear";
  return SPEED_PRESET_IDS.find((id) => {
    const preset = curveOfPreset(id);
    return preset !== undefined && preset.every((value, index) => value === curve[index]);
  });
}

/** Both handles on the straight line from the start to the end: that is no curve. */
const isEven = ([x1, y1, x2, y2]: SpeedCurve) => x1 === y1 && x2 === y2;

/** Where the handles of an even speed show, on its line, where people can grab them. */
export const EVEN_HANDLES: SpeedCurve = [1 / 3, 1 / 3, 2 / 3, 2 / 3];

/** What a curve looks like with its handles, also when there is none. */
export const handlesOf = (curve: SpeedCurve | undefined): SpeedCurve => curve ?? EVEN_HANDLES;

const clamp = (value: number, low: number, high: number) => Math.min(Math.max(value, low), high);

/** Few digits, which is what people can set by hand anyway, and what a file reads well with. */
const tidy = (value: number) => Math.round(value * 1000) / 1000;

/**
 * A curve with one of its handles somewhere else. A handle stays within the time of the transition.
 * Going past 0 and 1 the other way is a curve that overshoots, which only some transitions do: for
 * the others it stops there, as their progress does.
 */
export function withHandle(
  curve: SpeedCurve | undefined,
  handle: 0 | 1,
  x: number,
  y: number,
  overshoot: boolean,
): SpeedCurve {
  const [x1, y1, x2, y2] = handlesOf(curve);
  const at = [tidy(clamp(x, 0, 1)), tidy(overshoot ? clamp(y, -1, 2) : clamp(y, 0, 1))] as const;
  return handle === 0 ? [at[0], at[1], x2, y2] : [x1, y1, at[0], at[1]];
}

/** What gets written for a curve: none for an even speed. */
export const writtenCurve = (curve: SpeedCurve): SpeedCurve | undefined =>
  isEven(curve) ? undefined : curve;
