import { describe, expect, it } from "vitest";
import { MIX_RATE } from "../resample.ts";
import { EffectChain } from "./chain.ts";
import { db, effectOf, noise, seeded } from "./test-support.ts";

/** Runs a reverb over two channels, a block at a time. */
function run(params: Record<string, number>, left: Float64Array, right: Float64Array) {
  const chain = new EffectChain([effectOf("reverb", params)], 2);
  for (let at = 0; at < left.length; at += 128) {
    const end = Math.min(at + 128, left.length);
    chain.process([left.subarray(at, end), right.subarray(at, end)], end - at, at);
  }
}

/**
 * The low part of a signal, under about 800 Hz (two cookbook low passes): where the damping does not
 * take anything away, so that the decay is all that sets how fast it goes.
 */
function low(signal: Float64Array): Float64Array {
  const w0 = (2 * Math.PI * 800) / MIX_RATE;
  const alpha = Math.sin(w0) / (2 * Math.SQRT1_2);
  const c = Math.cos(w0);
  const a0 = 1 + alpha;
  const [b0, b1, b2, a1, a2] = [
    (1 - c) / 2 / a0,
    (1 - c) / a0,
    (1 - c) / 2 / a0,
    (-2 * c) / a0,
    (1 - alpha) / a0,
  ];
  let out = Float64Array.from(signal);
  for (let pass = 0; pass < 2; pass += 1) {
    const next = new Float64Array(out.length);
    let s1 = 0;
    let s2 = 0;
    for (let index = 0; index < out.length; index += 1) {
      const x = out[index] as number;
      const y = b0 * x + s1;
      s1 = b1 * x - a1 * y + s2;
      s2 = b2 * x - a2 * y;
      next[index] = y;
    }
    out = next;
  }
  return out;
}

/**
 * RT60 of an impulse response by Schroeder's backward integration: the time from −5 to −35 dB of
 * the energy left, twice over (T30).
 */
function rt60(response: Float64Array): number {
  const energy = new Float64Array(response.length);
  let sum = 0;
  for (let index = response.length - 1; index >= 0; index -= 1) {
    sum += (response[index] as number) ** 2;
    energy[index] = sum;
  }
  const total = energy[0] as number;
  const level = (index: number) => 10 * Math.log10((energy[index] as number) / total);
  const at5 = energy.findIndex((_, index) => level(index) <= -5);
  const at35 = energy.findIndex((_, index) => level(index) <= -35);
  return ((at35 - at5) / MIX_RATE) * 2;
}

describe("the reverb", () => {
  it("leaves every sample as it is with no mix", () => {
    const random = seeded(11);
    const left = noise(MIX_RATE, 1, random).map(Math.fround);
    const right = noise(MIX_RATE, 1, random).map(Math.fround);
    const outLeft = Float64Array.from(left);
    const outRight = Float64Array.from(right);
    run({ decay: 4, size: 0.9, mix: 0 }, outLeft, outRight);
    expect(outLeft).toEqual(left);
    expect(outRight).toEqual(right);
  });

  for (const decay of [0.5, 1.5, 4, 9]) {
    for (const size of [0.1, 0.5, 1]) {
      it(
        `dies away 60 dB in its decay, within 10%: ${decay} s at size ${size}`,
        { timeout: 60_000 },
        () => {
          const length = Math.ceil(MIX_RATE * (decay * 1.5 + 0.5));
          const left = new Float64Array(length);
          const right = new Float64Array(length);
          left[0] = 1;
          right[0] = 1;
          run({ decay, size, predelay: 0, damping: 8000, mix: 1 }, left, right);
          const measured = rt60(
            low(Float64Array.from(left, (value, index) => value + (right[index] as number))),
          );
          expect(Math.abs(measured - decay) / decay).toBeLessThan(0.1);
        },
      );
    }
  }

  it("has sides that have little to do with each other at full width", { timeout: 120_000 }, () => {
    const random = seeded(2);
    const signal = noise(MIX_RATE * 4, 0.5, random).map(Math.fround);
    const left = Float64Array.from(signal);
    const right = Float64Array.from(signal);
    run({ decay: 2, mix: 1, width: 1 }, left, right);
    let lr = 0;
    let ll = 0;
    let rr = 0;
    for (let index = MIX_RATE; index < left.length; index += 1) {
      const l = left[index] as number;
      const r = right[index] as number;
      lr += l * r;
      ll += l * l;
      rr += r * r;
    }
    expect(Math.abs(lr / Math.sqrt(ll * rr))).toBeLessThan(0.1);
  });

  it(
    "never runs away: a minute of loud white noise stays under +6 dBFS",
    { timeout: 120_000 },
    () => {
      const random = seeded(9);
      const chain = new EffectChain(
        [
          effectOf("reverb", {
            decay: 10,
            size: 1,
            mix: 1,
            width: 1,
            damping: 20_000,
            predelay: 0,
          }),
        ],
        2,
      );
      const left = new Float64Array(128);
      const right = new Float64Array(128);
      let peak = 0;
      for (let at = 0; at < MIX_RATE * 60; at += 128) {
        for (let index = 0; index < 128; index += 1) {
          left[index] = Math.fround(2 * random() - 1);
          right[index] = Math.fround(2 * random() - 1);
        }
        chain.process([left, right], 128, at);
        for (let index = 0; index < 128; index += 1) {
          peak = Math.max(peak, Math.abs(left[index] as number), Math.abs(right[index] as number));
        }
      }
      expect(db(peak)).toBeLessThan(6);
    },
  );
});
