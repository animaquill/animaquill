import { ProjectStore, USER, elsewhereOf, type Here } from "@animaquill/core";
import {
  CloudSignedOut,
  RepositoryRefused,
  SYNC_CLOSE,
  newSyncId,
  type AccountAccess,
  type CloudAccess,
  type CloudLine,
  type CloudLink,
  type CloudCopyProblem,
  type CloudLinkRepository,
  type CloudProjectSummary,
  type CloudWake,
  type ProjectLog,
  type CloudRemoval,
  type CloudRemoveOptions,
  type RepositoryStatus,
  type RepositoryUnusable,
  type IncomingProject,
  type LogEntry,
  type MediaStore,
  type ProjectLibrary,
  type StoragePersistence,
  type WindowMemory,
  type LocalRepository,
} from "@animaquill/host";
import { isSameHash } from "@animaquill/media";
import type { TFunction } from "i18next";
import { placedT } from "../i18n/i18n.ts";
import type { Dialogs } from "../workbench/dialogs.ts";
import { Emitter } from "../workbench/emitter.ts";
import type { Notifications } from "../workbench/notifications.ts";
import type { ProjectSession } from "../workbench/session.ts";
import { loadProject, type CopySource, type LoadedProject } from "../folder/copies.ts";
import { DownloadFailed, download, type Downloaded } from "./download.ts";
import { RepositoryPicker } from "./repository-picker.ts";
import {
  BRANCH_MENDS,
  connectRepositoryName,
  copyProblemText,
  divergedOutcome,
  pathList,
  pauseText,
} from "./repository-text.ts";
import {
  RepositoryWatch,
  type ArchiveNowOutcome,
  type RepositoryEnvironment,
  type RepositoryTiming,
} from "./repository-watch.ts";
import {
  CloudSession,
  isOnPlatform,
  pageEnvironment,
  type CloudEnvironment,
  type CloudTiming,
} from "./session.ts";
import { unusableTitle } from "./unusable.ts";
import { chooseTakeBack, takeBackFailedText } from "./take-back-flow.ts";
import {
  KEEP_BACKUP_MS,
  TakeBack,
  dropKept,
  isPlan,
  planTakeBack,
  settleRenewal,
} from "./take-back.ts";

/**
 * Which project of this window is connected to the platform, and how people connect one, let go of
 * one, and open one from there, see docs/design/local-projects.md 7.2 and 7.5. The open project
 * syncs through a `CloudSession`; this decides whether it does.
 *
 * A project of the online mode is kept in this browser as a copy that syncs, by its id on the
 * backend, which no two of them share (docs/design/online-offline.md of AnimaQuill Cloud, 1.2): it
 * has no folder, and a folder is only ever a copy it was saved to, see `SaveToFolder`. This browser
 * has one copy of a project at most. Taking the copy out of the browser reads its log first, as
 * what did not get to the platform is nowhere else.
 */

export type CloudProjectsSnapshot =
  /**
   * The open project is not connected, and nothing says it should be. `local: "browser"`: it is
   * only in this browser, without a folder and without the platform, as projects were made
   * before every new one was a folder or a project of the platform, see the design of the start
   * page, 7: the browser can clear it at any time, and people are told so.
   */
  | { readonly kind: "none"; readonly local?: "browser" }
  | {
      readonly kind: "linked";
      readonly session: CloudSession;
      /** The link as it was when syncing began here: how far it got since is the session's to say. */
      readonly link: CloudLink;
      /**
       * Whether the project is on the platform, as far as this window knows. Not while its first
       * version may still be on its way there, see `CloudLink.creating`: connecting it is not
       * finished then, and nothing is known of a repository.
       */
      readonly made: boolean;
      /** How saving it to GitHub goes, where the platform does that. */
      readonly repository: RepositoryWatch | undefined;
    };

/** What a project of the platform is like, as whoever opens it from a list knows it. */
export interface CloudProjectAbout {
  readonly name?: string;
  /** See `CloudProjectSummary.copy`. */
  readonly copy?: string;
}

/** What a closed window can leave on a project, see `CloudProjectsOptions.leftBehind`. */
export type LeftBehind = "trial" | "drafts";

/** What this browser has of a project that the platform may not have, see `unsavedHere`. */
interface OnlyHere {
  /**
   * Changes in its log that did not go to the platform: "all" where the project may not be there
   * at all, and "unknown" where the log does not tell.
   */
  readonly changes: number | "all" | "unknown";
  /** Files of its assets that this browser has, and that can be downloaded from nowhere else. */
  readonly files: readonly string[];
  /** What closed windows left on it that is not saved. */
  readonly left: readonly LeftBehind[];
  /**
   * Whether the platform has the project: "there" where its list has it; "gone" where the list
   * does not; "unknown" where the list could not be read, as without a network or with nobody
   * signed in; "otherAccount" where the list is that of somebody else than the project is of.
   */
  readonly cloud: "there" | "gone" | "unknown" | "otherAccount";
}

/** Whether nothing of a project is only in this browser, as far as could be read. */
const isAllThere = (found: OnlyHere | undefined): found is OnlyHere =>
  found !== undefined &&
  found.changes === 0 &&
  found.files.length === 0 &&
  found.left.length === 0 &&
  found.cloud === "there";

export interface CloudProjectsOptions {
  readonly cloud: CloudAccess;
  readonly session: ProjectSession;
  readonly projects: ProjectLibrary;
  readonly account: AccountAccess | undefined;
  readonly dialogs: Dialogs;
  readonly notifications: Notifications;
  readonly t: TFunction;
  /** Which window this is, see `ChangeSource.window`. */
  readonly window: string;
  /** The version of the editor. */
  readonly editor: string;
  /**
   * Signs in: the page goes and comes back. A promise where the host knows when leaving is over,
   * which is how the dialog that connects a project finds out that people stayed after all.
   */
  readonly signIn: () => Promise<void> | void;
  readonly openProject: (id: string) => Promise<void>;
  /**
   * Opens the project of this window again from what this browser keeps of it, without asking
   * people anything: what they were trying out stays, as for a reload. For a project whose log went
   * on another working copy of the platform, see `TakeBack`. Without it, `openProject`.
   */
  readonly reopenProject?: (key: string) => Promise<void>;
  /** Leaves the page to install the GitHub App on the account, and comes back. As `signIn`. */
  readonly installApp?: () => Promise<void> | void;
  /**
   * How many other windows of this browser have a project open, by its key. Rejects where that
   * cannot be told: one may have it open then. Without it, no other window is taken to.
   */
  readonly others?: (key: string) => Promise<number>;
  /**
   * Leaves the open project for the start page, as people do, with everything kept first. Resolves
   * to whether it is closed. Without it the open project cannot be taken out of this browser.
   */
  readonly closeProject?: () => Promise<boolean>;
  /**
   * Takes away what this browser keeps of a project, by its key: its log and its files, and what
   * else goes with them. Without it, what the library keeps.
   */
  readonly removeLocal?: (key: string) => Promise<void>;
  /**
   * Whether people did something just now, so that the browser lets the editor ask them for a
   * folder: it only does for a moment after a click.
   */
  readonly isActive?: () => boolean;
  /**
   * What windows that are closed left on a project of this browser that is not part of it, by its
   * key: something they were trying out, code they typed and did not save, see `Host.trials` and
   * `Host.drafts`. It goes with the project. Without it, nothing is known to be left.
   */
  readonly leftBehind?: (key: string) => Promise<readonly LeftBehind[]>;
  /** What this window remembers through a reload: what connecting was at when the page left. */
  readonly memory?: WindowMemory;
  /**
   * Whether the browser keeps what the editor stores, and asks for that, see `StoragePersistence`:
   * asked once a project of the platform is only in this browser.
   */
  readonly persistence?: StoragePersistence;
  /** Whether the page is going away on purpose now, as after `signIn`, see `Workbench.leavePage`. */
  readonly leaving?: () => boolean;
  readonly timing?: Partial<CloudTiming>;
  readonly environment?: CloudEnvironment;
  readonly repositoryTiming?: Partial<RepositoryTiming>;
  readonly repositoryEnvironment?: RepositoryEnvironment;
}

const NONE: CloudProjectsSnapshot = { kind: "none" };
/** A project that is only in this browser, without the platform: see `CloudProjectsSnapshot`. */
const ONLY_HERE: CloudProjectsSnapshot = { kind: "none", local: "browser" };
/** Where the window remembers which projects only in this browser it told people about. */
const TOLD_KEY = "cloud.onlyHereTold";

/**
 * `git clone "<folder>" "<name>"`, for a repository of the server's own: in double quotes, as every
 * shell takes them, a path on Windows with its backslashes; the name of the project as a folder
 * name, without what no file system or shell takes (`fallback` where nothing is left).
 */
export const cloneCommandOf = (clone: string, name: string, fallback: string): string => {
  const quote = (text: string) => `"${text.replace(/(["$`])/g, "\\$1")}"`;
  const folder =
    [...name]
      .filter((char) => char >= " " && !'\\/:*?"<>|$`'.includes(char))
      .join("")
      .trim() || fallback;
  return `git clone ${quote(clone)} ${quote(folder)}`;
};

/** Restoring a repository refused, see `RepositoryAccess.restore`, in people's words. */
function restoreRefusalText(error: RepositoryRefused, t: TFunction): string {
  const plain = { interpolation: { escapeValue: false } } as const;
  switch (error.code) {
    case "unreadable":
      return t("cloud.restore.failure.unreadable", {
        files: pathList(error.files ?? []),
        ...plain,
      });
    case "linkedElsewhere":
      return error.project
        ? t("cloud.restore.failure.linkedProject", { name: error.project.name, ...plain })
        : t("cloud.restore.failure.linkedElsewhere");
    case "notPushable":
      return t("cloud.restore.failure.cannotWrite");
    case "noProject":
    case "tooLarge":
    case "tooNew":
    case "quota":
    case "public":
    case "notFound":
    case "notInstalled":
    case "unavailable":
    case "busy":
      return t(`cloud.restore.failure.${error.code}`);
    default:
      return t("cloud.restore.failure.other", { code: error.code, ...plain });
  }
}

/**
 * How taking the open project back onto the copy the platform made again goes, see
 * `CloudProjects.takeBack`: on its way ("running"); stopped until people try again, as they did
 * not choose or it failed ("stopped"); waiting for someone to sign in, as the right person
 * ("signedOut", "missing"); trying by itself now and then, as the platform did not answer for
 * a while ("unavailable"); or stopped as the platform's copy changed under it each time it tried
 * ("moved"), until people try again.
 */
export type TakeBackState =
  "running" | "stopped" | "signedOut" | "missing" | "unavailable" | "moved";

/** The paths of either side. */
const pathsOfBoth = (a: ReadonlyMap<string, string>, b: ReadonlyMap<string, string>) => [
  ...new Set([...a.keys(), ...b.keys()]),
];

/** How often the list is asked while a project comes back from its repository, and for how long. */
const RESTORE_POLL_MS = 3000;
const RESTORE_WAIT_MS = 5 * 60_000;
/** How long the platform has to say that a project is gone, whatever the host waits for. */
const REMOVE_WAIT_MS = 25_000;
/** How long the platform has to say which projects it has, before a copy goes out of the browser. */
const LIST_WAIT_MS = 8000;
/** A link without a project is taken away once it is this old, see `CloudProjects.tidy`. */
const STALE_LINK_MS = 10 * 60_000;
/** How long archiving may take before people choose whether to delete all the same. */
const ARCHIVE_WAIT_MS = 2 * 60_000;
/** How often the platform is asked how archiving goes meanwhile. */
const ARCHIVE_POLL_MS = 3000;
/** How long the changes of a copy in this browser have to get to the platform before it goes. */
const SYNC_WAIT_MS = 60_000;
/** How often the log is read meanwhile. */
const SYNC_POLL_MS = 1000;
/** How often the platform may find something new after the archive before people choose. */
const DELETE_ROUNDS = 3;

const sameRepository = (
  a: CloudLinkRepository | null | undefined,
  b: CloudLinkRepository | null | undefined,
): boolean =>
  a === b ||
  (a !== null && a !== undefined && b !== null && b !== undefined
    ? a.id === b.id && a.fullName === b.fullName
    : false);

export class CloudProjects {
  readonly #options: CloudProjectsOptions;
  readonly #emitter = new Emitter();
  #snapshot: CloudProjectsSnapshot = NONE;
  /** What this follows: the project open in the window, by its key and store. */
  #key: string | undefined;
  #store: ProjectStore | undefined;
  /** One look at a time, and only the last one counts. */
  #turn = 0;
  #following: Promise<void> = Promise.resolve();
  #stopSession: (() => void) | undefined;
  /**
   * What the link of the open project remembers for lists, as it was last kept, see
   * `CloudLink.name`: only what is new gets written.
   */
  #remembered: {
    name?: string | undefined;
    owner?: string | undefined;
    repository?: CloudLinkRepository | null | undefined;
  } = {};
  /** Waiting for the open project to be on the platform, by its id there, see `#whenOnline`. */
  #arriving: { readonly project: string; readonly arrived: Promise<boolean> } | undefined;

  constructor(options: CloudProjectsOptions) {
    this.#options = options;
    options.account?.subscribe(() => {
      const session = this.session;
      if (options.account?.getSnapshot().status !== "signedIn" || !session) return;
      if (session.getSnapshot().problem?.kind === "signed-out") session.resume();
      const repository = this.repository;
      if (repository?.getSnapshot().trouble === "signedOut") void repository.refresh();
      // Taking it back waited for somebody to sign in: it goes on.
      const waited = this.takeBack;
      if (waited === "signedOut" || waited === "missing") void this.takeBackAgain();
    });
  }

  subscribe = this.#emitter.subscribe;
  getSnapshot = (): CloudProjectsSnapshot => this.#snapshot;

  /** The platform. */
  get platform(): string {
    return this.#options.cloud.platform;
  }

  /** How saving the open project to GitHub goes, where it syncs and the platform does that. */
  get repository(): RepositoryWatch | undefined {
    return this.#snapshot.kind === "linked" ? this.#snapshot.repository : undefined;
  }

  /** The sync of the open project, where it has one. */
  get session(): CloudSession | undefined {
    return this.#snapshot.kind === "linked" ? this.#snapshot.session : undefined;
  }

  /**
   * Whether the open project is on the platform, as far as this window knows: connected, and not
   * one whose first version is still on its way there, see `CloudLink.creating`.
   */
  get isOnPlatform(): boolean {
    const snapshot = this.#snapshot;
    return snapshot.kind === "linked" && snapshot.made;
  }

  /** Whether the open project still syncs as it did when `snapshot` was taken. */
  #isStill(snapshot: CloudProjectsSnapshot): boolean {
    const now = this.#snapshot;
    if (snapshot.kind !== "linked") return now === snapshot;
    return now.kind === "linked" && now.session === snapshot.session;
  }

  #set(snapshot: CloudProjectsSnapshot): void {
    this.#snapshot = snapshot;
    this.#emitter.emit();
  }

  /**
   * Looks again at the open project, after it changed. Resolves once every look
   * asked for by then is over: a look asked for later takes the place of one that did not begin,
   * and whoever asked for that one hears what the later one found.
   */
  follow(): Promise<void> {
    const { session } = this.#options;
    const key = session.key;
    const store = session.store;
    if (key !== this.#key || store !== this.#store) {
      const turn = ++this.#turn;
      this.#following = this.#following
        .then(() => this.#look(turn))
        .catch((error: unknown) => {
          console.warn("Whether the project syncs could not be found out", error);
        });
    }
    return this.#followed();
  }

  /** Resolves once no look is on its way, see `follow`. */
  async #followed(): Promise<void> {
    let seen: Promise<void>;
    do {
      seen = this.#following;
      await seen;
    } while (seen !== this.#following);
  }

  /** Where the windows of this browser say that a link of the open project changed. */
  #line: { readonly line: CloudLine; readonly stop: () => void } | undefined;

  /** Listens for links of this project that another window makes or takes away. */
  #listen(key: string | undefined): void {
    this.#line?.stop();
    this.#line?.line.close();
    this.#line = undefined;
    if (key === undefined) return;
    const line = this.#options.cloud.line(key);
    if (!line) return;
    const stop = line.listen((data) => {
      const kind = (data as { kind?: unknown } | null)?.kind;
      if (this.#options.session.key !== key) return;
      // Another window found that the repository can be used again: so can the project here.
      if (kind === "usable") {
        this.#usableAgain();
        return;
      }
      // Another window took the project back onto the copy the platform made again: what this
      // window has is of the copy before, and the log is not.
      if (kind === "renewed") {
        // Not where this window is on the new copy already.
        const sync = this.session;
        if (sync && sync.generation !== (data as { generation?: unknown }).generation)
          void this.#reopen(key);
        return;
      }
      if (kind !== "link") return;
      // Looks again as if the project had just opened.
      void this.#stop().then(() => {
        this.#key = undefined;
        this.#store = undefined;
        return this.follow();
      });
    });
    this.#line = { line, stop };
  }

  /**
   * The repository of the open project can be used again, as this window or another one found:
   * what the platform says of it is asked again, and syncing goes on, here and, as the window that
   * syncs hears it too, in every window of the project.
   */
  #usableAgain(): void {
    const snapshot = this.#snapshot;
    if (snapshot.kind !== "linked") return;
    void snapshot.repository?.refresh();
    if (snapshot.session.getSnapshot().problem?.kind === "unusable") {
      this.#heardUnusable.delete(snapshot.session);
      snapshot.session.resume();
    }
  }

  /** Tells the windows that have a project of the platform open that its repository can be used. */
  async #tellUsable(project: string): Promise<void> {
    const { cloud } = this.#options;
    const links = await cloud.links.withProject(cloud.platform, project).catch(() => []);
    for (const { key } of links) {
      const line = cloud.line(key);
      line?.post({ kind: "usable" });
      line?.close();
    }
  }

  /** Tells the other windows that the link of this project changed. */
  #tell(): void {
    this.#line?.line.post({ kind: "link" });
  }

  /** Tells the windows that have another project of this browser open that its link changed. */
  #tellAbout(key: string): void {
    const line = this.#options.cloud.line(key);
    line?.post({ kind: "link" });
    line?.close();
  }

  async #look(turn: number): Promise<void> {
    if (turn !== this.#turn) return;
    const { session, cloud } = this.#options;
    const key = session.key;
    const store = session.store;
    if (key !== this.#key || store !== this.#store) {
      await this.#stop();
      this.#key = key;
      this.#store = store;
      this.#listen(key);
    }
    if (!key || !store) return;
    if (this.#snapshot.kind === "linked") return;
    let link: CloudLink | undefined;
    try {
      link = await cloud.links.get(key);
    } catch (error) {
      // Not known, which is not "not connected": the next look reads again.
      console.warn("The link of the project to the platform could not be read", error);
      if (turn === this.#turn) {
        this.#key = undefined;
        this.#store = undefined;
      }
      return;
    }
    if (turn !== this.#turn) return;
    if (link && link.platform === cloud.platform) {
      this.#start(link, store);
      if (link.creating) void this.#whenOnline(link);
      return;
    }
    // Only in this browser, with nothing else that has it, as one that the platform took away
    // with changes that did not get there: people hear that once.
    this.#set(ONLY_HERE);
    this.#tellOnlyHere(key, store.getState().manifest.name);
  }

  /** Whether people were told about a project that is only in this browser, by its key. */
  #told(): string[] {
    try {
      const kept: unknown = JSON.parse(this.#options.memory?.read(TOLD_KEY) || "[]");
      return Array.isArray(kept)
        ? kept.filter((key): key is string => typeof key === "string")
        : [];
    } catch {
      return [];
    }
  }

  /**
   * Notes that people know a project is only in this browser, as one that a test made there on
   * purpose: nothing more is said about it as it opens.
   */
  noteToldOnlyHere(key: string): void {
    const told = this.#told();
    if (told.includes(key)) return;
    this.#options.memory?.write(TOLD_KEY, JSON.stringify([...told.slice(-50), key]));
  }

  #tellOnlyHere(key: string, name: string): void {
    const { notifications, t } = this.#options;
    if (this.#told().includes(key)) return;
    this.noteToldOnlyHere(key);
    // The status bar and the panel say it for as long as it is so: this one is for the first time.
    notifications.push(t("cloud.onlyHere.notice", { name, interpolation: { escapeValue: false } }));
  }

  /**
   * Whether the browser keeps what the editor stores until people clear it, as far as it said:
   * undefined where it was not asked, or cannot say. Asked once a project of the platform is only in
   * this browser, see `#keepStored`.
   */
  get persisted(): boolean | undefined {
    return this.#persisted;
  }

  #persisted: boolean | undefined;
  #askedToKeep = false;

  /**
   * Asks the browser to keep what it stores until people clear it, the first time a project of the
   * platform is only in this browser here, see R-ST-9: otherwise it may clear it when its disk is
   * nearly full, with changes that did not get to the platform yet. Where it says no, people hear
   * it once, and the panel says it.
   */
  async #keepStored(): Promise<void> {
    const { persistence, notifications, t } = this.#options;
    if (!persistence || this.#askedToKeep) return;
    this.#askedToKeep = true;
    // Once for this browser, whichever page asked: people heard what it said then.
    const wasAsked = persistence.wasAsked();
    const isKept = (await persistence.persisted()) || (await persistence.persist());
    this.#persisted = isKept;
    this.#emitter.emit();
    if (!isKept && !wasAsked) notifications.push(t("cloud.persist.refused"));
  }

  /**
   * The copies this browser has of a project of the platform, by their links: one at most, as
   * opening and downloading go by this; a link to a project that this browser does not keep any
   * more is none.
   */
  async #copiesOf(project: string): Promise<readonly CloudLink[]> {
    const { cloud, projects } = this.#options;
    const links = await cloud.links.withProject(cloud.platform, project);
    if (links.length === 0) return [];
    const kept = await projects.list();
    return links.filter((link) => kept.some((summary) => summary.id === link.key));
  }

  #start(link: CloudLink, store: ProjectStore): void {
    const { cloud, session, window, editor, timing, environment } = this.#options;
    const { name, id } = store.getState().manifest;
    // A project whose first version may not have got there yet makes it, or finds it there.
    const create = link.creating ? { name, projectId: id } : undefined;
    const sync = new CloudSession({
      store,
      journal: session.journal,
      cloud,
      link,
      window,
      editor,
      onSeq: (seq) => {
        if (session.store === store) session.cloudSeq = seq;
      },
      ...(create && { create }),
      ...(timing && { timing }),
      ...(environment && { environment }),
    });
    session.cloudSeq = link.seq;
    const access = cloud.repository;
    const repository =
      access &&
      new RepositoryWatch({
        access,
        project: link.project,
        ...(this.#options.repositoryTiming && { timing: this.#options.repositoryTiming }),
        ...(this.#options.repositoryEnvironment && {
          environment: this.#options.repositoryEnvironment,
        }),
      });
    this.#remembered = { name: link.name, owner: link.owner, repository: link.repository };
    this.#arriving = undefined;
    const stopSync = sync.subscribe(() => {
      this.#emitter.emit();
      const { state, problem } = sync.getSnapshot();
      // Another window disconnected it: this one looks again, and finds no link.
      if (problem?.kind === "unlinked") void this.#unlinked(sync);
      // The platform would not make the project: connecting it was given up on.
      if (problem?.kind === "missing" && problem.unmade) void this.#unmade(sync, link);
      // Taken away on the platform, here or elsewhere: what this computer has of it stays.
      if (problem?.kind === "deleted") void this.#deletedElsewhere(sync, link);
      // Its repository cannot be used: what the platform says of that, how long it keeps it.
      if (problem?.kind === "unusable" && !this.#heardUnusable.has(sync)) {
        this.#heardUnusable.set(sync, repository?.getSnapshot().checkedAt);
        void repository?.refresh();
      }
      // The platform made the project again from its repository: what this computer has goes onto
      // the new copy. Only the window that syncs: it holds the turn meanwhile.
      if (problem?.kind === "rebuilt" && sync.getSnapshot().here && !this.#takingBack.has(sync)) {
        void this.#takeBack(sync, link);
      }
      // The platform could not make the project again from its repository lately, and tries again
      // later: why, as what it says of the repository has it, see `copyProblem`.
      const { restoring } = sync.getSnapshot();
      if (restoring === "released" && !this.#heardReleased.has(sync)) {
        this.#heardReleased.add(sync);
        void repository?.refresh();
      } else if (restoring !== "released") this.#heardReleased.delete(sync);
      // What the log had of the copy before goes once the platform has what came of it.
      if (state === "online" && sync.getSnapshot().pending === 0 && link.kept)
        void this.#dropKept(sync, link);
      // What archiving says is of before a change that the platform has by now, see `noteSeq`.
      repository?.noteSeq(sync.getSnapshot().seq);
      // The platform only lets the owner of a project sync it: whoever is signed in is the one.
      if (state === "online") this.#rememberOwner(link);
    });
    const stopRepository = repository?.subscribe(() => {
      this.#emitter.emit();
      const status = repository.status;
      if (!status) return;
      // The repository can be used again, as the platform said since syncing heard otherwise:
      // syncing goes on. What it said before that is of before.
      if (
        status.unusable === undefined &&
        sync.getSnapshot().problem?.kind === "unusable" &&
        this.#heardUnusable.has(sync) &&
        repository.getSnapshot().checkedAt !== this.#heardUnusable.get(sync)
      ) {
        this.#heardUnusable.delete(sync);
        sync.resume();
      }
      const { repository: saved } = status;
      // What a list says about it while the platform cannot be asked.
      if (saved) this.#remember(link, { repository: { id: saved.id, fullName: saved.fullName } });
      else if (status.state === "none") this.#remember(link, { repository: null });
    });
    this.#stopSession = () => {
      stopSync();
      stopRepository?.();
      repository?.close();
      this.#remember(link, { name: store.getState().manifest.name });
    };
    this.#set({
      kind: "linked",
      session: sync,
      link,
      made: !link.creating,
      repository,
    });
    this.#remember(link, { name });
    void this.#keepStored();
    sync.start();
    // A project the platform may not have yet has nothing to say about GitHub until it does.
    if (!link.creating) repository?.start();
  }

  /**
   * Keeps what a list shows of a project while the platform cannot be asked, see `CloudLink.name`,
   * where it is not what the link has already. Nothing waits for it, and nothing fails with it.
   */
  #remember(
    link: CloudLink,
    change: {
      readonly name?: string;
      readonly owner?: string;
      readonly repository?: CloudLinkRepository | null;
    },
  ): void {
    const before = this.#remembered;
    const next: { -readonly [K in keyof typeof change]: (typeof change)[K] } = {};
    if (change.name !== undefined && change.name !== before.name) next.name = change.name;
    if (change.owner !== undefined && change.owner !== before.owner) next.owner = change.owner;
    if (change.repository !== undefined && !sameRepository(change.repository, before.repository))
      next.repository = change.repository;
    if (Object.keys(next).length === 0) return;
    this.#remembered = { ...before, ...next };
    void this.#options.cloud.links.update(link.key, link.project, next).catch((error: unknown) => {
      console.warn("What a list shows of the project could not be kept", error);
    });
  }

  /** Sessions that heard that the platform could not make the project again, see `copyProblem`. */
  readonly #heardReleased = new WeakSet<CloudSession>();

  /**
   * Why the platform could not make the open project again from its repository, where it could
   * not lately and the window waits for it to try again (`CloudSnapshot.restoring` "released"):
   * what helps is in the panel, see `wakeFromBranch`.
   */
  get copyProblem(): CloudCopyProblem | undefined {
    const snapshot = this.#snapshot;
    if (snapshot.kind !== "linked") return undefined;
    if (snapshot.session.getSnapshot().restoring !== "released") return undefined;
    return snapshot.repository?.status?.copyProblem;
  }

  /**
   * "我已在 GitHub 上修好": has the platform make the open project again from its branch as it is
   * now, where what the repository had kept it from coming, see `CloudAccess.wake`; syncing comes
   * back for it at once. Such a copy has nothing in common with the one this computer has, and
   * taking it back asks people about every file that is not the same, see `TakeBack`.
   */
  async wakeFromBranch(): Promise<void> {
    const snapshot = this.#snapshot;
    if (snapshot.kind !== "linked") return;
    const { link, session } = snapshot;
    const woke = await this.#wake(link.project, true);
    if (woke === undefined) return;
    if (woke.copy === "released") {
      const name = this.#options.session.store?.getState().manifest.name ?? link.name ?? "";
      await this.#notWoken(name, woke, { once: true });
      void snapshot.repository?.refresh();
      return;
    }
    session.resume();
  }

  /** Sessions whose copy is being taken back, or was, see `#takeBack`. */
  readonly #takingBack = new WeakSet<CloudSession>();
  /** How taking the open project back goes, see `TakeBackState`. */
  #takeBackState: TakeBackState | undefined;
  /** Which run of `#takeBack` is the one that counts: one that people start again is another. */
  #takeBackRun = 0;
  /** Sessions whose log of the copy before went, or is going. */
  readonly #dropping = new WeakSet<CloudSession>();

  /**
   * Whether the platform made the open project again from its repository, and what this window
   * has is of the copy before: it can be looked at, and not changed, until it is taken back.
   */
  get rebuilt(): boolean {
    const snapshot = this.#snapshot;
    return snapshot.kind === "linked" && snapshot.session.getSnapshot().problem?.kind === "rebuilt";
  }

  /** How taking the open project back goes, see `#takeBack`. */
  get takeBack(): TakeBackState | undefined {
    return this.rebuilt ? this.#takeBackState : undefined;
  }

  #setTakeBack(state: TakeBackState | undefined): void {
    if (this.#takeBackState === state) return;
    this.#takeBackState = state;
    this.#emitter.emit();
  }

  /** Tries again to take the open project back, as people ask after it stopped. */
  async takeBackAgain(): Promise<void> {
    const snapshot = this.#snapshot;
    if (snapshot.kind !== "linked" || !snapshot.session.getSnapshot().here) return;
    this.#takingBack.delete(snapshot.session);
    await this.#takeBack(snapshot.session, snapshot.link);
  }

  /**
   * Takes what this computer has of the open project back onto the copy that the platform made
   * again from its repository, see `TakeBack`, and opens the project again from what comes of it,
   * here and in the other windows of this browser that have it. Where the platform cannot be asked
   * now, again a little later; where people do not choose, or it fails, the project stays as it
   * is, and people can try again. Only the window that syncs does this, with its turn.
   */
  async #takeBack(sync: CloudSession, link: CloudLink): Promise<void> {
    const { cloud, projects, session, notifications, t } = this.#options;
    const repository = cloud.repository;
    this.#takingBack.add(sync);
    const run = ++this.#takeBackRun;
    const isStill = () =>
      this.session === sync &&
      run === this.#takeBackRun &&
      !sync.getSnapshot().state.startsWith("clos");
    const name = session.store?.getState().manifest.name ?? link.name ?? "";
    this.#setTakeBack("running");
    /** How many times in a row the platform could not be asked. */
    let unanswered = 0;
    try {
      for (let wait = 5000; isStill(); wait = Math.min(wait * 2, 5 * 60_000)) {
        const now = await cloud.links.get(link.key).catch(() => undefined);
        if (!now || now.project !== link.project) return;
        // A page that went away halfway: finished, or put back, by whoever syncs first.
        if (now.renewing) {
          if (await settleRenewal(cloud, projects, now)) await this.#reopen(link.key);
          else sync.resume();
          return;
        }
        // Another window of this browser took it back already.
        if ((now.generation ?? 1) !== sync.generation) {
          await this.#reopen(link.key);
          return;
        }
        const store = session.store;
        if (!repository || !store || session.key !== link.key) {
          this.#setTakeBack("stopped");
          return;
        }
        // The log went on another copy under this window: what it has is of the one before.
        if (!(await session.journal.current(store).catch(() => true))) {
          await this.#reopen(link.key);
          return;
        }
        const outcome = await new TakeBack({
          cloud,
          projects,
          status: (project) => repository.status(project),
          window: this.#options.window,
          editor: this.#options.editor,
        }).run({
          key: link.key,
          project: link.project,
          store,
          generation: sync.generation,
          saved: async () => {
            await session.journal.readLog().catch(() => {});
            return session.journal.saved();
          },
          entries: async () => (await session.journal.entries()) ?? [],
          choose: chooseTakeBack({ dialogs: this.#options.dialogs, t, name }),
        });
        switch (outcome.kind) {
          case "renewed": {
            if (outcome.changed) {
              notifications.push(
                t("cloud.takeBack.done", {
                  name,
                  count: outcome.merged.length + outcome.chosen,
                  interpolation: { escapeValue: false },
                }),
              );
            }
            const line = cloud.line(link.key);
            line?.post({
              kind: "renewed",
              generation: (await cloud.links.get(link.key))?.generation,
            });
            line?.close();
            await this.#reopen(link.key);
            return;
          }
          case "already":
            await this.#reopen(link.key);
            return;
          case "same":
            sync.resume();
            return;
          case "later":
            // Nobody signed in, or another account: what helps is people, who hear so.
            if (outcome.why === "signedOut" || outcome.why === "missing") {
              this.#setTakeBack(outcome.why);
              return;
            }
            // Not for a while: people hear so, and can try now; it goes on trying by itself.
            if (++unanswered >= 3) this.#setTakeBack("unavailable");
            await this.#wait(wait);
            continue;
          case "cancelled":
            this.#setTakeBack("stopped");
            return;
          case "failed":
            // The bar says that one, with the way to try again.
            if (outcome.why === "moved") {
              this.#setTakeBack("moved");
              return;
            }
            notifications.push(
              `${t("cloud.takeBack.failedTitle", { name, interpolation: { escapeValue: false } })}：${takeBackFailedText(outcome, t)}`,
            );
            this.#setTakeBack("stopped");
            return;
        }
      }
    } catch (error) {
      console.warn("The project could not be taken back onto the new copy", error);
      this.#setTakeBack("stopped");
    }
  }

  /**
   * Opens the project of this window again, as its log is now: where the log went on another copy
   * of the platform, what this window has is of the one before.
   */
  async #reopen(key: string): Promise<void> {
    const { session } = this.#options;
    if (session.key !== key) return;
    // Once: this window hears what it says to the others too.
    if (this.#reopening?.key === key) return this.#reopening.done;
    this.#takeBackState = undefined;
    const done = (this.#options.reopenProject ?? this.#options.openProject)(key).finally(() => {
      if (this.#reopening?.done === done) this.#reopening = undefined;
    });
    this.#reopening = { key, done };
    return done;
  }

  /**
   * Puts what this window changed and could not put into the log (`updates`, as `ProjectSession`
   * kept them) into the log of the project, which went on another copy of the platform under this
   * window, see `TakeBack`: as taking it back does, with what the log had then (`CloudLink.kept`)
   * for what both had, so that only those changes come in, and what the new copy changed in the
   * same place too people choose for. Straight into the log, while this window still has the
   * project open as it was: once it opens again, they are part of it, whatever people open
   * meanwhile. "carried": they are there, or there was nothing to put; "declined": people chose not
   * to have them; "failed": nothing changed, and they are only in this window still, which then
   * asks people before it lets go of them, as for anything else it could not save.
   */
  async carryOver(
    key: string,
    updates: readonly Uint8Array[],
  ): Promise<"carried" | "declined" | "failed"> {
    const { cloud, projects, dialogs, notifications, t, window } = this.#options;
    const name = this.#options.session.store?.getState().manifest.name ?? "";
    const plain = { name, interpolation: { escapeValue: false } } as const;
    const link = await cloud.links.get(key).catch(() => undefined);
    const backup = link?.kept?.backup;
    if (!backup || !projects.backupUpdates) return "failed";
    const stores: ProjectStore[] = [];
    const storeOf = (all: readonly Uint8Array[]) => {
      const store = ProjectStore.fromUpdates(all).store;
      if (!store) throw new Error("What the log has is no project");
      stores.push(store);
      return store;
    };
    let log: ProjectLog | undefined;
    try {
      const kept = await projects.backupUpdates(key, backup);
      log = await projects.open(key);
      const now = storeOf(await log.load());
      const base = storeOf(kept).exportFiles().files;
      const here = storeOf([...kept, ...updates]).exportFiles().files;
      const plan = planTakeBack(here, now, base);
      if (!isPlan(plan)) throw new Error("The changes do not go onto the project");
      stores.push(plan.store);
      let final = plan.after;
      if (plan.differences.length > 0) {
        const chosen = await chooseTakeBack({ dialogs, t, name })(plan);
        if (!chosen) {
          notifications.push(t("cloud.takeBack.carryDeclined", plain));
          return "declined";
        }
        final = chosen.settled.after;
      }
      const changes = pathsOfBoth(plan.cloud, final)
        .filter((path) => plan.cloud.get(path) !== final.get(path))
        .map((path) => ({ path, base: plan.cloud.get(path), text: final.get(path) }));
      if (changes.length === 0) return "carried";
      const before = now.stateVector();
      const merged = now.mergeFiles(changes, {
        origin: USER,
        baseOf: (path) => plan.cloud.get(path),
      });
      if (!merged.ok || merged.files.some(({ status }) => status !== "merged"))
        throw new Error("The changes did not go onto the project");
      // As a change of this window: what other windows wrote meanwhile stays, as Yjs puts both.
      await log.append(now.diffSince(before), now.getState().manifest.name, {
        kind: "user",
        window,
        at: Date.now(),
      });
      notifications.push(t("cloud.takeBack.carried", { ...plain, count: changes.length }));
      return "carried";
    } catch (error) {
      console.warn("Changes of this window could not go onto the new copy", error);
      notifications.push(t("cloud.takeBack.carryFailed", plain));
      return "failed";
    } finally {
      log?.close();
      for (const store of stores) store.destroy();
    }
  }

  /** The project this window opens again, while it does, see `#reopen`. */
  #reopening: { readonly key: string; readonly done: Promise<void> } | undefined;

  /** Takes away what the log had of the copy before, once the platform has what came of it. */
  async #dropKept(sync: CloudSession, link: CloudLink): Promise<void> {
    if (this.#dropping.has(sync)) return;
    // Kept for a while in any case: nothing to look at before then.
    if (Date.now() - (link.kept?.at ?? 0) < KEEP_BACKUP_MS) return;
    this.#dropping.add(sync);
    // Once `pushed` is noted down, a moment after the platform took it.
    await this.#wait(2000);
    for (let tries = 0; tries < 5 && this.session === sync; tries++) {
      try {
        if (await dropKept(this.#options.cloud, this.#options.projects, link.key)) return;
      } catch (error) {
        console.warn("What the log had of the copy before stays for now", error);
      }
      await this.#wait(10_000);
    }
    // Next time the project opens, or syncs again here.
    this.#dropping.delete(sync);
  }

  #rememberOwner(link: CloudLink): void {
    const who = this.#options.account?.getSnapshot();
    if (who?.status === "signedIn" && who.id !== undefined) this.#remember(link, { owner: who.id });
  }

  async #unlinked(sync: CloudSession): Promise<void> {
    if (this.session !== sync) return;
    await this.#stop();
    this.#key = undefined;
    this.#store = undefined;
    await this.follow();
  }

  /** The sessions whose project the platform would not make, once each, see `#unmade`. */
  readonly #refused = new WeakSet<CloudSession>();
  /** The sessions whose project was taken away on the platform, once each, see `#deletedElsewhere`. */
  readonly #deleted = new WeakSet<CloudSession>();
  /**
   * The sessions that heard that the repository cannot be used, with when the platform last said
   * how the repository is then: only what it says after that can say that it is usable again.
   */
  readonly #heardUnusable = new WeakMap<CloudSession, number | undefined>();

  /**
   * The platform would not make the project of a link that was still on its way there, see
   * `CloudProblem`: it was asked to take the project away, and makes none under that id again.
   * So connecting was given up on, here where the answer to that did not come back, or in another
   * window, and this finishes it: the link goes, and the project is one of this computer only
   * again, with everything in it, to be connected anew whenever people like. They hear that, and
   * are not left to choose what to do about a project the platform does not have.
   *
   * Not where the project may be somebody else's, which the platform says the same of: the link
   * stays then, and syncing says that the project is not there for whoever is signed in. And not
   * for a link that says the project was on the platform: one that was there and is gone is
   * something for people to look at.
   */
  async #unmade(sync: CloudSession, link: CloudLink): Promise<void> {
    if (this.session !== sync || this.#refused.has(sync)) return;
    this.#refused.add(sync);
    const { cloud, notifications, t } = this.#options;
    let kept: CloudLink | undefined;
    try {
      kept = await cloud.links.get(link.key);
    } catch (error) {
      console.warn("The link of a project that was not made could not be read", error);
      return;
    }
    if (this.session !== sync) return;
    // As it is kept now: another window may have taken it away, or found the project there.
    if (!kept || kept.project !== link.project || !kept.creating || !this.isOwn(kept)) return;
    if (!(await this.#unlink(link.key))) return;
    notifications.push(t("cloud.connectUndone"));
  }

  /**
   * The project of a link was taken away on the platform, on another computer or in another
   * window, see `CloudProblem`: there is nothing there to sync with any more. The link goes, and
   * what this computer has of it stays as it is, with every change that did not get there: a
   * folder is a project of this computer from now on; a copy in this browser is one of this
   * browser only, as projects were before, with its ways out, see the design of the start page, 5
   * and 7. Nothing of it is taken away. People hear it once.
   */
  async #deletedElsewhere(sync: CloudSession, link: CloudLink): Promise<void> {
    if (this.session !== sync || this.#deleted.has(sync)) return;
    this.#deleted.add(sync);
    const { cloud, notifications, session, t } = this.#options;
    let kept: CloudLink | undefined;
    try {
      kept = await cloud.links.get(link.key);
    } catch (error) {
      // It stays as it is, saying that it was deleted: the next look reads the link again.
      console.warn("The link of a project that was deleted could not be read", error);
      return;
    }
    if (this.session !== sync) return;
    // Another window let go of it already, or it is linked to another project by now.
    if (!kept || kept.project !== link.project) return;
    const name = session.store?.getState().manifest.name ?? kept.name ?? "";
    if (!(await this.#unlink(link.key))) return;
    notifications.push(
      t("cloud.deletedElsewhere.browser", {
        name,
        interpolation: { escapeValue: false },
      }),
      { stays: true },
    );
  }

  /**
   * Why the open project cannot be edited now, where it cannot: its repository cannot be used,
   * as the platform says of it, or as syncing heard when the platform closed it, see the design
   * of the start page, 5.1. What the platform said of the repository last tells more, as when the
   * project goes; syncing tells first.
   */
  get unusable(): RepositoryUnusable | undefined {
    const snapshot = this.#snapshot;
    if (snapshot.kind !== "linked") return undefined;
    const status = snapshot.repository?.status;
    const said = status?.unusable;
    if (said)
      return { ...said, ...(said.gone === undefined && status?.gone && { gone: status.gone }) };
    const problem = snapshot.session.getSnapshot().problem;
    return problem?.kind === "unusable" ? { reason: problem.reason, since: 0 } : undefined;
  }

  /**
   * "Check again": has the platform ask GitHub now whether the repository of a project can be
   * used, the open one where none is said. Where it can, the project can be edited again, and
   * syncing goes on. People hear what came of it. Resolves to the status then, or undefined.
   */
  async recheck(project?: string): Promise<RepositoryStatus | undefined> {
    const { cloud, notifications, t } = this.#options;
    const access = cloud.repository;
    const snapshot = this.#snapshot;
    const open = snapshot.kind === "linked" ? snapshot : undefined;
    const id = project ?? open?.link.project;
    if (!access || id === undefined) return undefined;
    let status: RepositoryStatus;
    try {
      status = await access.recheck(id);
    } catch (error) {
      const code =
        error instanceof CloudSignedOut
          ? "signedOut"
          : error instanceof RepositoryRefused && error.code !== "invalid"
            ? error.code
            : "unavailable";
      notifications.push(
        t(
          code === "busy" || code === "signedOut" || code === "notLinked"
            ? `cloud.recheck.${code}`
            : "cloud.recheck.unavailable",
        ),
      );
      return undefined;
    }
    const watch = open?.link.project === id ? open.repository : undefined;
    watch?.take(status);
    if (status.unusable) {
      notifications.push(
        t("cloud.recheck.still", {
          what: unusableTitle(status.unusable, t),
          interpolation: { escapeValue: false },
        }),
      );
    } else {
      // Syncing goes on, and with it editing, here and in every other window of the project:
      // the one that syncs may be another one, in the back.
      if (open?.link.project === id) {
        this.#heardUnusable.delete(open.session);
        open.session.resume();
      }
      void this.#tellUsable(id);
      notifications.push(t("cloud.recheck.usable"));
    }
    return status;
  }

  async #stop(): Promise<void> {
    const session = this.session;
    this.#stopSession?.();
    this.#stopSession = undefined;
    this.#set(NONE);
    await session?.close();
  }

  /** Stops syncing, before the window goes on to another project or away. */
  async close(): Promise<void> {
    this.#turn += 1;
    await this.#stop();
    this.#key = undefined;
    this.#store = undefined;
    this.#listen(undefined);
  }

  /**
   * Whether the open project can be taken away on the platform, see `deleteFromCloud`: it is
   * there, and of whoever is signed in, as far as its link says.
   */
  get canDelete(): boolean {
    const snapshot = this.#snapshot;
    return (
      snapshot.kind === "linked" &&
      snapshot.made &&
      this.#options.cloud.remove !== undefined &&
      this.isOwn(snapshot.link)
    );
  }

  /** Makes sure someone is signed in, or asks people to. Resolves to whether someone is. */
  async #signedIn(title: string): Promise<boolean> {
    const { account, dialogs, t } = this.#options;
    if (!account) return false;
    await account.refresh();
    if (account.getSnapshot().status === "signedIn") return true;
    const answer = await dialogs.choose({
      title,
      message: t("cloud.signInFirst"),
      choices: [{ id: "signIn", label: t("account.signIn"), kind: "primary" }],
    });
    if (answer === "signIn") await this.#options.signIn();
    return false;
  }

  /**
   * Waits for the project of a link to be on the platform, however long that takes, and keeps that
   * it is from then on. Resolves to whether it got there while this window synced it. Whoever
   * waits for the same project waits for the same.
   */
  #whenOnline(link: CloudLink): Promise<boolean> {
    const session = this.session;
    if (!session || session.project !== link.project) return Promise.resolve(false);
    if (this.#arriving?.project === link.project) return this.#arriving.arrived;
    const arrived = (async () => {
      const isOnline = await new Promise<boolean>((resolve) => {
        let stop = () => {};
        const check = () => {
          const { state } = session.getSnapshot();
          if (state !== "online" && state !== "closed") return;
          stop();
          resolve(state === "online");
        };
        stop = session.subscribe(check);
        check();
      });
      if (isOnline) await this.noteMade(link);
      return isOnline;
    })();
    this.#arriving = { project: link.project, arrived };
    return arrived;
  }

  /** The project of a link is on the platform now: the link says so, and GitHub can be asked about it. */
  async noteMade(link: CloudLink): Promise<void> {
    const open = () => {
      const snapshot = this.#snapshot;
      return snapshot.kind === "linked" && snapshot.link.project === link.project
        ? snapshot
        : undefined;
    };
    const snapshot = open();
    if (snapshot && !snapshot.made) this.#set({ ...snapshot, made: true });
    // Only that: how far it got is the session's to note down, at the same time.
    await this.#options.cloud.links
      .update(link.key, link.project, { made: true })
      .catch(() => false);
    open()?.repository?.start();
  }

  /**
   * Asks the platform to take a project away: one without a repository, or as `condition` says,
   * see `CloudAccess.remove`. "unknown": it could not say, also where it did not answer for a while.
   */
  async #takeAway(
    project: string,
    condition?: CloudRemoveOptions,
  ): Promise<CloudRemoval | "unknown"> {
    const { cloud } = this.#options;
    if (!cloud.remove) return "unknown";
    try {
      return await this.#within(
        REMOVE_WAIT_MS,
        condition === undefined ? cloud.remove(project) : cloud.remove(project, condition),
      );
    } catch (error) {
      console.warn("The platform could not say that the project is gone", error);
      return "unknown";
    }
  }

  /**
   * What `asked` comes to, or a rejection once it took longer than `ms`: what people wait for
   * ends, whatever the network does and whatever the host waits for.
   */
  #within<T>(ms: number, asked: Promise<T>): Promise<T> {
    const environment = this.#options.environment ?? pageEnvironment();
    return new Promise<T>((resolve, reject) => {
      const timer = environment.setTimeout(
        () => reject(new Error(`No answer within ${ms} ms`)),
        ms,
      );
      asked.then(
        (value) => {
          environment.clearTimeout(timer);
          resolve(value);
        },
        (error: unknown) => {
          environment.clearTimeout(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });
  }

  /**
   * How many other windows of this browser have a project open, or undefined where that cannot
   * be told: one may have then.
   */
  async #othersOf(key: string): Promise<number | undefined> {
    const { others } = this.#options;
    if (!others) return 0;
    try {
      return await others(key);
    } catch (error) {
      console.warn("Which windows have the project open could not be told", error);
      return undefined;
    }
  }

  /**
   * Whether a link is to a project of whoever is signed in, as far as both say. The platform says
   * the same of a project of somebody else as of one that is gone: only for one's own does "no
   * such project" mean that it is gone. A link or an account that does not say who is taken to be
   * the same.
   */
  isOwn(link: CloudLink): boolean {
    const who = this.#options.account?.getSnapshot();
    if (link.owner === undefined || who?.status !== "signedIn" || who.id === undefined) return true;
    return who.id === link.owner;
  }

  #wait(ms: number): Promise<void> {
    const environment = this.#options.environment ?? pageEnvironment();
    return new Promise((resolve) => environment.setTimeout(resolve, ms));
  }

  /** Whether the platform saves projects to GitHub at all. */
  get savesToGitHub(): boolean {
    return this.#options.cloud.repository !== undefined;
  }

  /**
   * Whether the open project can go to another repository than the one it has: at any time, see
   * the design of the start page, 4.
   */
  get canSwitchRepository(): boolean {
    return this.repository?.status?.repository !== undefined;
  }

  /**
   * Has the open project saved to another repository from now on: a new private one, or one people
   * have, see `RepositoryPicker`. Where archiving into the one it has paused, and also while it
   * goes as it should: what was archived there stays there. The first repository of a project is
   * chosen where it is made, see `CloudCreate`.
   */
  async switchRepository(): Promise<void> {
    const { cloud, session, notifications, t } = this.#options;
    const snapshot = this.#snapshot;
    const access = cloud.repository;
    const store = session.store;
    const key = session.key;
    if (snapshot.kind !== "linked" || !snapshot.repository || !access || !store || !key) return;
    const watch = snapshot.repository;
    const current = watch.status?.repository;
    if (!current) return;
    const title = t("repository.switchTitle");
    if (!(await this.#signedIn(title))) return;
    if (!this.#isStill(snapshot)) return;
    const linked = await this.#pickRepository(snapshot.link.project, watch.status ?? undefined, {
      current,
      name: connectRepositoryName(undefined, store.getState().manifest.name),
    });
    if (!linked || !this.#isStill(snapshot)) return;
    watch.take(linked, { hurry: true });
    if (!linked.unusable) void this.#tellUsable(snapshot.link.project);
    notifications.push(
      t("repository.linked", {
        name: linked.repository?.fullName ?? "",
        interpolation: { escapeValue: false },
      }),
    );
  }

  /**
   * Has a project of the platform that is not open here saved to another repository from now on,
   * as one whose repository cannot be used, from the start page: as `switchRepository` does.
   * Resolves to whether it has one now.
   */
  async switchRepositoryOf(project: string, name: string): Promise<boolean> {
    const { cloud, notifications, t } = this.#options;
    const access = cloud.repository;
    if (!access) return false;
    if (!(await this.#signedIn(t("repository.switchTitle")))) return false;
    let status: RepositoryStatus;
    try {
      status = await access.status(project);
    } catch (error) {
      console.warn("The repository of a project could not be asked about", error);
      notifications.push(t("repository.failure.unavailable"));
      return false;
    }
    const current = status.repository;
    if (!current) return false;
    const linked = await this.#pickRepository(project, status, {
      current,
      name: connectRepositoryName(undefined, name),
    });
    if (!linked) return false;
    if (!linked.unusable) void this.#tellUsable(project);
    notifications.push(
      t("repository.linked", {
        name: linked.repository?.fullName ?? "",
        interpolation: { escapeValue: false },
      }),
    );
    return true;
  }

  /** People choose another repository for a project, see `RepositoryPicker`. Resolves to its status. */
  async #pickRepository(
    project: string,
    status: RepositoryStatus | undefined,
    {
      current,
      name,
    }: {
      readonly current: NonNullable<RepositoryStatus["repository"]>;
      readonly name: string;
    },
  ): Promise<RepositoryStatus | undefined> {
    const { cloud, dialogs, account, t } = this.#options;
    const access = cloud.repository;
    if (!access) return undefined;
    const who = account?.getSnapshot();
    const picker = new RepositoryPicker({
      access,
      project,
      name,
      // Only where the platform would say no otherwise: one that paused takes another as it is.
      ...(status?.state === "ready" && { switching: true }),
      current,
      ...(who?.status === "signedIn" && { owner: who.name, appInstalled: who.appInstalled }),
    });
    void picker.refresh();
    const installApp = this.#options.installApp;
    const done = await dialogs.repository({
      title: t("repository.switchTitle"),
      picker,
      ...(installApp && { installApp }),
    });
    const linked = picker.getSnapshot().linked;
    picker.close();
    return done ? linked : undefined;
  }

  /**
   * The command that clones the repository of the open project, where it is one of the server's
   * own: `git clone "<folder>" "<name>"`. Undefined for any other.
   */
  cloneCommand(name: string): string | undefined {
    const repository = this.repository?.getSnapshot().status?.repository;
    if (repository?.place !== "local" || !repository.clone) return undefined;
    return cloneCommandOf(repository.clone, name, repository.name);
  }

  /**
   * "重新建一个", "从项目重新开始存档": archiving starts over into a new repository of the server's
   * own, for one gone or broken. Says how it went.
   */
  async restartArchive(): Promise<void> {
    const { notifications, t } = this.#options;
    const repository = this.repository;
    if (!repository) return;
    const outcome = await repository.restart();
    if (outcome.kind === "started") {
      notifications.push(t("repository.restarted"));
      return;
    }
    const code = outcome.code;
    const reason =
      code === "signedOut" || code === "busy" || code === "unavailable" || code === "notBroken"
        ? placedT(t, "local")(`repository.failure.${code}`)
        : t("repository.failure.other", { code });
    notifications.push(t("repository.archiveFailed", { reason }));
  }

  /** Archives the open project now, as people ask for it. */
  async archiveNow(): Promise<void> {
    const repository = this.repository;
    if (!repository) return;
    this.#tellArchive(await repository.archiveNow());
  }

  /**
   * People choose to go on with the editor's content where files of the project changed on GitHub
   * (Q3 of the plan): after they saw which files get written over and which taken away, the archive
   * goes on top of what GitHub has. Never forced: GitHub's version stays in the history.
   */
  async continueWithEditor(): Promise<void> {
    const { session, dialogs, notifications, t } = this.#options;
    const repository = this.repository;
    const status = repository?.status;
    const store = session.store;
    const diverged =
      status?.state === "paused" && (status.reason === "diverged" || status.reason === "too-large")
        ? status.diverged
        : undefined;
    if (!repository || !diverged || !store) return;
    const { files } = store.exportFiles();
    const { overwritten, removed, restored } = divergedOutcome(diverged, (path) => files.has(path));
    const details = [
      { title: t("repository.replaceOverwritten"), items: overwritten },
      { title: t("repository.replaceRemoved"), items: removed },
      { title: t("repository.replaceRestored"), items: restored },
    ].filter(({ items }) => items.length > 0);
    const go = await dialogs.confirm({
      title: t("repository.replaceTitle"),
      message: t("repository.replaceMessage"),
      confirm: t("repository.replaceConfirm"),
      danger: true,
      details,
    });
    if (!go || this.repository !== repository) return;
    const outcome = await repository.archiveNow({ replace: diverged.sha });
    if (outcome.kind === "refused" && outcome.code === "diverged") {
      notifications.push(t("repository.replaceChanged"));
      return;
    }
    this.#tellArchive(outcome);
  }

  /** What people should hear about "archive now": nothing where it started. */
  #tellArchive(outcome: ArchiveNowOutcome): void {
    const { notifications, t } = this.#options;
    if (outcome.kind === "waiting") {
      const seconds = Math.max(1, Math.ceil((outcome.at - Date.now()) / 1000));
      notifications.push(t("repository.archiveWait", { count: seconds }));
    } else if (outcome.kind === "refused") {
      const code = outcome.code;
      const reason =
        code === "signedOut" ||
        code === "busy" ||
        code === "unavailable" ||
        code === "notFound" ||
        code === "alreadyLinked"
          ? t(`repository.failure.${code}`)
          : code === "diverged"
            ? t("repository.pause.diverged", {
                count: outcome.error?.diverged?.files.length ?? 0,
              })
            : t("repository.failure.other", { code });
      notifications.push(t("repository.archiveFailed", { reason }));
    }
  }

  /**
   * People choose what to do with a project whose syncing stopped at something the platform does
   * not take, or that it does not have: everything stays here either way. A change of its own cannot
   * stay behind while the rest goes on, as what comes after it in Yjs builds on it: the project goes
   * on from what it is here, or people take a copy of it into a folder. A project the platform does
   * not have, or not as one of whoever is signed in, cannot go on from here: a copy in a folder is
   * the way out. Resolves to "saveToFolder" where people want that, which whoever shows the panel
   * does, right in the press.
   */
  async resolveStuck(): Promise<"saveToFolder" | undefined> {
    const { dialogs, t, session } = this.#options;
    const key = session.key;
    const snapshot = this.#snapshot;
    if (!key || snapshot.kind !== "linked") return undefined;
    const isMissing = snapshot.session.getSnapshot().problem?.kind === "missing";
    const answer = await dialogs.choose({
      title: t("cloud.stuckTitle"),
      message: t(isMissing ? "cloud.stuckMissingMessage" : "cloud.stuckMessage"),
      choices: isMissing
        ? [{ id: "saveToFolder", label: t("saveToFolder.action"), kind: "primary" }]
        : [
            { id: "saveToFolder", label: t("saveToFolder.action") },
            { id: "resync", label: t("cloud.resync"), kind: "primary" },
          ],
    });
    if (session.key !== key || !this.#isStill(snapshot)) return undefined;
    if (answer === "resync") await snapshot.session.resyncFromHere();
    return answer === "saveToFolder" ? "saveToFolder" : undefined;
  }

  /**
   * Stops syncing, and forgets the link: here, and in the other windows. Resolves to whether the
   * link is gone. Whoever asked says what came of it.
   */
  async #unlink(key: string): Promise<boolean> {
    const { cloud } = this.#options;
    await this.#stop();
    try {
      await cloud.links.remove(key);
    } catch (error) {
      console.warn("The link to the platform could not be taken away", error);
      this.#key = undefined;
      this.#store = undefined;
      void this.follow();
      return false;
    }
    // The copy in the browser is only there now.
    this.#set(ONLY_HERE);
    this.#tell();
    return true;
  }

  /** What this browser keeps about a project that went off the list. */
  async forget(key: string): Promise<void> {
    await this.#options.cloud.links.remove(key).catch((error: unknown) => {
      console.warn("The link of a project that is gone stays for now", error);
    });
  }

  /**
   * Opens a project of the platform, by its id there. What this browser has of it opens as it is,
   * with or without a network: its folder where a folder is connected to it, and otherwise the copy
   * in the browser. Only where it has neither does the project come from the platform, as a copy
   * in this browser that syncs, kept by the id of the project on the platform: two projects there
   * can have the same id of their own, as copies of one project do, and each is a project of its
   * own here. Resolves to whether it is open.
   */
  async openCloudProject(project: string, about: CloudProjectAbout = {}): Promise<boolean> {
    const { notifications, t } = this.#options;
    let here: CloudLink | undefined;
    try {
      [here] = await this.#copiesOf(project);
    } catch (error) {
      console.warn("What this browser has of a project of the platform could not be read", error);
      notifications.push(t("cloud.open.failed"));
      return false;
    }
    if (here) return this.#open(here.key);
    if (!(await this.#signedIn(t("cloud.openTitle")))) return false;
    if (!(await this.#whenLive(project, about))) return false;
    const downloaded = await this.#download(project);
    if (!downloaded) return false;
    const key = await this.#keep(project, downloaded);
    return key !== undefined && this.#open(key);
  }

  /** Opens what this browser keeps by `key`, unless it is open already. Resolves to whether it is. */
  async #open(key: string): Promise<boolean> {
    const { session } = this.#options;
    if (session.key !== key) await this.#options.openProject(key);
    return session.key === key;
  }

  /**
   * Whether the platform has the working copy of a project, which is what can be opened. One that
   * only its repository has now is asked for (`CloudAccess.wake`), and one on its way back from
   * there is waited for, as people watch: "正在从 GitHub 取回…". Where it cannot come, people hear
   * why, and what helps: to try again once it is time, or, where what the repository has kept it
   * from coming, to take the branch as it is once they put that right on GitHub.
   */
  async #whenLive(project: string, about: CloudProjectAbout): Promise<boolean> {
    const { cloud, dialogs, notifications, t } = this.#options;
    let copy = about.copy ?? "live";
    if (copy === "live") return true;
    // Let go of as nobody opened it for long: people hear why it takes a moment.
    const coming = t(copy === "released" ? "cloud.open.restoringReleased" : "cloud.open.restoring");
    const name = about.name ?? "";
    const environment = this.#options.environment ?? pageEnvironment();
    for (let asked = 0; asked < 10; asked++) {
      if (copy === "released") {
        const woke = await this.#wake(project, false);
        if (woke === undefined) return false;
        if (woke.copy === "released") {
          const again = await this.#notWoken(name, woke);
          if (again === undefined) return false;
          const retried = await this.#wake(project, again === "fromBranch");
          if (retried === undefined) return false;
          if (retried.copy === "released") {
            await this.#notWoken(name, retried, { once: true });
            return false;
          }
          copy = retried.copy;
        } else copy = woke.copy;
        if (copy === "live") return true;
      }
      if (copy !== "restoring") {
        notifications.push(t("cloud.open.notLive"));
        return false;
      }
      const progress = dialogs.progress({
        title: coming,
        cancel: t("dialog.cancel"),
        stopping: t("transfer.stopping"),
      });
      const until = environment.now() + RESTORE_WAIT_MS;
      let found: CloudProjectSummary | "gone" | undefined;
      try {
        for (;;) {
          await new Promise<void>((resolve) => {
            const timer = environment.setTimeout(resolve, RESTORE_POLL_MS);
            progress.signal.addEventListener(
              "abort",
              () => {
                environment.clearTimeout(timer);
                resolve();
              },
              { once: true },
            );
          });
          if (progress.signal.aborted) return false;
          found = await cloud.list().then(
            (list) => list.find((each) => each.id === project) ?? "gone",
            () => undefined,
          );
          if (progress.signal.aborted) return false;
          if (found === "gone") {
            notifications.push(t("cloud.open.gone"));
            return false;
          }
          const now = found?.copy ?? (found ? "live" : "restoring");
          if (now === "live") return true;
          if (now !== "restoring") {
            copy = now;
            break;
          }
          if (environment.now() >= until) {
            notifications.push(t("cloud.open.restoringLong"));
            return false;
          }
        }
      } finally {
        progress.close();
      }
      // It went back to "released": making it failed, and the list says why.
      if (copy === "released" && typeof found === "object" && found.copyProblem) {
        const again = await this.#notWoken(name, {
          copy: "released",
          refused: "busy",
          copyProblem: found.copyProblem,
        });
        if (again === undefined) return false;
        const retried = await this.#wake(project, again === "fromBranch");
        if (retried === undefined) return false;
        if (retried.copy === "released") {
          await this.#notWoken(name, retried, { once: true });
          return false;
        }
        copy = retried.copy;
        if (copy === "live") return true;
      }
    }
    return false;
  }

  /**
   * "从这个仓库恢复成在线项目": a repository of the person's that has a project at its top, which
   * connecting turns away, becomes a new project of the platform, made from the last commit of its
   * branch, see `RepositoryAccess.restore`; then it opens, in this browser only, as one that is
   * opened from the list. People say yes first, and watch it come ("正在从 GitHub 取回…"); where it
   * cannot, they hear why. `other`: a project is open that this does not change, and they are told
   * so. Resolves to whether it opened.
   */
  async restoreFromRepository(
    repository:
      | { readonly id: number; readonly fullName: string; readonly public?: boolean }
      /** A repository of the server's own, by its folder there (`localRepositories`). */
      | { readonly dir: string; readonly fullName: string; readonly public?: undefined },
    {
      other = false,
      asked = false,
    }: {
      readonly other?: boolean;
      /** People chose it in a dialog that said what restoring does already. */
      readonly asked?: boolean;
    } = {},
  ): Promise<boolean> {
    const { cloud, dialogs, notifications, t } = this.#options;
    const access = cloud.repository;
    const local = "dir" in repository;
    const restore = local
      ? access?.restoreLocal && ((dir: string) => access.restoreLocal!(dir))
      : access?.restore;
    if (!access || !restore) return false;
    const plain = { interpolation: { escapeValue: false } } as const;
    const words = { repository: repository.fullName, ...plain };
    const go =
      asked ||
      (await dialogs.confirm({
        title: t("cloud.restore.confirmTitle", words),
        message: [
          t("cloud.restore.confirmMessage"),
          ...(other ? [t("cloud.restore.confirmMessageOther")] : []),
          ...(repository.public ? [t("cloud.restore.publicNote")] : []),
        ].join(""),
        confirm: t("cloud.restore.confirm"),
      }));
    if (!go) return false;
    if (!(await this.#signedIn(t("cloud.openTitle")))) return false;
    const environment = this.#options.environment ?? pageEnvironment();
    const progress = dialogs.progress({
      title: t("cloud.restore.running"),
      cancel: t("dialog.cancel"),
      stopping: t("transfer.stopping"),
    });
    let made: { readonly id: string; readonly name: string } | undefined;
    let failure: string | undefined;
    try {
      const restored =
        "dir" in repository
          ? await access.restoreLocal!(repository.dir)
          : await access.restore!({
              existing: { id: repository.id },
              ...(repository.public && { confirmPublic: true }),
            });
      made = restored.project;
      if (restored.copy !== "live") {
        // It takes longer: the list says once it is there, or that it could not be.
        const until = environment.now() + RESTORE_WAIT_MS;
        for (;;) {
          await this.#pause(RESTORE_POLL_MS, progress.signal).catch(() => {});
          if (progress.signal.aborted) {
            notifications.push(t("cloud.restore.long"));
            return false;
          }
          const found = await cloud.list().then(
            (list) => list.find((each) => each.id === restored.project.id) ?? "gone",
            () => undefined,
          );
          if (found === "gone") {
            failure = t("cloud.restore.gone");
            break;
          }
          const copy = found?.copy ?? (found ? "live" : "restoring");
          if (copy === "live") break;
          if (copy === "released" && found && typeof found === "object") {
            failure = found.copyProblem
              ? copyProblemText(found.copyProblem, t)
              : t("cloud.restore.gone");
            break;
          }
          if (environment.now() >= until) {
            notifications.push(t("cloud.restore.long"));
            return false;
          }
        }
      }
    } catch (error) {
      if (error instanceof CloudSignedOut) failure = t("cloud.restore.failure.signedOut");
      else if (error instanceof RepositoryRefused) failure = restoreRefusalText(error, t);
      else {
        console.warn("A repository could not be restored as a project of the platform", error);
        failure = t("cloud.restore.failure.unavailable");
      }
    } finally {
      progress.close();
    }
    if (failure !== undefined || !made) {
      await dialogs.confirm({
        title: t("cloud.restore.failedTitle", words),
        message: failure ?? t("cloud.restore.gone"),
        confirm: t("dialog.close"),
        noticeOnly: true,
      });
      return false;
    }
    return this.openCloudProject(made.id, { name: made.name, copy: "live" });
  }

  /** The repositories of the server's own that people can restore: none where it has none. */
  async localRepositories(): Promise<readonly LocalRepository[]> {
    const access = this.#options.cloud.repository;
    if (!access?.localRepositories) return [];
    return access.localRepositories();
  }

  /**
   * "从本机仓库恢复…": people choose one of the repositories of the server's own that no project is
   * saved to, and it is restored as `restoreFromRepository` does one on GitHub. Resolves to
   * whether a project opened.
   */
  async restoreLocalRepository(): Promise<boolean> {
    const { dialogs, notifications, t } = this.#options;
    let list: readonly LocalRepository[];
    try {
      list = await this.localRepositories();
    } catch {
      notifications.push(t("cloud.restoreLocal.failed"));
      return false;
    }
    if (list.length === 0) {
      notifications.push(t("cloud.restoreLocal.empty"));
      return false;
    }
    const chosen = await dialogs.choose({
      title: t("cloud.restoreLocal.title"),
      message: t("cloud.restoreLocal.message"),
      stacked: true,
      choices: list.map((repository, index) => ({
        id: repository.dir,
        label: repository.name,
        ...(index === 0 && { kind: "primary" as const }),
      })),
    });
    const repository = list.find((each) => each.dir === chosen);
    if (!repository) return false;
    return this.restoreFromRepository(
      { dir: repository.dir, fullName: repository.name },
      { asked: true },
    );
  }

  /** Asks the platform for the working copy of a project, see `CloudAccess.wake`. */
  async #wake(project: string, fromBranch: boolean): Promise<CloudWake | undefined> {
    const { cloud, notifications, t } = this.#options;
    if (!cloud.wake) {
      notifications.push(t("cloud.open.notLive"));
      return undefined;
    }
    try {
      const woke = await cloud.wake(project, fromBranch ? { fromBranch: true } : {});
      if (woke.copy === "missing") {
        notifications.push(t("cloud.wake.missing"));
        return undefined;
      }
      return woke;
    } catch (error) {
      console.warn("The platform could not be asked for the working copy of a project", error);
      notifications.push(
        t(
          error instanceof CloudSignedOut
            ? "cloud.restore.failure.signedOut"
            : "cloud.wake.unavailable",
        ),
      );
      return undefined;
    }
  }

  /**
   * Says why the working copy of a project could not come, and what helps: "retry" once it may be
   * tried again; "fromBranch" where what the repository had kept it from coming. Resolves to what
   * people chose, or undefined. `once`: only says it, as after trying again.
   */
  async #notWoken(
    name: string,
    woke: Extract<CloudWake, { copy: "released" }>,
    { once = false } = {},
  ): Promise<"retry" | "fromBranch" | undefined> {
    const { dialogs, t } = this.#options;
    const environment = this.#options.environment ?? pageEnvironment();
    const plain = { interpolation: { escapeValue: false } } as const;
    const problem = woke.copyProblem;
    const why = problem ? copyProblemText(problem, t) : undefined;
    const lines: string[] = [];
    if (woke.refused === "noRepository") lines.push(t("cloud.wake.noRepository"));
    else if (woke.refused === "unusable") lines.push(t("cloud.wake.unusable"));
    else if (woke.refused === "notAllowed") lines.push(t("cloud.wake.notAllowed"));
    else if (why) lines.push(t("cloud.wake.busy", { why, ...plain }));
    const mends = problem !== undefined && BRANCH_MENDS.has(problem.code);
    const retryAt =
      problem?.retryAt ??
      (woke.retryAfter !== undefined ? environment.now() + woke.retryAfter * 1000 : undefined);
    const canRetry =
      woke.refused === "busy" && (retryAt === undefined || retryAt <= environment.now());
    if (woke.refused === "busy" && !canRetry && retryAt !== undefined) {
      lines.push(
        t("cloud.wake.retryAt", {
          count: Math.max(1, Math.ceil((retryAt - environment.now()) / 60_000)),
        }),
      );
    }
    if (mends) lines.push(t("cloud.wake.fixed"), t("cloud.wake.fromGitHubNote"));
    const choices = once
      ? []
      : [
          ...(canRetry ? [{ id: "retry", label: t("cloud.wake.retry") }] : []),
          ...(mends
            ? [{ id: "fromBranch", label: t("cloud.wake.fromGitHub"), kind: "primary" as const }]
            : []),
        ];
    const title = t("cloud.wake.failedTitle", { name, ...plain });
    if (choices.length === 0) {
      await dialogs.confirm({
        title,
        message: lines.join(""),
        confirm: t("dialog.close"),
        noticeOnly: true,
      });
      return undefined;
    }
    const answer = await dialogs.choose({ title, message: lines.join(""), choices });
    return answer === "retry" || answer === "fromBranch" ? answer : undefined;
  }

  /** All of a project from the platform, with people watching, who can stop it. */
  async #download(project: string): Promise<Downloaded | undefined> {
    const { cloud, dialogs, notifications, t } = this.#options;
    const progress = dialogs.progress({
      title: t("cloud.downloading"),
      cancel: t("dialog.cancel"),
      stopping: t("transfer.stopping"),
    });
    try {
      const downloaded = await download(cloud, project, {
        window: this.#options.window,
        editor: this.#options.editor,
        signal: progress.signal,
      });
      return progress.signal.aborted ? undefined : downloaded;
    } catch (error) {
      if (progress.signal.aborted) return undefined;
      console.warn("The project could not come from the platform", error);
      notifications.push(
        t(
          error instanceof DownloadFailed && error.code === SYNC_CLOSE.outdated
            ? "cloud.problem.outdated"
            : "cloud.downloadFailed",
        ),
      );
      return undefined;
    } finally {
      progress.close();
    }
  }

  /**
   * Keeps a project that came from the platform as a copy in this browser, with its link. Resolves
   * to the key of the copy, also where another window made one meanwhile, or to undefined after
   * saying why there is none.
   */
  async #keep(
    project: string,
    downloaded: Downloaded,
    {
      quietly = false,
      received,
    }: {
      readonly quietly?: boolean;
      /** The copy on its way in already, see `receiveFor`. */
      readonly received?: { readonly key: string; readonly incoming: IncomingProject };
    } = {},
  ): Promise<string | undefined> {
    const { cloud, projects, account, t } = this.#options;
    const notifications = quietly ? { push: () => {} } : this.#options.notifications;
    const { store } = ProjectStore.fromUpdates([downloaded.state]);
    if (!store) {
      notifications.push(t("cloud.downloadFailed"));
      return undefined;
    }
    const { name } = store.getState().manifest;
    store.destroy();
    try {
      // By its id on the platform, which is its own: the id in the project is not.
      let key = received?.key ?? project;
      let incoming = received?.incoming ?? (await projects.receive({ id: key, name }));
      if (!incoming) {
        // Another window may have brought it in meanwhile: that copy is the one.
        const [there] = await this.#copiesOf(project);
        if (there) return there.key;
        const kept = await projects.list();
        if (!kept.some((summary) => summary.id === key)) {
          // On its way in, in another window.
          notifications.push(t("cloud.open.busy"));
          return undefined;
        }
        // This browser keeps a project by that number that is not connected to this one, as one
        // that people disconnected: it stays as it is, and the copy gets a number of its own.
        key = newSyncId();
        incoming = await projects.receive({ id: key, name });
        if (!incoming) throw new Error("A new number for the copy is taken");
      }
      const who = account?.getSnapshot();
      const link: CloudLink = {
        key,
        platform: cloud.platform,
        project,
        seq: downloaded.head,
        digest: downloaded.digest,
        // Until the log says where what came is in it, see below.
        pushed: 0,
        linkedAt: Date.now(),
        name,
        ...(downloaded.generation !== undefined && { generation: downloaded.generation }),
        ...(who?.status === "signedIn" && who.id !== undefined && { owner: who.id }),
      };
      try {
        // The link first: a page that goes away right here leaves a link to nothing, which the
        // next time takes the place of. The other way round it would leave a project that looks
        // like one of this browser only.
        await cloud.links.put(link);
        await incoming.finish(downloaded.state);
      } catch (error) {
        await incoming.abandon().catch(() => {});
        await cloud.links.remove(key).catch(() => {});
        throw error;
      }
      // What came is what the platform has: none of it has to go there. Without this all of it
      // goes once, which costs time and nothing else.
      try {
        const log = await projects.open(key);
        try {
          const mark = (await log.entries?.())?.at(-1)?.mark;
          if (mark !== undefined) await cloud.links.update(key, project, { pushed: mark });
        } finally {
          log.close();
        }
      } catch (error) {
        console.warn("Where the project from the platform is in its log could not be noted", error);
      }
      return key;
    } catch (error) {
      console.warn("The project from the platform could not be kept here", error);
      notifications.push(t("cloud.downloadFailed"));
      return undefined;
    }
  }

  /**
   * Keeps a project that was just made on the platform, see `CloudCreate`, as a copy in this
   * browser that syncs: the same as one that is opened from there. `received`: the copy on its
   * way in already, with the files of its assets, as for one that was imported, see `receiveFor`.
   * Resolves to its key, or to
   * undefined where it could not be kept: the project is on the platform either way.
   */
  keepUploaded(
    project: string,
    made: Downloaded,
    received?: { readonly key: string; readonly incoming: IncomingProject },
  ): Promise<string | undefined> {
    return this.#keep(project, made, { quietly: true, ...(received && { received }) });
  }

  /**
   * Begins to bring in the copy in this browser of a project that is about to be made on the
   * platform, by its id there, unseen until `keepUploaded` keeps it: what is imported puts the
   * files of its assets there before anything goes to the platform. A number of its own where this
   * browser keeps another project by that id. Undefined where it cannot.
   */
  async receiveFor(
    project: string,
    name: string,
  ): Promise<{ readonly key: string; readonly incoming: IncomingProject } | undefined> {
    const { projects } = this.#options;
    for (const key of [project, newSyncId()]) {
      const incoming = await projects.receive({ id: key, name });
      if (incoming) return { key, incoming };
    }
    return undefined;
  }

  /**
   * A project of the platform as it is, for a copy of it as a project of this computer, see
   * `ProjectFolders.saveAsLocal` and the design of the start page, 4.3. Where this window has it
   * open, the project as it is here, with what did not get to the platform: of one whose repository
   * cannot be used, with what the platform has as well that it did not get here, where it can
   * still be read. Otherwise what the platform has, read only, which does not count as opening it,
   * and keeps nothing in this browser: also of a project that cannot be edited. Nothing of it
   * changes either way. Undefined, after saying why, where there is nothing to copy.
   */
  async copySource(
    project: string,
    signal: AbortSignal,
    mediaOf: (key: string) => Pick<MediaStore, "get">,
  ): Promise<CopySource | undefined> {
    const { session, notifications, t } = this.#options;
    const snapshot = this.#snapshot;
    const store = session.store;
    if (snapshot.kind === "linked" && snapshot.link.project === project && store) {
      await session.trySave();
      const media = mediaOf(snapshot.link.key);
      if (!this.unusable) return { store, media, close: () => {} };
      // What other computers sent before it could not be edited is on the platform, and may not
      // be here yet: the two copies of one project go together without losing anything.
      const there = await this.#read(project, signal).catch(() => undefined);
      // Of the same working copy only, see below.
      const generation = snapshot.link.generation ?? 1;
      if (!there || (there.generation ?? 1) !== generation)
        return { store, media, close: () => {} };
      const merged = ProjectStore.fromUpdates([store.encodeState(), there.state]).store;
      if (!merged) return { store, media, close: () => {} };
      return { store: merged, media, close: () => merged.destroy() };
    }
    // A copy in this browser that is not open: as its log has it, with what the platform has too.
    let browser: CloudLink | undefined;
    try {
      [browser] = await this.#copiesOf(project);
    } catch (error) {
      console.warn("What this browser has of a project of the platform could not be read", error);
    }
    if (browser) {
      let loaded: LoadedProject | undefined;
      try {
        loaded = await loadProject(this.#options.projects, browser.key);
      } catch (error) {
        console.warn("The copy in this browser could not be read for a copy", error);
      }
      if (loaded) {
        const local = loaded;
        const there = await this.#read(project, signal).catch(() => undefined);
        // Two copies of one project go together only where they are of the same working copy of
        // the platform. Until working copies are made again from repositories, there is only the
        // first one; once they are, a copy of another one is to be taken in as on coming back
        // (docs/design/start-and-cloud.md of AnimaQuill Cloud, plan 13.5), not left out unsaid.
        const fits = there && (there.generation ?? 1) === (browser.generation ?? 1);
        const merged = fits
          ? ProjectStore.fromUpdates([local.store.encodeState(), there.state]).store
          : undefined;
        return {
          store: merged ?? local.store,
          media: mediaOf(browser.key),
          close: () => {
            merged?.destroy();
            local.close();
          },
        };
      }
    }
    let there: Downloaded;
    try {
      there = await this.#read(project, signal);
    } catch (error) {
      if (signal.aborted) return undefined;
      console.warn("The project could not come from the platform for a copy", error);
      notifications.push(
        t(
          error instanceof DownloadFailed && error.reason === "released"
            ? "cloud.copy.released"
            : error instanceof DownloadFailed && error.code === SYNC_CLOSE.outdated
              ? "cloud.problem.outdated"
              : "cloud.downloadFailed",
        ),
      );
      return undefined;
    }
    const copied = ProjectStore.fromUpdates([there.state]).store;
    if (!copied) {
      notifications.push(t("cloud.downloadFailed"));
      return undefined;
    }
    // This browser has no files of it.
    return { store: copied, media: { get: async () => undefined }, close: () => copied.destroy() };
  }

  /** What the platform has of a project, read only, see `download`. */
  #read(project: string, signal: AbortSignal): Promise<Downloaded> {
    return download(this.#options.cloud, project, {
      window: this.#options.window,
      editor: this.#options.editor,
      signal,
      readOnly: true,
    });
  }

  /**
   * The link of a copy of a project of the platform that this browser keeps by `key`, or undefined
   * for a project that is not connected. Rejects when the links cannot be read.
   */
  async linkOf(key: string): Promise<CloudLink | undefined> {
    const { cloud } = this.#options;
    const link = await cloud.links.get(key);
    return link?.platform === cloud.platform ? link : undefined;
  }

  /**
   * Where the copy of a link is, as far as the places of files go, see `Here`: the repository its
   * project is saved to, as the link last heard, and whose project it is. A file that is kept
   * somewhere bound to anything else cannot come from there again once this copy is gone: the
   * large file storage of another repository, the cloud space of somebody else. So does one in a
   * storage of the person's own that is set up on a computer, as nothing says that another one
   * has it.
   */
  #hereOf(link: CloudLink): Here {
    const who = this.#options.account?.getSnapshot();
    return {
      repo: link.repository ? String(link.repository.id) : undefined,
      owner: link.owner ?? (who?.status === "signedIn" ? who.id : undefined),
    };
  }

  /**
   * What the platform's list says of the open project now, as its properties show it: when it was
   * made and changed, how large it is. Undefined where it is no project of the platform yet, or
   * the platform cannot say now.
   */
  async summaryOfOpen(): Promise<CloudProjectSummary | undefined> {
    const snapshot = this.#snapshot;
    if (snapshot.kind !== "linked" || !snapshot.made) return undefined;
    try {
      const list = await this.#within(LIST_WAIT_MS, this.#options.cloud.list());
      return list.find((each) => each.id === snapshot.link.project);
    } catch {
      return undefined;
    }
  }

  /**
   * Whether the platform has the project of a link, as its list says right now, see
   * `OnlyHere.cloud`. The list is the only thing that says so: a copy that synced a moment ago
   * may be of a project that was taken away since, on another computer.
   */
  async #onPlatform(link: CloudLink): Promise<OnlyHere["cloud"]> {
    try {
      const list = await this.#within(LIST_WAIT_MS, this.#options.cloud.list());
      if (list.some((each) => each.id === link.project)) return "there";
      // The list is that of whoever is signed in: it says nothing of a project of somebody else.
      return this.isOwn(link) ? "gone" : "otherAccount";
    } catch (error) {
      console.warn("Whether the platform still has the project could not be asked", error);
      return "unknown";
    }
  }

  /**
   * What this browser has of a project that the platform may not have, by reading its log,
   * looking at its files, and asking the platform whether the project is there: what taking the
   * copy out of this browser would lose. `withLeft`: also what closed windows left on it, which
   * is not asked while this window has the project open, as what it keeps there itself is its
   * own to settle as it leaves.
   */
  async #onlyHere(
    key: string,
    link: CloudLink,
    {
      withLeft,
      askPlatform = true,
      withFiles = true,
    }: {
      readonly withLeft: boolean;
      /** Whether the platform is asked whether it has the project: "unknown" otherwise. */
      readonly askPlatform?: boolean;
      /** Whether the files are looked at: none otherwise, which only the changes are wanted for. */
      readonly withFiles?: boolean;
    },
  ): Promise<OnlyHere> {
    const { projects } = this.#options;
    // Asked while the log is read. A project that never got there is not asked about.
    const asked: Promise<OnlyHere["cloud"]> =
      link.creating || !askPlatform ? Promise.resolve("unknown") : this.#onPlatform(link);
    const leaving = withLeft
      ? Promise.resolve(this.#options.leftBehind?.(key) ?? [])
      : Promise.resolve([]);
    // Looked at below, or not at all where the log cannot be read.
    leaving.catch(() => {});
    const log = await projects.open(key);
    let entries: readonly LogEntry[] | undefined;
    let updates: readonly Uint8Array[];
    try {
      entries = await log.entries?.();
      updates = entries ? entries.map((entry) => entry.update) : await log.load();
    } finally {
      log.close();
    }
    const waiting = entries?.filter((entry) => entry.mark > link.pushed && !isOnPlatform(entry));
    // A project whose first version may not have got there is not on the platform at all. One
    // that waits to go there in one piece is not there until the platform took that, whatever the
    // log says, see `CloudLink.resync`.
    const changes: OnlyHere["changes"] = link.creating
      ? "all"
      : waiting === undefined || (waiting.length === 0 && link.resync !== undefined)
        ? "unknown"
        : waiting.length;
    const [cloud, left] = await Promise.all([asked, leaving]);
    if (!withFiles) return { changes, files: [], left, cloud };
    const { store } = ProjectStore.fromUpdates(updates);
    // Without the project nothing says which files it needs.
    if (!store) return { changes: changes === 0 ? "unknown" : changes, files: [], left, cloud };
    try {
      const state = store.getState();
      const kept = await projects.copies(key);
      const here = this.#hereOf(link);
      const files = Object.entries(state.assets ?? {}).flatMap(([id, asset]) => {
        const { hash } = asset;
        // What can be downloaded from where it is kept comes again with the project.
        if (hash === undefined || elsewhereOf(state, id, here) !== undefined) return [];
        return kept.some((copy) => isSameHash(hash, copy.name)) ? [asset.path] : [];
      });
      return { changes, files: [...new Set(files)].toSorted(), left, cloud };
    } finally {
      store.destroy();
    }
  }

  /**
   * Every project of the backend this browser has a copy of whose copy has something the backend
   * may not have, as for "清掉这台电脑上的数据" (docs/design/online-offline.md of AnimaQuill Cloud,
   * 2.1): changes that did not go, files that can be downloaded from nowhere else, what closed
   * windows left on it, or a project the backend does not have any more. With what it is, in
   * words. What cannot be read counts as such. The project this window has open is not looked at
   * for what windows left: it is to be closed first. Rejects where the list of the backend could
   * not be read: without it nothing can be said.
   */
  async unsavedHere(): Promise<readonly { readonly name: string; readonly said: string }[]> {
    const { cloud, projects, session } = this.#options;
    const listed = new Set((await this.#within(LIST_WAIT_MS, cloud.list())).map((each) => each.id));
    const copies = await projects.list();
    const names = new Map(copies.map((each) => [each.id, each.name]));
    const links = (await cloud.links.list()).filter(
      (link) => link.platform === cloud.platform && names.has(link.key),
    );
    const found: { name: string; said: string }[] = [];
    for (const link of links) {
      let here: OnlyHere | undefined;
      try {
        const read = await this.#onlyHere(link.key, link, {
          withLeft: session.key !== link.key,
          askPlatform: false,
        });
        here = {
          ...read,
          cloud: listed.has(link.project) ? "there" : this.isOwn(link) ? "gone" : "otherAccount",
        };
      } catch (error) {
        console.warn("What the copy of a project has could not be read", error);
        here = undefined;
      }
      if (isAllThere(here)) continue;
      found.push({ name: names.get(link.key) ?? link.name ?? "", said: this.#onlyHereText(here) });
    }
    return found;
  }

  /** Takes a link away. Resolves to whether it is gone. */
  async #forgetLink(key: string): Promise<boolean> {
    try {
      await this.#options.cloud.links.remove(key);
      return true;
    } catch (error) {
      console.warn("The link of a project that is gone could not be taken away", error);
      return false;
    }
  }

  /**
   * Takes away the links that are left of copies this browser does not keep any more, as where
   * taking a copy out of it stopped between the copy and its link: nothing reads them, see
   * `#copiesOf`. Once after the page loaded is enough. Not a link that was made just now: its
   * project may still be on its way in, see `#keep`.
   */
  async tidy(): Promise<void> {
    const { cloud, projects } = this.#options;
    try {
      const links = (await cloud.links.list()).filter((link) => link.platform === cloud.platform);
      if (links.length === 0) return;
      const kept = new Set((await projects.list()).map((summary) => summary.id));
      const now = Date.now();
      for (const link of links) {
        if (kept.has(link.key) || now - link.linkedAt < STALE_LINK_MS) continue;
        // Still the same one: a copy that came in meanwhile has a link of its own under this key.
        const still = await cloud.links.get(link.key);
        if (still?.project !== link.project || still.linkedAt !== link.linkedAt) continue;
        await cloud.links.remove(link.key);
      }
    } catch (error) {
      console.warn("Links of copies that are gone could not be looked for", error);
    }
  }

  /** What is only here, in words, see `unsavedHere`. */
  #onlyHereText(found: OnlyHere | undefined): string {
    const { t } = this.#options;
    const said: string[] = [];
    // First what there is no doubt about: the platform does not have the project at all.
    if (found?.cloud === "gone") said.push(t("cloud.remove.gone"));
    if (!found || found.changes === "unknown") said.push(t("cloud.remove.unknown"));
    else if (found.changes === "all") said.push(t("cloud.remove.notThere"));
    else if (found.changes > 0) said.push(t("cloud.remove.unsynced", { count: found.changes }));
    if (found && found.files.length > 0) {
      said.push(
        t("cloud.remove.files", {
          count: found.files.length,
          files: pathList(found.files),
          interpolation: { escapeValue: false },
        }),
      );
    }
    if (found && found.left.length > 0) {
      const what = found.left
        .map((kind) => t(`cloud.remove.left.${kind}`))
        .join(t("cloud.remove.and"));
      said.push(t("cloud.remove.leftBehind", { what, interpolation: { escapeValue: false } }));
    }
    // A project that never got there is said above: whether the platform has it is no question.
    if (found && found.changes !== "all") {
      if (found.cloud === "unknown") said.push(t("cloud.remove.cloudUnknown"));
      if (found.cloud === "otherAccount") said.push(t("cloud.remove.cloudOtherAccount"));
    }
    return said.join("");
  }

  /**
   * Takes a project of the platform away there, for good, once people said so, see the design of
   * the start page, 5: what the platform has of it goes, its repository stays as it is, and what
   * this computer has of it stays as a project of this computer, but a copy in this browser that
   * the platform has all of. Only whoever it is of can: the list of whoever is signed in has it.
   *
   * 1. People are told what goes and what stays, and say yes. Nobody types its name.
   * 2. Changes of a copy in this browser go to the platform first, as nothing else has them: one
   *    that is not open opens for that, and closes again. Where they cannot, nothing goes.
   * 3. The platform archives what it has into the repository, and is asked to take the project
   *    away only once that is done, see `CloudRemoveOptions`: where something came after, it
   *    archives again. Where it cannot archive, people choose whether to let go of what the
   *    repository does not have; that is the only way it goes without. A project whose repository
   *    cannot be used goes without, as nothing can be archived; one without a repository too.
   * 4. A folder stays as a project of this computer. A copy in this browser goes once its log, its
   *    files and what closed windows left on it are read again, and the platform had all of it;
   *    otherwise it stays as a project of this browser only, as does one that is open elsewhere,
   *    or that cannot be read.
   *
   * Resolves to whether it is gone.
   */
  async deleteFromCloud(project: string, name: string): Promise<boolean> {
    const { cloud, dialogs, notifications, t } = this.#options;
    if (!cloud.remove) return false;
    const words = { name, interpolation: { escapeValue: false } };
    const title = t("cloud.delete.title", words);
    if (!(await this.#signedIn(title))) return false;
    // What the platform says of it, and what this computer has of it, before anything goes.
    let summary: CloudProjectSummary | undefined;
    let copies: readonly CloudLink[];
    try {
      const list = await this.#within(LIST_WAIT_MS, cloud.list());
      summary = list.find((each) => each.id === project);
      copies = await this.#copiesOf(project);
    } catch (error) {
      console.warn("Whether the project can be deleted could not be found out", error);
      notifications.push(
        t(error instanceof CloudSignedOut ? "cloud.delete.signedOut" : "cloud.delete.unreadable"),
      );
      return false;
    }
    if (!summary) {
      // Not of whoever is signed in, or gone already: either way nothing is asked of the platform.
      notifications.push(t("cloud.delete.notListed", words));
      return false;
    }
    const repository = summary.repository;
    const unusable = repository?.unusable;
    const archives = repository !== undefined && unusable === undefined;
    const message = [
      unusable
        ? t("cloud.delete.unusable", {
            what: unusableTitle(unusable, t),
            interpolation: { escapeValue: false },
          })
        : repository
          ? t("cloud.delete.withRepository", {
              repository: repository.fullName,
              interpolation: { escapeValue: false },
            })
          : t("cloud.delete.noRepository"),
      // As it is, the platform's copy may have what the repository does not: people hear that.
      ...(unusable && summary.archive?.behind === true ? [t("cloud.delete.unsavedGo")] : []),
      ...(copies.length > 0
        ? [t(archives ? "cloud.delete.browserGoes" : "cloud.delete.browserStays")]
        : []),
      ...(archives ? [t("cloud.delete.archiveFirst")] : []),
    ].join("");
    const go = await dialogs.confirm({
      title,
      message,
      confirm: t("cloud.delete.confirm"),
      danger: true,
    });
    if (!go) return false;
    // A copy whose repository cannot be used cannot sync: what it has stays with it, see below.
    if (!unusable) {
      for (const link of copies) {
        if (!(await this.#sendUp(link, name))) return false;
      }
    }
    const outcome = await this.#takeAwayArchived(project, name, { archives });
    if (outcome === "stopped") return false;
    const said = [t("cloud.delete.done", words)];
    for (const link of copies) {
      // Only where the repository has all the platform had does the platform's having all of the
      // copy say that nothing is lost with it. Otherwise the copy may be the last place some
      // changes are: it stays, as a project of this browser only, with its ways out.
      const kept =
        outcome === "archived" ? await this.#letGoOfCopy(link) : await this.#keepCopy(link);
      said.push(
        kept === undefined
          ? t("cloud.delete.doneBrowser")
          : t("cloud.delete.keptBrowser", { why: t(`cloud.delete.kept.${kept}`) }),
      );
    }
    notifications.push(said.join(""), { stays: copies.length > 0 });
    return true;
  }

  /**
   * Has the platform take a project away once its repository has all of it, see
   * `deleteFromCloud`, step 3, or as people let go of what it does not have. The open project of
   * it stops syncing first: nothing of it comes back, and the platform's word that it is gone is
   * no news from elsewhere. Where it stays, it goes on as before. Resolves to how it went:
   * "archived" where the platform took it away once its repository had all of it, "removed" where
   * it went without that (people let go, its repository cannot be used, it has none), "stopped"
   * where it stays, after saying why.
   */
  async #takeAwayArchived(
    project: string,
    name: string,
    { archives }: { readonly archives: boolean },
  ): Promise<"archived" | "removed" | "stopped"> {
    const { notifications, t } = this.#options;
    const words = { name, interpolation: { escapeValue: false } };
    let stopped = false;
    const goOn = (): "stopped" => {
      // The open project syncs again, as it did.
      if (stopped) {
        this.#key = undefined;
        this.#store = undefined;
        void this.follow();
      }
      return "stopped";
    };
    // Without a repository, or with one that cannot be used, it goes as it is.
    let condition: CloudRemoveOptions | undefined = archives ? undefined : {};
    for (let round = 1; ; round++) {
      if (condition === undefined) {
        const archived = await this.#archiveFor(project, name);
        if (archived === "cancelled") return goOn();
        condition = archived;
      }
      const open = this.#snapshot;
      if (open.kind === "linked" && open.link.project === project) {
        await this.#stop();
        stopped = true;
      }
      const outcome = await this.#takeAway(project, condition);
      if (outcome === "removed") return condition.archived !== undefined ? "archived" : "removed";
      if (outcome === "missing") {
        // Gone already, as the list had it a moment ago: what this computer has stays all the same.
        notifications.push(t("cloud.delete.notListed", words));
        return goOn();
      }
      if (outcome === "unknown") {
        notifications.push(t("cloud.delete.failed"));
        return goOn();
      }
      if (outcome === "hasRepository") {
        // A repository after all, or one that cannot be used where the platform does not take
        // such projects away by themselves yet: it cannot be archived either way just now.
        const discard = await this.#askDiscard(name, t("cloud.delete.cannotArchive"));
        if (!discard) return goOn();
        condition = { discard: true };
        continue;
      }
      if (outcome.kind === "uploading") {
        const discard = await this.#askDiscard(
          name,
          t("cloud.delete.uploading", { count: outcome.uploads }),
        );
        if (!discard) return goOn();
        condition = { discard: true };
        continue;
      }
      // Something came after the archive, or archiving did not go as it should: once more.
      if (round < DELETE_ROUNDS && outcome.state !== "paused") {
        condition = undefined;
        continue;
      }
      const reason =
        outcome.state === "paused"
          ? pauseText({ ...(outcome.reason !== undefined && { reason: outcome.reason }) }, t).reason
          : t("cloud.delete.keepsChanging");
      if (!(await this.#askDiscard(name, reason))) return goOn();
      condition = { discard: true };
    }
  }

  /**
   * Has the platform archive what it has of a project into its repository, and waits for that,
   * with people watching, who can stop it. Resolves to the update that the repository has all up
   * to, to `discard` where it could not be archived and people let go of what is not, or to
   * "cancelled".
   */
  async #archiveFor(project: string, name: string): Promise<CloudRemoveOptions | "cancelled"> {
    const { cloud, dialogs, t } = this.#options;
    const access = cloud.repository;
    // A platform that saves no projects to repositories: what it says about one comes as an answer.
    if (!access) return {};
    const environment = this.#options.environment ?? pageEnvironment();
    const progress = dialogs.progress({
      title: t(`cloud.delete.archiving`, { name, interpolation: { escapeValue: false } }),
      cancel: t("dialog.cancel"),
      stopping: t("transfer.stopping"),
    });
    const until = environment.now() + ARCHIVE_WAIT_MS;
    let asked = false;
    /** The platform takes "archive now" once a minute: one asked for too soon goes then. */
    let askAt = 0;
    let why: string;
    try {
      for (;;) {
        if (progress.signal.aborted) return "cancelled";
        let status: RepositoryStatus;
        try {
          status = await this.#within(REMOVE_WAIT_MS, access.status(project));
        } catch (error) {
          if (progress.signal.aborted) return "cancelled";
          why = t(
            error instanceof CloudSignedOut
              ? "repository.failure.signedOut"
              : "repository.failure.unavailable",
          );
          break;
        }
        if (progress.signal.aborted) return "cancelled";
        // Nothing can be archived: it goes as it is, which the platform takes for such a one.
        if (status.unusable) return {};
        if (status.state === "none") return {};
        if (status.state === "paused") {
          why = pauseText(status, t).reason;
          break;
        }
        const failures = status.failures ?? 0;
        const isDone =
          status.archivedSeq >= status.head &&
          status.dirtySince === undefined &&
          !status.archiving &&
          failures === 0;
        if (isDone) return { archived: status.head };
        if (asked && !status.archiving && failures > 0) {
          why = status.detail
            ? t("cloud.delete.archiveFailedSaid", { detail: status.detail })
            : t("cloud.delete.archiveFailed");
          break;
        }
        if (!asked && !status.archiving && environment.now() >= askAt) {
          asked = true;
          try {
            await this.#within(REMOVE_WAIT_MS, access.archiveNow(project));
          } catch (error) {
            // One a minute: it is asked again once the platform takes it.
            if (error instanceof RepositoryRefused && error.code === "busy") {
              asked = false;
              askAt = environment.now() + (error.retryAfter ?? 60) * 1000;
            } else {
              if (progress.signal.aborted) return "cancelled";
              why = t(
                error instanceof CloudSignedOut
                  ? "repository.failure.signedOut"
                  : "repository.failure.unavailable",
              );
              break;
            }
          }
        }
        if (environment.now() >= until) {
          why = t("cloud.delete.archiveSlow");
          break;
        }
        await this.#pause(ARCHIVE_POLL_MS, progress.signal);
      }
    } finally {
      progress.close();
    }
    return (await this.#askDiscard(name, why)) ? { discard: true } : "cancelled";
  }

  /**
   * Asks whether a project goes all the same, without what its repository does not have. Resolves
   * to whether people said so.
   */
  async #askDiscard(name: string, why: string): Promise<boolean> {
    const { dialogs, t } = this.#options;
    const answer = await dialogs.choose({
      title: t(`cloud.delete.title`, { name, interpolation: { escapeValue: false } }),
      // Why says it in a sentence of its own sometimes: one full stop is enough.
      message: t(`cloud.delete.notArchived`, {
        why: why.replace(/。$/, ""),
        interpolation: { escapeValue: false },
      }),
      choices: [{ id: "discard", label: t(`cloud.delete.discard`), kind: "danger" }],
    });
    return answer === "discard";
  }

  /**
   * Has the changes of a copy of this browser go to the platform, before the project goes there:
   * nothing else has them. One that is not open opens for that, and goes back to where people
   * were. Resolves to whether all of it is there, after saying why where it is not.
   */
  async #sendUp(link: CloudLink, name: string): Promise<boolean> {
    const { session, dialogs, notifications, t } = this.#options;
    const words = { name, interpolation: { escapeValue: false } };
    const wasOpen = session.key === link.key;
    if (!wasOpen) {
      // Nothing to send: the log says so, and nothing has to open.
      if ((await this.#waitingIn(link.key)) === 0) return true;
      await this.#options.openProject(link.key);
      if (session.key !== link.key) {
        notifications.push(t(`cloud.delete.notOpened`, words));
        return false;
      }
    }
    const environment = this.#options.environment ?? pageEnvironment();
    const progress = dialogs.progress({
      title: t(`cloud.delete.syncing`, words),
      cancel: t("dialog.cancel"),
      stopping: t("transfer.stopping"),
    });
    const until = environment.now() + SYNC_WAIT_MS;
    let why: string | undefined;
    let isThere = false;
    try {
      await session.trySave();
      for (;;) {
        if (progress.signal.aborted) break;
        const sync = this.session;
        if (!sync || sync.key !== link.key) {
          why = t("cloud.delete.notSyncing");
          break;
        }
        await sync.flush();
        const waiting = await this.#waitingIn(link.key);
        if (waiting === 0) {
          isThere = true;
          break;
        }
        const { state, problem } = sync.getSnapshot();
        if (state === "paused") {
          why =
            problem?.kind === "rejected"
              ? t("cloud.problem.rejected", {
                  reason: t(`cloud.reason.${problem.reason}`),
                  interpolation: { escapeValue: false },
                })
              : problem
                ? t(`cloud.problem.${problem.kind}`)
                : t("cloud.status.paused");
          break;
        }
        if (environment.now() >= until) {
          why = t(
            state === "offline" || state === "reconnecting"
              ? "cloud.delete.offline"
              : "cloud.delete.syncSlow",
          );
          break;
        }
        await this.#pause(SYNC_POLL_MS, progress.signal);
      }
    } finally {
      progress.close();
    }
    if (!isThere && why !== undefined) {
      await dialogs.confirm({
        title: t(`cloud.delete.title`, words),
        message: t(`cloud.delete.notSynced`, { why, interpolation: { escapeValue: false } }),
        confirm: t("dialog.close"),
        noticeOnly: true,
      });
    }
    // Back to the start page, as people were, unless it stays as the project they are in.
    if (!wasOpen && session.key === link.key) await this.#options.closeProject?.();
    return isThere;
  }

  /**
   * How many changes in the log of a copy of this browser the platform may not have, as for
   * `unsavedHere`: "unknown" where that cannot be told. Never rejects.
   */
  async #waitingIn(key: string): Promise<number | "unknown"> {
    try {
      const link = await this.#options.cloud.links.get(key);
      if (!link) return "unknown";
      const found = await this.#onlyHere(key, link, {
        withLeft: false,
        askPlatform: false,
        withFiles: false,
      });
      return typeof found.changes === "number" ? found.changes : "unknown";
    } catch (error) {
      console.warn("Whether the platform has all of the copy could not be read", error);
      return "unknown";
    }
  }

  /**
   * The copy in this browser of a project that is gone from the platform: it goes once its log, its
   * files and what closed windows left on it are read again, and the platform had all of it.
   * Otherwise it stays, as a project of this browser only, with nothing taken away. Its link goes
   * either way. Resolves to why it stays, or undefined where it went.
   */
  async #letGoOfCopy(link: CloudLink): Promise<"open" | "unsynced" | "unread" | undefined> {
    const { session, projects, cloud } = this.#options;
    const { key } = link;
    /** What only it has, as its log says now: not as it was when this began. */
    const look = async (withLeft: boolean): Promise<OnlyHere | undefined> => {
      try {
        const now = await cloud.links.get(key);
        if (!now) return undefined;
        return await this.#onlyHere(key, now, { withLeft, askPlatform: false });
      } catch (error) {
        console.warn("What only the copy in this browser has could not be read", error);
        return undefined;
      }
    };
    const isOnlyHere = (found: OnlyHere) =>
      found.changes !== 0 || found.files.length > 0 || found.left.length > 0;
    let kept: "open" | "unsynced" | "unread" | undefined;
    if (session.key === key) {
      // Open here: what it has is read first, and only a copy that goes is closed.
      const isSaved = await session.trySave();
      await this.session?.flush();
      const found = isSaved ? await look(false) : undefined;
      if (!found) kept = "unread";
      else if (isOnlyHere(found)) kept = "unsynced";
      else if (!(await this.#options.closeProject?.()) || session.key === key) kept = "open";
      if (kept !== undefined) {
        // It stays open, as a project of this browser only.
        await this.#unlink(key);
        return kept;
      }
    }
    if ((await this.#othersOf(key)) !== 0) kept = "open";
    if (kept === undefined) {
      const found = await look(true);
      if (!found) kept = "unread";
      else if (isOnlyHere(found)) kept = "unsynced";
    }
    if (kept === undefined) {
      try {
        await (this.#options.removeLocal ?? ((id: string) => projects.remove(id)))(key);
      } catch (error) {
        console.warn("The copy of a project that was deleted stays in this browser", error);
        kept = "unread";
      }
    }
    // The link goes last: a copy that went without it is a link to nothing, which `tidy` takes away.
    if (!(await this.#forgetLink(key)) && !(await this.#forgetLink(key))) {
      console.warn("The link of a project that was deleted stays until the next time");
    }
    this.#tellAbout(key);
    return kept;
  }

  /**
   * The copy in this browser of a project that went from the platform without its repository
   * having all of it, see `deleteFromCloud`: it stays as it is, as a project of this browser
   * only, and only its link goes. Resolves to why it stays.
   */
  async #keepCopy(link: CloudLink): Promise<"notArchived"> {
    const { key } = link;
    if (this.#options.session.key === key) await this.#unlink(key);
    else {
      if (!(await this.#forgetLink(key)) && !(await this.#forgetLink(key))) {
        console.warn("The link of a project that was deleted stays until the next time");
      }
      this.#tellAbout(key);
    }
    return "notArchived";
  }

  /** Waits a while, or until `signal` says to stop. */
  #pause(ms: number, signal: AbortSignal): Promise<void> {
    const environment = this.#options.environment ?? pageEnvironment();
    return new Promise<void>((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      const timer = environment.setTimeout(() => {
        signal.removeEventListener("abort", stop);
        resolve();
      }, ms);
      const stop = () => {
        environment.clearTimeout(timer);
        resolve();
      };
      signal.addEventListener("abort", stop, { once: true });
    });
  }
}
