import type { TransitionMedia, TransitionRef, TransitionUse } from "@animaquill/schema";
import type { TFunction } from "i18next";
import { textOf } from "../properties/names.ts";

/**
 * What people call a transition, where it is: the ones that come with the editor have names by use,
 * such as 淡入 and 淡出 for a fade. Any other shows as what the project calls it.
 */
export function transitionName(
  t: TFunction,
  transition: TransitionRef,
  use: TransitionUse,
  media: TransitionMedia,
): string {
  const { type, variant } = transition;
  if (type === undefined) return transition.transition ?? transition.resource ?? "";
  const kind = variant === undefined ? type : `${type}.${variant}`;
  const fallback = variant === undefined ? type : `${type} ${variant}`;
  // A name with a dot in it comes from a plugin, and would not be a key of the texts.
  if (type.includes(".")) return fallback;
  return textOf(t, `transition.names.${media}.${kind}.${use}`, fallback);
}
