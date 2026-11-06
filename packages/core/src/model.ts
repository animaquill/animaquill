import {
  Assets,
  Libraries,
  LibrariesLock,
  Locale,
  Notes,
  Overrides,
  ProjectManifest,
  SceneManifest,
  SoundManifest,
  Timeline,
  ZERO,
  add,
  parseTime,
  type Clip,
  type Problem,
  type Project,
  type Rational,
  type TimelineFiles,
  type Track,
} from "@animaquill/schema";
import type { z } from "zod";

type Note = Notes["notes"][number];
type Section = Timeline["sections"][number];
type Marker = NonNullable<Timeline["markers"]>[number];
type Transition = NonNullable<Extract<Track, { kind: "video" }>["transitions"]>[number];

/** A section in the live model. Sections have an order, a map of them does not. */
export type SectionState = Section & { readonly order: number };

type OmitFromEach<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** A track without its content. Clips point at their track instead. */
export type TrackState = OmitFromEach<Track, "clips" | "transitions"> & { readonly order: number };

/**
 * A clip in the live model. Clips sit next to each other and name their track, so moving a clip to
 * another track changes one field, and someone changing it at the same time loses nothing.
 */
export type ClipState = Clip & { readonly track: string };

export type TransitionState = Transition & { readonly track: string };

export interface TimelineState {
  readonly name: string;
  readonly background?: string;
  readonly beatGrid?: Timeline["beatGrid"];
  readonly mix?: Timeline["mix"];
  readonly sections: Readonly<Record<string, SectionState>>;
  readonly tracks: Readonly<Record<string, TrackState>>;
  readonly clips: Readonly<Record<string, ClipState>>;
  readonly transitions: Readonly<Record<string, TransitionState>>;
  readonly markers: Readonly<Record<string, Marker>>;
  readonly overrides: Readonly<Record<string, Overrides>>;
}

/**
 * A project while it is being worked on. It has the same shape as the Yjs document, which is what
 * makes a change easy to apply to both. Files are the other shape: conversions are below.
 */
export interface ProjectState {
  readonly manifest: ProjectManifest;
  readonly assets?: Assets["assets"];
  readonly libraries?: Libraries;
  readonly lock?: LibrariesLock;
  readonly notes?: Readonly<Record<string, Note>>;
  readonly scenes: Readonly<Record<string, SceneManifest>>;
  readonly sounds: Readonly<Record<string, SoundManifest>>;
  readonly locales: Readonly<Record<string, Locale["strings"]>>;
  readonly timelines: Readonly<Record<string, TimelineState>>;
  /** The text of scene, sound and shared code files, by path. */
  readonly files: Readonly<Record<string, string>>;
}

const byId = <T extends { readonly id: string }>(items: readonly T[] | undefined) =>
  Object.fromEntries((items ?? []).map((item) => [item.id, item]));

export function timelineToState(
  timeline: Timeline,
  overrides: ReadonlyMap<string, Overrides>,
): TimelineState {
  const tracks: Record<string, TrackState> = {};
  const clips: Record<string, ClipState> = {};
  const transitions: Record<string, TransitionState> = {};
  timeline.tracks.forEach((track, order) => {
    const { clips: trackClips, ...rest } = track;
    const { transitions: links, ...head } = rest as typeof rest & {
      transitions?: readonly Transition[];
    };
    tracks[track.id] = { ...head, order };
    for (const clip of trackClips) clips[clip.id] = { ...clip, track: track.id };
    for (const link of links ?? []) transitions[link.id] = { ...link, track: track.id };
  });
  const { name, background, beatGrid, mix } = timeline;
  return {
    name,
    ...(background === undefined ? {} : { background }),
    ...(beatGrid === undefined ? {} : { beatGrid }),
    ...(mix === undefined ? {} : { mix }),
    sections: Object.fromEntries(
      timeline.sections.map((section, order) => [section.id, { ...section, order }]),
    ),
    tracks,
    clips,
    transitions,
    markers: byId(timeline.markers),
    overrides: Object.fromEntries(overrides),
  };
}

export function projectToState(
  project: Project,
  files: Readonly<Record<string, string>> = {},
): ProjectState {
  const { manifest, assets, libraries, lock, notes } = project;
  return {
    manifest,
    ...(assets ? { assets: assets.assets } : {}),
    ...(libraries ? { libraries } : {}),
    ...(lock ? { lock } : {}),
    ...(notes ? { notes: byId(notes.notes) } : {}),
    scenes: Object.fromEntries(project.scenes),
    sounds: Object.fromEntries(project.sounds),
    locales: Object.fromEntries(
      [...project.locales].map(([language, locale]) => [language, locale.strings]),
    ),
    timelines: Object.fromEntries(
      [...project.timelines].flatMap(([id, timeline]) =>
        timeline.document ? [[id, timelineToState(timeline.document, timeline.overrides)]] : [],
      ),
    ),
    files,
  };
}

const inOrder = <T extends { readonly id: string; readonly order: number }>(
  items: Readonly<Record<string, T>>,
) => Object.values(items).toSorted((a, b) => a.order - b.order || a.id.localeCompare(b.id));

/** Tracks and sections in the order people see them. */
export const orderedTracks = (timeline: TimelineState) => inOrder(timeline.tracks);
export const orderedSections = (timeline: TimelineState) => inOrder(timeline.sections);

/** Exact times of a clip, for calculations. */
export const clipStart = (clip: ClipState): Rational => parseTime(clip.start);
export const clipEnd = (clip: ClipState): Rational =>
  add(parseTime(clip.start), parseTime(clip.duration));
export const clipOffset = (clip: ClipState): Rational =>
  clip.offset === undefined ? ZERO : parseTime(clip.offset);

/** Sections end to end make up the length of a timeline, which is kept nowhere else. */
export const timelineLength = (timeline: TimelineState): Rational =>
  Object.values(timeline.sections).reduce(
    (length, section) => add(length, parseTime(section.duration)),
    ZERO,
  );

const KINDS_OF_TRACK: Readonly<Record<string, string>> = {
  audio: "audio",
  sound: "audio",
  music: "audio",
  caption: "caption",
};

/** The kind of track a clip belongs on. */
export const trackKindFor = (clip: ClipState): Track["kind"] =>
  (KINDS_OF_TRACK[clip.source.kind] as Track["kind"] | undefined) ?? "video";

const FALLBACK_SECTION = { id: "section-recovered", duration: "1" };

/**
 * Back to the shape of the files. Two people working at once can leave things behind that nobody
 * asked for, such as a clip on a track someone else deleted. Those are placed somewhere instead of
 * being lost.
 */
export function stateToTimeline(state: TimelineState): unknown {
  const tracks = orderedTracks(state).map((head) => {
    const { order: _order, ...track } = head;
    return { ...track, clips: [] as ClipState[], transitions: [] as TransitionState[] };
  });
  const find = (id: string) => tracks.find((track) => track.id === id);

  for (const clip of Object.values(state.clips)) {
    const kind = trackKindFor(clip);
    let track = find(clip.track) ?? tracks.find((candidate) => candidate.kind === kind);
    if (!track) {
      track = {
        id: `recovered-${kind}`,
        kind,
        clips: [],
        transitions: [],
      } as unknown as (typeof tracks)[number];
      tracks.push(track);
    }
    const { track: _track, ...rest } = clip;
    track.clips.push(rest as ClipState);
  }
  for (const transition of Object.values(state.transitions)) {
    const { track: owner, ...rest } = transition;
    // Two people can each remove the clip on one side. Nothing is left to go from or to.
    if (rest.from === undefined && rest.to === undefined) continue;
    find(owner)?.transitions.push(rest as TransitionState);
  }

  const sections = orderedSections(state).map(({ order: _order, ...section }) => section);
  const markers = Object.values(state.markers);
  const { name, background, beatGrid, mix } = state;
  return {
    name,
    ...(background === undefined ? {} : { background }),
    sections: sections.length > 0 ? sections : [FALLBACK_SECTION],
    ...(markers.length > 0 ? { markers } : {}),
    ...(beatGrid === undefined ? {} : { beatGrid }),
    tracks: tracks.map(({ transitions, ...track }) =>
      track.kind === "caption" || transitions.length === 0 ? track : { ...track, transitions },
    ),
    ...(mix === undefined ? {} : { mix }),
  };
}

export interface ExportedProject {
  readonly project: Project;
  /** Documents that are not valid any more stay out, so that the last good file survives. */
  readonly problems: readonly Problem[];
}

export function stateToProject(state: ProjectState): ExportedProject {
  const problems: Problem[] = [];
  const check = <T>(file: string, schema: z.ZodType<T>, value: unknown): T | undefined => {
    const result = schema.safeParse(value);
    if (result.success) return result.data;
    for (const issue of result.error.issues) {
      problems.push({
        severity: "error",
        code: "invalid-state",
        file,
        path: issue.path.join("."),
        message: issue.message,
      });
    }
    return undefined;
  };
  const optional = <K extends string, T>(key: K, value: T | undefined) =>
    (value === undefined ? {} : { [key]: value }) as { [P in K]?: T };

  const validMap = <T>(
    entries: readonly (readonly [string, unknown])[],
    fileOf: (id: string) => string,
    schema: z.ZodType<T>,
  ) => {
    const result = new Map<string, T>();
    for (const [id, value] of entries) {
      const checked = check(fileOf(id), schema, value);
      if (checked) result.set(id, checked);
    }
    return result;
  };

  const timelines = new Map<string, TimelineFiles>();
  for (const [id, timeline] of Object.entries(state.timelines)) {
    const document = check(`timelines/${id}/timeline.json`, Timeline, stateToTimeline(timeline));
    const overrides = validMap(
      Object.entries(timeline.overrides),
      (name) => `timelines/${id}/overrides/${name}.json`,
      Overrides,
    );
    timelines.set(id, { ...(document ? { document } : {}), overrides });
  }

  const notes = state.notes && { notes: Object.values(state.notes) };
  const manifest = check("animaquill.json", ProjectManifest, state.manifest) ?? state.manifest;

  const project: Project = {
    manifest,
    ...optional("assets", state.assets && check("assets.json", Assets, { assets: state.assets })),
    ...optional(
      "libraries",
      state.libraries && check("libraries.json", Libraries, state.libraries),
    ),
    ...optional("lock", state.lock && check("libraries.lock.json", LibrariesLock, state.lock)),
    ...optional("notes", notes && check("notes.json", Notes, notes)),
    timelines,
    scenes: validMap(
      Object.entries(state.scenes),
      (id) => `scenes/${id}/scene.json`,
      SceneManifest,
    ),
    sounds: validMap(
      Object.entries(state.sounds),
      (id) => `sounds/${id}/sound.json`,
      SoundManifest,
    ),
    locales: validMap(
      Object.entries(state.locales).map(([id, strings]) => [id, { strings }] as const),
      (id) => `locales/${id}.json`,
      Locale,
    ),
  };
  return { project, problems };
}
