import type { SoundLayer } from "@animaquill/core";
import { describe, expect, it } from "vitest";
import { loudestIn, soundLevels, soundMemoryIn } from "./sound-row.ts";

/** A view of `seconds` of time over `width` pixels from `start`. */
const viewOf = (width: number, seconds: number, start = 0) => ({
  width,
  timeAt: (x: number) => start + (x / width) * seconds,
  xAt: (time: number) => ((time - start) / seconds) * width,
});

const layer = (id: string, start: number, end: number, extra: Partial<SoundLayer> = {}) =>
  ({ id, file: id, start, end, offset: 0, gain: 1, ...extra }) as SoundLayer;

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
    soundLevels([layer("a", 0, 1)], () => half, viewOf(25, 1), levels);
    expect(levels.slice(0, 12).every((level) => level === 1)).toBe(true);
    expect(levels.slice(12).every((level) => level === 0)).toBe(true);
    soundLevels([layer("a", 0, 1, { offset: 0.5 })], () => half, viewOf(25, 1), levels);
    expect([...levels].every((level) => level === 0)).toBe(true);
  });

  it("draws nothing outside the clip", () => {
    const levels = new Float32Array(50);
    soundLevels([layer("a", 1, 2)], () => half, viewOf(50, 2), levels);
    expect(levels.slice(0, 25).every((level) => level === 0)).toBe(true);
    expect(levels[25]).toBe(1);
  });

  it("adds sounds at once up as their power, at their volumes", () => {
    const levels = new Float32Array(10);
    const quiet = { gain: 0.3 };
    soundLevels(
      [layer("a", 0, 1, quiet), layer("b", 0, 1, { gain: 0.4 })],
      () => half,
      viewOf(10, 1),
      levels,
    );
    expect(levels[0]).toBeCloseTo(0.5);
    soundLevels([layer("a", 0, 1), layer("b", 0, 1)], () => half, viewOf(10, 1), levels);
    expect(levels[0]).toBe(1);
  });

  it("counts a waveform that is not there yet as silence", () => {
    const levels = new Float32Array(10);
    soundLevels([layer("a", 0, 1)], () => undefined, viewOf(10, 1), levels);
    expect([...levels].every((level) => level === 0)).toBe(true);
  });

  it("takes the transitions of a sound in", () => {
    const levels = new Float32Array(10);
    const fades = [{ use: "enter", way: "in", shape: "gain", start: 0, end: 1, duration: 1 }];
    const loud = Uint8Array.from({ length: 100 }, () => 255);
    soundLevels([layer("a", 0, 1, { fades } as never)], () => loud, viewOf(10, 1), levels);
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
