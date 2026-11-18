import type { MixEffect, MixPlan } from "@animaquill/core";
import { expect, it } from "vitest";
import { BLOCK, MixEngine, mixMemory } from "./engine.ts";
import { effectOf } from "./effects/test-support.ts";
import { MIX_RATE } from "./resample.ts";
import { chunksOf, sound, storeOf, track } from "./test-support.ts";

/**
 * How fast the engine runs with effects (audio-mixing.md 4.5). The design aims at a big project's
 * second of sound in 150 ms and the preroll of a typical one in 40 ms on the test machine, which
 * plain TypeScript does not get to yet (about 190 ms and 180 ms there, 2026-11-18): the hot loops
 * go into WebAssembly for that, as 4.5 says. Until then these hold what effects cost against the
 * same tracks without them, on whatever machine, so that it gets no slower unnoticed.
 */

const store = storeOf(chunksOf({ frames: 30 * MIX_RATE, size: 4096 }));

function planWith(tracks: number, perTrack: () => MixEffect[], master: MixEffect[], reverbs = 0) {
  return {
    sounds: Array.from({ length: tracks }, (_, index) =>
      sound({ id: `s${index}`, track: `t${index}`, end: 30, gain: 0.3 }),
    ),
    tracks: Array.from({ length: tracks }, (_, index) =>
      track({
        id: `t${index}`,
        effects: [
          ...perTrack(),
          ...(index < reverbs ? [effectOf("reverb", { mix: 0.3, decay: 2 }, "r")] : []),
        ],
      }),
    ),
    master: { gain: 1, effects: master, limit: { ceiling: -1 } },
  } satisfies MixPlan;
}

const channelStrip = () => [
  effectOf("eq", { "hp.on": 1, "mid2.gain": -3, "high.gain": 2 }, "e"),
  effectOf("compressor", { threshold: -18, ratio: 3 }, "c"),
];

/** Milliseconds to mix `seconds` of a plan from `from` on, once it is warm. */
function timeOf(plan: MixPlan, from: number, seconds: number): number {
  const engine = new MixEngine(plan, () => store);
  const left = new Float32Array(BLOCK);
  const right = new Float32Array(BLOCK);
  for (let at = 0; at < MIX_RATE / 2; at += BLOCK) engine.render(at, BLOCK, left, right);
  const first = Math.round(from * MIX_RATE);
  engine.render(first - BLOCK, BLOCK, left, right);
  const started = performance.now();
  for (let at = first; at < first + seconds * MIX_RATE; at += BLOCK) {
    engine.render(at, BLOCK, left, right);
  }
  return performance.now() - started;
}

/** Most effects may cost: so many times the same tracks without them. */
const MOST_TIMES = 4;

it("mixes a big project at most 4 times as slowly as without effects", { timeout: 120_000 }, () => {
  // 20 tracks with an equalizer and a compressor, two reverbs (for the two buses of M5), the
  // master's equalizer and limiter.
  const plan = planWith(20, channelStrip, [effectOf("eq", { "mid2.gain": 1 }, "m")], 2);
  const withEffects = timeOf(plan, 1, 2) / 2;
  const without =
    timeOf(
      planWith(20, () => [], []),
      1,
      2,
    ) / 2;
  console.log(
    `a second of 20 tracks: ${withEffects.toFixed(1)} ms with effects, ${without.toFixed(1)} ms without`,
  );
  expect(withEffects / without).toBeLessThan(MOST_TIMES);
});

it(
  "gets ready to play a typical project at most 4 times as slowly as without effects",
  {
    timeout: 120_000,
  },
  () => {
    // Eight tracks with an equalizer and a compressor at their defaults' release, the safe limiter.
    const plan = planWith(8, channelStrip, []);
    const left = new Float32Array(BLOCK);
    const right = new Float32Array(BLOCK);
    // Once to have it compiled.
    new MixEngine(plan, () => store).render(10 * MIX_RATE, BLOCK, left, right);
    const engine = new MixEngine(plan, () => store);
    const started = performance.now();
    engine.render(20 * MIX_RATE, BLOCK, left, right);
    const took = performance.now() - started;
    const seconds = mixMemory(plan) / MIX_RATE;
    const without = timeOf(
      planWith(8, () => [], []),
      1,
      seconds,
    );
    console.log(
      `preroll of ${seconds.toFixed(2)} s for 8 tracks: ${took.toFixed(1)} ms, as long without effects ${without.toFixed(1)} ms`,
    );
    expect(took / without).toBeLessThan(MOST_TIMES);
  },
);

it(
  "gets ready for the worst: compressors of 2 s release one after the other and a 10 s reverb",
  { timeout: 300_000 },
  () => {
    const slow = () => [
      effectOf("compressor", { threshold: -20, ratio: 4, release: 2000, attack: 200 }, "c1"),
      effectOf("compressor", { threshold: -10, ratio: 4, release: 2000, attack: 200 }, "c2"),
    ];
    const plan = planWith(4, slow, [effectOf("reverb", { mix: 0.2, decay: 10 }, "r")]);
    const left = new Float32Array(BLOCK);
    const right = new Float32Array(BLOCK);
    const engine = new MixEngine(plan, () => store);
    const started = performance.now();
    engine.render(Math.round(mixMemory(plan) * 1.2), BLOCK, left, right);
    const took = performance.now() - started;
    console.log(
      `the worst preroll, ${(mixMemory(plan) / MIX_RATE).toFixed(1)} s: ${took.toFixed(0)} ms`,
    );
  },
);
