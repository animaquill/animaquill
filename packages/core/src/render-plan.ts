import {
  CLIP_VISUAL,
  isAnimation,
  parseTime,
  toSeconds,
  type Animation,
  type Asset,
  type MediaRef,
  type PropertyValue,
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
  /** Seconds. */
  readonly fades: { readonly in: number; readonly out: number };
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

const secondsOf = (time: string | undefined) =>
  time === undefined ? 0 : toSeconds(parseTime(time));

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
): RenderLayer | undefined {
  const asset = assetOf(state, clip);
  const scene = sceneOf(state, clip);
  const properties = effectiveProperties(clip, version);
  const known = built.get(clip);
  if (known?.asset === asset && known?.scene === scene && known?.properties === properties) {
    return known?.layer;
  }
  const source = scene ?? sourceOf(clip, asset);
  const layer: RenderLayer | undefined = source && {
    id: clip.id,
    start: toSeconds(clipStart(clip)),
    end: toSeconds(clipEnd(clip)),
    offset: toSeconds(clipOffset(clip)),
    source,
    // A scene is laid out for its box, so there is nothing to keep in proportion.
    fit: scene ? "fixed" : fitOf(properties),
    fades: { in: secondsOf(clip.fadeIn), out: secondsOf(clip.fadeOut) },
    channels: channelsOf(properties),
    ...(scene && { content: contentOf(properties) }),
  };
  built.set(clip, { asset, scene, properties, layer });
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
  for (const clip of Object.values(timeline.clips)) {
    const lane = lanes.get(clip.track);
    const layer = lane && !clip.hidden ? layerOf(state, clip, version) : undefined;
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
