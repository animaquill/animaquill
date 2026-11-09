import type { TFunction } from "i18next";
import { textOf } from "../properties/names.ts";

/** What people call a type of resources, see docs/design/libraries.md, "分类". */
export function resourceTypeName(t: TFunction, type: string): string {
  if (type.startsWith("transition.")) {
    return textOf(t, `transitionPanel.types.${type.slice("transition.".length)}`, type);
  }
  if (type.startsWith("effect.")) {
    return textOf(t, `effectPanel.types.${type.slice("effect.".length)}`, type);
  }
  // Dots part keys of the texts, so the types are written with underscores there.
  return textOf(t, `resources.types.${type.replaceAll(".", "_")}`, type);
}
