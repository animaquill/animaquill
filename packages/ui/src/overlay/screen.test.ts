import { transformPoint } from "@animaquill/core";
import { describe, expect, it } from "vitest";
import { scaledSize } from "../preview/quality.ts";
import { pictureOnScreen, worldToScreen } from "./screen.ts";

const HD = { width: 1920, height: 1080 };
const camera = {};

describe("where the picture is on the screen", () => {
  it("fills a frame of its shape that is smaller than the full resolution", () => {
    expect(pictureOnScreen({ width: 960, height: 540 }, HD, HD)).toEqual({
      x: 0,
      y: 0,
      width: 960,
      height: 540,
    });
  });

  it("is never larger than the full resolution, in the middle of a frame that has more room", () => {
    expect(pictureOnScreen({ width: 2400, height: 1400 }, HD, HD)).toEqual({
      x: 240,
      y: 160,
      width: 1920,
      height: 1080,
    });
  });

  it("keeps its shape in a frame of another shape, in the middle of it", () => {
    expect(pictureOnScreen({ width: 960, height: 1000 }, HD, HD)).toEqual({
      x: 0,
      y: 230,
      width: 960,
      height: 540,
    });
    const tall = { width: 1080, height: 1920 };
    expect(pictureOnScreen({ width: 960, height: 540 }, tall, tall)).toEqual({
      x: 328.125,
      y: 0,
      width: 303.75,
      height: 540,
    });
  });

  it.each([1, 0.5, 0.25])("takes the same room at a quality of %d", (scale) => {
    const shown = scaledSize(1920, 1080, scale);
    expect(pictureOnScreen({ width: 1000, height: 700 }, HD, shown)).toEqual(
      pictureOnScreen({ width: 1000, height: 700 }, HD, HD),
    );
  });
});

describe("from the world to the screen", () => {
  it.each([1, 0.5, 0.25])("puts the stage on the picture at a quality of %d", (scale) => {
    const shown = scaledSize(1920, 1080, scale);
    const matrix = worldToScreen(
      { camera },
      { frame: { width: 960, height: 540 }, full: HD, shown },
      0,
    );
    if (!matrix) throw new Error("no matrix");
    const middle = transformPoint(matrix, { x: 0, y: 0 });
    const corner = transformPoint(matrix, { x: 960, y: 540 });
    expect(middle.x).toBeCloseTo(480, 9);
    expect(middle.y).toBeCloseTo(270, 9);
    expect(corner.x).toBeCloseTo(960, 9);
    expect(corner.y).toBeCloseTo(540, 9);
  });

  it("follows what the compositor draws of an odd format at a lower quality", () => {
    const full = { width: 1366, height: 769 };
    const shown = scaledSize(1366, 769, 0.25);
    expect(shown).toEqual({ width: 342, height: 192 });
    const frame = { width: 700, height: 500 };
    const matrix = worldToScreen({ camera }, { frame, full, shown }, 0);
    if (!matrix) throw new Error("no matrix");
    const rect = pictureOnScreen(frame, full, shown);
    // Fewer pixels are a little off the shape of the full picture, and show a little more of the
    // world at the sides: 192 pixels high is 5.625 units a pixel, and the middle is pixel 171.
    const scale = rect.width / 342;
    const middle = transformPoint(matrix, { x: 0, y: 0 });
    expect(middle.x).toBeCloseTo(rect.x + rect.width / 2, 9);
    expect(middle.y).toBeCloseTo(rect.y + rect.height / 2, 9);
    const stageLeft = (-1366 * (1080 / 769)) / 2;
    const left = transformPoint(matrix, { x: stageLeft, y: 0 });
    expect(left.x).toBeCloseTo(rect.x + (171 + stageLeft / 5.625) * scale, 9);
    expect(transformPoint(matrix, { x: 0, y: 540 }).y).toBeCloseTo(rect.y + rect.height, 9);
  });

  it("is nothing while there is no room, or no picture", () => {
    const sizes = { full: HD, shown: HD };
    expect(
      worldToScreen({ camera }, { ...sizes, frame: { width: 0, height: 0 } }, 0),
    ).toBeUndefined();
    const nothing = { width: 0, height: 0 };
    expect(worldToScreen({ camera }, { frame: HD, full: HD, shown: nothing }, 0)).toBeUndefined();
  });
});
