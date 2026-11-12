import {
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
 * Asks before an export that would not be what the project says, because this editor does not do
 * all of it yet. Each line goes to where it is; people can still export, which is what they want
 * when they only want to see what there is. Cancelling is what Enter does.
 */
export class OutputDifferences implements OutputCheck {
  readonly #dialogs: Dialogs;
  readonly #t: TFunction;
  readonly #goTo: (problem: ProjectProblem) => void;

  constructor(options: {
    readonly dialogs: Dialogs;
    readonly t: TFunction;
    readonly goTo: (problem: ProjectProblem) => void;
  }) {
    this.#dialogs = options.dialogs;
    this.#t = options.t;
    this.#goTo = options.goTo;
  }

  async confirm(state: ProjectState, query: OutputQuery): Promise<boolean> {
    // Worked out now: the list of problems waits for a burst of changes to end.
    const found = outputProblems(state, unsupportedProblems(state), query);
    if (found.length === 0) return true;
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
    return this.#dialogs.confirm({
      title: t(query.part === "picture" ? "problems.export.titleStill" : "problems.export.title"),
      message: t("problems.export.message"),
      confirm: t("problems.export.anyway"),
      details: [
        {
          title: t("problems.export.list", { count: found.length }),
          items: more > 0 ? [...items, t("problems.export.more", { count: more })] : items,
        },
      ],
    });
  }
}
