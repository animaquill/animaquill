import type { CommandCall } from "@animaquill/core";
import { findEffect } from "@animaquill/schema";
import { clipAt, type ClipBox, type Row, type TimelineModel } from "./model.ts";

/**
 * Where an effect that people pick in the effects tab goes on the timeline, and the commands that
 * put it there: dragged onto a clip, or clicked with clips selected. It goes last in the list of
 * each. See docs/design/resource-panels.md, section 4. Nothing here touches the DOM or the project.
 */

/** Why a clip cannot take effects: its track is locked, or it is not a picture. */
export type EffectBlocked = "locked" | "sound" | "caption";

/** Why the clips of a row cannot take effects, or nothing when they can. */
export function blockedRow(row: Row): EffectBlocked | undefined {
  if (row.track.locked === true) return "locked";
  if (row.track.kind === "audio") return "sound";
  if (row.track.kind === "caption") return "caption";
  return row.gone ? "locked" : undefined;
}

/** What a dragged effect would go onto at a moment of a row: the clip there, if it can take it. */
export function effectDropAt(
  row: Row | undefined,
  seconds: number,
): { readonly row: Row; readonly box: ClipBox } | undefined {
  if (!row || blockedRow(row) !== undefined) return undefined;
  const box = clipAt(row, seconds);
  return box && seconds < box.end ? { row, box } : undefined;
}

/** What a click on an effect in the tab is about: the clips selected that can take it. */
export interface EffectContext {
  /** In time order on each track. */
  readonly boxes: readonly ClipBox[];
  /** Why none of the clips selected can, when none can and some are selected. */
  readonly blocked: EffectBlocked | undefined;
  /** How many clips are selected at all. */
  readonly selected: number;
}

export function effectContext(
  model: TimelineModel | undefined,
  selection: ReadonlySet<string>,
): EffectContext {
  if (!model || selection.size === 0) return { boxes: [], blocked: undefined, selected: 0 };
  const boxes: ClipBox[] = [];
  let blocked: EffectBlocked | undefined;
  for (const row of model.rows) {
    const reason = blockedRow(row);
    for (const box of row.clips) {
      if (!selection.has(box.id)) continue;
      if (reason === undefined) boxes.push(box);
      else blocked ??= reason;
    }
  }
  return { boxes, blocked: boxes.length > 0 ? undefined : blocked, selected: selection.size };
}

/** Why a click on an effect does nothing with what is selected, or nothing when it does something. */
export function effectProblem(
  context: EffectContext,
  type: string,
): "nothing" | "unknown" | EffectBlocked | undefined {
  if (findEffect(type, "picture").kind !== "built-in") return "unknown";
  if (context.selected === 0) return "nothing";
  return context.boxes.length > 0 ? undefined : (context.blocked ?? "locked");
}

/** What puts an effect last on each of some clips, as commands of one step. */
export const effectCalls = (
  model: TimelineModel,
  boxes: readonly ClipBox[],
  type: string,
): readonly CommandCall[] =>
  boxes.map((box) => ({
    type: "effect.add",
    params: { timeline: model.id, clip: box.id, type },
  }));
