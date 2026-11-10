import { USER, folderBatch, type Origin, type ProjectStore } from "@animaquill/core";
import { Emitter } from "./emitter.ts";

/** Who an operation comes from, as this window sees it. */
export type OperationSource = "you" | "ai" | "folder" | "other";

/** One thing that changed the project, as the list of what happened shows it. */
export interface Operation {
  /** Unique in this window, for keys. */
  readonly id: number;
  readonly source: OperationSource;
  /** Where it came from: an AI task or a batch of files, which undo takes back as a whole. */
  readonly origin: Origin | undefined;
  /** The commands it ran, in order. Empty for what another window did. */
  readonly commands: readonly string[];
  /** The properties it changed, by path, as the project keeps them. */
  readonly properties: readonly string[];
  /** How many changes an AI task made, or how many files a batch from the folder brought. */
  readonly count: number;
  /** When it happened, or last happened for an AI task, in milliseconds since 1970. */
  readonly time: number;
  /** It was taken back, and can be done again. */
  readonly undone: boolean;
  /**
   * For what people did here: the step of the store that stands for it, see
   * `ProjectStore.lastStep`. Undo and redo give it a new one.
   */
  readonly step: number;
}

/** How many operations the list keeps. */
export const OPERATIONS_SHOWN = 30;

/** Where the store comes from: the project session, or anything with the same shape in a test. */
export interface StoreSource {
  subscribe(listener: () => void): () => void;
  getSnapshot(): { readonly store?: ProjectStore | undefined };
}

/** The file a change of a path is written to, near enough to count the files of a batch. */
function fileOf(path: readonly string[]): string {
  const [top = "", id = ""] = path;
  return ["files", "timelines", "scenes", "sounds", "transitions", "effects"].includes(top)
    ? `${top}/${id}`
    : top;
}

/** The properties that some changes are about, by the path that follows `properties`. */
function propertiesOf(paths: readonly (readonly string[])[]): readonly string[] {
  const found = new Set<string>();
  for (const path of paths) {
    const at = path.indexOf("properties");
    const property = at >= 0 ? path[at + 1] : undefined;
    if (property !== undefined) found.add(property);
  }
  return [...found];
}

const sourceOf = (origin: Origin): OperationSource =>
  origin === USER ? "you" : origin.startsWith(folderBatch("")) ? "folder" : "ai";

/**
 * What changed the open project lately, newest first, for the status bar: what people did here,
 * one at a time; each AI task and each batch of files from the folder as one; and what other
 * windows did. It follows undo and redo, which take back what people did here one step at a time,
 * so that the list says what can still be taken back and done again. It goes by what the store
 * tells its listeners, and starts afresh with every project. Nothing of it is saved.
 */
export class OperationLog {
  readonly #emitter = new Emitter();
  #store: ProjectStore | undefined;
  #unsubscribe: (() => void) | undefined;
  #revision = 0;
  #next = 1;
  /** Oldest first. */
  #operations: Operation[] = [];
  #snapshot: readonly Operation[] = [];
  #pending = false;

  constructor(source: StoreSource) {
    const follow = () => this.#attach(source.getSnapshot().store);
    source.subscribe(follow);
    follow();
  }

  subscribe = this.#emitter.subscribe;

  /** Newest first, at most `OPERATIONS_SHOWN`. */
  getSnapshot = (): readonly Operation[] => this.#snapshot;

  #attach(store: ProjectStore | undefined): void {
    if (store === this.#store) return;
    this.#unsubscribe?.();
    this.#store = store;
    this.#operations = [];
    this.#revision = store?.revision ?? 0;
    this.#unsubscribe = store?.subscribe(() => this.#heard(store));
    this.#show();
  }

  #heard(store: ProjectStore): void {
    if (store.revision === this.#revision) return;
    this.#revision = store.revision;
    const { change } = store;
    if (!change) {
      this.#add({ source: "other", origin: undefined, commands: [], properties: [], count: 1 });
      return;
    }
    const { origin, takesBack, step, back } = change;
    const source = sourceOf(origin);
    if (takesBack) {
      const undone = takesBack === "undo";
      const operation =
        source === "you"
          ? this.#operations.find((known) => known.source === "you" && known.step === back)
          : this.#operations.findLast((known) => known.origin === origin);
      if (operation) this.#replace(operation, { ...operation, undone, step });
      this.#show();
      return;
    }
    // A new step of a person leaves nothing to do again, as the store forgets it too.
    if (source === "you") {
      this.#operations = this.#operations.filter(
        (known) => known.source !== "you" || !known.undone,
      );
    }
    // The history has the commands only once the change is written, after the listeners.
    const revision = store.revision;
    this.#later(() => {
      const entry = store.history.findLast((known) => known.revision === revision);
      const commands = entry?.commands ?? [];
      const paths = entry?.patches.map(({ path }) => path) ?? [];
      const properties = propertiesOf(paths);
      if (source === "you") {
        this.#add({ source, origin, commands, properties, count: 1, step });
        return;
      }
      const known = this.#operations.findLast((operation) => operation.origin === origin);
      const files = new Set(paths.map(fileOf)).size;
      const count = source === "folder" ? files : commands.length;
      if (known) {
        this.#operations = this.#operations.filter((operation) => operation !== known);
        const merged = new Set([...known.properties, ...properties]);
        this.#add({
          source,
          origin,
          commands: [...known.commands, ...commands],
          properties: [...merged],
          count: known.count + count,
        });
      } else {
        this.#add({ source, origin, commands, properties, count });
      }
    });
  }

  /** After the store has finished writing down the change it tells about. */
  #later(run: () => void): void {
    const store = this.#store;
    queueMicrotask(() => {
      if (this.#store === store) run();
    });
  }

  #add(fields: Omit<Operation, "id" | "time" | "undone" | "step"> & { step?: number }): void {
    this.#operations.push({
      step: 0,
      ...fields,
      id: this.#next++,
      time: Date.now(),
      undone: false,
    });
    // What was done and taken back is kept a while longer than the list shows, for redo.
    if (this.#operations.length > OPERATIONS_SHOWN * 2) {
      this.#operations = this.#operations.slice(-OPERATIONS_SHOWN * 2);
    }
    this.#show();
  }

  #replace(old: Operation, next: Operation): void {
    this.#operations = this.#operations.map((operation) => (operation === old ? next : operation));
  }

  #show(): void {
    if (this.#pending) return;
    this.#pending = true;
    // One change can be heard several times over; the list changes once.
    queueMicrotask(() => {
      this.#pending = false;
      this.#snapshot = this.#operations.toReversed().slice(0, OPERATIONS_SHOWN);
      this.#emitter.emit();
    });
  }

  /**
   * Whether what people did here can be taken back from the list: it has not been undone, the
   * store still has it, and nothing between it and now is gone.
   */
  canUndoTo(operation: Operation): boolean {
    const store = this.#store;
    if (!store || operation.source !== "you" || operation.undone) return false;
    return store.canUndo && operation.step <= store.lastStep;
  }

  /** The step of people here that redo would do again: the one taken back last. */
  get redoable(): Operation | undefined {
    if (this.#store?.canRedo !== true) return undefined;
    const taken = this.#operations.filter(({ source, undone }) => source === "you" && undone);
    return taken.reduce<Operation | undefined>(
      (last, operation) => (last && last.step > operation.step ? last : operation),
      undefined,
    );
  }

  /** Whether an AI task or a batch of files can be taken back, or done again, as a whole. */
  canUndoOrigin(operation: Operation): boolean {
    const { origin } = operation;
    return origin !== undefined && this.#store?.canUndoOrigin(origin) === true;
  }

  canRedoOrigin(operation: Operation): boolean {
    const { origin } = operation;
    return origin !== undefined && this.#store?.canRedoOrigin(origin) === true;
  }

  /** The newest operation, which the status bar names. */
  get last(): Operation | undefined {
    return this.#snapshot[0];
  }

  destroy(): void {
    this.#unsubscribe?.();
  }
}
