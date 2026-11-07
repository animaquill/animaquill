import type { ScriptSource } from "../loader/project.ts";
import type { SceneProblem } from "../protocol.ts";

const BLOB_PLACE = /(blob:[^\s()]+?):(\d+):(\d+)/g;

/** The most problems a scene reports. One that fails on every frame has said what it had to say. */
const MAX_PROBLEMS = 100;

/** Project code decides how long an error message is, and that is no reason to go over the budget. */
const MAX_TEXT = 2000;
const MAX_STACK = 4000;

export interface Place {
  readonly file: string;
  readonly line: number;
  readonly column: number;
}

type Sources = ReadonlyMap<string, ScriptSource>;

/** A place in a script of the project, instead of a place in a blob. */
export function placeOf(
  url: string | undefined,
  line: number,
  column: number,
  sources: Sources,
): Place | undefined {
  const source = url === undefined ? undefined : sources.get(url);
  if (!source) return undefined;
  return {
    file: source.path,
    line,
    column: line === 1 ? Math.max(column - source.shift, 1) : column,
  };
}

/**
 * A stack with the names people know. Lines of the runtime say nothing to them, and they are what
 * calls project code from a timer, so they go.
 */
export function readStack(stack: string, sources: Sources): { stack: string; top?: Place } {
  const lines: string[] = [];
  let top: Place | undefined;
  for (const line of stack.split("\n")) {
    const matches = [...line.matchAll(BLOB_PLACE)];
    if (matches.length === 0) {
      // The message, which comes first and has no place in it.
      if (lines.length === 0 && !line.trimStart().startsWith("at ")) lines.push(line);
      continue;
    }
    const [match] = matches;
    const place = match && placeOf(match[1], Number(match[2]), Number(match[3]), sources);
    if (!place || !match) continue;
    top ??= place;
    lines.push(line.replace(match[0], `${place.file}:${place.line}:${place.column}`));
  }
  return { stack: lines.join("\n"), ...(top && { top }) };
}

function shortened(problem: Omit<SceneProblem, "frame">): Omit<SceneProblem, "frame"> {
  const { message, target, file, code, stack } = problem;
  return {
    ...problem,
    ...(message !== undefined && { message: message.slice(0, MAX_TEXT) }),
    ...(target !== undefined && { target: target.slice(0, MAX_TEXT) }),
    ...(file !== undefined && { file: file.slice(0, MAX_TEXT) }),
    ...(code !== undefined && { code: code.slice(0, MAX_TEXT) }),
    ...(stack !== undefined && { stack: stack.slice(0, MAX_STACK) }),
  };
}

/** Sends what went wrong to the compositor, once for each thing. */
export class ProblemLog {
  readonly #send: (problem: SceneProblem) => void;
  readonly #frame: () => number;
  readonly #seen = new Set<string>();
  #sources: Sources = new Map();
  /** What did not load before it is known whether that was only a mix-up. */
  #held: SceneProblem[] | undefined = [];

  constructor(send: (problem: SceneProblem) => void, frame: () => number) {
    this.#send = send;
    this.#frame = frame;
  }

  set sources(sources: Sources) {
    this.#sources = sources;
  }

  report(problem: Omit<SceneProblem, "frame">): void {
    const { kind, code, message, file, line, column, target } = problem;
    const key = JSON.stringify([kind, code, message, file, line, column, target]);
    if (this.#seen.has(key) || this.#seen.size >= MAX_PROBLEMS) return;
    this.#seen.add(key);
    const sent = { ...shortened(problem), frame: this.#frame() };
    if (this.#held && (kind === "blocked" || kind === "resource")) this.#held.push(sent);
    else this.#send(sent);
  }

  /**
   * The page is there. What did not load until now counts from here on, unless it was something
   * that got put right: the loader and the browser can disagree on where a tag ends up.
   */
  release(putRight: ReadonlySet<string>): void {
    const held = this.#held ?? [];
    this.#held = undefined;
    for (const problem of held) {
      if (problem.target === undefined || !putRight.has(problem.target)) this.#send(problem);
    }
  }

  /** Something that was thrown, wherever it came from. */
  thrown(kind: "error" | "rejection", thrown: unknown, near?: Place): void {
    const error = thrown instanceof Error ? thrown : undefined;
    const [firstLine = ""] = String(thrown).split("\n", 1);
    const message = error ? `${error.name}: ${error.message}` : firstLine;
    const stack = error ? error.stack : typeof thrown === "string" ? thrown : undefined;
    const read = stack ? readStack(stack, this.#sources) : undefined;
    const place = read?.top ?? near;
    this.report({
      kind,
      message,
      ...place,
      ...(read?.top && { stack: read.stack }),
    });
  }

  /** An `error` event. They come from anything that failed: a script, and also an `<img>`. */
  onError = (event: Event): void => {
    if (event instanceof ErrorEvent) {
      const { error, filename, lineno, colno, message } = event;
      const place = placeOf(filename, lineno, colno, this.#sources);
      this.thrown("error", error ?? message, place);
      return;
    }
    const target = event.target as { readonly src?: string; readonly href?: string } | null;
    const url = target?.src ?? target?.href;
    if (typeof url === "string") this.report({ kind: "resource", target: url });
  };

  onRejection = ({ reason }: PromiseRejectionEvent): void => this.thrown("rejection", reason);

  onBlocked = ({ blockedURI, effectiveDirective }: SecurityPolicyViolationEvent): void =>
    this.report({ kind: "blocked", code: effectiveDirective, target: blockedURI });
}
