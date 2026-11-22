import { scoped } from "./scope.ts";
import { broadcastLine } from "./cloud.ts";
import { browserFolderWriter, MemoryWriters, type WriterPage } from "./folder-writer.ts";
import type { DownloadedPiece, DownloadStore } from "./index.ts";
import { MemoryLines } from "./uploads.ts";

/**
 * The files of assets this browser downloads, see `DownloadStore`: a database of its own
 * (`animaquill-downloads`), as a new version of another one would lock out every page that is still
 * open. The pieces are Blobs, which the browser keeps on the disk, not in memory. Which window
 * downloads for a project goes by a Web Lock of its own (`animaquill.downloads.<key>`), and the
 * windows tell each other over a BroadcastChannel.
 */
const DATABASE = "animaquill-downloads";
const VERSION = 1;
const PIECES = "pieces";
const PAUSED = "paused";
const CHANNEL = "animaquill.downloads";
const LOCKS = "animaquill.downloads.";
/** Which windows use the pieces of an object, shared, and who may drop them, alone. */
const OBJECT_LOCKS = "animaquill.downloads.object.";

const resultOf = <T>(request: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error));
  });

const committed = (transaction: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve());
    transaction.addEventListener("abort", () => {
      reject(transaction.error ?? new DOMException("Transaction aborted", "AbortError"));
    });
  });

function open(factory: IDBFactory): Promise<IDBDatabase> {
  const request = factory.open(scoped(DATABASE), VERSION);
  request.addEventListener("upgradeneeded", () => {
    const pieces = request.result.createObjectStore(PIECES, { keyPath: ["oid", "start"] });
    pieces.createIndex("oid", "oid");
    request.result.createObjectStore(PAUSED, { keyPath: "key" });
  });
  return resultOf(request);
}

/** A piece as it was kept, or undefined for what is none. */
const pieceOf = (value: unknown): (DownloadedPiece & { readonly at: number }) | undefined => {
  const { start, bytes, at } = (value ?? {}) as { start?: unknown; bytes?: unknown; at?: unknown };
  return typeof start === "number" && bytes instanceof Blob && typeof at === "number"
    ? { start, bytes, at }
    : undefined;
};

interface Changes {
  post(key: string): void;
  listen(listener: (key: string) => void): () => void;
}

function broadcastChanges(): Changes | undefined {
  if (typeof BroadcastChannel === "undefined") return undefined;
  const channel = new BroadcastChannel(scoped(CHANNEL));
  return {
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- not a window
    post: (key) => channel.postMessage(key),
    listen(listener) {
      const onMessage = (event: MessageEvent<unknown>) => {
        if (typeof event.data === "string") listener(event.data);
      };
      channel.addEventListener("message", onMessage);
      return () => channel.removeEventListener("message", onMessage);
    },
  };
}

/** In IndexedDB, shared by every window of this browser. */
export function browserDownloads(
  factory: () => IDBFactory = () => indexedDB,
  locks: () => LockManager | undefined = () => navigator.locks,
  channel: () => Changes | undefined = broadcastChanges,
  now: () => number = Date.now,
): DownloadStore {
  /** Holds of this window, by oid, where the browser has no locks: this window alone counts. */
  const held = new Map<string, number>();
  let opening: Promise<IDBDatabase> | undefined;
  const database = () => {
    opening ??= open(factory()).then((opened) => {
      opened.addEventListener("versionchange", () => {
        opened.close();
        opening = undefined;
      });
      opened.addEventListener("close", () => {
        opening = undefined;
      });
      return opened;
    });
    opening.catch(() => {
      opening = undefined;
    });
    return opening;
  };
  const listeners = new Set<(key: string) => void>();
  let others: Changes | undefined;
  let isChannelMade = false;
  const othersOf = () => {
    if (!isChannelMade) {
      isChannelMade = true;
      try {
        others = channel();
      } catch (error) {
        console.warn("The other windows cannot be told about downloads", error);
      }
      others?.listen((key) => {
        for (const listener of listeners) listener(key);
      });
    }
    return others;
  };

  return {
    async pieces(oid) {
      const store = (await database()).transaction([PIECES], "readonly").objectStore(PIECES);
      const all: unknown[] = await resultOf(store.index("oid").getAll(oid));
      return all
        .flatMap((each) => {
          const piece = pieceOf(each);
          return piece ? [{ start: piece.start, bytes: piece.bytes }] : [];
        })
        .toSorted((a, b) => a.start - b.start);
    },
    async putPiece(oid, start, bytes) {
      const transaction = (await database()).transaction([PIECES], "readwrite");
      transaction.objectStore(PIECES).put({ oid, start, bytes, at: now() });
      await committed(transaction);
    },
    hold(oid) {
      const manager = locks();
      if (!manager) {
        held.set(oid, (held.get(oid) ?? 0) + 1);
        let left = false;
        return () => {
          if (left) return;
          left = true;
          const still = (held.get(oid) ?? 1) - 1;
          if (still > 0) held.set(oid, still);
          else held.delete(oid);
        };
      }
      let release = () => {};
      const kept = new Promise<void>((resolve) => {
        release = resolve;
      });
      void manager
        .request(scoped(`${OBJECT_LOCKS}${oid}`), { mode: "shared" }, () => kept)
        .catch(() => {});
      return () => release();
    },
    async dropUnused(oid) {
      const manager = locks();
      if (!manager) {
        if ((held.get(oid) ?? 0) > 0) return false;
        await this.dropPieces(oid);
        return true;
      }
      return manager.request(
        scoped(`${OBJECT_LOCKS}${oid}`),
        { ifAvailable: true },
        async (lock) => {
          if (!lock) return false;
          await this.dropPieces(oid);
          return true;
        },
      );
    },
    async dropPieces(oid) {
      const transaction = (await database()).transaction([PIECES], "readwrite");
      const request = transaction.objectStore(PIECES).index("oid").openCursor(oid);
      request.addEventListener("success", () => {
        const cursor = request.result;
        if (!cursor) return;
        cursor.delete();
        cursor.continue();
      });
      await committed(transaction);
    },
    async objects() {
      const store = (await database()).transaction([PIECES], "readonly").objectStore(PIECES);
      const all: unknown[] = await resultOf(store.getAll());
      const latest = new Map<string, number>();
      for (const each of all) {
        const oid = (each as { oid?: unknown } | null)?.oid;
        const piece = pieceOf(each);
        if (typeof oid === "string" && piece)
          latest.set(oid, Math.max(latest.get(oid) ?? 0, piece.at));
      }
      return [...latest].map(([oid, at]) => ({ oid, at }));
    },
    async paused(key) {
      const store = (await database()).transaction([PAUSED], "readonly").objectStore(PAUSED);
      return (await resultOf(store.get(key))) !== undefined;
    },
    async setPaused(key, paused) {
      const transaction = (await database()).transaction([PAUSED], "readwrite");
      const store = transaction.objectStore(PAUSED);
      if (paused) store.put({ key, at: now() });
      else store.delete(key);
      await committed(transaction);
      for (const listener of listeners) listener(key);
      othersOf()?.post(key);
    },
    downloader: (key) => browserFolderWriter(key, locks, undefined, LOCKS),
    line: (key) => broadcastLine(`${LOCKS}${key}`),
    listen(listener) {
      othersOf();
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/**
 * For tests: the downloads of one browser in memory. Each window gets a store of its own with
 * `window`, which shares the pieces, the turns and the lines with the others.
 */
export class MemoryDownloads {
  readonly #pieces = new Map<string, Map<number, DownloadedPiece & { readonly at: number }>>();
  readonly #paused = new Set<string>();
  /** Holds of all windows, by oid. */
  readonly #held = new Map<string, number>();
  readonly #listeners = new Set<(key: string) => void>();
  readonly writers = new MemoryWriters();
  readonly #lines = new MemoryLines();
  /** For tests that are about it: keeping a piece fails as for a full disk. */
  failPut = false;
  now: () => number = Date.now;

  /** What is kept of an object, all of it in order, for tests to look at. */
  keptOf(oid: string): readonly DownloadedPiece[] {
    return [...(this.#pieces.get(oid)?.values() ?? [])].toSorted((a, b) => a.start - b.start);
  }

  window(page: WriterPage = { isAlive: () => true, asleep: false }): DownloadStore {
    return {
      pieces: async (oid) => this.keptOf(oid).map(({ start, bytes }) => ({ start, bytes })),
      putPiece: async (oid, start, bytes) => {
        if (this.failPut) throw new DOMException("The disk is full", "QuotaExceededError");
        const of = this.#pieces.get(oid) ?? new Map();
        of.set(start, { start, bytes, at: this.now() });
        this.#pieces.set(oid, of);
      },
      dropPieces: async (oid) => {
        this.#pieces.delete(oid);
      },
      hold: (oid) => {
        this.#held.set(oid, (this.#held.get(oid) ?? 0) + 1);
        let left = false;
        return () => {
          if (left) return;
          left = true;
          const still = (this.#held.get(oid) ?? 1) - 1;
          if (still > 0) this.#held.set(oid, still);
          else this.#held.delete(oid);
        };
      },
      dropUnused: async (oid) => {
        if ((this.#held.get(oid) ?? 0) > 0) return false;
        this.#pieces.delete(oid);
        return true;
      },
      objects: async () =>
        [...this.#pieces].map(([oid, of]) => ({
          oid,
          at: Math.max(...[...of.values()].map(({ at }) => at)),
        })),
      paused: async (key) => this.#paused.has(key),
      setPaused: async (key, paused) => {
        if (paused) this.#paused.add(key);
        else this.#paused.delete(key);
        for (const listener of this.#listeners) void Promise.resolve().then(() => listener(key));
      },
      downloader: (key) => this.writers.writer(`downloads.${key}`, page),
      line: (key) => this.#lines.line(key),
      listen: (listener) => {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
      },
    };
  }
}
