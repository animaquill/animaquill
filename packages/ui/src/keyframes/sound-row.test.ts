import { compileChannel, type Channel, type MixPlan, type MixSound } from "@animaquill/core";
import { describe, expect, it } from "vitest";
import { loudestIn, soundLevels, soundMemoryIn } from "./sound-row.ts";

/** A view of `seconds` of time over `width` pixels from `start`. */
const viewOf = (width: number, seconds: number, start = 0) => ({
  width,
  timeAt: (x: number) => start + (x / width) * seconds,
  xAt: (time: number) => ((time - start) / seconds) * width,
});

const layer = (id: string, start: number, end: number, extra: Partial<MixSound> = {}) =>
  ({ id, file: id, start, end, offset: 0, gain: 1, track: "t", ...extra }) as MixSound;

/** Sounds on a track at 0 dB, or at another gain. */
const planOf = (sounds: readonly MixSound[], gain = 1): MixPlan => ({
  sounds,
  tracks: [{ id: "t", gain, muted: false, solo: false }],
});

describe("the loudest in a stretch", () => {
  it("is what going through all of it finds, for any stretch", () => {
    let seed = 7;
    const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (const length of [1, 2, 3, 7, 64, 1001]) {
      const peaks = Uint8Array.from({ length }, () => Math.floor(random() * 256));
      for (let round = 0; round < 200; round += 1) {
        const from = Math.floor(random() * (length + 4)) - 2;
        const to = from + Math.floor(random() * (length + 4));
        let expected = 0;
        for (let slot = Math.max(from, 0); slot < Math.min(to, length); slot += 1) {
          expected = Math.max(expected, peaks[slot] as number);
        }
        expect(loudestIn(peaks, from, to)).toBe(expected);
      }
    }
  });
});

describe("the levels of the row", () => {
  // A second at 100 slots: loud for the first 48, silent after.
  const half = Uint8Array.from({ length: 100 }, (_, slot) => (slot < 48 ? 255 : 0));

  it("follows the waveform on the timeline, from where the clip starts in its file", () => {
    // Four slots a pixel.
    const levels = new Float32Array(25);
    soundLevels(planOf([layer("a", 0, 1)]), () => half, viewOf(25, 1), levels);
    expect(levels.slice(0, 12).every((level) => level === 1)).toBe(true);
    expect(levels.slice(12).every((level) => level === 0)).toBe(true);
    soundLevels(planOf([layer("a", 0, 1, { offset: 0.5 })]), () => half, viewOf(25, 1), levels);
    expect([...levels].every((level) => level === 0)).toBe(true);
  });

  it("draws nothing outside the clip", () => {
    const levels = new Float32Array(50);
    soundLevels(planOf([layer("a", 1, 2)]), () => half, viewOf(50, 2), levels);
    expect(levels.slice(0, 25).every((level) => level === 0)).toBe(true);
    expect(levels[25]).toBe(1);
  });

  it("adds sounds at once up as their power, at their volumes", () => {
    const levels = new Float32Array(10);
    const quiet = { gain: 0.3 };
    soundLevels(
      planOf([layer("a", 0, 1, quiet), layer("b", 0, 1, { gain: 0.4 })]),
      () => half,
      viewOf(10, 1),
      levels,
    );
    expect(levels[0]).toBeCloseTo(0.5);
    soundLevels(planOf([layer("a", 0, 1), layer("b", 0, 1)]), () => half, viewOf(10, 1), levels);
    expect(levels[0]).toBe(1);
  });

  it("counts a waveform that is not there yet as silence", () => {
    const levels = new Float32Array(10);
    soundLevels(planOf([layer("a", 0, 1)]), () => undefined, viewOf(10, 1), levels);
    expect([...levels].every((level) => level === 0)).toBe(true);
  });

  it("follows the volume of the clip and of its track, also with keys", () => {
    const levels = new Float32Array(10);
    const loud = Uint8Array.from({ length: 100 }, () => 255);
    soundLevels(planOf([layer("a", 0, 1, { gain: 0.5 })], 0.5), () => loud, viewOf(10, 1), levels);
    expect(levels[0]).toBeCloseTo(0.25);
    // From 0 dB down to −20 dB over the second, evenly in decibels: −10 dB in the middle.
    const volume = compileChannel(
      {
        keys: [
          { time: "0", value: 0 },
          { time: "1", value: -20 },
        ],
      },
      "number",
    ) as Channel;
    soundLevels(planOf([layer("a", 0, 1, { volume })]), () => loud, viewOf(10, 1), levels);
    expect(levels[0]).toBeCloseTo(10 ** (-1 / 20), 2);
    expect(levels[5]).toBeLessThan(10 ** (-10 / 20));
    expect(levels[4]).toBeGreaterThan(10 ** (-10 / 20));
  });

  it("takes the transitions of a sound in", () => {
    const levels = new Float32Array(10);
    const fades = [{ use: "enter", way: "in", shape: "gain", start: 0, end: 1, duration: 1 }];
    const loud = Uint8Array.from({ length: 100 }, () => 255);
    soundLevels(planOf([layer("a", 0, 1, { fades } as never)]), () => loud, viewOf(10, 1), levels);
    expect(levels[0]).toBeLessThan(levels[9] as number);
  });
});

describe("what the row remembers", () => {
  it("keeps only what makes sense", () => {
    expect(soundMemoryIn({ folded: true, track: "a" })).toEqual({ folded: true, track: "a" });
    expect(soundMemoryIn({ folded: "yes", track: 3 })).toEqual({});
    expect(soundMemoryIn(null)).toEqual({});
  });
});
