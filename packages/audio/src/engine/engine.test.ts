import { fadesGainAt, type MixPlan, type SoundFade } from "@animaquill/core";
import { describe, expect, it } from "vitest";
import { BLOCK, MixEngine } from "./engine.ts";
import { MIX_RATE } from "./resample.ts";
import type { SampleStore } from "./samples.ts";
import { chunksOf, inFile, planOf, sound, storeOf, track } from "./test-support.ts";

/** Mixes samples `from` up to `from + frames` of a plan, with a store for each file. */
function mixed(plan: MixPlan, stores: Record<string, SampleStore>, from: number, frames: number) {
  const engine = new MixEngine(plan, (each) => stores[each.file]);
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  engine.render(from, frames, left, right);
  return { left, right, engine };
}

const second = () => storeOf(chunksOf({ frames: MIX_RATE }));
const f32 = Math.fround;

describe("the mix engine", () => {
  it("puts a sound at its place from its offset, and nothing elsewhere", () => {
    const plan = planOf([sound({ start: 0.5, end: 0.75, offset: 0.1 })]);
    const { left, right } = mixed(plan, { f: second() }, 0, MIX_RATE);
    for (const at of [0, 23_999, 36_000]) expect([left[at], right[at]]).toEqual([0, 0]);
    // Sample 24 000 of the timeline is frame 4 800 of the file.
    for (const at of [24_000, 24_001, 30_000, 35_999]) {
      expect(left[at]).toBe(f32(inFile(at - 24_000 + 4_800, 0)));
      expect(right[at]).toBe(f32(inFile(at - 24_000 + 4_800, 1)));
    }
  });

  it("adds sounds up, each with the gain of its clip and of its track", () => {
    const plan = planOf(
      [
        sound({ id: "a", gain: 0.5 }),
        sound({ id: "b", file: "g", gain: 0.25, track: "u" }),
        sound({ id: "c", file: "g", gain: 2, track: "u" }),
      ],
      [track({ gain: 0.8 }), track({ id: "u", gain: 0.5 })],
    );
    const other = storeOf(chunksOf({ frames: MIX_RATE, value: (frame) => inFile(frame + 99) }));
    const { left } = mixed(plan, { f: second(), g: other }, 0, MIX_RATE);
    for (const at of [0, 777, 47_999]) {
      const a = f32(inFile(at)) * 0.5 * 0.8;
      const bc = (f32(inFile(at + 99)) * 0.25 + f32(inFile(at + 99)) * 2) * 0.5;
      expect(left[at]).toBe(f32(a + bc));
    }
  });

  it("works the transitions in sample by sample, as fadesGainAt has them", () => {
    const fades: SoundFade[] = [
      { use: "enter", way: "in", shape: "power", start: 0, end: 0.3, duration: 0.3 },
      { use: "exit", way: "out", shape: "gain", start: 0.6, end: 1, duration: 0.4 },
    ];
    const plan = planOf([sound({ fades, gain: 0.7 })]);
    const { left } = mixed(plan, { f: second() }, 0, MIX_RATE);
    for (let at = 0; at < MIX_RATE; at += 1) {
      const want = f32(f32(f32(inFile(at)) * f32(fadesGainAt(fades, at / MIX_RATE))) * f32(0.7));
      if (left[at] !== want) throw new Error(`sample ${at}: ${left[at]} is not ${want}`);
    }
    expect(left[MIX_RATE * 0.15]).not.toBe(f32(f32(inFile(MIX_RATE * 0.15)) * f32(0.7)));
  });

  it("hears only soloed tracks once one is, and no muted ones", () => {
    const sounds = [sound({ id: "a" }), sound({ id: "b", track: "u" })];
    const at = 1000;
    const level = (tracks: Parameters<typeof planOf>[1]) =>
      mixed(planOf(sounds, tracks), { f: second() }, at, 1).left[0];
    const one = f32(inFile(at));
    expect(level([track(), track({ id: "u" })])).toBe(f32(2 * one));
    expect(level([track({ muted: true }), track({ id: "u" })])).toBe(one);
    expect(level([track(), track({ id: "u", solo: true })])).toBe(one);
    // Solo wins over mute.
    expect(level([track({ muted: true, solo: true }), track({ id: "u" })])).toBe(one);
    expect(level([track({ muted: true }), track({ id: "u", muted: true })])).toBe(0);
  });

  it("takes a new plan from the next block on: a gain tried out, a track muted", () => {
    const plan = planOf([sound()]);
    const { engine } = mixed(plan, { f: second() }, 0, 0);
    const left = new Float32Array(BLOCK);
    const right = new Float32Array(BLOCK);
    engine.render(0, BLOCK, left, right);
    expect(left[5]).toBe(f32(inFile(5)));
    engine.setPlan(planOf([sound({ gain: 0.5 })]));
    engine.render(BLOCK, BLOCK, left, right);
    expect(left[5]).toBe(f32(inFile(BLOCK + 5) * 0.5));
    engine.setPlan(planOf([sound({ gain: 0.5 })], [track({ muted: true })]));
    engine.render(2 * BLOCK, BLOCK, left, right);
    expect(left.every((value) => value === 0)).toBe(true);
  });

  it("says which sounds it hears", () => {
    const heard = sound({ id: "a" });
    const quiet = sound({ id: "b", gain: 0 });
    const muted = sound({ id: "c", track: "u" });
    const empty = sound({ id: "d", start: 1, end: 1 });
    const engine = new MixEngine(
      planOf([heard, quiet, muted, empty], [track(), track({ id: "u", muted: true })]),
      () => undefined,
    );
    expect([heard, quiet, muted, empty].map((each) => engine.hears(each))).toEqual([
      true,
      false,
      false,
      false,
    ]);
    expect(engine.silent).toBe(false);
    expect(new MixEngine(planOf([quiet]), () => undefined).silent).toBe(true);
  });

  it("is silent before the file starts and after it ends", () => {
    // From 0.1 s before the file to 0.1 s after it: the file is half a second.
    const half = storeOf(chunksOf({ frames: MIX_RATE / 2 }));
    const plan = planOf([sound({ start: 0, end: 0.7, offset: -0.1 })]);
    const { left } = mixed(plan, { f: half }, 0, MIX_RATE);
    expect(left[4799]).toBe(0);
    expect(left[4800]).toBe(f32(inFile(0)));
    expect(left[28_799]).toBe(f32(inFile(23_999)));
    expect(left[28_800]).toBe(0);
  });

  it("says what was missing, and leaves that sound out of the block", () => {
    const store = storeOf(chunksOf({ frames: 1000 }));
    const missing: [string, number, number][] = [];
    const engine = new MixEngine(
      planOf([sound()]),
      () => store,
      (each, from, count) => missing.push([each.id, from, count]),
    );
    const left = new Float32Array(BLOCK);
    const right = new Float32Array(BLOCK);
    // The file ends at 1000 as far as anyone knows: past it nothing was read yet.
    store.endAt(Number.POSITIVE_INFINITY);
    engine.render(8 * BLOCK, BLOCK, left, right);
    expect(missing).toEqual([["s", 8 * BLOCK, BLOCK]]);
    expect(left.every((value) => value === 0)).toBe(true);
  });

  it("is silent without a word for a sound that is not being read", () => {
    const missing: unknown[] = [];
    const engine = new MixEngine(
      planOf([sound()]),
      () => undefined,
      (...args) => missing.push(args),
    );
    const left = new Float32Array(BLOCK);
    engine.render(0, BLOCK, left, new Float32Array(BLOCK));
    expect(missing).toEqual([]);
  });

  it("plays mono in both channels", () => {
    const mono = storeOf(chunksOf({ frames: MIX_RATE, channels: 1 }));
    const { left, right } = mixed(planOf([sound({ gain: 0.5 })]), { f: mono }, 100, 10);
    for (let index = 0; index < 10; index += 1) {
      expect(left[index]).toBe(f32(f32(inFile(100 + index)) * 0.5));
      expect(right[index]).toBe(left[index]);
    }
  });
});
