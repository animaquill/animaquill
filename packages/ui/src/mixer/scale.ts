import { SILENT_DECIBELS } from "@animaquill/core";
import {
  heightOfVolume,
  roundedVolume,
  UNITY_HEIGHT,
  volumeOfHeight,
} from "../properties/sound-scale.ts";

/**
 * How the mixer's faders, knobs and meters go, apart from any screen: the fader has the scale of
 * the volume slider and the volume line (`sound-scale.ts`), so that the same height is the same
 * volume everywhere.
 */

/** How far a drag with Shift goes, against one without: a tenth, to set a value exactly. */
export const FINE = 0.1;
/** How close to 0 dB a drag of the fader sticks to it, in pixels. */
const UNITY_REACH = 4;

/**
 * Where a fader goes as the pointer moves down (up is louder), before it sticks to 0 dB: see
 * `stuckFader`. Shift goes a tenth as far, from wherever it is, also halfway through a drag.
 */
export function faderAfterDrag(
  height: number,
  /** How far the pointer went down since the last move, in pixels. */
  down: number,
  /** How tall the travel of the fader is, in pixels. */
  travel: number,
  fine: boolean,
): number {
  if (travel <= 0) return height;
  return Math.min(Math.max(height - (down / travel) * (fine ? FINE : 1), 0), 1);
}

/** A fader near 0 dB sticks to it, unless Shift sets it exactly. */
export function stuckFader(height: number, travel: number, fine: boolean): number {
  return !fine && Math.abs(height - UNITY_HEIGHT) * travel <= UNITY_REACH ? UNITY_HEIGHT : height;
}

/** The volume of a fader at a height, as a hand sets it. */
export const volumeOfFader = (height: number): number => roundedVolume(volumeOfHeight(height));

/** How high a fader is for a volume. */
export const faderOfVolume = (decibels: number): number => heightOfVolume(decibels);

/** How far up or down a knob turns all the way, from left to right, in pixels. */
const KNOB_TRAVEL = 200;
/** How close to the middle a turn of the knob sticks to it. */
const MIDDLE_REACH = 0.03;

/**
 * Where a pan knob goes as the pointer moves down (left) or up (right), as audio software has
 * knobs, before it sticks to the middle: see `stuckPan`. Shift goes a tenth as far.
 */
export function panAfterDrag(pan: number, down: number, fine: boolean): number {
  return Math.min(Math.max(pan - (down * 2 * (fine ? FINE : 1)) / KNOB_TRAVEL, -1), 1);
}

/** A pan as a hand sets it: to a hundredth, and near the middle the middle, unless with Shift. */
export function stuckPan(pan: number, fine: boolean): number {
  if (!fine && Math.abs(pan) <= MIDDLE_REACH) return 0;
  return Math.round(pan * 100) / 100;
}

/** How far a knob is turned for a pan, in degrees from straight up: −135 left to 135 right. */
export const knobAngle = (pan: number): number => Math.min(Math.max(pan, -1), 1) * 135;

/** The bottom of a meter, in dBFS. */
export const METER_FLOOR = -60;
/** Where the colour of a meter changes: green below the first, yellow up to the second, red above. */
export const METER_ZONES = [-18, -6] as const;
/** A sample at or above full scale lights the clip light. */
export const CLIPPING = 1;

/** A level (a sample, not in dB) in dBFS, −Infinity for silence. */
export const dbfsOf = (level: number): number =>
  level > 0 ? 20 * Math.log10(level) : Number.NEGATIVE_INFINITY;

/** How high a meter is for a level in dBFS: from 0 at the floor to 1 at full scale. */
export function meterHeight(dbfs: number): number {
  if (!(dbfs > METER_FLOOR)) return 0;
  return Math.min((dbfs - METER_FLOOR) / -METER_FLOOR, 1);
}

/** Which colour the top of a meter is at a level in dBFS. */
export function meterZone(dbfs: number): "low" | "mid" | "high" {
  const [mid, high] = METER_ZONES;
  if (dbfs >= high) return "high";
  return dbfs >= mid ? "mid" : "low";
}

/** How fast a meter falls back, in dB a second: slow enough to read, as peak meters do. */
export const FALL_PER_SECOND = 20;

/** What a meter shows after `seconds`, with a new peak: it jumps up, and falls back slowly. */
export function meterAfter(shown: number, peak: number, seconds: number): number {
  const fallen = shown - FALL_PER_SECOND * seconds;
  return Math.max(peak, fallen, METER_FLOOR);
}

const MINUS = "−";

/** A volume on a strip, without its unit: "−3.0", "0.0", "+2.5", "−∞". */
export function faderText(decibels: number): string {
  if (!(decibels > SILENT_DECIBELS)) return `${MINUS}∞`;
  const text = Math.abs(decibels).toFixed(1);
  if (text === "0.0") return text;
  return `${decibels < 0 ? MINUS : "+"}${text}`;
}

/** A loudness or a true peak to read: "−14.2", and "−∞" for silence. */
export function levelText(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return `${MINUS}∞`;
  const text = Math.abs(value).toFixed(1);
  if (text === "0.0") return text;
  return `${value < 0 ? MINUS : "+"}${text}`;
}
