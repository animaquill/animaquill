import { describe, expect, it } from "vitest";
import { SoundMeter, kWeighting, type Measured } from "./meter.ts";

const RATE = 48_000;

/** A part of a test signal: a sine of a frequency at a level in dBFS (its peak), or silence. */
interface Part {
  readonly seconds: number;
  readonly dbfs?: number;
  readonly hz?: number;
  /** Its phase at its first sample, in radians. */
  readonly phase?: number;
  /** Its level at each moment, 0–1, times its peak. */
  readonly shape?: (seconds: number) => number;
}

function signal(parts: readonly Part[], rate = RATE): Float32Array {
  const length = parts.reduce((sum, part) => sum + Math.round(part.seconds * rate), 0);
  const samples = new Float32Array(length);
  let at = 0;
  for (const part of parts) {
    const count = Math.round(part.seconds * rate);
    const amplitude = part.dbfs === undefined ? 0 : 10 ** (part.dbfs / 20);
    const hz = part.hz ?? 1000;
    for (let index = 0; index < count; index += 1) {
      const t = index / rate;
      const shape = part.shape ? part.shape(t) : 1;
      samples[at + index] = amplitude * shape * Math.sin(2 * Math.PI * hz * t + (part.phase ?? 0));
    }
    at += count;
  }
  return samples;
}

/** Measures the same samples in both channels, in pieces of `piece` samples. */
function measure(samples: Float32Array, envelope = false, piece = 4800, rate = RATE): Measured {
  const meter = new SoundMeter({ rate, channels: 2, seconds: samples.length / rate });
  for (let at = 0; at < samples.length; at += piece) {
    const part = samples.subarray(at, Math.min(samples.length, at + piece));
    meter.push([part, part]);
  }
  return meter.result(envelope);
}

describe("loudness, as EBU Tech 3341 (the test signals of EBU R128) has it", () => {
  // Tech 3341 v4, table 1, case 1 and 2: stereo 1 kHz sine at −23 / −33 dBFS for 20 s reads
  // −23.0 / −33.0 LUFS momentary, short-term and integrated, ±0.1.
  it("reads a 1 kHz sine at −23 dBFS in both channels as −23.0 LUFS", () => {
    const measured = measure(signal([{ seconds: 20, dbfs: -23 }]));
    expect(measured.integrated).toBeCloseTo(-23, 1);
    expect(measured.shortTermMax).toBeCloseTo(-23, 1);
    expect(measured.momentaryMax).toBeCloseTo(-23, 1);
  });

  it("reads a 1 kHz sine at −20 dBFS as −20.0 LUFS, and at −33 dBFS as −33.0", () => {
    expect(measure(signal([{ seconds: 20, dbfs: -20 }])).integrated).toBeCloseTo(-20, 1);
    expect(measure(signal([{ seconds: 20, dbfs: -33 }])).integrated).toBeCloseTo(-33, 1);
  });

  // Case 3 and 4: the relative and the absolute gate leave out what is quiet. The two signals are
  // 180 s of stereo at 48 kHz, as Tech 3341 has them: shorter ones would no longer be its cases.
  // Nothing in it waits or reads the clock, it only takes long to compute: about 4 s alone, more
  // than the default 5 s while the machine runs every other test at once (twice in `pnpm check`).
  it("leaves out what is 10 LU quieter and what is below −70 LUFS", { timeout: 30_000 }, () => {
    const relative = measure(
      signal([
        { seconds: 10, dbfs: -36 },
        { seconds: 60, dbfs: -23 },
        { seconds: 10, dbfs: -36 },
      ]),
    );
    expect(Math.abs((relative.integrated as number) + 23)).toBeLessThanOrEqual(0.1);
    const absolute = measure(
      signal([
        { seconds: 10, dbfs: -72 },
        { seconds: 10, dbfs: -36 },
        { seconds: 60, dbfs: -23 },
        { seconds: 10, dbfs: -36 },
        { seconds: 10, dbfs: -72 },
      ]),
    );
    expect(Math.abs((absolute.integrated as number) + 23)).toBeLessThanOrEqual(0.1);
  });

  it("takes the loudest 3 seconds for the short-term maximum", () => {
    const measured = measure(
      signal([
        { seconds: 5, dbfs: -30 },
        { seconds: 5, dbfs: -20 },
        { seconds: 5, dbfs: -30 },
      ]),
    );
    expect(measured.shortTermMax).toBeCloseTo(-20, 1);
  });

  it("says nothing of loudness for silence or for less than 400 ms", () => {
    const silent = measure(signal([{ seconds: 5 }]));
    expect(silent.integrated).toBeUndefined();
    expect(silent.truePeak).toBe(-Infinity);
    expect(silent.silent).toBe(true);
    expect(measure(signal([{ seconds: 0.3, dbfs: -10 }])).integrated).toBeUndefined();
    expect(measure(signal([{ seconds: 2, dbfs: -10 }])).shortTermMax).toBeUndefined();
  });

  it("has the K-weighting of BS.1770-4 table 1 and 2 at 48 kHz", () => {
    const [shelf, pass] = kWeighting(48_000);
    expect(shelf.b0).toBeCloseTo(1.53512485958697, 8);
    expect(shelf.b1).toBeCloseTo(-2.69169618940638, 8);
    expect(shelf.b2).toBeCloseTo(1.19839281085285, 8);
    expect(shelf.a1).toBeCloseTo(-1.69065929318241, 8);
    expect(shelf.a2).toBeCloseTo(0.73248077421585, 8);
    expect(pass.a1).toBeCloseTo(-1.99004745483398, 8);
    expect(pass.a2).toBeCloseTo(0.99007225036621, 8);
  });

  it("gives the same numbers whatever pieces the samples come in", () => {
    const samples = signal([
      { seconds: 3, dbfs: -18, hz: 440 },
      { seconds: 0.5 },
      { seconds: 2, dbfs: -6, hz: 3000 },
    ]);
    const one = measure(samples, true, samples.length);
    const many = measure(samples, true, 1234);
    expect(many).toEqual(one);
  });
});

describe("the true peak, as BS.1770-4 Annex 2 estimates it", () => {
  it("is the peak of a 1 kHz sine, where its samples reach it", () => {
    const measured = measure(signal([{ seconds: 1, dbfs: -6 }]));
    expect(measured.truePeak).toBeCloseTo(-6, 1);
    expect(measured.samplePeak).toBeCloseTo(-6, 1);
  });

  // A sine at a quarter of the sample rate with a phase of 45° has its samples 3 dB below its peak:
  // the classic case of a peak between samples (EBU Tech 3341 allows +0.2 / −0.4 dB for true peaks).
  it("finds the peak between samples of a sine at 12 kHz that no sample reaches", () => {
    const measured = measure(signal([{ seconds: 1, dbfs: -6, hz: 12_000, phase: Math.PI / 4 }]));
    expect(measured.samplePeak).toBeCloseTo(-9.01, 1);
    expect(measured.truePeak).toBeGreaterThan(-6.4);
    expect(measured.truePeak).toBeLessThan(-5.8);
  });
});

describe("clipping", () => {
  it("is not a sine that only touches full scale", () => {
    const measured = measure(signal([{ seconds: 2, dbfs: 0 }]));
    expect(measured.clipping).toEqual({ places: 0, samples: 0 });
  });

  it("says where samples go over full scale, near ones as one place", () => {
    const samples = signal([{ seconds: 4, dbfs: -12 }]);
    // Two places: at 1 s, overs for 10 ms; at 2.5 s, a run held at full scale for 2 ms.
    for (let index = 0; index < 480; index += 1)
      samples[RATE + index] = 1.3 * Math.sign(Math.sin(index));
    for (let index = 0; index < 96; index += 1) samples[2.5 * RATE + index] = 1;
    const measured = measure(samples);
    expect(measured.clipping.places).toBe(2);
    expect(measured.clips[0]?.from).toBeCloseTo(1, 2);
    expect(measured.clips[1]?.from).toBeCloseTo(2.5, 2);
    expect(measured.clips[1]?.samples).toBe(96 * 2);
  });
});

describe("silence", () => {
  it("is below −50 dBFS for 0.3 s or longer, and not a shorter gap", () => {
    const measured = measure(
      signal([
        { seconds: 1, dbfs: -20 },
        { seconds: 0.5 },
        { seconds: 1, dbfs: -20 },
        { seconds: 0.2 },
        { seconds: 1, dbfs: -20 },
        { seconds: 0.6, dbfs: -60 },
      ]),
    );
    expect(measured.silences).toHaveLength(2);
    expect(measured.silences[0]?.from).toBeCloseTo(1, 2);
    expect(measured.silences[0]?.to).toBeCloseTo(1.5, 2);
    expect(measured.silences[1]?.from).toBeCloseTo(3.7, 2);
    expect(measured.silences[1]?.to).toBeCloseTo(4.3, 2);
    expect(measured.silent).toBe(false);
  });
});

describe("the envelope of a sound", () => {
  it("has the attack from 10 % to 90 % of its peak, and the decay to 40 dB below it", () => {
    // 20 ms up in a straight line, then down by e every 150 ms: 40 dB below in 0.15 · ln 100 s.
    const shape = (t: number) => (t < 0.02 ? t / 0.02 : Math.exp(-(t - 0.02) / 0.15));
    const measured = measure(
      signal([{ seconds: 0.1 }, { seconds: 1.5, dbfs: -3, shape }, { seconds: 0.4 }]),
      true,
    );
    const envelope = measured.envelope;
    expect(envelope).toBeDefined();
    expect(envelope?.onset).toBeCloseTo(0.102, 2);
    expect(Math.abs((envelope?.attack ?? 0) - 0.016)).toBeLessThanOrEqual(0.002);
    expect(Math.abs((envelope?.decay ?? 0) - 0.15 * Math.log(100))).toBeLessThanOrEqual(0.01);
    expect(envelope?.peak).toBeCloseTo(-3, 0);
    expect(envelope?.cut).toBe(false);
  });

  it("says when the sound goes on past what was measured", () => {
    const measured = measure(signal([{ seconds: 1, dbfs: -6 }]), true);
    expect(measured.envelope?.cut).toBe(true);
  });
});

describe("the small picture of the level", () => {
  it("has the largest sample of each part", () => {
    const meter = new SoundMeter({ rate: RATE, channels: 1, seconds: 2, buckets: 4 });
    meter.push([signal([{ seconds: 1, dbfs: -6 }, { seconds: 1 }])]);
    const { wave } = meter.result();
    expect(wave).toHaveLength(4);
    expect(wave[0]).toBeCloseTo(0.501, 2);
    expect(wave[3]).toBe(0);
  });
});
