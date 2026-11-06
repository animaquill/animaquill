import type {
  Host,
  ProjectAddress,
  ProjectLibrary,
  ProjectLog,
  ProjectSummary,
  SettingsStore,
  WindowMemory,
} from "./index.ts";

const PREFIX = "animaquill.";
const DATABASE = "animaquill";
const DATABASE_VERSION = 1;
const PROJECTS = "projects";
const UPDATES = "updates";
const BY_PROJECT = "project";
const PROJECT_PARAM = "project";

interface UpdateRecord {
  readonly seq?: number;
  readonly project: string;
  readonly update: Uint8Array;
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
    database.createObjectStore(PROJECTS, { keyPath: "id" });
    const updates = database.createObjectStore(UPDATES, { keyPath: "seq", autoIncrement: true });
    updates.createIndex(BY_PROJECT, BY_PROJECT);
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

function createLibrary(factory: () => IDBFactory): ProjectLibrary {
  const database = connector(factory);

  return {
    async list() {
      const transaction = (await database()).transaction(PROJECTS);
      const projects = await resultOf<ProjectSummary[]>(transaction.objectStore(PROJECTS).getAll());
      return projects.toSorted((a, b) => b.updatedAt - a.updatedAt);
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
    async remove(id) {
      const transaction = (await database()).transaction([UPDATES, PROJECTS], "readwrite");
      const updates = transaction.objectStore(UPDATES);
      transaction.objectStore(PROJECTS).delete(id);
      const keys = updates.index(BY_PROJECT).getAllKeys(id);
      keys.addEventListener("success", () => {
        for (const key of keys.result) updates.delete(key);
      });
      await committed(transaction);
    },
  };
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
    projects: createLibrary(database),
    address,
    windowMemory: createWindowMemory(windowStorage),
  };
}
