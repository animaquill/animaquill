import type { ProjectAddress, ProjectLibrary, ProjectLog, ProjectSummary } from "@animaquill/host";

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

/** For tests: keeps projects in memory, and windows on the same project hear each other. */
export class MemoryLibrary implements ProjectLibrary {
  readonly updates = new Map<string, Uint8Array[]>();
  readonly summaries = new Map<string, ProjectSummary>();
  readonly listeners = new Map<string, Set<(update: Uint8Array) => void>>();
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
    this.summaries.set(id, { id, name, updatedAt: 1 });
    this.updates.set(id, [state]);
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

  /** Delivers an update to everyone on a project, as another window would. */
  broadcast(id: string, update: Uint8Array) {
    for (const listener of this.listeners.get(id) ?? []) listener(update);
  }

  async remove(id: string) {
    this.summaries.delete(id);
    this.updates.delete(id);
  }
}
