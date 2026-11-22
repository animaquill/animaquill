import { scoped } from "./scope.ts";
import {
  CloudOtherAccount,
  CloudSignedOut,
  OrganizerOffline,
  type AccountGroupOutcome,
  type AccountMarksChange,
  type AccountOrganized,
  type OrganizerAccess,
  type OrganizerContent,
  type PutGroupOutcome,
  type ProjectGroup,
  type ProjectMarks,
  type ProjectMarksChange,
  type ProjectOrganizer,
  type SettingsStore,
} from "./index.ts";
import { groupNameKey } from "./organize-rules.ts";

export {
  cleanGroupName,
  groupNameKey,
  groupNameOf,
  MAX_GROUP_NAME,
  ORGANIZER_BATCH,
} from "./organize-rules.ts";

/**
 * How people organise their projects on the start page, see `ProjectOrganizer`: in this browser in
 * the offline mode (`browserOrganizer`), on the backend in the online mode (`platformOrganizer`,
 * docs/design/online-offline.md of AnimaQuill Cloud, 2.1). Never both: nothing is merged.
 *
 * A database of its own, like what is being tried: a new version of the main database would lock
 * out every page that is still open, for something that is not even a project.
 */
const DATABASE = "animaquill-organizer";
const VERSION = 1;
const MARKS = "marks";
const GROUPS = "groups";
/** How the windows of this browser tell each other that something changed. */
const CHANNEL = "animaquill.organizer";

interface MarksRecord extends ProjectMarks {
  readonly project: string;
}

/**
 * The fields of `change` over those of `before`: what is missing stays as it was. Only the star
 * and the group move `at` on.
 */
export function mergeMarks(
  before: ProjectMarks | undefined,
  change: ProjectMarksChange,
): ProjectMarks {
  const openedAt = change.openedAt ?? before?.openedAt;
  const starredAt = change.starredAt !== undefined ? change.starredAt : before?.starredAt;
  const group = change.group !== undefined ? change.group : before?.group;
  const organizing = change.starredAt !== undefined || change.group !== undefined;
  return {
    ...(openedAt !== undefined && { openedAt }),
    ...(starredAt !== undefined && { starredAt }),
    ...(group !== undefined && { group }),
    at: organizing || before === undefined ? change.at : before.at,
  };
}

/** Whether `group` may take the place of `before`, among `all`, see `ProjectOrganizer.putGroup`. */
function decideGroup(
  before: ProjectGroup | undefined,
  group: ProjectGroup,
  all: readonly ProjectGroup[],
): PutGroupOutcome {
  if (before && before.at > group.at) return "older";
  // One taken away stays so.
  if (before?.deleted && !group.deleted) return "older";
  if (group.deleted) return "kept";
  const key = groupNameKey(group.name);
  const other = all.find(
    (each) => each.id !== group.id && !each.deleted && groupNameKey(each.name) === key,
  );
  return other ? { taken: other.id } : "kept";
}

/** What is kept of a project, without what it is kept by. */
function marksOf({ project: _project, ...marks }: MarksRecord): ProjectMarks {
  return marks;
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
  const request = factory.open(scoped(DATABASE), VERSION);
  request.addEventListener("upgradeneeded", () => {
    const database = request.result;
    database.createObjectStore(MARKS, { keyPath: "project" });
    database.createObjectStore(GROUPS, { keyPath: "id" });
  });
  return resultOf(request);
}

/** What tells the other windows, and hears them: a `BroadcastChannel` in a browser. */
export interface OrganizerChannel {
  post(): void;
  listen(listener: () => void): () => void;
}

function broadcastChannel(): OrganizerChannel | undefined {
  if (typeof BroadcastChannel === "undefined") return undefined;
  const channel = new BroadcastChannel(scoped(CHANNEL));
  return {
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- not a window
    post: () => channel.postMessage("changed"),
    listen(listener) {
      const onMessage = () => listener();
      channel.addEventListener("message", onMessage);
      return () => channel.removeEventListener("message", onMessage);
    },
  };
}

/** Listeners of this window, told of what other windows say too, through `channel`. */
function windowListeners(channel: () => OrganizerChannel | undefined) {
  const listeners = new Set<() => void>();
  let others: OrganizerChannel | undefined;
  let isChannelMade = false;
  const tell = () => {
    for (const listener of listeners) listener();
  };
  const othersOf = () => {
    if (!isChannelMade) {
      isChannelMade = true;
      try {
        others = channel();
      } catch (error) {
        console.warn("The other windows cannot be told about the start page", error);
      }
      others?.listen(tell);
    }
    return others;
  };
  return {
    tell,
    /** This window changed something: every window hears of it. */
    changed: () => {
      tell();
      othersOf()?.post();
    },
    listen(listener: () => void) {
      othersOf();
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** In IndexedDB, shared by every window of this browser: the offline mode's. */
export function browserOrganizer(
  factory: () => IDBFactory = () => indexedDB,
  channel: () => OrganizerChannel | undefined = broadcastChannel,
): ProjectOrganizer {
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
  const windows = windowListeners(channel);
  const write = async (stores: string[], work: (transaction: IDBTransaction) => void) => {
    const transaction = (await database()).transaction(stores, "readwrite");
    work(transaction);
    await committed(transaction);
    windows.changed();
  };

  return {
    async read() {
      const transaction = (await database()).transaction([MARKS, GROUPS], "readonly");
      const [marks, groups] = await Promise.all([
        resultOf(transaction.objectStore(MARKS).getAll() as IDBRequest<MarksRecord[]>),
        resultOf(transaction.objectStore(GROUPS).getAll() as IDBRequest<ProjectGroup[]>),
      ]);
      return { marks: new Map(marks.map((kept) => [kept.project, marksOf(kept)])), groups };
    },
    mark: (project, change) =>
      write([MARKS], (transaction) => {
        const store = transaction.objectStore(MARKS);
        // Read and written in one go: what another window changes meanwhile waits for it.
        const request = store.get(project) as IDBRequest<MarksRecord | undefined>;
        request.addEventListener("success", () => {
          store.put({ project, ...mergeMarks(request.result, change) });
        });
      }),
    async putGroup(group) {
      let outcome: PutGroupOutcome = "kept";
      await write([GROUPS], (transaction) => {
        // All of them, read and written in one go: another window that keeps one meanwhile waits.
        const store = transaction.objectStore(GROUPS);
        const request = store.getAll() as IDBRequest<ProjectGroup[]>;
        request.addEventListener("success", () => {
          const all = request.result;
          outcome = decideGroup(
            all.find((each) => each.id === group.id),
            group,
            all,
          );
          if (outcome === "kept") store.put(group);
        });
      });
      return outcome;
    },
    forget: (project) =>
      write([MARKS], (transaction) => transaction.objectStore(MARKS).delete(project)),
    listen: windows.listen,
  };
}

/** In memory, for tests and for hosts that keep nothing: one per page. */
export function memoryOrganizer(): ProjectOrganizer {
  const marks = new Map<string, ProjectMarks>();
  const groups = new Map<string, ProjectGroup>();
  const listeners = new Set<() => void>();
  const changed = () => {
    for (const listener of listeners) listener();
  };
  return {
    read: async (): Promise<OrganizerContent> => ({
      marks: new Map(marks),
      groups: [...groups.values()],
    }),
    async mark(project, change) {
      marks.set(project, mergeMarks(marks.get(project), change));
      changed();
    },
    async putGroup(group) {
      const outcome = decideGroup(groups.get(group.id), group, [...groups.values()]);
      if (outcome === "kept") {
        groups.set(group.id, group);
        changed();
      }
      return outcome;
    },
    async forget(project) {
      marks.delete(project);
      changed();
    },
    listen(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

// ---- the online mode's: on the backend

/** Where the marks of a project of the backend are kept, see `ProjectMarks`. */
const CLOUD = "cloud:";
/** What the browser keeps of the backend's, for a page that cannot read it. */
const CACHE_KEY = "organizer.cached";
/** How often the start page looks again while it is in view. */
const LOOK_MS = 60_000;

export interface PlatformOrganizerOptions {
  readonly access: OrganizerAccess;
  /** Whose it is, see `AccountSnapshot.id`. */
  readonly account: string;
  /**
   * The settings of the browser in the online scope: what the backend had last, for a page that
   * cannot read it, read-only.
   */
  readonly cache?: SettingsStore;
  /** The session is of somebody else, or of nobody: who is signed in is to be asked again. */
  readonly signedOut?: () => void;
  readonly channel?: () => OrganizerChannel | undefined;
  /** Only tests: nothing looks again by itself. */
  readonly watch?: boolean;
}

/** What the backend has, as the start page reads it. */
function contentOf(state: AccountOrganized): OrganizerContent {
  const marks = new Map<string, ProjectMarks>();
  for (const each of state.marks) {
    const at = Math.max(each.star?.at ?? 0, each.group?.at ?? 0);
    marks.set(`${CLOUD}${each.project}`, {
      ...(each.opened !== undefined && { openedAt: each.opened }),
      ...(each.star && { starredAt: each.star.starred ? each.star.at : null }),
      ...(each.group && { group: each.group.id }),
      at,
    });
  }
  return {
    marks,
    groups: state.groups.map((group) => ({
      id: group.id,
      name: group.name,
      at: group.at,
      ...(group.deleted && { deleted: true as const }),
    })),
  };
}

/** What the browser keeps of it: plain values, for the settings store. */
interface Cached {
  readonly version: 1;
  readonly account: string;
  readonly state: AccountOrganized;
}

const isCached = (value: unknown, account: string): value is Cached =>
  typeof value === "object" &&
  value !== null &&
  (value as Cached).version === 1 &&
  (value as Cached).account === account &&
  typeof (value as Cached).state === "object";

const isWhoProblem = (error: unknown) =>
  error instanceof CloudOtherAccount || error instanceof CloudSignedOut;

/**
 * On the backend, the online mode's (docs/design/online-offline.md of AnimaQuill Cloud, 2.1): read
 * from it every time the start page looks, written to it at once. Two computers show the same as
 * soon as each looks again: as the start page opens, the window comes to the front, the browser
 * goes online, every minute while it is in view, and whenever another window of this browser
 * changed something. While the backend cannot be reached, what it had last shows, and nothing
 * changes (`OrganizerOffline`).
 */
export function platformOrganizer(options: PlatformOrganizerOptions): ProjectOrganizer {
  const { access, account, cache } = options;
  const windows = windowListeners(options.channel ?? broadcastChannel);
  let last: AccountOrganized | undefined;
  let watching = options.watch === false;

  const keep = (state: AccountOrganized) => {
    if (state.account !== account) throw new CloudOtherAccount("Somebody else is signed in");
    last = state;
    void cache
      ?.save(CACHE_KEY, { version: 1, account, state } satisfies Cached)
      .catch((error: unknown) => {
        console.warn("How projects are organised could not be kept for while offline", error);
      });
  };

  /** Looks again now and then while the window is there, see above. */
  const watch = () => {
    if (watching || typeof addEventListener !== "function") return;
    watching = true;
    const look = () => windows.tell();
    addEventListener("focus", look);
    addEventListener("online", look);
    globalThis.document?.addEventListener("visibilitychange", () => {
      if (globalThis.document?.visibilityState === "visible") look();
    });
    setInterval(() => {
      if (globalThis.document?.visibilityState !== "hidden") look();
    }, LOOK_MS);
  };

  const change = async (marks: AccountMarksChange[], groups: ProjectGroup[] = []) => {
    let answer;
    try {
      answer = await access.change({
        account,
        groups: groups.map((group) => ({
          id: group.id,
          name: group.name,
          at: group.at,
          ...(group.deleted && { deleted: true as const }),
        })),
        marks,
      });
    } catch (error) {
      if (isWhoProblem(error)) options.signedOut?.();
      // A request that never arrived, as the network is gone: not what the browser says of its
      // network, as a backend on this computer answers without one.
      if (error instanceof TypeError) throw new OrganizerOffline();
      throw error;
    }
    keep(answer.state);
    windows.changed();
    return answer;
  };

  const outcomeOf = (outcome: AccountGroupOutcome | undefined): PutGroupOutcome => {
    if (outcome === "kept" || outcome === "missing") return "kept";
    if (outcome === "older") return "older";
    if (typeof outcome === "object") return outcome;
    return "refused";
  };

  return {
    async read() {
      watch();
      try {
        keep(await access.read());
      } catch (error) {
        if (isWhoProblem(error)) options.signedOut?.();
        if (!last) {
          const kept = await cache?.load(CACHE_KEY).catch(() => undefined);
          if (isCached(kept, account)) last = kept.state;
        }
      }
      const shown = last;
      if (!shown) throw new Error("How projects are organised could not be read");
      return contentOf(shown);
    },
    async mark(project, given) {
      if (!project.startsWith(CLOUD)) return;
      const marks: AccountMarksChange = {
        project: project.slice(CLOUD.length),
        ...(given.openedAt !== undefined && { opened: { at: given.openedAt } }),
        ...(given.starredAt !== undefined && {
          star: { starred: given.starredAt !== null, at: given.at },
        }),
        ...(given.group !== undefined && { group: { id: given.group, at: given.at } }),
      };
      const answer = await change([marks]);
      if (answer.marks[0]?.missing) throw new Error("No such project on the backend");
    },
    async putGroup(group) {
      const answer = await change([], [group]);
      return outcomeOf(answer.groups[0]);
    },
    // The backend lets go of what a project had as the project goes.
    forget: async () => {},
    listen: windows.listen,
  };
}
