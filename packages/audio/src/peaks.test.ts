import { describe, expect, it } from "vitest";
import type { SoundChunk } from "./index.ts";
import { computePeaks, PEAKS_PER_SECOND } from "./peaks.ts";

function chunk(timestamp: number, ...channels: readonly (readonly number[])[]): SoundChunk {
  const sampleRate = PEAKS_PER_SECOND * 2;
  const length = channels[0]?.length ?? 0;
  const buffer = {
    sampleRate,
    numberOfChannels: channels.length,
    duration: length / sampleRate,
    getChannelData: (index: number) => Float32Array.from(channels[index] ?? []),
  };
  return { buffer, timestamp, duration: buffer.duration } as unknown as SoundChunk;
}

async function* from(...chunks: readonly SoundChunk[]) {
  yield* chunks;
}

describe("peaks", () => {
  it("keeps the loudest level of each moment, negative or not", async () => {
    const peaks = await computePeaks(from(chunk(0, [0.1, 0.5, -1, 0.2])));
    expect([...peaks]).toEqual([128, 255]);
  });

  it("listens to all channels", async () => {
    const peaks = await computePeaks(from(chunk(0, [0, 0], [1, 0])));
    expect([...peaks]).toEqual([255]);
  });

  it("puts a chunk where it belongs in time", async () => {
    const peaks = await computePeaks(from(chunk(0.02, [1, 1])));
    expect([...peaks]).toEqual([0, 0, 255]);
  });

  it("survives a level above full scale", async () => {
    const peaks = await computePeaks(from(chunk(0, [3, 3])));
    expect([...peaks]).toEqual([255]);
  });

  it("grows with a long sound", async () => {
    const peaks = await computePeaks(from(chunk(100, [1, 1])));
    expect(peaks).toHaveLength(100 * PEAKS_PER_SECOND + 1);
    expect(peaks.at(-1)).toBe(255);
  });

  it("is empty for no sound at all", async () => {
    expect(await computePeaks(from())).toHaveLength(0);
  });
});
