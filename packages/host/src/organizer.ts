import type {
  AccountChanges,
  AccountGroup,
  AccountMarks,
  OrganizerContent,
  PutGroupOutcome,
  ProjectGroup,
  ProjectMarks,
  ProjectMarksChange,
  ProjectOrganizer,
} from "./index.ts";
import { cleanGroupName, groupNameKey, MAX_GROUP_NAME } from "./organize-rules.ts";

export {
  cleanGroupName,
  groupNameKey,
  groupNameOf,
  MAX_GROUP_NAME,
  ORGANIZER_BATCH,
} from "./organize-rules.ts";

/**
 * How people organise their projects on the start page, see `ProjectOrganizer`. A database of its
 * own, like what is being tried: a new version of the main database would lock out every page that
 * is still open, for something that is not even a project.
 */
const DATABASE = "animaquill-organizer";
/** 2: the account that was last signed in (`META`). */
const VERSION = 2;
const MARKS = "marks";
const GROUPS = "groups";
const META = "meta";
/** In `META`: the account that was last signed in. */
const ACCOUNT = "account";
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

const later = (a: number | undefined, b: number | undefined) =>
  a === undefined ? b : b === undefined ? a : Math.max(a, b);

/**
 * The fields of `change` over those of `before`: what is missing stays as it was, and so does a
 * star or a group changed later than the change, see `ProjectMarksChange`. Each of the two goes by
 * its own time: one that is later in `before` stays, whatever the other does. Only the star and the
 * group move `at` on, as only they are ever merged with another copy: when a project was opened
 * here is of this browser alone.
 */
export function mergeMarks(
  before: ProjectMarks | undefined,
  change: ProjectMarksChange,
): ProjectMarks {
  // What people do here comes after whatever is kept here, also where a clock that was ahead
  // left a time to come.
  const after = (at: number, kept: number) => (change.mine ? Math.max(at, kept + 1) : at);
  const changeStarAt = after(change.starAt ?? change.at, starTime(before));
  const changeGroupAt = after(change.groupAt ?? change.at, groupTime(before));
  const isStar = change.starredAt !== undefined && changeStarAt >= starTime(before);
  const isGroup = change.group !== undefined && changeGroupAt >= groupTime(before);
  /** A time kept here, no later than `notAfter`. */
  const notAfter = (at: number | undefined) =>
    at === undefined || change.notAfter === undefined ? at : Math.min(at, change.notAfter);
  const openedAt = change.openedAt ?? before?.openedAt;
  const starredAt = isStar ? change.starredAt : before?.starredAt;
  const starAt = isStar ? changeStarAt : notAfter(before?.starAt);
  const group = isGroup ? change.group : before?.group;
  const groupAt = isGroup ? changeGroupAt : notAfter(before?.groupAt);
  const account = change.account ?? before?.account;
  const sentStar = notAfter(later(before?.sent?.star, change.sent?.star));
  const sentGroup = notAfter(later(before?.sent?.group, change.sent?.group));
  const changed = Math.max(isStar ? changeStarAt : -Infinity, isGroup ? changeGroupAt : -Infinity);
  const at =
    before === undefined
      ? isStar || isGroup
        ? changed
        : change.at
      : isStar || isGroup
        ? Math.max(notAfter(before.at)!, changed)
        : notAfter(before.at)!;
  return {
    ...(openedAt !== undefined && { openedAt }),
    ...(starredAt !== undefined && { starredAt }),
    ...(starAt !== undefined && { starAt }),
    ...(group !== undefined && { group }),
    ...(groupAt !== undefined && { groupAt }),
    ...(account !== undefined && { account }),
    at,
    ...((sentStar !== undefined || sentGroup !== undefined) && {
      sent: {
        ...(sentStar !== undefined && { star: sentStar }),
        ...(sentGroup !== undefined && { group: sentGroup }),
      },
    }),
  };
}

const isLive = (group: ProjectGroup) => !group.deleted && group.into === undefined;
const accountOf = (group: ProjectGroup) =>
  group.scope === "browser" ? undefined : group.scope.account;

/**
 * Whether two groups are shown together, and so cannot have one name: of the same account, or of
 * this browser, which shows with those of the account that was last signed in (`last`).
 */
const together = (a: ProjectGroup, b: ProjectGroup, last: string | undefined) => {
  const [one, other] = [accountOf(a), accountOf(b)];
  if (one === other) return true;
  return (one === undefined && other === last) || (other === undefined && one === last);
};

/** Whether `group` may take the place of `before`, among `all`, see `ProjectOrganizer.putGroup`. */
function decideGroup(
  before: ProjectGroup | undefined,
  group: ProjectGroup,
  all: readonly ProjectGroup[],
  last: string | undefined,
): PutGroupOutcome {
  if (before && before.at > group.at) return "older";
  // One taken away stays so: nothing that went before brings it back. The account may, where it
  // was renamed elsewhere later, see `adoptGroups`.
  if (before?.deleted && !group.deleted) return "older";
  if (group.deleted) return "kept";
  const key = groupNameKey(group.name);
  const other = all.find(
    (each) =>
      each.id !== group.id &&
      isLive(each) &&
      together(each, group, last) &&
      groupNameKey(each.name) === key,
  );
  return other ? { taken: other.id } : "kept";
}

/**
 * What a group as an account has it (`group`, with its `sent`) makes of the copy here: the later of
 * the two, the account's at a tie, which knows what every computer did; with what the account has.
 */
function adoptOne(before: ProjectGroup | undefined, group: ProjectGroup): ProjectGroup {
  const sent = later(before?.sent, group.sent);
  // One that became another here stays so, unless the account changed it later than that.
  if (before?.into !== undefined && group.at <= before.at)
    return { ...before, ...(sent !== undefined && { sent }) };
  const winner = before === undefined || group.at >= before.at ? group : before;
  const { deleted: _deleted, sent: _sent, ...rest } = winner;
  return {
    ...rest,
    ...(winner.deleted && { deleted: true as const }),
    ...(sent !== undefined && { sent }),
  };
}

/** What changes as `from` becomes `into`: the group, and marks of projects that are in it. */
function becomeOther(
  from: ProjectGroup,
  into: string,
  marks: readonly MarksRecord[],
): { group: ProjectGroup; marks: MarksRecord[] } {
  return {
    // Taken away as it changed last: the account is given that, where it has it, see
    // `isUnsentGroup`. One it never had is nothing to give it.
    group: { ...from, deleted: true, into },
    marks: marks
      .filter((each) => each.group === from.id)
      .map((each) => {
        // The project moves, as the group became another: when it went in stays, and the account
        // is given it again, as it may have had the other id.
        const { sent, ...kept } = each;
        const star = sent?.star;
        return { ...kept, group: into, ...(star !== undefined && { sent: { star } }) };
      }),
  };
}

/** What `claimGroups` changes, see there. */
function claim(
  groups: readonly ProjectGroup[],
  marks: readonly MarksRecord[],
  account: string,
): { groups: ProjectGroup[]; marks: MarksRecord[] } {
  const changedGroups: ProjectGroup[] = [];
  const changedMarks = new Map<string, MarksRecord>();
  const theirs = new Map(
    groups
      .filter((group) => isLive(group) && accountOf(group) === account)
      .map((group) => [groupNameKey(group.name), group]),
  );
  for (const group of groups) {
    if (group.scope !== "browser" || !isLive(group)) continue;
    const same = theirs.get(groupNameKey(group.name));
    if (same) {
      const became = becomeOther(
        group,
        same.id,
        [...marks].map((m) => changedMarks.get(m.project) ?? m),
      );
      changedGroups.push(became.group);
      for (const each of became.marks) changedMarks.set(each.project, each);
    } else {
      const { sent: _sent, ...rest } = group;
      const now: ProjectGroup = { ...rest, scope: { account } };
      changedGroups.push(now);
      theirs.set(groupNameKey(group.name), now);
    }
  }
  return { groups: changedGroups, marks: [...changedMarks.values()] };
}

/** Whether a group of `account` is still to be given to it, see `ProjectGroup.sent`. */
export const isUnsentGroup = (group: ProjectGroup, account: string): boolean =>
  accountOf(group) === account &&
  (group.sent === undefined || group.at > group.sent) &&
  // One made and taken away before the account heard of it: there is nothing to give it.
  !(group.deleted && group.sent === undefined);

/**
 * What is still to be given to `account` (see `ProjectMarks.sent`, `ProjectGroup.sent`): its groups
 * changed here later than it has them, and the stars and groups of its projects (`cloud:` and the
 * id, of no account or of this one) likewise. A group of a project is given as the account knows
 * it: one of its own; none for one taken away that it never had, or one of this browser taken
 * away, which it cannot have; not at all for one it cannot know yet, or of another account.
 */
export function unsentOf(content: OrganizerContent, account: string): Required<AccountChanges> {
  const groups: AccountGroup[] = [];
  const byId = new Map(content.groups.map((group) => [group.id, group]));
  /** Groups whose names are nothing once cleaned: they stay here. */
  const nameless = new Set<string>();
  for (const group of content.groups) {
    if (!isUnsentGroup(group, account)) continue;
    // Names of before they were cleaned, as a tab pasted from a table: as they are kept, which the
    // copy here takes once the account has it.
    const name = [...cleanGroupName(group.name)].slice(0, MAX_GROUP_NAME).join("").trim();
    if (name === "" && !group.deleted) {
      nameless.add(group.id);
      continue;
    }
    groups.push({
      id: group.id,
      name: name === "" ? group.name : name,
      at: group.at,
      ...(group.deleted && { deleted: true as const }),
    });
  }
  /** What the account knows a group a project is in by. */
  const asKnown = (id: string | null): string | null | undefined => {
    if (id === null) return null;
    const group = byId.get(id);
    if (!group || group.into !== undefined || nameless.has(id)) return undefined;
    if (accountOf(group) === account) return group.deleted && group.sent === undefined ? null : id;
    return group.scope === "browser" && group.deleted ? null : undefined;
  };
  const marks: AccountMarks[] = [];
  for (const [key, each] of content.marks) {
    if (!key.startsWith("cloud:") || (each.account !== undefined && each.account !== account))
      continue;
    const starAt = starTime(each);
    const groupAt = groupTime(each);
    const star =
      each.starredAt !== undefined && starAt > (each.sent?.star ?? -Infinity)
        ? { starred: each.starredAt !== null, at: starAt }
        : undefined;
    const known = each.group === undefined ? undefined : asKnown(each.group);
    const group =
      known !== undefined && groupAt > (each.sent?.group ?? -Infinity)
        ? { id: known, at: groupAt }
        : undefined;
    if (star || group)
      marks.push({
        project: key.slice("cloud:".length),
        ...(star && { star }),
        ...(group && { group }),
      });
  }
  return { account, groups, marks };
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
  request.addEventListener("upgradeneeded", (event) => {
    const database = request.result;
    if (event.oldVersion < 1) {
      database.createObjectStore(MARKS, { keyPath: "project" });
      database.createObjectStore(GROUPS, { keyPath: "id" });
    }
    if (event.oldVersion < 2) database.createObjectStore(META);
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

  /** Reads everything in `stores` and writes what `work` makes of it, in one step. */
  const rewrite = (
    stores: string[],
    work: (content: {
      groups: ProjectGroup[];
      marks: MarksRecord[];
      account: string | undefined;
    }) => { groups?: ProjectGroup[]; marks?: MarksRecord[] },
  ) =>
    write([...stores, META], (transaction) => {
      // One request after another, each in the success of the one before: the transaction stays
      // active only so, and what is written is written in it.
      const all = <T>(store: string, then: (value: T[]) => void) => {
        if (!stores.includes(store)) return then([]);
        const request = transaction.objectStore(store).getAll() as IDBRequest<T[]>;
        request.addEventListener("success", () => then(request.result));
      };
      all<ProjectGroup>(GROUPS, (groups) => {
        all<MarksRecord>(MARKS, (marks) => {
          const request = transaction.objectStore(META).get(ACCOUNT) as IDBRequest<unknown>;
          request.addEventListener("success", () => {
            const account = typeof request.result === "string" ? request.result : undefined;
            const made = work({ groups, marks, account });
            for (const group of made.groups ?? []) transaction.objectStore(GROUPS).put(group);
            for (const each of made.marks ?? []) transaction.objectStore(MARKS).put(each);
          });
        });
      });
    });

  return {
    async read() {
      const transaction = (await database()).transaction([MARKS, GROUPS, META], "readonly");
      const [marks, groups, account] = await Promise.all([
        resultOf(transaction.objectStore(MARKS).getAll() as IDBRequest<MarksRecord[]>),
        resultOf(transaction.objectStore(GROUPS).getAll() as IDBRequest<ProjectGroup[]>),
        resultOf(transaction.objectStore(META).get(ACCOUNT) as IDBRequest<string | undefined>),
      ]);
      return {
        marks: new Map(marks.map((kept) => [kept.project, marksOf(kept)])),
        groups,
        ...(typeof account === "string" && { account }),
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
    markAll: (changes) =>
      write([MARKS], (transaction) => {
        const store = transaction.objectStore(MARKS);
        for (const [project, change] of changes) {
          const request = store.get(project) as IDBRequest<MarksRecord | undefined>;
          request.addEventListener("success", () => {
            store.put({ project, ...mergeMarks(request.result, change) });
          });
        }
      }),
    async putGroup(group) {
      let outcome: PutGroupOutcome = "kept";
      await rewrite([GROUPS], ({ groups: all, account }) => {
        // All of them, read and written in one go: another window that keeps one meanwhile waits.
        outcome = decideGroup(
          all.find((each) => each.id === group.id),
          group,
          all,
          account,
        );
        return outcome === "kept" ? { groups: [group] } : {};
      });
      return outcome;
    },
    adoptGroups: (groups, options) =>
      rewrite([GROUPS], ({ groups: all }) => {
        const byId = new Map(all.map((each) => [each.id, each]));
        return {
          groups: groups.map((group) => {
            const adopted = options?.replace ? group : adoptOne(byId.get(group.id), group);
            byId.set(group.id, adopted);
            return adopted;
          }),
        };
      }),
    claimGroups: (account) =>
      rewrite([GROUPS, MARKS], ({ groups, marks }) => claim(groups, marks, account)),
    mergeGroup: (from, into) =>
      rewrite([GROUPS, MARKS], ({ groups, marks }) => {
        const group = groups.find((each) => each.id === from);
        if (!group || group.into !== undefined || from === into) return {};
        const became = becomeOther(group, into, marks);
        return { groups: [became.group], marks: became.marks };
      }),
    noteAccount: (account) =>
      write([META], (transaction) => {
        transaction.objectStore(META).put(account, ACCOUNT);
      }),
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
  let account: string | undefined;
  const listeners = new Set<() => void>();
  const changed = () => {
    for (const listener of listeners) listener();
  };
  const records = () => [...marks].map(([project, each]): MarksRecord => ({ project, ...each }));
  const keep = (made: { groups?: ProjectGroup[]; marks?: MarksRecord[] }) => {
    for (const group of made.groups ?? []) groups.set(group.id, group);
    for (const each of made.marks ?? []) marks.set(each.project, marksOf(each));
    changed();
  };
  return {
    read: async (): Promise<OrganizerContent> => ({
      marks: new Map(marks),
      groups: [...groups.values()],
      ...(account !== undefined && { account }),
    }),
    async mark(project, change) {
      marks.set(project, mergeMarks(marks.get(project), change));
      changed();
    },
    async markAll(changes) {
      for (const [project, change] of changes)
        marks.set(project, mergeMarks(marks.get(project), change));
      changed();
    },
    async putGroup(group) {
      const outcome = decideGroup(groups.get(group.id), group, [...groups.values()], account);
      if (outcome === "kept") {
        groups.set(group.id, group);
        changed();
      }
      return outcome;
    },
    async adoptGroups(given, options) {
      for (const group of given)
        groups.set(group.id, options?.replace ? group : adoptOne(groups.get(group.id), group));
      changed();
    },
    async claimGroups(to) {
      keep(claim([...groups.values()], records(), to));
    },
    async mergeGroup(from, into) {
      const group = groups.get(from);
      if (!group || group.into !== undefined || from === into) return;
      const became = becomeOther(group, into, records());
      keep({ groups: [became.group], marks: became.marks });
    },
    async noteAccount(to) {
      account = to;
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
