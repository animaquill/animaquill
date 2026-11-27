import { clipPath, joinPath } from "./clip-edits.ts";
import type { Draft, Step } from "./draft.ts";
import { orderedTracks, type ProjectState, type TimelineState, type TrackState } from "./model.ts";

/** What a batch of commands cleans up after itself, in the same step. */
export interface Tidying {
  /** A track that the batch left without clips goes too, see `emptiedTracks`. */
  readonly emptyTracks: boolean;
}

export const NO_TIDYING: Tidying = { emptyTracks: false };

/** A track of a timeline. */
export interface TrackOf {
  readonly timeline: string;
  readonly track: string;
}

const trackPath = (timeline: string, track: string) => ["timelines", timeline, "tracks", track];

/** Removes a track, the clips on it and the joins between them, as `track.remove` does. */
export function removeTrackIn(draft: Draft, timeline: string, track: string): void {
  const target = draft.state.timelines[timeline];
  if (!target) return;
  for (const clip of Object.values(target.clips)) {
    if (clip.track === track) draft.delete(clipPath(timeline, clip.id));
  }
  for (const [id, join] of Object.entries(target.joins ?? {})) {
    if (join.track === track) draft.delete(joinPath(timeline, id));
  }
  draft.delete(trackPath(timeline, track));
}

const isSet = (value: unknown) => value !== undefined;
const isNotEmpty = (value: unknown) => Array.isArray(value) && value.length > 0;

/**
 * Whether a track keeps what people set on it, so that it stays when its clips go: a name, a lock,
 * hidden, muted or solo, a group, a role or an output, or anything of the mixer. What is `false` is
 * as good as not there, so nothing would get lost with it. A volume set back to 0 dB still counts.
 */
export function keepsEmptyTrack(track: TrackState): boolean {
  const fields = track as Partial<Record<string, unknown>>;
  if (typeof track.name === "string" && track.name.trim() !== "") return true;
  if (["locked", "hidden", "muted", "solo"].some((key) => fields[key] === true)) return true;
  if (["group", "role", "output"].some((key) => isSet(fields[key]))) return true;
  const properties = fields["properties"];
  if (typeof properties === "object" && properties !== null && Object.keys(properties).length > 0)
    return true;
  return isNotEmpty(fields["effects"]) || isNotEmpty(fields["sends"]);
}

/** The clips the steps touched, by timeline: undefined where they touched all of its clips. */
function touchedClips(
  before: ProjectState,
  steps: readonly Step[],
): Map<string, Set<string> | undefined> {
  const touched = new Map<string, Set<string> | undefined>();
  for (const { patch } of steps) {
    const { path } = patch;
    if (path[0] !== "timelines") continue;
    if (path[1] === undefined) {
      for (const timeline of Object.keys(before.timelines)) touched.set(timeline, undefined);
      continue;
    }
    const timeline = String(path[1]);
    if (!before.timelines[timeline]) continue;
    if (path.length === 2 || (path.length === 3 && path[2] === "clips")) {
      touched.set(timeline, undefined);
    } else if (path[2] === "clips" && path[3] !== undefined) {
      if (touched.has(timeline) && touched.get(timeline) === undefined) continue;
      const clips = touched.get(timeline) ?? new Set<string>();
      touched.set(timeline, clips.add(String(path[3])));
    }
  }
  return touched;
}

const counted = new WeakMap<object, ReadonlyMap<string, number>>();

/**
 * How many clips each track has. The project before a change is the same for every dry run of what
 * people might do next, so this is counted once for it.
 */
function clipCounts(clips: TimelineState["clips"]): ReadonlyMap<string, number> {
  const known = counted.get(clips);
  if (known) return known;
  const counts = new Map<string, number>();
  for (const id in clips) {
    const track = (clips[id] as { track: string }).track;
    counts.set(track, (counts.get(track) ?? 0) + 1);
  }
  counted.set(clips, counts);
  return counts;
}

/**
 * The tracks a change took clips off, which it left with none: of each timeline, by how many each
 * had and which clips came and went.
 */
function emptiedOf(
  was: TimelineState,
  now: TimelineState,
  clips: ReadonlySet<string> | undefined,
): readonly string[] {
  if (!clips) {
    const left = new Set<string>();
    for (const clip of Object.values(was.clips)) left.add(clip.track);
    const counts = clipCounts(now.clips);
    return [...left].filter((track) => !counts.has(track));
  }
  const change = new Map<string, number>();
  for (const id of clips) {
    const from = was.clips[id]?.track;
    const to = now.clips[id]?.track;
    if (from === to) continue;
    if (from !== undefined) change.set(from, (change.get(from) ?? 0) - 1);
    if (to !== undefined) change.set(to, (change.get(to) ?? 0) + 1);
  }
  const lost = [...change].filter(([, by]) => by < 0);
  if (lost.length === 0) return [];
  const counts = clipCounts(was.clips);
  return lost.filter(([track, by]) => (counts.get(track) ?? 0) + by === 0).map(([track]) => track);
}

/**
 * The tracks a change left without clips, which go with it; see `keepsEmptyTrack`. Only tracks that
 * had a clip the change took away or moved off: a track that was empty, or that the change added,
 * stays. Neither does a timeline lose its last video track or its last audio track, the first of
 * them staying, nor its last track of any kind.
 */
export function emptiedTracks(
  before: ProjectState,
  after: ProjectState,
  steps: readonly Step[],
): readonly TrackOf[] {
  const removed: TrackOf[] = [];
  for (const [timeline, clips] of touchedClips(before, steps)) {
    const was = before.timelines[timeline];
    const now = after.timelines[timeline];
    if (!was || !now) continue;
    const going = emptiedOf(was, now, clips).filter((id) => {
      const track = now.tracks[id];
      return track !== undefined && !keepsEmptyTrack(track);
    });
    if (going.length === 0) continue;
    const ordered = orderedTracks(now);
    const leaving = new Set(going);
    // A timeline always has a video track and an audio track, as in Premiere and Resolve: the
    // first of a kind stays where all of that kind would go. Captions have no such floor.
    for (const kind of ["video", "audio"]) {
      const ofKind = ordered.filter((track) => track.kind === kind);
      const first = ofKind[0];
      if (first && ofKind.every((track) => leaving.has(track.id))) leaving.delete(first.id);
    }
    // Nor does a timeline lose its last track, of whatever kind.
    if (ordered.every((track) => leaving.has(track.id))) {
      const stays = ordered[0];
      if (stays) leaving.delete(stays.id);
    }
    // In the order of the timeline, so that what it says does not depend on the commands.
    for (const track of ordered)
      if (leaving.has(track.id)) removed.push({ timeline, track: track.id });
  }
  return removed;
}

/** Removes what `emptiedTracks` finds the draft left without clips, in the same draft. */
export function removeEmptiedTracks(before: ProjectState, draft: Draft): readonly TrackOf[] {
  const removed = emptiedTracks(before, draft.state, draft.steps);
  for (const { timeline, track } of removed) removeTrackIn(draft, timeline, track);
  return removed;
}
