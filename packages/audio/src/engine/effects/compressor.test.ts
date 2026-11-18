import { describe, expect, it } from "vitest";
import { MIX_RATE } from "../resample.ts";
import { EffectChain } from "./chain.ts";
import { db, effectOf, noise, seeded } from "./test-support.ts";

/** Giannoulis, Massberg and Reiss 2012, equation (4), written out here on its own. */
function giannoulis(x: number, T: number, R: number, W: number): number {
  if (2 * (x - T) < -W) return x;
  if (2 * Math.abs(x - T) <= W) return x + ((1 / R - 1) * (x - T + W / 2) ** 2) / (2 * W);
  return T + (x - T) / R;
}

/** Runs a compressor over two channels, a block at a time. */
function run(params: Record<string, number>, left: Float64Array, right: Float64Array) {
  const chain = new EffectChain([effectOf("compressor", params)], 2);
  for (let at = 0; at < left.length; at += 128) {
    const end = Math.min(at + 128, left.length);
    chain.process([left.subarray(at, end), right.subarray(at, end)], end - at, at);
  }
}

/** A signal that stays at one level: ±level every other sample, which a peak sees at every one. */
const steady = (length: number, level: number) =>
  Float64Array.from({ length }, (_, index) => (index % 2 === 0 ? level : -level));

describe("the compressor", () => {
  const settings = [
    { threshold: -20, ratio: 4, knee: 6, makeup: 0 },
    { threshold: -30, ratio: 10, knee: 12, makeup: 6 },
    { threshold: -10, ratio: 2, knee: 0, makeup: 3 },
    { threshold: -40, ratio: 20, knee: 24, makeup: 12 },
  ];

  for (const setting of settings) {
    it(`follows the static curve of Giannoulis (4) within 0.1 dB: ${JSON.stringify(setting)}`, () => {
      for (let level = -60; level <= 0; level += 3) {
        const amplitude = 10 ** (level / 20);
        const left = steady(MIX_RATE / 2, amplitude);
        const right = steady(MIX_RATE / 2, amplitude * 0.5);
        run({ ...setting, attack: 1, release: 20 }, left, right);
        const out = db(Math.abs(left.at(-1) as number));
        const want =
          giannoulis(level, setting.threshold, setting.ratio, setting.knee) + setting.makeup;
        expect(Math.abs(out - want), `${level} dB`).toBeLessThan(0.1);
      }
    });
  }

  it("follows it on a steady sine too, at its peaks, with a fast attack and a slow release", () => {
    const setting = { threshold: -24, ratio: 6, knee: 6, makeup: 0 };
    for (const level of [-30, -24, -18, -6]) {
      const amplitude = 10 ** (level / 20);
      const sine = (index: number) => amplitude * Math.sin((2 * Math.PI * 997 * index) / MIX_RATE);
      const left = Float64Array.from({ length: MIX_RATE * 2 }, (_, index) => sine(index));
      const right = Float64Array.from(left);
      run({ ...setting, attack: 0.1, release: 2000 }, left, right);
      let peak = 0;
      for (let index = left.length - 4800; index < left.length; index += 1) {
        peak = Math.max(peak, Math.abs(left[index] as number));
      }
      const want = giannoulis(level, setting.threshold, setting.ratio, setting.knee);
      expect(Math.abs(db(peak) - want), `${level} dB`).toBeLessThan(0.1);
    }
  });

  it("gets to 63% of a step in its attack time, and back in its release time", () => {
    for (const [attack, release] of [
      [5, 50],
      [30, 400],
      [100, 1000],
    ] as const) {
      const params = { threshold: -30, ratio: 4, knee: 0, attack, release };
      const loud = 10 ** (-6 / 20);
      const quiet = 10 ** (-50 / 20);
      const length = MIX_RATE * 6;
      const half = MIX_RATE * 3;
      const input = Float64Array.from({ length }, (_, index) => (index < half ? loud : quiet));
      const output = Float64Array.from(input);
      run(params, output, Float64Array.from(input));
      const reduction = (index: number) => db(input[index] as number) - db(output[index] as number);
      const most = reduction(half - 1);
      // −6 dB in, 4:1 from −30: 18 dB less.
      expect(most).toBeCloseTo(18, 3);
      const rise = Array.from({ length: half }, (_, index) => reduction(index)).findIndex(
        (value) => value >= most * (1 - Math.exp(-1)),
      );
      expect(Math.abs(rise / MIX_RATE - attack / 1000)).toBeLessThan(
        0.02 * (attack / 1000) + 2 / MIX_RATE,
      );
      const fall = Array.from({ length: half }, (_, index) => reduction(half + index)).findIndex(
        (value) => value <= most * Math.exp(-1),
      );
      expect(Math.abs(fall / MIX_RATE - release / 1000)).toBeLessThan(
        0.02 * (release / 1000) + 2 / MIX_RATE,
      );
    }
  });

  it("leaves every sample as it is at a ratio of 1", () => {
    const random = seeded(3);
    const left = noise(MIX_RATE, 3, random).map(Math.fround);
    const right = noise(MIX_RATE, 3, random).map(Math.fround);
    const outLeft = Float64Array.from(left);
    const outRight = Float64Array.from(right);
    run({ threshold: -40, ratio: 1, knee: 12, attack: 1, release: 50 }, outLeft, outRight);
    expect(outLeft).toEqual(left);
    expect(outRight).toEqual(right);
  });
});
