import type { RenderLayer } from "@animaquill/core";
import type { PendingFrame } from "./frame-loop.ts";

/** What reading the frame of a video layer needs of the compositor. */
export interface VideoLayerParts<Video, Sample> {
  /** The file an id reads now. */
  fileOf(id: string): Blob | undefined;
  /** The opened video of a file, or undefined when it cannot be opened. */
  videoOf(id: string, file: Blob): Promise<Video | undefined>;
  /** The frame of a clip at a moment, and whether decoding had to start at a key frame for it. */
  frameAt(
    layer: RenderLayer,
    id: string,
    video: Video,
    seconds: number,
  ): Promise<{ readonly frame: Sample | undefined; readonly cold: boolean }>;
  /** Reading the video failed, which may say something about its file. */
  readFailed(id: string, file: Blob, video: Video, error: unknown): void;
}

/** The frame of a video layer, read from a video, which may have had to start at a key frame. */
export interface VideoLayerFrame<Video, Sample> {
  readonly video: Video;
  readonly sample: Sample | undefined;
  readonly cold: boolean;
}

/**
 * The frame of a video layer for a frame of the picture, from the file the id reads, or undefined
 * when there is nothing to draw. A frame that the playhead left while the file was opened is given
 * up: the playhead does not wait for it. So is one whose file another one took the place of while it
 * was opened or read, as a stand-in does of a video: drawn without this layer the picture would
 * flicker, and the next frame has the new file.
 */
export async function videoLayerFrame<Video, Sample>(
  parts: VideoLayerParts<Video, Sample>,
  layer: RenderLayer,
  id: string,
  file: Blob,
  frame: PendingFrame,
): Promise<VideoLayerFrame<Video, Sample> | undefined> {
  const isReplaced = () => parts.fileOf(id) !== file;
  const video = await parts.videoOf(id, file);
  // Opening the file takes a while, and the playhead does not wait for it.
  if (frame.jumped || isReplaced()) frame.givenUp = true;
  if (!video || frame.givenUp) return undefined;
  let read: Awaited<ReturnType<typeof parts.frameAt>>;
  try {
    read = await parts.frameAt(layer, id, video, frame.seconds);
  } catch (error) {
    // What was read was let go of for the new file: nothing wrong with either of them.
    if (isReplaced()) {
      frame.givenUp = true;
      return undefined;
    }
    parts.readFailed(id, file, video, error);
    throw error;
  }
  if (isReplaced()) {
    frame.givenUp = true;
    return undefined;
  }
  return { video, sample: read.frame, cold: read.cold };
}
