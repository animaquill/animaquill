/**
 * Taking a copy of a project of this computer back onto the working copy that the platform made
 * again from its repository, see the design of the start page of AnimaQuill Cloud, 1 ("实时副本删掉
 * 以后再打开"), and its plan, 补充一 3 and 13.5 of the plan of the redesign. The platform lets go of
 * its working copy of a project that nobody opened for a while, whether or not all of it got into
 * the repository, and makes it again from the repository once somebody opens it: that is another
 * document, which the log of this computer cannot go on with, see `CloudLink.generation`. What this
 * computer has that the new copy does not goes onto it:
 *
 * - From where both had the same: what the platform had of the copy before when it was as far as
 *   both this computer and the archive the new copy began as were, the earlier of the two
 *   (`baseOfTakeBack`). Where this computer got further than the archive, that is the archive
 *   itself, which the platform gives (`base` of "hello"); where it did not, what the log here has
 *   that the platform had then. A computer that was away for long does not take what others did
 *   since for its own changes, and what got to the platform but not into the repository before the
 *   copy went is taken for a change of this computer, which it is the only one to have now.
 * - What only this computer changed comes in by itself, file by file as files of a folder do, see
 *   `ProjectStore.mergeFiles`; files that both changed in the same place, and every file that is
 *   not the same where nothing says what both had (`commonBase` false, or more than one copy
 *   between), people choose for, as in `reconcile.ts`.
 * - The log then starts anew, in one step: the new copy as the platform has it, and what came of
 *   this computer's changes as one change on top, which syncs as any other. What the log had is
 *   kept until that change is on the platform (`ProjectLibrary.renew`, `CloudLink.kept`). A page
 *   that goes away halfway leaves the link saying so (`CloudLink.renewing`), and whoever opens the
 *   project next finishes it or puts it back, see `settleRenewal`.
 *
 * The log of the copy before never goes to the new one as it is: Yjs would keep either side of
 * every key at random.
 *
 * Nothing here touches the page: whoever asks people and opens the project again is `CloudProjects`.
 */
import { ProjectStore, USER, isEmptyUpdate, type CommandFailure } from "@animaquill/core";
import {
  CloudSignedOut,
  RepositoryRefused,
  SYNC_CLOSE,
  newSyncId,
  type CloudAccess,
  type CloudLink,
  type CloudRenewal,
  type LogEntry,
  type ProjectLibrary,
  type RepositoryStatus,
} from "@animaquill/host";
import type { Problem } from "@animaquill/schema";
import { download, DownloadFailed, type Downloaded } from "./download.ts";
import {
  differencesOf,
  settle,
  type ReconcileChoices,
  type ReconcileDifference,
  type Settled,
  type Unsettled,
} from "./reconcile.ts";
import { isOnPlatform } from "./session.ts";

/** Where the copy before was, as the platform says it, see `RepositoryStatus.rebuiltFrom`. */
export type RebuiltFrom = NonNullable<RepositoryStatus["rebuiltFrom"]>;

/**
 * What both this computer and the new copy had: the archive the new copy began as ("archive"); what
 * the log here has that the platform had ("log"); or nothing anybody can tell ("none").
 */
export type TakeBackBase = "archive" | "log" | "none";

/**
 * What this computer and the new copy have in common, by how far the log here got with the copy
 * before (`CloudLink.seq`) and how far the archive the new copy began as did (`archivedSeq`): the
 * earlier of the two. Taking the later one loses something either way: the archive, where this
 * computer did not get that far, takes what others did since for something this computer took
 * back; what this computer had, where the archive did not get that far, takes what only this
 * computer has now for something the new copy took away. Nothing in common where the new copy
 * began as something else (`commonBase`), the copy before had no archive, or the log here is of a
 * copy before that one, whose archive nobody knows any more.
 */
export function baseOfTakeBack(
  link: Pick<CloudLink, "seq" | "generation">,
  from: RebuiltFrom | undefined,
): TakeBackBase {
  if (!from || !from.commonBase || from.archivedSeq <= 0) return "none";
  if (from.generation !== (link.generation ?? 1)) return "none";
  return link.seq >= from.archivedSeq ? "archive" : "log";
}

/**
 * What the log here has that the platform had of the copy before, as one project: what came from
 * there up to where the link says the log got (`seq`), what the log put together of that, and
 * every change of this computer up to `pushed`. What the link does not say yet, as a page that
 * went away within the moment it takes to note it down, counts as something the platform did not
 * have, which is the safe side: a change of this computer comes in again as one, and what came
 * from the platform after the archive, which only this computer may have now, is brought back.
 * Undefined where that is no project.
 */
export function logBase(
  entries: readonly LogEntry[],
  link: Pick<CloudLink, "pushed" | "seq">,
): ProjectStore | undefined {
  const there = entries.filter((entry) => {
    if (entry.source?.kind === "cloud")
      return entry.source.seq !== undefined && entry.source.seq <= link.seq;
    return entry.mark <= link.pushed || isOnPlatform(entry);
  });
  if (there.length === 0) return undefined;
  return ProjectStore.fromUpdates(there.map((entry) => entry.update)).store;
}

/** What the two sides are, and what of here comes in by itself, see `planTakeBack`. */
export interface TakeBackPlan {
  /** The project here, as files, by path. */
  readonly here: ReadonlyMap<string, string>;
  /** The new copy as the platform has it, as files. */
  readonly cloud: ReadonlyMap<string, string>;
  /** What both had, or undefined where nothing says. */
  readonly base: ReadonlyMap<string, string> | undefined;
  /** The new copy with what came in by itself: what people choose against. */
  readonly after: ReadonlyMap<string, string>;
  /** Files that came in from here by themselves. */
  readonly merged: readonly string[];
  /** Files people choose for: both changed them in the same place, or nothing says which did. */
  readonly differences: readonly ReconcileDifference[];
  /** The new copy with what came in by itself, see `after`. Whoever has the plan destroys it. */
  readonly store: ProjectStore;
}

/** A plan that cannot be made: the new copy cannot take what came in as files. */
export interface TakeBackRefusal {
  readonly problems: readonly Problem[];
  readonly failure?: CommandFailure;
}

export const isPlan = (outcome: TakeBackPlan | TakeBackRefusal): outcome is TakeBackPlan =>
  "store" in outcome;

/** A copy of a store of its own, see `ProjectCopy`. */
const forkOf = (store: ProjectStore): ProjectStore => {
  const fork = ProjectStore.fromUpdates([store.encodeState()]).store;
  if (!fork) throw new Error("The project could not be copied");
  return fork;
};

/** The paths of either side, sorted. */
const pathsOf = (...sides: readonly ReadonlyMap<string, string>[]) =>
  [...new Set(sides.flatMap((side) => [...side.keys()]))].toSorted();

/**
 * What of the project here comes onto the new copy (`cloud`, which does not change) by itself, and
 * what people choose for. A file comes in where this computer changed it since `base`, and the
 * merge took all of it: what the new copy changed of it too stays, see `ProjectStore.mergeFiles`.
 * The merge is the person's, as the changes were: labels that only people change come in too. A
 * file the merge could not take, or took only part of (both changed the same place), is for people
 * to choose. Without a base, every file that is not the same is.
 */
export function planTakeBack(
  here: ReadonlyMap<string, string>,
  cloud: ProjectStore,
  base: ReadonlyMap<string, string> | undefined,
): TakeBackPlan | TakeBackRefusal {
  const cloudFiles = cloud.exportFiles().files;
  if (!base) {
    const differences = differencesOf(here, cloudFiles);
    return {
      here,
      cloud: cloudFiles,
      base,
      after: cloudFiles,
      merged: [],
      differences,
      store: forkOf(cloud),
    };
  }
  // What this computer changed, and the new copy does not have as it is here.
  const changed = pathsOf(here, base).filter(
    (path) => here.get(path) !== base.get(path) && here.get(path) !== cloudFiles.get(path),
  );
  const changesOf = (paths: readonly string[]) =>
    paths.map((path) => ({ path, base: base.get(path), text: here.get(path) }));
  const options = { origin: USER, baseOf: (path: string) => here.get(path) };
  // Once to find what goes in whole, on a copy of its own...
  const asked = new Set<string>();
  if (changed.length > 0) {
    const trial = forkOf(cloud);
    try {
      const tried = trial.mergeFiles(changesOf(changed), options);
      if (!tried.ok) for (const path of changed) asked.add(path);
      else {
        for (const { path, status } of tried.files) if (status !== "merged") asked.add(path);
        for (const { file } of tried.conflicts) asked.add(file);
      }
    } finally {
      trial.destroy();
    }
  }
  // ...and then only those, where nothing of the rest gets in the way. Without what the rest
  // needed, part of one may not go: that one is for people too, and the others go again.
  let clean = changed.filter((path) => !asked.has(path));
  let store = forkOf(cloud);
  for (let round = 0; clean.length > 0; round++) {
    const merged = store.mergeFiles(changesOf(clean), options);
    const blocked = merged.ok
      ? [
          ...merged.files.filter(({ status }) => status !== "merged").map(({ path }) => path),
          ...merged.conflicts.map(({ file }) => file),
        ]
      : clean;
    if (merged.ok && blocked.length === 0) break;
    store.destroy();
    store = forkOf(cloud);
    for (const path of blocked) asked.add(path);
    clean = clean.filter((path) => !asked.has(path));
    if (round >= 3) {
      for (const path of clean) asked.add(path);
      clean = [];
    }
  }
  const { files: after, problems } = store.exportFiles();
  const errors = problems.filter(({ severity }) => severity === "error");
  if (errors.length > 0) {
    store.destroy();
    return { problems: errors };
  }
  const only = (side: ReadonlyMap<string, string>) =>
    new Map([...side].filter(([path]) => asked.has(path)));
  // Both changed these: whoever is at this computer most likely wants what they did, as far as a
  // first choice goes. People see which side each file comes from either way.
  const differences = differencesOf(only(here), only(after)).map((difference) =>
    difference.kind === "both" ? { ...difference, newer: "here" as const } : difference,
  );
  return { here, cloud: cloudFiles, base, after, merged: clean, differences, store };
}

/**
 * The new copy with what people chose, see `settle`: each file they chose for as that side has it,
 * the rest as it came in. The person's change, as what it carries over is theirs.
 */
export const settleTakeBack = (
  plan: TakeBackPlan,
  choices: ReconcileChoices,
): Settled | Unsettled => {
  const here = new Map(plan.after);
  for (const { path } of plan.differences) {
    const text = plan.here.get(path);
    if (text === undefined) here.delete(path);
    else here.set(path, text);
  }
  return settle(plan.store, here, plan.after, plan.differences, choices, newSyncId(), USER);
};

/**
 * The change that takes the new copy (`state`, as it came) to what the plan and the choices make of
 * it, or undefined where it is the same. Undefined too where the choices do not go together, which
 * `settleTakeBack` says first.
 */
export function changeOf(
  plan: TakeBackPlan,
  settled: Settled | undefined,
  state: Uint8Array,
): { readonly update: Uint8Array | undefined; readonly after: ReadonlyMap<string, string> } {
  const store = plan.store;
  if (settled && settled.changes.length > 0) {
    const merged = store.mergeFiles(settled.changes, {
      origin: USER,
      baseOf: (path) => settled.after.get(path),
    });
    if (!merged.ok || merged.files.some(({ status }) => status !== "merged"))
      throw new Error("What people chose did not go onto the new copy");
  }
  const vector = ProjectStore.fromUpdates([state]).store;
  if (!vector) throw new Error("The new copy is no project");
  try {
    const update = store.diffSince(vector.stateVector());
    return {
      update: isEmptyUpdate(update) ? undefined : update,
      after: settled?.after ?? store.exportFiles().files,
    };
  } finally {
    vector.destroy();
  }
}

/** What taking a copy back came to. */
export type TakeBackOutcome =
  /**
   * The log is on the new copy now, with what came of this computer's changes, if any: the project
   * opens again from it. `merged`: files that came in by themselves; `chosen`: files people chose
   * for; `kept`: where the folder keeps what it had of the files that change, where it does.
   */
  | {
      readonly kind: "renewed";
      readonly merged: readonly string[];
      readonly chosen: number;
      readonly changed: boolean;
      readonly kept: string | undefined;
    }
  /** The link is on another copy already, as another window took it back: open it again. */
  | { readonly kind: "already" }
  /** The platform did not make it again after all: syncing goes on as it was. */
  | { readonly kind: "same" }
  /**
   * Not now: the copy is on its way back still ("restoring"), the platform cannot be reached or
   * asked ("unavailable"), another copy came meanwhile ("moved"), nobody is signed in
   * ("signedOut"), or the platform says it has no such project of whoever is, or nothing of it to
   * read ("missing"). Again a little later; for the last two, once people did something.
   */
  | {
      readonly kind: "later";
      readonly why: "restoring" | "unavailable" | "moved" | "signedOut" | "missing";
    }
  /** People did not choose: nothing changed. */
  | { readonly kind: "cancelled" }
  /**
   * It did not get there, and nothing changed: `why` says what stopped it ("unsaved": what this
   * window changed is not in the log; "unreadable": the project here cannot be written as files;
   * "kept": the folder could not keep what it had; "library": this browser could not start the log
   * anew; "gone": the link went).
   */
  | {
      readonly kind: "failed";
      readonly why: "unsaved" | "unreadable" | "kept" | "library" | "gone";
      readonly error?: unknown;
      readonly problems?: readonly Problem[];
    };

/** Asks people to choose sides, until what they chose goes together. Undefined: they did not. */
export type ChooseTakeBack = (
  plan: TakeBackPlan,
) => Promise<{ readonly choices: ReconcileChoices; readonly settled: Settled } | undefined>;

export interface TakeBackOptions {
  readonly cloud: CloudAccess;
  readonly projects: ProjectLibrary;
  /** What the platform says of the project, see `RepositoryAccess.status`. */
  readonly status: (project: string) => Promise<RepositoryStatus>;
  readonly window: string;
  readonly editor: string;
  readonly now?: () => number;
}

export interface TakeBackRun {
  /** What this browser keeps the project by, and its project on the platform. */
  readonly key: string;
  readonly project: string;
  /** The project as this window has it open, of the copy before. */
  readonly store: ProjectStore;
  /** Which copy that is, as the window's sync says. */
  readonly generation: number;
  /** Resolves once everything this window changed is in the log, to whether it is. */
  readonly saved: () => Promise<boolean>;
  /** The log as it is. */
  readonly entries: () => Promise<readonly LogEntry[]>;
  readonly choose: ChooseTakeBack;
  /**
   * Keeps what the folder of the project has of these files, before they change: resolves to where,
   * or undefined where it has none of them, and rejects where it could not. Missing for a project
   * without a folder.
   */
  readonly keep?: (paths: readonly string[]) => Promise<string | undefined>;
  readonly signal?: AbortSignal;
}

/** How many times the log may change under a plan before giving up for now. */
const MOST_TRIES = 3;

export class TakeBack {
  readonly #options: TakeBackOptions;

  constructor(options: TakeBackOptions) {
    this.#options = options;
  }

  /** Takes the copy of a window back onto the new copy of the platform, see `TakeBackOutcome`. */
  async run(run: TakeBackRun): Promise<TakeBackOutcome> {
    for (let tries = 0; tries < MOST_TRIES; tries++) {
      const outcome = await this.#once(run);
      if (outcome !== "again") return outcome;
    }
    return { kind: "later", why: "moved" };
  }

  async #once(run: TakeBackRun): Promise<TakeBackOutcome | "again"> {
    const { cloud } = this.#options;
    const { key, project } = run;
    const link = await cloud.links.get(key);
    if (!link || link.project !== project) return { kind: "failed", why: "gone" };
    if ((link.generation ?? 1) !== run.generation || link.renewing) return { kind: "already" };
    let status: RepositoryStatus;
    try {
      status = await this.#options.status(project);
    } catch (error) {
      return { kind: "later", why: laterOf(error) };
    }
    if (status.copy !== undefined && status.copy !== "live")
      return { kind: "later", why: "restoring" };
    const generation = status.generation;
    if (generation === undefined || generation === run.generation) return { kind: "same" };
    if (!(await run.saved())) return { kind: "failed", why: "unsaved" };
    const entries = await run.entries();
    const lastMark = entries.at(-1)?.mark ?? 0;
    // What the platform has now, and what both had.
    let now: Downloaded;
    let base: ReadonlyMap<string, string> | undefined;
    const rule = baseOfTakeBack(link, status.rebuiltFrom);
    try {
      now = await this.#read(project, run.signal);
      if (now.generation !== generation) return { kind: "later", why: "moved" };
      if (rule === "archive") {
        const began = await this.#read(project, run.signal, true);
        if (began.generation !== generation) return { kind: "later", why: "moved" };
        base = filesOf(began.state);
      } else if (rule === "log") {
        const store = logBase(entries, link);
        base = store?.exportFiles().files;
        store?.destroy();
      }
    } catch (error) {
      if (run.signal?.aborted) return { kind: "cancelled" };
      console.warn("The project could not come from the platform to take it back", error);
      return { kind: "later", why: laterOf(error) };
    }
    const cloudStore = ProjectStore.fromUpdates([now.state]).store;
    if (!cloudStore) return { kind: "later", why: "unavailable" };
    let plan: TakeBackPlan | TakeBackRefusal;
    try {
      plan = planTakeBack(run.store.exportFiles().files, cloudStore, base);
    } finally {
      cloudStore.destroy();
    }
    if (!isPlan(plan)) return { kind: "failed", why: "unreadable", problems: plan.problems };
    try {
      let settled: Settled | undefined;
      if (plan.differences.length > 0) {
        const chosen = await run.choose(plan);
        if (!chosen) return { kind: "cancelled" };
        settled = chosen.settled;
      }
      const { update, after } = changeOf(plan, settled, now.state);
      // Nothing may have changed here meanwhile: the project is only read while this goes on, and
      // what got into the log all the same is taken in with the next try.
      const later = await run.entries();
      if ((later.at(-1)?.mark ?? 0) !== lastMark) return "again";
      const changing = pathsOf(plan.here, after).filter(
        (path) => plan.here.get(path) !== after.get(path),
      );
      let kept: string | undefined;
      if (run.keep && changing.length > 0) {
        try {
          kept = await run.keep(changing);
        } catch (error) {
          console.warn("What the folder had could not be kept before taking it back", error);
          return { kind: "failed", why: "kept", error };
        }
      }
      // Nor may the platform have changed what this changes there, while people chose, or another
      // computer took the same back meanwhile: the change is made against the copy as it was, and
      // Yjs would keep either side of such a file at random, or put the same text in twice. Where
      // it did, it is planned again from what the platform has now, and people look again (as in
      // the review of linking a folder, 1); what is there already is no change any more. As late
      // as it can be: what is left between this and the platform taking the change is a known
      // risk until the platform takes it only on the copy as it was then, see the design of the
      // start page, 1. What the platform changed elsewhere comes in as any change of others does.
      const touched = pathsOf(plan.cloud, after).filter(
        (path) => plan.cloud.get(path) !== after.get(path),
      );
      if (touched.length > 0) {
        let latest: Downloaded;
        try {
          latest = await this.#read(project, run.signal);
        } catch (error) {
          if (run.signal?.aborted) return { kind: "cancelled" };
          return { kind: "later", why: laterOf(error) };
        }
        if (latest.generation !== generation) return { kind: "later", why: "moved" };
        if (latest.head !== now.head) {
          const files = filesOf(latest.state);
          if (touched.some((path) => files.get(path) !== plan.cloud.get(path))) return "again";
        }
      }
      const window = this.#options.window;
      const at = (this.#options.now ?? Date.now)();
      const renewal: CloudRenewal = {
        id: newSyncId(),
        from: run.generation,
        generation,
        seq: now.head,
        digest: now.digest,
        backup: `copy${run.generation}-${newSyncId()}`,
      };
      // Only where the log is still as it was read: what another window, or the start page, wrote
      // into it since would go into the backup, and not onto the new copy.
      const renewed = await this.#renew(
        key,
        project,
        renewal,
        [
          { update: now.state, source: { kind: "cloud", seq: now.head } },
          ...(update ? [{ update, source: { kind: "other", window, at } }] : []),
        ],
        lastMark,
      );
      if (renewed !== "renewed") return renewed;
      return {
        kind: "renewed",
        merged: plan.merged,
        chosen: plan.differences.length,
        changed: update !== undefined,
        kept,
      };
    } finally {
      plan.store.destroy();
    }
  }

  /** What the platform has of the project, read only: as it is, or as this copy began. */
  #read(project: string, signal: AbortSignal | undefined, base = false): Promise<Downloaded> {
    return download(this.#options.cloud, project, {
      window: this.#options.window,
      editor: this.#options.editor,
      readOnly: true,
      ...(base && { base: true }),
      ...(signal && { signal }),
    });
  }

  /**
   * Starts the log anew with `entries`, keeping what it had, and moves the link on: first the link
   * says that it is on its way, then the log goes in one step, and then the link goes on from it.
   * Whatever stops it in between is settled by whoever opens the project next, see `settleRenewal`.
   */
  async #renew(
    key: string,
    project: string,
    renewal: CloudRenewal,
    entries: readonly { readonly update: Uint8Array; readonly source: LogEntry["source"] }[],
    expectedLast: number,
  ): Promise<"renewed" | "again" | Extract<TakeBackOutcome, { kind: "failed" | "already" }>> {
    const { cloud, projects } = this.#options;
    if (!projects.renew) return { kind: "failed", why: "library" };
    try {
      await cloud.links.update(key, project, { renewing: renewal });
      const said = await cloud.links.get(key);
      if (!said) return { kind: "failed", why: "gone" };
      if (said.renewing?.id !== renewal.id) return { kind: "already" };
    } catch (error) {
      return { kind: "failed", why: "library", error };
    }
    try {
      const isRenewed = await projects.renew(
        key,
        entries.map(({ update, source }) => ({ update, ...(source && { source }) })),
        renewal.backup,
        { expectedLast },
      );
      if (!isRenewed) {
        await cloud.links.update(key, project, { renewing: null });
        return "again";
      }
    } catch (error) {
      console.warn("The log could not start anew on the new copy", error);
      await cloud.links.update(key, project, { renewing: null }).catch(() => {});
      return { kind: "failed", why: "library", error };
    }
    await finishRenewal(cloud, projects, key, project, renewal).catch((error: unknown) => {
      // The link says it is on its way: the next one to open the project finishes it.
      console.warn("The link could not go on from the new copy yet", error);
    });
    return "renewed";
  }
}

/** Why asking the platform failed, as taking a copy back waits for it, see `TakeBackOutcome`. */
function laterOf(error: unknown): "unavailable" | "moved" | "signedOut" | "missing" {
  if (error instanceof CloudSignedOut) return "signedOut";
  if (error instanceof RepositoryRefused) {
    if (error.code === "notFound") return "missing";
    return "unavailable";
  }
  if (error instanceof DownloadFailed) {
    if (error.code === SYNC_CLOSE.rebuilt) return "moved";
    if (error.code === SYNC_CLOSE.signedOut) return "signedOut";
    if (error.code === SYNC_CLOSE.missing || error.code === SYNC_CLOSE.forbidden) return "missing";
  }
  return "unavailable";
}

/** The project that an update is, as files, or rejects where it is none. */
function filesOf(state: Uint8Array): Map<string, string> {
  const store = ProjectStore.fromUpdates([state]).store;
  if (!store) throw new Error("What came is no project");
  try {
    return store.exportFiles().files;
  } finally {
    store.destroy();
  }
}

/**
 * Moves the link on to the copy that its log is on now, see `CloudLinks.update` with `renewed`:
 * the platform has all of the log up to its first entry, which is the copy as it came, and the
 * rest, what came of the changes of this computer and whatever was done since, goes there.
 */
async function finishRenewal(
  cloud: CloudAccess,
  projects: ProjectLibrary,
  key: string,
  project: string,
  renewal: CloudRenewal,
): Promise<void> {
  const log = await projects.open(key);
  let entries: readonly LogEntry[];
  try {
    entries = (await log.entries?.()) ?? [];
  } finally {
    log.close();
  }
  const first = entries[0];
  // The copy as it came is the first entry: where it is not, all of it goes, which costs time and
  // nothing else, as the platform has what it has.
  const isCopy =
    first !== undefined && first.source?.kind === "cloud" && first.source.seq === renewal.seq;
  await cloud.links.update(key, project, {
    renewed: { pushed: isCopy ? first.mark : 0, until: entries.at(-1)?.mark ?? 0, at: Date.now() },
  });
}

/**
 * How long the log of the copy before stays after the platform has what came of it: what came of
 * it is on the platform then, and soon in the repository, but where something went wrong in taking
 * it back, this is all there is of what this computer had. As long as the platform keeps a copy
 * nobody opens, see the design of the start page, 1.
 */
export const KEEP_BACKUP_MS = 7 * 24 * 60 * 60_000;

/**
 * Settles what a page that went away left halfway, as the link says (`CloudLink.renewing`): where
 * the log started anew already, the link goes on from there; where it did not, the link stays on
 * the copy it was, and taking it back starts over once the project syncs. Resolves to whether the
 * link is on another copy now. Only for whoever syncs the project: nobody else can be at it then.
 */
export async function settleRenewal(
  cloud: CloudAccess,
  projects: ProjectLibrary,
  link: CloudLink,
): Promise<boolean> {
  const renewal = link.renewing;
  if (!renewal) return false;
  const kept = (await projects.backups?.(link.key)) ?? [];
  if (kept.includes(renewal.backup)) {
    await finishRenewal(cloud, projects, link.key, link.project, renewal);
    return true;
  }
  await cloud.links.update(link.key, link.project, { renewing: null });
  return false;
}

/**
 * Takes away the log of the copy before, once the platform has what came of it (`CloudLink.kept`)
 * and `KEEP_BACKUP_MS` went by since, and with it what was kept of copies before that one: all of
 * what they had is in the log that came after them, which the platform has then. Never while the log is on its way to another copy.
 * Resolves to whether it went.
 */
export async function dropKept(
  cloud: CloudAccess,
  projects: ProjectLibrary,
  key: string,
  now = Date.now(),
): Promise<boolean> {
  const link = await cloud.links.get(key);
  const kept = link?.kept;
  if (!link || !kept || link.renewing || link.resync !== undefined) return false;
  if (link.pushed < kept.until) return false;
  if (now - (kept.at ?? 0) < KEEP_BACKUP_MS) return false;
  const all = (await projects.backups?.(key)) ?? [kept.backup];
  for (const backup of all) await projects.dropBackup?.(key, backup);
  await cloud.links.update(key, link.project, { kept: null });
  return true;
}
