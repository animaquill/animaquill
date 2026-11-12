import { entryOf, orderedTracks, sourceResourceOf, type ProjectState } from "@animaquill/core";
import type { TFunction } from "i18next";
import type { TurnChange } from "./summary.ts";

/** Text from a project is text, whatever it looks like. */
const asText = { interpolation: { escapeValue: false } } as const;

/**
 * What people call an object a turn changed, as the editor calls it elsewhere: its name; for a clip
 * without one, the name of what it shows (the asset, scene or sound), else "片段" and its number on
 * its timeline; for a track without one, its kind and number. Never the inner id. Nothing where the
 * object is gone and the tool did not say its name.
 */
export function changeName(
  t: TFunction,
  change: Pick<TurnChange, "kind" | "id" | "timeline" | "name">,
  state: ProjectState | undefined,
): string | undefined {
  if (change.name) return change.name;
  if (!state) return undefined;
  const timelines =
    change.timeline !== undefined ? [change.timeline] : Object.keys(state.timelines ?? {});
  if (change.kind === "clip") {
    for (const id of timelines) {
      const timeline = entryOf(state.timelines, id);
      const clip = entryOf(timeline?.clips, change.id);
      if (!timeline || !clip) continue;
      if (clip.name) return clip.name;
      const source = sourceResourceOf(clip.source);
      const resource =
        source?.kind === "asset"
          ? entryOf(state.assets, source.id)
          : source?.kind === "scene"
            ? entryOf(state.scenes, source.id)
            : source?.kind === "sound"
              ? entryOf(state.sounds, source.id)
              : undefined;
      if (resource?.name) return resource.name;
      const number = Object.keys(timeline.clips).indexOf(change.id) + 1;
      return `${t("chat.kinds.clip")} ${number}`;
    }
    return undefined;
  }
  if (change.kind === "track") {
    for (const id of timelines) {
      const timeline = entryOf(state.timelines, id);
      const track = entryOf(timeline?.tracks, change.id);
      if (!timeline || !track) continue;
      if (track.name) return track.name;
      const number =
        orderedTracks(timeline as never)
          .filter(({ kind }) => kind === track.kind)
          .findIndex(({ id: each }) => each === track.id) + 1;
      return t(`timeline.track.${track.kind}`, { number, ...asText });
    }
    return undefined;
  }
  const named =
    change.kind === "timeline"
      ? entryOf(state.timelines, change.id)
      : change.kind === "scene"
        ? entryOf(state.scenes, change.id)
        : change.kind === "sound"
          ? entryOf(state.sounds, change.id)
          : change.kind === "asset"
            ? entryOf(state.assets, change.id)
            : undefined;
  if (named) return named.name;
  for (const id of timelines) {
    const timeline = entryOf(state.timelines, id);
    const found =
      change.kind === "marker"
        ? entryOf(timeline?.markers, change.id)
        : change.kind === "section"
          ? entryOf(timeline?.sections, change.id)
          : undefined;
    if (found) return found.name;
  }
  return undefined;
}
