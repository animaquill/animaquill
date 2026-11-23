import type { ProjectState } from "@animaquill/core";
import {
  RepositoryRefused,
  type PlatformBatchNext,
  type PlatformBatchState,
  type RepositoryAccess,
} from "@animaquill/host";
import type { TFunction } from "i18next";
import type { Dialogs } from "../workbench/dialogs.ts";
import { Emitter } from "../workbench/emitter.ts";
import type { Notifications } from "../workbench/notifications.ts";
import { tellTakenBack } from "../workbench/undo-text.ts";

/**
 * Taking back a merge of changes on GitHub as a whole ("撤销这次", docs/design/start-and-cloud.md of
 * AnimaQuill Cloud, 10, 2E), or doing it again: the platform does it (`RepositoryAccess.undoBatch`),
 * from what it keeps of the merge, whichever window or computer asks, and the next archive writes
 * the project as it is then, so GitHub goes back too, which people confirm first. What anybody
 * changed since stays, as for an AI task (`tellTakenBack`). Whether it can, and why not, the
 * platform says for each batch (`RepositoryAccess.batch`), asked as the list of operations shows it
 * and kept until something changes. Files people chose to take out are never offered. No DOM.
 */

export interface BatchUndoOptions {
  readonly t: TFunction;
  readonly dialogs: Dialogs;
  readonly notifications: Notifications;
  /** The platform, and the project on it, while one of it is open. */
  readonly target: () =>
    { readonly access: RepositoryAccess; readonly project: string } | undefined;
  readonly state: () => ProjectState | undefined;
}

/** What the list of operations offers for merges, see `BatchUndo.stateOf`. */
export interface BatchUndoState {
  /** Undefined while the platform has not said, or says nothing can be done. */
  readonly direction?: "undo" | "redo";
  /** Why not, in the platform's words (`PlatformBatchState.why`). */
  readonly why?: string;
}

/** Codes of `why` that the list says in words of their own; others say it cannot be any more. */
const BATCH_WHYS = [
  "changed",
  "inUse",
  "count",
  "age",
  "rebuilt",
  "format",
  "locked",
  "unusable",
  "history",
  "drop",
] as const;

/** The key of the words for a `why`, see `operations.why`. */
export const batchWhyKey = (
  why: string,
): `operations.why.${(typeof BATCH_WHYS)[number] | "originGone"}` =>
  `operations.why.${(BATCH_WHYS as readonly string[]).includes(why) ? (why as (typeof BATCH_WHYS)[number]) : "originGone"}`;

export class BatchUndo {
  readonly #options: BatchUndoOptions;
  readonly #emitter = new Emitter();
  /** What the platform said of each batch, by its id, for the project of `#project`. */
  #states = new Map<string, PlatformBatchState | "asking" | "failed">();
  #project: string | undefined;
  #busy = false;
  #version = 0;

  constructor(options: BatchUndoOptions) {
    this.#options = options;
  }

  subscribe = this.#emitter.subscribe;
  /** Changes whenever what the platform said, or what is going on, does. */
  getSnapshot = (): number => this.#version;

  /** Asks the platform again, as after something changed what it would say. */
  forget(): void {
    this.#states.clear();
    this.#changed();
  }

  #changed(): void {
    this.#version += 1;
    this.#emitter.emit();
  }

  #target() {
    const target = this.#options.target();
    if (target?.project !== this.#project) {
      this.#project = target?.project;
      this.#states.clear();
    }
    return target;
  }

  /**
   * What can be done with merges as a whole: with several (as those that came while the editor was
   * away), all of them the same way, newest first. Asks the platform for what it has not said yet;
   * meanwhile it goes by whether this window heard them taken back (`undone`).
   */
  stateOf(batches: readonly string[], undone = false): BatchUndoState {
    const target = this.#target();
    if (!target?.access.batch || !target.access.undoBatch || batches.length === 0) return {};
    for (const batch of batches) if (!this.#states.has(batch)) void this.#ask(target, batch);
    const said: PlatformBatchState[] = [];
    for (const batch of batches) {
      const known = this.#states.get(batch);
      // As far as this window knows, until the platform says.
      if (known === undefined || known === "asking") return { direction: undone ? "redo" : "undo" };
      if (known === "failed") return {};
      said.push(known);
    }
    const directions = new Set(said.map(({ next }) => next?.direction));
    const why = said.find((each) => each.why !== undefined)?.why;
    const [direction] = directions;
    if (directions.size !== 1 || direction === undefined) return why === undefined ? {} : { why };
    return { direction, ...(why !== undefined && { why }) };
  }

  async #ask(
    target: { readonly access: RepositoryAccess; readonly project: string },
    batch: string,
  ): Promise<void> {
    this.#states.set(batch, "asking");
    let said: PlatformBatchState | "failed";
    try {
      said = (await target.access.batch?.(target.project, batch)) ?? "failed";
    } catch {
      said = "failed";
    }
    if (this.#project !== target.project) return;
    this.#states.set(batch, said);
    this.#changed();
  }

  /**
   * "撤销这次" for merges of `files` files, which people confirm, as GitHub goes back too; or doing
   * them again. Says what came of it.
   */
  async takeBack(
    batches: readonly string[],
    direction: "undo" | "redo",
    files: number,
    /** Whether people are asked first: for merges of GitHub, which the next archive takes back too. */
    { asks = true }: { readonly asks?: boolean } = {},
  ): Promise<void> {
    const { t, dialogs, notifications } = this.#options;
    const target = this.#target();
    if (!target?.access.undoBatch || batches.length === 0 || this.#busy) return;
    if (direction === "undo" && asks) {
      const sure = await dialogs.confirm({
        title: t("repoMerge.undo.title", { count: files }),
        message: t("repoMerge.undo.message"),
        confirm: t("repoMerge.undo.confirm"),
      });
      if (!sure) return;
    }
    this.#busy = true;
    const paths: (readonly string[])[] = [];
    const kept: (readonly string[])[] = [];
    let obstacle: "changed" | "inUse" | undefined;
    const again: PlatformBatchNext[] = [];
    let refused: string | undefined;
    try {
      // Newest first going back, oldest first going on again.
      const order = direction === "undo" ? batches.toReversed() : batches;
      for (const batch of order) {
        // The batch to take back for it, which the platform says: the last step, to do it again.
        let known = this.#states.get(batch);
        if (typeof known !== "object" || known.next?.direction !== direction)
          known = await target.access.batch?.(target.project, batch).catch(() => undefined);
        const next =
          typeof known === "object" && known.next?.direction === direction
            ? known.next.batch
            : batch;
        try {
          const taken = await target.access.undoBatch(target.project, next);
          paths.push(...taken.back, ...taken.kept);
          kept.push(...taken.kept);
          obstacle ??= taken.obstacle;
          again.unshift(taken.next);
        } catch (error) {
          refused =
            error instanceof RepositoryRefused && error.code === "notUndoable"
              ? (error.why ?? "failed")
              : "failed";
        }
      }
    } finally {
      this.#busy = false;
      this.forget();
    }
    if (paths.length === 0 && refused !== undefined) {
      notifications.push(
        refused === "failed" ? t("repoMerge.undo.failed") : t(batchWhyKey(refused)),
      );
      return;
    }
    tellTakenBack(
      this.#options,
      this.#options.state(),
      { direction, paths, kept, obstacle },
      direction === "undo" && again.length > 0
        ? () =>
            void this.takeBack(
              again.map(({ batch }) => batch),
              "redo",
              files,
              { asks },
            )
        : undefined,
    );
  }
}
