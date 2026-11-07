import {
  multiply,
  viewMatrix,
  type Matrix,
  type Rect,
  type RenderPlan,
  type Size,
} from "@animaquill/core";

/**
 * Where the picture of the compositor is on the screen. The compositor lays its canvas out with CSS,
 * see `sizeOnScreen` in `render/src/compositor.ts`: as large as there is room for, never larger than
 * the full resolution, in the middle of its frame, and what it draws fits into that, keeping its
 * shape. A preview drawn at a lower quality has fewer pixels in the same place. This is that layout
 * as numbers, and the two have to stay the same.
 */
export function pictureOnScreen(frame: Size, full: Size, shown: Size): Rect {
  const width = Math.min(frame.width, full.width);
  const height = Math.min(frame.height, full.height);
  const scale = Math.min(width / shown.width, height / shown.height);
  const drawnWidth = shown.width * scale;
  const drawnHeight = shown.height * scale;
  return {
    x: (frame.width - width) / 2 + (width - drawnWidth) / 2,
    y: (frame.height - height) / 2 + (height - drawnHeight) / 2,
    width: drawnWidth,
    height: drawnHeight,
  };
}

/** What the preview shows, as far as where things go on it. */
export interface ScreenSizes {
  /** The frame of the compositor, in CSS pixels. */
  readonly frame: Size;
  /** The pixels of the picture at full quality, which is the room it takes. */
  readonly full: Size;
  /** The pixels the picture is drawn with now. */
  readonly shown: Size;
}

/**
 * From the world to the frame of the compositor, in CSS pixels: the view of the compositor, at the
 * pixels it draws, and those pixels where its picture is. Undefined while there is no picture.
 */
export function worldToScreen(
  plan: Pick<RenderPlan, "camera">,
  { frame, full, shown }: ScreenSizes,
  time: number,
): Matrix | undefined {
  if (!(frame.width > 0 && frame.height > 0 && shown.width > 0 && shown.height > 0))
    return undefined;
  const rect = pictureOnScreen(frame, full, shown);
  const toScreen: Matrix = [
    rect.width / shown.width,
    0,
    0,
    rect.height / shown.height,
    rect.x,
    rect.y,
  ];
  const view = viewMatrix({ width: shown.width, height: shown.height, camera: plan.camera }, time);
  return multiply(toScreen, view);
}
