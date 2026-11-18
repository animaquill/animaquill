import { describe, expect, it } from "vitest";
import { MeterChannel } from "../../meter.ts";
import { MIX_RATE } from "../resample.ts";
import { EffectChain } from "./chain.ts";
import { LOOKAHEAD } from "./limiter.ts";
import { db, effectOf, noise, seedCount, seeded } from "./test-support.ts";

/** Runs a limiter over two channels, a block at a time. */
function run(params: Record<string, number>, left: Float64Array, right: Float64Array) {
  const chain = new EffectChain([effectOf("limiter", params)], 2);
  for (let at = 0; at < left.length; at += 128) {
    const end = Math.min(at + 128, left.length);
    chain.process([left.subarray(at, end), right.subarray(at, end)], end - at, at);
  }
}

/** The true peak of a signal as the meters of AI's listening measure it (BS.1770-4 Annex 2). */
function truePeak(...channels: Float64Array[]): number {
  let peak = 0;
  for (const samples of channels) {
    const meter = new MeterChannel(MIX_RATE);
    for (const sample of samples) meter.step(sample);
    for (let index = 0; index < 12; index += 1) meter.step(0);
    peak = Math.max(peak, meter.truePeak);
    for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
  }
  return peak;
}

/** Music-like noise, louder and softer, with peaks of +12 dBFS here and there. */
function wild(seed: number, length: number): [Float64Array, Float64Array] {
  const random = seeded(seed);
  const level = 0.2 + random() * 1.5;
  const left = noise(length, level, random);
  const right = noise(length, level, random);
  // Sines of high frequencies make peaks between samples.
  const f = 3000 + random() * 15_000;
  for (let index = 0; index < length; index += 1) {
    const swell = 0.5 + 0.5 * Math.sin(index / 7000);
    const tone = Math.sin((2 * Math.PI * f * index) / MIX_RATE);
    left[index] = (left[index] as number) * swell + tone * level;
    right[index] = (right[index] as number) * swell - tone * level;
  }
  for (let count = 0; count < 40; count += 1) {
    const at = Math.floor(random() * (length - 4));
    const sign = random() < 0.5 ? -1 : 1;
    for (let width = 0; width < 1 + Math.floor(random() * 3); width += 1) {
      left[at + width] = sign * 10 ** (12 / 20);
      right[at + width] = -sign * 10 ** ((random() * 12) / 20);
    }
  }
  return [left.map(Math.fround), right.map(Math.fround)];
}

describe("the limiter", () => {
  it(
    "keeps the true peak at or under its ceiling, +12 dBFS peaks and all",
    { timeout: 120_000 },
    () => {
      const count = seedCount(12);
      for (let seed = 1; seed <= count; seed += 1) {
        const random = seeded(seed * 31);
        const ceiling = -12 + random() * 12;
        const release = 10 + random() * 990;
        const [left, right] = wild(seed, MIX_RATE * 2);
        run({ ceiling, release }, left, right);
        const peak = db(truePeak(left, right));
        expect(peak, `seed ${seed}, ceiling ${ceiling}`).toBeLessThanOrEqual(ceiling + 1e-6);
      }
    },
  );

  it("leaves what stays under the ceiling as it is, only 72 samples later", () => {
    const random = seeded(5);
    // Under −1 dBTP all the way: −3 dBFS of slow noise has no peaks between samples above it.
    const left = Float64Array.from({ length: MIX_RATE }, (_, index) =>
      Math.fround(0.5 * Math.sin(index / 50) * (0.5 + 0.5 * random())),
    );
    const right = Float64Array.from(left, (value) => Math.fround(-value * 0.7));
    expect(db(truePeak(left, right))).toBeLessThan(-1);
    const outLeft = Float64Array.from(left);
    const outRight = Float64Array.from(right);
    run({ ceiling: -1, release: 100 }, outLeft, outRight);
    expect(outLeft.subarray(0, LOOKAHEAD).every((value) => value === 0)).toBe(true);
    expect(outLeft.subarray(LOOKAHEAD)).toEqual(left.subarray(0, left.length - LOOKAHEAD));
    expect(outRight.subarray(LOOKAHEAD)).toEqual(right.subarray(0, right.length - LOOKAHEAD));
  });

  it("is 72 samples late, 1.5 ms", () => {
    expect(LOOKAHEAD).toBe(72);
    expect((LOOKAHEAD / MIX_RATE) * 1000).toBe(1.5);
    const left = new Float64Array(1024);
    left[100] = 4;
    const right = new Float64Array(1024);
    run({ ceiling: -6, release: 100 }, left, right);
    let at = 0;
    for (let index = 0; index < left.length; index += 1) {
      if (Math.abs(left[index] as number) > Math.abs(left[at] as number)) at = index;
    }
    expect(at).toBe(100 + LOOKAHEAD);
  });
});
