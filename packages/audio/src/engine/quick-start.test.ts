import type { MixPlan } from "@animaquill/core";
import { describe, expect, it } from "vitest";
import { MixEngine } from "./engine.ts";
import { MixerCore } from "./mixer-core.ts";
import { MIX_RATE } from "./resample.ts";
import { chunksOf, planOf, sound, storeOf, track } from "./test-support.ts";

/**
 * Playing from the middle of a project where only the safe limiter of the master remembers
 * anything (audio-mixing.md 4.2): sound at once, with a cold limiter, and the limiter that the
 * export has there takes over once it is worked out on the side.
 */

/** A tone that goes over the ceiling now and then: loud for 0.2 s of every 0.5 s. */
const value = (frame: number, channel: number) =>
  (frame % 24_000 < 9600 ? 1.4 : 0.3) * Math.sin(frame * 0.05 + channel);
const chunks = chunksOf({ frames: 4 * MIX_RATE, value });
const plan: MixPlan = {
  ...planOf([sound({ id: "a", file: "a", start: 0, end: 4 })], [track()]),
  master: { gain: 1, limit: { ceiling: -1 } },
};

function exported(from: number, to: number) {
  const engine = new MixEngine(plan, () => store);
  const left = new Float32Array(to);
  const right = new Float32Array(to);
  engine.render(0, to, left, right);
  return left.subarray(from, to);
}
const store = storeOf(chunks);

describe("playing from the middle with only the safe limiter", () => {
  it("sounds at the first block, and is the export once the limiter worked out on the side is there", () => {
    const engine = new MixEngine(plan, () => store);
    engine.quickStart = true;
    const from = 2 * MIX_RATE + 9600 - 4800;
    const left = new Float32Array(128);
    const right = new Float32Array(128);
    engine.render(from, 128, left, right);
    expect(Math.max(...left.map(Math.abs))).toBeGreaterThan(0.1);
    // Under the ceiling all the same.
    expect(Math.max(...left.map(Math.abs))).toBeLessThanOrEqual(10 ** (-1 / 20));
    expect(engine.catchingUp).toBe(true);
    const length = MIX_RATE;
    const out = new Float32Array(length);
    out.set(left);
    let at = 128;
    while (engine.catchingUp) {
      engine.catchUp(4, false);
      engine.render(from + at, 128, left, right);
      out.set(left, at);
      at += 128;
    }
    const swapped = at + 128;
    for (; at < length; at += 128) {
      engine.render(from + at, 128, left, right);
      out.set(left, at);
    }
    const wanted = exported(from, from + length);
    let most = 0;
    for (let index = swapped; index < length; index += 1) {
      most = Math.max(most, Math.abs((out[index] as number) - (wanted[index] as number)));
    }
    expect(most).toBeLessThanOrEqual(2 ** -16);
  });

  it("is the export to the sample where the limiter took nothing off before", () => {
    const quiet = storeOf(
      chunksOf({ frames: 4 * MIX_RATE, value: (frame) => 0.3 * Math.sin(frame * 0.05) }),
    );
    const engine = new MixEngine(plan, () => quiet);
    engine.quickStart = true;
    const from = 2 * MIX_RATE + 77;
    const left = new Float32Array(MIX_RATE / 2);
    const right = new Float32Array(MIX_RATE / 2);
    engine.render(from, left.length, left, right);
    const whole = new MixEngine(plan, () => quiet);
    const wantLeft = new Float32Array(from + left.length);
    whole.render(0, wantLeft.length, wantLeft, new Float32Array(wantLeft.length));
    expect(left).toEqual(wantLeft.subarray(from));
  });

  it("has the preview play from the middle with sound in its first quantum", () => {
    const core = new MixerCore(() => {}, MIX_RATE);
    const start = 2 * MIX_RATE;
    core.receive({ kind: "play", run: 1, plan, frame: 0, sample: start, rate: 1 });
    core.receive({ kind: "open", run: 1, id: "a" });
    // Only what plays from here on is there yet: the second before is not waited for.
    for (const chunk of chunks) {
      if (chunk.start + 1000 < start) continue;
      core.receive({ kind: "chunk", run: 1, id: "a", ...chunk, since: chunk.start });
    }
    const left = new Float32Array(128);
    const right = new Float32Array(128);
    core.process(0, left, right);
    expect(Math.max(...left.map(Math.abs))).toBeGreaterThan(0.1);
  });
});
