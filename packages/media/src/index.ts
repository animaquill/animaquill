import { ALL_FORMATS, BlobSource, Input } from "mediabunny";

export {
  formatHash,
  hashFile,
  hashText,
  hashingCopy,
  isSameHash,
  type HashOptions,
} from "./hash.ts";
export {
  containerOf,
  VideoFileWriter,
  type ByteSink,
  type EncodedFrame,
  type SoundCodecName,
  type VideoCodecName,
  type VideoFileOptions,
} from "./video-file.ts";

/** What a file contains, as far as the project cares. */
export interface MediaFacts {
  readonly kind: "video" | "audio" | "image";
  /** Seconds. Pictures have none. */
  readonly duration?: number;
  readonly width?: number;
  readonly height?: number;
  readonly fps?: number;
  readonly sampleRate?: number;
  /** Whether a video has sound, which then gets a clip of its own. */
  readonly hasAudio?: boolean;
}

async function probeImage(file: Blob): Promise<MediaFacts | undefined> {
  try {
    const bitmap = await createImageBitmap(file);
    const { width, height } = bitmap;
    bitmap.close();
    return { kind: "image", width, height };
  } catch {
    return undefined;
  }
}

/** Reads the container only. Nothing gets decoded, so this is quick also for long files. */
async function probeContainer(file: Blob): Promise<MediaFacts | undefined> {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  try {
    const video = await input.getPrimaryVideoTrack();
    const audio = await input.getPrimaryAudioTrack();
    if (!video && !audio) return undefined;
    const duration = await input.computeDuration();
    if (!video) {
      return { kind: "audio", duration, sampleRate: audio?.sampleRate ?? 0 };
    }
    const stats = await video.computePacketStats(100);
    return {
      kind: "video",
      duration,
      width: video.displayWidth,
      height: video.displayHeight,
      fps: stats.averagePacketRate,
      hasAudio: audio !== null,
    };
  } catch {
    return undefined;
  } finally {
    input.dispose();
  }
}

/** Undefined when this browser cannot make sense of the file. */
export async function probeMedia(file: Blob): Promise<MediaFacts | undefined> {
  return file.type.startsWith("image/")
    ? probeImage(file)
    : ((await probeContainer(file)) ?? probeImage(file));
}
