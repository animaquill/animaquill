import { createHash, randomUUID } from "node:crypto";
import type { MergeConflict } from "@animaquill/core";
import {
  Reassembler,
  SYNC_CLOSE,
  SYNC_LIMITS,
  SYNC_PROTOCOL,
  framesOf,
  packChecked,
  readSyncClientMessage,
  type SyncBatch,
  type SyncClientMessage,
  type SyncRejection,
  type SyncServerMessage,
} from "@animaquill/host/sync";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  inArray,
  lt,
  lte,
  isNotNull,
  isNull,
  min,
  ne,
  notInArray,
  or,
  sql,
  sum,
} from "drizzle-orm";
import {
  describeError,
  retryOnDeadlock,
  type Db,
  type Executor,
  type Logger,
  type Tx,
} from "../database.ts";
import { ARCHIVE_LOCK, recheckSoon, unusableOf, unusableReasonOf } from "../archive/links.ts";
import { hereOf } from "../archive/repo-host.ts";
import { linkLocal } from "../archive/local/links.ts";
import {
  LOOKED_WHILE_PAUSED,
  MERGE_BYTES,
  MERGE_FILES,
  settleMergePause,
} from "../archive/merging.ts";
import { wakeCopy } from "./wake.ts";
import { NO_HOLDS, type ProjectHolds } from "../holds.ts";
import { NO_LIMITS, type PersonLimits } from "../limits.ts";
import { roomFor } from "./room.ts";
import { OWNER_ONLY, type AccessPolicy, type ProjectAction } from "../access.ts";
import {
  deletedProjects,
  lfsUploads,
  OPEN_LFS_STATES,
  projectBatches,
  projectRepos,
  projectSnapshots,
  projects,
  projectUpdates,
  repoConflicts,
  repoMerges,
  type BlockedFile,
  type ConflictLost,
  type ReleasedFrom,
  type RepoMergeState,
} from "../schema.ts";
import { notifyPerson } from "../me/events.ts";
import {
  CopiesFull,
  CopiesGone,
  WorkingCopies,
  type CopyInfo,
  type Executed,
  type Late,
  type Merged,
  type Taken,
  type TakeBackWhy,
  type TakenBack,
  type WatchedBatch,
} from "./copies.ts";
import { batchFromRow, batchRow, mergeBytesOf, readMergeBases, readMergeInput } from "./batches.ts";
import { CURRENT_FORMAT_VERSION } from "@animaquill/schema";

/**
 * Projects kept in step with the editors that connected them: the working copy of each project, the
 * updates of Yjs that the editor sends, numbered one after the other in the database, and the
 * connections that hear of them. The protocol is the editor's, see `SyncClientMessage` in
 * @animaquill/host.
 *
 * Every update is checked before it is taken: read whole, taken into the working copy with the
 * editor's own core, and every key it writes checked on its own (see `checkWritten`: a place the
 * format has, the right kind, a value of its field, not too large), and the project is still that
 * project, of a format the platform knows. Nothing checks how keys go together: two changes that are
 * fine on their own can make a project that is not, and neither may be turned away for that. An
 * update that needs one the platform does not have is turned away, and the window sends what is
 * missing first. Whatever goes wrong once an update is in the working copy, and before the database
 * has it, the copy goes and comes back from the database: it never has what the database does not.
 *
 * The working copies are in a thread of their own, see copies.ts, with a budget of memory that
 * counts what projects are made of, not only their bytes: a person's projects in use get a share of
 * it, and a project grows only so large. What one connection sends is counted as it arrives, it
 * waits while its last message is taken in, and only so much of it can wait at all. A person has only
 * so many projects, of only so many bytes, and opens only so many connections in a minute.
 *
 * Every update has a digest that stands for it and all before it. A window that says it has another
 * digest for a number than the platform has (the platform came back from a backup) gets everything
 * from the start, and sends again what it has of its own, see "welcome".
 *
 * Who makes a change goes with it (see `SyncKind`), with the browser and the window, and the update
 * of the platform the window had then: what is needed to put the
 * person's own changes first. For now Yjs merges what was made at the same time; where changes made
 * without the latest come in after others, the project is kept as it was before them first.
 *
 * One process holds the working copies. Two would each have their own, which is why the head of a
 * project only moves on where it still is what this one thinks: otherwise its connections close, and
 * come back to a copy read again.
 *
 * What the platform keeps of a project for good is its row, and the working copy can go and come
 * back from the repository: `release` lets go of it, and the worker makes it again
 * (archive/rebuild.ts) once a window of the owner says hello for it, which closes with
 * `SYNC_CLOSE.unavailable` ("restoring") meanwhile and comes back. A project whose copy is not here
 * (`copy_state`) is not read at all. Each copy of a project has a number, its `generation`: a
 * window says which one it has in "hello", and one that has another than the project's closes with
 * `SYNC_CLOSE.rebuilt`, as what it has is of another document and cannot go on with this one,
 * nothing of it taken; "welcome" says which one this is. A window that says none and has nothing of
 * the project yet (`after` 0) goes on as ever; one that says none and has some of it is from before
 * copies were told apart, and hears that it is too old (`SYNC_CLOSE.outdated`) once the project is
 * on another copy than its first. A window that only reads can ask for the copy as it began
 * (`base`), which is what a window of the one before has in common with it. `opened_at` notes when
 * a window last connected, once an hour at most.
 *
 * A project can be taken away for good, see `remove`: one saved to a repository only once that has
 * everything of it, or where people said they let the rest go; the repository stays as it is. Its id
 * is kept for a week (`deleted_projects`, `deletedKeptMs`), and no project is made under it
 * meanwhile, whoever asks: a window's request to make it can arrive well after the project went, or
 * after the editor asked to take away what was not there yet. Once the person took it out of their
 * list, nothing needs to remember it longer: the ids that are older go within the hour, see
 * sync/sweep.ts, and until then count for nothing. Windows hear that it was deleted
 * (`SYNC_CLOSE.deleted`) as it goes, and when they come for it in that week.
 *
 * A project whose repository cannot be used (archive/links.ts, `UNUSABLE_REASONS`) cannot be
 * edited: the hub closes its windows as soon as that is found (`linkChanged`, which
 * sync/link-listener.ts calls when the database says so), turns away every window that says hello
 * for it, and takes no change of it (`SYNC_CLOSE.unusable`). What came before that stays in the
 * working copy. A window may still read it (`readOnly` of "hello"), to keep a copy of what the
 * platform has: that sends nothing, and does not count as opening it.
 */

/**
 * The oldest editor the platform syncs with: an older one is closed with `SYNC_CLOSE.outdated` as
 * it says hello, and its page says to reload. What it has is in its log, which a reload sends.
 * Raised by a release whose change an older page would read or write wrongly, and listed in the
 * release notes: 0.3.71 takes files into the large file storage of GitHub from the editor, whose
 * places an older page writes nothing of; 0.3.72 keeps the switches of the cloud features on each
 * device and what is secret of each AI service sealed whole, and an older page asks the platform
 * for what it no longer has; 0.3.82 keeps summaries of conversations as entries of their own, which
 * an older page drops and writes back without, so it writes no conversation either (me/routes.ts);
 * 0.3.105 has pictures stretch to their box (`fit` "stretch"), which an older page reads as a
 * project that does not fit the format (an older page of a project on this computer does too, and
 * only a reload helps there); 0.3.106 works springs, presets and noise of keys out and gives keys
 * `presetParams`, which an older page reads as a key that does not
 * fit the format, and works out otherwise than the export; 0.3.110 writes the changes of a project
 * in the browser's storage in a transaction of their own, marked with the log they are for (`of`),
 * which an older page carries along when it moves a log, so that after a backup is put back they
 * would no longer count as the project's; 0.3.117 has the master of a timeline take `limit.on` and
 * `limit.ceiling` (its safe limiter), which an older page reads as a project
 * that does not fit the format, and mixes effects of sound otherwise than the export; 0.3.120 has
 * the manifest take `defaultStorage`, which an older page reads as a
 * project that does not fit the format, refusing the commands of the project properties; 0.3.143 keeps
 * messages of other conversations in a conversation (a turn they start is a message of people
 * marked `from`, one read in the middle of a task an entry of its own), which an older page takes
 * for words of people, or drops. Undefined: every editor. An editor that is not a release ("dev")
 * is as new as the code.
 */
export const OLDEST_EDITOR: string | undefined = "0.3.143";

const VERSION = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/;

/**
 * Whether an editor of this version (`editor` of "hello") is `since` or later, as `OLDEST_EDITOR`
 * asks. An editor that is not a release (a page of the code as it is, "dev") is as new as the code;
 * anything else that is no version is not.
 */
export const editorAtLeast = (editor: string, since: string | undefined): boolean => {
  if (since === undefined) return false;
  if (editor === "dev") return true;
  const have = VERSION.exec(editor);
  const need = VERSION.exec(since);
  if (!have || !need) return false;
  for (let part = 1; part <= 3; part++) {
    const a = Number(have[part]);
    const b = Number(need[part]);
    if (a !== b) return a > b;
  }
  return true;
};

/** `opened_at` of a project is written at most this often. */
const OPENED_EVERY_MS = 60 * 60_000;

/** A repository nobody looked at for this long is looked at again when a window opens its project. */
export const LOOK_AGAIN_MS = 60 * 60_000;

/**
 * A transaction whose every statement sees what is committed when it starts: what `remove` and
 * `#create` need, as they look only after they waited for a lock.
 */
const READ_COMMITTED = { isolationLevel: "read committed" } as const;

/** The space of the locks on the ids of projects, see `lockProject`. */
export const PROJECT_LOCK = 0x61712d70; // "aq-p"

/**
 * Holds the id of a project until the transaction ends, against any other transaction that does:
 * making a project under an id and taking the project of an id away both do, so that neither
 * happens between the other one's looking and its writing. Whoever comes second waits, and then
 * sees what the first one left.
 */
export const lockProject = async (tx: Tx, id: string): Promise<void> => {
  await tx.execute(sql`select pg_advisory_xact_lock(${PROJECT_LOCK}, hashtext(${id}))`);
};

/**
 * Whether a project of this id was taken away after `since`, see `deleted_projects`: an id noted
 * before that counts for nothing, as if it was forgotten already (`deletedKeptMs`).
 */
const wasDeleted = async (
  db: Executor,
  id: string,
  since: Date,
  /** Only where it was this person's. */
  ownerId?: string,
): Promise<boolean> => {
  const [gone] = await db
    .select({ id: deletedProjects.id })
    .from(deletedProjects)
    .where(
      and(
        eq(deletedProjects.id, id),
        gt(deletedProjects.deletedAt, since),
        ownerId === undefined ? undefined : eq(deletedProjects.ownerId, ownerId),
      ),
    )
    .limit(1);
  return gone !== undefined;
};

/**
 * What people asked for when they take a project away that is saved to a repository, see
 * `SyncHub.remove`. Without either, such a project stays.
 */
export interface RemoveCondition {
  /**
   * The update of the project that the editor saw archived: it goes only where the repository has
   * the project up to its head, and that is this update, and no change waits to be archived; and
   * where archiving goes as it should, which says that the repository is still there: not paused
   * (as for a repository that is gone), no archive people asked for still to be done (which is
   * what finds out, asking GitHub first), and the last one did not fail.
   */
  readonly archived?: number | undefined;
  /**
   * People let go of whatever the repository does not have, and of files still on their way into
   * its large file storage: nothing is looked at.
   */
  readonly discard?: boolean | undefined;
  /**
   * The platform takes it away as its repository cannot be used (sync/sweep.ts): only where that
   * is so since this time or before, as the database has it now; otherwise it stays
   * ("hasRepository"). Nothing else is looked at.
   */
  readonly unusableBefore?: Date | undefined;
}

/** What taking a project away came to, see `SyncHub.remove`. */
export type RemoveOutcome =
  | "removed"
  | "missing"
  | "hasRepository"
  /**
   * It stays: the repository does not have everything of it, or may not be there any more, as far
   * as the platform knows. How archiving goes, for the editor to say why: paused and why, an
   * archive people asked for that is not done yet, the last one failed.
   */
  | {
      readonly kind: "notArchived";
      readonly head: number;
      readonly archivedSeq: number;
      readonly state: "ready" | "paused";
      readonly reason?: string;
      readonly archiving: boolean;
      readonly failures?: number;
    }
  /** It stays: files of it are still on their way into the large file storage, this many. */
  | { readonly kind: "uploading"; readonly uploads: number };

export interface SyncLimits {
  /** A snapshot is made after this many updates... */
  readonly compactUpdates: number;
  /** ...or this many bytes of them. */
  readonly compactBytes: number;
  /** A project does not grow larger than this, as Yjs counts it. */
  readonly projectBytes: number;
  /**
   * Ids a person has noted as taken away in a day (`deleted_projects`), after which no more ids
   * that never were a project are noted for them, see `remove`. A project that is taken away is
   * always noted.
   */
  readonly notedIdsPerDay: number;
  /**
   * How long the id of a project that was taken away is kept (`deleted_projects`), and no project
   * is made under it: after that it counts for nothing, and goes with the hourly sweep.
   */
  readonly deletedKeptMs: number;
  /** A window further behind than this gets the whole project instead of the updates. */
  readonly catchUpUpdates: number;
  /** Updates read from the database at a time, while a window catches up. */
  readonly catchUpBatch: number;
  /** Snapshots from before changes made without the latest, kept for each project... */
  readonly beforeMerge: number;
  /** ...and their bytes, together. */
  readonly beforeMergeBytes: number;
  /** ...and at most one in this long, whatever browsers say they are. */
  readonly beforeMergeMs: number;
  /** A project nobody is connected to stays in memory for this long. */
  readonly idleMs: number;
  /** What one connection may send in a minute. */
  readonly messagesPerMinute: number;
  readonly bytesPerMinute: number;
  /** What may wait to be taken in, of one connection: whole messages, and what came of one... */
  readonly queuedMessages: number;
  readonly queuedBytes: number;
  /** ...of all connections of one person, and of everyone. */
  readonly queuedBytesPerUser: number;
  readonly queuedBytesTotal: number;
  /** A message in parts whose next part does not come in this long closes its connection. */
  readonly partsMs: number;
  /** What may wait to go out to one connection, and to everyone, see `Outbox`... */
  readonly outboundBytes: number;
  readonly outboundBytesTotal: number;
  /** ...and how long it may wait without any of it going. */
  readonly stuckMs: number;
  /** Connections of one person at a time... */
  readonly connectionsPerUser: number;
  /** ...and how many they may open in a minute. */
  readonly startsPerMinute: number;
  /** Memory the working copies may take together, as `weightOf` estimates it... */
  readonly copiesBytes: number;
  /** ...the projects of one person that are in use... */
  readonly copiesPerPerson: number;
  /** ...and one project: it grows no larger. */
  readonly projectMemory: number;
  /** The heap of the thread of the working copies, in MB: the copies, and what changes take. */
  readonly copiesHeapMb: number;
  /**
   * The most files, and bytes of their texts, that one merge from GitHub takes in: more is refused
   * ("too-large"), and people choose what to do.
   */
  readonly mergeFiles: number;
  readonly mergeBytes: number;
  /** A merge that holds up the thread of the working copies longer than this is noted. */
  readonly mergeSlowMs: number;
  /**
   * The platform's batches whose changes made without them are looked for, see late-writes.ts of
   * core: the newest so many of a project, of so long ago at most, as for taking them back (6.5a).
   */
  readonly batchesWatched: number;
  readonly batchesWatchedMs: number;
}

export const SYNC_HUB_LIMITS: SyncLimits = {
  compactUpdates: 500,
  compactBytes: 4 * 1024 * 1024,
  projectBytes: SYNC_LIMITS.state,
  notedIdsPerDay: 200,
  deletedKeptMs: 7 * 24 * 3600_000,
  catchUpUpdates: 2000,
  catchUpBatch: 200,
  beforeMerge: 20,
  beforeMergeBytes: 64 * 1024 * 1024,
  beforeMergeMs: 10 * 60_000,
  idleMs: 60_000,
  messagesPerMinute: 6000,
  bytesPerMinute: 128 * 1024 * 1024,
  queuedMessages: 256,
  queuedBytes: 2 * SYNC_LIMITS.update,
  queuedBytesPerUser: 3 * SYNC_LIMITS.update,
  queuedBytesTotal: 256 * 1024 * 1024,
  partsMs: 45_000,
  outboundBytes: 2 * SYNC_LIMITS.state,
  outboundBytesTotal: 256 * 1024 * 1024,
  stuckMs: 60_000,
  connectionsPerUser: 10,
  startsPerMinute: 120,
  copiesBytes: 384 * 1024 * 1024,
  // A quarter of it, and no project larger: one of them always opens, when nothing else of the
  // person's is being done with.
  copiesPerPerson: 96 * 1024 * 1024,
  projectMemory: 96 * 1024 * 1024,
  copiesHeapMb: 768,
  mergeFiles: MERGE_FILES,
  mergeBytes: MERGE_BYTES,
  mergeSlowMs: 5000,
  batchesWatched: 50,
  batchesWatchedMs: 30 * 24 * 3600_000,
};

/** The other end of a connection, as the socket has it. */
export interface SyncPeer {
  send(data: Uint8Array): void;
  close(code: number, reason: string): void;
  /** Stops reading what comes, while what came is taken in. */
  pause?(): void;
  resume?(): void;
  /** Bytes sent that are still on their way out, see `Outbox`. Nothing waits where it says none. */
  buffered?(): number;
}

/** Bytes a socket may have on their way out before more goes into it, see `Outbox`. */
const SOCKET_HIGH = 1024 * 1024;

/** Who is on a connection: the person, and the session of their browser. */
export interface SyncWho {
  readonly userId: string;
  /** What the session is known by, so that signing out can close what it opened. */
  readonly session: string;
}

/** A connection as the socket talks to it. */
export interface SyncConnection {
  receive(data: Uint8Array): void;
  /** The socket closed. */
  closed(): void;
}

export interface SyncHubOptions {
  readonly db: Db;
  readonly log: Logger;
  readonly now?: () => Date;
  readonly limits?: Partial<SyncLimits>;
  /**
   * How much each person may have, see limits.ts: asked only as a project is made (`#create`,
   * sync/room.ts), never of a change, a merge, renaming or a copy made again. Nothing unless said.
   */
  readonly personLimits?: PersonLimits | undefined;
  /** The oldest editor synced with, see `OLDEST_EDITOR`: none unless said, as in the tests. */
  readonly oldestEditor?: string | undefined;
  /** What else may change a project, which keeps its copy from being let go of: none unless said. */
  readonly holds?: ProjectHolds | undefined;
  /** Who may do what with which project, see access.ts: only the owner unless said. */
  readonly access?: AccessPolicy | undefined;
  /**
   * Has the repository of a project looked at again soon, as a window opened it and nobody looked
   * for a while (`LOOK_AGAIN_MS`): GitHub does not send again what it could not deliver.
   */
  readonly lookAgain?: ((projectId: string) => Promise<void>) | undefined;
  /**
   * Has the worker make the working copy of a project again from its repository (archive/rebuild.ts),
   * as a window of its owner says hello for it after the platform let go of it. Undefined where
   * nothing does that: such a window hears to come back later, and the copy stays where it is.
   */
  readonly rebuild?: ((projectId: string) => Promise<void>) | undefined;
  /** Has a project archived soon, as after a merge from GitHub changed it, see `mergeRepo`. */
  readonly merged?: ((projectId: string) => Promise<void>) | undefined;
  /**
   * New projects are saved to repositories of the server's own (archive/local/), linked as they
   * are made: where the server keeps those and is not set up for GitHub.
   */
  readonly linkLocal?: boolean | undefined;
}

/**
 * What came of merging changes from GitHub, see `SyncHub.mergeRepo`: no such merge; nothing to do
 * any more, as it is not "ready"; not now, as the working copy is not here or the project cannot be
 * edited, and it stays "ready"; merged as this update (none where nothing changed); or refused.
 */
export type RepoMergeOutcome =
  | { readonly kind: "missing" }
  | { readonly kind: "done"; readonly state: RepoMergeState }
  | { readonly kind: "later"; readonly why: string }
  | {
      readonly kind: "applied";
      readonly seq: number | undefined;
      readonly conflicts: number;
      readonly blocked: number;
    }
  | { readonly kind: "refused"; readonly reason: string };

/**
 * Why a batch of the platform's cannot be taken back, or done again, now (`SyncHub.takeBack`), as
 * the copy says (`TakeBackWhy`), or as the database does: files people chose to take out, or a
 * merge some of whose files they chose to take out since ("drop"); what history taken away on
 * GitHub brought, taken out again, or a merge whose history was taken away since ("history"): any
 * of these would come back;
 * a step that is not the last of its batch any more, or a batch taken back already, whose last step
 * goes the other way ("notLatest", "undone"); older than a project keeps them for, or behind as
 * many newer ones ("age", "count", as `SyncLimits.batchesWatched`); the repository cannot be used,
 * and nothing of the project changes ("unusable").
 */
export type BatchWhy =
  TakeBackWhy | "drop" | "history" | "notLatest" | "count" | "age" | "unusable";

/** A batch of the platform's own, and what taking it back would do now, `SyncHub.batchState`. */
export interface BatchState {
  readonly id: string;
  /** "repo", "drop", "undo", "redo", see `project_batches.kind`. */
  readonly kind: string;
  readonly label: string;
  readonly files: number;
  /** When it was made, in milliseconds since 1970. */
  readonly at: number;
  /** The batch it is about is taken back now (for "undo" and "redo", the one of `undoes`). */
  readonly undone: boolean;
  readonly undoes?: string;
  /** What takes the batch it is about back, or does it again, from where it is now. */
  readonly next?: { readonly batch: string; readonly direction: "undo" | "redo" };
  /** Why `takeBack` of this one would not go now. */
  readonly why?: BatchWhy;
}

export type BatchStateOutcome =
  { readonly kind: "missing" } | { readonly kind: "state"; readonly state: BatchState };

/** What came of `SyncHub.takeBack`. */
export type TakeBackOutcome =
  | { readonly kind: "missing" }
  | { readonly kind: "refused"; readonly why: BatchWhy }
  | {
      readonly kind: "taken";
      /** The batch it is, and its update: none where nothing changed. */
      readonly batch: string;
      readonly seq: number | undefined;
      readonly direction: "undo" | "redo";
      /** Places that went back, and that stayed as they were changed since: the first of them. */
      readonly back: readonly (readonly string[])[];
      readonly kept: readonly (readonly string[])[];
      readonly backCount: number;
      readonly keptCount: number;
      readonly obstacle?: "changed" | "inUse";
      /** What goes the other way again. */
      readonly next: { readonly batch: string; readonly direction: "undo" | "redo" };
    };

/** The kind of the batch a rename from the start page is, see `SyncHub.rename`. */
export const RENAME_BATCH = "rename";

/** What came of renaming a project from the start page, see `SyncHub.rename`. */
export type RenameOutcome =
  | { readonly kind: "missing" }
  /** It is called that already: nothing was written. */
  | { readonly kind: "unchanged"; readonly name: string }
  /** `batch`, the batch it is, which takes it back as a whole; `seq`, its update. */
  | {
      readonly kind: "renamed";
      readonly name: string;
      readonly batch: string;
      readonly seq: number | undefined;
    }
  /**
   * Not renamed: no name ("invalid"), the project is locked ("locked"), its repository cannot be
   * used ("unusable"), the working copy is not here but in the repository ("released", see
   * wake.ts), or something else ("failed"). Never for what the person keeps: renaming a project
   * that is there takes no room of a new one (sync/room.ts).
   */
  | {
      readonly kind: "refused";
      readonly why: "invalid" | "locked" | "unusable" | "released" | "failed";
    };

/** How many places `TakeBackOutcome` names at most, each way. */
const PATHS_SAID = 500;

/** A batch to take back, as the database says, see `SyncHub.#takingBack`. */
interface TakingBack {
  readonly state: BatchState;
  readonly root: typeof projectBatches.$inferSelect;
  readonly direction: "undo" | "redo";
}

/**
 * The update of a batch of the platform's own, for `#store`: of the platform's device, its window
 * the batch, with `by` for the windows; none where it changed nothing.
 */
const platformChange = (
  delta: Uint8Array | undefined,
  options: {
    readonly kind: string;
    readonly base: number;
    readonly at: Date;
    readonly by: SyncBatch;
  },
): Taking[] =>
  delta
    ? [
        {
          delta,
          kind: options.kind,
          device: PLATFORM_DEVICE,
          window: options.by.batch,
          base: options.base,
          behind: false,
          madeAt: options.at,
          by: options.by,
        },
      ]
    : [];

/** What the platform writes into the database as an update of a project, see `#store`. */
interface Taking {
  readonly delta: Uint8Array;
  readonly kind: string;
  readonly device: string;
  readonly window: string;
  readonly base: number;
  readonly behind: boolean;
  readonly madeAt: Date;
  readonly by?: SyncBatch;
}

/** An update as the database took it, to tell windows of. */
interface Stored {
  readonly seq: number;
  readonly digest: string;
  readonly kind: string;
  readonly at: number;
  readonly payload: Uint8Array;
  readonly by?: SyncBatch;
}

/** A conflict to note, see `#noteConflicts`. */
interface NewConflict extends MergeConflict {
  readonly batch: string;
  readonly lost: ConflictLost;
  readonly source: "merge" | "late";
  readonly oursBy?: string;
  readonly oursAt?: Date;
  /** What went is what this change wrote into what the batch took away, see `#theirsWithout`. */
  readonly change?: Uint8Array;
}

/** The largest change kept with a conflict, see `repo_conflicts.change`. */
const CHANGE_KEPT = 1024 * 1024;

/** What the platform calls a batch of its own that it knows nothing more of. */
const REPO_LABEL = "GitHub 上的改动";

/** What names the platform as the device of updates it wrote itself. */
export const PLATFORM_DEVICE = "platform";

/** A merge that is not "ready" any more, as the transaction that would take it finds. */
class NotReady extends Error {}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * What letting go of a working copy came to, see `SyncHub.release`: done; not there or not the
 * person's; not here anyway; a window is connected; it has no repository, or one that cannot be
 * used; an archive of it runs, a repository is being linked to it, or changes wait that only GitHub
 * or the platform keeps from being archived (`transient`); or the repository does not have
 * everything of it yet.
 */
export type ReleaseOutcome =
  | { readonly kind: "released"; readonly from: ReleasedFrom }
  | { readonly kind: "missing" | "notLive" | "connected" | "noRepository" | "unusable" | "busy" }
  | { readonly kind: "transient" }
  | {
      readonly kind: "notArchived";
      readonly head: number;
      readonly archivedSeq: number;
      readonly state: string;
      readonly reason?: string;
    };

/** The project ids of the editor, see `Id` in the project format. */
export const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
/** What names a project of the platform, as "hello" of the protocol takes it, see `newSyncId`. */
export const PLATFORM_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** Kinds of changes a browser of the owner may say it sends. */
const BROWSER_KINDS = new Set(["user", "folder", "ai", "other", "repair"]);
/** Part of `projectBytes` from which a change finds out how large the project really is. */
const NEAR_THE_LIMIT = 0.9;
/** Rejections that the same change can come again after. */
const RETRY: ReadonlySet<SyncRejection> = new Set(["too-new", "busy", "unavailable"]);

/**
 * What stands for an update and all before it: a project that came back from a backup gives a
 * number another update, and so another digest.
 */
export const digestOf = (before: string, seq: number, data: Uint8Array): string =>
  createHash("sha256")
    .update(before)
    .update(`:${seq}:`)
    .update(data)
    .digest("base64url")
    .slice(0, 22);

class Closed extends Error {
  readonly code: number;
  constructor(code: number, reason: string) {
    super(reason);
    this.code = code;
  }
}

/** The head of a project moved on in the database, not here: another process took a change. */
class HeadMoved extends Error {}

/** A project of the id was taken away lately: none is made under it, see `deleted_projects`. */
class Deleted extends Error {}

/** The working copy of a project is not here, see `copy_state`: nothing of it is read. */
class NotLive extends Error {
  /** Whose project it is: what a connection hears depends on that, as for one that is here. */
  readonly ownerId: string;
  /** On its way back from the repository, as against let go of. */
  readonly isComing: boolean;
  constructor(ownerId: string, isComing: boolean) {
    super("the working copy of the project is not here");
    this.ownerId = ownerId;
    this.isComing = isComing;
  }
}

/** What the hub knows of a project, in memory or not. */
class Project {
  readonly id: string;
  readonly ownerId: string;
  /** The id in its animaquill.json, which it keeps. */
  readonly projectId: string;
  head: number;
  digest: string;
  /** The first update the database still has: before it, only the snapshot. */
  oldest: number;
  /** Updates and their bytes since the last snapshot. */
  updatesSince: number;
  bytesSince: number;
  /** How large the project is, about: its snapshot and the updates after it. */
  bytes: number;
  name: string;
  /** What it says about itself, as the platform keeps it, see `CopyInfo.description`. */
  description: string;
  /** Which working copy this is, see `projects.generation`. */
  readonly generation: number;
  /** When `opened_at` was last written, in milliseconds since 1970: 0 for never. */
  openedAt: number;
  /**
   * Why its repository cannot be used, as last read (`linkChanged`, "hello"): undefined where it
   * can, or where it has none.
   */
  unusable: string | undefined;
  /** When the hub last had its repository looked at, see `lookAgain`. */
  lookedAt = 0;
  readonly connections = new Set<Connection>();
  unloadTimer: ReturnType<typeof setTimeout> | undefined;
  lastBeforeMerge = 0;
  /** Which side stays where both changed the same thing, as its link said when last read. */
  prefer: "editor" | "github" = "editor";
  /** The platform's batches the copy watches, see `#batchesOf`, by their updates, oldest first. */
  watched: { readonly id: string; readonly seq: number }[] = [];
  /** The newest batch it does not watch any more, if there is one. */
  unwatched: { readonly id: string; readonly seq: number } | undefined;

  constructor(fields: {
    id: string;
    ownerId: string;
    projectId: string;
    head: number;
    digest: string;
    oldest: number;
    updatesSince: number;
    bytesSince: number;
    bytes: number;
    name: string;
    description: string;
    generation: number;
    openedAt: number;
    unusable?: string | undefined;
  }) {
    this.id = fields.id;
    this.ownerId = fields.ownerId;
    this.projectId = fields.projectId;
    this.head = fields.head;
    this.digest = fields.digest;
    this.oldest = fields.oldest;
    this.updatesSince = fields.updatesSince;
    this.bytesSince = fields.bytesSince;
    this.bytes = fields.bytes;
    this.name = fields.name;
    this.description = fields.description;
    this.generation = fields.generation;
    this.openedAt = fields.openedAt;
    this.unusable = fields.unusable;
  }
}

/**
 * What goes out to a connection, in order: into its socket only as fast as that takes it, so that a
 * browser that reads slowly, or not at all, holds no more than `outboundBytes` here and in the
 * socket. One whose socket takes nothing for `stuckMs` closes.
 */
class Outbox {
  readonly #connection: Connection;
  readonly #frames: Uint8Array[] = [];
  bytes = 0;
  #pumping = false;

  constructor(connection: Connection) {
    this.#connection = connection;
  }

  /** What waits here and in the socket. */
  get total(): number {
    return this.bytes + (this.#connection.peer.buffered?.() ?? 0);
  }

  add(frames: readonly Uint8Array[]): void {
    for (const frame of frames) {
      this.#frames.push(frame);
      this.bytes += frame.length;
    }
    this.#connection.hub.outbound(this.#connection, frames);
    void this.#pump();
  }

  /** Lets go of everything, as the connection closed. */
  clear(): void {
    this.#frames.length = 0;
    this.bytes = 0;
  }

  async #pump(): Promise<void> {
    if (this.#pumping) return;
    this.#pumping = true;
    const { peer, hub } = this.#connection;
    let lastLeft = Number.POSITIVE_INFINITY;
    let since = Date.now();
    try {
      while (this.#frames.length > 0 && !this.#connection.isClosed) {
        const left = peer.buffered?.() ?? 0;
        if (left > SOCKET_HIGH) {
          if (left < lastLeft) since = Date.now();
          lastLeft = left;
          if (Date.now() - since > hub.stuckMs) {
            this.#connection.close(SYNC_CLOSE.tooMany, "takes nothing of what it is sent");
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 50));
          continue;
        }
        lastLeft = Number.POSITIVE_INFINITY;
        since = Date.now();
        const frame = this.#frames.shift() as Uint8Array;
        this.bytes -= frame.length;
        hub.outbound(this.#connection, [], frame.length);
        peer.send(frame);
      }
    } finally {
      this.#pumping = false;
    }
  }
}

class Connection implements SyncConnection {
  readonly hub: SyncHub;
  readonly peer: SyncPeer;
  readonly who: SyncWho;
  readonly frames: Reassembler;
  readonly outbox: Outbox;
  project: Project | undefined;
  device = "";
  window = "";
  /** The version of the editor, as "hello" says it. */
  editor = "";
  /** It only reads the project, see `readOnly` of "hello". */
  readOnly = false;
  isReady = false;
  isClosed = false;
  /** Whether the project was kept as it was before changes of this connection that are behind. */
  snapshotted = false;
  /** One message after the other. */
  work: Promise<void> = Promise.resolve();
  queuedMessages = 0;
  /** Bytes of whole frames that wait to be taken in, and of a message in parts that is on its way. */
  queuedBytes = 0;
  held = 0;
  partsTimer: ReturnType<typeof setTimeout> | undefined;
  windowStart = 0;
  messages = 0;
  bytes = 0;

  constructor(hub: SyncHub, peer: SyncPeer, who: SyncWho) {
    this.hub = hub;
    this.peer = peer;
    this.who = who;
    this.frames = new Reassembler(SYNC_LIMITS.update);
    this.outbox = new Outbox(this);
  }

  receive(data: Uint8Array): void {
    if (this.isClosed) return;
    // Counted as it comes, not as it is taken in: what waits counts too.
    if (!this.hub.counts(this, data.length)) return;
    this.queuedMessages += 1;
    this.hub.inbound(this, data.length);
    this.peer.pause?.();
    this.work = this.work.then(async () => {
      try {
        await this.hub.handle(this, data);
      } finally {
        this.queuedMessages -= 1;
        this.hub.inbound(this, -data.length);
        if (this.queuedMessages === 0 && !this.isClosed) this.peer.resume?.();
      }
    });
  }

  closed(): void {
    this.hub.forget(this);
  }

  send(message: SyncServerMessage): void {
    if (this.isClosed) return;
    this.outbox.add(framesOf(message));
  }

  close(code: number, reason: string): void {
    if (this.isClosed) return;
    this.isClosed = true;
    this.peer.close(code, reason);
    this.hub.forget(this);
  }
}

export class SyncHub {
  readonly #db: Db;
  readonly #log: Logger;
  readonly #now: () => Date;
  readonly #limits: SyncLimits;
  readonly #copies: WorkingCopies;
  readonly #projects = new Map<string, Project>();
  /** What happens to each project, in order, by its id: also before it is in memory. */
  readonly #queues = new Map<string, Promise<void>>();
  readonly #connections = new Set<Connection>();
  /** Connections each person opened in the last minute, see `startsPerMinute`. */
  readonly #starts = new Map<string, { at: number; count: number }>();
  /** Bytes that wait to be taken in, see `queuedBytesPerUser`, of each person and of everyone. */
  readonly #inboundOf = new Map<string, number>();
  #inboundTotal = 0;
  /** Bytes that wait to go out, see `outboundBytesTotal`. */
  #outboundTotal = 0;
  /** The update that was being taken in, by its digest, when the working copies last went. */
  readonly #blewUp = new Map<string, string>();
  #stopped = false;
  readonly #oldestEditor: string | undefined;
  readonly #holds: ProjectHolds;
  readonly #personLimits: PersonLimits;
  readonly #access: AccessPolicy;
  readonly #lookAgain: ((projectId: string) => Promise<void>) | undefined;
  readonly #linkLocal: boolean;
  readonly #rebuild: ((projectId: string) => Promise<void>) | undefined;
  readonly #merged: ((projectId: string) => Promise<void>) | undefined;

  constructor({ db, log, now, limits, ...options }: SyncHubOptions) {
    this.#db = db;
    this.#log = log;
    this.#now = now ?? (() => new Date());
    this.#oldestEditor = options.oldestEditor;
    this.#holds = options.holds ?? NO_HOLDS;
    this.#personLimits = options.personLimits ?? NO_LIMITS;
    this.#access = options.access ?? OWNER_ONLY;
    this.#lookAgain = options.lookAgain;
    this.#rebuild = options.rebuild;
    this.#linkLocal = options.linkLocal === true;
    this.#merged = options.merged;
    this.#limits = { ...SYNC_HUB_LIMITS, ...limits };
    this.#copies = new WorkingCopies({
      heapMb: this.#limits.copiesHeapMb,
      budget: this.#limits.copiesBytes,
      perPerson: this.#limits.copiesPerPerson,
      perProject: this.#limits.projectMemory,
      busy: () => this.#inUse(),
      log,
    });
    // Each process notes the projects its windows are connected to as opened, every hour, by
    // itself: the sweep, which runs in one of them, sees only its own (`noteConnected`).
    this.#openedTimer = setInterval(() => {
      void this.noteConnected().catch(() => {});
    }, OPENED_EVERY_MS);
    this.#openedTimer.unref?.();
  }

  /** See the constructor. */
  readonly #openedTimer: ReturnType<typeof setInterval>;

  /** A new connection, of someone signed in. */
  open(peer: SyncPeer, who: SyncWho): SyncConnection {
    const connection = new Connection(this, peer, who);
    if (this.#stopped) {
      connection.close(SYNC_CLOSE.unavailable, "the platform is stopping");
      return connection;
    }
    const theirs = [...this.#connections].filter((other) => other.who.userId === who.userId);
    if (theirs.length >= this.#limits.connectionsPerUser || !this.#mayStart(who.userId)) {
      connection.close(SYNC_CLOSE.tooMany, "too many connections");
      return connection;
    }
    this.#connections.add(connection);
    return connection;
  }

  /** Counts a connection a person opens. False where that is more than they may in a minute. */
  #mayStart(userId: string): boolean {
    const now = this.#now().getTime();
    if (this.#starts.size > 10_000) {
      for (const [user, starts] of this.#starts) {
        if (now - starts.at >= 60_000) this.#starts.delete(user);
      }
    }
    const starts = this.#starts.get(userId);
    if (!starts || now - starts.at >= 60_000) {
      this.#starts.set(userId, { at: now, count: 1 });
      return true;
    }
    starts.count += 1;
    return starts.count <= this.#limits.startsPerMinute;
  }

  /** Signing out: the connections of the session close, saying so. */
  closeSession(session: string): void {
    for (const connection of Array.from(this.#connections)) {
      if (connection.who.session === session) connection.close(SYNC_CLOSE.signedOut, "signed out");
    }
  }

  /** A person is signed out everywhere, as after taking the App's authorization back. */
  closeUser(userId: string): void {
    for (const connection of Array.from(this.#connections)) {
      if (connection.who.userId === userId) connection.close(SYNC_CLOSE.signedOut, "signed out");
    }
  }

  /** The platform stops: everyone comes back later, to whichever runs then. */
  stop(): void {
    this.#stopped = true;
    clearInterval(this.#openedTimer);
    for (const connection of Array.from(this.#connections)) {
      connection.close(SYNC_CLOSE.unavailable, "the platform is stopping");
    }
    for (const project of this.#projects.values()) clearTimeout(project.unloadTimer);
    this.#projects.clear();
    void this.#copies.stop();
  }

  /** Resolves once nothing is on its way, for tests: every message taken in, every project done. */
  async idle(): Promise<void> {
    for (;;) {
      const busy = [...this.#queues.values(), ...[...this.#connections].map((each) => each.work)];
      await Promise.all(busy);
      const now = [...this.#queues.values(), ...[...this.#connections].map((each) => each.work)];
      if (now.length === busy.length && now.every((work, index) => work === busy[index])) return;
    }
  }

  /** How many connections are open, how many projects are known, and how many are in memory. */
  get size(): { readonly connections: number; readonly projects: number; readonly open: number } {
    let open = 0;
    for (const id of this.#projects.keys()) if (this.#copies.isOpen(id)) open += 1;
    return { connections: this.#connections.size, projects: this.#projects.size, open };
  }

  /** How long a connection may take nothing of what waits for it, see `Outbox`. */
  get stuckMs(): number {
    return this.#limits.stuckMs;
  }

  /** Counts bytes that came on a connection and wait to be taken in, or that went (`bytes` < 0). */
  inbound(connection: Connection, bytes: number): void {
    connection.queuedBytes += bytes;
    this.#inboundTotal += bytes;
    const user = connection.who.userId;
    const theirs = (this.#inboundOf.get(user) ?? 0) + bytes;
    if (theirs > 0) this.#inboundOf.set(user, theirs);
    else this.#inboundOf.delete(user);
  }

  /** Counts what waits to go out: `frames` that came into an outbox, and `sent` bytes that went. */
  outbound(connection: Connection, frames: readonly Uint8Array[], sent = 0): void {
    let added = 0;
    for (const frame of frames) added += frame.length;
    this.#outboundTotal += added - sent;
    if (added === 0 || connection.isClosed) return;
    if (connection.outbox.total > this.#limits.outboundBytes) {
      connection.close(SYNC_CLOSE.tooMany, "takes too little of what it is sent");
    } else if (this.#outboundTotal > this.#limits.outboundBytesTotal) {
      // Everyone gets less: this one comes back later.
      connection.close(SYNC_CLOSE.unavailable, "too much to send");
    }
  }

  forget(connection: Connection): void {
    if (connection.held > 0) this.inbound(connection, -connection.held);
    connection.held = 0;
    clearTimeout(connection.partsTimer);
    this.#outboundTotal -= connection.outbox.bytes;
    connection.outbox.clear();
    connection.isClosed = true;
    this.#connections.delete(connection);
    const project = connection.project;
    if (project) {
      project.connections.delete(connection);
      // Open until now, however long ago it was opened: what the copy is kept by, see `release`.
      if (!connection.readOnly && connection.isReady) void this.#noteOpened(project);
      this.#unloadSoon(project);
    }
  }

  /**
   * Notes the projects windows are connected to here as opened now, at most once an hour each, as
   * the sweep does before it lets go of copies nobody opened for long (sync/sweep.ts): a window
   * that stays for days keeps its project opened, also where the process stops before it goes.
   */
  async noteConnected(): Promise<void> {
    for (const project of this.#projects.values()) {
      const editing = [...project.connections].some(
        (connection) => !connection.readOnly && connection.isReady && !connection.isClosed,
      );
      if (editing) await this.#noteOpened(project);
    }
  }

  /** A project nobody is connected to goes from memory after a while. */
  #unloadSoon(project: Project): void {
    if (project.connections.size > 0) return;
    clearTimeout(project.unloadTimer);
    project.unloadTimer = setTimeout(() => {
      if (project.connections.size > 0 || this.#projects.get(project.id) !== project) return;
      // Something is on its way for it, such as a hello: it is asked again once that is done.
      if (this.#queues.has(project.id)) {
        void this.#run(project.id, async () => this.#unloadSoon(project));
        return;
      }
      this.#projects.delete(project.id);
      void this.#copies.drop(project.id);
    }, this.#limits.idleMs);
    project.unloadTimer.unref?.();
  }

  /** Counts what a connection sends, as it arrives. False, and it closes, when that is too much. */
  counts(connection: Connection, bytes: number): boolean {
    const now = this.#now().getTime();
    if (now - connection.windowStart >= 60_000) {
      connection.windowStart = now;
      connection.messages = 0;
      connection.bytes = 0;
    }
    connection.messages += 1;
    connection.bytes += bytes;
    const limits = this.#limits;
    const isFlood =
      connection.messages > 2 * limits.messagesPerMinute ||
      connection.bytes > 2 * limits.bytesPerMinute ||
      connection.queuedMessages >= limits.queuedMessages ||
      connection.queuedBytes + bytes > limits.queuedBytes ||
      (this.#inboundOf.get(connection.who.userId) ?? 0) + bytes > limits.queuedBytesPerUser;
    if (isFlood) {
      connection.close(SYNC_CLOSE.tooMany, "too much");
      return false;
    }
    if (this.#inboundTotal + bytes > limits.queuedBytesTotal) {
      // Everyone sends more than the platform takes in at once: this one comes back later.
      connection.close(SYNC_CLOSE.unavailable, "too much at once");
      return false;
    }
    return true;
  }

  /** Whether a connection sends more than it may for now: its changes wait, see "busy". */
  #isBusy(connection: Connection): boolean {
    return (
      connection.messages > this.#limits.messagesPerMinute ||
      connection.bytes > this.#limits.bytesPerMinute
    );
  }

  /** One frame of a connection, in turn. */
  async handle(connection: Connection, data: Uint8Array): Promise<void> {
    if (connection.isClosed) return;
    const whole = connection.frames.take(data);
    // What it holds of a message in parts counts as what waits to be taken in.
    const held = connection.frames.held;
    this.inbound(connection, held - connection.held);
    connection.held = held;
    clearTimeout(connection.partsTimer);
    if (whole === "more") {
      connection.partsTimer = setTimeout(() => {
        connection.close(SYNC_CLOSE.tooMany, "the rest of a message does not come");
      }, this.#limits.partsMs);
      connection.partsTimer.unref?.();
      return;
    }
    const message = whole && readSyncClientMessage(whole);
    if (!message) {
      connection.close(SYNC_CLOSE.protocol, "not a message of the protocol");
      return;
    }
    try {
      switch (message.t) {
        case "hello":
          if (connection.project || connection.isReady) {
            throw new Closed(SYNC_CLOSE.protocol, "hello twice");
          }
          await this.#run(message.project, () => this.#hello(connection, message));
          return;
        case "push": {
          const project = connection.project;
          if (!project || !connection.isReady)
            throw new Closed(SYNC_CLOSE.protocol, "push before hello");
          await this.#run(project.id, () => this.#push(connection, project, message));
          return;
        }
        case "check": {
          const project = connection.project;
          if (!project || !connection.isReady)
            throw new Closed(SYNC_CLOSE.protocol, "check before hello");
          await this.#run(project.id, () => this.#check(connection, project));
          return;
        }
        case "ping":
          connection.send({ t: "pong" });
          return;
      }
    } catch (error) {
      if (error instanceof Closed) {
        connection.close(error.code, error.message);
        return;
      }
      if (error instanceof CopiesFull) {
        // No room for the project now: the window comes back later, as from a restart.
        this.#log.warn({ own: error.isOwn }, "no room for a working copy");
        connection.close(error.isOwn ? SYNC_CLOSE.tooMany : SYNC_CLOSE.unavailable, error.message);
        return;
      }
      this.#log.error({ err: describeError(error) }, "a sync message failed");
      connection.close(SYNC_CLOSE.unavailable, "something went wrong");
    }
  }

  #run<T>(id: string, task: () => Promise<T>): Promise<T> {
    const before = this.#queues.get(id) ?? Promise.resolve();
    const run = before.then(task, task);
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    this.#queues.set(id, settled);
    void settled.then(() => {
      if (this.#queues.get(id) === settled) this.#queues.delete(id);
    });
    return run;
  }

  /** What the hub knows of a project, from the database where it does not know it yet. */
  async #project(id: string): Promise<Project | undefined> {
    const known = this.#projects.get(id);
    if (known) return known;
    const [row] = await this.#db.select().from(projects).where(eq(projects.id, id));
    if (!row) return undefined;
    // A working copy that is not here: nothing of it is read, and the hub does not know the project.
    if (row.copyState !== "live") throw new NotLive(row.ownerId, row.copyState === "restoring");
    const [snapshot] = await this.#db
      .select({ seq: projectSnapshots.seq })
      .from(projectSnapshots)
      .where(and(eq(projectSnapshots.projectId, id), eq(projectSnapshots.reason, "compact")))
      .orderBy(desc(projectSnapshots.seq))
      .limit(1);
    const after = snapshot?.seq ?? 0;
    const [since] = await this.#db
      .select({
        updates: count(),
        bytes: sum(sql`octet_length(${projectUpdates.data})`).mapWith(Number),
      })
      .from(projectUpdates)
      .where(and(eq(projectUpdates.projectId, id), gt(projectUpdates.seq, after)));
    const [first] = await this.#db
      .select({ oldest: min(projectUpdates.seq) })
      .from(projectUpdates)
      .where(eq(projectUpdates.projectId, id));
    const project = new Project({
      id,
      ownerId: row.ownerId,
      projectId: row.projectId,
      head: row.head,
      digest: row.digest,
      oldest: first?.oldest ?? row.head + 1,
      updatesSince: since?.updates ?? 0,
      bytesSince: since?.bytes ?? 0,
      bytes: row.bytes,
      name: row.name,
      description: row.description,
      generation: row.generation,
      openedAt: row.openedAt?.getTime() ?? 0,
      unusable: (await unusableOf(this.#db, id))?.reason,
    });
    this.#projects.set(id, project);
    this.#unloadSoon(project);
    return project;
  }

  /** The policy of access the hub goes by, which the routes have to go by too (app.ts). */
  get access(): AccessPolicy {
    return this.#access;
  }

  /** Whether the connection's person may read the project, or edit it, as the window would. */
  #may(connection: Connection, project: { readonly id: string; readonly ownerId: string }) {
    return this.#access.may(
      this.#db,
      connection.who.userId,
      project,
      connection.readOnly ? "read" : "edit",
    );
  }

  /**
   * A project for a connection that says hello for it. One whose working copy is not here closes
   * the connection, for anyone else as any project that is not theirs. For the owner, one the
   * platform let go of is made again from its repository (`wakeCopy`, the worker): come back later
   * ("restoring"), as for one on its way back already; it is another copy by then, which the window
   * hears when it does (`rebuilt`). One that cannot be made again (no repository, or one that
   * cannot be used) closes as it always did: reload, or why it cannot be edited. A window that only
   * reads it is no reason to make it: it hears that there is nothing of it here to read.
   */
  async #projectFor(connection: Connection, id: string): Promise<Project | undefined> {
    try {
      return await this.#project(id);
    } catch (error) {
      if (!(error instanceof NotLive)) throw error;
      if (!(await this.#may(connection, { id, ownerId: error.ownerId })))
        throw new Closed(SYNC_CLOSE.missing, "no such project");
      if (connection.readOnly && !error.isComing) throw new Closed(SYNC_CLOSE.unusable, "released");
      if (connection.readOnly) throw new Closed(SYNC_CLOSE.unavailable, "restoring");
      throw await this.#wake(connection, id, error.isComing);
    }
  }

  /**
   * Asks for the working copy of a project of the connection's person to be made again, see
   * `wakeCopy`, and says how the connection closes meanwhile.
   */
  async #wake(connection: Connection, id: string, isComing: boolean): Promise<Closed> {
    const rebuild = this.#rebuild;
    if (!rebuild) return new Closed(SYNC_CLOSE.unavailable, isComing ? "restoring" : "released");
    const woke = await wakeCopy(
      this.#db,
      id,
      { userId: connection.who.userId, access: this.#access },
      this.#now(),
    );
    switch (woke.copy) {
      case "missing":
        return new Closed(SYNC_CLOSE.missing, "no such project");
      case "live":
        // Here by now, as it was made a moment ago: the window comes again for it.
        return new Closed(SYNC_CLOSE.unavailable, "restored");
      case "restoring":
        await rebuild(id).catch((error: unknown) => {
          this.#log.warn({ err: describeError(error), project: id }, "no rebuild queued");
        });
        return new Closed(SYNC_CLOSE.unavailable, "restoring");
      case "released":
        if (woke.why === "later") return new Closed(SYNC_CLOSE.unavailable, "released");
        if (woke.why === "unusable") {
          const reason = (await unusableOf(this.#db, id))?.reason ?? "gone";
          return new Closed(SYNC_CLOSE.unusable, reason);
        }
        return new Closed(SYNC_CLOSE.outdated, "released");
    }
  }

  /** Puts a project into memory, from its last snapshot and the updates after it. */
  async #ensureOpen(project: Project): Promise<void> {
    if (this.#copies.isOpen(project.id)) return;
    const [snapshot] = await this.#db
      .select({ seq: projectSnapshots.seq, state: projectSnapshots.state })
      .from(projectSnapshots)
      .where(
        and(eq(projectSnapshots.projectId, project.id), eq(projectSnapshots.reason, "compact")),
      )
      .orderBy(desc(projectSnapshots.seq))
      .limit(1);
    const after = snapshot?.seq ?? 0;
    const rows = await this.#db
      .select({ seq: projectUpdates.seq, data: projectUpdates.data })
      .from(projectUpdates)
      .where(and(eq(projectUpdates.projectId, project.id), gt(projectUpdates.seq, after)))
      .orderBy(asc(projectUpdates.seq));
    rows.forEach((row, index) => {
      if (row.seq !== after + index + 1) {
        throw new Error(`project ${project.id} misses update ${after + index + 1}`);
      }
    });
    if (after + rows.length !== project.head) {
      throw new Error(`project ${project.id} does not reach its head ${project.head}`);
    }
    const parts = [...(snapshot ? [snapshot.state] : []), ...rows.map((row) => row.data)];
    await this.#copies.open(
      project.id,
      parts,
      project.projectId,
      project.bytes,
      project.ownerId,
      this.#inUse(),
      await this.#batchesOf(project),
    );
  }

  /**
   * The platform's batches of a project whose changes made without them may still come, as the
   * copy keeps them, see late-writes.ts of core: the newest of not so long ago. One that was taken
   * back, or takes one back or does it again, is quiet (`WatchedBatch`): what it took away of a
   * change still counts, as the change is gone all the same. One that cannot be read is left out.
   */
  async #batchesOf(project: Project): Promise<WatchedBatch[]> {
    const id = project.id;
    const since = new Date(this.#now().getTime() - this.#limits.batchesWatchedMs);
    const rows = await this.#db
      .select({
        id: projectBatches.id,
        seq: projectBatches.seq,
        writes: projectBatches.writes,
        kind: projectBatches.kind,
        undoes: projectBatches.undoes,
      })
      .from(projectBatches)
      .where(and(eq(projectBatches.projectId, id), gt(projectBatches.createdAt, since)))
      .orderBy(desc(projectBatches.seq))
      .limit(this.#limits.batchesWatched);
    // Taken back at some time: also those taken back by a batch that is not among these any more.
    const taken = new Set(
      (
        await this.#db
          .selectDistinct({ undoes: projectBatches.undoes })
          .from(projectBatches)
          .where(and(eq(projectBatches.projectId, id), isNotNull(projectBatches.undoes)))
      ).map(({ undoes }) => undoes),
    );
    const batches: WatchedBatch[] = [];
    for (const row of rows) {
      const batch = batchFromRow(row);
      if (!batch) {
        this.#log.warn({ project: id, batch: row.id }, "a batch of the platform does not read");
        continue;
      }
      // Doing one again ("redo") writes GitHub's side once more: what goes of that is said.
      const quiet = row.kind === "undo" || taken.has(row.id);
      batches.push(quiet ? { ...batch, quiet } : batch);
    }
    project.watched = batches
      .map(({ batch, seq }) => ({ id: batch, seq }))
      .toSorted((a, b) => a.seq - b.seq);
    // The newest one older than those, or not read: what changes made without it took away cannot
    // be told any more.
    const [older] = await this.#db
      .select({ id: projectBatches.id, seq: projectBatches.seq })
      .from(projectBatches)
      .where(
        and(
          eq(projectBatches.projectId, id),
          project.watched.length === 0
            ? undefined
            : notInArray(
                projectBatches.id,
                project.watched.map((each) => each.id),
              ),
        ),
      )
      .orderBy(desc(projectBatches.seq))
      .limit(1);
    project.unwatched = older;
    return batches;
  }

  /**
   * Projects that something is being done with now, which the copies keep. A copy that windows are
   * connected to, but that nothing is done with, can go: it comes back from the database when it is
   * needed again.
   */
  #inUse(): ReadonlySet<string> {
    return new Set<string>(this.#queues.keys());
  }

  /** The digest the platform has for `seq`, or undefined where it does not keep one any more. */
  async #digestAt(project: Project, seq: number): Promise<string | undefined> {
    if (seq === 0) return "";
    if (seq === project.head) return project.digest;
    if (seq > project.head) return undefined;
    const [row] = await this.#db
      .select({ digest: projectUpdates.digest })
      .from(projectUpdates)
      .where(and(eq(projectUpdates.projectId, project.id), eq(projectUpdates.seq, seq)));
    if (row) return row.digest;
    const [snapshot] = await this.#db
      .select({ digest: projectSnapshots.digest })
      .from(projectSnapshots)
      .where(and(eq(projectSnapshots.projectId, project.id), eq(projectSnapshots.seq, seq)))
      .limit(1);
    return snapshot?.digest;
  }

  async #hello(
    connection: Connection,
    message: Extract<SyncClientMessage, { t: "hello" }>,
  ): Promise<void> {
    if (message.v !== SYNC_PROTOCOL) throw new Closed(SYNC_CLOSE.outdated, "another protocol");
    // Too old a page: it reloads, and sends what it has then.
    if (this.#oldestEditor !== undefined && !editorAtLeast(message.editor, this.#oldestEditor))
      throw new Closed(SYNC_CLOSE.outdated, "an older editor");
    /** Which working copy the window says it has, where it says. */
    const { generation } = message;
    connection.device = message.device;
    connection.window = message.window;
    connection.editor = message.editor;
    // Only reading what is there: nothing is made for it.
    if (message.readOnly === true && message.create)
      throw new Closed(SYNC_CLOSE.protocol, "a window that only reads makes nothing");
    // The copy as it began is only read.
    if (message.base === true && message.readOnly !== true)
      throw new Closed(SYNC_CLOSE.protocol, "only a window that only reads asks for the base");
    connection.readOnly = message.readOnly === true;
    let project = await this.#projectFor(connection, message.project);
    // A project the person may not read, or edit as the window would, is not even read.
    if (project && !(await this.#may(connection, project))) {
      throw new Closed(SYNC_CLOSE.missing, "no such project");
    }
    let created = false;
    try {
      if (!project && message.create) {
        project = await this.#create(connection, message);
        created = project !== undefined;
        // Made by someone else at the same moment, as a window and its reload can.
        project ??= await this.#projectFor(connection, message.project);
      }
      // Not there: perhaps deleted, which the window hears where it was the person's.
      if (!project) throw await this.#notThere(connection, message.project);
      if (!created && !(await this.#may(connection, project))) {
        throw new Closed(SYNC_CLOSE.missing, "no such project");
      }
      if (connection.isClosed) return;
      // What the window has is of another working copy than this one: two documents, which put
      // together would take away changes of either at random. Only a window that says which one it
      // has: one that says none has nothing of the project yet, or is from before they were told
      // apart, when every project had its first.
      if (generation !== undefined && generation !== project.generation) {
        throw new Closed(SYNC_CLOSE.rebuilt, "another working copy of the project");
      }
      // A window from before copies were told apart, that has some of the project: of the first
      // copy, which this is not. What it has would be taken for this one's, so it reloads.
      if (generation === undefined && message.after > 0 && project.generation > 1) {
        throw new Closed(SYNC_CLOSE.outdated, "another working copy of the project");
      }
      if (message.base === true) {
        await this.#sendBase(connection, project);
        return;
      }
      // Whether its repository can be used, as the database says it now: one that cannot is not
      // opened for editing. A window that only reads it is welcome all the same.
      const link = created ? undefined : await this.#linkOf(project.id);
      project.unusable = link?.unusable;
      // Somebody wants it: GitHub is asked again soon whether it can be used by now.
      const id = project.id;
      if (!connection.readOnly && project.unusable !== undefined)
        await recheckSoon(this.#db, [id], this.#now()).catch((error: unknown) => {
          this.#log.warn({ err: describeError(error), project: id }, "no check soon");
        });
      if (!connection.readOnly && project.unusable !== undefined)
        throw new Closed(SYNC_CLOSE.unusable, project.unusable);
      const known = message.after > 0 ? await this.#digestAt(project, message.after) : "";
      const reset =
        message.after > project.head ||
        (known !== undefined && message.digest !== undefined && message.digest !== known);
      const after = reset ? 0 : created ? project.head : message.after;
      // With which working copy this is, which an editor from before copies were told apart does
      // not read.
      connection.send({
        t: "welcome",
        head: project.head,
        digest: project.digest,
        reset,
        generation: project.generation,
      });
      await this.#catchUp(connection, project, after);
      connection.send({ t: "synced", head: project.head, digest: project.digest });
      if (connection.isClosed) return;
      connection.project = project;
      connection.isReady = true;
      project.connections.add(connection);
      clearTimeout(project.unloadTimer);
      // Reading it is not opening it.
      if (connection.readOnly) return;
      await this.#noteOpened(project);
      if (link?.stale) this.#lookAgainAt(project);
    } finally {
      if (project && !project.connections.has(connection)) this.#unloadSoon(project);
    }
  }

  /**
   * The working copy as it began, for a window that asks for it (`base` of "hello"): "welcome" for
   * that version, it whole, and "synced". Nothing more comes on the connection, which the window
   * closes once it has that. A copy that was not made again from its repository has none.
   */
  async #sendBase(connection: Connection, project: Project): Promise<void> {
    const [base] = await this.#db
      .select({
        seq: projectSnapshots.seq,
        digest: projectSnapshots.digest,
        state: projectSnapshots.state,
      })
      .from(projectSnapshots)
      .where(and(eq(projectSnapshots.projectId, project.id), eq(projectSnapshots.reason, "base")))
      .orderBy(desc(projectSnapshots.seq))
      .limit(1);
    if (!base) throw new Closed(SYNC_CLOSE.missing, "the copy has no base");
    connection.send({
      t: "welcome",
      head: base.seq,
      digest: base.digest,
      reset: false,
      generation: project.generation,
    });
    connection.send({
      t: "update",
      seq: base.seq,
      digest: base.digest,
      kind: "snapshot",
      at: this.#now().getTime(),
      payload: base.state,
    });
    connection.send({ t: "synced", head: base.seq, digest: base.digest });
  }

  /**
   * Notes that a window connected to a project (`opened_at`), at most once an hour for each: what
   * says whether anyone opened it lately, where `updated_at` only says when it last changed. A
   * note that cannot be written is tried again with the next window.
   */
  async #noteOpened(project: Project): Promise<void> {
    const now = this.#now();
    if (now.getTime() - project.openedAt < OPENED_EVERY_MS) return;
    try {
      await this.#db.update(projects).set({ openedAt: now }).where(eq(projects.id, project.id));
      project.openedAt = now.getTime();
    } catch (error) {
      this.#log.warn(
        { err: describeError(error), project: project.id },
        "when the project was opened is not noted",
      );
    }
  }

  /**
   * What the hub needs of the link of a project to its repository, from the database: why it
   * cannot be used, if so, and whether it is due to be looked at again, see `LOOK_AGAIN_MS`.
   */
  async #linkOf(
    id: string,
  ): Promise<{ readonly unusable: string | undefined; readonly stale: boolean } | undefined> {
    const [row] = await this.#db
      .select({
        state: projectRepos.state,
        pauseReason: projectRepos.pauseReason,
        unusableSince: projectRepos.unusableSince,
        checkedAt: projectRepos.checkedAt,
        nextAttemptAt: projectRepos.nextAttemptAt,
        prefer: projectRepos.prefer,
      })
      .from(projectRepos)
      .where(eq(projectRepos.projectId, id));
    if (!row) return undefined;
    const known = this.#projects.get(id);
    if (known) known.prefer = row.prefer;
    const now = this.#now().getTime();
    return {
      unusable: unusableReasonOf(row),
      // A link whose archives go as they should, that nobody looked at for a while, and that does
      // not wait to be tried again after failing: an archive that waits looks soon enough.
      stale:
        row.state === "ready" &&
        (row.checkedAt === null || now - row.checkedAt.getTime() >= LOOK_AGAIN_MS) &&
        (row.nextAttemptAt === null || row.nextAttemptAt.getTime() <= now),
    };
  }

  /** Has the repository of a project looked at again, at most once in `LOOK_AGAIN_MS` from here. */
  #lookAgainAt(project: Project): void {
    const lookAgain = this.#lookAgain;
    const now = this.#now().getTime();
    if (!lookAgain || now - project.lookedAt < LOOK_AGAIN_MS) return;
    project.lookedAt = now;
    void lookAgain(project.id).catch((error: unknown) => {
      this.#log.warn(
        { err: describeError(error), project: project.id },
        "the repository will not be looked at again",
      );
    });
  }

  /**
   * The link of a project to its repository changed (sync/link-listener.ts): whether it can be used
   * is read again, and where it cannot, every window that edits it closes, in the project's turn,
   * so after what it took in before and before anything that comes after. Windows that only read
   * it stay. Nothing to do for a project the hub does not hold: a window that says hello for it
   * reads the link then.
   */
  linkChanged(id: string): Promise<void> {
    if (!this.#projects.has(id)) return Promise.resolve();
    return this.#run(id, async () => {
      const project = this.#projects.get(id);
      if (!project) return;
      project.unusable = (await unusableOf(this.#db, id))?.reason;
      // Which side merges keep first, as people may have changed it (`RepositoryService.setPrefer`):
      // what comes late goes by it from now on.
      const [link] = await this.#db
        .select({ prefer: projectRepos.prefer })
        .from(projectRepos)
        .where(eq(projectRepos.projectId, id));
      if (link) project.prefer = link.prefer;
      const unusable = project.unusable;
      if (unusable === undefined) return;
      let closed = 0;
      for (const connection of Array.from(project.connections)) {
        if (connection.readOnly) continue;
        connection.close(SYNC_CLOSE.unusable, unusable);
        closed += 1;
      }
      if (closed > 0)
        this.#log.info(
          { project: id, reason: unusable, connections: closed },
          "a project cannot be edited: its repository cannot be used",
        );
    });
  }

  /**
   * What the hub holds may have missed changes of links, as while it did not hear the database:
   * every project it holds is read again.
   */
  async linksChanged(): Promise<void> {
    for (const id of Array.from(this.#projects.keys())) await this.linkChanged(id);
  }

  /**
   * Takes a project of `userId` away for good: its row, and with it everything that points at it
   * (its updates and snapshots, its link to a repository and the archives that went there, its
   * cover, uploads and tasks of it). Only the person's own ("missing" for any other, as for one that
   * is not there). The repository stays as it is, with everything that was archived into it.
   *
   * One whose repository cannot be used (`unusable_since`, see archive/links.ts) goes where people
   * ask without saying more, and as the platform takes it away (`unusableBefore`): nothing is looked
   * at, as nothing can be archived, and nothing of it can reach the large file storage either. Its
   * windows hear that it was deleted as for any other.
   *
   * One that is saved to a repository goes only as people said (`condition`): where the repository
   * has the project up to its head, which is the update the editor saw archived (`archived`), and
   * no change waits to be archived; otherwise it stays ("notArchived", with the head and how far
   * archiving got). Or whatever the repository has, as people let the rest go (`discard`). Without
   * either it stays ("hasRepository"), as for an editor from before this. One that is saved to none
   * goes whatever is asked.
   *
   * It takes its turn among what happens to the project, so nothing of it is being taken in
   * meanwhile, and a window that says hello for it while it goes waits, and finds it gone. Its rows
   * are locked before anything is looked at, the link to its repository first, as an archive locks
   * them: a change that another process takes, an archive that lands, a repository linked or
   * switched, each either came before, and is seen, or comes after, and finds no project. So
   * nothing comes between what is looked at and taking the project away. Once the rows are gone for
   * good, and still in the project's turn, its connections close, saying that it was deleted, and
   * its working copy goes: no window is left believing it is in step with a project that is gone,
   * and none gets a copy of it afterwards. Where taking the rows away fails, also as late as when
   * the transaction ends, nothing was closed, and the project is as it was.
   *
   * The id is kept, in the same transaction (`deleted_projects`): nothing is made under it for a
   * week (`deletedKeptMs`), see `#create`, which holds the id as this does, so that a project is
   * never made between this looking for it and noting that it is gone. Also the id of a project
   * that is not there: the editor asks to take away what it gave up connecting, and its request to
   * make the project can still be on its way then, in parts or whole. Such an id is noted as
   * whoever asked's, only where no project has it (someone else's project is theirs to keep), and
   * only so many of them a day for a person (`notedIdsPerDay`), so that nobody fills the table with
   * ids that never were.
   */
  remove(id: string, userId: string, condition: RemoveCondition = {}): Promise<RemoveOutcome> {
    // What could not name a project is none, and nothing is noted of it.
    if (!PLATFORM_ID.test(id)) return Promise.resolve("missing");
    return this.#run(id, async () => {
      let gone:
        | {
            head: number;
            bytes: number;
            repository: boolean;
            discarded: boolean;
            unusable: boolean;
          }
        | undefined;
      let tooMany = false;
      // Each statement sees what is committed by the time it runs, which is what makes the locks
      // count: what is looked at is looked at after the wait for the rows, not as things were
      // before. A repository linked and archived into while this waited for the project's row can
      // still make the two wait for each other: the database lets one of them go, and where that
      // is this, it looks again from the start, nothing of it done.
      const outcome = await retryOnDeadlock(() =>
        this.#db.transaction(async (tx): Promise<RemoveOutcome> => {
          gone = undefined;
          tooMany = false;
          await lockProject(tx, id);
          // The link first, then the project, in the order an archive that lands takes them: the
          // other way round, each would wait for the other.
          await tx
            .select({ repoId: projectRepos.repoId })
            .from(projectRepos)
            .where(eq(projectRepos.projectId, id))
            .for("update");
          const [row] = await tx
            .select({
              ownerId: projects.ownerId,
              head: projects.head,
              bytes: projects.bytes,
              dirtySince: projects.dirtySince,
              linkingUntil: projects.linkingUntil,
              openedAt: projects.openedAt,
              updatedAt: projects.updatedAt,
              createdAt: projects.createdAt,
            })
            .from(projects)
            .where(eq(projects.id, id))
            .for("update");
          if (!row) {
            // Not there, and perhaps on its way: noted, so that nothing makes it after this. A note
            // of it that is too old to count is noted again, from now.
            if (await wasDeleted(tx, id, this.#keptSince())) return "missing";
            if (await this.#notesMany(tx, userId)) tooMany = true;
            else await this.#note(tx, id, userId);
            return "missing";
          }
          if (!(await this.#access.may(tx, userId, { id, ownerId: row.ownerId }, "manage")))
            return "missing";
          // Again, now that nothing changes the project: a repository linked while this waited for
          // its row is there to see now, and is held as well.
          const [link] = await tx
            .select({
              repoId: projectRepos.repoId,
              archivedSeq: projectRepos.archivedSeq,
              state: projectRepos.state,
              pauseReason: projectRepos.pauseReason,
              requestedAt: projectRepos.requestedAt,
              failures: projectRepos.failures,
              unusableSince: projectRepos.unusableSince,
            })
            .from(projectRepos)
            .where(eq(projectRepos.projectId, id))
            .limit(1)
            .for("update");
          const { unusableBefore } = condition;
          // A repository is being linked to it: it has one, as far as anyone is to know, and the
          // repository GitHub may be making for it is not left there for nobody.
          if (row.linkingUntil !== null && row.linkingUntil > this.#now()) return "hasRepository";
          const unusable =
            link?.unusableSince != null &&
            (unusableBefore === undefined
              ? condition.archived === undefined && condition.discard === undefined
              : link.unusableSince <= unusableBefore);
          // Taken away for its repository, which can be used by now, or not long enough ago.
          if (unusableBefore !== undefined && !unusable) return "hasRepository";
          const discard = link !== undefined && condition.discard === true;
          if (link && !discard && !unusable && condition.archived === undefined)
            return "hasRepository";
          // Files on their way into the large file storage are nowhere else but where they came
          // from: they go only where people let them go. None begins meanwhile, as an upload is of a
          // project whose row this holds.
          if (condition.discard !== true && !unusable) {
            const [open] = await tx
              .select({ uploads: count() })
              .from(lfsUploads)
              .where(
                and(eq(lfsUploads.projectId, id), inArray(lfsUploads.state, [...OPEN_LFS_STATES])),
              );
            if ((open?.uploads ?? 0) > 0) return { kind: "uploading", uploads: open!.uploads };
          }
          if (link && !discard && !unusable) {
            // What the platform last noted of the repository holds only while archiving goes as it
            // should: a repository that is gone, or that an archive people asked for has not looked
            // at yet, may have nothing of it.
            const state = link.state === "paused" ? "paused" : "ready";
            const archived =
              state === "ready" &&
              link.requestedAt === null &&
              link.failures === 0 &&
              link.archivedSeq === row.head &&
              row.head === condition.archived &&
              row.dirtySince === null;
            if (!archived)
              return {
                kind: "notArchived",
                head: row.head,
                archivedSeq: link.archivedSeq,
                state,
                ...(state === "paused" &&
                  link.pauseReason !== null && { reason: link.pauseReason }),
                archiving: link.requestedAt !== null,
                ...(link.failures > 0 && { failures: link.failures }),
              };
          }
          // Its id, and whose it was: nothing is made under it for a while.
          await this.#note(tx, id, row.ownerId);
          await tx.delete(projects).where(eq(projects.id, id));
          await notifyPerson(tx, [row.ownerId]);
          gone = {
            head: row.head,
            bytes: row.bytes,
            repository: link !== undefined,
            discarded: discard,
            unusable,
          };
          return "removed";
        }, READ_COMMITTED),
      );
      // Who asked for more than a person does: not what they asked for.
      if (tooMany) this.#log.warn({ user: userId }, "too many ids noted as deleted in a day");
      if (gone) {
        // Gone for good: only now do the windows hear that the project was deleted, and the
        // working copy goes. Nothing of the project was taken in since, as this is still its turn.
        const connections = await this.#letGo(id, () => ({
          code: SYNC_CLOSE.deleted,
          reason: "the project was deleted",
        }));
        this.#blewUp.delete(id);
        this.#blewUp.delete(`create:${id}`);
        // Who took what away, and how much of it there was: nothing of what was in it.
        this.#log.info(
          { project: id, user: userId, ...gone, connections },
          "a project was deleted",
        );
      }
      return outcome;
    });
  }

  /**
   * Lets go of the working copy of a project: its updates and snapshots go, and `projects` keeps
   * where the copy was (`released_from`), as "released"; its row, its link to the repository and
   * its archives stay, and so does the list. The worker makes it again from the repository once it
   * is asked for (archive/rebuild.ts), as the next copy. Only where nothing is lost that is not
   * lost anyway, and nothing is going on with it:
   *
   * - no window is connected to it, also one that only reads (`connected`), and it is "live";
   * - it is saved to a repository that can be used (`noRepository`, `unusable`): one that cannot be
   *   used goes as a whole after its week, see sync/sweep.ts;
   * - no archive of it runs, no repository is being linked to it, and no AI task of it is going on
   *   (`busy`);
   * - changes do not wait that only GitHub or the platform keep from being archived, or that are
   *   not tried yet (`transient`: those are never let go of);
   * - and the repository has everything of it: archiving goes as it should, up to the head, no
   *   change waits, nothing people asked for waits (`notArchived`). With `unarchived`, people (an
   *   admin) said to let go of what it does not have: the devices that made those changes still
   *   have them.
   *
   * It takes the project's turn, so no window says hello for it meanwhile, and holds the project's
   * id and the lock of its archives until it is done: an archive that would land, a link that
   * would change, a window of another process, each comes before, and is seen, or after, and finds
   * it let go of.
   *
   * Nor while what it is cannot be told (`busy`): an archive found the repository not there a
   * moment ago, and looks again in a few minutes (`unusable_seen_at`); a merge from GitHub waits to
   * go into the copy; or files people chose to take out wait for theirs. What was merged from GitHub
   * into the copy and not archived goes with it: the next copy is what the platform archived, and
   * GitHub's changes come into it again from there, so `merged_sha` and the files a merge could not
   * take go, as do the pauses that only waited for those, and conflicts that are of the copy that
   * goes (stale: what they were about is not in the next one). Otherwise the next archive would go
   * on from GitHub's commit with a copy without its changes, which takes them back out.
   */
  release(
    id: string,
    options: {
      readonly unarchived?: boolean;
      /** Runs in the transaction that lets go of it, as noting who did it: one is never without the other. */
      readonly onReleased?: (tx: Tx, from: ReleasedFrom) => Promise<void>;
    } = {},
  ): Promise<ReleaseOutcome> {
    if (!PLATFORM_ID.test(id)) return Promise.resolve({ kind: "missing" });
    return this.#run(id, async (): Promise<ReleaseOutcome> => {
      const held = this.#projects.get(id);
      if (held && held.connections.size > 0) return { kind: "connected" };
      const outcome = await retryOnDeadlock(() =>
        this.#db.transaction(async (tx): Promise<ReleaseOutcome> => {
          await lockProject(tx, id);
          const [free] = (
            await tx.execute<{ held: boolean }>(
              sql`select pg_try_advisory_xact_lock(${ARCHIVE_LOCK}, hashtext(${id})) as held`,
            )
          ).rows;
          if (free?.held !== true) return { kind: "busy" };
          const [link] = await tx
            .select()
            .from(projectRepos)
            .where(eq(projectRepos.projectId, id))
            .for("update");
          const [row] = await tx.select().from(projects).where(eq(projects.id, id)).for("update");
          if (!row) return { kind: "missing" };
          if (row.copyState !== "live") return { kind: "notLive" };
          if (!link) return { kind: "noRepository" };
          if (link.unusableSince !== null) return { kind: "unusable" };
          // What it is cannot be told now: in a few minutes, or once the merge or the files went.
          if (link.unusableSeenAt !== null || link.dropping !== null || link.droppingMerge !== null)
            return { kind: "busy" };
          const [merging] = await tx
            .select({ count: count() })
            .from(repoMerges)
            .where(and(eq(repoMerges.projectId, id), eq(repoMerges.state, "ready")));
          if ((merging?.count ?? 0) > 0) return { kind: "busy" };
          if (
            (row.linkingUntil !== null && row.linkingUntil > this.#now()) ||
            link.pendingSha !== null
          )
            return { kind: "busy" };
          // Something else that may change it yet, as an AI task of it that has not ended.
          if (await this.#holds.busy(tx, id)) return { kind: "busy" };
          const waiting = row.dirtySince !== null || link.archivedSeq < row.head;
          // Changes that wait for GitHub or the platform, or for their first try: never let go of.
          if (
            waiting &&
            link.state === "ready" &&
            (link.transientSince !== null || link.failures === 0)
          )
            return { kind: "transient" };
          const archived =
            link.state === "ready" &&
            !waiting &&
            link.requestedAt === null &&
            link.failures === 0 &&
            link.headSha !== null;
          if (!archived && options.unarchived !== true)
            return {
              kind: "notArchived",
              head: row.head,
              archivedSeq: link.archivedSeq,
              state: link.state,
              ...(link.pauseReason !== null && { reason: link.pauseReason }),
            };
          // Never archived at all: there is nothing to make it again from.
          if (link.headSha === null)
            return {
              kind: "notArchived",
              head: row.head,
              archivedSeq: link.archivedSeq,
              state: link.state,
            };
          const from: ReleasedFrom = {
            generation: row.generation,
            head: row.head,
            archivedSeq: link.archivedSeq,
            headSha: link.headSha,
          };
          await tx.delete(projectUpdates).where(eq(projectUpdates.projectId, id));
          await tx.delete(projectSnapshots).where(eq(projectSnapshots.projectId, id));
          await tx
            .update(projects)
            .set({
              copyState: "released",
              releasedAt: this.#now(),
              releasedFrom: from,
              copyProblem: null,
              bytes: 0,
              // What was not archived is nowhere here any more: nothing waits to be archived.
              dirtySince: null,
            })
            .where(eq(projects.id, id));
          // What was merged from GitHub is merged again into the next copy, see above.
          const waitedForMerges =
            link.state === "paused" &&
            link.pauseReason !== null &&
            LOOKED_WHILE_PAUSED.includes(link.pauseReason);
          await tx
            .update(projectRepos)
            .set({
              requestedAt: null,
              requestedBy: null,
              unusableSeenAt: null,
              mergedSha: null,
              blocked: [],
              ...(waitedForMerges && {
                state: "ready",
                pauseReason: null,
                detail: null,
                pausedAt: null,
                pausedSeq: null,
                diverged: null,
              }),
            })
            .where(eq(projectRepos.projectId, id));
          await tx
            .update(repoConflicts)
            .set({ state: "stale", change: null })
            .where(and(eq(repoConflicts.projectId, id), eq(repoConflicts.state, "open")));
          // ...and so are the merges that went into the copy and not into an archive since: an
          // archive that found one there would take it for in, and go on from its commit, which
          // the next copy does not have. Those an archive has stay, as `#takeOutDropped` of the
          // archiver reads them.
          await tx
            .update(repoMerges)
            .set({ state: "superseded" })
            .where(
              and(
                eq(repoMerges.projectId, id),
                eq(repoMerges.state, "applied"),
                link.archivedAt === null ? undefined : gt(repoMerges.appliedAt, link.archivedAt),
              ),
            );
          await options.onReleased?.(tx, from);
          return { kind: "released", from };
        }, READ_COMMITTED),
      );
      if (outcome.kind === "released") {
        await this.#letGo(id, () => ({ code: SYNC_CLOSE.unavailable, reason: "released" }));
        this.#blewUp.delete(id);
        this.#log.info({ project: id, ...outcome.from }, "a working copy was let go of");
      }
      return outcome;
    });
  }

  /**
   * Merges changes on GitHub into a project, as the worker wrote them down (`repo_merges`,
   * "ready"): in the project's turn, so after whatever came before and before what comes after,
   * also with no window connected (the copy is read from the database for it). The copy merges the
   * files as the platform (copy-worker.ts); what it wrote is checked as a change of an editor is,
   * and goes into the database in one transaction with the merge marked "applied" (only where it is
   * still "ready": once at most), its conflicts, the project as it was right before (a snapshot,
   * "before-repo"), the batch, and the link noting the commit and what did not come in, paused
   * where people have to choose. Only then do windows hear of it, with `by`. Where that transaction
   * fails, the copy goes and comes back from the database, and the merge stays "ready" for the job
   * to try again. Merges of too much are refused, as are merges that took the copies down twice.
   */
  mergeRepo(id: string): Promise<RepoMergeOutcome> {
    if (!UUID.test(id)) return Promise.resolve({ kind: "missing" });
    return (async () => {
      const [row] = await this.#db
        .select({ projectId: repoMerges.projectId })
        .from(repoMerges)
        .where(eq(repoMerges.id, id));
      if (!row) return { kind: "missing" } as const;
      return this.#run(row.projectId, () => this.#mergeRepo(id));
    })();
  }

  async #mergeRepo(id: string): Promise<RepoMergeOutcome> {
    const [merge] = await this.#db.select().from(repoMerges).where(eq(repoMerges.id, id));
    if (!merge) return { kind: "missing" };
    if (merge.state !== "ready") return { kind: "done", state: merge.state };
    let project: Project | undefined;
    try {
      project = await this.#project(merge.projectId);
    } catch (error) {
      if (error instanceof NotLive) return { kind: "later", why: "the working copy is not here" };
      throw error;
    }
    if (!project) return { kind: "missing" };
    const refuse = async (reason: string, detail = ""): Promise<RepoMergeOutcome> => {
      await this.#db
        .update(repoMerges)
        .set({ state: "refused", input: null, result: { refused: reason, detail } })
        .where(and(eq(repoMerges.id, id), eq(repoMerges.state, "ready")));
      this.#log.warn(
        { project: merge.projectId, merge: id, reason, detail },
        "a merge was refused",
      );
      // The archive looks again, finds the merge refused, and pauses saying why (archiver.ts): a
      // refused merge stays so, and a newer push is read again from what was merged before.
      await this.#merged?.(merge.projectId).catch((error: unknown) => {
        this.#log.warn(
          { err: describeError(error), project: merge.projectId },
          "no archive queued",
        );
      });
      return { kind: "refused", reason };
    };
    const [link] = await this.#db
      .select({
        provider: projectRepos.provider,
        repoId: projectRepos.repoId,
        prefer: projectRepos.prefer,
      })
      .from(projectRepos)
      .where(eq(projectRepos.projectId, project.id));
    if (!link || link.provider !== merge.provider || link.repoId !== merge.repoId)
      return refuse("another-repository");
    const unusable = await unusableOf(this.#db, project.id);
    if (unusable) return { kind: "later", why: unusable.reason };
    const changes = readMergeInput(merge.input);
    if (!changes) return refuse("unreadable");
    if (
      changes.length > this.#limits.mergeFiles ||
      mergeBytesOf(changes) > this.#limits.mergeBytes
    ) {
      return refuse("too-large", `${changes.length} files`);
    }
    const oursSeq = project.head;
    await this.#ensureOpen(project);
    const before = await this.#copies.encode(project.id);
    // What people chose to take out of the project is theirs, not a change of GitHub's: it says so,
    // and a batch of its own kind ("drop"), which undoing (2E) refuses, as it would bring back what
    // was taken out on purpose, such as a secret.
    const drops = merge.result?.drops;
    const batchKind = drops !== undefined ? "drop" : "repo";
    const label =
      drops !== undefined
        ? `按你的选择从项目里去掉了 ${drops.length} 个文件`
        : `${merge.provider === "local" ? "本机仓库里的改动" : "GitHub 上的改动"} ${merge.toSha.slice(0, 7)}`;
    let merged: Merged;
    try {
      merged = await this.#copies.merge(project.id, {
        changes,
        batch: id,
        here: hereOf(merge),
        prefer: link.prefer,
        seq: oursSeq + 1,
        watched: this.#limits.batchesWatched,
      });
    } catch (error) {
      if (error instanceof CopiesGone) {
        if (error.running && this.#blewUpTwice(`merge:${id}`, merge.input ?? new Uint8Array()))
          return refuse("too-large", "the working copies went, twice");
        throw error;
      }
      await this.#copies.drop(project.id);
      throw error;
    }
    this.#blewUp.delete(`merge:${id}`);
    if (merged.kind === "refused") return refuse(merged.reason, merged.detail);
    if (merged.ms > this.#limits.mergeSlowMs) {
      this.#log.warn(
        { project: project.id, merge: id, ms: merged.ms, files: changes.length },
        "a merge held up the working copies for long",
      );
    }
    project.prefer = link.prefer;
    const { delta, info } = merged;
    const by: SyncBatch = { batch: id, kind: batchKind, label, files: changes.length };
    let stored: Stored[];
    try {
      if (delta && !(await this.#fits(project, delta.length))) {
        await this.#copies.drop(project.id);
        return refuse("too-large", "the project");
      }
      const at = this.#now();
      const taking = platformChange(delta, { kind: "repo", base: oursSeq, at, by });
      // Each from the commit it goes on from, where it is merged again: the one before GitHub made
      // it what could not be taken in (the worker says, see archiver.ts), or this merge's own.
      const bases = readMergeBases(merge.input);
      const found = merge.result ?? {};
      const blocked: BlockedFile[] = [
        ...merged.blocked.map(({ path, detail, code }) => ({
          path,
          reason: code === "project-locked" ? "locked" : "invalid",
          ...(detail && { detail: detail.slice(0, 500) }),
          baseSha: bases.get(path) ?? merge.fromSha,
        })),
        // What the worker did not read into the merge at all.
        ...(found.unreadable ?? []),
      ];
      const noted = merged.conflicts.map((conflict): NewConflict => ({
        ...conflict,
        batch: id,
        lost: conflict.taken ? "change" : "batch",
        source: "merge",
      }));
      stored = await this.#store(project, taking, info, async (tx, kept) => {
        const seq = kept[0]?.seq;
        const [taken] = await tx
          .update(repoMerges)
          .set({
            state: "applied",
            input: null,
            seq: seq ?? null,
            oursSeq,
            appliedAt: at,
            result: { ...found, files: merged.files, ms: merged.ms },
          })
          .where(and(eq(repoMerges.id, id), eq(repoMerges.state, "ready")))
          .returning({ id: repoMerges.id });
        if (!taken) throw new NotReady();
        if (seq !== undefined) {
          const [snapshot] = await tx
            .insert(projectSnapshots)
            .values({
              projectId: project.id,
              seq: oursSeq,
              digest: project.digest,
              state: Buffer.from(before),
              reason: "before-repo",
              createdAt: at,
            })
            .returning({ id: projectSnapshots.id });
          await this.#pruneBeforeRepo(tx, project.id);
          await tx.insert(projectBatches).values({
            id,
            projectId: project.id,
            kind: batchKind,
            mergeId: id,
            seq,
            label,
            files: changes.length,
            writes: batchRow(merged.batch),
            undo: merged.undo ?? null,
            formatVersion: merged.undo?.doc.formatVersion ?? CURRENT_FORMAT_VERSION,
            snapshotId: snapshot?.id ?? null,
            createdAt: at,
          });
        }
        await this.#noteConflicts(tx, project.id, noted);
        // Taking out what history taken away brought, or what people chose to take out: what is
        // merged from GitHub stays as it was.
        // What people chose to take out is out: the archive may write from now on.
        if (found.drops !== undefined)
          await tx
            .update(projectRepos)
            .set({ dropping: null, droppingMerge: null })
            .where(and(eq(projectRepos.projectId, project.id), eq(projectRepos.droppingMerge, id)));
        if (found.undoes === undefined && found.drops === undefined) {
          await tx
            .update(projectRepos)
            .set({ mergedSha: merge.toSha, blocked })
            .where(eq(projectRepos.projectId, project.id));
        } else if (blocked.length > 0) {
          // Taking out what history taken away on GitHub brought: what is merged from GitHub stays
          // as it was, and what could not be taken out waits with what waited before.
          const [now] = await tx
            .select({ blocked: projectRepos.blocked })
            .from(projectRepos)
            .where(eq(projectRepos.projectId, project.id));
          const paths = new Set(blocked.map(({ path }) => path));
          await tx
            .update(projectRepos)
            .set({
              blocked: [...(now?.blocked ?? []).filter(({ path }) => !paths.has(path)), ...blocked],
            })
            .where(eq(projectRepos.projectId, project.id));
        }
        // Paused while files are blocked or conflicts open; going on where a newer push put right
        // what was blocked before, and nothing else waits.
        await settleMergePause(tx, project.id, at, { merged: true });
      });
    } catch (error) {
      // The copy has the merge, and the database does not.
      await this.#notStored(project, error);
      if (error instanceof NotReady) return { kind: "done", state: "applied" };
      throw error;
    }
    this.#stored(project, stored, { watch: id });
    this.#log.info(
      {
        project: project.id,
        merge: id,
        seq: stored[0]?.seq,
        files: changes.length,
        conflicts: merged.conflicts.length,
        blocked: merged.blocked.length,
        ms: merged.ms,
      },
      "merged changes from GitHub",
    );
    await this.#compactSoon(project);
    const onMerged = this.#merged;
    if (onMerged && stored.length > 0) {
      await onMerged(project.id).catch((error: unknown) => {
        this.#log.warn(
          { err: describeError(error), project: merge.projectId },
          "no archive queued",
        );
      });
    }
    return {
      kind: "applied",
      seq: stored[0]?.seq,
      conflicts: merged.conflicts.length,
      blocked: merged.blocked.length,
    };
  }

  /**
   * What a batch of the platform's own is, and whether `takeBack` could take it back, or do it
   * again, now: as `takeBack` works it out, without writing anything (the copy is read for it). For
   * the project's owner only; others, and batches of other projects, are "missing".
   */
  batchState(projectId: string, userId: string, batch: string): Promise<BatchStateOutcome> {
    return this.#owned(projectId, userId, "read", batch, () => this.#batchState(projectId, batch));
  }

  /**
   * Takes a batch of the platform's own back as a whole, such as a merge from GitHub, or does again
   * what was taken back: `batch` is the batch to take back, which is the merge itself, or the batch
   * that took it back last ("undo") to do it again, or the one that did it again ("redo") to take
   * it back once more. Each of those is a batch of its own, which windows hear of with `by`
   * (`undoes`), and which changes made without it are watched for as a merge's are. It goes by what
   * the batch keeps (`UndoRecord` of core) and the marks of the document now: what anybody changed
   * since stays, and is said (`kept`). In the project's turn, as merges and changes of editors are,
   * so two that ask at once take it back once. Files people chose to take out ("drop") are never
   * brought back: refused. What the batch taken back left open in the list of conflicts is stale
   * from then on. For the project's owner only.
   */
  takeBack(projectId: string, userId: string, batch: string): Promise<TakeBackOutcome> {
    return this.#owned(projectId, userId, "edit", batch, () => this.#takeBack(projectId, batch));
  }

  /**
   * Renames a project, as people do on the start page, without opening it: the same
   * "project.rename" as in the project, run by the platform on the working copy as a batch of its
   * own (`RENAME_BATCH`), in the project's turn, as merges from GitHub are. The windows that have the
   * project hear it with `by`, and the list says the new name; it is archived as any change is, and
   * taken back as a whole as a merge is, see `takeBack`. The change is of the person (kind "user"),
   * written by the platform. For whoever may manage the project (`AccessPolicy`, "manage"): for
   * anyone else it is "missing".
   */
  rename(projectId: string, userId: string, name: string): Promise<RenameOutcome> {
    return this.#owned(projectId, userId, "manage", RENAME_BATCH, () =>
      this.#rename(projectId, name.trim()),
    );
  }

  async #rename(projectId: string, name: string): Promise<RenameOutcome> {
    if (name === "") return { kind: "refused", why: "invalid" };
    let project: Project | undefined;
    try {
      project = await this.#project(projectId);
    } catch (error) {
      if (error instanceof NotLive) return { kind: "refused", why: "released" };
      throw error;
    }
    if (!project) return { kind: "missing" };
    if (project.name === name) return { kind: "unchanged", name };
    if (await unusableOf(this.#db, project.id)) return { kind: "refused", why: "unusable" };
    await this.#ensureOpen(project);
    const batch = randomUUID();
    const base = project.head;
    let done: Executed;
    try {
      done = await this.#copies.execute(project.id, {
        calls: [{ type: "project.rename", params: { name } }],
        batch,
        seq: base + 1,
      });
    } catch (error) {
      await this.#copies.drop(project.id);
      throw error;
    }
    if (done.kind === "refused") {
      if (done.reason === "failed")
        this.#log.warn({ project: project.id, detail: done.detail }, "a rename did not go");
      return { kind: "refused", why: done.reason === "locked" ? "locked" : "failed" };
    }
    if (!done.delta) return { kind: "unchanged", name };
    const label = `在开始页改名为「${name}」`.slice(0, 200);
    const by: SyncBatch = { batch, kind: RENAME_BATCH, label, files: 1 };
    const at = this.#now();
    let stored: Stored[];
    try {
      if (!(await this.#fits(project, done.delta.length))) {
        await this.#copies.drop(project.id);
        return { kind: "refused", why: "failed" };
      }
      const changes = platformChange(done.delta, { kind: "user", base, at, by });
      stored = await this.#store(project, changes, done.info, async (tx, kept) => {
        await tx.insert(projectBatches).values({
          id: batch,
          projectId: project.id,
          kind: RENAME_BATCH,
          undoes: null,
          mergeId: null,
          seq: kept[0]?.seq ?? base,
          label,
          files: 1,
          writes: batchRow(done.batch),
          undo: done.undo ?? null,
          formatVersion: done.undo?.doc.formatVersion ?? CURRENT_FORMAT_VERSION,
          snapshotId: null,
          createdAt: at,
        });
      });
    } catch (error) {
      await this.#notStored(project, error);
      throw error;
    }
    // Not watched: it is what a person asked for, as an editor's change, see copy-worker.ts.
    this.#stored(project, stored);
    this.#log.info({ project: project.id, batch, seq: stored[0]?.seq }, "a project was renamed");
    await this.#compactSoon(project);
    return { kind: "renamed", name, batch, seq: stored[0]?.seq };
  }

  async #owned<T>(
    projectId: string,
    userId: string,
    action: ProjectAction,
    batch: string,
    work: () => Promise<T>,
  ): Promise<T | { readonly kind: "missing" }> {
    if (!PLATFORM_ID.test(projectId) || batch.length === 0 || batch.length > 64)
      return { kind: "missing" };
    const [row] = await this.#db
      .select({ ownerId: projects.ownerId })
      .from(projects)
      .where(eq(projects.id, projectId));
    if (
      !row ||
      !(await this.#access.may(this.#db, userId, { id: projectId, ownerId: row.ownerId }, action))
    )
      return { kind: "missing" };
    return this.#run(projectId, work);
  }

  /**
   * Which batch a request to take `id` back is about (`root`, the one whose record says how), which
   * way, and why not, where that can be told from the database alone.
   */
  async #takingBack(
    projectId: string,
    id: string,
  ): Promise<TakingBack | { readonly kind: "missing" }> {
    const rowOf = async (batch: string) =>
      (
        await this.#db
          .select()
          .from(projectBatches)
          .where(and(eq(projectBatches.id, batch), eq(projectBatches.projectId, projectId)))
      )[0];
    const asked = await rowOf(id);
    if (!asked) return { kind: "missing" };
    const isStep = asked.kind === "undo" || asked.kind === "redo";
    const root = isStep && asked.undoes !== null ? await rowOf(asked.undoes) : asked;
    if (!root) return { kind: "missing" };
    const state: BatchState = {
      id: asked.id,
      kind: asked.kind,
      label: asked.label,
      files: asked.files,
      at: asked.createdAt.getTime(),
      undone: root.undoneAt !== null,
      ...(isStep && { undoes: root.id }),
    };
    const [last] = await this.#db
      .select({ id: projectBatches.id, kind: projectBatches.kind })
      .from(projectBatches)
      .where(and(eq(projectBatches.projectId, projectId), eq(projectBatches.undoes, root.id)))
      .orderBy(desc(projectBatches.seq), desc(projectBatches.createdAt))
      .limit(1);
    // What takes it back, or does it again, from where it is now.
    const direction: "undo" | "redo" = root.undoneAt === null ? "undo" : "redo";
    const next = { batch: direction === "undo" ? root.id : (last?.id ?? root.id), direction };
    const taking: TakingBack = { state: { ...state, next }, root, direction };
    const why = (reason: BatchWhy): TakingBack => ({
      ...taking,
      state: { ...taking.state, why: reason },
    });
    // People's own choice: what they took out stays out, such as a secret.
    if (root.kind === "drop") return why("drop");
    // Only the last step of it goes the other way: an older one, or the batch itself once it was
    // taken back, is done with.
    if (!isStep && root.undoneAt !== null) return why("undone");
    if (isStep && (last?.id !== asked.id || (asked.kind === "undo") !== (root.undoneAt !== null)))
      return why("notLatest");
    if (root.createdAt.getTime() < this.#now().getTime() - this.#limits.batchesWatchedMs)
      return why("age");
    const [newer] = await this.#db
      .select({ count: count() })
      .from(projectBatches)
      .where(
        and(
          eq(projectBatches.projectId, projectId),
          gt(projectBatches.seq, root.seq),
          notInArray(projectBatches.kind, ["undo", "redo"]),
        ),
      );
    if ((newer?.count ?? 0) >= this.#limits.batchesWatched) return why("count");
    if (root.undo === null) return why("gone");
    if (root.formatVersion !== CURRENT_FORMAT_VERSION) return why("format");
    if (root.mergeId !== null) {
      const [merge] = await this.#db
        .select({ state: repoMerges.state, result: repoMerges.result })
        .from(repoMerges)
        .where(eq(repoMerges.id, root.mergeId));
      // What history taken away on GitHub brought, taken out again (`#takeOutDropped` of the
      // archiver): as for files people chose to take out, such as a secret, it stays out.
      if (merge?.result?.undoes !== undefined) return why("history");
      // ...and so does a merge whose history was taken away on GitHub since: the archiver took it
      // out (or found nothing to, as it was taken back), and doing it again would bring it back,
      // where nothing takes it out again.
      const [out] = await this.#db
        .select({ id: repoMerges.id })
        .from(repoMerges)
        .where(
          and(
            eq(repoMerges.projectId, projectId),
            sql`${repoMerges.result}->>'undoes' = ${root.mergeId}`,
            notInArray(repoMerges.state, ["refused", "superseded"]),
          ),
        )
        .limit(1);
      if (out) return why("history");
      // Gone with the copy it went into: GitHub's change comes again, as a merge of its own.
      if (merge?.state === "superseded") return why("rebuilt");
      // Files of it that people chose to take out since, or are taking out: they stay out.
      const files = new Set((merge?.result?.files ?? []).map(({ path }) => path));
      if (files.size > 0) {
        const [link] = await this.#db
          .select({ dropping: projectRepos.dropping })
          .from(projectRepos)
          .where(eq(projectRepos.projectId, projectId));
        const drops = await this.#db
          .select({ result: repoMerges.result })
          .from(projectBatches)
          .innerJoin(repoMerges, eq(repoMerges.id, projectBatches.mergeId))
          .where(
            and(
              eq(projectBatches.projectId, projectId),
              eq(projectBatches.kind, "drop"),
              gt(projectBatches.seq, root.seq),
            ),
          );
        const dropped = [
          ...(link?.dropping ?? []),
          ...drops.flatMap(({ result }) => result?.drops ?? []),
        ];
        if (dropped.some((path) => files.has(path))) return why("drop");
      }
    }
    return taking;
  }

  async #batchState(projectId: string, id: string): Promise<BatchStateOutcome> {
    const asked = await this.#takingBack(projectId, id);
    if ("kind" in asked) return asked;
    // What it says is of the way it goes from here: the last step of it, where that is another.
    const next = asked.state.next?.batch;
    const other =
      next !== undefined && next !== id ? await this.#takingBack(projectId, next) : asked;
    if ("kind" in other) return { kind: "state", state: asked.state };
    const { why: _why, ...said } = asked.state;
    const taking: TakingBack = {
      ...other,
      state: { ...said, ...(other.state.why !== undefined && { why: other.state.why }) },
    };
    if (taking.state.why !== undefined) return { kind: "state", state: taking.state };
    const looked = await this.#onCopy(projectId, (project) =>
      this.#copies.takeBack(project.id, {
        record: taking.root.undo,
        direction: taking.direction,
        batch: "",
        seq: project.head + 1,
        of: taking.root.id,
        watched: this.#limits.batchesWatched,
        look: true,
      }),
    );
    const why = "why" in looked ? looked.why : undefined;
    return { kind: "state", state: why === undefined ? taking.state : { ...taking.state, why } };
  }

  /** Something done with the working copy of a project, opened for it: "rebuilt" where gone. */
  async #onCopy<T>(
    projectId: string,
    work: (project: Project) => Promise<T>,
  ): Promise<T | { readonly why: BatchWhy }> {
    let project: Project | undefined;
    try {
      project = await this.#project(projectId);
    } catch (error) {
      // Let go of: what comes back is made from the repository, another document.
      if (error instanceof NotLive) return { why: "rebuilt" };
      throw error;
    }
    if (!project) return { why: "rebuilt" };
    await this.#ensureOpen(project);
    return work(project);
  }

  async #takeBack(projectId: string, id: string): Promise<TakeBackOutcome> {
    const taking = await this.#takingBack(projectId, id);
    if ("kind" in taking) return taking;
    const { root, direction } = taking;
    if (taking.state.why !== undefined) return { kind: "refused", why: taking.state.why };
    const project = await (async () => {
      try {
        return await this.#project(projectId);
      } catch (error) {
        if (error instanceof NotLive) return undefined;
        throw error;
      }
    })();
    if (!project) return { kind: "refused", why: "rebuilt" };
    const unusable = await unusableOf(this.#db, project.id);
    if (unusable) return { kind: "refused", why: "unusable" };
    await this.#ensureOpen(project);
    const batch = randomUUID();
    const base = project.head;
    let taken: TakenBack;
    try {
      taken = await this.#copies.takeBack(project.id, {
        record: root.undo,
        direction,
        batch,
        seq: base + 1,
        of: root.id,
        watched: this.#limits.batchesWatched,
      });
    } catch (error) {
      await this.#copies.drop(project.id);
      throw error;
    }
    if (taken.kind === "refused") {
      if (taken.why === "failed")
        this.#log.warn(
          { project: project.id, batch: root.id, detail: taken.detail },
          "a batch was not taken back",
        );
      return { kind: "refused", why: taken.why };
    }
    if (taken.kind !== "taken") throw new Error("the copy only looked");
    const undo = direction === "undo";
    const label = `${undo ? "撤销了" : "重做了"}${root.label}`.slice(0, 200);
    const by: SyncBatch = { batch, kind: direction, label, files: root.files, undoes: root.id };
    const at = this.#now();
    // As the update of the batch it takes back was, which says who it is of.
    const [was] = await this.#db
      .select({ kind: projectUpdates.kind })
      .from(projectUpdates)
      .where(and(eq(projectUpdates.projectId, project.id), eq(projectUpdates.seq, root.seq)));
    let stored: Stored[];
    let settled: Awaited<ReturnType<typeof settleMergePause>> = undefined;
    let stale = 0;
    try {
      if (taken.delta && !(await this.#fits(project, taken.delta.length))) {
        await this.#copies.drop(project.id);
        return { kind: "refused", why: "failed" };
      }
      const changes = platformChange(taken.delta, { kind: was?.kind ?? "repo", base, at, by });
      stored = await this.#store(project, changes, taken.info, async (tx, kept) => {
        const [turned] = await tx
          .update(projectBatches)
          .set({ undoneAt: undo ? at : null, undo: taken.undo ?? null })
          .where(
            and(
              eq(projectBatches.id, root.id),
              undo ? isNull(projectBatches.undoneAt) : isNotNull(projectBatches.undoneAt),
            ),
          )
          .returning({ id: projectBatches.id });
        // Another process took it back meanwhile: the copy goes, and nothing is kept.
        if (!turned) throw new NotReady();
        await tx.insert(projectBatches).values({
          id: batch,
          projectId: project.id,
          kind: direction,
          undoes: root.id,
          mergeId: null,
          seq: kept[0]?.seq ?? base,
          label,
          files: root.files,
          writes: batchRow(taken.batch),
          undo: null,
          formatVersion: CURRENT_FORMAT_VERSION,
          snapshotId: null,
          createdAt: at,
        });
        if (undo) {
          // Whichever side of it people would choose is not what the project has any more.
          const staled = await tx
            .update(repoConflicts)
            .set({ state: "stale", change: null })
            .where(
              and(
                eq(repoConflicts.projectId, project.id),
                eq(repoConflicts.batch, root.id),
                eq(repoConflicts.state, "open"),
              ),
            )
            .returning({ id: repoConflicts.id });
          stale = staled.length;
        }
        settled = stale > 0 ? await settleMergePause(tx, project.id, at) : undefined;
      });
    } catch (error) {
      // The copy has it, and the database does not.
      await this.#notStored(project, error);
      if (error instanceof NotReady) return { kind: "refused", why: undo ? "undone" : "done" };
      throw error;
    }
    const made = stored[0];
    this.#stored(project, stored, { watch: batch });
    this.#log.info(
      {
        project: project.id,
        batch: root.id,
        direction,
        seq: made?.seq,
        back: taken.back.length,
        kept: taken.kept.length,
        stale,
      },
      undo ? "a batch was taken back" : "a batch was done again",
    );
    await this.#compactSoon(project);
    // Conflicts of it kept archiving waiting: it goes on, and writes what the project has now.
    if (settled === "ready")
      await this.#merged?.(project.id).catch((error: unknown) => {
        this.#log.warn({ err: describeError(error), project: project.id }, "no archive queued");
      });
    return {
      kind: "taken",
      batch,
      seq: made?.seq,
      direction,
      back: taken.back.slice(0, PATHS_SAID),
      kept: taken.kept.slice(0, PATHS_SAID),
      backCount: taken.back.length,
      keptCount: taken.kept.length,
      ...(taken.obstacle !== undefined && { obstacle: taken.obstacle }),
      next: { batch, direction: undo ? "redo" : "undo" },
    };
  }

  /**
   * A batch of the platform's own is in the database (`stored`, as `#store` resolved): the windows
   * hear of it, and where it is one that changes made without it are looked at for (`watch`, as the
   * copy does), it is watched, only so many of them.
   */
  #stored(project: Project, stored: readonly Stored[], { watch }: { watch?: string } = {}): void {
    const made = stored[0];
    if (made && watch !== undefined) {
      project.watched.push({ id: watch, seq: made.seq });
      while (project.watched.length > this.#limits.batchesWatched)
        project.unwatched = project.watched.shift();
    }
    this.#tell(project, stored);
  }

  /**
   * A batch of the platform's own that the copy has did not get into the database: the copy goes,
   * and comes back from the database. Where another process changed the project meanwhile, this
   * one lets go of it, and its windows connect again. The caller says what came of it.
   */
  async #notStored(project: Project, error: unknown): Promise<void> {
    await this.#copies.drop(project.id);
    if (!(error instanceof HeadMoved)) return;
    this.#log.error({ project: project.id }, "another process changed the project");
    this.#projects.delete(project.id);
    for (const other of Array.from(project.connections)) {
      other.close(SYNC_CLOSE.unavailable, "the project changed elsewhere");
    }
  }

  /** Snapshots from before merges from GitHub, kept for each project as those before late changes. */
  async #pruneBeforeRepo(tx: Tx, id: string): Promise<void> {
    const kept = await tx
      .select({
        id: projectSnapshots.id,
        bytes: sql<number>`octet_length(${projectSnapshots.state})`.mapWith(Number),
      })
      .from(projectSnapshots)
      .where(and(eq(projectSnapshots.projectId, id), eq(projectSnapshots.reason, "before-repo")))
      .orderBy(desc(projectSnapshots.seq), desc(projectSnapshots.id));
    let bytes = 0;
    for (const [index, snapshot] of kept.entries()) {
      bytes += snapshot.bytes;
      if (index >= this.#limits.beforeMerge || bytes > this.#limits.beforeMergeBytes) {
        await tx.delete(projectSnapshots).where(eq(projectSnapshots.id, snapshot.id));
      }
    }
  }

  /**
   * What a window hears that says hello for a project that is not there: that it was deleted, where
   * it was the person's and the platform still keeps its id; that there is no such project
   * otherwise.
   */
  async #notThere(connection: Connection, id: string): Promise<Closed> {
    if (await wasDeleted(this.#db, id, this.#keptSince(), connection.who.userId))
      return new Closed(SYNC_CLOSE.deleted, "the project was deleted");
    return new Closed(SYNC_CLOSE.missing, "no such project");
  }

  /**
   * Notes the id as taken away now, as `userId`'s. An older note of it, which counts no more (the
   * project was made again since, or it is only not swept yet), is noted over.
   */
  async #note(tx: Tx, id: string, userId: string): Promise<void> {
    const at = this.#now();
    await tx
      .insert(deletedProjects)
      .values({ id, ownerId: userId, deletedAt: at })
      .onConflictDoUpdate({ target: deletedProjects.id, set: { ownerId: userId, deletedAt: at } });
  }

  /** Ids noted as taken away before this count for nothing any more, see `deletedKeptMs`. */
  #keptSince(): Date {
    return new Date(this.#now().getTime() - this.#limits.deletedKeptMs);
  }

  /**
   * Forgets the ids of projects that were taken away longer ago than `deletedKeptMs`, which count
   * for nothing already: every hour, see sync/sweep.ts. Resolves to how many went.
   */
  async forgetDeleted(): Promise<number> {
    const gone = await this.#db
      .delete(deletedProjects)
      .where(lte(deletedProjects.deletedAt, this.#keptSince()))
      .returning({ id: deletedProjects.id });
    return gone.length;
  }

  /**
   * Whether a person has as many ids noted as taken away in the last day as they get, see
   * `notedIdsPerDay`: counted by the index of their ids and when they were noted.
   */
  async #notesMany(tx: Tx, userId: string): Promise<boolean> {
    const since = new Date(this.#now().getTime() - 24 * 3600_000);
    const [noted] = await tx
      .select({ count: count() })
      .from(deletedProjects)
      .where(and(eq(deletedProjects.ownerId, userId), gt(deletedProjects.deletedAt, since)));
    return (noted?.count ?? 0) >= this.#limits.notedIdsPerDay;
  }

  /**
   * Lets go of what the hub holds of a project: its connections close, each saying what `said`
   * says for it, and its working copy goes from memory. Resolves to how many connections there were.
   */
  async #letGo(
    id: string,
    said: (connection: Connection) => { readonly code: number; readonly reason: string },
  ): Promise<number> {
    const project = this.#projects.get(id);
    let closed = 0;
    if (project) {
      clearTimeout(project.unloadTimer);
      this.#projects.delete(id);
      for (const connection of Array.from(project.connections)) {
        const { code, reason } = said(connection);
        connection.close(code, reason);
        closed += 1;
      }
    }
    await this.#copies.drop(id);
    return closed;
  }

  /** Everything after `after`, in order: the updates where the database has them, or all at once. */
  async #catchUp(connection: Connection, project: Project, after: number): Promise<void> {
    if (after >= project.head) return;
    const isWhole =
      after + 1 < project.oldest ||
      project.head - after > this.#limits.catchUpUpdates ||
      (await this.#bytesAfter(project, after)) > project.bytes;
    if (isWhole) {
      // What came after is not there one by one any more, or there is more of it than the whole
      // project is: what goes out to a window is never more than the project.
      await this.#ensureOpen(project);
      const whole = await this.#copies.encode(project.id);
      if (whole.length > SYNC_LIMITS.state) {
        // No editor takes it: saying so beats sending it over and over.
        throw new Closed(SYNC_CLOSE.tooLarge, "the project is larger than a window takes");
      }
      connection.send({
        t: "update",
        seq: project.head,
        digest: project.digest,
        kind: "snapshot",
        at: this.#now().getTime(),
        payload: whole,
      });
      return;
    }
    for (let from = after; from < project.head && !connection.isClosed;) {
      const rows = await this.#db
        .select({
          seq: projectUpdates.seq,
          digest: projectUpdates.digest,
          data: projectUpdates.data,
          kind: projectUpdates.kind,
          createdAt: projectUpdates.createdAt,
          batch: projectUpdates.batch,
          label: projectBatches.label,
          files: projectBatches.files,
          batchKind: projectBatches.kind,
          undoes: projectBatches.undoes,
        })
        .from(projectUpdates)
        .leftJoin(projectBatches, eq(projectBatches.id, projectUpdates.batch))
        .where(
          and(
            eq(projectUpdates.projectId, project.id),
            gt(projectUpdates.seq, from),
            lte(projectUpdates.seq, project.head),
          ),
        )
        .orderBy(asc(projectUpdates.seq))
        .limit(this.#limits.catchUpBatch);
      if (rows.length === 0) break;
      for (const row of rows) {
        connection.send({
          t: "update",
          seq: row.seq,
          digest: row.digest,
          kind: row.kind,
          at: row.createdAt.getTime(),
          ...(row.batch !== null && {
            by: {
              batch: row.batch,
              // What the batch is ("drop", "undo"), as it is said live: the update's kind is whose.
              kind: row.batchKind ?? row.kind,
              label: row.label ?? REPO_LABEL,
              files: row.files ?? 1,
              ...(row.undoes !== null && { undoes: row.undoes }),
            },
          }),
          payload: row.data,
        });
      }
      from = (rows.at(-1) as { seq: number }).seq;
    }
  }

  /** Bytes of the updates of a project after `after`, as the database has them. */
  async #bytesAfter(project: Project, after: number): Promise<number> {
    const [row] = await this.#db
      .select({ bytes: sum(sql`octet_length(${projectUpdates.data})`).mapWith(Number) })
      .from(projectUpdates)
      .where(and(eq(projectUpdates.projectId, project.id), gt(projectUpdates.seq, after)));
    return row?.bytes ?? 0;
  }

  /**
   * A new project, whose first version is what the window sent. Resolves to undefined when the id
   * is taken by now. None is made under the id of a project that was taken away in the last week,
   * whoever asks (`deleted_projects`, `deletedKeptMs`): the connection closes as for a project
   * that is not there, which stops an editor.
   */
  async #create(
    connection: Connection,
    message: Extract<SyncClientMessage, { t: "hello" }>,
  ): Promise<Project | undefined> {
    const create = message.create;
    if (!create) return undefined;
    const state = message.payload;
    if (!PROJECT_ID.test(create.projectId))
      throw new Closed(SYNC_CLOSE.protocol, "not a project id");
    if (state.length > SYNC_LIMITS.state) throw new Closed(SYNC_CLOSE.tooLarge, "too large");
    // A project that was taken away lately is not made again, whoever asks: looked at first,
    // before anything is done with what was sent, and once more as it is made.
    if (await wasDeleted(this.#db, message.project, this.#keptSince())) {
      this.#log.info({ project: message.project }, "a deleted project is not made again");
      throw await this.#notThere(connection, message.project);
    }
    // A new project is its first working copy: a window that says it has another one of it has
    // nothing this could go on with, and none is made for it.
    if (message.generation !== undefined && message.generation !== 1) {
      throw new Closed(SYNC_CLOSE.rebuilt, "another working copy of the project");
    }
    let taken: Taken;
    try {
      taken = await this.#copies.create(
        message.project,
        state,
        create.projectId,
        connection.who.userId,
        SYNC_LIMITS.structs,
        this.#inUse(),
      );
    } catch (error) {
      if (error instanceof CopiesGone) {
        throw error.running && this.#blewUpTwice(`create:${message.project}`, state)
          ? new Closed(SYNC_CLOSE.tooLarge, "too large")
          : new Closed(SYNC_CLOSE.unavailable, "the working copies went");
      }
      throw error;
    }
    this.#blewUp.delete(`create:${message.project}`);
    if (taken.kind !== "taken") {
      const reason = taken.kind === "refused" ? taken.reason : "malformed";
      throw new Closed(
        reason === "too-new"
          ? SYNC_CLOSE.outdated
          : reason === "too-large"
            ? SYNC_CLOSE.tooLarge
            : SYNC_CLOSE.protocol,
        taken.kind === "refused"
          ? `${taken.reason}: ${taken.detail}`.slice(0, 100)
          : "not a project",
      );
    }
    const at = this.#now();
    const digest = digestOf("", 1, state);
    try {
      await this.#db.transaction(async (tx) => {
        // Room for it, of what the person may keep (`storage.platform`, `projects.count`): counted
        // with the person held (before the id, as restoring holds them), so that of two new
        // projects at once the second counts the first. Only here: a project that is there is
        // never turned away for what is kept, see room.ts.
        const full = await roomFor(tx, this.#personLimits, connection.who.userId, state.length);
        if (full) throw new Closed(SYNC_CLOSE.quota, full.detail === "count" ? "count" : "quota");
        // The id is held from looking whether a project of it was taken away until the project is
        // made, as `remove` holds it: one that is being taken away now is seen as gone here.
        await lockProject(tx, message.project);
        if (await wasDeleted(tx, message.project, this.#keptSince())) throw new Deleted();
        await tx.insert(projects).values({
          id: message.project,
          ownerId: connection.who.userId,
          projectId: create.projectId,
          name: taken.info.name,
          description: taken.info.description,
          head: 1,
          digest,
          bytes: state.length,
          createdAt: at,
          updatedAt: at,
          dirtySince: at,
          openedAt: at,
        });
        await notifyPerson(tx, [connection.who.userId]);
        await tx.insert(projectUpdates).values({
          projectId: message.project,
          seq: 1,
          digest,
          data: Buffer.from(state),
          kind: "first",
          device: connection.device,
          window: connection.window,
          base: 0,
          behind: false,
          madeAt: at,
          createdAt: at,
        });
        if (this.#linkLocal)
          await linkLocal(tx, { projectId: message.project, userId: connection.who.userId, at });
      }, READ_COMMITTED);
    } catch (error) {
      await this.#copies.drop(message.project);
      if (error instanceof Deleted) {
        this.#log.info({ project: message.project }, "a deleted project is not made again");
        throw await this.#notThere(connection, message.project);
      }
      const code = (error as { cause?: { code?: unknown }; code?: unknown }).cause?.code;
      if (code === "23505" || (error as { code?: unknown }).code === "23505") return undefined;
      throw error;
    }
    this.#log.info({ project: message.project }, "a project came to the platform");
    const project = new Project({
      id: message.project,
      ownerId: connection.who.userId,
      projectId: create.projectId,
      head: 1,
      digest,
      oldest: 1,
      updatesSince: 1,
      bytesSince: state.length,
      bytes: state.length,
      name: taken.info.name,
      description: taken.info.description,
      generation: 1,
      openedAt: at.getTime(),
    });
    this.#projects.set(project.id, project);
    return project;
  }

  async #check(connection: Connection, project: Project): Promise<void> {
    if (connection.isClosed) return;
    if (this.#projects.get(project.id) !== project) {
      connection.close(SYNC_CLOSE.unavailable, "the project was read again");
      return;
    }
    try {
      await this.#ensureOpen(project);
      const [vector, deletions] = [
        await this.#copies.stateVector(project.id),
        await this.#copies.deletions(project.id),
      ];
      connection.send({
        t: "checked",
        head: project.head,
        digest: project.digest,
        payload: packChecked(vector, deletions),
      });
    } catch (error) {
      if (!(error instanceof CopiesGone)) throw error;
      connection.close(SYNC_CLOSE.unavailable, "the working copies start again");
    }
  }

  async #push(
    connection: Connection,
    project: Project,
    message: Extract<SyncClientMessage, { t: "push" }>,
  ): Promise<void> {
    const reject = (reason: SyncRejection, detail = "") => {
      this.#log.warn(
        { project: project.id, reason, detail, kind: message.kind, bytes: message.payload.length },
        "a change was turned away",
      );
      connection.send({ t: "reject", id: message.id, reason, retry: RETRY.has(reason) });
    };
    if (connection.isClosed) return;
    if (connection.readOnly)
      throw new Closed(SYNC_CLOSE.protocol, "a window that only reads sends no change");
    if (this.#projects.get(project.id) !== project) {
      // The project was read again since this connection began: it comes again, to that one.
      connection.close(SYNC_CLOSE.unavailable, "the project was read again");
      return;
    }
    // Its repository cannot be used: the change stays with the window, which closes.
    if (project.unusable !== undefined) {
      connection.close(SYNC_CLOSE.unusable, project.unusable);
      return;
    }
    if (!BROWSER_KINDS.has(message.kind)) return reject("source");
    // Made against the project as it was then, as taking a copy back makes it: where anything came
    // since, as the same taken back by another computer, it would go in twice (two computers taking a
    // copy back at once). The project is read nowhere else meanwhile: this is its turn, and what
    // another process wrote since fails as `HeadMoved` below.
    const { expect } = message;
    if (expect && (expect.generation !== project.generation || expect.seq !== project.head))
      return reject("moved", `expected ${expect.generation}/${expect.seq}`);
    if (this.#isBusy(connection)) return reject("busy");
    const update = message.payload;
    if (update.length > SYNC_LIMITS.update) return reject("too-large");

    if (message.behind && !connection.snapshotted && message.base < project.head) {
      await this.#keepBeforeMerge(connection, project, message.base);
    }

    let taken: Taken;
    try {
      await this.#ensureOpen(project);
      // A change of an editor: also one that may have been made without a batch of the platform's.
      const repair = message.kind === "repair";
      // Made without a batch the copy does not watch any more: what went cannot be told.
      const unwatched = project.unwatched;
      const isUnknown = unwatched !== undefined && (repair || message.base < unwatched.seq);
      if (isUnknown) {
        this.#log.warn(
          { project: project.id, base: message.base, batch: unwatched.id },
          "a change made without a merge from GitHub that is not watched any more",
        );
      }
      taken = await this.#copies.apply(project.id, update, SYNC_LIMITS.structs, {
        fromEditor: true,
        base: message.base,
        repair,
        prefer: project.prefer,
        ...(isUnknown && { unknown: unwatched.id }),
      });
    } catch (error) {
      if (error instanceof CopiesGone) {
        return error.running && this.#blewUpTwice(project.id, update)
          ? reject("too-large", "the working copies went, twice")
          : reject("unavailable", "the working copies went");
      }
      // Whatever it was, the copy may have the change: it goes, and comes from the database.
      await this.#copies.drop(project.id);
      throw error;
    }
    this.#blewUp.delete(project.id);
    if (taken.kind !== "refused" && taken.late?.unknownPlaces !== undefined) {
      this.#log.warn(
        { project: project.id, places: taken.late.unknownPlaces },
        "places of a change that cannot be told against a merge from GitHub, said to people",
      );
    }
    if (taken.kind === "refused") return reject(taken.reason, taken.detail);
    if (taken.kind === "nothing") {
      // Nothing new, though what it did may have gone for a batch it did not have.
      const late = taken.late?.conflicts ?? [];
      if (late.length > 0) {
        try {
          const conflicts = await this.#theirsWithout(project, late, update);
          await this.#store(project, [], taken.info, (tx) =>
            this.#noteConflicts(
              tx,
              project.id,
              this.#lateConflicts(connection, message, conflicts),
            ),
          );
        } catch (error) {
          await this.#copies.drop(project.id);
          this.#log.error(
            { err: describeError(error), project: project.id },
            "conflicts of a change could not be kept",
          );
          return reject("unavailable");
        }
      }
      connection.send({ t: "ack", id: message.id, seq: project.head, digest: project.digest });
      return;
    }
    // From here on the copy has the change, and the database must have it too, or the copy goes.
    const { delta, info, late } = taken;
    try {
      const added = delta.length + (late?.fix?.delta.length ?? 0);
      if (!(await this.#fits(project, added))) {
        await this.#copies.drop(project.id);
        return reject("too-large", "the project");
      }
      await this.#keep(connection, project, message, delta, info, late);
    } catch (error) {
      await this.#copies.drop(project.id);
      if (error instanceof HeadMoved) {
        this.#log.error({ project: project.id }, "another process changed the project");
        this.#projects.delete(project.id);
        for (const other of Array.from(project.connections)) {
          other.close(SYNC_CLOSE.unavailable, "the project changed elsewhere");
        }
        return;
      }
      this.#log.error(
        { err: describeError(error), project: project.id },
        "a change could not be kept",
      );
      return reject("unavailable");
    }
  }

  /**
   * The working copies went while they took in `update`. The first time, that can be what else they
   * had: the change can come again. Twice in a row, it is the change.
   */
  #blewUpTwice(key: string, update: Uint8Array): boolean {
    const digest = createHash("sha256").update(update).digest("base64url");
    if (this.#blewUp.get(key) === digest) {
      this.#blewUp.delete(key);
      return true;
    }
    if (this.#blewUp.size > 1000) this.#blewUp.clear();
    this.#blewUp.set(key, digest);
    return false;
  }

  /**
   * Whether a project that grows by `added` bytes is still no larger than it may be. The bytes of
   * what came since the last snapshot can be more than the project is, as where a large file was
   * written over, or less, where many small changes split what was there: near the limit, what it
   * really is decides.
   */
  async #fits(project: Project, added: number): Promise<boolean> {
    if (project.bytes + added <= NEAR_THE_LIMIT * this.#limits.projectBytes) return true;
    const size = (await this.#copies.encode(project.id)).length;
    if (size > this.#limits.projectBytes) return false;
    project.bytes = size - added;
    return true;
  }

  /**
   * Keeps a change, answers it and tells the others, and makes a snapshot when it is time. Where it
   * was made without a batch of the platform's, what either took away of the other is noted as
   * conflicts, in the same transaction; where it brought in again what a batch did, the copy wrote
   * that once more (`fix`), which goes in after it, to every window.
   */
  async #keep(
    connection: Connection,
    project: Project,
    message: Extract<SyncClientMessage, { t: "push" }>,
    delta: Uint8Array,
    info: CopyInfo,
    late?: Late,
  ): Promise<void> {
    const at = this.#now();
    const madeAt = new Date(Math.min(message.at, at.getTime() + 60_000));
    const taking: Taking[] = [
      {
        delta,
        kind: message.kind,
        device: connection.device,
        window: message.window,
        base: Math.min(message.base, project.head),
        behind: message.behind,
        madeAt,
      },
    ];
    const fix = late?.fix;
    const fixed = fix?.batches[0];
    if (fix && fixed !== undefined) {
      const [batch] = await this.#db
        .select({
          label: projectBatches.label,
          files: projectBatches.files,
          kind: projectBatches.kind,
        })
        .from(projectBatches)
        .where(eq(projectBatches.id, fixed));
      taking.push({
        delta: fix.delta,
        kind: "repo",
        device: PLATFORM_DEVICE,
        window: fixed,
        base: project.head + 1,
        behind: false,
        madeAt: at,
        by: {
          batch: fixed,
          kind: batch?.kind ?? "repo",
          label: batch?.label ?? REPO_LABEL,
          files: batch?.files ?? 1,
        },
      });
    }
    const conflicts =
      late && late.conflicts.length > 0
        ? await this.#theirsWithout(project, late.conflicts, message.payload)
        : [];
    const noted = this.#lateConflicts(connection, message, conflicts);
    const stored = await this.#store(
      project,
      taking,
      info,
      noted.length === 0 ? undefined : (tx) => this.#noteConflicts(tx, project.id, noted),
    );
    const [own, ...more] = stored as [Stored, ...Stored[]];
    connection.send({ t: "ack", id: message.id, seq: own.seq, digest: own.digest });
    this.#tell(project, [own], connection);
    this.#tell(project, more);
    if (noted.length > 0) {
      this.#log.info(
        { project: project.id, conflicts: noted.length },
        "a change made without a merge from GitHub took something of it away, or it of the change",
      );
    }
    await this.#compactSoon(project);
  }

  /** Conflicts of a change that arrived late, as they are noted: by whom, and when it was made. */
  #lateConflicts(
    connection: Connection,
    message: Extract<SyncClientMessage, { t: "push" }>,
    conflicts: Late["conflicts"],
  ): NewConflict[] {
    const madeAt = new Date(Math.min(message.at, this.#now().getTime() + 60_000));
    return conflicts.map((conflict): NewConflict => ({
      ...conflict,
      source: "late",
      oursBy: `${message.kind}:${connection.device}`,
      oursAt: madeAt,
      ...(conflict.without && message.payload.length <= CHANGE_KEPT && { change: message.payload }),
    }));
  }

  /**
   * Writes updates of a project into the database, one after the other from its head, and whatever
   * else `more` does, in one transaction: only where the head is still where the hub thinks, as
   * another process could have moved it (`HeadMoved`). Without updates, `more` only. Once it is
   * done, the hub's own idea of the project follows.
   */
  async #store(
    project: Project,
    taking: readonly Taking[],
    info: CopyInfo,
    more?: (tx: Tx, stored: readonly Stored[]) => Promise<void>,
  ): Promise<Stored[]> {
    const at = this.#now();
    const { name, description } = info;
    const stored: Stored[] = [];
    let digest = project.digest;
    let bytes = 0;
    for (const [index, each] of taking.entries()) {
      const seq = project.head + 1 + index;
      digest = digestOf(digest, seq, each.delta);
      bytes += each.delta.length;
      stored.push({
        seq,
        digest,
        kind: each.kind,
        at: at.getTime(),
        payload: each.delta,
        ...(each.by && { by: each.by }),
      });
    }
    const last = stored.at(-1);
    await this.#db.transaction(async (tx) => {
      if (last) {
        const [moved] = await tx
          .update(projects)
          .set({
            head: last.seq,
            digest: last.digest,
            bytes: sql`${projects.bytes} + ${bytes}`,
            updatedAt: at,
            // Changes that GitHub does not have yet, since the first of them: see archive/.
            dirtySince: sql`coalesce(${projects.dirtySince}, ${at.toISOString()}::timestamptz)`,
            ...(name !== project.name && { name }),
            ...(description !== project.description && { description }),
          })
          .where(
            and(
              eq(projects.id, project.id),
              eq(projects.head, project.head),
              // Let go of meanwhile, by another process: nothing is taken into what is not here.
              eq(projects.copyState, "live"),
            ),
          )
          .returning({ head: projects.head });
        if (!moved) throw new HeadMoved();
        // Its name is in the person's list: their pages read it again.
        if (name !== project.name) await notifyPerson(tx, [project.ownerId]);
        await tx.insert(projectUpdates).values(
          taking.map((each, index) => ({
            projectId: project.id,
            seq: (stored[index] as Stored).seq,
            digest: (stored[index] as Stored).digest,
            data: Buffer.from(each.delta),
            kind: each.kind,
            device: each.device,
            window: each.window,
            base: each.base,
            behind: each.behind,
            madeAt: each.madeAt,
            createdAt: at,
            batch: each.by?.batch ?? null,
          })),
        );
      } else {
        // Nothing new of the project: it still has to be where the hub thinks.
        const [row] = await tx
          .select({ head: projects.head, copyState: projects.copyState })
          .from(projects)
          .where(eq(projects.id, project.id))
          .for("update");
        if (!row || row.head !== project.head || row.copyState !== "live") throw new HeadMoved();
      }
      await more?.(tx, stored);
    });
    if (last) {
      project.head = last.seq;
      project.digest = last.digest;
      project.updatesSince += stored.length;
      project.bytesSince += bytes;
      project.bytes += bytes;
    }
    project.name = name;
    project.description = description;
    return stored;
  }

  /** Tells the windows of a project of updates, but the one that sent them. */
  #tell(project: Project, stored: readonly Stored[], except?: Connection): void {
    if (stored.length === 0) return;
    for (const other of project.connections) {
      if (other === except || !other.isReady) continue;
      for (const update of stored) other.send({ t: "update", ...update });
    }
  }

  /** A snapshot, where it is time for one: what fails waits for the next change. */
  async #compactSoon(project: Project): Promise<void> {
    if (
      project.updatesSince >= this.#limits.compactUpdates ||
      project.bytesSince >= this.#limits.compactBytes
    ) {
      await this.#compact(project).catch((error: unknown) => {
        this.#log.warn({ err: describeError(error), project: project.id }, "no snapshot for now");
      });
    }
  }

  /**
   * Notes conflicts of merges from GitHub (`repo_conflicts`), and pauses archiving where the link
   * goes as it should: GitHub keeps what it has until people chose. What a merge or a batch wrote
   * that went counts as it went the first time, as later changes are on top of that one: another of
   * the same place is not noted. What a change did that went counts as the latest change says it,
   * and the one before goes stale. A new merge makes every older conflict of the same place stale.
   */
  async #noteConflicts(
    tx: Tx,
    projectId: string,
    conflicts: readonly NewConflict[],
  ): Promise<void> {
    if (conflicts.length === 0) return;
    const merges = [...new Set(conflicts.map(({ batch }) => batch))].filter((id) => UUID.test(id));
    const shas = new Map(
      merges.length === 0
        ? []
        : (
            await tx
              .select({ id: repoMerges.id, toSha: repoMerges.toSha })
              .from(repoMerges)
              .where(and(eq(repoMerges.projectId, projectId), inArray(repoMerges.id, merges)))
          ).map((row) => [row.id, row.toSha] as const),
    );
    const now = this.#now();
    let noted = 0;
    for (const conflict of conflicts) {
      // The merge it is of may be gone by now: the conflict is noted all the same.
      const sha = shas.get(conflict.batch);
      const place = and(
        eq(repoConflicts.projectId, projectId),
        eq(repoConflicts.state, "open"),
        eq(repoConflicts.file, conflict.file),
        sql`${repoConflicts.path} = ${JSON.stringify(conflict.path)}::jsonb`,
      );
      if (conflict.source === "merge") {
        await tx.update(repoConflicts).set({ state: "stale" }).where(place);
      } else if (conflict.lost === "batch") {
        const [known] = await tx
          .select({ id: repoConflicts.id })
          .from(repoConflicts)
          .where(
            and(place, eq(repoConflicts.batch, conflict.batch), eq(repoConflicts.lost, "batch")),
          )
          .limit(1);
        if (known) continue;
      } else {
        await tx
          .update(repoConflicts)
          .set({ state: "stale" })
          .where(
            and(place, eq(repoConflicts.batch, conflict.batch), eq(repoConflicts.lost, "change")),
          );
      }
      await tx.insert(repoConflicts).values({
        projectId,
        mergeId: sha === undefined ? null : conflict.batch,
        batch: conflict.batch,
        source: conflict.source,
        lost: conflict.lost,
        file: conflict.file,
        path: [...conflict.path],
        label: conflict.label.slice(0, 500),
        kind: conflict.kind,
        lines: conflict.lines ?? null,
        around: conflict.around ?? null,
        ours: conflict.ours === undefined ? null : (conflict.ours as object),
        theirs: conflict.theirs === undefined ? null : (conflict.theirs as object),
        oursBy: conflict.oursBy ?? null,
        oursAt: conflict.oursAt ?? null,
        change: conflict.change ? Buffer.from(conflict.change) : null,
        theirsSha: sha ?? null,
        createdAt: now,
      });
      noted += 1;
    }
    if (noted === 0) return;
    await tx
      .update(projectRepos)
      .set({ state: "paused", pauseReason: "conflicts", pausedAt: now, detail: null })
      .where(and(eq(projectRepos.projectId, projectId), eq(projectRepos.state, "ready")));
  }

  /**
   * What a change wrote into what a batch took away, for the conflicts that say so
   * (`LateConflict.without`): the project as it would be without the batch, from the snapshot right
   * before it, the changes that wrote into it before as they were sent, this one, and the updates
   * since, but the batch's own. Where that is not
   * there any more, or does not read, what was there before the batch stays what went.
   */
  async #theirsWithout(
    project: Project,
    conflicts: Late["conflicts"],
    update: Uint8Array,
  ): Promise<Late["conflicts"]> {
    const out = [...conflicts];
    const batches = new Set(conflicts.filter(({ without }) => without).map(({ batch }) => batch));
    for (const batch of batches) {
      try {
        const [row] = await this.#db
          .select({ seq: projectBatches.seq, snapshotId: projectBatches.snapshotId })
          .from(projectBatches)
          .where(and(eq(projectBatches.id, batch), eq(projectBatches.projectId, project.id)));
        if (!row?.snapshotId) continue;
        const [snapshot] = await this.#db
          .select({ state: projectSnapshots.state })
          .from(projectSnapshots)
          .where(eq(projectSnapshots.id, row.snapshotId));
        if (!snapshot) continue;
        const since = await this.#db
          .select({ data: projectUpdates.data })
          .from(projectUpdates)
          .where(
            and(
              eq(projectUpdates.projectId, project.id),
              gt(projectUpdates.seq, row.seq),
              or(isNull(projectUpdates.batch), ne(projectUpdates.batch, batch)),
            ),
          )
          .orderBy(asc(projectUpdates.seq))
          .limit(this.#limits.catchUpUpdates);
        // What changes before this one wrote into it: the copy kept nothing of that.
        const before = await this.#db
          .select({ change: repoConflicts.change })
          .from(repoConflicts)
          .where(
            and(
              eq(repoConflicts.projectId, project.id),
              eq(repoConflicts.batch, batch),
              isNotNull(repoConflicts.change),
            ),
          )
          .orderBy(asc(repoConflicts.createdAt));
        const earlier = [...new Set(before.map(({ change }) => change as Buffer))];
        const at = out.flatMap((conflict, index) =>
          conflict.without && conflict.batch === batch ? [index] : [],
        );
        const { values } = await this.#copies.without(
          // The changes as they were sent first: the updates of the database have what the copy
          // made of them, where what went into what the batch took away is gone.
          [snapshot.state, ...earlier, update, ...since.map(({ data }) => data)],
          at.map((index) => (out[index] as Late["conflicts"][number]).path),
        );
        for (const [position, index] of at.entries()) {
          out[index] = { ...(out[index] as Late["conflicts"][number]), theirs: values[position] };
        }
      } catch (error) {
        this.#log.warn(
          { err: describeError(error), project: project.id, batch },
          "what a change wrote into what a merge took away is not known as a whole",
        );
      }
    }
    return out;
  }

  /**
   * Keeps the project as it is, before changes that were made without the latest come in after
   * changes of another browser: whatever they replace can be found again, see the design, 7.6. At
   * most one in a while for each project, and only so many bytes of them: a browser names itself.
   */
  async #keepBeforeMerge(connection: Connection, project: Project, base: number): Promise<void> {
    const now = this.#now().getTime();
    if (now - project.lastBeforeMerge < this.#limits.beforeMergeMs) return;
    const [other] =
      base + 1 < project.oldest
        ? [{ seq: base + 1 }]
        : await this.#db
            .select({ seq: projectUpdates.seq })
            .from(projectUpdates)
            .where(
              and(
                eq(projectUpdates.projectId, project.id),
                gt(projectUpdates.seq, base),
                ne(projectUpdates.device, connection.device),
              ),
            )
            .limit(1);
    if (!other) return;
    connection.snapshotted = true;
    project.lastBeforeMerge = now;
    try {
      await this.#ensureOpen(project);
      const state = Buffer.from(await this.#copies.encode(project.id));
      await this.#db.transaction(async (tx) => {
        await tx.insert(projectSnapshots).values({
          projectId: project.id,
          seq: project.head,
          digest: project.digest,
          state,
          reason: "before-merge",
          device: connection.device,
          createdAt: this.#now(),
        });
        const kept = await tx
          .select({
            id: projectSnapshots.id,
            bytes: sql<number>`octet_length(${projectSnapshots.state})`.mapWith(Number),
          })
          .from(projectSnapshots)
          .where(
            and(
              eq(projectSnapshots.projectId, project.id),
              eq(projectSnapshots.reason, "before-merge"),
            ),
          )
          .orderBy(desc(projectSnapshots.seq), desc(projectSnapshots.id));
        let bytes = 0;
        for (const [index, snapshot] of kept.entries()) {
          bytes += snapshot.bytes;
          if (index >= this.#limits.beforeMerge || bytes > this.#limits.beforeMergeBytes) {
            await tx.delete(projectSnapshots).where(eq(projectSnapshots.id, snapshot.id));
          }
        }
      });
      this.#log.info({ project: project.id, seq: project.head }, "kept the project before a merge");
    } catch (error) {
      this.#log.warn(
        { err: describeError(error), project: project.id },
        "no snapshot before a merge",
      );
    }
  }

  /** A snapshot of the project now, after which the updates before the last one go. */
  async #compact(project: Project): Promise<void> {
    await this.#ensureOpen(project);
    const state = await this.#copies.encode(project.id);
    const seq = project.head;
    const digest = project.digest;
    const previous = await this.#db.transaction(async (tx) => {
      const [last] = await tx
        .select({ seq: projectSnapshots.seq })
        .from(projectSnapshots)
        .where(
          and(eq(projectSnapshots.projectId, project.id), eq(projectSnapshots.reason, "compact")),
        )
        .orderBy(desc(projectSnapshots.seq))
        .limit(1);
      await tx.insert(projectSnapshots).values({
        projectId: project.id,
        seq,
        digest,
        state: Buffer.from(state),
        reason: "compact",
        createdAt: this.#now(),
      });
      if (last) {
        await tx
          .delete(projectUpdates)
          .where(and(eq(projectUpdates.projectId, project.id), lte(projectUpdates.seq, last.seq)));
        await tx
          .delete(projectSnapshots)
          .where(
            and(
              eq(projectSnapshots.projectId, project.id),
              eq(projectSnapshots.reason, "compact"),
              lt(projectSnapshots.seq, last.seq),
            ),
          );
      }
      await tx.update(projects).set({ bytes: state.length }).where(eq(projects.id, project.id));
      return last?.seq;
    });
    if (previous !== undefined) project.oldest = previous + 1;
    project.updatesSince = 0;
    project.bytesSince = 0;
    project.bytes = state.length;
    this.#copies.resize(project.id, state.length);
  }
}
