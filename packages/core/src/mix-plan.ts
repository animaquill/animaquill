import type { SoundLayer } from "./render-plan.ts";

/**
 * What the mix engine plays (`@animaquill/audio`), see `buildMixPlan`. Its own module, with nothing
 * but plain data and functions, because the audio thread loads it: it has none of what the rest of
 * the editor needs.
 */

/** A sound of a mix: a `SoundLayer` on its track, with the gain of its clip alone. */
export interface MixSound extends SoundLayer {
  /** The gain of its clip only: the track's is `MixTrack.gain`, which comes after. */
  readonly gain: number;
  readonly track: string;
}

/** A track of sound in a mix, muted or not: what mutes it or soloes it changes on the spot. */
export interface MixTrack {
  readonly id: string;
  readonly gain: number;
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
