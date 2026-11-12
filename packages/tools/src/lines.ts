import {
  clipEnd,
  effectsOf,
  orderedSections,
  type ClipState,
  type ProjectState,
  type TimelineState,
} from "@animaquill/core";
import {
  add,
  formatTime,
  isAnimation,
  parseTime,
  type Asset,
  type Transition,
} from "@animaquill/schema";
import { named, quoted } from "./context.ts";

/**
 * Objects as results show them: one compact line each, the id first and unquoted, the name quoted,
 * times in seconds as `start..end`, the rest as `key=value` with the keys that operations take, so
 * that what the model reads it can write back.
 */

const end = (clip: ClipState) => {
  try {
    return formatTime(clipEnd(clip));
  } catch {
    return "?";
  }
};

/** What a clip shows, as `asset=…`, `scene=…` and the like. */
export function sourceText(source: unknown): string {
  const value = (source ?? {}) as Record<string, unknown>;
  const kind = String(value.kind ?? "?");
  const media = value.media as Record<string, unknown> | undefined;
  if (media?.asset !== undefined) return `${kind} asset=${String(media.asset)}`;
  if (media?.library !== undefined)
    return `${kind} library=${String(media.library)}:${String(media.path)}`;
  if (kind === "scene" || kind === "sound") {
    if (value[kind] !== undefined) return `${kind}=${String(value[kind])}`;
    return `${kind} library=${String(value.library)}:${String(value.resource)}`;
  }
  if (kind === "color") return `color=${String(value.color)}`;
  if (kind === "caption") {
    const text = value.text;
    return typeof text === "string" ? `caption text=${quoted(text)}` : "caption";
  }
  return `kind=${kind}`;
}

/** A transition, as `fade(0.5)`. */
export function transitionText(transition: Partial<Transition> | undefined): string {
  if (!transition) return "none";
  const value = transition as Record<string, unknown>;
  const what =
    value.type ?? value.transition ?? `${String(value.library)}:${String(value.resource)}`;
  return `${String(what)}(${String(value.duration ?? "?")})`;
}

/** One clip, as timeline lists show it. */
export function clipLine(clip: ClipState): string {
  const properties = Object.entries(clip.properties ?? {});
  const animated = properties.filter(([, value]) => isAnimation(value)).length;
  const effects = effectsOf(clip).map(({ id, type }) => (id === type ? type : `${id}:${type}`));
  const parts = [
    named(clip.id, clip.name),
    `track=${clip.track}`,
    `${clip.start}..${end(clip)}`,
    sourceText(clip.source),
    ...(clip.offset !== undefined ? [`offset=${clip.offset}`] : []),
    ...(clip.loop ? ["loop"] : []),
    ...(clip.hidden ? ["hidden"] : []),
    ...(clip.draft ? ["draft"] : []),
    ...(clip.link !== undefined ? [`link=${clip.link}`] : []),
    ...(clip.enter ? [`enter=${transitionText(clip.enter)}`] : []),
    ...(clip.exit ? [`exit=${transitionText(clip.exit)}`] : []),
    ...(effects.length > 0 ? [`effects=${effects.join(",")}`] : []),
    ...(properties.length > 0 ? [`props=${properties.length}`] : []),
    ...(animated > 0 ? [`animated=${animated}`] : []),
  ];
  return parts.join(" ");
}

/** The sections of a timeline, end to end, in one line. */
export function sectionsLine(timeline: TimelineState): string {
  let at = parseTime("0");
  const parts = orderedSections(timeline).map((section) => {
    const from = formatTime(at);
    at = add(at, parseTime(section.duration));
    return `${named(section.id, section.name)} ${from}..${formatTime(at)}`;
  });
  return `sections: ${parts.join(" | ")}`;
}

/** An asset in a few words. */
export function assetLine(id: string, asset: Asset): string {
  const info = asset.info;
  const parts = [
    named(id, asset.name),
    asset.kind,
    `path=${quoted(asset.path)}`,
    ...(info?.duration !== undefined ? [`${info.duration}s`] : []),
    ...(info?.width !== undefined && info.height !== undefined
      ? [`${info.width}x${info.height}`]
      : []),
  ];
  return parts.join(" ");
}

/** A scene or sound in a few words. */
export const codeLine = (
  id: string,
  manifest: { readonly name?: string; readonly entry: string },
) => `${named(id, manifest.name)} entry=${manifest.entry}`;

/** All files of the project's code, by path. */
export const codeFiles = (state: ProjectState): readonly string[] =>
  Object.keys(state.files).toSorted();
