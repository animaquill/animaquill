/** What the editor needs from the place it runs in: a browser, the desktop app or the platform. */
export interface Host {
  readonly settings: SettingsStore;
  readonly projects: ProjectLibrary;
  readonly address: ProjectAddress;
  readonly windowMemory: WindowMemory;
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

/** The projects this host keeps. */
export interface ProjectLibrary {
  /** Most recently changed first. */
  list(): Promise<readonly ProjectSummary[]>;
  create(project: { readonly id: string; readonly name: string }, state: Uint8Array): Promise<void>;
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
