import type { ImageFrame } from "@animaquill/agent";

/**
 * Pictures that go with a message to AI: a frame of the project, rendered as the export renders it
 * (docs/design/settings-and-properties.md of AnimaQuill Cloud, 10.3), or a picture people add. As
 * small as a model reads them, as JPEG.
 */

/** How large a frame goes at most, on its longer side; "original" leaves it as the project has it. */
export type ShotSize = 1024 | 1568 | "original";
export const SHOT_SIZES: readonly ShotSize[] = [1024, 1568, "original"];
/**
 * 1568 pixels is what Anthropic says is the most a picture should have on its longer side: a larger
 * one is made smaller by the service first, and only costs more. The others take about as much.
 */
export const DEFAULT_SHOT_SIZE: ShotSize = 1568;

/** A picture people add goes at most this large: no model reads more of it. */
export const ADDED_SIDE = 2048;

/** The qualities a picture is tried at, until it fits; then it is made smaller. */
export const SHOT_QUALITIES: readonly number[] = [0.85, 0.7];
/** How much smaller a picture gets each time it does not fit at any quality. */
const SHRINK = 0.8;
/** It never gets smaller than this on its longer side. */
const SMALLEST = 256;

/**
 * The largest picture a model takes where it does not say, in bytes: Anthropic takes 5 MB of base64,
 * which is 3.75 MB of picture. Others take more.
 */
export const DEFAULT_IMAGE_BYTES = 3_750_000;

/** At most this many pictures go with one message. */
export const MOST_PICTURES = 8;

/** A size made to fit `side` on its longer side, never larger than it was. */
export function fitSize(
  width: number,
  height: number,
  side: number | undefined,
): { readonly width: number; readonly height: number } {
  const scale = side === undefined ? 1 : Math.min(1, side / Math.max(width, height, 1));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** Encodes a picture at a size and a quality. */
export type ShotEncoder = (width: number, height: number, quality: number) => Promise<Blob>;

/**
 * The picture as JPEG at its size and the best quality that fits `maxBytes`; where none does, made
 * smaller until it fits, or as small as it goes.
 */
export async function compressShot(
  encode: ShotEncoder,
  width: number,
  height: number,
  maxBytes: number,
): Promise<{ readonly blob: Blob; readonly width: number; readonly height: number }> {
  let size = { width, height };
  for (;;) {
    let blob: Blob | undefined;
    for (const quality of SHOT_QUALITIES) {
      blob = await encode(size.width, size.height, quality);
      if (blob.size <= maxBytes) return { blob, ...size };
    }
    const side = Math.max(size.width, size.height);
    if (side <= SMALLEST || !blob) return { blob: blob as Blob, ...size };
    size = fitSize(size.width, size.height, Math.max(SMALLEST, Math.floor(side * SHRINK)));
  }
}

/** In the browser: a picture drawn on a canvas of its own, as JPEG. */
export function canvasShotEncoder(image: CanvasImageSource): ShotEncoder {
  return async (width, height, quality) => {
    const canvas = new OffscreenCanvas(width, height);
    const painter = canvas.getContext("2d");
    if (!painter) throw new Error("No 2D context");
    // JPEG has no transparency: what is not drawn is black, as in the export.
    painter.fillStyle = "#000";
    painter.fillRect(0, 0, width, height);
    painter.imageSmoothingQuality = "high";
    painter.drawImage(image, 0, 0, width, height);
    return canvas.convertToBlob({ type: "image/jpeg", quality });
  };
}

/** A frame or a picture, ready to keep: as small as `side` and `maxBytes` say. */
export async function shotOf(
  image: ImageBitmap,
  side: number | undefined,
  maxBytes: number,
): Promise<{ readonly blob: Blob; readonly width: number; readonly height: number }> {
  const size = fitSize(image.width, image.height, side);
  return compressShot(canvasShotEncoder(image), size.width, size.height, maxBytes);
}

/** What a frame is of, for the line that goes with it to AI and for people. */
export type FrameOf = ImageFrame;

/** The line that goes with a picture to AI, in English as all words to AI. */
export function pictureNote(
  number: number,
  picture: { readonly width: number; readonly height: number; readonly frame?: FrameOf },
): string {
  const { frame, width, height } = picture;
  if (!frame) return `[image ${number}: a picture the user added, ${width}×${height}]`;
  const named =
    frame.timelineName && frame.timelineName !== frame.timeline
      ? `"${frame.timelineName}" (${frame.timeline})`
      : frame.timeline;
  return `[image ${number}: the frame of timeline ${named} at t=${frame.t} (${frame.timecode}), as the export renders it, ${width}×${height}]`;
}

/** A size of a file as people read it. */
export function bytesText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
