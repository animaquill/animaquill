import type { ClipFact } from "./draft.ts";
import type { Origin } from "./origin.ts";
import type { Patch } from "./patch.ts";
import type { Path } from "./structure.ts";
import type { Mark } from "./undo-marks.ts";

/**
 * Who wrote what at a path, as `Written`, with each write by a name that stays the same when it is
 * saved and read again. Null is nobody: the project was opened like that.
 */
export interface SavedWritten {
  readonly by: string | null;
  readonly below?: readonly (readonly [string, SavedWritten])[];
}

/** One step of a change, and how to take it back, see `Step`. */
export interface SavedStep {
  readonly patch: Patch;
  readonly inverse: Patch;
  readonly replaced: SavedWritten;
  readonly left: SavedWritten;
  /** What the store said was written at the path of the step when this was saved. */
  readonly now: SavedWritten;
}

export interface SavedEntry {
  readonly steps: readonly SavedStep[];
  readonly facts: readonly ClipFact[] | null;
  readonly danglingBefore: readonly string[];
  readonly danglingAfter: readonly string[];
}

/**
 * What it takes to take back, or do again, everything that came from one origin, as an AI task or a
 * batch of files, after the project was closed and opened again, also somewhere else that has the
 * same document, as the platform: `ProjectStore.saveUndo` and `restoreUndo`. A person's own steps
 * can be saved the same way, which nothing does yet.
 *
 * The store knows which write the document holds where only while it is open (`Written`). What it
 * knew is saved with each step (`now`), together with marks of what the document held at those
 * places (`Mark`). Opened again, what still has its mark is as it was when this was saved; where
 * something else was written since, the mark is different, and that place counts as written by
 * somebody else, as it would have in the store that saved this.
 */
export interface UndoRecord {
  readonly format: typeof UNDO_FORMAT;
  readonly origin: Origin;
  /**
   * When it was saved, in milliseconds since 1970, and always later than every record the store
   * that saved it knew: what a later record knew of a place counts over what an earlier one did.
   */
  readonly at: number;
  readonly done: readonly SavedEntry[];
  readonly undone: readonly SavedEntry[];
  /** The places the steps are about, and their marks when this was saved. */
  readonly marks: readonly (readonly [Path, Mark])[];
  /** Which document this is about: a project that was made again from its files is another one. */
  readonly doc: {
    readonly manifest: Mark;
    /**
     * The version of the format of projects the steps were written in, see `CURRENT_FORMAT_VERSION`:
     * a step of an older one would put back a value in a shape the project no longer has.
     */
    readonly formatVersion: number;
  };
}

export const UNDO_FORMAT = 1;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isStrings = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

/** A path, never one that means something to every object, whatever wrote it down. */
const isPath = (value: unknown): value is readonly string[] =>
  isStrings(value) && value.length > 0 && !value.includes("__proto__");

function isPatch(value: unknown): value is Patch {
  if (!isObject(value) || !isPath(value.path)) return false;
  if (value.op === "delete") return true;
  if (value.op === "text") return typeof value.value === "string";
  return value.op === "set" && "value" in value;
}

function isWritten(value: unknown, depth = 0): value is SavedWritten {
  if (!isObject(value) || depth > 64) return false;
  if (value.by !== null && typeof value.by !== "string") return false;
  if (value.below === undefined) return true;
  return (
    Array.isArray(value.below) &&
    value.below.every(
      (pair: unknown) =>
        Array.isArray(pair) &&
        pair.length === 2 &&
        typeof pair[0] === "string" &&
        pair[0] !== "__proto__" &&
        isWritten(pair[1], depth + 1),
    )
  );
}

const isStep = (value: unknown): value is SavedStep =>
  isObject(value) &&
  isPatch(value.patch) &&
  isPatch(value.inverse) &&
  isWritten(value.replaced) &&
  isWritten(value.left) &&
  isWritten(value.now);

const isEntry = (value: unknown): value is SavedEntry =>
  isObject(value) &&
  Array.isArray(value.steps) &&
  value.steps.every(isStep) &&
  (value.facts === null || Array.isArray(value.facts)) &&
  isStrings(value.danglingBefore) &&
  isStrings(value.danglingAfter);

/** Whether something read back is a record this editor can use, whoever kept it. */
export function isUndoRecord(value: unknown): value is UndoRecord {
  if (
    !isObject(value) ||
    value.format !== UNDO_FORMAT ||
    typeof value.origin !== "string" ||
    typeof value.at !== "number"
  ) {
    return false;
  }
  const doc = value.doc;
  return (
    isObject(doc) &&
    typeof doc.manifest === "string" &&
    Number.isInteger(doc.formatVersion) &&
    Array.isArray(value.done) &&
    value.done.every(isEntry) &&
    Array.isArray(value.undone) &&
    value.undone.every(isEntry) &&
    Array.isArray(value.marks) &&
    value.marks.every(
      (pair: unknown) =>
        Array.isArray(pair) && pair.length === 2 && isPath(pair[0]) && typeof pair[1] === "string",
    )
  );
}
