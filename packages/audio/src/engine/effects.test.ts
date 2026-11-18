import type { MixEffect, MixPlan } from "@animaquill/core";
import { describe, expect, it } from "vitest";
import { MeterChannel } from "../meter.ts";
import { MixEngine, mixMemory } from "./engine.ts";
import { effectOf, keyed, seedCount, seeded } from "./effects/test-support.ts";
import { MIX_RATE } from "./resample.ts";
import type { SampleStore } from "./samples.ts";
import { chunksOf, planOf, sound, storeOf, track } from "./test-support.ts";

/** The effects of sound and the master in the engine (audio-mixing.md 2.1, 2.4, 2.5 and 4.2). */

type Stores = Record<string, SampleStore>;

function mix(plan: MixPlan, stores: Stores, from: number, to: number, cut = 128) {
  const engine = new MixEngine(plan, (each) => stores[each.file]);
  const left = new Float32Array(to - from);
  const right = new Float32Array(to - from);
  for (let at = from; at < to; at += cut) {
    engine.render(at, Math.min(cut, to - at), left, right, at - from);
  }
  return { left, right };
}

const master = (changes: Partial<NonNullable<MixPlan["master"]>> = {}) => ({
  gain: 1,
  limit: { ceiling: -1 },
  ...changes,
});

function truePeakDb(...channels: Float32Array[]): number {
  let peak = 0;
  for (const samples of channels) {
    const meter = new MeterChannel(MIX_RATE);
    for (const sample of samples) meter.step(sample);
    for (let index = 0; index < 12; index += 1) meter.step(0);
    peak = Math.max(peak, meter.truePeak, ...samples.map(Math.abs));
  }
  return 20 * Math.log10(peak);
}

/** A file of a tone at a level, two channels. */
const tone = (level: number, frequency = 440, seconds = 2) =>
  storeOf(
    chunksOf({
      frames: seconds * MIX_RATE,
      value: (frame, channel) =>
        level * Math.sin((2 * Math.PI * (frequency + channel * 3) * frame) / MIX_RATE),
    }),
  );

/** A file of silence with a click of `level` at `frame`. */
const click = (frame: number, level = 0.5, frames = MIX_RATE) =>
  storeOf(chunksOf({ frames, value: (at) => (at === frame ? level : 0) }));

describe("the master's safe limiter", () => {
  it("changes no sample of a mix that stays under −1 dBTP", () => {
    const stores = { a: tone(0.3), b: tone(0.2, 1234) };
    const sounds = [
      sound({ id: "a", file: "a", start: 0.1, end: 1.7, gain: 0.9 }),
      sound({ id: "b", file: "b", track: "u", start: 0.4, end: 1.9, offset: 0.3 }),
    ];
    const tracks = [track(), track({ id: "u", gain: 0.8 })];
    const plain = mix(planOf(sounds, tracks), stores, 0, 2 * MIX_RATE);
    const limited = mix({ ...planOf(sounds, tracks), master: master() }, stores, 0, 2 * MIX_RATE);
    expect(truePeakDb(plain.left, plain.right)).toBeLessThan(-1);
    expect(limited.left).toEqual(plain.left);
    expect(limited.right).toEqual(plain.right);
  });

  it("brings a mix that clips down to −1 dBTP, where it was, without clipping", () => {
    const stores = { a: tone(0.8), b: tone(0.7, 440) };
    const sounds = [
      sound({ id: "a", file: "a", start: 0, end: 2 }),
      sound({ id: "b", file: "b", track: "u", start: 0.5, end: 1.5 }),
    ];
    const plan = { ...planOf(sounds, [track(), track({ id: "u" })]), master: master() };
    const out = mix(plan, stores, 0, 2 * MIX_RATE);
    expect(truePeakDb(out.left, out.right)).toBeLessThanOrEqual(-1 + 1e-6);
    // Before the loud part, as it was: 0.8 under −1 dBTP.
    const plain = mix(planOf(sounds, [track(), track({ id: "u" })]), stores, 0, 2 * MIX_RATE);
    expect(out.left.subarray(0, MIX_RATE * 0.4)).toEqual(plain.left.subarray(0, MIX_RATE * 0.4));
  });

  it("is made up for: a click comes out where it is on the timeline", () => {
    const stores = { c: click(4800, 1.6) };
    const plan = { ...planOf([sound({ id: "c", file: "c", start: 0, end: 1 })]), master: master() };
    const out = mix(plan, stores, 0, MIX_RATE);
    let loudest = 0;
    out.left.forEach((value, index) => {
      if (Math.abs(value) > Math.abs(out.left[loudest] as number)) loudest = index;
    });
    expect(loudest).toBe(4800);
  });

  it("keeps within [−1, 1] when it is off", () => {
    const stores = { a: tone(0.9), b: tone(0.9) };
    const sounds = [
      sound({ id: "a", file: "a", start: 0, end: 1 }),
      sound({ id: "b", file: "b", track: "u", start: 0, end: 1 }),
    ];
    const plan = { ...planOf(sounds, [track(), track({ id: "u" })]), master: { gain: 1 } };
    const out = mix(plan, stores, 0, MIX_RATE);
    expect(Math.max(...out.left.map(Math.abs))).toBe(1);
  });
});

describe("effects in the mix", () => {
  it("make up for limiters on clips, tracks and the master: clicks stay together", () => {
    const stores = { c: click(9600, 0.9) };
    const limiter = effectOf("limiter", { ceiling: -12 }, "l");
    const plan: MixPlan = {
      sounds: [
        sound({ id: "a", file: "c", start: 0, end: 1, effects: [limiter] }),
        sound({ id: "b", file: "c", track: "u", start: 0, end: 1 }),
      ],
      tracks: [
        track({ effects: [effectOf("limiter", { ceiling: -6 }, "t")] }),
        track({ id: "u", pan: { kind: "still", value: 1 } }),
      ],
      master: master({ effects: [effectOf("limiter", { ceiling: -3 }, "m")] }),
    };
    const out = mix(plan, stores, 0, MIX_RATE);
    const loudest = (samples: Float32Array) =>
      samples.reduce(
        (best, value, index) =>
          Math.abs(value) > Math.abs(samples[best] as number) ? index : best,
        0,
      );
    // Track a sits in the middle (both sides), track b all the way right.
    expect(loudest(out.left)).toBe(9600);
    expect(loudest(out.right)).toBe(9600);
  });

  it("end where their clip ends: no tail of a clip's reverb", () => {
    const stores = { a: tone(0.5) };
    const reverb = effectOf("reverb", { decay: 3, mix: 0.7 }, "r");
    const plan = planOf([sound({ id: "a", file: "a", start: 0.2, end: 0.6, effects: [reverb] })]);
    const out = mix(plan, stores, 0, MIX_RATE);
    expect(out.left.subarray(0.6 * MIX_RATE).every((value) => value === 0)).toBe(true);
    // The same on the track goes on after it.
    const onTrack = mix(
      planOf([sound({ id: "a", file: "a", start: 0.2, end: 0.6 })], [track({ effects: [reverb] })]),
      stores,
      0,
      MIX_RATE,
    );
    expect(Math.abs(onTrack.left[0.7 * MIX_RATE] as number)).toBeGreaterThan(1e-4);
  });

  it("work in their order: a compressor before an equalizer is not one after it", () => {
    const stores = { a: tone(0.6, 200) };
    const eq = effectOf("eq", { "low.gain": 12, "low.freq": 300 }, "e");
    const compressor = effectOf("compressor", { threshold: -20, ratio: 8, attack: 1 }, "c");
    const at = (effects: MixEffect[]) =>
      mix(
        planOf([sound({ id: "a", file: "a", start: 0, end: 1 })], [track({ effects })]),
        stores,
        0,
        MIX_RATE,
      );
    const first = at([eq, compressor]);
    const second = at([compressor, eq]);
    const level = (samples: Float32Array) =>
      Math.max(...samples.subarray(MIX_RATE / 2).map(Math.abs));
    expect(Math.abs(20 * Math.log10(level(first.left) / level(second.left)))).toBeGreaterThan(3);
  });

  it("say what compressors and limiters take off, for the meters, without changing a sample", () => {
    const stores = { a: tone(0.9, 300) };
    const compressor = effectOf("compressor", { threshold: -30, ratio: 6, attack: 1 }, "c");
    const plan = {
      ...planOf(
        [sound({ id: "a", file: "a", start: 0, end: 1 })],
        [track({ effects: [compressor] })],
      ),
      master: master(),
    };
    const metered = new MixEngine(plan, (each) => stores[each.file as "a"]);
    metered.metering = true;
    const left = new Float32Array(MIX_RATE / 2);
    const right = new Float32Array(MIX_RATE / 2);
    metered.render(0, left.length, left, right);
    const reductions = metered.takeReductions();
    expect(reductions.get("~track:t/c")).toBeGreaterThan(10);
    expect(reductions.get("~master/~limit")).toBe(0);
    const plain = mix(plan, stores, 0, left.length);
    expect(left).toEqual(plain.left);
  });

  it("take parameters with keys every 32 samples", () => {
    const stores = { a: tone(0.5, 1000) };
    const eq: MixEffect = {
      id: "e",
      type: "eq",
      params: {
        "mid2.gain": keyed([
          [0, 0],
          [1, -24],
        ]),
      },
    };
    const out = mix(
      planOf([sound({ id: "a", file: "a", start: 0, end: 1 })], [track({ effects: [eq] })]),
      stores,
      0,
      MIX_RATE,
    );
    const early = Math.max(...out.left.subarray(4800, 9600).map(Math.abs));
    const late = Math.max(...out.left.subarray(43_200, 48_000).map(Math.abs));
    expect(20 * Math.log10(late / early)).toBeLessThan(-15);
  });
});

/** Plans with every effect, at random, on clips, tracks and the master. */
function randomPlan(seed: number): { plan: MixPlan; stores: Stores } {
  const random = seeded(seed);
  const pick = <T>(items: readonly T[]) => items[Math.floor(random() * items.length)] as T;
  const effect = (id: string): MixEffect =>
    pick([
      effectOf(
        "eq",
        { "mid2.gain": -12 + random() * 24, "mid2.q": 0.5 + random() * 4, "hp.on": 1 },
        id,
      ),
      effectOf(
        "compressor",
        { threshold: -30, ratio: 4, attack: 1 + random() * 20, release: 20 + random() * 300 },
        id,
      ),
      effectOf("limiter", { ceiling: -6, release: 10 + random() * 200 }, id),
      effectOf("reverb", { decay: 0.2 + random() * 1.5, mix: 0.3, size: random() }, id),
    ]);
  const stores = {
    a: tone(0.7, 220, 3),
    b: storeOf(chunksOf({ frames: 3 * 44_100, rate: 44_100, size: 1152 })),
  };
  const plan: MixPlan = {
    sounds: [
      sound({ id: "a", file: "a", start: 0.1, end: 2.6, effects: [effect("c1"), effect("c2")] }),
      sound({ id: "b", file: "b", track: "u", start: 0.5, end: 2.9, offset: 0.1 }),
    ],
    tracks: [track({ effects: [effect("t1")] }), track({ id: "u", effects: [effect("t2")] })],
    master: master({ effects: [effect("m")] }),
  };
  return { plan, stores };
}

describe("a mix with effects", () => {
  it("gives the same samples however it is cut into calls", { timeout: 120_000 }, () => {
    const { plan, stores } = randomPlan(3);
    const whole = mix(plan, stores, 0, 3 * MIX_RATE, 3 * MIX_RATE);
    const random = seeded(5);
    const engine = new MixEngine(plan, (each) => stores[each.file]);
    const left = new Float32Array(3 * MIX_RATE);
    const right = new Float32Array(3 * MIX_RATE);
    for (let at = 0; at < left.length;) {
      const frames = Math.min(1 + Math.floor(random() * 3000), left.length - at);
      engine.render(at, frames, left, right, at);
      at += frames;
    }
    expect(left).toEqual(whole.left);
    expect(right).toEqual(whole.right);
  });

  it(
    "comes within −96 dBFS of the mix from the start, from wherever it starts",
    { timeout: 120_000 },
    () => {
      const count = seedCount(4);
      for (let seed = 1; seed <= count; seed += 1) {
        const { plan, stores } = randomPlan(seed);
        const whole = mix(plan, stores, 0, 3 * MIX_RATE);
        const random = seeded(seed * 13);
        for (let turn = 0; turn < 3; turn += 1) {
          const from = Math.floor(random() * 2.5 * MIX_RATE);
          const to = Math.min(from + 9000, 3 * MIX_RATE);
          const part = mix(plan, stores, from, to);
          let most = 0;
          for (let index = 0; index < to - from; index += 1) {
            most = Math.max(
              most,
              Math.abs((part.left[index] as number) - (whole.left[from + index] as number)),
              Math.abs((part.right[index] as number) - (whole.right[from + index] as number)),
            );
          }
          expect(most, `seed ${seed} from ${from}`).toBeLessThanOrEqual(2 ** -16);
        }
      }
    },
  );

  it("remembers nothing without effects and the limiter", () => {
    expect(mixMemory(planOf([sound()]))).toBe(0);
    expect(mixMemory({ ...planOf([sound()]), master: master() })).toBeGreaterThan(0);
  });
});
