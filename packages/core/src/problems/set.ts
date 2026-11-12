import type { ProjectState } from "../model.ts";
import {
  MAX_PROBLEMS,
  compareProblems,
  type ProblemSource,
  type ProjectProblem,
  type ReportedSource,
} from "./model.ts";
import { staticProblems, type StaticInputs } from "./static.ts";

export interface ProblemSetOptions extends StaticInputs {
  /** What the host reports by itself, see `report`. Only those are said to be checked. */
  readonly reports?: readonly ReportedSource[];
}

const NOTHING: readonly ProjectProblem[] = [];

/** The id says what and where; how bad, what it makes of an export and what fixes it can change. */
const sameAs = (a: ProjectProblem, b: ProjectProblem | undefined) =>
  b !== undefined &&
  a.id === b.id &&
  a.severity === b.severity &&
  a.affectsOutput === b.affectsOutput &&
  JSON.stringify(a.fix) === JSON.stringify(b.fix);

const same = (a: readonly ProjectProblem[], b: readonly ProjectProblem[]) =>
  a.length === b.length && a.every((problem, index) => sameAs(problem, b[index]));

/**
 * All problems of one project: what the project alone tells, worked out again on `update`, and what
 * the host reports, each group of a source replaced as a whole. Listeners hear of it only when the
 * list is another one.
 */
export class ProblemSet {
  readonly #options: ProblemSetOptions;
  #static: readonly ProjectProblem[] = NOTHING;
  readonly #reported = new Map<string, readonly ProjectProblem[]>();
  #all: readonly ProjectProblem[] = NOTHING;
  readonly #listeners = new Set<() => void>();

  constructor(options: ProblemSetOptions = {}) {
    this.#options = options;
  }

  /** The project as it is now, or nothing when there is none. The host waits for a burst of changes. */
  update(state: ProjectState | undefined): void {
    const next = state ? staticProblems(state, this.#options) : NOTHING;
    if (same(next, this.#static)) return;
    this.#static = next;
    this.#changed();
  }

  /** All that a source says of one thing, such as an open file: nothing makes it go away. */
  report(source: ReportedSource, key: string, problems: readonly ProjectProblem[]): void {
    const group = `${source}\u0000${key}`;
    const known = this.#reported.get(group) ?? NOTHING;
    if (problems.length === 0 && known.length === 0) return;
    if (problems.length === 0) this.#reported.delete(group);
    else this.#reported.set(group, problems.slice(0, MAX_PROBLEMS));
    if (same(problems, known)) return;
    this.#changed();
  }

  /** Another project: nothing of the last one stays. */
  clear(): void {
    const had = this.#all.length > 0;
    this.#static = NOTHING;
    this.#reported.clear();
    this.#all = NOTHING;
    if (had) this.#emit();
  }

  /** Each problem once, files first, at most `MAX_PROBLEMS`. */
  all(): readonly ProjectProblem[] {
    return this.#all;
  }

  /** Where the problems come from here: a command line runs no scenes, so it has no `runtime`. */
  sources(): readonly ProblemSource[] {
    return [
      "unsupported",
      ...(this.#options.describe ? (["properties"] as const) : []),
      ...(this.#options.reports ?? []),
    ];
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  #changed(): void {
    const seen = new Map<string, ProjectProblem>();
    const add = (problem: ProjectProblem) => {
      if (!seen.has(problem.id)) seen.set(problem.id, problem);
    };
    for (const problems of this.#reported.values()) problems.forEach(add);
    this.#static.forEach(add);
    const all = [...seen.values()].toSorted(compareProblems).slice(0, MAX_PROBLEMS);
    if (same(all, this.#all)) {
      // The same problems, but what they hold can be newer, such as the words of a host.
      this.#all = all;
      return;
    }
    this.#all = all;
    this.#emit();
  }

  #emit(): void {
    for (const listener of this.#listeners) listener();
  }
}
