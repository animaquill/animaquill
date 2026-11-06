import { browserFolders } from "./folders.ts";
import type {
  Host,
  IncomingProject,
  MediaStore,
  ProjectAddress,
  ProjectLibrary,
  ProjectLog,
  ProjectSummary,
  SettingsStore,
  WindowMemory,
} from "./index.ts";

const PREFIX = "animaquill.";
const DATABASE = "animaquill";
const DATABASE_VERSION = 2;
const PROJECTS = "projects";
const UPDATES = "updates";
const MEDIA = "media";
const BY_PROJECT = "project";
const PROJECT_PARAM = "project";

interface MediaRecord {
  readonly project: string;
  readonly hash: string;
  readonly file: Blob;
}

interface UpdateRecord {
  readonly seq?: number;
  readonly project: string;
  readonly update: Uint8Array;
}

/** A project that is still on its way in holds on to its id, and stays out of the list. */
interface ProjectRecord extends ProjectSummary {
  readonly incoming?: true;
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

function openDatabase(factory: IDBFactory): Promise<IDBDatabase> {
  const request = factory.open(DATABASE, DATABASE_VERSION);
  request.addEventListener("upgradeneeded", () => {
    const database = request.result;
    if (!database.objectStoreNames.contains(PROJECTS)) {
      database.createObjectStore(PROJECTS, { keyPath: "id" });
      const updates = database.createObjectStore(UPDATES, { keyPath: "seq", autoIncrement: true });
      updates.createIndex(BY_PROJECT, BY_PROJECT);
    }
    if (!database.objectStoreNames.contains(MEDIA)) {
      const media = database.createObjectStore(MEDIA, { keyPath: [BY_PROJECT, "hash"] });
      media.createIndex(BY_PROJECT, BY_PROJECT);
    }
  });
  return resultOf(request);
}

/**
 * The connection to the database, opened on first use. It reconnects after losing the connection,
 * and a failed attempt is not remembered, so that a passing problem stays a passing problem.
 */
function connector(factory: () => IDBFactory): () => Promise<IDBDatabase> {
  let opening: Promise<IDBDatabase> | undefined;
  const forget = () => {
    opening = undefined;
  };
  const connect = async () => {
    const database = await openDatabase(factory());
    // Another tab runs a newer version and cannot upgrade the data while this one holds on to it.
    database.addEventListener("versionchange", () => {
      database.close();
      forget();
    });
    database.addEventListener("close", forget);
    return database;
  };
  return () => {
    opening ??= connect().catch((error: unknown) => {
      forget();
      throw error;
    });
    return opening;
  };
}

/** Lets other windows of this browser see the changes of a project as they happen. */
function channelFor(id: string): BroadcastChannel | undefined {
  return typeof BroadcastChannel === "undefined"
    ? undefined
    : new BroadcastChannel(`${PREFIX}project.${id}`);
}

function openLog(database: () => Promise<IDBDatabase>, id: string): ProjectLog {
  const channel = channelFor(id);

  return {
    async load() {
      const transaction = (await database()).transaction(UPDATES);
      const index = transaction.objectStore(UPDATES).index(BY_PROJECT);
      const records = await resultOf<UpdateRecord[]>(index.getAll(id));
      return records.map((record) => record.update);
    },
    async append(update, name) {
      // "strict" waits for the disk, so that a power cut cannot take back what looks saved. Slow
      // writes do no harm: changes that arrive in the meantime go along with the next one.
      const transaction = (await database()).transaction([UPDATES, PROJECTS], "readwrite", {
        durability: "strict",
      });
      transaction.objectStore(UPDATES).add({ project: id, update } satisfies UpdateRecord);
      const projects = transaction.objectStore(PROJECTS);
      const read = projects.get(id);
      read.addEventListener("success", () => {
        const summary = read.result as ProjectSummary | undefined;
        // Writing on would leave data behind that nothing can ever reach.
        if (summary) projects.put({ ...summary, name, updatedAt: Date.now() });
        else transaction.abort();
      });
      await committed(transaction);
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- not a window
      channel?.postMessage(update);
    },
    async compact(merge) {
      const transaction = (await database()).transaction(UPDATES, "readwrite");
      const updates = transaction.objectStore(UPDATES);
      const read = updates.index(BY_PROJECT).getAll(id);
      read.addEventListener("success", () => {
        const records = read.result as UpdateRecord[];
        if (records.length < 2) return;
        const merged = merge(records.map((record) => record.update));
        for (const record of records) updates.delete(record.seq as number);
        updates.add({ project: id, update: merged } satisfies UpdateRecord);
      });
      await committed(transaction);
    },
    listen(listener) {
      const onMessage = (event: MessageEvent<Uint8Array>) => listener(event.data);
      channel?.addEventListener("message", onMessage);
      return () => channel?.removeEventListener("message", onMessage);
    },
    close() {
      channel?.close();
    },
  };
}

function openMedia(database: () => Promise<IDBDatabase>, project: string): MediaStore {
  return {
    async put(hash, file) {
      const transaction = (await database()).transaction(MEDIA, "readwrite");
      transaction.objectStore(MEDIA).put({ project, hash, file } satisfies MediaRecord);
      await committed(transaction);
    },
    async get(hash) {
      const transaction = (await database()).transaction(MEDIA);
      const request = transaction.objectStore(MEDIA).get([project, hash]);
      const record = await resultOf<MediaRecord | undefined>(request);
      return record?.file;
    },
  };
}

/** Removes all there is of a project, as part of a transaction on all stores. */
function removeFrom(transaction: IDBTransaction, id: string): void {
  transaction.objectStore(PROJECTS).delete(id);
  for (const name of [UPDATES, MEDIA]) {
    const store = transaction.objectStore(name);
    const keys = store.index(BY_PROJECT).getAllKeys(id);
    keys.addEventListener("success", () => {
      for (const key of keys.result) store.delete(key);
    });
  }
}

/**
 * Holds a lock until the returned function runs. The browser lets go by itself when a page goes
 * away, which is how a project left behind by a page that went away can be told apart from one
 * that is still coming in. Resolves to undefined when somebody else holds the lock.
 */
const hold = (locks: LockManager, name: string) =>
  new Promise<(() => void) | undefined>((resolve, reject) => {
    locks
      .request(name, { ifAvailable: true }, (lock) => {
        if (!lock) {
          resolve(undefined);
          return undefined;
        }
        return new Promise<void>((release) => resolve(release));
      })
      .catch(reject);
  });

function createLibrary(
  factory: () => IDBFactory,
  lockManager: () => LockManager | undefined,
): ProjectLibrary {
  const database = connector(factory);
  const incomingLock = (id: string) => `${PREFIX}incoming.${id}`;
  const allStores = [UPDATES, PROJECTS, MEDIA];

  /** Checks once more inside the transaction, because this deletes: it may have finished by now. */
  const removeIfIncoming = async (id: string) => {
    const transaction = (await database()).transaction(allStores, "readwrite");
    const read = transaction.objectStore(PROJECTS).get(id);
    read.addEventListener("success", () => {
      if ((read.result as ProjectRecord | undefined)?.incoming) removeFrom(transaction, id);
    });
    await committed(transaction);
  };

  /** What a page that went away had brought in so far. It would take up space for good. */
  const sweep = async (locks: LockManager) => {
    const transaction = (await database()).transaction(PROJECTS);
    const records = await resultOf<ProjectRecord[]>(transaction.objectStore(PROJECTS).getAll());
    for (const { id, incoming } of records) {
      if (!incoming) continue;
      // While this holds the lock, nobody can start bringing in a project with this id.
      const release = await hold(locks, incomingLock(id));
      if (!release) continue;
      try {
        await removeIfIncoming(id);
      } finally {
        release();
      }
    }
  };

  /** Resolves to whether the id was free. */
  const claim = async (id: string, name: string) => {
    const transaction = (await database()).transaction(PROJECTS, "readwrite");
    const projects = transaction.objectStore(PROJECTS);
    const read = projects.get(id);
    let free = false;
    read.addEventListener("success", () => {
      free = read.result === undefined;
      const record: ProjectRecord = { id, name, updatedAt: Date.now(), incoming: true };
      if (free) projects.add(record);
    });
    await committed(transaction);
    return free;
  };

  const library: ProjectLibrary = {
    async list() {
      const transaction = (await database()).transaction(PROJECTS);
      const projects = await resultOf<ProjectRecord[]>(transaction.objectStore(PROJECTS).getAll());
      return projects
        .filter((project) => !project.incoming)
        .toSorted((a, b) => b.updatedAt - a.updatedAt);
    },
    async receive({ id, name }) {
      const locks = lockManager();
      // Tidying up is no reason for this to fail. It gets another chance the next time.
      await (locks && sweep(locks))?.catch((error: unknown) => {
        console.warn("Could not clean up after a project that did not arrive", error);
      });
      // The lock comes first, so that a record of this project always has somebody holding it.
      const release = locks ? await hold(locks, incomingLock(id)) : () => {};
      if (!release) return undefined;
      try {
        if (!(await claim(id, name))) {
          release();
          return undefined;
        }
      } catch (error) {
        release();
        throw error;
      }
      const incoming: IncomingProject = {
        media: library.media(id),
        async finish(state) {
          const transaction = (await database()).transaction([UPDATES, PROJECTS], "readwrite", {
            durability: "strict",
          });
          const summary: ProjectSummary = { id, name, updatedAt: Date.now() };
          transaction.objectStore(PROJECTS).put(summary);
          transaction
            .objectStore(UPDATES)
            .add({ project: id, update: state } satisfies UpdateRecord);
          await committed(transaction);
          release();
        },
        async abandon() {
          try {
            await removeIfIncoming(id);
          } finally {
            release();
          }
        },
      };
      return incoming;
    },
    async create({ id, name }, state) {
      const transaction = (await database()).transaction([UPDATES, PROJECTS], "readwrite");
      const summary: ProjectSummary = { id, name, updatedAt: Date.now() };
      transaction.objectStore(PROJECTS).add(summary);
      transaction.objectStore(UPDATES).add({ project: id, update: state } satisfies UpdateRecord);
      await committed(transaction);
    },
    async open(id) {
      // Without this the browser may clear the data when it runs short of space. The answer can
      // change as the site gets used, so it is worth asking every time.
      void navigator.storage?.persist?.()?.catch(() => {});
      return openLog(database, id);
    },
    media: (id) => openMedia(database, id),
    async remove(id) {
      const transaction = (await database()).transaction(allStores, "readwrite");
      removeFrom(transaction, id);
      await committed(transaction);
    },
  };
  return library;
}

/** The address bar has exactly the right lifetime: one per window, kept through a reload. */
const address: ProjectAddress = {
  read: () => new URLSearchParams(location.search).get(PROJECT_PARAM) || undefined,
  write(id) {
    const url = new URL(location.href);
    if (id === undefined) url.searchParams.delete(PROJECT_PARAM);
    else url.searchParams.set(PROJECT_PARAM, id);
    history.replaceState(history.state, "", url);
  },
};

/** Session storage has the lifetime of a tab, and a duplicated tab starts with a copy of it. */
function createWindowMemory(storage: () => Storage): WindowMemory {
  return {
    read(key) {
      try {
        return storage().getItem(`${PREFIX}window.${key}`) ?? undefined;
      } catch (error) {
        console.warn("Window memory is out of reach", error);
        return undefined;
      }
    },
    write(key, value) {
      try {
        storage().setItem(`${PREFIX}window.${key}`, value);
      } catch (error) {
        console.warn("Window memory is out of reach", error);
      }
    },
  };
}

/** Keeps everything in this browser. Used until an account or a local folder can hold it. */
export function createBrowserHost(
  storage: () => Storage = () => localStorage,
  database: () => IDBFactory = () => indexedDB,
  windowStorage: () => Storage = () => sessionStorage,
  locks: () => LockManager | undefined = () => navigator.locks,
): Host {
  const settings: SettingsStore = {
    async load(key) {
      const text = storage().getItem(PREFIX + key);
      return text === null ? undefined : JSON.parse(text);
    },
    async save(key, value) {
      storage().setItem(PREFIX + key, JSON.stringify(value));
    },
    listen(key, listener) {
      // The browser tells every window but the one that wrote.
      const onStorage = (event: StorageEvent) => {
        if (event.key !== PREFIX + key || event.newValue === null) return;
        try {
          listener(JSON.parse(event.newValue));
        } catch (error) {
          console.warn(`Setting ${key} from another window is unreadable`, error);
        }
      };
      addEventListener("storage", onStorage);
      return () => removeEventListener("storage", onStorage);
    },
  };
  return {
    settings,
    projects: createLibrary(database, locks),
    address,
    windowMemory: createWindowMemory(windowStorage),
    folders: browserFolders(),
  };
}
