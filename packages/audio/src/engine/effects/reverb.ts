import type { MixEffect } from "@animaquill/core/mix-plan";
import { MIX_RATE } from "../resample.ts";
import { QUIET, valuesOf, type Processor } from "./processor.ts";

/**
 * The reverb (`reverb`): a feedback delay network of eight lines, as the project format writes it
 * down, sample by sample:
 *
 * 1. In: the mean of the sides (the one side of a mono sound), delayed by the predelay
 *    (round(predelay·48) samples), through four allpass filters one after the other
 *    (`DIFFUSERS` samples, gain `DIFFUSION`), times the input gain k.
 * 2. Each line i is `round(LINES[i]·(0.25 + 1.5·size))` samples long. What comes out of it, v_i, goes
 *    through a one-pole low pass (d_i += (v_i − d_i)·(1 − a), a = e^(−2π·damping/48000)), times
 *    g_i = 10^(−3·length_i/(decay·48000)) so that it is 60 dB down after `decay` seconds; the
 *    eight of them through the Hadamard matrix of order 8 divided by √8; each line takes in its
 *    share and the input.
 * 3. The wet sides: (Σ L_i·v_i)/√8 and (Σ R_i·v_i)/√8 with two rows of that
 *    matrix, then width w: left·(1 + w)/2 + right·(1 − w)/2 and the other way round; a mono sound
 *    gets the mean of the two.
 * 4. Out: dry + mix·(wet − dry).
 *
 * k = ½·√(1 − mean g_i²) keeps what comes out about 6 dB under what goes in, whatever the decay.
 */

/** The lengths of the lines at size ½, in samples: primes, so that their echoes do not line up. */
export const LINES = [1423, 1597, 1789, 1993, 2179, 2357, 2551, 2749] as const;
/** The allpass filters that blur what comes in, in samples. */
export const DIFFUSERS = [142, 107, 379, 277] as const;
export const DIFFUSION = 0.7;
/**
 * The rows of the Hadamard matrix that the two sides take: [1, −1, 1, −1, 1, −1, 1, −1] and
 * [1, 1, −1, −1, 1, 1, −1, −1] (written out in `process`).
 */
const SCALE = 1 / Math.sqrt(8);
const MOST_PREDELAY = 200;

export const lengthOf = (line: number, size: number): number =>
  Math.round(line * (0.25 + 1.5 * size));

const longest = (line: number) => lengthOf(line, 1);

export class Reverb implements Processor {
  readonly latency = 0;
  readonly #channels: number;
  #effect: MixEffect;
  #mix = 0;
  #width = 1;
  #predelay = 0;
  #damping = 0;
  #inputGain = 0;
  readonly #lengths = new Int32Array(8);
  readonly #gains = new Float64Array(8);
  readonly #lines: Float64Array[] = LINES.map((line) => new Float64Array(longest(line)));
  readonly #lineAt = new Int32Array(8);
  readonly #damped = new Float64Array(8);
  readonly #pre = new Float64Array(Math.round(MOST_PREDELAY * 48) + 1);
  #preAt = 0;
  readonly #diffusers: Float64Array[] = DIFFUSERS.map((length) => new Float64Array(length));
  readonly #diffuserAt = new Int32Array(DIFFUSERS.length);
  readonly #scratch = new Float64Array(8);
  /** Samples in a row that put nothing louder than `QUIET` anywhere into it. */
  #quietFor = 0;
  /** After this many such samples all it holds is that quiet. */
  readonly #holds =
    this.#pre.length +
    DIFFUSERS.reduce((sum, length) => sum + length, 0) +
    Math.max(...LINES.map(longest));
  readonly #out = new Float64Array(8);

  constructor(channels: number, effect: MixEffect) {
    this.#channels = channels;
    this.#effect = effect;
  }

  adopt(effect: MixEffect): void {
    this.#effect = effect;
  }

  configure(param: (name: string) => number): void {
    this.#mix = param("mix");
    this.#width = param("width");
    this.#predelay = Math.round(param("predelay") * 48);
    this.#damping = Math.exp((-2 * Math.PI * param("damping")) / MIX_RATE);
    const decay = param("decay");
    const size = param("size");
    let squares = 0;
    LINES.forEach((line, index) => {
      const length = lengthOf(line, size);
      this.#lengths[index] = length;
      const gain = 10 ** ((-3 * length) / (decay * MIX_RATE));
      this.#gains[index] = gain;
      squares += gain * gain;
    });
    this.#inputGain = 0.5 * Math.sqrt(1 - squares / 8);
  }

  /** Whether it does anything at all: with `mix` at 0 and no keys on it, it does not. */
  get #idle(): boolean {
    return this.#mix === 0 && this.#effect.params["mix"]?.kind !== "curve";
  }

  process(channels: readonly Float64Array[], at: number, count: number): void {
    if (this.#idle) return;
    const left = channels[0] as Float64Array;
    const right = this.#channels > 1 ? (channels[1] as Float64Array) : undefined;
    const mix = this.#mix;
    const near = (1 + this.#width) / 2;
    const far = (1 - this.#width) / 2;
    const rise = 1 - this.#damping;
    const k = this.#inputGain;
    const pre = this.#pre;
    const preLength = pre.length;
    const lines = this.#lines;
    const lengths = this.#lengths;
    const gains = this.#gains;
    const damped = this.#damped;
    const lineAt = this.#lineAt;
    const s = this.#scratch;
    const out = this.#out;
    const diffusers = this.#diffusers;
    const diffuserAt = this.#diffuserAt;
    let preAt = this.#preAt;
    let quietFor = this.#quietFor;
    const end = at + count;
    for (let index = at; index < end; index += 1) {
      const l = left[index] as number;
      const r = right ? (right[index] as number) : l;
      // 1: predelay, diffusion.
      const into = right ? (l + r) / 2 : l;
      pre[preAt] = into;
      let back = preAt - this.#predelay;
      if (back < 0) back += preLength;
      let x = pre[back] as number;
      preAt += 1;
      if (preAt === preLength) preAt = 0;
      for (let stage = 0; stage < 4; stage += 1) {
        const buffer = diffusers[stage] as Float64Array;
        const where = diffuserAt[stage] as number;
        const delayed = buffer[where] as number;
        const fed = x + DIFFUSION * delayed;
        buffer[where] = fed;
        diffuserAt[stage] = where + 1 === buffer.length ? 0 : where + 1;
        x = delayed - DIFFUSION * fed;
      }
      const input = x * k;
      let loud = into > QUIET || into < -QUIET || x > QUIET || x < -QUIET;
      // 2: the lines.
      for (let line = 0; line < 8; line += 1) {
        const buffer = lines[line] as Float64Array;
        let read = (lineAt[line] as number) - (lengths[line] as number);
        if (read < 0) read += buffer.length;
        const v = buffer[read] as number;
        out[line] = v;
        const was = damped[line] as number;
        const smooth = was + (v - was) * rise;
        damped[line] = smooth;
        s[line] = smooth * (gains[line] as number);
      }
      // The Hadamard matrix of order 8, by butterflies.
      const a0 = (s[0] as number) + (s[1] as number);
      const a1 = (s[0] as number) - (s[1] as number);
      const a2 = (s[2] as number) + (s[3] as number);
      const a3 = (s[2] as number) - (s[3] as number);
      const a4 = (s[4] as number) + (s[5] as number);
      const a5 = (s[4] as number) - (s[5] as number);
      const a6 = (s[6] as number) + (s[7] as number);
      const a7 = (s[6] as number) - (s[7] as number);
      const b0 = a0 + a2;
      const b1 = a1 + a3;
      const b2 = a0 - a2;
      const b3 = a1 - a3;
      const b4 = a4 + a6;
      const b5 = a5 + a7;
      const b6 = a4 - a6;
      const b7 = a5 - a7;
      s[0] = b0 + b4;
      s[1] = b1 + b5;
      s[2] = b2 + b6;
      s[3] = b3 + b7;
      s[4] = b0 - b4;
      s[5] = b1 - b5;
      s[6] = b2 - b6;
      s[7] = b3 - b7;
      for (let line = 0; line < 8; line += 1) {
        const buffer = lines[line] as Float64Array;
        const where = lineAt[line] as number;
        const written = (s[line] as number) * SCALE + input;
        buffer[where] = written;
        lineAt[line] = where + 1 === buffer.length ? 0 : where + 1;
        if (written > QUIET || written < -QUIET) loud = true;
      }
      quietFor = loud ? 0 : quietFor + 1;
      // 3: the sides.
      const o0 = out[0] as number;
      const o1 = out[1] as number;
      const o2 = out[2] as number;
      const o3 = out[3] as number;
      const o4 = out[4] as number;
      const o5 = out[5] as number;
      const o6 = out[6] as number;
      const o7 = out[7] as number;
      const wetLeft = (o0 - o1 + o2 - o3 + o4 - o5 + o6 - o7) * SCALE;
      const wetRight = (o0 + o1 - o2 - o3 + o4 + o5 - o6 - o7) * SCALE;
      // 4: dry and wet.
      if (right) {
        const sideLeft = wetLeft * near + wetRight * far;
        const sideRight = wetRight * near + wetLeft * far;
        left[index] = l + mix * (sideLeft - l);
        right[index] = r + mix * (sideRight - r);
      } else {
        left[index] = l + mix * ((wetLeft + wetRight) / 2 - l);
      }
    }
    this.#preAt = preAt;
    this.#quietFor = quietFor;
  }

  reset(): void {
    this.#quietFor = 0;
    for (const line of this.#lines) line.fill(0);
    for (const buffer of this.#diffusers) buffer.fill(0);
    this.#pre.fill(0);
    this.#damped.fill(0);
  }

  settle(): boolean {
    if (this.#idle) return true;
    if (this.#quietFor < this.#holds) return false;
    this.reset();
    return true;
  }
}

/**
 * The memory of a reverb, in samples: until its tail is 2⁻²⁰ (120 dB) under where it started, and
 * what the predelay, the diffusion and the longest line hold before that.
 */
export function reverbMemory(effect: MixEffect): number {
  const decay = Math.max(...valuesOf(effect, "decay"));
  const predelay = Math.max(...valuesOf(effect, "predelay"));
  const size = Math.max(...valuesOf(effect, "size"));
  const lines = Math.max(...LINES.map((line) => lengthOf(line, size)));
  // An allpass rings on by its gain every time round.
  const turns = Math.log(2 ** -20) / Math.log(DIFFUSION);
  const diffusion = DIFFUSERS.reduce((sum, length) => sum + length * turns, 0);
  return Math.ceil(predelay * 48 + diffusion + lines + 2 * decay * MIX_RATE);
}
