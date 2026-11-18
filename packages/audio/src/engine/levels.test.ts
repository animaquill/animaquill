import type { MixPlan } from "@animaquill/core";
import { describe, expect, it } from "vitest";
import { SoundMeter } from "../meter.ts";
import { LEVELS_PER_SECOND, MasterLevels, type Levels } from "./levels.ts";
import { MixerCore, type MixerReport } from "./mixer-core.ts";
import { MIX_RATE } from "./resample.ts";
import { MixEngine } from "./engine.ts";
import { chunksOf, planOf, sound, storeOf, track } from "./test-support.ts";

/**
 * The meters of the mixer, measured in the audio thread: the peaks of every track after its fader
 * and pan, and of the master, its true peak and its short-term loudness, read as AI hears them.
 */

/** Pink noise as Paul Kellet's filter makes it, from a fixed seed, at a level of its own. */
function pinkNoise(frames: number, seed: number): Float32Array {
  let state = seed;
  const white = () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 2 ** 31 - 1;
  };
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  let b3 = 0;
  let b4 = 0;
  let b5 = 0;
  let b6 = 0;
  const out = new Float32Array(frames);
  for (let index = 0; index < frames; index += 1) {
    const w = white();
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856;
    b4 = 0.55 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.016898;
    out[index] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
    b6 = w * 0.115926;
  }
  return out;
}

/** Scaled to an RMS of `dbfs`. */
function atLevel(samples: Float32Array, dbfs: number): Float32Array {
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  const gain = 10 ** (dbfs / 20) / Math.sqrt(sum / samples.length);
  return samples.map((sample) => sample * gain);
}

function measured(left: Float32Array, right: Float32Array, rate = MIX_RATE) {
  const levels = new MasterLevels(rate);
  // A quantum at a time, as the audio thread has them.
  for (let at = 0; at < left.length; at += 128) {
    levels.add(left.subarray(at, at + 128), right.subarray(at, at + 128));
  }
  return levels.take();
}

describe("the loudness of the master", () => {
  it("reads as AI hears it, for 3 s of the same sound", () => {
    const frames = 3 * MIX_RATE;
    const left = atLevel(pinkNoise(frames, 1), -23);
    const right = atLevel(pinkNoise(frames, 2), -23);
    const meter = new SoundMeter({ rate: MIX_RATE, channels: 2, seconds: 3 });
    meter.push([left, right]);
    const { shortTermMax } = meter.result();
    expect(measured(left, right).shortTerm).toBeCloseTo(shortTermMax as number, 6);
  });

  it("reads −23 LUFS for a 1 kHz sine at −23 dBFS on both sides, as EBU Tech 3341 has it", () => {
    const peak = 10 ** (-23 / 20);
    const sine = Float32Array.from(
      { length: 3 * MIX_RATE },
      (_, index) => peak * Math.sin((2 * Math.PI * 1000 * index) / MIX_RATE),
    );
    expect(measured(sine, sine).shortTerm).toBeCloseTo(-23, 1);
  });

  it("goes by the last 3 s, and by what played when that is less", () => {
    const quiet = atLevel(pinkNoise(5 * MIX_RATE, 3), -40);
    const loud = atLevel(pinkNoise(MIX_RATE, 4), -20);
    const levels = new MasterLevels(MIX_RATE);
    levels.add(loud, loud);
    const first = levels.take().shortTerm as number;
    levels.add(quiet, quiet);
    const later = levels.take().shortTerm as number;
    expect(first).toBeGreaterThan(-20);
    // Only the quiet part is in the last 3 s.
    expect(later).toBeLessThan(-35);
  });

  it("says nothing before 100 ms played, and −∞ for silence", () => {
    const levels = new MasterLevels(MIX_RATE);
    levels.add(new Float32Array(1000), new Float32Array(1000));
    expect(levels.take().shortTerm).toBeUndefined();
    levels.add(new Float32Array(MIX_RATE), new Float32Array(MIX_RATE));
    expect(levels.take().shortTerm).toBe(Number.NEGATIVE_INFINITY);
  });
});

describe("the peaks of the master", () => {
  it("are those of each side since the last time, and the true peak is above the samples", () => {
    // A sine at a quarter of the rate, between the samples: its true peak is 3 dB above them.
    const left = Float32Array.from(
      { length: 4800 },
      (_, index) => 0.5 * Math.sin((Math.PI / 2) * index + Math.PI / 4),
    );
    const right = left.map((sample) => sample / 2);
    const taken = measured(left, right);
    expect(taken.left).toBeCloseTo(0.5 * Math.SQRT1_2, 6);
    expect(taken.right).toBeCloseTo(0.25 * Math.SQRT1_2, 6);
    expect(20 * Math.log10(taken.truePeak)).toBeCloseTo(20 * Math.log10(0.5), 0);
  });
});

describe("the levels the audio thread sends", () => {
  const plan: MixPlan = planOf(
    [sound({ id: "a", track: "t", end: 3 }), sound({ id: "b", file: "g", track: "u", end: 3 })],
    [track({ id: "t", gain: 0.5 }), track({ id: "u", gain: 1, muted: true })],
  );

  function play(seconds: number, mixPlan = plan) {
    const reports: MixerReport[] = [];
    const core = new MixerCore((report) => reports.push(report), MIX_RATE);
    core.receive({ kind: "play", run: 1, plan: mixPlan, frame: 0, sample: 0, rate: 1 });
    // A file whose every sample is 0.8.
    const chunks = chunksOf({ frames: 3 * MIX_RATE, value: () => 0.8 });
    for (const id of ["a", "b"]) {
      core.receive({ kind: "open", run: 1, id });
      for (const chunk of chunks) core.receive({ kind: "chunk", run: 1, id, ...chunk, since: 0 });
    }
    const left = new Float32Array(128);
    const right = new Float32Array(128);
    for (let frame = 0; frame < seconds * MIX_RATE; frame += 128) {
      core.process(frame, left, right);
    }
    return reports.filter((report): report is Levels & { kind: "levels" } => {
      return report.kind === "levels";
    });
  }

  it("come 30 times a second", () => {
    const levels = play(2);
    expect(levels.length).toBeGreaterThanOrEqual(2 * LEVELS_PER_SECOND - 1);
    expect(levels.length).toBeLessThanOrEqual(2 * LEVELS_PER_SECOND);
  });

  it("have each track after its fader, and nothing of a track that is muted", () => {
    const [first] = play(0.1);
    expect(first?.tracks).toEqual(["t", "u"]);
    expect(first?.peaks[0]).toBeCloseTo(0.4, 6);
    expect(first?.peaks[1]).toBe(0);
    expect(first?.left).toBeCloseTo(0.4, 6);
    expect(first?.right).toBeCloseTo(0.4, 6);
  });

  it("change no sample of the mix", () => {
    const stores = {
      f: storeOf(chunksOf({ frames: MIX_RATE })),
      g: storeOf(chunksOf({ frames: MIX_RATE })),
    };
    const mix = (metering: boolean) => {
      const engine = new MixEngine(plan, (one) => stores[one.file as "f" | "g"]);
      engine.metering = metering;
      const left = new Float32Array(MIX_RATE / 2);
      const right = new Float32Array(MIX_RATE / 2);
      engine.render(77, left.length, left, right);
      return [left, right];
    };
    expect(mix(true)).toEqual(mix(false));
  });
});
