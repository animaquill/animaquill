import type {
  OrganizerContent,
  ProjectGroup,
  ProjectMarks,
  ProjectMarksChange,
  ProjectOrganizer,
} from "./index.ts";

/**
 * How people organise their projects on the start page, see `ProjectOrganizer`. A database of its
 * own, like what is being tried: a new version of the main database would lock out every page that
 * is still open, for something that is not even a project.
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
 * The fields of `change` over those of `before`: what is missing stays as it was. Only the star and
 * the group move `at` on, as only they are ever merged with another copy: when a project was opened
 * here is of this browser alone.
 */
export function mergeMarks(
  before: ProjectMarks | undefined,
  change: ProjectMarksChange,
): ProjectMarks {
  const openedAt = change.openedAt ?? before?.openedAt;
  const starredAt = change.starredAt === undefined ? before?.starredAt : change.starredAt;
  const group = change.group === undefined ? before?.group : change.group;
  const isOrganized = change.starredAt !== undefined || change.group !== undefined;
  return {
    ...(openedAt !== undefined && { openedAt }),
    ...(starredAt !== undefined && { starredAt }),
    ...(group !== undefined && { group }),
    at: isOrganized || before === undefined ? change.at : before.at,
  };
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
  const channel = new BroadcastChannel(CHANNEL);
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

/** In IndexedDB, shared by every window of this browser. */
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
  const listeners = new Set<() => void>();
  let others: OrganizerChannel | undefined;
  let isChannelMade = false;
  const othersOf = () => {
    if (!isChannelMade) {
      isChannelMade = true;
      try {
        others = channel();
      } catch (error) {
        console.warn("The other windows cannot be told about the start page", error);
      }
      others?.listen(() => {
        for (const listener of listeners) listener();
      });
    }
    return others;
  };
  const changed = () => {
    for (const listener of listeners) listener();
    othersOf()?.post();
  };
  const write = async (stores: string[], work: (transaction: IDBTransaction) => void) => {
    const transaction = (await database()).transaction(stores, "readwrite");
    work(transaction);
    await committed(transaction);
    changed();
  };

  return {
    async read() {
      const transaction = (await database()).transaction([MARKS, GROUPS], "readonly");
      const [marks, groups] = await Promise.all([
        resultOf(transaction.objectStore(MARKS).getAll() as IDBRequest<MarksRecord[]>),
        resultOf(transaction.objectStore(GROUPS).getAll() as IDBRequest<ProjectGroup[]>),
      ]);
      return {
        marks: new Map(marks.map((kept) => [kept.project, mergeMarks(undefined, kept)])),
        groups,
      };
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
    putGroup: (group) =>
      write([GROUPS], (transaction) => transaction.objectStore(GROUPS).put(group)),
    forget: (project) =>
      write([MARKS], (transaction) => transaction.objectStore(MARKS).delete(project)),
    listen(listener) {
      othersOf();
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
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
      groups.set(group.id, group);
      changed();
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
