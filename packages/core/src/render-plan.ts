import {
  BUILT_IN_PROPERTIES,
  CLIP_VISUAL,
  add,
  builtInEffect,
  effectOfPath,
  effectPath,
  findEffect,
  parameterOf,
  edgeLength,
  findTransition,
  isAnimation,
  isSupported,
  parseTime,
  subtract,
  toSeconds,
  type Animation,
  type Asset,
  type MediaRef,
  type PropertySpec,
  type PropertyValue,
  type SpeedCurve,
  type TransitionMedia,
  type TransitionRef,
  type TransitionUse,
  type TransitionValues,
  type Value,
  type ValueType,
} from "@animaquill/schema";
import { compileChannel, type Channel, type Channels } from "./curve.ts";
import { joinSpan, joinsInEffect, spanOfJoin, type JoinInEffect } from "./joins.ts";
import {
  clipEnd,
  clipOffset,
  clipStart,
  effectsOf,
  entryOf,
  orderedTracks,
  type ClipState,
  type JoinState,
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
  /**
   * Back to front, track by track: the layers of a track are next to each other, in time order. A
   * later one is in front of an earlier one.
   */
  readonly layers: readonly RenderLayer[];
  /** Transitions on the cuts between layers of a track, from the one before to the one after. */
  readonly joins: readonly RenderJoin[];
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
  /**
   * What its code gets as it is: those of the transition, with those of the variant over them.
   * Without it, none.
   */
  readonly values?: TransitionValues;
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
  /** Its speed curve goes past 0 and 1 as it is, see `progressAt`. */
  readonly overshoot?: true;
  /**
   * It stands in for a transition that this editor cannot do, as a fade. An export stops there, so
   * that no file says something else than the project.
   */
  readonly missing?: true;
}

/**
 * A transition on the cut between two layers of a track, ready to be drawn: from the one before to
 * the one after, which show past their clips for it, see `RenderLayer.shows`. A side that is not in
 * the plan, because it has nothing to draw, is nothing there.
 */
export interface RenderJoin extends PlannedTransition {
  readonly id: string;
  readonly track: string;
  /** Layers, by id. */
  readonly from: string;
  readonly to: string;
}

/**
 * An effect ready to be drawn: which one, in its place in the list. What it takes are channels of
 * its layer, `effect.<id>.<parameter>`, so that they change like any other while people drag. Only
 * those that are on are in the plan.
 */
export interface PlannedEffect {
  readonly id: string;
  readonly type: string;
  /**
   * This editor cannot do it. The preview goes on without it, and an export stops wherever the
   * layer shows, so that no file says something else than the project.
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
  /**
   * Seconds on the timeline that it shows, where a join has it go on after its end or start before
   * its start: it does that on its own clock, see the project format. Without it, its own.
   */
  readonly shows?: { readonly from: number; readonly to: number };
  /**
   * What changes over time, on the clock of the clip: `transform.*`, `opacity`, `blend`, and what
   * its effects take, `effect.<id>.<parameter>`.
   */
  readonly channels: Channels;
  /** In the order they work, on what the clip shows in its box. Without it, none. */
  readonly effects?: readonly PlannedEffect[];
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

/**
 * What a compositor reads from the properties of a clip, with what its effects take. A value that
 * is not of the type of its property does nothing, and the default counts.
 */
export function channelsOf(
  properties: Properties,
  effects: readonly PlannedEffect[] = [],
): Channels {
  const channels: Record<string, Channel> = {};
  const put = (path: string, type: ValueType) => {
    const value = entryOf(properties, path);
    const channel = value === undefined ? undefined : channelOf(value, type);
    if (channel) channels[path] = channel;
  };
  for (const { path, type } of VISUAL_SPECS) put(path, type);
  for (const { id, type, missing } of effects) {
    const spec = missing ? undefined : builtInEffect(type);
    for (const parameter of spec?.properties ?? []) {
      put(effectPath(id, parameter.path), parameter.type);
    }
  }
  return channels;
}

/** What describes a property of a layer, for its channel: built in, or one of its effects. */
export function layerSpecOf(
  layer: Pick<RenderLayer, "effects">,
  path: string,
): PropertySpec | undefined {
  if (Object.hasOwn(BUILT_IN_PROPERTIES, path)) return BUILT_IN_PROPERTIES[path];
  const of = effectOfPath(path);
  const effect = of && layer.effects?.find(({ id }) => id === of.effect);
  const spec = effect && !effect.missing ? builtInEffect(effect.type) : undefined;
  return spec && of ? parameterOf(spec, of.parameter) : undefined;
}

const NO_PLANNED: readonly PlannedEffect[] = [];

/** The effects of a clip that are on, as a compositor draws them. Only pictures have them so far. */
export function plannedEffects(clip: ClipState): readonly PlannedEffect[] {
  const planned = effectsOf(clip).flatMap(({ id, type, enabled }): PlannedEffect[] => {
    if (enabled === false) return [];
    const found = findEffect(type, "picture");
    return [found.kind === "built-in" ? { id, type } : { id, type, missing: true }];
  });
  return planned.length > 0 ? planned : NO_PLANNED;
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
 * What draws a transition, there. One that this editor cannot do is drawn as a fade, and says so:
 * see `PlannedTransition.missing`.
 */
function implementationOf(
  transition: TransitionRef,
  use: TransitionUse,
): Pick<PlannedTransition, "how" | "overshoot" | "missing"> {
  const found = findTransition(transition, "picture", use);
  if (found.kind !== "built-in" || !isSupported(found, "picture", use)) {
    return { how: FADE, missing: true };
  }
  const { type, variant, values, spec } = found;
  const given = Object.keys(values).length > 0 ? { values } : {};
  return {
    how: { kind: "built-in", type, ...(variant === undefined ? {} : { variant }), ...given },
    ...(spec.overshoot && { overshoot: true as const }),
  };
}

/** A transition at the start or the end of a clip, ready to draw. It is never longer than the clip. */
function plannedEdge(clip: ClipState, edge: Edge): PlannedTransition | undefined {
  const transition = clip[edge];
  if (!transition) return undefined;
  const length = edgeLength(parseTime(transition.duration), parseTime(clip.duration));
  const [start, end] =
    edge === "enter"
      ? [clipStart(clip), add(clipStart(clip), length)]
      : [subtract(clipEnd(clip), length), clipEnd(clip)];
  return {
    ...implementationOf(transition, edge),
    start: toSeconds(start),
    end: toSeconds(end),
    duration: toSeconds(length),
    ...(transition.curve && { curve: transition.curve }),
  };
}

/** A join ready to draw, at its cut, as long as the clips on its sides let it be. */
function plannedJoin(join: JoinInEffect): RenderJoin {
  const { transition } = join;
  const { from, to } = spanOfJoin(join);
  return {
    id: join.id,
    track: join.track,
    from: join.from.id,
    to: join.to.id,
    ...implementationOf(transition, "join"),
    start: toSeconds(from),
    end: toSeconds(to),
    duration: toSeconds(subtract(to, from)),
    ...(transition.curve && { curve: transition.curve }),
  };
}

/** A transition that this editor does not do yet, and where it is. */
export interface TransitionNotDone {
  /** The clip that it is at, and for a join the clip before it. */
  readonly clip: string;
  /** Where it is, or `effect` for an effect of the clip that this editor cannot do. */
  readonly use: TransitionUse | "effect";
  readonly media: TransitionMedia;
  /** Seconds on the timeline. */
  readonly start: number;
  readonly end: number;
}

/**
 * Where a file of a timeline would show or sound otherwise than the project says, earliest first.
 * Transitions of pictures that this editor cannot do show as fades, and no transition of sound is
 * heard yet. An export stops at the first of them, instead of a file with a fade or a sound that
 * goes on where the project says something else. Only what the file gets counts: what does not
 * show in the plan, or is not heard, is no matter.
 */
export function transitionsNotDone(
  timeline: TimelineState,
  plan: Pick<RenderPlan, "layers" | "joins">,
  audio: AudioPlan | undefined,
): readonly TransitionNotDone[] {
  const found: TransitionNotDone[] = [];
  const heard = new Set(audio?.sounds.map(({ id }) => id));
  for (const layer of plan.layers) {
    if (layer.effects?.some(({ missing }) => missing)) {
      const start = layer.shows?.from ?? layer.start;
      const end = layer.shows?.to ?? layer.end;
      found.push({ clip: layer.id, use: "effect", media: "picture", start, end });
    }
    for (const use of EDGES) {
      const transition = layer[use];
      if (!transition?.missing) continue;
      const { start, end } = transition;
      found.push({ clip: layer.id, use, media: "picture", start, end });
    }
  }
  for (const { from, missing, start, end } of plan.joins) {
    if (missing) found.push({ clip: from, use: "join", media: "picture", start, end });
  }
  const joined = new Set<string>();
  for (const join of joinsInEffect(timeline)) {
    joined.add(`${join.from.id} exit`).add(`${join.to.id} enter`);
    if (!heard.has(join.from.id) || !heard.has(join.to.id)) continue;
    const [start, end] = joinSpan(join);
    found.push({ clip: join.from.id, use: "join", media: "sound", start, end });
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
  readonly effects: ClipState["effects"];
  readonly asset: Asset | undefined;
  readonly scene: SceneSource | undefined;
  readonly properties: Properties;
  /** Which of its edges a join has, and how far it shows past them for that. */
  readonly joined: string;
  readonly layer: RenderLayer | undefined;
}

const built = new WeakMap<ClipState, BuiltLayer>();

/** What joins do to a clip: which of its edges they win over, and where it shows then. */
interface Joined {
  readonly enter: boolean;
  readonly exit: boolean;
  /** Seconds on the timeline, past its own ends. */
  readonly from?: number;
  readonly to?: number;
}

const NOT_JOINED: Joined = { enter: false, exit: false };

/**
 * Clips that did not change keep their identity, so they keep their layer. That is what makes a
 * change to one clip of thousands cheap, and it tells at a glance which layers are still the same.
 */
function layerOf(
  state: ProjectState,
  clip: ClipState,
  version: Version | undefined,
  joins: Joined,
): RenderLayer | undefined {
  const asset = assetOf(state, clip);
  const scene = sceneOf(state, clip);
  const properties = effectiveProperties(clip, version);
  const joined = `${joins.enter} ${joins.exit} ${joins.from} ${joins.to}`;
  const known = built.get(clip);
  if (
    known?.effects === clip.effects &&
    known?.asset === asset &&
    known?.scene === scene &&
    known?.properties === properties &&
    known?.joined === joined
  ) {
    return known?.layer;
  }
  const enter = joins.enter ? undefined : plannedEdge(clip, "enter");
  const exit = joins.exit ? undefined : plannedEdge(clip, "exit");
  const source = scene ?? sourceOf(clip, asset);
  const start = toSeconds(clipStart(clip));
  const end = toSeconds(clipEnd(clip));
  const shows = joins.from !== undefined || joins.to !== undefined;
  const effects = plannedEffects(clip);
  const layer: RenderLayer | undefined = source && {
    id: clip.id,
    start,
    end,
    offset: toSeconds(clipOffset(clip)),
    source,
    // A scene is laid out for its box, so there is nothing to keep in proportion.
    fit: scene ? "fixed" : fitOf(properties),
    ...(enter && { enter }),
    ...(exit && { exit }),
    ...(shows && { shows: { from: joins.from ?? start, to: joins.to ?? end } }),
    channels: channelsOf(properties, effects),
    ...(effects.length > 0 && { effects }),
    ...(scene && { content: contentOf(properties) }),
  };
  built.set(clip, { effects: clip.effects, asset, scene, properties, joined, layer });
  return layer;
}

/** What the joins of the drawn tracks do to their clips, by clip. */
function joinedClips(joins: readonly RenderJoin[]): ReadonlyMap<string, Joined> {
  const joined = new Map<string, Joined>();
  for (const join of joins) {
    const before = joined.get(join.from) ?? NOT_JOINED;
    // The clip before the cut goes on for what is after it, the one after starts early.
    joined.set(join.from, { ...before, exit: true, to: join.end });
    const after = joined.get(join.to) ?? NOT_JOINED;
    joined.set(join.to, { ...after, enter: true, from: join.start });
  }
  return joined;
}

/** A plan keeps the joins it had while they stay the same, so that it stays the same plan. */
const plannedJoins = new WeakMap<object, RenderJoin>();

function joinOf(join: JoinInEffect, state: JoinState): RenderJoin {
  const planned = plannedJoin(join);
  const known = plannedJoins.get(state);
  if (known && sameJoin(known, planned)) return known;
  plannedJoins.set(state, planned);
  return planned;
}

function sameJoin(a: RenderJoin, b: RenderJoin): boolean {
  return (
    a.id === b.id &&
    a.track === b.track &&
    a.from === b.from &&
    a.to === b.to &&
    a.start === b.start &&
    a.end === b.end &&
    a.duration === b.duration &&
    a.missing === b.missing &&
    a.overshoot === b.overshoot &&
    a.how.type === b.how.type &&
    a.how.variant === b.how.variant &&
    JSON.stringify(a.curve) === JSON.stringify(b.curve)
  );
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
  const effective = joinsInEffect(timeline).filter(({ track }) => lanes.has(track));
  const planned = effective.map((join) => joinOf(join, timeline.joins?.[join.id] as JoinState));
  const joined = joinedClips(planned);
  for (const clip of Object.values(timeline.clips)) {
    const lane = lanes.get(clip.track);
    const joins = joined.get(clip.id) ?? NOT_JOINED;
    const layer = lane && !clip.hidden ? layerOf(state, clip, version, joins) : undefined;
    if (layer) lane?.push(layer);
  }
  const layers = [...lanes.values()].flatMap((lane) => lane.toSorted((a, b) => a.start - b.start));
  // A join with nothing on either side draws nothing, which is no matter for anybody.
  const drawn = new Set(layers.map(({ id }) => id));
  const joins = planned
    .filter(({ from, to }) => drawn.has(from) || drawn.has(to))
    .toSorted((a, b) => a.start - b.start || a.id.localeCompare(b.id));
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
    layers,
    joins,
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
    a.layers.every((layer, index) => layer === b.layers[index]) &&
    a.joins.length === b.joins.length &&
    a.joins.every((join, index) => join === b.joins[index])
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
