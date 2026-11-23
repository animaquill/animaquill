import {
  projectFrameRate,
  type CommandCall,
  type CommandFailure,
  type CommandResult,
  type ProjectState,
  type ProjectStore,
} from "@animaquill/core";
import { normalizeTime, type ProjectManifest } from "@animaquill/schema";
import type { TFunction } from "i18next";
import { commandFailedText } from "../i18n/failures.ts";
import type { Dialogs } from "../workbench/dialogs.ts";
import type { Notifications } from "../workbench/notifications.ts";
import {
  frameRateChange,
  isFrameRate,
  masterChange,
  rateLabel,
  ratioOf,
  sameRate,
} from "./changes.ts";

type ProjectFormat = ProjectManifest["formats"][number];
type Language = ProjectManifest["languages"][number];
type Tag = NonNullable<ProjectManifest["tags"]>[number];
type Credit = NonNullable<ProjectManifest["credits"]>[number];
type Cover = NonNullable<ProjectManifest["cover"]>;

export interface ProjectEditsOptions {
  readonly t: TFunction;
  readonly dialogs: Dialogs;
  readonly notifications: Notifications;
  /** The open project. */
  readonly store: () => ProjectStore | undefined;
  /** Where the playhead is, in seconds of which timeline: the moment the dialogs show. */
  readonly playhead: () => { readonly timeline: string; readonly seconds: number } | undefined;
  /** How many videos have proxies, which are made for the rate of editing. */
  readonly proxies: () => number;
  /**
   * A frame of the project as it would be, small, as a picture to show: the frame of a timeline at
   * a moment. Undefined where it cannot be drawn here.
   */
  readonly picture?: (
    state: ProjectState,
    timeline: string,
    seconds: number,
  ) => Promise<Blob | undefined>;
}

/**
 * What the project properties change, each as one step of the project that undo takes back, and
 * the changes that change what people see first asked about, with what they come to
 * (docs/design/settings-and-properties.md of AnimaQuill Cloud, 5.3). Says what went wrong where a
 * command did not happen; resolves to whether it did.
 */
export class ProjectEdits {
  readonly #options: ProjectEditsOptions;

  constructor(options: ProjectEditsOptions) {
    this.#options = options;
  }

  get #t(): TFunction {
    return this.#options.t;
  }

  /** Runs commands as one step; what went wrong goes to the notifications. */
  run(calls: CommandCall | readonly CommandCall[]): CommandResult | undefined {
    const store = this.#options.store();
    if (!store) return undefined;
    const result = Array.isArray(calls)
      ? store.executeBatch(calls)
      : store.execute(calls as CommandCall);
    if (!result.ok) this.#failed(result.error);
    return result;
  }

  #failed(failure: CommandFailure): void {
    this.#options.notifications.push(commandFailedText(this.#t, failure));
  }

  #ok = (calls: CommandCall | readonly CommandCall[]): boolean => this.run(calls)?.ok === true;

  #state(): ProjectState | undefined {
    return this.#options.store()?.getState();
  }

  rename(name: string): boolean {
    const trimmed = name.trim();
    if (trimmed === "" || trimmed === this.#state()?.manifest.name) return trimmed !== "";
    return this.#ok({ type: "project.rename", params: { name: trimmed } });
  }

  setDescription(description: string): boolean {
    if ((this.#state()?.manifest.description ?? "") === description) return true;
    return this.#ok({ type: "project.setDescription", params: { description } });
  }

  setCredits(credits: readonly Credit[]): boolean {
    return this.#ok({ type: "project.setCredits", params: { credits } });
  }

  /**
   * The tags, as a whole: locking or unlocking the project is asked about first, as it decides
   * whether anybody can change the project (5.2).
   */
  async setTags(tags: readonly Tag[]): Promise<boolean> {
    const state = this.#state();
    if (!state) return false;
    const t = this.#t;
    const wasLocked = state.manifest.tags?.some((tag) => tag.locked) === true;
    const isLocked = tags.some((tag) => tag.locked);
    if (isLocked !== wasLocked) {
      const sure = await this.#options.dialogs.confirm({
        title: t(isLocked ? "projectProps.tags.lockTitle" : "projectProps.tags.unlockTitle"),
        message: t(isLocked ? "projectProps.tags.lockMessage" : "projectProps.tags.unlockMessage"),
        confirm: t(isLocked ? "projectProps.tags.lock" : "projectProps.tags.unlock"),
        ...(isLocked && { danger: true }),
      });
      if (!sure) return false;
    }
    return this.#ok({ type: "project.setTags", params: { tags } });
  }

  /**
   * The rate of editing (5.3): what it comes to is said first, with whether the export frame rate
   * of the master goes along; both are one step.
   */
  async setFrameRate(fps: string): Promise<boolean> {
    const state = this.#state();
    if (!state) return false;
    const t = this.#t;
    if (!isFrameRate(fps)) {
      this.#options.notifications.push(t("notice.frameRateInvalid"));
      return false;
    }
    const to = normalizeTime(fps.trim());
    const change = frameRateChange(state, to, this.#options.playhead()?.seconds ?? 0);
    if (sameRate(change.from, to)) return true;
    const shown = rateLabel(to);
    const proxies = this.#options.proxies();
    const answer = await this.#options.dialogs.form({
      title: t("projectProps.fps.confirmTitle", { from: rateLabel(change.from), to: shown }),
      notesFirst: true,
      notes: [
        t("projectProps.fps.nothingMoves"),
        t("projectProps.fps.timecode", {
          to: shown,
          before: change.example.before,
          after: change.example.after,
        }),
        change.offGrid > 0
          ? t("projectProps.fps.offGrid", { count: change.offGrid, to: shown })
          : t("projectProps.fps.allOnGrid", { to: shown }),
        ...(proxies > 0 ? [t("projectProps.fps.proxies", { count: proxies, to: shown })] : []),
        t("projectProps.undoable"),
      ],
      fields: [
        {
          id: "master",
          label: t("projectProps.fps.master", { name: change.master.name }),
          options: [
            { id: "along", label: t("projectProps.fps.masterAlong", { to: shown }) },
            {
              id: "keep",
              label: t("projectProps.fps.masterKeep", { fps: rateLabel(change.master.fps) }),
            },
          ],
          value: change.masterAlong ? "along" : "keep",
        },
      ],
      confirm: t("projectProps.fps.confirm", { to: shown }),
    });
    if (!answer) return false;
    const calls: CommandCall[] = [{ type: "project.setFrameRate", params: { fps: to } }];
    if (answer.master === "along" && !sameRate(change.master.fps, to)) {
      const formats = state.manifest.formats.map((format, index) =>
        index === 0 ? { ...format, fps: to } : format,
      );
      calls.push({ type: "project.setFormats", params: { formats } });
    }
    return this.#ok(calls);
  }

  /**
   * The formats as a whole (5.3): a master of another size or shape, and formats that go with their
   * versions, are asked about first. A master of another shape can go in as a format of its own
   * instead, with the master as it is: what people most likely want.
   */
  async setFormats(formats: readonly ProjectFormat[], asked = 0): Promise<boolean> {
    const store = this.#options.store();
    const state = store?.getState();
    if (!store || !state) return false;
    const t = this.#t;
    const before = state.manifest.formats;
    const call = { type: "project.setFormats", params: { formats } } as const;
    const tried = store.execute(call, { dryRun: true });
    if (!tried.ok) {
      this.#failed(tried.error);
      return false;
    }
    const removed = (tried.results[0] as { filesRemoved?: readonly string[] } | undefined)
      ?.filesRemoved;
    const change = masterChange(before, formats);
    const [was] = before;
    const [now] = formats;
    let chosen: readonly ProjectFormat[] = formats;
    if (change === "ratio" && was && now) {
      const answer = await this.#askRatio(state, formats, was, now, removed);
      if (answer === undefined) return false;
      if (answer === "add") chosen = asAnotherFormat(before, formats, now, t);
    } else if (change === "size" && was && now) {
      const larger = now.width * now.height > was.width * was.height;
      const proxies = this.#options.proxies();
      const sure = await this.#options.dialogs.confirm({
        title: t("projectProps.size.title", { width: now.width, height: now.height }),
        message: [
          t(larger ? "projectProps.size.larger" : "projectProps.size.smaller"),
          ...(proxies > 0 ? [t("projectProps.size.proxies", { count: proxies })] : []),
        ].join(""),
        confirm: t("projectProps.size.confirm"),
        ...(removed && { details: [this.#removedDetail(removed)] }),
      });
      if (!sure) return false;
    } else if (removed && removed.length > 0) {
      const sure = await this.#options.dialogs.confirm({
        title: t("projectProps.formats.removeTitle"),
        message: t("projectProps.formats.removeMessage", { count: removed.length }),
        confirm: t("projectProps.formats.remove"),
        danger: true,
        details: [this.#removedDetail(removed)],
      });
      if (!sure) return false;
    }
    const writing = { type: "project.setFormats", params: { formats: chosen } } as const;
    // Another window may have changed the project while people read: what goes along is asked
    // about again where it is not what they saw.
    if (chosen === formats && asked < 2 && !sameFiles(removed, filesRemovedBy(store, writing)))
      return this.setFormats(formats, asked + 1);
    // Without a rate of its own, the project edits at the rate of the master: that stays as it is
    // when the master or its rate changes, as one step with it.
    const rate = projectFrameRate(store.getState().manifest);
    const [master] = chosen;
    const pin =
      store.getState().manifest.fps === undefined &&
      master !== undefined &&
      !sameRate(master.fps, rate)
        ? [{ type: "project.setFrameRate", params: { fps: rate } }]
        : [];
    return this.#ok([...pin, writing]);
  }

  /** What a master of another shape comes to, with the frame before and after it (5.3). */
  async #askRatio(
    state: ProjectState,
    formats: readonly ProjectFormat[],
    was: ProjectFormat,
    now: ProjectFormat,
    removed: readonly string[] | undefined,
  ): Promise<"change" | "add" | undefined> {
    const t = this.#t;
    const pictures = await this.#beforeAndAfter(state, formats);
    try {
      const answer = await this.#options.dialogs.choose({
        title: t("projectProps.ratio.title", {
          from: ratioOf(was.width, was.height),
          to: ratioOf(now.width, now.height),
        }),
        message: t("projectProps.ratio.message"),
        notes: [
          t("projectProps.ratio.suggest"),
          ...(this.#options.proxies() > 0
            ? [t("projectProps.size.proxies", { count: this.#options.proxies() })]
            : []),
          ...(removed && removed.length > 0
            ? [t("projectProps.formats.removeMessage", { count: removed.length })]
            : []),
          t("projectProps.undoable"),
        ],
        pictures,
        choices: [
          { id: "change", label: t("projectProps.ratio.change") },
          { id: "add", label: t("projectProps.ratio.add"), kind: "primary" },
        ],
      });
      return answer === "change" || answer === "add" ? answer : undefined;
    } finally {
      for (const { url } of pictures) URL.revokeObjectURL(url);
    }
  }

  /** The frame at the playhead, as the master shows it now and would show it. */
  async #beforeAndAfter(
    state: ProjectState,
    formats: readonly ProjectFormat[],
  ): Promise<{ label: string; url: string }[]> {
    const draw = this.#options.picture;
    const at = this.#options.playhead();
    const timeline = at?.timeline ?? state.manifest.timelines[0];
    if (!draw || timeline === undefined) return [];
    const after = { ...state, manifest: { ...state.manifest, formats: [...formats] } };
    const seconds = at?.seconds ?? 0;
    const t = this.#t;
    try {
      const [first, second] = await Promise.all([
        draw(state, timeline, seconds),
        draw(after, timeline, seconds),
      ]);
      if (!first || !second) return [];
      return [
        { label: t("projectProps.ratio.before"), url: URL.createObjectURL(first) },
        { label: t("projectProps.ratio.after"), url: URL.createObjectURL(second) },
      ];
    } catch (error) {
      console.warn("The frames before and after could not be drawn", error);
      return [];
    }
  }

  #removedDetail(files: readonly string[]) {
    return { title: this.#t("projectProps.removedFiles"), items: files };
  }

  /**
   * The languages as a whole: one that goes takes its strings and versions along, which people see
   * listed first (5.2).
   */
  async setLanguages(languages: readonly Language[], asked = 0): Promise<boolean> {
    const store = this.#options.store();
    if (!store) return false;
    const t = this.#t;
    const call = { type: "project.setLanguages", params: { languages } } as const;
    const tried = store.execute(call, { dryRun: true });
    if (!tried.ok) {
      this.#failed(tried.error);
      return false;
    }
    const removed = (tried.results[0] as { filesRemoved?: readonly string[] } | undefined)
      ?.filesRemoved;
    const gone = store
      .getState()
      .manifest.languages.filter(({ id }) => !languages.some((language) => language.id === id));
    if (gone.length > 0) {
      const sure = await this.#options.dialogs.confirm({
        title: t("projectProps.languages.removeTitle", {
          name: gone.map(({ name }) => name).join("、"),
        }),
        message: removed?.length
          ? t("projectProps.languages.removeFiles", { count: removed.length })
          : t("projectProps.languages.removeNothing"),
        confirm: t("projectProps.languages.remove"),
        danger: true,
        ...(removed?.length && { details: [this.#removedDetail(removed)] }),
      });
      if (!sure) return false;
      if (asked < 2 && !sameFiles(removed, filesRemovedBy(store, call)))
        return this.setLanguages(languages, asked + 1);
    }
    return this.#ok(call);
  }

  /** The background of every timeline: one step. */
  setBackground(background: string | null): boolean {
    const state = this.#state();
    if (!state) return false;
    const calls = Object.keys(state.timelines).map((timeline) => ({
      type: "timeline.setBackground",
      params: { timeline, background },
    }));
    return calls.length > 0 && this.#ok(calls);
  }

  setTimelineBackground(timeline: string, background: string | null): boolean {
    return this.#ok({ type: "timeline.setBackground", params: { timeline, background } });
  }

  renameTimeline(timeline: string, name: string): boolean {
    const trimmed = name.trim();
    if (trimmed === "") return false;
    if (this.#state()?.timelines[timeline]?.name === trimmed) return true;
    return this.#ok({ type: "timeline.rename", params: { timeline, name: trimmed } });
  }

  setDefaultTimeline(timeline: string): boolean {
    return this.#ok({ type: "timeline.setDefault", params: { timeline } });
  }

  setCover(cover: Cover | null): boolean {
    return this.#ok({ type: "project.setCover", params: { cover } });
  }

  /** Where new assets go: `null` as the mode has it, see `defaultToWrite`. */
  setDefaultStorage(defaultStorage: ProjectManifest["defaultStorage"] | null): boolean {
    return this.#ok({ type: "project.setDefaultStorage", params: { defaultStorage } });
  }
}

/** What a command would take along, as a dry run says now. */
function filesRemovedBy(store: ProjectStore, call: CommandCall): readonly string[] | undefined {
  const tried = store.execute(call, { dryRun: true });
  return tried.ok
    ? (tried.results[0] as { filesRemoved?: readonly string[] } | undefined)?.filesRemoved
    : undefined;
}

const sameFiles = (a: readonly string[] | undefined, b: readonly string[] | undefined) =>
  (a ?? []).join("\n") === (b ?? []).join("\n");

/**
 * The formats with the new shape as a format of its own, and the master as it was: what the dialog
 * suggests in place of changing the shape of the master (5.3).
 */
export function asAnotherFormat(
  before: readonly ProjectFormat[],
  wanted: readonly ProjectFormat[],
  now: ProjectFormat,
  t: TFunction,
): readonly ProjectFormat[] {
  const [master] = before;
  if (!master) return wanted;
  const rest = wanted.filter((format) => format.id !== master.id && format.id !== now.id);
  const taken = [master.id, ...rest.map(({ id }) => id)];
  const id = taken.includes(now.id) || now.id === master.id ? freshId(now, taken) : now.id;
  const name =
    now.id === master.id
      ? t("projectProps.ratio.newName", { ratio: ratioOf(now.width, now.height) })
      : now.name;
  return [master, ...rest, { ...now, id, name }];
}

function freshId(format: ProjectFormat, taken: readonly string[]): string {
  const base =
    format.width > format.height
      ? "landscape"
      : format.width < format.height
        ? "vertical"
        : "square";
  if (!taken.includes(base)) return base;
  for (let number = 2; ; number += 1) {
    const id = `${base}-${number}`;
    if (!taken.includes(id)) return id;
  }
}
