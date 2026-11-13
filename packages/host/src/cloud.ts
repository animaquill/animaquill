import { browserFolderWriter } from "./folder-writer.ts";
import { newSyncId } from "./sync-protocol.ts";
import type {
  CloudAccess,
  CloudClose,
  CloudLinkChange,
  CloudConnection,
  CloudLine,
  CloudLink,
  CloudLinks,
  CloudProjectSummary,
  CoverAccess,
  OrganizerAccess,
  AiSyncAccess,
  ChatSyncAccess,
  LfsAccess,
  RepositoryAccess,
} from "./index.ts";

/**
 * Keeping projects in step with a platform, such as AnimaQuill Cloud: the messages of the sync
 * protocol, and what a browser keeps about the projects it connected. The editor runs the protocol,
 * see `CloudSession` in the editor; a host only carries messages and keeps records, and never reads
 * an update, which only the editor understands.
 */

/**
 * Keeps what a change of a link may move forward, and never back, see `CloudLinks.update`. What a
 * link only remembers for lists is as the last one said.
 */
const forward = (link: CloudLink, change: CloudLinkChange): CloudLink => {
  const renewed = renewal(link, change);
  if (renewed !== link) return renewed;
  const { creating: _creating, ...made } = link;
  const kept: CloudLink = change.made ? made : link;
  // The platform took what waited to go in one piece: nothing waits like that any more.
  const { resync: _resync, ...settled } = kept;
  const resynced: CloudLink = change.resync === null ? settled : kept;
  // The log of the copy before is gone.
  const { kept: _old, ...dropped } = resynced;
  const next: CloudLink = change.kept === null ? dropped : resynced;
  const isAhead = change.seq !== undefined && change.seq > link.seq;
  return {
    ...next,
    ...(isAhead && { seq: change.seq }),
    ...(isAhead && change.digest !== undefined && { digest: change.digest }),
    ...(change.pushed !== undefined && { pushed: Math.max(link.pushed, change.pushed) }),
    ...(change.syncedAt !== undefined && {
      syncedAt: Math.max(link.syncedAt ?? 0, change.syncedAt),
    }),
    // The log of a link is of one copy of the project, and stays that: only a link that never said.
    ...(change.generation !== undefined &&
      link.generation === undefined && { generation: change.generation }),
    ...(change.pending !== undefined && { pending: change.pending }),
    ...(typeof change.resync === "number" && {
      resync: Math.max(link.resync ?? 0, change.resync),
    }),
    ...(change.name !== undefined && { name: change.name }),
    ...(change.repository !== undefined && { repository: change.repository }),
    ...(change.owner !== undefined && { owner: change.owner }),
  };
};

/**
 * What a change does to a link where it puts its log on another working copy, see
 * `CloudLink.renewing`: the link itself where it does nothing of that. Beginning takes only a link
 * of the copy it goes from with nothing else on its way; getting there only a link that is on its
 * way, and then the link goes on from the new copy, whatever it said of the one before.
 */
const renewal = (link: CloudLink, change: CloudLinkChange): CloudLink => {
  const { renewing: on, kept: _kept, ...rest } = link;
  if (change.renewed !== undefined) {
    if (!on) return link;
    const { resync: _resync, pending: _pending, ...plain } = rest;
    return {
      ...plain,
      generation: on.generation,
      seq: on.seq,
      digest: on.digest,
      pushed: change.renewed.pushed,
      kept: {
        backup: on.backup,
        generation: on.from,
        until: change.renewed.until,
        ...(change.renewed.at !== undefined && { at: change.renewed.at }),
      },
    };
  }
  if (change.renewing === null) {
    if (!on) return link;
    const { renewing: _gone, ...without } = link;
    return without;
  }
  if (change.renewing !== undefined) {
    if (on || (link.generation ?? 1) !== change.renewing.from) return link;
    return { ...link, renewing: change.renewing };
  }
  return link;
};

/** Where a link starts over, see `CloudLinks.reset`. */
const startOver = (
  link: CloudLink,
  to: { readonly seq: number; readonly digest: string; readonly pushed: number },
): CloudLink => ({ ...link, seq: to.seq, digest: to.digest, pushed: to.pushed });

/** For tests: links in memory, shared by everything that has this. */
export class MemoryCloudLinks implements CloudLinks {
  readonly links = new Map<string, CloudLink>();
  #device = newSyncId();
  failing = false;

  async get(key: string) {
    if (this.failing) throw new Error("blocked");
    const link = this.links.get(key);
    return link && { ...link };
  }

  async list() {
    if (this.failing) throw new Error("blocked");
    return [...this.links.values()].map((link) => ({ ...link }));
  }

  async put(link: CloudLink) {
    if (this.failing) throw new Error("blocked");
    this.links.set(link.key, { ...link });
  }

  async update(key: string, project: string, change: CloudLinkChange) {
    if (this.failing) throw new Error("blocked");
    const link = this.links.get(key);
    if (!link || link.project !== project) return false;
    this.links.set(key, forward(link, change));
    return true;
  }

  async reset(key: string, project: string, to: Parameters<CloudLinks["reset"]>[2]) {
    if (this.failing) throw new Error("blocked");
    const link = this.links.get(key);
    if (!link || link.project !== project) return false;
    this.links.set(key, startOver(link, to));
    return true;
  }

  async remove(key: string) {
    if (this.failing) throw new Error("blocked");
    this.links.delete(key);
  }

  async withProject(platform: string, project: string) {
    return [...this.links.values()].filter(
      (link) => link.platform === platform && link.project === project,
    );
  }

  async device() {
    return this.#device;
  }
}

const DATABASE = "animaquill-cloud";
const DATABASE_VERSION = 1;
const LINKS = "links";
const META = "meta";
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

interface LinkRecord extends CloudLink {
  /** The platform and the project, for finding the links of a project. */
  readonly where: readonly [string, string];
}

const recordOf = (link: CloudLink): LinkRecord => ({
  ...link,
  where: [link.platform, link.project],
});

const linkOf = ({ where: _where, ...link }: LinkRecord): CloudLink => link;

/**
 * What a browser keeps about the projects it connected to a platform, in a database of its own, so
 * that the database of projects does not need a new version for it: a new version locks out every
 * page that is still open.
 */
export function browserCloudLinks(factory: () => IDBFactory = () => indexedDB): CloudLinks {
  let opening: Promise<IDBDatabase> | undefined;
  const database = () => {
    opening ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory().open(DATABASE, DATABASE_VERSION);
      request.addEventListener("upgradeneeded", () => {
        const links = request.result.createObjectStore(LINKS, { keyPath: "key" });
        links.createIndex(BY_PROJECT, "where");
        request.result.createObjectStore(META);
      });
      request.addEventListener("success", () => {
        const opened = request.result;
        const forget = () => {
          opening = undefined;
        };
        opened.addEventListener("versionchange", () => {
          opened.close();
          forget();
        });
        opened.addEventListener("close", forget);
        resolve(opened);
      });
      request.addEventListener("error", () => reject(request.error));
    }).catch((error: unknown) => {
      opening = undefined;
      throw error;
    });
    return opening;
  };
  /** Changes a link to `project` in one step. Resolves to whether there was one. */
  const changeLink = async (
    key: string,
    project: string,
    next: (link: CloudLink) => CloudLink,
  ): Promise<boolean> => {
    const transaction = (await database()).transaction(LINKS, "readwrite");
    const links = transaction.objectStore(LINKS);
    const read = links.get(key);
    let isThere = false;
    read.addEventListener("success", () => {
      const record = read.result as LinkRecord | undefined;
      if (!record || record.project !== project) return;
      isThere = true;
      links.put(recordOf(next(linkOf(record))));
    });
    await committed(transaction);
    return isThere;
  };
  return {
    async get(key) {
      const transaction = (await database()).transaction(LINKS);
      const record = await resultOf<LinkRecord | undefined>(
        transaction.objectStore(LINKS).get(key),
      );
      return record && linkOf(record);
    },
    async list() {
      const transaction = (await database()).transaction(LINKS);
      const records = await resultOf<LinkRecord[]>(transaction.objectStore(LINKS).getAll());
      return records.map(linkOf);
    },
    async put(link) {
      // "strict": a link says where the changes of a project go, and has to be there after a crash.
      const transaction = (await database()).transaction(LINKS, "readwrite", {
        durability: "strict",
      });
      transaction.objectStore(LINKS).put(recordOf(link));
      await committed(transaction);
    },
    async update(key, project, change) {
      return changeLink(key, project, (link) => forward(link, change));
    },
    async reset(key, project, to) {
      return changeLink(key, project, (link) => startOver(link, to));
    },
    async remove(key) {
      const transaction = (await database()).transaction(LINKS, "readwrite", {
        durability: "strict",
      });
      transaction.objectStore(LINKS).delete(key);
      await committed(transaction);
    },
    async withProject(platform, project) {
      const transaction = (await database()).transaction(LINKS);
      const index = transaction.objectStore(LINKS).index(BY_PROJECT);
      const records = await resultOf<LinkRecord[]>(index.getAll([platform, project]));
      return records.map(linkOf);
    },
    async device() {
      const transaction = (await database()).transaction(META, "readwrite", {
        durability: "strict",
      });
      const meta = transaction.objectStore(META);
      const read = meta.get("device");
      let device = "";
      read.addEventListener("success", () => {
        const kept = read.result as unknown;
        if (typeof kept === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(kept)) {
          device = kept;
        } else {
          device = newSyncId();
          meta.put(device, "device");
        }
      });
      await committed(transaction);
      return device;
    },
  };
}

/** A connection over a WebSocket, as a browser has it. */
export function webSocketConnection(url: string): CloudConnection {
  const socket = new WebSocket(url);
  socket.binaryType = "arraybuffer";
  let listener: ((data: Uint8Array) => void) | undefined;
  const opened = new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("close", () => reject(new Error("The connection did not open")), {
      once: true,
    });
  });
  // Nobody might wait for it, when it closes first.
  opened.catch(() => {});
  const closed = new Promise<CloudClose>((resolve) => {
    socket.addEventListener(
      "close",
      (event) => resolve({ code: event.code, reason: event.reason }),
      { once: true },
    );
  });
  socket.addEventListener("message", (event: MessageEvent<unknown>) => {
    if (event.data instanceof ArrayBuffer) listener?.(new Uint8Array(event.data));
  });
  return {
    opened,
    closed,
    send(data) {
      if (socket.readyState === WebSocket.OPEN) socket.send(data);
    },
    onMessage(next) {
      listener = next;
    },
    buffered: () => socket.bufferedAmount,
    close(code, reason) {
      try {
        socket.close(code, reason);
      } catch {
        // A code the browser does not let a page use: it closes anyway.
        socket.close();
      }
    },
  };
}

/** What windows of a browser tell each other about a project, over a BroadcastChannel. */
function broadcastLine(name: string): CloudLine | undefined {
  if (typeof BroadcastChannel === "undefined") return undefined;
  const channel = new BroadcastChannel(name);
  return {
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- not a window
    post: (message) => channel.postMessage(message),
    listen(listener) {
      const onMessage = (event: MessageEvent<unknown>) => listener(event.data);
      channel.addEventListener("message", onMessage);
      return () => channel.removeEventListener("message", onMessage);
    },
    close: () => channel.close(),
  };
}

export interface BrowserCloudOptions {
  /** The platform, as an address: what a `CloudLink` names. */
  readonly platform: string;
  /** Where the WebSocket for syncing is. */
  readonly syncUrl: () => string;
  /** The projects of whoever is signed in, see `CloudAccess.list`. */
  readonly list: () => Promise<readonly CloudProjectSummary[]>;
  /** Takes a project without a repository away, where the platform does, see `CloudAccess.remove`. */
  readonly remove?: NonNullable<CloudAccess["remove"]>;
  /** Makes the working copy of a project again from its repository, see `CloudAccess.wake`. */
  readonly wake?: NonNullable<CloudAccess["wake"]>;
  /** Saving its projects to repositories, where the platform does, see `browserRepository`. */
  readonly repository?: RepositoryAccess;
  /** Sending files of assets into the large file storage of repositories, see `browserLfs`. */
  readonly lfs?: LfsAccess;
  /** The covers of its projects, where the platform keeps them, see `browserCoverAccess`. */
  readonly cover?: CoverAccess;
  /** How the person organises their projects, where the platform keeps it, see `browserOrganizerAccess`. */
  readonly organizer?: OrganizerAccess;
  readonly aiSync?: AiSyncAccess;
  readonly chats?: ChatSyncAccess;
  readonly database?: () => IDBFactory;
  readonly locks?: () => LockManager | undefined;
}

/** A platform as a browser reaches it: the host of a site adds where its platform is. */
export function browserCloud(options: BrowserCloudOptions): CloudAccess {
  const locks = options.locks ?? (() => navigator.locks);
  return {
    platform: options.platform,
    connect: () => webSocketConnection(options.syncUrl()),
    list: options.list,
    links: browserCloudLinks(options.database),
    syncer: (key) => browserFolderWriter(key, locks, undefined, "animaquill.cloud-sync."),
    line: (key) => broadcastLine(`animaquill.cloud.${key}`),
    ...(options.remove && { remove: options.remove }),
    ...(options.wake && { wake: options.wake }),
    ...(options.repository && { repository: options.repository }),
    ...(options.lfs && { lfs: options.lfs }),
    ...(options.cover && { cover: options.cover }),
    ...(options.organizer && { organizer: options.organizer }),
    ...(options.aiSync && { aiSync: options.aiSync }),
    ...(options.chats && { chats: options.chats }),
  };
}
