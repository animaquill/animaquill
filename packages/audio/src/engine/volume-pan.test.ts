import {
  clockOfSound,
  compileChannel,
  gainOfDecibels,
  monoPan,
  numberAt,
  stereoPan,
  type Channel,
  type MixPlan,
} from "@animaquill/core";
import { describe, expect, it } from "vitest";
import { MixEngine } from "./engine.ts";
import { MIX_RATE } from "./resample.ts";
import type { SampleStore } from "./samples.ts";
import { chunksOf, inFile, planOf, sound, storeOf, track } from "./test-support.ts";

/** The volume and the pan of the mix: keys worked out at every sample, and where a sound sits. */

const f32 = Math.fround;

function mixed(plan: MixPlan, stores: Record<string, SampleStore>, from: number, frames: number) {
  const engine = new MixEngine(plan, (each) => stores[each.file]);
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  engine.render(from, frames, left, right);
  return { left, right };
}

const curve = (value: NonNullable<Parameters<typeof compileChannel>[0]>) =>
  compileChannel(value, "number") as Channel;
const second = (channels = 2) => storeOf(chunksOf({ frames: MIX_RATE, channels }));

describe("the volume with keys", () => {
  // From 0 dB at 0.2 s on the clock of the clip to −30 dB at 0.6 s, eased, then back up.
  const volume = curve({
    keys: [
      { time: "0.2", value: 0, interp: "bezier", out: [0.42, 0] },
      { time: "0.6", value: -30, in: [0.58, 1] },
      { time: "0.9", value: 6 },
    ],
  });

  it("is the curve worked out at every sample, in decibels, then a gain", () => {
    // The clip starts at 0.1 s on the timeline, with its file and its clock at 0.05 s.
    const one = sound({ start: 0.1, end: 1, offset: 0.05, volume });
    const { left, right } = mixed(planOf([one]), { f: second() }, 0, MIX_RATE);
    let changed = 0;
    for (let at = 4800; at < MIX_RATE; at += 1) {
      const clock = clockOfSound(one, at / MIX_RATE);
      const gain = f32(gainOfDecibels(numberAt(volume, clock, 0)));
      const frame = at - 4800 + 2400;
      const wantLeft = f32(f32(inFile(frame, 0)) * gain);
      const wantRight = f32(f32(inFile(frame, 1)) * gain);
      if (left[at] !== wantLeft || right[at] !== wantRight) {
        throw new Error(`sample ${at}: ${left[at]}, ${right[at]} is not ${wantLeft}, ${wantRight}`);
      }
      if (gain !== 1) changed += 1;
    }
    expect(changed).toBeGreaterThan(MIX_RATE / 2);
  });

  it("goes evenly in decibels, so that −10 dB is halfway from 0 to −20", () => {
    const even = curve({
      keys: [
        { time: "0", value: 0 },
        { time: "1", value: -20 },
      ],
    });
    const flat = storeOf(chunksOf({ frames: MIX_RATE, value: () => 0.5 }));
    const { left } = mixed(planOf([sound({ volume: even })]), { f: flat }, 0, MIX_RATE);
    expect(left[MIX_RATE / 2]).toBeCloseTo(0.5 * 10 ** (-10 / 20), 6);
    expect(left[0]).toBe(0.5);
  });

  it("is silent from −96 dB down", () => {
    const down = curve({
      keys: [
        { time: "0", value: -96 },
        { time: "1", value: -96 },
      ],
    });
    const { left } = mixed(planOf([sound({ volume: down })]), { f: second() }, 0, 1000);
    expect(left.every((value) => value === 0)).toBe(true);
  });

  it("of a track is on the timeline's time, after the clips of the track", () => {
    const keyed = curve({
      keys: [
        { time: "0.25", value: 0 },
        { time: "0.75", value: -40 },
      ],
    });
    const plan = planOf(
      [sound({ start: 0.5, end: 1, offset: 0.5, gain: 0.5 })],
      [track({ volume: keyed })],
    );
    const { left } = mixed(plan, { f: second() }, 0, MIX_RATE);
    for (const at of [24_000, 30_000, 36_000, 47_999]) {
      const gain = f32(gainOfDecibels(numberAt(keyed, at / MIX_RATE, 0)));
      expect(left[at]).toBe(f32(f32(f32(inFile(at)) * f32(0.5)) * gain));
    }
  });

  it("changes on the spot, without the sound starting over", () => {
    const engine = new MixEngine(planOf([sound()]), () => second());
    const left = new Float32Array(128);
    const right = new Float32Array(128);
    engine.setPlan(planOf([sound({ volume })]));
    engine.render(MIX_RATE / 2, 128, left, right);
    expect(left[0]).not.toBe(f32(inFile(MIX_RATE / 2)));
  });
});

describe("the pan", () => {
  // p, then left and right of one channel; then of two, how much of l and r goes to each side.
  const table = [
    { p: -1, mono: [Math.SQRT2, 0], stereo: [1, 1, 0, 0] },
    {
      p: -0.5,
      mono: [Math.SQRT2 * Math.cos(Math.PI / 8), Math.SQRT2 * Math.sin(Math.PI / 8)],
      stereo: [1, Math.cos(Math.PI / 4), 0, Math.sin(Math.PI / 4)],
    },
    { p: 0, mono: [1, 1], stereo: [1, 0, 0, 1] },
    {
      p: 0.5,
      mono: [Math.SQRT2 * Math.cos((3 * Math.PI) / 8), Math.SQRT2 * Math.sin((3 * Math.PI) / 8)],
      stereo: [Math.cos(Math.PI / 4), 0, Math.sin(Math.PI / 4), 1],
    },
    { p: 1, mono: [0, Math.SQRT2], stereo: [0, 0, 1, 1] },
  ];

  it.each(table)("at $p is equal power for one channel and a balance for two", (row) => {
    const sides = new Float64Array(4);
    monoPan(row.p, sides);
    expect(sides[0]).toBeCloseTo(row.mono[0] as number, 12);
    expect(sides[1]).toBeCloseTo(row.mono[1] as number, 12);
    // Equal power: as loud together wherever it sits.
    expect((sides[0] as number) ** 2 + (sides[1] as number) ** 2).toBeCloseTo(2, 12);
    stereoPan(row.p, sides);
    for (const [index, want] of row.stereo.entries()) expect(sides[index]).toBeCloseTo(want, 12);
  });

  it("leaves one channel in the middle as it was, sample by sample", () => {
    const mono = storeOf(chunksOf({ frames: MIX_RATE, channels: 1 }));
    const middle = curve(0);
    const plain = mixed(planOf([sound({ gain: 0.5 })]), { f: mono }, 0, 4096);
    const panned = mixed(planOf([sound({ gain: 0.5, pan: middle })]), { f: mono }, 0, 4096);
    expect(panned.left).toEqual(plain.left);
    expect(panned.right).toEqual(plain.right);
    expect(plain.right).toEqual(plain.left);
  });

  it("leaves two channels in the middle as they were, on a clip and on a track", () => {
    const middle = curve(0);
    const plain = mixed(planOf([sound()]), { f: second() }, 0, 4096);
    const panned = mixed(
      planOf([sound({ pan: middle })], [track({ pan: middle })]),
      { f: second() },
      0,
      4096,
    );
    expect(panned.left).toEqual(plain.left);
    expect(panned.right).toEqual(plain.right);
  });

  it("all the way left leaves the right silent, for one channel and for two", () => {
    const left = curve(-1);
    const mono = storeOf(chunksOf({ frames: MIX_RATE, channels: 1 }));
    const one = mixed(planOf([sound({ pan: left })]), { f: mono }, 0, 1000);
    expect(one.right.every((value) => value === 0)).toBe(true);
    expect(one.left[10]).toBe(f32(f32(inFile(10)) * Math.SQRT2));
    const two = mixed(planOf([sound()], [track({ pan: left })]), { f: second() }, 0, 1000);
    expect(two.right.every((value) => Math.abs(value) < 1e-7)).toBe(true);
    expect(two.left[10]).toBeCloseTo(f32(inFile(10, 0)) + f32(inFile(10, 1)), 6);
  });

  it("follows keys at every sample, after the volume", () => {
    const pan = curve({
      keys: [
        { time: "0", value: -1 },
        { time: "1", value: 1 },
      ],
    });
    const mono = storeOf(chunksOf({ frames: MIX_RATE, channels: 1 }));
    const { left, right } = mixed(planOf([sound({ pan, gain: 0.5 })]), { f: mono }, 0, MIX_RATE);
    const sides = new Float64Array(4);
    for (const at of [0, 1, 12_000, 24_000, 36_001, 47_999]) {
      monoPan(numberAt(pan, at / MIX_RATE, 0), sides);
      const x = f32(f32(inFile(at)) * f32(0.5));
      expect(left[at]).toBe(f32(x * (sides[0] as number)));
      expect(right[at]).toBe(f32(x * (sides[1] as number)));
    }
  });
});
