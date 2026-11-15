import {
  BUILT_IN_TRANSITIONS,
  TRANSITION_USES,
  type TransitionMedia,
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

/** Every transition that comes with the editor, pictures first, with what it works on first. */
function builtInTypes(): readonly (readonly [string, TransitionMedia])[] {
  const types = new Map<string, TransitionMedia>();
  for (const media of ["picture", "sound"] as const) {
    for (const type of Object.keys(BUILT_IN_TRANSITIONS[media])) {
      if (!types.has(type)) types.set(type, media);
    }
  }
  return [...types];
}

/**
 * The transitions that come with the editor, once for each place they can go, each with the name
 * it has there: `fade` comes in as 淡入 and goes out as 淡出, on pictures and on sound alike, and
 * `fade-linear` is for sound only. Which way one goes and such are its properties, which people set
 * once it is there. Those of the project and of libraries come with their own lists later, see
 * `ResourceSource`.
 */
export function builtInTransitions(t: TFunction): readonly Resource<TransitionItem>[] {
  const resources: Resource<TransitionItem>[] = [];
  for (const use of USE_ORDER.filter((value) => TRANSITION_USES.includes(value))) {
    for (const [type, media] of builtInTypes()) {
      const pick = builtInPick(type);
      if (!pick?.uses.includes(use)) continue;
      const tags = textOf(t, `transitionPanel.tags.${type}`, "");
      resources.push({
        id: `transition:built-in:${type}:${use}`,
        source: { kind: "built-in" },
        type: typeOfUse(use),
        name: transitionName(t, pick.name, use, media),
        tags: tags ? tags.split("、") : [],
        keywords: [type, t(`transition.uses.${use}`)],
        data: { pick, use },
      });
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
