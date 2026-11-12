import {
  REQUEST_TIMEOUT_MS,
  CHANGE_TIMEOUT_MS,
  count,
  isObject,
  text,
  withinTime,
} from "./answers.ts";
import {
  COVER_BYTES,
  CloudSignedOut,
  type CoverAccess,
  type CoverPut,
  mergeMade,
  type CoverStore,
  type ProjectCover,
} from "./index.ts";

/**
 * The covers of projects, see `CoverStore`: a database of their own, like how projects are
 * organised, as a new version of the main database would lock out every page that is still open.
 * Not in the folder of a project, where the start page cannot read without asking, and not in the
 * project, where every new picture would be a change of it.
 */
const DATABASE = "animaquill-covers";
const VERSION = 1;
const COVERS = "covers";
/** How the windows of this browser tell each other which cover changed. */
const CHANNEL = "animaquill.covers";

interface CoverRecord extends ProjectCover {
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

function open(factory: IDBFactory): Promise<IDBDatabase> {
  const request = factory.open(DATABASE, VERSION);
  request.addEventListener("upgradeneeded", () => {
    request.result.createObjectStore(COVERS, { keyPath: "key" });
  });
  return resultOf(request);
}

/** What tells the other windows, and hears them: a `BroadcastChannel` in a browser. */
export interface CoverChannel {
  post(key: string): void;
  listen(listener: (key: string) => void): () => void;
}

function broadcastChannel(): CoverChannel | undefined {
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

/** What is kept of a cover, without what it is kept by; nothing where it is no cover. */
function coverOf(record: unknown): ProjectCover | undefined {
  if (!isObject(record) || !(record.picture instanceof Blob)) return undefined;
  const { key: _key, ...cover } = record as unknown as CoverRecord;
  return cover;
}

/** In IndexedDB, shared by every window of this browser. */
export function browserCoverStore(
  factory: () => IDBFactory = () => indexedDB,
  channel: () => CoverChannel | undefined = broadcastChannel,
): CoverStore {
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
  let others: CoverChannel | undefined;
  let isChannelMade = false;
  const othersOf = () => {
    if (!isChannelMade) {
      isChannelMade = true;
      try {
        others = channel();
      } catch (error) {
        console.warn("The other windows cannot be told about covers", error);
      }
      others?.listen((key) => {
        for (const listener of listeners) listener(key);
      });
    }
    return others;
  };
  const changed = (key: string) => {
    for (const listener of listeners) listener(key);
    othersOf()?.post(key);
  };
  const write = async (key: string, work: (store: IDBObjectStore) => void) => {
    const transaction = (await database()).transaction([COVERS], "readwrite");
    work(transaction.objectStore(COVERS));
    await committed(transaction);
    changed(key);
  };

  return {
    async read(keys) {
      const found = new Map<string, ProjectCover>();
      if (keys.length === 0) return found;
      const store = (await database()).transaction([COVERS], "readonly").objectStore(COVERS);
      const records = await Promise.all(
        [...new Set(keys)].map((key) => resultOf(store.get(key) as IDBRequest<unknown>)),
      );
      for (const record of records) {
        const cover = coverOf(record);
        if (cover) found.set((record as CoverRecord).key, cover);
      }
      return found;
    },
    put: (key, cover) => write(key, (store) => store.put({ ...cover, key })),
    async made(key, cover) {
      let kept = cover;
      await write(key, (store) => {
        // Read and written in one go: a cover people choose meanwhile in another window waits.
        const request = store.get(key) as IDBRequest<unknown>;
        request.addEventListener("success", () => {
          kept = mergeMade(coverOf(request.result), cover);
          store.put({ ...kept, key });
        });
      });
      return kept;
    },
    sent: (key, etag) =>
      write(key, (store) => {
        // Read and written in one go: a new cover another window keeps meanwhile waits for it.
        const request = store.get(key) as IDBRequest<CoverRecord | undefined>;
        request.addEventListener("success", () => {
          const kept = request.result;
          if (kept?.etag === etag) store.put({ ...kept, sent: etag, sentAt: Date.now() });
        });
      }),
    forget: (key) => write(key, (store) => store.delete(key)),
    listen(listener) {
      othersOf();
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** In memory, for tests and for hosts that keep nothing: one per page. */
export function memoryCoverStore(): CoverStore {
  const covers = new Map<string, ProjectCover>();
  const listeners = new Set<(key: string) => void>();
  const changed = (key: string) => {
    for (const listener of listeners) listener(key);
  };
  return {
    async read(keys) {
      const found = new Map<string, ProjectCover>();
      for (const key of keys) {
        const cover = covers.get(key);
        if (cover) found.set(key, cover);
      }
      return found;
    },
    async put(key, cover) {
      covers.set(key, cover);
      changed(key);
    },
    async made(key, cover) {
      const kept = mergeMade(covers.get(key), cover);
      covers.set(key, kept);
      changed(key);
      return kept;
    },
    async sent(key, etag) {
      const kept = covers.get(key);
      if (kept?.etag !== etag) return;
      covers.set(key, { ...kept, sent: etag, sentAt: Date.now() });
      changed(key);
    },
    async forget(key) {
      covers.delete(key);
      changed(key);
    },
    listen(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export interface BrowserCoverAccessOptions {
  /** The address of a path of the platform's API, such as `/projects`. */
  readonly api: (path: string) => string;
  /** Headers the platform asks of requests that change something. */
  readonly changeHeaders?: Readonly<Record<string, string>>;
  readonly fetch?: typeof fetch;
  /** How long the platform has to answer, see `REQUEST_TIMEOUT_MS`. */
  readonly timeoutMs?: number;
}

/** The types of pictures the platform takes. */
const TYPES = new Set(["image/webp", "image/jpeg"]);

/**
 * The covers of projects of a platform over its HTTP API, see `CoverAccess`:
 *
 * - `PUT <api>/projects/<project>/cover[?durationMs=][&chosen=1]`, the picture as the body,
 *   answers `{etag, at, chosen?}`, or `{error}`: 404 "notFound", 413 "tooLarge", 415
 *   "unsupported", 400 "invalid", 429 "busy" with Retry-After
 * - `DELETE <api>/projects/<project>/cover` answers 204, or 404 "notFound", 429 "busy"
 * - `GET <api>/projects/<project>/cover` answers the picture, or 404 "notFound"
 *
 * The browser keeps what `GET` answered by its ETag, and asks again each time: this is only asked
 * for where the list says the cover is not the one this browser has.
 */
export function browserCoverAccess(options: BrowserCoverAccessOptions): CoverAccess {
  const request = options.fetch ?? ((input, init) => fetch(input, init));
  const path = (project: string) => options.api(`/projects/${encodeURIComponent(project)}/cover`);
  return {
    put: (project, picture, durationMs, { chosen = false } = {}) =>
      withinTime(options.timeoutMs ?? CHANGE_TIMEOUT_MS, async (signal): Promise<CoverPut> => {
        if (!TYPES.has(picture.type) || picture.size > COVER_BYTES) return { kind: "refused" };
        const query = new URLSearchParams();
        if (durationMs !== undefined && Number.isFinite(durationMs) && durationMs >= 0)
          query.set("durationMs", String(Math.round(durationMs)));
        if (chosen) query.set("chosen", "1");
        const asked = query.size > 0 ? `?${query}` : "";
        const response = await request(`${path(project)}${asked}`, {
          method: "PUT",
          cache: "no-store",
          headers: { ...options.changeHeaders, "content-type": picture.type },
          body: picture,
          signal,
        });
        const answer: unknown = await response.json().catch(() => undefined);
        const said = isObject(answer) ? answer.error : undefined;
        if (response.status === 401 || said === "signedOut")
          throw new CloudSignedOut("Nobody is signed in");
        if (response.ok && isObject(answer)) {
          const etag = text(answer.etag);
          const at = count(answer.at);
          if (etag !== undefined && at !== undefined)
            return { kind: "kept", etag, at, ...(answer.chosen === true && { chosen: true }) };
        }
        // Only in the platform's own words: a gateway says such things too.
        if (response.status === 404 && said === "notFound") return { kind: "missing" };
        if (
          (response.status === 413 && said === "tooLarge") ||
          (response.status === 415 && said === "unsupported") ||
          (response.status === 400 && said === "invalid")
        )
          return { kind: "refused" };
        if (response.status === 429) {
          const seconds = Number(response.headers.get("retry-after"));
          return {
            kind: "busy",
            retryAfterMs: Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 60_000,
          };
        }
        throw new Error(`The platform answered ${response.status}`);
      }),
    remove: (project) =>
      withinTime(options.timeoutMs ?? CHANGE_TIMEOUT_MS, async (signal) => {
        const response = await request(path(project), {
          method: "DELETE",
          cache: "no-store",
          headers: { ...options.changeHeaders },
          signal,
        });
        // Only the platform's own yes: a gateway, or a page to sign in on, says 200 to anything.
        if (response.status === 204) return "removed" as const;
        const answer: unknown = await response.json().catch(() => undefined);
        const said = isObject(answer) ? answer.error : undefined;
        if (response.status === 401 || said === "signedOut")
          throw new CloudSignedOut("Nobody is signed in");
        if (response.status === 404 && said === "notFound") return "missing" as const;
        if (response.status === 429) return "busy" as const;
        throw new Error(`The platform answered ${response.status}`);
      }),
    get: (project) =>
      withinTime(options.timeoutMs ?? REQUEST_TIMEOUT_MS, async (signal) => {
        const response = await request(path(project), { signal });
        if (response.status === 401) throw new CloudSignedOut("Nobody is signed in");
        if (response.status === 404) {
          const answer: unknown = await response.json().catch(() => undefined);
          if (isObject(answer) && answer.error === "notFound") return undefined;
        }
        if (!response.ok) throw new Error(`The platform answered ${response.status}`);
        const type = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
        // A page of a gateway is no picture.
        if (type === undefined || !TYPES.has(type))
          throw new Error(`The platform answered a ${type ?? "nothing"} for a cover`);
        const picture = await response.blob();
        if (picture.size > COVER_BYTES) throw new Error("The cover is larger than any can be");
        return picture.type === type ? picture : new Blob([picture], { type });
      }),
  };
}
