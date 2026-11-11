import {
  ProjectStore,
  cloudSeqOf,
  isEmptyUpdate,
  mergeUpdates,
  sourceKindOf,
  type Origin,
} from "@animaquill/core";
import type {
  ChangeSource,
  LogEntry,
  ProjectAddress,
  ProjectLibrary,
  ProjectLog,
  ProjectSummary,
} from "@animaquill/host";
import { CURRENT_FORMAT_VERSION, createProject, type NewProject } from "@animaquill/schema";
import { Emitter } from "./emitter.ts";

/**
 * A log this long is merged when the project opens. Not while people work: on a big project merging
 * takes the page away for a third of a second, and a long log costs next to nothing.
 */
const COMPACT_AFTER = 200;
/** How long to wait before trying again when saving failed and nothing else happens. */
const RETRY_AFTER_MS = 5000;

export type SaveState = "saved" | "saving" | "failed";

/** What sessions opened their stores as, see `SessionSnapshot.key`. */
const keys = new WeakMap<ProjectStore, string>();

/**
 * What this browser keeps the project of a store by, see `SessionSnapshot.key`: everything that is
 * kept of a project in this browser goes by it, never by the id of the project. It stays with the
 * store, also while another project opens. A store that no session opened is kept by its id.
 */
export const projectKeyOf = (store: ProjectStore): string =>
  keys.get(store) ?? store.getState().manifest.id;

export interface SessionSnapshot {
  readonly store?: ProjectStore;
  /**
   * What this browser keeps the open project by: its log, and everything else this browser has of
   * it, such as what is being tried. For a project in a folder the number of the folder, see
   * `FolderRecord.id`, as copies of a folder have the same project id; for a project in the browser
   * its id.
   */
  readonly key?: string;
  readonly save: SaveState;
}

/** A change on its way into the log, with who made it. */
interface Unsaved {
  readonly update: Uint8Array;
  readonly source: ChangeSource;
}

/**
 * Whether two changes in a row can be one entry of the log. What came from a platform in a row is
 * one, with the number of the last: thousands of them, after a while away, are one write.
 */
const isSameSource = (a: ChangeSource, b: ChangeSource) =>
  a.kind === b.kind && a.window === b.window && (a.kind === "cloud" || a.seq === b.seq);

/** What syncing a project with a platform needs of its log, see `ProjectSession.journal`. */
export interface Journal {
  /** What the log has after a mark, see `ProjectLog.entries`. Undefined where the host keeps no marks. */
  entries(after?: number): Promise<readonly LogEntry[]> | undefined;
  /** Hears that something new is in the log: from this window, or from another one. */
  onChange(listener: () => void): () => void;
  /** Resolves once every change made so far is in the log, to whether it is. */
  saved(): Promise<boolean>;
  /** Takes in what the log has that the project does not, see `ProjectSession.readLog`. */
  readLog(): Promise<void>;
  /** How many entries of the log could not be read when the project opened here. */
  damaged(): number;
  /**
   * Puts into the log, as one entry, what the project has and a window that opened from a log that
   * lost something does not, by its state vector: it gets that from there.
   */
  refill(theirs: Uint8Array): Promise<void>;
}

export interface SessionOptions {
  /** Which window this is, for who made a change, see `ChangeSource.window`. */
  readonly window?: string;
  /**
   * How far the log of a project may be made shorter when it opens: up to this mark, see
   * `ProjectLog.compact`, or all of it when this says undefined. What a platform does not have yet
   * has to stay as it is.
   */
  readonly compactThrough?: (key: string) => Promise<number | undefined>;
  /** For tests: how long a log gets before it is made shorter when the project opens. */
  readonly compactAfter?: number;
}

export interface SessionMessages {
  createFailed(): void;
  notFound(): void;
  openFailed(): void;
  tooNew(): void;
  damaged(): void;
  saveFailed(): void;
  saveRecovered(): void;
}

/**
 * The project that is open, and keeping it safe. Every change goes to the host at once. A change
 * that cannot be saved stays here and is tried again, so nothing is lost as long as the page is
 * open, and people are told.
 */
export class ProjectSession {
  readonly #projects: ProjectLibrary;
  readonly #address: ProjectAddress;
  readonly #messages: SessionMessages;
  readonly #emitter = new Emitter();
  readonly #options: SessionOptions;
  #snapshot: SessionSnapshot = { save: "saved" };
  #log: ProjectLog | undefined;
  #stop: (() => void)[] = [];
  /** Writing happens one step at a time, in order. */
  #queue: Promise<void> = Promise.resolve();
  #unsaved: Unsaved[] = [];
  #retry: ReturnType<typeof setTimeout> | undefined;
  #catchingUp = false;
  #readAgain = false;
  /** The last update of a platform that the project has, as far as this window knows, see `cloudSeq`. */
  #cloudSeq: number | undefined;
  readonly #journalListeners = new Set<() => void>();

  constructor(
    projects: ProjectLibrary,
    address: ProjectAddress,
    messages: SessionMessages,
    options: SessionOptions = {},
  ) {
    this.#projects = projects;
    this.#address = address;
    this.#messages = messages;
    this.#options = options;
  }

  /**
   * The last update of the platform that the open project has, which every change made here from
   * now on says it was made on, see `ChangeSource.seq`. Whoever knows tells, such as the window that
   * syncs. Undefined while the project is not connected to one.
   */
  get cloudSeq(): number | undefined {
    return this.#cloudSeq;
  }

  set cloudSeq(seq: number | undefined) {
    this.#cloudSeq = seq === undefined ? undefined : Math.max(this.#cloudSeq ?? 0, seq);
  }

  /** The log of the open project, as syncing it with a platform needs it. */
  readonly journal: Journal = {
    entries: (after) => this.#log?.entries?.(after),
    onChange: (listener) => {
      this.#journalListeners.add(listener);
      return () => this.#journalListeners.delete(listener);
    },
    saved: () => this.trySave(),
    readLog: () => this.readLog(),
    damaged: () => this.#damaged,
    refill: (theirs) =>
      new Promise<void>((resolve, reject) => {
        const log = this.#log;
        const { store } = this.#snapshot;
        if (!log || !store) {
          resolve();
          return;
        }
        this.#enqueue(async () => {
          try {
            // Only what that window lacks: the log does not grow by the whole project each time.
            const missing = store.diffSince(theirs);
            if (!isEmptyUpdate(missing)) {
              await log.append(missing, store.getState().manifest.name, { kind: "merged" });
            }
            resolve();
          } catch (error) {
            reject(error);
          }
        });
      }),
  };
  /** See `Journal.damaged`. */
  #damaged = 0;

  #journalChanged(): void {
    for (const listener of this.#journalListeners) listener();
  }

  subscribe = this.#emitter.subscribe;
  getSnapshot = (): SessionSnapshot => this.#snapshot;

  get store(): ProjectStore | undefined {
    return this.#snapshot.store;
  }

  /** See `SessionSnapshot.key`. */
  get key(): string | undefined {
    return this.#snapshot.key;
  }

  /** Whether closing the page now would lose something. */
  get hasUnsavedChanges(): boolean {
    return this.#snapshot.save !== "saved";
  }

  /** Saves whatever is still waiting. Resolves to whether everything is saved now. */
  async trySave(): Promise<boolean> {
    this.#enqueue(() => this.#flush());
    await this.#idle();
    return !this.hasUnsavedChanges;
  }

  /**
   * Takes in everything the log has that the project does not have yet, such as what another window
   * wrote just before it let go of the project folder, and has not arrived here. Resolves once it is
   * in: whoever writes the folder next has to have it, or would take it for a change from outside.
   * Rejects when the log cannot be read, and then that cannot be known.
   */
  readLog(): Promise<void> {
    const log = this.#log;
    const { store } = this.#snapshot;
    if (!log || !store) return Promise.reject(new Error("No project is open"));
    return new Promise<void>((resolve, reject) => {
      this.#enqueue(async () => {
        try {
          store.catchUp(await log.load());
          resolve();
        } catch (error) {
          reject(error);
        }
      });
    });
  }

  list(): Promise<readonly ProjectSummary[]> {
    return this.#projects.list();
  }

  /** Opens the project this window shows, if any. */
  async restore(): Promise<void> {
    const id = this.#address.read();
    if (id !== undefined) await this.open(id);
  }

  /** Resolves to whether the project was created and opened. */
  /** `format`: the first format of the project, see `newFormat`; the usual one without it. */
  async create(name: string, format?: NewProject["format"]): Promise<boolean> {
    const store = ProjectStore.create(createProject({ name, ...(format && { format }) }));
    const { id } = store.getState().manifest;
    const state = store.encodeState();
    store.destroy();
    try {
      await this.#projects.create({ id, name }, state);
    } catch (error) {
      console.warn("Project could not be created", error);
      this.#messages.createFailed();
      return false;
    }
    return this.open(id);
  }

  /** Resolves to whether the project is open. */
  async open(id: string): Promise<boolean> {
    await this.close();
    let log: ProjectLog | undefined;
    try {
      log = await this.#projects.open(id);
      if (await this.#adopt(id, log)) return true;
    } catch (error) {
      console.warn("Project could not be read", error);
      this.#messages.openFailed();
    }
    log?.close();
    return false;
  }

  /** Waits for what is being written, then lets go. Anything that could not be saved is lost. */
  async close(): Promise<void> {
    const { store } = this.#snapshot;
    if (!store) return;
    await this.#idle();
    clearTimeout(this.#retry);
    for (const stop of this.#stop) stop();
    this.#stop = [];
    store.destroy();
    this.#log?.close();
    this.#log = undefined;
    this.#unsaved = [];
    this.#cloudSeq = undefined;
    this.#address.write(undefined);
    this.#snapshot = { save: "saved" };
    this.#emitter.emit();
  }

  async remove(id: string): Promise<void> {
    await this.#projects.remove(id);
  }

  async #adopt(id: string, log: ProjectLog): Promise<boolean> {
    // Listening starts before reading: one change that slips through in between would hold back
    // every later change of that window, which only make sense on top of it.
    const early: Uint8Array[] = [];
    const stopEarly = log.listen((update) => early.push(update));
    // With where each is, where the host keeps that: what comes after the last one is not made
    // shorter now, whatever happens meanwhile, such as the project getting connected elsewhere.
    const entries = await log.entries?.();
    const updates = entries ? entries.map((entry) => entry.update) : await log.load();
    const lastMark = entries?.at(-1)?.mark;
    if (updates.length === 0) {
      // Other failures keep the address, so that a reload tries again. This one never will work.
      this.#address.write(undefined);
      this.#messages.notFound();
      return false;
    }
    const { store, damaged } = ProjectStore.fromUpdates(updates);
    if (!store) throw new Error(`Nothing usable is saved for project ${id}`);
    if (store.getState().manifest.formatVersion > CURRENT_FORMAT_VERSION) {
      store.destroy();
      this.#messages.tooNew();
      return false;
    }
    stopEarly();
    store.applyUpdates(early);
    this.#damaged = damaged;
    if (damaged > 0) this.#messages.damaged();

    this.#log = log;
    keys.set(store, id);
    this.#stop = [
      store.onLocalUpdate((update, origin) => this.#save(update, origin)),
      log.listen((update) => {
        this.#receive(store, log, update);
        this.#journalChanged();
      }),
    ];
    this.#address.write(id);
    this.#snapshot = { store, key: id, save: "saved" };
    this.#emitter.emit();
    this.#catchUp(store, log);
    if (updates.length >= (this.#options.compactAfter ?? COMPACT_AFTER)) {
      this.#enqueue(async () => {
        const allowed = await this.#options.compactThrough?.(id);
        const through =
          allowed === undefined
            ? lastMark
            : lastMark === undefined
              ? allowed
              : Math.min(allowed, lastMark);
        await log.compact((all) => store.mergeWith(all), through === undefined ? {} : { through });
      });
    }
    return true;
  }

  #enqueue(work: () => Promise<void>): void {
    this.#queue = this.#queue.then(work).catch((error: unknown) => {
      console.warn("Project log could not be updated", error);
    });
  }

  /** Work can add more work, so one look at the queue is not enough. */
  async #idle(): Promise<void> {
    let seen;
    do {
      seen = this.#queue;
      await seen;
    } while (seen !== this.#queue);
  }

  #setSave(save: SaveState): void {
    if (save === this.#snapshot.save) return;
    this.#snapshot = { ...this.#snapshot, save };
    this.#emitter.emit();
  }

  /** Who made a change, as the log keeps it, see `ChangeSource`. */
  #sourceOf(origin: Origin): ChangeSource {
    const kind = sourceKindOf(origin);
    const window = this.#options.window;
    const seq = kind === "cloud" ? cloudSeqOf(origin) : this.#cloudSeq;
    if (kind === "cloud" && seq !== undefined) this.cloudSeq = seq;
    return {
      kind,
      ...(window !== undefined && kind !== "cloud" && { window }),
      at: Date.now(),
      ...(seq !== undefined && { seq }),
    };
  }

  #save(update: Uint8Array, origin: Origin): void {
    this.#unsaved.push({ update, source: this.#sourceOf(origin) });
    if (this.#snapshot.save !== "failed") this.#setSave("saving");
    this.#enqueue(() => this.#flush());
  }

  /**
   * Writes what waits, as few entries as it takes: changes in a row of the same maker are one. Each
   * maker keeps its own, so that whoever sends them on can tell who made what.
   */
  async #flush(): Promise<void> {
    const log = this.#log;
    const { store } = this.#snapshot;
    if (!log || !store || this.#unsaved.length === 0) return;
    while (this.#unsaved.length > 0) {
      const first = this.#unsaved[0] as Unsaved;
      let count = 1;
      while (count < this.#unsaved.length) {
        if (!isSameSource((this.#unsaved[count] as Unsaved).source, first.source)) break;
        count += 1;
      }
      const run = this.#unsaved.slice(0, count);
      const update =
        run.length === 1 ? first.update : mergeUpdates(run.map((unsaved) => unsaved.update));
      const { source } = run.at(-1) as Unsaved;
      try {
        await log.append(update, store.getState().manifest.name, source);
      } catch (error) {
        console.warn("Change could not be saved", error);
        // What came meanwhile stays behind it, in order.
        this.#unsaved = [{ update, source }, ...this.#unsaved.slice(count)];
        if (this.#snapshot.save !== "failed") this.#messages.saveFailed();
        this.#setSave("failed");
        clearTimeout(this.#retry);
        this.#retry = setTimeout(() => void this.trySave(), RETRY_AFTER_MS);
        return;
      }
      this.#unsaved = this.#unsaved.slice(count);
      this.#journalChanged();
    }
    clearTimeout(this.#retry);
    const recovered = this.#snapshot.save === "failed";
    this.#setSave(this.#unsaved.length === 0 ? "saved" : "saving");
    if (recovered) this.#messages.saveRecovered();
  }

  #receive(store: ProjectStore, log: ProjectLog, update: Uint8Array): void {
    store.applyUpdates([update]);
    this.#catchUp(store, log);
  }

  /**
   * Should a change from another window have gone missing, the log still has it. Until the log was
   * read the project takes no changes. What arrives in the meantime can need something that was
   * written after reading, so reading goes on until nothing else came in.
   */
  #catchUp(store: ProjectStore, log: ProjectLog): void {
    if (!store.isMissingUpdates) return;
    this.#readAgain = true;
    if (this.#catchingUp) return;
    this.#catchingUp = true;
    this.#enqueue(async () => {
      try {
        for (;;) {
          this.#readAgain = false;
          const updates = await log.load();
          if (!this.#readAgain) {
            store.catchUp(updates);
            break;
          }
          store.applyUpdates(updates);
        }
      } finally {
        this.#catchingUp = false;
      }
    });
  }
}
