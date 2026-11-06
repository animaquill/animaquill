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
}

/** Receives what people chose to send about how the editor runs. */
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

export interface ProjectSummary {
  readonly id: string;
  readonly name: string;
  /** Milliseconds since 1970. */
  readonly updatedAt: number;
}

/** The files of a project. They are kept by their content, so a file only exists once. */
export interface MediaStore {
  /** Rejects when there is no room. */
  put(hash: string, file: Blob): Promise<void>;
  /** Resolves to undefined when this host does not have the file. */
  get(hash: string): Promise<Blob | undefined>;
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
  /** Rejects when the project is gone, for example because another window removed it. */
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
   * Resolves when the whole file is in place. The content is read piece by piece, so its size does
   * not matter. Rejects when it could not be written, and with the reason of the signal when asked
   * to stop.
   */
  write(path: string, content: Blob, options?: WriteOptions): Promise<void>;
  remove(path: string): Promise<void>;
  /** Everything is in place. */
  finish(): Promise<void>;
  /** Takes back what was written. Rejects when something had to stay. */
  abandon(): Promise<void>;
}

/** How people get to folders. Both ask them, so both need to run right after they did something. */
export interface FolderAccess {
  /** Resolves to undefined when they changed their minds. */
  chooseSource(): Promise<SourceFolder | undefined>;
  /**
   * Asks where a new folder with about this name should go. It never is a folder that exists: what
   * is there stays as it is. Resolves to undefined when they changed their minds.
   */
  chooseTarget(name: string): Promise<TargetFolder | undefined>;
}
