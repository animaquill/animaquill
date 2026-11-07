import type { ExportPiece, ExportStore, SavedExport } from "./index.ts";

/**
 * Exports get a database of their own, like what is being tried: a new version of the main
 * database would lock out every page that is still open.
 */
const DATABASE = "animaquill-exports";
const VERSION = 1;
const EXPORTS = "exports";
const PIECES = "pieces";
const BY_PROJECT = "project";
/** Pieces are about a megabyte each, and this many at a time are in memory while reading. */
const READ_AT_ONCE = 4;

interface PieceRecord extends ExportPiece {
  readonly id: string;
  readonly track: string;
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
    const database = request.result;
    const exports = database.createObjectStore(EXPORTS, { keyPath: "id" });
    exports.createIndex(BY_PROJECT, BY_PROJECT);
    database.createObjectStore(PIECES, { keyPath: ["id", "track", "seq"] });
  });
  return resultOf(request);
}

const piecesOf = (id: string, track: string, from = 0) =>
  IDBKeyRange.bound([id, track, from], [id, track, Infinity]);

/** Locks go with the page that holds them, also when it crashes. */
type LockManagerLike = Pick<LockManager, "request">;

export function createExportStore(
  factory: () => IDBFactory,
  locks: () => LockManagerLike | undefined,
): ExportStore {
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
  const write = async (stores: string[], work: (transaction: IDBTransaction) => void) => {
    const transaction = (await database()).transaction(stores, "readwrite");
    work(transaction);
    await committed(transaction);
  };
  /** Without locks, which only very old browsers lack, every window may take every export. */
  const held = new Set<string>();

  return {
    async list(project) {
      const transaction = (await database()).transaction(EXPORTS);
      const index = transaction.objectStore(EXPORTS).index(BY_PROJECT);
      return (await resultOf(index.getAll(project))) as SavedExport[];
    },
    async all() {
      const transaction = (await database()).transaction(EXPORTS);
      return (await resultOf(transaction.objectStore(EXPORTS).getAll())) as SavedExport[];
    },
    save: (saved) => write([EXPORTS], (transaction) => transaction.objectStore(EXPORTS).put(saved)),
    // A piece of an export that is gone, given up while it was on its way, would stay forever.
    async addPiece(id, track, piece) {
      let missing = false;
      try {
        await write([EXPORTS, PIECES], (transaction) => {
          const found = transaction.objectStore(EXPORTS).getKey(id);
          found.addEventListener("success", () => {
            if (found.result === undefined) {
              missing = true;
              transaction.abort();
              return;
            }
            const record: PieceRecord = { id, track, ...piece };
            transaction.objectStore(PIECES).put(record);
          });
        });
      } catch (error) {
        if (missing) throw new DOMException("The export is not kept any more", "NotFoundError");
        throw error;
      }
    },
    async *pieces(id, track) {
      let from = 0;
      for (;;) {
        const transaction = (await database()).transaction(PIECES);
        const request = transaction
          .objectStore(PIECES)
          .getAll(piecesOf(id, track, from), READ_AT_ONCE);
        const found = (await resultOf(request)) as PieceRecord[];
        for (const { seq, data, index } of found) yield { seq, data, index };
        const last = found.at(-1);
        if (!last || found.length < READ_AT_ONCE) return;
        from = last.seq + 1;
      }
    },
    dropPieces: (id, track, from) =>
      write([PIECES], (transaction) => {
        transaction.objectStore(PIECES).delete(piecesOf(id, track, from));
      }),
    remove: (id) =>
      write([EXPORTS, PIECES], (transaction) => {
        transaction.objectStore(EXPORTS).delete(id);
        transaction.objectStore(PIECES).delete(IDBKeyRange.bound([id], [id, []]));
      }),
    claim(id) {
      const manager = locks();
      if (!manager) {
        if (held.has(id)) return Promise.resolve(undefined);
        held.add(id);
        return Promise.resolve(() => held.delete(id));
      }
      return new Promise((resolve) => {
        void manager.request(`animaquill-export-${id}`, { ifAvailable: true }, (lock) => {
          if (!lock) {
            resolve(undefined);
            return undefined;
          }
          return new Promise<void>((release) => resolve(() => release()));
        });
      });
    },
  };
}
