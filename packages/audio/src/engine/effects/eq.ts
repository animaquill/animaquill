import { effectParamMoves, type MixEffect } from "@animaquill/core/mix-plan";
import { MIX_RATE } from "../resample.ts";
import { QUIET, valuesOf, type Processor } from "./processor.ts";

/**
 * The equalizer (`eq`): high pass, low shelf, three peaks, high shelf and low pass, in that order,
 * each a biquad with the coefficients of Robert Bristow-Johnson's "Audio EQ Cookbook", in transposed
 * direct form II with its memory in doubles. High and low pass are Butterworth (Q = 1/√2), 24 dB an
 * octave being two of them one after the other; the shelves have a slope S of 1; the peaks their Q.
 * A band whose gain is 0 and has no keys is left out, and so is a pass that is off, so that the
 * defaults leave every sample as it is.
 */

/** The coefficients of one biquad, divided by a0. */
export interface Biquad {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

export type BandKind = "highpass" | "lowshelf" | "peak" | "highshelf" | "lowpass";

const BUTTERWORTH_Q = Math.SQRT1_2;

/** The cookbook's coefficients for a band at `frequency` Hz, at the rate of the mix. */
export function cookbook(
  kind: BandKind,
  frequency: number,
  gain: number,
  q: number,
  rate = MIX_RATE,
): Biquad {
  const w0 = (2 * Math.PI * frequency) / rate;
  const cos = Math.cos(w0);
  const sin = Math.sin(w0);
  const A = 10 ** (gain / 40);
  let b0: number;
  let b1: number;
  let b2: number;
  let a0: number;
  let a1: number;
  let a2: number;
  switch (kind) {
    case "highpass":
    case "lowpass": {
      const alpha = sin / (2 * q);
      const side = kind === "lowpass" ? 1 - cos : 1 + cos;
      b0 = side / 2;
      b1 = kind === "lowpass" ? side : -side;
      b2 = side / 2;
      a0 = 1 + alpha;
      a1 = -2 * cos;
      a2 = 1 - alpha;
      break;
    }
    case "peak": {
      const alpha = sin / (2 * q);
      b0 = 1 + alpha * A;
      b1 = -2 * cos;
      b2 = 1 - alpha * A;
      a0 = 1 + alpha / A;
      a1 = -2 * cos;
      a2 = 1 - alpha / A;
      break;
    }
    case "lowshelf":
    case "highshelf": {
      // A slope S of 1: alpha = sin/2 · √((A + 1/A)(1/S − 1) + 2).
      const alpha = (sin / 2) * Math.SQRT2;
      const root = 2 * Math.sqrt(A) * alpha;
      const sign = kind === "lowshelf" ? 1 : -1;
      b0 = A * (A + 1 - sign * (A - 1) * cos + root);
      b1 = sign * 2 * A * (A - 1 - sign * (A + 1) * cos);
      b2 = A * (A + 1 - sign * (A - 1) * cos - root);
      a0 = A + 1 + sign * (A - 1) * cos + root;
      a1 = -sign * 2 * (A - 1 + sign * (A + 1) * cos);
      a2 = A + 1 + sign * (A - 1) * cos - root;
      break;
    }
  }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

/** The gain of a biquad at a frequency, in dB. */
export function responseDb(filter: Biquad, frequency: number, rate = MIX_RATE): number {
  const w = (2 * Math.PI * frequency) / rate;
  const re = (z: number, c0: number, c1: number, c2: number) =>
    c0 + c1 * Math.cos(z) + c2 * Math.cos(2 * z);
  const im = (z: number, c1: number, c2: number) => -(c1 * Math.sin(z) + c2 * Math.sin(2 * z));
  const numRe = re(w, filter.b0, filter.b1, filter.b2);
  const numIm = im(w, filter.b1, filter.b2);
  const denRe = re(w, 1, filter.a1, filter.a2);
  const denIm = im(w, filter.a1, filter.a2);
  return 10 * Math.log10((numRe ** 2 + numIm ** 2) / (denRe ** 2 + denIm ** 2));
}

/**
 * How many samples a biquad remembers: until what it holds is below 2⁻²⁴ of the largest it could
 * ring up to, by the radius of its poles and how close to 0 Hz they are (the closer, the more a low
 * resonance rings).
 */
export function biquadMemory({ a1, a2 }: Biquad): number {
  const discriminant = a1 * a1 - 4 * a2;
  let radius: number;
  let spread: number;
  if (discriminant < 0) {
    radius = Math.sqrt(a2);
    spread = Math.sqrt(-discriminant) / (2 * radius);
  } else {
    const root = Math.sqrt(discriminant);
    radius = Math.max(Math.abs((-a1 + root) / 2), Math.abs((-a1 - root) / 2));
    spread = 1 - radius;
  }
  if (radius <= 0) return 2;
  if (radius >= 1) return Number.POSITIVE_INFINITY;
  const ring = Math.min(1, Math.max(spread, 1e-9));
  return Math.ceil(Math.log(2 ** -24 * ring) / Math.log(radius)) + 2;
}

interface Band {
  readonly kind: BandKind;
  /** Its parameters, by the name of the band. */
  readonly name: string;
  /** For the passes: how many biquads, from `<name>.slope`. */
  stages: number;
  readonly filter: Biquad;
  /** Two numbers of memory for each biquad and channel. */
  state: Float64Array;
}

const BANDS: readonly { name: string; kind: BandKind }[] = [
  { name: "hp", kind: "highpass" },
  { name: "low", kind: "lowshelf" },
  { name: "mid1", kind: "peak" },
  { name: "mid2", kind: "peak" },
  { name: "mid3", kind: "peak" },
  { name: "high", kind: "highshelf" },
  { name: "lp", kind: "lowpass" },
];

const isPass = (kind: BandKind) => kind === "highpass" || kind === "lowpass";

/** Whether a band works at all in an effect, which stays so while it plays. */
function works(effect: MixEffect, name: string, kind: BandKind, param: (name: string) => number) {
  if (isPass(kind)) return param(`${name}.on`) !== 0;
  return effectParamMoves(effect, `${name}.gain`) || param(`${name}.gain`) !== 0;
}

const stagesOf = (slope: number) => (slope >= 24 ? 2 : 1);

export class Equalizer implements Processor {
  readonly latency = 0;
  readonly #channels: number;
  #effect: MixEffect;
  #bands: Band[] = [];

  constructor(channels: number, effect: MixEffect) {
    this.#channels = channels;
    this.#effect = effect;
  }

  /** The same effect with other values or keys: the bands that still work keep their memory. */
  adopt(effect: MixEffect): void {
    this.#effect = effect;
  }

  configure(param: (name: string) => number): void {
    const bands: Band[] = [];
    for (const { name, kind } of BANDS) {
      if (!works(this.#effect, name, kind, param)) continue;
      const kept = this.#bands.find((band) => band.name === name);
      const stages = isPass(kind) ? stagesOf(param(`${name}.slope`)) : 1;
      const band: Band = kept ?? {
        kind,
        name,
        stages,
        filter: { b0: 1, b1: 0, b2: 0, a1: 0, a2: 0 },
        state: new Float64Array(2 * stages * this.#channels),
      };
      if (band.stages !== stages) {
        band.stages = stages;
        band.state = new Float64Array(2 * stages * this.#channels);
      }
      const q = isPass(kind) ? BUTTERWORTH_Q : kind === "peak" ? param(`${name}.q`) : 1;
      const gain = isPass(kind) ? 0 : param(`${name}.gain`);
      Object.assign(band.filter, cookbook(kind, param(`${name}.freq`), gain, q));
      bands.push(band);
    }
    this.#bands = bands;
  }

  process(channels: readonly Float64Array[], at: number, count: number): void {
    const end = at + count;
    for (const band of this.#bands) {
      const { b0, b1, b2, a1, a2 } = band.filter;
      const state = band.state;
      for (let stage = 0; stage < band.stages; stage += 1) {
        for (let channel = 0; channel < this.#channels; channel += 1) {
          const samples = channels[channel] as Float64Array;
          const at1 = (stage * this.#channels + channel) * 2;
          let s1 = state[at1] as number;
          let s2 = state[at1 + 1] as number;
          for (let index = at; index < end; index += 1) {
            const x = samples[index] as number;
            const y = b0 * x + s1;
            s1 = b1 * x - a1 * y + s2;
            s2 = b2 * x - a2 * y;
            samples[index] = y;
          }
          state[at1] = s1;
          state[at1 + 1] = s2;
        }
      }
    }
  }

  reset(): void {
    for (const band of this.#bands) band.state.fill(0);
  }

  settle(): boolean {
    for (const band of this.#bands) {
      for (const value of band.state) if (Math.abs(value) > QUIET) return false;
    }
    for (const band of this.#bands) band.state.fill(0);
    return true;
  }
}

/**
 * The memory of an equalizer, in samples: the sum of its biquads', at the values its parameters
 * have, or the worst of their range for those with keys.
 */
export function equalizerMemory(effect: MixEffect, param: (name: string) => number): number {
  let total = 0;
  for (const { name, kind } of BANDS) {
    if (!works(effect, name, kind, param)) continue;
    let worst = 0;
    const qs = kind === "peak" ? valuesOf(effect, `${name}.q`) : [1];
    const gains = isPass(kind) ? [0] : valuesOf(effect, `${name}.gain`);
    for (const frequency of valuesOf(effect, `${name}.freq`)) {
      for (const q of qs) {
        for (const gain of gains) {
          const filter = cookbook(kind, frequency, gain, isPass(kind) ? BUTTERWORTH_Q : q);
          worst = Math.max(worst, biquadMemory(filter));
        }
      }
    }
    total += worst * (isPass(kind) ? stagesOf(param(`${name}.slope`)) : 1);
  }
  return total;
}
