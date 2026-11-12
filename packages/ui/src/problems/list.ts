import {
  MAX_PROBLEMS,
  ProblemSet,
  withId,
  type ClipDescription,
  type ClipState,
  type OperationCall,
  type ProblemFields,
  type ProjectProblem,
  type ProjectState,
  type RegistrationProblem,
} from "@animaquill/core";
import type { SceneProblem } from "@animaquill/scene";
import type { TFunction } from "i18next";
import { Emitter } from "../workbench/emitter.ts";
import { describeProjectProblem, originOf } from "./words.ts";

export type ProblemSeverity = "error" | "warning";

/** One line of the list of problems: a problem of the project, in words. */
export interface ListedProblem {
  /** The id of the problem: the same problem has the same id, wherever it comes from and however often. */
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
  /** Who says so, or what it is about: a clip, a track, the code editor, an import. */
  readonly origin: string;
  /** What it is, as data: what the tools for AI read too. */
  readonly problem?: ProjectProblem;
  /** What can be done about it right away, as one step. */
  readonly action?: { readonly label: string; readonly run: () => void };
}

/** What a host says in its own words, such as the code editor and the project folder. */
export interface SaidProblem {
  readonly severity: ProblemSeverity;
  readonly text: string;
  readonly file?: string;
  readonly line?: number;
  readonly column?: number;
  readonly place?: string;
  readonly origin: string;
  /** The code of what it is, where the host knows one, such as a problem of the format. */
  readonly code?: string;
  readonly action?: { readonly label: string; readonly run: () => void };
}

export interface ProblemsSnapshot {
  readonly problems: readonly ListedProblem[];
  readonly errors: number;
  readonly warnings: number;
  /** Whether any of them came with an import. Nothing can make those go away but people. */
  readonly imported: boolean;
}

export interface ProblemListOptions {
  readonly t: TFunction;
  /** The project as it is now, for what problems are about. */
  readonly state: () => ProjectState | undefined;
  readonly describe?: (clip: ClipState) => ClipDescription | undefined;
  readonly registered?: (revision: string) => readonly RegistrationProblem[];
  /** Runs what fixes a problem, as one step. */
  readonly fix?: (call: OperationCall) => void;
}

/** One problem of a scene, in the state of the scene it came from. */
interface SceneEntry {
  readonly problem: ProjectProblem;
  /** What the first clip that ran into it is called. */
  readonly origin: string;
  /** Goes for several clips when they show the same scene, which fails the same way. */
  readonly clips: Map<string, string>;
}

/** What a host said in words, kept with the problem it makes. */
interface Said {
  readonly text: string;
  readonly origin: string;
  readonly action?: SaidProblem["action"];
}

const NOTHING: ProblemsSnapshot = { problems: [], errors: 0, warnings: 0, imported: false };

/** Code that failed is an error. What did not load or cannot work in a scene may not matter. */
export const severityOf = ({ kind }: Pick<SceneProblem, "kind">): ProblemSeverity =>
  kind === "error" || kind === "rejection" ? "error" : "warning";

/** The codes of what hosts say in words, by source, where they say no code of their own. */
const SAID_CODES: Readonly<Record<"editor" | "folder" | "import", string>> = {
  editor: "editor-diagnostic",
  folder: "folder-file",
  import: "import-note",
};

/** A problem of the code of a scene that ran, as data. See `describeProjectProblem` for its words. */
export function sceneProblem(
  problem: SceneProblem,
  about: ProjectProblem["subject"],
): ProjectProblem {
  const { kind, code, message, file, line, column, target } = problem;
  return withId({
    source: "runtime",
    severity: severityOf(problem),
    code: `scene-${kind}`,
    params: {
      ...(code !== undefined && { code }),
      ...(target !== undefined && { target }),
    },
    ...(about && { subject: about }),
    ...(file !== undefined && { file }),
    ...(line !== undefined && { line }),
    ...(column !== undefined && { column }),
    ...(message !== undefined && { detail: message }),
  });
}

/** Whether a line says the same and does the same as another. */
function sameListed(a: ListedProblem, b: ListedProblem | undefined): boolean {
  if (!b) return false;
  const fixOf = (listed: ListedProblem) => JSON.stringify(listed.problem?.fix ?? null);
  return (
    a.id === b.id &&
    a.severity === b.severity &&
    a.text === b.text &&
    a.origin === b.origin &&
    a.problem?.affectsOutput === b.problem?.affectsOutput &&
    fixOf(a) === fixOf(b) &&
    a.action?.label === b.action?.label &&
    // An action of a host belongs to the moment it was made in; one of a fix is the same step.
    (a.problem?.fix !== undefined || a.action?.run === b.action?.run)
  );
}

/** Whether going to a problem leads anywhere: a file, or something of the project. */
export const canGoTo = ({ file, problem }: ListedProblem): boolean =>
  file !== undefined || problem?.subject !== undefined;

/**
 * What is wrong with the open project, from everybody who can tell, in words: around the problems
 * of `core` (`ProblemSet`), which are data. What the project alone tells is worked out on `update`;
 * every host only ever speaks for itself: a scene that got a new state takes its own problems along,
 * and nothing else. The list stays when panels come and go, so it lives here.
 */
export class ProblemList {
  readonly #options: ProblemListOptions;
  readonly #emitter = new Emitter();
  /** The problems as data, which the tools for AI read too. */
  readonly set: ProblemSet;
  readonly #scenes = new Map<string, SceneEntry>();
  /** Scenes that do not run, by clip. */
  readonly #stopped = new Map<string, ProjectProblem>();
  /** What hosts said in words, by the id of the problem. */
  readonly #said = new Map<string, Said>();
  #imported = false;
  #snapshot = NOTHING;
  /** The lines of problems as of one state of the project, by problem. */
  #words = new WeakMap<ProjectProblem, ListedProblem>();
  #wordsOf: ProjectState | undefined;

  constructor(options: ProblemListOptions) {
    this.#options = options;
    this.set = new ProblemSet({
      describe: (clip) => options.describe?.(clip),
      registered: (revision) => options.registered?.(revision) ?? [],
      reports: ["runtime", "editor", "folder", "import"],
    });
    this.set.subscribe(() => this.#refresh());
  }

  subscribe = this.#emitter.subscribe;
  getSnapshot = (): ProblemsSnapshot => this.#snapshot;

  /**
   * The project changed: what it tells by itself is worked out again, and what the others are about
   * may be called otherwise now. The host waits for a burst of changes.
   */
  update(): void {
    this.set.update(this.#options.state());
    this.#refresh();
  }

  #listed(problem: ProjectProblem, state: ProjectState | undefined): ListedProblem {
    const { t, fix: run } = this.#options;
    const said = this.#said.get(problem.id);
    const scene = this.#scenes.get(problem.id);
    const origin = said?.origin ?? scene?.origin ?? originOf(t, problem, state);
    const text = said?.text ?? describeProjectProblem(t, problem, state, origin);
    const { fix } = problem;
    const action =
      said?.action ??
      (fix &&
        run && {
          label: t(`problems.fix.${fix.type}`, { defaultValue: fix.type }),
          run: () => run(fix),
        });
    return {
      id: problem.id,
      severity: problem.severity === "error" ? "error" : "warning",
      text,
      origin,
      problem,
      ...(problem.file !== undefined && { file: problem.file }),
      ...(problem.line !== undefined && { line: problem.line }),
      ...(problem.column !== undefined && { column: problem.column }),
      ...(problem.place !== undefined && { place: problem.place }),
      ...(action && { action }),
    };
  }

  /** The words again, which say only what is there now. Listeners hear of it when they changed. */
  #refresh(): void {
    const state = this.#options.state();
    const all = this.set.all();
    // The words of a problem change with the project, and with what a host said of it.
    if (state !== this.#wordsOf) this.#words = new WeakMap();
    this.#wordsOf = state;
    const problems = all.map((problem) => {
      const known = this.#words.get(problem);
      if (known && !this.#said.has(problem.id)) return known;
      const listed = this.#listed(problem, state);
      this.#words.set(problem, listed);
      return listed;
    });
    const errors = problems.filter(({ severity }) => severity === "error").length;
    const imported = this.#imported;
    const before = this.#snapshot;
    const same =
      before.imported === imported &&
      before.problems.length === problems.length &&
      problems.every((problem, index) => sameListed(problem, before.problems[index]));
    // What hosts said of problems that are gone is of no use any more.
    const ids = new Set(all.map(({ id }) => id));
    for (const id of this.#said.keys()) if (!ids.has(id)) this.#said.delete(id);
    if (same) return;
    this.#snapshot =
      problems.length === 0 && !imported
        ? NOTHING
        : { problems, errors, warnings: problems.length - errors, imported };
    this.#emitter.emit();
  }

  #reportScenes(): void {
    this.set.report(
      "runtime",
      "scenes",
      [...this.#scenes.values()].map(({ problem }) => problem),
    );
  }

  /** Something a scene said, as data, and what the clip that ran into it is called. */
  noteScene(clip: string, revision: string, problem: ProjectProblem, origin: string): void {
    const known = this.#scenes.get(problem.id);
    if (known) {
      known.clips.set(clip, revision);
      return;
    }
    if (this.#scenes.size >= MAX_PROBLEMS) return;
    this.#scenes.set(problem.id, { problem, origin, clips: new Map([[clip, revision]]) });
    this.#reportScenes();
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
    if (changed) this.#reportScenes();
    let stopped = false;
    for (const clip of this.#stopped.keys()) {
      if (!revisions.has(clip)) stopped = this.#stopped.delete(clip) || stopped;
    }
    if (stopped) this.#reportStopped();
  }

  #reportStopped(): void {
    this.set.report("runtime", "stopped", [...this.#stopped.values()]);
  }

  /** A scene that stopped for good, or undefined once that is over. */
  noteStopped(clip: string, problem: ProjectProblem | undefined): void {
    if (problem) this.#stopped.set(clip, problem);
    else if (!this.#stopped.delete(clip)) return;
    this.#reportStopped();
  }

  /** Problems that a host says in words, as data, with the words kept for the list. */
  #fromSaid(
    source: "editor" | "folder" | "import",
    said: readonly SaidProblem[],
  ): ProjectProblem[] {
    return said.slice(0, MAX_PROBLEMS).map((each) => {
      const { severity, text, file, line, column, place, origin, code, action } = each;
      const fields: ProblemFields = {
        source,
        severity,
        code: code ?? SAID_CODES[source],
        params: {},
        detail: text,
        ...(file !== undefined && { file }),
        ...(line !== undefined && { line }),
        ...(column !== undefined && { column }),
        ...(place !== undefined && { place }),
      };
      const problem = withId(fields);
      this.#said.set(problem.id, { text, origin, ...(action && { action }) });
      return problem;
    });
  }

  /** All that is wrong with an open file right now, as far as the code editor can see. */
  setFile(path: string, problems: readonly SaidProblem[]): void {
    this.set.report("editor", path, this.#fromSaid("editor", problems));
    this.#refresh();
  }

  /**
   * All that is wrong between the project and its folder right now: files that wait for people, and
   * what of the folder did not come in. Each comes with what people can do about it.
   */
  setFolder(problems: readonly SaidProblem[]): void {
    this.set.report("folder", "folder", this.#fromSaid("folder", problems));
    // An action belongs to the state it was made in, so a list that reads the same still changes.
    this.#refresh();
  }

  /** What an import found. Nobody looks at it again, so it stays until people clear it. */
  noteImport(problems: readonly SaidProblem[]): void {
    this.#imported = problems.length > 0;
    this.set.report("import", "import", this.#fromSaid("import", problems));
    this.#refresh();
  }

  clearImport(): void {
    if (!this.#imported) return;
    this.#imported = false;
    this.set.report("import", "import", []);
  }

  /** Another project has problems of its own. */
  clear(): void {
    this.#scenes.clear();
    this.#stopped.clear();
    this.#said.clear();
    this.#imported = false;
    this.set.clear();
    this.#refresh();
  }
}
