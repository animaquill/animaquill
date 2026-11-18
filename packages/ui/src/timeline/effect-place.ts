import type { CommandCall } from "@animaquill/core";
import { builtInEffect, findEffect, newId, type EffectMedia } from "@animaquill/schema";
import { MASTER_CLIP } from "../mixer/track-clip.ts";
import { clipAt, type ClipBox, type Row, type TimelineModel } from "./model.ts";

/**
 * Where an effect that people pick in the effects tab goes on the timeline, and the commands that
 * put it there: dragged onto a clip, or clicked with clips selected. It goes last in the list of
 * each. See docs/design/resource-panels.md, section 4. Nothing here touches the DOM or the project.
 */

/**
 * Why a clip cannot take effects: its track is locked, or it is not what the effect is for: sound
 * for one of pictures, a picture for one of sound.
 */
export type EffectBlocked = "locked" | "sound" | "picture" | "caption";

/** What an effect works on: pictures, or sound (nothing goes on both). */
export const mediaOfEffect = (type: string): EffectMedia =>
  builtInEffect(type)?.media.includes("sound") ? "sound" : "picture";

/** Why the clips of a row cannot take effects for this, or nothing when they can. */
export function blockedRow(row: Row, media: EffectMedia = "picture"): EffectBlocked | undefined {
  if (row.track.locked === true) return "locked";
  if (row.track.kind === "caption") return "caption";
  if (media === "picture" && row.track.kind === "audio") return "sound";
  if (media === "sound" && row.track.kind !== "audio") return "picture";
  return row.gone ? "locked" : undefined;
}

/** What a dragged effect would go onto at a moment of a row: the clip there, if it can take it. */
export function effectDropAt(
  row: Row | undefined,
  seconds: number,
  media: EffectMedia = "picture",
): { readonly row: Row; readonly box: ClipBox } | undefined {
  if (!row || blockedRow(row, media) !== undefined) return undefined;
  const box = clipAt(row, seconds);
  return box && seconds < box.end ? { row, box } : undefined;
}

/** What a click on an effect in a tab is about: the clips selected that can take it, of each kind. */
export interface EffectContext {
  /** In time order on each track, by what their effects work on. */
  readonly boxes: Readonly<Record<EffectMedia, readonly ClipBox[]>>;
  /** Why none of the clips selected can, when none can and some are selected. */
  readonly blocked: Readonly<Record<EffectMedia, EffectBlocked | undefined>>;
  /** How many clips are selected at all. */
  readonly selected: number;
  /**
   * The track of sound selected instead of clips (or the master, `MASTER_CLIP`), which takes
   * effects of sound; undefined when it is locked or nothing is.
   */
  readonly track: string | undefined;
  readonly trackLocked: boolean;
}

export function effectContext(
  model: TimelineModel | undefined,
  selection: ReadonlySet<string>,
  track?: string,
): EffectContext {
  const chosenRow = track === undefined ? undefined : model?.rows.find((one) => one.id === track);
  const trackLocked = chosenRow?.track.locked === true;
  const chosen = model && (track === MASTER_CLIP || chosenRow) && !trackLocked ? track : undefined;
  const none = {
    boxes: { picture: [], sound: [] },
    blocked: { picture: undefined, sound: undefined },
    track: chosen,
    trackLocked,
  };
  if (!model || selection.size === 0) return { ...none, selected: 0 };
  const boxes: Record<EffectMedia, ClipBox[]> = { picture: [], sound: [] };
  const blocked: Record<EffectMedia, EffectBlocked | undefined> = {
    picture: undefined,
    sound: undefined,
  };
  for (const row of model.rows) {
    for (const media of ["picture", "sound"] as const) {
      const reason = blockedRow(row, media);
      for (const box of row.clips) {
        if (!selection.has(box.id)) continue;
        if (reason === undefined) boxes[media].push(box);
        else blocked[media] ??= reason;
      }
    }
  }
  for (const media of ["picture", "sound"] as const) {
    if (boxes[media].length > 0) blocked[media] = undefined;
  }
  return { boxes, blocked, selected: selection.size, track: undefined, trackLocked: false };
}

/** Why a click on an effect does nothing with what is selected, or nothing when it does something. */
export function effectProblem(
  context: EffectContext,
  type: string,
): "nothing" | "unknown" | EffectBlocked | undefined {
  const media = mediaOfEffect(type);
  if (findEffect(type, media).kind !== "built-in") return "unknown";
  if (context.selected === 0) {
    if (media === "sound" && context.track !== undefined) return undefined;
    if (media === "sound" && context.trackLocked) return "locked";
    return "nothing";
  }
  return context.boxes[media].length > 0 ? undefined : (context.blocked[media] ?? "locked");
}

/**
 * What puts an effect last on each of some clips, as commands of one step, with the id that each
 * gets: the same effect again is one more, so that people can stack it.
 */
export function effectCalls(
  model: TimelineModel,
  boxes: readonly ClipBox[],
  type: string,
): { readonly calls: readonly CommandCall[]; readonly added: ReadonlyMap<string, string> } {
  const added = new Map<string, string>();
  const calls = boxes.map((box): CommandCall => {
    const id = newId("fx");
    added.set(box.id, id);
    return { type: "effect.add", params: { timeline: model.id, clip: box.id, type, id } };
  });
  return { calls, added };
}
