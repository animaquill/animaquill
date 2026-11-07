import {
  Asset,
  Clip,
  ClipSource,
  Duration,
  Id,
  KnownProperties,
  Marker,
  ProjectManifest,
  PropertyPath,
  PropertyValue,
  Rate,
  Time,
  Track,
  add,
  canHold,
  cannotHaveKeys,
  compare,
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
  removeClips,
  spanOf,
  splitClip,
  timelineOf,
  timelinePath,
  trimClip,
  type Span,
} from "./clip-edits.ts";
import { fail, type Draft } from "./draft.ts";
import {
  clipEnd,
  clipOffset,
  clipStart,
  entryOf,
  orderedSections,
  orderedTracks,
  sourceLength,
  type ClipState,
  type TimelineState,
  type TrackState,
} from "./model.ts";
import { deepEqual } from "./patch.ts";
import { PropertyEdit, applyEdit } from "./property-edit.ts";
import { isInUse } from "./references.ts";
import {
  FileRemove,
  FileRename,
  FileWrite,
  SceneAdd,
  SceneRemove,
  SceneUpdate,
  addScene,
  removeFile,
  removeScene,
  renameFile,
  updateScene,
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

/** A locked track protects its clips from everyone, also from AI tasks. */
function editableTrack(timeline: TimelineState, id: string): TrackState {
  const track = trackOf(timeline, id);
  if (track.locked) fail("track-locked", `轨道已锁定：${track.name ?? id}`);
  return track;
}

/** Two people at once can leave a clip behind on a track that is gone. People can still clean up. */
function editableClip(timeline: TimelineState, id: string): ClipState {
  const clip = entryOf(timeline.clips, id) ?? fail("not-found", `没有这个片段：${id}`);
  if (entryOf(timeline.tracks, clip.track)) editableTrack(timeline, clip.track);
  return clip;
}

function checkClip(clip: ClipState): void {
  const { track: _track, ...rest } = clip;
  const result = Clip.safeParse(rest);
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

/** A clip on a scene that is not there would show nothing, and nothing would say why. */
function checkScene(state: Draft["state"], { source }: { readonly source: ClipSource }): void {
  if (source.kind !== "scene" || source.scene === undefined) return;
  const scene = source.scene as string;
  if (!entryOf(state.scenes, scene)) fail("not-found", `没有这个场景：${scene}`);
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
    const clip = editableClip(target, owner.clip);
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
        draft.set(where, value);
      }
    }
  }
}

const ClipFields = Clip.omit({ id: true });
const ClipInput = ClipFields.extend({ id: Id.optional() });
const ClearableField = z.enum([
  "name",
  "offset",
  "loop",
  "fadeIn",
  "fadeOut",
  "hidden",
  "draft",
  "link",
  "sectionFit",
]);

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

  define("asset.remove", z.strictObject({ asset: Id }), (draft, { asset }) => {
    if (!entryOf(draft.state.assets, asset)) fail("not-found", `没有这个素材：${asset}`);
    if (isInUse(draft.state, ["assets", asset])) {
      fail("asset-in-use", "还有片段或版本在用这个素材，要先换掉或删除它们");
    }
    const code = codeUsingAsset(draft.state, asset);
    if (code !== undefined) fail("asset-in-use", `代码在用这个素材，要先改掉：${code}`);
    draft.delete(["assets", asset]);
  }),

  define("scene.add", SceneAdd, addScene),
  define("scene.update", SceneUpdate, updateScene),
  define("scene.remove", SceneRemove, removeScene),
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
    editableTrack(target, track);
    for (const clip of Object.values(target.clips)) {
      if (clip.track === track) draft.delete(clipPath(timeline, clip.id));
    }
    for (const transition of Object.values(target.transitions)) {
      if (transition.track === track) {
        draft.delete([...timelinePath(timeline), "transitions", transition.id]);
      }
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
      checkFits(editableTrack(target, track), clip);
      checkScene(draft.state, clip);
      const id = clip.id ?? newId("clip");
      if (entryOf(target.clips, id)) fail("id-taken", `这个 ID 已经有片段了：${id}`);
      for (const [path, value] of Object.entries(clip.properties ?? {})) checkKeys(path, value);
      const added = { ...clip, id, track };
      makeRoom(draft, timeline, track, [spanOf(added)], new Set(), overlap);
      draft.set(clipPath(timeline, id), added);
      extendToFit(draft, timeline, clipEnd(added));
      if (movedFrom !== undefined) {
        if (!draft.wentAway(clipPath(timeline, movedFrom))) {
          fail("not-moved", `这一批改动没有移走这个片段：${movedFrom}`);
        }
        draft.note({ kind: "moved", from: movedFrom, to: id });
      }
      return { id };
    },
    { userOnlyParams: ["movedFrom"] },
  ),

  define(
    "clip.remove",
    z.strictObject({ timeline: Id, clips: z.array(Id).min(1) }),
    (draft, { timeline, clips }) => {
      const target = timelineOf(draft, timeline);
      for (const id of clips) editableClip(target, id);
      removeClips(draft, timeline, clips);
    },
  ),

  define(
    "clip.update",
    z.strictObject({
      timeline: Id,
      clip: Id,
      changes: ClipFields.omit({ properties: true, effects: true }).partial(),
      clear: z.array(ClearableField).optional(),
    }),
    (draft, { timeline, clip, changes, clear }) => {
      const target = timelineOf(draft, timeline);
      const current = editableClip(target, clip);
      const next: Record<string, unknown> = { ...current, ...changes };
      for (const field of clear ?? []) delete next[field];
      checkClip(next as ClipState);
      const home = entryOf(target.tracks, current.track);
      if (home) checkFits(home, next as ClipState);
      if (changes.source) checkScene(draft.state, next as ClipState);
      const updated = next as ClipState;
      // Clips can overlap after a merge, and that should not stop people from renaming one.
      const moves = changes.start !== undefined || changes.duration !== undefined;
      if (moves) assertFree(target, current.track, [spanOf(updated)], new Set([clip]));
      draft.replace(clipPath(timeline, clip), next);
      if (moves) extendToFit(draft, timeline, clipEnd(updated));
    },
  ),

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
        const current = editableClip(target, clip);
        if (track !== undefined) checkFits(editableTrack(target, track), current);
        const moved = { ...current, start: start ?? current.start, track: track ?? current.track };
        return { moved, span: spanOf(moved) };
      });

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
    },
  ),

  /** Moves the edges of a clip, which is different from changing its numbers: see trimClip. */
  define(
    "clip.trim",
    z.strictObject({ timeline: Id, clip: Id, start: Time.optional(), end: Time.optional() }),
    (draft, { timeline, clip, start, end }) => {
      const target = timelineOf(draft, timeline);
      const current = editableClip(target, clip);
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
      trimClip(draft, timeline, current, span);
      extendToFit(draft, timeline, span.to);
    },
  ),

  /**
   * Cuts a clip in two at a moment on the timeline. Clips linked to it are cut along with it, and
   * the parts after the cut get a link of their own: otherwise all four would move as one.
   */
  define(
    "clip.split",
    z.strictObject({ timeline: Id, clip: Id, at: Time, id: Id.optional() }),
    (draft, { timeline, clip, at, id }) => {
      const target = timelineOf(draft, timeline);
      const current = editableClip(target, clip);
      const moment = parseTime(at);
      const isInside = (candidate: ClipState) =>
        compare(moment, clipStart(candidate)) > 0 && compare(moment, clipEnd(candidate)) < 0;
      if (!isInside(current)) fail("invalid-value", "切割点要在片段中间");
      const rightId = id ?? newId("clip");
      if (entryOf(target.clips, rightId)) fail("id-taken", `这个 ID 已经有片段了：${rightId}`);

      // A locked track stays as it is, so a partner there is left whole and keeps its link.
      const cut = Object.values(target.clips).filter(
        (other) =>
          current.link &&
          other.id !== clip &&
          other.link === current.link &&
          isInside(other) &&
          entryOf(target.tracks, other.track)?.locked !== true,
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
