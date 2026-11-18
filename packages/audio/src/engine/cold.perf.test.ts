import { expect, it } from "vitest";
import { BLOCK, MixEngine, warmUp } from "./engine.ts";
import { chunksOf, planOf, sound, storeOf, track } from "./test-support.ts";

/**
 * The first quanta of the first playing, as the audio thread has them right after it was made: a
 * file of its own, so that nothing else warmed the engine up before. Without `warmUp` the first
 * hundred milliseconds take several times as long, while the JavaScript engine compiles.
 */
it("is quick from the first quantum on, once warmed up", { timeout: 60_000 }, () => {
  const started = performance.now();
  warmUp();
  const warming = performance.now() - started;
  const store = storeOf(chunksOf({ frames: 2 * 44_100, rate: 44_100, size: 4096 }));
  const tracks = 8;
  const plan = planOf(
    Array.from({ length: tracks }, (_, index) =>
      sound({ id: `s${index}`, track: `t${index}`, end: 2, gain: 0.5 }),
    ),
    Array.from({ length: tracks }, (_, index) => track({ id: `t${index}`, gain: 0.9 })),
  );
  const engine = new MixEngine(plan, () => store);
  const left = new Float32Array(BLOCK);
  const right = new Float32Array(BLOCK);
  const first = performance.now();
  const quanta = 50;
  for (let index = 0; index < quanta; index += 1) {
    engine.render(index * BLOCK, BLOCK, left, right);
  }
  const perQuantum = ((performance.now() - first) * 1000) / quanta;
  console.log(
    `warming up ${warming.toFixed(1)} ms; then the first ${quanta} quanta of 8 tracks at ` +
      `44.1 kHz ${perQuantum.toFixed(1)} µs each`,
  );
  expect(perQuantum).toBeLessThan(2670 / 2);
});
