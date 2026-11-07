import type {
  IncomingProject,
  MediaStore,
  ProjectAddress,
  ProjectLibrary,
  ProjectLog,
  ProjectSummary,
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

  async create({ id, name }: { id: string; name: string }, state: Uint8Array) {
    if (this.failing) throw new Error("quota");
    if (this.summaries.has(id)) throw new Error("taken");
    this.summaries.set(id, { id, name, updatedAt: 1 });
    this.updates.set(id, [state]);
    this.instances.set(id, this.#nextInstance++);
  }

  async receive({ id, name }: { id: string; name: string }): Promise<IncomingProject | undefined> {
    if (this.summaries.has(id) || this.incoming.has(id)) return undefined;
    this.incoming.add(id);
    return {
      media: this.media(id),
      finish: async (state) => {
        if (this.failing) throw new Error("quota");
        this.incoming.delete(id);
        await this.create({ id, name }, state);
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
      append: async (update, name) => {
        if (this.failing) throw new Error("quota");
        const summary = this.summaries.get(id);
        if (!summary || this.instances.get(id) !== instance) throw new Error("gone");
        await this.duringAppend?.();
        this.summaries.set(id, { ...summary, name });
        this.updates.get(id)?.push(update);
        for (const listener of listeners) if (!own.has(listener)) listener(update);
      },
      compact: async (merge) => {
        this.compactions += 1;
        this.updates.set(id, [merge(this.updates.get(id) ?? [])]);
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
    return {
      put: async (hash, file) => {
        if (this.failing) throw new Error("quota");
        this.files.set(key(hash), file);
      },
      get: async (hash) => this.files.get(key(hash)),
    };
  }

  /** Delivers an update to everyone on a project, as another window would. */
  broadcast(id: string, update: Uint8Array) {
    for (const listener of this.listeners.get(id) ?? []) listener(update);
  }

  #removeFiles(project: string) {
    for (const key of this.files.keys()) {
      if (key.startsWith(`${project}/`)) this.files.delete(key);
    }
  }

  async remove(id: string) {
    this.summaries.delete(id);
    this.updates.delete(id);
    this.instances.delete(id);
    this.#removeFiles(id);
  }
}
