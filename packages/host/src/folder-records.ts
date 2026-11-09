import type { FolderBases, FolderBasesChange, FolderFileRecord } from "./index.ts";
import type { RecordStore, StoredRecord } from "./local-folders.ts";

/**
 * Folders that were opened get a database of their own, like exports and what is being tried: a new
 * version of the main database would lock out every page that is still open. Handles of folders can
 * only be kept in IndexedDB. What the editor last wrote or read in their files is in it too.
 */
const DATABASE = "animaquill-folders";
/** 2 added what is kept about files. Nothing used the database before that. */
const VERSION = 2;
const FOLDERS = "folders";
const BY_PROJECT = "project";
/** What is kept about each file, by the number of its folder and its path. */
const FILES = "files";
const BY_FOLDER = "folder";
/** Which turn it is to keep what is kept about the files of a folder, see `FolderBases.claim`. */
const TURNS = "turns";

/** A file as it is kept, with the folder it belongs to. */
interface StoredFile extends FolderFileRecord {
  readonly folder: string;
}

interface StoredTurn {
  readonly folder: string;
  readonly turn: number;
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
  request.addEventListener("upgradeneeded", (event) => {
    const database = request.result;
    if (event.oldVersion < 1) {
      const folders = database.createObjectStore(FOLDERS, { keyPath: "id" });
      folders.createIndex(BY_PROJECT, BY_PROJECT);
    }
    if (event.oldVersion < 2) {
      const files = database.createObjectStore(FILES, { keyPath: [BY_FOLDER, "path"] });
      files.createIndex(BY_FOLDER, BY_FOLDER);
      database.createObjectStore(TURNS, { keyPath: BY_FOLDER });
    }
  });
  return resultOf(request);
}

/** The database, opened on first use and again after losing it. A failure is not remembered. */
function connector(factory: () => IDBFactory): () => Promise<IDBDatabase> {
  let opening: Promise<IDBDatabase> | undefined;
  return () => {
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
}

/** One connection for each factory, which the records and the files share. */
const connections = new WeakMap<() => IDBFactory, () => Promise<IDBDatabase>>();

function databaseOf(factory: () => IDBFactory): () => Promise<IDBDatabase> {
  let database = connections.get(factory);
  if (!database) {
    database = connector(factory);
    connections.set(factory, database);
  }
  return database;
}

/** "strict" waits for the disk: a folder that people chose is not something to choose again. */
async function write(
  database: () => Promise<IDBDatabase>,
  stores: string | string[],
  work: (transaction: IDBTransaction) => void,
): Promise<void> {
  const transaction = (await database()).transaction(stores, "readwrite", {
    durability: "strict",
  });
  work(transaction);
  await committed(transaction);
}

/** Keeps the folders that were opened in this browser, with their handles. */
export function createRecordStore(factory: () => IDBFactory): RecordStore {
  const database = databaseOf(factory);
  const reading = async () => (await database()).transaction(FOLDERS).objectStore(FOLDERS);
  const change = (work: (folders: IDBObjectStore) => void) =>
    write(database, FOLDERS, (transaction) => work(transaction.objectStore(FOLDERS)));

  return {
    list: async () => resultOf<StoredRecord[]>((await reading()).getAll()),
    get: async (id) => resultOf<StoredRecord | undefined>((await reading()).get(id)),
    put: (record) => change((folders) => folders.put(record)),
    remove: (id) => change((folders) => folders.delete(id)),
    withProject: async (project) =>
      resultOf<StoredRecord[]>((await reading()).index(BY_PROJECT).getAll(project)),
  };
}

const withoutFolder = ({ folder: _folder, ...record }: StoredFile): FolderFileRecord => record;

/** Takes away everything kept about the files of a folder, as part of a transaction. */
function removeAllOf(files: IDBObjectStore, folder: string, then: () => void): void {
  const keys = files.index(BY_FOLDER).getAllKeys(folder);
  keys.addEventListener("success", () => {
    for (const key of keys.result) files.delete(key);
    then();
  });
}

/** Keeps what the editor last wrote or read in the files of folders, in the same database. */
export function createBaseStore(factory: () => IDBFactory): FolderBases {
  const database = databaseOf(factory);
  return {
    async claim(folder) {
      let turn = 0;
      await write(database, TURNS, (transaction) => {
        const turns = transaction.objectStore(TURNS);
        const read = turns.get(folder);
        read.addEventListener("success", () => {
          turn = ((read.result as StoredTurn | undefined)?.turn ?? 0) + 1;
          turns.put({ folder, turn } satisfies StoredTurn);
        });
      });
      return turn;
    },
    async turnOf(folder) {
      const transaction = (await database()).transaction(TURNS);
      const read = transaction.objectStore(TURNS).get(folder);
      return (await resultOf<StoredTurn | undefined>(read))?.turn ?? 0;
    },
    async load(folder) {
      const transaction = (await database()).transaction(FILES);
      const index = transaction.objectStore(FILES).index(BY_FOLDER);
      return (await resultOf<StoredFile[]>(index.getAll(folder))).map(withoutFolder);
    },
    async save(folder, turn, { put = [], remove = [], replace = false }: FolderBasesChange) {
      let isTheirs = false;
      await write(database, [FILES, TURNS], (transaction) => {
        const files = transaction.objectStore(FILES);
        const read = transaction.objectStore(TURNS).get(folder);
        const keep = () => {
          for (const path of remove) files.delete([folder, path]);
          for (const record of put) files.put({ ...record, folder } satisfies StoredFile);
        };
        read.addEventListener("success", () => {
          // Another window took over: what this one has is from before, and keeping it would put
          // back what the folder had then.
          if ((read.result as StoredTurn | undefined)?.turn !== turn) {
            isTheirs = true;
            return;
          }
          if (replace) removeAllOf(files, folder, keep);
          else keep();
        });
      });
      return !isTheirs;
    },
    forget: (folder) =>
      write(database, [FILES, TURNS], (transaction) => {
        removeAllOf(transaction.objectStore(FILES), folder, () => {});
        transaction.objectStore(TURNS).delete(folder);
      }),
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

/** What a browser in memory keeps about the files of folders, for all of its pages. */
export interface MemoryBases {
  readonly turns: Map<string, number>;
  readonly files: Map<string, Map<string, FolderFileRecord>>;
}

export const memoryBases = (): MemoryBases => ({ turns: new Map(), files: new Map() });

/**
 * What the editor last wrote or read in files, kept in memory the way a database keeps it: by value,
 * all of a change or nothing. `check` runs first for each call and can throw, as for a page whose
 * browser went away.
 */
export function memoryBaseStore(kept: MemoryBases, check: () => void = () => {}): FolderBases {
  const filesOf = (folder: string) => {
    let files = kept.files.get(folder);
    if (!files) {
      files = new Map();
      kept.files.set(folder, files);
    }
    return files;
  };
  return {
    async claim(folder) {
      check();
      const turn = (kept.turns.get(folder) ?? 0) + 1;
      kept.turns.set(folder, turn);
      return turn;
    },
    async turnOf(folder) {
      check();
      return kept.turns.get(folder) ?? 0;
    },
    async load(folder) {
      check();
      return [...(kept.files.get(folder)?.values() ?? [])].map((record) => structuredClone(record));
    },
    async save(folder, turn, { put = [], remove = [], replace = false }) {
      check();
      if (kept.turns.get(folder) !== turn) return false;
      const files = filesOf(folder);
      if (replace) files.clear();
      for (const path of remove) files.delete(path);
      for (const record of put) files.set(record.path, structuredClone(record));
      return true;
    },
    async forget(folder) {
      check();
      kept.files.delete(folder);
      kept.turns.delete(folder);
    },
  };
}
