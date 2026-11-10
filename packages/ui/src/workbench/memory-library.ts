import { isMadeFile } from "@animaquill/host";
import type {
  ChangeSource,
  LogEntry,
  ProjectPresence,
  ExportPiece,
  ExportStore,
  IncomingProject,
  MediaStore,
  ProjectAddress,
  ProjectLibrary,
  ProjectLog,
  ProjectSummary,
  SavedExport,
  TrialPlace,
  TrialStore,
  WindowMemory,
} from "@animaquill/host";

/** For tests: the address of one window. */
export function memoryAddress(start?: string): ProjectAddress {
  let current = start;
  return {
    read: () => current,
    write: (id) => {
      current = id;
    },
  };
}

/** For tests: what one window remembers. */
export function memoryWindow(): WindowMemory {
  const values = new Map<string, string>();
  return {
    read: (key) => values.get(key),
    write: (key, value) => void values.set(key, value),
  };
}

/** For tests: what is being tried out, kept the way a host does, by value. */
export class MemoryTrials implements TrialStore {
  /** What is kept, by project and then by place. */
  readonly kept = new Map<string, Map<string, unknown>>();
  /** Everything that was asked to be kept, in order. */
  readonly writes: unknown[] = [];
  /** The places windows have right now. */
  readonly held = new Set<string>();
  #nextPlace = 1;
  failing = false;
  /** Reading fails, which is something else than not being able to write. */
  failingToRead = false;
  /** Called while `save` writes, as if people kept working in the meantime. */
  duringSave: (() => Promise<void> | void) | undefined;
  /** Called while `load` reads, as if the disk was busy. */
  duringLoad: (() => Promise<void> | void) | undefined;

  async open(project: string): Promise<TrialPlace> {
    if (this.failing) throw new Error("blocked");
    const places = this.kept.get(project) ?? new Map<string, unknown>();
    this.kept.set(project, places);
    const free = [...places.keys()].toReversed().find((name) => !this.held.has(name));
    const place = free ?? `place${this.#nextPlace++}`;
    this.held.add(place);
    return {
      load: async () => {
        await this.duringLoad?.();
        if (this.failingToRead) throw new Error("damaged");
        return structuredClone(places.get(place));
      },
      save: async (trial) => {
        if (this.failing) throw new Error("quota");
        await this.duringSave?.();
        this.writes.push(trial);
        if (trial === undefined) places.delete(place);
        else places.set(place, structuredClone(trial));
      },
      close: () => void this.held.delete(place),
    };
  }
}

/** For tests: keeps projects in memory, and windows on the same project hear each other. */
export class MemoryLibrary implements ProjectLibrary {
  readonly updates = new Map<string, Uint8Array[]>();
  /** Where each update is in its log, and who made it, by the update, see `LogEntry`. */
  readonly entries = new WeakMap<Uint8Array, { mark: number; source: ChangeSource | undefined }>();
  #nextMark = 1;
  readonly summaries = new Map<string, ProjectSummary>();
  readonly listeners = new Map<string, Set<(update: Uint8Array) => void>>();
  readonly files = new Map<string, Blob>();
  /** Projects on their way in. */
  readonly incoming = new Set<string>();
  /** What tells two projects with one id apart. */
  readonly instances = new Map<string, number>();
  #nextInstance = 1;
  failing = false;
  compactions = 0;
  /** Called while `load` reads, as if another window was writing at that moment. */
  duringLoad: (() => void) | undefined;
  /** Called while `append` writes, as if people kept working in the meantime. */
  duringAppend: (() => Promise<void> | void) | undefined;

  async list() {
    if (this.failing) throw new Error("blocked");
    return [...this.summaries.values()];
  }

  async create(
    { id, name, folder = false }: { id: string; name: string; folder?: boolean },
    state: Uint8Array,
  ) {
    if (this.failing) throw new Error("quota");
    if (this.summaries.has(id)) throw new Error("taken");
    this.summaries.set(id, { id, name, updatedAt: 1, ...(folder && { folder: true }) });
    this.updates.set(id, [this.#marked(state, undefined)]);
    this.instances.set(id, this.#nextInstance++);
  }

  /** An update as a new entry of a log, see `entries`. */
  #marked(update: Uint8Array, source: ChangeSource | undefined): Uint8Array {
    // The same bytes can come twice, as another window's update does: each one is an entry.
    const entry = this.entries.has(update) ? update.slice() : update;
    this.entries.set(entry, { mark: this.#nextMark++, source });
    return entry;
  }

  /** The entries of a log after a mark, see `ProjectLog.entries`. */
  #entriesOf(id: string, after: number): LogEntry[] {
    return (this.updates.get(id) ?? []).flatMap((update) => {
      // What a test put in the log by hand gets its mark when it is first read.
      let entry = this.entries.get(update);
      if (!entry) {
        entry = { mark: this.#nextMark++, source: undefined };
        this.entries.set(update, entry);
      }
      if (entry.mark <= after) return [];
      return [{ update, mark: entry.mark, source: entry.source }];
    });
  }

  async receive({
    id,
    name,
    folder = false,
  }: {
    id: string;
    name: string;
    folder?: boolean;
  }): Promise<IncomingProject | undefined> {
    if (this.summaries.has(id) || this.incoming.has(id)) return undefined;
    this.incoming.add(id);
    return {
      media: this.media(id),
      finish: async (state) => {
        if (this.failing) throw new Error("quota");
        this.incoming.delete(id);
        await this.create({ id, name, folder }, state);
      },
      abandon: async () => {
        this.incoming.delete(id);
        this.#removeFiles(id);
      },
    };
  }

  async open(id: string): Promise<ProjectLog> {
    const listeners = this.listeners.get(id) ?? new Set();
    this.listeners.set(id, listeners);
    const own = new Set<(update: Uint8Array) => void>();
    const instance = this.instances.get(id);
    return {
      load: async () => {
        const updates = [...(this.updates.get(id) ?? [])];
        this.duringLoad?.();
        return updates;
      },
      entries: async (after = 0) => {
        const entries = this.#entriesOf(id, after);
        // Reading all of it is what opening a project does, as `load`.
        if (after === 0) this.duringLoad?.();
        return entries;
      },
      append: async (update, name, source) => {
        if (this.failing) throw new Error("quota");
        const summary = this.summaries.get(id);
        if (!summary || this.instances.get(id) !== instance) throw new Error("gone");
        await this.duringAppend?.();
        this.summaries.set(id, { ...summary, name });
        this.updates.get(id)?.push(this.#marked(update, source));
        for (const listener of listeners) if (!own.has(listener)) listener(update);
      },
      compact: async (merge, { through } = {}) => {
        this.compactions += 1;
        const all = this.updates.get(id) ?? [];
        const markOf = (update: Uint8Array) => this.entries.get(update)?.mark ?? 0;
        const merging = all.filter((update) => through === undefined || markOf(update) <= through);
        if (merging.length < 2 && through !== undefined) return;
        const staying = all.filter((update) => !merging.includes(update));
        const merged = this.#marked(merge(merging), { kind: "merged" });
        this.updates.set(id, [...staying, merged]);
      },
      listen: (listener) => {
        listeners.add(listener);
        own.add(listener);
        return () => {
          listeners.delete(listener);
          own.delete(listener);
        };
      },
      close: () => {},
    };
  }

  media(project: string): MediaStore {
    const key = (hash: string) => `${project}/${hash}`;
    const used = this.usedAt;
    return {
      put: async (hash, file) => {
        if (this.failing) throw new Error("quota");
        this.files.set(key(hash), file);
        if (isMadeFile(hash)) used.set(key(hash), this.now());
      },
      get: async (hash) => this.files.get(key(hash)),
      listMade: async () =>
        [...this.files]
          .filter(([name]) => name.startsWith(`${project}/`))
          .map(([name, file]) => ({ name: name.slice(project.length + 1), file, at: name }))
          .filter(({ name }) => isMadeFile(name))
          .map(({ name, file, at }) => ({ name, size: file.size, usedAt: used.get(at) ?? 0 })),
      touchMade: async (name) => {
        if (isMadeFile(name) && this.files.has(key(name))) used.set(key(name), this.now());
      },
      removeMade: async (name) => {
        if (!isMadeFile(name)) throw new Error(`Only made files can go: ${name}`);
        if (this.failingToRemove.has(name)) throw new Error("blocked");
        this.files.delete(key(name));
      },
    };
  }

  /** When made files were last used, by the same key as `files`. */
  readonly usedAt = new Map<string, number>();
  /** Made files that cannot be removed, as when the database is busy. */
  readonly failingToRemove = new Set<string>();
  /** The clock of `usedAt`. */
  now = () => Date.now();

  /** Delivers an update to everyone on a project, as another window would. */
  broadcast(id: string, update: Uint8Array) {
    for (const listener of this.listeners.get(id) ?? []) listener(update);
  }

  #removeFiles(project: string) {
    for (const key of this.files.keys()) {
      if (key.startsWith(`${project}/`)) this.files.delete(key);
    }
  }

  async remove(id: string, { folder = false }: { readonly folder?: boolean } = {}) {
    if (this.summaries.get(id)?.folder === true && !folder) {
      throw new Error(`Project ${id} is a folder: it goes with its folder`);
    }
    this.summaries.delete(id);
    this.updates.delete(id);
    this.instances.delete(id);
    this.#removeFiles(id);
  }

  async toFolder(id: string) {
    if (this.failing) throw new Error("quota");
    const summary = this.summaries.get(id);
    if (!summary) throw new Error(`No project ${id}`);
    this.summaries.set(id, { ...summary, folder: true });
  }

  async copies(id: string) {
    return [...this.files]
      .filter(([key]) => key.startsWith(`${id}/`))
      .map(([key, file]) => ({ name: key.slice(id.length + 1), size: file.size }))
      .filter(({ name }) => !isMadeFile(name));
  }

  async dropCopies(id: string, names: readonly string[]) {
    if (this.failing) throw new Error("quota");
    if (this.summaries.get(id)?.folder !== true) throw new Error(`Project ${id} is no folder`);
    for (const name of names) if (!isMadeFile(name)) this.files.delete(`${id}/${name}`);
  }
}

/** For tests: what exports keep, in memory, as it would be on the disk. */
export class MemoryExports implements ExportStore {
  readonly saved = new Map<string, SavedExport>();
  /** By export, then by track, then by number. */
  readonly kept = new Map<string, Map<string, Map<number, ExportPiece>>>();
  readonly claimed = new Set<string>();
  failing = false;
  /** Only pieces cannot be kept, as when the disk is full of them. */
  failingPieces = false;

  async list(project: string): Promise<readonly SavedExport[]> {
    return [...this.saved.values()]
      .filter((saved) => saved.project === project)
      .map((saved) => structuredClone(saved));
  }

  async all(): Promise<readonly SavedExport[]> {
    return [...this.saved.values()].map((saved) => structuredClone(saved));
  }

  async save(saved: SavedExport): Promise<void> {
    if (this.failing) throw new Error("quota");
    this.saved.set(saved.id, structuredClone(saved));
  }

  #track(id: string, track: string): Map<number, ExportPiece> {
    let tracks = this.kept.get(id);
    if (!tracks) {
      tracks = new Map();
      this.kept.set(id, tracks);
    }
    let pieces = tracks.get(track);
    if (!pieces) {
      pieces = new Map();
      tracks.set(track, pieces);
    }
    return pieces;
  }

  async addPiece(id: string, track: string, piece: ExportPiece): Promise<void> {
    if (this.failing || this.failingPieces) throw new Error("quota");
    if (!this.saved.has(id)) throw new DOMException("No such export", "NotFoundError");
    this.#track(id, track).set(piece.seq, piece);
  }

  async *pieces(id: string, track: string): AsyncGenerator<ExportPiece> {
    const pieces = [...this.#track(id, track).values()].toSorted((a, b) => a.seq - b.seq);
    yield* pieces;
  }

  async dropPieces(id: string, track: string, from: number): Promise<void> {
    const pieces = this.#track(id, track);
    for (const seq of pieces.keys()) if (seq >= from) pieces.delete(seq);
  }

  async remove(id: string): Promise<void> {
    this.saved.delete(id);
    this.kept.delete(id);
  }

  /** Pieces of a track, as many as there are. */
  count(id: string, track: string): number {
    return this.kept.get(id)?.get(track)?.size ?? 0;
  }

  async claim(id: string): Promise<(() => void) | undefined> {
    if (this.claimed.has(id)) return undefined;
    this.claimed.add(id);
    return () => this.claimed.delete(id);
  }
}

/**
 * For tests: which windows of a browser in memory have which projects open, see `ProjectPresence`.
 * Each window gets one of its own from `window`.
 */
export class MemoryPresence {
  /** How many windows have each project open. */
  readonly open = new Map<string, number>();
  readonly #windows = new Set<{ readonly listeners: Set<(project: string) => void> }>();

  window(): ProjectPresence {
    const own = new Map<string, number>();
    const listeners = new Set<(project: string) => void>();
    const page = { listeners };
    this.#windows.add(page);
    return {
      enter: (project) => {
        own.set(project, (own.get(project) ?? 0) + 1);
        this.open.set(project, (this.open.get(project) ?? 0) + 1);
        let isOver = false;
        return () => {
          if (isOver) return;
          isOver = true;
          own.set(project, (own.get(project) ?? 1) - 1);
          this.open.set(project, (this.open.get(project) ?? 1) - 1);
        };
      },
      others: async (project) => (this.open.get(project) ?? 0) - (own.get(project) ?? 0),
      moved: (project) => {
        for (const other of this.#windows) {
          if (other === page) continue;
          for (const listener of other.listeners) listener(project);
        }
      },
      onMoved: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
  }
}
