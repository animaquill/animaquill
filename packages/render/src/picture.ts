import type { Context2D } from "./compose.ts";

/** Something the compositor draws: a picture, a frame of a video, or of a scene. */
export interface Picture {
  readonly width: number;
  readonly height: number;
  /** Draws a part of it, in its pixels, on the same pixels of whatever the matrix says. */
  draw(target: Context2D, x: number, y: number, width: number, height: number): void;
  close(): void;
}

/** What a frame of a video gives to draw it, as mediabunny has it. */
export interface VideoSampleLike {
  readonly displayWidth: number;
  readonly displayHeight: number;
  readonly rotation: number;
  readonly flip: boolean;
  /** Draws a part of it, in pixels as it shows, turned the way the video says. */
  draw(
    target: Context2D,
    sx: number,
    sy: number,
    sWidth: number,
    sHeight: number,
    dx: number,
    dy: number,
    dWidth: number,
    dHeight: number,
  ): void;
  toCanvasImageSource(): CanvasImageSource;
}

/**
 * A frame of a video, as large as the video it is of shows. Of a smaller copy that stands in for a
 * video, `standsFor` is how large that one shows: the frame is drawn that large, so that where things
 * are on the picture does not change, only how sharp they are.
 *
 * What a phone records upright is stored on its side with a note to turn it, and only the sample
 * knows how to read parts of that. Going around it for all the other videos keeps the numbers that
 * reach the canvas the same as for a picture.
 */
export function videoPicture(
  sample: VideoSampleLike,
  standsFor?: { readonly width: number; readonly height: number },
): Picture {
  const width = standsFor?.width ?? sample.displayWidth;
  const height = standsFor?.height ?? sample.displayHeight;
  const scaleX = sample.displayWidth / width;
  const scaleY = sample.displayHeight / height;
  return {
    width,
    height,
    draw(target, x, y, partWidth, partHeight) {
      const sx = x * scaleX;
      const sy = y * scaleY;
      const sw = partWidth * scaleX;
      const sh = partHeight * scaleY;
      if (sample.rotation !== 0 || sample.flip) {
        sample.draw(target, sx, sy, sw, sh, x, y, partWidth, partHeight);
      } else {
        target.drawImage(sample.toCanvasImageSource(), sx, sy, sw, sh, x, y, partWidth, partHeight);
      }
    },
    close() {},
  };
}
