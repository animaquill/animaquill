import type { MixPlan, SoundFade } from "@animaquill/core";
import { describe, expect, it } from "vitest";
import { MixEngine } from "./engine.ts";
import { MIX_RATE } from "./resample.ts";
import type { SampleStore } from "./samples.ts";
import { chunksOf, inFile, planOf, sound, storeOf, track } from "./test-support.ts";

/**
 * The preview and the export mix with the same engine, cut into calls differently: the preview a
 * quantum at a time from wherever it starts, the export ten seconds at a time. Cut any way, from
 * any start, the samples are the same.
 */

const fades: SoundFade[] = [
  { use: "enter", way: "in", shape: "power", start: 0.1, end: 0.4, duration: 0.3 },
  { use: "join", way: "out", shape: "gain", start: 1.2, end: 1.6, duration: 0.4 },
];

/** A little of everything there is: two rates, mono and 5.1, transitions, two tracks. */
function everything(): { plan: MixPlan; stores: Record<string, SampleStore> } {
  const plan = planOf(
    [
      sound({ id: "a", file: "48", start: 0.1, end: 1.6, offset: 0.05, gain: 0.8, fades }),
      sound({ id: "b", file: "44", start: 0.3, end: 1.9, offset: 0.2, gain: 0.6 }),
      sound({ id: "c", file: "mono", track: "u", start: 0, end: 2, gain: 1.2 }),
      sound({ id: "d", file: "96", track: "u", start: 0.9, end: 1.4, offset: 0.37 }),
    ],
    [track({ gain: 0.9 }), track({ id: "u", gain: 0.7 })],
  );
  const stores = {
    "48": storeOf(chunksOf({ frames: 2 * MIX_RATE, size: 1024 })),
    "44": storeOf(chunksOf({ frames: 2 * 44_100, rate: 44_100, size: 1152 })),
    mono: storeOf(
      chunksOf({ frames: 2 * 22_050, rate: 22_050, channels: 1, value: (f) => inFile(f, 3) }),
    ),
    "96": storeOf(chunksOf({ frames: 2 * 96_000, rate: 96_000, channels: 6, size: 960 })),
  };
  return { plan, stores };
}

const { plan, stores } = everything();

/** Samples `from` up to `to`, in calls of the lengths `cut` gives, one after the other. */
function mixedIn(cut: (call: number) => number, from: number, to: number) {
  const engine = new MixEngine(plan, (each) => stores[each.file]);
  const left = new Float32Array(to - from);
  const right = new Float32Array(to - from);
  for (let at = from, call = 0; at < to; call += 1) {
    const frames = Math.min(cut(call), to - at);
    engine.render(at, frames, left, right, at - from);
    at += frames;
  }
  return { left, right };
}

/** Numbers that look random and are the same every time. */
function seeded(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
}

describe("however a mix is cut into calls", () => {
  const whole = mixedIn(() => 2 * MIX_RATE, 0, 2 * MIX_RATE);

  it("has something to compare: every sound is heard", () => {
    for (const at of [0.2, 0.5, 1.0, 1.7]) {
      expect(Math.abs(whole.left[at * MIX_RATE] ?? 0)).toBeGreaterThan(0.01);
    }
  });

  for (const [name, cut] of [
    ["quanta of 128", () => 128],
    ["pieces of 1000", () => 1000],
    [
      "calls of any length",
      (() => {
        const random = seeded(7);
        return () => 1 + Math.floor(random() * 3000);
      })(),
    ],
  ] as const) {
    it(`gives the same samples in ${name}`, () => {
      const cutUp = mixedIn(cut, 0, 2 * MIX_RATE);
      expect(cutUp.left).toEqual(whole.left);
      expect(cutUp.right).toEqual(whole.right);
    });
  }

  it("gives the same samples from wherever it starts", () => {
    const random = seeded(11);
    for (let turn = 0; turn < 20; turn += 1) {
      const from = Math.floor(random() * 1.8 * MIX_RATE);
      const to = Math.min(from + 1 + Math.floor(random() * 20_000), 2 * MIX_RATE);
      const part = mixedIn(() => 128, from, to);
      expect(part.left).toEqual(whole.left.subarray(from, to));
      expect(part.right).toEqual(whole.right.subarray(from, to));
    }
  });
});
