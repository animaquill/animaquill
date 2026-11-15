import { describe, expect, it } from "vitest";
import { compressShot, fitSize, pictureNote } from "./shots.ts";

describe("frames for AI", () => {
  it("fit 1568 on the longer side, never larger than they are", () => {
    expect(fitSize(1920, 1080, 1568)).toEqual({ width: 1568, height: 882 });
    expect(fitSize(1080, 1920, 1568)).toEqual({ width: 882, height: 1568 });
    expect(fitSize(1280, 720, 1568)).toEqual({ width: 1280, height: 720 });
    expect(fitSize(3840, 2160, 1024)).toEqual({ width: 1024, height: 576 });
    expect(fitSize(3840, 2160, undefined)).toEqual({ width: 3840, height: 2160 });
  });

  it("go at 0.85, then 0.7, then smaller until they fit what the model takes", async () => {
    const tried: string[] = [];
    // About a byte per pixel at 0.85, less at 0.7.
    const encode = async (width: number, height: number, quality: number) => {
      tried.push(`${width}x${height}@${quality}`);
      return new Blob([new Uint8Array(Math.round(width * height * quality))]);
    };
    const fits = await compressShot(encode, 1568, 882, 2_000_000);
    expect(fits).toMatchObject({ width: 1568, height: 882 });
    expect(tried).toEqual(["1568x882@0.85"]);
    tried.length = 0;
    const smaller = await compressShot(encode, 1568, 882, 800_000);
    expect(tried).toEqual(["1568x882@0.85", "1568x882@0.7", "1254x705@0.85"]);
    expect(smaller).toMatchObject({ width: 1254, height: 705 });
    expect(smaller.blob.size).toBeLessThanOrEqual(800_000);
  });

  it("say what they are to AI", () => {
    expect(
      pictureNote(1, {
        width: 1568,
        height: 882,
        frame: { timeline: "main", timelineName: "主时间轴", t: "73/6", timecode: "0:12/05" },
      }),
    ).toBe(
      '[image 1: the frame of timeline "主时间轴" (main) at t=73/6 (0:12/05), as the export renders it, 1568×882]',
    );
    expect(pictureNote(2, { width: 800, height: 600 })).toBe(
      "[image 2: a picture the user added, 800×600]",
    );
  });
});
