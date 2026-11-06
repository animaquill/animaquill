import { isAnimation, toSeconds, type MediaRef } from "@animaquill/schema";
import { clipEnd, clipOffset, clipStart, orderedTracks, type ClipState } from "./model.ts";
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

/** A property as a plain number. Keys come with keyframe evaluation, until then the first value. */
function numberOf(clip: ClipState, path: string, fallback: number): number {
  const value = clip.properties?.[path];
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
        opacity: numberOf(clip, "opacity", 1),
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
