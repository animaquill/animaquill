import type { RenderLayer } from "@animaquill/core";
import { describe, expect, it } from "vitest";
import type { FrameSource, TimedFrame } from "./cursor.ts";
import { VideoReads } from "./reads.ts";

interface Frame extends TimedFrame {
  /** Which file it came from. */
  readonly from: string;
}

/** Frames every tenth of a second, which say where they came from. */
function sourceOf(from: string): FrameSource<Frame> & { readonly starts: number[] } {
  const starts: number[] = [];
  return {
    starts,
    async *samples(seconds) {
      starts.push(seconds);
      for (let index = Math.max(0, Math.floor(seconds * 10)); index < 100; index += 1) {
        yield { from, timestamp: index / 10, close() {} };
      }
    },
  };
}

const layer: RenderLayer = {
  id: "clip",
  start: 0,
  end: 10,
  offset: 0,
  source: { kind: "video", file: "video" },
  fit: "contain",
  channels: {},
};

describe("the reads of a video", () => {
  it("go on in the file of a clip, from where they were", async () => {
    const reads = new VideoReads<Frame>();
    const video = sourceOf("video");
    expect((await reads.frameAt(layer, "video", video, 1)).frame?.timestamp).toBe(1);
    expect((await reads.frameAt(layer, "video", video, 1.5)).frame?.timestamp).toBe(1.5);
    expect(video.starts).toEqual([1]);
  });

  it("start over for another source of the same file, as a stand-in, whatever read last", async () => {
    const reads = new VideoReads<Frame>();
    const video = sourceOf("video");
    const standIn = sourceOf("stand-in");
    expect((await reads.frameAt(layer, "video", video, 1)).frame?.from).toBe("video");
    const switched = await reads.frameAt(layer, "video", standIn, 1);
    expect(switched).toMatchObject({ frame: { from: "stand-in", timestamp: 1 }, cold: true });
    // A frame that was on its way with the video, and the next one with the stand-in again.
    expect((await reads.frameAt(layer, "video", video, 1)).frame?.from).toBe("video");
    expect((await reads.frameAt(layer, "video", standIn, 1.1)).frame?.from).toBe("stand-in");
  });
});
