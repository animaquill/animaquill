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
    const repo = note.batches.filter(({ kind }) => kind === "repo");
    if (repo.length === 0) return;
    const store = this.#options.store();
    if (!store) return;
    const merge = repoMergeOf(store, { ...note, batches: repo });
    const { t, notifications } = this.#options;
    this.#options.heard({ files: repo.map(({ files }) => files), away: note.away });
    this.#set({ marked: markedOf(merge) });
    const message = merge.away
      ? t("repoMerge.notice.away", { merges: merge.merges, count: merge.files })
      : t("repoMerge.notice.merged", { count: merge.files });
    notifications.push(message, {
      ...(merge.changes.length > 0 && {
        actions: [{ label: t("repoMerge.notice.show"), run: () => void this.show(merge) }],
      }),
    });
    this.#options.refresh();
  }

  /** What merges changed, all of it, to read. */
  async show(merge: RepoMerge): Promise<void> {
    const { t, dialogs } = this.#options;
    const state = this.#options.store()?.getState();
    const lines = merge.changes.map((change) => changeLine(t, change, state));
    await dialogs.confirm({
      title: t("repoMerge.showTitle", { count: merge.files }),
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
