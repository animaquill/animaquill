import type { VideoCodecName } from "@animaquill/media";

/** What a picture of the output takes to encode. */
export interface VideoShape {
  readonly width: number;
  readonly height: number;
  /** Frames per second. */
  readonly fps: number;
}

export type Quality = "small" | "standard" | "high";
export const QUALITIES: readonly Quality[] = ["small", "standard", "high"];

/**
 * Bits per second for 1080p at 30 frames, as the export demo had it, which also had 16 Mbit/s for
 * 60 frames and 45 and 60 for 4K. More pixels and more frames take more, but not in proportion.
 */
const STANDARD_1080P30 = 12e6;
const PIXELS_1080P = 1920 * 1080;
/** Fitted to the demo: 4K takes 3.75 times as much, twice the frames 1.33 times as much. */
const PIXEL_POWER = Math.log(45 / 12) / Math.log(4);
const FRAME_POWER = Math.log(16 / 12) / Math.log(2);
const FACTORS: Readonly<Record<Quality, number>> = { small: 0.6, standard: 1, high: 1.6 };
const MIN_BITRATE = 500_000;

export function bitrateFor({ width, height, fps }: VideoShape, quality: Quality): number {
  const pixels = (width * height) / PIXELS_1080P;
  const raw = STANDARD_1080P30 * pixels ** PIXEL_POWER * (fps / 30) ** FRAME_POWER;
  return Math.max(Math.round((raw * FACTORS[quality]) / 100_000) * 100_000, MIN_BITRATE);
}

/** Level, largest frame in macroblocks, macroblocks per second, kbit/s of the High profile. */
const AVC_LEVELS: readonly (readonly [number, number, number, number])[] = [
  [31, 3600, 108_000, 17_500],
  [32, 5120, 216_000, 25_000],
  [40, 8192, 245_760, 25_000],
  [41, 8192, 245_760, 62_500],
  [42, 8704, 522_240, 62_500],
  [50, 22_080, 589_824, 168_750],
  [51, 36_864, 983_040, 300_000],
  [52, 36_864, 2_073_600, 300_000],
  [60, 139_264, 4_177_920, 300_000],
  [61, 139_264, 8_355_840, 300_000],
  [62, 139_264, 16_711_680, 1_000_000],
];

/** Level, largest picture in samples, samples per second. VP9 and AV1 count the same way. */
const VP9_LEVELS: readonly (readonly [string, number, number])[] = [
  ["31", 1_065_024, 73_728_000],
  ["40", 2_228_224, 83_558_400],
  ["41", 2_228_224, 160_432_128],
  ["50", 8_912_896, 311_951_360],
  ["51", 8_912_896, 588_251_136],
  ["52", 8_912_896, 1_176_502_272],
  ["60", 35_651_584, 1_176_502_272],
  ["61", 35_651_584, 2_353_004_544],
  ["62", 35_651_584, 4_706_009_088],
];
const AV1_LEVELS: readonly (readonly [string, number, number])[] = [
  ["05", 1_065_024, 79_902_720],
  ["08", 2_228_224, 133_693_440],
  ["09", 2_228_224, 267_386_880],
  ["12", 8_912_896, 534_773_760],
  ["13", 8_912_896, 1_069_547_520],
  ["14", 8_912_896, 2_139_095_040],
  ["16", 35_651_584, 2_139_095_040],
  ["17", 35_651_584, 4_278_190_080],
  ["18", 35_651_584, 8_556_380_160],
];

const hex = (value: number) => value.toString(16).padStart(2, "0").toUpperCase();

/**
 * The string WebCodecs takes for a codec, with the lowest level that holds this video: players go by
 * the level to decide whether they can play a file at all, so it should not claim more than it needs.
 */
export function codecString(codec: VideoCodecName, shape: VideoShape, bitrate: number): string {
  const { width, height, fps } = shape;
  if (codec === "avc") {
    const blocks = Math.ceil(width / 16) * Math.ceil(height / 16);
    const level =
      AVC_LEVELS.find(
        ([, frame, rate, kbits]) =>
          blocks <= frame && blocks * fps <= rate && bitrate <= kbits * 1000,
      ) ?? AVC_LEVELS.at(-1);
    return `avc1.6400${hex(level?.[0] ?? 62)}`;
  }
  const samples = width * height;
  const fits = ([, size, rate]: readonly [string, number, number]) =>
    samples <= size && samples * fps <= rate;
  if (codec === "vp9") {
    const [level] = VP9_LEVELS.find(fits) ?? VP9_LEVELS.at(-1) ?? ["62"];
    return `vp09.00.${level}.08`;
  }
  const [level] = AV1_LEVELS.find(fits) ?? AV1_LEVELS.at(-1) ?? ["18"];
  return `av01.0.${level}M.08`;
}

/** Best first. */
export const CODECS: readonly VideoCodecName[] = ["avc", "vp9", "av1"];

export interface VideoEncoding {
  readonly codec: VideoCodecName;
  /** Whether the graphics card does it, which is much faster and goes easy on the battery. */
  readonly acceleration: "hardware" | "software";
  readonly config: VideoEncoderConfig;
}

export type SupportCheck = (config: VideoEncoderConfig) => Promise<boolean>;

export const browserSupport: SupportCheck = async (config) => {
  if (typeof VideoEncoder === "undefined") return false;
  try {
    return (await VideoEncoder.isConfigSupported(config)).supported === true;
  } catch {
    return false;
  }
};

const ACCELERATIONS = [
  ["hardware", "prefer-hardware"],
  ["software", "prefer-software"],
] as const;

/** The same codec on the other kind of encoder, for when the first one cannot be started. */
export function inSoftware(encoding: VideoEncoding): VideoEncoding {
  return {
    ...encoding,
    acceleration: "software",
    config: { ...encoding.config, hardwareAcceleration: "prefer-software" },
  };
}

/**
 * The first codec this browser can encode the video with, or nothing at all. For each codec the
 * graphics card comes first, as in the export demo, and then the processor. A graphics card that
 * failed at a codec here before does not get it again: the processor is slower, but it finishes.
 */
export async function chooseEncoding(
  shape: VideoShape,
  quality: Quality,
  supported: SupportCheck = browserSupport,
  noHardware: ReadonlySet<VideoCodecName> = new Set(),
): Promise<VideoEncoding | undefined> {
  const bitrate = bitrateFor(shape, quality);
  for (const codec of CODECS) {
    for (const [acceleration, hardwareAcceleration] of ACCELERATIONS) {
      if (acceleration === "hardware" && noHardware.has(codec)) continue;
      const config: VideoEncoderConfig = {
        codec: codecString(codec, shape, bitrate),
        width: shape.width,
        height: shape.height,
        bitrate,
        framerate: shape.fps,
        hardwareAcceleration,
        latencyMode: "quality",
        ...(codec === "avc" && { avc: { format: "avc" as const } }),
      };
      if (await supported(config)) return { codec, acceleration, config };
    }
  }
  return undefined;
}
