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
  Clip,
  Timeline,
  TimelineOutline,
  ZERO,
  add,
  fromSeconds,
  downloadableFrom,
  isAnimation,
  isSameHash,
  parseTime,
  type Asset,
  type Elsewhere,
  type Join,
  type MediaRef,
  type Problem,
  type Project,
  type Rational,
  type TimelineFiles,
  type Track,
  type Value,
} from "@animaquill/schema";
import type { z } from "zod";
import type { Place } from "./places.ts";

type Note = Notes["notes"][number];
type Section = Timeline["sections"][number];
type Marker = NonNullable<Timeline["markers"]>[number];

/** A section in the live model. Sections have an order, a map of them does not. */
export type SectionState = Section & { readonly order: number };

type OmitFromEach<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** A track without its content. Clips and joins point at their track instead. */
export type TrackState = OmitFromEach<Track, "clips" | "joins"> & { readonly order: number };

/**
 * An effect of a clip in the live model, by its id. Its fields sit flat in the clip (see
 * structure.ts), and two people at once can leave one without a type: that is no effect, and it
 * stays out of the files until it is whole again. What it takes are properties of the clip.
 */
export interface EffectState {
  readonly type?: string;
  readonly enabled?: boolean;
  /** Effects have an order, a map of them does not. */
  readonly order?: number;
  /** When it works, from the start of the clip, see the project format. Each is a field of its own. */
  readonly start?: string;
  readonly end?: string;
}

/** An effect as files have it. */
export type ClipEffect = NonNullable<Clip["effects"]>[number];

/**
 * A clip in the live model. Clips sit next to each other and name their track, so moving a clip to
 * another track changes one field, and someone changing it at the same time loses nothing. Its
 * effects are by id, see `EffectState`.
 */
export type ClipState = Omit<Clip, "effects"> & {
  readonly track: string;
  readonly effects?: Readonly<Record<string, EffectState>>;
};

const NO_EFFECTS: readonly ClipEffect[] = [];
const listed = new WeakMap<object, readonly ClipEffect[]>();

/**
 * The effects of a clip in the order they work, as files have them: only whole ones. Clips that do
 * not change keep their list.
 */
export function effectsOf(clip: Pick<ClipState, "effects">): readonly ClipEffect[] {
  const { effects } = clip;
  if (!effects) return NO_EFFECTS;
  const known = listed.get(effects);
  if (known) return known;
  const list = Object.entries(effects)
    .filter(([, effect]) => typeof effect.type === "string")
    .toSorted(
      ([a, first], [b, second]) =>
        (first.order ?? 0) - (second.order ?? 0) || (a < b ? -1 : a > b ? 1 : 0),
    )
    .map(([id, { type, enabled, start, end }]): ClipEffect => ({
      id,
      type: type as string,
      ...(enabled === undefined ? {} : { enabled }),
      ...(typeof start === "string" ? { start } : {}),
      ...(typeof end === "string" ? { end } : {}),
    }));
  listed.set(effects, list);
  return list;
}

/** Effects as files have them, by id, in their order, the way the live model keeps them. */
export function effectStates(
  effects: readonly ClipEffect[] | undefined,
): Readonly<Record<string, EffectState>> | undefined {
  if (!effects || effects.length === 0) return undefined;
  return Object.fromEntries(
    effects.map(({ id, type, enabled, start, end }, order) => [
      id,
      {
        type,
        ...(enabled === undefined ? {} : { enabled }),
        order,
        ...(start === undefined ? {} : { start }),
        ...(end === undefined ? {} : { end }),
      },
    ]),
  );
}

/** A clip as files have it, apart from its track. */
export function clipFileOf(clip: Omit<ClipState, "track"> & { readonly track?: string }): Clip {
  const { track: _track, effects: _effects, ...rest } = clip;
  const effects = effectsOf(clip);
  return { ...rest, ...(effects.length > 0 ? { effects: [...effects] } : {}) } as Clip;
}

/** A clip of a file in the live model, on a track. */
export function clipStateOf(clip: Clip, track: string): ClipState {
  const { effects, ...rest } = clip;
  const states = effectStates(effects);
  return { ...rest, track, ...(states ? { effects: states } : {}) };
}

/**
 * What a join is, apart from where it is: which transition, how long, how it goes, and where around
 * the cut. One value, so that two people who each pick another one at the same time never end up
 * with half of each, such as a `type` and a `library`.
 */
export type JoinTransition = Omit<Join, "id" | "from" | "to">;

/**
 * A join in the live model, by its id. Its track and its sides are fields of their own, like those
 * of a clip, so that cutting a clip and changing the join at the same time both stay. They sit flat
 * in their timeline (see structure.ts), and two people at once can leave a join with only some of
 * them: that is no join, and it stays out of the files until it is whole again.
 */
export interface JoinState {
  readonly track?: string;
  readonly from?: string;
  readonly to?: string;
  readonly transition?: JoinTransition;
}

export interface TimelineState {
  readonly name: string;
  readonly background?: string;
  readonly beatGrid?: Timeline["beatGrid"];
  readonly mix?: Timeline["mix"];
  readonly sections: Readonly<Record<string, SectionState>>;
  readonly tracks: Readonly<Record<string, TrackState>>;
  readonly clips: Readonly<Record<string, ClipState>>;
  /** Not there without any. */
  readonly joins?: Readonly<Record<string, JoinState>>;
  readonly markers: Readonly<Record<string, Marker>>;
  readonly overrides: Readonly<Record<string, Overrides>>;
}

/**
 * A project while it is being worked on. It has the same shape as the Yjs document, which is what
 * makes a change easy to apply to both. Files are the other shape: conversions are below.
 */
export interface ProjectState {
  readonly manifest: ProjectManifest;
  /**
   * What each asset says itself. Where its file is kept can be in `places` as well, which counts
   * for as long as the asset has the content that was written down for: read the asset with
   * `placedAsset`, as files have it, to know where its file is.
   */
  readonly assets?: Assets["assets"];
  /** Where the file of an asset is kept, by the id of the asset, see structure.ts. */
  readonly places?: Readonly<Record<string, Place>>;
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

/** Something by its id. An id can be anything, also a name that every object has. */
export const entryOf = <T>(
  map: Readonly<Record<string, T>> | undefined,
  id: string,
): T | undefined => (map && Object.hasOwn(map, id) ? map[id] : undefined);

/**
 * Where the project is, as far as places go: what a place has to be bound to, to count here. The
 * repository the project is kept in, by its id on GitHub; who is signed in to the platform, by the
 * id of the person there; and the storages of the person set up on this computer. Where nobody says
 * where here is (undefined), every place counts as it is; where something is not known here, the
 * places bound to it do not count: a copy of the project in another repository, somebody else, or a
 * computer without that storage cannot get the file from there.
 */
export interface Here {
  readonly repo?: string | undefined;
  readonly owner?: string | undefined;
  readonly stores?: readonly string[] | undefined;
}

/** Whether a place counts here, see `Here`. */
export function isBoundHere(place: Place, here: Here | undefined): boolean {
  if (here === undefined) return true;
  switch (place.storage) {
    case "lfs":
      return place.repo !== undefined && place.repo === here.repo;
    case "platform":
      return place.owner !== undefined && place.owner === here.owner;
    case "remote":
      return place.store === undefined || (here.stores ?? []).includes(place.store);
    default:
      return true;
  }
}

/**
 * An asset as files have it: where its file is kept is what its place says, while that is about
 * the file the asset has, the same content of the same size, and counts here, see `Here`. A place
 * that knows the size of a file says it for an asset that does not. A place that would leave the
 * asset without what another computer needs to get the file, see `downloadableFrom`, says nothing.
 * The same object where the place says nothing else.
 */
export function withPlace(asset: Asset, place: Place | undefined, here?: Here): Asset {
  if (!place || asset.hash === undefined || !isSameHash(place.hash, asset.hash)) return asset;
  if (place.size !== undefined && asset.size !== undefined && place.size !== asset.size) {
    return asset;
  }
  if (!isBoundHere(place, here)) return asset;
  const size = asset.size ?? place.size;
  if (place.storage === asset.storage && place.url === asset.url && size === asset.size) {
    return asset;
  }
  const { url: _url, size: _size, ...rest } = asset;
  const placed: Asset = {
    ...rest,
    storage: place.storage,
    ...(place.url !== undefined && { url: place.url }),
    ...(size !== undefined && { size }),
  };
  if (place.storage !== "local" && downloadableFrom(placed) === undefined) return asset;
  return placed;
}

/** An asset of a project as files have it, see `withPlace`. */
export const placedAsset = (
  state: Pick<ProjectState, "assets" | "places">,
  id: string,
  here?: Here,
): Asset | undefined => {
  const asset = entryOf(state.assets, id);
  return asset && withPlace(asset, entryOf(state.places, id), here);
};

/**
 * Where else than here the file of an asset can be downloaded from, see `downloadableFrom`, for this
 * computer to get it where it does not have the file: undefined for a file that is only here, in
 * the person's own Git, or that nothing could check.
 */
export function elsewhereOf(
  state: Pick<ProjectState, "assets" | "places">,
  id: string,
  here?: Here,
): Elsewhere | undefined {
  const asset = placedAsset(state, id, here);
  return asset && downloadableFrom(asset);
}

const placedBy = new WeakMap<
  object,
  {
    readonly places: object;
    readonly here: Here | undefined;
    readonly assets: Assets["assets"];
  }
>();

/**
 * All assets of a project as files have them, see `withPlace`. The same object as long as the
 * assets, their places and here are, and the assets themselves where no place says anything else.
 */
export function placedAssets(
  state: Pick<ProjectState, "assets" | "places">,
  here?: Here,
): Assets["assets"] | undefined {
  const { assets, places } = state;
  if (!assets || !places) return assets;
  const known = placedBy.get(assets);
  if (known?.places === places && known.here === here) return known.assets;
  let changed = false;
  const placed: Record<string, Asset> = {};
  for (const [id, asset] of Object.entries(assets)) {
    const each = withPlace(asset, entryOf(places, id), here);
    changed ||= each !== asset;
    placed[id] = each;
  }
  const result = changed ? placed : assets;
  placedBy.set(assets, { places, here, assets: result });
  return result;
}

const byId = <T extends { readonly id: string }>(items: readonly T[] | undefined) =>
  Object.fromEntries((items ?? []).map((item) => [item.id, item]));

export function timelineToState(
  timeline: Timeline,
  overrides: ReadonlyMap<string, Overrides>,
): TimelineState {
  const tracks: Record<string, TrackState> = {};
  const clips: Record<string, ClipState> = {};
  const joins: Record<string, JoinState> = {};
  timeline.tracks.forEach((track, order) => {
    const { clips: trackClips, ...rest } = track;
    const { joins: trackJoins, ...head } = rest as typeof rest & { joins?: readonly Join[] };
    tracks[track.id] = { ...head, order };
    for (const clip of trackClips) clips[clip.id] = clipStateOf(clip, track.id);
    for (const { id, from, to, ...transition } of trackJoins ?? []) {
      joins[id] = { track: track.id, from, to, transition };
    }
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
    ...(Object.keys(joins).length > 0 ? { joins } : {}),
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

/** What the ruler of a project counts. Formats can be exported at a rate of their own. */
export const projectFrameRate = ({ fps, formats }: ProjectManifest): string =>
  fps ?? formats[0]?.fps ?? "30";

/** Exact times of a clip, for calculations. */
export const clipStart = (clip: ClipState): Rational => parseTime(clip.start);
export const clipEnd = (clip: ClipState): Rational =>
  add(parseTime(clip.start), parseTime(clip.duration));
export const clipOffset = (clip: ClipState): Rational =>
  clip.offset === undefined ? ZERO : parseTime(clip.offset);

/** A parameter of a sound: what the clip says, or else what the sound starts out with. */
export function paramOf(
  clip: ClipState,
  manifest: SoundManifest | undefined,
  id: string,
): Value | undefined {
  const value = entryOf(clip.properties, `param.${id}`);
  // Keys on what makes a sound would have to make it again for every moment.
  const plain = value !== undefined && isAnimation(value) ? value.keys[0]?.value : value;
  return plain ?? manifest?.params?.find((param) => param.id === id)?.default;
}

/**
 * How long a sound made by code is, in seconds, when something says so. That has to come from
 * somewhere else than the length of the clip: trimming and cutting show less of a sound, and do not
 * make another one.
 */
export function statedSoundLength(state: ProjectState, clip: ClipState): number | undefined {
  const { sound } = clip.source as { readonly sound?: string };
  const manifest = sound === undefined ? undefined : entryOf(state.sounds, sound);
  const value = paramOf(clip, manifest, "duration");
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * How far the clock of a clip can run before its content ends. Undefined when nothing stops it:
 * a loop, a changing speed, or content of no known length.
 */
export function sourceLength(state: ProjectState, clip: ClipState): Rational | undefined {
  const { source } = clip;
  if (clip.loop || clip.properties?.["time.speed"] !== undefined) return undefined;
  if (source.kind === "sound") {
    const seconds = statedSoundLength(state, clip);
    return seconds === undefined ? undefined : fromSeconds(seconds);
  }
  if (source.kind !== "video" && source.kind !== "audio") return undefined;
  const media = source.media as MediaRef;
  const duration =
    "asset" in media ? entryOf(state.assets, media.asset)?.info?.duration : undefined;
  return duration === undefined ? undefined : parseTime(duration);
}

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
export function stateToTimeline(state: TimelineState, whole = true): unknown {
  const tracks = orderedTracks(state).map((head) => {
    const { order: _order, ...track } = head;
    return { ...track, clips: [] as Clip[], joins: [] as Join[] };
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
        joins: [],
      } as unknown as (typeof tracks)[number];
      tracks.push(track);
    }
    // Only what `TimelineOutline` looks at, where the clips are checked on their own.
    track.clips.push(whole ? clipFileOf(clip) : ({ id: clip.id, source: clip.source } as Clip));
  }
  for (const [id, { track: owner, from, to, transition }] of Object.entries(state.joins ?? {})) {
    // Only some of a join is no join. A join on a track that is gone has nowhere to be.
    if (owner === undefined || from === undefined || to === undefined || !transition) continue;
    find(owner)?.joins.push({ id, from, to, ...transition });
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
    tracks: tracks.map(({ joins, ...track }) =>
      track.kind === "caption" || joins.length === 0 ? track : { ...track, joins },
    ),
    ...(mix === undefined ? {} : { mix }),
  };
}

/** The scope that the name of a version stands for, see `override-misnamed`. */
function scopeNamed(name: string): Overrides["scope"] | undefined {
  const [kind, first, second, ...rest] = name.split(".");
  if (!first || rest.length > 0) return undefined;
  if (kind === "language" && second === undefined) return { language: first };
  if (kind === "format" && second === undefined) return { format: first };
  return kind === "version" && second ? { language: first, format: second } : undefined;
}

/**
 * What a version changes sits in the document one value at a time, and so does its scope. Two
 * people at once can leave a version without one: one takes a change back, the other has just made
 * one there. Its name says the same, so the version keeps its place in the files.
 */
function withScope(name: string, version: Overrides): Overrides {
  if ((version as { readonly scope?: unknown }).scope !== undefined) return version;
  const scope = scopeNamed(name);
  return scope ? { ...version, scope } : version;
}

export interface ExportedProject {
  readonly project: Project;
  /** Documents that are not valid any more stay out, so that the last good file survives. */
  readonly problems: readonly Problem[];
}

/** The project as files have it, with where the files of its assets are as counts `here`. */
export function stateToProject(state: ProjectState, here?: Here): ExportedProject {
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
      Object.entries(timeline.overrides).map(([name, version]) => [name, withScope(name, version)]),
      (name) => `timelines/${id}/overrides/${name}.json`,
      Overrides,
    );
    timelines.set(id, { ...(document ? { document } : {}), overrides });
  }

  const notes = state.notes && { notes: Object.values(state.notes) };
  const manifest = check("animaquill.json", ProjectManifest, state.manifest) ?? state.manifest;

  const project: Project = {
    manifest,
    ...optional(
      "assets",
      state.assets && check("assets.json", Assets, { assets: placedAssets(state, here) }),
    ),
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

/**
 * One document of a project, as a path into the state finds it: the file it is written to, and
 * whether it can be written, by the same checks as `stateToProject`. Code files have no format of
 * their own, so they are none.
 */
export interface StateDocument {
  readonly file: string;
  /** What the format finds wrong with it, or undefined when it is valid or not there. */
  readonly issue: (
    state: ProjectState,
  ) => { readonly path: string; readonly message: string } | undefined;
}

type DocumentIssue = { readonly path: string; readonly message: string };

const issueOf = (schema: z.ZodType, value: unknown): DocumentIssue | undefined => {
  if (value === undefined) return undefined;
  const result = schema.safeParse(value);
  if (result.success) return undefined;
  const issue = result.error.issues[0];
  return { path: issue?.path.map(String).join(".") ?? "", message: issue?.message ?? "" };
};

/**
 * What the format finds wrong with a clip on its own, by the clip: a clip that did not change is the
 * same object in the next state, so a large timeline is checked again by what changed of it.
 */
const clipIssues = new WeakMap<ClipState, DocumentIssue | null>();

function clipIssue(clip: ClipState): DocumentIssue | undefined {
  const known = clipIssues.get(clip);
  if (known !== undefined) return known ?? undefined;
  const issue = issueOf(Clip, clipFileOf(clip));
  clipIssues.set(clip, issue ?? null);
  return issue;
}

/**
 * What the format finds wrong with a timeline, as `Timeline` would: each clip on its own, and the
 * rest with `TimelineOutline`, which is the same rules without what clips are on their own.
 */
function timelineIssue(timeline: TimelineState): DocumentIssue | undefined {
  for (const clip of Object.values(timeline.clips)) {
    const issue = clipIssue(clip);
    if (issue)
      return {
        path: `clips.${clip.id}${issue.path ? `.${issue.path}` : ""}`,
        message: issue.message,
      };
  }
  return issueOf(TimelineOutline, stateToTimeline(timeline, false));
}

/** The document that a path into the state is part of, see `StateDocument`. */
export function documentAt(path: readonly string[]): StateDocument | undefined {
  const [top, id, level, version] = path;
  const of = (file: string, schema: z.ZodType, value: (state: ProjectState) => unknown) => ({
    file,
    issue: (state: ProjectState) => issueOf(schema, value(state)),
  });
  switch (top) {
    case "manifest":
      return of("animaquill.json", ProjectManifest, (state) => state.manifest);
    case "assets":
    case "places":
      return of("assets.json", Assets, (state) =>
        state.assets === undefined ? undefined : { assets: placedAssets(state) },
      );
    case "libraries":
      return of("libraries.json", Libraries, (state) => state.libraries);
    case "lock":
      return of("libraries.lock.json", LibrariesLock, (state) => state.lock);
    case "notes":
      return of("notes.json", Notes, (state) =>
        state.notes === undefined ? undefined : { notes: Object.values(state.notes) },
      );
    case "scenes":
      if (id === undefined) return undefined;
      return of(`scenes/${id}/scene.json`, SceneManifest, (state) => entryOf(state.scenes, id));
    case "sounds":
      if (id === undefined) return undefined;
      return of(`sounds/${id}/sound.json`, SoundManifest, (state) => entryOf(state.sounds, id));
    case "locales":
      if (id === undefined) return undefined;
      return of(`locales/${id}.json`, Locale, (state) => {
        const strings = entryOf(state.locales, id);
        return strings === undefined ? undefined : { strings };
      });
    case "timelines": {
      if (id === undefined) return undefined;
      if (level === "overrides" && version !== undefined) {
        return of(`timelines/${id}/overrides/${version}.json`, Overrides, (state) => {
          const override = entryOf(entryOf(state.timelines, id)?.overrides, version);
          return override === undefined ? undefined : withScope(version, override);
        });
      }
      return {
        file: `timelines/${id}/timeline.json`,
        issue: (state: ProjectState) => {
          const timeline = entryOf(state.timelines, id);
          return timeline === undefined ? undefined : timelineIssue(timeline);
        },
      };
    }
    default:
      return undefined;
  }
}
