import { effectsOf, type ClipState } from "@animaquill/core";
import { parseTime, toSeconds } from "@animaquill/schema";

/** What goes between the names of effects on the band of a clip. */
export const EFFECT_NAMES_SEPARATOR = " · ";

/**
 * The band at the bottom of a clip with effects: where on the clip they work, as one band over all
 * of them, with the types of those it is about. Nothing here touches the DOM.
 */
export interface EffectBand {
  /** Seconds from the start of the clip, in order, apart from each other. */
  readonly spans: readonly (readonly [from: number, to: number])[];
  /** The types of the effects that it shows, in their order, each once. */
  readonly types: readonly string[];
  /** All of them are off: the band shows where they would work, dimmed. */
  readonly off: boolean;
}

/**
 * The band of a clip, or nothing for a clip without effects. One band for all of them keeps the
 * clip readable however many it has: it covers where any of those that are on works, or where any
 * would, when all are off. What works nowhere takes none of it, and is not named on it.
 */
export function effectBandOf(clip: ClipState): EffectBand | undefined {
  const effects = effectsOf(clip);
  if (effects.length === 0) return undefined;
  const on = effects.filter(({ enabled }) => enabled !== false);
  const shown = on.length > 0 ? on : effects;
  const length = toSeconds(parseTime(clip.duration));
  const within = (seconds: number) => Math.min(Math.max(seconds, 0), length);
  const working = shown
    .map(({ type, start, end }) => ({
      type,
      span: [
        start === undefined ? 0 : within(toSeconds(parseTime(start))),
        end === undefined ? length : within(toSeconds(parseTime(end))),
      ] as [number, number],
    }))
    .filter(({ span: [from, to] }) => to > from);
  const spans = working.map(({ span }) => span).toSorted((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const [from, to] of spans) {
    const last = merged.at(-1);
    if (last && from <= last[1]) last[1] = Math.max(last[1], to);
    else merged.push([from, to]);
  }
  const types = [...new Set(working.map(({ type }) => type))];
  return { spans: merged, types, off: on.length === 0 };
}
