import {
  channelOf,
  clipEnd,
  clipOffset,
  clipStart,
  effectiveProperties,
  entryOf,
  firstKeyFrom,
  firstValue,
  objectsOf,
  sample,
  valueWithout,
  type ClipState,
  type ProjectState,
  type PropertyEdit,
} from "@animaquill/core";
import {
  add,
  compare,
  formatTime,
  isAnimation,
  parseTime,
  subtract,
  toSeconds,
  type Key,
  type ObjectDescriptor,
  type PropertySpec,
  type PropertyValue,
  type Rational,
  type Value,
} from "@animaquill/schema";
import { frameContaining, frameTime } from "../timeline/frames.ts";
import type { ClipBox, TimelineModel } from "../timeline/model.ts";

/** A property as a control shows it at the playhead. */
export interface PropertyRow {
  readonly spec: PropertySpec;
  /** Where the clip stores it. */
  readonly path: string;
  /** What the project holds. */
  readonly stored: PropertyValue | undefined;
  /** What it comes to at the playhead. */
  readonly value: Value | undefined;
  /** It has no value of its own and follows something else, like a clip box without a size. */
  readonly automatic: boolean;
  readonly animated: boolean;
  /** When the key of this frame is, on the clock of the clip. An edit goes there. */
  readonly keyTime: string | undefined;
  /** The frames of the nearest keys inside the clip. */
  readonly previousKey: number | undefined;
  readonly nextKey: number | undefined;
  /** What it shows is being tried, and not in the project yet. */
  readonly tried: boolean;
  /** Somebody else changed what the project holds since people started to try this. */
  readonly changedElsewhere: boolean;
}

/** What is being tried out, as far as showing it goes. */
export interface TrialLook {
  apply(clip: ClipState): ClipState;
  holds(clip: string, path: string): boolean;
  changedElsewhere(clip: string, path: string): boolean;
}

export interface InspectedObject {
  readonly object: ObjectDescriptor;
  readonly rows: readonly PropertyRow[];
}

/**
 * What a control writes. It goes to the key of this frame, which does not have to be on the frame.
 * What cannot have keys has no moment to write at, also where a hand-written project has some.
 */
export function writeEdit(
  clip: string,
  row: PropertyRow,
  time: string,
  value: Value,
): PropertyEdit {
  const target = { owner: { clip }, path: row.path };
  return row.spec.animatable === false
    ? { ...target, op: "set", value }
    : { ...target, op: "write", time: row.keyTime ?? time, value };
}

/** What the diamond does: takes the key of this frame away, or writes one with what is showing. */
export function keyEdit(clip: string, row: PropertyRow, time: string): PropertyEdit | undefined {
  const target = { owner: { clip }, path: row.path };
  if (row.keyTime !== undefined) return { ...target, op: "removeKey", time: row.keyTime };
  return row.value === undefined ? undefined : { ...target, op: "setKey", time, value: row.value };
}

/** Why nothing can be changed right now. */
export type Blocked = "locked" | "outside" | "comparing";

export type Inspection =
  /** Nothing is selected. */
  | { readonly kind: "nothing" }
  /** Selected, but it has no properties to show. */
  | { readonly kind: "no-properties" }
  /** One at a time. */
  | { readonly kind: "several"; readonly count: number }
  | {
      readonly kind: "clip";
      readonly box: ClipBox;
      readonly blocked: Blocked | undefined;
      /** The clock of the clip at the playhead, exactly, as keys write it. */
      readonly time: string;
      /** The first frame that shows the clip, for getting there. */
      readonly firstFrame: number;
      readonly objects: readonly InspectedObject[];
    };

/** Whether the picture of a moment has this clip in it. The end belongs to what comes next. */
const shows = (clip: ClipState, moment: Rational) =>
  compare(moment, clipStart(clip)) >= 0 && compare(moment, clipEnd(clip)) < 0;

/** A clip does not have to start on a frame, and the frame before it does not show it. */
function firstFrameOf(clip: ClipState, model: TimelineModel): number {
  const frame = frameContaining(clipStart(clip), model.rate);
  return shows(clip, frameTime(frame, model.rate)) ? frame : frame + 1;
}

/** Where a moment on the timeline is on the clock of a clip. */
const clockAt = (clip: ClipState, moment: Rational) =>
  add(clipOffset(clip), subtract(moment, clipStart(clip)));

/** Where a key is on the timeline. */
const momentOf = (clip: ClipState, key: Key) =>
  add(clipStart(clip), subtract(parseTime(key.time), clipOffset(clip)));

interface Place {
  readonly state: ProjectState;
  readonly model: TimelineModel;
  readonly clip: ClipState;
  /** The moment of the playhead on the timeline, and on the clock of the clip. */
  readonly moment: Rational;
  readonly clock: Rational;
  readonly firstFrame: number;
  /**
   * The part of the clock that belongs to the frame of the playhead. Keys do not have to be on a
   * frame, and each one has to be somewhere people can get to. So a frame stands for all the time
   * until the next one, and the first frame of a clip also for what comes before it in that clip.
   */
  readonly from: Rational;
  readonly to: Rational;
}

function placeOf(state: ProjectState, model: TimelineModel, clip: ClipState, frame: number): Place {
  // As for cutting at the playhead: a float would not land on a key that is exactly there.
  const moment = frameTime(frame, model.rate);
  const firstFrame = firstFrameOf(clip, model);
  const start = frame === firstFrame ? clipStart(clip) : moment;
  const next = frameTime(frame + 1, model.rate);
  const end = compare(next, clipEnd(clip)) < 0 ? next : clipEnd(clip);
  return {
    state,
    model,
    clip,
    moment,
    clock: clockAt(clip, moment),
    firstFrame,
    from: clockAt(clip, start),
    to: clockAt(clip, compare(end, start) > 0 ? end : next),
  };
}

/** The frame that stands for a key: see `from`. */
const frameOfKey = ({ clip, model, firstFrame }: Place, key: Key | undefined) =>
  key && Math.max(frameContaining(momentOf(clip, key), model.rate), firstFrame);

function rowOf(spec: PropertySpec, place: Place, look: TrialLook | undefined): PropertyRow {
  const { state, clip, moment, clock, from, to } = place;
  const properties = effectiveProperties(clip);
  const { path } = spec;
  const stored = entryOf(properties, path);
  const channel = stored === undefined ? undefined : channelOf(stored, spec.type);
  const keys = stored !== undefined && isAnimation(stored) ? stored.keys : [];
  // Only what the clip shows of them: what was trimmed away is out of reach.
  const first = firstKeyFrom(keys, clockAt(clip, clipStart(clip)));
  const end = firstKeyFrom(keys, clockAt(clip, clipEnd(clip)));
  const before = Math.min(firstKeyFrom(keys, from), end);
  const after = Math.max(firstKeyFrom(keys, to), first);
  const under = before >= first && before < after ? keys[before] : undefined;
  let value: Value | undefined;
  if (spec.animatable === false && stored !== undefined) value = firstValue(stored);
  else if (under) value = under.value;
  else if (channel) value = sample(channel, toSeconds(clock));
  else value = valueWithout(state, clip, spec, toSeconds(moment));
  return {
    spec,
    path,
    stored,
    value,
    automatic: stored === undefined && spec.default === undefined,
    animated: keys.length > 0,
    keyTime: under?.time,
    previousKey: before > first ? frameOfKey(place, keys[before - 1]) : undefined,
    nextKey: after < end ? frameOfKey(place, keys[after]) : undefined,
    tried: look?.holds(clip.id, path) === true,
    changedElsewhere: look?.changedElsewhere(clip.id, path) === true,
  };
}

function blockedAt({ model, clip, moment }: Place, comparing: boolean | undefined) {
  if (comparing) return "comparing";
  if (model.rowOfClip.get(clip.id)?.track.locked) return "locked";
  return shows(clip, moment) ? undefined : "outside";
}

function inspectClip(
  state: ProjectState,
  model: TimelineModel,
  box: ClipBox,
  frame: number,
  { look, comparing }: TrialView,
): Inspection {
  const clip = look?.apply(box.clip) ?? box.clip;
  const place = placeOf(state, model, clip, frame);
  return {
    kind: "clip",
    box,
    blocked: blockedAt(place, comparing),
    time: formatTime(place.clock),
    firstFrame: place.firstFrame,
    objects: objectsOf(clip).map((object) => ({
      object,
      rows: object.properties.map((spec) => rowOf(spec, place, look)),
    })),
  };
}

/** One property of a clip at the playhead, as a control needs it. */
export interface InspectedProperty {
  readonly row: PropertyRow;
  readonly blocked: Blocked | undefined;
  /** The clock of the clip at the playhead, exactly, as keys write it. */
  readonly time: string;
}

export function inspectProperty(
  state: ProjectState,
  model: TimelineModel,
  box: ClipBox,
  spec: PropertySpec,
  frame: number,
  { look, comparing }: TrialView = {},
): InspectedProperty {
  const clip = look?.apply(box.clip) ?? box.clip;
  const place = placeOf(state, model, clip, frame);
  return {
    row: rowOf(spec, place, look),
    blocked: blockedAt(place, comparing),
    time: formatTime(place.clock),
  };
}

/** What the tab goes by apart from the project. */
export interface TrialView {
  /** What goes on top of the project. */
  readonly look?: TrialLook | undefined;
  /** People are looking at what is saved, so what they see is not what an edit would start from. */
  readonly comparing?: boolean;
}

/**
 * What the properties tab shows. Picture and sound of a video are selected together and only one of
 * them has anything to show here, so it comes down to the clips that do.
 */
export function inspect(
  state: ProjectState,
  model: TimelineModel,
  selection: ReadonlySet<string>,
  frame: number,
  trial: TrialView = {},
): Inspection {
  if (selection.size === 0) return { kind: "nothing" };
  const boxes = [...selection].flatMap((id) => {
    const box = model.boxes.get(id);
    return box && objectsOf(box.clip).length > 0 ? [box] : [];
  });
  const [box] = boxes;
  if (!box) return { kind: "no-properties" };
  if (boxes.length > 1) return { kind: "several", count: boxes.length };
  return inspectClip(state, model, box, frame, trial);
}
