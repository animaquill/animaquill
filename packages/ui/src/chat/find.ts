import { entryOf, sourceResourceOf, type ClipState, type ProjectState } from "@animaquill/core";
import { formatAddress } from "@animaquill/tools";
import type { TFunction } from "i18next";
import { textOf } from "../properties/names.ts";
import { changeName } from "./objectName.ts";
import { shortName, type ChatRef } from "./refs.ts";

/**
 * What `@` in the input box finds by its name (docs/design/chat-panel.md of AnimaQuill Cloud, 3.3):
 * clips and markers of the timelines, the one shown first, and the assets, scenes and sounds of the
 * project. Each as the block it goes in as, the same as for what is selected (`pointing.ts`).
 */

/** What `@` finds, in the order the menu groups it. */
export const FOUND_KINDS = ["clip", "asset", "scene", "sound", "marker"] as const;
export type FoundKind = (typeof FOUND_KINDS)[number];

export interface FoundGroup {
  readonly kind: FoundKind;
  /** The first so many found, as blocks. */
  readonly refs: readonly ChatRef[];
  /** How many there are in all. */
  readonly total: number;
}

interface Hit {
  readonly name: string;
  /** Whether the name starts with what was typed: those come first. */
  readonly starts: boolean;
  /** Where the timeline is among those looked at, then when on it: the order of a timeline. */
  readonly rank: number;
  readonly at: () => number;
  readonly ref: () => ChatRef;
}

/** A time as seconds, to put things in order: quick, for every clip found in a big project. */
const seconds = (time: string | undefined): number => {
  if (time === undefined) return 0;
  const slash = time.indexOf("/");
  const value =
    slash < 0 ? Number(time) : Number(time.slice(0, slash)) / Number(time.slice(slash + 1));
  return Number.isFinite(value) ? value : 0;
};

/** A moment as a marker without a name says it: 1:05. */
const clock = (at: number): string => {
  const whole = Math.max(0, Math.floor(at));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
};

/** A clip as a block says it: a caption by its words, any other by its name. */
export function clipLabelOf(
  t: TFunction,
  state: ProjectState,
  timeline: string,
  id: string,
): string {
  const clip = entryOf(entryOf(state.timelines, timeline)?.clips, id);
  if (clip?.source.kind === "caption" && !clip.name) {
    return t("chat.refs.caption", {
      name: shortName(String(clip.source.text)),
      interpolation: { escapeValue: false },
    });
  }
  // Its name, else the name of what it shows, else what kind it is: never a number of its own.
  const kind = clip?.source.kind ?? "";
  const shows =
    clip && sourceResourceOf(clip.source)
      ? changeName(t, { kind: "clip", id, timeline }, state)
      : undefined;
  const name = clip?.name || shows || textOf(t, `timeline.kind.${kind}`, kind || id);
  return t("chat.refs.clip", { name: shortName(name), interpolation: { escapeValue: false } });
}

/**
 * The name `@` finds a clip by: its own, the words of a caption, the name of what it shows, else
 * what kind it is. Cheap, for every clip of a big project: the label of a block is only made for
 * those that show.
 */
function clipName(t: TFunction, state: ProjectState, clip: ClipState): string {
  if (clip.name) return clip.name;
  if (clip.source.kind === "caption") return String(clip.source.text ?? "");
  const source = sourceResourceOf(clip.source);
  const resource =
    source?.kind === "asset"
      ? entryOf(state.assets, source.id)
      : source?.kind === "scene"
        ? entryOf(state.scenes, source.id)
        : source?.kind === "sound"
          ? entryOf(state.sounds, source.id)
          : undefined;
  return resource?.name || textOf(t, `timeline.kind.${clip.source.kind}`, clip.source.kind);
}

export interface FindOptions {
  readonly t: TFunction;
  /** The timeline shown, whose clips and markers come first. */
  readonly shown: string | undefined;
  /** At most so many of each kind, as blocks. */
  readonly limit: number;
}

/**
 * What of the project is called what was typed (any case, anywhere in the name), by kind: those
 * whose names start with it first, then by timeline and time, resources by name.
 */
export function findIn(
  state: ProjectState,
  query: string,
  { t, shown, limit }: FindOptions,
): readonly FoundGroup[] {
  const wanted = query.trim().toLowerCase();
  const hits: Record<FoundKind, Hit[]> = { clip: [], asset: [], scene: [], sound: [], marker: [] };
  /** Where what was typed is in a name: nowhere is -1. */
  const where = (name: string) => (wanted === "" ? 0 : name.toLowerCase().indexOf(wanted));
  const order = [
    ...(shown !== undefined && entryOf(state.timelines, shown) ? [shown] : []),
    ...state.manifest.timelines.filter((id) => id !== shown),
    ...Object.keys(state.timelines).filter(
      (id) => id !== shown && !state.manifest.timelines.includes(id),
    ),
  ];
  order.forEach((timelineId, rank) => {
    const timeline = entryOf(state.timelines, timelineId);
    if (!timeline) return;
    for (const clip of Object.values(timeline.clips)) {
      const name = clipName(t, state, clip);
      const at = where(name);
      if (at < 0) continue;
      hits.clip.push({
        name,
        starts: at === 0,
        rank,
        at: () => seconds(clip.start),
        ref: () => ({
          label: clipLabelOf(t, state, timelineId, clip.id),
          href: formatAddress({ kind: "object", id: clip.id, timeline: timelineId }),
        }),
      });
    }
    for (const marker of Object.values(timeline.markers)) {
      const time = () => clock(seconds(marker.time));
      const own = marker.name ?? "";
      const name = own || time();
      const at = where(name);
      if (at < 0) continue;
      hits.marker.push({
        name,
        starts: at === 0,
        rank,
        at: () => seconds(marker.time),
        ref: () => ({
          label: own
            ? t("chat.refs.marker", { name: shortName(own), interpolation: { escapeValue: false } })
            : t("chat.refs.markerAt", { time: time() }),
          href: formatAddress({ kind: "object", id: marker.id, timeline: timelineId }),
        }),
      });
    }
  });
  const resources = [
    ["asset", state.assets ?? {}],
    ["scene", state.scenes],
    ["sound", state.sounds],
  ] as const;
  for (const [kind, map] of resources) {
    for (const [id, named] of Object.entries(map)) {
      const name = (named as { readonly name?: string }).name || id;
      const at = where(name);
      if (at < 0) continue;
      hits[kind].push({
        name,
        starts: at === 0,
        rank: 0,
        at: () => 0,
        ref: () => ({
          label: t(`chat.refs.${kind}`, {
            name: shortName(name),
            interpolation: { escapeValue: false },
          }),
          href: formatAddress({ kind: "object", id, timeline: undefined }),
        }),
      });
    }
  }
  return FOUND_KINDS.flatMap((kind) => {
    const all = hits[kind];
    if (all.length === 0) return [];
    const timed = kind === "clip" || kind === "marker";
    const first = all
      .map((hit) => ({ hit, at: timed ? hit.at() : 0 }))
      .toSorted(
        (a, b) =>
          Number(b.hit.starts) - Number(a.hit.starts) ||
          a.hit.rank - b.hit.rank ||
          a.at - b.at ||
          (timed ? 0 : a.hit.name.localeCompare(b.hit.name)),
      )
      .slice(0, limit);
    return [{ kind, refs: first.map(({ hit }) => hit.ref()), total: all.length }];
  });
}
