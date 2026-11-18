import { MASTER_CLIP, effectStates, type ClipState, type PropertyOwner } from "@animaquill/core";
import { formatTime, type PropertyValue } from "@animaquill/schema";
import { frameTime } from "../timeline/frames.ts";
import type { ClipBox, Row, TimelineModel } from "../timeline/model.ts";

/**
 * A track of sound, as what has properties: its volume and its pan, keyed on the timeline's time.
 * The properties tab and the keyframe tab are made for clips, and a track has the same two rows a
 * clip of sound has, so it shows there as a clip of its own that covers all of the timeline, whose
 * clock is the timeline's time. Nothing of it is in the project: edits of it go to the track, see
 * `ownerOf`.
 */

/** Ids of clips never start with this, see `Id`: no clip can be taken for a track. */
const PREFIX = "~track:";

/** The clip that stands for a track. */
export const trackClipId = (track: string): string => `${PREFIX}${track}`;

/**
 * The master of the timeline, which shows the same way: a clip of its own over all of it, with its
 * volume, its safe limiter and its effects. Selected, it is what `TimelineSnapshot.track` holds.
 */
export { MASTER_CLIP };

/** The track a clip stands for, if it stands for one. */
export const trackOfClip = (clip: string): string | undefined =>
  clip.startsWith(PREFIX) ? clip.slice(PREFIX.length) : undefined;

/**
 * What a clip that stands for a track or the master stands for, as `TimelineSnapshot.track` holds
 * it when it is selected; undefined for a clip of the timeline.
 */
export const standsFor = (clip: string): string | undefined =>
  clip === MASTER_CLIP ? MASTER_CLIP : trackOfClip(clip);

/** Whose property an edit of a clip is: the track it stands for, or the clip itself. */
export function ownerOf(clip: string): PropertyOwner {
  if (clip === MASTER_CLIP) return { master: true };
  const track = trackOfClip(clip);
  return track === undefined ? { clip } : { track };
}

/** Where an effect of a clip is, for the commands of effects: on the clip, its track or the master. */
export function effectTargetOf(
  clip: string,
): { readonly clip: string } | { readonly track: string } | { readonly master: true } {
  return ownerOf(clip);
}

const single = new WeakMap<TimelineModel, Map<string, TimelineModel>>();

/**
 * The timeline with the clip of a selected track of sound among its clips, for what shows the
 * properties of what is selected; the timeline itself as it is when no such track is selected.
 * The same model and track give the same object.
 */
export function withTrackClip(model: TimelineModel, track: string | undefined): TimelineModel {
  if (track === undefined) return model;
  const row = model.rows.find((one) => one.id === track);
  const master = track === MASTER_CLIP;
  if (!master && (row?.track.kind !== "audio" || row.gone)) return model;
  let own = single.get(model);
  if (!own) single.set(model, (own = new Map()));
  const known = own.get(track);
  if (known) return known;
  const box = master || !row ? masterBoxOf(model) : trackBoxOf(model, row);
  const boxes = new Map(model.boxes).set(box.id, box);
  const rowOfClip = row ? new Map(model.rowOfClip).set(box.id, row) : model.rowOfClip;
  const shown: TimelineModel = { ...model, boxes, rowOfClip };
  own.set(track, shown);
  return shown;
}

const all = new WeakMap<TimelineModel, TimelineModel>();

/** The timeline with the clips of all its tracks of sound, as the mixer has them. */
export function withTrackClips(model: TimelineModel): TimelineModel {
  const known = all.get(model);
  if (known) return known;
  const sound = model.rows.filter((row) => row.track.kind === "audio" && !row.gone);
  const boxes = new Map(model.boxes);
  const master = masterBoxOf(model);
  boxes.set(master.id, master);
  const rowOfClip = new Map(model.rowOfClip);
  for (const row of sound) {
    const box = trackBoxOf(model, row);
    boxes.set(box.id, box);
    rowOfClip.set(box.id, row);
  }
  const shown: TimelineModel = { ...model, boxes, rowOfClip };
  all.set(model, shown);
  return shown;
}

const masters = new WeakMap<TimelineModel, ClipBox>();

/** The clip of a track: from 0 to a frame past the end, so that every frame is on it. */
function trackBoxOf(model: TimelineModel, row: Row): ClipBox {
  const { track } = row;
  const effects = "effects" in track ? effectStates(track.effects) : undefined;
  return boxOf(model, {
    id: trackClipId(track.id),
    track: track.id,
    ...("properties" in track && track.properties && { properties: track.properties }),
    ...(effects && { effects }),
  });
}

/** The clip of the master, the same way. The same model gives the same object. */
function masterBoxOf(model: TimelineModel): ClipBox {
  const known = masters.get(model);
  if (known) return known;
  const master = model.state.mix?.master;
  const effects = effectStates(master?.effects);
  const box = boxOf(model, {
    id: MASTER_CLIP,
    track: MASTER_CLIP,
    ...(master?.properties && { properties: master.properties }),
    ...(effects && { effects }),
  });
  masters.set(model, box);
  return box;
}

function boxOf(model: TimelineModel, fields: Partial<ClipState> & { id: string }): ClipBox {
  const frames = Math.ceil(model.duration * model.rate.fps - 1e-9) + 1;
  const end = frameTime(frames, model.rate);
  const clip = {
    start: "0",
    duration: formatTime(end),
    source: { kind: "sound" },
    ...fields,
  } as ClipState;
  return { id: clip.id, clip, start: 0, end: frames / model.rate.fps, offset: 0 };
}

type Tried = ReadonlyMap<string, ReadonlyMap<string, PropertyValue | undefined>>;

type Parted = {
  readonly clips: Tried;
  readonly tracks: Tried;
  /** What is tried on the master, by path. */
  readonly master: ReadonlyMap<string, PropertyValue | undefined> | undefined;
};

const parted = new WeakMap<Tried, Parted>();

/**
 * What is tried on clips and what on tracks, apart, for the mix: the same values give the same
 * objects, so that the mix knows when nothing changed.
 */
export function triedApart(tried: Tried): Parted {
  const known = parted.get(tried);
  if (known) return known;
  const clips = new Map<string, ReadonlyMap<string, PropertyValue | undefined>>();
  const tracks = new Map<string, ReadonlyMap<string, PropertyValue | undefined>>();
  let master: ReadonlyMap<string, PropertyValue | undefined> | undefined;
  for (const [id, values] of tried) {
    if (id === MASTER_CLIP) {
      master = values;
      continue;
    }
    const track = trackOfClip(id);
    if (track === undefined) clips.set(id, values);
    else tracks.set(track, values);
  }
  const made = { clips: tracks.size === 0 && !master ? tried : clips, tracks, master };
  parted.set(tried, made);
  return made;
}
