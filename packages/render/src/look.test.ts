import { viewMatrix } from "@animaquill/core/view";
import { describe, expect, it } from "vitest";
import { DIFF_THRESHOLD, diffPicture, diffPixels, markRect, sheetSize } from "./look.ts";

/** A picture of one color, with a block of another. */
function picture(
  width: number,
  height: number,
  block?: { x: number; y: number; w: number; h: number },
) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = (y * width + x) * 4;
      const inside =
        block && x >= block.x && x < block.x + block.w && y >= block.y && y < block.y + block.h;
      data.set(inside ? [200, 40, 40, 255] : [20, 20, 20, 255], at);
    }
  }
  return data;
}

describe("what a picture for AI works out", () => {
  it("finds the share of pixels that changed and the box around them", () => {
    const before = picture(8, 4);
    const after = picture(8, 4, { x: 0, y: 2, w: 4, h: 2 });
    const found = diffPixels(before, after, 8, 4);
    expect(found.ratio).toBe(0.25);
    expect(found.box).toEqual({ x: 0, y: 2, width: 4, height: 2 });
    // The same picture, and one a renderer rounds a little otherwise, did not change.
    expect(diffPixels(before, before, 8, 4)).toMatchObject({ ratio: 0 });
    const rounded = before.map((value, at) => (at % 4 === 3 ? value : value + DIFF_THRESHOLD));
    expect(diffPixels(before, rounded, 8, 4).ratio).toBe(0);
    // Red where it changed, grey elsewhere.
    const shown = diffPicture(after, found.changed);
    expect(Array.from(shown.subarray(2 * 8 * 4, 2 * 8 * 4 + 4))).toEqual([
      255,
      expect.any(Number),
      expect.any(Number),
      255,
    ]);
    expect(shown[0]).toBe(shown[1]);
  });

  it("puts a box of the world where the picture has it, also where a camera comes closer", () => {
    const plan = { width: 1024, height: 576, camera: {} };
    // The right half of the world, on a picture of 1024 for 1920 units.
    expect(markRect(viewMatrix(plan, 0), { x: 0, y: -540, width: 960, height: 1080 })).toEqual({
      x: 512,
      y: 0,
      width: 512,
      height: 576,
    });
    // A part rendered large: the bottom left quarter fills the picture.
    const closer = {
      width: 1024,
      height: 576,
      camera: {
        "camera.x": { kind: "still" as const, value: -480 },
        "camera.y": { kind: "still" as const, value: 270 },
        "camera.zoom": { kind: "still" as const, value: 2 },
      },
    };
    const box = markRect(viewMatrix(closer, 0), { x: -960, y: 0, width: 960, height: 540 });
    expect(box.x).toBeCloseTo(0);
    expect(box.y).toBeCloseTo(0);
    expect(box.width).toBeCloseTo(1024);
    expect(box.height).toBeCloseTo(576);
  });

  it("lays an overview out in rows", () => {
    expect(sheetSize(12, 4, { width: 256, height: 144 })).toEqual({
      width: 1036,
      height: 440,
      rows: 3,
    });
    expect(sheetSize(1, 4, { width: 256, height: 144 })).toEqual({
      width: 256,
      height: 144,
      rows: 1,
    });
  });
});
