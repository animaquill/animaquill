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
  create(project: { readonly id: string; readonly name: string }, state: Uint8Array): Promise<void>;
  /**
   * Starts bringing in a project. Resolves to undefined when the id is taken, by a project or by
   * another one on its way in, so that two of them can never end up in one place.
   */
  receive(project: {
    readonly id: string;
    readonly name: string;
  }): Promise<IncomingProject | undefined>;
  open(id: string): Promise<ProjectLog>;
  media(id: string): MediaStore;
  remove(id: string): Promise<void>;
}

/**
 * One open project, as a list of binary updates that only the editor understands. Every change is
 * appended right away, so that a crash loses nothing. The order of updates does not matter.
 */
export interface ProjectLog {
  load(): Promise<readonly Uint8Array[]>;
  /**
   * Rejects when the project is gone, for example because another window removed it. That stays so
   * when another project comes in with the same id: it is not the one this log belongs to.
   */
  append(update: Uint8Array, name: string): Promise<void>;
  /**
   * Replaces all updates with what `merge` makes of them, in one step. Updates that another window
   * writes at the same moment are part of it or stay, so nothing gets lost. `merge` has to be
   * synchronous, because the step cannot wait.
   */
  compact(merge: (updates: readonly Uint8Array[]) => Uint8Array): Promise<void>;
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
export interface FolderBases {
  /** Has this window keep what is kept for the folder from now on. Resolves to its turn. */
  claim(folder: string): Promise<number>;
  /** The last turn that a window claimed for the folder, 0 when none did. */
  turnOf(folder: string): Promise<number>;
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
