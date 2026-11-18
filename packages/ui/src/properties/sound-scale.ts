import { SILENT_DECIBELS } from "@animaquill/core";

/**
 * How volume and pan read and how a volume goes along a control, for the volume line on the
 * timeline and the slider of the properties alike: the same height is the same volume in both.
 */

/** The loudest a volume control goes, which is as far as the format lets a volume go. */
export const LOUDEST_DECIBELS = 24;
/** How high 0 dB is on a control, as a share of it from the bottom: the top third is louder. */
export const UNITY_HEIGHT = 2 / 3;
/**
 * Below 0 dB the height goes with this root of the gain, the way faders of mixers bunch the quiet
 * end together: −6 dB is a little way down, −20 dB about halfway, −96 dB the bottom.
 */
const ROOT = 4;
const FLOOR = 10 ** (SILENT_DECIBELS / (20 * ROOT));
/** What a volume is rounded to when a hand sets it. */
const DECIBEL_STEP = 0.1;

/** How high a volume is on a control, from 0 at the bottom (silent) to 1 at the top (+24 dB). */
export function heightOfVolume(decibels: number): number {
  if (!(decibels > SILENT_DECIBELS)) return 0;
  if (decibels >= 0)
    return UNITY_HEIGHT + (1 - UNITY_HEIGHT) * Math.min(decibels / LOUDEST_DECIBELS, 1);
  const root = 10 ** (decibels / (20 * ROOT));
  return (UNITY_HEIGHT * (root - FLOOR)) / (1 - FLOOR);
}

/** The volume at a height of a control, exactly: the other way round from `heightOfVolume`. */
export function volumeOfHeight(height: number): number {
  if (height >= UNITY_HEIGHT) {
    return ((Math.min(height, 1) - UNITY_HEIGHT) / (1 - UNITY_HEIGHT)) * LOUDEST_DECIBELS;
  }
  if (height <= 0) return SILENT_DECIBELS;
  const root = FLOOR + (height / UNITY_HEIGHT) * (1 - FLOOR);
  return Math.max(20 * ROOT * Math.log10(root), SILENT_DECIBELS);
}

/** A volume as a hand sets it: to a tenth of a decibel, and silence as the format says it. */
export function roundedVolume(decibels: number): number {
  if (!(decibels > SILENT_DECIBELS)) return SILENT_DECIBELS;
  const rounded = Math.round(decibels / DECIBEL_STEP) * DECIBEL_STEP;
  return Number(Math.min(rounded, LOUDEST_DECIBELS).toFixed(1));
}

const MINUS = "−";

/** A volume to read: "−6.0 dB", "+3.5 dB", "0.0 dB", and "−∞ dB" for silence. */
export function formatVolume(decibels: number): string {
  if (!(decibels > SILENT_DECIBELS)) return `${MINUS}∞ dB`;
  const text = Math.abs(decibels).toFixed(1);
  if (text === "0.0") return "0.0 dB";
  return `${decibels < 0 ? MINUS : "+"}${text} dB`;
}

/** What people typed for a volume, or undefined: "−6", "-6 dB", "+3", and "−∞" or "-inf" for silence. */
export function parseVolume(text: string): number | undefined {
  const plain = text
    .normalize("NFKC")
    .replaceAll(MINUS, "-")
    .replace(/db\s*$/iu, "")
    .trim();
  if (/^-?(?:∞|inf(?:inity)?)$/iu.test(plain)) return SILENT_DECIBELS;
  const number = plain === "" ? Number.NaN : Number(plain);
  return Number.isFinite(number) ? number : undefined;
}

/** A pan to read: "C" in the middle, "L 50" halfway left, "R 30". */
export function formatPan(pan: number): string {
  const amount = Math.round(Math.min(Math.abs(pan), 1) * 100);
  if (amount === 0) return "C";
  return `${pan < 0 ? "L" : "R"} ${amount}`;
}

/** What people typed for a pan, or undefined: "L 50", "R30", "C", or a number from −100 to 100. */
export function parsePan(text: string): number | undefined {
  const plain = text.normalize("NFKC").replaceAll(MINUS, "-").trim().toUpperCase();
  if (plain === "C") return 0;
  const side = /^([LR])\s*(\d+(?:\.\d+)?)$/u.exec(plain);
  const amount = side ? Number(side[2]) * (side[1] === "L" ? -1 : 1) : Number(plain);
  if (plain === "" || !Number.isFinite(amount)) return undefined;
  return Math.min(Math.max(amount / 100, -1), 1);
}
