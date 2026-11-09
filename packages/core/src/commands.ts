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
  Rate,
  Time,
  Track,
  Transition,
  ZERO,
  add,
  canHold,
  cannotHaveKeys,
  compare,
  describeMissing,
  describeUnsupported,
  findTransition,
  isSupported,
  mediaOfTrack,
  newId,
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
  type Edge,
  type JoinedEdges,
  type Span,
} from "./clip-edits.ts";
import { fail, type Draft } from "./draft.ts";
import {
  EffectAdd,
  EffectMove,
  EffectRemove,
  EffectUpdate,
  addEffect,
  checkEffectWrite,
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
  trackKindFor,
  type ClipState,
  type TimelineState,
  type TrackState,
} from "./model.ts";
import { deepEqual } from "./patch.ts";
import { PropertyEdit, applyEdit } from "./property-edit.ts";
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

export interface CommandDefinition<P = unknown> {
  readonly type: string;
  readonly params: z.ZodType<P>;
  readonly run: (draft: Draft, params: P) => unknown;
  /** Can run on a project with a locked tag: the way to take the tag off again. */
  readonly whileLocked?: boolean;
  /** Only people can do this, never an AI task. */
  readonly userOnly?: boolean;
  /** Only people can use these parameters. */
  readonly userOnlyParams?: readonly string[];
}

function define<S extends z.ZodType>(
  type: string,
  params: S,
  run: (draft: Draft, params: z.output<S>) => unknown,
  options: Pick<CommandDefinition, "whileLocked" | "userOnly" | "userOnlyParams"> = {},
): CommandDefinition {
  return { type, params, run: run as CommandDefinition["run"], ...options };
}

const trackPath = (timeline: string, track: string) => ["timelines", timeline, "tracks", track];

function trackOf(timeline: TimelineState, id: string): TrackState {
  return entryOf(timeline.tracks, id) ?? fail("not-found", `没有这条轨道：${id}`);
}

/**
 * Also a clip that two people at once left behind on a track that is gone: people can still clean
 * up. Locks on tracks are for people at the editor, which keeps to them: commands do not.
 */
function clipOf(timeline: TimelineState, id: string): ClipState {
  return entryOf(timeline.clips, id) ?? fail("not-found", `没有这个片段：${id}`);
}

/**
 * What a command says about the joins it took away because their clips are no longer next to each
 * other, so that people hear of it: nothing when it took none.
 */
const apart = (joins: readonly string[]) =>
  joins.length > 0 ? { joinsRemoved: joins } : undefined;

function checkClip(clip: ClipState): void {
  const result = Clip.safeParse(clipFileOf(clip));
  if (!result.success) {
    const issue = result.error.issues[0];
    fail("invalid-value", `${issue?.path.join(".")}：${issue?.message}`);
  }
}

function checkFits(track: TrackState, clip: { readonly source: ClipSource }): void {
  if (!canHold(track.kind, clip.source.kind)) {
    fail("wrong-track", `${track.kind} 轨道不能放 ${clip.source.kind} 片段`);
  }
}

/** A clip on code that is not there would do nothing, and nothing would say why. */
function checkCode(state: Draft["state"], { source }: { readonly source: ClipSource }): void {
  if (source.kind === "scene" && source.scene !== undefined) {
    const scene = source.scene as string;
    if (!entryOf(state.scenes, scene)) fail("not-found", `没有这个场景：${scene}`);
  }
  if (source.kind === "sound" && source.sound !== undefined) {
    const sound = source.sound as string;
    if (!entryOf(state.sounds, sound)) fail("not-found", `没有这个声音：${sound}`);
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
    if (found.kind === "missing") return fail("transition-missing", describeMissing(found.why));
    // Captions do not get drawn yet, and neither would what they come in and go out with.
    if (kind === "caption" || !isSupported(found, media, edge)) {
      const words = kind === "caption" ? "这一版的编辑器还不能显示字幕的转场" : undefined;
      fail("transition-unsupported", words ?? describeUnsupported(found.type, media, edge));
    }
    checkValues(found.spec, found.type, transition.values);
  }
  const total = edgesLength(next);
  if (compare(total, parseTime(next.duration)) > 0 && compare(total, edgesLength(current)) > 0) {
    fail("transition-too-long", "入转场和出转场加起来比片段长");
  }
  // A join at the other end takes its part of the clip, which no transition may run into.
  const taken = takenLength(joined, next);
  if (
    compare(taken, parseTime(next.duration)) > 0 &&
    compare(taken, takenLength(joined, current)) > 0
  ) {
    fail("transition-too-long", "这个转场和片段另一头的衔接转场加起来比片段长");
  }
}

/** A number for something that goes before `next` in a list, without renumbering the others. */
function orderBefore<T extends { readonly id: string; readonly order: number }>(
  items: readonly T[],
  next: string | undefined,
  moving?: string,
): number {
  const others = items.filter((item) => item.id !== moving);
  const index = next === undefined ? others.length : others.findIndex((item) => item.id === next);
  if (index < 0) fail("not-found", `没有这一项：${next}`);
  const after = others[index]?.order;
  const before = others[index - 1]?.order;
  if (after === undefined) return (before ?? -1) + 1;
  return before === undefined ? after - 1 : (before + after) / 2;
}

/**
 * What happens to clips in the way. An editor drops over them, like people expect from any video
 * editor. Everyone else has to say so: a change nobody asked for is worse than a refused command.
 */
const Overlap = z.enum(["reject", "overwrite"]).optional();

function makeRoom(
  draft: Draft,
  timeline: string,
  track: string,
  spans: readonly Span[],
  moving: ReadonlySet<string>,
  overlap: z.output<typeof Overlap>,
): void {
  if (overlap === "overwrite") clearSpans(draft, timeline, track, spans, moving);
  else assertFree(timelineOf(draft, timeline), track, spans, moving);
}

function checkKeys(path: string, value: PropertyValue): void {
  if (cannotHaveKeys(path, value)) fail("not-animatable", `${path} 不能打关键帧`);
}

/** Only what gets written. Something else being wrong must not stop people from fixing it. */
export function checkWrite(
  path: string,
  before: PropertyValue | undefined,
  after: PropertyValue,
): void {
  if (RETIRED_PROPERTIES.includes(path)) fail("invalid-value", `没有这个属性：${path}，裁切是效果`);
  const result = KnownProperties.safeParse({ [path]: after });
  if (!result.success) {
    const issue = result.error.issues[0];
    fail("invalid-value", `${issue?.path.join(".")}：${issue?.message}`);
  }
  if (!deepEqual(before, after)) checkKeys(path, after);
}

/**
 * Plans edits of properties, each one seeing the ones before it. All writes of properties come
 * through here. What does not change writes nothing, so that a drag that ends where it started leaves
 * no step to undo, and taking something away always works, because that is the way out of bad data.
 */
function editProperties(draft: Draft, timeline: string, edits: readonly PropertyEdit[]): void {
  const target = timelineOf(draft, timeline);
  const changes = new Map<string, Map<string, PropertyValue | undefined>>();
  for (const edit of edits) {
    const { path, owner } = edit;
    const clip = clipOf(target, owner.clip);
    const values = changes.get(clip.id) ?? new Map<string, PropertyValue | undefined>();
    changes.set(clip.id, values);
    const before = values.has(path) ? values.get(path) : entryOf(clip.properties, path);
    values.set(path, applyEdit(before, edit));
  }
  for (const [id, values] of changes) {
    const clip = entryOf(target.clips, id) as ClipState;
    for (const [path, value] of values) {
      const saved = entryOf(clip.properties, path);
      if (deepEqual(saved, value)) continue;
      const where = [...clipPath(timeline, id), "properties", path];
      if (value === undefined) {
        draft.delete(where);
      } else {
        checkWrite(path, saved, value);
        checkEffectWrite(clip, path, value);
        draft.set(where, value);
      }
    }
  }
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
    if (moves.length === 0) fail("not-found", `没有这个属性：${rename.from}`);
    const plan = plans.get(clip.id) ?? new Map<string, PlannedMove>();
    plans.set(clip.id, plan);
    for (const [from, to] of moves) {
      if (!PropertyPath.safeParse(to).success) fail("invalid-value", `不是属性路径：${to}`);
      if (from === to) fail("invalid-value", `改名前后是同一个属性：${from}`);
      if (plan.has(from)) fail("invalid-value", `同一个属性不能改名两次：${from}`);
      plan.set(from, { to, rename });
    }
  }
  let moved = 0;
  for (const [id, plan] of plans) {
    const clip = entryOf(target.clips, id) as ClipState;
    const paths = pathsOfClip(target, clip);
    const targets = new Set<string>();
    for (const { to } of plan.values()) {
      if (targets.has(to)) fail("invalid-value", `两个属性不能改成同一个名字：${to}`);
      targets.add(to);
      if (paths.has(to) && !plan.has(to)) fail("conflict", `已经有这个属性：${to}`);
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

export const COMMANDS: readonly CommandDefinition[] = [
  define("project.rename", z.strictObject({ name: z.string().min(1) }), (draft, { name }) => {
    draft.set(["manifest", "name"], name);
  }),

  define("project.setFrameRate", z.strictObject({ fps: Rate }), (draft, { fps }) => {
    draft.set(["manifest", "fps"], fps);
  }),

  define(
    "project.setTags",
    z.strictObject({ tags: ProjectManifest.shape.tags.unwrap() }),
    (draft, { tags }) => {
      draft.set(["manifest", "tags"], tags);
    },
    { whileLocked: true, userOnly: true },
  ),

  define(
    "asset.add",
    z.strictObject({ id: Id.optional(), asset: Asset }),
    (draft, { id, asset }) => {
      const key = id ?? newId("asset");
      if (entryOf(draft.state.assets, key)) fail("id-taken", `这个 ID 已经有素材了：${key}`);
      draft.set(["assets", key], asset);
      return { id: key };
    },
  ),

  /**
   * What an asset is called and found by, and where its file is and what it is: for a file that
   * moved or was replaced, as people agreed. Clips stay on the asset. No tags at all takes them away.
   */
  define(
    "asset.update",
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
      if (!found) fail("not-found", `没有这个素材：${asset}`);
      const defined: Record<string, unknown> = Object.fromEntries(
        Object.entries(changes).filter(([, value]) => value !== undefined),
      );
      const merged: Record<string, unknown> = { ...found, ...defined };
      if (changes.tags?.length === 0) delete merged.tags;
      const next = Asset.safeParse(merged);
      if (!next.success) {
        fail("invalid-value", `素材的新内容不对：${next.error.issues[0]?.message ?? ""}`);
      }
      // Assets are no layer of their own: each one is written as a whole, see structure.ts.
      draft.set(["assets", asset], next.data);
    },
  ),

  /** `withUses` takes the clips that use it along, in the same step, see `removeUses`. */
  define(
    "asset.remove",
    z.strictObject({ asset: Id, withUses: z.boolean().optional() }),
    (draft, { asset, withUses }) => {
      if (!entryOf(draft.state.assets, asset)) fail("not-found", `没有这个素材：${asset}`);
      const code = codeUsingAsset(draft.state, asset);
      if (code !== undefined) fail("asset-in-use", `代码在用这个素材，要先改掉：${code}`);
      if (withUses) removeUses(draft, "asset", asset);
      else if (isInUse(draft.state, ["assets", asset])) {
        fail("asset-in-use", "还有片段或版本在用这个素材，要先换掉或删除它们");
      }
      draft.delete(["assets", asset]);
    },
  ),

  define("scene.add", SceneAdd, addScene),
  define("scene.update", SceneUpdate, updateScene),
  define("scene.remove", SceneRemove, removeScene),
  define("sound.add", SoundAdd, addSound),
  define("sound.update", SoundUpdate, updateSound),
  define("sound.remove", SoundRemove, removeSound),
  /** Clips that use an asset, scene or sound use another one of the same kind instead. */
  define("source.replace", SourceReplace, replaceSource),
  define("file.write", FileWrite, writeFile),
  define("file.remove", FileRemove, removeFile),
  define("file.rename", FileRename, renameFile),

  define(
    "timeline.rename",
    z.strictObject({ timeline: Id, name: z.string().min(1) }),
    (draft, { timeline, name }) => {
      timelineOf(draft, timeline);
      draft.set([...timelinePath(timeline), "name"], name);
    },
  ),

  define(
    "section.add",
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
      if (entryOf(target.sections, id)) fail("id-taken", `这个 ID 已经有段落了：${id}`);
      const order = orderBefore(orderedSections(target), before);
      const section = { id, ...(name ? { name } : {}), duration, order };
      draft.set([...timelinePath(timeline), "sections", id], section);
      return { id };
    },
  ),

  define(
    "section.update",
    z.strictObject({
      timeline: Id,
      section: Id,
      duration: Duration.optional(),
      name: z.string().optional(),
    }),
    (draft, { timeline, section, duration, name }) => {
      const target = entryOf(timelineOf(draft, timeline).sections, section);
      if (!target) fail("not-found", `没有这个段落：${section}`);
      const path = [...timelinePath(timeline), "sections", section];
      if (duration !== undefined) draft.set([...path, "duration"], duration);
      if (name !== undefined) draft.set([...path, "name"], name);
    },
  ),

  define(
    "section.remove",
    z.strictObject({ timeline: Id, section: Id }),
    (draft, { timeline, section }) => {
      const { sections } = timelineOf(draft, timeline);
      if (!entryOf(sections, section)) fail("not-found", `没有这个段落：${section}`);
      if (Object.keys(sections).length === 1) fail("last-section", "时间轴至少要有一个段落");
      draft.delete([...timelinePath(timeline), "sections", section]);
    },
  ),

  define(
    "track.add",
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
      if (entryOf(target.tracks, id)) fail("id-taken", `这个 ID 已经有轨道了：${id}`);
      const order = orderBefore(orderedTracks(target), before);
      const track = { id, kind, ...(name ? { name } : {}), order };
      draft.set(trackPath(timeline, id), track);
      return { id };
    },
  ),

  define(
    "track.update",
    z.strictObject({ timeline: Id, track: Id, changes: TrackChanges }),
    (draft, { timeline, track, changes }) => {
      const current = trackOf(timelineOf(draft, timeline), track);
      const { order: _order, ...head } = current;
      const result = Track.safeParse({ ...head, ...changes, clips: [] });
      if (!result.success) fail("invalid-value", `${current.kind} 轨道没有这些设置`);
      for (const [key, value] of Object.entries(changes)) {
        draft.set([...trackPath(timeline, track), key], value);
      }
    },
  ),

  define(
    "track.move",
    z.strictObject({ timeline: Id, track: Id, before: Id.optional() }),
    (draft, { timeline, track, before }) => {
      const target = timelineOf(draft, timeline);
      trackOf(target, track);
      const order = orderBefore(orderedTracks(target), before, track);
      draft.set([...trackPath(timeline, track), "order"], order);
    },
  ),

  define("track.remove", z.strictObject({ timeline: Id, track: Id }), (draft, params) => {
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
  }),

  define(
    "clip.add",
    z.strictObject({
      timeline: Id,
      track: Id,
      clip: ClipInput,
      overlap: Overlap,
      /**
       * The clip that this one takes the place of, which went away earlier in the same batch. What
       * people are trying goes along, so AI has no say in this: it does not even see that.
       */
      movedFrom: Id.optional(),
    }),
    (draft, { timeline, track, clip, overlap, movedFrom }) => {
      const target = timelineOf(draft, timeline);
      const home = trackOf(target, track);
      checkFits(home, clip);
      checkCode(draft.state, clip);
      const id = clip.id ?? newId("clip");
      if (entryOf(target.clips, id)) fail("id-taken", `这个 ID 已经有片段了：${id}`);
      for (const [path, value] of Object.entries(clip.properties ?? {})) checkKeys(path, value);
      const added = clipStateOf({ ...clip, id }, track);
      const together = joinsTogether(target);
      makeRoom(draft, timeline, track, [spanOf(added)], new Set(), overlap);
      draft.set(clipPath(timeline, id), added);
      // A copy brings its transitions as they are, also ones that this editor cannot do yet, which
      // the problems and exports then tell about. What does not fit any more gets shorter.
      fitTransitions(draft, timeline, added, parseTime(added.duration), "end");
      extendToFit(draft, timeline, clipEnd(added));
      if (movedFrom !== undefined) {
        if (!draft.wentAway(clipPath(timeline, movedFrom))) {
          fail("not-moved", `这一批改动没有移走这个片段：${movedFrom}`);
        }
        draft.note({ kind: "moved", from: movedFrom, to: id });
      }
      return { id, ...apart(followJoins(draft, timeline, together)) };
    },
    { userOnlyParams: ["movedFrom"] },
  ),

  define(
    "clip.remove",
    z.strictObject({ timeline: Id, clips: z.array(Id).min(1) }),
    (draft, { timeline, clips }) => {
      const target = timelineOf(draft, timeline);
      for (const id of clips) clipOf(target, id);
      removeClips(draft, timeline, clips);
    },
  ),

  /** Transitions at the edges of a clip have a command of their own, `clip.setTransition`. */
  define(
    "clip.update",
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
  ),

  /**
   * Puts a transition at the start or the end of a clip, or takes it away with null, such as a fade
   * in. What is left out stays as it is. Transitions are about the clip, not properties that change
   * over time, so this is never something that people try first.
   */
  define(
    "clip.setTransition",
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
  ),

  /** Puts a join on the cut between two clips, see join-edits.ts. */
  define("join.add", JoinAdd, addJoin, { userOnlyParams: ["copied"] }),
  define("effect.add", EffectAdd, addEffect),
  define("effect.remove", EffectRemove, removeEffects),
  define("effect.move", EffectMove, moveEffect),
  define("effect.update", EffectUpdate, updateEffect),
  define("join.update", JoinUpdate, updateJoin),
  define("join.remove", JoinRemove, removeJoins),

  /** Several clips move in one step, because the place one of them leaves is free for another. */
  define(
    "clip.move",
    z.strictObject({
      timeline: Id,
      clips: z
        .array(z.strictObject({ clip: Id, start: Time.optional(), track: Id.optional() }))
        .min(1),
      overlap: Overlap,
    }),
    (draft, { timeline, clips, overlap }) => {
      const target = timelineOf(draft, timeline);
      const moving = new Set(clips.map(({ clip }) => clip));
      if (moving.size !== clips.length) fail("invalid-value", "同一个片段不能移动两次");
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
      for (const [track, items] of byTrack) {
        const inOrder = items.toSorted((a, b) => compare(a.span.from, b.span.from));
        inOrder.forEach(({ moved, span }, index) => {
          const next = inOrder[index + 1];
          if (next && compare(span.to, next.span.from) > 0) {
            fail("overlap", `片段落在了同一个位置：${moved.id}、${next.moved.id}`);
          }
        });
        const spans = inOrder.map(({ span }) => span);
        makeRoom(draft, timeline, track, spans, moving, overlap);
      }

      for (const { moved } of landed) {
        const path = clipPath(timeline, moved.id);
        const before = entryOf(target.clips, moved.id);
        if (moved.track !== before?.track) draft.set([...path, "track"], moved.track);
        if (moved.start !== before?.start) draft.set([...path, "start"], moved.start);
      }
      const last = landed.reduce((a, b) => (compare(a.span.to, b.span.to) >= 0 ? a : b));
      extendToFit(draft, timeline, last.span.to);
      return apart(followJoins(draft, timeline, together));
    },
  ),

  /** Moves the edges of a clip, which is different from changing its numbers: see trimClip. */
  define(
    "clip.trim",
    z.strictObject({ timeline: Id, clip: Id, start: Time.optional(), end: Time.optional() }),
    (draft, { timeline, clip, start, end }) => {
      const target = timelineOf(draft, timeline);
      const current = clipOf(target, clip);
      const span: Span = {
        from: start === undefined ? clipStart(current) : parseTime(start),
        to: end === undefined ? clipEnd(current) : parseTime(end),
      };
      if (compare(span.to, span.from) <= 0) fail("invalid-value", "片段的结尾要在开头之后");
      const length = sourceLength(draft.state, current);
      const clockAtEnd = add(clipOffset(current), subtract(span.to, clipStart(current)));
      if (length && compare(clockAtEnd, length) > 0) {
        fail("source-end", `已经到内容的结尾了：${current.name ?? current.id}`);
      }
      assertFree(target, current.track, [span], new Set([clip]));
      const together = joinsTogether(target);
      trimClip(draft, timeline, current, span);
      extendToFit(draft, timeline, span.to);
      return apart(followJoins(draft, timeline, together));
    },
  ),

  /**
   * Cuts a clip in two at a moment on the timeline. Clips linked to it are cut along with it, and
   * the parts after the cut get a link of their own: otherwise all four would move as one.
   */
  define(
    "clip.split",
    z.strictObject({
      timeline: Id,
      clip: Id,
      at: Time,
      id: Id.optional(),
      /**
       * Linked clips that stay whole and keep their link, such as ones on a track that people
       * locked at the editor.
       */
      keep: z.array(Id).optional(),
    }),
    (draft, { timeline, clip, at, id, keep }) => {
      const target = timelineOf(draft, timeline);
      const current = clipOf(target, clip);
      const moment = parseTime(at);
      const isInside = (candidate: ClipState) =>
        compare(moment, clipStart(candidate)) > 0 && compare(moment, clipEnd(candidate)) < 0;
      if (!isInside(current)) fail("invalid-value", "切割点要在片段中间");
      const rightId = id ?? newId("clip");
      if (entryOf(target.clips, rightId)) fail("id-taken", `这个 ID 已经有片段了：${rightId}`);

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
  ),

  define(
    "clip.setProperty",
    z.strictObject({ timeline: Id, clip: Id, path: PropertyPath, value: PropertyValue }),
    (draft, { timeline, clip, path, value }) => {
      const owner = { clip };
      editProperties(draft, timeline, [{ owner, path, op: "set", value }]);
    },
  ),

  define(
    "clip.clearProperty",
    z.strictObject({ timeline: Id, clip: Id, path: PropertyPath }),
    (draft, { timeline, clip, path }) => {
      editProperties(draft, timeline, [{ owner: { clip }, path, op: "clear" }]);
    },
  ),

  /** Everything people, tools and AI do to properties, in one step however much it is. */
  define(
    "property.edit",
    z.strictObject({ timeline: Id, edits: z.array(PropertyEdit).min(1) }),
    (draft, { timeline, edits }) => {
      editProperties(draft, timeline, edits);
    },
  ),

  /**
   * Gives keys and values another path, for code that renamed what they are about: one property,
   * or everything under a path with `object.arm.*`. Nothing renames anything by itself.
   */
  define(
    "property.rename",
    z.strictObject({ timeline: Id, renames: z.array(PropertyRename).min(1) }),
    (draft, { timeline, renames }) => ({ renamed: renameProperties(draft, timeline, renames) }),
  ),

  define(
    "marker.add",
    z.strictObject({ timeline: Id, marker: Marker.extend({ id: Id.optional() }) }),
    (draft, { timeline, marker }) => {
      timelineOf(draft, timeline);
      const id = marker.id ?? newId("marker");
      draft.set([...timelinePath(timeline), "markers", id], { ...marker, id });
      return { id };
    },
  ),

  define(
    "marker.update",
    z.strictObject({ timeline: Id, marker: Id, changes: MarkerChanges }),
    (draft, { timeline, marker, changes }) => {
      if (!entryOf(timelineOf(draft, timeline).markers, marker)) {
        fail("not-found", `没有这个标记：${marker}`);
      }
      for (const [key, value] of Object.entries(changes)) {
        draft.set([...timelinePath(timeline), "markers", marker, key], value);
      }
    },
  ),

  define("marker.remove", z.strictObject({ timeline: Id, marker: Id }), (draft, params) => {
    const { timeline, marker } = params;
    if (!entryOf(timelineOf(draft, timeline).markers, marker)) {
      fail("not-found", `没有这个标记：${marker}`);
    }
    draft.delete([...timelinePath(timeline), "markers", marker]);
  }),
];
