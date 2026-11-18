import {
  BUILT_IN_EFFECTS,
  EFFECT_CATEGORIES,
  type EffectCategory,
  type EffectMedia,
} from "@animaquill/schema";
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
