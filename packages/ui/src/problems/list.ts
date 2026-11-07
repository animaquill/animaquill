import type { SceneProblem } from "@animaquill/scene";
import { Emitter } from "../workbench/emitter.ts";

export type ProblemSeverity = "error" | "warning";

/** One line of the list of problems. */
export interface ListedProblem {
  /** The same problem has the same id, wherever it comes from and however often. */
  readonly id: string;
  readonly severity: ProblemSeverity;
  /** What it says, in words. */
  readonly text: string;
  /** The path in the project, if it is about a file. */
  readonly file?: string;
  readonly line?: number;
  readonly column?: number;
  /** Where in a document, for what has no line, such as `tracks.0.clips.3`. */
  readonly place?: string;
  /** Who says so: the clip with the scene, the code editor, or an import. */
  readonly origin: string;
}

export interface ProblemsSnapshot {
  readonly problems: readonly ListedProblem[];
  readonly errors: number;
  readonly warnings: number;
  /** Whether any of them came with an import. Nothing can make those go away but people. */
  readonly imported: boolean;
}

type Listed = Omit<ListedProblem, "id">;

/** One problem of a scene, in the state of the scene it came from. */
interface SceneEntry {
  readonly problem: ListedProblem;
  /** Goes for several clips when they show the same scene, which fails the same way. */
  readonly clips: Map<string, string>;
}

/** More than anybody reads, and a project can have as many of them as it likes. */
const MAX_PROBLEMS = 500;

const NOTHING: ProblemsSnapshot = { problems: [], errors: 0, warnings: 0, imported: false };

/** Code that failed is an error. What did not load or cannot work in a scene may not matter. */
export const severityOf = ({ kind }: Pick<SceneProblem, "kind">): ProblemSeverity =>
  kind === "error" || kind === "rejection" ? "error" : "warning";

const idOf = ({ severity, text, file, line, column, place }: Listed) =>
  JSON.stringify([severity, text, file, line, column, place]);

const withId = (problem: Listed): ListedProblem => ({ ...problem, id: idOf(problem) });

/** Files first, in order, and in a file by where it is. What is about no file goes last. */
function compare(a: ListedProblem, b: ListedProblem): number {
  if ((a.file === undefined) !== (b.file === undefined)) return a.file === undefined ? 1 : -1;
  return (
    (a.file ?? "").localeCompare(b.file ?? "") ||
    (a.line ?? 0) - (b.line ?? 0) ||
    (a.column ?? 0) - (b.column ?? 0)
  );
}

/**
 * What is wrong with the open project, from everybody who can tell. Each of them only ever speaks
 * for itself: a scene that got a new state takes its own problems along, and nothing else. The list
 * stays when panels come and go, so it lives here.
 */
export class ProblemList {
  readonly #emitter = new Emitter();
  readonly #scenes = new Map<string, SceneEntry>();
  /** Scenes that do not run, by clip. */
  readonly #stopped = new Map<string, ListedProblem>();
  /** What the code editor sees in open files, by path. */
  readonly #files = new Map<string, readonly ListedProblem[]>();
  #imported: readonly ListedProblem[] = [];
  #snapshot = NOTHING;

  subscribe = this.#emitter.subscribe;
  getSnapshot = (): ProblemsSnapshot => this.#snapshot;

  #changed(): void {
    const seen = new Map<string, ListedProblem>();
    const add = (problem: ListedProblem) => {
      if (!seen.has(problem.id)) seen.set(problem.id, problem);
    };
    for (const { problem } of this.#scenes.values()) add(problem);
    for (const problem of this.#stopped.values()) add(problem);
    for (const problems of this.#files.values()) problems.forEach(add);
    this.#imported.forEach(add);
    const problems = [...seen.values()].toSorted(compare);
    const errors = problems.filter(({ severity }) => severity === "error").length;
    this.#snapshot = {
      problems,
      errors,
      warnings: problems.length - errors,
      imported: this.#imported.length > 0,
    };
    this.#emitter.emit();
  }

  /** Something a scene said, as it was put in words. */
  noteScene(clip: string, revision: string, listed: Listed): void {
    const problem = withId(listed);
    const known = this.#scenes.get(problem.id);
    if (known) {
      known.clips.set(clip, revision);
      return;
    }
    if (this.#scenes.size >= MAX_PROBLEMS) return;
    this.#scenes.set(problem.id, { problem, clips: new Map([[clip, revision]]) });
    this.#changed();
  }

  /** Which state of its scene each clip shows now. What came from another one is over. */
  keepRevisions(revisions: ReadonlyMap<string, string>): void {
    let changed = false;
    for (const [id, { clips }] of this.#scenes) {
      for (const [clip, revision] of clips) {
        if (revisions.get(clip) !== revision) clips.delete(clip);
      }
      if (clips.size === 0) {
        this.#scenes.delete(id);
        changed = true;
      }
    }
    for (const clip of this.#stopped.keys()) {
      if (!revisions.has(clip)) changed = this.#stopped.delete(clip) || changed;
    }
    if (changed) this.#changed();
  }

  /** A scene that stopped for good, or undefined once that is over. */
  noteStopped(clip: string, listed: Listed | undefined): void {
    if (listed) this.#stopped.set(clip, withId(listed));
    else if (!this.#stopped.delete(clip)) return;
    this.#changed();
  }

  /** All that is wrong with an open file right now, as far as the code editor can see. */
  setFile(path: string, problems: readonly Listed[]): void {
    if (problems.length === 0 && !this.#files.has(path)) return;
    if (problems.length > 0) this.#files.set(path, problems.slice(0, MAX_PROBLEMS).map(withId));
    else this.#files.delete(path);
    this.#changed();
  }

  /** What an import found. Nobody looks at it again, so it stays until people clear it. */
  noteImport(problems: readonly Listed[]): void {
    this.#imported = problems.slice(0, MAX_PROBLEMS).map(withId);
    this.#changed();
  }

  clearImport(): void {
    if (this.#imported.length === 0) return;
    this.#imported = [];
    this.#changed();
  }

  /** Another project has problems of its own. */
  clear(): void {
    this.#scenes.clear();
    this.#stopped.clear();
    this.#files.clear();
    this.#imported = [];
    if (this.#snapshot === NOTHING) return;
    this.#snapshot = NOTHING;
    this.#emitter.emit();
  }
}
