import { ProjectStore, mergeUpdates } from "@animaquill/core";
import type { ProjectAddress, ProjectLibrary, ProjectLog, ProjectSummary } from "@animaquill/host";
import { CURRENT_FORMAT_VERSION, createProject } from "@animaquill/schema";
import { Emitter } from "./emitter.ts";

/**
 * A log this long is merged when the project opens. Not while people work: on a big project merging
 * takes the page away for a third of a second, and a long log costs next to nothing.
 */
const COMPACT_AFTER = 200;
/** How long to wait before trying again when saving failed and nothing else happens. */
const RETRY_AFTER_MS = 5000;

export type SaveState = "saved" | "saving" | "failed";

export interface SessionSnapshot {
  readonly store?: ProjectStore;
  readonly save: SaveState;
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
  #snapshot: SessionSnapshot = { save: "saved" };
  #log: ProjectLog | undefined;
  #stop: (() => void)[] = [];
  /** Writing happens one step at a time, in order. */
  #queue: Promise<void> = Promise.resolve();
  #unsaved: Uint8Array[] = [];
  #retry: ReturnType<typeof setTimeout> | undefined;
  #catchingUp = false;
  #readAgain = false;

  constructor(projects: ProjectLibrary, address: ProjectAddress, messages: SessionMessages) {
    this.#projects = projects;
    this.#address = address;
    this.#messages = messages;
  }

  subscribe = this.#emitter.subscribe;
  getSnapshot = (): SessionSnapshot => this.#snapshot;

  get store(): ProjectStore | undefined {
    return this.#snapshot.store;
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
   */
  async readLog(): Promise<void> {
    const log = this.#log;
    const { store } = this.#snapshot;
    if (!log || !store) return;
    let done = () => {};
    const read = new Promise<void>((resolve) => {
      done = resolve;
    });
    this.#enqueue(async () => {
      try {
        store.catchUp(await log.load());
      } finally {
        done();
      }
    });
    await read;
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
  async create(name: string): Promise<boolean> {
    const store = ProjectStore.create(createProject({ name }));
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
    const updates = await log.load();
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
    if (damaged > 0) this.#messages.damaged();

    this.#log = log;
    this.#stop = [
      store.onLocalUpdate((update) => this.#save(update)),
      log.listen((update) => this.#receive(store, log, update)),
    ];
    this.#address.write(id);
    this.#snapshot = { store, save: "saved" };
    this.#emitter.emit();
    this.#catchUp(store, log);
    if (updates.length >= COMPACT_AFTER) {
      this.#enqueue(() => log.compact((all) => store.mergeWith(all)));
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

  #save(update: Uint8Array): void {
    this.#unsaved.push(update);
    if (this.#snapshot.save !== "failed") this.#setSave("saving");
    this.#enqueue(() => this.#flush());
  }

  async #flush(): Promise<void> {
    const log = this.#log;
    const { store } = this.#snapshot;
    if (!log || !store || this.#unsaved.length === 0) return;
    const batch = this.#unsaved;
    this.#unsaved = [];
    const update = batch.length === 1 ? (batch[0] as Uint8Array) : mergeUpdates(batch);
    try {
      await log.append(update, store.getState().manifest.name);
    } catch (error) {
      console.warn("Change could not be saved", error);
      this.#unsaved = [update, ...this.#unsaved];
      if (this.#snapshot.save !== "failed") this.#messages.saveFailed();
      this.#setSave("failed");
      clearTimeout(this.#retry);
      this.#retry = setTimeout(() => void this.trySave(), RETRY_AFTER_MS);
      return;
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
