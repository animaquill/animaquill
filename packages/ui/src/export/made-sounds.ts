import { readSound, SoundFailed, type SoundSource } from "@animaquill/audio";
import { madeSoundsOf, type ProjectState, type SoundLayer } from "@animaquill/core";
import type { MediaStore } from "@animaquill/host";
import type { MadeSounds, SoundFailure } from "../media/sounds.ts";

/** Code did not make a sound that a mix needs, and without it the mix would sound wrong. */
export class SoundNotMade extends Error {
  readonly sound: SoundLayer;
  readonly why: SoundFailure;

  constructor(sound: SoundLayer, why: SoundFailure) {
    super(`Sound ${sound.id} not made: ${why}`);
    this.sound = sound;
    this.why = why;
  }
}

/** Ends as soon as people ask for it. What it was waiting for gets stopped by whoever called this. */
export function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) reject(signal.reason);
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    work.then(resolve, reject);
  });
}

/**
 * Where the sounds made by code of a timeline come from in a mix, as the export mixes them: a sound
 * made by code is a file like any other once it is there, made from this state; it waits for it,
 * and says so with `making`. The export and what AI hears (`aq_audio_analyze`) mix with this.
 */
export function madeSoundSource(options: {
  readonly state: ProjectState;
  readonly timeline: string;
  readonly project: string;
  readonly media: Pick<MediaStore, "get">;
  readonly sounds: Pick<MadeSounds, "whenMade">;
  readonly signal: AbortSignal;
  readonly making?: (busy: boolean) => void;
}): SoundSource {
  const { state, timeline, project, media, sounds, signal, making } = options;
  const made = new Map(madeSoundsOf(state, timeline).map((each) => [each.file, each]));
  return async (layer) => {
    const wanted = layer.made && made.get(layer.file);
    if (!wanted) return undefined;
    making?.(true);
    const outcome = await untilAborted(
      sounds.whenMade(wanted, state, project, signal),
      signal,
    ).finally(() => making?.(false));
    if (outcome.state === "failed") throw new SoundNotMade(layer, outcome.reason);
    const wav = await media.get(layer.file).catch(() => undefined);
    if (!wav) throw new SoundFailed(layer, "missing-file");
    return (from, to) => readSound(wav, from, to);
  };
}
