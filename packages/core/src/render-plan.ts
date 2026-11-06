import { isAnimation, toSeconds, type MediaRef } from "@animaquill/schema";
import {
  clipEnd,
  clipOffset,
  clipStart,
  orderedTracks,
  type ClipState,
  type TrackState,
} from "./model.ts";
import type { ProjectState } from "./model.ts";

/** What a compositor draws from. It knows nothing about projects, versions or Yjs. */
export interface RenderPlan {
  readonly width: number;
  readonly height: number;
  readonly background: string;
  /** Back to front. */
  readonly layers: readonly RenderLayer[];
}

export type LayerSource =
  | { readonly kind: "color"; readonly color: string }
  | { readonly kind: "image"; readonly file: string }
  | { readonly kind: "video"; readonly file: string };

export interface RenderLayer {
  readonly id: string;
  /** Seconds on the timeline. */
  readonly start: number;
  readonly end: number;
  /** What the clock of the clip reads at its start, which for a video is the time in the file. */
  readonly offset: number;
  readonly source: LayerSource;
  readonly opacity: number;
  readonly fit: "contain" | "cover";
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
}

/** What a timeline sounds like. */
export interface AudioPlan {
  readonly sounds: readonly SoundLayer[];
}

type Properties = ClipState["properties"];
type AudioTrackState = Extract<TrackState, { kind: "audio" }>;

/** A property as a plain number. Keys come with keyframe evaluation, until then the first value. */
function numberOf(properties: Properties, path: string, fallback: number): number {
  const value = properties?.[path];
  if (value === undefined) return fallback;
  const plain = isAnimation(value) ? value.keys[0]?.value : value;
  return typeof plain === "number" ? plain : fallback;
}

function sourceOf(state: ProjectState, clip: ClipState): LayerSource | undefined {
  const { source } = clip;
  if (source.kind === "color") return { kind: "color", color: source.color as string };
  if (source.kind !== "video" && source.kind !== "image") return undefined;
  const media = source.media as MediaRef;
  const file = "asset" in media ? state.assets?.[media.asset]?.hash : undefined;
  return file === undefined ? undefined : { kind: source.kind, file };
}

/** What a timeline shows: a compositor needs nothing else. */
export function buildRenderPlan(state: ProjectState, timelineId: string): RenderPlan | undefined {
  const timeline = state.timelines[timelineId];
  const format = state.manifest.formats[0];
  if (!timeline || !format) return undefined;
  const layers: RenderLayer[] = [];
  for (const track of orderedTracks(timeline)) {
    if (track.kind !== "video" || track.hidden) continue;
    const clips = Object.values(timeline.clips)
      .filter((clip) => clip.track === track.id && !clip.hidden)
      .toSorted((a, b) => toSeconds(clipStart(a)) - toSeconds(clipStart(b)));
    for (const clip of clips) {
      const source = sourceOf(state, clip);
      if (!source) continue;
      layers.push({
        id: clip.id,
        start: toSeconds(clipStart(clip)),
        end: toSeconds(clipEnd(clip)),
        offset: toSeconds(clipOffset(clip)),
        source,
        opacity: numberOf(clip.properties, "opacity", 1),
        fit: clip.properties?.["fit"] === "cover" ? "cover" : "contain",
      });
    }
  }
  return {
    width: format.width,
    height: format.height,
    background: timeline.background ?? "#000000",
    layers,
  };
}

const gainOf = (decibels: number) => 10 ** (decibels / 20);

/** Solo wins: as soon as one track has it, only those tracks sound. */
export function buildAudioPlan(state: ProjectState, timelineId: string): AudioPlan {
  const timeline = state.timelines[timelineId];
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
    const { source } = clip;
    if (!track || clip.hidden || source.kind !== "audio") continue;
    const media = source.media as MediaRef;
    const file = "asset" in media ? state.assets?.[media.asset]?.hash : undefined;
    if (file === undefined) continue;
    const decibels =
      numberOf(track.properties, "audio.volume", 0) + numberOf(clip.properties, "audio.volume", 0);
    sounds.push({
      id: clip.id,
      file,
      start: toSeconds(clipStart(clip)),
      end: toSeconds(clipEnd(clip)),
      offset: toSeconds(clipOffset(clip)),
      gain: gainOf(decibels),
    });
  }
  return { sounds };
}
