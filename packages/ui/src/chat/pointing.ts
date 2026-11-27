import { entryOf, nameKeyOf, type ProjectState } from "@animaquill/core";
import { formatTime, parseTime, toSeconds } from "@animaquill/schema";
import { formatAddress, parseAddress, type Address } from "@animaquill/tools";
import type { TFunction } from "i18next";
import type { CodeDocuments } from "../code/documents.ts";
import type { KeyframeEditor } from "../keyframes/editor.ts";
import type { ExplorerState } from "../resources/explorer.ts";
import { textOf } from "../properties/names.ts";
import { parseProjectResourceId } from "../resources/project-resources.ts";
import type { TimelineEditor } from "../timeline/editor.ts";
import { formatTimecode, frameAt, frameTime } from "../timeline/frames.ts";
import { Emitter } from "../workbench/emitter.ts";
import type { ProjectSession } from "../workbench/session.ts";
import { clipLabelOf, findIn, type FoundGroup } from "./find.ts";
import { shortName, type ChatRef } from "./refs.ts";

/**
 * What the chat points at for people: the moment of the playhead, and what they selected last, on
 * the timeline (clips, captions), among the keys of the keyframes tab, in the explorer (an asset, a
 * scene, a sound) or in the code editor (lines). As blocks for their words to AI, see `refs.ts`, and
 * the other way round: where a block of a message or an answer points, to show and go to it.
 */

/** Where people selected last: that is what "the selected objects" are. */
export type PointedFrom = "timeline" | "keys" | "resource" | "lines";

export interface PointingSnapshot {
  readonly from: PointedFrom | undefined;
  /** How many things are selected there. */
  readonly count: number;
}

/** More than this many objects go as the first few and one block for the rest. */
export const MANY = 8;
/** As many blocks of their own as many objects get. */
export const FIRST = 3;
/** At most this many objects go at once. */
export const MOST = 200;

export interface ChatPointingOptions {
  readonly session: ProjectSession;
  readonly timeline: TimelineEditor;
  readonly keyframes: KeyframeEditor;
  readonly explorer: ExplorerState;
  readonly code: CodeDocuments;
  readonly t: TFunction;
  /** Whether a conversation of the project is still there, for a block that points to one. */
  readonly agentHere?: (id: string) => boolean;
}

/** The project's name of something a block points to, else nothing: it is not there any more. */
export type RefState = "here" | "gone" | "elsewhere";

export class ChatPointing {
  readonly #options: ChatPointingOptions;
  readonly #emitter = new Emitter();
  #snapshot: PointingSnapshot = { from: undefined, count: 0 };
  #seen: {
    clips: ReadonlySet<string>;
    keys: unknown;
    resource: string | undefined;
    lines: unknown;
  };

  constructor(options: ChatPointingOptions) {
    this.#options = options;
    const { timeline, keyframes, explorer, code } = options;
    this.#seen = {
      clips: timeline.getSnapshot().selection,
      keys: keyframes.getSnapshot().selection,
      resource: explorer.getSnapshot().selected,
      lines: code.selectedLines,
    };
    timeline.subscribe(() => this.#look());
    keyframes.subscribe(() => this.#look());
    explorer.subscribe(() => this.#look());
    code.subscribeLines(() => this.#look());
    this.#look();
  }

  subscribe = this.#emitter.subscribe;
  getSnapshot = (): PointingSnapshot => this.#snapshot;

  /** Follows what changed last, and how many are selected there now. */
  #look(): void {
    const { timeline, keyframes, explorer, code } = this.#options;
    const clips = timeline.getSnapshot().selection;
    const keys = keyframes.getSnapshot().selection;
    const resource = explorer.getSnapshot().selected;
    const lines = code.selectedLines;
    let from = this.#snapshot.from;
    // Taking something away from where people selected last leaves what is still selected there.
    // Keys selected select their clips too: that is still the keys.
    const ofKeys = from === "keys" && keys.size > 0 && [...keys.clips()].every((c) => clips.has(c));
    if (clips !== this.#seen.clips && clips.size > 0 && !ofKeys) from = "timeline";
    if (keys !== this.#seen.keys && keyframes.getSnapshot().selection.size > 0) from = "keys";
    if (resource !== this.#seen.resource && resource !== undefined) from = "resource";
    if (lines !== this.#seen.lines && lines !== undefined) from = "lines";
    this.#seen = { clips, keys, resource, lines };
    const count = (which: PointedFrom | undefined) =>
      which === "timeline"
        ? clips.size
        : which === "keys"
          ? keys.size
          : which === "resource"
            ? this.#resourceRef() === undefined
              ? 0
              : 1
            : which === "lines"
              ? lines === undefined
                ? 0
                : 1
              : 0;
    // Nothing there any more: what is still selected elsewhere, in this order.
    if (count(from) === 0) {
      from = (["timeline", "keys", "lines", "resource"] as const).find((each) => count(each) > 0);
    }
    const next = { from, count: count(from) };
    if (next.from === this.#snapshot.from && next.count === this.#snapshot.count) return;
    this.#snapshot = next;
    this.#emitter.emit();
  }

  get #state(): ProjectState | undefined {
    return this.#options.session.store?.getState();
  }

  /** The moment of the playhead, as a block: its timecode, and the exact time for AI. */
  timeRef(): ChatRef | undefined {
    const { timeline } = this.#options;
    const model = timeline.model;
    if (!model) return undefined;
    const frame = timeline.frame;
    return {
      label: formatTimecode(frame, model.rate),
      href: formatAddress({
        kind: "time",
        timeline: model.id,
        t: formatTime(frameTime(frame, model.rate)),
      }),
    };
  }

  /** What is selected, as blocks: more than `MANY` as the first `FIRST` and one for the rest. */
  selectedRefs(): readonly ChatRef[] {
    const all = this.#selected().slice(0, MOST);
    if (all.length <= MANY) return all.map(({ ref }) => ref);
    // The rest by the objects they are of: several keys of one clip are that clip once.
    const ids = [...new Set(all.slice(FIRST).map(({ id }) => id))];
    const timeline = this.#options.timeline.model?.id;
    return [
      ...all.slice(0, FIRST).map(({ ref }) => ref),
      {
        label: this.#options.t("chat.refs.more", { count: ids.length }),
        href: formatAddress({ kind: "objects", ids, timeline }),
      },
    ];
  }

  #selected(): readonly { readonly id: string; readonly ref: ChatRef }[] {
    const { from } = this.#snapshot;
    const state = this.#state;
    const { timeline, keyframes, code, t } = this.#options;
    const model = timeline.model;
    if (!state) return [];
    if (from === "timeline" && model) {
      const order = [...model.boxes.values()]
        .filter((box) => timeline.getSnapshot().selection.has(box.id))
        .toSorted((a, b) => a.start - b.start || a.id.localeCompare(b.id));
      return order.map((box) => ({
        id: box.id,
        ref: {
          label: this.#clipLabel(state, model.id, box.id),
          href: formatAddress({ kind: "object", id: box.id, timeline: model.id }),
        },
      }));
    }
    if (from === "keys" && model) {
      return [...keyframes.getSnapshot().selection].map((key) => {
        const seconds = toSeconds(parseTime(key.time));
        const at = formatTimecode(frameAt(seconds, model.rate), model.rate);
        return {
          id: key.clip,
          ref: {
            label: t("chat.refs.keyframe", {
              property: this.#propertyName(key.path),
              at,
              clip: this.#clipLabel(state, model.id, key.clip),
              interpolation: { escapeValue: false },
            }),
            href: formatAddress({
              kind: "keyframe",
              id: key.clip,
              timeline: model.id,
              property: key.path,
              t: key.time,
            }),
          },
        };
      });
    }
    if (from === "lines") {
      const lines = code.selectedLines;
      if (!lines) return [];
      const name = lines.path.slice(lines.path.lastIndexOf("/") + 1);
      return [
        {
          id: lines.path,
          ref: {
            label:
              lines.from === lines.to
                ? t("chat.refs.line", { file: name, line: lines.from })
                : t("chat.refs.lines", { file: name, from: lines.from, to: lines.to }),
            href: formatAddress({ kind: "file", path: lines.path, from: lines.from, to: lines.to }),
          },
        },
      ];
    }
    if (from === "resource") {
      const ref = this.#resourceRef();
      return ref ? [ref] : [];
    }
    return [];
  }

  #resourceRef(): { readonly id: string; readonly ref: ChatRef } | undefined {
    const selected = this.#options.explorer.getSnapshot().selected;
    const found = selected === undefined ? undefined : parseProjectResourceId(selected);
    const state = this.#state;
    if (!found || !state) return undefined;
    const named =
      found.kind === "asset"
        ? entryOf(state.assets, found.id)
        : found.kind === "scene"
          ? entryOf(state.scenes, found.id)
          : entryOf(state.sounds, found.id);
    if (!named) return undefined;
    return {
      id: found.id,
      ref: {
        label: this.#options.t(`chat.refs.${found.kind}`, {
          name: shortName(named.name ?? found.id),
          interpolation: { escapeValue: false },
        }),
        href: formatAddress({ kind: "object", id: found.id, timeline: undefined }),
      },
    };
  }

  #propertyName(path: string): string {
    const { t } = this.#options;
    const head = path.split(".")[0] ?? path;
    return textOf(t, `property.group.${head}`, textOf(t, `property.name.${nameKeyOf(path)}`, path));
  }

  #clipLabel(state: ProjectState, timeline: string, id: string): string {
    return clipLabelOf(this.#options.t, state, timeline, id);
  }

  /**
   * What of the project is called `query`, for `@` in the input box: clips and markers of the
   * timeline shown first, then of the others, and the assets, scenes and sounds, at most `limit`
   * of each kind as blocks (`find.ts`).
   */
  find(query: string, limit: number, state = this.#state): readonly FoundGroup[] {
    if (!state) return [];
    return findIn(state, query, {
      t: this.#options.t,
      shown: this.#options.timeline.model?.id,
      limit,
    });
  }

  /** Whether what a block points to is still in the project, and on the timeline shown. */
  stateOf(href: string, state = this.#state): RefState {
    const address = parseAddress(href);
    if (!address || !state) return "gone";
    const shown = this.#options.timeline.model?.id;
    const onTimeline = (timeline: string | undefined) =>
      timeline === undefined || timeline === shown ? "here" : "elsewhere";
    switch (address.kind) {
      case "time":
        return address.timeline === undefined || entryOf(state.timelines, address.timeline)
          ? onTimeline(address.timeline)
          : "gone";
      case "object":
      case "keyframe": {
        const timelines =
          address.timeline === undefined ? Object.keys(state.timelines) : [address.timeline];
        const onOne = timelines.some((each) => {
          const found = entryOf(state.timelines, each);
          return (
            entryOf(found?.clips, address.id) ??
            entryOf(found?.markers, address.id) ??
            entryOf(found?.tracks, address.id)
          );
        });
        if (onOne) return onTimeline(address.timeline);
        return (entryOf(state.assets, address.id) ??
          entryOf(state.scenes, address.id) ??
          entryOf(state.sounds, address.id) ??
          entryOf(state.timelines, address.id))
          ? "here"
          : "gone";
      }
      case "file":
        return entryOf(state.files, address.path) !== undefined ? "here" : "gone";
      case "objects":
        return "here";
      case "agent":
        return this.#options.agentHere?.(address.id) === false ? "gone" : "here";
    }
  }

  /** The clips a block points to on the timeline shown, to light up while the pointer is on it. */
  clipsOf(href: string): readonly string[] {
    const address: Address | undefined = parseAddress(href);
    const model = this.#options.timeline.model;
    if (!address || !model) return [];
    const on = "timeline" in address ? address.timeline : undefined;
    if (on !== undefined && on !== model.id) return [];
    const ids =
      address.kind === "object" || address.kind === "keyframe"
        ? [address.id]
        : address.kind === "objects"
          ? address.ids
          : [];
    return ids.filter((id) => model.boxes.has(id));
  }
}
