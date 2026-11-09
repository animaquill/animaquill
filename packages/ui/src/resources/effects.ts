import { BUILT_IN_EFFECTS, EFFECT_CATEGORIES, type EffectCategory } from "@animaquill/schema";
import type { TFunction } from "i18next";
import { textOf } from "../properties/names.ts";
import type { Resource } from "./resources.ts";

/** What the effects tab knows of each effect it lists. */
export interface EffectItem {
  /** As the project writes it. */
  readonly type: string;
  readonly category: EffectCategory;
}

/** The types of effects, by what they do, in the order people see them. */
export const EFFECT_RESOURCE_TYPES: readonly string[] = EFFECT_CATEGORIES.map(
  (category) => `effect.${category}`,
);

/** What people call an effect. One with a dot comes from a plugin, and is called as it is written. */
export const effectName = (t: TFunction, type: string): string =>
  type.includes(".") ? type : textOf(t, `effect.names.${type}`, type);

/**
 * The effects that come with the editor, as the project writes them. Those of the project and of
 * libraries come with their own lists later, see `ResourceSource`.
 */
export function builtInEffects(t: TFunction): readonly Resource<EffectItem>[] {
  return Object.entries(BUILT_IN_EFFECTS).map(([type, spec]) => {
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
