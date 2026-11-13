import type { ChatStore, KeyStore, SavedChat, SavedChatSummary } from "./index.ts";

/**
 * Keys of AI services and conversations with AI, each in a database of its own: keys must not be
 * where anything else is read from, such as a report or a project, and neither is part of a
 * project. A new version of the main database would also lock out every page that is still open.
 */
export const KEYS_DATABASE = "animaquill-keys";
/**
 * Keys that go with an account, by account: apart from those of this browser, which pages of
 * before 0.3.62 read, and which stay where they are as people sign in and out.
 */
export const ACCOUNT_KEYS_DATABASE = "animaquill-account-keys";
const BY_ACCOUNT = "account";
const CHATS_DATABASE = "animaquill-chats";
const VERSION = 1;
const KEYS = "keys";
const CHATS = "chats";
const BY_PROJECT = "project";
/** Conversations of one project that are kept: the ones people talked in last. */
export const MAX_CHATS_PER_PROJECT = 50;

interface KeyRecord {
  readonly service: string;
  readonly key: string;
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

/** Opens a database once, and again after another page upgraded it. */
function connector(open: () => Promise<IDBDatabase>): () => Promise<IDBDatabase> {
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

/** Keys in this browser only. Failing to read one is no key, which people can type again. */
export function browserKeys(factory: () => IDBFactory): KeyStore {
  const database = connector(() => {
    const request = factory().open(KEYS_DATABASE, VERSION);
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
      const found = (await resultOf(transaction.objectStore(KEYS).get(service))) as
        KeyRecord | undefined;
      return typeof found?.key === "string" ? found.key : undefined;
    },
    async list() {
      const transaction = (await database()).transaction(KEYS, "readonly");
      const keys = await resultOf(transaction.objectStore(KEYS).getAllKeys());
      return keys.filter((key): key is string => typeof key === "string");
    },
    write: (service, key) => change((store) => store.put({ service, key } satisfies KeyRecord)),
    remove: (service) => change((store) => store.delete(service)),
    clear: () => change((store) => store.clear()),
  };
}

/** Keys that go with accounts, kept in this browser by account, see `ACCOUNT_KEYS_DATABASE`. */
export interface AccountKeys {
  /** The keys of one account. */
  of(account: string): KeyStore;
  /** Every key of an account, as it signs out of this browser. */
  forget(account: string): Promise<void>;
}

interface AccountKeyRecord {
  readonly account: string;
  readonly service: string;
  readonly key: string;
}

/** Keys of accounts in this browser, each account's apart. */
export function browserAccountKeys(factory: () => IDBFactory): AccountKeys {
  const database = connector(() => {
    const request = factory().open(ACCOUNT_KEYS_DATABASE, VERSION);
    request.addEventListener("upgradeneeded", () => {
      const store = request.result.createObjectStore(KEYS, { keyPath: [BY_ACCOUNT, "service"] });
      store.createIndex(BY_ACCOUNT, BY_ACCOUNT);
    });
    return resultOf(request);
  });
  const change = async (work: (store: IDBObjectStore) => void) => {
    const transaction = (await database()).transaction(KEYS, "readwrite");
    work(transaction.objectStore(KEYS));
    await committed(transaction);
  };
  const forget = async (account: string) => {
    const transaction = (await database()).transaction(KEYS, "readwrite");
    const store = transaction.objectStore(KEYS);
    const keys = await resultOf(store.index(BY_ACCOUNT).getAllKeys(account));
    for (const key of keys) store.delete(key);
    await committed(transaction);
  };
  return {
    of: (account) => ({
      where: ACCOUNT_KEYS_DATABASE,
      async read(service) {
        const transaction = (await database()).transaction(KEYS, "readonly");
        const found = (await resultOf(transaction.objectStore(KEYS).get([account, service]))) as
          AccountKeyRecord | undefined;
        return typeof found?.key === "string" ? found.key : undefined;
      },
      async list() {
        const transaction = (await database()).transaction(KEYS, "readonly");
        const found = (await resultOf(
          transaction.objectStore(KEYS).index(BY_ACCOUNT).getAll(account),
        )) as AccountKeyRecord[];
        return found.map(({ service }) => service);
      },
      write: (service, key) =>
        change((store) => store.put({ account, service, key } satisfies AccountKeyRecord)),
      remove: (service) => change((store) => store.delete([account, service])),
      clear: () => forget(account),
    }),
    forget,
  };
}

/** Keys of accounts that last as long as the page. */
export function memoryAccountKeys(): AccountKeys {
  const accounts = new Map<string, KeyStore>();
  return {
    of(account) {
      let keys = accounts.get(account);
      if (!keys) accounts.set(account, (keys = memoryKeys()));
      return keys;
    },
    async forget(account) {
      accounts.delete(account);
    },
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
}: SavedChat): SavedChatSummary => ({
  id,
  project,
  title,
  updatedAt,
  ...(titleBy !== undefined && { titleBy }),
  ...(changes !== undefined && { changes }),
  ...(asking === true && { asking }),
  ...(forkedFrom !== undefined && { forkedFrom }),
});

/** Conversations in this browser, by project. */
export function browserChats(
  factory: () => IDBFactory,
  limit: number = MAX_CHATS_PER_PROJECT,
): ChatStore {
  const database = connector(() => {
    const request = factory().open(CHATS_DATABASE, VERSION);
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
      const { transaction, store, all } = await allOf(chat.project, "readwrite");
      store.put(chat);
      // The oldest go, so that one project does not fill the disk with what nobody reads again.
      const others = all.filter(({ id }) => id !== chat.id);
      const over = others.length + 1 - limit;
      if (over > 0) {
        const oldest = others.toSorted((a, b) => a.updatedAt - b.updatedAt).slice(0, over);
        for (const { id } of oldest) store.delete([chat.project, id]);
      }
      await committed(transaction);
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
  };
}

/** Keys that last as long as the page, where there is nowhere to keep them. */
export function memoryKeys(): KeyStore {
  const keys = new Map<string, string>();
  return {
    where: undefined,
    read: async (service) => keys.get(service),
    list: async () => [...keys.keys()],
    write: async (service, key) => void keys.set(service, key),
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
  };
}
