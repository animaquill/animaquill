import { scoped } from "./scope.ts";
import { committed, connector, resultOf } from "./ai.ts";
import type { SavedUndo, UndoGone, UndoStore, UndoUsage } from "./index.ts";

/** A database of its own: a new version of the main one would lock out every page still open. */
export const UNDO_DATABASE = "animaquill-undo";
const VERSION = 1;
const RECORDS = "records";
const GONE = "gone";
const BY_PROJECT = "project";
/** How many batches of each project are kept, and for how long: whichever comes first (2026-11-14). */
export const UNDO_KEPT = 50;
export const UNDO_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
/** How many of what went each project remembers, to say why. */
const GONE_KEPT = 500;
const CHANNEL = "animaquill-undo";
/** One lock for each project, see `UndoStore.exclusive`. */
const LOCK_PREFIX = "animaquill-undo-project:";

interface Row extends SavedUndo {
  readonly bytes: number;
}

interface GoneRow {
  readonly project: string;
  readonly origin: string;
  readonly why: UndoGone;
  readonly at: number;
}

const sizeOf = (saved: Pick<SavedUndo, "record" | "about">): number => {
  try {
    return JSON.stringify([saved.record, saved.about]).length;
  } catch {
    return 0;
  }
};

/** Which records of a project go: past the newest `UNDO_KEPT`, or older than `UNDO_DAYS`. */
export function undoDropped(
  rows: readonly Pick<SavedUndo, "origin" | "madeAt">[],
  now: number,
): readonly { readonly origin: string; readonly why: UndoGone }[] {
  const newest = rows.toSorted((a, b) => b.madeAt - a.madeAt);
  return newest.flatMap(({ origin, madeAt }, index): { origin: string; why: UndoGone }[] => {
    if (now - madeAt > UNDO_DAYS * DAY_MS) return [{ origin, why: "age" }];
    return index >= UNDO_KEPT ? [{ origin, why: "count" }] : [];
  });
}

const newWindow = () => `${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 10)}`;

/**
 * Undo logs in this browser, in a database of their own (`animaquill-undo`), by project and origin.
 * Windows hear what other windows saved through a broadcast channel, and take turns with Web Locks.
 */
export function browserUndo(
  factory: () => IDBFactory = () => indexedDB,
  locks: () => LockManager | undefined = () => navigator.locks,
  clock: () => number = Date.now,
): UndoStore {
  const window = newWindow();
  const database = connector(() => {
    const request = factory().open(scoped(UNDO_DATABASE), VERSION);
    request.addEventListener("upgradeneeded", () => {
      const records = request.result.createObjectStore(RECORDS, { keyPath: ["project", "origin"] });
      records.createIndex(BY_PROJECT, "project");
      const gone = request.result.createObjectStore(GONE, { keyPath: ["project", "origin"] });
      gone.createIndex(BY_PROJECT, "project");
    });
    return resultOf(request);
  });
  const channel =
    typeof BroadcastChannel === "undefined" ? undefined : new BroadcastChannel(scoped(CHANNEL));
  const listeners = new Set<(project: string, origin: string) => void>();
  channel?.addEventListener("message", (event: MessageEvent<unknown>) => {
    const data = event.data as { project?: unknown; origin?: unknown } | null;
    if (typeof data?.project !== "string" || typeof data.origin !== "string") return;
    for (const listener of listeners) listener(data.project, data.origin);
  });
  const tell = (project: string, origin: string) =>
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- not a window
    channel?.postMessage({ project, origin });

  const rowsOf = async (store: IDBObjectStore, project: string): Promise<Row[]> =>
    (await resultOf(store.index(BY_PROJECT).getAll(project))) as Row[];

  const toSaved = ({ bytes: _bytes, ...saved }: Row): SavedUndo => saved;

  const saveAll: UndoStore["saveAll"] = async (project, saved, removed = []) => {
    const now = clock();
    const rows = saved.map(({ project: _project, origin, madeAt: made, ...kept }): Row => ({
      ...kept,
      project,
      origin,
      window,
      savedAt: now,
      madeAt: made ?? now,
      bytes: sizeOf(kept),
    }));
    // The logs first, on their own, with nothing to read before them, and committed right away:
    // a page that goes away right after still has them (a transaction the page did not commit is
    // taken back as it goes). What goes for them comes after, in a transaction of its own.
    const writing = (await database()).transaction(RECORDS, "readwrite");
    const kept = writing.objectStore(RECORDS);
    for (const row of rows) kept.put(row);
    for (const origin of removed) kept.delete([project, origin]);
    writing.commit?.();
    await committed(writing);
    for (const { origin } of rows) tell(project, origin);
    for (const origin of removed) tell(project, origin);
    if (rows.length === 0) return { dropped: [] };
    // The logs are kept by now: where this fails, the save did not, and what goes goes next time.
    try {
      const transaction = (await database()).transaction([RECORDS, GONE], "readwrite");
      const records = transaction.objectStore(RECORDS);
      const gone = transaction.objectStore(GONE);
      const dropped = undoDropped(await rowsOf(records, project), now);
      for (const { origin: away, why } of dropped) {
        records.delete([project, away]);
        gone.put({ project, origin: away, why, at: now } satisfies GoneRow);
      }
      if (dropped.length > 0) {
        const all = (await resultOf(gone.index(BY_PROJECT).getAll(project))) as GoneRow[];
        const old = all.toSorted((a, b) => b.at - a.at).slice(GONE_KEPT);
        for (const each of old) gone.delete([project, each.origin]);
      }
      await committed(transaction);
      for (const { origin: away } of dropped) tell(project, away);
      return { dropped: dropped.map(({ origin: away }) => away) };
    } catch (error) {
      console.warn("The oldest undo logs could not go", error);
      return { dropped: [] };
    }
  };

  return {
    window,
    async list(project) {
      const transaction = (await database()).transaction(RECORDS, "readonly");
      const rows = await rowsOf(transaction.objectStore(RECORDS), project);
      return rows.toSorted((a, b) => a.savedAt - b.savedAt).map(toSaved);
    },
    async get(project, origin) {
      const transaction = (await database()).transaction(RECORDS, "readonly");
      const row = (await resultOf(transaction.objectStore(RECORDS).get([project, origin]))) as
        Row | undefined;
      return row && toSaved(row);
    },
    save: (saved) => saveAll(saved.project, [saved]),
    saveAll,
    async remove(project, origin) {
      const transaction = (await database()).transaction(RECORDS, "readwrite");
      transaction.objectStore(RECORDS).delete([project, origin]);
      await committed(transaction);
      tell(project, origin);
    },
    async gone(project) {
      const transaction = (await database()).transaction(GONE, "readonly");
      const all = (await resultOf(
        transaction.objectStore(GONE).index(BY_PROJECT).getAll(project),
      )) as GoneRow[];
      return new Map(all.map(({ origin, why }) => [origin, why]));
    },
    async usage() {
      const transaction = (await database()).transaction(RECORDS, "readonly");
      const projects = new Set<string>();
      let bytes = 0;
      const cursor = transaction.objectStore(RECORDS).openCursor();
      await new Promise<void>((resolve, reject) => {
        cursor.addEventListener("error", () => reject(cursor.error));
        cursor.addEventListener("success", () => {
          const at = cursor.result;
          if (!at) return resolve();
          const row = at.value as Row;
          projects.add(row.project);
          bytes += row.bytes;
          at.continue();
        });
      });
      return { projects: projects.size, bytes } satisfies UndoUsage;
    },
    async clear() {
      const transaction = (await database()).transaction([RECORDS, GONE], "readwrite");
      const all = (await resultOf(transaction.objectStore(RECORDS).getAll())) as Row[];
      transaction.objectStore(RECORDS).clear();
      transaction.objectStore(GONE).clear();
      await committed(transaction);
      for (const { project, origin } of all) tell(project, origin);
    },
    async forget(project) {
      const transaction = (await database()).transaction([RECORDS, GONE], "readwrite");
      for (const name of [RECORDS, GONE]) {
        const store = transaction.objectStore(name);
        const keys = await resultOf(store.index(BY_PROJECT).getAllKeys(project));
        for (const key of keys) store.delete(key);
      }
      await committed(transaction);
    },
    listen(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async exclusive(project, run) {
      const manager = locks();
      if (!manager) return run();
      return manager.request(scoped(`${LOCK_PREFIX}${project}`), () => run());
    },
  };
}

/**
 * Undo logs that last as long as the page. Windows of a test share one with `shared`, each with a
 * window of its own: they hear each other, and take turns, as windows of a browser do.
 */
export function memoryUndo(
  shared: MemoryUndoPlace = new MemoryUndoPlace(),
  clock: () => number = Date.now,
): UndoStore {
  const window = newWindow();
  const toSaved = ({ bytes: _bytes, ...saved }: Row): SavedUndo => saved;
  const key = (project: string, origin: string) => JSON.stringify([project, origin]);
  const saveAll: UndoStore["saveAll"] = async (project, saved, removed = []) => {
    const now = clock();
    for (const { madeAt, ...kept } of saved) {
      const row: Row = {
        ...kept,
        project,
        window,
        savedAt: now,
        madeAt: madeAt ?? now,
        bytes: sizeOf(kept),
      };
      shared.rows.set(key(project, kept.origin), row);
    }
    for (const origin of removed) shared.rows.delete(key(project, origin));
    for (const { origin } of saved) shared.tell(window, project, origin);
    for (const origin of removed) shared.tell(window, project, origin);
    if (saved.length === 0) return { dropped: [] };
    const rows = [...shared.rows.values()].filter((each) => each.project === project);
    const dropped = undoDropped(rows, now);
    for (const { origin, why } of dropped) {
      shared.rows.delete(key(project, origin));
      shared.gone.set(key(project, origin), why);
    }
    for (const { origin } of dropped) shared.tell(window, project, origin);
    return { dropped: dropped.map(({ origin }) => origin) };
  };

  return {
    window,
    list: async (project) =>
      [...shared.rows.values()]
        .filter((row) => row.project === project)
        .toSorted((a, b) => a.savedAt - b.savedAt)
        .map(toSaved),
    get: async (project, origin) => {
      const row = shared.rows.get(key(project, origin));
      return row && toSaved(row);
    },
    save: (saved) => saveAll(saved.project, [saved]),
    saveAll,
    async remove(project, origin) {
      shared.rows.delete(key(project, origin));
      shared.tell(window, project, origin);
    },
    gone: async (project) =>
      new Map(
        [...shared.gone].flatMap(([at, why]) => {
          const [of, origin] = JSON.parse(at) as [string, string];
          return of === project ? [[origin, why] as const] : [];
        }),
      ),
    usage: async () => {
      const rows = [...shared.rows.values()];
      return {
        projects: new Set(rows.map(({ project }) => project)).size,
        bytes: rows.reduce((sum, row) => sum + row.bytes, 0),
      };
    },
    async clear() {
      const all = [...shared.rows.values()];
      shared.rows.clear();
      shared.gone.clear();
      for (const { project, origin } of all) shared.tell(window, project, origin);
    },
    async forget(project) {
      for (const [at, row] of shared.rows) if (row.project === project) shared.rows.delete(at);
    },
    listen: (listener) => shared.listen(window, listener),
    exclusive: (project, run) => shared.exclusive(JSON.stringify([project]), run),
  };
}

/** What windows of a test share of their undo logs, see `memoryUndo`. */
export class MemoryUndoPlace {
  readonly rows = new Map<string, Row>();
  readonly gone = new Map<string, UndoGone>();
  readonly #listeners = new Set<{
    readonly window: string;
    readonly listener: (project: string, origin: string) => void;
  }>();
  readonly #turns = new Map<string, Promise<unknown>>();

  tell(from: string, project: string, origin: string): void {
    for (const { window, listener } of this.#listeners) {
      if (window !== from) queueMicrotask(() => listener(project, origin));
    }
  }

  listen(window: string, listener: (project: string, origin: string) => void): () => void {
    const entry = { window, listener };
    this.#listeners.add(entry);
    return () => this.#listeners.delete(entry);
  }

  /** One after the other, as a Web Lock does. */
  exclusive<T>(name: string, run: () => Promise<T> | T): Promise<T> {
    const before = this.#turns.get(name) ?? Promise.resolve();
    const turn = before.then(run, run);
    this.#turns.set(
      name,
      turn.catch(() => {}),
    );
    return turn;
  }
}
