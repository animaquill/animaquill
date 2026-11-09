import { describe, expect, it } from "vitest";
import type { Context2D } from "./compose.ts";
import { videoPicture, type VideoSampleLike } from "./picture.ts";

/** A frame of a video that says how it gets drawn. */
function sample(width: number, height: number, rotation = 0) {
  const drawn: unknown[][] = [];
  const source = { kind: "frame" } as unknown as CanvasImageSource;
  const frame: VideoSampleLike = {
    displayWidth: width,
    displayHeight: height,
    rotation,
    flip: false,
    draw: (_target, ...numbers) => void drawn.push(["sample", ...numbers]),
    toCanvasImageSource: () => source,
  };
  const target = {
    drawImage: (image: unknown, ...numbers: number[]) =>
      void drawn.push([image === source ? "image" : "other", ...numbers]),
  } as unknown as Context2D;
  return { frame, target, drawn };
}

describe("a frame of a video", () => {
  it("is as large as it shows, and draws the part asked for", () => {
    const { frame, target, drawn } = sample(1920, 1080);
    const picture = videoPicture(frame);
    expect([picture.width, picture.height]).toEqual([1920, 1080]);
    picture.draw(target, 10, 20, 300, 200);
    expect(drawn).toEqual([["image", 10, 20, 300, 200, 10, 20, 300, 200]]);
  });

  it("of a stand-in is as large as the video it stands in for, and draws the same part of it", () => {
    const { frame, target, drawn } = sample(960, 540);
    const picture = videoPicture(frame, { width: 3840, height: 2160 });
    expect([picture.width, picture.height]).toEqual([3840, 2160]);
    // What is at 400,200 of the video is at 100,50 of the stand-in, four times smaller.
    picture.draw(target, 400, 200, 3000, 1800);
    expect(drawn).toEqual([["image", 100, 50, 750, 450, 400, 200, 3000, 1800]]);
  });

  it("of a stand-in that a phone turned is drawn the way the sample turns it", () => {
    const { frame, target, drawn } = sample(540, 960, 90);
    const picture = videoPicture(frame, { width: 2160, height: 3840 });
    picture.draw(target, 0, 0, 2160, 3840);
    expect(drawn).toEqual([["sample", 0, 0, 540, 960, 0, 0, 2160, 3840]]);
  });
});
