import { ProjectStore, elsewhereOf } from "@animaquill/core";
import {
  FolderError,
  SYNC_CLOSE,
  newSyncId,
  type AccountAccess,
  type CloudAccess,
  type CloudLine,
  type CloudLink,
  type CloudLinkRepository,
  type FolderRecords,
  type LocalFolder,
  type LogEntry,
  type ProjectLibrary,
  type WindowMemory,
} from "@animaquill/host";
import { isSameHash } from "@animaquill/media";
import type { TFunction } from "i18next";
import type { Dialogs } from "../workbench/dialogs.ts";
import { Emitter } from "../workbench/emitter.ts";
import type { Notifications } from "../workbench/notifications.ts";
import type { ProjectSession } from "../workbench/session.ts";
import { CloudConnect, takeIntent, type ConnectTiming } from "./connect.ts";
import { DownloadFailed, download, type Downloaded } from "./download.ts";
import { RepositoryPicker } from "./repository-picker.ts";
import { defaultRepositoryName, divergedOutcome, pathList } from "./repository-text.ts";
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

/**
 * Which project of this window is connected to the platform, and how people connect one, let go of
 * one, and open one from there, see docs/design/local-projects.md 7.2 and 7.5. The open project
 * syncs through a `CloudSession`; this decides whether it does.
 *
 * A project in a folder says in `.animaquill/cloud.json` which project of the platform it is, so that
 * the folder knows it wherever it goes. What counts is the link this browser keeps, though: only a
 * log that came from that project can go on with it, see `CloudLink`. A folder whose file names a
 * project that this browser did not connect it to is a copy of a folder that is, or one from another
 * browser: people choose to let it go, or to make it a project of its own on the platform.
 *
 * A project of the platform can also be opened without a folder, see the design of the start page
 * (docs/design/start-and-cloud.md of AnimaQuill Cloud), 1: it is kept in this browser then, by its
 * id on the platform, which no two of them share, and syncs like any other. This browser has one
 * copy of a project of the platform at most: a folder, or that copy in the browser. Taking the
 * copy out of the browser reads its log first, as what did not get to the platform is nowhere else.
 */

/** Where a folder says which project of the platform it is. */
export const CLOUD_FILE = ".animaquill/cloud.json";
/** Keeps .animaquill out of Git, without changing the .gitignore of the project. */
const IGNORE_FILE = ".animaquill/.gitignore";

/** What .animaquill/cloud.json says. */
export interface CloudFile {
  readonly platform: string;
  readonly project: string;
}

export const cloudFileText = (file: CloudFile): string =>
  `${JSON.stringify({ version: 1, platform: file.platform, project: file.project }, null, 2)}\n`;

export function readCloudFile(text: string): CloudFile | undefined {
  try {
    const value = JSON.parse(text) as { platform?: unknown; project?: unknown };
    if (typeof value.platform !== "string" || typeof value.project !== "string") return undefined;
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(value.project)) return undefined;
    return { platform: value.platform, project: value.project };
  } catch {
    return undefined;
  }
}

const isFolderError = (error: unknown, ...reasons: readonly FolderError["reason"][]) =>
  error instanceof FolderError && reasons.includes(error.reason);

export type CloudProjectsSnapshot =
  /** The open project is not connected, and nothing says it should be. */
  | { readonly kind: "none" }
  | {
      readonly kind: "linked";
      readonly session: CloudSession;
      /** The link as it was when syncing began here: how far it got since is the session's to say. */
      readonly link: CloudLink;
      /** How saving it to GitHub goes, where the platform does that. */
      readonly repository: RepositoryWatch | undefined;
      /**
       * Where the project is on this computer: in a folder, or in this browser only, as a project
       * of the platform that was opened without one.
       */
      readonly local: "folder" | "browser";
    }
  /**
   * The folder says it is a project of the platform that this browser does not sync from it: a
   * copy of a folder that this browser syncs ("copy"), a folder of a project that this browser has
   * a copy of its own of ("browser"), or a folder from somewhere else ("foreign").
   */
  | {
      readonly kind: "detached";
      readonly project: string;
      readonly reason: "copy" | "browser" | "foreign";
    };

/** Why a project could not begin to connect, see `CloudProjects.beginLink`. */
export type LinkRefusal =
  /** Changes of it are not in its log yet. */
  | "notSaved"
  /** This browser keeps no marks in logs, which syncing goes by. */
  | "unsupported"
  /** Its folder is not open yet. */
  | "folderNotReady"
  /** The link could not be kept. */
  | "failed";

/** What a project of the platform is like, as whoever opens it from a list knows it. */
export interface CloudProjectAbout {
  readonly name?: string;
  /** See `CloudProjectSummary.copy`. */
  readonly copy?: string;
}

/** What this browser has of a project that the platform may not have, see `removeFromBrowser`. */
interface OnlyHere {
  /**
   * Changes in its log that did not go to the platform: "all" where the project may not be there
   * at all, and "unknown" where the log does not tell.
   */
  readonly changes: number | "all" | "unknown";
  /** Files of its assets that this browser has, and that can be downloaded from nowhere else. */
  readonly files: readonly string[];
}

export interface CloudProjectsOptions {
  readonly cloud: CloudAccess;
  readonly session: ProjectSession;
  readonly projects: ProjectLibrary;
  /** The folder of a project of this window that is a folder, by its key, once the folder is there. */
  readonly folderOf: (key: string) => LocalFolder | undefined;
  /** Whether a project of this window is a folder, also while its folder is not there yet. */
  readonly isFolder: (key: string) => boolean;
  readonly account: AccountAccess | undefined;
  readonly dialogs: Dialogs;
  readonly notifications: Notifications;
  readonly t: TFunction;
  /** Which window this is, see `ChangeSource.window`. */
  readonly window: string;
  /** The version of the editor. */
  readonly editor: string;
  /** Signs in: the page goes and comes back. */
  readonly signIn: () => Promise<void>;
  readonly openProject: (id: string) => Promise<void>;
  /** Leaves the page to install the GitHub App on the account, and comes back. */
  readonly installApp?: () => void;
  /**
   * The folders this browser knows, where it can write folders: which of the projects it keeps are
   * folders. Without it none is.
   */
  readonly records?: Pick<FolderRecords, "get">;
  /** How many other windows of this browser have a project open, by its key. */
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
   * Moves a project of this browser into a folder that people choose, see `FolderMove`. Resolves
   * to whether it moved. Missing where the browser cannot write folders.
   */
  readonly moveToFolder?: (key: string) => Promise<boolean>;
  /**
   * Whether people did something just now, so that the browser lets the editor ask them for a
   * folder: it only does for a moment after a click.
   */
  readonly isActive?: () => boolean;
  /** What this window remembers through a reload: what connecting was at when the page left. */
  readonly memory?: WindowMemory;
  /** Whether the page is going away on purpose now, as after `signIn`, see `Workbench.leavePage`. */
  readonly leaving?: () => boolean;
  readonly timing?: Partial<CloudTiming>;
  readonly environment?: CloudEnvironment;
  readonly repositoryTiming?: Partial<RepositoryTiming>;
  readonly repositoryEnvironment?: RepositoryEnvironment;
  readonly connectTiming?: Partial<ConnectTiming>;
}

const NONE: CloudProjectsSnapshot = { kind: "none" };

/** What people hear where a project could not begin to connect. */
const LINK_REFUSALS = {
  notSaved: "cloud.notSaved",
  unsupported: "cloud.unsupported",
  folderNotReady: "cloud.folderNotReady",
  failed: "cloud.connectFailed",
} as const satisfies Record<LinkRefusal, string>;

/** How often the list is asked while a project comes back from its repository, and for how long. */
const RESTORE_POLL_MS = 3000;
const RESTORE_WAIT_MS = 5 * 60_000;
/**
 * How long after giving up on a project that was just being made the platform is asked once more
 * to take it away: what was on its way there may only have arrived by then, see `abandonConnect`.
 */
const SETTLE_MS = 1500;

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
  /** Folders whose question people put off, by key, so that it comes once per page. */
  readonly #asked = new Set<string>();
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
  /**
   * The project of the platform that the open project is known to be there as, see `isOnPlatform`:
   * the link of the snapshot is as it was when syncing began, and may still say `creating`.
   */
  #made: string | undefined;

  constructor(options: CloudProjectsOptions) {
    this.#options = options;
    options.account?.subscribe(() => {
      const session = this.session;
      if (options.account?.getSnapshot().status !== "signedIn" || !session) return;
      if (session.getSnapshot().problem?.kind === "signed-out") session.resume();
      const repository = this.repository;
      if (repository?.getSnapshot().trouble === "signedOut") void repository.refresh();
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
    return snapshot.kind === "linked" && this.#made === snapshot.link.project;
  }

  #set(snapshot: CloudProjectsSnapshot): void {
    this.#snapshot = snapshot;
    this.#emitter.emit();
  }

  /** Looks again at the open project, after it changed or its folder came. */
  follow(): Promise<void> {
    const { session } = this.#options;
    const key = session.key;
    const store = session.store;
    if (key === this.#key && store === this.#store && !this.#waitsForFolder()) {
      return this.#following;
    }
    const turn = ++this.#turn;
    this.#following = this.#following
      .then(() => this.#look(turn))
      .catch((error: unknown) => {
        console.warn("Whether the project syncs could not be found out", error);
      });
    return this.#following;
  }

  /**
   * A folder project whose folder was not there at the last look: one that waited for it, or one
   * that syncs and moved into a folder just now, which has to say so there.
   */
  #waitsForFolder(): boolean {
    const key = this.#key;
    return (
      key !== undefined &&
      this.#snapshot.kind !== "detached" &&
      this.#options.isFolder(key) &&
      this.#folderLooked !== key &&
      this.#options.folderOf(key) !== undefined
    );
  }

  #folderLooked: string | undefined;
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
      if ((data as { kind?: unknown } | null)?.kind !== "link" || this.#options.session.key !== key)
        return;
      // Looks again as if the project had just opened.
      void this.#stop().then(() => {
        this.#key = undefined;
        this.#store = undefined;
        return this.follow();
      });
    });
    this.#line = { line, stop };
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
      this.#folderLooked = undefined;
      this.#listen(key);
    }
    if (!key || !store) return;
    const isFolder = this.#options.isFolder(key);
    const folder = this.#options.folderOf(key);
    // A folder that is not there yet comes with its own look.
    if (isFolder && !folder) return;
    if (folder) this.#folderLooked = key;
    const linked = this.#snapshot;
    if (linked.kind === "linked") {
      // It syncs already, and is a folder now, as after it moved into one: the folder says which
      // project of the platform it is from here on.
      if (!folder) return;
      await this.#sayInFolder(folder, linked.link);
      if (this.#snapshot === linked && linked.local !== "folder") {
        this.#set({ ...linked, local: "folder" });
      }
      return;
    }
    const link = await cloud.links.get(key).catch(() => undefined);
    const file = folder ? await this.#readFile(folder) : undefined;
    if (turn !== this.#turn) return;
    if (link && link.platform === cloud.platform) {
      if (folder && (file?.project !== link.project || file.platform !== cloud.platform)) {
        // The browser's link is what counts; the folder says so again, as a folder that was moved
        // into, or lost its file.
        await this.#writeFile(folder, link).catch((error: unknown) => {
          console.warn("The folder could not say which project of the platform it is", error);
        });
      }
      this.#start(link, store);
      if (link.creating) void this.#whenOnline(link);
      return;
    }
    if (file && file.platform === cloud.platform) {
      const reason = await this.#whyDetached(key, file.project);
      if (turn !== this.#turn) return;
      this.#set({ kind: "detached", project: file.project, reason });
      if (!this.#asked.has(key)) {
        this.#asked.add(key);
        void this.resolveDetached();
      }
      return;
    }
    this.#set(NONE);
  }

  /**
   * Why a folder that names a project of the platform does not sync with it here: this browser has
   * that project as another folder already, or as a copy of its own, or not at all. A link whose
   * project this browser does not keep any more says nothing.
   */
  async #whyDetached(key: string, project: string): Promise<"copy" | "browser" | "foreign"> {
    try {
      const { folders, browsers } = await this.#copiesOf(project);
      if (folders.some((link) => link.key !== key)) return "copy";
      if (browsers.some((link) => link.key !== key)) return "browser";
    } catch (error) {
      console.warn("What this browser has of the project of a folder could not be read", error);
    }
    return "foreign";
  }

  /**
   * The copies this browser has of a project of the platform, by their links: folders, and copies
   * in the browser. A link to a project that this browser does not keep any more is neither.
   */
  async #copiesOf(
    project: string,
  ): Promise<{ readonly folders: readonly CloudLink[]; readonly browsers: readonly CloudLink[] }> {
    const { cloud, projects, records } = this.#options;
    const links = await cloud.links.withProject(cloud.platform, project);
    if (links.length === 0) return { folders: [], browsers: [] };
    const folders: CloudLink[] = [];
    const rest: CloudLink[] = [];
    for (const link of links) {
      ((await records?.get(link.key)) ? folders : rest).push(link);
    }
    if (rest.length === 0) return { folders, browsers: [] };
    const kept = await projects.list();
    // The log of a folder whose record went is no project of the browser, see `ProjectSummary`.
    const browsers = rest.filter((link) =>
      kept.some((summary) => summary.id === link.key && summary.folder !== true),
    );
    return { folders, browsers };
  }

  /** Has the folder of a project that syncs say which project of the platform it is. */
  async #sayInFolder(folder: LocalFolder, link: CloudLink): Promise<void> {
    const file = await this.#readFile(folder);
    if (file?.project === link.project && file.platform === link.platform) return;
    await this.#writeFile(folder, link).catch((error: unknown) => {
      console.warn("The folder could not say which project of the platform it is", error);
    });
  }

  async #readFile(folder: LocalFolder): Promise<CloudFile | undefined> {
    try {
      return readCloudFile(await folder.readText(CLOUD_FILE));
    } catch (error) {
      if (!isFolderError(error, "missing", "not-text", "refused")) {
        console.warn("What the folder says about the platform could not be read", error);
      }
      return undefined;
    }
  }

  async #writeFile(folder: LocalFolder, link: CloudLink): Promise<void> {
    try {
      await folder.write(IGNORE_FILE, "*\n", { expected: "absent" });
    } catch (error) {
      if (!isFolderError(error, "changed")) throw error;
    }
    await folder.write(CLOUD_FILE, cloudFileText(link));
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
    this.#made = link.creating ? undefined : link.project;
    const stopSync = sync.subscribe(() => {
      this.#emitter.emit();
      const { state, problem } = sync.getSnapshot();
      // Another window disconnected it: this one looks again, and finds no link.
      if (problem?.kind === "unlinked") void this.#unlinked(sync);
      // The platform only lets the owner of a project sync it: whoever is signed in is the one.
      if (state === "online") this.#rememberOwner(link);
    });
    const stopRepository = repository?.subscribe(() => {
      this.#emitter.emit();
      const status = repository.status;
      if (!status) return;
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
      repository,
      local: this.#options.isFolder(link.key) ? "folder" : "browser",
    });
    this.#remember(link, { name });
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

  /** Whether the open project can be connected now: there is one, and it is not connected. */
  get canConnect(): boolean {
    return this.#options.session.store !== undefined && this.#snapshot.kind !== "linked";
  }

  get canDisconnect(): boolean {
    return this.#snapshot.kind === "linked";
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
   * Connects the open project to the platform, as a new project there whose first version is what
   * the project is now, see the design, 7.2. A folder that names another project of the platform
   * becomes a new one too, with `replace`. People say yes first, and are asked about GitHub once it
   * is there; `CloudConnect` does all of that in one dialog, see `beginConnect`.
   */
  async connect({ replace = false } = {}): Promise<void> {
    const { session, dialogs, notifications, t } = this.#options;
    const key = session.key;
    const store = session.store;
    if (!key || !store) return;
    if (this.#snapshot.kind === "linked") {
      notifications.push(t("cloud.alreadyConnected"));
      return;
    }
    if (!(await this.#signedIn(t("cloud.connectTitle", { name: store.getState().manifest.name }))))
      return;
    const words = { name: store.getState().manifest.name, interpolation: { escapeValue: false } };
    const go = await dialogs.confirm({
      title: t(replace ? "cloud.newTitle" : "cloud.connectTitle", words),
      message: t("cloud.connectMessage"),
      confirm: t(replace ? "cloud.newConfirm" : "cloud.connectConfirm"),
    });
    if (!go || session.store !== store) return;
    const begun = await this.beginLink();
    if (typeof begun === "string") {
      notifications.push(t(LINK_REFUSALS[begun]));
      return;
    }
    void this.#tellWhenConnected(begun);
  }

  /**
   * Keeps a link from the open project to a new project of the platform, and starts syncing: the
   * first connection makes the project there, from what the open project is then. The first step
   * of connecting, which asks nobody anything. Resolves to the link, or to why there is none. A
   * project that has a link already keeps it.
   */
  async beginLink(): Promise<CloudLink | LinkRefusal> {
    const { session, cloud, account } = this.#options;
    const key = session.key;
    const store = session.store;
    if (!key || !store) return "failed";
    if (this.#snapshot.kind === "linked") return this.#snapshot.link;
    // What is in the log is what goes: all of it, and nothing that is still on its way there.
    if (!(await session.trySave())) return "notSaved";
    let entries: readonly LogEntry[] | undefined;
    try {
      await session.readLog();
      entries = await session.journal.entries();
    } catch (error) {
      console.warn("The log of the project could not be read for connecting it", error);
      return "failed";
    }
    if (!entries) return "unsupported";
    if (session.store !== store) return "failed";
    const folder = this.#options.isFolder(key) ? this.#options.folderOf(key) : undefined;
    if (this.#options.isFolder(key) && !folder) return "folderNotReady";
    const who = account?.getSnapshot();
    const link: CloudLink = {
      key,
      platform: cloud.platform,
      project: newSyncId(),
      seq: 0,
      pushed: entries.at(-1)?.mark ?? 0,
      linkedAt: Date.now(),
      creating: true,
      name: store.getState().manifest.name,
      ...(who?.status === "signedIn" && who.id !== undefined && { owner: who.id }),
    };
    try {
      await cloud.links.put(link);
    } catch (error) {
      console.warn("The link to the platform could not be kept", error);
      return "failed";
    }
    await this.#stop();
    this.#turn += 1;
    this.#key = key;
    this.#store = store;
    if (folder) {
      this.#folderLooked = key;
      await this.#writeFile(folder, link).catch((error: unknown) => {
        // Next time the project opens, the folder gets it from the link.
        console.warn("The folder could not say which project of the platform it is", error);
      });
    }
    this.#start(link, store);
    this.#tell();
    return link;
  }

  /**
   * Waits for the project of a link to be on the platform, however long that takes, and keeps that
   * it is from then on. Resolves to whether it got there while this window synced it.
   */
  async #whenOnline(link: CloudLink): Promise<boolean> {
    const session = this.session;
    if (!session || session.project !== link.project) return false;
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
  }

  /** The project of a link is on the platform now: the link says so, and GitHub can be asked about it. */
  async noteMade(link: CloudLink): Promise<void> {
    const isOpen = () => this.session?.project === link.project;
    if (isOpen() && this.#made !== link.project) {
      this.#made = link.project;
      this.#emitter.emit();
    }
    // Only that: how far it got is the session's to note down, at the same time.
    await this.#options.cloud.links
      .update(link.key, link.project, { made: true })
      .catch(() => false);
    if (isOpen()) this.repository?.start();
  }

  /** Says once that the first connection got there, and asks about GitHub. */
  async #tellWhenConnected(link: CloudLink): Promise<void> {
    const { notifications, t } = this.#options;
    const session = this.session;
    if (!session || !(await this.#whenOnline(link))) return;
    notifications.push(t("cloud.connected"));
    // Once, right after connecting: a copy away from the platform, on GitHub (Q1 of the plan).
    if (this.repository && this.session === session) await this.saveToGitHub({ asking: true });
  }

  /**
   * The dialog that connects the open project in one go, see `CloudConnect` and the design of the
   * start page, 3: the project goes to the platform, gets its repository, and is archived there
   * for the first time. For a project that is on the platform without a repository, as one from
   * before every project there had one, it only does what is missing. Undefined where there is
   * nothing to do, or the platform saves no projects to repositories: `connect` is all there is
   * then. `resume`: only where the page left in the middle of it, as to sign in, and came back.
   */
  beginConnect({ resume = false } = {}): CloudConnect | undefined {
    const { session, cloud, account, memory, connectTiming, environment } = this.#options;
    const key = session.key;
    const store = session.store;
    const access = cloud.repository;
    if (!key || !store || !access || !account) return undefined;
    const now = (environment ?? pageEnvironment()).now();
    const intent = memory && takeIntent(memory, key, now);
    if (resume && !intent) return undefined;
    const snapshot = this.#snapshot;
    // It has its repository: what there is to say about it is in the panel.
    if (snapshot.kind === "linked" && snapshot.repository?.status?.repository) return undefined;
    const folder = this.#options.isFolder(key) ? this.#options.folderOf(key) : undefined;
    return new CloudConnect({
      projects: this,
      access,
      account,
      key,
      name: store.getState().manifest.name,
      folder: folder?.name,
      signIn: this.#options.signIn,
      ...(this.#options.installApp && { installApp: this.#options.installApp }),
      ...(memory && { memory }),
      ...(this.#options.leaving && { leaving: this.#options.leaving }),
      ...(intent && { intent }),
      ...(connectTiming && { timing: connectTiming }),
      ...(environment && { environment }),
    });
  }

  /**
   * Takes back a connection that connecting made and people gave up on before the project had a
   * repository: the project on the platform goes, then the link, and the project is one of this
   * computer only again. Syncing stops first, as the first connection would make the project
   * again. "kept": the platform says it has a repository after all, so it stays connected.
   * "unconfirmed": the platform could not say that the project is gone, as without a network; it
   * stays connected then, without a repository, unless `force` says to let go all the same, which
   * can leave a project without a repository on the platform for people to take away later.
   */
  async abandonConnect(
    link: CloudLink,
    { force = false } = {},
  ): Promise<"cancelled" | "kept" | "unconfirmed"> {
    const sync = this.session;
    if (this.#options.session.key !== link.key || !sync || sync.project !== link.project)
      return "unconfirmed";
    // What a connection that was saying hello may still bring there.
    const { state } = sync.getSnapshot();
    const isArriving = state === "connecting" || state === "reconnecting";
    // Another window of this browser that has the project open syncs it once this one stops, for
    // the moment until it hears that the link is gone: it can make the project again.
    const isElsewhere = ((await this.#options.others?.(link.key).catch(() => 0)) ?? 0) > 0;
    await this.#stop();
    let outcome = await this.#takeAway(link.project);
    if (outcome === "missing" && isArriving) {
      await this.#wait(SETTLE_MS);
      outcome = await this.#takeAway(link.project);
    }
    const isGone = outcome === "removed" || outcome === "missing";
    if (!isGone && !(force && outcome === "unknown")) {
      // It goes on as it was: this window looks at its link again.
      this.#key = undefined;
      this.#store = undefined;
      await this.follow();
      return outcome === "hasRepository" ? "kept" : "unconfirmed";
    }
    if (!(await this.#unlink(link.key, { quietly: true }))) return "unconfirmed";
    if (isElsewhere) {
      // No window syncs it any more: what one of them made of it meanwhile goes too.
      await this.#wait(SETTLE_MS);
      await this.#takeAway(link.project);
    }
    return "cancelled";
  }

  /** Asks the platform to take a project without a repository away. "unknown": it could not say. */
  async #takeAway(project: string): Promise<"removed" | "missing" | "hasRepository" | "unknown"> {
    const { cloud } = this.#options;
    if (!cloud.remove) return "unknown";
    try {
      return await cloud.remove(project);
    } catch (error) {
      console.warn("The platform could not say that the project is gone", error);
      return "unknown";
    }
  }

  #wait(ms: number): Promise<void> {
    const environment = this.#options.environment ?? pageEnvironment();
    return new Promise((resolve) => environment.setTimeout(resolve, ms));
  }

  /** Whether the platform saves projects to GitHub at all. */
  get savesToGitHub(): boolean {
    return this.#options.cloud.repository !== undefined;
  }

  /** Whether the open project can be saved to a repository now, or to another one in its place. */
  get canSaveToGitHub(): boolean {
    const repository = this.repository;
    return repository !== undefined && repository.status?.state !== "ready";
  }

  /**
   * Whether the open project can go to another repository than the one it has: at any time, see
   * the design of the start page, 4.
   */
  get canSwitchRepository(): boolean {
    return this.repository?.status?.repository !== undefined;
  }

  /**
   * Has the open project saved to another repository from now on, also while archiving into the
   * one it has goes as it should: what was archived there stays there.
   */
  async switchRepository(): Promise<void> {
    if (this.canSwitchRepository) await this.saveToGitHub({ switching: true });
  }

  /**
   * Saves the open project to GitHub: a new private repository, or one people have, see
   * `RepositoryPicker`. Also for another repository where archiving into this one paused, and
   * with `switching` at any time. `asking`: right after connecting, where people can put it off.
   */
  async saveToGitHub({ asking = false, switching = false } = {}): Promise<void> {
    const { cloud, session, dialogs, notifications, account, t } = this.#options;
    const snapshot = this.#snapshot;
    const access = cloud.repository;
    const store = session.store;
    if (snapshot.kind !== "linked" || !snapshot.repository || !access || !store) return;
    const watch = snapshot.repository;
    const isReady = watch.status?.state === "ready";
    if (isReady && !switching) {
      notifications.push(t("repository.failure.alreadyLinked"));
      return;
    }
    const title = t(
      asking ? "repository.askTitle" : switching ? "repository.switchTitle" : "repository.title",
    );
    if (!asking && !(await this.#signedIn(title))) return;
    if (this.#snapshot !== snapshot) return;
    const { name, id } = store.getState().manifest;
    const who = account?.getSnapshot();
    const current =
      watch.status?.state === "paused" || switching ? watch.status?.repository : undefined;
    const picker = new RepositoryPicker({
      access,
      project: snapshot.link.project,
      name: defaultRepositoryName(name, id),
      asking,
      // Only where the platform would say no otherwise: one that paused takes another as it is.
      ...(isReady && { switching: true }),
      ...(current && { current }),
      ...(who?.status === "signedIn" && { owner: who.name, appInstalled: who.appInstalled }),
    });
    void picker.refresh();
    const installApp = this.#options.installApp;
    const done = await dialogs.repository({
      title,
      picker,
      ...(installApp && { installApp }),
    });
    const linked = picker.getSnapshot().linked;
    picker.close();
    if (!done || !linked || this.#snapshot !== snapshot) return;
    watch.take(linked, { hurry: true });
    notifications.push(
      t("repository.linked", {
        name: linked.repository?.fullName ?? "",
        interpolation: { escapeValue: false },
      }),
    );
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
      status?.state === "paused" && status.reason === "diverged" ? status.diverged : undefined;
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

  /** People choose what to do with a folder that names a project of the platform, see `detached`. */
  async resolveDetached(): Promise<void> {
    const { dialogs, t, session } = this.#options;
    const snapshot = this.#snapshot;
    const key = session.key;
    if (snapshot.kind !== "detached" || !key) return;
    const answer = await dialogs.choose({
      title: t(`cloud.${snapshot.reason}Title`),
      message: t(`cloud.${snapshot.reason}Message`),
      choices: [
        { id: "disconnect", label: t("cloud.letGo") },
        { id: "new", label: t("cloud.makeNew"), kind: "primary" },
      ],
    });
    if (session.key !== key || this.#snapshot !== snapshot) return;
    if (answer === "new") await this.connect({ replace: true });
    else if (answer === "disconnect") await this.#forgetFile(key);
  }

  /** Takes the file that names a project of the platform out of the folder. */
  async #forgetFile(key: string): Promise<void> {
    const { notifications, t } = this.#options;
    const folder = this.#options.folderOf(key);
    if (!folder) return;
    try {
      await folder.remove(CLOUD_FILE);
      this.#set(NONE);
      notifications.push(t("cloud.letGoDone"));
    } catch (error) {
      console.warn("The folder could not let go of the platform", error);
      notifications.push(t("cloud.letGoFailed"));
    }
  }

  /**
   * Stops syncing the open project, and forgets that it was connected: here, and in its folder. The
   * project on the platform stays as it is.
   */
  async disconnect(): Promise<void> {
    const { session, dialogs, t } = this.#options;
    const key = session.key;
    const snapshot = this.#snapshot;
    if (!key || snapshot.kind !== "linked") return;
    const go = await dialogs.confirm({
      title: t("cloud.disconnectTitle"),
      message: t(
        snapshot.session.getSnapshot().pending > 0
          ? "cloud.disconnectPending"
          : "cloud.disconnectMessage",
      ),
      confirm: t("cloud.disconnect"),
      danger: true,
    });
    if (!go || this.#snapshot !== snapshot) return;
    await this.#unlink(key);
  }

  /**
   * People choose what to do with a project whose syncing stopped at something the platform does
   * not take, or that it does not have: everything stays here either way. A change of its own cannot
   * stay behind while the rest goes on, as what comes after it in Yjs builds on it.
   */
  async resolveStuck(): Promise<void> {
    const { dialogs, t, session } = this.#options;
    const key = session.key;
    const snapshot = this.#snapshot;
    if (!key || snapshot.kind !== "linked") return;
    const answer = await dialogs.choose({
      title: t("cloud.stuckTitle"),
      message: t("cloud.stuckMessage"),
      choices: [
        { id: "disconnect", label: t("cloud.letGo") },
        { id: "new", label: t("cloud.makeNew") },
        { id: "resync", label: t("cloud.resync"), kind: "primary" },
      ],
    });
    if (session.key !== key || this.#snapshot !== snapshot) return;
    if (answer === "resync") await snapshot.session.resyncFromHere();
    if (answer === "disconnect" || answer === "new") await this.#unlink(key);
    if (answer === "new" && this.getSnapshot().kind === "none")
      await this.connect({ replace: true });
  }

  /**
   * Stops syncing, and forgets the link: here, in the folder, and in the other windows. Resolves
   * to whether the link is gone. `quietly`: whoever asked says what came of it.
   */
  async #unlink(key: string, { quietly = false } = {}): Promise<boolean> {
    const { cloud, notifications, t } = this.#options;
    await this.#stop();
    try {
      await cloud.links.remove(key);
    } catch (error) {
      console.warn("The link to the platform could not be taken away", error);
      if (!quietly) notifications.push(t("cloud.disconnectFailed"));
      this.#key = undefined;
      this.#store = undefined;
      void this.follow();
      return false;
    }
    const folder = this.#options.isFolder(key) ? this.#options.folderOf(key) : undefined;
    await folder?.remove(CLOUD_FILE).catch((error: unknown) => {
      console.warn("The folder still says which project of the platform it was", error);
    });
    this.#set(NONE);
    this.#tell();
    if (!quietly) notifications.push(t("cloud.disconnected"));
    return true;
  }

  /** What this browser keeps about a project that went off the list. */
  async forget(key: string): Promise<void> {
    await this.#options.cloud.links.remove(key).catch((error: unknown) => {
      console.warn("The link of a project that is gone stays for now", error);
    });
  }

  /**
   * Asks which project of the platform to open, and opens it, see `openCloudProject`: for a
   * computer of a moment, or a browser that cannot write folders (the design, 7.5).
   */
  async openFromCloud(): Promise<void> {
    const { cloud, dialogs, notifications, t } = this.#options;
    if (!(await this.#signedIn(t("cloud.openTitle")))) return;
    let list;
    try {
      list = await cloud.list();
    } catch (error) {
      console.warn("The projects on the platform could not be listed", error);
      notifications.push(t("cloud.listFailed"));
      return;
    }
    if (list.length === 0) {
      notifications.push(t("cloud.nothingThere"));
      return;
    }
    const answer = await dialogs.form({
      title: t("cloud.openTitle"),
      notes: [t("cloud.openNote")],
      fields: [
        {
          id: "project",
          label: t("cloud.openField"),
          options: list.map((project) => ({ id: project.id, label: project.name })),
          value: list[0]?.id ?? "",
        },
      ],
      confirm: t("cloud.openConfirm"),
    });
    const chosen = list.find((project) => project.id === answer?.["project"]);
    if (chosen) await this.openCloudProject(chosen.id, chosen);
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
      const { folders, browsers } = await this.#copiesOf(project);
      here = folders[0] ?? browsers[0];
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
   * is on its way back from its repository is waited for; one that only its repository has now
   * takes an editor that knows how to ask for it.
   */
  async #whenLive(project: string, about: CloudProjectAbout): Promise<boolean> {
    const { cloud, dialogs, notifications, t } = this.#options;
    const copy = about.copy ?? "live";
    if (copy === "live") return true;
    if (copy !== "restoring") {
      notifications.push(t("cloud.open.notLive"));
      return false;
    }
    const environment = this.#options.environment ?? pageEnvironment();
    const progress = dialogs.progress({
      title: t("cloud.open.restoring"),
      cancel: t("dialog.cancel"),
      stopping: t("transfer.stopping"),
    });
    const until = environment.now() + RESTORE_WAIT_MS;
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
        const found = await cloud.list().then(
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
          notifications.push(t("cloud.open.notLive"));
          return false;
        }
        if (environment.now() >= until) {
          notifications.push(t("cloud.open.restoringLong"));
          return false;
        }
      }
    } finally {
      progress.close();
    }
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
  async #keep(project: string, downloaded: Downloaded): Promise<string | undefined> {
    const { cloud, projects, account, notifications, t } = this.#options;
    const { store } = ProjectStore.fromUpdates([downloaded.state]);
    if (!store) {
      notifications.push(t("cloud.downloadFailed"));
      return undefined;
    }
    const { name } = store.getState().manifest;
    store.destroy();
    try {
      // By its id on the platform, which is its own: the id in the project is not.
      let key = project;
      let incoming = await projects.receive({ id: key, name });
      if (!incoming) {
        // Another window may have brought it in meanwhile: that copy is the one.
        const { folders, browsers } = await this.#copiesOf(project);
        const there = folders[0] ?? browsers[0];
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
   * Opens a project of the platform and moves it into a folder that people choose: from then on
   * it is a project in a folder that syncs. Its documents and code go there, and the files of its
   * assets that this browser has; downloading the others comes later. A project that a folder of
   * this computer is connected to already opens as that folder. Resolves to whether it is in a
   * folder now.
   */
  async downloadToFolder(project: string, about: CloudProjectAbout = {}): Promise<boolean> {
    const { session, dialogs, notifications, moveToFolder, t } = this.#options;
    if (!moveToFolder) return false;
    let folder: CloudLink | undefined;
    try {
      folder = (await this.#copiesOf(project)).folders[0];
    } catch (error) {
      console.warn("What this browser has of a project of the platform could not be read", error);
      notifications.push(t("cloud.open.failed"));
      return false;
    }
    if (folder) {
      notifications.push(t("cloud.download.already"));
      return this.#open(folder.key);
    }
    if (!(await this.openCloudProject(project, about))) return false;
    const key = session.key;
    const store = session.store;
    if (key === undefined || !store) return false;
    // The browser only lets the editor ask for a folder right after people did something, and
    // the project may have taken a while to come.
    const isActive =
      this.#options.isActive ??
      (() => typeof navigator === "undefined" || navigator.userActivation?.isActive !== false);
    if (!isActive()) {
      const words = { name: store.getState().manifest.name, interpolation: { escapeValue: false } };
      const go = await dialogs.confirm({
        title: t("cloud.download.chooseTitle", words),
        message: t("cloud.download.chooseMessage"),
        confirm: t("cloud.download.choose"),
        cancel: t("cloud.download.later"),
      });
      if (!go || session.key !== key) return false;
    }
    return moveToFolder(key);
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
   * What this browser has of a project that the platform may not have, by reading its log and
   * looking at its files: what taking the copy out of this browser would lose.
   */
  async #onlyHere(key: string, link: CloudLink): Promise<OnlyHere> {
    const { projects } = this.#options;
    const log = await projects.open(key);
    let entries: readonly LogEntry[] | undefined;
    let updates: readonly Uint8Array[];
    try {
      entries = await log.entries?.();
      updates = entries ? entries.map((entry) => entry.update) : await log.load();
    } finally {
      log.close();
    }
    // A project whose first version may not have got there is not on the platform at all.
    const changes = link.creating
      ? "all"
      : entries
        ? entries.filter((entry) => entry.mark > link.pushed && !isOnPlatform(entry)).length
        : "unknown";
    const { store } = ProjectStore.fromUpdates(updates);
    // Without the project nothing says which files it needs.
    if (!store) return { changes: changes === 0 ? "unknown" : changes, files: [] };
    try {
      const state = store.getState();
      const kept = await projects.copies(key);
      const files = Object.entries(state.assets ?? {}).flatMap(([id, asset]) => {
        const { hash } = asset;
        // What can be downloaded from where it is kept comes again with the project.
        if (hash === undefined || elsewhereOf(state, id) !== undefined) return [];
        return kept.some((copy) => isSameHash(hash, copy.name)) ? [asset.path] : [];
      });
      return { changes, files: [...new Set(files)].toSorted() };
    } finally {
      store.destroy();
    }
  }

  /**
   * Takes the copy of a project of the platform out of this browser: its log, the files of its
   * assets that this browser keeps, and its link. The project on the platform stays as it is, and
   * can be opened again. What did not get there is nowhere else, so the log is read first, and
   * where it has changes the platform does not have, or files that can be downloaded from
   * nowhere, people choose: open the project so that it syncs, take it away all the same, or
   * leave it. Resolves to whether it is gone.
   */
  async removeFromBrowser(key: string): Promise<boolean> {
    const { cloud, session, dialogs, notifications, projects, records, t } = this.#options;
    let link: CloudLink | undefined;
    let isFolder: boolean;
    try {
      link = await this.linkOf(key);
      isFolder = (await records?.get(key)) !== undefined;
    } catch (error) {
      console.warn("What this browser keeps of the project could not be read", error);
      notifications.push(t("cloud.remove.failed"));
      return false;
    }
    // A folder is the project itself: it goes off the list of folders, never like this.
    if (!link || isFolder) return false;
    const summary = (await projects.list().catch(() => [])).find((each) => each.id === key);
    const name = summary?.name ?? link.name ?? "";
    const words = { name, interpolation: { escapeValue: false } };
    /** A window that has it open would go on writing a log that is gone. Resolves to whether one has. */
    const isOpenElsewhere = async (): Promise<boolean> => {
      if (((await this.#options.others?.(key).catch(() => 0)) ?? 0) === 0) return false;
      await dialogs.confirm({
        title: t("cloud.remove.title", words),
        message: t("cloud.remove.openElsewhere"),
        confirm: t("dialog.close"),
        noticeOnly: true,
      });
      return true;
    };
    if (await isOpenElsewhere()) return false;
    const isOpen = () => session.key === key;
    const wasOpen = isOpen();
    if (wasOpen && !this.#options.closeProject) return false;
    /** Asks where something is only here. Resolves to whether it may go all the same. */
    const mayGo = async (found: OnlyHere | undefined): Promise<boolean> => {
      if (found && found.changes === 0 && found.files.length === 0) return true;
      const answer = await dialogs.choose({
        title: t("cloud.remove.unsyncedTitle", words),
        message: this.#onlyHereText(found),
        choices: [
          { id: "open", label: t(isOpen() ? "cloud.remove.wait" : "cloud.remove.open") },
          { id: "remove", label: t("cloud.remove.anyway"), kind: "danger" },
        ],
      });
      if (answer === "open" && !isOpen()) await this.#options.openProject(key);
      return answer === "remove";
    };
    /** Reads what is only here. Undefined: it could not be read, which is as much as "maybe". */
    const look = async (): Promise<OnlyHere | undefined> => {
      try {
        if (isOpen()) {
          // What this window still has to write is part of it, and what the platform took of it
          // just now is not.
          if (!(await session.trySave())) return undefined;
          await this.session?.flush();
        }
        const now = await cloud.links.get(key);
        return now ? await this.#onlyHere(key, now) : undefined;
      } catch (error) {
        console.warn("Whether the platform has all of the project could not be read", error);
        return undefined;
      }
    };
    const found = await look();
    const isAllThere = found !== undefined && found.changes === 0 && found.files.length === 0;
    if (isAllThere) {
      const go = await dialogs.confirm({
        title: t("cloud.remove.title", words),
        message: t("cloud.remove.message"),
        confirm: t("cloud.remove.confirm"),
      });
      if (!go) return false;
    } else if (!(await mayGo(found))) return false;
    if (wasOpen) {
      if (isOpen() && !(await this.#options.closeProject?.())) return false;
      if (isOpen()) return false;
      // Leaving it can have saved what was being tried, or typed: that counts too.
      if (isAllThere) {
        const after = await look();
        const stillAll = after !== undefined && after.changes === 0 && after.files.length === 0;
        if (!stillAll && !(await mayGo(after))) return false;
      }
    }
    // People took their time to answer: a window may have opened it meanwhile.
    if (await isOpenElsewhere()) return false;
    try {
      await (this.#options.removeLocal ?? ((id: string) => projects.remove(id)))(key);
    } catch (error) {
      console.warn("The copy of the project could not be taken out of this browser", error);
      notifications.push(t("cloud.remove.failed"));
      return false;
    }
    await this.forget(key);
    notifications.push(t("cloud.remove.done", words));
    return true;
  }

  /** What is only here, in words, see `removeFromBrowser`. */
  #onlyHereText(found: OnlyHere | undefined): string {
    const { t } = this.#options;
    const said: string[] = [];
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
    said.push(t("cloud.remove.lost"));
    // A folder keeps the files too, where this browser can write one.
    if (found && found.files.length > 0 && this.#options.moveToFolder)
      said.push(t("cloud.remove.keepFiles"));
    return said.join("");
  }

  /**
   * Takes a project of the platform that has no repository away there, for good, once people said
   * so: what this computer has of it stays, as a project of this computer only. Resolves to whether
   * it is gone.
   */
  async deleteFromCloud(project: string, name: string): Promise<boolean> {
    const { cloud, session, dialogs, notifications, records, t } = this.#options;
    if (!cloud.remove) return false;
    const words = { name, interpolation: { escapeValue: false } };
    if (!(await this.#signedIn(t("cloud.delete.title", words)))) return false;
    const go = await dialogs.confirm({
      title: t("cloud.delete.title", words),
      message: t("cloud.delete.message"),
      confirm: t("cloud.delete.confirm"),
      danger: true,
    });
    if (!go) return false;
    // Nothing of it may come back: the window that syncs it here stops first.
    const open = this.#snapshot.kind === "linked" ? this.#snapshot.link : undefined;
    const isOpen = open?.project === project && session.key === open.key;
    if (isOpen) await this.#stop();
    const outcome = await this.#takeAway(project);
    if (outcome !== "removed" && outcome !== "missing") {
      if (isOpen) {
        this.#key = undefined;
        this.#store = undefined;
        void this.follow();
      }
      notifications.push(
        t(outcome === "hasRepository" ? "cloud.delete.hasRepository" : "cloud.delete.failed"),
      );
      return false;
    }
    // What this computer has of it is of this computer only from now on.
    const links = await cloud.links.withProject(cloud.platform, project).catch(() => []);
    for (const link of links) {
      if (isOpen && link.key === open?.key) {
        await this.#unlink(link.key, { quietly: true });
        continue;
      }
      await this.forget(link.key);
      this.#tellAbout(link.key);
      const record = await records?.get(link.key).catch(() => undefined);
      // Its folder says so too, where it can be written without asking.
      if (record && (await record.folder.status().catch(() => "gone")) === "ready") {
        await record.folder.remove(CLOUD_FILE).catch(() => {});
      }
    }
    notifications.push(t("cloud.delete.done", words));
    return true;
  }
}
