import { describe, expect, it } from "vitest";
import { wavOf } from "./wav.ts";

const planar = (...channels: readonly (readonly number[])[]) =>
  new Blob(channels.map((channel) => new Float32Array(channel)));

async function read(file: Blob) {
  const bytes = await file.arrayBuffer();
  const view = new DataView(bytes);
  const text = (at: number, length: number) =>
    String.fromCharCode(...new Uint8Array(bytes, at, length));
  return { view, text, samples: new Float32Array(bytes.slice(44)) };
}

describe("a sound file", () => {
  it("says what it holds", async () => {
    const { view, text } = await read(await wavOf(planar([0, 0.5], [1, -1]), 2, 2, 48_000));
    expect(text(0, 4)).toBe("RIFF");
    expect(view.getUint32(4, true)).toBe(36 + 16);
    expect(text(8, 8)).toBe("WAVEfmt ");
    expect(view.getUint16(20, true)).toBe(3);
    expect(view.getUint16(22, true)).toBe(2);
    expect(view.getUint32(24, true)).toBe(48_000);
    expect(view.getUint32(28, true)).toBe(48_000 * 8);
    expect(view.getUint16(32, true)).toBe(8);
    expect(view.getUint16(34, true)).toBe(32);
    expect(text(36, 4)).toBe("data");
    expect(view.getUint32(40, true)).toBe(16);
  });

  it("has the channels in turns", async () => {
    const { samples } = await read(await wavOf(planar([0.25, 0.5], [-0.25, -0.5]), 2, 2, 48_000));
    expect([...samples]).toEqual([0.25, -0.25, 0.5, -0.5]);
  });

  it("keeps samples exactly", async () => {
    const value = Math.fround(0.1234567);
    const { samples } = await read(await wavOf(planar([value]), 1, 1, 48_000));
    expect(samples[0]).toBe(value);
  });

  it("does not let anything through that cannot be played", async () => {
    const wild = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 7, -7, 1, -1];
    const { samples } = await read(await wavOf(planar(wild), 1, wild.length, 48_000));
    expect([...samples]).toEqual([0, 1, -1, 1, -1, 1, -1]);
  });

  it("gets the same out of a sound of many blocks", async () => {
    const frames = (1 << 16) * 2 + 5;
    const left = Float32Array.from({ length: frames }, (_, index) => (index % 100) / 100);
    const right = left.map((value) => -value);
    const { samples } = await read(await wavOf(new Blob([left, right]), 2, frames, 48_000));
    expect(samples).toHaveLength(frames * 2);
    for (const at of [0, 1, 65_535, 65_536, 65_537, frames - 1]) {
      expect(samples[at * 2]).toBe(left[at]);
      expect(samples[at * 2 + 1]).toBe(right[at]);
    }
  });
});
