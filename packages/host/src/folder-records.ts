import type { RecordStore, StoredRecord } from "./local-folders.ts";

/**
 * Folders that were opened get a database of their own, like exports and what is being tried: a new
 * version of the main database would lock out every page that is still open. Handles of folders can
 * only be kept in IndexedDB.
 */
const DATABASE = "animaquill-folders";
const VERSION = 1;
const FOLDERS = "folders";
const BY_PROJECT = "project";

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
    const folders = request.result.createObjectStore(FOLDERS, { keyPath: "id" });
    folders.createIndex(BY_PROJECT, BY_PROJECT);
  });
  return resultOf(request);
}

/** Keeps the folders that were opened in this browser, with their handles. */
export function createRecordStore(factory: () => IDBFactory): RecordStore {
  let opening: Promise<IDBDatabase> | undefined;
  /** Opened on first use, and again after losing it. A failure is not remembered. */
  const database = () => {
    opening ??= open(factory()).then(
      (opened) => {
        // Another tab runs a newer version and cannot upgrade while this one holds on to it.
        opened.addEventListener("versionchange", () => {
          opened.close();
          opening = undefined;
        });
        opened.addEventListener("close", () => {
          opening = undefined;
        });
        return opened;
      },
      (error: unknown) => {
        opening = undefined;
        throw error;
      },
    );
    return opening;
  };
  const reading = async () => (await database()).transaction(FOLDERS).objectStore(FOLDERS);
  const write = async (work: (folders: IDBObjectStore) => void) => {
    // "strict" waits for the disk: a folder that people chose is not something to choose again.
    const transaction = (await database()).transaction(FOLDERS, "readwrite", {
      durability: "strict",
    });
    work(transaction.objectStore(FOLDERS));
    await committed(transaction);
  };

  return {
    list: async () => resultOf<StoredRecord[]>((await reading()).getAll()),
    get: async (id) => resultOf<StoredRecord | undefined>((await reading()).get(id)),
    put: (record) => write((folders) => folders.put(record)),
    remove: (id) => write((folders) => folders.delete(id)),
    withProject: async (project) =>
      resultOf<StoredRecord[]>((await reading()).index(BY_PROJECT).getAll(project)),
  };
}

/** Keeps the folders in memory, for tests. */
export function memoryRecordStore(): RecordStore {
  const records = new Map<string, StoredRecord>();
  return {
    list: async () => [...records.values()],
    get: async (id) => records.get(id),
    async put(record) {
      records.set(record.id, record);
    },
    async remove(id) {
      records.delete(id);
    },
    withProject: async (project) =>
      [...records.values()].filter((record) => record.project === project),
  };
}
