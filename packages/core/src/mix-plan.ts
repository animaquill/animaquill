import { BUILT_IN_SOUND_EFFECTS } from "@animaquill/schema/effects";
import { BUILT_IN_PROPERTIES } from "@animaquill/schema/properties";
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
  /**
   * Its effects in the order they work, on the sound of its file before its transitions: those that
   * are on and that this editor has. Their keys are on the clock of the clip. Without, none.
   */
  readonly effects?: readonly MixEffect[];
}

/**
 * An effect of sound as the mix engine runs it (see `BUILT_IN_SOUND_EFFECTS`): every parameter, a
 * number (switches are 0 or 1, choices their number), still or with keys. A parameter with keys is
 * read every `PARAMETER_STEP` samples.
 */
export interface MixEffect {
  /** Its id where it is, which is how the engine keeps its memory while it gets changed. */
  readonly id: string;
  readonly type: string;
  readonly params: Readonly<Record<string, Channel>>;
  /**
   * Only on clips: when it works, in seconds on the timeline, from `from` up to `to`. Outside it
   * the sound goes through as it is; inside it starts from nothing at `from`.
   */
  readonly from?: number;
  readonly to?: number;
}

/**
 * Effects with keys take a value every this many samples of the mix, from sample 0 of the timeline
 * on: the value at the moment of sample 32·k holds for samples 32·k up to 32·k + 31.
 */
export const PARAMETER_STEP = 32;

/** The master of a mix: after all tracks are added up. */
export interface MixMaster {
  readonly effects?: readonly MixEffect[];
  /** From a volume that stays the same. With `volume` it is that instead. */
  readonly gain: number;
  /** Its volume with keys, on the time of the timeline. */
  readonly volume?: Channel;
  /** The safe limiter at its end, with its ceiling in dBTP. Without, it is off. */
  readonly limit?: { readonly ceiling: number };
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
  /** Its effects, before its volume, on the timeline's time. Without, none. */
  readonly effects?: readonly MixEffect[];
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
  /** Without, the tracks add up and that is it: no effects, no volume and no limiter. */
  readonly master?: MixMaster;
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

/** The loudest a volume goes, as the format has it: louder, as keys that go on can get, is that. */
const LOUDEST = BUILT_IN_PROPERTIES["audio.volume"]?.max ?? 0;
const PAN = BUILT_IN_PROPERTIES["audio.pan"];
const LEFTMOST = PAN?.min ?? 0;
const RIGHTMOST = PAN?.max ?? 0;

/**
 * The gain of a volume in decibels, as the project format has it: none at all from −96 dB down (and
 * for what is no number), and no more than at the loudest a volume can be.
 */
export const gainOfDecibels = (decibels: number): number =>
  decibels > SILENT_DECIBELS ? 10 ** (Math.min(decibels, LOUDEST) / 20) : 0;

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

/** A pan within what the format takes (−1 to 1), whatever is written or keys go on to. */
export const panOf = (value: number): number =>
  value > RIGHTMOST ? RIGHTMOST : value < LEFTMOST ? LEFTMOST : value || 0;

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

/**
 * The value of a parameter of an effect at a reading of its clock, within the range that the effect
 * gives it, whatever keys go on to.
 */
export function effectParamAt(effect: MixEffect, name: string, clock: number): number {
  const channel = effect.params[name];
  const spec = BUILT_IN_SOUND_EFFECTS[effect.type]?.properties.find(({ path }) => path === name);
  const preset = spec?.default;
  const fallback =
    typeof preset === "number"
      ? preset
      : typeof preset === "string"
        ? Number(preset) || 0
        : preset === true
          ? 1
          : 0;
  if (!channel) return fallback;
  const value =
    channel.kind === "still" ? (channel.value as number) : numberAt(channel, clock, fallback);
  if (!Number.isFinite(value)) return fallback;
  const min = spec?.min ?? -Infinity;
  const max = spec?.max ?? Infinity;
  return value < min ? min : value > max ? max : value;
}

/** Whether a parameter of an effect has keys, so that it gets read again as the mix goes. */
export const effectParamMoves = (effect: MixEffect, name: string): boolean =>
  effect.params[name]?.kind === "curve";

/** The range a parameter of a sound effect takes, from the effect's description. */
export function effectParamRange(type: string, name: string): readonly [number, number] {
  const spec = BUILT_IN_SOUND_EFFECTS[type]?.properties.find(({ path }) => path === name);
  return [spec?.min ?? 0, spec?.max ?? 0];
}

/** The effects of sound there are, see `@animaquill/schema/effects`. */
export { BUILT_IN_SOUND_EFFECTS };
