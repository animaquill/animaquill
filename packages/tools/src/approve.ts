import {
  deepEqual,
  type CommandCall,
  type CommandFailure,
  type CommandResult,
  type ExecuteOptions,
  type Patch,
  type ProjectState,
  type ProjectStore,
  type Revision,
  type RevisionId,
} from "@animaquill/core";
import { withIds } from "@animaquill/schema";
import type { ObjectChange } from "./changes.ts";

/**
 * "AI 改项目前先问我" (S-D4, the design of changes and gates of AnimaQuill Cloud, section 4): while
 * people want to be asked, a tool that changes the project works out what it would change without
 * writing it (a preview), shows that to people, and writes only once they allow it: exactly what
 * they saw, from the project as it was then. All of it happens in `makeTool`, around the tool,
 * whatever the tool is: the tool only says whether it previews, see `Call.preview`.
 */

/**
 * What people answered: this change only, every change of this run of the task, none; or the task
 * stopped while it waited, as when people stopped it or the page went away.
 */
export type Approval = "once" | "task" | "no" | "stopped";

/** A change that waits for people to allow it, as the host shows it. */
export interface ApproveRequest {
  /** The tool, such as `aq_edit`. */
  readonly tool: string;
  /** What AI said the change does (`aq_edit` summary), where it said. */
  readonly summary?: string;
  /** What it changes, as the result of the tool tells it once written. */
  readonly changes: readonly ObjectChange[];
  /** The project as it is while people are asked, and as it would be after the change. */
  readonly before: ProjectState;
  readonly after: ProjectState;
  /** The revision the change was worked out at: it is written against this one, or not at all. */
  readonly revision: RevisionId;
}

/**
 * What people allowed in one run of a task: a run is as long as the toolset (`createToolset`), so
 * that "this task" ends with the run, also when the same task is tried again, and nothing of it is
 * ever kept. Changes wait for people one after another.
 */
export class Approvals {
  #all = false;
  #queue: Promise<unknown> = Promise.resolve();

  /** People allowed every change of this run. */
  get all(): boolean {
    return this.#all;
  }

  allowAll(): void {
    this.#all = true;
  }

  /** Runs after what was asked before it is done, whatever came of that. */
  inTurn<T>(run: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(run, run);
    this.#queue = next.catch(() => undefined);
    return next;
  }
}

/** What a preview found the tool would write, by each time it asked the store to. */
export interface Previewed {
  readonly patches: readonly Patch[];
  /** The ids the commands made, to make the same ones once allowed. */
  readonly ids: readonly string[];
  readonly state: ProjectState;
}

/** What of a store a tool may use around a change that people are asked about: it only reads. */
const READS: ReadonlySet<PropertyKey> = new Set([
  "getState",
  "revision",
  "revisionId",
  "revisionOf",
  "changesSince",
  "history",
  "readOnly",
  "exportFiles",
]);

/**
 * A store that a tool gets around a change people are asked about: it reads as the store does,
 * changes only through `executeBatch` (and `execute`), as `batch` has it, and refuses everything
 * else that would change the project, also what the tools never use.
 */
function storeWith(
  store: ProjectStore,
  batch: (calls: readonly CommandCall[], options: ExecuteOptions) => CommandResult,
): ProjectStore {
  return new Proxy(store, {
    get(target, key) {
      if (key === "executeBatch") {
        return (calls: readonly CommandCall[], options: ExecuteOptions = {}) =>
          batch(calls, options);
      }
      if (key === "execute") {
        return (call: CommandCall, options: ExecuteOptions = {}) => batch([call], options);
      }
      if (!READS.has(key)) {
        throw new Error(
          `the store's ${String(key)} is not for a change that people are asked about`,
        );
      }
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === "function" ? (value as () => unknown).bind(target) : value;
    },
    set() {
      return false;
    },
  });
}

/** A store on which a tool works out what it would change, writing nothing: see `Previewed`. */
export function previewStore(store: ProjectStore): {
  readonly store: ProjectStore;
  readonly found: readonly Previewed[];
} {
  const found: Previewed[] = [];
  const preview = storeWith(store, (calls, options) => {
    const { value, ids } = withIds([], () =>
      store.executeBatch(calls, { ...options, dryRun: true }),
    );
    if (value.ok) found.push({ patches: value.patches, ids, state: value.state });
    return value;
  });
  return { store: preview, found };
}

/** The earlier of two revisions of a store; one it does not have stays, to be refused. */
function earlier(store: ProjectStore, a: Revision | undefined, b: RevisionId): Revision {
  if (a === undefined) return b;
  const x = store.revisionOf(a);
  const y = store.revisionOf(b);
  if (x === undefined) return a;
  if (y === undefined) return b;
  return x <= y ? a : b;
}

/** Where two lists of patches differ: the paths of either that the other does not have the same. */
function differing(patches: readonly Patch[], seen: readonly Patch[]): readonly Patch["path"][] {
  const paths: Patch["path"][] = [];
  const length = Math.max(patches.length, seen.length);
  for (let index = 0; index < length; index += 1) {
    const now = patches[index];
    const then = seen[index];
    if (deepEqual(now, then)) continue;
    if (now) paths.push(now.path);
    if (then && !deepEqual(then.path, now?.path)) paths.push(then.path);
  }
  return paths;
}

/**
 * A store on which a tool writes what people allowed: against the revision of the preview, so that
 * whatever anybody changed since at a place the change writes is a conflict, also where the tool
 * itself would check against a later read; and only what the preview found, to the patch, with the
 * same ids, or nothing.
 */
export function allowedStore(
  store: ProjectStore,
  revision: RevisionId,
  previewed: readonly Previewed[],
): ProjectStore {
  let count = 0;
  return storeWith(store, (calls, options) => {
    const seen = previewed[count];
    count += 1;
    const given = options.baseRevision;
    const baseRevision = (path: Patch["path"]): Revision =>
      earlier(store, typeof given === "function" ? given(path) : given, revision);
    const expect = (patches: readonly Patch[]): CommandFailure | undefined =>
      seen !== undefined && deepEqual(patches, seen.patches)
        ? undefined
        : { code: "conflict", params: {}, conflicts: differing(patches, seen?.patches ?? []) };
    return withIds(seen?.ids ?? [], () =>
      store.executeBatch(calls, { ...options, baseRevision, expect }),
    ).value;
  });
}
