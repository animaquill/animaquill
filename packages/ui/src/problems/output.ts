import {
  masterLimited,
  curveProblems,
  outputProblems,
  unsupportedProblems,
  type OutputQuery,
  type ProjectProblem,
  type ProjectState,
} from "@animaquill/core";
import type { TFunction } from "i18next";
import type { Dialogs } from "../workbench/dialogs.ts";
import { describeProjectProblem, originOf } from "./words.ts";

/** Before an export: what of it would be otherwise than the project says, and whether to go on. */
export interface OutputCheck {
  /** Resolves to whether to export. Without such problems it is true right away, and asks nothing. */
  confirm(state: ProjectState, query: OutputQuery): Promise<boolean>;
}

/** More than a dialog should show: the rest is a line that says how many. */
const MAX_LISTED = 30;

/**
 * Where the sound of an export would clip, in seconds on the timeline: what the master gives above
 * 0 dBFS, which only happens with its safe limiter off. Mixes the stretch that goes out.
 */
export type ClipsOf = (
  state: ProjectState,
  query: OutputQuery,
) => Promise<readonly { readonly from: number }[]>;

/**
 * Asks before an export that would not be what the project says, because this editor does not do
 * all of it yet, or goes linearly where keys say what it cannot work out. Each line goes to where it is; people can still export, which is what they want
 * when they only want to see what there is. Cancelling is what Enter does.
 */
export class OutputDifferences implements OutputCheck {
  readonly #dialogs: Dialogs;
  readonly #t: TFunction;
  readonly #goTo: (problem: ProjectProblem) => void;
  readonly #clipsOf: ClipsOf | undefined;
  readonly #seek: (timeline: string, seconds: number) => void;

  constructor(options: {
    readonly dialogs: Dialogs;
    readonly t: TFunction;
    readonly goTo: (problem: ProjectProblem) => void;
    /** Where the sound would clip, see `ClipsOf`: only asked with the master's limiter off. */
    readonly clipsOf?: ClipsOf;
    /** Puts the playhead of a timeline somewhere, for a place where the sound clips. */
    readonly seek?: (timeline: string, seconds: number) => void;
  }) {
    this.#dialogs = options.dialogs;
    this.#t = options.t;
    this.#goTo = options.goTo;
    this.#clipsOf = options.clipsOf;
    this.#seek = options.seek ?? (() => {});
  }

  async confirm(state: ProjectState, query: OutputQuery): Promise<boolean> {
    // Worked out now: the list of problems waits for a burst of changes to end.
    const problems = [...unsupportedProblems(state), ...curveProblems(state)];
    const found = outputProblems(state, problems, query);
    const clips = this.#asksClips(state, query) ? await this.#clips(state, query) : [];
    if (found.length === 0 && clips.length === 0) return true;
    const t = this.#t;
    const items = found.slice(0, MAX_LISTED).map((problem) => {
      const origin = originOf(t, problem, state);
      const text = describeProjectProblem(t, problem, state, origin);
      return {
        label: t("problems.export.line", { origin, text, interpolation: { escapeValue: false } }),
        show: () => this.#goTo(problem),
      };
    });
    const more = found.length - items.length;
    const details = [];
    if (found.length > 0) {
      details.push({
        title: t("problems.export.list", { count: found.length }),
        items: more > 0 ? [...items, t("problems.export.more", { count: more })] : items,
      });
    }
    if (clips.length > 0) {
      details.push({
        title: t("problems.export.clipping", { count: clips.length }),
        items: clips.slice(0, MAX_LISTED).map(({ from }) => ({
          label: t("problems.export.clipAt", { seconds: from.toFixed(2) }),
          show: () => this.#seek(query.timeline, from),
        })),
      });
    }
    const onlyClips = found.length === 0;
    return this.#dialogs.confirm({
      title: t(
        onlyClips
          ? "problems.export.clippingTitle"
          : query.part === "picture"
            ? "problems.export.titleStill"
            : "problems.export.title",
      ),
      message: t(onlyClips ? "problems.export.clippingMessage" : "problems.export.message"),
      confirm: t("problems.export.anyway"),
      details,
    });
  }

  /**
   * Where the sound would clip (`master-clipping`): only with the master's safe limiter off, and
   * only for an export with sound. Nothing when that cannot be told.
   */
  #asksClips(state: ProjectState, query: OutputQuery): boolean {
    return (
      query.part !== "picture" &&
      this.#clipsOf !== undefined &&
      !masterLimited(state, query.timeline)
    );
  }

  async #clips(state: ProjectState, query: OutputQuery): Promise<readonly { from: number }[]> {
    try {
      return (await this.#clipsOf?.(state, query)) ?? [];
    } catch {
      return [];
    }
  }
}
