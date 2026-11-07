import type { WorkCache } from "./index.ts";

/**
 * What the editor worked out gets a database of its own, like exports and what is being tried: a
 * new version of the main database would lock out every page that is still open.
 */
const DATABASE = "animaquill-cache";
const VERSION = 1;
const ENTRIES = "entries";
const BY_USE = "usedAt";
/** Plenty for the scenes of many projects. Each one is small, and the oldest go first. */
export const MAX_CACHE_ENTRIES = 500;

interface Entry {
  readonly key: string;
  readonly value: unknown;
  /** Milliseconds since 1970, when it was last written or read. */
  readonly usedAt: number;
}

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
  const request = factory.open(DATABASE, VERSION);
  request.addEventListener("upgradeneeded", () => {
    const entries = request.result.createObjectStore(ENTRIES, { keyPath: "key" });
    entries.createIndex(BY_USE, BY_USE);
  });
  return resultOf(request);
}

/** Keeps what was worked out in this browser. Whatever goes wrong only means it is not kept. */
export function createWorkCache(
  factory: () => IDBFactory,
  limit: number = MAX_CACHE_ENTRIES,
  now: () => number = Date.now,
): WorkCache {
  let opening: Promise<IDBDatabase> | undefined;
  const database = () => {
    opening ??= open(factory()).then(
      (opened) => {
        opened.addEventListener("versionchange", () => {
          opened.close();
          opening = undefined;
        });
        opened.addEventListener("close", () => (opening = undefined));
        return opened;
      },
      (error: unknown) => {
        opening = undefined;
        throw error;
      },
    );
    return opening;
  };

  /** Only so many stay: the ones that were used last. */
  async function trim(opened: IDBDatabase): Promise<void> {
    const transaction = opened.transaction(ENTRIES, "readwrite");
    const store = transaction.objectStore(ENTRIES);
    const count = await resultOf(store.count());
    let over = count - limit;
    if (over > 0) {
      const cursor = store.index(BY_USE).openCursor();
      await new Promise<void>((resolve, reject) => {
        cursor.addEventListener("error", () => reject(cursor.error));
        cursor.addEventListener("success", () => {
          const found = cursor.result;
          if (!found || over <= 0) {
            resolve();
            return;
          }
          found.delete();
          over -= 1;
          found.continue();
        });
      });
    }
    await committed(transaction);
  }

  return {
    async read(key) {
      try {
        const opened = await database();
        const transaction = opened.transaction(ENTRIES, "readwrite");
        const store = transaction.objectStore(ENTRIES);
        const entry = (await resultOf(store.get(key))) as Entry | undefined;
        if (entry) store.put({ ...entry, usedAt: now() } satisfies Entry);
        await committed(transaction);
        return entry?.value;
      } catch (error) {
        console.warn("Something worked out before could not be read", error);
        return undefined;
      }
    },
    async write(key, value) {
      try {
        const opened = await database();
        const transaction = opened.transaction(ENTRIES, "readwrite");
        transaction.objectStore(ENTRIES).put({ key, value, usedAt: now() } satisfies Entry);
        await committed(transaction);
        await trim(opened);
      } catch (error) {
        console.warn("Something worked out could not be kept", error);
      }
    },
  };
}
