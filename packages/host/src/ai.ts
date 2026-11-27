import { scoped } from "./scope.ts";
import { readServiceSecret, type ServiceSecret } from "./ai-sync-rules.ts";
import type {
  ChatImageRef,
  ChatImageStore,
  ChatStore,
  KeyStore,
  SavedChat,
  SavedChatSummary,
} from "./index.ts";

/**
 * Keys of AI services and conversations with AI, each in a database of its own: keys must not be
 * where anything else is read from, such as a report or a project, and neither is part of a
 * project. A new version of the main database would also lock out every page that is still open.
 */
export const KEYS_DATABASE = "animaquill-keys";
const CHATS_DATABASE = "animaquill-chats";
const VERSION = 1;
const KEYS = "keys";
const CHATS = "chats";
const BY_PROJECT = "project";
/** Conversations of one project that are kept: the ones people talked in last. */
export const MAX_CHATS_PER_PROJECT = 50;

/**
 * What is secret of a service as it is kept: its key where pages of before 0.3.72 read it, and the
 * rest of its `ServiceSecret` beside it.
 */
type KeyRecord = { readonly service: string } & ServiceSecret;

/** What a record has, or undefined where it has nothing that can be read. */
const secretOf = (found: unknown): ServiceSecret | undefined => {
  if (typeof found !== "object" || found === null) return undefined;
  const { service: _service, account: _account, ...rest } = found as Record<string, unknown>;
  return readServiceSecret(rest);
};

export const resultOf = <T>(request: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error));
  });

export const committed = (transaction: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve());
    transaction.addEventListener("abort", () => {
      reject(transaction.error ?? new DOMException("Transaction aborted", "AbortError"));
    });
  });

/** Opens a database once, and again after another page upgraded it. */
export function connector(open: () => Promise<IDBDatabase>): () => Promise<IDBDatabase> {
  let opening: Promise<IDBDatabase> | undefined;
  return () => {
    opening ??= open().then(
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
}

/**
 * What is secret of one service changed in one transaction, from what is kept: a write of another
 * window waits for it, or it for that one. What cannot be read is not written over.
 */
async function changeOne(
  database: () => Promise<IDBDatabase>,
  key: IDBValidKey,
  next: (before: ServiceSecret | undefined) => ServiceSecret | undefined,
  recordOf: (secret: ServiceSecret) => unknown,
): Promise<ServiceSecret | undefined> {
  const transaction = (await database()).transaction(KEYS, "readwrite");
  const store = transaction.objectStore(KEYS);
  const found: unknown = await resultOf(store.get(key));
  const before = secretOf(found);
  if (found !== undefined && before === undefined) {
    transaction.abort();
    throw new Error("What is secret of a service could not be read: nothing was written");
  }
  const after = next(before);
  if (after === undefined || Object.keys(after).length === 0) store.delete(key);
  else store.put(recordOf(after));
  await committed(transaction);
  return after && Object.keys(after).length > 0 ? after : undefined;
}

/** Keys in this browser only. Failing to read one is no key, which people can type again. */
export function browserKeys(factory: () => IDBFactory): KeyStore {
  const database = connector(() => {
    const request = factory().open(scoped(KEYS_DATABASE), VERSION);
    request.addEventListener("upgradeneeded", () => {
      request.result.createObjectStore(KEYS, { keyPath: "service" });
    });
    return resultOf(request);
  });
  const change = async (work: (store: IDBObjectStore) => void) => {
    const transaction = (await database()).transaction(KEYS, "readwrite");
    work(transaction.objectStore(KEYS));
    await committed(transaction);
  };
  return {
    where: KEYS_DATABASE,
    async read(service) {
      const transaction = (await database()).transaction(KEYS, "readonly");
      return secretOf(await resultOf(transaction.objectStore(KEYS).get(service)));
    },
    async list() {
      const transaction = (await database()).transaction(KEYS, "readonly");
      const keys = await resultOf(transaction.objectStore(KEYS).getAllKeys());
      return keys.filter((key): key is string => typeof key === "string");
    },
    write: (service, secret) =>
      change((store) => store.put({ ...secret, service } satisfies KeyRecord)),
    update: (service, next) =>
      changeOne(database, service, next, (secret) => ({ ...secret, service }) satisfies KeyRecord),
    remove: (service) => change((store) => store.delete(service)),
    clear: () => change((store) => store.clear()),
  };
}

const summaryOf = ({
  id,
  project,
  title,
  updatedAt,
  titleBy,
  changes,
  asking,
  forkedFrom,
  modelName,
}: SavedChat): SavedChatSummary => ({
  id,
  project,
  title,
  updatedAt,
  ...(titleBy !== undefined && { titleBy }),
  ...(changes !== undefined && { changes }),
  ...(asking === true && { asking }),
  ...(forkedFrom !== undefined && { forkedFrom }),
  ...(typeof modelName === "string" && { modelName }),
});

/** Conversations in this browser, by project. */
export function browserChats(
  factory: () => IDBFactory,
  limit: number = MAX_CHATS_PER_PROJECT,
): ChatStore {
  const database = connector(() => {
    const request = factory().open(scoped(CHATS_DATABASE), VERSION);
    request.addEventListener("upgradeneeded", () => {
      const chats = request.result.createObjectStore(CHATS, { keyPath: [BY_PROJECT, "id"] });
      chats.createIndex(BY_PROJECT, BY_PROJECT);
    });
    return resultOf(request);
  });
  const allOf = async (project: string, mode: IDBTransactionMode) => {
    const transaction = (await database()).transaction(CHATS, mode);
    const store = transaction.objectStore(CHATS);
    const all = (await resultOf(store.index(BY_PROJECT).getAll(project))) as SavedChat[];
    return { transaction, store, all };
  };
  return {
    async list(project) {
      const { all } = await allOf(project, "readonly");
      return all.map(summaryOf).toSorted((a, b) => b.updatedAt - a.updatedAt);
    },
    async load(project, id) {
      const transaction = (await database()).transaction(CHATS, "readonly");
      const found = await resultOf(transaction.objectStore(CHATS).get([project, id]));
      return found as SavedChat | undefined;
    },
    async save(chat) {
      // The write goes on its own, committed in the same turn as it opens: a page that goes right
      // after (the tab closes, a reload) takes the answer with it only if nothing of the write
      // waits for the page any more, neither a read nor the answer to the write itself (without
      // `commit`, the browser commits only once the page took the answer to the last request).
      const writing = (await database()).transaction(CHATS, "readwrite");
      writing.objectStore(CHATS).put(chat);
      writing.commit?.();
      await committed(writing);
      // The oldest go after, in a transaction of their own, so that one project does not fill the
      // disk with what nobody reads again. The conversation is kept by now: where this fails, the
      // save did not, and the oldest go the next time.
      try {
        const transaction = (await database()).transaction(CHATS, "readwrite");
        const store = transaction.objectStore(CHATS);
        const all = (await resultOf(store.index(BY_PROJECT).getAll(chat.project))) as SavedChat[];
        const others = all.filter(({ id }) => id !== chat.id);
        const over = others.length + 1 - limit;
        if (over > 0) {
          const oldest = others.toSorted((a, b) => a.updatedAt - b.updatedAt).slice(0, over);
          for (const { id } of oldest) store.delete([chat.project, id]);
        }
        await committed(transaction);
      } catch (error) {
        console.warn("The oldest conversations could not go", error);
      }
    },
    async remove(project, id) {
      const transaction = (await database()).transaction(CHATS, "readwrite");
      transaction.objectStore(CHATS).delete([project, id]);
      await committed(transaction);
    },
    async forget(project) {
      const { transaction, store, all } = await allOf(project, "readwrite");
      for (const { id } of all) store.delete([project, id]);
      await committed(transaction);
    },
    async usage() {
      const transaction = (await database()).transaction(CHATS, "readonly");
      const found = new Map<string, { count: number; bytes: number }>();
      // A cursor, not all at once: there can be many, and only their sizes are wanted.
      const cursor = transaction.objectStore(CHATS).openCursor();
      await new Promise<void>((resolve, reject) => {
        cursor.addEventListener("error", () => reject(cursor.error));
        cursor.addEventListener("success", () => {
          const at = cursor.result;
          if (!at) return resolve();
          const chat = at.value as SavedChat;
          const each = found.get(chat.project) ?? { count: 0, bytes: 0 };
          each.count += 1;
          each.bytes += sizeOf(chat);
          found.set(chat.project, each);
          at.continue();
        });
      });
      return [...found].map(([project, each]) => ({ project, ...each }));
    },
  };
}

/** About how many bytes a conversation takes as kept: as JSON, in UTF-8. */
const sizeOf = (chat: SavedChat): number => {
  try {
    return new Blob([JSON.stringify(chat)]).size;
  } catch {
    return 0;
  }
};

/** Keys that last as long as the page, where there is nowhere to keep them. */
export function memoryKeys(): KeyStore {
  const keys = new Map<string, ServiceSecret>();
  return {
    where: undefined,
    read: async (service) => {
      const found = keys.get(service);
      return found && structuredClone(found);
    },
    list: async () => [...keys.keys()],
    write: async (service, secret) => void keys.set(service, structuredClone(secret)),
    update: async (service, next) => {
      const after = next(keys.has(service) ? structuredClone(keys.get(service)) : undefined);
      if (after === undefined || Object.keys(after).length === 0) keys.delete(service);
      else keys.set(service, structuredClone(after));
      return after && Object.keys(after).length > 0 ? structuredClone(after) : undefined;
    },
    remove: async (service) => void keys.delete(service),
    clear: async () => keys.clear(),
  };
}

/** Conversations that last as long as the page. */
export function memoryChats(): ChatStore {
  const chats = new Map<string, SavedChat>();
  const keyOf = (project: string, id: string) => JSON.stringify([project, id]);
  return {
    list: async (project) =>
      [...chats.values()]
        .filter((chat) => chat.project === project)
        .map(summaryOf)
        .toSorted((a, b) => b.updatedAt - a.updatedAt),
    load: async (project, id) => chats.get(keyOf(project, id)),
    save: async (chat) => void chats.set(keyOf(chat.project, chat.id), structuredClone(chat)),
    remove: async (project, id) => void chats.delete(keyOf(project, id)),
    forget: async (project) => {
      for (const chat of chats.values()) {
        if (chat.project === project) chats.delete(keyOf(project, chat.id));
      }
    },
    usage: async () => {
      const found = new Map<string, { count: number; bytes: number }>();
      for (const chat of chats.values()) {
        const each = found.get(chat.project) ?? { count: 0, bytes: 0 };
        each.count += 1;
        each.bytes += sizeOf(chat);
        found.set(chat.project, each);
      }
      return [...found].map(([project, each]) => ({ project, ...each }));
    },
  };
}

/**
 * Where the pictures of conversations are kept: a database of its own, so that pages of before it
 * still open the one of conversations, which has the same version as ever.
 */
export const CHAT_IMAGES_DATABASE = "animaquill-chat-images";
const IMAGES = "images";

/** What a picture is called by: the SHA-256 of its bytes. */
export async function imageHashOf(blob: Blob): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()));
  return `sha256:${[...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

interface ImageRecord {
  readonly image: string;
  readonly blob: Blob;
  /** When it was kept, for whoever clears what nothing has any more. */
  readonly at: number;
}

const refOf = (image: string, blob: Blob, size: { width: number; height: number }) => ({
  image,
  type: blob.type,
  width: size.width,
  height: size.height,
  bytes: blob.size,
});

/** The pictures of conversations in this browser. */
export function browserChatImages(factory: () => IDBFactory): ChatImageStore {
  const database = connector(() => {
    const request = factory().open(scoped(CHAT_IMAGES_DATABASE), VERSION);
    request.addEventListener("upgradeneeded", () => {
      request.result.createObjectStore(IMAGES, { keyPath: "image" });
    });
    return resultOf(request);
  });
  return {
    async save(blob, size): Promise<ChatImageRef> {
      const image = await imageHashOf(blob);
      const transaction = (await database()).transaction(IMAGES, "readwrite");
      const store = transaction.objectStore(IMAGES);
      const known = await resultOf(store.getKey(image));
      if (known === undefined) store.put({ image, blob, at: Date.now() } satisfies ImageRecord);
      await committed(transaction);
      return refOf(image, blob, size);
    },
    async read(image) {
      const transaction = (await database()).transaction(IMAGES, "readonly");
      const found = (await resultOf(transaction.objectStore(IMAGES).get(image))) as
        ImageRecord | undefined;
      return found?.blob;
    },
    async keys() {
      const transaction = (await database()).transaction(IMAGES, "readonly");
      const found: { image: string; bytes: number }[] = [];
      const cursor = transaction.objectStore(IMAGES).openCursor();
      await new Promise<void>((resolve, reject) => {
        cursor.addEventListener("error", () => reject(cursor.error));
        cursor.addEventListener("success", () => {
          const at = cursor.result;
          if (!at) return resolve();
          const { image, blob } = at.value as ImageRecord;
          found.push({ image, bytes: blob.size });
          at.continue();
        });
      });
      return found;
    },
    async delete(images) {
      if (images.length === 0) return;
      const transaction = (await database()).transaction(IMAGES, "readwrite");
      const store = transaction.objectStore(IMAGES);
      for (const image of images) store.delete(image);
      await committed(transaction);
    },
  };
}

/** Pictures that last as long as the page. */
export function memoryChatImages(): ChatImageStore {
  const images = new Map<string, Blob>();
  return {
    async save(blob, size) {
      const image = await imageHashOf(blob);
      if (!images.has(image)) images.set(image, blob);
      return refOf(image, blob, size);
    },
    read: async (image) => images.get(image),
    keys: async () => [...images].map(([image, blob]) => ({ image, bytes: blob.size })),
    delete: async (gone) => {
      for (const image of gone) images.delete(image);
    },
  };
}
