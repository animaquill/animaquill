import type {
  IncomingProject,
  MediaStore,
  ProjectAddress,
  ProjectLibrary,
  ProjectLog,
  ProjectSummary,
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

/** For tests: keeps projects in memory, and windows on the same project hear each other. */
export class MemoryLibrary implements ProjectLibrary {
  readonly updates = new Map<string, Uint8Array[]>();
  readonly summaries = new Map<string, ProjectSummary>();
  readonly listeners = new Map<string, Set<(update: Uint8Array) => void>>();
  readonly files = new Map<string, Blob>();
  /** Projects on their way in. */
  readonly incoming = new Set<string>();
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
    return {
      load: async () => {
        const updates = [...(this.updates.get(id) ?? [])];
        this.duringLoad?.();
        return updates;
      },
      append: async (update, name) => {
        if (this.failing) throw new Error("quota");
        const summary = this.summaries.get(id);
        if (!summary) throw new Error("gone");
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
    this.#removeFiles(id);
  }
}
