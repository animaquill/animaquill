import type { Levels } from "@animaquill/audio";
import { Emitter } from "../workbench/emitter.ts";
import { CLIPPING, METER_FLOOR, dbfsOf, meterAfter } from "./scale.ts";

/** The meters of the master, by side, among those of the tracks. */
export const MASTER_LEFT = "~master:left";
export const MASTER_RIGHT = "~master:right";

/**
 * What the meters of the mixer show, from what the audio thread measured (see `Levels`): each
 * jumps up to a peak and falls back slowly, and drops to the bottom once playing stops. A clip
 * light stays on until it is clicked, and so does the largest true peak. It belongs to the window,
 * and plays whichever panels are open; the mixer draws it when it is.
 */
export class MixLevels {
  readonly #emitter = new Emitter();
  /** What each meter shows, in dBFS, by track or side of the master. */
  readonly #shown = new Map<string, number>();
  readonly #clipped = new Set<string>();
  #truePeak = Number.NEGATIVE_INFINITY;
  #shortTerm: number | undefined;
  /** What compressors and limiters take off, in dB, by `<clip>/<effect>`. */
  #reductions = new Map<string, number>();
  #last: number | undefined;
  #playing = false;
  #version = 0;

  subscribe = this.#emitter.subscribe;

  /** Changes with everything the meters show. */
  getVersion = (): number => this.#version;

  /** What was measured, at `now` (milliseconds); undefined once playing stops. */
  receive(levels: Levels | undefined, now: number): void {
    if (!levels) {
      if (!this.#playing && this.#shown.size === 0 && this.#shortTerm === undefined) return;
      this.#playing = false;
      this.#shown.clear();
      this.#reductions = new Map();
      this.#shortTerm = undefined;
      this.#last = undefined;
      this.#changed();
      return;
    }
    const seconds = this.#last === undefined ? 0 : Math.max(now - this.#last, 0) / 1000;
    this.#last = now;
    this.#playing = true;
    const seen = new Set<string>();
    const take = (id: string, peak: number) => {
      seen.add(id);
      this.#shown.set(id, meterAfter(this.#shown.get(id) ?? METER_FLOOR, dbfsOf(peak), seconds));
      if (peak >= CLIPPING) this.#clipped.add(id);
    };
    levels.tracks.forEach((track, index) => take(track, levels.peaks[index] ?? 0));
    take(MASTER_LEFT, levels.left);
    take(MASTER_RIGHT, levels.right);
    // A track that went from the plan falls as one that is silent.
    for (const [id, shown] of this.#shown) {
      if (!seen.has(id)) this.#shown.set(id, meterAfter(shown, 0, seconds));
    }
    const truePeak = dbfsOf(levels.truePeak);
    if (truePeak > this.#truePeak) this.#truePeak = truePeak;
    this.#shortTerm = levels.shortTerm;
    this.#reductions = new Map(levels.reductions ?? []);
    this.#changed();
  }

  /**
   * What a compressor or a limiter takes off now, in dB, by the clip it is on (or the clip that
   * stands for its track or the master) and its id; 0 when it is not playing.
   */
  reductionOf(clip: string, effect: string): number {
    return this.#reductions.get(`${clip}/${effect}`) ?? 0;
  }

  /** What a meter shows, in dBFS: `METER_FLOOR` at the bottom. */
  shownOf(id: string): number {
    return this.#shown.get(id) ?? METER_FLOOR;
  }

  /** Whether a meter went to full scale since its light was put out. */
  isClipped(id: string): boolean {
    return this.#clipped.has(id);
  }

  /** Puts out the clip light of a meter. */
  resetClip(id: string): void {
    if (this.#clipped.delete(id)) this.#changed();
  }

  /** The largest true peak of the master since it was reset, in dBTP. */
  get truePeak(): number {
    return this.#truePeak;
  }

  resetTruePeak(): void {
    if (this.#truePeak === Number.NEGATIVE_INFINITY) return;
    this.#truePeak = Number.NEGATIVE_INFINITY;
    this.#changed();
  }

  /** The short-term loudness of the master while playing, in LUFS. */
  get shortTerm(): number | undefined {
    return this.#shortTerm;
  }

  get playing(): boolean {
    return this.#playing;
  }

  #changed(): void {
    this.#version += 1;
    this.#emitter.emit();
  }
}
