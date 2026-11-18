import type { MixEffect, MixPlan } from "@animaquill/core";
import { expect, it } from "vitest";
import { BLOCK, MixEngine, mixMemory } from "./engine.ts";
import { effectOf } from "./effects/test-support.ts";
import { MIX_RATE } from "./resample.ts";
import { chunksOf, sound, storeOf, track } from "./test-support.ts";

/**
 * How fast the engine runs with effects (audio-mixing.md 4.5). The design aims at a big project's
 * second of sound in 150 ms and the preroll of a typical one in 40 ms on the test machine, which
 * plain TypeScript does not get to yet (about 190 ms and 200 ms there, 2026-11-18): the hot loops
 * go into WebAssembly for that, as 4.5 says. Until then these hold what there is, so that it gets
 * no slower unnoticed.
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

it("mixes a second of a big project in 300 ms", { timeout: 120_000 }, () => {
  // 20 tracks with an equalizer and a compressor, two reverbs (for the two buses of M5), the
  // master's equalizer and limiter.
  const plan = planWith(20, channelStrip, [effectOf("eq", { "mid2.gain": 1 }, "m")], 2);
  const engine = new MixEngine(plan, () => store);
  const left = new Float32Array(BLOCK);
  const right = new Float32Array(BLOCK);
  for (let at = 0; at < MIX_RATE; at += BLOCK) engine.render(at, BLOCK, left, right);
  const started = performance.now();
  for (let at = MIX_RATE; at < 3 * MIX_RATE; at += BLOCK) engine.render(at, BLOCK, left, right);
  const perSecond = (performance.now() - started) / 2;
  console.log(`a second of 20 tracks with effects: ${perSecond.toFixed(1)} ms`);
  expect(perSecond).toBeLessThan(300);
});

it("gets ready to play a typical project in 400 ms", { timeout: 120_000 }, () => {
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
  console.log(
    `preroll of ${(mixMemory(plan) / MIX_RATE).toFixed(2)} s for 8 tracks: ${took.toFixed(1)} ms`,
  );
  expect(took).toBeLessThan(400);
});

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
