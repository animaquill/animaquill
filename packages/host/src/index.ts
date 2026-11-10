import type { AiRelay } from "./relay.ts";
import type { CloudConnection } from "./sync-protocol.ts";

export { KEYS_DATABASE, MAX_CHATS_PER_PROJECT, memoryChats, memoryKeys } from "./ai.ts";
export { RELAY_REFUSALS, relayRefusalIn, type AiRelay, type RelayRefusal } from "./relay.ts";
export { MemoryCloudLinks } from "./cloud.ts";
export {
  SYNC_CLOSE,
  SYNC_KINDS,
  SYNC_LIMITS,
  SYNC_MESSAGE_BYTES,
  SYNC_PROTOCOL,
  Reassembler,
  encodeSyncMessage,
  framesOf,
  newSyncId,
  packChecked,
  readSyncClientMessage,
  readSyncServerMessage,
  unpackChecked,
  type SyncClientMessage,
  type SyncKind,
  type SyncRejection,
  type SyncServerMessage,
} from "./sync-protocol.ts";
export { chromeRefuses, isRefusedByChrome } from "./chrome-names.ts";
export {
  MAX_NAME_LENGTH,
  MAX_PATH_LENGTH,
  isSafeName,
  isSafePath,
  newNameFor,
  sameNameKey,
} from "./paths.ts";

/** What the editor needs from the place it runs in: a browser, the desktop app or the platform. */
export interface Host {
  readonly settings: SettingsStore;
  readonly projects: ProjectLibrary;
  readonly address: ProjectAddress;
  readonly windowMemory: WindowMemory;
  /** Where reports go. Without it people get the report as a file and pass it on themselves. */
  readonly diagnostics?: DiagnosticsSink;
  /** The way to folders outside of the host, which is how projects get in and out. */
  readonly folders: FolderAccess;
  /**
   * Folders on this computer that the editor reads and writes as people work, such as the folder of
   * a project. Missing where the browser does not let a page write to folders.
   */
  readonly localFolders?: LocalFolders;
  /** Where what people are trying out waits until they save it or give up on it. */
  readonly trials: TrialStore;
  /** Where code that people typed and did not save waits, so that a crash does not take it. */
  readonly drafts: DraftStore;
  /** Where an export keeps what it has done, so that a reload or a crash costs only a little. */
  readonly exports: ExportStore;
  /** What the editor worked out and can work out again, kept to save time. Optional: see `WorkCache`. */
  readonly caches?: WorkCache;
  /** Which windows have which projects open. Without it every window is on its own. */
  readonly presence?: ProjectPresence;
  /**
   * Keys of AI services that people set up, on this device only: not in projects, not synced, and
   * never in a report. Without it keys last as long as the page.
   */
  readonly keys?: KeyStore;
  /** Conversations with AI in the browser, by project. Without it they last as long as the page. */
  readonly chats?: ChatStore;
  /**
   * The relay of AI services of the platform the editor is hosted on, for services that do not let a
   * page read their answers: see `AiRelay`. Without it, as on this computer, services can only be
   * reached straight.
   */
  readonly aiRelay?: AiRelay;
  /**
   * The account people have where the editor is hosted, such as a platform that keeps projects on
   * GitHub. Without it, as on the development page and in the desktop app, there is nothing to sign
   * in to. Either way everything on this computer works the same, signed in or not.
   */
  readonly account?: AccountAccess;
  /**
   * The platform that projects can be connected to, where the editor is hosted on one: changes go
   * there as they happen, and come from there. Only with `account`, which is how people get to it.
   * Without it projects stay on this computer, which is everything they need.
   */
  readonly cloud?: CloudAccess;
}

/** A project on the platform, as people find it in a list. */
export interface CloudProjectSummary {
  /** Its id on the platform. */
  readonly id: string;
  readonly name: string;
  /** Milliseconds since 1970. */
  readonly updatedAt: number;
}

/**
 * Where projects sync to: a platform, as the host reaches it. The editor runs the protocol over the
 * connections, see `SyncClientMessage`, and keeps its records here.
 */
export interface CloudAccess {
  /** The platform, as an address such as https://platform.example: what .animaquill/cloud.json names. */
  readonly platform: string;
  /** A new connection for syncing a project. */
  connect(): CloudConnection;
  /**
   * The projects on the platform of whoever is signed in, most recently changed first. Rejects when
   * the platform cannot say, with a `CloudSignedOut` when nobody is signed in.
   */
  list(): Promise<readonly CloudProjectSummary[]>;
  /** Which projects of this browser are connected, and how far they got. */
  readonly links: CloudLinks;
  /**
   * Which window of this browser syncs a project, by the key the browser keeps it by, see
   * `CloudLink.key`: one at a time, as only one window writes a folder.
   */
  syncer(key: string): FolderWriter;
  /** How the windows of this browser tell each other about the sync of a project. */
  line(key: string): CloudLine | undefined;
  /**
   * Saving projects of the platform to a Git repository of the person, where the platform does that:
   * it archives what it has of a project into the repository by itself. Without it, there is none.
   */
  readonly repository?: RepositoryAccess;
}

/** Nobody is signed in to the platform. */
export class CloudSignedOut extends Error {
  override readonly name = "CloudSignedOut";
}

/** A repository people can choose to save a project to, as the platform lists them. */
export interface RepositoryChoice {
  /** Its number on the Git platform, which stays as it is renamed. */
  readonly id: number;
  readonly owner: string;
  readonly name: string;
  readonly fullName: string;
  readonly private: boolean;
  /** Whether the person may write to it. */
  readonly pushable: boolean;
  /** As far as the Git platform tells: an empty one can look not empty, never the other way. */
  readonly empty: boolean;
  readonly archived: boolean;
  /** Another project of the platform is saved there. */
  readonly linked: boolean;
}

export interface RepositoryList {
  readonly repositories: readonly RepositoryChoice[];
  readonly page: number;
  /** There is another page. */
  readonly more: boolean;
  /** Where people choose which repositories the platform may touch. */
  readonly manageUrl: string;
}

/** A new private repository, or one people have: a public one only with `confirmPublic`. */
export type RepositoryLink =
  | { readonly create: { readonly name: string } }
  | { readonly existing: { readonly id: number }; readonly confirmPublic?: boolean };

/** Why archiving stopped until people do something about it. */
export type RepositoryPause =
  /** Files of the project were changed in the repository, see `RepositoryStatus.diverged`. */
  | "diverged"
  /** The repository is gone, or the platform may not touch it any more. */
  | "gone"
  | "uninstalled"
  | "suspended"
  /** The repository is archived, and so read-only. */
  | "archived"
  /** The platform may not move the branch, as a protected branch: `detail` says what it said. */
  | "protected"
  /** The repository is on another account now than the one it was linked on. */
  | "transferred"
  /** animaquill.json is not what the format says. */
  | "manifest"
  /** What would be saved does not read as a project. */
  | "invalid";

/** The repository of a project, and how archiving into it goes. Times are milliseconds since 1970. */
export interface RepositoryStatus {
  readonly repository?: {
    readonly id: number;
    readonly owner: string;
    readonly name: string;
    readonly fullName: string;
    readonly private: boolean;
    readonly branch: string;
    /** Where people see it. */
    readonly url: string;
    readonly createdHere: boolean;
    readonly linkedAt: number;
  };
  /** "none": no repository; "ready": archiving goes as it should; "paused": see `reason`. */
  readonly state: "none" | "ready" | "paused";
  readonly reason?: RepositoryPause | (string & {});
  /** A short word about the pause, or about the last failure, from the platform. */
  readonly detail?: string;
  /** An archive is waiting or running. */
  readonly archiving: boolean;
  readonly lastArchive?: {
    readonly sha: string;
    readonly seq: number;
    readonly at: number;
    /** "first", "auto" or "manual". */
    readonly kind: string;
    readonly changed: number;
    readonly removed: number;
    readonly url: string;
  };
  /** Documents the last archive could not write: the repository has an older version of them. */
  readonly kept?: readonly string[];
  /** Since when changes wait to be archived, and when they are due. */
  readonly dirtySince?: number;
  readonly nextAt?: number;
  /** After failing: when it is tried again, and how many failed in a row. */
  readonly retryAt?: number;
  readonly failures?: number;
  /**
   * For "diverged": which files changed, on which commit: what `archiveNow` with `replace` goes on
   * top of. `deleted`: those of them the commit does not have any more, as against changed or new.
   */
  readonly diverged?: {
    readonly sha: string;
    readonly files: readonly string[];
    readonly deleted: readonly string[];
  };
  /** The update of the project the platform has, and the one the repository has. */
  readonly head: number;
  readonly archivedSeq: number;
}

/**
 * Saving the projects of a platform to Git repositories (on AnimaQuill Cloud, GitHub): the platform
 * archives what it has of a project, when people stop for a while and now and then while they go on,
 * see `RepositoryStatus`. Projects are named by their id on the platform, `CloudLink.project`. What
 * the platform refuses rejects with `RepositoryRefused`; nobody signed in with `CloudSignedOut`.
 */
export interface RepositoryAccess {
  /** A page of the repositories people can choose, from 1. */
  list(page?: number): Promise<RepositoryList>;
  /** Saves a project to a repository from now on: the first archive follows at once. */
  link(project: string, choice: RepositoryLink): Promise<RepositoryStatus>;
  status(project: string): Promise<RepositoryStatus>;
  /**
   * Archives now. Also goes on after a pause; for "diverged" only with `replace`, the commit people
   * saw the changed files on, which the archive then writes over (never forced: it goes on top).
   */
  archiveNow(project: string, options?: { readonly replace?: string }): Promise<RepositoryStatus>;
}

/** What the platform says when it refuses something about repositories. */
export type RepositoryRefusal =
  | "notInstalled"
  | "nameTaken"
  | "hasProject"
  | "linkedElsewhere"
  | "notPushable"
  | "public"
  | "notFound"
  | "invalidName"
  | "alreadyLinked"
  | "notLinked"
  | "diverged"
  | "busy"
  | "invalid"
  | "unavailable";

/**
 * The platform did not do what was asked: always one of the codes of `RepositoryRefusal`, also where
 * no answer came ("unavailable") or the answer was not one of them.
 */
export class RepositoryRefused extends Error {
  override readonly name = "RepositoryRefused";
  readonly code: RepositoryRefusal;
  /** For "hasProject": what of a project is there. */
  readonly files: readonly string[] | undefined;
  /** For "diverged": what changed, see `RepositoryStatus.diverged`. */
  readonly diverged: RepositoryStatus["diverged"];
  /** For "busy": seconds to wait. */
  readonly retryAfter: number | undefined;
  constructor(
    code: RepositoryRefusal,
    more: {
      readonly files?: readonly string[];
      readonly diverged?: RepositoryStatus["diverged"];
      readonly retryAfter?: number;
    } = {},
  ) {
    super(`The platform refused: ${code}`);
    this.code = code;
    this.files = more.files;
    this.diverged = more.diverged;
    this.retryAfter = more.retryAfter;
  }
}

export type { CloudClose, CloudConnection } from "./sync-protocol.ts";

/** What windows of this browser say to each other, as structured clones. */
export interface CloudLine {
  post(message: unknown): void;
  listen(listener: (message: unknown) => void): () => void;
  close(): void;
}

/** How a link moves forward, see `CloudLinks.update`. */
export interface CloudLinkChange {
  readonly seq?: number;
  readonly digest?: string;
  readonly pushed?: number;
  readonly syncedAt?: number;
  /** The project is on the platform now: it is not `creating` any more. */
  readonly made?: true;
}

/** That a project of this browser is connected to a project of the platform. */
export interface CloudLink {
  /** What this browser keeps the project by: its id, or the number of its folder, see `FolderRecord.id`. */
  readonly key: string;
  /** The platform, see `CloudAccess.platform`. */
  readonly platform: string;
  /** The id of the project on the platform. */
  readonly project: string;
  /** Every update of the platform up to this number is in the log of the project here. */
  readonly seq: number;
  /**
   * What the platform said stands for its updates up to `seq`, see "welcome" of the protocol: where
   * the platform has another one for that number, it came back from a backup.
   */
  readonly digest?: string;
  /** Every change in the log up to this mark is on the platform, see `LogEntry.mark`. */
  readonly pushed: number;
  /** Milliseconds since 1970. */
  readonly linkedAt: number;
  /** When the project was last in step with the platform, in milliseconds since 1970. */
  readonly syncedAt?: number;
  /**
   * The project is not on the platform yet, as far as this browser knows: the first connection makes
   * it there, with what the project is then, see `SyncClientMessage` "hello".
   */
  readonly creating?: true;
}

export interface CloudLinks {
  get(key: string): Promise<CloudLink | undefined>;
  /** Keeps a link, in place of the one with the same key. */
  put(link: CloudLink): Promise<void>;
  /**
   * Moves a link to `project` forward, never back, as two windows can both have been the one that
   * syncs: `seq` with its `digest`, `pushed`, `syncedAt`, and `made` once the project is on the
   * platform, see `creating`. Resolves to false, and changes nothing, when there is no such link:
   * one that another window took away, or made for another project, stays as it is.
   */
  update(key: string, project: string, change: CloudLinkChange): Promise<boolean>;
  /**
   * Puts a link to `project` back to where the platform is after it came back from a backup: `seq`
   * and `digest` as they are now, and `pushed` back to the start, so that everything goes again.
   * Resolves to false when there is no such link.
   */
  reset(
    key: string,
    project: string,
    to: { readonly seq: number; readonly digest: string; readonly pushed: number },
  ): Promise<boolean>;
  remove(key: string): Promise<void>;
  /** The links to a project of a platform: more than one means a copy of a folder, see the design, 7.5. */
  withProject(platform: string, project: string): Promise<readonly CloudLink[]>;
  /** What this browser is called on the platform: a number of its own, the same every time. */
  device(): Promise<string>;
}
/** How the last sign-in ended, when this page is where it came back to. */
export type SignInOutcome =
  | "signedIn"
  /** People said no where they were asked. */
  | "cancelled"
  | "failed"
  /** It took too long, or was done already. */
  | "expired"
  /** Too many tries for now. */
  | "busy"
  /** Signing in cannot work here right now. */
  | "unavailable"
  /** The account cannot sign in: whoever runs the platform disabled it. */
  | "disabled";

export type AccountSnapshot =
  /** Not known yet, or the host could not find out. */
  | { readonly status: "unknown" }
  | { readonly status: "signedOut" }
  | {
      readonly status: "signedIn";
      /** What people know the account by, such as the login on GitHub. */
      readonly name: string;
      /** An https address of the account's picture. */
      readonly picture?: string;
      /** Whether the GitHub App is installed on the account, which saving projects to GitHub needs. */
      readonly appInstalled: boolean;
    };

/**
 * Signing in and out, where the host has accounts. The host knows how; the editor only shows where
 * things are and asks for them. Signing in and installing the App leave the page and come back to
 * it, to the same project: the editor keeps everything first, see `Workbench.leavePage`.
 */
export interface AccountAccess {
  subscribe(listener: () => void): () => void;
  getSnapshot(): AccountSnapshot;
  /** Asks again, such as when people come back to the window. Never rejects. */
  refresh(): Promise<void>;
  /** How the sign-in that brought this page here ended, once, and then undefined. */
  takeOutcome(): SignInOutcome | undefined;
  /** Leaves the page to sign in, and comes back to this page as it is now. */
  signIn(): void;
  /** Leaves the page to install the GitHub App on the account, and comes back. */
  installApp(): void;
  /** Rejects when the host could not be reached: people are then still signed in. */
  signOut(): Promise<void>;
}

/**
 * Which windows of this browser have which projects open, and what they have to hear of another
 * window: a project that moved into a folder in one window is a folder in all of them.
 */
export interface ProjectPresence {
  /** This window has a project open, by what the browser keeps it by, until this returns. */
  enter(project: string): () => void;
  /** How many other windows have the project open now, as far as the browser can tell. */
  others(project: string): Promise<number>;
  /** Tells the other windows that a project is a folder now, see `onMoved`. */
  moved(project: string): void;
  /** What another window says about a project that moved into a folder. Returns how to stop. */
  onMoved(listener: (project: string) => void): () => void;
}

/** An export that stopped before it was finished, and can go on from where it got. */
export interface SavedExport {
  readonly id: string;
  readonly project: string;
  /** Milliseconds since 1970. */
  readonly savedAt: number;
  /** Where the finished file goes, as `GrowingFile.target` had it. */
  readonly target: unknown;
  /** What the editor needs to go on. The host keeps it as it is. */
  readonly state: unknown;
}

/** Encoded media of an export, a piece at a time, as the editor wrote it. */
export interface ExportPiece {
  /** From 0, in the order they were written. */
  readonly seq: number;
  readonly data: Blob;
  /** What is in it, which only the editor reads. */
  readonly index: unknown;
}

/**
 * What an export has done. It is kept on this device only, and goes away when the export is
 * finished or given up. The pieces are on the disk as soon as `addPiece` resolves, so that whatever
 * happens to the page then, they are there for the next one.
 */
export interface ExportStore {
  list(project: string): Promise<readonly SavedExport[]>;
  /** Of all projects, for people to see what takes room. */
  all(): Promise<readonly SavedExport[]>;
  save(saved: SavedExport): Promise<void>;
  /**
   * Rejects with a "NotFoundError" when the export is not there, or not any more: its pieces would
   * stay forever.
   */
  addPiece(id: string, track: string, piece: ExportPiece): Promise<void>;
  /** The pieces of a track in order, a few at a time, so that they never all are in memory. */
  pieces(id: string, track: string): AsyncIterable<ExportPiece>;
  /** Takes away the pieces of a track from this one on. */
  dropPieces(id: string, track: string, from: number): Promise<void>;
  /** The export and all its pieces. */
  remove(id: string): Promise<void>;
  /**
   * Makes sure that no other window works on an export at the same time. Resolves to how to let go,
   * or to undefined when another window has it. A window that goes away lets go by itself.
   */
  claim(id: string): Promise<(() => void) | undefined>;
}

/**
 * What the editor worked out and can work out again, such as what the code of a scene registered,
 * kept on this device so that the next time does not have to wait for it. Losing any of it does no
 * harm, so nothing here fails: what cannot be read is not there, and what cannot be kept is not
 * kept. The host decides how much it keeps, and what goes first. Values must survive JSON.
 */
export interface WorkCache {
  /** Resolves to undefined when nothing is kept under this key. */
  read(key: string): Promise<unknown>;
  write(key: string, value: unknown): Promise<void>;
}

/**
 * Keys of AI services, by the service people set up. They stay apart from everything else, so that
 * nothing that reads settings, projects or reports can come across them.
 */
export interface KeyStore {
  /** Where they are, to tell people: the name of the database in the browser. */
  readonly where: string | undefined;
  read(service: string): Promise<string | undefined>;
  /** The services that have a key. */
  list(): Promise<readonly string[]>;
  write(service: string, key: string): Promise<void>;
  remove(service: string): Promise<void>;
  clear(): Promise<void>;
}

export interface SavedChatSummary {
  readonly id: string;
  readonly project: string;
  /** What it is about, for people to find it again. */
  readonly title: string;
  /** Milliseconds since 1970. */
  readonly updatedAt: number;
}

/** A conversation as it was kept. What was said is the editor's to read, see `readEntry`. */
export interface SavedChat extends SavedChatSummary {
  readonly entries: readonly unknown[];
}

/** Conversations with AI by project. Only so many of a project are kept, the oldest go first. */
export interface ChatStore {
  /** Newest first, without what was said. */
  list(project: string): Promise<readonly SavedChatSummary[]>;
  load(project: string, id: string): Promise<SavedChat | undefined>;
  save(chat: SavedChat): Promise<void>;
  remove(project: string, id: string): Promise<void>;
  /** All of a project, for a project that is gone. */
  forget(project: string): Promise<void>;
}

/** Receives what people chose to send: how the editor runs, or what went wrong in it. */
export interface DiagnosticsSink {
  /** Resolves to something people can quote. Rejects when it did not arrive. */
  send(report: unknown): Promise<string>;
}

/**
 * Which project this window shows. It belongs to the window, unlike settings, which all windows
 * share: nothing that happens in another window may change it, and it survives a reload.
 */
export interface ProjectAddress {
  read(): string | undefined;
  write(id: string | undefined): void;
}

/**
 * What this window is doing, apart from which project it shows, such as its workspace. Like the
 * address it belongs to the window and survives a reload, but it stays out of links. Losing it does
 * no harm, so neither method fails: without it the window behaves like a new one.
 */
export interface WindowMemory {
  read(key: string): string | undefined;
  write(key: string, value: string): void;
}

/**
 * Preferences of the person using the editor, such as the layout, shared by all windows. What one
 * window is doing right now does not belong here. Values must survive JSON.
 * Both `load` and `save` reject when the store cannot do its job, and the caller decides what to
 * tell people.
 */
export interface SettingsStore {
  /** Resolves to undefined when nothing has been saved under this key. */
  load(key: string): Promise<unknown>;
  save(key: string, value: unknown): Promise<void>;
  /**
   * What other windows save under this key, so that saving here does not bring back an old value.
   * Returns how to stop listening.
   */
  listen(key: string, listener: (value: unknown) => void): () => void;
}

/**
 * What is being tried out on projects, kept on this device only. It is not part of a project: it is
 * there so that a reload or a crash costs nothing, and the host keeps whatever it gets as it is.
 */
/** Something a window keeps on a project for itself until it is done with it. */
export interface WindowPlaces {
  /**
   * Gets a window a place of its own on a project, since two windows try out different things. A
   * window that was reloaded or crashed finds the place it had. Other places that no window has any
   * more go to the next window that needs one, the most recent one first. Rejects when the host
   * cannot keep anything.
   */
  open(project: string): Promise<WindowPlace>;
}

export interface WindowPlace {
  /** Resolves to undefined when nothing is kept here. */
  load(): Promise<unknown>;
  /** Replaces what is kept. Undefined leaves nothing. Rejects when it could not be kept. */
  save(kept: unknown): Promise<void>;
  /** Lets go of the place. What is kept stays, for the next window. */
  close(): void;
}

export type TrialStore = WindowPlaces;
export type TrialPlace = WindowPlace;
export type DraftStore = WindowPlaces;

export interface ProjectSummary {
  readonly id: string;
  readonly name: string;
  /** Milliseconds since 1970. */
  readonly updatedAt: number;
  /**
   * The log of a project that is a folder on this computer, kept by the number of the folder, see
   * `FolderRecord`: the project is the folder, and this is no project of the browser.
   */
  readonly folder?: true;
}

/**
 * Whether a file of the media store is one the editor made itself and can make again, such as a
 * sound from code and its waveform. Only those can ever be removed one by one. What people brought
 * in is named by its SHA-256, and that never looks like this.
 */
export const isMadeFile = (name: string): boolean => /^(?:peaks-\d+:)?sound-\d+:/.test(name);

/** A file the editor made, as far as cleaning up goes. */
export interface MadeFile {
  readonly name: string;
  /** Bytes. */
  readonly size: number;
  /** Milliseconds since 1970. 0 when nobody knows. */
  readonly usedAt: number;
}

/** The files of a project. They are kept by their content, so a file only exists once. */
export interface MediaStore {
  /** Rejects when there is no room. A made file counts as used now. */
  put(hash: string, file: Blob): Promise<void>;
  /** Resolves to undefined when this host does not have the file. */
  get(hash: string): Promise<Blob | undefined>;
  /** The made files of the project, see `isMadeFile`. Nothing else shows up here. */
  listMade(): Promise<readonly MadeFile[]>;
  /** A made file was used just now. Nothing happens for any other file. */
  touchMade(name: string): Promise<void>;
  /** Removes a made file. Rejects for any other, so that this can never take what people brought in. */
  removeMade(name: string): Promise<void>;
}

/**
 * A project on its way in, which takes a while because of its files. Nobody sees it until it is
 * finished. Whatever stops it, also a closing page, leaves nothing that stays behind for good.
 */
export interface IncomingProject {
  readonly media: MediaStore;
  /** Makes the project appear, all at once. */
  finish(state: Uint8Array): Promise<void>;
  /** Takes back what came in so far. */
  abandon(): Promise<void>;
}

/** The projects this host keeps. */
export interface ProjectLibrary {
  /** Most recently changed first. */
  list(): Promise<readonly ProjectSummary[]>;
  /** Rejects when the id is taken: a new project never replaces another one. */
  create(
    project: { readonly id: string; readonly name: string; readonly folder?: boolean },
    state: Uint8Array,
  ): Promise<void>;
  /**
   * Starts bringing in a project. Resolves to undefined when the id is taken, by a project or by
   * another one on its way in, so that two of them can never end up in one place.
   */
  receive(project: {
    readonly id: string;
    readonly name: string;
    readonly folder?: boolean;
  }): Promise<IncomingProject | undefined>;
  open(id: string): Promise<ProjectLog>;
  media(id: string): MediaStore;
  /**
   * Takes a project away with all that is kept of it. The log of a project that is a folder, see
   * `ProjectSummary.folder`, only goes with `folder`, as the folder goes off the list: a page that
   * still takes it for a project of the browser must not take away what the folder relies on.
   */
  remove(id: string, options?: { readonly folder?: boolean }): Promise<void>;
  /**
   * Makes a project of this host one that is a folder on this computer, see `ProjectSummary.folder`,
   * once all of it is in that folder. Everything kept by its id goes on as it was: its log, what
   * windows keep of it, what its exports did, and the files people brought in, which are copies
   * now, see `copies`. Rejects when there is no such project. A folder already is fine.
   */
  toFolder(id: string): Promise<void>;
  /**
   * The files people brought into a project, as this host keeps them, by name: of a project that
   * is a folder now, copies of what is in the folder. Never what the editor made, see `isMadeFile`.
   */
  copies(id: string): Promise<readonly KeptFile[]>;
  /**
   * Takes away copies of files people brought into a project that is a folder now, see `toFolder`,
   * once people say so. Rejects for a project of this host, whose files those are, and for one that
   * is not there. What the editor made stays.
   */
  dropCopies(id: string, names: readonly string[]): Promise<void>;
}

/** A file that a host keeps, as far as the room it takes goes. */
export interface KeptFile {
  readonly name: string;
  /** Bytes. */
  readonly size: number;
}

/**
 * Who made a change in the log of a project, for whoever sends it on, such as to a platform. The
 * host keeps it as it is.
 */
export interface ChangeSource {
  /**
   * "user", "folder", "ai" and "other" as the editor tells them apart; "cloud" for what came from
   * the platform, and "merged" for what the log put together when it got shorter, see `compact`.
   */
  readonly kind: string;
  /** Which window made it. */
  readonly window?: string;
  /** When, in milliseconds since 1970. */
  readonly at?: number;
  /**
   * For "cloud": its number on the platform. For a change of a window: the last update of the
   * platform that the window had when it made it.
   */
  readonly seq?: number;
}

/** An update in the log of a project, where it is in there, and who made it. */
export interface LogEntry {
  readonly update: Uint8Array;
  /** Undefined for what was written without saying, as by an older editor. */
  readonly source: ChangeSource | undefined;
  /** Where it is: what comes later has a larger mark. */
  readonly mark: number;
}

/**
 * One open project, as a list of binary updates that only the editor understands. Every change is
 * appended right away, so that a crash loses nothing. The order of updates does not matter.
 */
export interface ProjectLog {
  load(): Promise<readonly Uint8Array[]>;
  /**
   * What is in the log after a mark, oldest first, with who made it. Hosts that keep no marks do not
   * have this: then nothing can tell what of a log is on a platform, and syncing compares instead.
   */
  entries?(after?: number): Promise<readonly LogEntry[]>;
  /**
   * Rejects when the project is gone, for example because another window removed it. That stays so
   * when another project comes in with the same id: it is not the one this log belongs to.
   */
  append(update: Uint8Array, name: string, source?: ChangeSource): Promise<void>;
  /**
   * Replaces all updates with what `merge` makes of them, in one step. Updates that another window
   * writes at the same moment are part of it or stay, so nothing gets lost. `merge` has to be
   * synchronous, because the step cannot wait. With `through`, only the updates up to that mark go
   * into it, see `LogEntry.mark`, and the rest stay as they are: what is not on a platform yet. What
   * it makes is a "merged" change, see `ChangeSource`.
   */
  compact(
    merge: (updates: readonly Uint8Array[]) => Uint8Array,
    options?: { readonly through?: number },
  ): Promise<void>;
  /** Updates from other windows on the same project. Returns how to stop listening. */
  listen(listener: (update: Uint8Array) => void): () => void;
  close(): void;
}

/** A file in a folder outside of the host. */
export interface FolderFile {
  /** From the top of the folder, with forward slashes. */
  readonly path: string;
  /** Rejects when the file cannot be read, for example because it went away. */
  read(): Promise<File>;
}

/** A folder people chose to bring in. */
export interface SourceFolder {
  /** To tell people which one this is about. */
  readonly name: string;
  /** Every file in it, apart from what belongs to tools, such as .git. */
  files(): AsyncIterable<FolderFile>;
}

export interface WriteOptions {
  readonly signal?: AbortSignal;
  /** How much of this file got written so far, in bytes. */
  readonly onProgress?: (bytes: number) => void;
}

/**
 * A new place to put a project. There is no way to get it there in one step, so what is in it after
 * a failure is whatever got written up to then.
 */
export interface TargetFolder {
  /** To tell people where it went. */
  readonly name: string;
  /** An archive is one file that people have to unpack to get the folder. */
  readonly kind: "folder" | "archive";
  /**
   * Resolves to true when the whole file is in place, and to false when a file cannot have this
   * path here, which is no reason to give up on the others. The content is read piece by piece, so
   * its size does not matter. Rejects when writing failed, and with the reason of the signal when
   * asked to stop.
   */
  write(path: string, content: Blob, options?: WriteOptions): Promise<boolean>;
  remove(path: string): Promise<void>;
  /** Everything is in place. */
  finish(): Promise<void>;
  /** Takes back what was written. Rejects when something had to stay. */
  abandon(): Promise<void>;
}

/** What kind of file a new one is, for the dialog that asks where it goes. */
export interface FileKind {
  /** For people, such as "MP4 video". */
  readonly description: string;
  readonly mime: string;
  /** Without the dot. */
  readonly extension: string;
}

/**
 * A new file that gets written piece by piece, anywhere in it, so that it never has to be in memory
 * as a whole. Nothing of it counts until `finish`: a file that stops halfway is not a file.
 */
export interface GrowingFile {
  /** To tell people where it went. */
  readonly name: string;
  /** A place people chose, or their downloads, where it only arrives once it is finished. */
  readonly kind: "file" | "download";
  /**
   * How to get to it again from another page, see `FolderAccess.reopen`. A browser that cannot keep
   * a file people chose has a download here instead.
   */
  readonly target: unknown;
  write(data: Uint8Array<ArrayBuffer>, position: number): Promise<void>;
  finish(): Promise<void>;
  /**
   * Takes back what was written. The file only goes while it is still empty and none of `others`,
   * targets of other exports, is the same file. Rejects when something had to stay, such as an
   * empty file.
   */
  abandon(others?: readonly unknown[]): Promise<void>;
}

/** How people get to folders. Both ask them, so both need to run right after they did something. */
export interface FolderAccess {
  /**
   * The browser asks whether a folder may be uploaded, with cancel as the default, although nothing
   * leaves the computer. People should know that before they see it.
   */
  readonly asksToUpload?: boolean;
  /** Resolves to undefined when they changed their minds. */
  chooseSource(): Promise<SourceFolder | undefined>;
  /**
   * Asks where a new folder with about this name should go. It never is a folder that exists: what
   * is there stays as it is. Resolves to undefined when they changed their minds.
   */
  chooseTarget(name: string): Promise<TargetFolder | undefined>;
  /** Gives people a finished file, the way downloads go here. The name can be anything. */
  saveFile(file: Blob, name: string): void;
  /**
   * Asks where a new file with about this name should go, for one that is too large to hold. It has
   * to run right after people did something. Resolves to undefined when they changed their minds.
   */
  chooseFile(name: string, kind: FileKind): Promise<GrowingFile | undefined>;
  /**
   * A file from `chooseFile` again, after a reload, to write it from the start. The browser may ask
   * whether that is all right, which has to run right after people did something. "gone" when it
   * is not there any more, "denied" when it may not be written, "taken" when something else is in
   * it now, which stays as it is.
   */
  reopen(target: unknown, kind: FileKind): Promise<GrowingFile | "gone" | "denied" | "taken">;
  /**
   * Takes away the file of a target that is given up, as far as it is still empty and none of
   * `others` is the same file. With `ask` the browser may ask whether that is all right, which has
   * to run right after people did something. Resolves to whether an empty file stays behind.
   */
  dropTarget(target: unknown, others: readonly unknown[], ask: boolean): Promise<boolean>;
  /**
   * Files from `chooseFile` are put together in the storage of the browser first and then become
   * downloads, so that what an export keeps there takes twice the room.
   */
  readonly savesInBrowser: boolean;
}

/**
 * Folders on this computer that the editor reads and writes as people work, such as the folder of a
 * project. Choosing and dropping get a folder, and the records remember the folders for next time.
 */
export interface LocalFolders {
  /**
   * Asks people for a folder that the editor may read and write. It has to run right after they did
   * something. Resolves to undefined when they changed their minds, and also when the browser did not
   * let them have that folder, such as their documents themselves: the browser says why itself.
   */
  choose(): Promise<LocalFolder | undefined>;
  /**
   * Folders and files that people dropped. It has to run in the `drop` event before anything there
   * waits, because the browser takes away what was dropped right after. They can be read. To write a
   * folder that was dropped, ask first, see `LocalFolder.requestAccess`, which is best done right
   * away: dropping counts as people doing something, but not for long.
   */
  dropped(transfer: DataTransfer): Promise<readonly LocalEntry[]>;
  /**
   * Asks people for files, as `showOpenFilePicker` does, starting in `near`, such as the folder of
   * the open project. It has to run right after they did something. Like what was dropped, they can
   * be read, and a folder tells whether they are in it, see `LocalFolder.pathOf`. Resolves to none
   * when people changed their minds, and to undefined where the browser cannot ask this way.
   */
  chooseFiles(near?: LocalFolder): Promise<readonly LocalEntry[] | undefined>;
  /** The folders that were opened in this browser, in a database of their own. */
  readonly records: FolderRecords;
  /** What the editor last wrote or read in each file of those folders, in the same database. */
  readonly bases: FolderBases;
  /**
   * Which window of this browser writes the folder with this number, see `FolderRecord.id`: one at
   * a time, so that no two of them write a file, or take in what changed in it, at once.
   */
  writer(folder: string): FolderWriter;
}

/**
 * What the editor keeps about a file of a folder that it reads and writes, see `FolderBases`. Values
 * are stored as they are, and only the editor knows what they mean.
 */
export interface FolderFileRecord {
  /** From the top of the folder, with forward slashes. */
  readonly path: string;
  /**
   * What the file held when the editor last wrote or read it: what changed outside is the difference
   * from this. Not there when the file was not.
   */
  readonly base?: string | undefined;
  /** How the file was then, so that it gets replaced only while it still is. */
  readonly stat?: FileStat | undefined;
  /** Something the editor keeps to tell whether it has to write the file again. */
  readonly synced?: string | undefined;
  /**
   * What the editor is about to do to the file, while it does it. A crash leaves this behind, and
   * the file tells then whether it got there.
   */
  readonly intent?: string | undefined;
  /**
   * What the file held before the editor last replaced it or took it away, until the folder was
   * looked at again: a crash can take back the replacement, and the file is that one then.
   */
  readonly replaced?: string | undefined;
}

/** A change to what is kept about the files of a folder, which happens as a whole or not at all. */
export interface FolderBasesChange {
  /** In place of what is kept for the same paths. */
  readonly put?: readonly FolderFileRecord[];
  /** Paths to keep nothing for any more. */
  readonly remove?: readonly string[];
  /** Everything else that was kept for the folder goes. */
  readonly replace?: boolean;
}

/**
 * What the editor last wrote or read in the files of the folders it works on, by the number this
 * browser knows a folder by. It is what tells a change from outside apart from the editor's own, so
 * it is on the disk before anything resolves. Only one window keeps it for a folder at a time:
 * whoever takes over claims it, and what a window that lost its turn keeps after that is refused,
 * since it would put back what the folder had before.
 */
/** The hash of a file of a folder, as it was found to be, for as long as the file is that way. */
export interface FolderHash {
  /** From the top of the folder, with forward slashes. */
  readonly path: string;
  readonly size: number;
  readonly lastModified: number;
  /** As a project writes it down, see `hashFile`. */
  readonly hash: string;
  /**
   * A hash of pieces at the start, the middle and the end, quick to find out again: another file
   * of the same size and time shows by that, as one that a program put back keeping the time.
   */
  readonly samples?: string;
  /**
   * When reading the file for its hash began. A file that changed less than a moment before may
   * change again without its time changing, as Git knows, so its hash holds only once looked again.
   */
  readonly hashedAt?: number;
}

export interface FolderBases {
  /** Has this window keep what is kept for the folder from now on. Resolves to its turn. */
  claim(folder: string): Promise<number>;
  /** The last turn that a window claimed for the folder, 0 when none did. */
  turnOf(folder: string): Promise<number>;
  /** What the hash of a file of the folder was found to be, see `keepHash`. */
  hashOf(folder: string, path: string): Promise<FolderHash | undefined>;
  /**
   * Notes the hash of a file of the folder, which holds for as long as the file has that size and
   * time: reading all of a large file again is what this saves. Any window may note it down.
   */
  keepHash(folder: string, hash: FolderHash): Promise<void>;
  /** What is kept for each file of the folder. */
  load(folder: string): Promise<readonly FolderFileRecord[]>;
  /**
   * Keeps a change, once it is on the disk. Resolves to false, and keeps nothing, when another
   * window claimed the folder after `turn`.
   */
  save(folder: string, turn: number, change: FolderBasesChange): Promise<boolean>;
  /** Keeps nothing more for the folder, such as one that was taken off the list. */
  forget(folder: string): Promise<void>;
}

/**
 * Which window of this browser writes a folder. It goes to one window at a time, and to the next
 * one, in turn, once that one lets go or goes away.
 */
export interface FolderWriter {
  /**
   * Waits until no other window writes the folder, and then has this one write it. Rejects with the
   * reason of the signal when asked to stop waiting. `steal` takes over right away from the one
   * that writes now, which only makes sense when that one does not answer: a browser can put a
   * window to sleep with its turn.
   */
  claim(options?: {
    readonly signal?: AbortSignal | undefined;
    readonly steal?: boolean;
    /** Called when another window writes the folder now, so that this one has to wait. */
    readonly onWaiting?: () => void;
  }): Promise<WriterClaim>;
  /** Whether the window that writes the folder answers within this long. True when none does. */
  answers(timeoutMs: number): Promise<boolean>;
}

/** That this window writes a folder, for as long as it lasts. */
export interface WriterClaim {
  /**
   * Settles once this window does not write the folder any more: another one took over, or this
   * one let go. Nothing may be written after that.
   */
  readonly lost: Promise<void>;
  release(): void;
}

/** Something on this computer that people dropped. */
export type LocalEntry =
  | { readonly kind: "folder"; readonly folder: LocalFolder }
  | { readonly kind: "file"; readonly file: LocalFile };

/** A file on this computer that people dropped. */
export interface LocalFile {
  readonly name: string;
  /** What is in it now. Rejects with a `FolderError` when it cannot be read. */
  read(): Promise<File>;
}

/** What a file can hold. Text is written as UTF-8. */
export type FileContent = Blob | Uint8Array<ArrayBuffer> | string;

/** Enough of a file on a disk to tell that it changed. A `File` is one. */
export interface FileStat {
  /** Bytes. */
  readonly size: number;
  /** Milliseconds since 1970, as the system has it. */
  readonly lastModified: number;
}

/** How a folder is, as far as the editor goes. */
export type FolderStatus =
  /** It can be read and written. */
  | "ready"
  /**
   * The browser has to ask people first, see `LocalFolder.requestAccess`: after the browser was
   * closed, for example, or for a folder that was dropped, which comes only to be read.
   */
  | "ask"
  /** The browser does not let the editor at it at all, for example because of a policy. */
  | "blocked"
  /**
   * It is not where it was: moved, renamed or removed. A folder only knows its place, so whatever
   * comes to that place later is what it then has.
   */
  | "gone";

/** What people said when the browser asked them whether the editor may write a folder. */
export type AccessAnswer =
  | "granted"
  /** They said no, or closed the question. The two cannot be told apart. */
  | "refused"
  /** The browser only asks right after people did something: ask again from a button. */
  | "needs-activation";

/** Why something could not be done in a folder on this computer, see `FolderError`. */
export type FolderFailure =
  /** The path leads out of the folder, or the browser does not allow a name in it. */
  | "refused"
  /** No file is at the path. */
  | "missing"
  /** The folder itself is not where it was any more: moved, renamed or removed. */
  | "gone"
  /** The browser does not let the editor at the folder, until people allow it again. */
  | "denied"
  /** Something is in the way: a file at a new path, or a file where a folder has to be. */
  | "exists"
  /** Another writer in this browser has the file, maybe in another window. */
  | "busy"
  /** The disk is full, or the browser does not let the site have more room. */
  | "full"
  /**
   * The folder is there and the file could not be made in it: most likely the whole path is too
   * long for the system. Windows allows 260 characters, wherever the folder is.
   */
  | "too-long"
  /** The file is not what it was said to be, or changed while it was read or just after writing. */
  | "changed"
  /** The file is no UTF-8 text. */
  | "not-text"
  /** Anything else, such as another program that holds on to the file. */
  | "failed";

/** Something could not be done in a folder on this computer. `reason` says why. */
export class FolderError extends Error {
  override readonly name = "FolderError";
  readonly reason: FolderFailure;
  /** From the top of the folder, "" for the folder itself. */
  readonly path: string;
  /**
   * Where a copy of the file is that this left behind, as a move that wrote the new file and could
   * not take away the old one: then both are there.
   */
  readonly copy: string | undefined;

  constructor(
    reason: FolderFailure,
    path: string,
    options?: { readonly cause?: unknown; readonly copy?: string },
  ) {
    const both = options?.copy === undefined ? "" : `, and a copy is at ${options.copy}`;
    super(`${reason}: ${path === "" ? "the folder" : path}${both}`, options);
    this.reason = reason;
    this.path = path;
    this.copy = options?.copy;
  }
}

export interface LocalWriteOptions {
  /** Stops the write. The file stays as it was, and this rejects with the reason of the signal. */
  readonly signal?: AbortSignal;
  /** How much of this file got written so far, in bytes. */
  readonly onProgress?: (bytes: number) => void;
  /**
   * Writes only when the file is still the way it was seen, so that a change from somewhere else
   * does not get lost, and rejects with "changed" otherwise. "absent" when there should be no file,
   * or an empty one: that is what a crash leaves of a file that was being made.
   */
  readonly expected?: FileStat | "absent";
}

export interface RemoveOptions {
  /**
   * Takes the file away only when it is still the way it was seen, and rejects with "changed"
   * otherwise: whatever another program just wrote stays.
   */
  readonly expected?: FileStat;
}

/**
 * A new file of a folder on this computer that gets written piece by piece, anywhere in it, see
 * `LocalFolder.grow`. Nothing of it counts until `finish`: a file that stops halfway is not a file.
 * What fails rejects with a `FolderError`.
 */
export interface LocalGrowingFile {
  /** Puts bytes at a place in the file, also where something was before, or past its end. */
  write(data: Uint8Array<ArrayBuffer>, position: number): Promise<void>;
  /** Puts all of it at its path at once. Resolves to the file as it was written. */
  finish(): Promise<File>;
  /** Takes back what was written, and the empty file that `grow` made. Fine after `finish` too. */
  abandon(): Promise<void>;
}

export interface WriteAllOptions {
  /** Stops writing. Files that were written stay written. */
  readonly signal?: AbortSignal;
  /** How many files are written at the same time. */
  readonly concurrency?: number;
  /** How many of the files are written so far, out of how many. */
  readonly onProgress?: (written: number, total: number) => void;
  /** Each file as soon as it is in place. */
  readonly onWritten?: (path: string, file: File) => void;
}

/**
 * A folder on this computer that people chose or dropped. Paths are from its top, with forward
 * slashes. What fails rejects with a `FolderError`, which says why.
 *
 * Use one of these for one folder: it knows what it wrote itself, and nothing else does. Other
 * programs can change the folder at any time, also a file just as the editor writes it, which
 * nothing in a browser can stop. That is why a write can say what it expects to replace.
 */
export interface LocalFolder {
  /** Its name. Where it is on the disk is more than a page gets to know. */
  readonly name: string;
  /** Whether the editor can read and write it now. */
  status(): Promise<FolderStatus>;
  /**
   * Asks people to let the editor read and write the folder, unless it may already. The browser
   * only asks right after people did something, such as a click, or dropping the folder.
   */
  requestAccess(): Promise<AccessAnswer>;
  /** Whether this is the same folder as another one, at the same place. One that moved is not. */
  isSame(other: LocalFolder): Promise<boolean>;
  /**
   * A folder right inside this one, as a folder of its own, which the editor may write as far as it
   * may write this one. With `create` it is made when it is not there. Rejects with "missing" when
   * it is not there, and when making it, with "exists" where a file has its name.
   */
  inside(name: string, options?: { readonly create?: boolean }): Promise<LocalFolder>;
  /**
   * Where something that was dropped is in this folder, "" for the folder itself, or undefined when
   * it is somewhere else.
   */
  pathOf(entry: LocalEntry): Promise<string | undefined>;
  /**
   * Every file in it, apart from what belongs to tools, such as .git. Chrome does not show names it
   * does not allow, see `chromeRefuses`: those files stay as they are, but this leaves them out.
   * With `includes` only what matters, as for a watch, which is much quicker in a large folder.
   */
  list(options?: { readonly includes?: WatchOptions["includes"] }): AsyncIterable<string>;
  /**
   * A file as it is now. Once it changes, also because the editor wrote it, reading this one fails
   * with a "NotReadableError": get it again then.
   */
  file(path: string): Promise<File>;
  /** What is in a file now. */
  read(path: string): Promise<Uint8Array<ArrayBuffer>>;
  /** The text in a file now. Rejects with "not-text" when it is no UTF-8. */
  readText(path: string): Promise<string>;
  /**
   * Replaces a file, or makes it, and the folders on the way. The browser writes next to it first
   * and puts that in place once all of it is there, so that nobody ever sees half a file, and the
   * file stays as it was when anything stops this. A file is written by one writer at a time in
   * this browser, the others get "busy". Resolves to the file as it was written.
   */
  write(path: string, content: FileContent, options?: LocalWriteOptions): Promise<File>;
  /**
   * Starts a new file that gets written piece by piece, anywhere in it, such as a video that an
   * encoder makes: it never has to be in memory, whatever its size. As with `write`, the browser
   * writes next to it and puts that in place on `finish`, so nobody ever sees half of it. Until then
   * the path has an empty file, which is also what a crash leaves. Rejects with "changed" where a
   * file that is not empty is at the path, and with "busy" where another writer has it. From start
   * to end a watch takes it for a write of this folder.
   */
  grow(path: string): Promise<LocalGrowingFile>;
  /**
   * Writes many files, some at the same time, because each one costs about a tenth of a second on
   * Windows, however small it is. Rejects with the first failure, once the files on their way are
   * done. The order of the files is up to whoever writes: write what others refer to first.
   */
  writeAll(
    files: Iterable<{ readonly path: string; readonly content: FileContent }>,
    options?: WriteAllOptions,
  ): Promise<void>;
  /**
   * Takes away a file, and the folders on the way that this leaves empty, apart from this one. A
   * file that is not there is fine. Folders are not taken away with what is in them, and a folder
   * that was empty before stays: people may have made it.
   */
  remove(path: string, options?: RemoveOptions): Promise<void>;
  /**
   * Moves or renames a file. Rejects with "exists" when another file is at the new path, which the
   * browser would replace without a word, also one that differs only in case on a system where
   * that is another file. Where the browser cannot move a file, this writes it at the new path and
   * then takes away the old one. When the old one changed in the meantime, or cannot be taken away,
   * the copy stays only as long as it is needed: the error says when both are there, see
   * `FolderError.copy`. Folders cannot be moved.
   */
  move(from: string, to: string, options?: RemoveOptions): Promise<void>;
  /**
   * Takes away the temporary files that writing these files left behind. A write that stops because
   * the browser went away leaves one next to the file on Linux and maybe a Mac, as
   * "<name>.crswap" or "<name>.<number>.crswap", and the browser does not clean them up. One that a
   * write in this browser is using stays. Only call this when no other window writes the folder.
   * Resolves to the paths of what was taken away.
   */
  removeLeftovers(paths: Iterable<string>): Promise<readonly string[]>;
  /**
   * Takes away a folder in this one while nothing is in it, also nothing that the browser does not
   * show: a folder with anything in it stays as it is, and so does a file of that name. Resolves to
   * whether it is gone, also when it was not there.
   */
  removeFolder(path: string): Promise<boolean>;
  /** Tells what changes in the folder, see `FolderWatch`. */
  watch(options: WatchOptions): FolderWatch;
}

export interface WatchOptions {
  /**
   * Whether a file matters, or what is in a folder. Only what matters gets looked at: projects can be
   * in large folders, such as a repository.
   */
  readonly includes: (path: string, kind: "file" | "folder") => boolean;
  /** Files to look at besides what is in folders that matter, such as the assets of a project. */
  readonly files?: () => Iterable<string>;
  /**
   * Tells also about a file that only got a new time: a `File` of it from before cannot be read any
   * more, so whatever holds on to one has to get it again, see `LocalFolder.file`. Otherwise a file
   * that has what it had is no change.
   */
  readonly newTimes?: boolean;
  /**
   * What changed since the last time, once nothing changed for a moment: other programs often change
   * several files at once. What this folder wrote itself does not show up. The next changes wait
   * until what this returns is done.
   */
  readonly onChange: (changes: readonly FolderChange[], batch: FolderBatch) => void | Promise<void>;
  /**
   * The folder cannot be looked at. "gone" ends the watch: start another one once the folder is
   * back. After "denied" the watch looks again when the window comes to the front again.
   */
  readonly onProblem?: (error: FolderError) => void;
}

/** How a batch of changes came to be told. */
export interface FolderBatch {
  /**
   * The folder kept changing, for half a minute, as during a long checkout: more is likely to come,
   * and whoever takes this in may want to wait for the next batch, which comes once it is quiet.
   */
  readonly stillChanging: boolean;
}

/** A file that changed. */
export interface FolderChange {
  readonly path: string;
  /** What is there now, or undefined when the file is gone. */
  readonly file: File | undefined;
}

/**
 * Tells what changes in a folder, made by whatever program. The browser tells about changes where it
 * can, but not always all of them: on Linux it misses some, and other browsers tell nothing. So the
 * folder gets looked at again when the window comes to the front, and whenever what the browser
 * says does not add up. What changed is told by what files are like now, not by what was said.
 */
export interface FolderWatch {
  /**
   * Resolves once the watch knows how the folder is. What changes from then on gets told, so read
   * what the folder holds after this, not before. Rejects when the folder cannot be looked at, and
   * the watch is over then.
   */
  readonly ready: Promise<void>;
  /** Looks at everything that matters again, and tells what changed. */
  rescan(): Promise<void>;
  /** Tells what changed so far right away, without waiting for a quiet moment. */
  flush(): Promise<void>;
  stop(): void;
}

/** A folder that was opened in this browser. */
export interface FolderRecord {
  /**
   * The number this browser knows the folder by, and what keeps what belongs to it. Not the id of the
   * project: copies of a folder have the same one.
   */
  readonly id: string;
  readonly folder: LocalFolder;
  /** The id of the project in it, the last time it was looked at. */
  readonly project: string;
  /** What the project is called, for people to recognise it. */
  readonly name: string;
  /** Milliseconds since 1970. */
  readonly openedAt: number;
  /**
   * The file that says that a move into this folder is not done, see `INCOMPLETE_FILE` of core, as
   * the move wrote it, while it may still be there: it goes once the folder opens.
   */
  readonly unfinished?: FileStat;
}

/** The folders that were opened in this browser. */
export interface FolderRecords {
  /** The most recently opened first. */
  list(): Promise<readonly FolderRecord[]>;
  get(id: string): Promise<FolderRecord | undefined>;
  /** Keeps a record, in place of the one with the same id. */
  put(record: FolderRecord): Promise<void>;
  /** Takes a folder off the list. Nothing happens to the folder. */
  remove(id: string): Promise<void>;
  /** The record of this very folder, for one that was chosen or dropped once more. */
  find(folder: LocalFolder): Promise<FolderRecord | undefined>;
  /** The records of folders with this project in them, one of which might have moved. */
  withProject(project: string): Promise<readonly FolderRecord[]>;
}
