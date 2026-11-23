import type { ProjectStore } from "@animaquill/core";
import {
  gitHubUrlOf,
  type RepositoryAccess,
  type RepositoryConflict,
  type RepositoryStatus,
} from "@animaquill/host";
import type { TFunction } from "i18next";
import type { Dialogs } from "../workbench/dialogs.ts";
import type { Notifications } from "../workbench/notifications.ts";
import { ConflictList } from "./conflicts.ts";
import type { CloudProjectsSnapshot } from "./projects.ts";
import { divergedOutcome } from "./repository-text.ts";
import type { CloudSnapshot } from "./session.ts";

/**
 * What people do about merging changes on GitHub where it waits for them (docs/design/start-and-
 * cloud.md of AnimaQuill Cloud, 10): the notice that stays while conflicts wait, the list of
 * conflicts, files on GitHub that did not go in, a history on GitHub that was rewritten, files
 * GitHub took away that the project still has, and which side merges keep first. Words are few:
 * the states and the choices say what there is to do. No DOM.
 */

export interface RepoMergesOptions {
  readonly t: TFunction;
  readonly dialogs: Dialogs;
  readonly notifications: Notifications;
  readonly access: RepositoryAccess | undefined;
  /** How the open project syncs, see `CloudProjects`. */
  readonly cloud: {
    subscribe(listener: () => void): () => void;
    getSnapshot(): CloudProjectsSnapshot;
    switchRepository(): Promise<void>;
  };
  readonly store: () => ProjectStore | undefined;
  /** Goes to what a conflict is about: the clip, the lines of code. */
  readonly locate: (conflict: RepositoryConflict) => void;
  /** Opens a file of code where people change it. */
  readonly openFile: (path: string) => void;
  /** Opens a file on GitHub, or anything there, in a new tab. */
  readonly open: (url: string) => void;
  /** How long a change of people's waits to get to the platform before a choice goes without. */
  readonly sendMs?: number;
}

/** A change waits this long for the platform before what people chose goes without saying when. */
const SEND_MS = 15_000;

export class RepoMerges {
  readonly #options: RepoMergesOptions;
  /** The notice that stays while conflicts wait, and how many it says. */
  #notice: { readonly id: number; readonly count: number } | undefined;
  #watching: { readonly subscribe: (listener: () => void) => () => void } | undefined;
  #stopWatch: (() => void) | undefined;
  #list: ConflictList | undefined;

  constructor(options: RepoMergesOptions) {
    this.#options = options;
    const follow = () => this.#follow();
    options.cloud.subscribe(follow);
    follow();
  }

  get #linked() {
    const snapshot = this.#options.cloud.getSnapshot();
    return snapshot.kind === "linked" ? snapshot : undefined;
  }

  get #status(): RepositoryStatus | undefined {
    return this.#linked?.repository?.status;
  }

  /** Follows how archiving the open project goes, for the notice that stays while conflicts wait. */
  #follow(): void {
    const watch = this.#linked?.repository;
    if (watch !== this.#watching) {
      this.#stopWatch?.();
      this.#watching = watch;
      this.#stopWatch = watch?.subscribe(() => this.#tell());
    }
    this.#tell();
  }

  #tell(): void {
    const { t, notifications } = this.#options;
    const status = this.#status;
    const count =
      status?.state === "paused" && status.reason === "conflicts" ? (status.conflicts ?? 0) : 0;
    if (count === 0) {
      if (this.#notice) notifications.dismiss(this.#notice.id);
      this.#notice = undefined;
      return;
    }
    if (this.#notice?.count === count) return;
    const id = notifications.update(this.#notice?.id, t("repoMerge.notice.conflicts", { count }), {
      stays: true,
      actions: [{ label: t("repoMerge.notice.resolve"), run: () => void this.openConflicts() }],
    });
    this.#notice = { id, count };
  }

  /** What the panel's "处理…" does, by why archiving waits. */
  async resolve(): Promise<void> {
    const reason = this.#status?.reason;
    if (reason === "conflicts") return this.openConflicts();
    if (reason === "rewritten") return this.rewritten();
    if (reason === "unmerged") return this.unmerged();
    if (reason === "blocked") return this.blocked();
  }

  /** The list of conflicts, as a dialog: it stays until people close it. */
  async openConflicts(): Promise<void> {
    const { access, dialogs, t } = this.#options;
    const linked = this.#linked;
    if (!access || !linked) return;
    this.#list?.close();
    const session = linked.session;
    const list = new ConflictList({
      access,
      project: linked.link.project,
      store: this.#options.store,
      sent: () => sentOf(session, this.#options.sendMs ?? SEND_MS),
      status: (status) => linked.repository?.take(status, { hurry: status.archiving }),
    });
    this.#list = list;
    void list.load();
    await dialogs.conflicts({
      title: t("repoMerge.list.titleDone"),
      list,
      archiving: () => this.#linked?.repository?.status?.archiving === true,
      locate: (conflict) => this.#options.locate(conflict),
      openFile: (path) => this.#options.openFile(path),
      open: (url) => this.#options.open(url),
    });
    list.close();
    if (this.#list === list) this.#list = undefined;
    void linked.repository?.refresh();
  }

  /**
   * Files on GitHub the merge did not take in (screen G3, top left): which, and what was wrong;
   * putting them right on GitHub merges again by itself, or the project's version goes over them.
   */
  async blocked(): Promise<void> {
    const { access, dialogs, t } = this.#options;
    const linked = this.#linked;
    const status = this.#status;
    const repository = status?.repository;
    const files = (status?.blocked ?? []).filter(({ reason }) => reason !== "locked");
    if (!access?.useEditor || !linked || !repository || files.length === 0) return;
    const store = this.#options.store();
    const has = new Set(store ? store.exportFiles().files.keys() : []);
    // The list above names the files: a button names its file only where there are more.
    const named = (label: string, path: string) =>
      files.length > 1 ? `${label} · ${path}` : label;
    const web = gitHubUrlOf(repository);
    const choices = files.flatMap(({ path }) => [
      ...(web === undefined
        ? []
        : [{ id: `open:${path}`, label: named(`${t("repoMerge.blocked.openOnGitHub")} ↗`, path) }]),
      {
        id: `use:${path}`,
        label: named(
          t(has.has(path) ? "repoMerge.blocked.useHere" : "repoMerge.blocked.deleteOnGitHub"),
          path,
        ),
      },
    ]);
    const answer = await dialogs.choose({
      title: t("repoMerge.blocked.title"),
      message: "",
      notes: files.map(
        ({ path, reason, detail }) =>
          `${path}：${detail ?? t(`repoMerge.blocked.reason.${reason}`, { defaultValue: reason })}`,
      ),
      choices,
      stacked: true,
    });
    if (!answer) return;
    const [kind, ...rest] = answer.split(":");
    const path = rest.join(":");
    if (kind === "open" && web !== undefined) {
      this.#options.open(`${web}/blob/${encodeURIComponent(repository.branch)}/${path}`);
      return;
    }
    const isThere = has.has(path);
    const sure = await dialogs.confirm({
      title: t(isThere ? "repoMerge.blocked.useHereTitle" : "repoMerge.blocked.deleteTitle", {
        path,
        interpolation: { escapeValue: false },
      }),
      message: t("repoMerge.blocked.useHereMessage"),
      confirm: t(isThere ? "repoMerge.blocked.confirmUse" : "repoMerge.blocked.confirmDelete"),
      danger: true,
    });
    if (!sure || this.#linked !== linked) return;
    try {
      linked.repository?.take(await access.useEditor(linked.link.project, path), { hurry: true });
    } catch {
      this.#options.notifications.push(t("repoMerge.list.busy"));
    }
  }

  /**
   * The history on GitHub was rewritten (screen G3, bottom left): nothing was merged. People go on
   * with what the project has, merge what GitHub has now from what both have, or take another
   * repository.
   */
  async rewritten(): Promise<void> {
    const { access, dialogs, t } = this.#options;
    const linked = this.#linked;
    const status = this.#status;
    const diverged = status?.reason === "rewritten" ? status.diverged : undefined;
    if (!access || !linked || !diverged) return;
    const restored = this.#restored(diverged);
    // What going on would commit again is said where people choose it, file by file.
    const answer = await dialogs.choose({
      title: t("repoMerge.rewritten.title"),
      message: "",
      choices: [
        { id: "continue", label: t("repoMerge.rewritten.continue"), kind: "primary" },
        ...(diverged.base !== undefined && access.mergeNow
          ? [{ id: "merge", label: t("repoMerge.rewritten.mergeNow") }]
          : []),
        { id: "switch", label: t("repoMerge.rewritten.switch") },
      ],
      stacked: true,
    });
    if (!answer || this.#linked !== linked) return;
    if (answer === "switch") return this.#options.cloud.switchRepository();
    if (answer === "merge" && access.mergeNow) {
      try {
        linked.repository?.take(await access.mergeNow(linked.link.project, diverged.sha), {
          hurry: true,
        });
      } catch {
        this.#options.notifications.push(t("repoMerge.list.busy"));
        void linked.repository?.refresh();
      }
      return;
    }
    await this.#goOn(diverged, restored);
  }

  /**
   * After a rewritten history, files that GitHub took away and the project still has, which the
   * platform cannot tell apart from the project's own: going on would commit them again, and they
   * may be what was taken away on purpose, such as a secret. Each is taken out of the project or
   * committed again, as people say, one by one.
   */
  async unmerged(): Promise<void> {
    const status = this.#status;
    const diverged = status?.reason === "unmerged" ? status.diverged : undefined;
    if (!diverged) return;
    // What GitHub took away and the project has: what it changed and still has goes over it.
    await this.#goOn(diverged, this.#inProject(diverged.deleted));
  }

  /** The files of a list the project has. */
  #inProject(paths: readonly string[]): string[] {
    const store = this.#options.store();
    if (!store) return [...paths];
    const { files } = store.exportFiles();
    return paths.filter((path) => files.has(path));
  }

  /** Of what changed on GitHub, the files it took away that the project still has. */
  #restored(diverged: NonNullable<RepositoryStatus["diverged"]>): string[] {
    const store = this.#options.store();
    if (!store) return [];
    const { files } = store.exportFiles();
    return [...divergedOutcome(diverged, (path) => files.has(path)).restored];
  }

  /**
   * Goes on with the editor's content on top of GitHub's commit (`replace`), where `restored` would
   * be committed again unless people take them out first (`drop`), each as they choose.
   */
  async #goOn(
    diverged: NonNullable<RepositoryStatus["diverged"]>,
    restored: readonly string[],
  ): Promise<void> {
    const { dialogs, t, notifications } = this.#options;
    const linked = this.#linked;
    const watch = linked?.repository;
    if (!linked || !watch) return;
    let drop: string[] = [];
    if (restored.length > 0) {
      const answer = await dialogs.reconcile({
        title: t("repoMerge.unmerged.title"),
        message: t("repoMerge.unmerged.message"),
        // Nothing chosen to start with: each file is people's to say, as either way is for good.
        items: restored.map((path) => ({
          path,
          status: "",
          options: [
            { id: "drop", label: t("repoMerge.unmerged.drop") },
            { id: "keep", label: t("repoMerge.unmerged.keep") },
          ],
          value: "",
        })),
        all: [
          { id: "drop", label: t("repoMerge.unmerged.allDrop") },
          { id: "keep", label: t("repoMerge.unmerged.allKeep") },
        ],
        notes: [],
        confirm: t("repoMerge.unmerged.confirm"),
        summarize: (values) => {
          const dropped = restored.filter((path) => values[path] === "drop").length;
          const kept = restored.filter((path) => values[path] === "keep").length;
          const parts = [
            ...(dropped > 0 ? [t("repoMerge.unmerged.confirmDrop", { count: dropped })] : []),
            ...(kept > 0 ? [t("repoMerge.unmerged.confirmKeep", { count: kept })] : []),
          ];
          return {
            text: "",
            confirm:
              parts.length === 0
                ? t("repoMerge.unmerged.confirm")
                : t("repoMerge.unmerged.confirmGo", { parts: parts.join("、") }),
            loud: false,
            ready: dropped + kept === restored.length,
          };
        },
      });
      if (!answer || this.#linked !== linked) return;
      if (restored.some((path) => answer[path] !== "drop" && answer[path] !== "keep")) return;
      drop = restored.filter((path) => answer[path] === "drop");
    }
    const outcome = await watch.archiveNow({
      replace: diverged.sha,
      ...(drop.length > 0 && { drop }),
    });
    if (outcome.kind === "refused")
      notifications.push(
        outcome.code === "diverged" ? t("repository.replaceChanged") : t("repoMerge.list.busy"),
      );
  }

  /** Which side merges keep first, as people chose in the project's properties. */
  async setPrefer(prefer: "editor" | "github"): Promise<boolean> {
    const { access } = this.#options;
    const linked = this.#linked;
    if (!access?.prefer || !linked) return false;
    try {
      linked.repository?.take(await access.prefer(linked.link.project, prefer));
      return true;
    } catch {
      return false;
    }
  }

  destroy(): void {
    this.#stopWatch?.();
    this.#list?.close();
  }
}

/**
 * Resolves to the update of the platform that has what was changed here so far, once nothing of
 * this window waits to get there and it has answered; undefined where that takes longer than `ms`.
 */
export function sentOf(
  session: {
    getSnapshot(): Pick<CloudSnapshot, "pending" | "seq" | "state">;
    subscribe(listener: () => void): () => void;
  },
  ms: number,
): Promise<number | undefined> {
  const from = session.getSnapshot().seq;
  return new Promise((resolve) => {
    let done = false;
    let stop: () => void = () => {};
    const finish = (seq: number | undefined) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      stop();
      resolve(seq);
    };
    const look = () => {
      const { pending, seq, state } = session.getSnapshot();
      // The change went into the log and out: the platform took it, as a new update of its own.
      if (state === "online" && pending === 0 && seq > from) finish(seq);
    };
    const timer = setTimeout(() => finish(undefined), ms);
    stop = session.subscribe(look);
    // The log takes the change a moment after it was made.
    setTimeout(look, 50);
  });
}
