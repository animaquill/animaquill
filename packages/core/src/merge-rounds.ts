import type { FileChange } from "./merge-files.ts";
import type { ProjectState } from "./model.ts";
import { inRanks } from "./project-files.ts";
import type { MergeOptions, MergeResult } from "./store.ts";

/**
 * Refusals of a batch that say which files they are about, see `mergeFiles`: those can wait while
 * the rest comes in.
 */
export const SALVAGEABLE: ReadonlySet<string> = new Set(["merge-would-break", "merge-unsettled"]);

/** How often the files a refusal names are left out, before each file goes on its own. */
const ROUNDS = 3;

/** What `mergeInRounds` needs of a project: `ProjectStore`. */
export interface Mergeable {
  mergeFiles(changes: readonly FileChange[], options: MergeOptions): MergeResult;
  getState(): ProjectState;
}

/**
 * One merge of some of the files of a batch: what came of them, with the project before it, or why
 * none of them came in.
 */
export type MergeRound =
  | {
      readonly ok: true;
      readonly changes: readonly FileChange[];
      readonly result: Extract<MergeResult, { ok: true }>;
      readonly before: ProjectState;
    }
  | {
      readonly ok: false;
      readonly changes: readonly FileChange[];
      readonly error: Extract<MergeResult, { ok: false }>["error"];
    };

/**
 * Merges a batch of files, and where the merge refuses all of it for what some of the files would
 * break, see `SALVAGEABLE`, the rest still: the files the refusal names are left out and the rest is
 * tried again, a few times, and when the refusal says no file, or that does not help, each file
 * goes on its own, what others refer to first. A file that still would break the project waits, to
 * be tried again once the project changes. Each merge and each refusal goes to `each` as it
 * happens, before the next merge, so that whoever looks after the files can note it first: the
 * folder of a project, or the platform for a repository. That is the same for both, and so is what
 * comes in.
 *
 * What a file left out holds is what the batch has of it, for the merges after that: it is not in
 * the project, and not where it came from either. So `baseOf` says that for each file of the batch
 * that is not in a merge, whatever it says itself. Without `baseOf` nothing is known of the files
 * outside a merge, and whatever could be in them counts as there, also of these.
 */
export function mergeInRounds(
  store: Mergeable,
  changes: readonly FileChange[],
  options: MergeOptions,
  each: (round: MergeRound) => void,
): void {
  const inBatch = new Map(changes.map((change) => [change.path, change]));
  const mergeOf = (files: readonly FileChange[]): MergeRound => {
    const merging = new Set(files.map(({ path }) => path));
    const outside = options.baseOf;
    const baseOf = (path: string) => {
      const change = inBatch.get(path);
      if (change && !merging.has(path)) return change.text;
      return outside?.(path);
    };
    const before = store.getState();
    // Without `baseOf`, whatever could be there counts as there: for these files too.
    const result = store.mergeFiles(files, {
      ...options,
      baseOf: outside === undefined ? undefined : baseOf,
    });
    return result.ok
      ? { ok: true, changes: files, result, before }
      : { ok: false, changes: files, error: result.error };
  };
  const isSalvageable = (round: MergeRound, files: readonly FileChange[]) =>
    !round.ok && SALVAGEABLE.has(round.error.code) && files.length > 1;

  let batch = changes;
  let round = mergeOf(batch);
  for (let tried = 0; tried < ROUNDS && isSalvageable(round, batch); tried++) {
    if (round.ok) break;
    const named = new Set((round.error.problems ?? []).map(({ file }) => file));
    const out = batch.filter(({ path }) => named.has(path));
    if (out.length === 0 || out.length === batch.length) break;
    each({ ok: false, changes: out, error: round.error });
    batch = batch.filter(({ path }) => !named.has(path));
    round = mergeOf(batch);
  }
  if (isSalvageable(round, batch)) {
    // It does not say which: each file goes on its own then.
    for (const rank of inRanks(batch.map(({ path }) => path))) {
      for (const path of rank) each(mergeOf(batch.filter((change) => change.path === path)));
    }
    return;
  }
  each(round);
}
