import { describe, expect, it } from "vitest";
import { MIX_RATE } from "../resample.ts";
import { EffectChain } from "./chain.ts";
import { effectOf, noise, seeded } from "./test-support.ts";

/**
 * The cookbook, written out here once more on its own (Robert Bristow-Johnson, "Cookbook formulae
 * for audio EQ biquad filter coefficients"), so that a mistake in the equalizer's own copy shows.
 */
function rbj(kind: string, f0: number, gainDb: number, q: number) {
  const A = Math.pow(10, gainDb / 40);
  const w0 = (2 * Math.PI * f0) / MIX_RATE;
  const c = Math.cos(w0);
  const sn = Math.sin(w0);
  const alpha = sn / (2 * q);
  const shelf = (sn / 2) * Math.sqrt((A + 1 / A) * (1 / 1 - 1) + 2);
  const r = 2 * Math.sqrt(A) * shelf;
  switch (kind) {
    case "lpf":
      return [(1 - c) / 2, 1 - c, (1 - c) / 2, 1 + alpha, -2 * c, 1 - alpha];
    case "hpf":
      return [(1 + c) / 2, -(1 + c), (1 + c) / 2, 1 + alpha, -2 * c, 1 - alpha];
    case "peakingEQ":
      return [1 + alpha * A, -2 * c, 1 - alpha * A, 1 + alpha / A, -2 * c, 1 - alpha / A];
    case "lowShelf":
      return [
        A * (A + 1 - (A - 1) * c + r),
        2 * A * (A - 1 - (A + 1) * c),
        A * (A + 1 - (A - 1) * c - r),
        A + 1 + (A - 1) * c + r,
        -2 * (A - 1 + (A + 1) * c),
        A + 1 + (A - 1) * c - r,
      ];
    default:
      return [
        A * (A + 1 + (A - 1) * c + r),
        -2 * A * (A - 1 + (A + 1) * c),
        A * (A + 1 + (A - 1) * c - r),
        A + 1 - (A - 1) * c + r,
        2 * (A - 1 - (A + 1) * c),
        A + 1 - (A - 1) * c - r,
      ];
  }
}

/** |H| of the cookbook's biquad at f, in dB. */
function analytic(kind: string, f0: number, gainDb: number, q: number, f: number) {
  const [b0, b1, b2, a0, a1, a2] = rbj(kind, f0, gainDb, q) as number[];
  const w = (2 * Math.PI * f) / MIX_RATE;
  const part = (x0: number, x1: number, x2: number) => [
    x0 + x1 * Math.cos(w) + x2 * Math.cos(2 * w),
    -(x1 * Math.sin(w) + x2 * Math.sin(2 * w)),
  ];
  const [nr, ni] = part(b0 as number, b1 as number, b2 as number) as [number, number];
  const [dr, di] = part(a0 as number, a1 as number, a2 as number) as [number, number];
  return 10 * Math.log10((nr * nr + ni * ni) / (dr * dr + di * di));
}

/** 20 frequencies from 20 Hz to 20 kHz, evenly on a log scale. */
const FREQUENCIES = Array.from({ length: 20 }, (_, index) => 20 * 1000 ** (index / 19));

/** What the equalizer does to each frequency, measured on its impulse response, in dB. */
function measured(params: Record<string, number>, length = 1 << 17): number[] {
  const chain = new EffectChain([effectOf("eq", params)], 1);
  const impulse = new Float64Array(length);
  impulse[0] = 1;
  // Not rounded to 32 bits on its way, so the response is the filter's: in blocks of all of it.
  const response = Float64Array.from(impulse);
  processExact(chain, response);
  return FREQUENCIES.map((f) => {
    const w = (2 * Math.PI * f) / MIX_RATE;
    let re = 0;
    let im = 0;
    for (let n = 0; n < length; n += 1) {
      const h = response[n] as number;
      if (h === 0) continue;
      re += h * Math.cos(w * n);
      im -= h * Math.sin(w * n);
    }
    return 10 * Math.log10(re * re + im * im);
  });
}

/**
 * Has the chain work on all of a signal, a block at a time as the mix does. Its output is rounded to
 * 32 bits like every step of the mix: 24 bits of the response are far finer than 0.01 dB.
 */
function processExact(chain: EffectChain, signal: Float64Array): void {
  for (let at = 0; at < signal.length; at += 128) {
    const part = signal.subarray(at, at + 128);
    chain.process([part], part.length, at);
  }
}

describe("the equalizer", () => {
  const cases: { name: string; params: Record<string, number>; expect: (f: number) => number }[] = [
    {
      name: "high pass 12 dB",
      params: { "hp.on": 1, "hp.freq": 120 },
      expect: (f) => analytic("hpf", 120, 0, Math.SQRT1_2, f),
    },
    {
      name: "high pass 24 dB",
      params: { "hp.on": 1, "hp.freq": 300, "hp.slope": 24 },
      expect: (f) => 2 * analytic("hpf", 300, 0, Math.SQRT1_2, f),
    },
    {
      name: "low shelf",
      params: { "low.freq": 150, "low.gain": 9 },
      expect: (f) => analytic("lowShelf", 150, 9, 1, f),
    },
    {
      name: "a peak",
      params: { "mid2.freq": 1000, "mid2.gain": -12, "mid2.q": 2.5 },
      expect: (f) => analytic("peakingEQ", 1000, -12, 2.5, f),
    },
    {
      name: "a narrow peak",
      params: { "mid1.freq": 400, "mid1.gain": 18, "mid1.q": 8 },
      expect: (f) => analytic("peakingEQ", 400, 18, 8, f),
    },
    {
      name: "high shelf",
      params: { "high.freq": 6000, "high.gain": -7 },
      expect: (f) => analytic("highShelf", 6000, -7, 1, f),
    },
    {
      name: "low pass 12 dB",
      params: { "lp.on": 1, "lp.freq": 5000 },
      expect: (f) => analytic("lpf", 5000, 0, Math.SQRT1_2, f),
    },
    {
      name: "low pass 24 dB",
      params: { "lp.on": 1, "lp.freq": 9000, "lp.slope": 24 },
      expect: (f) => 2 * analytic("lpf", 9000, 0, Math.SQRT1_2, f),
    },
    {
      name: "all bands at once",
      params: {
        "hp.on": 1,
        "hp.freq": 40,
        "low.gain": 3,
        "mid1.gain": -4,
        "mid2.gain": 5,
        "mid2.q": 0.7,
        "mid3.gain": 2,
        "mid3.q": 3,
        "high.gain": -3,
      },
      expect: (f) =>
        analytic("hpf", 40, 0, Math.SQRT1_2, f) +
        analytic("lowShelf", 100, 3, 1, f) +
        analytic("peakingEQ", 250, -4, 1, f) +
        analytic("peakingEQ", 1000, 5, 0.7, f) +
        analytic("peakingEQ", 4000, 2, 3, f) +
        analytic("highShelf", 8000, -3, 1, f),
    },
  ];

  for (const { name, params, expect: expected } of cases) {
    it(`answers as the cookbook has it, within 0.01 dB at 20 frequencies: ${name}`, () => {
      const response = measured(params);
      FREQUENCIES.forEach((f, index) => {
        const want = expected(f);
        // Far down a pass the numbers are tiny; what matters is where sound is.
        if (want < -60) return;
        expect(Math.abs((response[index] as number) - want), `${f.toFixed(1)} Hz`).toBeLessThan(
          0.01,
        );
      });
    });
  }

  it("leaves every sample as it is with its defaults", () => {
    const random = seeded(7);
    const left = noise(48_000, 1.5, random).map(Math.fround);
    const right = noise(48_000, 1.5, random).map(Math.fround);
    const chain = new EffectChain([effectOf("eq")], 2);
    const outLeft = Float64Array.from(left);
    const outRight = Float64Array.from(right);
    for (let at = 0; at < left.length; at += 128) {
      chain.process([outLeft.subarray(at, at + 128), outRight.subarray(at, at + 128)], 128, at);
    }
    expect(outLeft).toEqual(left);
    expect(outRight).toEqual(right);
  });
});
