import { SILENT_DECIBELS, channelOf, numberAt, secondsOf } from "@animaquill/core";
import { isAnimation, type Key, type PropertyValue } from "@animaquill/schema";
import {
  LOUDEST_DECIBELS,
  heightOfVolume,
  roundedVolume,
  volumeOfHeight,
} from "../properties/sound-scale.ts";
import type { Pointer } from "./gestures.ts";
import type { ClipBox } from "./model.ts";

/**
 * The volume line on a clip of sound: where it is and what is under the pointer, without the DOM.
 * The line is the `audio.volume` of the clip over its time, as the mix works it out: up and down
 * as `sound-scale.ts` has a volume on a control, 0 dB a third from the top, silence at the bottom.
 */

export const VOLUME_PATH = "audio.volume";

/** A clip lower than this has no line: there is no room to point at it. */
export const VOLUME_LINE_MIN_HEIGHT = 28;
/** How far from the line, up or down, the pointer is on it. */
export const LINE_REACH = 4;
/** How far from a key the pointer is on it. */
export const KEY_REACH = 6;
/** Half the size of the mark of a key. */
export const KEY_HALF = 3.5;
/** Room at the top and the bottom of the clip, so that the loudest and silence can be reached. */
const INSET = 3;

/**
 * Which modifier adds a key where the line is clicked: Ctrl, or Cmd on a Mac, as in Premiere.
 * One place to change it (see docs/design/audio-mixing.md, section 8, question 1).
 */
export const ADD_KEY_MODIFIER: "mod" | "alt" = "mod";

/** Whether a press adds a key on the line. */
export const addsKey = (pointer: Pick<Pointer, "mod" | "alt">): boolean =>
  pointer[ADD_KEY_MODIFIER];

/** Where a clip is on screen, in pixels: what the line is drawn in. */
export interface LineArea {
  readonly top: number;
  readonly height: number;
}

/** How high a volume is on a clip, in pixels from the top of the timeline area. */
export function yOfVolume(area: LineArea, decibels: number): number {
  const room = Math.max(area.height - INSET * 2, 1);
  return area.top + INSET + (1 - heightOfVolume(decibels)) * room;
}

/** The volume at a height of a clip, exactly, as `yOfVolume` has it the other way round. */
export function volumeAtY(area: LineArea, y: number): number {
  const room = Math.max(area.height - INSET * 2, 1);
  return volumeOfHeight(1 - (y - area.top - INSET) / room);
}

/** Whether a clip shows a line at this height. */
export const showsLine = (height: number): boolean => height >= VOLUME_LINE_MIN_HEIGHT;

/** The volume of a clip over its time: its keys, and what it is at a reading of its clock. */
export interface VolumeLine {
  /** Its keys in order, none when it stays the same. */
  readonly keys: readonly Key[];
  /** Decibels at a reading of the clock of the clip, as the mix has them. */
  at(clock: number): number;
}

const lines = new WeakMap<object, VolumeLine>();
const STILL_LINES = new Map<number, VolumeLine>();

/** The line of a value of `audio.volume`: the same value gives the same line. */
export function volumeLineOf(value: PropertyValue | undefined): VolumeLine {
  if (value !== undefined && isAnimation(value)) {
    const known = lines.get(value);
    if (known) return known;
    const channel = channelOf(value, "number");
    const line: VolumeLine = { keys: value.keys, at: (clock) => numberAt(channel, clock, 0) };
    lines.set(value, line);
    return line;
  }
  const still = typeof value === "number" ? value : 0;
  let line = STILL_LINES.get(still);
  if (!line) {
    line = { keys: [], at: () => still };
    if (STILL_LINES.size > 64) STILL_LINES.clear();
    STILL_LINES.set(still, line);
  }
  return line;
}

/** The gain of a volume line at a reading of the clock, as the mix makes it: none from −96 dB. */
export function gainOfLine(line: VolumeLine, clock: number): number {
  const decibels = line.at(clock);
  return decibels <= SILENT_DECIBELS ? 0 : 10 ** (decibels / 20);
}

/** Where on the timeline a reading of the clock of a clip is, for a clip that starts at `start`. */
export const secondsOfClock = (box: Pick<ClipBox, "offset">, start: number, clock: number) =>
  start + clock - box.offset;

/** What a press on a line is about: a key, or the line between keys. */
export type LineHit =
  | { readonly kind: "key"; readonly time: string }
  /**
   * The line itself, with the keys that go up and down with it: none for a line without keys, the
   * two around the pointer between keys, and the nearest one before the first or after the last.
   */
  | { readonly kind: "line"; readonly keys: readonly string[]; readonly clock: number };

/** How the screen and the clock of a clip go together. */
export interface LineView {
  xAt(seconds: number): number;
  timeAt(x: number): number;
}

/** What is under the pointer on the line of a clip on screen, or nothing. */
export function lineHitAt(
  view: LineView,
  box: ClipBox,
  area: LineArea,
  line: VolumeLine,
  pointer: Pick<Pointer, "x" | "y">,
): LineHit | undefined {
  if (!showsLine(area.height)) return undefined;
  const { keys } = line;
  let nearest: { time: string; distance: number } | undefined;
  for (const key of keys) {
    const x = view.xAt(secondsOfClock(box, box.start, secondsOf(key.time)));
    if (Math.abs(x - pointer.x) > KEY_REACH) continue;
    const y = yOfVolume(area, typeof key.value === "number" ? key.value : 0);
    const distance = Math.hypot(x - pointer.x, y - pointer.y);
    if (distance <= KEY_REACH && (!nearest || distance < nearest.distance)) {
      nearest = { time: key.time, distance };
    }
  }
  if (nearest) return { kind: "key", time: nearest.time };
  const clock = view.timeAt(pointer.x) - box.start + box.offset;
  const y = yOfVolume(area, line.at(clock));
  if (Math.abs(y - pointer.y) > LINE_REACH) return undefined;
  return { kind: "line", keys: keysAround(keys, clock), clock };
}

/** The keys that go up and down with the line at a reading of the clock. */
export function keysAround(keys: readonly Key[], clock: number): readonly string[] {
  if (keys.length === 0) return [];
  const after = keys.findIndex((key) => secondsOf(key.time) > clock);
  if (after === 0) return [(keys[0] as Key).time];
  if (after === -1) return [(keys.at(-1) as Key).time];
  return [(keys[after - 1] as Key).time, (keys[after] as Key).time];
}

/** A volume a key can have: a hand rounds it, and it stays within what the format takes. */
export const keptVolume = (decibels: number): number =>
  roundedVolume(Math.min(decibels, LOUDEST_DECIBELS));

/** What the line reads at a moment, for a key put there: exact, so that nothing sounds otherwise. */
export const exactVolume = (line: VolumeLine, clock: number): number =>
  Number(line.at(clock).toFixed(6));

/** Volumes raised by `by` decibels, each kept within what the format takes. */
export function raisedKeys(keys: readonly Key[], times: readonly string[], by: number): Key[] {
  const moving = new Set(times);
  return keys
    .filter((key) => moving.has(key.time))
    .map((key) => {
      const value = typeof key.value === "number" ? key.value : 0;
      const raised = value <= SILENT_DECIBELS && by <= 0 ? value : keptVolume(value + by);
      return { ...key, value: raised };
    });
}

/** The keys of a line by their time. */
export const keyAt = (line: VolumeLine, time: string): Key | undefined =>
  line.keys.find((key) => key.time === time);
