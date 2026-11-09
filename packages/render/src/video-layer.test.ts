import type { RenderLayer } from "@animaquill/core";
import { describe, expect, it, vi } from "vitest";
import { PendingFrame, type FrameLoop } from "./frame-loop.ts";
import { videoLayerFrame, type VideoLayerParts } from "./video-layer.ts";

const layer: RenderLayer = {
  id: "clip",
  start: 0,
  end: 10,
  offset: 0,
  source: { kind: "video", file: "video" },
  fit: "contain",
  channels: {},
};

/** The files of a compositor, one of which takes the place of the other when the test says. */
function compositor() {
  const video = new Blob(["视频"]);
  const standIn = new Blob(["代理"]);
  let current = video;
  let during: (() => void) | undefined;
  const failed: unknown[] = [];
  const parts: VideoLayerParts<{ readonly file: Blob }, string> = {
    fileOf: () => current,
    async videoOf(_, file) {
      during?.();
      return { file };
    },
    async frameAt(_, __, opened) {
      during?.();
      return { frame: opened.file === video ? "视频的一帧" : "代理的一帧", cold: false };
    },
    readFailed: (_, __, ___, error) => void failed.push(error),
  };
  return {
    parts,
    video,
    standIn,
    failed,
    /** Has the stand-in take the place of the video while a frame opens or reads it. */
    replaceWhile(step: "opening" | "reading") {
      let calls = 0;
      during = () => {
        calls += 1;
        if ((step === "opening" && calls === 1) || (step === "reading" && calls === 2)) {
          current = standIn;
        }
      };
    },
  };
}

const frameAt = (seconds: number) => new PendingFrame(seconds, { jumps: 0 } as FrameLoop);

describe("the frame of a video layer", () => {
  it("is read from the file the id reads", async () => {
    const { parts, video } = compositor();
    const frame = frameAt(1);
    expect(await videoLayerFrame(parts, layer, "video", video, frame)).toMatchObject({
      sample: "视频的一帧",
      cold: false,
    });
    expect(frame.givenUp).toBe(false);
  });

  it.each(["opening", "reading"] as const)(
    "gives up the whole frame when another file takes the place of its own while %s it",
    async (step) => {
      const { parts, video, replaceWhile } = compositor();
      replaceWhile(step);
      const frame = frameAt(1);
      // Drawn without this layer, the picture would flicker: the next frame has the new file.
      expect(await videoLayerFrame(parts, layer, "video", video, frame)).toBeUndefined();
      expect(frame.givenUp).toBe(true);
    },
  );

  it("gives up a frame whose read failed because another file took the place of its own", async () => {
    const { parts, video, failed, replaceWhile } = compositor();
    replaceWhile("reading");
    const read = parts.frameAt;
    parts.frameAt = async (...args) => {
      await read(...args);
      throw new Error("Input has been disposed");
    };
    const frame = frameAt(1);
    expect(await videoLayerFrame(parts, layer, "video", video, frame)).toBeUndefined();
    expect(frame.givenUp).toBe(true);
    expect(failed).toEqual([]);
  });

  it("says that a read failed, and fails", async () => {
    const { parts, video, failed } = compositor();
    const error = new Error("读不了");
    parts.frameAt = vi.fn(() => Promise.reject(error));
    await expect(videoLayerFrame(parts, layer, "video", video, frameAt(1))).rejects.toBe(error);
    expect(failed).toEqual([error]);
  });
});
