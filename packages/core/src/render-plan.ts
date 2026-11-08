import {
  CLIP_VISUAL,
  ZERO,
  add,
  divide,
  edgeLength,
  findTransition,
  isAnimation,
  isSupported,
  parseTime,
  placeJoins,
  rational,
  subtract,
  toSeconds,
  type Animation,
  type Asset,
  type JoinSides,
  type MediaRef,
  type PropertyValue,
  type Rational,
  type SpeedCurve,
  type TransitionMedia,
  type TransitionUse,
  type Value,
  type ValueType,
} from "@animaquill/schema";
import { compileChannel, type Channel, type Channels } from "./curve.ts";
import {
  clipEnd,
  clipOffset,
  clipStart,
  entryOf,
  orderedTracks,
  type ClipState,
  type JoinTransition,
  type TimelineState,
  type TrackState,
} from "./model.ts";
import type { ProjectState } from "./model.ts";
import { isSceneOwned } from "./registration.ts";
import { sceneSourceOf, type SceneSource } from "./scene-plan.ts";
import { madeSoundOf } from "./sound-plan.ts";
import { stageOf, type Size } from "./view.ts";

/** What a compositor draws from. It knows nothing about projects, versions or Yjs. */
export interface RenderPlan {
  /** Pixels of the picture. */
  readonly width: number;
  readonly height: number;
  /** How much of the world it shows, in world units. */
  readonly stage: Size;
  /** Empty, which is a camera that stands still, until cameras exist: see viewMatrix. */
  readonly camera: Channels;
  readonly background: string;
  /** What scenes get told about the version they are shown in. */
  readonly scenes: SceneContext;
  /** Back to front. */
  readonly layers: readonly RenderLayer[];
}

export interface SceneContext {
  readonly format: string;
  readonly language: string;
  /** Frames per second of the picture, as a fraction, so that 30000/1001 stays exact. */
  readonly fps: { readonly num: number; readonly den: number };
}

export type LayerSource =
  | { readonly kind: "color"; readonly color: string }
  | { readonly kind: "image"; readonly file: string }
  | { readonly kind: "video"; readonly file: string }
  | SceneSource;

/** What draws a transition. Only the built-in ones so far. */
export interface TransitionImplementation {
  readonly kind: "built-in";
  readonly type: string;
  readonly variant?: string;
}

/** A transition ready to be drawn: what draws it, and when. */
export interface PlannedTransition {
  readonly how: TransitionImplementation;
  /** Seconds on the timeline, already no longer than it fits. Its progress goes from 0 to 1 here. */
  readonly start: number;
  readonly end: number;
  /**
   * Seconds from the exact length, which is what progress goes by: `end − start` of two floats can
   * be a little off, and a fade has always been worked out from its exact length.
   */
  readonly duration: number;
  /** Without it the speed is even. */
  readonly curve?: SpeedCurve;
  /**
   * It stands in for a transition that this editor cannot do, as a fade. An export stops there, so
   * that no file says something else than the project.
   */
  readonly missing?: true;
}

export interface RenderLayer {
  readonly id: string;
  /** Seconds on the timeline. */
  readonly start: number;
  readonly end: number;
  /** What the clock of the clip reads at its start, which for a video is the time in the file. */
  readonly offset: number;
  readonly source: LayerSource;
  /** How the clip box comes about and how the media goes in it. See boxOf. */
  readonly fit: "contain" | "cover" | "fixed";
  /** From nothing to the clip at its start, and from the clip to nothing at its end. */
  readonly enter?: PlannedTransition;
  readonly exit?: PlannedTransition;
  /** What changes over time, on the clock of the clip: `transform.*` and `opacity`. */
  readonly channels: Channels;
  /**
   * What the content works out by itself, as the clip stores it: a scene gets its `param.*`,
   * `element.*` and `object.*`. Only the scene knows what types those are, see `describeClip`, so
   * they go as they are and it prepares them itself.
   */
  readonly content?: Readonly<Record<string, PropertyValue>>;
}

export interface SoundLayer {
  readonly id: string;
  /** The file, by its content. */
  readonly file: string;
  /** Seconds on the timeline. */
  readonly start: number;
  readonly end: number;
  /** The time in the file at the start of the clip. */
  readonly offset: number;
  /** 1 is the original volume. */
  readonly gain: number;
  /** Code makes this file, so it not being here yet is no problem, and it may be soon. */
  readonly made?: true;
}

/** What a timeline sounds like. */
export interface AudioPlan {
  readonly sounds: readonly SoundLayer[];
}

/** Which version of a timeline to look at. */
export interface Version {
  readonly format?: string;
}

type Properties = NonNullable<ClipState["properties"]>;
type AudioTrackState = Extract<TrackState, { kind: "audio" }>;

const NO_PROPERTIES: Properties = {};
const STILL_CAMERA: Channels = {};

/**
 * The properties of a clip in a version. Reading them from anywhere else would leave that place out
 * once versions change them, so this is the one way, and the place for the differences to come in.
 */
export const effectiveProperties = (clip: ClipState, _version?: Version): Properties =>
  clip.properties ?? NO_PROPERTIES;

/** A property as a plain number. Keys on sound come later, until then the first value. */
function numberOf(properties: ClipState["properties"], path: string, fallback: number): number {
  const value = properties?.[path];
  if (value === undefined) return fallback;
  const plain = isAnimation(value) ? value.keys[0]?.value : value;
  return typeof plain === "number" ? plain : fallback;
}

const compiled = new WeakMap<
  Animation,
  { readonly type: ValueType; readonly channel: Channel | undefined }
>();

/** Prepares a value to be read. Keys are the expensive part and only change by being replaced. */
export function channelOf(value: PropertyValue, type: ValueType): Channel | undefined {
  if (!isAnimation(value)) return compileChannel(value, type);
  const known = compiled.get(value);
  if (known?.type === type) return known.channel;
  const channel = compileChannel(value, type);
  compiled.set(value, { type, channel });
  return channel;
}

const VISUAL_SPECS = CLIP_VISUAL.properties.filter(({ animatable }) => animatable !== false);

/** What a compositor reads from the properties of a clip. */
export function channelsOf(properties: Properties): Channels {
  const channels: Record<string, Channel> = {};
  for (const { path, type } of VISUAL_SPECS) {
    const value = properties[path];
    const channel = value === undefined ? undefined : channelOf(value, type);
    if (channel) channels[path] = channel;
  }
  return channels;
}

/** The one value of what cannot have keys: only a hand-written project can have them anyway. */
export const firstValue = (value: PropertyValue | undefined): Value | undefined =>
  value !== undefined && isAnimation(value) ? value.keys[0]?.value : value;

export function fitOf(properties: Properties): RenderLayer["fit"] {
  const plain = firstValue(entryOf(properties, "fit"));
  return plain === "cover" || plain === "fixed" ? plain : "contain";
}

function assetOf(state: ProjectState, clip: ClipState): Asset | undefined {
  const { media } = clip.source as { readonly media?: MediaRef };
  return media && "asset" in media ? entryOf(state.assets, media.asset) : undefined;
}

const sceneOf = (state: ProjectState, { source }: ClipState): SceneSource | undefined =>
  source.kind === "scene" && source.scene !== undefined
    ? sceneSourceOf(state, source.scene as string)
    : undefined;

function sourceOf(clip: ClipState, asset: Asset | undefined): LayerSource | undefined {
  const { source } = clip;
  if (source.kind === "color") return { kind: "color", color: source.color as string };
  if (source.kind !== "video" && source.kind !== "image") return undefined;
  return asset?.hash === undefined ? undefined : { kind: source.kind, file: asset.hash };
}

const FADE: TransitionImplementation = { kind: "built-in", type: "fade" };

type Edge = "enter" | "exit";
const EDGES: readonly Edge[] = ["enter", "exit"];

/**
 * A transition at the start or the end of a clip, ready to draw. One that this editor cannot do
 * shows as a fade, and says so. It is never longer than the clip.
 */
function plannedEdge(clip: ClipState, edge: Edge): PlannedTransition | undefined {
  const transition = clip[edge];
  if (!transition) return undefined;
  const length = edgeLength(parseTime(transition.duration), parseTime(clip.duration));
  const [start, end] =
    edge === "enter"
      ? [clipStart(clip), add(clipStart(clip), length)]
      : [subtract(clipEnd(clip), length), clipEnd(clip)];
  const found = findTransition(transition, "picture", edge);
  const isDone = found.kind === "built-in" && isSupported(found, "picture", edge);
  const how: TransitionImplementation =
    found.kind === "built-in" && isDone
      ? {
          kind: "built-in",
          type: found.type,
          ...(found.variant === undefined ? {} : { variant: found.variant }),
        }
      : FADE;
  return {
    how,
    start: toSeconds(start),
    end: toSeconds(end),
    duration: toSeconds(length),
    ...(transition.curve && { curve: transition.curve }),
    ...(isDone ? {} : { missing: true as const }),
  };
}

/** A join that does what it says: on the cut between its two clips, which both show. */
export interface JoinInEffect {
  readonly id: string;
  readonly track: string;
  readonly from: ClipState;
  readonly to: ClipState;
  readonly transition: JoinTransition;
  /** The cut, exactly. */
  readonly at: Rational;
}

/**
 * The joins of a timeline that do something, by `placeJoins`, as the problems of a file have them
 * too: a join whose sides are apart, or one of them hidden, does nothing.
 */
export function joinsInEffect(timeline: TimelineState): readonly JoinInEffect[] {
  const byTrack = new Map<string, Map<string, JoinSides>>();
  for (const [id, { track, from, to, transition }] of Object.entries(timeline.joins ?? {})) {
    if (track === undefined || from === undefined || to === undefined || !transition) continue;
    const joins = byTrack.get(track) ?? new Map<string, JoinSides>();
    byTrack.set(track, joins.set(id, { from, to }));
  }
  const found: JoinInEffect[] = [];
  for (const [track, joins] of byTrack) {
    const clipOf = (id: string) => {
      const clip = entryOf(timeline.clips, id);
      return clip?.track === track ? clip : undefined;
    };
    for (const [id, place] of placeJoins(joins, clipOf)) {
      if (place.kind !== "cut") continue;
      const { from, to } = joins.get(id) as JoinSides;
      const transition = timeline.joins?.[id]?.transition as JoinTransition;
      const sides = { from: clipOf(from) as ClipState, to: clipOf(to) as ClipState };
      found.push({ id, track, ...sides, transition, at: place.at });
    }
  }
  return found;
}

/**
 * The edges of clips where a join is, as `<clip> enter` and `<clip> exit`: a join wins over the
 * transition at either of its ends. Joins are not drawn yet, so for now such a cut is a cut and
 * nothing else, and an export stops there (see `transitionsNotDone`).
 */
export function joinedEdges(timeline: TimelineState): ReadonlySet<string> {
  const joined = new Set<string>();
  for (const { from, to } of joinsInEffect(timeline)) {
    joined.add(`${from.id} exit`).add(`${to.id} enter`);
  }
  return joined;
}

/**
 * Seconds on the timeline that a join takes, around its cut as `align` says: half before and half
 * after, all before or all after. Each part stays within the clip on its side.
 */
export function joinSpan({ from, to, transition, at }: JoinInEffect): readonly [number, number] {
  const length = parseTime(transition.duration);
  const half = divide(length, rational(2n));
  const [before, after] =
    transition.align === "before"
      ? [length, ZERO]
      : transition.align === "after"
        ? [ZERO, length]
        : [half, half];
  const start = subtract(at, edgeLength(before, parseTime(from.duration)));
  const end = add(at, edgeLength(after, parseTime(to.duration)));
  return [toSeconds(start), toSeconds(end)];
}

/** A transition that this editor does not do yet, and where it is. */
export interface TransitionNotDone {
  /** The clip that it is at, and for a join the clip before it. */
  readonly clip: string;
  readonly use: TransitionUse;
  readonly media: TransitionMedia;
  /** Seconds on the timeline. */
  readonly start: number;
  readonly end: number;
}

/**
 * Where a file of a timeline would show or sound otherwise than the project says, earliest first.
 * Enter and exit transitions of pictures that this editor cannot do show as fades, joins are not
 * drawn yet, and no transition of sound is heard yet. An export stops at the first of them, instead
 * of a file with a fade, a hard cut or a sound that goes on where the project says something else.
 * Only what the file gets counts: what does not show in the plan, or is not heard, is no matter.
 */
export function transitionsNotDone(
  timeline: TimelineState,
  plan: Pick<RenderPlan, "layers">,
  audio: AudioPlan | undefined,
): readonly TransitionNotDone[] {
  const found: TransitionNotDone[] = [];
  const drawn = new Set(plan.layers.map(({ id }) => id));
  const heard = new Set(audio?.sounds.map(({ id }) => id));
  for (const layer of plan.layers) {
    for (const use of EDGES) {
      const transition = layer[use];
      if (!transition?.missing) continue;
      const { start, end } = transition;
      found.push({ clip: layer.id, use, media: "picture", start, end });
    }
  }
  const joined = new Set<string>();
  for (const join of joinsInEffect(timeline)) {
    joined.add(`${join.from.id} exit`).add(`${join.to.id} enter`);
    const both = (set: ReadonlySet<string>) => set.has(join.from.id) && set.has(join.to.id);
    const media = both(drawn) ? "picture" : both(heard) ? "sound" : undefined;
    if (media === undefined) continue;
    const [start, end] = joinSpan(join);
    found.push({ clip: join.from.id, use: "join", media, start, end });
  }
  for (const id of heard) {
    const clip = entryOf(timeline.clips, id);
    for (const use of EDGES) {
      const transition = clip?.[use];
      if (!clip || !transition || joined.has(`${id} ${use}`)) continue;
      const length = edgeLength(parseTime(transition.duration), parseTime(clip.duration));
      const [start, end] =
        use === "enter"
          ? [clipStart(clip), add(clipStart(clip), length)]
          : [subtract(clipEnd(clip), length), clipEnd(clip)];
      found.push({ clip: id, use, media: "sound", start: toSeconds(start), end: toSeconds(end) });
    }
  }
  return found.toSorted((a, b) => a.start - b.start || a.clip.localeCompare(b.clip));
}

const NO_CONTENT: Readonly<Record<string, PropertyValue>> = {};

/** What of a clip is for its scene. */
export function contentOf(properties: Properties): Readonly<Record<string, PropertyValue>> {
  let content: Record<string, PropertyValue> | undefined;
  for (const [path, value] of Object.entries(properties)) {
    if (!isSceneOwned(path)) continue;
    content ??= {};
    content[path] = value;
  }
  return content ?? NO_CONTENT;
}

interface BuiltLayer {
  readonly asset: Asset | undefined;
  readonly scene: SceneSource | undefined;
  readonly properties: Properties;
  /** Which of its edges a join has. */
  readonly joined: string;
  readonly layer: RenderLayer | undefined;
}

const built = new WeakMap<ClipState, BuiltLayer>();

/**
 * Clips that did not change keep their identity, so they keep their layer. That is what makes a
 * change to one clip of thousands cheap, and it tells at a glance which layers are still the same.
 */
function layerOf(
  state: ProjectState,
  clip: ClipState,
  version: Version | undefined,
  joins: ReadonlySet<string>,
): RenderLayer | undefined {
  const asset = assetOf(state, clip);
  const scene = sceneOf(state, clip);
  const properties = effectiveProperties(clip, version);
  const enters = !joins.has(`${clip.id} enter`);
  const exits = !joins.has(`${clip.id} exit`);
  const joined = `${enters ? "" : "enter"} ${exits ? "" : "exit"}`;
  const known = built.get(clip);
  if (
    known?.asset === asset &&
    known?.scene === scene &&
    known?.properties === properties &&
    known?.joined === joined
  ) {
    return known?.layer;
  }
  const enter = enters ? plannedEdge(clip, "enter") : undefined;
  const exit = exits ? plannedEdge(clip, "exit") : undefined;
  const source = scene ?? sourceOf(clip, asset);
  const layer: RenderLayer | undefined = source && {
    id: clip.id,
    start: toSeconds(clipStart(clip)),
    end: toSeconds(clipEnd(clip)),
    offset: toSeconds(clipOffset(clip)),
    source,
    // A scene is laid out for its box, so there is nothing to keep in proportion.
    fit: scene ? "fixed" : fitOf(properties),
    ...(enter && { enter }),
    ...(exit && { exit }),
    channels: channelsOf(properties),
    ...(scene && { content: contentOf(properties) }),
  };
  built.set(clip, { asset, scene, properties, joined, layer });
  return layer;
}

/** The format of a version: the first one, unless the version says otherwise. */
export function formatOf(state: ProjectState, version?: Version) {
  const { formats } = state.manifest;
  return version?.format === undefined
    ? formats[0]
    : formats.find(({ id }) => id === version.format);
}

/** What a timeline shows: a compositor needs nothing else. */
export function buildRenderPlan(
  state: ProjectState,
  timelineId: string,
  version?: Version,
): RenderPlan | undefined {
  const timeline = entryOf(state.timelines, timelineId);
  const format = formatOf(state, version);
  if (!timeline || !format) return undefined;
  const { n, d } = parseTime(format.fps);
  const tracks = orderedTracks(timeline).filter((track) => track.kind === "video" && !track.hidden);
  const lanes = new Map(tracks.map(({ id }) => [id, [] as RenderLayer[]]));
  const joined = joinedEdges(timeline);
  for (const clip of Object.values(timeline.clips)) {
    const lane = lanes.get(clip.track);
    const layer = lane && !clip.hidden ? layerOf(state, clip, version, joined) : undefined;
    if (layer) lane?.push(layer);
  }
  return {
    width: format.width,
    height: format.height,
    stage: stageOf(format),
    camera: STILL_CAMERA,
    background: timeline.background ?? "#000000",
    scenes: {
      format: format.id,
      language: state.manifest.languages[0]?.id ?? "",
      fps: { num: Number(n), den: Number(d) },
    },
    layers: [...lanes.values()].flatMap((lane) => lane.toSorted((a, b) => a.start - b.start)),
  };
}

/** Whether two plans draw the same. Layers that did not change are the same objects: see layerOf. */
export function samePlan(a: RenderPlan, b: RenderPlan): boolean {
  return (
    a.width === b.width &&
    a.height === b.height &&
    a.background === b.background &&
    a.camera === b.camera &&
    a.scenes.format === b.scenes.format &&
    a.scenes.language === b.scenes.language &&
    a.scenes.fps.num === b.scenes.fps.num &&
    a.scenes.fps.den === b.scenes.fps.den &&
    a.layers.length === b.layers.length &&
    a.layers.every((layer, index) => layer === b.layers[index])
  );
}

const gainOf = (decibels: number) => 10 ** (decibels / 20);

/** The file of a clip with sound, as far as there is one. */
function soundFileOf(state: ProjectState, clip: ClipState): string | undefined {
  const { source } = clip;
  if (source.kind === "sound") return madeSoundOf(state, clip)?.file;
  if (source.kind !== "audio") return undefined;
  const media = source.media as MediaRef;
  return "asset" in media ? entryOf(state.assets, media.asset)?.hash : undefined;
}

/**
 * Solo wins: as soon as one track has it, only those tracks sound. `volumeOf` is for what people are
 * trying out, which they have to hear: it gives the volume of a clip when that is not the saved one.
 */
export function buildAudioPlan(
  state: ProjectState,
  timelineId: string,
  volumeOf?: (clip: string) => number | undefined,
): AudioPlan {
  const timeline = entryOf(state.timelines, timelineId);
  if (!timeline) return { sounds: [] };
  const tracks = orderedTracks(timeline).filter(
    (track): track is AudioTrackState => track.kind === "audio",
  );
  const soloing = tracks.some((track) => track.solo);
  const audible = new Map(
    tracks
      .filter((track) => (soloing ? track.solo : !track.muted))
      .map((track) => [track.id, track]),
  );
  const sounds: SoundLayer[] = [];
  for (const clip of Object.values(timeline.clips)) {
    const track = audible.get(clip.track);
    if (!track || clip.hidden) continue;
    const file = soundFileOf(state, clip);
    if (file === undefined) continue;
    const decibels =
      numberOf(track.properties, "audio.volume", 0) +
      (volumeOf?.(clip.id) ?? numberOf(effectiveProperties(clip), "audio.volume", 0));
    sounds.push({
      id: clip.id,
      file,
      start: toSeconds(clipStart(clip)),
      end: toSeconds(clipEnd(clip)),
      offset: toSeconds(clipOffset(clip)),
      gain: gainOf(decibels),
      ...(clip.source.kind === "sound" && { made: true as const }),
    });
  }
  return { sounds };
}
