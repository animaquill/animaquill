import { describe, expect, it } from "vitest";
import { MixEngine } from "./engine.ts";
import { MIX_RATE, interpolate, kernelFor } from "./resample.ts";
import { chunksOf, planOf, sound, storeOf } from "./test-support.ts";

/**
 * How far a sine resampled to the rate of the mix is from the same sine worked out at that rate:
 * the root mean square of the difference, in dB of its amplitude, away from the ends.
 */
function errorOf(rate: number, frequency: number): number {
  const kernel = kernelFor(rate);
  const input = Float64Array.from({ length: rate }, (_, index) =>
    Math.sin((2 * Math.PI * frequency * index) / rate),
  );
  let squares = 0;
  let count = 0;
  for (let sample = 2000; sample < MIX_RATE - 2000; sample += 1) {
    const got = interpolate(kernel, input, 0, (sample * rate) / MIX_RATE);
    const wanted = Math.sin((2 * Math.PI * frequency * sample) / MIX_RATE);
    squares += (got - wanted) ** 2;
    count += 1;
  }
  return 10 * Math.log10(squares / count);
}

describe("resampling to the rate of the mix", () => {
  // The pass band: up to 15 kHz from 44.1 and 96 kHz, up to 8 kHz from 22.05 kHz.
  for (const [rate, frequencies] of [
    [44_100, [100, 1000, 5000, 10_000, 15_000]],
    [22_050, [100, 1000, 5000, 8000]],
    [96_000, [100, 1000, 5000, 10_000, 15_000]],
  ] as const) {
    it(`keeps a sine from ${rate / 1000} kHz within -90 dB of itself`, () => {
      for (const frequency of frequencies) {
        expect(errorOf(rate, frequency), `${frequency} Hz`).toBeLessThan(-90);
      }
    });
  }

  it("takes out what lies above half the rate of the mix, from a faster file", () => {
    // 30 kHz from 96 kHz would fold back to 18 kHz at 48 kHz.
    const kernel = kernelFor(96_000);
    const input = Float64Array.from({ length: 96_000 }, (_, index) =>
      Math.sin((2 * Math.PI * 30_000 * index) / 96_000),
    );
    let peak = 0;
    for (let sample = 2000; sample < 46_000; sample += 1) {
      const at = (sample * 96_000) / MIX_RATE;
      peak = Math.max(peak, Math.abs(interpolate(kernel, input, 0, at)));
    }
    expect(20 * Math.log10(peak)).toBeLessThan(-80);
  });

  it("lets sound at the rate of the mix through as it is", () => {
    const store = storeOf(chunksOf({ frames: MIX_RATE, size: 777 }));
    const engine = new MixEngine(planOf([sound({ offset: 0.25, end: 0.5 })]), () => store);
    const left = new Float32Array(MIX_RATE / 2);
    const right = new Float32Array(MIX_RATE / 2);
    engine.render(0, MIX_RATE / 2, left, right);
    const [file] = chunksOf({ frames: MIX_RATE, size: MIX_RATE });
    expect(left).toEqual(file?.channels[0]?.subarray(12_000, 36_000));
    expect(right).toEqual(file?.channels[1]?.subarray(12_000, 36_000));
  });

  it("puts each sample of a slower file where its time is", () => {
    // A ramp is exact through any interpolation that keeps a straight line straight.
    const ramp = (frame: number) => frame / 100_000;
    const store = storeOf(chunksOf({ frames: 44_100, rate: 44_100, value: ramp }));
    const engine = new MixEngine(planOf([sound({ offset: 0.1, end: 0.5 })]), () => store);
    const left = new Float32Array(100);
    engine.render(10_000, 100, left, new Float32Array(100));
    for (let index = 0; index < 100; index += 1) {
      const frame = ((10_000 + index) / MIX_RATE + 0.1) * 44_100;
      expect(left[index]).toBeCloseTo(ramp(frame), 4);
    }
  });
});
