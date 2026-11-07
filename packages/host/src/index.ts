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
  /** Where what people are trying out waits until they save it or give up on it. */
  readonly trials: TrialStore;
  /** Where code that people typed and did not save waits, so that a crash does not take it. */
  readonly drafts: DraftStore;
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
}
