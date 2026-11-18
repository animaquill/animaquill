import {
  Asset,
  Clip,
  ClipSource,
  Duration,
  Id,
  KnownProperties,
  Marker,
  MediaInfo,
  ProjectManifest,
  PropertyPath,
  PropertyValue,
  RETIRED_PROPERTIES,
  ResourceTags,
  Time,
  Track,
  Transition,
  TIME_PATTERN,
  ZERO,
  add,
  canHold,
  cannotHaveKeys,
  compare,
  findTransition,
  formatTime,
  isElsewhere,
  isSameHash,
  isSupported,
  mediaOfTrack,
  newId,
  normalizeTime,
  parseTime,
  subtract,
} from "@animaquill/schema";
import { z } from "zod";
import {
  assertFree,
  clearSpans,
  clipPath,
  extendToFit,
  fitEffects,
  fitTransitions,
  followJoins,
  joinPath,
  joinsAtEdgesOf,
  joinsTogether,
  removeClips,
  spanOf,
  splitClip,
  timelineOf,
  timelinePath,
  trimClip,
  PieceLinks,
  expectCuts,
  type Edge,
  type JoinedEdges,
  type Span,
} from "./clip-edits.ts";
import { fail, type Draft } from "./draft.ts";
import { formatFailure, nameOf, named, type FailureCode } from "./failures.ts";
import {
  EffectAdd,
  EffectMove,
  EffectRemove,
  EffectUpdate,
  addEffect,
  checkEffectWrite,
  checkListedWrite,
  updateMaster,
  moveEffect,
  removeEffects,
  updateEffect,
} from "./effect-edits.ts";
import {
  JoinAdd,
  JoinRemove,
  JoinUpdate,
  addJoin,
  checkValues,
  removeJoins,
  updateJoin,
} from "./join-edits.ts";
import { joinedEndsOf, takenAt, type JoinedEnds } from "./joins.ts";
import {
  clipEnd,
  clipFileOf,
  clipOffset,
  clipStart,
  clipStateOf,
  entryOf,
  orderedSections,
  orderedTracks,
  sourceLength,
  timelineLength,
  trackKindFor,
  type ClipState,
  type TimelineState,
  type TrackState,
} from "./model.ts";
import { STORAGE, type Origin } from "./origin.ts";
import { moveBoundary, removeSection, splitSection } from "./section-edits.ts";
import { rollEdges, slideClips, slipClips } from "./slip-edits.ts";
import {
  checkSpan,
  checkTracks,
  closeGaps,
  liftSpan,
  openGap,
  openRoom,
  rippleTrim,
  type Opened,
  type RippleTrimmed,
  type Rippled,
} from "./ripple-edits.ts";
import {
  BackgroundSet,
  CoverSet,
  CreditsSet,
  DefaultSet,
  DescriptionSet,
  FilesRemoved,
  FormatsSet,
  LanguagesSet,
  LimitedRate,
  setBackground,
  setCover,
  setCredits,
  setDefault,
  setDescription,
  setFormats,
  setLanguages,
} from "./project-edits.ts";
import { deepEqual } from "./patch.ts";
import { StorageChange, setStorage } from "./places.ts";
import {
  PropertyEdit,
  TRACK_PATHS,
  MASTER_PATHS,
  takesPath,
  applyEdit,
  editContextOf,
  retimedValue,
  trackEditContextOf,
  type EditContext,
  type PropertyOwner,
} from "./property-edit.ts";
import { PropertyRename, convertedValue, movesOf } from "./rename.ts";
import { isInUse } from "./references.ts";
import { SourceReplace, removeUses, replaceSource } from "./resource-edits.ts";
import {
  FileRemove,
  FileRename,
  FileWrite,
  SceneAdd,
  SceneRemove,
  SceneUpdate,
  SoundAdd,
  SoundRemove,
  SoundUpdate,
  addScene,
  addSound,
  removeFile,
  removeScene,
  removeSound,
  renameFile,
  updateScene,
  updateSound,
  writeFile,
} from "./scene-edits.ts";
import { codeUsingAsset } from "./scene-plan.ts";
import { takeTheirs } from "./merge-files.ts";

/** A conflict of a merge, as `MergeConflict` says it, whose other side `conflict.take` takes. */
const ConflictTake = z.strictObject({
  conflict: z.object({
    file: z.string().min(1),
    path: z.array(z.string()).min(1),
    kind: z.enum([
      "value",
      "lines",
      "file",
      "order",
      "asset-file",
      "removed-link",
      "check-duplicate",
    ]),
    lines: z
      .strictObject({ from: z.number().int().nonnegative(), to: z.number().int().nonnegative() })
      .optional(),
    ours: z.unknown().optional(),
    theirs: z.unknown().optional(),
    around: z
      .strictObject({ before: z.string().optional(), after: z.string().optional() })
      .optional(),
  }),
});

/**
 * How far an operation reaches. `edit` changes the project, and can be undone; `outside` would change
 * what is outside of the project, such as a library, which only people do, and AI can only propose
 * (none so far); `human` is for people only, such as the tags that lock a project. Reading is no
 * operation: whatever reads has nothing to register.
 */
export type OperationLevel = "edit" | "outside" | "human";

/** What an operation is about, for lists of them. */
export type OperationGroup =
  | "project"
  | "timeline"
  | "track"
  | "clip"
  | "transition"
  | "effect"
  | "property"
  | "marker"
  | "scene"
  | "sound"
  | "asset"
  | "file";

/**
 * A parameter that AI does not see: one that only people can use (`human`), which the store refuses
 * from anyone else, or one that another operation is for (`instead`), which people still use.
 * Parameters inside an object are named by their path, such as `changes.path`.
 */
export interface HiddenParam {
  readonly name: string;
  readonly why: "human" | "instead";
  /** The operation to use instead. */
  readonly instead?: string;
}

/**
 * Whether AI can use an operation, and if not, why: it is for people (`human`), it needs a file
 * that only people can pick (`needs-file`), another one does the same (`duplicate`), or the tools
 * for files do it (`file-tools`). `instead` says what to use.
 */
export type AiUse =
  | "yes"
  | {
      readonly no: "human" | "needs-file" | "duplicate" | "file-tools";
      readonly instead?: string;
    };

/**
 * One operation of the registry, as it runs: what it takes, what it gives back and what can stop
 * it. What AI reads about it, in English, is in `@animaquill/tools`, by its name.
 */
export interface Operation<P = unknown, R = unknown> {
  /** Such as `clip.move`: the name of the command. */
  readonly name: string;
  /** The same, by its older name. */
  readonly type: string;
  readonly group: OperationGroup;
  readonly level: OperationLevel;
  /**
   * What it does, in one sentence for people: the command tools of the browser assistant say it,
   * until the tools of `@animaquill/tools` take over, and the command palette can show it.
   */
  readonly description: string;
  /** The only definition of what it takes. */
  readonly params: z.ZodType<P>;
  /** What it gives back: what it made, what it took away along with it. */
  readonly result: z.ZodType<R>;
  /** What it can fail with, apart from `GENERAL_FAILURES`. Tests hold it to that. */
  readonly failures: readonly FailureCode[];
  run(draft: Draft, params: P): R;
  readonly hiddenParams?: readonly HiddenParam[];
  readonly ai: AiUse;
  /** Can run on a project with a locked tag: the way to take the tag off again. */
  readonly whileLocked?: boolean;
  /**
   * Who else than people can do what only people can: a part of the editor that is no person, such
   * as the uploads that write down where files went. Never an AI task.
   */
  readonly alsoBy?: readonly Origin[];
}

/** An operation by its older name, which most of the editor still uses. */
export type CommandDefinition = Operation;

interface Meta<R extends z.ZodType, A extends AiUse> {
  readonly group: OperationGroup;
  readonly level?: OperationLevel;
  readonly result: R;
  readonly failures: readonly FailureCode[];
  readonly ai?: A;
  readonly hiddenParams?: readonly HiddenParam[];
  readonly whileLocked?: boolean;
  readonly alsoBy?: readonly Origin[];
}

function define<
  const N extends string,
  S extends z.ZodType,
  R extends z.ZodType,
  const A extends AiUse = "yes",
>(
  name: N,
  description: string,
  params: S,
  run: (draft: Draft, params: z.output<S>) => Returned<R>,
  meta: Meta<R, A>,
): Operation<z.output<S>, z.output<R>> & { readonly name: N; readonly ai: A } {
  const { level = "edit", ai = "yes" as A, result, ...rest } = meta;
  return {
    name,
    type: name,
    description,
    params: params as z.ZodType<z.output<S>>,
    result: result as z.ZodType<z.output<R>>,
    run: run as (draft: Draft, params: z.output<S>) => z.output<R>,
    level,
    ai,
    ...rest,
  };
}

/** What `run` gives back for a result: nothing at all where the result can be undefined. */
type Returned<R extends z.ZodType> = undefined extends z.input<R> ? z.input<R> | void : z.input<R>;

/** What an operation gives back when it made nothing worth telling. */
const Nothing = z.undefined();
/** What an operation that made something gives back: its id. */
const Made = z.strictObject({ id: Id });
/** Joins that went away because their clips are no longer next to each other, see `apart`. */
const JoinsRemoved = { joinsRemoved: z.array(Id).readonly().optional() };
const MaybeApart = z.strictObject(JoinsRemoved).optional();
/** What a ripple edit moved back, and took away along with it. */
const RippledFields = {
  moved: z.array(Id).readonly().optional(),
  ...JoinsRemoved,
  sectionsRemoved: z.array(Id).readonly().optional(),
};

/** What a ripple edit says it did: only what there is of it. */
const rippled = ({ moved, joinsRemoved, sectionsRemoved }: Rippled) => ({
  ...(moved.length > 0 && { moved }),
  ...apart(joinsRemoved),
  ...(sectionsRemoved.length > 0 && { sectionsRemoved }),
});

/** Keys that gave way to keys that `retimeKeys` put where they were, by property. */
const RemovedKeys = z.union([
  z.strictObject({ clip: Id, path: z.string(), times: z.array(z.string()).readonly() }),
  z.strictObject({ track: Id, path: z.string(), times: z.array(z.string()).readonly() }),
  z.strictObject({
    master: z.literal(true),
    path: z.string(),
    times: z.array(z.string()).readonly(),
  }),
]);
type RemovedKeys = z.output<typeof RemovedKeys>;
const EditedProperties = z.strictObject({ removed: z.array(RemovedKeys).readonly() }).optional();

/** A stretch of a timeline, from a moment to a later one. */
const Range = z.strictObject({ from: Time, to: Time });
/**
 * The tracks that a ripple edit moves; without them all of them. The editor leaves out the tracks
 * that people locked, as video editors do with sync lock.
 */
const RippleTracks = z.array(Id).min(1).optional();

/** A length of time either way: later for more than zero, earlier for less. */
const Shift = z
  .string()
  .regex(TIME_PATTERN, '时间要写成字符串，单位是秒，往前是负数，比如 "-0.5" 或 "1/30"')
  .overwrite(normalizeTime);

const trackPath = (timeline: string, track: string) => ["timelines", timeline, "tracks", track];

/** Clips by id, each once. */
const DistinctClips = z
  .array(Id)
  .refine((ids) => new Set(ids).size === ids.length, "同一个片段只能写一次");

/**
 * Gives clips a link, or takes theirs away. A group they leave that keeps only one clip goes too:
 * a link to nothing would show as one and do nothing.
 */
function setLinks(
  draft: Draft,
  timeline: string,
  target: TimelineState,
  clips: readonly string[],
  link: string | undefined,
): void {
  const listed = new Set(clips);
  const left = new Set<string>();
  for (const id of clips) {
    const before = entryOf(target.clips, id)?.link;
    if (before !== undefined) left.add(before);
    if (before === link) continue;
    const path = [...clipPath(timeline, id), "link"];
    if (link === undefined) draft.delete(path);
    else draft.set(path, link);
  }
  if (left.size === 0) return;
  const staying = new Map<string, string[]>();
  for (const clip of Object.values(target.clips)) {
    if (clip.link === undefined || !left.has(clip.link) || listed.has(clip.id)) continue;
    staying.set(clip.link, [...(staying.get(clip.link) ?? []), clip.id]);
  }
  for (const [, ids] of staying) {
    if (ids.length === 1) draft.delete([...clipPath(timeline, ids[0] as string), "link"]);
  }
}

function trackOf(timeline: TimelineState, id: string): TrackState {
  return entryOf(timeline.tracks, id) ?? fail("not-found", { kind: "track", id });
}

/**
 * Also a clip that two people at once left behind on a track that is gone: people can still clean
 * up. Locks on tracks are for people at the editor, which keeps to them: commands do not.
 */
function clipOf(timeline: TimelineState, id: string): ClipState {
  return entryOf(timeline.clips, id) ?? fail("not-found", { kind: "clip", id });
}

/**
 * What a command says about the joins it took away because their clips are no longer next to each
 * other, so that people hear of it: nothing when it took none.
 */
const apart = (joins: readonly string[]) =>
  joins.length > 0 ? { joinsRemoved: joins } : undefined;

function checkClip(clip: ClipState): void {
  const result = Clip.safeParse(clipFileOf(clip));
  if (!result.success) formatFailure(result.error);
}

/**
 * Sections, tracks and clips of a timeline share their ids, as the format says: a new one cannot
 * take the id of any of them, whatever kind it is.
 */
function assertIdFree(timeline: TimelineState, id: string, kind: "section" | "track" | "clip") {
  const by = entryOf(timeline.sections, id)
    ? "section"
    : entryOf(timeline.tracks, id)
      ? "track"
      : entryOf(timeline.clips, id)
        ? "clip"
        : undefined;
  if (by) fail("id-taken", { kind, id, by });
}

function checkFits(track: TrackState, clip: { readonly source: ClipSource }): void {
  if (!canHold(track.kind, clip.source.kind)) {
    fail("wrong-track", { trackKind: track.kind, holds: "clip", sourceKind: clip.source.kind });
  }
}

/** A clip on code that is not there would do nothing, and nothing would say why. */
function checkCode(state: Draft["state"], { source }: { readonly source: ClipSource }): void {
  if (source.kind === "scene" && source.scene !== undefined) {
    const scene = source.scene as string;
    if (!entryOf(state.scenes, scene)) fail("not-found", { kind: "scene", id: scene });
  }
  if (source.kind === "sound" && source.sound !== undefined) {
    const sound = source.sound as string;
    if (!entryOf(state.sounds, sound)) fail("not-found", { kind: "sound", id: sound });
  }
}

const EDGES: readonly Edge[] = ["enter", "exit"];

/** How long the transitions at the edges of a clip are together. */
const edgesLength = (clip: Pick<ClipState, Edge>) =>
  EDGES.reduce((total, edge) => {
    const transition = clip[edge];
    return transition ? add(total, parseTime(transition.duration)) : total;
  }, ZERO);

/** The same, with what a join takes where one wins over the transition of the clip. */
const takenLength = (joined: JoinedEnds, clip: ClipState) =>
  add(takenAt(joined, clip, "start"), takenAt(joined, clip, "end"));

/** Whether two transitions are the same one, whatever their length and speed. */
function sameTransition(a: Transition | undefined, b: Transition): boolean {
  if (a === undefined) return false;
  const { duration: _a, curve: _curveA, ...one } = a;
  const { duration: _b, curve: _curveB, ...other } = b;
  return deepEqual(one, other);
}

/**
 * What `clip.setTransition` puts at the edges of a clip, against what was there. A transition that
 * comes there has to be one that this editor does, so that nothing does something else than it
 * says. One that is there already can always get another length or speed: files, copies and two
 * windows at once can leave what commands never make, and that has rules of its own (see the
 * project format). The two can be longer than the clip only where they were already, and then
 * never longer than before.
 */
function checkTransitions(
  kind: Track["kind"],
  current: ClipState,
  next: ClipState,
  edges: readonly Edge[],
  joined: JoinedEnds,
): void {
  const media = mediaOfTrack(kind);
  for (const edge of edges) {
    const transition = next[edge];
    if (transition === undefined || sameTransition(current[edge], transition)) continue;
    const found = findTransition(transition, media, edge);
    if (found.kind === "missing") return fail("transition-missing", { why: found.why });
    // Captions do not get drawn yet, and neither would what they come in and go out with.
    if (kind === "caption" || !isSupported(found, media, edge)) {
      const caption = kind === "caption" ? { caption: true } : {};
      fail("transition-unsupported", { type: found.type, media, use: edge, ...caption });
    }
    checkValues(found.spec, found.type, transition.values);
  }
  const total = edgesLength(next);
  if (compare(total, parseTime(next.duration)) > 0 && compare(total, edgesLength(current)) > 0) {
    fail("transition-too-long", { why: "edges" });
  }
  // A join at the other end takes its part of the clip, which no transition may run into.
  const taken = takenLength(joined, next);
  if (
    compare(taken, parseTime(next.duration)) > 0 &&
    compare(taken, takenLength(joined, current)) > 0
  ) {
    fail("transition-too-long", { why: "join" });
  }
}

/** A number for something that goes before `next` in a list, without renumbering the others. */
function orderBefore<T extends { readonly id: string; readonly order: number }>(
  kind: "section" | "track",
  items: readonly T[],
  next: string | undefined,
  moving?: string,
): number {
  const others = items.filter((item) => item.id !== moving);
  const index = next === undefined ? others.length : others.findIndex((item) => item.id === next);
  if (index < 0) fail("not-found", { kind, id: next ?? "" });
  const after = others[index]?.order;
  const before = others[index - 1]?.order;
  if (after === undefined) return (before ?? -1) + 1;
  return before === undefined ? after - 1 : (before + after) / 2;
}

/**
 * What happens to clips in the way. An editor drops over them, like people expect from any video
 * editor, or makes room for what it drops by pushing on what follows (insert). Everyone else has to
 * say so: a change nobody asked for is worse than a refused command.
 */
const Overlap = z.enum(["reject", "overwrite", "insert"]).optional();

/** Cut in two by making room: the clip, and its part after the cut. */
const Split = z.array(z.strictObject({ clip: Id, piece: Id })).readonly();

/** What making room for clips that land did, as far as there is anything to tell. */
const opened = ({
  moved,
  split,
}: {
  readonly moved: readonly string[];
  readonly split: Split;
}) => ({
  ...(moved.length > 0 && { moved }),
  ...(split.length > 0 && { split }),
});
type Split = z.output<typeof Split>;

/** The tracks that make room or close it: those listed, and always those of the clips themselves. */
const withOwn = (tracks: readonly string[] | undefined, own: Iterable<string>) =>
  tracks && [...new Set([...tracks, ...own])];

/** Clears spans with overwrite; otherwise they have to be free, also after making room to insert. */
function makeRoom(
  draft: Draft,
  timeline: string,
  track: string,
  spans: readonly Span[],
  moving: ReadonlySet<string>,
  overlap: z.output<typeof Overlap>,
  links: PieceLinks,
): void {
  if (overlap === "overwrite") clearSpans(draft, timeline, track, spans, moving, links);
  else assertFree(timelineOf(draft, timeline), track, spans, moving);
}

function checkKeys(path: string, value: PropertyValue): void {
  if (cannotHaveKeys(path, value)) fail("not-animatable", { path });
}

/** Only what gets written. Something else being wrong must not stop people from fixing it. */
export function checkWrite(
  path: string,
  before: PropertyValue | undefined,
  after: PropertyValue,
): void {
  if (RETIRED_PROPERTIES.includes(path)) fail("invalid-value", { rule: "retired-property", path });
  const result = KnownProperties.safeParse({ [path]: after });
  if (!result.success) formatFailure(result.error);
  if (!deepEqual(before, after)) checkKeys(path, after);
}

/**
 * Plans edits of properties, each one seeing the ones before it. All writes of properties come
 * through here. What does not change writes nothing, so that a drag that ends where it started leaves
 * no step to undo, and taking something away always works, because that is the way out of bad data.
 */
function editProperties(
  draft: Draft,
  timeline: string,
  edits: readonly PropertyEdit[],
): readonly RemovedKeys[] {
  const target = timelineOf(draft, timeline);
  const changes = new Map<string, OwnedChanges>();
  const removed: RemovedKeys[] = [];
  for (const edit of edits) {
    const { path } = edit;
    const owned = ownedOf(draft, target, timeline, edit, changes);
    const { values } = owned;
    const before = values.has(path) ? values.get(path) : entryOf(owned.properties, path);
    const context = owned.context(path);
    if (edit.op === "retimeKeys") {
      const retimed = retimedValue(before, edit, context);
      values.set(path, retimed.value);
      if (retimed.removed.length > 0)
        removed.push({ ...owned.owner, path, times: retimed.removed });
    } else {
      values.set(path, applyEdit(before, edit, context));
    }
  }
  for (const owned of changes.values()) {
    if ("master" in owned.owner) {
      writeMasterProperties(draft, timeline, owned);
      continue;
    }
    for (const [path, value] of owned.values) {
      const saved = entryOf(owned.properties, path);
      if (deepEqual(saved, value)) continue;
      const where = [...owned.where, "properties", path];
      if (value === undefined) {
        draft.delete(where);
      } else {
        checkWrite(path, saved, value);
        owned.check(path, value);
        draft.set(where, value);
      }
    }
  }
  return removed;
}

/**
 * The properties of the master after the edits of a step: the mix is one value, as in files, so it
 * gets written whole, once.
 */
function writeMasterProperties(draft: Draft, timeline: string, owned: OwnedChanges): void {
  const changed: Record<string, PropertyValue> = { ...owned.properties };
  let any = false;
  for (const [path, value] of owned.values) {
    const saved = entryOf(owned.properties, path);
    if (deepEqual(saved, value)) continue;
    any = true;
    if (value === undefined) delete changed[path];
    else {
      checkWrite(path, saved, value);
      owned.check(path, value);
      changed[path] = value;
    }
  }
  if (!any) return;
  updateMaster(draft, timeline, (master) => {
    const { properties: _properties, ...rest } = master;
    const sorted = Object.fromEntries(
      Object.entries(changed).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    );
    return { ...rest, ...(Object.keys(sorted).length > 0 && { properties: sorted }) };
  });
}

/** What the edits of a step come to for the properties of one clip, track or the master. */
interface OwnedChanges {
  readonly owner: PropertyOwner;
  readonly where: readonly string[];
  readonly properties: Readonly<Record<string, PropertyValue>> | undefined;
  readonly values: Map<string, PropertyValue | undefined>;
  context(path: string): EditContext;
  check(path: string, value: PropertyValue): void;
}

/** The clip or track an edit is about, with what the step did to it so far. */
function ownedOf(
  draft: Draft,
  target: TimelineState,
  timeline: string,
  edit: PropertyEdit,
  changes: Map<string, OwnedChanges>,
): OwnedChanges {
  const { owner, path } = edit;
  if ("clip" in owner) {
    const clip = clipOf(target, owner.clip);
    const id = `clip ${clip.id}`;
    const known = changes.get(id);
    if (known) return known;
    const made: OwnedChanges = {
      owner: { clip: clip.id },
      where: clipPath(timeline, clip.id),
      properties: clip.properties,
      values: new Map(),
      context: (at) => editContextOf(draft.state, clip, at),
      check: (at, value) =>
        checkEffectWrite(
          clip,
          at,
          value,
          entryOf(target.tracks, clip.track)?.kind === "audio" ? "sound" : "picture",
        ),
    };
    changes.set(id, made);
    return made;
  }
  if ("master" in owner) {
    if (!takesPath(MASTER_PATHS, path)) {
      return fail("wrong-target", { path, target: "master", takes: MASTER_PATHS });
    }
    const known = changes.get("master");
    if (known) return known;
    const master = target.mix?.master;
    const effects = master?.effects ?? [];
    const made: OwnedChanges = {
      owner: { master: true },
      where: [],
      properties: master?.properties,
      values: new Map(),
      context: (at) => trackEditContextOf(draft.state, "master", at, effects),
      check: (at, value) => checkListedWrite(effects, at, value, "sound"),
    };
    changes.set("master", made);
    return made;
  }
  const track = trackOf(target, owner.track);
  // Only what the mix does with a track: a picture has no volume, a track no transform.
  const sound = track.kind === "audio" ? track : undefined;
  if (!sound || !takesPath(TRACK_PATHS, path)) {
    return fail("wrong-target", {
      path,
      target: "track",
      track: track.id,
      kind: track.kind,
      takes: sound ? TRACK_PATHS : [],
    });
  }
  const id = `track ${track.id}`;
  const known = changes.get(id);
  if (known) return known;
  const effects = sound.effects ?? [];
  const made: OwnedChanges = {
    owner: { track: track.id },
    where: trackPath(timeline, track.id),
    properties: sound.properties,
    values: new Map(),
    context: (at) => trackEditContextOf(draft.state, track.id, at, effects),
    check: (at, value) => checkListedWrite(effects, at, value, "sound"),
  };
  changes.set(id, made);
  return made;
}

type ClipOverrides = NonNullable<TimelineState["overrides"][string]["clips"]>[string];

/** The property paths of a clip, also those that only a version has. */
function pathsOfClip(timeline: TimelineState, clip: ClipState): ReadonlySet<string> {
  const paths = new Set(Object.keys(clip.properties ?? {}));
  for (const override of Object.values(timeline.overrides)) {
    const changes: ClipOverrides | undefined = entryOf(override.clips, clip.id);
    for (const path of Object.keys(changes?.properties ?? {})) paths.add(path);
  }
  return paths;
}

interface PlannedMove {
  readonly to: string;
  readonly rename: PropertyRename;
}

/**
 * Moves channels to other paths, with their keys and in every version, for code that renamed what
 * they are about. Everything gets checked first: a path cannot go to two places, and nothing gets
 * written over, apart from what moves away in the same step, so that two properties can swap.
 */
function renameProperties(
  draft: Draft,
  timeline: string,
  renames: readonly PropertyRename[],
): number {
  const target = timelineOf(draft, timeline);
  const plans = new Map<string, Map<string, PlannedMove>>();
  for (const rename of renames) {
    const clip = clipOf(target, rename.owner.clip);
    const moves = movesOf(pathsOfClip(target, clip), rename);
    if (moves.length === 0) fail("not-found", { kind: "property", id: rename.from, clip: clip.id });
    const plan = plans.get(clip.id) ?? new Map<string, PlannedMove>();
    plans.set(clip.id, plan);
    for (const [from, to] of moves) {
      if (!PropertyPath.safeParse(to).success)
        fail("invalid-value", { rule: "not-a-path", path: to });
      if (from === to) fail("invalid-value", { rule: "rename-same", path: from });
      if (plan.has(from)) fail("invalid-value", { rule: "renamed-twice", path: from });
      plan.set(from, { to, rename });
    }
  }
  let moved = 0;
  for (const [id, plan] of plans) {
    const clip = entryOf(target.clips, id) as ClipState;
    const paths = pathsOfClip(target, clip);
    const targets = new Set<string>();
    for (const { to } of plan.values()) {
      if (targets.has(to)) fail("invalid-value", { rule: "rename-into-one", path: to });
      targets.add(to);
      if (paths.has(to) && !plan.has(to)) fail("path-taken", { path: to, by: "property" });
    }
    moveProperties(draft, timeline, clip, plan);
    moved += plan.size;
  }
  return moved;
}

function moveProperties(
  draft: Draft,
  timeline: string,
  clip: ClipState,
  plan: ReadonlyMap<string, PlannedMove>,
): void {
  const properties = clip.properties ?? {};
  const where = [...clipPath(timeline, clip.id), "properties"];
  const written = new Map<string, PropertyValue>();
  for (const [from, { to, rename }] of plan) {
    const value = entryOf(properties, from);
    if (value === undefined) continue;
    const converted = convertedValue(value, rename);
    checkWrite(to, undefined, converted);
    written.set(to, converted);
  }
  // Changes of versions first, all of them checked before anything gets written.
  const versions: [string[], Map<string, unknown>, readonly string[]][] = [];
  for (const [version, override] of Object.entries(timelineOf(draft, timeline).overrides)) {
    const changes = entryOf(override.clips, clip.id)?.properties;
    if (!changes) continue;
    const moved = new Map<string, unknown>();
    const leaving: string[] = [];
    for (const [from, { to, rename }] of plan) {
      const change = entryOf(changes, from);
      if (!change) continue;
      const value = convertedValue(change.value, rename);
      checkWrite(to, undefined, value);
      const base = change.base === undefined ? undefined : convertedValue(change.base, rename);
      moved.set(to, base === undefined ? { value } : { value, base });
      leaving.push(from);
    }
    const path = [...timelinePath(timeline), "overrides", version, "clips", clip.id, "properties"];
    if (moved.size > 0) versions.push([path, moved, leaving]);
  }
  for (const [from, { to, rename }] of plan) {
    const { scale, offset } = rename;
    if (entryOf(properties, from) !== undefined) draft.delete([...where, from]);
    draft.note({
      kind: "renamed",
      clip: clip.id,
      from,
      to,
      ...(scale !== undefined && { scale }),
      ...(offset !== undefined && { offset }),
    });
  }
  for (const [to, value] of written) draft.set([...where, to], value);
  for (const [path, moved, leaving] of versions) {
    for (const from of leaving) draft.delete([...path, from]);
    for (const [to, change] of moved) draft.set([...path, to], change);
  }
}

/** What `asset.add` takes: an asset of a file only here (the default), or in the person's own Git. */
const AddedAsset = z.strictObject({
  ...Asset.shape,
  /** Elsewhere is for uploads to write down, once the file got there. */
  storage: z.enum(["local", "git"]).default("local"),
});

const ClipFields = Clip.omit({ id: true });
const ClipInput = ClipFields.extend({ id: Id.optional() });
const ClearableField = z.enum(["name", "offset", "loop", "hidden", "draft", "link", "sectionFit"]);

const TrackChanges = z
  .strictObject({
    name: z.string(),
    locked: z.boolean(),
    group: z.string(),
    hidden: z.boolean(),
    muted: z.boolean(),
    solo: z.boolean(),
    role: z.enum(["voice", "music", "effects"]),
  })
  .partial();

const MarkerChanges = Marker.omit({ id: true }).partial();
const ClearableMarkerField = z.enum(["name", "note", "color", "duration"]);

/** What writing properties can run into, whichever operation does it. */
const PROPERTY_FAILURES: readonly FailureCode[] = ["not-found", "invalid-value", "not-animatable"];
/** What `property.edit` can fail with, which can also be about a track. */
const PROPERTY_EDIT_FAILURES: readonly FailureCode[] = [...PROPERTY_FAILURES, "wrong-target"];

/** The clip that `clip.add` puts on a track, as its own fields: the format's, with an id to choose. */
const AddedClip = ClipInput.shape;

/**
 * The registry of operations: everything that changes a project, for people, tools and AI alike.
 * Written `as const` so that names are what they are, see `AiOperationName`.
 */
export const OPERATIONS = [
  define(
    "project.rename",
    "给项目改名。",
    z.strictObject({ name: z.string().min(1) }),
    (draft, { name }) => {
      draft.set(["manifest", "name"], name);
    },
    { group: "project", result: Nothing, failures: [] },
  ),

  define(
    "project.setFrameRate",
    "设置项目的帧率，时间轴的标尺按它数帧。",
    z.strictObject({ fps: LimitedRate }),
    (draft, { fps }) => {
      draft.set(["manifest", "fps"], fps);
    },
    { group: "project", result: Nothing, failures: [] },
  ),

  define(
    "project.setTags",
    "设置项目的标签，包括锁定项目的标签。",
    z.strictObject({ tags: ProjectManifest.shape.tags.unwrap() }),
    (draft, { tags }) => {
      draft.set(["manifest", "tags"], tags);
    },
    {
      group: "project",
      level: "human",
      ai: { no: "human" },
      result: Nothing,
      failures: [],
      whileLocked: true,
    },
  ),

  /**
   * The other side of a conflict of a merge, such as what GitHub has where the editor's stayed. It
   * is a decision of the person, which goes back with undo like any other change of theirs.
   */
  define(
    "conflict.take",
    "把合并时两边都改了、留了编辑器这边的一处，换成另一边（比如 GitHub 上）的内容。",
    ConflictTake,
    (draft, { conflict }) => takeTheirs(draft, conflict),
    {
      group: "project",
      level: "human",
      ai: { no: "human" },
      result: Nothing,
      failures: ["conflict-not-taken"],
    },
  ),

  define(
    "project.setDescription",
    "设置项目的说明，空的就去掉说明。",
    DescriptionSet,
    setDescription,
    {
      group: "project",
      result: Nothing,
      failures: [],
    },
  ),

  define("project.setCredits", "设置项目的署名：每条有角色和名字。", CreditsSet, setCredits, {
    group: "project",
    result: Nothing,
    failures: [],
  }),

  define(
    "project.setFormats",
    "设置项目的画幅（第一个是母版）：加、改、删、换母版。删掉的画幅的差异文件一起删。",
    FormatsSet,
    setFormats,
    {
      group: "project",
      result: FilesRemoved.optional(),
      failures: ["invalid-value"],
    },
  ),

  define(
    "project.setLanguages",
    "设置项目的语言（第一种是母版）：加、改名、删、换母版。删掉的语言的字符串表和差异文件一起删。",
    LanguagesSet,
    setLanguages,
    {
      group: "project",
      result: FilesRemoved.optional(),
      failures: ["invalid-value"],
    },
  ),

  define(
    "project.setCover",
    "设置项目的封面帧：哪条时间轴的哪一刻；null 去掉。",
    CoverSet,
    setCover,
    {
      group: "project",
      result: Nothing,
      failures: ["not-found", "invalid-value"],
    },
  ),

  /**
   * An asset of a file only here, or in the person's own Git: where else a file is kept, uploads
   * write down once it got there (`asset.setStorage`), and files say.
   */
  define(
    "asset.add",
    "在项目里登记一个素材文件：名字、类型和它在项目里的路径。不会上传文件本身。",
    z.strictObject({ id: Id.optional(), asset: AddedAsset }),
    (draft, { id, asset }) => {
      const key = id ?? newId("asset");
      if (entryOf(draft.state.assets, key))
        fail("id-taken", { kind: "asset", id: key, by: "asset" });
      draft.set(["assets", key], asset);
      return { id: key };
    },
    { group: "asset", ai: { no: "needs-file" }, result: Made, failures: ["id-taken"] },
  ),

  /**
   * What an asset is called and found by, and where its file is and what it is: for a file that
   * moved or was replaced, as people agreed. Clips stay on the asset. No tags at all takes them away.
   * Another file, by its hash or its size, is only here: what the asset said about where else its
   * file was is about the one before. What the file is, only people say: AI cannot see files.
   */
  define(
    "asset.update",
    "改素材的名字和标签，或在文件移动、替换后改它的路径和文件信息，用它的片段不变。",
    z.strictObject({
      asset: Id,
      changes: z.strictObject({
        name: z.string().trim().min(1).optional(),
        tags: ResourceTags.optional(),
        path: z.string().optional(),
        hash: z.string().optional(),
        size: z.number().optional(),
        info: MediaInfo.optional(),
      }),
    }),
    (draft, { asset, changes }) => {
      const found = entryOf(draft.state.assets, asset);
      if (!found) fail("not-found", { kind: "asset", id: asset });
      const defined: Record<string, unknown> = Object.fromEntries(
        Object.entries(changes).filter(([, value]) => value !== undefined),
      );
      const merged: Record<string, unknown> = { ...found, ...defined };
      if (changes.tags?.length === 0) delete merged.tags;
      const before = found?.hash;
      // Of one content there is one size: another size is another file, also with the same hash.
      const isAnotherFile =
        (before !== undefined && changes.hash !== undefined && !isSameHash(before, changes.hash)) ||
        (changes.size !== undefined && changes.size !== found?.size);
      if (isAnotherFile && found && isElsewhere(found.storage)) {
        merged.storage = "local";
        delete merged.url;
      }
      const next = Asset.safeParse(merged);
      if (!next.success) formatFailure(next.error, "changes");
      // Assets are no layer of their own: each one is written as a whole, see structure.ts.
      draft.set(["assets", asset], next.data);
    },
    {
      group: "asset",
      result: Nothing,
      failures: ["not-found", "invalid-value"],
      hiddenParams: ["changes.path", "changes.hash", "changes.size", "changes.info"].map(
        (name) => ({ name, why: "human" }) as const,
      ),
    },
  ),

  /** `withUses` takes the clips that use it along, in the same step, see `removeUses`. */
  define(
    "asset.remove",
    "删除一个素材；withUses 为 true 时连同用它的片段一起删，否则还有片段在用时拒绝。",
    z.strictObject({ asset: Id, withUses: z.boolean().optional() }),
    (draft, { asset, withUses }) => {
      if (!entryOf(draft.state.assets, asset)) fail("not-found", { kind: "asset", id: asset });
      const code = codeUsingAsset(draft.state, asset);
      if (code !== undefined) fail("asset-in-use", { asset, by: "code", file: code });
      if (withUses) removeUses(draft, "asset", asset);
      else if (isInUse(draft.state, ["assets", asset])) {
        fail("asset-in-use", { asset, by: "clips" });
      }
      draft.delete(["assets", asset]);
      draft.delete(["places", asset]);
    },
    { group: "asset", result: Nothing, failures: ["not-found", "asset-in-use"] },
  ),

  /**
   * Where the file of an asset is kept besides here, for the content it has now, which `hash` has
   * to be: an upload writes it down once the file got there and was checked, as `STORAGE`, which is
   * nothing to undo. People only take it back to `local`, which they can undo. AI cannot do either:
   * it cannot tell where a file is, and where it goes is for people to choose. It only writes down
   * where the file is, never changes what the project shows, so it can happen while it is locked.
   */
  define(
    "asset.setStorage",
    "记下素材文件放在哪里：上传完成后由上传记下 lfs、platform 或 remote；用户把它改回只在本机（local）。",
    StorageChange,
    setStorage,
    {
      group: "asset",
      level: "human",
      ai: { no: "human" },
      result: Nothing,
      failures: ["not-found", "asset-file-changed", "upload-only", "invalid-value"],
      whileLocked: true,
      alsoBy: [STORAGE],
    },
  ),

  define("scene.add", "新建一个 HTML 场景（代码生成的画面），连同它的文件。", SceneAdd, addScene, {
    group: "scene",
    result: Made,
    failures: [
      "id-taken",
      "invalid-value",
      "not-found",
      "file-too-large",
      "path-taken",
      "runtime-too-new",
      "missing-entry",
    ],
  }),
  define(
    "scene.update",
    "改场景的清单，比如名字、入口文件、参数和预设。",
    SceneUpdate,
    updateScene,
    {
      group: "scene",
      result: Nothing,
      failures: ["not-found", "invalid-value", "runtime-too-new", "missing-entry"],
    },
  ),
  define(
    "scene.remove",
    "删除一个场景和它的文件；withUses 为 true 时连同用它的片段一起删。",
    SceneRemove,
    removeScene,
    { group: "scene", result: Nothing, failures: ["not-found", "scene-in-use"] },
  ),
  define("sound.add", "新建一个代码生成的声音，连同它的文件。", SoundAdd, addSound, {
    group: "sound",
    result: Made,
    failures: [
      "id-taken",
      "invalid-value",
      "not-found",
      "file-too-large",
      "path-taken",
      "runtime-too-new",
      "missing-entry",
    ],
  }),
  define(
    "sound.update",
    "改代码生成的声音的清单，比如名字、入口文件、参数和输出。",
    SoundUpdate,
    updateSound,
    {
      group: "sound",
      result: Nothing,
      failures: ["not-found", "invalid-value", "runtime-too-new", "missing-entry"],
    },
  ),
  define(
    "sound.remove",
    "删除一个代码生成的声音和它的文件；withUses 为 true 时连同用它的片段一起删。",
    SoundRemove,
    removeSound,
    { group: "sound", result: Nothing, failures: ["not-found", "sound-in-use"] },
  ),
  /** Clips that use an asset, scene or sound use another one of the same kind instead. */
  define(
    "source.replace",
    "让用某个素材、场景或声音的片段全部改用另一个同类的。",
    SourceReplace,
    replaceSource,
    {
      group: "clip",
      result: z.strictObject({ clips: z.number() }),
      failures: ["invalid-value", "not-found", "not-in-use"],
    },
  ),
  define(
    "file.write",
    "写入项目里的一个代码文件（场景、声音或共用代码），整份替换。",
    FileWrite,
    writeFile,
    {
      group: "file",
      ai: { no: "file-tools" },
      result: Nothing,
      failures: ["not-found", "file-too-large", "path-taken"],
    },
  ),
  define(
    "file.remove",
    "删除项目里的一个代码文件，场景和声音的入口文件不能删。",
    FileRemove,
    removeFile,
    { group: "file", result: Nothing, failures: ["not-found", "entry-in-use"] },
  ),
  define("file.rename", "把项目里的一个代码文件改名或移到别的路径。", FileRename, renameFile, {
    group: "file",
    result: Nothing,
    failures: [
      "not-found",
      "path-taken",
      "entry-in-use",
      "file-too-large",
      "invalid-value",
      "runtime-too-new",
      "missing-entry",
    ],
  }),

  define(
    "timeline.rename",
    "给时间轴改名。",
    z.strictObject({ timeline: Id, name: z.string().min(1) }),
    (draft, { timeline, name }) => {
      timelineOf(draft, timeline);
      draft.set([...timelinePath(timeline), "name"], name);
    },
    { group: "timeline", result: Nothing, failures: ["not-found"] },
  ),

  define(
    "timeline.setBackground",
    "设置时间轴的背景色，null 是默认的黑色。",
    BackgroundSet,
    setBackground,
    { group: "timeline", result: Nothing, failures: ["not-found"] },
  ),

  define(
    "timeline.setDefault",
    "让一条时间轴默认打开：排到项目的时间轴列表最前面。",
    DefaultSet,
    setDefault,
    { group: "timeline", result: Nothing, failures: ["not-found"] },
  ),

  define(
    "section.add",
    "在时间轴上加一个段落（时间轴由段落首尾相接组成），可以指定放在哪个段落前面。",
    z.strictObject({
      timeline: Id,
      id: Id.optional(),
      duration: Duration,
      name: z.string().optional(),
      before: Id.optional(),
    }),
    (draft, params) => {
      const { timeline, duration, name, before } = params;
      const target = timelineOf(draft, timeline);
      const id = params.id ?? newId("section");
      assertIdFree(target, id, "section");
      const order = orderBefore("section", orderedSections(target), before);
      const section = { id, ...(name ? { name } : {}), duration, order };
      draft.set([...timelinePath(timeline), "sections", id], section);
      return { id };
    },
    { group: "timeline", result: Made, failures: ["not-found", "id-taken"] },
  ),

  define(
    "section.update",
    "改段落的时长或名字，clear 去掉名字。",
    z.strictObject({
      timeline: Id,
      section: Id,
      duration: Duration.optional(),
      name: z.string().optional(),
      clear: z.array(z.enum(["name"])).optional(),
    }),
    (draft, { timeline, section, duration, name, clear }) => {
      const target = entryOf(timelineOf(draft, timeline).sections, section);
      if (!target) fail("not-found", { kind: "section", id: section });
      const path = [...timelinePath(timeline), "sections", section];
      if (duration !== undefined) draft.set([...path, "duration"], duration);
      if (name !== undefined) draft.set([...path, "name"], name);
      else if (clear?.includes("name") && target?.name !== undefined) {
        draft.delete([...path, "name"]);
      }
    },
    { group: "timeline", result: Nothing, failures: ["not-found"] },
  ),

  define(
    "section.split",
    "在一个时刻把它所在的段落分成两段：前一段留着原来的段落和名字，后一段是新的。时间轴的长度和上面的内容都不动。",
    z.strictObject({ timeline: Id, at: Time, id: Id.optional(), name: z.string().optional() }),
    (draft, { timeline, at, id: wanted, name }) => {
      const target = timelineOf(draft, timeline);
      const id = wanted ?? newId("section");
      assertIdFree(target, id, "section");
      splitSection(draft, timeline, parseTime(at), id, name);
      return { id };
    },
    { group: "timeline", result: Made, failures: ["not-found", "id-taken", "invalid-value"] },
  ),

  define(
    "section.moveBoundary",
    "把一个段落的结尾、也就是下一个段落的开头移到一个时刻：一段变长、一段变短，时间轴的长度和上面的内容都不动。",
    z.strictObject({ timeline: Id, section: Id, at: Time }),
    (draft, { timeline, section, at }) => moveBoundary(draft, timeline, section, parseTime(at)),
    { group: "timeline", result: Nothing, failures: ["not-found", "invalid-value"] },
  ),

  /**
   * Clips and markers are where they are on the whole timeline, so a section that goes gives its
   * time to the one before it: the length and the other boundaries stay with what is on them.
   */
  define(
    "section.remove",
    "删除一个段落，它的时长并进前一段（第一段并进后一段），时间轴的长度、其他分界和上面的内容都不动；时间轴至少要留一个段落。",
    z.strictObject({ timeline: Id, section: Id }),
    (draft, { timeline, section }) => removeSection(draft, timeline, section),
    { group: "timeline", result: Nothing, failures: ["not-found", "last-section"] },
  ),

  define(
    "track.add",
    "加一条轨道（video、audio 或 caption），可以指定放在哪条轨道前面。",
    z.strictObject({
      timeline: Id,
      id: Id.optional(),
      kind: z.enum(["video", "audio", "caption"]),
      name: z.string().optional(),
      before: Id.optional(),
    }),
    (draft, params) => {
      const { timeline, kind, name, before } = params;
      const target = timelineOf(draft, timeline);
      const id = params.id ?? newId("track");
      assertIdFree(target, id, "track");
      const order = orderBefore("track", orderedTracks(target), before);
      const track = { id, kind, ...(name ? { name } : {}), order };
      draft.set(trackPath(timeline, id), track);
      return { id };
    },
    { group: "track", result: Made, failures: ["not-found", "id-taken"] },
  ),

  define(
    "track.update",
    "改轨道的名字、隐藏、静音、独奏、锁定、分组或声音角色。",
    z.strictObject({ timeline: Id, track: Id, changes: TrackChanges }),
    (draft, { timeline, track, changes }) => {
      const current = trackOf(timelineOf(draft, timeline), track);
      const { order: _order, ...head } = current;
      const result = Track.safeParse({ ...head, ...changes, clips: [] });
      if (!result.success)
        fail("invalid-value", { rule: "track-settings", trackKind: current.kind });
      for (const [key, value] of Object.entries(changes)) {
        draft.set([...trackPath(timeline, track), key], value);
      }
    },
    { group: "track", result: Nothing, failures: ["not-found", "invalid-value"] },
  ),

  define(
    "track.move",
    "改轨道的顺序：移到某条轨道前面，不写就移到最后。",
    z.strictObject({ timeline: Id, track: Id, before: Id.optional() }),
    (draft, { timeline, track, before }) => {
      const target = timelineOf(draft, timeline);
      trackOf(target, track);
      const order = orderBefore("track", orderedTracks(target), before, track);
      draft.set([...trackPath(timeline, track), "order"], order);
    },
    { group: "track", result: Nothing, failures: ["not-found"] },
  ),

  define(
    "track.remove",
    "删除一条轨道和上面的全部片段。",
    z.strictObject({ timeline: Id, track: Id }),
    (draft, params) => {
      const { timeline, track } = params;
      const target = timelineOf(draft, timeline);
      trackOf(target, track);
      for (const clip of Object.values(target.clips)) {
        if (clip.track === track) draft.delete(clipPath(timeline, clip.id));
      }
      for (const [id, join] of Object.entries(target.joins ?? {})) {
        if (join.track === track) draft.delete(joinPath(timeline, id));
      }
      draft.delete(trackPath(timeline, track));
    },
    { group: "track", result: Nothing, failures: ["not-found"] },
  ),

  define(
    "clip.add",
    "在轨道上放一个片段（素材、场景、声音、字幕等）；默认不能和已有片段重叠，overlap 为 overwrite 时盖掉重叠的部分，为 insert 时插入：后面的内容右移让出位置。",
    z.strictObject({
      timeline: Id,
      track: Id,
      ...AddedClip,
      overlap: Overlap,
      /** With insert, the tracks that make room, and always its own; without them all of them. */
      rippleTracks: RippleTracks,
      /**
       * The clip that this one takes the place of, which went away earlier in the same batch. What
       * people are trying goes along, so AI has no say in this: it does not even see that.
       */
      movedFrom: Id.optional(),
    }),
    (draft, params) => {
      const { timeline, track, overlap, movedFrom, rippleTracks, ...clip } = params;
      const target = timelineOf(draft, timeline);
      const home = trackOf(target, track);
      checkFits(home, clip);
      checkCode(draft.state, clip);
      const id = clip.id ?? newId("clip");
      assertIdFree(target, id, "clip");
      for (const [path, value] of Object.entries(clip.properties ?? {})) checkKeys(path, value);
      const added = clipStateOf({ ...clip, id }, track);
      const together = joinsTogether(target);
      const links = new PieceLinks();
      if (overlap === "overwrite") expectCuts(target, track, [spanOf(added)], new Set(), links);
      if (overlap === "insert") checkTracks(target, rippleTracks);
      const room =
        overlap === "insert"
          ? openRoom(
              draft,
              timeline,
              clipStart(added),
              parseTime(added.duration),
              withOwn(rippleTracks, [track]),
            )
          : undefined;
      makeRoom(draft, timeline, track, [spanOf(added)], new Set(), overlap, links);
      draft.set(clipPath(timeline, id), added);
      // A copy brings its transitions as they are, also ones that this editor cannot do yet, which
      // the problems and exports then tell about. What does not fit any more gets shorter.
      fitTransitions(draft, timeline, added, parseTime(added.duration), "end");
      extendToFit(draft, timeline, clipEnd(added));
      if (movedFrom !== undefined) {
        if (!draft.wentAway(clipPath(timeline, movedFrom))) {
          fail("not-moved", { clip: movedFrom });
        }
        draft.note({ kind: "moved", from: movedFrom, to: id });
      }
      return {
        id,
        ...(room && opened(room)),
        ...apart(followJoins(draft, timeline, together)),
      };
    },
    {
      group: "clip",
      result: z.strictObject({
        id: Id,
        moved: z.array(Id).readonly().optional(),
        split: Split.optional(),
        ...JoinsRemoved,
      }),
      failures: ["not-found", "wrong-track", "id-taken", "not-animatable", "overlap", "not-moved"],
      hiddenParams: [{ name: "movedFrom", why: "human" }],
    },
  ),

  /**
   * With ripple, what was after the clips moves back into where they were, on all tracks or those
   * listed, as long as nothing else is in that time there: see `closeGaps`.
   */
  define(
    "clip.remove",
    "删除一个或几个片段；ripple 为 true 时合上它们留下的空（波纹删除），后面的内容左移。",
    z.strictObject({
      timeline: Id,
      clips: z.array(Id).min(1),
      ripple: z.boolean().optional(),
      rippleTracks: RippleTracks,
    }),
    (draft, { timeline, clips, ripple, rippleTracks }) => {
      const target = timelineOf(draft, timeline);
      const gone = clips.map((id) => clipOf(target, id));
      if (!ripple) {
        removeClips(draft, timeline, clips);
        return undefined;
      }
      checkTracks(target, rippleTracks);
      removeClips(draft, timeline, clips);
      return rippled(closeGaps(draft, timeline, gone.map(spanOf), rippleTracks));
    },
    {
      group: "clip",
      result: z.strictObject(RippledFields).optional(),
      failures: ["not-found", "ripple-blocked"],
    },
  ),

  /** Takes stretches out of a timeline, which have to be empty on the tracks that move. */
  define(
    "timeline.closeGap",
    "把时间段从时间轴上抽掉（合上空隙）：这些时间段在参与的轨道上要是空的，之后的片段、段落和标记左移。",
    z.strictObject({ timeline: Id, ranges: z.array(Range).min(1), rippleTracks: RippleTracks }),
    (draft, { timeline, ranges, rippleTracks }) => {
      const target = timelineOf(draft, timeline);
      checkTracks(target, rippleTracks);
      const spans = ranges.map(({ from, to }, index) => {
        const span = { from: parseTime(from), to: parseTime(to) };
        checkSpan(target, span, `ranges.${index}`, `ranges.${index}.to`);
        return span;
      });
      return rippled(closeGaps(draft, timeline, spans, rippleTracks));
    },
    {
      group: "timeline",
      result: z.strictObject(RippledFields),
      failures: ["not-found", "invalid-value", "ripple-blocked"],
    },
  ),

  /**
   * Puts empty time into a timeline, which is what inserting does before what it inserts goes there:
   * for several clips at once, such as pasting, one stretch for all of them.
   */
  define(
    "timeline.openGap",
    "在时间轴的某个时刻开出一段空的时间：参与的轨道上从这一刻开始的片段右移，跨过这一刻的片段在这里切开，段落和标记跟着移。",
    z.strictObject({ timeline: Id, at: Time, duration: Duration, rippleTracks: RippleTracks }),
    (draft, { timeline, at, duration, rippleTracks }) => {
      const target = timelineOf(draft, timeline);
      checkTracks(target, rippleTracks);
      const moment = parseTime(at);
      const length = timelineLength(target);
      if (compare(moment, length) > 0) {
        fail("invalid-value", {
          rule: "range-outside",
          path: "at",
          to: at,
          length: formatTime(length),
        });
      }
      const done = openGap(draft, timeline, moment, parseTime(duration), rippleTracks);
      return { ...opened(done), ...apart(done.joinsRemoved) };
    },
    {
      group: "timeline",
      result: z.strictObject({
        moved: z.array(Id).readonly().optional(),
        split: Split.optional(),
        ...JoinsRemoved,
      }),
      failures: ["not-found", "invalid-value"],
    },
  ),

  /**
   * Lift and extract, as video editors have them between in and out: what is in a stretch of time
   * goes, and with ripple the stretch goes too.
   */
  define(
    "timeline.removeRange",
    "去掉一段时间里轨道上的内容（抬起），跨边界的片段切开留两头；ripple 为 true 时再合上这段（提取），后面的内容左移。",
    z.strictObject({
      timeline: Id,
      from: Time,
      to: Time,
      tracks: z.array(Id).min(1).optional(),
      ripple: z.boolean().optional(),
    }),
    (draft, { timeline, from, to, tracks, ripple }) => {
      const target = timelineOf(draft, timeline);
      checkTracks(target, tracks);
      const span = { from: parseTime(from), to: parseTime(to) };
      checkSpan(target, span, "from", "to");
      const together = joinsTogether(target);
      const lifted = liftSpan(draft, timeline, span, tracks);
      const apartNow = followJoins(draft, timeline, together);
      if (!ripple) return { ...lifted, ...apart(apartNow) };
      const closed = closeGaps(draft, timeline, [span], tracks);
      const joinsRemoved = [...apartNow, ...closed.joinsRemoved];
      return { ...lifted, ...rippled({ ...closed, joinsRemoved }) };
    },
    {
      group: "timeline",
      result: z.strictObject({
        removed: z.array(Id).readonly(),
        split: z.array(z.strictObject({ clip: Id, piece: Id })).readonly(),
        ...RippledFields,
      }),
      failures: ["not-found", "invalid-value"],
    },
  ),

  /**
   * Transitions at the edges of a clip have a command of their own, `clip.setTransition`. Where a
   * clip is and how long, `clip.move` and `clip.trim` are for: people can still change them here.
   */
  define(
    "clip.update",
    "改片段自己的字段，比如名字、开头、时长、内容、offset、循环和隐藏；转场、效果和属性用各自的命令。",
    z.strictObject({
      timeline: Id,
      clip: Id,
      changes: ClipFields.omit({
        properties: true,
        effects: true,
        enter: true,
        exit: true,
      }).partial(),
      clear: z.array(ClearableField).optional(),
    }),
    (draft, { timeline, clip, changes, clear }) => {
      const target = timelineOf(draft, timeline);
      const current = clipOf(target, clip);
      const next: Record<string, unknown> = { ...current, ...changes };
      for (const field of clear ?? []) delete next[field];
      checkClip(next as ClipState);
      const home = entryOf(target.tracks, current.track);
      if (home) checkFits(home, next as ClipState);
      if (changes.source) checkCode(draft.state, next as ClipState);
      const updated = next as ClipState;
      // Clips can overlap after a merge, and that should not stop people from renaming one.
      const moves = changes.start !== undefined || changes.duration !== undefined;
      if (moves) assertFree(target, current.track, [spanOf(updated)], new Set([clip]));
      const together = moves ? joinsTogether(target) : [];
      // A join at an edge that stays where it is stays too, and has to fit what is left.
      const startStays = compare(clipStart(updated), clipStart(current)) === 0;
      const endStays = compare(clipEnd(updated), clipEnd(current)) === 0;
      const { enter, exit } = joinsAtEdgesOf(target, clip);
      const stays: JoinedEdges = {
        ...(startStays && enter && { enter }),
        ...(endStays && exit && { exit }),
      };
      draft.replace(clipPath(timeline, clip), next);
      if (changes.duration !== undefined) {
        const moved = startStays ? "end" : "start";
        fitTransitions(draft, timeline, updated, parseTime(updated.duration), moved, stays);
        // What the clip shows moves along with its start here, and so do its effects.
        fitEffects(draft, timeline, clip, ZERO, parseTime(updated.duration));
      }
      if (!moves) return undefined;
      extendToFit(draft, timeline, clipEnd(updated));
      return apart(followJoins(draft, timeline, together));
    },
    {
      group: "clip",
      result: MaybeApart,
      failures: ["not-found", "invalid-value", "wrong-track", "overlap"],
      hiddenParams: [
        { name: "changes.start", why: "instead", instead: "clip.move" },
        { name: "changes.duration", why: "instead", instead: "clip.trim" },
      ],
    },
  ),

  /**
   * Puts a transition at the start or the end of a clip, or takes it away with null, such as a fade
   * in. What is left out stays as it is. Transitions are about the clip, not properties that change
   * over time, so this is never something that people try first.
   */
  define(
    "clip.setTransition",
    "给片段的开头（enter）或结尾（exit）加上、换掉或去掉转场，null 表示去掉。",
    z
      .strictObject({
        timeline: Id,
        clip: Id,
        enter: Transition.nullable().optional(),
        exit: Transition.nullable().optional(),
      })
      .refine(({ enter, exit }) => enter !== undefined || exit !== undefined, "要写 enter 或 exit"),
    (draft, params) => {
      const { timeline, clip } = params;
      const target = timelineOf(draft, timeline);
      const current = clipOf(target, clip);
      const kind = entryOf(target.tracks, current.track)?.kind ?? trackKindFor(current);
      const next: Record<string, unknown> = { ...current };
      const setting: Edge[] = [];
      for (const edge of EDGES) {
        const wanted = params[edge];
        if (wanted === null) delete next[edge];
        else if (wanted !== undefined) {
          // Nothing set is what it is without saying so.
          const { values, ...rest } = wanted;
          next[edge] = values && Object.keys(values).length > 0 ? wanted : rest;
          setting.push(edge);
        }
      }
      // Taking one away always works: that is the way out of what a file did.
      if (setting.length > 0) {
        checkTransitions(kind, current, next as ClipState, setting, joinedEndsOf(target));
      }
      for (const edge of EDGES) {
        const path = [...clipPath(timeline, clip), edge];
        if (deepEqual(current[edge], next[edge])) continue;
        if (next[edge] === undefined) draft.delete(path);
        else draft.set(path, next[edge]);
      }
    },
    {
      group: "transition",
      result: Nothing,
      failures: [
        "not-found",
        "transition-missing",
        "transition-unsupported",
        "invalid-value",
        "transition-too-long",
      ],
    },
  ),

  /** Puts a join on the cut between two clips, see join-edits.ts. */
  define("join.add", "在两个首尾相接的片段之间加衔接转场。", JoinAdd, addJoin, {
    group: "transition",
    result: z.union([
      z.strictObject({ id: Id, align: z.enum(["center", "before", "after"]) }),
      z.strictObject({ left: z.enum(["taken", "no-room"]) }),
    ]),
    failures: [
      "not-found",
      "invalid-value",
      "not-adjacent",
      "join-taken",
      "id-taken",
      "transition-too-long",
      "wrong-track",
      "transition-missing",
      "transition-unsupported",
    ],
    hiddenParams: [{ name: "copied", why: "human" }],
  }),
  define(
    "effect.add",
    "给片段、音轨或主输出加一个效果，可以指定放在效果列表的哪里和参数的初始值。",
    EffectAdd,
    addEffect,
    {
      group: "effect",
      result: Made,
      failures: [
        "not-found",
        "wrong-track",
        "wrong-target",
        "not-applicable",
        "invalid-value",
        "id-taken",
        "not-animatable",
      ],
    },
  ),
  define("effect.remove", "去掉片段、音轨或主输出上的效果。", EffectRemove, removeEffects, {
    group: "effect",
    result: Nothing,
    failures: ["not-found", "wrong-track"],
  }),
  define(
    "effect.move",
    "调整效果在效果列表里的位置，先后顺序会影响结果。",
    EffectMove,
    moveEffect,
    { group: "effect", result: Nothing, failures: ["not-found", "wrong-track"] },
  ),
  define(
    "effect.update",
    "打开或关闭效果，或改片段上的效果生效的开始和结束时间。",
    EffectUpdate,
    updateEffect,
    {
      group: "effect",
      result: Nothing,
      failures: ["not-found", "invalid-value", "wrong-track", "not-applicable"],
    },
  ),
  define("join.update", "改衔接转场的类型、时长、对齐、速度曲线或参数。", JoinUpdate, updateJoin, {
    group: "transition",
    result: Nothing,
    failures: [
      "not-found",
      "invalid-value",
      "transition-missing",
      "transition-unsupported",
      "wrong-track",
      "transition-too-long",
    ],
  }),
  define("join.remove", "删除衔接转场。", JoinRemove, removeJoins, {
    group: "transition",
    result: Nothing,
    failures: ["not-found"],
  }),

  /** Several clips move in one step, because the place one of them leaves is free for another. */
  define(
    "clip.move",
    "把一个或几个片段移到新的开始时间或别的轨道，一步完成；overlap 为 insert 时插入：落点之后的内容右移让出位置，原来的位置留空。",
    z.strictObject({
      timeline: Id,
      clips: z
        .array(z.strictObject({ clip: Id, start: Time.optional(), track: Id.optional() }))
        .min(1),
      overlap: Overlap,
      /** With insert, the tracks that make room, and always those it lands on; else all of them. */
      rippleTracks: RippleTracks,
    }),
    (draft, { timeline, clips, overlap, rippleTracks }) => {
      const target = timelineOf(draft, timeline);
      const moving = new Set(clips.map(({ clip }) => clip));
      if (moving.size !== clips.length) {
        const twice = clips.find(({ clip }, index) =>
          clips.slice(0, index).some((other) => other.clip === clip),
        );
        fail("invalid-value", { rule: "moved-twice", clip: twice?.clip ?? "" });
      }
      const landed = clips.map(({ clip, start, track }) => {
        const current = clipOf(target, clip);
        if (track !== undefined) checkFits(trackOf(target, track), current);
        const moved = { ...current, start: start ?? current.start, track: track ?? current.track };
        return { moved, span: spanOf(moved) };
      });

      const together = joinsTogether(target);
      const byTrack = new Map<string, typeof landed>();
      for (const item of landed) {
        const onTrack = byTrack.get(item.moved.track);
        if (onTrack) onTrack.push(item);
        else byTrack.set(item.moved.track, [item]);
      }
      // Every cut of every track is counted before any is made: see PieceLinks.
      const links = new PieceLinks();
      const spansOf = (items: typeof landed) =>
        items.toSorted((a, b) => compare(a.span.from, b.span.from)).map(({ span }) => span);
      if (overlap === "overwrite") {
        for (const [track, items] of byTrack) {
          expectCuts(target, track, spansOf(items), moving, links);
        }
      }
      // Inserting: one stretch from the first to land to the last, which the moving clips take no
      // part in. Where they were stays empty.
      let room: Omit<Opened, "joinsRemoved"> | undefined;
      if (overlap === "insert") {
        checkTracks(target, rippleTracks);
        const spans = landed.map(({ span }) => span);
        const from = spans.reduce((a, b) => (compare(a.from, b.from) <= 0 ? a : b)).from;
        const to = spans.reduce((a, b) => (compare(a.to, b.to) >= 0 ? a : b)).to;
        const own = withOwn(rippleTracks, byTrack.keys());
        room = openRoom(draft, timeline, from, subtract(to, from), own, moving);
      }
      for (const [track, items] of byTrack) {
        const inOrder = items.toSorted((a, b) => compare(a.span.from, b.span.from));
        inOrder.forEach(({ moved, span }, index) => {
          const next = inOrder[index + 1];
          if (next && compare(span.to, next.span.from) > 0) {
            fail("overlap", { clips: [named(moved), named(next.moved)], moved: true });
          }
        });
        const spans = inOrder.map(({ span }) => span);
        makeRoom(draft, timeline, track, spans, moving, overlap, links);
      }

      for (const { moved } of landed) {
        const path = clipPath(timeline, moved.id);
        const before = entryOf(target.clips, moved.id);
        if (moved.track !== before?.track) draft.set([...path, "track"], moved.track);
        if (moved.start !== before?.start) draft.set([...path, "start"], moved.start);
      }
      const last = landed.reduce((a, b) => (compare(a.span.to, b.span.to) >= 0 ? a : b));
      extendToFit(draft, timeline, last.span.to);
      const joins = apart(followJoins(draft, timeline, together));
      if (!room) return joins;
      const told = { ...opened(room), ...joins };
      return Object.keys(told).length > 0 ? told : undefined;
    },
    {
      group: "clip",
      result: z
        .strictObject({
          moved: z.array(Id).readonly().optional(),
          split: Split.optional(),
          ...JoinsRemoved,
        })
        .optional(),
      failures: ["not-found", "invalid-value", "wrong-track", "overlap"],
    },
  ),

  /** Moves the edges of a clip, which is different from changing its numbers: see trimClip. */
  define(
    "clip.trim",
    "修剪片段的开头或结尾：移动边缘，画面内容留在时间轴原来的位置；ripple 为 true 时波纹修剪：后面的内容跟着前移或后移。",
    z.strictObject({
      timeline: Id,
      clip: Id,
      start: Time.optional(),
      end: Time.optional(),
      /**
       * Clips trimmed with it, the same edges by the same amount, as the sound linked to a picture,
       * also where it is longer or shorter: a ripple goes once for all of them, and they stay in step.
       */
      together: DistinctClips.min(1).optional(),
      ripple: z.boolean().optional(),
      rippleTracks: RippleTracks,
    }),
    (draft, { timeline, clip, start, end, together: others, ripple, rippleTracks }) => {
      const target = timelineOf(draft, timeline);
      const current = clipOf(target, clip);
      // How far each edge moves: every clip of together moves its edges by as much.
      const byStart = start === undefined ? ZERO : subtract(parseTime(start), clipStart(current));
      const byEnd = end === undefined ? ZERO : subtract(parseTime(end), clipEnd(current));
      const all = [
        current,
        ...(others ?? []).filter((id) => id !== clip).map((id) => clipOf(target, id)),
      ];
      const spans = all.map((each): Span => ({
        from: add(clipStart(each), byStart),
        to: add(clipEnd(each), byEnd),
      }));
      all.forEach((each, index) => {
        const span = spans[index] as Span;
        if (compare(span.to, span.from) <= 0)
          fail("invalid-value", { rule: "end-before-start", clip: each.id });
        const length = sourceLength(draft.state, each);
        const clockAtEnd = add(clipOffset(each), subtract(span.to, clipStart(each)));
        if (length && compare(clockAtEnd, length) > 0) {
          fail("source-end", { clip: each.id, ...nameOf(each) });
        }
      });
      const ids = all.map(({ id }) => id);
      if (ripple) {
        checkTracks(target, rippleTracks);
        // The end first, then the start, each a ripple of its own.
        const done = [
          ...(compare(byEnd, ZERO) === 0
            ? []
            : [rippleTrim(draft, timeline, ids, "end", parseTime(end as string), rippleTracks)]),
          ...(compare(byStart, ZERO) === 0
            ? []
            : [
                rippleTrim(draft, timeline, ids, "start", parseTime(start as string), rippleTracks),
              ]),
        ];
        const union = (pick: (each: RippleTrimmed) => readonly string[]) => [
          ...new Set(done.flatMap(pick)),
        ];
        const told = {
          ...opened({
            moved: union(({ moved }) => moved),
            split: done.flatMap(({ split }) => split),
          }),
          ...rippled({
            moved: [],
            joinsRemoved: union(({ joinsRemoved }) => joinsRemoved),
            sectionsRemoved: union(({ sectionsRemoved }) => sectionsRemoved),
          }),
        };
        return Object.keys(told).length > 0 ? told : undefined;
      }
      const trimmed = new Set(ids);
      all.forEach((each, index) => assertFree(target, each.track, [spans[index] as Span], trimmed));
      const together = joinsTogether(target);
      all.forEach((each, index) => trimClip(draft, timeline, each, spans[index] as Span));
      for (const span of spans) extendToFit(draft, timeline, span.to);
      return apart(followJoins(draft, timeline, together));
    },
    {
      group: "clip",
      result: z.strictObject({ ...RippledFields, split: Split.optional() }).optional(),
      failures: [
        "not-found",
        "invalid-value",
        "source-end",
        "source-start",
        "overlap",
        "ripple-blocked",
      ],
    },
  ),

  /**
   * Slip, as video editors have it: the clips stay where they are and as long, and what they show
   * goes by `by` within them. Linked clips are listed by whoever slips, see `slipClips`.
   */
  define(
    "clip.slip",
    "滑移：片段的位置和长短不变，里面的内容整体前后滑动 by（改 offset），关键帧随内容一起滑。",
    z.strictObject({ timeline: Id, clips: DistinctClips.min(1), by: Shift }),
    (draft, { timeline, clips, by }) => {
      slipClips(draft, timeline, clips, parseTime(by));
    },
    {
      group: "clip",
      result: Nothing,
      failures: ["not-found", "source-start", "source-end"],
    },
  ),

  /**
   * Slide, as video editors have it: the clips move by `by`, and their neighbours on each track give
   * and take that time, see `slideClips`.
   */
  define(
    "clip.slide",
    "滑动：片段整体移动 by，同一轨道上紧贴着的前一个片段修结尾、后一个修开头，合起来的范围不变；一侧是空隙时空隙变长变短。",
    z.strictObject({ timeline: Id, clips: DistinctClips.min(1), by: Shift }),
    (draft, { timeline, clips, by }) => apart(slideClips(draft, timeline, clips, parseTime(by))),
    {
      group: "clip",
      result: MaybeApart,
      failures: ["not-found", "invalid-value", "source-start", "source-end", "overlap"],
    },
  ),

  /**
   * A roll edit, as video editors have it: an edge and the edge right next to it move together, so
   * that the two clips are as long together as before, see `rollEdges`.
   */
  define(
    "clip.roll",
    "滚动编辑：把片段的一条边和紧贴着它的邻居的那条边一起移到 at，两段总长不变；edges 里其余的边移同样的量；没有紧贴的邻居时就是普通修剪。",
    z.strictObject({
      timeline: Id,
      edges: z.array(z.strictObject({ clip: Id, edge: z.enum(["start", "end"]) })).min(1),
      at: Time,
    }),
    (draft, { timeline, edges, at }) => apart(rollEdges(draft, timeline, edges, parseTime(at))),
    {
      group: "clip",
      result: MaybeApart,
      failures: ["not-found", "invalid-value", "source-start", "source-end", "overlap"],
    },
  ),

  /**
   * Cuts a clip in two at a moment on the timeline. Clips linked to it are cut along with it, and
   * the parts after the cut get a link of their own: otherwise all four would move as one.
   */
  define(
    "clip.split",
    "在时间轴上的某个时刻把片段切成两段，链接在一起的片段一起切。",
    z.strictObject({
      timeline: Id,
      clip: Id,
      at: Time,
      /** The id of the new part after the cut. Without it the editor makes one. */
      piece: Id.optional(),
      /**
       * Linked clips that stay whole and keep their link, such as ones on a track that people
       * locked at the editor.
       */
      keep: z.array(Id).optional(),
    }),
    (draft, { timeline, clip, at, piece, keep }) => {
      const target = timelineOf(draft, timeline);
      const current = clipOf(target, clip);
      const moment = parseTime(at);
      const isInside = (candidate: ClipState) =>
        compare(moment, clipStart(candidate)) > 0 && compare(moment, clipEnd(candidate)) < 0;
      if (!isInside(current)) fail("invalid-value", { rule: "cut-outside", clip, at });
      const rightId = piece ?? newId("clip");
      assertIdFree(target, rightId, "clip");

      const cut = Object.values(target.clips).filter(
        (other) =>
          current.link &&
          other.id !== clip &&
          other.link === current.link &&
          isInside(other) &&
          keep?.includes(other.id) !== true,
      );
      const link = cut.length > 0 ? newId("link") : undefined;
      splitClip(draft, timeline, current, moment, rightId, link);
      for (const partner of cut) splitClip(draft, timeline, partner, moment, newId("clip"), link);
      return { id: rightId };
    },
    { group: "clip", result: Made, failures: ["not-found", "invalid-value", "id-taken"] },
  ),

  /**
   * Links clips, such as the picture and the sound of a video, so that people select, move, trim
   * and cut them together. Commands still do only what they list. A group that would keep only one
   * clip goes, so that no clip is linked to nothing.
   */
  define(
    "clip.link",
    "把几个片段联动成一组：在编辑器里一起选中、移动、修剪和切割。",
    z.strictObject({ timeline: Id, clips: DistinctClips.min(2) }),
    (draft, { timeline, clips }) => {
      const target = timelineOf(draft, timeline);
      for (const id of clips) clipOf(target, id);
      const link = newId("link");
      setLinks(draft, timeline, target, clips, link);
      return { link };
    },
    {
      group: "clip",
      result: z.strictObject({ link: Id }),
      failures: ["not-found"],
    },
  ),

  /** Takes clips out of their groups, and a group that keeps only one clip goes. */
  define(
    "clip.unlink",
    "取消片段的联动，之后各自独立；组里只剩一个片段时它也不再联动。",
    z.strictObject({ timeline: Id, clips: DistinctClips.min(1) }),
    (draft, { timeline, clips }) => {
      const target = timelineOf(draft, timeline);
      for (const id of clips) clipOf(target, id);
      setLinks(draft, timeline, target, clips, undefined);
    },
    { group: "clip", result: Nothing, failures: ["not-found"] },
  ),

  define(
    "clip.setProperty",
    "把片段的一个属性整个设成一个值，也可以是带关键帧的动画。",
    z.strictObject({ timeline: Id, clip: Id, path: PropertyPath, value: PropertyValue }),
    (draft, { timeline, clip, path, value }) => {
      const owner = { clip };
      editProperties(draft, timeline, [{ owner, path, op: "set", value }]);
    },
    {
      group: "property",
      ai: { no: "duplicate", instead: "property.edit" },
      result: Nothing,
      failures: PROPERTY_FAILURES,
    },
  ),

  define(
    "clip.clearProperty",
    "去掉片段的一个属性，回到默认值。",
    z.strictObject({ timeline: Id, clip: Id, path: PropertyPath }),
    (draft, { timeline, clip, path }) => {
      editProperties(draft, timeline, [{ owner: { clip }, path, op: "clear" }]);
    },
    {
      group: "property",
      ai: { no: "duplicate", instead: "property.edit" },
      result: Nothing,
      failures: PROPERTY_FAILURES,
    },
  ),

  /** Everything people, tools and AI do to properties, in one step however much it is. */
  define(
    "property.edit",
    "一步里批量改片段、音轨或主输出的属性和关键帧：写值、加删移关键帧、改插值、伸缩和反转关键帧的时间、整个设置或清除。",
    z.strictObject({ timeline: Id, edits: z.array(PropertyEdit).min(1) }),
    (draft, { timeline, edits }) => {
      const removed = editProperties(draft, timeline, edits);
      return removed.length > 0 ? { removed } : undefined;
    },
    { group: "property", result: EditedProperties, failures: PROPERTY_EDIT_FAILURES },
  ),

  /**
   * Gives keys and values another path, for code that renamed what they are about: one property,
   * or everything under a path with `object.arm.*`. Nothing renames anything by itself.
   */
  define(
    "property.rename",
    "给片段属性的路径改名，关键帧和各个版本里的值一起移过去，用在代码里的对象改名之后。",
    z.strictObject({ timeline: Id, renames: z.array(PropertyRename).min(1) }),
    (draft, { timeline, renames }) => ({ renamed: renameProperties(draft, timeline, renames) }),
    {
      group: "property",
      result: z.strictObject({ renamed: z.number() }),
      failures: ["not-found", "invalid-value", "path-taken", "not-animatable"],
    },
  ),

  /** A marker, with its own fields. Markers share their ids among themselves, see the format. */
  define(
    "marker.add",
    "在时间轴上加一个标记。",
    z.strictObject({ timeline: Id, ...Marker.extend({ id: Id.optional() }).shape }),
    (draft, { timeline, ...marker }) => {
      const markers = timelineOf(draft, timeline).markers;
      const id = marker.id ?? newId("marker");
      if (entryOf(markers, id)) fail("id-taken", { kind: "marker", id, by: "marker" });
      draft.set([...timelinePath(timeline), "markers", id], { ...marker, id });
      return { id };
    },
    { group: "marker", result: Made, failures: ["not-found", "id-taken"] },
  ),

  define(
    "marker.update",
    "改标记的时间、名字、备注、颜色或时长，clear 去掉名字、备注、颜色或时长（变成点标记）。",
    z.strictObject({
      timeline: Id,
      marker: Id,
      changes: MarkerChanges,
      clear: z.array(ClearableMarkerField).optional(),
    }),
    (draft, { timeline, marker, changes, clear }) => {
      const current = entryOf(timelineOf(draft, timeline).markers, marker);
      if (!current) fail("not-found", { kind: "marker", id: marker });
      for (const [key, value] of Object.entries(changes)) {
        draft.set([...timelinePath(timeline), "markers", marker, key], value);
      }
      for (const field of clear ?? []) {
        if (field in changes || current?.[field] === undefined) continue;
        draft.delete([...timelinePath(timeline), "markers", marker, field]);
      }
    },
    { group: "marker", result: Nothing, failures: ["not-found"] },
  ),

  define(
    "marker.remove",
    "删除一个标记。",
    z.strictObject({ timeline: Id, marker: Id }),
    (draft, params) => {
      const { timeline, marker } = params;
      if (!entryOf(timelineOf(draft, timeline).markers, marker)) {
        fail("not-found", { kind: "marker", id: marker });
      }
      draft.delete([...timelinePath(timeline), "markers", marker]);
    },
    { group: "marker", result: Nothing, failures: ["not-found"] },
  ),
] as const satisfies readonly Operation[];

/** Every operation, by the name it had first. Kept until the tools of 6.5b are all in. */
export const COMMANDS: readonly Operation[] = OPERATIONS;

export type OperationName = (typeof OPERATIONS)[number]["name"];

/** What AI can use, by name: the tools document every one of them, see `@animaquill/tools`. */
export type AiOperationName = Exclude<
  OperationName,
  Extract<(typeof OPERATIONS)[number], { readonly ai: { readonly no: string } }>["name"]
>;

const BY_NAME: ReadonlyMap<string, Operation> = new Map(OPERATIONS.map((op) => [op.name, op]));

/** The operation of a name, or undefined for one there is not. */
export const operationOf = (name: string): Operation | undefined => BY_NAME.get(name);
