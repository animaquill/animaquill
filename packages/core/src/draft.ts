import type { ProjectState } from "./model.ts";
import { Mutator, diff, getIn, type Patch } from "./patch.ts";
import type { Path } from "./structure.ts";

/** Why a command did not happen. Commands throw it, callers get it as a result. */
export class CommandError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** Stops a command. Nothing it planned so far gets written. */
export const fail = (code: string, message: string): never => {
  throw new CommandError(code, message);
};

/** One change, and how to take it back. */
export interface Step {
  readonly patch: Patch;
  readonly inverse: Patch;
}

/**
 * A project while commands plan their changes. Yjs has no way to take a change back, so nothing is
 * written until every command of a batch has run here, and each one sees what the one before did.
 */
export class Draft {
  readonly #mutator: Mutator<ProjectState>;
  readonly #steps: Step[] = [];

  /** Who is asking. */
  readonly origin: string;

  constructor(state: ProjectState, origin: string) {
    this.#mutator = new Mutator(state);
    this.origin = origin;
  }

  get state(): ProjectState {
    return this.#mutator.root;
  }

  get steps(): readonly Step[] {
    return this.#steps;
  }

  /** Whether the object a path belongs to is there. */
  hasParent(path: Path): boolean {
    return getIn(this.state, path.slice(0, -1)) !== undefined;
  }

  apply(patch: Patch): void {
    const { path } = patch;
    const before = getIn(this.state, path);
    let inverse: Patch;
    if (before === undefined) inverse = { op: "delete", path };
    else if (patch.op === "text") inverse = { op: "text", path, value: before as string };
    else inverse = { op: "set", path, value: before };
    this.#steps.push({ patch, inverse });
    this.#mutator.apply(patch);
  }

  set(path: Path, value: unknown): void {
    this.apply({ op: "set", path, value });
  }

  delete(path: Path): void {
    this.apply({ op: "delete", path });
  }

  setText(path: Path, value: string): void {
    this.apply({ op: "text", path, value });
  }

  /** Makes a path hold this value, changing no more than what is different. */
  replace(path: Path, value: unknown): void {
    for (const patch of diff(path, getIn(this.state, path), value)) this.apply(patch);
  }
}
