import { ProjectStore, mergeUpdates } from "@animaquill/core";
import type { ProjectLibrary, ProjectLog, ProjectSummary, SettingsStore } from "@animaquill/host";
import { CURRENT_FORMAT_VERSION, createProject } from "@animaquill/schema";
import { Emitter } from "./emitter.ts";
import { readSetting } from "./settings.ts";

const SETTINGS_KEY = "session";
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
  openFailed(): void;
  tooNew(): void;
  damaged(): void;
  saveFailed(): void;
  saveRecovered(): void;
}

function parseSaved(value: unknown): { last: string | null } | undefined {
  const last = (value as { last?: unknown } | null)?.last;
  return typeof last === "string" || last === null ? { last } : undefined;
}

/**
 * The project that is open, and keeping it safe. Every change goes to the host at once. A change
 * that cannot be saved stays here and is tried again, so nothing is lost as long as the page is
 * open, and people are told.
 */
export class ProjectSession {
  readonly #projects: ProjectLibrary;
  readonly #settings: SettingsStore;
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

  constructor(projects: ProjectLibrary, settings: SettingsStore, messages: SessionMessages) {
    this.#projects = projects;
    this.#settings = settings;
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

  list(): Promise<readonly ProjectSummary[]> {
    return this.#projects.list();
  }

  /** Opens the project of the last visit, if it is still there. */
  async restore(): Promise<void> {
    const reading = await readSetting(this.#settings, SETTINGS_KEY, parseSaved);
    if (reading.kind !== "ok" || reading.value.last === null) return;
    const { last } = reading.value;
    const projects = await this.list().catch(() => []);
    if (projects.some((project) => project.id === last)) await this.open(last);
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
    this.#snapshot = { save: "saved" };
    this.#emitter.emit();
    await this.#remember(null);
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
    this.#snapshot = { store, save: "saved" };
    this.#emitter.emit();
    if (updates.length >= COMPACT_AFTER) {
      this.#enqueue(() => log.compact((all) => store.mergeWith(all)));
    }
    await this.#remember(id);
    return true;
  }

  async #remember(last: string | null): Promise<void> {
    await this.#settings.save(SETTINGS_KEY, { last }).catch((error: unknown) => {
      console.warn("Could not remember the project", error);
    });
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

  /** Should a change from another window have gone missing, the log still has it. */
  #receive(store: ProjectStore, log: ProjectLog, update: Uint8Array): void {
    store.applyUpdates([update]);
    if (!store.isMissingUpdates || this.#catchingUp) return;
    this.#catchingUp = true;
    this.#enqueue(async () => {
      try {
        store.applyUpdates(await log.load());
      } finally {
        this.#catchingUp = false;
      }
    });
  }
}
