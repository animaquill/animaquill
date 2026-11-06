import {
  divide,
  multiply,
  parseTime,
  rational,
  toSeconds,
  type Rational,
} from "@animaquill/schema";

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

/** The frame a moment falls in, exactly: a frame lasts from where it starts until the next one. */
export function frameContaining(moment: Rational, rate: FrameRate): number {
  const { n, d } = multiply(moment, rate.exact);
  const whole = n / d;
  return Number(n < 0n && n % d !== 0n ? whole - 1n : whole);
}

export const frameSeconds = (frame: number, rate: FrameRate): number => frame / rate.fps;

const twoDigits = (value: number) => String(value).padStart(2, "0");

/**
 * Hours, minutes and seconds, then the frame after a slash: 2:12/30 and 1:02:12/30. The slash keeps
 * frames from looking like hundredths of a second. Without hours they stay out. Like every editor,
 * it counts frames and not real seconds.
 */
export function formatTimecode(frame: number, { nominal }: FrameRate): string {
  const total = Math.floor(frame / nominal);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor(total / 60) % 60;
  const clock = hours > 0 ? `${hours}:${twoDigits(minutes)}` : String(minutes);
  const digits = String(nominal - 1).length;
  const frames = String(frame % nominal).padStart(digits, "0");
  return `${clock}:${twoDigits(total % 60)}/${frames}`;
}

/**
 * The frame people mean by what they typed: seconds, or a time filled up from the right with the
 * frame after a slash, so 2:12 is two minutes and twelve seconds. The four numbers of a classic
 * timecode, which people paste from other programs, also work. Undefined when it is neither.
 */
export function parseTimecode(text: string, rate: FrameRate): number | undefined {
  const value = text.trim();
  if (/^\d+(\.\d+)?$/.test(value)) return frameAt(Number(value), rate);
  const classic = /^(\d+):(\d+):(\d+):(\d+)$/.exec(value);
  const time = classic ? `${classic.slice(1, 4).join(":")}/${classic[4]}` : value;
  const match = /^(\d+(?::\d+){0,2})(?:\/(\d+))?$/.exec(time);
  if (!match?.[1]) return undefined;
  const [seconds = 0, minutes = 0, hours = 0] = match[1].split(":").map(Number).toReversed();
  return Number(match[2] ?? 0) + rate.nominal * (seconds + 60 * minutes + 3600 * hours);
}
