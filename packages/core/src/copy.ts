import { newId, writeProject } from "@animaquill/schema";
import * as Y from "yjs";
import type { CommandFailure } from "./failures.ts";
import { stateToProject, type ProjectState } from "./model.ts";
import { objectKey, objectOfPath, pathOfObject, type ObjectRef } from "./object-of-path.ts";
import { ProjectStore, type RevisionId } from "./store.ts";
import type { Path } from "./structure.ts";

/** How large a project may be to be copied, as the update of its document. */
export const MAX_COPY_BYTES = 64 * 1024 ** 2;

/** What a copy cannot do: it has the assets of its project and no others. See `ProjectCopy`. */
const NOT_IN_COPY: ReadonlySet<string> = new Set(["asset.add", "file.import", "file.merge"]);

const DISCARDED: CommandFailure = { code: "copy-discarded", params: {} };

/** What became of an object of a copy, against when it was made. */
export interface CopyChange {
  readonly object: ObjectRef;
  readonly change: "added" | "removed" | "changed";
  /** Where it changed, as paths of the state: the base of the summary of changes, see the tools. */
  readonly paths: readonly Path[];
}

export type ForkResult =
  | { readonly ok: true; readonly copy: ProjectCopy }
  | { readonly ok: false; readonly error: CommandFailure };

/** Thrown when a copy is used after `discard`. */
export class CopyDiscarded extends Error {
  readonly failure = DISCARDED;

  constructor() {
    super("copy-discarded");
  }
}

/**
 * A temporary copy of a project: changes that are not the project's yet. Alternatives (R-AI-36)
 * and drafts of cloud tasks while the person is away are made on one, and only come into the
 * project when someone takes them, with a three-way merge against `baseFiles`.
 *
 * It is a project of its own: its own Yjs document, with a client id of its own, its own history,
 * undo and record of changes. Commands, the checks before a write, problems and the tools of AI
 * work on its `store` as on any project. Nothing done to it reaches the project it came from, and
 * what that project does later does not reach it: its base stays the moment it was made.
 *
 * What it does not do, and who will:
 * - take a copy into its project (the merge, "what the person also changed stays theirs", one step
 *   to undo): 6.19, with `mergeFiles` and `baseFiles`;
 * - keep it anywhere: it lives in memory and is gone with the page. Where alternatives and drafts
 *   are kept, with the conversation in the browser or as a draft on the platform, is for 6.19 and
 *   6.7; `store.encodeState()` and `baseRevision` are what they will keep;
 * - save, sync or write files: nothing hands its store to a session, autosave, a folder or the
 *   platform, and it must not be;
 * - copy files of assets: it has the same assets as its project, whose files stay where they are,
 *   and takes no new ones (`not-in-copy`);
 * - show it, compare it, or let AI choose it as the target of its tools.
 */
export class ProjectCopy {
  /** `copy_<random>`, to tell copies apart, also in what is kept of them later. */
  readonly id: string;
  /** The revision of the project it was made from, of that open project (see `RevisionId`). */
  readonly baseRevision: RevisionId;
  readonly #store: ProjectStore;
  readonly #base: ProjectState;
  #discarded = false;

  private constructor(store: ProjectStore, baseRevision: RevisionId) {
    this.id = newId("copy");
    this.baseRevision = baseRevision;
    this.#store = store;
    this.#base = store.getState();
  }

  /**
   * A copy of a project as it is now. One that is read-only gives one that is read-only; one that is
   * locked gives one that is locked, as its manifest says so. A project that waits for changes from
   * elsewhere (`missing-updates`) or is larger than `maxBytes` (`copy-too-large`) gives none.
   */
  static fork(source: ProjectStore, options: { readonly maxBytes?: number } = {}): ForkResult {
    const limit = options.maxBytes ?? MAX_COPY_BYTES;
    if (source.isMissingUpdates)
      return { ok: false, error: { code: "missing-updates", params: {} } };
    const update = Y.encodeStateAsUpdate(source.doc);
    if (update.byteLength > limit) {
      return {
        ok: false,
        error: { code: "copy-too-large", params: { bytes: update.byteLength, limit } },
      };
    }
    // A document of its own, with a client id of its own: nothing of it is the project's.
    const { store } = ProjectStore.fromUpdates([update]);
    if (!store) throw new Error("A project without a manifest cannot be copied");
    store.readOnly = source.readOnly;
    const copy = new ProjectCopy(store, source.revisionId);
    store.refuse((commands) => copy.#refusal(commands));
    return { ok: true, copy };
  }

  get discarded(): boolean {
    return this.#discarded;
  }

  /** The project of the copy, to read and change. */
  get store(): ProjectStore {
    this.#assertKept();
    return this.#store;
  }

  /** What the copy was when it was made. It does not change. */
  baseState(): ProjectState {
    this.#assertKept();
    return this.#base;
  }

  /** The objects that changed since the copy was made, with where. */
  changes(): readonly CopyChange[] {
    this.#assertKept();
    const base = this.#base;
    const now = this.#store.getState();
    const byObject = new Map<string, { object: ObjectRef; paths: Path[] }>();
    for (const path of differences(base, now)) {
      const object = objectOfPath(path);
      const key = objectKey(object);
      const entry = byObject.get(key) ?? { object, paths: [] };
      byObject.set(key, entry);
      entry.paths.push(path);
    }
    return [...byObject.values()].map(({ object, paths }) => {
      const where = pathOfObject(object);
      const before = valueAt(base, where) !== undefined;
      const after = valueAt(now, where) !== undefined;
      const change = !before ? "added" : !after ? "removed" : "changed";
      return { object, change, paths };
    });
  }

  /** What the copy was when it was made, as files: the base of a three-way merge. */
  baseFiles(): ReadonlyMap<string, string> {
    this.#assertKept();
    const { project } = stateToProject(this.#base);
    const files = writeProject(project);
    for (const [path, text] of Object.entries(this.#base.files)) files.set(path, text);
    return files;
  }

  /** Lets the copy go. Its store refuses every change from then on, with `copy-discarded`. */
  discard(): void {
    if (this.#discarded) return;
    this.#discarded = true;
    this.#store.destroy();
    this.#store.doc.destroy();
  }

  #refusal(commands: readonly string[]): CommandFailure | undefined {
    if (this.#discarded) return DISCARDED;
    const command = commands.find((name) => NOT_IN_COPY.has(name));
    return command === undefined ? undefined : { code: "not-in-copy", params: { command } };
  }

  #assertKept(): void {
    if (this.#discarded) throw new CopyDiscarded();
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Where two states differ, as paths: as deep as both have records, and only where they differ. */
function differences(before: unknown, after: unknown, path: Path = []): Path[] {
  if (before === after) return [];
  if (!isRecord(before) || !isRecord(after)) {
    return JSON.stringify(before) === JSON.stringify(after) ? [] : [path];
  }
  const found: Path[] = [];
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    found.push(...differences(before[key], after[key], [...path, key]));
  }
  return found;
}

function valueAt(state: unknown, path: Path): unknown {
  let node = state;
  for (const key of path) {
    if (!isRecord(node) || !Object.hasOwn(node, key)) return undefined;
    node = node[key];
  }
  return node;
}
