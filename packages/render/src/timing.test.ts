import type { RenderLayer } from "@animaquill/core";
import { clockOf } from "@animaquill/core/view";
import { describe, expect, it } from "vitest";
import { showsAt, VideoCursor } from "./cursor.ts";

/** Samples the way Mediabunny gives them for an MP4: ticks over the timescale, as floats. */
function mp4Source(timescale: number, step: number, count: number) {
  const timestamp = (n: number) => Math.round(((n * step) / timescale) * timescale) / timescale;
  return {
    async *samples(seconds: number) {
      let n = 0;
      while (n + 1 < count && timestamp(n + 1) <= seconds) n += 1;
      for (; n < count; n += 1) yield { n, timestamp: timestamp(n), close() {} };
    },
  };
}

/** A moment of a frame of an export, the way an export works it out from where its range starts. */
const momentOf = (from: number, index: number) => from + index / 30;

/** Which frames of a video at 30 frames show where they should not, for a clip on a timeline. */
async function wrongFrames(startFrame: number, offsetFrame: number, frames: number) {
  const layer = { start: startFrame / 30, offset: offsetFrame / 30 };
  const cursor = new VideoCursor(mp4Source(15_360, 512, offsetFrame + frames + 10));
  const wrong: [number, number, number][] = [];
  for (let index = startFrame; index < startFrame + frames; index += 1) {
    const sample = await cursor.at(clockOf(layer, momentOf(0, index)));
    const expected = index - startFrame + offsetFrame;
    if (sample?.n !== expected) wrong.push([index, expected, sample?.n ?? -1]);
  }
  return wrong;
}

describe("the frame of a video that a moment shows", () => {
  it("is its own for a clip at the start", async () => {
    expect(await wrongFrames(0, 0, 300)).toEqual([]);
  });

  it("is its own for a clip that starts on a later frame", async () => {
    expect(await wrongFrames(1, 0, 300)).toEqual([]);
  });

  it("is its own for a clip that was trimmed", async () => {
    expect(await wrongFrames(1, 7, 44)).toEqual([]);
    expect(await wrongFrames(100, 17, 300)).toEqual([]);
  });
});

describe("where a clip starts", () => {
  it("is the frame it starts on, also in a part of the timeline that starts elsewhere", () => {
    // As times of the project come out of their fractions.
    const from = 1 / 30;
    const next = { start: 6 / 30, end: 1 } as RenderLayer;
    const before = { start: from, end: next.start } as RenderLayer;
    // Frame 5 of a part that starts at 1/30 is at 6/30, and 1/30 + 5/30 is a little less.
    const seconds = momentOf(from, 5);
    expect(showsAt(next, seconds)).toBe(true);
    expect(showsAt(before, seconds)).toBe(false);
  });
});
