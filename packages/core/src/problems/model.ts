import type { ObjectKind, ObjectRef } from "../object-of-path.ts";

/**
 * What is wrong with a project, as data: a stable code with its parameters, about an object or a
 * place in a file. Words come from whoever shows it (the editor in Chinese, the tools for AI in
 * English), so the same problem reads the same wherever it is shown, and keeps its id.
 */

/** `check`: an acceptance check that did not pass, which is no error. */
export type ProblemSeverity = "error" | "warning" | "check";

export type ProblemSource =
  /** A document that does not fit the format. */
  | "format"
  /** Something that is referred to and is not there: a file of an asset, a scene, a library. */
  | "reference"
  /** What the format has and this editor does not do yet, see `unsupported.ts`. */
  | "unsupported"
  /** What clips hold for their scenes and what the scenes describe do not agree. */
  | "properties"
  /** What code of scenes and sounds said when it ran. Hosts that run it report it. */
  | "runtime"
  /** What the code editor sees in files. */
  | "editor"
  /** Between the project and its folder. */
  | "folder"
  /** What an import found. */
  | "import";

/** The sources that only a host can tell, and reports. */
export type ReportedSource = "runtime" | "editor" | "folder" | "import";

/**
 * What a problem is about: an object, as changes and what AI read are about objects, see
 * `objectOfPath`. Clips and tracks are by timeline, because their ids are only unique there.
 */
export interface ProblemSubject extends ObjectRef {
  readonly kind: Extract<ObjectKind, "clip" | "track" | "timeline" | "scene" | "sound" | "asset">;
}

/** A command as one step, with its parameters: what `ProjectStore.execute` takes. */
export interface OperationCall {
  readonly type: string;
  readonly params: unknown;
}

/** What of an export would be otherwise than the project says: its picture, its sound, or both. */
export type OutputPart = "picture" | "sound" | "both";

export interface ProjectProblem {
  /** From the source, code, subject, parameters and place: the same problem always has the same one. */
  readonly id: string;
  readonly source: ProblemSource;
  readonly severity: ProblemSeverity;
  /** Stable, such as `unsupported-audio-property`. Tools and AI go by it, not by words. */
  readonly code: string;
  readonly params: Readonly<Record<string, string | number>>;
  readonly subject?: ProblemSubject;
  readonly file?: string;
  readonly line?: number;
  readonly column?: number;
  /** Where in a document or an object, for what has no line, such as a property path. */
  readonly place?: string;
  /** Text as it came, such as what code threw. It is data, not words to translate. */
  readonly detail?: string;
  /** What fixes it as one step. */
  readonly fix?: OperationCall;
  /** It makes an export otherwise than the project: an export stops there first, see `outputProblems`. */
  readonly affectsOutput?: OutputPart;
}

/** A problem before it has its id. */
export type ProblemFields = Omit<ProjectProblem, "id">;

/** More than anybody reads, and a project can have as many as it likes. */
export const MAX_PROBLEMS = 500;

/** cyrb53: short, fast, and the same everywhere. Not for secrets, only for telling apart. */
function hash(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

const sorted = (params: Readonly<Record<string, string | number>>) =>
  Object.keys(params)
    .toSorted()
    .map((key) => [key, params[key]]);

/**
 * The id of a problem: what it is and where, and nothing of how bad it is or what fixes it, which
 * can change with the editor while it is still the same problem.
 */
export function problemId(problem: ProblemFields): string {
  const { source, code, params, subject, file, line, column, place, detail } = problem;
  const about = subject && [subject.kind, subject.id, subject.timeline ?? null];
  const key = JSON.stringify([
    source,
    code,
    sorted(params),
    about ?? null,
    file ?? null,
    line ?? null,
    column ?? null,
    place ?? null,
    detail ?? null,
  ]);
  return `${code}-${hash(key)}`;
}

export const withId = (problem: ProblemFields): ProjectProblem => ({
  ...problem,
  id: problemId(problem),
});

/** Files first, in order, and in a file by where it is. What is about no file goes last. */
export function compareProblems(a: ProjectProblem, b: ProjectProblem): number {
  if ((a.file === undefined) !== (b.file === undefined)) return a.file === undefined ? 1 : -1;
  return (
    (a.file ?? "").localeCompare(b.file ?? "") ||
    (a.line ?? 0) - (b.line ?? 0) ||
    (a.column ?? 0) - (b.column ?? 0)
  );
}

/** What came and what went from one list of problems to the next, by id. */
export function problemDelta(
  before: readonly ProjectProblem[],
  after: readonly ProjectProblem[],
): { readonly added: readonly ProjectProblem[]; readonly resolved: readonly ProjectProblem[] } {
  const was = new Set(before.map(({ id }) => id));
  const is = new Set(after.map(({ id }) => id));
  return {
    added: after.filter(({ id }) => !was.has(id)),
    resolved: before.filter(({ id }) => !is.has(id)),
  };
}
