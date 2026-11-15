import {
  boxOf,
  buildRenderPlan,
  cornersOf,
  entryOf,
  formatOf,
  isShownAt,
  layerMatrix,
  naturalSizeOf,
  placementOf,
  sceneViewOf,
  shownAt,
  stageOf,
  transformPoint,
  type Point,
  type ProjectState,
  type Rect,
  type RenderLayer,
  type RenderPlan,
  type Size,
} from "@animaquill/core";
import type { LookTexts } from "./types.ts";

/**
 * What is on the picture at a moment, measured from the render plan as the compositor draws it: the
 * box of each clip in the world, how far it shows, and where it goes past the edges of the picture.
 * The text in scenes comes from the scenes themselves (`LookTexts`), placed the same way. This is
 * the measuring that size checks and acceptance checks will use too (preview.md 8).
 */

/** The sides of the picture, in the order they are told. */
export const SIDES = ["left", "right", "top", "bottom"] as const;
export type Side = (typeof SIDES)[number];

/** Less than this of a world unit past an edge is rounding, not past it. */
const EDGE_TOLERANCE = 0.5;
/** At most this many text elements of all scenes on one frame are told. */
export const MOST_TEXTS = 20;
/** Clips that both cover less than this share of the picture are told when they overlap. */
const SMALL_SHARE = 0.5;
/** Where they overlap by less than this share of the smaller one, it is their edges touching. */
const OVERLAP_SHARE = 0.02;

/** A text element of a scene, in the world. */
export interface TextFact {
  readonly text: string;
  readonly box: Rect;
  /** How far it goes past each edge of the picture, in world units: only those it goes past. */
  readonly past: Partial<Record<Side, number>>;
}

/** A clip that shows at a moment. */
export interface ClipFact {
  readonly id: string;
  readonly name: string | undefined;
  /** What it shows, as the timeline lines say it: `asset=…`, `scene=…`, `color=…`. */
  readonly source: string;
  /** From the back, 1 first. */
  readonly depth: number;
  /** Its opacity with its fades, 0 to 1. */
  readonly opacity: number;
  /** What of its box has something in it, in the world, as the box around its corners. */
  readonly box: Rect;
  /** The share of the picture it covers, 0 to 1, as far as it is on the picture. */
  readonly share: number;
  readonly past: Partial<Record<Side, number>>;
  /** None of it is on the picture. */
  readonly outside: boolean;
  /** Its media is wider or taller than its box, which `cover` cuts. */
  readonly cropped: boolean;
  /** The clips in front of it or behind it that it overlaps, both small, by id. */
  readonly overlaps: readonly string[];
  readonly texts: readonly TextFact[];
}

/** What is on one frame. */
export interface FrameFacts {
  readonly clips: readonly ClipFact[];
  /** Clips that show at the moment with nothing of them to see: opacity 0, or no size. */
  readonly unseen: number;
  /** Text elements that were not told, past `MOST_TEXTS`. */
  readonly moreTexts: number;
}

/** The picture of a format in the world: x and y from minus half to half of its size. */
export function pictureRect(stage: Size): Rect {
  return { x: -stage.width / 2, y: -stage.height / 2, width: stage.width, height: stage.height };
}

/** The box around some points. */
export function boundsOf(points: readonly Point[]): Rect {
  const xs = points.map(({ x }) => x);
  const ys = points.map(({ y }) => y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

/** Where two boxes overlap, or nothing. */
export function overlapOf(a: Rect, b: Rect): Rect | undefined {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : undefined;
}

/** How far a box goes past each edge of another, where it does. */
export function pastOf(box: Rect, picture: Rect): Partial<Record<Side, number>> {
  const by: Record<Side, number> = {
    left: picture.x - box.x,
    right: box.x + box.width - (picture.x + picture.width),
    top: picture.y - box.y,
    bottom: box.y + box.height - (picture.y + picture.height),
  };
  return Object.fromEntries(
    SIDES.filter((side) => by[side] > EDGE_TOLERANCE).map((side) => [side, by[side]]),
  );
}

const area = (rect: Rect) => rect.width * rect.height;

/** What a clip shows, in a word and an id. */
function sourceOf(layer: RenderLayer, state: ProjectState, timeline: string): string {
  const { source } = layer;
  if (source.kind === "color") return `color=${source.color}`;
  if (source.kind === "scene") return `scene=${source.scene}`;
  const clip = entryOf(entryOf(state.timelines, timeline)?.clips ?? {}, layer.id);
  const media = (clip?.source as { readonly media?: { readonly asset?: string } } | undefined)
    ?.media;
  return media?.asset === undefined ? source.kind : `asset=${media.asset}`;
}

/** Where the text of a scene is in the world, from where its page laid it out. */
function textsOf(
  layer: RenderLayer,
  seconds: number,
  stage: Size,
  found: LookTexts | undefined,
  picture: Rect,
): TextFact[] {
  if (!found || layer.source.kind !== "scene") return [];
  const view = sceneViewOf(layer, stage);
  const box = boxOf(layer, seconds, undefined, stage);
  const matrix = layerMatrix(layer, seconds, box);
  const sx = box.width / view.width;
  const sy = box.height / view.height;
  return found.texts.flatMap((text) => {
    const corners = [
      { x: text.x, y: text.y },
      { x: text.x + text.width, y: text.y },
      { x: text.x + text.width, y: text.y + text.height },
      { x: text.x, y: text.y + text.height },
    ].map((point) => transformPoint(matrix, { x: point.x * sx, y: point.y * sy }));
    const world = boundsOf(corners);
    return Number.isFinite(world.x)
      ? [{ text: text.text, box: world, past: pastOf(world, picture) }]
      : [];
  });
}

/**
 * What shows at a moment of a plan, back to front. `texts` are what scenes said of their text on
 * this frame, by clip.
 */
export function frameFacts(
  state: ProjectState,
  timeline: string,
  plan: RenderPlan,
  seconds: number,
  texts: readonly LookTexts[] = [],
): FrameFacts {
  const picture = pictureRect(plan.stage);
  const clips: Omit<ClipFact, "overlaps">[] = [];
  let unseen = 0;
  let told = 0;
  let moreTexts = 0;
  const clipsOfTimeline = entryOf(state.timelines, timeline)?.clips ?? {};
  for (const layer of plan.layers) {
    if (!isShownAt(layer, seconds)) continue;
    const opacity = shownAt(layer, seconds);
    const clip = entryOf(clipsOfTimeline, layer.id);
    const natural = clip ? naturalSizeOf(state, clip) : undefined;
    const placement = placementOf(layer, seconds, natural, plan.stage);
    if (opacity <= 0 || !(placement.box.width > 0) || !(placement.box.height > 0)) {
      unseen += 1;
      continue;
    }
    const box = boundsOf(cornersOf(placement.matrix, placement.picture));
    if (!Number.isFinite(box.x) || !Number.isFinite(box.width)) {
      unseen += 1;
      continue;
    }
    const on = overlapOf(box, picture);
    const media =
      layer.source.kind === "image" || layer.source.kind === "video" ? natural : undefined;
    const cropped =
      layer.fit === "cover" &&
      media !== undefined &&
      Math.abs(media.width / media.height - placement.box.width / placement.box.height) >
        0.01 * (media.width / media.height);
    const all = textsOf(
      layer,
      seconds,
      plan.stage,
      texts.find((each) => each.layer === layer.id),
      picture,
    );
    const room = Math.max(0, MOST_TEXTS - told);
    told += Math.min(room, all.length);
    moreTexts += Math.max(0, all.length - room);
    clips.push({
      id: layer.id,
      name: clip?.name,
      source: sourceOf(layer, state, timeline),
      depth: clips.length + 1,
      opacity,
      box,
      share: on ? area(on) / area(picture) : 0,
      past: pastOf(box, picture),
      outside: on === undefined,
      cropped,
      texts: all.slice(0, room),
    });
  }
  const small = clips.filter((clip) => clip.share < SMALL_SHARE && !clip.outside);
  return {
    clips: clips.map((clip) => ({
      ...clip,
      overlaps: small.includes(clip)
        ? small
            .filter((other) => {
              if (other === clip) return false;
              const both = overlapOf(clip.box, other.box);
              return (
                both !== undefined &&
                area(both) > OVERLAP_SHARE * Math.min(area(clip.box), area(other.box))
              );
            })
            .map(({ id }) => id)
        : [],
    })),
    unseen,
    moreTexts,
  };
}

/** The plan of a timeline in a format, as the export renders it; nothing where there is none. */
export function planOf(
  state: ProjectState,
  timeline: string,
  format: string | undefined,
): RenderPlan | undefined {
  return buildRenderPlan(state, timeline, format === undefined ? undefined : { format });
}

/** The stage of a format of the project, in world units. */
export function stageOfFormat(state: ProjectState, format: string | undefined): Size | undefined {
  const found = formatOf(state, format === undefined ? undefined : { format });
  return found && stageOf(found);
}
