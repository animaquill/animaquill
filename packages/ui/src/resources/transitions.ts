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

/** What the transitions and fades tabs know of each transition they list. */
export interface TransitionItem {
  readonly pick: TransitionPick;
  /** Where it is listed: one entry for each place a transition can go, with its name there. */
  readonly use: TransitionUse;
  /** What it goes on: pictures in the transitions tab, sound in the fades tab. */
  readonly media: TransitionMedia;
}

/**
 * The types of transitions, by where they go, in the order people see them: in, between, out. Those
 * of sound are types of their own, which people know by what they do: 淡入, 交叉淡化, 淡出.
 */
export const TRANSITION_TYPES: readonly string[] = [
  "transition.enter",
  "transition.join",
  "transition.exit",
];
export const FADE_TYPES: readonly string[] = ["fade.enter", "fade.join", "fade.exit"];

/** The types of a tab, pictures or sound. */
export const typesOf = (media: TransitionMedia): readonly string[] =>
  media === "picture" ? TRANSITION_TYPES : FADE_TYPES;

export const typeOfUse = (use: TransitionUse, media: TransitionMedia = "picture"): string =>
  `${media === "picture" ? "transition" : "fade"}.${use}`;

/** The order of the uses as people see them. */
const USE_ORDER: readonly TransitionUse[] = ["enter", "join", "exit"];

/**
 * The id of a transition that comes with the editor. Those for pictures keep the ids they had when
 * one tab listed both, so what people used lately stays.
 */
export const builtInTransitionId = (media: TransitionMedia, type: string, use: TransitionUse) =>
  media === "picture"
    ? `transition:built-in:${type}:${use}`
    : `transition:built-in:${media}:${type}:${use}`;

/** Whether an id is of a transition for sound that comes with the editor. */
export const isBuiltInSoundId = (id: string): boolean =>
  id.startsWith("transition:built-in:sound:");

/**
 * The transitions that come with the editor for pictures or for sound, once for each place they
 * can go, each with the name it has there: `fade` comes in as 淡入 and goes out as 淡出, and goes
 * between two clips as 叠化 on pictures and as 交叉淡化 on sound. Pictures have theirs in the
 * transitions tab and sound in the fades tab, so a `fade` is listed in each, for that one only.
 * Which way one goes and such are its properties, which people set once it is there. Those of the
 * project and of libraries come with their own lists later, see `ResourceSource`.
 */
export function builtInTransitions(
  t: TFunction,
  media: TransitionMedia,
): readonly Resource<TransitionItem>[] {
  const resources: Resource<TransitionItem>[] = [];
  const tagsKey = media === "picture" ? "transitionPanel.tags" : "fadePanel.tags";
  for (const use of USE_ORDER.filter((value) => TRANSITION_USES.includes(value))) {
    for (const type of Object.keys(BUILT_IN_TRANSITIONS[media])) {
      const pick = builtInPick(type, media);
      if (!pick?.uses.includes(use)) continue;
      const tags = textOf(t, `${tagsKey}.${type}`, "");
      resources.push({
        id: builtInTransitionId(media, type, use),
        source: { kind: "built-in" },
        type: typeOfUse(use, media),
        name: transitionName(t, pick.name, use, media),
        tags: tags ? tags.split("、") : [],
        keywords: [
          type,
          t(`transition.uses.${use}`),
          t(media === "picture" ? "panel.transitions.title" : "panel.fades.title"),
        ],
        data: { pick, use, media },
      });
    }
  }
  return resources;
}

/** The type that what is selected is about, which comes first in the tab of pictures or sound. */
export function firstTypeOf(
  context: AttachContext,
  media: TransitionMedia = "picture",
): string | undefined {
  if (context.kind === "join") return typeOfUse("join", media);
  if (context.kind === "edge") return typeOfUse(context.edge, media);
  if (context.kind === "clips" && context.pairs.length > 0) return typeOfUse("join", media);
  return undefined;
}

/** Whether a transition in the list is what is selected now. */
export function isChosen(context: AttachContext, { pick, use, media }: TransitionItem): boolean {
  // A `fade` of sound is not the `fade` of pictures, which the other tab has.
  if ((context.kind === "edge" || context.kind === "join") && context.media !== media) return false;
  if (context.kind === "edge") {
    const current = context.box.clip[context.edge];
    return use === context.edge && current !== undefined && isPicked(current, pick);
  }
  return context.kind === "join" && use === "join" && isPicked(context.join.join.transition, pick);
}
