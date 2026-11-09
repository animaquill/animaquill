import type { FolderAccess, ProjectLibrary, SourceFolder, TargetFolder } from "@animaquill/host";
import type { Problem } from "@animaquill/schema";
import type { TFunction } from "i18next";
import type { DialogDetail, Dialogs, ProgressDialog } from "../workbench/dialogs.ts";
import type { Notifications } from "../workbench/notifications.ts";
import { projectKeyOf, type ProjectSession } from "../workbench/session.ts";
import { INCOMPLETE_FILE, exportProject, type ExportReport, type TransferStep } from "./export.ts";
import {
  ImportRefused,
  bringIn,
  pointingAtNothing,
  readProjectFolder,
  type ImportReport,
  type ProjectFolder,
} from "./import.ts";

/** Often enough to see it move, and little enough for the file to be what takes the time. */
const STEP_INTERVAL_MS = 100;
/** A dialog is no place for thousands of lines. */
const MAX_LISTED = 100;

export interface TransferOptions {
  readonly folders: FolderAccess;
  readonly projects: ProjectLibrary;
  readonly session: ProjectSession;
  readonly dialogs: Dialogs;
  readonly notifications: Notifications;
  readonly t: TFunction;
}

const sizeUnits = ["B", "KB", "MB", "GB", "TB"];

export function formatSize(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < sizeUnits.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${value.toFixed(unit > 1 ? 1 : 0)} ${sizeUnits[unit]}`;
}

/** Tells failures apart when people pass on what they got to read. */
const errorName = (error: unknown) => (error instanceof Error ? error.name : "Error");

/** Work that did not get to the end, and what to tell people about that. */
type Stopped = () => Promise<void>;

/** Moves projects out to folders and in from folders, and keeps people informed. */
export class ProjectTransfer {
  readonly #folders: FolderAccess;
  readonly #projects: ProjectLibrary;
  readonly #session: ProjectSession;
  readonly #dialogs: Dialogs;
  readonly #notifications: Notifications;
  readonly #t: TFunction;
  #running = false;
  #choosing = false;

  constructor(options: TransferOptions) {
    this.#folders = options.folders;
    this.#projects = options.projects;
    this.#session = options.session;
    this.#dialogs = options.dialogs;
    this.#notifications = options.notifications;
    this.#t = options.t;
  }

  /** Whether closing the page now would leave something unfinished. */
  get running(): boolean {
    return this.#running;
  }

  async #notice(title: string, message: string, details: readonly DialogDetail[] = []) {
    const confirm = this.#t("dialog.close");
    await this.#dialogs.confirm({ title, message, confirm, noticeOnly: true, details });
  }

  /** Keeps a dialog up with what is happening. */
  #follow(progress: ProgressDialog): (step: TransferStep) => void {
    const t = this.#t;
    let last = Number.NEGATIVE_INFINITY;
    return ({ file, done, total }) => {
      const now = performance.now();
      if (now - last < STEP_INTERVAL_MS) return;
      last = now;
      progress.update({
        detail: file,
        ...(total > 0
          ? {
              ratio: Math.min(done / total, 1),
              amount: t("transfer.amount", {
                done: formatSize(done),
                total: formatSize(total),
              }),
            }
          : {}),
      });
    };
  }

  /** Running ends where the work ends. What people still have to read is no reason to stay. */
  async #run<T>(work: () => Promise<T>): Promise<T> {
    this.#running = true;
    try {
      return await work();
    } finally {
      this.#running = false;
    }
  }

  /**
   * Asks for a folder. This comes first of all, because browsers only show the dialog right after
   * people did something, and a second click while it is open should not ask once more.
   */
  async #choose<T>(failed: string, choose: () => Promise<T | undefined>): Promise<T | undefined> {
    if (this.#running || this.#choosing) return undefined;
    this.#choosing = true;
    try {
      return await choose();
    } catch (error) {
      console.warn("No folder", error);
      await this.#notice(failed, this.#t("transfer.noAccess"));
      return undefined;
    } finally {
      this.#choosing = false;
    }
  }

  async exportProject(): Promise<void> {
    const t = this.#t;
    const store = this.#session.store;
    if (!store) return;
    const { name } = store.getState().manifest;
    const target = await this.#choose(t("transfer.exportFailed"), () =>
      this.#folders.chooseTarget(name),
    );
    if (!target) return;

    const announce = await this.#run(async () => {
      const progress = this.#dialogs.progress({
        title: t("transfer.exporting", { name }),
        cancel: t("dialog.cancel"),
        stopping: t("transfer.stopping"),
      });
      const { signal } = progress;
      const show = this.#follow(progress);
      let current = INCOMPLETE_FILE;
      try {
        const report = await exportProject(
          store,
          this.#projects.media(projectKeyOf(store)),
          target,
          {
            notice: t("transfer.incompleteNotice"),
            signal,
            onStep: (step) => {
              current = step.file;
              show(step);
            },
          },
        );
        return () => this.#announceExport(target, report);
      } catch (error) {
        const cleaned = await this.#takeBack(target);
        return () => this.#exportStopped(error, target, current, cleaned, signal.aborted);
      } finally {
        progress.close();
      }
    });
    await announce();
  }

  /** Resolves to whether all of it is gone. */
  async #takeBack(target: TargetFolder): Promise<boolean> {
    try {
      await target.abandon();
      return true;
    } catch (error) {
      console.warn("An unfinished export stayed behind", error);
      return false;
    }
  }

  async #exportStopped(
    error: unknown,
    target: TargetFolder,
    file: string,
    cleaned: boolean,
    cancelled: boolean,
  ) {
    const t = this.#t;
    if (cancelled && cleaned) {
      this.#notifications.push(t("transfer.exportCancelled"));
      return;
    }
    if (!cancelled) console.warn("Export stopped", error);
    const left = cleaned
      ? t("transfer.nothingLeft")
      : t("transfer.leftBehind", { folder: target.name, file: INCOMPLETE_FILE });
    const reason = cancelled
      ? t("transfer.exportCancelled")
      : t("transfer.writeFailed", { file, error: errorName(error) });
    await this.#notice(t("transfer.exportFailed"), `${reason}${left}`);
  }

  async #announceExport(target: TargetFolder, report: ExportReport) {
    const t = this.#t;
    const { missing, clashing, refused, tooLarge, problems } = report;
    const message =
      target.kind === "archive"
        ? t("transfer.exportedArchive", { folder: target.name })
        : t("transfer.exported", { folder: target.name });
    const left = [
      this.#list(t("transfer.exportMissing"), missing),
      this.#list(t("transfer.exportClashing"), clashing),
      this.#list(t("transfer.exportRefused"), refused),
      this.#list(t("transfer.exportProblems"), problems.map(this.#describe)),
    ].filter((detail) => detail.items.length > 0);
    const title = left.length > 0 ? t("transfer.exportedPartly") : t("transfer.exportedTitle");
    const details = [...left, this.#list(t("transfer.exportTooLarge"), tooLarge)];
    await this.#notice(
      title,
      message,
      details.filter((detail) => detail.items.length > 0),
    );
  }

  #list(title: string, items: readonly string[]): DialogDetail {
    const t = this.#t;
    const shown = items.slice(0, MAX_LISTED);
    const more = items.length - shown.length;
    return {
      title: t("transfer.listTitle", { title, count: items.length }),
      items: more > 0 ? [...shown, t("transfer.andMore", { count: more })] : shown,
    };
  }

  #describe = ({ file, path, message }: Problem): string =>
    this.#t("transfer.problem", { place: path ? `${file} ${path}` : file, message });

  /** Resolves to what came in, for the caller to open. */
  async importProject(): Promise<ImportReport | undefined> {
    const t = this.#t;
    const source = await this.#choose(t("transfer.importFailed"), () => this.#askForSource());
    if (!source) return undefined;

    const folder = await this.#importStep(
      source,
      t("transfer.reading", { folder: source.name }),
      async (options) => {
        const found = await readProjectFolder(source, t, options);
        // Past this point nothing looks at it any more, and the next step has a button of its own.
        options.signal.throwIfAborted();
        return found;
      },
    );
    if (typeof folder === "function") {
      await folder();
      return undefined;
    }
    if (folder.lost.length > 0 && !(await this.#agreeToLose(folder, source.name))) {
      this.#notifications.push(t("transfer.importCancelled"));
      return undefined;
    }

    const { name } = folder.project.manifest;
    const report = await this.#importStep(source, t("transfer.importing", { name }), (options) =>
      bringIn(folder, this.#projects, {
        copyName: (original) => t("transfer.copyName", { name: original }),
        ...options,
      }),
    );
    if (typeof report !== "function") return report;
    await report();
    return undefined;
  }

  /** One part of an import, which people can follow and stop. */
  #importStep<T>(
    source: SourceFolder,
    title: string,
    work: (options: {
      readonly signal: AbortSignal;
      readonly onStep: (step: TransferStep) => void;
    }) => Promise<T>,
  ): Promise<T | Stopped> {
    const t = this.#t;
    return this.#run(async () => {
      const progress = this.#dialogs.progress({
        title,
        cancel: t("dialog.cancel"),
        stopping: t("transfer.stopping"),
      });
      const { signal } = progress;
      try {
        return await work({ signal, onStep: this.#follow(progress) });
      } catch (error) {
        return () => this.#importStopped(error, source.name, signal.aborted);
      } finally {
        progress.close();
      }
    });
  }

  /**
   * Whether people want a project with these parts missing. This is the one question an import
   * asks: anything but the one button means no, because the folder is all they have. Nothing is
   * going on meanwhile, so it runs outside of `#run`.
   */
  #agreeToLose({ lost, warnings }: ProjectFolder, folder: string): Promise<boolean> {
    const t = this.#t;
    const details = [
      this.#list(
        t("transfer.skipLost"),
        lost.map(({ consequence }) => consequence),
      ),
      this.#list(t("transfer.skipAffected"), pointingAtNothing(warnings).map(this.#describe)),
      this.#list(
        t("transfer.skipReasons"),
        lost.flatMap(({ problems }) => problems).map(this.#describe),
      ),
    ];
    return this.#dialogs.confirm({
      title: t("transfer.skipTitle"),
      message: t("transfer.skipMessage", { folder, count: lost.length }),
      confirm: t("transfer.skipConfirm"),
      danger: true,
      details: details.filter((detail) => detail.items.length > 0),
    });
  }

  /** People can take their time in the dialog, and what the browser asks comes after it. */
  async #askForSource() {
    const notifications = this.#notifications;
    const hint = this.#folders.asksToUpload
      ? notifications.push(this.#t("transfer.uploadHint"), { stays: true })
      : undefined;
    try {
      return await this.#folders.chooseSource();
    } finally {
      if (hint !== undefined) notifications.dismiss(hint);
    }
  }

  async #importStopped(error: unknown, folder: string, cancelled: boolean) {
    const t = this.#t;
    if (cancelled) {
      this.#notifications.push(t("transfer.importCancelled"));
      return;
    }
    if (error instanceof ImportRefused) {
      const { reason, problems } = error;
      const items = reason === "too-new" ? [] : problems.map(this.#describe);
      const message = t(`transfer.refused.${reason}`, {
        folder,
        detail: problems[0]?.message ?? "",
      });
      const details = items.length > 0 ? [this.#list(t("transfer.refusedList"), items)] : [];
      await this.#notice(t("transfer.refusedTitle"), message, details);
      return;
    }
    console.warn("Import stopped", error);
    const name = errorName(error);
    const reason =
      name === "QuotaExceededError"
        ? t("transfer.storageFull")
        : t("transfer.readFailed", { error: name });
    await this.#notice(t("transfer.importFailed"), reason);
  }

  /** Says what people have to know about a project that just came in. */
  /** What people bring in can be from anybody, and this is the moment before any of it runs. */
  async warnAboutCode({ name, runsCode }: ImportReport): Promise<void> {
    if (!runsCode) return;
    const t = this.#t;
    await this.#dialogs.confirm({
      title: t("transfer.codeTitle"),
      message: t("transfer.codeWarning", { name }),
      confirm: t("transfer.codeConfirm"),
      noticeOnly: true,
    });
  }

  async announceImport(report: ImportReport): Promise<void> {
    const t = this.#t;
    const { name, copied, missing, damaged, skipped, lost, warnings } = report;
    const details = [
      this.#list(t("transfer.importLost"), lost),
      this.#list(t("transfer.importMissing"), missing),
      this.#list(t("transfer.importDamaged"), damaged),
      this.#list(t("transfer.importSkipped"), skipped),
      this.#list(t("transfer.importWarnings"), warnings.map(this.#describe)),
    ].filter((detail) => detail.items.length > 0);
    if (details.length === 0 && !copied) {
      this.#notifications.push(t("transfer.imported", { name }));
      return;
    }
    const message = [
      t("transfer.imported", { name }),
      ...(copied ? [t("transfer.importedCopy")] : []),
      ...(lost.length > 0 ? [t("transfer.importLostHint")] : []),
      ...(missing.length + damaged.length > 0 ? [t("transfer.importHint")] : []),
    ].join("");
    await this.#notice(t("transfer.importedTitle"), message, details);
  }
}
