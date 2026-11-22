import {
  OFFLINE_SCOPE,
  UNSCOPED_DATABASES,
  onlineScope,
  scoped,
  setStorageScope,
} from "./scope.ts";
import { browserDownloads } from "./downloads.ts";
import { browserUploads } from "./uploads.ts";
import { browserAccountKeys, browserChatImages, browserChats, browserKeys } from "./ai.ts";
import { browserUndo } from "./undo.ts";
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
  LocalFolder,
  LocalFolders,
  SavedFolders,
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
const DATABASE_VERSION = 1;
const PROJECTS = "projects";
const UPDATES = "updates";
const MEDIA = "media";
const BY_PROJECT = "project";
/** Where the address said which project, before it was in the path. */
const OLD_PROJECT_PARAM = "project";
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
  /**
   * The log it was written for (`logKey`), where nothing checked as it was written that this log
   * is the project's: see `ProjectLog.append`. Reads take it only while it is, see `belongs`.
   * Records written where that was checked have none.
   */
  readonly of?: string;
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
  /**
   * Which log of the project this is, once it started anew (`ProjectLibrary.renew`): windows of the
   * log before neither write to this one nor hear from it. What windows keep of the project goes
   * by `instance`, which stays. Projects whose log never started anew have none.
   */
  readonly log?: string;
  /** What `renew` kept of the log before, by name, see `backupKey`. */
  readonly backups?: readonly string[];
}

/**
 * The key that the records of a kept log go by, see `ProjectLibrary.renew`: nothing that reads the
 * log of a project by its id finds them.
 */
const backupKey = (id: string, backup: string) => `${id}\u0000backup\u0000${backup}`;

const newInstance = () => crypto.getRandomValues(new Uint32Array(4)).join("-");

/** Which log of which project, see `UpdateRecord.of`. */
const logKey = (instance: string | undefined, log: string | undefined) =>
  `${instance ?? ""}\n${log ?? ""}`;

/**
 * Whether an update is of the log a project has now: checked as it was written, or written for
 * this log. One a window wrote for a project that went meanwhile, or whose log started anew, is not:
 * nothing reads it, and what notices it takes it away.
 */
const belongs = (update: UpdateRecord, record: ProjectRecord | undefined) =>
  update.of === undefined ||
  (record !== undefined && !record.incoming && update.of === logKey(record.instance, record.log));

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
  const request = factory.open(scoped(DATABASE), DATABASE_VERSION);
  request.addEventListener("upgradeneeded", () => {
    const database = request.result;
    database.createObjectStore(PROJECTS, { keyPath: "id" });
    const updates = database.createObjectStore(UPDATES, { keyPath: "seq", autoIncrement: true });
    updates.createIndex(BY_PROJECT, BY_PROJECT);
    const media = database.createObjectStore(MEDIA, { keyPath: [BY_PROJECT, "hash"] });
    media.createIndex(BY_PROJECT, BY_PROJECT);
  });
  return resultOf(request);
}

function openPlaceDatabase(factory: IDBFactory, { name, database }: PlaceKind) {
  const request = factory.open(scoped(database), PLACE_DATABASE_VERSION);
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
    : new BroadcastChannel(scoped(`${PREFIX}project.${id}`));
}

/** Whether a project is the one with this instance, and not one that came after it with its id. */
const isInstance = (record: ProjectRecord | undefined, instance: string | undefined) =>
  record !== undefined && !record.incoming && record.instance === instance;

function openLog(
  database: () => Promise<IDBDatabase>,
  id: string,
  instance: string | undefined,
  log: string | undefined,
): ProjectLog {
  // Windows on another project with this id, or on its log before it started anew, have nothing
  // to say to this one.
  const channel = channelFor(
    [id, ...(instance === undefined ? [] : [instance]), ...(log === undefined ? [] : [log])].join(
      ".",
    ),
  );
  const isOurs = (record: ProjectRecord | undefined) =>
    isInstance(record, instance) && record?.log === log;
  const ours = logKey(instance, log);
  /**
   * Rejects where the log of this project started anew since this one opened: what it has now is
   * another document, which a window of the log before must not take for more of its own. Resolves
   * to the project as it is.
   */
  const refuseRenewed = async (transaction: IDBTransaction) => {
    const record = await resultOf<ProjectRecord | undefined>(
      transaction.objectStore(PROJECTS).get(id),
    );
    if (record && isInstance(record, instance) && record.log !== log)
      throw new Error("The log of the project started anew");
    return record;
  };

  return {
    async isCurrent() {
      const transaction = (await database()).transaction(PROJECTS);
      const record = await resultOf<ProjectRecord | undefined>(
        transaction.objectStore(PROJECTS).get(id),
      );
      return record !== undefined && !record.incoming && isOurs(record);
    },
    async load() {
      const transaction = (await database()).transaction([UPDATES, PROJECTS]);
      const project = await refuseRenewed(transaction);
      const index = transaction.objectStore(UPDATES).index(BY_PROJECT);
      const records = await resultOf<UpdateRecord[]>(index.getAll(id));
      return records.filter((record) => belongs(record, project)).map((record) => record.update);
    },
    async entries(after = 0) {
      const transaction = (await database()).transaction([UPDATES, PROJECTS]);
      const project = await refuseRenewed(transaction);
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
          if (mark > after && belongs(record, project))
            found.push({ update: record.update, source: record.source, mark });
          cursor.continue();
        });
      });
      return found;
    },
    async append(update, name, source) {
      // The change goes on its own, committed in the same turn as it opens: a page that goes right
      // after (a reload, the tab closes) keeps it only if nothing of the write waits for the page
      // any more. Whether the project is still this one is not asked first, which would take a
      // read: the record says which log it is for (`of`), and reads take it only while that is the
      // project's (`belongs`), so that a project that took over the id, or a log that started
      // anew, never has it. "strict" waits for the disk, so that a power cut cannot take back what
      // looks saved. Slow writes do no harm: changes that arrive in the meantime go along with the
      // next one.
      const writing = (await database()).transaction(UPDATES, "readwrite", {
        durability: "strict",
      });
      const added = writing
        .objectStore(UPDATES)
        .add({ project: id, update, ...(source && { source }), of: ours } satisfies UpdateRecord);
      writing.commit?.();
      await committed(writing);
      const seq = added.result as number;
      // Then the project: its name and when it changed for the list, or, where it is not this one
      // any more, the change goes again, as nothing would ever read it.
      const transaction = (await database()).transaction([UPDATES, PROJECTS], "readwrite");
      const projects = transaction.objectStore(PROJECTS);
      const read = projects.get(id);
      let isGone = false;
      read.addEventListener("success", () => {
        const record = read.result as ProjectRecord | undefined;
        if (record && isOurs(record)) {
          projects.put({ ...record, name, updatedAt: Date.now() } satisfies ProjectRecord);
          return;
        }
        isGone = true;
        const updates = transaction.objectStore(UPDATES);
        const again = updates.get(seq);
        again.addEventListener("success", () => {
          const kept = again.result as UpdateRecord | undefined;
          if (kept?.project === id && kept.of === ours) updates.delete(seq);
        });
      });
      await committed(transaction);
      if (isGone) throw new Error(`Project ${id} is gone, or not the one this window has`);
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- not a window
      channel?.postMessage(update);
    },
    async describe(description) {
      const transaction = (await database()).transaction(PROJECTS, "readwrite");
      const projects = transaction.objectStore(PROJECTS);
      const read = projects.get(id);
      read.addEventListener("success", () => {
        const record = read.result as ProjectRecord | undefined;
        if (!isOurs(record) || record?.description === description) return;
        const { description: _, ...rest } = record as ProjectRecord;
        projects.put(description === undefined ? rest : { ...rest, description });
      });
      await committed(transaction);
    },
    async compact(merge, { through } = {}) {
      const transaction = (await database()).transaction([UPDATES, PROJECTS], "readwrite");
      const updates = transaction.objectStore(UPDATES);
      const owner = transaction.objectStore(PROJECTS).get(id);
      const read = updates.index(BY_PROJECT).getAll(id);
      read.addEventListener("success", () => {
        const project = owner.result as ProjectRecord | undefined;
        if (!isOurs(project)) return;
        const all = read.result as UpdateRecord[];
        // What a window wrote for what is not this project's log is of nobody: it goes.
        for (const record of all)
          if (!belongs(record, project)) updates.delete(record.seq as number);
        // What is not on a platform yet stays as it is, see `ProjectLog.compact`.
        const records = all.filter(
          (record) =>
            belongs(record, project) &&
            (through === undefined || (record.seq as number) <= through),
        );
        if (records.length < 2) return;
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
  const projects = transaction.objectStore(PROJECTS);
  // What its log kept of before goes with it.
  const read = projects.get(id);
  read.addEventListener("success", () => {
    const record = read.result as ProjectRecord | undefined;
    for (const backup of record?.backups ?? []) deleteLog(transaction, backupKey(id, backup));
    projects.delete(id);
  });
  for (const name of [UPDATES, MEDIA]) {
    const store = transaction.objectStore(name);
    const keys = store.index(BY_PROJECT).getAllKeys(id);
    keys.addEventListener("success", () => {
      for (const key of keys.result) store.delete(key);
    });
  }
}

/** Takes away the records of a log by the key they go by, as part of a transaction. */
function deleteLog(transaction: IDBTransaction, key: string): void {
  const updates = transaction.objectStore(UPDATES);
  const keys = updates.index(BY_PROJECT).getAllKeys(key);
  keys.addEventListener("success", () => {
    for (const each of keys.result) updates.delete(each);
  });
}

/**
 * Moves the records of a log from one key to another, as part of a transaction: they keep where they
 * are in it (`seq`), and so their order. With `project`, the log is that project's: what is not of
 * it (`belongs`) goes. What is moved counts as checked from then on (no `of`): the log it goes to is
 * a backup, or becomes the project's.
 */
function moveLog(
  transaction: IDBTransaction,
  from: string,
  to: string,
  project?: ProjectRecord,
): void {
  const updates = transaction.objectStore(UPDATES);
  const read = updates.index(BY_PROJECT).getAll(from);
  read.addEventListener("success", () => {
    for (const record of read.result as UpdateRecord[]) {
      if (project && !belongs(record, project)) {
        updates.delete(record.seq as number);
        continue;
      }
      const { of: _of, ...checked } = record;
      updates.put({ ...checked, project: to } satisfies UpdateRecord);
    }
  });
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
  const incomingLock = (id: string) => scoped(`${PREFIX}incoming.${id}`);
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
      return openLog(database, id, record?.instance, record?.log);
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
    async renew(id, entries, backup, { expectedLast } = {}) {
      const transaction = (await database()).transaction([UPDATES, PROJECTS], "readwrite", {
        durability: "strict",
      });
      const projects = transaction.objectStore(PROJECTS);
      const updates = transaction.objectStore(UPDATES);
      const read = projects.get(id);
      // The last entry of the log, by its mark, in the same step: what came since stays where it is.
      // Only what is of the log counts, as `entries` has it (the project is read by then).
      const last = updates.index(BY_PROJECT).openCursor(IDBKeyRange.only(id), "prev");
      let refused: string | undefined;
      let moved = false;
      last.addEventListener("success", () => {
        const at = last.result;
        if (at && !belongs(at.value as UpdateRecord, read.result as ProjectRecord | undefined)) {
          at.continue();
          return;
        }
        const mark = (at?.primaryKey as number | undefined) ?? 0;
        if (expectedLast === undefined || mark === expectedLast) return;
        moved = true;
        transaction.abort();
      });
      read.addEventListener("success", () => {
        const record = read.result as ProjectRecord | undefined;
        if (!record || record.incoming) refused = `No project ${id} to start anew`;
        else if (record.backups?.includes(backup)) refused = `A backup ${backup} is there already`;
        if (!record || refused !== undefined) {
          transaction.abort();
          return;
        }
        // What the log had goes out of its way first: the new entries come after it.
        moveLog(transaction, id, backupKey(id, backup), record);
        for (const { update, source } of entries) {
          updates.add({ project: id, update, ...(source && { source }) } satisfies UpdateRecord);
        }
        projects.put({
          ...record,
          updatedAt: Date.now(),
          log: newInstance(),
          backups: [...(record.backups ?? []), backup],
        } satisfies ProjectRecord);
      });
      try {
        await committed(transaction);
      } catch (error) {
        if (moved && refused === undefined) return false;
        throw new Error(refused ?? "The log could not start anew", { cause: error });
      }
      return !moved;
    },
    async backupUpdates(id, backup) {
      const transaction = (await database()).transaction([UPDATES, PROJECTS]);
      const record = await resultOf<ProjectRecord | undefined>(
        transaction.objectStore(PROJECTS).get(id),
      );
      if (!record?.backups?.includes(backup)) throw new Error(`No backup ${backup} of ${id}`);
      const index = transaction.objectStore(UPDATES).index(BY_PROJECT);
      const records = await resultOf<UpdateRecord[]>(index.getAll(backupKey(id, backup)));
      return records.map((each) => each.update);
    },
    async backups(id) {
      const transaction = (await database()).transaction(PROJECTS);
      const record = await resultOf<ProjectRecord | undefined>(
        transaction.objectStore(PROJECTS).get(id),
      );
      return record?.incoming ? [] : [...(record?.backups ?? [])];
    },
    async restoreBackup(id, backup) {
      const transaction = (await database()).transaction([UPDATES, PROJECTS], "readwrite", {
        durability: "strict",
      });
      const projects = transaction.objectStore(PROJECTS);
      const read = projects.get(id);
      let isThere = false;
      read.addEventListener("success", () => {
        const record = read.result as ProjectRecord | undefined;
        if (!record || record.incoming || !record.backups?.includes(backup)) {
          transaction.abort();
          return;
        }
        isThere = true;
        // What the log has now goes, and what it had comes back, in its order.
        deleteLog(transaction, id);
        moveLog(transaction, backupKey(id, backup), id);
        projects.put({
          ...record,
          updatedAt: Date.now(),
          log: newInstance(),
          backups: record.backups.filter((name) => name !== backup),
        } satisfies ProjectRecord);
      });
      await committed(transaction).catch((error: unknown) => {
        throw new Error(
          isThere ? "The log could not be put back" : `No backup ${backup} of ${id}`,
          {
            cause: error,
          },
        );
      });
    },
    async dropBackup(id, backup) {
      const transaction = (await database()).transaction([UPDATES, PROJECTS], "readwrite");
      const projects = transaction.objectStore(PROJECTS);
      const read = projects.get(id);
      read.addEventListener("success", () => {
        const record = read.result as ProjectRecord | undefined;
        if (!record?.backups?.includes(backup)) return;
        deleteLog(transaction, backupKey(id, backup));
        projects.put({
          ...record,
          backups: record.backups.filter((name) => name !== backup),
        } satisfies ProjectRecord);
      });
      await committed(transaction);
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
  const placeLock = (project: string, place: string) =>
    scoped(`${PREFIX}${kind.name}.${project}.${place}`);
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
        // Committed right away, not once the page hears back: one that goes takes it back otherwise.
        transaction.commit?.();
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
/**
 * Where the mode is in the address of the page, and the project after it (docs/design/
 * online-offline.md of AnimaQuill Cloud, 2.2): `/` and `/p/<project>` online, `/offline` and
 * `/offline/p/<project>` offline. A reload stays in the mode, and with the project.
 */
export const OFFLINE_PATH = "/offline";
const PROJECT_PATH = "/p/";

/** The mode an address is of. */
export const modeOfPath = (pathname: string): "online" | "offline" =>
  pathname === OFFLINE_PATH || pathname.startsWith(`${OFFLINE_PATH}/`) ? "offline" : "online";

/** The project an address shows, by its path: undefined on the start page. */
export function projectOfPath(pathname: string): string | undefined {
  const rest = modeOfPath(pathname) === "offline" ? pathname.slice(OFFLINE_PATH.length) : pathname;
  if (!rest.startsWith(PROJECT_PATH)) return undefined;
  const id = rest.slice(PROJECT_PATH.length);
  if (id === "" || id.includes("/")) return undefined;
  try {
    return decodeURIComponent(id);
  } catch {
    return undefined;
  }
}

/** The path of a project, or of the start page, in a mode. */
export function pathOf(mode: "online" | "offline", project: string | undefined): string {
  const base = mode === "offline" ? OFFLINE_PATH : "";
  return project === undefined
    ? base || "/"
    : `${base}${PROJECT_PATH}${encodeURIComponent(project)}`;
}

/** The address of this page in a mode, as the page asks for it: what else it says stays. */
function browserAddress(mode: "online" | "offline"): ProjectAddress {
  const at = (project: string | undefined) => {
    const url = new URL(location.href);
    url.hash = "";
    url.pathname = pathOf(mode, project);
    // From before the project was in the path.
    url.searchParams.delete(OLD_PROJECT_PARAM);
    return url;
  };
  return {
    read: () => projectOfPath(location.pathname),
    write(id) {
      const url = at(id);
      // What else the address says stays, the part after # too.
      url.hash = location.hash;
      if (url.href !== location.href) history.replaceState(history.state, "", url);
    },
    linkTo: (id) => at(id).href,
  };
}

/**
 * Settings of the device rather than of a mode or an account, in no scope: how the editor looks,
 * which web/public/boot.js puts on the page before anything knows the mode.
 */
const DEVICE_SETTINGS: ReadonlySet<string> = new Set(["appearance"]);

/** Session storage has the lifetime of a tab, and a duplicated tab starts with a copy of it. */
function createWindowMemory(storage: () => Storage): WindowMemory {
  return {
    read(key) {
      try {
        return storage().getItem(scoped(`${PREFIX}window.${key}`)) ?? undefined;
      } catch (error) {
        console.warn("Window memory is out of reach", error);
        return undefined;
      }
    },
    write(key, value) {
      try {
        storage().setItem(scoped(`${PREFIX}window.${key}`), value);
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
export { AiSyncBusy, browserAiSyncAccess, browserChatSyncAccess } from "./ai-sync-access.ts";
export { browserAccountKeys } from "./ai.ts";
export { browserModelCatalogAccess } from "./model-catalog-access.ts";
export type { BrowserCoverAccessOptions } from "./covers.ts";
export type { BrowserCloudOptions } from "./cloud.ts";
export { browserRepository, statusOf } from "./repository.ts";
export type { BrowserRepositoryOptions } from "./repository.ts";
export { browserLfs, browserLfsAccount, lfsAccountOf, uploadOf } from "./lfs.ts";
export { browserUploads, uploadRecordOf } from "./uploads.ts";
export { browserDownloads } from "./downloads.ts";
export type { BrowserLfsOptions } from "./lfs.ts";
export { browserCloudProjects, projectSummaryOf } from "./cloud-projects.ts";
export type { BrowserCloudProjectsOptions } from "./cloud-projects.ts";

/**
 * For tests: the browser cannot write folders, as Firefox and Safari, and projects of the offline
 * mode stay in it, as a test cannot answer the browser's dialog for a folder. For the whole browser,
 * whatever the scope.
 */
export const PROJECTS_HERE_KEY = "animaquill.projectsInBrowser";

/**
 * Whether a browser is Safari, by its name: no interface says that it clears what a site stores
 * after seven days without a visit, which is what this is for.
 */
export const isSafariAgent = (agent: string): boolean =>
  /Safari\//.test(agent) &&
  !/Chrome\/|Chromium\/|CriOS\/|FxiOS\/|EdgiOS\/|Edg\/|Android/.test(agent);

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
  const isSafari = isSafariAgent(agent);
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
    askAgain: async () => {
      if (typeof storage?.persist !== "function") return false;
      try {
        local().setItem(PERSIST_ASKED_KEY, "yes");
      } catch {
        // It was asked all the same.
      }
      return storage.persist().catch(() => false);
    },
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
      const kept: unknown = JSON.parse(local().getItem(scoped(MAKING_KEY)) || "[]");
      return Array.isArray(kept) ? kept.filter((id): id is string => typeof id === "string") : [];
    } catch {
      return [];
    }
  };
  const write = (ids: readonly string[]) => {
    try {
      local().setItem(scoped(MAKING_KEY), JSON.stringify(ids));
    } catch (error) {
      console.warn("What is being made on the platform could not be noted", error);
    }
  };
  const lockOf = (project: string) => scoped(`${PREFIX}making.${project}`);
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
  const keyOf = (key: string) => (DEVICE_SETTINGS.has(key) ? PREFIX + key : scoped(PREFIX + key));
  const settings: SettingsStore = {
    async load(key) {
      const text = storage().getItem(keyOf(key));
      return text === null ? undefined : JSON.parse(text);
    },
    async save(key, value) {
      storage().setItem(keyOf(key), JSON.stringify(value));
    },
    async remove(key) {
      storage().removeItem(keyOf(key));
    },
    listen(key, listener) {
      // The browser tells every window but the one that wrote.
      const onStorage = (event: StorageEvent) => {
        if (event.key !== keyOf(key) || event.newValue === null) return;
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
  const uploads = browserUploads(database, locks);
  const downloads = browserDownloads(database, locks);
  const undo = browserUndo(database, locks);
  // What an export kept of a project that is gone would only take room on the disk.
  const forget = async (project: string) => {
    await Promise.all([
      trials.forget(project),
      drafts.forget(project),
      chats.forget(project).catch(() => {}),
      covers.forget(project).catch(() => {}),
      uploads.forget(project).catch(() => {}),
      undo.forget(project).catch(() => {}),
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
    mode: "offline",
    settings,
    projects: createLibrary(projects, locks, forget),
    address: browserAddress("offline"),
    windowMemory,
    folders: browserFolders(),
    ...(localFolders && { localFolders }),
    ...(persistence && { persistence }),
    making,
    trials: trials.store,
    drafts: drafts.store,
    exports,
    caches: createWorkCache(database),
    presence: browserPresence(locks),
    keys: browserKeys(database),
    accountKeys: browserAccountKeys(database),
    chats,
    chatImages: browserChatImages(database),
    organizer: browserOrganizer(database),
    covers,
    uploads,
    downloads,
    undo,
  };
}

/** What the offline mode adds to the browser's host. */
export interface OfflineHostOptions {
  /** What signs in, where the site has a backend, see `Host.goOnline`. */
  readonly goOnline?: () => void;
}

/**
 * The host of the offline mode: no backend, projects in folders, or in this browser where it
 * cannot write folders. It keeps what it keeps in the offline scope, see `setStorageScope`.
 */
export function createOfflineHost({ goOnline }: OfflineHostOptions = {}): Host {
  setStorageScope(OFFLINE_SCOPE);
  const host = createBrowserHost();
  const { localFolders } = host;
  return {
    ...host,
    ...(goOnline && { goOnline }),
    ...(localFolders && { handedOver: () => takeHandedOver(localFolders) }),
  };
}

/** What the online mode adds to the browser's host, see `Host`. */
export interface OnlineHostOptions {
  /** The backend, as the site of the page: part of the scope. */
  readonly backend: string;
  /** Whose the scope is: the id of the account on the backend, see `AccountSnapshot.id`. */
  readonly account: string;
  readonly parts: Pick<Host, "account" | "cloud" | "aiRelay" | "diagnostics">;
  /**
   * The offline mode of the same site, to go to and open folders in, see `Host.openOffline`.
   * Missing where this browser gets no offline mode, as Safari.
   */
  readonly offlineAddress?: string;
}

/**
 * The host of the online mode: an account on a backend, which has the projects. What it keeps in
 * this browser is in the scope of the backend and the account, see `setStorageScope`.
 */
export function createOnlineHost({
  backend,
  account,
  parts,
  offlineAddress,
}: OnlineHostOptions): Host {
  setStorageScope(onlineScope(backend, account));
  const host = createBrowserHost();
  const { localFolders } = host;
  const offline = () => {
    const url = new URL(offlineAddress ?? OFFLINE_PATH, location.href);
    return url;
  };
  return {
    ...host,
    ...parts,
    mode: "online",
    address: browserAddress("online"),
    ...(offlineAddress !== undefined && { goOffline: () => location.assign(offline()) }),
    ...(localFolders && { savedFolders: browserSavedFolders(localFolders) }),
    ...(localFolders &&
      offlineAddress !== undefined && {
        openOffline: async (folder: LocalFolder) => {
          const id = await handOver(localFolders, folder);
          const url = offline();
          url.searchParams.set(HANDED_OVER_PARAM, id);
          window.open(url, "_blank");
        },
      }),
  };
}

// ---- folders saved to, and handed over to the offline mode

const SAVED_FOLDERS_DATABASE = "animaquill-saved-folders";
const SAVED = "folders";

function openSavedFolders(factory: IDBFactory, name: string): Promise<IDBDatabase> {
  const request = factory.open(name, 1);
  request.addEventListener("upgradeneeded", () => {
    request.result.createObjectStore(SAVED);
  });
  return resultOf(request);
}

/** The folders projects were saved to, see `SavedFolders`, in the scope of the page. */
export function browserSavedFolders(
  folders: Pick<LocalFolders, "keep" | "fromKept">,
  factory: () => IDBFactory = () => indexedDB,
): SavedFolders {
  const database = connector(() => openSavedFolders(factory(), scoped(SAVED_FOLDERS_DATABASE)));
  const change = async (work: (store: IDBObjectStore) => void) => {
    const transaction = (await database()).transaction(SAVED, "readwrite");
    work(transaction.objectStore(SAVED));
    await committed(transaction);
  };
  return {
    async get(project) {
      const read = (await database()).transaction(SAVED).objectStore(SAVED).get(project);
      return folders.fromKept(await resultOf<unknown>(read));
    },
    put: (project, folder) => change((store) => store.put(folders.keep(folder), project)),
    forget: (project) => change((store) => store.delete(project)),
  };
}

/**
 * Folders that a window of the online mode handed over to one of the offline mode, see
 * `Host.openOffline`: in no scope, as they go from one to the other, each taken once.
 */
const HANDOVER_DATABASE = "aq-handover";
/** Where the address of the offline window says which, see `takeHandedOver`. */
export const HANDED_OVER_PARAM = "folder";
/** One that nobody took for this long is from a window that never opened. */
const HANDOVER_MS = 10 * 60_000;

async function handOver(
  folders: Pick<LocalFolders, "keep">,
  folder: LocalFolder,
  factory: () => IDBFactory = () => indexedDB,
): Promise<string> {
  const id = crypto.randomUUID();
  const database = await openSavedFolders(factory(), HANDOVER_DATABASE);
  try {
    const transaction = database.transaction(SAVED, "readwrite");
    transaction.objectStore(SAVED).put({ kept: folders.keep(folder), at: Date.now() }, id);
    await committed(transaction);
  } finally {
    database.close();
  }
  return id;
}

/** The folder handed over to this window, once, see `HANDED_OVER_PARAM`. */
async function takeHandedOver(
  folders: Pick<LocalFolders, "fromKept">,
  factory: () => IDBFactory = () => indexedDB,
): Promise<LocalFolder | undefined> {
  const url = new URL(location.href);
  const id = url.searchParams.get(HANDED_OVER_PARAM);
  if (id === null) return undefined;
  url.searchParams.delete(HANDED_OVER_PARAM);
  history.replaceState(history.state, "", url);
  const database = await openSavedFolders(factory(), HANDOVER_DATABASE);
  try {
    const transaction = database.transaction(SAVED, "readwrite");
    const store = transaction.objectStore(SAVED);
    const read = store.get(id);
    let found: { kept?: unknown; at?: unknown } | undefined;
    read.addEventListener("success", () => {
      found = read.result as typeof found;
      store.delete(id);
      // What nobody took goes too.
      const all = store.openCursor();
      all.addEventListener("success", () => {
        const cursor = all.result;
        if (!cursor) return;
        const { at } = (cursor.value ?? {}) as { at?: unknown };
        if (typeof at !== "number" || Date.now() - at > HANDOVER_MS) cursor.delete();
        cursor.continue();
      });
    });
    await committed(transaction);
    return found ? folders.fromKept(found.kept) : undefined;
  } finally {
    database.close();
  }
}

// ---- which mode, as this browser remembers it

/** People chose the offline mode on the entry page: next time it opens right away. */
export const MODE_KEY = "animaquill.mode";
/** Who was signed in last, by backend: the online mode opens for them where the backend cannot be reached. */
export const LAST_ACCOUNT_KEY = "animaquill.lastAccount";

export interface ModeMemory {
  /** People chose the offline mode, and have not signed in since. */
  prefersOffline(): boolean;
  setPrefersOffline(offline: boolean): void;
  /** Who was signed in last on a backend, see `AccountSnapshot.id`. */
  lastAccount(backend: string): { readonly id: string; readonly name?: string } | undefined;
  setLastAccount(
    backend: string,
    account: { readonly id: string; readonly name?: string } | undefined,
  ): void;
}

/** What this browser remembers of the modes, for every page of the site. */
export function browserModeMemory(storage: () => Storage = () => localStorage): ModeMemory {
  const read = (key: string): string | null => {
    try {
      return storage().getItem(key);
    } catch {
      return null;
    }
  };
  const write = (key: string, value: string | undefined) => {
    try {
      if (value === undefined) storage().removeItem(key);
      else storage().setItem(key, value);
    } catch {
      // Not remembered, then: the entry page asks again.
    }
  };
  const accounts = (): Record<string, { id: string; name?: string }> => {
    try {
      const kept: unknown = JSON.parse(read(LAST_ACCOUNT_KEY) ?? "{}");
      return typeof kept === "object" && kept !== null
        ? (kept as Record<string, { id: string }>)
        : {};
    } catch {
      return {};
    }
  };
  return {
    prefersOffline: () => read(MODE_KEY) === "offline",
    setPrefersOffline: (offline) => write(MODE_KEY, offline ? "offline" : undefined),
    lastAccount(backend) {
      const found = accounts()[backend];
      return typeof found?.id === "string" && found.id !== ""
        ? { id: found.id, ...(typeof found.name === "string" && { name: found.name }) }
        : undefined;
    },
    setLastAccount(backend, account) {
      const all = accounts();
      if (account) all[backend] = { id: account.id, ...(account.name && { name: account.name }) };
      else delete all[backend];
      write(LAST_ACCOUNT_KEY, JSON.stringify(all));
    },
  };
}

// ---- what the editor kept before there were scopes

/** Keys of the local storage of before the scopes: all that begin so, but these. */
const UNSCOPED_PREFIX = "animaquill.";
const UNSCOPED_KEPT: ReadonlySet<string> = new Set([
  PROJECTS_HERE_KEY,
  "animaquill.persistAsked",
  "animaquill.appearance",
  MODE_KEY,
  LAST_ACCOUNT_KEY,
]);

/**
 * Takes away what the editor kept before there were scopes (0.3.117 and before): its databases,
 * and its keys in the local storage. The online mode is where this goes first, once the changes
 * of its projects that this browser had are on the backend, see `dropUnscoped` in the editor. Each
 * database goes once every page that has it open let go of it; one that a page of before holds
 * goes the next time. Resolves to the names of the databases it took away.
 */
export async function dropUnscopedData(
  factory: () => IDBFactory = () => indexedDB,
  storage: () => Storage = () => localStorage,
): Promise<readonly string[]> {
  try {
    const keys: string[] = [];
    for (let index = 0; index < storage().length; index += 1) {
      const key = storage().key(index);
      if (key?.startsWith(UNSCOPED_PREFIX) && !UNSCOPED_KEPT.has(key)) keys.push(key);
    }
    for (const key of keys) storage().removeItem(key);
  } catch (error) {
    console.warn("What the editor kept before stays in the local storage for now", error);
  }
  const there = await unscopedDatabases(factory);
  const gone: string[] = [];
  for (const name of there) {
    const request = factory().deleteDatabase(name);
    await new Promise<void>((resolve) => {
      request.addEventListener("success", () => {
        gone.push(name);
        resolve();
      });
      request.addEventListener("error", () => resolve());
      // A page of before holds it: it goes once that one lets go, without anybody waiting.
      request.addEventListener("blocked", () => resolve());
    });
  }
  return gone;
}

/** Which databases of before the scopes this browser has, where it can say. */
export async function unscopedDatabases(
  factory: () => IDBFactory = () => indexedDB,
): Promise<readonly string[]> {
  const all = await factory()
    .databases?.()
    .catch(() => undefined);
  // A browser that cannot list them: all of them, as taking away one that is not there is nothing.
  if (!all) return UNSCOPED_DATABASES;
  const names = new Set(all.map(({ name }) => name));
  return UNSCOPED_DATABASES.filter((name) => names.has(name));
}

/**
 * How many projects of the platform the editor of before the scopes had changes of here that the
 * platform may not have, as its links say (`CloudLink.pending`, `creating`, `resync`): what
 * `dropUnscopedData` must not take away. Zero where it kept no links.
 */
export async function unscopedUnsent(factory: () => IDBFactory = () => indexedDB): Promise<number> {
  if (!(await unscopedDatabases(factory)).includes("animaquill-cloud")) return 0;
  const request = factory().open("animaquill-cloud");
  // Never made here: nothing of it to keep.
  request.addEventListener("upgradeneeded", () => request.transaction?.abort());
  let database: IDBDatabase;
  try {
    database = await resultOf(request);
  } catch {
    return 0;
  }
  try {
    if (!database.objectStoreNames.contains("links")) return 0;
    const links = await resultOf<unknown[]>(
      database.transaction("links").objectStore("links").getAll(),
    );
    return links.filter((value) => {
      const link = value as {
        creating?: unknown;
        pending?: unknown;
        resync?: unknown;
        renewing?: unknown;
      } | null;
      return (
        link?.creating === true ||
        (typeof link?.pending === "number" && link.pending > 0) ||
        link?.resync !== undefined ||
        link?.renewing !== undefined
      );
    }).length;
  } finally {
    database.close();
  }
}
