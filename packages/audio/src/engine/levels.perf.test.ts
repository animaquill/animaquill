import { describe, expect, it } from "vitest";
import { BLOCK, MixEngine } from "./engine.ts";
import { LEVELS_PER_SECOND, MasterLevels } from "./levels.ts";
import { MixerCore, type MixerReport } from "./mixer-core.ts";
import { MIX_RATE } from "./resample.ts";
import { chunksOf, planOf, sound, storeOf, track } from "./test-support.ts";

/**
 * What the meters of the mixer cost the audio thread, which has 2.67 ms for each quantum: the
 * peaks of every track as the engine mixes, and the peaks, true peak and loudness of the master.
 * And how often they bother the page.
 */

const TRACKS = 20;
const SECONDS = 10;

const plan = planOf(
  Array.from({ length: TRACKS }, (_, index) =>
    sound({ id: `s${index}`, track: `t${index}`, end: 12, gain: 0.5 }),
  ),
  Array.from({ length: TRACKS }, (_, index) => track({ id: `t${index}`, gain: 0.9 })),
);

/** Microseconds per quantum of the engine for twenty tracks, metering them or not. */
function engineQuantum(metering: boolean): number {
  const store = storeOf(chunksOf({ frames: 12 * MIX_RATE, size: 4096 }));
  const engine = new MixEngine(plan, () => store);
  engine.metering = metering;
  const left = new Float32Array(BLOCK);
  const right = new Float32Array(BLOCK);
  for (let at = 0; at < MIX_RATE; at += BLOCK) engine.render(at, BLOCK, left, right);
  const quanta = (SECONDS * MIX_RATE) / BLOCK;
  const started = performance.now();
  for (let index = 0; index < quanta; index += 1) {
    engine.render(MIX_RATE + index * BLOCK, BLOCK, left, right);
    if (metering && index % 12 === 0)
      for (let one = 0; one < TRACKS; one += 1) engine.takePeak(`t${one}`);
  }
  return ((performance.now() - started) * 1000) / quanta;
}

/** Microseconds per quantum of the meters of the master. */
function masterQuantum(): number {
  const levels = new MasterLevels(MIX_RATE);
  const left = Float32Array.from({ length: BLOCK }, (_, index) => Math.sin(index * 0.1) * 0.5);
  const right = left.map((sample) => -sample);
  for (let at = 0; at < MIX_RATE; at += BLOCK) levels.add(left, right);
  const quanta = (SECONDS * MIX_RATE) / BLOCK;
  const started = performance.now();
  for (let index = 0; index < quanta; index += 1) {
    levels.add(left, right);
    if (index % 12 === 0) levels.take();
  }
  return ((performance.now() - started) * 1000) / quanta;
}

describe("the meters in the audio thread", () => {
  it("cost little of a quantum", { timeout: 60_000 }, () => {
    const without = engineQuantum(false);
    const withMeters = engineQuantum(true);
    const master = masterQuantum();
    console.log(
      [
        `engine, ${TRACKS} tracks: ${without.toFixed(1)} µs per quantum`,
        `engine, ${TRACKS} tracks, metering them: ${withMeters.toFixed(1)} µs per quantum`,
        `meters of the master: ${master.toFixed(1)} µs per quantum`,
      ].join("\n"),
    );
    // The master's true peak and loudness, and the peaks of tracks, well under a tenth of it.
    expect(master).toBeLessThan(2670 / 10);
    expect(withMeters - without).toBeLessThan(2670 / 10);
  });

  it("tell the page at most 30 times a second", () => {
    const reports: MixerReport[] = [];
    const core = new MixerCore((report) => reports.push(report), MIX_RATE);
    core.receive({ kind: "play", run: 1, plan, frame: 0, sample: 0, rate: 1 });
    const left = new Float32Array(BLOCK);
    const right = new Float32Array(BLOCK);
    for (let frame = 0; frame < SECONDS * MIX_RATE; frame += BLOCK) {
      core.process(frame, left, right);
    }
    const levels = reports.filter(({ kind }) => kind === "levels").length;
    expect(levels).toBeLessThanOrEqual(SECONDS * LEVELS_PER_SECOND);
    expect(levels).toBeGreaterThanOrEqual(SECONDS * LEVELS_PER_SECOND - 1);
  });
});
