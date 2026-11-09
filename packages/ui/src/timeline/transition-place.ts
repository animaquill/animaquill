import { clipEnd, clipStart, type ClipState, type CommandCall } from "@animaquill/core";
import {
  BUILT_IN_TRANSITIONS,
  ZERO,
  compare,
  formatTime,
  newId,
  parseTime,
  toSeconds,
  variantsOf,
  type Rational,
  type SpeedCurve,
  type Transition,
  type TransitionUse,
} from "@animaquill/schema";
import { frameAt, frameTime } from "./frames.ts";
import { longestTransition } from "./gestures.ts";
import {
  canHaveTransitions,
  clipAt,
  edgesOf,
  joinAt,
  type ClipBox,
  type Edge,
  type JoinBox,
  type Row,
  type TimelineModel,
} from "./model.ts";

/**
 * Where a transition that people pick in the transitions tab goes on the timeline, and the commands
 * that put it there: dragged onto a clip or a cut, or clicked with something selected. See
 * docs/design/resource-panels.md, section 3. Nothing here touches the DOM or the project.
 */

/** What the project writes for a transition, apart from how long it is and how it goes. */
export interface TransitionName {
  readonly type?: string | undefined;
  readonly transition?: string | undefined;
  readonly library?: string | undefined;
  readonly resource?: string | undefined;
  readonly variant?: string | undefined;
}

/**
 * A transition as people pick it, with what it comes with: where it can go, and how long it is and
 * how it goes when it is put somewhere. Only the editor's own so far. Those of the project and of
 * libraries bring the same from their descriptions.
 */
export interface TransitionPick {
  readonly name: TransitionName;
  readonly uses: readonly TransitionUse[];
  /** Seconds, as the project format writes them. */
  readonly duration: string;
  readonly curve?: SpeedCurve;
}

/** A picture transition that comes with the editor, or nothing for one there is not. */
export function builtInPick(type: string, variant?: string): TransitionPick | undefined {
  const own = BUILT_IN_TRANSITIONS.picture;
  const spec = Object.hasOwn(own, type) ? own[type] : undefined;
  if (!spec) return undefined;
  const variants = variantsOf(spec);
  if (variant === undefined ? variants.length > 0 : !variants.includes(variant)) return undefined;
  return {
    name: variant === undefined ? { type } : { type, variant },
    uses: spec.uses,
    duration: spec.duration,
    ...(spec.curve && { curve: spec.curve }),
  };
}

/** Whether a transition is the one picked. */
export const isPicked = (transition: TransitionName, { name }: TransitionPick): boolean =>
  transition.type === name.type &&
  transition.transition === name.transition &&
  transition.library === name.library &&
  transition.resource === name.resource &&
  transition.variant === name.variant;

const atMost = (value: Rational, limit: Rational) => (compare(value, limit) > 0 ? limit : value);

/** The length of a pick in whole frames, which is what people see, and never no frames at all. */
function presetLength(pick: TransitionPick, model: TimelineModel): Rational {
  const frames = frameAt(toSeconds(parseTime(pick.duration)), model.rate);
  return frameTime(Math.max(frames, 1), model.rate);
}

/**
 * A transition at an edge of a clip as the pick makes it: in place of one that is there, it keeps
 * how long that one is, and goes as the pick does (see the decision of 2026-11-09). A new one is as
 * long as the pick says, or as there is room for.
 */
function edgeTransition(
  model: TimelineModel,
  clip: ClipState,
  edge: Edge,
  pick: TransitionPick,
): Transition | undefined {
  const current = clip[edge];
  const length = current
    ? parseTime(current.duration)
    : atMost(presetLength(pick, model), longestTransition(clip, edge, model));
  if (compare(length, ZERO) <= 0) return undefined;
  // What it names is checked by the command, as anything a file says.
  return {
    ...pick.name,
    duration: current ? current.duration : formatTime(length),
    ...(pick.curve && { curve: pick.curve }),
  } as Transition;
}

/** Whether a transition can go at an edge of a clip: where a join is not, and there is room. */
export function canTakeEdge(model: TimelineModel, box: ClipBox, edge: Edge): boolean {
  if (model.joined.has(`${box.id} ${edge}`)) return false;
  return (
    box.clip[edge] !== undefined || compare(longestTransition(box.clip, edge, model), ZERO) > 0
  );
}

/** Whether people can put transitions on the clips of a row. */
const takesTransitions = (row: Row): boolean =>
  !row.gone && row.track.locked !== true && canHaveTransitions(row.track);

/** Whether two clips follow each other with nothing in between, which a join needs. */
const touching = (from: ClipBox, to: ClipBox) =>
  compare(clipEnd(from.clip), clipStart(to.clip)) === 0;

/** The join on the cut between two clips, when there is one. */
const joinBetween = (row: Row, from: ClipBox, to: ClipBox): JoinBox | undefined =>
  row.joins.find((join) => join.from.id === from.id && join.to.id === to.id);

/** Where a dragged transition would go, and what of the timeline it would take. */
export type TransitionDrop =
  | {
      readonly kind: "edge";
      readonly row: Row;
      readonly box: ClipBox;
      readonly edge: Edge;
      /** There is one there, which this takes the place of. */
      readonly replacing: boolean;
      /** Seconds on the timeline, for showing where. */
      readonly start: number;
      readonly end: number;
    }
  | {
      readonly kind: "join";
      readonly row: Row;
      readonly from: ClipBox;
      readonly to: ClipBox;
      /** The join there, which this takes the place of. */
      readonly join: JoinBox | undefined;
      readonly start: number;
      readonly end: number;
    };

/**
 * Where a transition dragged to a moment on a row goes: on a cut between two clips that touch, it
 * goes between them, within `reach` seconds of the cut; on the first third of a clip it comes in,
 * on the last third it goes out, and on a transition that is there it takes its place. The middle
 * of a clip takes nothing, and nor does anywhere the transition cannot go: a locked track, sound
 * and captions so far, an edge that a join has, an edge without room.
 */
export function transitionDropAt(
  model: TimelineModel,
  row: Row | undefined,
  seconds: number,
  reach: number,
  pick: TransitionPick,
): TransitionDrop | undefined {
  if (!row || !takesTransitions(row)) return undefined;
  const join = joinAt(row, seconds);
  if (join) {
    if (!pick.uses.includes("join")) return undefined;
    const { from, to, start, end } = join;
    return { kind: "join", row, from, to, join, start, end };
  }
  const box = clipAt(row, seconds);
  if (!box) return undefined;
  const seam = pick.uses.includes("join") ? seamNear(row, box, seconds, reach) : undefined;
  if (seam) {
    const { from, to } = seam;
    if (model.joined.has(`${from.id} exit`) || model.joined.has(`${to.id} enter`)) return undefined;
    const half = toSeconds(presetLength(pick, model)) / 2;
    const start = Math.max(from.start, from.end - half);
    return {
      kind: "join",
      row,
      from,
      to,
      join: undefined,
      start,
      end: Math.min(to.end, to.start + half),
    };
  }
  const edge = edgeUnder(box, seconds);
  if (!edge || !pick.uses.includes(edge) || !canTakeEdge(model, box, edge)) return undefined;
  const current = edgesOf(box.clip)[edge];
  const length =
    current > 0
      ? current
      : toSeconds(atMost(presetLength(pick, model), longestTransition(box.clip, edge, model)));
  return edge === "enter"
    ? {
        kind: "edge",
        row,
        box,
        edge,
        replacing: current > 0,
        start: box.start,
        end: box.start + length,
      }
    : {
        kind: "edge",
        row,
        box,
        edge,
        replacing: current > 0,
        start: box.end - length,
        end: box.end,
      };
}

/** The cut near a moment in a clip, with the clip on its other side, if they touch. */
function seamNear(row: Row, box: ClipBox, seconds: number, reach: number) {
  const index = row.clips.indexOf(box);
  const near = (cut: number, from: ClipBox, to: ClipBox) =>
    Math.abs(seconds - cut) <=
    Math.min(reach, (from.end - from.start) / 3, (to.end - to.start) / 3);
  const before = row.clips[index - 1];
  if (before && touching(before, box) && near(box.start, before, box))
    return { from: before, to: box };
  const after = row.clips[index + 1];
  if (after && touching(box, after) && near(box.end, box, after)) return { from: box, to: after };
  return undefined;
}

/** Which edge of a clip a moment is about: a transition there, or else a third of the clip. */
function edgeUnder(box: ClipBox, seconds: number): Edge | undefined {
  const edges = edgesOf(box.clip);
  // The one at the end is drawn over the one at the start, where they overlap.
  if (edges.exit > 0 && seconds >= box.end - edges.exit) return "exit";
  if (edges.enter > 0 && seconds <= box.start + edges.enter) return "enter";
  const share = (seconds - box.start) / (box.end - box.start);
  return share < 1 / 3 ? "enter" : share > 2 / 3 ? "exit" : undefined;
}

/** What makes the transition at the edges of a clip what the pick is, as one command. */
function edgesCall(
  model: TimelineModel,
  box: ClipBox,
  edges: readonly Edge[],
  pick: TransitionPick,
): CommandCall | undefined {
  let clip = box.clip;
  const params: Record<string, unknown> = { timeline: model.id, clip: box.id };
  for (const edge of edges) {
    if (!canTakeEdge(model, { ...box, clip }, edge)) continue;
    const transition = edgeTransition(model, clip, edge, pick);
    if (!transition) continue;
    params[edge] = transition;
    // The other edge leaves room for this one when they come together.
    clip = { ...clip, [edge]: transition };
  }
  return Object.keys(params).length > 2 ? { type: "clip.setTransition", params } : undefined;
}

/** What makes the join between two clips the pick: in place of the one there, or a new one. */
function joinCall(
  model: TimelineModel,
  row: Row,
  from: ClipBox,
  to: ClipBox,
  pick: TransitionPick,
): { readonly call: CommandCall; readonly id: string } | undefined {
  const join = joinBetween(row, from, to);
  if (join) return { call: replaceJoinCall(model, join.id, pick), id: join.id };
  if (model.joined.has(`${from.id} exit`) || model.joined.has(`${to.id} enter`)) return undefined;
  const id = newId("join");
  // How long it is comes from what it is, as far as there is room: see `join.add`.
  const params = { timeline: model.id, id, from: from.id, to: to.id, ...pick.name };
  return {
    call: { type: "join.add", params: pick.curve ? { ...params, curve: pick.curve } : params },
    id,
  };
}

/** What puts the pick in the place of a join, as long as that one is. */
function replaceJoinCall(model: TimelineModel, join: string, pick: TransitionPick): CommandCall {
  const { type, transition, library, resource, variant } = pick.name;
  const names = { type, transition, library, resource };
  const changes: Record<string, unknown> = Object.fromEntries(
    Object.entries(names).filter(([, value]) => value !== undefined),
  );
  changes["variant"] = variant ?? null;
  changes["curve"] = pick.curve ?? null;
  return { type: "join.update", params: { timeline: model.id, join, changes } };
}

/** What puts the pick in the place of the transition at an edge of a clip, as long as that one is. */
function replaceEdgeCall(
  model: TimelineModel,
  box: ClipBox,
  edge: Edge,
  pick: TransitionPick,
): CommandCall | undefined {
  const current = box.clip[edge];
  if (!current) return undefined;
  const transition = edgeTransition(model, box.clip, edge, pick);
  return (
    transition && {
      type: "clip.setTransition",
      params: { timeline: model.id, clip: box.id, [edge]: transition },
    }
  );
}

/** What a drop does, and what to select once it did it. */
export function dropCalls(
  model: TimelineModel,
  drop: TransitionDrop,
  pick: TransitionPick,
):
  | {
      readonly calls: readonly CommandCall[];
      readonly chosen: { readonly clip: string; readonly edge: Edge } | { readonly join: string };
    }
  | undefined {
  if (drop.kind === "join") {
    const made = joinCall(model, drop.row, drop.from, drop.to, pick);
    return made && { calls: [made.call], chosen: { join: made.id } };
  }
  const call = edgesCall(model, drop.box, [drop.edge], pick);
  return call && { calls: [call], chosen: { clip: drop.box.id, edge: drop.edge } };
}

/** Why the clips selected cannot take transitions at all. */
export type Blocked = "locked" | "sound" | "caption";

/** What a click on a transition in the tab is about: what is selected on the timeline. */
export type AttachContext =
  | { readonly kind: "nothing" }
  | {
      readonly kind: "edge";
      readonly box: ClipBox;
      readonly edge: Edge;
      readonly locked: boolean;
    }
  | { readonly kind: "join"; readonly join: JoinBox; readonly locked: boolean }
  | {
      readonly kind: "clips";
      /** Those that can take transitions, in time order on each track. */
      readonly boxes: readonly ClipBox[];
      /** Selected clips that follow each other on a track, with nothing in between. */
      readonly pairs: readonly (readonly [Row, ClipBox, ClipBox])[];
      /** Why none of them can, when none can. */
      readonly blocked: Blocked | undefined;
    };

/** What a click on a transition would be about, from what is selected. */
export function attachContext(
  model: TimelineModel | undefined,
  selection: ReadonlySet<string>,
  chosen: { readonly clip: string; readonly edge: Edge } | { readonly join: string } | undefined,
): AttachContext {
  if (!model) return { kind: "nothing" };
  if (chosen && "join" in chosen) {
    const join = model.joins.get(chosen.join);
    if (!join) return { kind: "nothing" };
    return { kind: "join", join, locked: model.state.tracks[join.join.track]?.locked === true };
  }
  if (chosen) {
    const box = model.boxes.get(chosen.clip);
    const row = model.rowOfClip.get(chosen.clip);
    if (!box || !row) return { kind: "nothing" };
    return { kind: "edge", box, edge: chosen.edge, locked: row.track.locked === true };
  }
  if (selection.size === 0) return { kind: "nothing" };
  // By row, in time order: the order of clips in a row, found in one go over each of those rows.
  const byRow = new Map<Row, Set<string>>();
  let blocked: Blocked | undefined;
  for (const id of selection) {
    const row = model.rowOfClip.get(id);
    if (!row) continue;
    if (takesTransitions(row)) {
      const ids = byRow.get(row) ?? new Set();
      ids.add(id);
      byRow.set(row, ids);
    } else {
      blocked ??=
        row.track.locked === true
          ? "locked"
          : row.track.kind === "audio"
            ? "sound"
            : row.track.kind === "caption"
              ? "caption"
              : "locked";
    }
  }
  const boxes: ClipBox[] = [];
  const pairs: (readonly [Row, ClipBox, ClipBox])[] = [];
  for (const [row, ids] of byRow) {
    let before: ClipBox | undefined;
    for (const box of row.clips) {
      if (!ids.has(box.id)) {
        before = undefined;
        continue;
      }
      boxes.push(box);
      if (before && touching(before, box)) pairs.push([row, before, box]);
      before = box;
    }
  }
  return {
    kind: "clips",
    boxes,
    pairs,
    blocked: boxes.length > 0 ? undefined : (blocked ?? "locked"),
  };
}

/**
 * Why a click on a transition for a use does nothing with what is selected, as a key of the
 * texts, or nothing when it does something.
 */
export function attachProblem(
  model: TimelineModel | undefined,
  context: AttachContext,
  use: TransitionUse,
  pick: TransitionPick,
):
  | "nothing"
  | "locked"
  | "sound"
  | "caption"
  | "chosenEnter"
  | "chosenExit"
  | "chosenJoin"
  | "noPair"
  | "noRoom"
  | "use"
  | undefined {
  if (!pick.uses.includes(use)) return "use";
  switch (context.kind) {
    case "nothing":
      return "nothing";
    case "edge":
      if (context.locked) return "locked";
      if (context.edge !== use) return context.edge === "enter" ? "chosenEnter" : "chosenExit";
      return undefined;
    case "join":
      if (context.locked) return "locked";
      return use === "join" ? undefined : "chosenJoin";
    case "clips": {
      if (context.blocked) return context.blocked;
      if (use === "join")
        return context.pairs.some(([row, from, to]) => model && canJoin(model, row, from, to))
          ? undefined
          : "noPair";
      if (!model) return "nothing";
      // One clip can take it at either edge: people say which.
      const edges: readonly Edge[] = context.boxes.length === 1 ? ["enter", "exit"] : [use];
      const any = context.boxes.some((box) => edges.some((edge) => canTakeEdge(model, box, edge)));
      return any ? undefined : "noRoom";
    }
  }
}

/** Whether a join can go between two clips, or is there to take the place of. */
const canJoin = (model: TimelineModel, row: Row, from: ClipBox, to: ClipBox) =>
  joinBetween(row, from, to) !== undefined ||
  (!model.joined.has(`${from.id} exit`) && !model.joined.has(`${to.id} enter`));

/**
 * What a click on a transition does with what is selected, as commands of one step: a transition
 * that is selected becomes it, as long as it was; the clips selected get it at `edges`, a pair of
 * them that touch gets it between them.
 */
export function attachCalls(
  model: TimelineModel,
  context: AttachContext,
  use: TransitionUse,
  pick: TransitionPick,
  edges: readonly Edge[],
): readonly CommandCall[] {
  if (attachProblem(model, context, use, pick)) return [];
  switch (context.kind) {
    case "nothing":
      return [];
    case "edge": {
      const call = replaceEdgeCall(model, context.box, context.edge, pick);
      return call && !isPicked(context.box.clip[context.edge] ?? {}, pick) ? [call] : [];
    }
    case "join":
      return isPicked(context.join.join.transition, pick)
        ? []
        : [replaceJoinCall(model, context.join.id, pick)];
    case "clips":
      if (use === "join") {
        return context.pairs.flatMap(([row, from, to]) => {
          const made = joinCall(model, row, from, to, pick);
          return made ? [made.call] : [];
        });
      }
      return context.boxes.flatMap((box) => {
        const call = edgesCall(model, box, edges, pick);
        return call ? [call] : [];
      });
  }
}
