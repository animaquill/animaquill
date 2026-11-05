import {
  Clip,
  ClipSource,
  Duration,
  Id,
  Marker,
  ProjectManifest,
  PropertyValue,
  Time,
  Track,
  canHold,
  newId,
} from "@animaquill/schema";
import { z } from "zod";
import { CommandError, type Draft } from "./draft.ts";
import {
  orderedSections,
  orderedTracks,
  type ClipState,
  type TimelineState,
  type TrackState,
} from "./model.ts";

export interface CommandDefinition<P = unknown> {
  readonly type: string;
  readonly params: z.ZodType<P>;
  readonly run: (draft: Draft, params: P) => unknown;
  /** Can run on a project with a locked tag: the way to take the tag off again. */
  readonly whileLocked?: boolean;
  /** Only people can do this, never an AI task. */
  readonly userOnly?: boolean;
}

function define<S extends z.ZodType>(
  type: string,
  params: S,
  run: (draft: Draft, params: z.output<S>) => unknown,
  options: Pick<CommandDefinition, "whileLocked" | "userOnly"> = {},
): CommandDefinition {
  return { type, params, run: run as CommandDefinition["run"], ...options };
}

const fail = (code: string, message: string): never => {
  throw new CommandError(code, message);
};

const timelinePath = (timeline: string) => ["timelines", timeline];
const clipPath = (timeline: string, clip: string) => ["timelines", timeline, "clips", clip];
const trackPath = (timeline: string, track: string) => ["timelines", timeline, "tracks", track];

function timelineOf(draft: Draft, id: string): TimelineState {
  return draft.state.timelines[id] ?? fail("not-found", `没有这条时间轴：${id}`);
}

function trackOf(timeline: TimelineState, id: string): TrackState {
  return timeline.tracks[id] ?? fail("not-found", `没有这条轨道：${id}`);
}

/** A locked track protects its clips from everyone, also from AI tasks. */
function editableTrack(timeline: TimelineState, id: string): TrackState {
  const track = trackOf(timeline, id);
  if (track.locked) fail("track-locked", `轨道已锁定：${track.name ?? id}`);
  return track;
}

function editableClip(timeline: TimelineState, id: string): ClipState {
  const clip = timeline.clips[id] ?? fail("not-found", `没有这个片段：${id}`);
  editableTrack(timeline, clip.track);
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

  define(
    "project.setTags",
    z.strictObject({ tags: ProjectManifest.shape.tags.unwrap() }),
    (draft, { tags }) => {
      draft.set(["manifest", "tags"], tags);
    },
    { whileLocked: true, userOnly: true },
  ),

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
      if (target.sections[id]) fail("id-taken", `这个 ID 已经有段落了：${id}`);
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
      const target = timelineOf(draft, timeline).sections[section];
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
      if (!sections[section]) fail("not-found", `没有这个段落：${section}`);
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
      if (target.tracks[id]) fail("id-taken", `这个 ID 已经有轨道了：${id}`);
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
    z.strictObject({ timeline: Id, track: Id, clip: ClipInput }),
    (draft, { timeline, track, clip }) => {
      const target = timelineOf(draft, timeline);
      checkFits(editableTrack(target, track), clip);
      const id = clip.id ?? newId("clip");
      if (target.clips[id]) fail("id-taken", `这个 ID 已经有片段了：${id}`);
      draft.set(clipPath(timeline, id), { ...clip, id, track });
      return { id };
    },
  ),

  define(
    "clip.remove",
    z.strictObject({ timeline: Id, clips: z.array(Id).min(1) }),
    (draft, { timeline, clips }) => {
      const target = timelineOf(draft, timeline);
      for (const id of clips) editableClip(target, id);
      const removed = new Set(clips);
      for (const id of clips) draft.delete(clipPath(timeline, id));
      for (const transition of Object.values(target.transitions)) {
        const path = [...timelinePath(timeline), "transitions", transition.id];
        const from = transition.from && removed.has(transition.from);
        const to = transition.to && removed.has(transition.to);
        if (!from && !to) continue;
        const keepsSide = (!from && transition.from) || (!to && transition.to);
        if (!keepsSide) draft.delete(path);
        else draft.delete([...path, from ? "from" : "to"]);
      }
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
      checkFits(trackOf(target, current.track), next as ClipState);
      draft.replace(clipPath(timeline, clip), next);
    },
  ),

  define(
    "clip.move",
    z.strictObject({ timeline: Id, clip: Id, start: Time.optional(), track: Id.optional() }),
    (draft, { timeline, clip, start, track }) => {
      const target = timelineOf(draft, timeline);
      const current = editableClip(target, clip);
      if (track !== undefined) {
        checkFits(editableTrack(target, track), current);
        draft.set([...clipPath(timeline, clip), "track"], track);
      }
      if (start !== undefined) draft.set([...clipPath(timeline, clip), "start"], start);
    },
  ),

  define(
    "clip.setProperty",
    z.strictObject({ timeline: Id, clip: Id, path: z.string().min(1), value: PropertyValue }),
    (draft, { timeline, clip, path, value }) => {
      const current = editableClip(timelineOf(draft, timeline), clip);
      checkClip({ ...current, properties: { ...current.properties, [path]: value } });
      draft.set([...clipPath(timeline, clip), "properties", path], value);
    },
  ),

  define(
    "clip.clearProperty",
    z.strictObject({ timeline: Id, clip: Id, path: z.string().min(1) }),
    (draft, { timeline, clip, path }) => {
      editableClip(timelineOf(draft, timeline), clip);
      draft.delete([...clipPath(timeline, clip), "properties", path]);
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
      if (!timelineOf(draft, timeline).markers[marker]) {
        fail("not-found", `没有这个标记：${marker}`);
      }
      for (const [key, value] of Object.entries(changes)) {
        draft.set([...timelinePath(timeline), "markers", marker, key], value);
      }
    },
  ),

  define("marker.remove", z.strictObject({ timeline: Id, marker: Id }), (draft, params) => {
    const { timeline, marker } = params;
    if (!timelineOf(draft, timeline).markers[marker]) {
      fail("not-found", `没有这个标记：${marker}`);
    }
    draft.delete([...timelinePath(timeline), "markers", marker]);
  }),
];
