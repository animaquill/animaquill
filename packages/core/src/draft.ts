import { ZERO, formatTime, parseTime, subtract } from "@animaquill/schema";
import type { ProjectState } from "./model.ts";
import { Mutator, diff, getIn, settled, settledPatch, type Patch } from "./patch.ts";
import { touchesLockedTrack } from "./references.ts";
import { isFlat, type Path } from "./structure.ts";
import { UNWRITTEN, WriteTree, sameWrites, type WriteId, type Written } from "./write-tree.ts";

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

/**
 * What a change did to clips, beyond the fields it wrote. The document only has the outcome, and the
 * same outcome can have different reasons: a clip that starts earlier can have grown, with its keys
 * moving along, or it can have been given a new start. Whatever depends on the difference, like what
 * is tried on a clip, goes by this.
 */
export type ClipFact =
  /** Everything on the clock of a clip moved. A time, which is negative to go back. */
  | { readonly kind: "clock"; readonly clip: string; readonly by: string }
  /** A clip got cut, and `piece` is the part that is new. */
  | { readonly kind: "cut"; readonly clip: string; readonly piece: string }
  /** That was taken back. */
  | { readonly kind: "joined"; readonly clip: string; readonly piece: string }
  /** A clip became another one, which is how cutting it out and pasting it works. */
  | { readonly kind: "moved"; readonly from: string; readonly to: string }
  /**
   * A property of a clip went to another path, for code that renamed what it is about. Its values
   * became `value × scale + offset` on the way, when those are there.
   */
  | {
      readonly kind: "renamed";
      readonly clip: string;
      readonly from: string;
      readonly to: string;
      readonly scale?: number;
      readonly offset?: number;
    };

function factTakenBack(fact: ClipFact): ClipFact {
  switch (fact.kind) {
    case "clock":
      return { ...fact, by: formatTime(subtract(ZERO, parseTime(fact.by))) };
    case "cut":
      return { ...fact, kind: "joined" };
    case "joined":
      return { ...fact, kind: "cut" };
    case "moved":
      return { kind: "moved", from: fact.to, to: fact.from };
    case "renamed": {
      const { clip, from, to, scale = 1, offset = 0 } = fact;
      const back = scale === 1 && offset === 0 ? {} : { scale: 1 / scale, offset: -offset / scale };
      return { kind: "renamed", clip, from: to, to: from, ...back };
    }
  }
}

/** What taking changes back does, given what they did. */
export const factsTakenBack = (facts: readonly ClipFact[]): readonly ClipFact[] =>
  facts.toReversed().map(factTakenBack);

/** One change, and how to take it back. */
export interface Step {
  readonly patch: Patch;
  readonly inverse: Patch;
  /** What was written at its path until now. Taking the step back hands the path back to that. */
  readonly replaced: Written;
  /** What it left there. As long as that is still there, the step is free to go back. */
  readonly left: Written;
  /**
   * It wrote on a locked track. Files and commands leave what is there as it is, and a file changes
   * a track before it puts a lock on, but a change elsewhere can still reach there: a transition on
   * a locked track that points at a clip that goes away. A lock keeps what was there when it came,
   * so it does not stop this step from going back to that.
   */
  readonly pastLock: boolean;
}

/**
 * A project while commands plan their changes. Yjs has no way to take a change back, so nothing is
 * written until every command of a batch has run here, and each one sees what the one before did.
 */
export class Draft {
  readonly #mutator: Mutator<ProjectState>;
  readonly #writes: WriteTree;
  readonly #write: WriteId = Symbol("write");
  readonly #steps: Step[] = [];
  readonly #before: ProjectState;
  #facts: ClipFact[] | undefined = [];

  /** Who is asking. */
  readonly origin: string;

  constructor(state: ProjectState, origin: string, written: Written = UNWRITTEN) {
    this.#before = state;
    this.#mutator = new Mutator(state);
    this.#writes = new WriteTree(written);
    this.origin = origin;
  }

  get state(): ProjectState {
    return this.#mutator.root;
  }

  get steps(): readonly Step[] {
    return this.#steps;
  }

  get facts(): readonly ClipFact[] | undefined {
    return this.#facts;
  }

  /** Says what this change does to a clip, in the order it does it. */
  note(fact: ClipFact): void {
    this.#facts?.push(fact);
  }

  /** This change comes from somewhere that says nothing about what happened, like a file. */
  knowsOnlyOutcome(): void {
    this.#facts = undefined;
  }

  /** Whether what was at this path when this started is gone by now. */
  wentAway(path: Path): boolean {
    return getIn(this.#before, path) !== undefined && getIn(this.state, path) === undefined;
  }

  /** What was written where, with this draft on top of it. */
  get written(): Written {
    return this.#writes.root;
  }

  /** A flat level has nothing of its own to write, so this comes down to its entries. */
  apply(change: Patch): void {
    if (isFlat(change.path)) {
      this.replace(change.path, change.op === "delete" ? undefined : change.value);
      return;
    }
    const patch = settledPatch(change);
    if (patch.op === "delete" && getIn(this.state, patch.path) === undefined) return;
    this.#record(patch, { by: this.#write }, touchesLockedTrack(this.state, patch));
  }

  /**
   * Takes back a step of an earlier change. Only the write that the document holds now can go, also
   * when something else left the same value. Returns whether it went. See `Written`.
   */
  takeBack({ patch, inverse, replaced, left, pastLock }: Step): boolean {
    if (!sameWrites(this.#writes.at(patch.path), left)) return false;
    this.#record(inverse, replaced, pastLock);
    return true;
  }

  #record(patch: Patch, left: Written, pastLock: boolean): void {
    const { path } = patch;
    const before = getIn(this.state, path);
    let inverse: Patch;
    if (before === undefined) inverse = { op: "delete", path };
    else if (patch.op === "text") inverse = { op: "text", path, value: before as string };
    else inverse = { op: "set", path, value: before };
    const replaced = this.#writes.at(path);
    this.#mutator.apply(patch);
    this.#writes.put(path, left);
    this.#steps.push({ patch, inverse, replaced, left, pastLock });
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
    const wanted = settled(path, value);
    for (const patch of diff(path, getIn(this.state, path), wanted)) this.apply(patch);
  }
}
