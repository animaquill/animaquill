import { numberAt, type Channel } from "./curve.ts";
import type { SoundLayer } from "./render-plan.ts";

/**
 * What the mix engine plays (`@animaquill/audio`), see `buildMixPlan`. Its own module, with nothing
 * but plain data and functions, because the audio thread loads it: it has none of what the rest of
 * the editor needs.
 */

/** A sound of a mix: a `SoundLayer` on its track, with the gain of its clip alone. */
export interface MixSound extends SoundLayer {
  /**
   * The gain of its clip only, from a volume that stays the same: the track's is `MixTrack.gain`,
   * which comes after. With `volume` it is that instead.
   */
  readonly gain: number;
  /**
   * The volume of its clip when it changes over time: decibels, on the clock of the clip (seconds
   * on the timeline minus `start`, plus `offset`), see `gainAt`.
   */
  readonly volume?: Channel;
  /** Where it sits between left (−1) and right (1), on the clock of the clip. Without, the middle. */
  readonly pan?: Channel;
  readonly track: string;
}

/** A track of sound in a mix, muted or not: what mutes it or soloes it changes on the spot. */
export interface MixTrack {
  readonly id: string;
  /** From a volume that stays the same. With `volume` it is that instead. */
  readonly gain: number;
  /** Its volume when it changes over time: decibels, on the timeline's time, from its start. */
  readonly volume?: Channel;
  /** Its pan, on the timeline's time. Without, the middle. */
  readonly pan?: Channel;
  readonly muted: boolean;
  readonly solo: boolean;
}

/**
 * What a mix plays: every sound of every track of sound, muted or not, and its tracks. What can be
 * heard follows from the tracks, see `audibleTracks`, so that muting and soloing change what plays
 * on the spot, without the sounds starting over.
 */
export interface MixPlan {
  readonly sounds: readonly MixSound[];
  readonly tracks: readonly MixTrack[];
}

/** The tracks of a mix that are heard: with any soloed, those, otherwise all that are not muted. */
export function audibleTracks(tracks: readonly MixTrack[]): ReadonlySet<string> {
  const soloing = tracks.some((track) => track.solo);
  return new Set(
    tracks.filter((track) => (soloing ? track.solo : !track.muted)).map(({ id }) => id),
  );
}

/** A volume at or below this is silence: the bottom of every volume control, "−∞". */
export const SILENT_DECIBELS = -96;

/** The gain of a volume in decibels, as the project format has it: none at all from −96 dB down. */
export const gainOfDecibels = (decibels: number): number =>
  decibels <= SILENT_DECIBELS ? 0 : 10 ** (decibels / 20);

/** Where a moment on the timeline is on the clock of the clip of a sound. */
export const clockOfSound = (sound: Pick<SoundLayer, "start" | "offset">, seconds: number) =>
  seconds - sound.start + sound.offset;

/**
 * The gain of a sound's clip at a moment on the timeline: its volume, worked out in decibels (keys
 * go evenly in decibels, as the volume lines of video editors do), then made a gain. Without its
 * track and its transitions.
 */
export function gainAt(sound: MixSound, seconds: number): number {
  const { volume } = sound;
  return volume ? gainOfDecibels(numberAt(volume, clockOfSound(sound, seconds), 0)) : sound.gain;
}

/** The gain of a track at a moment on the timeline. */
export function trackGainAt(track: MixTrack, seconds: number): number {
  const { volume } = track;
  return volume ? gainOfDecibels(numberAt(volume, seconds, 0)) : track.gain;
}

/** Whether something with this gain and volume can be heard at all. */
export const canSound = ({ gain, volume }: { gain: number; volume?: Channel }): boolean =>
  volume !== undefined || gain > 0;

/** A pan as a number from −1 to 1, whatever is written. */
export const panOf = (value: number): number => (value > 1 ? 1 : value < -1 ? -1 : value || 0);

/**
 * How one channel goes to two at a pan `p`: equal power, with both sides at 0 dB in the middle, so
 * that a sound of one channel in the middle is what it was, and at one side that side is +3 dB and
 * the other silent. θ = (p + 1)·π/4, left √2·cos θ, right √2·sin θ. Into `out` as [left, right].
 */
export function monoPan(p: number, out: Float64Array): void {
  const at = panOf(p);
  if (at === 0) {
    out[0] = 1;
    out[1] = 1;
    return;
  }
  const theta = ((at + 1) * Math.PI) / 4;
  out[0] = Math.SQRT2 * Math.cos(theta);
  out[1] = Math.SQRT2 * Math.sin(theta);
}

/**
 * How two channels go to two at a pan `p`: Web Audio's `StereoPannerNode`, a balance. For p ≤ 0,
 * x = p + 1, left = l + r·cos(x·π/2), right = r·sin(x·π/2); for p > 0, x = p, left = l·cos(x·π/2),
 * right = r + l·sin(x·π/2). In the middle nothing changes. Into `out` as how much of the left goes
 * left, of the right left, of the left right, and of the right right.
 */
export function stereoPan(p: number, out: Float64Array): void {
  const at = panOf(p);
  if (at === 0) {
    out[0] = 1;
    out[1] = 0;
    out[2] = 0;
    out[3] = 1;
    return;
  }
  if (at < 0) {
    const x = ((at + 1) * Math.PI) / 2;
    out[0] = 1;
    out[1] = Math.cos(x);
    out[2] = 0;
    out[3] = Math.sin(x);
  } else {
    const x = (at * Math.PI) / 2;
    out[0] = Math.cos(x);
    out[1] = 0;
    out[2] = Math.sin(x);
    out[3] = 1;
  }
}
