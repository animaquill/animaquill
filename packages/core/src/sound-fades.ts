import type { SpeedCurve, TransitionUse } from "@animaquill/schema";
import { progressAt } from "./view.ts";

/**
 * Transitions of sound: what they do to the gain of a sound over their time. A fade in, the side
 * after the cut of a cross-fade, goes from nothing up; a fade out, the side before, goes down to
 * nothing. `fade` keeps the power of the two sides of a cross-fade together the same (cos and sin),
 * `fade-linear` their gain (1 − p and p), see the project format. Playback and the mix of an export
 * both work out every sample with `fadeGainAt`, so what people hear is what the file gets.
 */

/** How the gain of a sound goes over a transition, see `fadeGainAt`. */
export interface SoundFade {
  /** Where it is on the clip: at its start, at its end, or on a cut, as either side of a join. */
  readonly use: TransitionUse;
  /** From nothing to the sound, or from the sound to nothing. */
  readonly way: "in" | "out";
  /** `power` keeps the power of a cross-fade the same, `gain` its gain. */
  readonly shape: "power" | "gain";
  /** Seconds on the timeline. */
  readonly start: number;
  readonly end: number;
  /** Seconds from the exact length, as `PlannedTransition.duration`. */
  readonly duration: number;
  /** Without it the speed is even. */
  readonly curve?: SpeedCurve;
  /**
   * It stands in for a transition that this editor cannot do, as a `fade`. An export stops there,
   * so that no file says something else than the project.
   */
  readonly missing?: true;
}

const QUARTER_TURN = Math.PI / 2;

/** The gain that one transition gives a sound at a moment on the timeline, from 0 to 1. */
export function fadeGainAt(fade: SoundFade, seconds: number): number {
  const progress = progressAt(fade, seconds);
  const share = fade.way === "in" ? progress : 1 - progress;
  if (share <= 0) return 0;
  if (share >= 1) return 1;
  return fade.shape === "power" ? Math.sin(share * QUARTER_TURN) : share;
}

/** What the transitions of a sound give it at a moment: all of them together, 1 without any. */
export function fadesGainAt(fades: readonly SoundFade[] | undefined, seconds: number): number {
  let gain = 1;
  if (!fades) return gain;
  for (const fade of fades) {
    if (seconds <= fade.start && fade.way === "out") continue;
    if (seconds >= fade.end && fade.way === "in") continue;
    gain *= fadeGainAt(fade, seconds);
  }
  return gain;
}

/** Whether any of the transitions of a sound changes it somewhere from `from` up to `to`. */
export const fadesDuring = (
  fades: readonly SoundFade[] | undefined,
  from: number,
  to: number,
): boolean => fades?.some((fade) => fade.start < to && fade.end > from) === true;
