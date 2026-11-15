import { isObject, text } from "./answers.ts";
import { broadcastLine } from "./cloud.ts";
import { browserFolderWriter, MemoryWriters, type WriterPage } from "./folder-writer.ts";
import type {
  CloudLine,
  UploadRecord,
  UploadRecordState,
  UploadStore,
  UploadTarget,
} from "./index.ts";

/**
 * The files of assets this browser sends somewhere, see `UploadStore`: a database of its own
 * (`animaquill-uploads`), as a new version of the main database would lock out every page that is
 * still open. Which window sends the files of a project goes by a Web Lock of its own
 * (`animaquill.uploads.<key>`), and the windows tell each other over a BroadcastChannel.
 */
const DATABASE = "animaquill-uploads";
const VERSION = 1;
const UPLOADS = "uploads";
/** How the windows of this browser tell each other which project's uploads changed. */
const CHANNEL = "animaquill.uploads";
const LOCKS = "animaquill.uploads.";

/** A number of bytes, or a time: a whole number, not below zero. */
const count = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

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
    const store = request.result.createObjectStore(UPLOADS, { keyPath: ["key", "asset"] });
    store.createIndex("key", "key");
  });
  return resultOf(request);
}

const STATES: ReadonlySet<string> = new Set<UploadRecordState>([
  "waiting",
  "paused",
  "failed",
  "done",
  "cancelling",
]);
const TARGETS: ReadonlySet<string> = new Set<UploadTarget>(["lfs"]);

/** A record as it was kept, or undefined for one this editor cannot read, as of a newer one. */
export function uploadRecordOf(value: unknown): UploadRecord | undefined {
  if (!isObject(value)) return undefined;
  const key = text(value.key);
  const asset = text(value.asset);
  const target = text(value.target);
  const hash = text(value.hash);
  const size = count(value.size);
  const name = text(value.name);
  const project = text(value.project);
  const state = text(value.state);
  const at = count(value.at);
  if (
    key === undefined ||
    asset === undefined ||
    target === undefined ||
    !TARGETS.has(target) ||
    hash === undefined ||
    size === undefined ||
    name === undefined ||
    project === undefined ||
    state === undefined ||
    !STATES.has(state) ||
    at === undefined
  )
    return undefined;
  const upload = text(value.upload);
  const received = count(value.received);
  const problem = text(value.problem);
  const doneAt = count(value.doneAt);
  return {
    key,
    asset,
    target: target as UploadTarget,
    hash,
    size,
    name,
    project,
    state: state as UploadRecordState,
    at,
    ...(upload !== undefined && { upload }),
    ...(received !== undefined && { received }),
    ...(problem !== undefined && { problem }),
    ...(doneAt !== undefined && { doneAt }),
    ...(value.replaced === true && { replaced: true as const }),
  };
}

/** What tells the other windows which project's uploads changed, and hears them. */
interface Changes {
  post(key: string): void;
  listen(listener: (key: string) => void): () => void;
}

function broadcastChanges(): Changes | undefined {
  if (typeof BroadcastChannel === "undefined") return undefined;
  const channel = new BroadcastChannel(CHANNEL);
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
export function browserUploads(
  factory: () => IDBFactory = () => indexedDB,
  locks: () => LockManager | undefined = () => navigator.locks,
  channel: () => Changes | undefined = broadcastChanges,
): UploadStore {
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
        console.warn("The other windows cannot be told about uploads", error);
      }
      others?.listen((key) => {
        for (const listener of listeners) listener(key);
      });
    }
    return others;
  };
  const changed = (keys: Iterable<string>) => {
    for (const key of new Set(keys)) {
      for (const listener of listeners) listener(key);
      othersOf()?.post(key);
    }
  };
  const write = async (keys: Iterable<string>, work: (store: IDBObjectStore) => void) => {
    const transaction = (await database()).transaction([UPLOADS], "readwrite");
    work(transaction.objectStore(UPLOADS));
    await committed(transaction);
    changed(keys);
  };

  return {
    async list(key) {
      const store = (await database()).transaction([UPLOADS], "readonly").objectStore(UPLOADS);
      const all: unknown[] = await resultOf(
        key === undefined ? store.getAll() : store.index("key").getAll(key),
      );
      return all.flatMap((each) => uploadRecordOf(each) ?? []);
    },
    async update(key, assets, change) {
      const transaction = (await database()).transaction([UPLOADS], "readwrite");
      const store = transaction.objectStore(UPLOADS);
      const after: (UploadRecord | undefined)[] = [];
      let written = 0;
      assets.forEach((asset, index) => {
        const request = store.get([key, asset]);
        request.addEventListener("success", () => {
          const before = uploadRecordOf(request.result);
          const next = change(before, asset);
          if (next === undefined) after[index] = before;
          else if (next === null) {
            if (request.result !== undefined) store.delete([key, asset]);
            written += 1;
          } else {
            store.put({ ...next, key, asset });
            after[index] = { ...next, key, asset };
            written += 1;
          }
        });
      });
      await committed(transaction);
      if (written > 0) changed([key]);
      return after;
    },
    forget: (key) =>
      write([key], (store) => {
        const request = store.index("key").openCursor(key);
        request.addEventListener("success", () => {
          const cursor = request.result;
          if (!cursor) return;
          cursor.delete();
          cursor.continue();
        });
      }),
    uploader: (key) => browserFolderWriter(key, locks, undefined, LOCKS),
    line: (key) => broadcastLine(`${LOCKS}${key}`),
    listen(listener) {
      othersOf();
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** For tests: what windows of one browser say to each other, in memory, a moment later. */
export class MemoryLines {
  readonly #listeners = new Map<string, Set<(message: unknown) => void>>();

  line(key: string): CloudLine {
    const listeners = this.#listeners.get(key) ?? new Set();
    this.#listeners.set(key, listeners);
    const own = new Set<(message: unknown) => void>();
    return {
      post: (message) => {
        const copy = structuredClone(message);
        for (const listener of listeners)
          if (!own.has(listener)) void Promise.resolve().then(() => listener(copy));
      },
      listen: (listener) => {
        listeners.add(listener);
        own.add(listener);
        return () => {
          listeners.delete(listener);
          own.delete(listener);
        };
      },
      close: () => {
        for (const listener of own) listeners.delete(listener);
        own.clear();
      },
    };
  }
}

/**
 * For tests: the uploads of one browser in memory. Each window gets a store of its own with
 * `window`, which shares the records, the turns and the lines with the others, as the windows of
 * a browser do.
 */
export class MemoryUploads {
  readonly #records = new Map<string, UploadRecord>();
  readonly #listeners = new Set<(key: string) => void>();
  readonly writers = new MemoryWriters();
  readonly #lines = new MemoryLines();
  /** For tests that are about it: putting fails. */
  failPut = false;

  #changed(keys: Iterable<string>): void {
    for (const key of new Set(keys))
      for (const listener of this.#listeners) void Promise.resolve().then(() => listener(key));
  }

  window(page: WriterPage = { isAlive: () => true, asleep: false }): UploadStore {
    const idOf = (key: string, asset: string) => `${key}\n${asset}`;
    return {
      list: async (key) =>
        [...this.#records.values()]
          .filter((record) => key === undefined || record.key === key)
          .map((record) => structuredClone(record)),
      update: async (key, assets, change) => {
        if (this.failPut) throw new DOMException("The disk is full", "QuotaExceededError");
        const after: (UploadRecord | undefined)[] = [];
        let changes = 0;
        for (const asset of assets) {
          const id = idOf(key, asset);
          const before = this.#records.get(id);
          const next = change(before && structuredClone(before), asset);
          if (next === undefined) after.push(before && structuredClone(before));
          else if (next === null) {
            this.#records.delete(id);
            after.push(undefined);
            changes += 1;
          } else {
            const kept = structuredClone({ ...next, key, asset });
            this.#records.set(id, kept);
            after.push(structuredClone(kept));
            changes += 1;
          }
        }
        if (changes > 0) this.#changed([key]);
        return after;
      },
      forget: async (key) => {
        for (const [id, record] of this.#records) if (record.key === key) this.#records.delete(id);
        this.#changed([key]);
      },
      uploader: (key) => this.writers.writer(`uploads.${key}`, page),
      line: (key) => this.#lines.line(key),
      listen: (listener) => {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
      },
    };
  }
}
