import {
  clipEnd,
  clipStart,
  joinedEdges,
  orderedTracks,
  timelineLength,
  trackKindFor,
  type ClipState,
  type TimelineState,
  type TrackState,
} from "@animaquill/core";
import {
  compare,
  findTransition,
  isSupported,
  mediaOfTrack,
  parseTime,
  toSeconds,
  type Rational,
  type Transition,
} from "@animaquill/schema";
import { frameRate, type FrameRate } from "./frames.ts";

const ROW_HEIGHTS: Readonly<Record<TrackState["kind"], number>> = {
  caption: 32,
  video: 52,
  audio: 44,
};

/** The transitions at the start and the end of a clip, by the field that holds each. */
export type Edge = "enter" | "exit";

export const EDGES: readonly Edge[] = ["enter", "exit"];

/**
 * Whether people can put transitions on the clips of a track. Only the picture does them so far:
 * sound and captions get theirs later. What a file gave them still shows, and can be taken away.
 */
export const canHaveTransitions = (track: TrackState): boolean => track.kind === "video";

/** How long a transition is in seconds, as it shows: never longer than its clip. */
function secondsOfEdge(transition: Transition | undefined, clip: ClipState): number {
  if (transition === undefined) return 0;
  try {
    const seconds = Math.min(
      toSeconds(parseTime(transition.duration)),
      toSeconds(parseTime(clip.duration)),
    );
    return Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  } catch {
    return 0;
  }
}

/** How long the transitions at the edges of a clip are, in seconds, for drawing and finding them. */
export const edgesOf = (clip: ClipState): Readonly<Record<Edge, number>> => ({
  enter: secondsOfEdge(clip.enter, clip),
  exit: secondsOfEdge(clip.exit, clip),
});

/**
 * Whether the transition at an edge of a clip does what it says. One that this editor cannot do yet,
 * or that a join wins over, stays as it is and shows that it does not.
 */
export function edgeWorks(model: TimelineModel, box: ClipBox, edge: Edge): boolean {
  const transition = box.clip[edge];
  const track = model.rowOfClip.get(box.id)?.track;
  if (!transition || !track || track.kind === "caption") return false;
  if (model.joined.has(`${box.id} ${edge}`)) return false;
  const media = mediaOfTrack(track.kind);
  return isSupported(findTransition(transition, media, edge), media, edge);
}

/** How much room tracks need under their clips. */
export type RoomBelow = ReadonlyMap<string, number>;

export const NO_ROOM_BELOW: RoomBelow = new Map();

/** A clip as the timeline draws it. Times are floats: fine for drawing, not for saving. */
export interface ClipBox {
  readonly id: string;
  readonly clip: ClipState;
  readonly start: number;
  readonly end: number;
  /** What the clock of the clip reads at its start. */
  readonly offset: number;
}

/** A track as the timeline shows it. */
export interface Row {
  readonly id: string;
  readonly track: TrackState;
  /** Counted per kind from the first track, as in V1 and V2. */
  readonly number: number;
  /** Distance from the top of the first row. */
  readonly top: number;
  readonly height: number;
  /** Room under the clips for what belongs to them, which is not part of the row itself. */
  readonly below: number;
  /** In time order. */
  readonly clips: readonly ClipBox[];
  /** The latest end so far at each clip. Clips can overlap after a merge, so ends are not sorted. */
  readonly reach: Float64Array;
  /**
   * Somebody removed this track while somebody else put clips on it. The row keeps those in sight,
   * so that people can move them to a real track or delete them.
   */
  readonly gone: boolean;
}

/** A timeline prepared for drawing and for finding things quickly. */
export interface TimelineModel {
  readonly id: string;
  readonly state: TimelineState;
  /** As written in the project, to notice when it changes. */
  readonly fps: string;
  /** How tall rows are shown, 1 being the normal height. */
  readonly rowScale: number;
  /** What `below` of each row comes from, by track. */
  readonly roomBelow: RoomBelow;
  readonly rate: FrameRate;
  /** Top to bottom. */
  readonly rows: readonly Row[];
  /** Seconds. */
  readonly duration: number;
  readonly height: number;
  readonly boxes: ReadonlyMap<string, ClipBox>;
  readonly rowOfClip: ReadonlyMap<string, Row>;
  /** Clips that belong together, like the picture and the sound of a video. */
  readonly links: ReadonlyMap<string, readonly string[]>;
  /** The edges of clips that a join wins over, as `<clip> enter` and `<clip> exit`. */
  readonly joined: ReadonlySet<string>;
}

const secondsOf = (time: string) =>
  time.includes("/") ? toSeconds(parseTime(time)) : Number(time);

/** Unchanged clips keep their identity from one state to the next, so most of this is free. */
const boxes = new WeakMap<ClipState, ClipBox>();

function boxOf(clip: ClipState): ClipBox {
  let box = boxes.get(clip);
  if (!box) {
    const start = secondsOf(clip.start);
    const offset = clip.offset === undefined ? 0 : secondsOf(clip.offset);
    box = { id: clip.id, clip, start, end: start + secondsOf(clip.duration), offset };
    boxes.set(clip, box);
  }
  return box;
}

const inTimeOrder = (a: ClipBox, b: ClipBox) => a.start - b.start || a.id.localeCompare(b.id);

function reachOf(clips: readonly ClipBox[]): Float64Array {
  const reach = new Float64Array(clips.length);
  let latest = -Infinity;
  clips.forEach((box, index) => {
    latest = Math.max(latest, box.end);
    reach[index] = latest;
  });
  return reach;
}

/** Tracks that are gone but still have clips. */
function goneTracks(state: TimelineState): readonly TrackState[] {
  const gone = new Map<string, TrackState>();
  for (const clip of Object.values(state.clips)) {
    if (state.tracks[clip.track] || gone.has(clip.track)) continue;
    const track = { id: clip.track, kind: trackKindFor(clip), order: 0 };
    gone.set(clip.track, track as TrackState);
  }
  return [...gone.values()];
}

/** Captions on top, the front of the picture above its back, and sound below all of that. */
function displayOrder(state: TimelineState): readonly (readonly [TrackState, number])[] {
  const all = [...orderedTracks(state), ...goneTracks(state)];
  const ofKind = (kind: TrackState["kind"]) =>
    all.filter((track) => track.kind === kind).map((track, index) => [track, index + 1] as const);
  return [...ofKind("caption").toReversed(), ...ofKind("video").toReversed(), ...ofKind("audio")];
}

export function buildModel(
  id: string,
  state: TimelineState,
  fps: string,
  rowScale = 1,
  roomBelow: RoomBelow = NO_ROOM_BELOW,
): TimelineModel {
  const clipsByTrack = new Map<string, ClipBox[]>();
  const all = new Map<string, ClipBox>();
  const links = new Map<string, string[]>();
  for (const clip of Object.values(state.clips)) {
    const box = boxOf(clip);
    all.set(box.id, box);
    if (clip.link !== undefined) links.set(clip.link, [...(links.get(clip.link) ?? []), clip.id]);
    const list = clipsByTrack.get(clip.track);
    if (list) list.push(box);
    else clipsByTrack.set(clip.track, [box]);
  }

  let top = 0;
  const rowOfClip = new Map<string, Row>();
  const rows = displayOrder(state).map(([track, number]) => {
    const clips = (clipsByTrack.get(track.id) ?? []).toSorted(inTimeOrder);
    const height = Math.round(ROW_HEIGHTS[track.kind] * rowScale);
    const gone = !state.tracks[track.id];
    const below = roomBelow.get(track.id) ?? 0;
    const row: Row = {
      id: track.id,
      track,
      number,
      top,
      height,
      below,
      clips,
      reach: reachOf(clips),
      gone,
    };
    for (const box of clips) rowOfClip.set(box.id, row);
    top += height + below;
    return row;
  });

  return {
    id,
    state,
    fps,
    rowScale,
    roomBelow,
    rate: frameRate(fps),
    rows,
    duration: toSeconds(timelineLength(state)),
    height: top,
    boxes: all,
    rowOfClip,
    links,
    joined: joinedEdges(state),
  };
}

/** Whether a moment is strictly inside a clip, which is what it takes to cut there. */
export const isInsideClip = (clip: ClipState, moment: Rational): boolean =>
  compare(moment, clipStart(clip)) > 0 && compare(moment, clipEnd(clip)) < 0;

/** The row at a distance from the top of the first row. */
export function rowAt(model: TimelineModel, y: number): Row | undefined {
  return model.rows.find((row) => y >= row.top && y < row.top + row.height);
}

/** The first clip of a row that ends after a moment. */
export function firstEndingAfter(row: Row, seconds: number): number {
  let low = 0;
  let high = row.clips.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if ((row.reach[middle] as number) > seconds) high = middle;
    else low = middle + 1;
  }
  return low;
}

/** Calls back with the clips of a row that show between two moments, in time order. */
export function forEachBetween(
  row: Row,
  from: number,
  to: number,
  visit: (box: ClipBox) => void,
): void {
  for (let index = firstEndingAfter(row, from); index < row.clips.length; index++) {
    const box = row.clips[index] as ClipBox;
    if (box.start >= to) return;
    if (box.end > from) visit(box);
  }
}

/** The clip under a moment. A later clip lies on top of an earlier one. */
export function clipAt(row: Row, seconds: number): ClipBox | undefined {
  let found: ClipBox | undefined;
  forEachBetween(row, seconds, Number.POSITIVE_INFINITY, (box) => {
    if (box.start <= seconds) found = box;
  });
  return found;
}
