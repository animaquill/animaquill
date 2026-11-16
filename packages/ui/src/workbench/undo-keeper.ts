import {
  STORAGE,
  USER,
  isFileBatch,
  type ManyUndoResult,
  type Origin,
  type ProjectStore,
  type UndoObstacle,
  type UndoResult,
} from "@animaquill/core";
import type { UndoGone, UndoStore, UndoUsage } from "@animaquill/host";
import { Emitter } from "./emitter.ts";

/** What lists show of an AI task or a batch of files whose changes can be taken back. */
export interface UndoAbout {
  readonly kind: "ai" | "folder";
  /** How many changes it made, or how many files it brought. */
  readonly count: number;
  /** When it changed the project first and last, in milliseconds since 1970. */
  readonly from: number;
  readonly to: number;
  /** What people asked AI for. */
  readonly label?: string;
  /** The AI tool on this computer that wrote the files, by its name. */
  readonly tool?: string;
  /** The files of a batch, so that what the folder has goes somewhere safe before it is taken back. */
  readonly files?: readonly string[];
}

/** One AI task or batch whose undo log came back from before the page was loaded. */
export interface RestoredUndo {
  readonly origin: Origin;
  readonly about: UndoAbout;
}

/**
 * Why the changes of an origin cannot be taken back or done again here: everything was changed
 * since, or is in use; its log went, as the newest 50 or 30 days are kept; or it was made on
 * another device, which has its log.
 */
export type UndoWhyNot = UndoObstacle | UndoGone | "elsewhere";

export interface UndoState {
  readonly direction: "undo" | "redo" | undefined;
  readonly whyNot?: UndoWhyNot;
}

export interface UndoKeeperSnapshot {
  /** Logs that came back from before the page was loaded, the oldest first. */
  readonly restored: readonly RestoredUndo[];
  /** Counts up whenever what can be taken back may have changed. */
  readonly tick: number;
}

export interface UndoKeeperOptions {
  readonly host: UndoStore | undefined;
  readonly session: {
    subscribe(listener: () => void): () => void;
    getSnapshot(): { readonly store?: ProjectStore | undefined; readonly key?: string | undefined };
  };
  /** What lists show of an origin, as far as this window knows. */
  readonly describe: (origin: Origin) => Partial<UndoAbout>;
  /** Whether the open project is one of the platform, which other devices open too. */
  readonly isCloud: () => boolean;
}

/** How long changes of an AI task or a batch wait before its log is saved, so that a task is a few writes. */
const SAVE_AFTER_MS = 400;

/** See `#emitSoon`. */
const EMIT_AFTER_MS = 250;

const EMPTY: UndoKeeperSnapshot = { restored: [], tick: 0 };

/**
 * What came of taking back several origins at once, see `UndoKeeper.takeBackMany`: done, with what
 * each came to; or nothing, because what would go back is not what people were shown any more, with
 * what would go back now.
 */
export type ManyTakeBack =
  | { readonly done: true; readonly result: ManyUndoResult }
  | { readonly done: false; readonly plan: ManyUndoResult };

/**
 * What a dry run of `undoOrigins` comes to, as text that is the same where the same would go back
 * and stay: what people were shown is compared with it before anything goes back.
 */
export function planKey(plan: ManyUndoResult): string {
  if (!plan.ok) return JSON.stringify({ error: plan.error.code });
  return JSON.stringify(
    plan.each.map(({ origin, result }) =>
      result.ok
        ? [origin, result.patches, result.kept, result.obstacle ?? null]
        : [origin, result.error.code, result.error.conflicts ?? [], result.error.obstacle ?? null],
    ),
  );
}

const kindOf = (origin: Origin): UndoAbout["kind"] => (isFileBatch(origin) ? "folder" : "ai");

function isAbout(value: unknown): value is UndoAbout {
  const about = value as Partial<UndoAbout> | null;
  return (
    typeof about === "object" &&
    about !== null &&
    (about.kind === "ai" || about.kind === "folder") &&
    typeof about.count === "number" &&
    typeof about.from === "number" &&
    typeof about.to === "number"
  );
}

/**
 * Keeps the undo logs of AI tasks and batches of files of the open project on this device, so
 * that they can still be taken back after a reload, see `ProjectStore.saveUndo`: it saves the log
 * of an origin a moment after it changed, after anything was taken back or done again, and when the
 * page hides (`flush`, see mount.tsx); it takes up what was saved when a project opens, and what
 * other windows save while it is open. Taking something back goes one window at a time, with what
 * the window that did it last saved. Each log is written as it is, before anything is read.
 */
export class UndoKeeper {
  readonly #options: UndoKeeperOptions;
  readonly #emitter = new Emitter();
  #snapshot: UndoKeeperSnapshot = EMPTY;
  #store: ProjectStore | undefined;
  #key: string | undefined;
  #unsubscribe: (() => void) | undefined;
  readonly #stopListening: (() => void) | undefined;
  #gone: ReadonlyMap<string, UndoGone> = new Map();
  /** What lists show of each origin, as saved or as learned here. */
  readonly #about = new Map<Origin, UndoAbout>();
  readonly #pending = new Set<Origin>();
  /** Origins whose logs are on their way to be saved, how many times. */
  readonly #unsaved = new Map<Origin, number>();
  #timer: ReturnType<typeof setTimeout> | undefined;
  /**
   * Origins whose log here is what another window saved last. That window's changes can reach this
   * one after its log did, which then takes them for somebody else's: so it is read again once they
   * are here.
   */
  readonly #foreign = new Set<Origin>();
  #refresh: ReturnType<typeof setTimeout> | undefined;
  #soon: ReturnType<typeof setTimeout> | undefined;
  /** Saving one after the other, so that an older log never comes after a newer one. */
  #saving: Promise<unknown> = Promise.resolve();
  /** Taking up what was saved of the open project, see `loaded`. */
  #loading: Promise<void> = Promise.resolve();

  constructor(options: UndoKeeperOptions) {
    this.#options = options;
    const follow = () => this.#attach(options.session.getSnapshot());
    options.session.subscribe(follow);
    this.#stopListening = options.host?.listen((project, origin) => {
      if (project === this.#key) void this.#heard(origin);
    });
    follow();
  }

  subscribe = this.#emitter.subscribe;
  getSnapshot = (): UndoKeeperSnapshot => this.#snapshot;

  #emit(changes: Partial<UndoKeeperSnapshot> = {}): void {
    this.#snapshot = { ...this.#snapshot, ...changes, tick: this.#snapshot.tick + 1 };
    this.#emitter.emit();
  }

  /**
   * What can be taken back changes with every change of the project, and working it out takes a
   * moment for each task on the screen: during a drag that is said a few times a second, not with
   * every frame.
   */
  #emitSoon(): void {
    if (this.#soon !== undefined) return;
    this.#soon = setTimeout(() => {
      this.#soon = undefined;
      this.#emit();
    }, EMIT_AFTER_MS);
  }

  #attach({
    store,
    key,
  }: {
    readonly store?: ProjectStore | undefined;
    readonly key?: string | undefined;
  }): void {
    if (store === this.#store && key === this.#key) return;
    void this.flush();
    this.#unsubscribe?.();
    this.#store = store;
    this.#key = key;
    this.#about.clear();
    this.#foreign.clear();
    this.#gone = new Map();
    this.#snapshot = { ...EMPTY, tick: this.#snapshot.tick + 1 };
    this.#emitter.emit();
    if (!store || key === undefined) {
      this.#loading = Promise.resolve();
      return;
    }
    this.#unsubscribe = store.subscribe(() => this.#heardStore(store));
    this.#loading = this.#load(store, key);
  }

  /**
   * Resolves once what was saved of the undo logs of `store` is taken up, as far as it could be, or
   * at once where another project is open by now. Opening a project waits for it before changes
   * from its folder come in (`ProjectOpening`): a batch that goes on where it left off has the same
   * origin, and a log the store has already of an origin keeps what was saved of it out.
   */
  loaded(store: ProjectStore): Promise<void> {
    this.#attach(this.#options.session.getSnapshot());
    return this.#store === store ? this.#loading : Promise.resolve();
  }

  async #load(store: ProjectStore, key: string): Promise<void> {
    const host = this.#options.host;
    if (!host) return;
    try {
      const [saved, gone] = await Promise.all([host.list(key), host.gone(key)]);
      if (this.#store !== store) return;
      this.#gone = gone;
      const origins = new Set(store.restoreUndo(saved.map(({ record }) => record)));
      const restored: RestoredUndo[] = [];
      for (const { origin, about } of saved) {
        if (!origins.has(origin) || !isAbout(about)) continue;
        this.#about.set(origin, about);
        restored.push({ origin, about });
      }
      this.#emit({ restored });
    } catch (error) {
      console.warn("The undo logs of the project could not be read", error);
    }
  }

  /** The store changed: whatever it was, AI tasks and batches that it touched are saved soon. */
  #heardStore(store: ProjectStore): void {
    const { change } = store;
    if (!change) {
      if (this.#foreign.size > 0 && this.#refresh === undefined) {
        this.#refresh = setTimeout(() => {
          this.#refresh = undefined;
          for (const origin of this.#foreign) void this.#heard(origin);
        }, SAVE_AFTER_MS);
      }
      this.#emitSoon();
      return;
    }
    const { origin, takesBack } = change;
    // Where uploads put files keeps no undo log, see `STORAGE`.
    if (origin === STORAGE) {
      this.#emitSoon();
      return;
    }
    if (origin !== USER) {
      this.#learn(origin);
      this.#pending.add(origin);
    } else if (takesBack) {
      // What people took back of their own can hand a place back to an AI task.
      for (const each of store.loggedOrigins) this.#pending.add(each);
    }
    if (this.#pending.size > 0) this.#later();
    this.#emitSoon();
  }

  /** What this window learns of an origin as it changes the project. */
  #learn(origin: Origin): void {
    const now = Date.now();
    const before = this.#about.get(origin);
    const told = this.#options.describe(origin);
    this.#about.set(origin, {
      kind: kindOf(origin),
      count: told.count ?? before?.count ?? 0,
      from: before?.from ?? told.from ?? now,
      to: now,
      ...(before?.label !== undefined && { label: before.label }),
      ...(before?.tool !== undefined && { tool: before.tool }),
      ...(before?.files && { files: before.files }),
      ...told,
    } satisfies UndoAbout);
  }

  #later(): void {
    if (this.#timer !== undefined) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.flush();
    }, SAVE_AFTER_MS);
  }

  /** Saves what changed and was not saved yet. Resolves once it is. */
  flush(): Promise<void> {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    const origins = [...this.#pending];
    this.#pending.clear();
    const store = this.#store;
    const key = this.#key;
    if (!store || key === undefined || origins.length === 0) return this.#saving.then(() => {});
    return this.#queueSave(store, key, origins);
  }

  /** Saves after what is queued already; until then the logs count as not saved, see `#takeUp`. */
  #queueSave(store: ProjectStore, key: string, origins: readonly Origin[]): Promise<void> {
    for (const origin of origins) this.#unsaved.set(origin, (this.#unsaved.get(origin) ?? 0) + 1);
    return this.#queue(() => this.#save(store, key, origins));
  }

  /** Whether this window changed the log of an origin and has not saved it yet. */
  #isUnsaved(origin: Origin): boolean {
    return this.#pending.has(origin) || (this.#unsaved.get(origin) ?? 0) > 0;
  }

  #queue(run: () => Promise<void>): Promise<void> {
    const next = this.#saving.then(run, run);
    this.#saving = next.catch(() => {});
    return next;
  }

  async #save(store: ProjectStore, key: string, origins: readonly Origin[]): Promise<void> {
    const host = this.#options.host;
    if (!host) return;
    for (const origin of origins) {
      try {
        await this.#saveOne(host, store, key, origin);
      } finally {
        const left = (this.#unsaved.get(origin) ?? 1) - 1;
        if (left > 0) this.#unsaved.set(origin, left);
        else this.#unsaved.delete(origin);
      }
    }
  }

  async #saveOne(host: UndoStore, store: ProjectStore, key: string, origin: Origin): Promise<void> {
    try {
      const record = store.saveUndo(origin);
      if (!record) {
        await host.remove(key, origin);
        return;
      }
      const told = this.#options.describe(origin);
      const known = this.#about.get(origin);
      const now = Date.now();
      const about: UndoAbout = {
        kind: kindOf(origin),
        count: 0,
        from: now,
        to: now,
        ...known,
        ...told,
      };
      this.#about.set(origin, about);
      const { dropped } = await host.save({
        project: key,
        origin,
        record,
        about,
        madeAt: about.from,
      });
      this.#foreign.delete(origin);
      if (dropped.length > 0) {
        for (const away of dropped) store.forgetUndo(away);
        this.#gone = await host.gone(key);
        this.#emit();
      }
    } catch (error) {
      console.warn("An undo log could not be saved", error);
    }
  }

  /** Another window saved the log of an origin of this project, or took it away. */
  async #heard(origin: Origin): Promise<void> {
    const host = this.#options.host;
    const store = this.#store;
    const key = this.#key;
    if (!host || !store || key === undefined) return;
    try {
      // In turn with taking it back here: a log read before that would put back what it changed.
      await host.exclusive(key, () => this.#takeUp(host, store, key, origin));
    } catch (error) {
      console.warn("An undo log of another window could not be read", error);
    }
  }

  async #takeUp(host: UndoStore, store: ProjectStore, key: string, origin: Origin): Promise<void> {
    // What this window changed and has not saved yet is newer than anything another one saved.
    if (this.#isUnsaved(origin)) return;
    const saved = await host.get(key, origin);
    if (this.#store !== store || this.#isUnsaved(origin)) return;
    if (saved?.window === host.window) return;
    this.#foreign.delete(origin);
    if (!saved) {
      store.forgetUndo(origin);
      this.#gone = await host.gone(key);
    } else if (store.restoreUndo([saved.record], { replace: true }).length > 0) {
      this.#foreign.add(origin);
      if (isAbout(saved.about)) this.#about.set(origin, saved.about);
      const known = this.#snapshot.restored.some((each) => each.origin === origin);
      if (!known && isAbout(saved.about) && !this.#isMine(origin)) {
        this.#snapshot = {
          ...this.#snapshot,
          restored: [...this.#snapshot.restored, { origin, about: saved.about }],
        };
      }
    }
    this.#emit();
  }

  /** Whether this window made changes of an origin itself. */
  #isMine(origin: Origin): boolean {
    return (
      this.#about.has(origin) && !this.#snapshot.restored.some((each) => each.origin === origin)
    );
  }

  /**
   * Takes back or does again all of an origin, one window at a time: first what another window did
   * with it, then this, which is saved before the next window gets its turn. Resolves to undefined
   * where there was no project, or it changed meanwhile.
   */
  async takeBack(origin: Origin, direction: "undo" | "redo"): Promise<UndoResult | undefined> {
    const store = this.#store;
    const key = this.#key;
    if (!store) return undefined;
    const go = () => (direction === "undo" ? store.undoOrigin(origin) : store.redoOrigin(origin));
    const host = this.#options.host;
    if (!host || key === undefined) return go();
    return host.exclusive(key, async () => {
      if (this.#store !== store) return undefined;
      // Saves of this window first, so that what is read is the newest of all windows.
      await this.flush();
      const saved = await host.get(key, origin).catch(() => undefined);
      if (saved && saved.window !== host.window) {
        store.restoreUndo([saved.record], { replace: true });
        this.#foreign.add(origin);
      }
      const isForeign = this.#foreign.has(origin);
      const result = go();
      // Taking it back can hand places back to other tasks and batches: their logs say so too. One
      // that went wrong took its steps out of the log, which is saved as well, unless it is the log
      // of another window, which this one may be behind of.
      if (result.ok || !isForeign) {
        this.#pending.delete(origin);
        await this.#queueSave(store, key, [origin]);
      }
      if (result.ok) {
        for (const each of store.loggedOrigins) if (each !== origin) this.#pending.add(each);
        this.#later();
      }
      this.#emit();
      return result;
    });
  }

  /**
   * What taking back these origins at once, or doing them again, would come to now, see
   * `ProjectStore.undoOrigins`. Undefined where there is no project.
   */
  planMany(origins: readonly Origin[], direction: "undo" | "redo"): ManyUndoResult | undefined {
    const store = this.#store;
    if (!store) return undefined;
    return direction === "undo"
      ? store.undoOrigins(origins, { dryRun: true })
      : store.redoOrigins(origins, { dryRun: true });
  }

  /**
   * Takes back several origins at once, the newest first, or does them again, in one turn of the
   * lock of the project, as `takeBack` does one: first what other windows saved of them, then this.
   * With `expected` (see `planKey`), it works it out again in that turn first, and where that is
   * not what people were shown, nothing goes back: it says what would now. Only those that have
   * something to take back go, so that one that cannot keeps its log. Resolves to undefined where
   * there was no project, or it changed meanwhile.
   */
  async takeBackMany(
    origins: readonly Origin[],
    direction: "undo" | "redo",
    expected?: string,
  ): Promise<ManyTakeBack | undefined> {
    const store = this.#store;
    const key = this.#key;
    if (!store) return undefined;
    const host = this.#options.host;
    const go = (): ManyTakeBack => {
      const plan =
        direction === "undo"
          ? store.undoOrigins(origins, { dryRun: true })
          : store.redoOrigins(origins, { dryRun: true });
      if (expected !== undefined && planKey(plan) !== expected) return { done: false, plan };
      if (!plan.ok) return { done: true, result: plan };
      const going = plan.each.filter(({ result }) => result.ok).map(({ origin }) => origin);
      const result = direction === "undo" ? store.undoOrigins(going) : store.redoOrigins(going);
      return { done: true, result };
    };
    if (!host || key === undefined) return go();
    return host.exclusive(key, async () => {
      if (this.#store !== store) return undefined;
      // Saves of this window first, so that what is read is the newest of all windows.
      await this.flush();
      const records: unknown[] = [];
      for (const origin of new Set(origins)) {
        const saved = await host.get(key, origin).catch(() => undefined);
        if (saved && saved.window !== host.window) records.push(saved.record);
      }
      if (this.#store !== store) return undefined;
      if (records.length > 0) {
        for (const origin of store.restoreUndo(records, { replace: true })) {
          this.#foreign.add(origin);
        }
      }
      const outcome = go();
      if (!outcome.done || !outcome.result.ok) {
        this.#emit();
        return outcome;
      }
      // As `takeBack` does for each of them, see there.
      const saving: Origin[] = [];
      let any = false;
      for (const { origin, result } of outcome.result.each) {
        if (result.ok) any = true;
        if (result.ok || !this.#foreign.has(origin)) {
          this.#pending.delete(origin);
          saving.push(origin);
        }
      }
      if (saving.length > 0) await this.#queueSave(store, key, saving);
      if (any) {
        for (const each of store.loggedOrigins) if (!saving.includes(each)) this.#pending.add(each);
        this.#later();
      }
      this.#emit();
      return outcome;
    });
  }

  /** Whether the changes of an origin can be taken back or done again here, and why not. */
  stateOf(origin: Origin): UndoState {
    const store = this.#store;
    if (!store) return { direction: undefined };
    const { direction, blocked } = store.undoOutlook(origin);
    if (direction) return blocked ? { direction, whyNot: blocked } : { direction };
    const gone = this.#gone.get(origin);
    if (gone) return { direction: undefined, whyNot: gone };
    if (this.#options.isCloud() && !this.#about.has(origin)) {
      return { direction: undefined, whyNot: "elsewhere" };
    }
    return { direction: undefined };
  }

  /** What lists show of an origin, if this window knows. */
  aboutOf(origin: Origin): UndoAbout | undefined {
    return this.#about.get(origin);
  }

  /**
   * Takes up again what is saved of the open project, and nothing of what this window learned, as
   * after a reload. For tests, which cannot reload a page whose platform lives in it.
   */
  async readAgain(): Promise<void> {
    const store = this.#store;
    const key = this.#key;
    await this.flush();
    this.#store = undefined;
    this.#attach({ store, key });
  }

  /** How much the undo logs of all projects take on this device. */
  async usage(): Promise<UndoUsage | undefined> {
    return this.#options.host?.usage();
  }

  /** Takes away the undo logs of every project, also what this window can take back now. */
  async clear(): Promise<void> {
    const host = this.#options.host;
    if (!host) return;
    await this.flush();
    await host.clear();
    const store = this.#store;
    for (const origin of store?.loggedOrigins ?? []) store?.forgetUndo(origin);
    this.#pending.clear();
    this.#gone = new Map();
    this.#emit({ restored: [] });
  }

  destroy(): void {
    void this.flush();
    if (this.#refresh !== undefined) clearTimeout(this.#refresh);
    if (this.#soon !== undefined) clearTimeout(this.#soon);
    this.#unsubscribe?.();
    this.#stopListening?.();
  }
}
