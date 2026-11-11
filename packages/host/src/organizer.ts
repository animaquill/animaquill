import type {
  OrganizerContent,
  PutGroupOutcome,
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

/** Marks kept before the star and the group had times of their own: `at` is the time of both. */
const isOld = (marks: ProjectMarks) => marks.starAt === undefined && marks.groupAt === undefined;
/** When the star of a project was last changed. */
export const starTime = (marks: ProjectMarks | undefined) =>
  marks === undefined ? -Infinity : (marks.starAt ?? (isOld(marks) ? marks.at : -Infinity));
/** When the group of a project was last changed. */
export const groupTime = (marks: ProjectMarks | undefined) =>
  marks === undefined ? -Infinity : (marks.groupAt ?? (isOld(marks) ? marks.at : -Infinity));

/**
 * The fields of `change` over those of `before`: what is missing stays as it was, and so does a
 * star or a group changed later than the change, see `ProjectMarksChange`. Only the star and the
 * group move `at` on, as only they are ever merged with another copy: when a project was opened
 * here is of this browser alone.
 */
export function mergeMarks(
  before: ProjectMarks | undefined,
  change: ProjectMarksChange,
): ProjectMarks {
  const isStar = change.starredAt !== undefined && change.at >= starTime(before);
  const isGroup = change.group !== undefined && change.at >= groupTime(before);
  const openedAt = change.openedAt ?? before?.openedAt;
  const starredAt = isStar ? change.starredAt : before?.starredAt;
  const starAt = isStar ? change.at : before?.starAt;
  const group = isGroup ? change.group : before?.group;
  const groupAt = isGroup ? change.at : before?.groupAt;
  const account = change.account ?? before?.account;
  const at =
    before === undefined
      ? change.at
      : isStar || isGroup
        ? Math.max(before.at, change.at)
        : before.at;
  return {
    ...(openedAt !== undefined && { openedAt }),
    ...(starredAt !== undefined && { starredAt }),
    ...(starAt !== undefined && { starAt }),
    ...(group !== undefined && { group }),
    ...(groupAt !== undefined && { groupAt }),
    ...(account !== undefined && { account }),
    at,
  };
}

/** What two names of groups are the same by: whatever the case and width of their letters. */
export const groupNameKey = (name: string): string =>
  name.trim().normalize("NFKC").toLocaleLowerCase("zh-CN");

/** Whether `group` may take the place of `before`, among `all`, see `ProjectOrganizer.putGroup`. */
function decideGroup(
  before: ProjectGroup | undefined,
  group: ProjectGroup,
  all: readonly ProjectGroup[],
): PutGroupOutcome {
  if (before && before.at > group.at) return "older";
  // One taken away stays so: nothing that went before brings it back.
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
        marks: new Map(marks.map((kept) => [kept.project, marksOf(kept)])),
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
    async putGroup(group) {
      let outcome: PutGroupOutcome = "kept";
      await write([GROUPS], (transaction) => {
        const store = transaction.objectStore(GROUPS);
        // All of them, read and written in one go: another window that keeps one meanwhile waits.
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
