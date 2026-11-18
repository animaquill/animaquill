import type { MixEffect } from "@animaquill/core/mix-plan";
import { MIX_RATE } from "../resample.ts";
import { fadeSamples, valuesOf, type Processor } from "./processor.ts";

/**
 * The compressor (`compressor`), after Giannoulis, Massberg and Reiss, "Digital Dynamic Range
 * Compressor Design" (2012): feed-forward, in decibels, both sides by the louder of the two. The
 * level x_G = 20·log10(max(|l|, |r|)) (−200 dB for less than 10⁻¹⁰) goes through the static curve
 * with a soft knee, their equation (4); the reduction x_L = x_G − y_G is smoothed by a branching
 * one-pole, attack while it grows and release while it falls, α = e^(−1/(τ·48000)), and under
 * 10⁻¹² dB it is 0; the gain is 10^((makeup − y_L)/20). A ratio of 1 without makeup leaves every
 * sample as it is.
 */

/** From a level to decibels, and from decibels to a level, by the natural logarithm. */
const TO_DB = 20 / Math.LN10;
const FROM_DB = Math.LN10 / 20;

/** A reduction under this many dB is none: it stops going back, at no sound's expense. */
const REST = 1e-12;
/** Below this a level is silence: no reduction at all. */
const FLOOR = 1e-10;
const FLOOR_DB = -200;

/** The static curve of equation (4): the level out for a level in, in dB. */
export function staticCurve(level: number, threshold: number, ratio: number, knee: number): number {
  const over = level - threshold;
  if (knee <= 0) return over <= 0 ? level : threshold + over / ratio;
  if (2 * over < -knee) return level;
  if (2 * Math.abs(over) <= knee) {
    return level + ((1 / ratio - 1) * (over + knee / 2) ** 2) / (2 * knee);
  }
  return threshold + over / ratio;
}

/** The smoothing of a time constant of `ms` milliseconds, per sample of the mix. */
export const smoothing = (ms: number): number => Math.exp(-1 / ((ms / 1000) * MIX_RATE));

export class Compressor implements Processor {
  readonly latency = 0;
  #threshold = 0;
  #ratio = 1;
  #knee = 6;
  #makeup = 0;
  #attack = 0;
  #release = 0;
  /** The reduction as smoothed so far, in dB: its memory. */
  #reduction = 0;
  /** The most since `takeReduction`. */
  #most = 0;

  configure(param: (name: string) => number): void {
    this.#threshold = param("threshold");
    this.#ratio = param("ratio");
    this.#knee = param("knee");
    this.#makeup = param("makeup");
    this.#attack = smoothing(param("attack"));
    this.#release = smoothing(param("release"));
  }

  process(channels: readonly Float64Array[], at: number, count: number): void {
    const threshold = this.#threshold;
    const ratio = this.#ratio;
    const knee = this.#knee;
    const makeup = this.#makeup;
    // Nothing to reduce, nothing to add, nothing remembered: every sample stays.
    if (ratio === 1 && makeup === 0 && this.#reduction === 0) return;
    const attack = this.#attack;
    const release = this.#release;
    const left = channels[0] as Float64Array;
    const right = channels[1];
    // Under where the knee starts, the curve reduces nothing.
    const quiet = 10 ** ((threshold - knee / 2) / 20);
    const still = Math.exp(makeup * FROM_DB);
    let reduction = this.#reduction;
    const end = at + count;
    for (let index = at; index < end; index += 1) {
      const l = left[index] as number;
      const r = right ? (right[index] as number) : l;
      const peak = Math.max(Math.abs(l), Math.abs(r));
      let gain: number;
      if (peak <= quiet || ratio === 1) {
        // The target is 0: the reduction goes back with the release.
        if (reduction === 0) gain = still;
        else {
          reduction = release * reduction;
          if (reduction < REST) reduction = 0;
          gain = Math.exp((makeup - reduction) * FROM_DB);
        }
      } else {
        const level = peak > FLOOR ? Math.log(peak) * TO_DB : FLOOR_DB;
        const target = level - staticCurve(level, threshold, ratio, knee);
        const alpha = target > reduction ? attack : release;
        reduction = alpha * reduction + (1 - alpha) * target;
        if (reduction < REST) reduction = 0;
        gain = Math.exp((makeup - reduction) * FROM_DB);
      }
      left[index] = l * gain;
      if (right) right[index] = r * gain;
    }
    this.#reduction = reduction;
    if (reduction > this.#most) this.#most = reduction;
  }

  takeReduction(): number {
    const most = Math.max(this.#most, this.#reduction);
    this.#most = 0;
    return most;
  }

  reset(): void {
    this.#reduction = 0;
  }

  settle(): boolean {
    return this.#reduction === 0;
  }
}

/**
 * The memory of a compressor, in samples: with the slower of its two time constants, until two
 * reductions that started apart (by as much as one can be, for sound up to +24 dBFS) are close
 * enough that the sound they give, up to +12 dBFS and with the makeup, is within 2⁻¹⁶.
 */
export function compressorMemory(effect: MixEffect): number {
  const slowest = Math.max(...valuesOf(effect, "attack"), ...valuesOf(effect, "release"));
  let apart = 0;
  for (const threshold of valuesOf(effect, "threshold")) {
    for (const ratio of valuesOf(effect, "ratio")) {
      for (const knee of valuesOf(effect, "knee")) {
        apart = Math.max(apart, (24 - threshold + knee / 2) * (1 - 1 / ratio));
      }
    }
  }
  const makeup = 10 ** (Math.max(...valuesOf(effect, "makeup")) / 20);
  // A reduction that is d dB off changes the sound by up to d·ln(10)/20 of it.
  const worst = Math.max(1, apart * (Math.LN10 / 20) * makeup * 4);
  return fadeSamples(smoothing(slowest), 2 ** -16 / worst) + 1;
}
