import {
  effectParamAt,
  effectParamMoves,
  effectParamRange,
  type MixEffect,
} from "@animaquill/core/mix-plan";

/**
 * One effect of sound as the mix engine runs it, on one or two channels in place, sample by sample
 * in doubles. Every one of them does what the project format says, to the sample, and once out it
 * never changes: a better one gets another name.
 */
export interface Processor {
  /** Samples its sound comes out after it went in. The mix makes up for it, see `engine.ts`. */
  readonly latency: number;
  /**
   * Takes its parameters: before the first sample, and every `PARAMETER_STEP` samples while one of
   * them has keys. `param` reads them within their range.
   */
  configure(param: (name: string) => number): void;
  /** Works on `count` samples of each channel from `at` on, in place. */
  process(channels: readonly Float64Array[], at: number, count: number): void;
  /** As if nothing ever went in. */
  reset(): void;
  /**
   * Whether all it holds is silence, so that silence in gives silence out: it may then skip. Small
   * enough memory counts, and becomes silence once it says so.
   */
  settle(): boolean;
  /**
   * The most it took off since this was asked last, in dB (0 for nothing), for the meters of the
   * interface: only compressors and limiters have it.
   */
  takeReduction?(): number;
}

/**
 * The memory of a value that fades by `ratio` each sample, in samples: how long until what it held
 * is below `share` of what it was. 2⁻²⁴ (−144 dB) by default, far enough under −96 dBFS for any
 * level a mix gets to.
 */
export const fadeSamples = (ratio: number, share = 2 ** -24): number =>
  ratio <= 0
    ? 0
    : ratio >= 1
      ? Number.POSITIVE_INFINITY
      : Math.ceil(Math.log(share) / Math.log(ratio));

/** Below this all an effect holds counts as silence: 2⁻⁸⁰, some −480 dB. */
export const QUIET = 2 ** -80;

/**
 * The values a parameter can have while an effect works: the one it has, or with keys the ends of
 * its range, which is what its memory has to be ready for.
 */
export function valuesOf(effect: MixEffect, name: string): readonly number[] {
  if (effectParamMoves(effect, name)) return effectParamRange(effect.type, name);
  return [effectParamAt(effect, name, 0)];
}
