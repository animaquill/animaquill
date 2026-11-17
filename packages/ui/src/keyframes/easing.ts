import {
  bezierProgress,
  knowsPreset,
  presetProgress,
  springOf,
  springProgress,
  type KeyEase,
} from "@animaquill/core";
import { EASE_PRESET_NAMES, type Key } from "@animaquill/schema";

/** Easing written as numbers: a bezier, or one of the two that have none. */
const FIXED_EASES = {
  linear: { interp: "linear" },
  hold: { interp: "hold" },
  easeIn: { interp: "bezier", out: [0.42, 0], in: [1, 1] },
  easeOut: { interp: "bezier", out: [0, 0], in: [0.58, 1] },
  easeInOut: { interp: "bezier", out: [0.42, 0], in: [0.58, 1] },
  overshoot: { interp: "bezier", out: [0.34, 1.56], in: [0.64, 1] },
} as const satisfies Readonly<Record<string, KeyEase>>;

type FixedEase = keyof typeof FIXED_EASES;

/** Presets of the project format and springs, which people tune below the choices. */
export const TUNED_EASES = ["elastic", "bounce", "steps", "spring"] as const;

export type TunedEase = (typeof TUNED_EASES)[number];

export type EasePreset = FixedEase | TunedEase;

/** What people pick from, in this order. */
export const EASE_CHOICES: readonly EasePreset[] = [
  ...(Object.keys(FIXED_EASES) as FixedEase[]),
  ...TUNED_EASES,
];

export const isTuned = (preset: EasePreset | undefined): preset is TunedEase =>
  (TUNED_EASES as readonly string[]).includes(preset ?? "");

/** Where elastic and bounce do their thing: at the next key (out), at their own (in), or both. */
export type EaseDirection = "in" | "out" | "inOut";
export const EASE_DIRECTIONS: readonly EaseDirection[] = ["in", "out", "inOut"];

/** Whether steps jump right at their key (start) or only once a step has passed (end). */
export type StepJump = "start" | "end";
export const STEP_JUMPS: readonly StepJump[] = ["start", "end"];

/** All that the tuned eases take. Each uses some of it, and keeps the rest when people switch. */
export interface EaseTuning {
  readonly direction: EaseDirection;
  /** Elastic: how far it overshoots, at least 1. */
  readonly amplitude: number;
  /** Elastic: how long one swing takes, as a share of the stretch. */
  readonly period: number;
  readonly steps: number;
  readonly jump: StepJump;
  /** Spring: how much it wobbles, 0 not at all; 1 would never stop, so it goes up to 0.95. */
  readonly wobble: number;
  /** Spring: how long one swing takes, in seconds: more is slower. */
  readonly duration: number;
}

/**
 * Out is what people want most: it plays at the end. The steps are those of CSS `steps(4)`. A spring
 * with this wobble is still to less than 0.001 two swings after it starts, which is where the spring
 * a stretch gets comes to its next key (see `springFor`), and overshoots by a tenth.
 */
export const DEFAULT_TUNING: EaseTuning = {
  direction: "out",
  amplitude: 1,
  period: 0.3,
  steps: 4,
  jump: "end",
  wobble: 0.4,
  duration: 0.5,
};

/** The ranges people can choose from, which are all what the project format can work out. */
export const TUNING_RANGES = {
  amplitude: { min: 1, max: 10 },
  period: { min: 0.05, max: 2 },
  steps: { min: 1, max: 100 },
  wobble: { min: 0, max: 0.95 },
  duration: { min: 0.01, max: 60 },
} as const;

const TAU = 2 * Math.PI;

/** The spring of the project format that swings in `duration` seconds with a wobble. */
export function springFrom(wobble: number, duration: number): NonNullable<Key["spring"]> {
  const stiffness = (TAU / duration) ** 2;
  return { stiffness, damping: 2 * (1 - wobble) * Math.sqrt(stiffness) };
}

/** The other way round, whatever the mass. Undefined for a spring that cannot be worked out. */
export function tuningOfSpring(
  spring: Key["spring"],
): Pick<EaseTuning, "wobble" | "duration"> | undefined {
  const known = springOf(spring);
  if (!known) return undefined;
  const [omega, zeta] = known;
  return { wobble: 1 - zeta, duration: TAU / omega };
}

/** What a spring is when people choose it: it comes to rest by the next key, half way along. */
export const springFor = (length: number | undefined): Pick<EaseTuning, "duration"> => ({
  duration: length !== undefined && length > 0 ? length / 2 : DEFAULT_TUNING.duration,
});

const SUFFIXES: Readonly<Record<EaseDirection, string>> = { in: "In", out: "Out", inOut: "InOut" };

/** How a key eases with a preset. What is as the format has it anyway is left out. */
export function easeOf(preset: EasePreset, tuning: EaseTuning = DEFAULT_TUNING): KeyEase {
  switch (preset) {
    case "elastic": {
      const { amplitude, period } = tuning;
      const params = {
        ...(amplitude !== DEFAULT_TUNING.amplitude && { amplitude }),
        ...(period !== DEFAULT_TUNING.period && { period }),
      };
      return {
        interp: "preset",
        preset: `elastic${SUFFIXES[tuning.direction]}`,
        ...(Object.keys(params).length > 0 && { presetParams: params }),
      };
    }
    case "bounce":
      return { interp: "preset", preset: `bounce${SUFFIXES[tuning.direction]}` };
    case "steps":
      return {
        interp: "preset",
        preset: tuning.jump === "start" ? "stepsStart" : "stepsEnd",
        presetParams: { steps: tuning.steps },
      };
    case "spring":
      return { interp: "spring", spring: springFrom(tuning.wobble, tuning.duration) };
    default:
      return FIXED_EASES[preset];
  }
}

const sameHandle = (a: readonly number[] | undefined, b: readonly number[]) =>
  a?.[0] === b[0] && a?.[1] === b[1];

const directionOf = (name: string): EaseDirection =>
  name.endsWith("InOut") ? "inOut" : name.endsWith("In") ? "in" : "out";

/** Which tuned preset a key is, as far as it can be worked out. */
function tunedOf(key: Key): TunedEase | undefined {
  if (key.interp === "spring") return springOf(key.spring) ? "spring" : undefined;
  if (key.interp !== "preset" || !knowsPreset(key)) return undefined;
  const name = key.preset as string;
  if (name.startsWith("elastic")) return "elastic";
  if (name.startsWith("bounce")) return "bounce";
  return "steps";
}

/** Which preset a stretch is, as far as it is one. Without a next key only its start can tell. */
export function presetOf(key: Key, next: Key | undefined): EasePreset | undefined {
  const { interp, out } = key;
  if (interp === undefined || interp === "linear") return "linear";
  if (interp === "hold") return "hold";
  if (interp !== "bezier") return tunedOf(key);
  const arriving = next?.in ?? [1, 1];
  return (Object.keys(FIXED_EASES) as FixedEase[]).find((id) => {
    const ease: KeyEase = FIXED_EASES[id];
    return (
      ease.interp === "bezier" &&
      sameHandle(out, ease.out) &&
      (next === undefined || sameHandle(arriving, ease.in ?? [1, 1]))
    );
  });
}

/** What a key says of the tuning of its preset, and the defaults for the rest. */
export function tuningOf(key: Key): EaseTuning {
  if (key.interp === "spring") return { ...DEFAULT_TUNING, ...tuningOfSpring(key.spring) };
  if (key.interp !== "preset" || !knowsPreset(key)) return DEFAULT_TUNING;
  const name = key.preset as string;
  const { amplitude, period, steps } = key.presetParams ?? {};
  return {
    ...DEFAULT_TUNING,
    direction: name.startsWith("steps") ? DEFAULT_TUNING.direction : directionOf(name),
    jump: name === "stepsStart" ? "start" : "end",
    ...(amplitude !== undefined && { amplitude }),
    ...(period !== undefined && { period }),
    ...(steps !== undefined && { steps }),
  };
}

/**
 * How far along an ease is at a share of its stretch, as the project format works it out. A spring
 * goes by seconds: `span` is how long the stretch is, two swings when it is not known.
 */
export function progressOf(ease: KeyEase, share: number, span?: number): number {
  switch (ease.interp) {
    case "linear":
      return share;
    case "hold":
      return share >= 1 ? 1 : 0;
    case "bezier": {
      const [x1, y1] = ease.out;
      const [x2, y2] = ease.in ?? [1, 1];
      return bezierProgress(x1, y1, x2, y2, share);
    }
    case "spring": {
      const known = springOf(ease.spring);
      if (!known) return share;
      const [omega, zeta] = known;
      const seconds = span ?? (2 * TAU) / omega;
      return share >= 1 ? 1 : springProgress(omega, zeta, share * seconds);
    }
    case "preset": {
      const index = (EASE_PRESET_NAMES as readonly string[]).indexOf(ease.preset);
      if (index < 0 || !knowsPreset(ease)) return share;
      const { amplitude = 1, period = 0.3, steps = 1 } = ease.presetParams ?? {};
      return presetProgress(index, amplitude, period, steps, share);
    }
  }
}
