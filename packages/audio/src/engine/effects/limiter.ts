import type { MixEffect } from "@animaquill/core/mix-plan";
import { TRUE_PEAK_PHASES } from "../../meter.ts";
import { fadeSamples, valuesOf, type Processor } from "./processor.ts";
import { smoothing } from "./compressor.ts";

/**
 * The limiter (`limiter`, and the safe limiter at the end of the master): keeps the true peaks of
 * both sides under a ceiling, looking ahead 1.5 ms. Sample by sample n:
 *
 * 1. The true peak around sample n − 6: the four values of the interpolation of BS.1770-4 Annex 2
 *    (`TRUE_PEAK_PHASES`, on samples n − 11 to n) and |x[n − 6]|, the largest of either side.
 * 2. The gain it needs, q[n]: 1 up to the ceiling c = 10^(ceiling/20), c·(1 − 2⁻¹⁰)/peak above
 *    it (a hair under the ceiling, for the gain that still changes around a smaller peak).
 * 3. h[n]: the smallest q of the last `HOLD` samples.
 * 4. e[n]: h[n] when that is lower than e[n − 1], else e[n − 1] + (h[n] − e[n − 1])·(1 − α), with
 *    α = e^(−1/(τ·48000)) from the release; within 10⁻¹² of 1 it is 1.
 * 5. The gain s[n]: the mean of the last `RAMP` values of e, exactly 1 when they all are.
 * 6. Out: x[n − 72]·s[n].
 *
 * So the gain goes down in a straight line over `RAMP` samples before a peak and stays down for
 * all the samples the interpolation around it takes; where nothing goes over, the gain is exactly 1
 * and the sound only comes 72 samples later, which the mix makes up for.
 */

/** Samples the sound comes out later. */
export const LOOKAHEAD = 72;
/** How far under the ceiling what goes over it is brought: 2⁻¹⁰, some 0.008 dB. */
const UNDER = 1 - 2 ** -10;
/** Samples a needed gain is held. */
export const HOLD = LOOKAHEAD + 1;
/** Samples the gain takes to go down. */
export const RAMP = LOOKAHEAD - 10;
const TAPS = 12;
/** The sample that the four values of the interpolation at sample n are around. */
const MIDDLE = 6;
/** The four phases of the interpolation in a row. */
const PHASES = Float64Array.from(TRUE_PEAK_PHASES.flat());
/**
 * The most that any of the four values can be for samples of at most 1: while the last `TAPS`
 * samples stay under the ceiling divided by this, nothing goes over it, and the peak need not be
 * worked out (which gives the very same gain, quicker).
 */
const REACH = Math.max(
  ...TRUE_PEAK_PHASES.map((phase) => phase.reduce((sum, tap) => sum + Math.abs(tap), 0)),
);

export class Limiter implements Processor {
  readonly latency = LOOKAHEAD;
  readonly #channels: number;
  #ceiling = 10 ** (-1 / 20);
  /** Under this a sample cannot make anything go over the ceiling, see `REACH`. */
  #safe = 10 ** (-1 / 20) / REACH;
  /** Samples since the last that was not under `#safe`. */
  #since = TAPS;
  #release = 0;
  /** The last `TAPS` samples of each side, twice over so that they read in a row. */
  readonly #history: Float64Array[];
  #at = 0;
  /** The last `LOOKAHEAD` samples of each side, to give out later. */
  readonly #delay: Float64Array[];
  #delayAt = 0;
  readonly #needed = new Float64Array(HOLD).fill(1);
  #neededAt = 0;
  /** How many of `#needed` are below 1. */
  #lowNeeded = 0;
  #held = 1;
  readonly #ramp = new Float64Array(RAMP).fill(1);
  #rampAt = 0;
  #lowRamp = 0;
  /** The gain of the last sample: what the meters of the mixer show. */
  gain = 1;
  /** The least gain since `takeReduction`. */
  #least = 1;

  constructor(channels: number) {
    this.#channels = channels;
    this.#history = Array.from({ length: channels }, () => new Float64Array(TAPS * 2));
    this.#delay = Array.from({ length: channels }, () => new Float64Array(LOOKAHEAD));
  }

  configure(param: (name: string) => number): void {
    this.setCeiling(param("ceiling"));
    this.#release = smoothing(param("release"));
  }

  /** The ceiling in dBTP. */
  setCeiling(ceiling: number): void {
    this.#ceiling = 10 ** (ceiling / 20);
    this.#safe = (this.#ceiling / REACH) * (1 - 1e-12);
  }

  /** The release in milliseconds. */
  setRelease(ms: number): void {
    this.#release = smoothing(ms);
  }

  process(channels: readonly Float64Array[], at: number, count: number): void {
    const end = at + count;
    const sides = this.#channels;
    const ceiling = this.#ceiling;
    const rise = 1 - this.#release;
    for (let index = at; index < end; index += 1) {
      // 1 and 2: what the newest samples need.
      const slot = this.#at;
      const newest = slot + TAPS;
      const safe = this.#safe;
      let loud = false;
      for (let side = 0; side < sides; side += 1) {
        const history = this.#history[side] as Float64Array;
        const x = (channels[side] as Float64Array)[index] as number;
        history[slot] = x;
        history[newest] = x;
        if (x > safe || x < -safe) loud = true;
      }
      this.#at = (slot + 1) % TAPS;
      this.#since = loud ? 0 : this.#since + 1;
      let need = 1;
      if (this.#since < TAPS) {
        let peak = 0;
        for (let side = 0; side < sides; side += 1) {
          const history = this.#history[side] as Float64Array;
          const middle = Math.abs(history[newest - MIDDLE] as number);
          if (middle > peak) peak = middle;
          for (let phase = 0; phase < 4; phase += 1) {
            let value = 0;
            const base = phase * TAPS;
            for (let tap = 0; tap < TAPS; tap += 1) {
              value += (PHASES[base + tap] as number) * (history[newest - tap] as number);
            }
            const level = value < 0 ? -value : value;
            if (level > peak) peak = level;
          }
        }
        if (peak > ceiling) need = (ceiling * UNDER) / peak;
      }
      // 3: the smallest of the last HOLD.
      const needed = this.#needed;
      const dropped = needed[this.#neededAt] as number;
      if (dropped < 1) this.#lowNeeded -= 1;
      if (need < 1) this.#lowNeeded += 1;
      needed[this.#neededAt] = need;
      this.#neededAt = (this.#neededAt + 1) % HOLD;
      let held = 1;
      if (this.#lowNeeded > 0) {
        for (let place = 0; place < HOLD; place += 1) {
          const value = needed[place] as number;
          if (value < held) held = value;
        }
      }
      // 4: down at once, up with the release.
      let envelope = this.#held;
      if (held < envelope) envelope = held;
      else if (envelope < held) {
        envelope += (held - envelope) * rise;
        if (held - envelope < 1e-12) envelope = held;
      }
      this.#held = envelope;
      // 5: the mean of the last RAMP.
      const ramp = this.#ramp;
      const gone = ramp[this.#rampAt] as number;
      if (gone < 1) this.#lowRamp -= 1;
      if (envelope < 1) this.#lowRamp += 1;
      ramp[this.#rampAt] = envelope;
      this.#rampAt = (this.#rampAt + 1) % RAMP;
      let gain = 1;
      if (this.#lowRamp > 0) {
        let sum = 0;
        for (let one = 0; one < RAMP; one += 1) sum += ramp[one] as number;
        gain = sum / RAMP;
      }
      this.gain = gain;
      if (gain < this.#least) this.#least = gain;
      // 6: what went in LOOKAHEAD samples ago.
      const delayAt = this.#delayAt;
      for (let side = 0; side < sides; side += 1) {
        const delay = this.#delay[side] as Float64Array;
        const samples = channels[side] as Float64Array;
        const late = delay[delayAt] as number;
        delay[delayAt] = samples[index] as number;
        samples[index] = gain === 1 ? late : late * gain;
      }
      this.#delayAt = (delayAt + 1) % LOOKAHEAD;
    }
  }

  takeReduction(): number {
    const least = Math.min(this.#least, this.gain);
    this.#least = 1;
    return least >= 1 ? 0 : -20 * Math.log10(least);
  }

  /**
   * Outside the stretch it works in: what came in goes out `LOOKAHEAD` samples later as it is, and
   * the gain starts over at 1, so that it works from nothing where it starts again.
   */
  pass(channels: readonly Float64Array[], at: number, count: number): void {
    this.#needed.fill(1);
    this.#ramp.fill(1);
    this.#lowNeeded = 0;
    this.#lowRamp = 0;
    this.#held = 1;
    this.gain = 1;
    const sides = this.#channels;
    for (let index = at; index < at + count; index += 1) {
      const slot = this.#at;
      const delayAt = this.#delayAt;
      let loud = false;
      for (let side = 0; side < sides; side += 1) {
        const samples = channels[side] as Float64Array;
        const history = this.#history[side] as Float64Array;
        const delay = this.#delay[side] as Float64Array;
        const x = samples[index] as number;
        history[slot] = x;
        history[slot + TAPS] = x;
        samples[index] = delay[delayAt] as number;
        delay[delayAt] = x;
        if (x > this.#safe || x < -this.#safe) loud = true;
      }
      this.#since = loud ? 0 : this.#since + 1;
      this.#at = (slot + 1) % TAPS;
      this.#delayAt = (delayAt + 1) % LOOKAHEAD;
    }
  }

  reset(): void {
    this.#since = TAPS;
    for (const history of this.#history) history.fill(0);
    for (const delay of this.#delay) delay.fill(0);
    this.#needed.fill(1);
    this.#ramp.fill(1);
    this.#lowNeeded = 0;
    this.#lowRamp = 0;
    this.#held = 1;
    this.gain = 1;
  }

  settle(): boolean {
    if (this.#lowNeeded > 0 || this.#lowRamp > 0 || this.#held !== 1) return false;
    for (const delay of this.#delay) for (const value of delay) if (value !== 0) return false;
    for (const history of this.#history) for (const value of history) if (value !== 0) return false;
    return true;
  }
}

/**
 * The memory of a limiter in samples: its release until two gains that started apart (by at most
 * 1) are within 2⁻¹⁷ (what it gives out is under its ceiling, at most 1), and what it holds and
 * looks ahead.
 */
export function limiterMemoryOf(release: number): number {
  return fadeSamples(smoothing(release), 2 ** -17) + HOLD + RAMP + LOOKAHEAD + TAPS;
}

export const limiterMemory = (effect: MixEffect): number =>
  limiterMemoryOf(Math.max(...valuesOf(effect, "release")));
