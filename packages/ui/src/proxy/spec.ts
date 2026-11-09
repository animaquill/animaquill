/**
 * Which videos of a project get a proxy, a smaller copy for the preview, and what it is like, see
 * the decision of 2026-11-09 and `makeProxy`: at most half the size of the project and 1280×720, at
 * the frame rate of the project, for a video that is larger than the project or has more frames.
 */
import { projectFrameRate, type ProjectState } from "@animaquill/core";
import type { FrameRate, ProxyShape } from "@animaquill/media/proxy";
import { parseTime } from "@animaquill/schema";
import { bitrateFor, codecString } from "../export/codecs.ts";

/** Where proxies are in a project folder: on this computer only, kept out of Git. */
export const PROXY_FOLDER = ".animaquill/proxies";

/** The largest a proxy gets, whichever way it stands: 720p. */
export const MAX_LONG = 1280;
export const MAX_SHORT = 720;

/** How much faster than the project a video can be before it counts as faster, as for 29.97 and 30. */
const FASTER_BY = 0.01;

/** A proxy made another way gets another name, so that old ones are not taken for new ones. */
const RECIPE = "v1";

/** What a video is like as it shows: after turning it the way it says. */
export interface VideoFacts {
  readonly width: number;
  readonly height: number;
  /** Frames per second, about. Unknown for some files. */
  readonly fps?: number | undefined;
}

/** What the preview of a project draws: its first format, at the rate of editing. */
export interface PictureFacts {
  readonly width: number;
  readonly height: number;
  readonly fps: FrameRate;
}

export type ProxySpec = ProxyShape;

/** The rate of a project, reduced, as the format writes it. */
export function rateOf(text: string): FrameRate {
  const { n, d } = parseTime(text);
  return { num: Number(n), den: Number(d) };
}

/** What the preview of a project draws, which is what proxies are made for. */
export function pictureOf(state: ProjectState): PictureFacts | undefined {
  const format = state.manifest.formats[0];
  if (!format) return undefined;
  return {
    width: format.width,
    height: format.height,
    fps: rateOf(projectFrameRate(state.manifest)),
  };
}

const even = (value: number) => Math.max(2, Math.floor(value / 2) * 2);

/**
 * What the proxy of a video is like, or undefined when it needs none: one no larger and no faster
 * than the project decodes no slower than what the preview draws anyway. Sizes go by the long and
 * the short side, so that a video that stands upright in a project that lies gets as many pixels.
 */
export function proxySpecFor(video: VideoFacts, picture: PictureFacts): ProxySpec | undefined {
  const long = Math.max(picture.width, picture.height);
  const short = Math.min(picture.width, picture.height);
  const videoLong = Math.max(video.width, video.height);
  const videoShort = Math.min(video.width, video.height);
  if (!(videoLong > 0 && videoShort > 0)) return undefined;
  const fps = picture.fps.num / picture.fps.den;
  const isLarger = videoLong > long || videoShort > short;
  const isFaster = video.fps !== undefined && video.fps > fps * (1 + FASTER_BY);
  if (!isLarger && !isFaster) return undefined;
  const scale = Math.min(
    1,
    Math.min(MAX_LONG, long / 2) / videoLong,
    Math.min(MAX_SHORT, short / 2) / videoShort,
  );
  return {
    width: even(video.width * scale),
    height: even(video.height * scale),
    fps: picture.fps,
  };
}

/** What a hash of a file looks like in a name: hex, which no system mixes up by case. */
function digestOf(hash: string): string {
  const base64 = hash
    .replace(/^sha256-/, "")
    .replaceAll("-", "+")
    .replaceAll("_", "/");
  try {
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    if (bytes.length >= 12) {
      return [...bytes.subarray(0, 12)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    }
  } catch {
    // Not base64: a hash of another kind, which only has to stay apart from others.
  }
  return [...new TextEncoder().encode(hash)]
    .slice(0, 12)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .padEnd(24, "0");
}

/**
 * The name of the proxy of a file in `PROXY_FOLDER`: by the hash of the file and what the proxy is
 * like, so that a file that changed, or a project of another size or rate, gets another one.
 */
export function proxyName(hash: string, { width, height, fps }: ProxySpec): string {
  const rate = fps.den === 1 ? `${fps.num}` : `${fps.num}_${fps.den}`;
  return `${digestOf(hash)}-${width}x${height}-${rate}-${RECIPE}.mp4`;
}

/** Where a proxy is written until it is whole and checked, see `ProxyFolder`. */
export const partOf = (name: string): string => `${name}.part`;

const MADE = /^[0-9a-f]{24}-\d+x\d+-\d+(?:_\d+)?-v\d+\.mp4(?:\.part)?(?:\.\d+)?(?:\.crswap)?$/;

/**
 * Whether a file in `PROXY_FOLDER` is one the editor makes there: a proxy, of any project size and
 * any way of making them, one on its way, or what writing one left. Nothing else there gets taken
 * away.
 */
export const isMadeHere = (name: string): boolean => MADE.test(name);

/**
 * What to encode a proxy with, best first: H.264 on the graphics card, then on the processor. The
 * level and the bitrate go by its size, as for an export at the smallest quality.
 */
export function proxyEncoders({ width, height, fps }: ProxySpec): VideoEncoderConfig[] {
  const shape = { width, height, fps: fps.num / fps.den };
  const bitrate = bitrateFor(shape, "small");
  const codec = codecString("avc", shape, bitrate);
  return (["prefer-hardware", "prefer-software"] as const).map((hardwareAcceleration) => ({
    codec,
    width,
    height,
    bitrate,
    framerate: shape.fps,
    hardwareAcceleration,
    latencyMode: "quality",
    avc: { format: "avc" },
  }));
}
