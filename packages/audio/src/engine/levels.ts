import { MeterChannel, loudnessOf } from "../meter.ts";

/** How often the meters of the mixer hear from the audio thread, per second. */
export const LEVELS_PER_SECOND = 30;
/** The short-term loudness: 3 s, in sub-blocks of 100 ms, as BS.1770 and EBU R128 have it. */
const SUB_SECONDS = 0.1;
const SHORT_TERM_SUBS = 30;

/** What the meters of the mixer show, since the last of these. */
export interface Levels {
  /** The tracks, in the order of the plan, and the largest sample of each after its fader and pan. */
  readonly tracks: readonly string[];
  readonly peaks: readonly number[];
  /** The largest sample of each side of the master. */
  readonly left: number;
  readonly right: number;
  /** The largest true peak (BS.1770-4 Annex 2) of either side, as a level, not in dB. */
  readonly truePeak: number;
  /**
   * The short-term loudness in LUFS: the last 3 s, or what played so far when that is less.
   * Undefined until 100 ms played, and −Infinity for silence.
   */
  readonly shortTerm: number | undefined;
  /**
   * What compressors and limiters took off, in dB, by where they are (see
   * `MixEngine.takeReductions`).
   */
  readonly reductions?: readonly (readonly [string, number])[];
}

/**
 * What the master meters measure as the mix plays: peaks of each side, the true peak and the
 * short-term loudness, K-weighted as `SoundMeter` does for what AI hears, so that the two read the
 * same. It runs in the audio thread and makes nothing new while it measures.
 */
export class MasterLevels {
  readonly #left: MeterChannel;
  readonly #right: MeterChannel;
  readonly #subLength: number;
  /** The mean square of the sub-blocks of the last 3 s, round and round. */
  readonly #subs = new Float64Array(SHORT_TERM_SUBS);
  #subsFilled = 0;
  #subAt = 0;
  #subEnergy = 0;
  #subCount = 0;
  #peakLeft = 0;
  #peakRight = 0;
  #shortTerm: number | undefined;

  constructor(rate: number) {
    this.#left = new MeterChannel(rate);
    this.#right = new MeterChannel(rate);
    this.#subLength = Math.round(rate * SUB_SECONDS);
  }

  /** The next samples of the master, as they are heard. */
  add(left: Float32Array, right: Float32Array): void {
    const length = left.length;
    for (let index = 0; index < length; index += 1) {
      const l = left[index] ?? 0;
      const r = right[index] ?? 0;
      const al = Math.abs(l);
      const ar = Math.abs(r);
      if (al > this.#peakLeft) this.#peakLeft = al;
      if (ar > this.#peakRight) this.#peakRight = ar;
      this.#subEnergy += this.#left.step(l) + this.#right.step(r);
      this.#subCount += 1;
      if (this.#subCount === this.#subLength) this.#endSub();
    }
  }

  #endSub(): void {
    this.#subs[this.#subAt] = this.#subEnergy / this.#subLength;
    this.#subAt = (this.#subAt + 1) % SHORT_TERM_SUBS;
    this.#subsFilled = Math.min(this.#subsFilled + 1, SHORT_TERM_SUBS);
    this.#subEnergy = 0;
    this.#subCount = 0;
    let sum = 0;
    for (let index = 0; index < this.#subsFilled; index += 1) sum += this.#subs[index] as number;
    this.#shortTerm = loudnessOf(Math.max(0, sum / this.#subsFilled));
  }

  /** What was measured since the last time, and the loudness so far. */
  take(): Pick<Levels, "left" | "right" | "truePeak" | "shortTerm"> {
    const taken = {
      left: this.#peakLeft,
      right: this.#peakRight,
      truePeak: Math.max(this.#left.truePeak, this.#right.truePeak),
      shortTerm: this.#shortTerm,
    };
    this.#peakLeft = 0;
    this.#peakRight = 0;
    this.#left.truePeak = 0;
    this.#right.truePeak = 0;
    return taken;
  }
}
