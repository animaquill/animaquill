import { browserChats, browserKeys } from "./ai.ts";
import { createWorkCache } from "./caches.ts";
import { createExportStore } from "./exports.ts";
import { browserFolders } from "./folders.ts";
import { dropTarget } from "./growing.ts";
import { isMadeFile } from "./index.ts";
import { browserLocalFolders } from "./local-folders.ts";
import { browserCoverStore } from "./covers.ts";
import { browserOrganizer } from "./organizer.ts";
import { browserPresence } from "./presence.ts";
import type {
  ChangeSource,
  Host,
  IncomingProject,
  LogEntry,
  MediaStore,
  ProjectAddress,
  ProjectLibrary,
  ProjectLog,
  ProjectSummary,
  MadeFile,
  MakingNotes,
  SettingsStore,
  StoragePersistence,
  WindowPlace,
  WindowPlaces,
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
/**
 * What is being tried gets a database of its own, and so does code that is not saved. They come and
 * go, and a new version of the main database would lock out every page that is still open, for
 * something that is not even a project. For the same reason each has one of its own.
 */
const PLACE_DATABASE_VERSION = 1;

/** What a window keeps for itself, by what it calls it, and what its database is called. */
interface PlaceKind {
  /** Also the name of its store, with an "s", and part of the names of its locks and memory. */
  readonly name: string;
  readonly database: string;
}

const TRIALS: PlaceKind = { name: "trial", database: "animaquill-trials" };
const DRAFTS: PlaceKind = { name: "draft", database: "animaquill-drafts" };
/** Without locks all windows share one place, which is the best that can be done. */
const ONLY_PLACE = "only";
/** A page that goes away holds on to its locks for a moment. */
const LEAVING_WAIT_MS = 300;
/**
 * A window that gets reloaded is waiting for itself, so it can wait longer. It is the same wait for
 * a window that got duplicated with its memory, which gets a place of its own after that.
 */
const OWN_PLACE_WAIT_MS = 3000;
const LOCK_POLL_MS = 100;

interface MediaRecord {
  readonly project: string;
  readonly hash: string;
  readonly file: Blob;
  /** Only made files have this, see `isMadeFile`. */
  readonly usedAt?: number;
}

interface UpdateRecord {
  readonly seq?: number;
  readonly project: string;
  readonly update: Uint8Array;
  /** Who made it, see `ChangeSource`. Records of older editors have none. */
  readonly source?: ChangeSource;
}

/** What the log puts together when it gets shorter, see `ProjectLog.compact`. */
const MERGED: ChangeSource = { kind: "merged" };

interface PlaceRecord {
  readonly project: string;
  readonly place: string;
  /** Which project with this id it belongs to: see ProjectRecord. */
  readonly instance: string | undefined;
  /** Milliseconds since 1970. */
  readonly savedAt: number;
  /** What is kept. The name is from when there were only trials, and records have it. */
  readonly trial: unknown;
}

interface ProjectRecord extends ProjectSummary {
  /** A project that is still on its way in holds on to its id, and stays out of the list. */
  readonly incoming?: true;
  /**
   * Different for every project, also for two that have the same id one after the other, so that a
   * window of the first one does not take the second one for its own. Projects saved before this
   * was added have none, and go on working: nothing else can be without one.
   */
  readonly instance?: string;
}

const newInstance = () => crypto.getRandomValues(new Uint32Array(4)).join("-");

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

function openPlaceDatabase(factory: IDBFactory, { name, database }: PlaceKind) {
  const request = factory.open(database, PLACE_DATABASE_VERSION);
  request.addEventListener("upgradeneeded", () => {
    const places = request.result.createObjectStore(`${name}s`, {
      keyPath: [BY_PROJECT, "place"],
    });
    places.createIndex(BY_PROJECT, BY_PROJECT);
  });
  return resultOf(request);
}

/**
 * The connection to the database, opened on first use. It reconnects after losing the connection,
 * and a failed attempt is not remembered, so that a passing problem stays a passing problem.
 */
function connector(open: () => Promise<IDBDatabase>): () => Promise<IDBDatabase> {
  let opening: Promise<IDBDatabase> | undefined;
  const forget = () => {
    opening = undefined;
  };
  const connect = async () => {
    const database = await open();
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

/** Whether a project is the one with this instance, and not one that came after it with its id. */
const isInstance = (record: ProjectRecord | undefined, instance: string | undefined) =>
  record !== undefined && !record.incoming && record.instance === instance;

function openLog(
  database: () => Promise<IDBDatabase>,
  id: string,
  instance: string | undefined,
): ProjectLog {
  // Windows on another project with this id have nothing to say to this one.
  const channel = channelFor(instance === undefined ? id : `${id}.${instance}`);
  const isOurs = (record: ProjectRecord | undefined) => isInstance(record, instance);

  return {
    async load() {
      const transaction = (await database()).transaction(UPDATES);
      const index = transaction.objectStore(UPDATES).index(BY_PROJECT);
      const records = await resultOf<UpdateRecord[]>(index.getAll(id));
      return records.map((record) => record.update);
    },
    async entries(after = 0) {
      const transaction = (await database()).transaction(UPDATES);
      const index = transaction.objectStore(UPDATES).index(BY_PROJECT);
      // The index has the records of a project in the order they came in: from the first one after
      // the mark on, and nothing of other projects.
      const found: LogEntry[] = [];
      await new Promise<void>((resolve, reject) => {
        const request = index.openCursor(IDBKeyRange.only(id));
        let isFirst = true;
        request.addEventListener("error", () => reject(request.error));
        request.addEventListener("success", () => {
          const cursor = request.result;
          if (!cursor) {
            resolve();
            return;
          }
          const record = cursor.value as UpdateRecord;
          const mark = record.seq as number;
          if (isFirst && after > 0 && mark <= after) {
            isFirst = false;
            cursor.continuePrimaryKey(id, after + 1);
            return;
          }
          isFirst = false;
          if (mark > after) found.push({ update: record.update, source: record.source, mark });
          cursor.continue();
        });
      });
      return found;
    },
    async append(update, name, source) {
      // "strict" waits for the disk, so that a power cut cannot take back what looks saved. Slow
      // writes do no harm: changes that arrive in the meantime go along with the next one.
      const transaction = (await database()).transaction([UPDATES, PROJECTS], "readwrite", {
        durability: "strict",
      });
      transaction
        .objectStore(UPDATES)
        .add({ project: id, update, ...(source && { source }) } satisfies UpdateRecord);
      const projects = transaction.objectStore(PROJECTS);
      const read = projects.get(id);
      read.addEventListener("success", () => {
        const record = read.result as ProjectRecord | undefined;
        // Writing on would leave data behind that nothing can ever reach, and to a project that
        // has taken over the id it would be changes to a document it does not have.
        if (isOurs(record)) projects.put({ ...record, name, updatedAt: Date.now() });
        else transaction.abort();
      });
      await committed(transaction);
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- not a window
      channel?.postMessage(update);
    },
    async compact(merge, { through } = {}) {
      const transaction = (await database()).transaction([UPDATES, PROJECTS], "readwrite");
      const updates = transaction.objectStore(UPDATES);
      const owner = transaction.objectStore(PROJECTS).get(id);
      const read = updates.index(BY_PROJECT).getAll(id);
      read.addEventListener("success", () => {
        // What is not on a platform yet stays as it is, see `ProjectLog.compact`.
        const records = (read.result as UpdateRecord[]).filter(
          (record) => through === undefined || (record.seq as number) <= through,
        );
        if (records.length < 2 || !isOurs(owner.result as ProjectRecord | undefined)) return;
        const merged = merge(records.map((record) => record.update));
        for (const record of records) updates.delete(record.seq as number);
        updates.add({ project: id, update: merged, source: MERGED } satisfies UpdateRecord);
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

function refuseUnmade(name: string): void {
  if (!isMadeFile(name)) throw new Error(`Only files the editor made can go this way: ${name}`);
}

/** How much of a file a copy reads at a time, see `ownCopy`. */
const COPY_PART_BYTES = 16 * 1024 * 1024;

/**
 * The bytes of a file, in a blob of their own. Where its database is in memory, as in a private
 * window, IndexedDB keeps a file people chose as a reference to the file on their disk: once that
 * goes, moves or changes, what was kept cannot be read any more, and the project has lost it. A
 * copy is the browser's own, whatever happens to the file. It is read part by part, so that a large
 * video never is in memory here as a whole: the browser keeps the parts, on its disk where it can.
 */
async function ownCopy(file: Blob): Promise<Blob> {
  const parts: Blob[] = [];
  for (let at = 0; at < file.size; at += COPY_PART_BYTES) {
    parts.push(new Blob([await file.slice(at, at + COPY_PART_BYTES).arrayBuffer()]));
  }
  return new Blob(parts, { type: file.type });
}

/**
 * Whether what a record holds can still be read. A file kept as a reference before `ownCopy`, as in
 * a private window, cannot once the file on the disk went or changed: that is a file the project
 * does not have, which people can bring in again, not one that fails wherever it is used.
 */
async function canRead(file: Blob): Promise<boolean> {
  try {
    await file.slice(0, 1).arrayBuffer();
    return true;
  } catch {
    return false;
  }
}

function openMedia(database: () => Promise<IDBDatabase>, project: string): MediaStore {
  return {
    async put(hash, file) {
      const copy = await ownCopy(file);
      const transaction = (await database()).transaction(MEDIA, "readwrite");
      const used = isMadeFile(hash) ? { usedAt: Date.now() } : {};
      transaction
        .objectStore(MEDIA)
        .put({ project, hash, file: copy, ...used } satisfies MediaRecord);
      await committed(transaction);
      // What is kept now is what comes back, as large as the file was.
      const read = (await database()).transaction(MEDIA).objectStore(MEDIA).get([project, hash]);
      const kept = (await resultOf<MediaRecord | undefined>(read))?.file;
      if (!kept || kept.size !== file.size || !(await canRead(kept))) {
        throw new Error(`The file ${hash} was not kept as it is`);
      }
    },
    async listMade() {
      const transaction = (await database()).transaction(MEDIA);
      const index = transaction.objectStore(MEDIA).index(BY_PROJECT);
      // Records hold their files by reference, so reading them reads none of the files.
      const records = await resultOf<MediaRecord[]>(index.getAll(project));
      return records.flatMap(({ hash, file, usedAt = 0 }): MadeFile[] =>
        isMadeFile(hash) ? [{ name: hash, size: file.size, usedAt }] : [],
      );
    },
    async touchMade(name) {
      if (!isMadeFile(name)) return;
      const transaction = (await database()).transaction(MEDIA, "readwrite");
      const media = transaction.objectStore(MEDIA);
      const record = await resultOf<MediaRecord | undefined>(media.get([project, name]));
      if (record) media.put({ ...record, usedAt: Date.now() } satisfies MediaRecord);
      await committed(transaction);
    },
    async removeMade(name) {
      refuseUnmade(name);
      const transaction = (await database()).transaction(MEDIA, "readwrite");
      transaction.objectStore(MEDIA).delete([project, name]);
      await committed(transaction);
    },
    async get(hash) {
      const transaction = (await database()).transaction(MEDIA);
      const request = transaction.objectStore(MEDIA).get([project, hash]);
      const record = await resultOf<MediaRecord | undefined>(request);
      if (!record) return undefined;
      if (await canRead(record.file)) return record.file;
      console.warn("A file kept in this browser cannot be read any more", hash);
      return undefined;
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
  database: () => Promise<IDBDatabase>,
  lockManager: () => LockManager | undefined,
  forgetPlaces: (project: string) => Promise<unknown>,
): ProjectLibrary {
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
  const claim = async (id: string, name: string, instance: string, folder: boolean) => {
    const transaction = (await database()).transaction(PROJECTS, "readwrite");
    const projects = transaction.objectStore(PROJECTS);
    const read = projects.get(id);
    let free = false;
    read.addEventListener("success", () => {
      free = read.result === undefined;
      const record: ProjectRecord = {
        id,
        name,
        updatedAt: Date.now(),
        incoming: true,
        instance,
        ...(folder && { folder: true }),
      };
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
    async receive({ id, name, folder = false }) {
      const locks = lockManager();
      // Tidying up is no reason for this to fail. It gets another chance the next time.
      await (locks && sweep(locks))?.catch((error: unknown) => {
        console.warn("Could not clean up after a project that did not arrive", error);
      });
      // The lock comes first, so that a record of this project always has somebody holding it.
      const release = locks ? await hold(locks, incomingLock(id)) : () => {};
      if (!release) return undefined;
      const instance = newInstance();
      try {
        if (!(await claim(id, name, instance, folder))) {
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
          const record: ProjectRecord = {
            id,
            name,
            updatedAt: Date.now(),
            instance,
            ...(folder && { folder: true }),
          };
          transaction.objectStore(PROJECTS).put(record);
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
    async create({ id, name, folder = false }, state) {
      const transaction = (await database()).transaction([UPDATES, PROJECTS], "readwrite");
      const record: ProjectRecord = {
        id,
        name,
        updatedAt: Date.now(),
        instance: newInstance(),
        ...(folder && { folder: true }),
      };
      transaction.objectStore(PROJECTS).add(record);
      transaction.objectStore(UPDATES).add({ project: id, update: state } satisfies UpdateRecord);
      await committed(transaction);
    },
    async open(id) {
      // Without this the browser may clear the data when it runs short of space. The answer can
      // change as the site gets used, so it is worth asking every time.
      void navigator.storage?.persist?.()?.catch(() => {});
      const transaction = (await database()).transaction(PROJECTS);
      const request = transaction.objectStore(PROJECTS).get(id);
      const record = await resultOf<ProjectRecord | undefined>(request);
      return openLog(database, id, record?.instance);
    },
    media: (id) => openMedia(database, id),
    async remove(id, { folder = false } = {}) {
      const transaction = (await database()).transaction(allStores, "readwrite");
      const read = transaction.objectStore(PROJECTS).get(id);
      let isFolder = false;
      read.addEventListener("success", () => {
        // A folder relies on its log: it only goes with the folder, off the list of folders.
        isFolder = (read.result as ProjectRecord | undefined)?.folder === true && !folder;
        if (isFolder) transaction.abort();
        else removeFrom(transaction, id);
      });
      await committed(transaction).catch((error: unknown) => {
        if (isFolder) throw new Error(`Project ${id} is a folder: it goes with its folder`);
        throw error;
      });
      // The project is gone either way, and what stays behind gets swept up later.
      await forgetPlaces(id).catch((error: unknown) => {
        console.warn("What windows kept of a project that is gone stays for now", error);
      });
    },
    async toFolder(id) {
      // "strict", as for its log: from here on the browser keeps it by its folder.
      const transaction = (await database()).transaction(PROJECTS, "readwrite", {
        durability: "strict",
      });
      const projects = transaction.objectStore(PROJECTS);
      const read = projects.get(id);
      let isThere = false;
      read.addEventListener("success", () => {
        const record = read.result as ProjectRecord | undefined;
        if (!record || record.incoming) return;
        isThere = true;
        // Its instance stays, which is what windows of it and what they keep go by.
        if (!record.folder) projects.put({ ...record, folder: true } satisfies ProjectRecord);
      });
      await committed(transaction);
      if (!isThere) throw new Error(`No project ${id} to keep by its folder`);
    },
    async copies(id) {
      const transaction = (await database()).transaction(MEDIA);
      const index = transaction.objectStore(MEDIA).index(BY_PROJECT);
      // Records hold their files by reference, so reading them reads none of the files.
      const records = await resultOf<MediaRecord[]>(index.getAll(id));
      return records.flatMap(({ hash, file }) =>
        isMadeFile(hash) ? [] : [{ name: hash, size: file.size }],
      );
    },
    async dropCopies(id, names) {
      const transaction = (await database()).transaction([PROJECTS, MEDIA], "readwrite");
      const read = transaction.objectStore(PROJECTS).get(id);
      let isFolder = false;
      read.addEventListener("success", () => {
        const record = read.result as ProjectRecord | undefined;
        isFolder = record?.folder === true && !record.incoming;
        // The files of a project of the browser are the only ones it has.
        if (!isFolder) return;
        const media = transaction.objectStore(MEDIA);
        for (const name of names) if (!isMadeFile(name)) media.delete([id, name]);
      });
      await committed(transaction);
      if (!isFolder) throw new Error(`Project ${id} is no folder: its files are its own`);
    },
  };
  return library;
}

/** A place for each window on each project, for one kind of thing that windows keep. */
function createPlaces(
  kind: PlaceKind,
  projects: () => Promise<IDBDatabase>,
  factory: () => IDBFactory,
  lockManager: () => LockManager | undefined,
  memory: WindowMemory,
) {
  const database = connector(() => openPlaceDatabase(factory(), kind));
  const storeName = `${kind.name}s`;
  const placeLock = (project: string, place: string) => `${PREFIX}${kind.name}.${project}.${place}`;
  const memoryKey = (project: string) => `${kind.name}.${project}`;
  let isSwept = false;

  const projectOf = async (project: string) => {
    const transaction = (await projects()).transaction(PROJECTS);
    return resultOf<ProjectRecord | undefined>(transaction.objectStore(PROJECTS).get(project));
  };

  /** Places with something in them on this project, the most recent first. */
  const keptPlaces = async (project: string, instance: string | undefined) => {
    const transaction = (await database()).transaction(storeName);
    const index = transaction.objectStore(storeName).index(BY_PROJECT);
    const records = await resultOf<PlaceRecord[]>(index.getAll(project));
    return records
      .filter((record) => record.instance === instance)
      .toSorted((a, b) => b.savedAt - a.savedAt)
      .map(({ place }) => place);
  };

  /** Takes away what belongs to a project that is gone, for all of it or for one. */
  const remove = async (isGone: (record: PlaceRecord) => boolean) => {
    const transaction = (await database()).transaction(storeName, "readwrite");
    const kept = transaction.objectStore(storeName);
    const read = kept.getAll();
    read.addEventListener("success", () => {
      for (const record of read.result as PlaceRecord[]) {
        if (isGone(record)) kept.delete([record.project, record.place]);
      }
    });
    await committed(transaction);
  };

  /**
   * What removing a project could not reach, because it is two databases and that can fail halfway.
   * Once per page is enough, and it is no reason for anything else to fail.
   */
  const sweep = async () => {
    if (isSwept) return;
    isSwept = true;
    const transaction = (await projects()).transaction(PROJECTS);
    const all = await resultOf<ProjectRecord[]>(transaction.objectStore(PROJECTS).getAll());
    const instances = new Map(all.map(({ id, instance }) => [id, instance]));
    await remove(
      ({ project, instance }) => !instances.has(project) || instances.get(project) !== instance,
    );
  };

  /** The first of these places that no window holds. */
  const firstFree = async (locks: LockManager, project: string, places: readonly string[]) => {
    for (const place of places) {
      const release = await hold(locks, placeLock(project, place));
      if (release) return { place, release };
    }
    return undefined;
  };

  /** Keeps asking for a while. Resolves to undefined when somebody else keeps holding on to it. */
  const waitFor = async (locks: LockManager, name: string, wait: number) => {
    const until = Date.now() + wait;
    for (;;) {
      const release = await hold(locks, name);
      if (release || Date.now() >= until) return release;
      await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
    }
  };

  const placeOf = (
    project: string,
    place: string,
    instance: string | undefined,
    release: () => void,
  ): WindowPlace => {
    memory.write(memoryKey(project), place);
    return {
      async load() {
        const transaction = (await database()).transaction(storeName);
        const request = transaction.objectStore(storeName).get([project, place]);
        const record = await resultOf<PlaceRecord | undefined>(request);
        return record?.instance === instance ? record?.trial : undefined;
      },
      async save(trial) {
        // This starts right here, with nothing to wait for: the page may be on its way out. Asking
        // whether the project is still there first would cost that, and sweeping takes care of it.
        // "strict" for the same reason as a project: what people tried should survive a power cut.
        const transaction = (await database()).transaction(storeName, "readwrite", {
          durability: "strict",
        });
        const kept = transaction.objectStore(storeName);
        if (trial === undefined) kept.delete([project, place]);
        else {
          const record: PlaceRecord = { project, place, instance, savedAt: Date.now(), trial };
          kept.put(record);
        }
        await committed(transaction);
      },
      close: release,
    };
  };

  const store: WindowPlaces = {
    async open(project) {
      void sweep().catch((error: unknown) => {
        console.warn("Could not clean up after projects that are gone", error);
      });
      const instance = (await projectOf(project))?.instance;
      const locks = lockManager();
      if (!locks) return placeOf(project, ONLY_PLACE, instance, () => {});
      // Its own place first: a window that comes back has to find what it left, and nothing else.
      const own = memory.read(memoryKey(project));
      if (own !== undefined) {
        const release = await waitFor(locks, placeLock(project, own), OWN_PLACE_WAIT_MS);
        if (release) return placeOf(project, own, instance, release);
      }
      const places = await keptPlaces(project, instance);
      const others = places.filter((place) => place !== own);
      let free = await firstFree(locks, project, others);
      if (!free && own === undefined && others.length > 0) {
        await new Promise((resolve) => setTimeout(resolve, LEAVING_WAIT_MS));
        free = await firstFree(locks, project, others);
      }
      if (free) return placeOf(project, free.place, instance, free.release);
      const place = newInstance();
      const release = await hold(locks, placeLock(project, place));
      return placeOf(project, place, instance, release ?? (() => {}));
    },
    async holds(project) {
      // Of the project that is there now: what one that went before it left is swept away.
      const instance = (await projectOf(project))?.instance;
      return (await keptPlaces(project, instance)).length > 0;
    },
  };
  return {
    store,
    forget: (project: string) => remove((record) => record.project === project),
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
  linkTo(id) {
    // What else the address says, such as which site this is, stays as it is.
    const url = new URL(location.href);
    url.hash = "";
    url.searchParams.set(PROJECT_PARAM, id);
    return url.href;
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

/**
 * Says that projects stay in this browser here, as where it cannot write folders, see `LocalFolders`.
 * Tests of everything else set it, as a page cannot answer the browser's dialog for a folder.
 */
export { browserCloud, browserCloudLinks, webSocketConnection } from "./cloud.ts";
export { browserOrganizer } from "./organizer.ts";
export { browserCoverAccess, browserCoverStore, memoryCoverStore } from "./covers.ts";
export { browserOrganizerAccess, OrganizerBusy } from "./organizer-access.ts";
export type { BrowserCoverAccessOptions } from "./covers.ts";
export type { BrowserCloudOptions } from "./cloud.ts";
export { browserRepository, statusOf } from "./repository.ts";
export type { BrowserRepositoryOptions } from "./repository.ts";
export { browserLfs, uploadOf } from "./lfs.ts";
export type { BrowserLfsOptions } from "./lfs.ts";
export { browserCloudProjects, projectSummaryOf } from "./cloud-projects.ts";
export type { BrowserCloudProjectsOptions } from "./cloud-projects.ts";

/**
 * For tests only: projects stay in this browser, as where it cannot write folders, and a new one can
 * be made there, see `Host.projectsHereForTests`. Tests of everything that is not about folders set
 * it, as a page cannot answer the browser's dialog for a folder.
 */
export const PROJECTS_HERE_KEY = "animaquill.projectsInBrowser";

/**
 * Whether the browser keeps what the editor stores, as `navigator.storage` says, see
 * `StoragePersistence`. Safari is the one that clears it after seven days without a visit: no
 * interface says so, so its name does, and an installed app is not cleared.
 */
export function browserPersistence(
  local: () => Storage = () => localStorage,
): StoragePersistence | undefined {
  if (typeof navigator === "undefined") return undefined;
  const storage = navigator.storage as StorageManager | undefined;
  const agent = navigator.userAgent;
  const isSafari =
    /Safari\//.test(agent) &&
    !/Chrome\/|Chromium\/|CriOS\/|FxiOS\/|EdgiOS\/|Edg\/|Android/.test(agent);
  const isInstalled =
    (navigator as { standalone?: boolean }).standalone === true ||
    (typeof matchMedia === "function" && matchMedia("(display-mode: standalone)").matches);
  const asked = () => {
    try {
      return local().getItem(PERSIST_ASKED_KEY) === "yes";
    } catch {
      return false;
    }
  };
  return {
    // A browser without the interface keeps nothing for good: Safari before 15.2.
    persisted: async () =>
      typeof storage?.persisted === "function" ? storage.persisted().catch(() => false) : false,
    persist: async () => {
      if (typeof storage?.persist !== "function") return false;
      if (asked())
        return typeof storage.persisted === "function"
          ? storage.persisted().catch(() => false)
          : false;
      try {
        local().setItem(PERSIST_ASKED_KEY, "yes");
      } catch {
        // Asked again next time, then.
      }
      return storage.persist().catch(() => false);
    },
    wasAsked: asked,
    clearsWhenIdle: isSafari && !isInstalled,
  };
}

/** Where this browser remembers that it was asked to keep what the site stores, see `persist`. */
const PERSIST_ASKED_KEY = "animaquill.persistAsked";

/** Where the projects of the platform that windows began to make are noted, see `MakingNotes`. */
const MAKING_KEY = "animaquill.cloud.making";

/** The notes in local storage, and the holds as locks: a page that goes away lets go of them. */
export function browserMakingNotes(
  local: () => Storage = () => localStorage,
  locks: () => LockManager | undefined = () => navigator.locks,
): MakingNotes {
  const read = (): string[] => {
    try {
      const kept: unknown = JSON.parse(local().getItem(MAKING_KEY) || "[]");
      return Array.isArray(kept) ? kept.filter((id): id is string => typeof id === "string") : [];
    } catch {
      return [];
    }
  };
  const write = (ids: readonly string[]) => {
    try {
      local().setItem(MAKING_KEY, JSON.stringify(ids));
    } catch (error) {
      console.warn("What is being made on the platform could not be noted", error);
    }
  };
  const lockOf = (project: string) => `${PREFIX}making.${project}`;
  return {
    list: read,
    note: (project) => write([...read().filter((id) => id !== project), project]),
    forget: (project) => write(read().filter((id) => id !== project)),
    hold: async (project) => {
      const manager = locks();
      if (!manager) return () => {};
      return new Promise<() => void>((resolve, reject) => {
        manager
          .request(lockOf(project), () => new Promise<void>((release) => resolve(release)))
          .catch(reject);
      });
    },
    isHeld: async (project) => {
      const manager = locks();
      if (!manager) return true;
      try {
        return await manager.request(
          lockOf(project),
          { ifAvailable: true },
          (lock) => lock === null,
        );
      } catch {
        return true;
      }
    },
  };
}

function keepsProjectsHere(storage: () => Storage): boolean {
  try {
    return storage().getItem(PROJECTS_HERE_KEY) === "yes";
  } catch {
    return false;
  }
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
  const windowMemory = createWindowMemory(windowStorage);
  const projects = connector(() => openDatabase(database()));
  const trials = createPlaces(TRIALS, projects, database, locks, windowMemory);
  const drafts = createPlaces(DRAFTS, projects, database, locks, windowMemory);
  const exports = createExportStore(database, locks);
  const chats = browserChats(database);
  const covers = browserCoverStore(database);
  // What an export kept of a project that is gone would only take room on the disk.
  const forget = async (project: string) => {
    await Promise.all([
      trials.forget(project),
      drafts.forget(project),
      chats.forget(project).catch(() => {}),
      covers.forget(project).catch(() => {}),
    ]);
    for (const saved of await exports.list(project).catch(() => [])) {
      // One that a window is at is that window's to finish or give up.
      const release = await exports.claim(saved.id);
      if (!release) continue;
      await exports.remove(saved.id).catch(() => {});
      release();
      // Its file too, while that is still the empty one it made. Nothing asks about it now, and
      // without knowing where the other exports go it stays.
      const all = await exports.all().catch(() => undefined);
      if (!all) continue;
      await dropTarget(
        saved.target,
        all.map(({ target }) => target),
        false,
      ).catch(() => {});
    }
  };
  const persistence = browserPersistence(storage);
  const making = browserMakingNotes(storage, locks);
  const localFolders = keepsProjectsHere(storage)
    ? undefined
    : browserLocalFolders(database, locks);
  return {
    settings,
    projects: createLibrary(projects, locks, forget),
    address,
    windowMemory,
    folders: browserFolders(),
    ...(localFolders && { localFolders }),
    ...(!localFolders && keepsProjectsHere(storage) && { projectsHereForTests: true as const }),
    ...(persistence && { persistence }),
    making,
    trials: trials.store,
    drafts: drafts.store,
    exports,
    caches: createWorkCache(database),
    presence: browserPresence(locks),
    keys: browserKeys(database),
    chats,
    organizer: browserOrganizer(database),
    covers,
  };
}
