/**
 * Projects that are folders on this computer, as people work with them: making one, opening one that
 * they chose, dropped or opened before, letting the editor at it again, finding it when it moved,
 * and keeping it in step while it is open, see `FolderSession`. What is in a folder and what this
 * browser keeps of it is `FolderProjects`; this is the part that asks people and tells them.
 */
import type { ProjectStore } from "@animaquill/core";
import type {
  AccessAnswer,
  FolderRecord,
  FolderStatus,
  LocalFolder,
  LocalFolders,
  ProjectAddress,
  ProjectLibrary,
} from "@animaquill/host";
import type { TFunction } from "i18next";
import { FolderProjects, type FolderLook, type RecentFolder } from "../folder/projects.ts";
import {
  FolderSession,
  type FolderMerge,
  type FolderSnapshot,
  type FolderTiming,
} from "../folder/session.ts";
import type { ProblemList } from "../problems/list.ts";
import type { ImportReport } from "../transfer/import.ts";
import type { ConfirmOptions, Dialogs } from "./dialogs.ts";
import { Emitter } from "./emitter.ts";
import type { Notifications } from "./notifications.ts";
import type { ProjectSession } from "./session.ts";

/** The project folder that is open in this window, and how it is. */
export interface OpenFolder {
  readonly record: FolderRecord;
  readonly snapshot: FolderSnapshot;
}

/**
 * The project folder that the address of this window asks for, which cannot open by itself: people
 * have to let the editor at it first, or find it where it is now.
 */
export interface WaitingFolder {
  readonly record: FolderRecord;
  readonly status: Exclude<FolderStatus, "ready">;
}

export interface ProjectFoldersSnapshot {
  readonly open: OpenFolder | undefined;
  readonly waiting: WaitingFolder | undefined;
}

export interface ProjectFoldersOptions {
  readonly folders: LocalFolders;
  readonly projects: ProjectLibrary;
  readonly session: ProjectSession;
  readonly address: ProjectAddress;
  readonly dialogs: Dialogs;
  readonly notifications: Notifications;
  readonly problems: ProblemList;
  readonly t: TFunction;
  /** Leaves the open project, then does the next thing, see `Workbench`. */
  readonly changeProject: (next: () => Promise<unknown>) => Promise<void>;
  /** For a project that comes into this browser for the first time, before it opens. */
  readonly warnAboutCode: (report: ImportReport) => Promise<void>;
  /** The same once it is open, for what people should see in the list of problems. */
  readonly noteArrival: (report: ImportReport) => void;
  /** What an export of the project kept, which goes with what this browser keeps of it. */
  readonly letGo: (id: string) => Promise<void>;
  readonly showProblems: () => void;
  readonly timing?: Partial<FolderTiming>;
}

interface Current {
  readonly session: FolderSession;
  readonly store: ProjectStore;
  record: FolderRecord;
  readonly stop: () => void;
}

/** More than anybody reads: what of the folder did not come in, since the project opened. */
const MAX_CONFLICTS = 200;
/** What of a value the folder had is shown, at most. */
const MAX_SHOWN = 4000;

const NOTHING: ProjectFoldersSnapshot = { open: undefined, waiting: undefined };

/** A value the way people can read it. */
function shown(value: unknown, t: TFunction): string {
  if (value === undefined) return t("folder.theirsRemoved");
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return text.length > MAX_SHOWN ? `${text.slice(0, MAX_SHOWN)}…` : text;
}

export class ProjectFolders {
  readonly projects: FolderProjects;
  readonly #options: ProjectFoldersOptions;
  readonly #emitter = new Emitter();
  #current: Current | undefined;
  #waiting: WaitingFolder | undefined;
  #snapshot = NOTHING;
  /** What of the folder did not come in, as problems. */
  #conflicts: Parameters<ProblemList["setFolder"]>[0] = [];

  constructor(options: ProjectFoldersOptions) {
    this.#options = options;
    this.projects = new FolderProjects({
      folders: options.folders,
      projects: options.projects,
      t: options.t,
    });
  }

  subscribe = this.#emitter.subscribe;
  getSnapshot = (): ProjectFoldersSnapshot => this.#snapshot;

  /** The folder session of the open project, if it is a folder. */
  get session(): FolderSession | undefined {
    return this.#current?.session;
  }

  /** The folders opened in this browser, and how each is now. */
  recent(): Promise<readonly RecentFolder[]> {
    return this.projects.recent();
  }

  /**
   * Opens the project folder that the address of this window asks for, or says what it waits for.
   * Resolves to whether the address asks for a folder at all.
   */
  async restore(): Promise<boolean> {
    const id = this.#options.address.read();
    if (id === undefined) return false;
    const record = await this.projects.records.get(id).catch(() => undefined);
    if (!record) return false;
    const status = await record.folder.status().catch((): FolderStatus => "gone");
    if (status === "ready") await this.#open(record);
    else this.#setWaiting({ record, status });
    return true;
  }

  /** Writes what is waiting, right away: for Ctrl+S, and for a page that goes to the background. */
  async flush(): Promise<void> {
    await this.#current?.session.flush();
  }

  /** Writes what is waiting, and lets go of the folder, for the next project or the start page. */
  async close(): Promise<void> {
    const current = this.#current;
    if (!current) return;
    this.#current = undefined;
    current.stop();
    this.#conflicts = [];
    this.#changed();
    await current.session.close();
    // The list on the start page shows what the project is called now.
    const { name } = current.store.getState().manifest;
    if (name !== current.record.name)
      await this.projects.opened(current.record, name).catch(() => {});
  }

  /** Lets go of a folder whose project is not the open one any more, however that happened. */
  followSession(): void {
    const { store } = this.#options.session;
    const current = this.#current;
    if (current && store !== current.store) void this.close();
    // Another project opened: the address asks for that one now.
    if (store && this.#waiting) this.#setWaiting(undefined);
  }

  /** Makes a new project: what it is called, then where it goes, see the design, 3.2. */
  async create(): Promise<void> {
    const { dialogs, t } = this.#options;
    const name = await dialogs.prompt({
      title: t("project.nameLabel"),
      value: t("project.defaultName"),
      hint: t("folder.chooseHint"),
      confirm: t("folder.chooseFolder"),
    });
    if (!name) return;
    const folder = await this.#choose();
    if (folder) await this.#createIn(folder, name);
  }

  /** Asks for a folder, and opens the project in it. */
  async open(): Promise<void> {
    const folder = await this.#choose();
    if (folder) await this.#openChosen(folder, "granted");
  }

  /**
   * Opens what people dropped, which has to be called in the `drop` event: the browser lets go of
   * what was dropped once it is over. Dropping counts as people doing something, so the editor asks
   * for writing right away.
   */
  dropped(transfer: DataTransfer): void {
    const { folders, notifications, t } = this.#options;
    const entries = folders.dropped(transfer);
    void entries
      .then(async (all) => {
        const entry = all.find((each) => each.kind === "folder");
        if (entry?.kind !== "folder") {
          if (all.length > 0) notifications.push(t("folder.droppedNoFolder"));
          return;
        }
        const answer = await entry.folder.requestAccess();
        await this.#openChosen(entry.folder, answer);
      })
      .catch((error: unknown) => this.#failed(error));
  }

  /** A folder opened before, from the list on the start page. */
  async openRecent(record: FolderRecord): Promise<void> {
    const status = await record.folder.status().catch((): FolderStatus => "gone");
    if (status === "gone") {
      await this.#findAgainOrNot(record);
      return;
    }
    if (status === "blocked") {
      this.#options.notifications.push(this.#options.t("folder.blocked", { name: record.name }));
      return;
    }
    if (status === "ask" && (await record.folder.requestAccess()) !== "granted") return;
    this.#setWaiting(undefined);
    await this.#options.changeProject(() => this.#open(record));
  }

  /**
   * Another place of a folder that is not where it was any more. A folder knows only its place, so
   * whatever people choose has to be this project.
   */
  async findAgain(record: FolderRecord): Promise<void> {
    const { notifications, t } = this.#options;
    const folder = await this.#choose();
    if (!folder) return;
    const current = this.#current;
    if (current?.record.id === record.id) {
      const answer = await current.session.reconnect(folder);
      if (answer === "connected") {
        current.record = { ...current.record, folder };
        await this.projects.opened(current.record).catch(() => {});
        this.#changed();
      } else {
        notifications.push(t(`folder.reconnect.${answer}`, { name: record.name }));
      }
      return;
    }
    const found = await this.projects
      .findAgain(record, folder)
      .catch(() => "not-a-project" as const);
    if (found !== "found") {
      notifications.push(t(`folder.reconnect.${found}`, { name: record.name }));
      return;
    }
    this.#setWaiting(undefined);
    await this.#options.changeProject(() => this.#open({ ...record, folder }));
  }

  /** Lets the editor at the open folder again, after the browser took that back. */
  async allowAgain(): Promise<void> {
    const current = this.#current;
    if (!current) return;
    if ((await current.record.folder.requestAccess()) !== "granted") return;
    await current.session.reconnect();
  }

  /**
   * Writes what the editor has over files that wait for people, or puts back the whole project
   * where animaquill.json went away. What the folder had goes to .animaquill/recovered first.
   */
  async writeEditorContent(paths?: readonly string[]): Promise<void> {
    await this.#current?.session.useEditorContent(paths);
  }

  /** Takes a folder off the list. Nothing happens to the folder. */
  async remove(record: FolderRecord): Promise<boolean> {
    const { dialogs, notifications, t } = this.#options;
    const confirmed = await dialogs.confirm({
      title: t("folder.removeTitle", { name: record.name }),
      message: t("folder.removeMessage"),
      confirm: t("folder.remove"),
    });
    if (!confirmed) return false;
    try {
      await this.#options.letGo(record.id);
      await this.projects.forget(record.id);
      if (this.#waiting?.record.id === record.id) this.#setWaiting(undefined);
      return true;
    } catch (error) {
      console.warn("A folder could not be taken off the list", error);
      notifications.push(t("folder.removeFailed"));
      return false;
    }
  }

  async #choose(): Promise<LocalFolder | undefined> {
    try {
      return await this.#options.folders.choose();
    } catch (error) {
      this.#failed(error);
      return undefined;
    }
  }

  #failed(error: unknown): void {
    console.warn("A project folder could not be opened", error);
    this.#options.notifications.push(this.#options.t("folder.failed"));
  }

  async #createIn(folder: LocalFolder, name: string): Promise<void> {
    const { dialogs, notifications, t } = this.#options;
    let inside: string | undefined;
    try {
      const place = await this.projects.placeFor(folder, name);
      if (place.kind === "project") {
        const open = await dialogs.confirm({
          title: t("folder.isProjectTitle", { folder: folder.name }),
          message: t("folder.isProjectMessage"),
          confirm: t("folder.openIt"),
        });
        if (open) await this.#openChosen(folder, "granted");
        return;
      }
      if (place.kind === "incomplete") {
        await this.#notice(t("folder.incompleteTitle"), t("folder.incompleteForNew"));
        return;
      }
      if (place.kind === "other") {
        const answer = await dialogs.choose({
          title: t("folder.notEmptyTitle", { folder: folder.name }),
          message: t("folder.notEmptyMessage", { inside: place.inside }),
          choices: [
            { id: "here", label: t("folder.putHere") },
            {
              id: "inside",
              label: t("folder.putInside", { inside: place.inside }),
              kind: "primary",
            },
          ],
        });
        if (answer === undefined) return;
        if (answer === "inside") inside = place.inside;
      }
    } catch (error) {
      this.#failed(error);
      return;
    }
    let record: FolderRecord;
    try {
      record = await this.projects.create(name, folder, inside);
    } catch (error) {
      console.warn("A project could not be made in a folder", error);
      notifications.push(t("folder.createFailed"));
      return;
    }
    await this.#options.changeProject(() => this.#open(record));
  }

  /** What people chose or dropped, once the editor may read and write it, or may not. */
  async #openChosen(folder: LocalFolder, given: AccessAnswer): Promise<void> {
    const { dialogs, t } = this.#options;
    let answer = given;
    if (answer === "needs-activation") {
      // The browser only asks right after people did something: this button is that.
      const go = await dialogs.confirm({
        title: t("folder.openTitle", { name: folder.name }),
        message: t("folder.openMessage"),
        confirm: t("folder.openButton", { name: folder.name }),
      });
      if (!go) return;
      answer = await folder.requestAccess();
    }
    // People said no: nothing changes, and they can try again.
    if (answer !== "granted") return;
    let look: FolderLook;
    try {
      look = await this.projects.look(folder);
    } catch (error) {
      this.#failed(error);
      return;
    }
    if (look.kind === "empty") {
      const create = await dialogs.confirm({
        title: t("folder.emptyTitle", { folder: folder.name }),
        message: t("folder.emptyMessage"),
        confirm: t("folder.createHere"),
      });
      if (!create) return;
      const name = await dialogs.prompt({
        title: t("project.nameLabel"),
        value: t("project.defaultName"),
        confirm: t("project.create"),
      });
      if (name) await this.#createIn(folder, name);
      return;
    }
    if (look.kind === "refused") {
      const { reason, problems } = look.error;
      const details =
        problems.length > 0
          ? [
              {
                title: t("transfer.refusedList"),
                items: problems.map(({ file, path, message }) =>
                  t("transfer.problem", { place: path ? `${file} ${path}` : file, message }),
                ),
              },
            ]
          : undefined;
      await this.#notice(
        t("folder.refusedTitle", { folder: folder.name }),
        t(`folder.refused.${reason}`),
        details,
      );
      return;
    }
    // The project of this folder is open here already.
    if (look.record && look.record.id === this.#current?.record.id) return;
    let moved: FolderRecord | undefined;
    const [candidate] = look.moved;
    if (!look.record && candidate) {
      // A folder that moved is a new one to the browser: only its project says it may be that one.
      const answerMoved = await dialogs.choose({
        title: t("folder.movedTitle", { name: candidate.name }),
        message: t("folder.movedMessage"),
        choices: [
          { id: "new", label: t("folder.movedNo") },
          { id: "moved", label: t("folder.movedYes"), kind: "primary" },
        ],
      });
      if (answerMoved === undefined) return;
      if (answerMoved === "moved") moved = candidate;
    }
    let adopted: Awaited<ReturnType<FolderProjects["adopt"]>>;
    try {
      adopted = await this.#adopt(look, moved);
    } catch (error) {
      this.#failed(error);
      return;
    }
    const { record, report } = adopted;
    if (report) await this.#options.warnAboutCode(report);
    this.#setWaiting(undefined);
    await this.#options.changeProject(async () => {
      if ((await this.#open(record)) && report) this.#options.noteArrival(report);
    });
  }

  /** Reading a folder the browser does not know yet can take a while: people see it go. */
  async #adopt(
    look: Extract<FolderLook, { kind: "project" }>,
    moved: FolderRecord | undefined,
  ): ReturnType<FolderProjects["adopt"]> {
    const { dialogs, t } = this.#options;
    if (moved || look.record) return this.projects.adopt(look, moved);
    const progress = dialogs.progress({
      title: t("folder.reading", { folder: look.folder.name }),
      cancel: t("dialog.cancel"),
      stopping: t("transfer.stopping"),
    });
    try {
      return await this.projects.adopt(look, moved);
    } finally {
      progress.close();
    }
  }

  async #findAgainOrNot(record: FolderRecord): Promise<void> {
    const { dialogs, t } = this.#options;
    const find = await dialogs.confirm({
      title: t("folder.goneTitle", { name: record.name }),
      message: t("folder.goneMessage"),
      confirm: t("folder.findAgain"),
    });
    if (find) await this.findAgain(record);
  }

  /** Opens the project of a folder this browser has a log of, and keeps the folder in step. */
  async #open(record: FolderRecord): Promise<boolean> {
    const { session, folders, timing } = this.#options;
    // A folder this browser knows, whose log it lost, comes from the folder again.
    let report: ImportReport | undefined;
    try {
      report = await this.projects.prepare(record);
    } catch (error) {
      this.#failed(error);
      return false;
    }
    if (report) await this.#options.warnAboutCode(report);
    if (!(await session.open(record.id))) return false;
    const store = session.store as ProjectStore;
    const folderSession = new FolderSession({
      store,
      folder: record.folder,
      id: record.id,
      bases: folders.bases,
      writer: folders.writer(record.id),
      log: { saved: () => session.trySave(), caughtUp: () => session.readLog() },
      ...(timing && { timing }),
    });
    const stops = [
      folderSession.subscribe(() => this.#changed()),
      folderSession.onMerge((merge) => this.#merged(store, merge)),
    ];
    this.#current = {
      session: folderSession,
      store,
      record,
      stop: () => {
        for (const stop of stops) stop();
      },
    };
    this.#changed();
    await folderSession.start();
    await this.projects.opened(record, store.getState().manifest.name).catch((error: unknown) => {
      console.warn("When the folder was opened could not be noted down", error);
    });
    if (report) this.#options.noteArrival(report);
    return true;
  }

  #merged(store: ProjectStore, merge: FolderMerge): void {
    const { notifications, t } = this.#options;
    const { files, conflicts, problems } = merge;
    if (files.length === 0 && conflicts.length === 0) return;
    const message =
      conflicts.length > 0
        ? t("folder.mergedWithConflicts", { count: files.length, conflicts: conflicts.length })
        : t("folder.merged", { count: files.length });
    notifications.push(message, {
      actions: [
        ...(conflicts.length > 0 || problems.length > 0
          ? [{ label: t("folder.showMerged"), run: () => this.#options.showProblems() }]
          : []),
        { label: t("folder.undoMerge"), run: () => this.#undo(store, merge) },
      ],
    });
    if (conflicts.length === 0) return;
    const listed = conflicts.map((conflict) => ({
      severity: "warning" as const,
      text: t("folder.conflict"),
      file: conflict.file,
      place: conflict.path.join("."),
      origin: t("folder.origin"),
      action: {
        label: t("folder.showTheirs"),
        run: () =>
          void this.#notice(
            t("folder.theirsTitle", { file: conflict.file }),
            shown(conflict.theirs, t),
          ),
      },
    }));
    this.#conflicts = [...this.#conflicts, ...listed].slice(-MAX_CONFLICTS);
    this.#changed();
  }

  #undo(store: ProjectStore, merge: FolderMerge): void {
    const { notifications, t } = this.#options;
    if (this.#current?.store !== store) return;
    const result = store.undoOrigin(merge.origin);
    if (result.ok) {
      notifications.push(t("folder.undone"));
      return;
    }
    notifications.push(t("folder.undoFailed", { message: result.error.message }));
  }

  async #notice(
    title: string,
    message: string,
    details?: ConfirmOptions["details"],
  ): Promise<void> {
    await this.#options.dialogs.confirm({
      title,
      message,
      confirm: this.#options.t("dialog.close"),
      noticeOnly: true,
      ...(details && { details }),
    });
  }

  #setWaiting(waiting: WaitingFolder | undefined): void {
    this.#waiting = waiting;
    this.#changed();
  }

  #changed(): void {
    const current = this.#current;
    const snapshot = current?.session.getSnapshot();
    this.#options.problems.setFolder([...this.#blockedProblems(snapshot), ...this.#conflicts]);
    this.#snapshot = {
      open: current && snapshot ? { record: current.record, snapshot } : undefined,
      waiting: this.#waiting,
    };
    this.#emitter.emit();
  }

  #blockedProblems(snapshot: FolderSnapshot | undefined) {
    const { t } = this.#options;
    return (snapshot?.blocked ?? []).map(({ path, problems }) => ({
      severity: "error" as const,
      text:
        problems.length > 0
          ? problems.map(({ message }) => message).join(t("folder.listSeparator"))
          : t("folder.waits"),
      file: path,
      origin: t("folder.origin"),
      action: {
        label: t("folder.useEditorContent"),
        run: () => void this.writeEditorContent([path]),
      },
    }));
  }
}
