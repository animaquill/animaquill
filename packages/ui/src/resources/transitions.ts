import {
  BUILT_IN_TRANSITIONS,
  TRANSITION_USES,
  variantsOf,
  type TransitionUse,
} from "@animaquill/schema";
import type { TFunction } from "i18next";
import type { AttachContext } from "../timeline/transition-place.ts";
import { builtInPick, isPicked, type TransitionPick } from "../timeline/transition-place.ts";
import { transitionName } from "../timeline/transition-names.ts";
import { textOf } from "../properties/names.ts";
import type { Resource } from "./resources.ts";

/** What the transitions tab knows of each transition it lists. */
export interface TransitionItem {
  readonly pick: TransitionPick;
  /** Where it is listed: one entry for each place a transition can go, with its name there. */
  readonly use: TransitionUse;
}

/** The types of transitions, by where they go, in the order people see them: in, between, out. */
export const TRANSITION_TYPES: readonly string[] = [
  "transition.enter",
  "transition.join",
  "transition.exit",
];

export const typeOfUse = (use: TransitionUse): string => `transition.${use}`;

/** The order of the uses as people see them. */
const USE_ORDER: readonly TransitionUse[] = ["enter", "join", "exit"];

/**
 * The picture transitions that come with the editor, once for each place they can go, each kind
 * of them on its own, as the project writes them: `fade` comes in as 淡入 and goes out as 淡出.
 * Those of the project and of libraries come with their own lists later, see `ResourceSource`.
 */
export function builtInTransitions(t: TFunction): readonly Resource<TransitionItem>[] {
  const resources: Resource<TransitionItem>[] = [];
  for (const use of USE_ORDER.filter((value) => TRANSITION_USES.includes(value))) {
    for (const [type, spec] of Object.entries(BUILT_IN_TRANSITIONS.picture)) {
      if (!spec.uses.includes(use)) continue;
      const variants = variantsOf(spec);
      for (const variant of variants.length === 0 ? [undefined] : variants) {
        const pick = builtInPick(type, variant);
        if (!pick) continue;
        const kind = variant === undefined ? type : `${type}.${variant}`;
        const tags = textOf(t, `transitionPanel.tags.${type}`, "");
        resources.push({
          id: `transition:built-in:${kind}:${use}`,
          source: { kind: "built-in" },
          type: typeOfUse(use),
          name: transitionName(t, pick.name, use, "picture"),
          tags: tags ? tags.split("、") : [],
          keywords: [kind, t(`transition.uses.${use}`)],
          data: { pick, use },
        });
      }
    }
  }
  return resources;
}

/** The type that what is selected is about, which comes first in the tab. */
export function firstTypeOf(context: AttachContext): string | undefined {
  if (context.kind === "join") return typeOfUse("join");
  if (context.kind === "edge") return typeOfUse(context.edge);
  if (context.kind === "clips" && context.pairs.length > 0) return typeOfUse("join");
  return undefined;
}

/** Whether a transition in the list is what is selected now. */
export function isChosen(context: AttachContext, { pick, use }: TransitionItem): boolean {
  if (context.kind === "edge") {
    const current = context.box.clip[context.edge];
    return use === context.edge && current !== undefined && isPicked(current, pick);
  }
  return context.kind === "join" && use === "join" && isPicked(context.join.join.transition, pick);
}
