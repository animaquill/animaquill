import {
  BUILT_IN_TRANSITIONS,
  variantsOf,
  type TransitionRef,
  type TransitionUse,
} from "@animaquill/schema";
import type { TFunction } from "i18next";
import type { MenuItem } from "../app/Menu.tsx";
import { transitionName } from "./transition-names.ts";

/** A transition that comes with the editor, by what a project writes for it. */
export interface BuiltInChoice {
  readonly type: string;
  readonly variant?: string;
}

/** The pictures that come with the editor, as people pick them: one kind of each at a time. */
export function builtInChoices(use: TransitionUse): readonly (readonly BuiltInChoice[])[] {
  return Object.entries(BUILT_IN_TRANSITIONS.picture)
    .filter(([, spec]) => spec.uses.includes(use))
    .map(([type, spec]) => {
      const variants = variantsOf(spec);
      return variants.length === 0 ? [{ type }] : variants.map((variant) => ({ type, variant }));
    });
}

/**
 * What a transition can be instead of what it is, for a menu: the pictures that come with the
 * editor, in groups of one kind, with the one it is now marked. Picking one runs `pick`.
 */
export function replacementItems(
  t: TFunction,
  use: TransitionUse,
  current: TransitionRef | undefined,
  pick: (choice: BuiltInChoice) => void,
): readonly (readonly MenuItem[])[] {
  return builtInChoices(use).map((group) =>
    group.map((choice) => ({
      id: `${choice.type}.${choice.variant ?? ""}`,
      label: transitionName(t, choice, use, "picture"),
      selected:
        current !== undefined &&
        current.type === choice.type &&
        (current.variant ?? undefined) === choice.variant,
      run: () => pick(choice),
    })),
  );
}
