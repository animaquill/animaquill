import { ProjectStore } from "@animaquill/core";
import {
  FolderError,
  SYNC_CLOSE,
  newSyncId,
  type AccountAccess,
  type CloudAccess,
  type CloudLine,
  type CloudLink,
  type LocalFolder,
  type ProjectLibrary,
} from "@animaquill/host";
import type { TFunction } from "i18next";
import type { Dialogs } from "../workbench/dialogs.ts";
import { Emitter } from "../workbench/emitter.ts";
import type { Notifications } from "../workbench/notifications.ts";
import type { ProjectSession } from "../workbench/session.ts";
import { DownloadFailed, download } from "./download.ts";
import {
  CloudSession,
  type CloudEnvironment,
  type CloudSnapshot,
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
  | { readonly kind: "linked"; readonly session: CloudSession; readonly link: CloudLink }
  /**
   * The folder says it is a project of the platform that this browser does not sync from it: a
   * copy of a folder that this browser syncs ("copy"), or a folder from somewhere else ("foreign").
   */
  | { readonly kind: "detached"; readonly project: string; readonly reason: "copy" | "foreign" };

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
  readonly timing?: Partial<CloudTiming>;
  readonly environment?: CloudEnvironment;
}

const NONE: CloudProjectsSnapshot = { kind: "none" };

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

  constructor(options: CloudProjectsOptions) {
    this.#options = options;
    options.account?.subscribe(() => {
      const session = this.session;
      if (options.account?.getSnapshot().status !== "signedIn" || !session) return;
      if (session.getSnapshot().problem?.kind === "signed-out") session.resume();
    });
  }

  subscribe = this.#emitter.subscribe;
  getSnapshot = (): CloudProjectsSnapshot => this.#snapshot;

  /** The platform. */
  get platform(): string {
    return this.#options.cloud.platform;
  }

  /** The sync of the open project, where it has one. */
  get session(): CloudSession | undefined {
    return this.#snapshot.kind === "linked" ? this.#snapshot.session : undefined;
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

  /** A folder project whose folder was not there at the last look. */
  #waitsForFolder(): boolean {
    const key = this.#key;
    return (
      key !== undefined &&
      this.#snapshot.kind === "none" &&
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
    if (this.#snapshot.kind === "linked") return;
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
      if (link.creating) void this.#tellWhenConnected(link, { quietly: true });
      return;
    }
    if (file && file.platform === cloud.platform) {
      const others = await cloud.links.withProject(cloud.platform, file.project);
      const reason = others.some((other) => other.key !== key) ? "copy" : "foreign";
      this.#set({ kind: "detached", project: file.project, reason });
      if (!this.#asked.has(key)) {
        this.#asked.add(key);
        void this.resolveDetached();
      }
      return;
    }
    this.#set(NONE);
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
    this.#stopSession = sync.subscribe(() => {
      this.#emitter.emit();
      // Another window disconnected it: this one looks again, and finds no link.
      if (sync.getSnapshot().problem?.kind === "unlinked") void this.#unlinked(sync);
    });
    this.#set({ kind: "linked", session: sync, link });
    sync.start();
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
   * becomes a new one too, with `replace`.
   */
  async connect({ replace = false } = {}): Promise<void> {
    const { session, cloud, dialogs, notifications, t } = this.#options;
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
    // What is in the log is what goes: all of it, and nothing that is still on its way there.
    if (!(await session.trySave())) {
      notifications.push(t("cloud.notSaved"));
      return;
    }
    await session.readLog();
    const entries = await session.journal.entries();
    if (!entries) {
      notifications.push(t("cloud.unsupported"));
      return;
    }
    const folder = this.#options.isFolder(key) ? this.#options.folderOf(key) : undefined;
    if (this.#options.isFolder(key) && !folder) {
      notifications.push(t("cloud.folderNotReady"));
      return;
    }
    const link: CloudLink = {
      key,
      platform: cloud.platform,
      project: newSyncId(),
      seq: 0,
      pushed: entries.at(-1)?.mark ?? 0,
      linkedAt: Date.now(),
      creating: true,
    };
    try {
      await cloud.links.put(link);
    } catch (error) {
      console.warn("The link to the platform could not be kept", error);
      notifications.push(t("cloud.connectFailed"));
      return;
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
    void this.#tellWhenConnected(link);
  }

  /** Says once whether the first connection got there, and keeps the link from then on. */
  async #tellWhenConnected(link: CloudLink, { quietly = false } = {}): Promise<void> {
    const { cloud, notifications, t } = this.#options;
    const session = this.session;
    if (!session) return;
    const outcome = await new Promise<CloudSnapshot>((resolve) => {
      const check = () => {
        const snapshot = session.getSnapshot();
        if (
          snapshot.state === "online" ||
          snapshot.state === "paused" ||
          snapshot.state === "closed"
        )
          resolve(snapshot);
      };
      const stop = session.subscribe(check);
      check();
      void Promise.resolve().then(() => {
        if (session.getSnapshot().state === "closed") stop();
      });
    });
    if (outcome.state === "online") {
      // Only that: how far it got is the session's to note down, at the same time.
      await cloud.links.update(link.key, link.project, { made: true }).catch(() => false);
      if (!quietly) notifications.push(t("cloud.connected"));
    }
  }

  /** People choose what to do with a folder that names a project of the platform, see `detached`. */
  async resolveDetached(): Promise<void> {
    const { dialogs, t, session } = this.#options;
    const snapshot = this.#snapshot;
    const key = session.key;
    if (snapshot.kind !== "detached" || !key) return;
    const answer = await dialogs.choose({
      title: t(snapshot.reason === "copy" ? "cloud.copyTitle" : "cloud.foreignTitle"),
      message: t(snapshot.reason === "copy" ? "cloud.copyMessage" : "cloud.foreignMessage"),
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

  /** Stops syncing, and forgets the link: here, in the folder, and in the other windows. */
  async #unlink(key: string): Promise<void> {
    const { cloud, notifications, t } = this.#options;
    await this.#stop();
    try {
      await cloud.links.remove(key);
    } catch (error) {
      console.warn("The link to the platform could not be taken away", error);
      notifications.push(t("cloud.disconnectFailed"));
      void this.follow();
      return;
    }
    const folder = this.#options.isFolder(key) ? this.#options.folderOf(key) : undefined;
    await folder?.remove(CLOUD_FILE).catch((error: unknown) => {
      console.warn("The folder still says which project of the platform it was", error);
    });
    this.#set(NONE);
    this.#tell();
    notifications.push(t("cloud.disconnected"));
  }

  /** What this browser keeps about a project that went off the list. */
  async forget(key: string): Promise<void> {
    await this.#options.cloud.links.remove(key).catch((error: unknown) => {
      console.warn("The link of a project that is gone stays for now", error);
    });
  }

  /**
   * Opens a project of the platform in this browser, as a project of the browser that syncs, see
   * the design, 7.5: for a computer of a moment, or a browser that cannot write folders.
   */
  async openFromCloud(): Promise<void> {
    const { cloud, dialogs, notifications, t, projects } = this.#options;
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
    const chosen = answer?.["project"];
    if (!chosen) return;
    const progress = dialogs.progress({
      title: t("cloud.downloading"),
      cancel: t("dialog.cancel"),
      stopping: t("transfer.stopping"),
    });
    let downloaded;
    try {
      downloaded = await download(cloud, chosen, {
        window: this.#options.window,
        editor: this.#options.editor,
        signal: progress.signal,
      });
    } catch (error) {
      if (progress.signal.aborted) return;
      console.warn("The project could not come from the platform", error);
      notifications.push(
        t(
          error instanceof DownloadFailed && error.code === SYNC_CLOSE.outdated
            ? "cloud.problem.outdated"
            : "cloud.downloadFailed",
        ),
      );
      return;
    } finally {
      progress.close();
    }
    if (progress.signal.aborted) return;
    const { store } = ProjectStore.fromUpdates([downloaded.state]);
    if (!store) {
      notifications.push(t("cloud.downloadFailed"));
      return;
    }
    const { id, name } = store.getState().manifest;
    store.destroy();
    const here = (await projects.list().catch(() => [])).find((project) => project.id === id);
    if (here) {
      const link = await cloud.links.get(id).catch(() => undefined);
      if (link?.project === chosen) await this.#options.openProject(id);
      else notifications.push(t("cloud.alreadyHere", { name: here.name }));
      return;
    }
    try {
      await projects.create({ id, name }, downloaded.state);
      const log = await projects.open(id);
      const mark = (await log.entries?.())?.at(-1)?.mark ?? 0;
      log.close();
      await cloud.links.put({
        key: id,
        platform: cloud.platform,
        project: chosen,
        seq: downloaded.head,
        pushed: mark,
        linkedAt: Date.now(),
      });
    } catch (error) {
      console.warn("The project from the platform could not be kept here", error);
      notifications.push(t("cloud.downloadFailed"));
      return;
    }
    await this.#options.openProject(id);
  }
}
