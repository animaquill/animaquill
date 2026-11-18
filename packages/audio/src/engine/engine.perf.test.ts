import { describe, expect, it } from "vitest";
import { BLOCK, MixEngine } from "./engine.ts";
import { MIX_RATE } from "./resample.ts";
import { chunksOf, planOf, sound, storeOf, track } from "./test-support.ts";

/**
 * How long the engine takes for one quantum of the preview, as the audio thread runs it, with many
 * tracks over each other. The audio thread has 2.67 ms for each.
 */

/** Microseconds per quantum for `tracks` tracks of stereo at `rate`, all sounding at once. */
function perQuantum(tracks: number, rate: number, fading = false): number {
  const store = storeOf(chunksOf({ frames: 12 * rate, rate, size: 4096 }));
  const fades = fading
    ? [
        {
          use: "enter" as const,
          way: "in" as const,
          shape: "power" as const,
          start: 0,
          end: 12,
          duration: 12,
        },
      ]
    : undefined;
  const plan = planOf(
    Array.from({ length: tracks }, (_, index) =>
      sound({ id: `s${index}`, track: `t${index}`, end: 12, gain: 0.5, ...(fades && { fades }) }),
    ),
    Array.from({ length: tracks }, (_, index) => track({ id: `t${index}`, gain: 0.9 })),
  );
  const engine = new MixEngine(plan, () => store);
  const left = new Float32Array(BLOCK);
  const right = new Float32Array(BLOCK);
  // Warm, as the audio thread is after a moment.
  for (let at = 0; at < MIX_RATE; at += BLOCK) engine.render(at, BLOCK, left, right);
  const quanta = (10 * MIX_RATE) / BLOCK;
  const started = performance.now();
  for (let index = 0; index < quanta; index += 1) {
    engine.render(MIX_RATE + index * BLOCK, BLOCK, left, right);
  }
  return ((performance.now() - started) * 1000) / quanta;
}

describe("the engine in the audio thread", () => {
  // Ten seconds of each of five mixes, a quantum at a time.
  it("mixes many tracks well within a quantum", { timeout: 60_000 }, () => {
    const rows = {
      "20 tracks at 48 kHz": perQuantum(20, 48_000),
      "20 tracks at 48 kHz, all fading": perQuantum(20, 48_000, true),
      "20 tracks at 44.1 kHz": perQuantum(20, 44_100),
      "8 tracks at 44.1 kHz": perQuantum(8, 44_100),
      "4 tracks at 96 kHz": perQuantum(4, 96_000),
    };
    console.log(
      Object.entries(rows)
        .map(([name, us]) => `${name}: ${us.toFixed(1)} µs per quantum`)
        .join("\n"),
    );
    // Half of the quantum for the worst of these, twenty files at another rate all at once, which
    // leaves room for a busy machine.
    for (const us of Object.values(rows)) expect(us).toBeLessThan(2670 / 2);
  });
});
