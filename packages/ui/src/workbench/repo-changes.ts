import type { ProjectStore } from "@animaquill/core";
import { describeChanges } from "@animaquill/tools";
import type { TFunction } from "i18next";
import { changeLine } from "../chat/change-line.ts";
import type { TurnChange } from "../chat/summary.ts";
import type { CloudProjectsSnapshot } from "../cloud/projects.ts";
import type { CloudBatchNote } from "../cloud/session.ts";
import type { Dialogs } from "./dialogs.ts";
import { Emitter } from "./emitter.ts";
import type { Notifications } from "./notifications.ts";
import type { RepoMergesHeard } from "./operations.ts";
import { asTurnChange, withProjectFields } from "./tool-activity.ts";

/**
 * What merges of changes on GitHub did to the open project, as the window takes them in from the
 * platform (docs/design/start-and-cloud.md of AnimaQuill Cloud, 10, "平常"): a notice that goes by
 * itself, with what changed to look at; the clips they changed, which the timeline marks in a
 * colour of their own; one "GitHub 上的改动" in the list of operations; and the status of archiving
 * asked again at once. Merges that came while the editor was away are told once, together, as the
 * project opens. Nothing of it is saved, and nothing touches the page.
 */

export interface RepoChangesSnapshot {
  /** The clips the latest merge changed or made. */
  readonly marked: ReadonlySet<string>;
}

export interface RepoChangesOptions {
  readonly t: TFunction;
  readonly notifications: Notifications;
  readonly dialogs: Dialogs;
  /** How the open project syncs, see `CloudProjects`. */
  readonly cloud:
    | {
        subscribe(listener: () => void): () => void;
        getSnapshot(): CloudProjectsSnapshot;
      }
    | undefined;
  readonly store: () => ProjectStore | undefined;
  /** Tells the list of operations, see `OperationLog.heardRepo`. */
  readonly heard: (merges: RepoMergesHeard) => void;
  /** ...that merges were taken back or done again, see `OperationLog.heardTakenBack`. */
  readonly heardTakenBack?: (taken: {
    readonly undoes: readonly string[];
    readonly direction: "undo" | "redo";
  }) => void;
  /** ...that the project was renamed on the start page, see `OperationLog.heardRename`. */
  readonly heardRename?: (renamed: { readonly batch: string; readonly name: string }) => void;
  /** "撤销这次" of merges, see `BatchUndo`: undefined where the platform does not take them back. */
  readonly undo?: (batches: readonly string[], files: number) => void;
  /** Asks the platform how archiving goes, see `RepositoryWatch.refresh`. */
  readonly refresh: () => void;
}

const NOTHING: ReadonlySet<string> = new Set();

/** What one or more merges changed, for the notice and for looking at. */
export interface RepoMerge {
  readonly files: number;
  readonly merges: number;
  readonly away: boolean;
  readonly changes: readonly TurnChange[];
  /** Files people chose to take out, not a change of GitHub's. */
  readonly dropped?: boolean;
}

/** What the merges of a note changed, object by object, from what the store recorded. */
export function repoMergeOf(store: ProjectStore, note: CloudBatchNote): RepoMerge {
  const records = store.changesSince(note.revision) ?? [];
  const written = records.flatMap(({ paths }) => paths);
  const before = note.before;
  const after = store.getState();
  const changes =
    before === undefined
      ? []
      : describeChanges(before, after, written)
          .map(asTurnChange)
          .map((change) => withProjectFields(change, { paths: written, before }, after));
  return {
    files: note.batches.reduce((sum, { files }) => sum + files, 0),
    merges: note.batches.length,
    away: note.away,
    changes,
  };
}

/** The clips a merge changed or made, as the timeline marks them. */
export const markedOf = (merge: RepoMerge): ReadonlySet<string> =>
  new Set(
    merge.changes
      .filter(({ kind, change }) => kind === "clip" && change !== "removed")
      .map(({ id }) => id),
  );

export class RepoChanges {
  readonly #options: RepoChangesOptions;
  readonly #emitter = new Emitter();
  #snapshot: RepoChangesSnapshot = { marked: NOTHING };
  #session: CloudBatchSource | undefined;
  #stop: (() => void) | undefined;

  constructor(options: RepoChangesOptions) {
    this.#options = options;
    const cloud = options.cloud;
    if (!cloud) return;
    const follow = () => {
      const snapshot = cloud.getSnapshot();
      this.#follow(snapshot.kind === "linked" ? snapshot.session : undefined);
    };
    cloud.subscribe(follow);
    follow();
  }

  subscribe = this.#emitter.subscribe;
  getSnapshot = (): RepoChangesSnapshot => this.#snapshot;

  #follow(session: CloudBatchSource | undefined): void {
    if (session === this.#session) return;
    this.#stop?.();
    this.#session = session;
    this.#stop = session?.watchBatches((note) => this.heard(note));
    if (this.#snapshot.marked.size > 0) this.#set({ marked: NOTHING });
  }

  /** Merges of what changed on GitHub came in, see `CloudBatchNote`. */
  heard(note: CloudBatchNote): void {
    this.#heardMerges(note);
    // Renamed on the start page: the list says so, as what it is, and the title follows by itself.
    for (const batch of note.batches) {
      if (batch.kind !== "rename") continue;
      const name = this.#options.store()?.getState().manifest.name ?? "";
      this.#options.heardRename?.({ batch: batch.batch, name });
    }
    // Merges taken back as a whole, or done again: the list says so, nothing else changes. After
    // the merges of the same note, which take the place of "其他窗口" first.
    for (const direction of ["undo", "redo"] as const) {
      const undoes = note.batches.flatMap((batch) =>
        batch.kind === direction && batch.undoes !== undefined ? [batch.undoes] : [],
      );
      if (undoes.length > 0) {
        this.#options.heardTakenBack?.({ undoes, direction });
        this.#options.refresh();
      }
    }
  }

  #heardMerges(note: CloudBatchNote): void {
    // Files people chose to take out ("drop") are told as what they are, not as GitHub's.
    const dropped = note.batches.some(({ kind }) => kind === "drop");
    const repo = note.batches.filter(({ kind }) => kind === "repo" || kind === "drop");
    if (repo.length === 0) return;
    const store = this.#options.store();
    if (!store) return;
    const isDrop = dropped && repo.every(({ kind }) => kind === "drop");
    const merge = { ...repoMergeOf(store, { ...note, batches: repo }), dropped: isDrop };
    const { t, notifications } = this.#options;
    // Only GitHub's own changes can be taken back as a whole: what people chose to take out stays.
    const undoable = repo.filter(({ kind }) => kind === "repo").map(({ batch }) => batch);
    this.#options.heard({
      files: repo.map(({ files }) => files),
      away: note.away,
      ...(isDrop && { dropped: true }),
      ...(!isDrop && undoable.length > 0 && { batches: undoable }),
    });
    this.#set({ marked: markedOf(merge) });
    const message = isDrop
      ? t("repoMerge.notice.dropped", { count: merge.files })
      : merge.away
        ? t("repoMerge.notice.away", { merges: merge.merges, count: merge.files })
        : t("repoMerge.notice.merged", { count: merge.files });
    const undo = this.#options.undo;
    const actions = [
      ...(merge.changes.length > 0
        ? [{ label: t("repoMerge.notice.show"), run: () => void this.show(merge) }]
        : []),
      ...(undo && !isDrop && undoable.length > 0
        ? [{ label: t("operations.undoThis"), run: () => undo(undoable, merge.files) }]
        : []),
    ];
    notifications.push(message, { ...(actions.length > 0 && { actions }) });
    this.#options.refresh();
  }

  /** What merges changed, all of it, to read. */
  async show(merge: RepoMerge): Promise<void> {
    const { t, dialogs } = this.#options;
    const state = this.#options.store()?.getState();
    const lines = merge.changes.map((change) => changeLine(t, change, state));
    await dialogs.confirm({
      title: merge.dropped
        ? t("repoMerge.notice.dropped", { count: merge.files })
        : t("repoMerge.showTitle", { count: merge.files }),
      message: "",
      confirm: t("dialog.close"),
      noticeOnly: true,
      ...(lines.length > 0 && { details: [{ title: t("repoMerge.changes"), items: lines }] }),
    });
  }

  #set(next: Partial<RepoChangesSnapshot>): void {
    this.#snapshot = { ...this.#snapshot, ...next };
    this.#emitter.emit();
  }

  destroy(): void {
    this.#stop?.();
  }
}

/** What `RepoChanges` hears batches from, see `CloudSession.watchBatches`. */
interface CloudBatchSource {
  watchBatches(listener: (note: CloudBatchNote) => void): () => void;
}
