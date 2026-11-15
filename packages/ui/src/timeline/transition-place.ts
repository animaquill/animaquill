import { clipEnd, clipStart, roomAt, type ClipState, type CommandCall } from "@animaquill/core";
import {
  ZERO,
  builtInTransition,
  compare,
  formatTime,
  mediaOfTrack,
  newId,
  parseTime,
  toSeconds,
  type Rational,
  type SpeedCurve,
  type Transition,
  type TransitionMedia,
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
}

/**
 * A transition as people pick it, with what it comes with: where it can go, what on, and how long it
 * is and how it goes when it is put somewhere. Only the editor's own so far. Those of the project
 * and of libraries bring the same from their descriptions.
 */
export interface TransitionPick {
  readonly name: TransitionName;
  readonly uses: readonly TransitionUse[];
  /**
   * What it works on, pictures or sound, each with how long it is when it is put there: seconds,
   * as the project format writes them. `fade` is one of each.
   */
  readonly lengths: Readonly<Partial<Record<TransitionMedia, string>>>;
  readonly curve?: SpeedCurve;
}

/** Whether a transition goes on pictures or on sound. */
export const worksOn = (pick: TransitionPick, media: TransitionMedia): boolean =>
  pick.lengths[media] !== undefined;

/** How long a pick is where it goes first, for showing how it goes. */
export const firstLength = (pick: TransitionPick): string =>
  pick.lengths.picture ?? pick.lengths.sound ?? "0.5";

/**
 * A transition that comes with the editor, for pictures, sound or both, or nothing for one there is
 * not. It comes with the defaults of its properties, which people change once it is there.
 */
export function builtInPick(type: string): TransitionPick | undefined {
  const picture = builtInTransition("picture", type);
  const sound = builtInTransition("sound", type);
  const spec = picture ?? sound;
  if (!spec) return undefined;
  const uses = [...new Set([...(picture?.uses ?? []), ...(sound?.uses ?? [])])];
  return {
    name: { type },
    uses,
    lengths: {
      ...(picture && { picture: picture.duration }),
      ...(sound && { sound: sound.duration }),
    },
    ...(spec.curve && { curve: spec.curve }),
  };
}

/** What the clips of a row are, pictures or sound. */
const mediaOf = (row: Row): TransitionMedia => mediaOfTrack(row.track.kind);

/** Whether a transition is the one picked, whatever it sets for its properties. */
export const isPicked = (transition: TransitionName, { name }: TransitionPick): boolean =>
  transition.type === name.type &&
  transition.transition === name.transition &&
  transition.library === name.library &&
  transition.resource === name.resource;

const atMost = (value: Rational, limit: Rational) => (compare(value, limit) > 0 ? limit : value);

/**
 * The length of a pick on pictures or sound in whole frames, which is what people see, and never no
 * frames at all.
 */
function presetLength(
  pick: TransitionPick,
  model: TimelineModel,
  media: TransitionMedia,
): Rational {
  const length = pick.lengths[media] ?? firstLength(pick);
  const frames = frameAt(toSeconds(parseTime(length)), model.rate);
  return frameTime(Math.max(frames, 1), model.rate);
}

/**
 * A transition at an edge of a clip as the pick makes it: in place of one that is there, it keeps
 * how long that one is, and goes as the pick does, with the defaults of its own properties (see the
 * decisions of 2026-11-09). A new one is as long as the pick says, or as there is room for.
 */
function edgeTransition(
  model: TimelineModel,
  clip: ClipState,
  edge: Edge,
  pick: TransitionPick,
): Transition | undefined {
  const current = clip[edge];
  const row = model.rowOfClip.get(clip.id);
  const media = row ? mediaOf(row) : "picture";
  const length = current
    ? parseTime(current.duration)
    : atMost(presetLength(pick, model, media), longestTransition(clip, edge, model));
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

/** Whether a pick goes on the clips of a row: one for pictures on a video track, and so on. */
const fitsRow = (pick: TransitionPick, row: Row): boolean => worksOn(pick, mediaOf(row));

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
 * of a clip takes nothing, and nor does anywhere the transition cannot go: a locked track, captions
 * so far, a track of the other media, an edge that a join has, an edge without room.
 */
export function transitionDropAt(
  model: TimelineModel,
  row: Row | undefined,
  seconds: number,
  reach: number,
  pick: TransitionPick,
): TransitionDrop | undefined {
  if (!row || !takesTransitions(row) || !fitsRow(pick, row)) return undefined;
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
    const half = toSeconds(presetLength(pick, model, mediaOf(row))) / 2;
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
      : toSeconds(
          atMost(presetLength(pick, model, mediaOf(row)), longestTransition(box.clip, edge, model)),
        );
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
  const { type, transition, library, resource } = pick.name;
  const names = { type, transition, library, resource };
  const changes: Record<string, unknown> = Object.fromEntries(
    Object.entries(names).filter(([, value]) => value !== undefined),
  );
  // What the one before set is about the one before.
  changes["values"] = null;
  changes["curve"] = pick.curve ?? null;
  return { type: "join.update", params: { timeline: model.id, join, changes } };
}

/** The clips linked to one on audio tracks, which people can put transitions on. */
function soundOf(model: TimelineModel, box: ClipBox): readonly [Row, ClipBox][] {
  const { link } = box.clip;
  if (link === undefined) return [];
  return (model.links.get(link) ?? []).flatMap((id) => {
    const row = model.rowOfClip.get(id);
    const other = model.boxes.get(id);
    return row && other && row.track.kind === "audio" && takesTransitions(row)
      ? [[row, other]]
      : [];
  });
}

/**
 * Where the sound of two clips of pictures meets at the same cut as they do, on an audio track
 * that can take it, with no join there yet and room for one: the two clips of sound linked to them.
 */
function soundCut(model: TimelineModel, from: ClipBox, to: ClipBox) {
  const cut = clipStart(to.clip);
  for (const [row, before] of soundOf(model, from)) {
    if (compare(clipEnd(before.clip), cut) !== 0) continue;
    const after = soundOf(model, to).find(
      ([other, box]) => other === row && compare(clipStart(box.clip), cut) === 0,
    )?.[1];
    if (!after || joinBetween(row, before, after)) continue;
    if (model.joined.has(`${before.id} exit`) || model.joined.has(`${after.id} enter`)) continue;
    // A cross-fade needs a little of both, wherever it goes around the cut.
    const room = (box: ClipBox, end: "start" | "end") =>
      compare(roomAt(model.ends, box.clip, end), ZERO) > 0;
    if (!room(before, "end") || !room(after, "start")) continue;
    return { before, after };
  }
  return undefined;
}

/**
 * New joins of pictures bring a cross-fade of their sound along, in the same step, where the sound
 * linked to the two clips meets at the same cut: a `fade` of sound, as long as sound has it. A cut
 * of sound that the calls have already is left as they have it. See docs/design/transitions.md,
 * section 6.
 */
function withSoundAlong(
  model: TimelineModel,
  calls: readonly CommandCall[],
): readonly CommandCall[] {
  const params = (call: CommandCall) => call.params as Readonly<Record<string, unknown>>;
  const cuts = new Set(
    calls
      .filter(({ type }) => type === "join.add")
      .map((call) => `${String(params(call)["from"])} ${String(params(call)["to"])}`),
  );
  const along: CommandCall[] = [];
  for (const call of calls) {
    if (call.type !== "join.add") continue;
    const from = model.boxes.get(String(params(call)["from"]));
    const to = model.boxes.get(String(params(call)["to"]));
    const row = from && model.rowOfClip.get(from.id);
    if (!from || !to || row?.track.kind !== "video") continue;
    const sound = soundCut(model, from, to);
    if (!sound || cuts.has(`${sound.before.id} ${sound.after.id}`)) continue;
    cuts.add(`${sound.before.id} ${sound.after.id}`);
    along.push({
      type: "join.add",
      params: {
        timeline: model.id,
        id: newId("join"),
        from: sound.before.id,
        to: sound.after.id,
        type: "fade",
      },
    });
  }
  return along.length > 0 ? [...calls, ...along] : calls;
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
    return made && { calls: withSoundAlong(model, [made.call]), chosen: { join: made.id } };
  }
  const call = edgesCall(model, drop.box, [drop.edge], pick);
  return call && { calls: [call], chosen: { clip: drop.box.id, edge: drop.edge } };
}

/** Why the clips selected cannot take transitions at all. */
export type Blocked = "locked" | "caption";

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
      blocked ??= row.track.locked !== true && row.track.kind === "caption" ? "caption" : "locked";
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
 * texts, or nothing when it does something. One that goes between two clips is never greyed out
 * for it: a click with no two clips next to each other selected says how it goes (`joinHow`).
 */
export function attachProblem(
  model: TimelineModel | undefined,
  context: AttachContext,
  use: TransitionUse,
  pick: TransitionPick,
):
  | "nothing"
  | "locked"
  | "caption"
  | "pictureOnly"
  | "soundOnly"
  | "chosenEnter"
  | "chosenExit"
  | "chosenJoin"
  | "joinHow"
  | "noRoom"
  | "use"
  | undefined {
  if (!pick.uses.includes(use)) return "use";
  // One for pictures where there is only sound, or the other way round.
  const otherMedia = worksOn(pick, "picture") ? "pictureOnly" : "soundOnly";
  const fits = (box: ClipBox) => {
    const row = model?.rowOfClip.get(box.id);
    return row !== undefined && fitsRow(pick, row);
  };
  switch (context.kind) {
    case "nothing":
      return use === "join" ? "joinHow" : "nothing";
    case "edge":
      if (use === "join") return "joinHow";
      if (context.locked) return "locked";
      if (context.edge !== use) return context.edge === "enter" ? "chosenEnter" : "chosenExit";
      return fits(context.box) ? undefined : otherMedia;
    case "join":
      if (context.locked) return "locked";
      if (use !== "join") return "chosenJoin";
      return fits(context.join.from) ? undefined : otherMedia;
    case "clips": {
      if (use === "join") {
        const joinable = context.pairs.filter(
          ([row, from, to]) => model && canJoin(model, row, from, to),
        );
        if (joinable.some(([row]) => fitsRow(pick, row))) return undefined;
        return joinable.length > 0 ? otherMedia : "joinHow";
      }
      if (context.blocked) return context.blocked;
      if (!model) return "nothing";
      const fitting = context.boxes.filter(fits);
      if (fitting.length === 0) return otherMedia;
      const any = fitting.some((box) => canTakeEdge(model, box, use));
      return any ? undefined : "noRoom";
    }
  }
}

type AttachProblem = ReturnType<typeof attachProblem>;

/** Whether a problem of a click is one that greys out what was clicked. */
export const greysOut = (
  problem: AttachProblem,
): problem is Exclude<AttachProblem, undefined | "nothing" | "joinHow"> =>
  problem !== undefined && problem !== "nothing" && problem !== "joinHow";

/** Whether a join can go between two clips, or is there to take the place of. */
const canJoin = (model: TimelineModel, row: Row, from: ClipBox, to: ClipBox) =>
  joinBetween(row, from, to) !== undefined ||
  (!model.joined.has(`${from.id} exit`) && !model.joined.has(`${to.id} enter`));

/**
 * What a click on a transition does with what is selected, as commands of one step: a transition
 * that is selected becomes it, as long as it was; the clips selected get one that comes in at their
 * start and one that goes out at their end, and each pair of them that touch gets one that goes
 * between them there. See docs/design/resource-panels.md, section 7.
 */
export function attachCalls(
  model: TimelineModel,
  context: AttachContext,
  use: TransitionUse,
  pick: TransitionPick,
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
        const calls = context.pairs.flatMap(([row, from, to]) => {
          const made = fitsRow(pick, row) ? joinCall(model, row, from, to, pick) : undefined;
          return made ? [made.call] : [];
        });
        return withSoundAlong(model, calls);
      }
      return context.boxes.flatMap((box) => {
        const row = model.rowOfClip.get(box.id);
        const call = row && fitsRow(pick, row) ? edgesCall(model, box, [use], pick) : undefined;
        return call ? [call] : [];
      });
  }
}
