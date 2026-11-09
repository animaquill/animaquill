import {
  Trial,
  type ProjectStore,
  type PropertyEdit,
  type TrialChanges,
  type TrialNotice,
} from "@animaquill/core";
import type { SettingsStore, TrialStore } from "@animaquill/host";
import type { PropertyValue } from "@animaquill/schema";
import type { TimelineEditor } from "../timeline/editor.ts";
import { Emitter } from "../workbench/emitter.ts";
import { PlaceKeeper } from "../workbench/keeper.ts";
import { projectKeyOf, type ProjectSession } from "../workbench/session.ts";
import { readSetting } from "../workbench/settings.ts";

/** What the picture shows instead of the project, by clip and then by property path. */
export type PreviewedValues = ReadonlyMap<string, ReadonlyMap<string, PropertyValue | undefined>>;

export interface TrialSnapshot {
  /** Whether people want edits to wait for them to save. Part of their settings. */
  readonly enabled: boolean;
  /** How many properties are being tried out. */
  readonly count: number;
  /** How many of those somebody else changed in the meantime. */
  readonly conflicts: number;
  /** How many wait for their clip to come back. They do not count as being tried. */
  readonly setAside: number;
  /** Showing what is saved, to compare it with what is being tried. */
  readonly comparing: boolean;
}

export interface TrialMessages {
  commandFailed(message: string): void;
  /** Saving went over what somebody else wrote in the meantime. */
  overwrote(count: number): void;
  discarded(count: number): void;
  /** What cannot be used for now, because its clip went away or its keys do not fit on it. */
  setAside(count: number): void;
  /** What is back from that. */
  back(count: number): void;
  /** There was too much of it, so what had waited longest went. */
  asideDropped(count: number): void;
  /** Another window changed a clip in a way that cannot be told apart, so nothing moved here. */
  unsure(): void;
  restored(count: number): void;
  /** What could not come back. */
  dropped(count: number): void;
  /** What was kept could not be read. It stays where it is, and gets tried again. */
  readFailed(): void;
  /** This device cannot hold what is being tried, so that a reload would lose it. */
  keepFailed(): void;
  keepRecovered(): void;
}

const SETTINGS_KEY = "trial";
const SETTINGS_VERSION = 1;
const NOTHING: PreviewedValues = new Map();
const NO_CHANGES: TrialChanges = new Map();

function parseSaved(value: unknown): boolean | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { version, enabled } = value as { version?: unknown; enabled?: unknown };
  return version === SETTINGS_VERSION && typeof enabled === "boolean" ? enabled : undefined;
}

/**
 * What is being tried out on the open project, and keeping it safe. A window has this on its own: it
 * is there before anything is saved, and other windows and AI only get to see what comes out of it.
 */
export class TrialSession {
  readonly #session: ProjectSession;
  readonly #timeline: TimelineEditor;
  readonly #trials: TrialStore;
  readonly #settings: SettingsStore;
  readonly #messages: TrialMessages;
  readonly #emitter = new Emitter();
  #snapshot: TrialSnapshot = {
    enabled: true,
    count: 0,
    conflicts: 0,
    setAside: 0,
    comparing: false,
  };
  #store: ProjectStore | undefined;
  #trial: Trial | undefined;
  #keeper: PlaceKeeper | undefined;
  /** What the values for the picture were made from. */
  #changes = NO_CHANGES;
  /** What was put on the device the last time. */
  #kept = NO_CHANGES;
  #values = NOTHING;
  /** Until this is over, the place of the project before is taken. */
  #leaving: Promise<void> = Promise.resolve();

  constructor(
    session: ProjectSession,
    timeline: TimelineEditor,
    trials: TrialStore,
    settings: SettingsStore,
    messages: TrialMessages,
  ) {
    this.#session = session;
    this.#timeline = timeline;
    this.#trials = trials;
    this.#settings = settings;
    this.#messages = messages;
    session.subscribe(() => this.#followSession());
    this.#followSession();
  }

  subscribe = this.#emitter.subscribe;
  getSnapshot = (): TrialSnapshot => this.#snapshot;

  async load(): Promise<void> {
    const reading = await readSetting(this.#settings, SETTINGS_KEY, parseSaved);
    if (reading.kind === "ok") this.#show({ enabled: reading.value });
    this.#settings.listen(SETTINGS_KEY, (value) => {
      const enabled = parseSaved(value);
      if (enabled !== undefined) this.#show({ enabled });
    });
  }

  setEnabled(enabled: boolean): void {
    this.#show({ enabled });
    this.#settings
      .save(SETTINGS_KEY, { version: SETTINGS_VERSION, enabled })
      .catch((error: unknown) => console.warn("The setting could not be saved", error));
  }

  /**
   * Whether edits go here. Something that is being tried stays in charge until it is saved or given
   * up on, also when the setting changed: writing under it would show nothing.
   */
  get takesEdits(): boolean {
    const { enabled, count } = this.#snapshot;
    return this.#trial !== undefined && (enabled || count > 0);
  }

  /** What the properties tab shows on top of the project. Nothing while comparing. */
  get look(): Trial | undefined {
    return this.#snapshot.comparing ? undefined : this.#trial;
  }

  /** What the picture shows on top of the project. It stays the same object until it changes. */
  getValues = (): PreviewedValues => (this.#snapshot.comparing ? NOTHING : this.#values);

  /** Whether closing the page now would lose what is being tried, or what is set aside. */
  get notKept(): boolean {
    const keeper = this.#keeper;
    const { count, setAside } = this.#snapshot;
    return keeper !== undefined && count + setAside > 0 && (keeper.failed || keeper.isBusy);
  }

  write(edits: readonly PropertyEdit[]): boolean {
    const result = this.#trial?.write(edits);
    if (result && !result.ok) this.#messages.commandFailed(result.error.message);
    if (result?.ok) this.#show({ comparing: false });
    return result?.ok === true;
  }

  /**
   * Says whether everything is in the project now. It stays on the device until the project is, so
   * that a crash or a full disk in between does not cost anything: what comes back then and turns
   * out to be in the project after all gets written off.
   */
  save(): boolean {
    const keeper = this.#keeper;
    keeper?.pause();
    const result = this.#trial?.save();
    if (result?.ok === false) this.#messages.commandFailed(result.error.message);
    if (result?.ok && result.overwritten > 0) this.#messages.overwrote(result.overwritten);
    if (result?.ok !== true || !this.#session.hasUnsavedChanges) keeper?.resume();
    return result?.ok !== false;
  }

  discard(): void {
    const { count, setAside } = this.#snapshot;
    if (count + setAside === 0) return;
    this.#trial?.discard();
    this.#messages.discarded(count + setAside);
  }

  discardProperty(clip: string, path: string): void {
    this.#trial?.discard({ clip, path });
  }

  /** Between what is being tried and what is saved. */
  toggleCompare(): void {
    const { comparing, count } = this.#snapshot;
    if (count > 0 || comparing) this.#show({ comparing: !comparing });
  }

  get canUndo(): boolean {
    return this.#trial?.canUndo === true;
  }

  get canRedo(): boolean {
    return this.#trial?.canRedo === true;
  }

  /** Whether undo is about what is being tried, or about the project. */
  get undoesFirst(): boolean {
    return this.#trial?.undoesFirst === true;
  }

  get redoesFirst(): boolean {
    return this.#trial?.redoesFirst === true;
  }

  undo(): void {
    this.#trial?.undo();
    this.#show({ comparing: false });
  }

  redo(): void {
    this.#trial?.redo();
    this.#show({ comparing: false });
  }

  /** Waits for what was kept to come back and for what is new to be kept. Resolves to whether it is. */
  async settle(): Promise<boolean> {
    return (await this.#keeper?.settled()) !== false;
  }

  #followSession(): void {
    const { store } = this.#session;
    if (store === this.#store) {
      if (!this.#session.hasUnsavedChanges) this.#keeper?.resume();
      return;
    }
    this.#trial?.dispose();
    this.#leaving = this.#keeper?.close() ?? this.#leaving;
    this.#store = store;
    this.#trial = undefined;
    this.#keeper = undefined;
    const timeline = this.#timeline.model?.id;
    const trial = store && timeline !== undefined ? this.#open(store, timeline) : undefined;
    // Nothing has changed yet: what was kept stays as it is at least until it has come back.
    this.#changes = trial?.changes ?? NO_CHANGES;
    this.#kept = trial?.kept ?? NO_CHANGES;
    this.#values = NOTHING;
    this.#show({ count: 0, conflicts: 0, setAside: 0, comparing: false }, true);
  }

  #open(store: ProjectStore, timeline: string): Trial {
    const trial = new Trial(store, timeline);
    const id = projectKeyOf(store);
    const leaving = this.#leaving;
    const open = () => leaving.then(() => this.#trials.open(id));
    this.#trial = trial;
    trial.subscribe(() => this.#update());
    trial.onNotice((notice) => this.#tell(notice));
    const keeper = new PlaceKeeper(
      () => trial.toStored(),
      open,
      this.#messages,
      (kept) => {
        const { restored, dropped, stale, unreadable } = trial.restore(kept);
        if (restored > 0) this.#messages.restored(restored);
        if (dropped > 0 || unreadable) this.#messages.dropped(dropped);
        // Saying this again every time the project opens would help nobody, and what is of no use
        // would come back later on, after the project moved on from it.
        if (dropped > 0 || unreadable || stale > 0) keeper.keep();
      },
    );
    this.#keeper = keeper;
    return trial;
  }

  #tell(notice: TrialNotice): void {
    if (notice.kind === "aside") this.#messages.setAside(notice.count);
    else if (notice.kind === "back") this.#messages.back(notice.count);
    else if (notice.kind === "dropped") this.#messages.asideDropped(notice.count);
    else this.#messages.unsure();
  }

  /** The same numbers can stand for other values, which is what `anyway` is for. */
  #show(changes: Partial<TrialSnapshot>, anyway = false): void {
    const snapshot = this.#snapshot;
    const next = { ...snapshot, ...changes };
    const keys = Object.keys(next) as (keyof TrialSnapshot)[];
    if (!anyway && keys.every((key) => next[key] === snapshot[key])) return;
    this.#snapshot = next;
    this.#emitter.emit();
  }

  #update(): void {
    const trial = this.#trial;
    const changes = trial?.changes ?? NO_CHANGES;
    const kept = trial?.kept ?? NO_CHANGES;
    const changed = changes !== this.#changes;
    if (changed) {
      this.#changes = changes;
      this.#values = new Map(
        [...changes].map(([clip, held]) => [
          clip,
          new Map([...held].map(([path, { value }]) => [path, value])),
        ]),
      );
    }
    if (kept !== this.#kept) {
      this.#kept = kept;
      this.#keeper?.keep();
    }
    const count = trial?.count ?? 0;
    const conflicts = trial?.conflicts ?? 0;
    const setAside = trial?.setAside ?? 0;
    const comparing = this.#snapshot.comparing && count > 0;
    this.#show({ count, conflicts, setAside, comparing }, changed);
  }
}
