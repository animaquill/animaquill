import {
  CLIP_VISUAL,
  toSeconds,
  type MediaRef,
  type ObjectDescriptor,
  type PropertySpec,
  type Value,
} from "@animaquill/schema";
import { clipOffset, clipStart, entryOf, type ClipState, type ProjectState } from "./model.ts";
import { channelsOf, effectiveProperties, fitOf, formatOf, type Version } from "./render-plan.ts";
import { boxOf, stageOf, type Size } from "./view.ts";

const WITH_A_PICTURE = new Set(["video", "image", "color"]);

/**
 * The objects of a clip, which is everything about it that can be edited or animated. Whatever shows
 * or changes properties reads this instead of knowing them. Effects, scenes and code objects come in
 * here with the same description.
 */
export const objectsOf = (clip: ClipState): readonly ObjectDescriptor[] =>
  WITH_A_PICTURE.has(clip.source.kind) ? [CLIP_VISUAL] : [];

/** How large the media of a clip is, as far as the project knows. */
export function naturalSizeOf(state: ProjectState, clip: ClipState): Size | undefined {
  const { media } = clip.source as { readonly media?: MediaRef };
  const info = media && "asset" in media ? entryOf(state.assets, media.asset)?.info : undefined;
  return info?.width && info.height ? { width: info.width, height: info.height } : undefined;
}

const SIDES: Readonly<Record<string, keyof Size>> = {
  "transform.width": "width",
  "transform.height": "height",
};

/**
 * What a clip without this property uses at a moment on the timeline. Most have a default. A clip box
 * without a size follows the stage or the media, so that depends on where the clip is.
 */
export function valueWithout(
  state: ProjectState,
  clip: ClipState,
  spec: PropertySpec,
  time: number,
  version?: Version,
): Value | undefined {
  if (spec.default !== undefined) return spec.default;
  const side = entryOf(SIDES, spec.path);
  const format = formatOf(state, version);
  if (!side || !format) return undefined;
  const properties = effectiveProperties(clip, version);
  const layer = {
    fit: fitOf(properties),
    channels: channelsOf(properties),
    offset: toSeconds(clipOffset(clip)),
    start: toSeconds(clipStart(clip)),
  };
  return boxOf(layer, time, naturalSizeOf(state, clip), stageOf(format))[side];
}
