import {
  BUILT_IN_EFFECTS,
  EFFECT_CATEGORIES,
  type EffectCategory,
  type EffectMedia,
} from "@animaquill/schema";
import type { ProjectState } from "@animaquill/core";
import type { TFunction } from "i18next";
import { textOf } from "../properties/names.ts";
import type { Resource } from "./resources.ts";

/** What the effects tab knows of each effect it lists. */
export interface EffectItem {
  /** As the project writes it. */
  readonly type: string;
  readonly category: EffectCategory;
}

/** The kinds of effects for sound: the others are for pictures. */
const SOUND_CATEGORIES: ReadonlySet<EffectCategory> = new Set(["eq", "dynamics", "space"]);

/** Whether an effect of the list is one of sound. */
export const isSoundEffect = (item: EffectItem): boolean => SOUND_CATEGORIES.has(item.category);

/** The types of effects of a tab, by what they do, in the order people see them. */
export const effectResourceTypes = (media: EffectMedia): readonly string[] =>
  EFFECT_CATEGORIES.filter(
    (category) => SOUND_CATEGORIES.has(category) === (media === "sound"),
  ).map((category) => `effect.${category}`);

/** The types of effects of pictures, which the effects tab has. */
export const EFFECT_RESOURCE_TYPES: readonly string[] = effectResourceTypes("picture");

/** What people call an effect. One with a dot comes from a plugin, and is called as it is written. */
export const effectName = (t: TFunction, type: string): string =>
  type.includes(".") ? type : textOf(t, `effect.names.${type}`, type);

/**
 * The effects that come with the editor for pictures or for sound, as the project writes them: the
 * effects tab has those of pictures, the tab of sound effects the others. Those of the project and
 * of libraries come with their own lists later, see `ResourceSource`.
 */
export function builtInEffects(
  t: TFunction,
  media: EffectMedia = "picture",
): readonly Resource<EffectItem>[] {
  const entries = Object.entries(BUILT_IN_EFFECTS).filter(([, spec]) => spec.media.includes(media));
  return entries.map(([type, spec]) => {
    const tags = textOf(t, `effectPanel.tags.${type}`, "");
    return {
      id: `effect:built-in:${type}`,
      source: { kind: "built-in" },
      type: `effect.${spec.category}`,
      name: effectName(t, type),
      tags: tags ? tags.split("、") : [],
      keywords: [type, t(`effectPanel.types.${spec.category}`)],
      data: { type, category: spec.category },
    };
  });
}

const usedTypes = new WeakMap<ProjectState, ReadonlySet<string>>();

/**
 * The types of effects that the project uses anywhere: on clips, and on tracks, buses and the
 * master, as the mixer has them. What "本项目" lists of effects, see the explorer. Once for each
 * state of the project.
 */
export function effectTypesUsed(state: ProjectState): ReadonlySet<string> {
  const known = usedTypes.get(state);
  if (known) return known;
  const types = new Set<string>();
  const take = (effects: Iterable<{ readonly type?: string | undefined }> | undefined) => {
    for (const { type } of effects ?? []) if (typeof type === "string") types.add(type);
  };
  for (const timeline of Object.values(state.timelines)) {
    for (const clip of Object.values(timeline.clips)) take(Object.values(clip.effects ?? {}));
    for (const track of Object.values(timeline.tracks)) {
      if (track.kind === "audio") take(track.effects);
    }
    for (const bus of timeline.mix?.buses ?? []) take(bus.effects);
    take(timeline.mix?.master?.effects);
  }
  usedTypes.set(state, types);
  return types;
}
