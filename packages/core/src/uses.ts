import {
  findEffect,
  findTransition,
  parseTime,
  toSeconds,
  type EffectMissing,
  type TransitionMedia,
  type TransitionMissing,
  type TransitionRef,
  type TransitionUse,
} from "@animaquill/schema";
import { entryOf, type ClipState, type ProjectState, type TimelineState } from "./model.ts";

/**
 * Where the resources of a project are used, and which of them it uses that are not there: for the
 * explorer, which says where something is used before it goes, and lists what is missing. See
 * docs/design/resource-panels.md, section 1. Nothing here changes the project.
 */

/** Something that clips use, by what the project writes about it. */
export type UsedResource =
  | { readonly kind: "asset" | "scene" | "sound"; readonly id: string }
  | { readonly kind: "effect"; readonly type: string }
  /** At the edges of clips, or between them for a join. */
  | { readonly kind: "transition"; readonly use: TransitionUse; readonly ref: TransitionRef };

/** One place where something is used. */
export interface ResourceUse {
  readonly timeline: string;
  /** The clip that uses it. For a join, the clip before it, if it is there. */
  readonly clip?: string;
  readonly join?: string;
  /** The transition at this edge of the clip uses it. */
  readonly edge?: "enter" | "exit";
  /** The effect of the clip that is it, by its id. */
  readonly effect?: string;
  /** A version shows the clip with it, by the name of the version in `overrides`. */
  readonly version?: string;
}

/** The kinds of what clips get their content from that is a resource of the project. */
type SourceKind = "asset" | "scene" | "sound";

/** What a source of a clip takes its content from, as a resource of the project. */
export function sourceResourceOf(
  source: unknown,
): { readonly kind: SourceKind; readonly id: string } | undefined {
  const { kind, media, scene, sound } = (source ?? {}) as {
    readonly kind?: string;
    readonly media?: { readonly asset?: unknown };
    readonly scene?: unknown;
    readonly sound?: unknown;
  };
  if (kind === "video" || kind === "image" || kind === "audio") {
    return typeof media?.asset === "string" ? { kind: "asset", id: media.asset } : undefined;
  }
  if (kind === "scene" && typeof scene === "string") return { kind: "scene", id: scene };
  if (kind === "sound" && typeof sound === "string") return { kind: "sound", id: sound };
  return undefined;
}

/** What of a library a source of a clip takes its content from. */
function librarySourceOf(
  source: unknown,
): { readonly kind: "library"; readonly library: string; readonly item: string } | undefined {
  const { media, library, resource } = (source ?? {}) as {
    readonly media?: { readonly library?: unknown; readonly path?: unknown };
    readonly library?: unknown;
    readonly resource?: unknown;
  };
  if (typeof media?.library === "string" && typeof media.path === "string") {
    return { kind: "library", library: media.library, item: media.path };
  }
  if (typeof library === "string" && typeof resource === "string") {
    return { kind: "library", library, item: resource };
  }
  return undefined;
}

const sameRef = (a: TransitionRef, b: TransitionRef): boolean =>
  a.type === b.type &&
  a.transition === b.transition &&
  a.library === b.library &&
  a.resource === b.resource;

/** Clips by where they start, so that a list of uses reads like the timeline. */
const byStart = (timeline: TimelineState) => {
  const startOf = (clip: ClipState) => {
    try {
      return toSeconds(parseTime(clip.start));
    } catch {
      return Infinity;
    }
  };
  const order = new Map(
    Object.values(timeline.clips)
      .map((clip) => ({ clip, start: startOf(clip) }))
      .toSorted((a, b) => a.start - b.start || a.clip.id.localeCompare(b.clip.id))
      .map(({ clip }) => clip)
      .map((clip, index) => [clip.id, index]),
  );
  return (clip: string | undefined) =>
    clip === undefined ? Infinity : (order.get(clip) ?? Infinity);
};

/** The order of the uses: by timeline as the project lists them, then by clip. */
function sorted(state: ProjectState, uses: ResourceUse[]): readonly ResourceUse[] {
  const timelines = state.manifest.timelines ?? [];
  const places = new Map<string, (clip: string | undefined) => number>();
  const placeOf = (use: ResourceUse) => {
    let at = places.get(use.timeline);
    if (!at) {
      const timeline = entryOf(state.timelines, use.timeline);
      at = timeline ? byStart(timeline) : () => Infinity;
      places.set(use.timeline, at);
    }
    return at(use.clip);
  };
  const timelineIndex = (id: string) => {
    const index = timelines.indexOf(id);
    return index === -1 ? timelines.length : index;
  };
  return uses.toSorted(
    (a, b) =>
      timelineIndex(a.timeline) - timelineIndex(b.timeline) ||
      a.timeline.localeCompare(b.timeline) ||
      placeOf(a) - placeOf(b) ||
      (a.version ?? "").localeCompare(b.version ?? ""),
  );
}

/** Each clip with the effects it has, in no order. */
function* effectsIn(clip: ClipState): Generator<readonly [string, string]> {
  for (const [id, effect] of Object.entries(clip.effects ?? {})) {
    if (typeof effect.type === "string") yield [id, effect.type];
  }
}

/**
 * Every place where something is used: clips, what versions change about clips, the transitions at
 * the edges of clips and between them, and the effects of clips. In the order of the timeline.
 */
export function usesOf(state: ProjectState, resource: UsedResource): readonly ResourceUse[] {
  const uses: ResourceUse[] = [];
  for (const [id, timeline] of Object.entries(state.timelines)) {
    uses.push(...usesIn(id, timeline, resource));
  }
  return sorted(state, uses);
}

function usesIn(id: string, timeline: TimelineState, resource: UsedResource): ResourceUse[] {
  const uses: ResourceUse[] = [];
  switch (resource.kind) {
    case "asset":
    case "scene":
    case "sound": {
      const isIt = (source: unknown) => {
        const found = sourceResourceOf(source);
        return found?.kind === resource.kind && found.id === resource.id;
      };
      for (const clip of Object.values(timeline.clips)) {
        if (isIt(clip.source)) uses.push({ timeline: id, clip: clip.id });
      }
      for (const [version, { clips }] of Object.entries(timeline.overrides)) {
        for (const [clip, changes] of Object.entries(clips ?? {})) {
          if (changes.source && isIt(changes.source.value)) {
            uses.push({ timeline: id, clip, version });
          }
        }
      }
      return uses;
    }
    case "effect":
      for (const clip of Object.values(timeline.clips)) {
        for (const [effect, type] of effectsIn(clip)) {
          if (type === resource.type) uses.push({ timeline: id, clip: clip.id, effect });
        }
      }
      return uses;
    case "transition":
      if (resource.use === "join") {
        for (const [join, { from, to, transition }] of Object.entries(timeline.joins ?? {})) {
          if (!transition || !sameRef(transition, resource.ref)) continue;
          const clip = from ?? to;
          uses.push({ timeline: id, join, ...(clip !== undefined && { clip }) });
        }
        return uses;
      }
      for (const clip of Object.values(timeline.clips)) {
        const transition = clip[resource.use];
        if (transition && sameRef(transition, resource.ref)) {
          uses.push({ timeline: id, clip: clip.id, edge: resource.use });
        }
      }
      return uses;
  }
}

/** Something that clips use, which the project does not have or the editor cannot find. */
export type MissingResource =
  /** Clips use it, and the project does not have it: a file or two people at once can do that. */
  | {
      readonly kind: SourceKind;
      readonly id: string;
      readonly uses: readonly ResourceUse[];
    }
  /** Something of a library, which this editor cannot reach yet. */
  | {
      readonly kind: "library";
      readonly library: string;
      /** Which of it: a resource by its id, or a file by its path. */
      readonly item: string;
      readonly uses: readonly ResourceUse[];
    }
  | {
      readonly kind: "effect";
      readonly type: string;
      readonly why: EffectMissing;
      readonly uses: readonly ResourceUse[];
    }
  | {
      readonly kind: "transition";
      readonly use: TransitionUse;
      readonly ref: TransitionRef;
      readonly why: TransitionMissing;
      readonly uses: readonly ResourceUse[];
    };

type WithoutUses<T> = T extends unknown ? Omit<T, "uses"> : never;

/**
 * Why a transition is not there, as opposed to put where it cannot go: the second is about the
 * place, and the problems of the project tell about it.
 */
const GONE: ReadonlySet<TransitionMissing["reason"]> = new Set([
  "unknown",
  "plugin",
  "project",
  "library",
]);

const mediaOf = (timeline: TimelineState, track: string | undefined): TransitionMedia =>
  track !== undefined && entryOf(timeline.tracks, track)?.kind === "audio" ? "sound" : "picture";

const refKey = (use: TransitionUse, ref: TransitionRef) =>
  JSON.stringify([use, ref.type, ref.transition, ref.library, ref.resource]);

/**
 * What clips use that is not there: assets, scenes and sounds that the project does not have, and
 * effects and transitions that this editor does not know, with where each is used. The files of
 * assets that are not there are up to whoever keeps them, see the explorer.
 */
export function missingIn(state: ProjectState): readonly MissingResource[] {
  const found = new Map<
    string,
    { readonly missing: WithoutUses<MissingResource>; readonly uses: ResourceUse[] }
  >();
  const note = (key: string, missing: WithoutUses<MissingResource>, use: ResourceUse) => {
    const known = found.get(key);
    if (known) known.uses.push(use);
    else found.set(key, { missing, uses: [use] });
  };
  const has = (kind: SourceKind, id: string) =>
    (kind === "asset"
      ? entryOf(state.assets, id)
      : kind === "scene"
        ? entryOf(state.scenes, id)
        : entryOf(state.sounds, id)) !== undefined;
  const noteSource = (source: unknown, use: ResourceUse) => {
    const resource = sourceResourceOf(source);
    if (resource && !has(resource.kind, resource.id)) {
      note(`${resource.kind}:${resource.id}`, resource, use);
    }
    const library = librarySourceOf(source);
    if (library) note(`library:${library.library}:${library.item}`, library, use);
  };
  const noteTransition = (
    ref: TransitionRef,
    media: TransitionMedia,
    use: TransitionUse,
    at: ResourceUse,
  ) => {
    const result = findTransition(ref, media, use);
    if (result.kind === "missing" && GONE.has(result.why.reason)) {
      note(refKey(use, ref), { kind: "transition", use, ref, why: result.why }, at);
    }
  };
  for (const [id, timeline] of Object.entries(state.timelines)) {
    for (const clip of Object.values(timeline.clips)) {
      noteSource(clip.source, { timeline: id, clip: clip.id });
      const media = mediaOf(timeline, clip.track);
      for (const [effect, type] of effectsIn(clip)) {
        const result = findEffect(type, media);
        if (result.kind === "missing" && result.why.reason !== "media") {
          note(
            `effect:${type}`,
            { kind: "effect", type, why: result.why },
            { timeline: id, clip: clip.id, effect },
          );
        }
      }
      for (const edge of ["enter", "exit"] as const) {
        const transition = clip[edge];
        if (transition) {
          noteTransition(transition, media, edge, { timeline: id, clip: clip.id, edge });
        }
      }
    }
    for (const [join, { from, to, track, transition }] of Object.entries(timeline.joins ?? {})) {
      if (!transition) continue;
      const clip = from ?? to;
      noteTransition(transition, mediaOf(timeline, track), "join", {
        timeline: id,
        join,
        ...(clip !== undefined && { clip }),
      });
    }
    for (const [version, { clips }] of Object.entries(timeline.overrides)) {
      for (const [clip, changes] of Object.entries(clips ?? {})) {
        if (changes.source) noteSource(changes.source.value, { timeline: id, clip, version });
      }
    }
  }
  return [...found.values()].map(
    ({ missing, uses }) => ({ ...missing, uses: sorted(state, uses) }) as MissingResource,
  );
}
