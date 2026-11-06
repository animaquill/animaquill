import {
  clipEnd,
  clipStart,
  orderedTracks,
  timelineLength,
  trackKindFor,
  type ClipState,
  type TimelineState,
  type TrackState,
} from "@animaquill/core";
import { compare, parseTime, toSeconds, type Rational } from "@animaquill/schema";
import { frameRate, type FrameRate } from "./frames.ts";

const ROW_HEIGHTS: Readonly<Record<TrackState["kind"], number>> = {
  caption: 32,
  video: 52,
  audio: 44,
};

/** A clip as the timeline draws it. Times are floats: fine for drawing, not for saving. */
export interface ClipBox {
  readonly id: string;
  readonly clip: ClipState;
  readonly start: number;
  readonly end: number;
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
}

const secondsOf = (time: string) =>
  time.includes("/") ? toSeconds(parseTime(time)) : Number(time);

/** Unchanged clips keep their identity from one state to the next, so most of this is free. */
const boxes = new WeakMap<ClipState, ClipBox>();

function boxOf(clip: ClipState): ClipBox {
  let box = boxes.get(clip);
  if (!box) {
    const start = secondsOf(clip.start);
    box = { id: clip.id, clip, start, end: start + secondsOf(clip.duration) };
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
    const row: Row = {
      id: track.id,
      track,
      number,
      top,
      height,
      clips,
      reach: reachOf(clips),
      gone,
    };
    for (const box of clips) rowOfClip.set(box.id, row);
    top += height;
    return row;
  });

  return {
    id,
    state,
    fps,
    rowScale,
    rate: frameRate(fps),
    rows,
    duration: toSeconds(timelineLength(state)),
    height: top,
    boxes: all,
    rowOfClip,
    links,
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
