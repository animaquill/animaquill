import { divide, parseTime, rational, toSeconds, type Rational } from "@animaquill/schema";

/** The frame rate of what is being edited. Whatever people place lands on its frames. */
export interface FrameRate {
  readonly exact: Rational;
  /** Frames per second as a float, for drawing. */
  readonly fps: number;
  /** What a timecode counts to: 30 for 29.97. */
  readonly nominal: number;
}

export function frameRate(text: string): FrameRate {
  const exact = parseTime(text);
  const fps = toSeconds(exact);
  return { exact, fps, nominal: Math.round(fps) };
}

/** The frame nearest to a moment. */
export const frameAt = (seconds: number, rate: FrameRate): number => Math.round(seconds * rate.fps);

/** The exact moment a frame starts, for what gets saved. */
export const frameTime = (frame: number, rate: FrameRate): Rational =>
  divide(rational(BigInt(frame)), rate.exact);

export const frameSeconds = (frame: number, rate: FrameRate): number => frame / rate.fps;

const twoDigits = (value: number) => String(value).padStart(2, "0");

/** Hours, minutes, seconds and frames. Like every editor, it counts frames and not real seconds. */
export function formatTimecode(frame: number, { nominal }: FrameRate): string {
  const seconds = Math.floor(frame / nominal);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds / 60) % 60;
  return [hours, minutes, seconds % 60, frame % nominal].map(twoDigits).join(":");
}
