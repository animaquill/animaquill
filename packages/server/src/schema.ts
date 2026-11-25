import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  customType,
  foreignKey,
  index,
  integer,
  jsonb,
  pgSequence,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * The tables of the server, for Drizzle, in the schema `public`. After changing this file, write
 * the migration with `db:generate` and commit both. A deployment keeps tables of its own in a
 * schema of its own (the platform's is `cloud`), which may refer to
 * these and are never referred to from here.
 *
 * What people's browsers carry (the id of a session, the state of a sign-in, an invite code) is kept
 * as its SHA-256 only, and secrets (GitHub tokens, the PKCE verifier) only sealed with the master
 * key, see seal.ts. Reading the database, or a backup of it, is not enough to use any of them.
 */

export const bytes = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

export const moment = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
/** Ids of GitHub are numbers, below 2^53 for a long time to come. */
export const githubNumber = (name: string) => bigint(name, { mode: "number" });

/** A person, known by the number of their GitHub account: the login can change. */
export const users = pgTable("users", {
  id: uuid("id")
    .primaryKey()
    .default(sql`uuidv7()`),
  githubId: githubNumber("github_id").notNull().unique(),
  /** As GitHub had it at the last sign-in, for showing only. */
  login: text("login").notNull(),
  avatarUrl: text("avatar_url"),
  createdAt: moment("created_at").notNull().defaultNow(),
  /**
   * Since when an admin has the account disabled: it cannot sign in or sync, and its data stays.
   * Null while it works.
   */
  disabledAt: moment("disabled_at"),
  /** Why, as the admin wrote it, for the admins. */
  disabledReason: text("disabled_reason"),
});

/**
 * The tokens of a person's authorization of the GitHub App, sealed. A refresh replaces both and the
 * old ones stop working at once, so they change only with the row locked, see auth/tokens.ts.
 */
export const githubTokens = pgTable("github_tokens", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  accessToken: bytes("access_token").notNull(),
  /** Null when the App's tokens do not expire. */
  accessExpiresAt: moment("access_expires_at"),
  refreshToken: bytes("refresh_token"),
  refreshExpiresAt: moment("refresh_expires_at"),
  /** One more with each refresh, to see that another one came first. */
  generation: integer("generation").notNull().default(1),
  updatedAt: moment("updated_at").notNull().defaultNow(),
});

/** A browser that is signed in. */
export const sessions = pgTable(
  "sessions",
  {
    idHash: bytes("id_hash").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: moment("created_at").notNull().defaultNow(),
    lastUsedAt: moment("last_used_at").notNull().defaultNow(),
    /** Moves on as the session is used, see auth/store.ts. */
    expiresAt: moment("expires_at").notNull(),
    /** Which browser on which system, such as "Chrome 157, Windows", for a list of sessions. */
    userAgent: text("user_agent"),
  },
  (table) => [
    index("sessions_user").on(table.userId),
    index("sessions_expires").on(table.expiresAt),
  ],
);

/** A sign-in on its way through GitHub. It works once, for ten minutes. */
export const loginAttempts = pgTable(
  "login_attempts",
  {
    stateHash: bytes("state_hash").primaryKey(),
    /** The PKCE verifier, sealed. */
    verifier: bytes("verifier").notNull(),
    /** Where in the editor the browser goes back to: a path of this site. */
    returnTo: text("return_to").notNull(),
    createdAt: moment("created_at").notNull().defaultNow(),
    expiresAt: moment("expires_at").notNull(),
  },
  (table) => [index("login_attempts_expires").on(table.expiresAt)],
);

/**
 * Someone GitHub knows who has no account here yet, waiting for an invite code. The tokens are
 * sealed, and become the account's when the code is right.
 */
export const signups = pgTable(
  "signups",
  {
    idHash: bytes("id_hash").primaryKey(),
    githubId: githubNumber("github_id").notNull(),
    login: text("login").notNull(),
    avatarUrl: text("avatar_url"),
    accessToken: bytes("access_token").notNull(),
    accessExpiresAt: moment("access_expires_at"),
    refreshToken: bytes("refresh_token"),
    refreshExpiresAt: moment("refresh_expires_at"),
    returnTo: text("return_to").notNull(),
    /** Wrong codes so far. Too many, and this goes. */
    failures: integer("failures").notNull().default(0),
    createdAt: moment("created_at").notNull().defaultNow(),
    expiresAt: moment("expires_at").notNull(),
  },
  (table) => [index("signups_expires").on(table.expiresAt)],
);

/** Where the GitHub App is installed, from GitHub's webhooks and from what users' tokens see. */
export const installations = pgTable(
  "installations",
  {
    /** GitHub's number of the installation. */
    id: githubNumber("id").primaryKey(),
    /** The account it is on: a person's own, or an organization. */
    accountId: githubNumber("account_id").notNull(),
    accountLogin: text("account_login").notNull(),
    /** "User" or "Organization". */
    accountType: text("account_type").notNull(),
    /** "all" or "selected": which of the account's repositories the App may touch. */
    repositorySelection: text("repository_selection").notNull(),
    suspendedAt: moment("suspended_at"),
    createdAt: moment("created_at").notNull().defaultNow(),
    updatedAt: moment("updated_at").notNull().defaultNow(),
  },
  (table) => [index("installations_account").on(table.accountId)],
);

/**
 * Deliveries of GitHub's webhooks taken in lately, by X-GitHub-Delivery: GitHub sends one again when
 * people ask it to, and so can anyone who saw one go by. A week is kept, see `Accounts.cleanUp`.
 */
export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: text("id").primaryKey(),
    event: text("event").notNull(),
    receivedAt: moment("received_at").notNull().defaultNow(),
  },
  (table) => [index("webhook_deliveries_received").on(table.receivedAt)],
);

/** Numbers of updates, which count on for as long as a project lives. */
export const count = (name: string) => bigint(name, { mode: "number" });

/**
 * Whether the platform has the working copy of a project, see `projects.copy_state`: "live" where it
 * does; "released" where it let go of it, and only the repository has the project; "restoring"
 * while it comes back from there.
 */
export type CopyState = "live" | "released" | "restoring";

/**
 * Where the working copy of a project was when the platform let go of it
 * (`projects.released_from`): which one it was, its last update, and the update and commit of its
 * last archive, which is what the next one is made from (archive/rebuild.ts). A window that had the
 * one before finds what it has in common with the new one by it (the plan of the redesign, 13.5):
 * the new one starts as that archive. It stays after the copy is made again, until the next one
 * goes.
 */
export interface ReleasedFrom {
  readonly generation: number;
  readonly head: number;
  readonly archivedSeq: number;
  readonly headSha: string;
  /**
   * Once the next copy is made: whether it began as that archive, which is what the copy before
   * has in common with it. False where it was made from something else (the archive was not there
   * any more, or people asked for the branch as it is): a window of the copy before then has
   * nothing in common with it to put its changes onto, and has people choose. Missing until then.
   */
  readonly commonBase?: boolean;
}

/**
 * Why the working copy of a project could not be made from its repository the last time it was
 * tried (`projects.copy_problem`), see archive/rebuild.ts: "unreadable", documents that do not read
 * as the format says (`files`); "notProject", no project at the top of the repository; "tooLarge",
 * larger than a project of the platform may be; "tooNew", of a newer format than the platform
 * knows; "identity", another project than the one it was; "quota", more than the person may keep;
 * "unusable", the repository cannot be used (`reason`, as a pause says it); "unavailable", GitHub or
 * the platform failed, which is tried again. `at`: milliseconds since 1970.
 */
export interface CopyProblem {
  readonly code:
    | "unreadable"
    | "notProject"
    | "tooLarge"
    | "tooNew"
    | "identity"
    | "quota"
    | "unusable"
    | "unavailable";
  readonly at: number;
  readonly files?: readonly string[];
  readonly reason?: string;
  /**
   * From when it is tried again as it is asked for, in milliseconds since 1970: a minute, then
   * longer after each failure in a row; hours for what the repository has (`PERMANENT_PROBLEMS`
   * of archive/rebuild.ts), which only people can put right.
   */
  readonly retryAt?: number;
}

/**
 * What the last archive of a project counted, for a list of projects (`projects.stats`): its assets,
 * how many bytes their files have, and how many of them can be downloaded from where they are kept.
 */
export interface ProjectStats {
  readonly assets?: {
    readonly count: number;
    readonly bytes: number;
    readonly elsewhere: number;
  };
}

/**
 * A project on the platform: its working copy, which is the updates of Yjs that the editor sends,
 * numbered one after the other, see sync/hub.ts. Only its owner reads and writes it, until there is
 * more than one person to a project.
 *
 * The row is also what the platform keeps of a project for good, with `project_repos`: the list
 * people open their projects from, which reads nothing of the working copy. That one, `head` to
 * `dirty_since` here with `project_updates` and `project_snapshots`, can go once the project is
 * archived and nobody opened it for long, and come back from the repository (`copy_state`,
 * `generation`): the row stays.
 */
export const projects = pgTable(
  "projects",
  {
    /** What the editor that connected it named it: 128 random bits, see `newSyncId`. */
    id: text("id").primaryKey(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /**
     * The id in its animaquill.json, which it has to keep: copies of a project share it, as a
     * folder imported twice, so it is not unique here.
     */
    projectId: text("project_id").notNull(),
    /** What people call it, as of the last snapshot, for a list of projects. */
    name: text("name").notNull(),
    /**
     * What it says about itself (`description` of its animaquill.json), cut short, as of its last
     * change: the start page shows it on its card. Empty where it says nothing.
     */
    description: text("description").notNull().default(""),
    /** The number of its last update. */
    head: count("head").notNull().default(0),
    /** What stands for its updates up to `head`, see `digestOf` in sync/hub.ts. */
    digest: text("digest").notNull().default(""),
    /** How large it is, about: its last snapshot and the updates after it, in bytes. */
    bytes: count("bytes").notNull().default(0),
    createdAt: moment("created_at").notNull().defaultNow(),
    updatedAt: moment("updated_at").notNull().defaultNow(),
    /**
     * Since when it has changes that are not saved to GitHub: set with the first update after the
     * last archive, in the same statement that takes the update, see `SyncHub` and archive/.
     */
    dirtySince: moment("dirty_since"),
    /**
     * Whether the working copy is here, see `CopyState`. The hub reads nothing of a project that is
     * not "live". It lets go of a copy (`SyncHub.release`) nobody opened for a week (sync/sweep.ts),
     * or as an admin says so; the worker makes it again from the repository (archive/rebuild.ts), as
     * a window comes for it.
     */
    copyState: text("copy_state").$type<CopyState>().notNull().default("live"),
    /**
     * Which working copy this is, from 1: one made again from the repository is another document
     * of Yjs, with the same content, and what a window has of the one before cannot go on with it.
     * Windows say which one they have, see "hello" of the protocol and `SyncHub`.
     */
    generation: integer("generation").notNull().default(1),
    /**
     * When a window last connected to it, written at most once an hour: `updated_at` only says
     * when it last changed, and a project people look at without changing it is not one nobody
     * opened for long.
     */
    openedAt: moment("opened_at"),
    /** What the last archive counted, see `ProjectStats`. Null until an archive says. */
    stats: jsonb("stats").$type<ProjectStats>(),
    /** When the platform let go of the working copy, for "released". */
    releasedAt: moment("released_at"),
    /** Where the working copy was when the platform last let go of it, see `ReleasedFrom`. */
    releasedFrom: jsonb("released_from").$type<ReleasedFrom>(),
    /**
     * Why making the working copy from the repository failed the last time, see `CopyProblem`: gone
     * once it is made.
     */
    copyProblem: jsonb("copy_problem").$type<CopyProblem>(),
    /**
     * Tries in a row to make the working copy from the repository that did not come to one, as
     * the worker begins each (archive/rebuild.ts): also those it did not live through. Back to 0
     * once one does.
     */
    rebuildAttempts: integer("rebuild_attempts").notNull().default(0),
    /** When the worker began the try it is on, while "restoring": null where none runs. */
    rebuildStartedAt: moment("rebuild_started_at"),
    /**
     * People asked for the copy to be made from the branch as it is, not from the last archive, as
     * after they put the repository right (sync/wake.ts): for the next try only.
     */
    rebuildFromBranch: boolean("rebuild_from_branch").notNull().default(false),
    /**
     * A repository is being linked to it, until this time at most: what the platform holds the
     * project with while it asks GitHub, as making a repository there, so that taking the project
     * away meanwhile does not leave that repository there for nobody (`RepositoryService.link`,
     * `SyncHub.remove`). Past it, it counts for nothing, as after a process that died.
     */
    linkingUntil: moment("linking_until"),
  },
  (table) => [
    index("projects_owner").on(table.ownerId, table.updatedAt),
    check("projects_head", sql`${table.head} >= 0`),
    check("projects_copy_state", sql`${table.copyState} in ('live', 'released', 'restoring')`),
    check("projects_generation", sql`${table.generation} >= 1`),
  ],
);

/**
 * The ids of projects that were taken away, see `SyncHub.remove`: for a week (`deletedKeptMs`), no
 * project is made under one of them. A window that still says "make it" for such an id, as one
 * whose request was on its way when the project went, or one that kept its note to make it for
 * days, would bring back a project nobody has any more. Editors make a new id each time they
 * connect a project, so nothing they mean to make is turned away for this. Only the id, whose it
 * was and when: nothing of what was in the project. After the week they count for nothing, and go
 * with the hourly sweep (`SyncHub.forgetDeleted`, sync/sweep.ts), or before that with their
 * person. The id of a project that never was is noted too, where the editor asked to take it away:
 * its request to make it may still be on its way.
 */
export const deletedProjects = pgTable(
  "deleted_projects",
  {
    /** The id the project had on the platform, see `projects.id`. */
    id: text("id").primaryKey(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    deletedAt: moment("deleted_at").notNull().defaultNow(),
  },
  // How many a person had noted lately is counted by it, see `SyncHub.remove`.
  (table) => [index("deleted_projects_owner").on(table.ownerId, table.deletedAt)],
);

/**
 * The changes of a project as the platform took them, in order: what an editor sent, with who made
 * it, from where, and on which update of the platform. The first one is the whole project as it was
 * connected. Older ones go once a snapshot has them, see `projectSnapshots`.
 */
export const projectUpdates = pgTable(
  "project_updates",
  {
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    seq: count("seq").notNull(),
    /** What stands for this update and every one before it, see `digestOf` in sync/hub.ts. */
    digest: text("digest").notNull(),
    /** What it changed, as an update of Yjs. */
    data: bytes("data").notNull(),
    /** "first", "user", "folder", "ai", "other" or "repair", see `SyncKind`. */
    kind: text("kind").notNull(),
    /** Which browser sent it, as it names itself. */
    device: text("device").notNull(),
    /** Which window of it made the change. */
    window: text("window").notNull(),
    /** The last update of the platform that the window had when it made the change. */
    base: count("base").notNull(),
    /** Made without the latest of the platform, such as offline. */
    behind: boolean("behind").notNull().default(false),
    /** When the window made it, as its clock says. */
    madeAt: moment("made_at"),
    createdAt: moment("created_at").notNull().defaultNow(),
    /**
     * The batch of the platform's own that it is of, see `projectBatches`: what windows hear it
     * as (`by` of "update"). Null for what windows sent.
     */
    batch: text("batch"),
  },
  (table) => [primaryKey({ columns: [table.projectId, table.seq] })],
);

/**
 * A project as it was after an update, whole. "compact": the updates before it are not needed any
 * more, and go after the next one. "before-merge": as it was before changes that were made without
 * the latest of the platform came in, so that what they replaced can be found again.
 */
export const projectSnapshots = pgTable(
  "project_snapshots",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    seq: count("seq").notNull(),
    /** The digest of the update at `seq`. */
    digest: text("digest").notNull(),
    state: bytes("state").notNull(),
    reason: text("reason").notNull(),
    /** For "before-merge": the browser whose changes came in after it. */
    device: text("device"),
    createdAt: moment("created_at").notNull().defaultNow(),
  },
  (table) => [index("project_snapshots_project").on(table.projectId, table.reason, table.seq)],
);

/** The kinds of pictures a cover can be, see `projectCovers`. */
export type CoverType = "image/webp" | "image/jpeg";

/**
 * The cover of a project, for the cards of the start page on any computer: a small picture the
 * editor makes of a frame and sends, one for each project, which goes with it. A few dozen
 * kilobytes at most (`COVER_BYTES` of sync/covers.ts), so it is kept here, with the project and its
 * daily backup, not on a disk of its own. Lists name it by `etag`, the start of the SHA-256 of its
 * bytes, so that what a browser has is fetched again only once it changed; `duration_ms` is how
 * long the project's main timeline was then. `chosen`: people chose the picture themselves, and one
 * the editor makes does not take its place, see `putCover`.
 */
export const projectCovers = pgTable(
  "project_covers",
  {
    projectId: text("project_id")
      .primaryKey()
      .references(() => projects.id, { onDelete: "cascade" }),
    bytes: bytes("bytes").notNull(),
    type: text("type").$type<CoverType>().notNull(),
    etag: text("etag").notNull(),
    durationMs: integer("duration_ms"),
    chosen: boolean("chosen").notNull().default(false),
    updatedAt: moment("updated_at").notNull().defaultNow(),
  },
  (table) => [
    check("project_covers_type", sql`${table.type} in ('image/webp', 'image/jpeg')`),
    check("project_covers_bytes", sql`octet_length(${table.bytes}) <= 65536`),
    check("project_covers_duration", sql`${table.durationMs} >= 0`),
  ],
);

/**
 * The groups a person sorts their projects into on the start page, by an id the editor made (`id`,
 * unique for the person only), as sync/organize.ts keeps them: each change is kept where it is
 * later than the one before (`at`, by the platform's clock), and one that is taken away stays, as
 * such (`deleted`), so that a computer that still has it as it was is not taken for one that makes
 * it anew. No two that are there have one name, whatever the case or width of their letters
 * (`name_key`, see `groupNameKey`).
 */
export const projectGroups = pgTable(
  "project_groups",
  {
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    id: text("id").notNull(),
    name: text("name").notNull(),
    nameKey: text("name_key").notNull(),
    deleted: boolean("deleted").notNull().default(false),
    /** When it was last made, renamed or taken away, as the editor said, by the platform's clock. */
    at: moment("at").notNull(),
    createdAt: moment("created_at").notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.ownerId, table.id] }),
    uniqueIndex("project_groups_name")
      .on(table.ownerId, table.nameKey)
      .where(sql`not ${table.deleted}`),
    check("project_groups_id", sql`${table.id} ~ '^[A-Za-z0-9_-]{1,64}$'`),
    check("project_groups_name_length", sql`char_length(${table.name}) between 1 and 60`),
  ],
);

/**
 * How a person organises a project of the platform on the start page: whether it is starred, and
 * which of their groups it is in (null: none), each with when it last changed (`star_at`,
 * `group_at`), as sync/organize.ts keeps them, each field on its own. Of the person (`user_id`):
 * a project that several people have one day is organised by each as they like. Goes with the
 * project, and with the person. A group that is taken away stays (`project_groups.deleted`), so
 * what says it is in one always leads to a row; a project in one that is taken away is in none.
 */
export const projectMarks = pgTable(
  "project_marks",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    starred: boolean("starred"),
    starAt: moment("star_at"),
    groupId: text("group_id"),
    groupAt: moment("group_at"),
    /** When the person last opened it, on any computer: "最近打开". */
    openedAt: moment("opened_at"),
    updatedAt: moment("updated_at").notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.projectId] }),
    foreignKey({
      columns: [table.userId, table.groupId],
      foreignColumns: [projectGroups.ownerId, projectGroups.id],
      name: "project_marks_group_fk",
    }),
    index("project_marks_group").on(table.userId, table.groupId),
    check("project_marks_star", sql`(${table.starred} is null) = (${table.starAt} is null)`),
    check("project_marks_group_at", sql`${table.groupId} is null or ${table.groupAt} is not null`),
  ],
);

/** Why archiving a project to its repository stopped until someone does something about it. */
export type PauseReason =
  /** Files of the project were changed on GitHub, see archive/plan.ts. */
  | "diverged"
  /** The repository is not there any more, or the App may not touch it now. */
  | "gone"
  /**
   * A repository of the server's own does not read as Git: an object is not what its name says, or
   * not there (archive/local/). It is put aside as people start archiving over.
   */
  | "broken"
  /** The App is not installed on the account any more. */
  | "uninstalled"
  | "suspended"
  /** The repository is archived on GitHub, and so read-only. */
  | "archived"
  /** GitHub does not let the branch move, as a protected branch or a ruleset: `detail` says why. */
  | "protected"
  /** The repository is on another account now than the one it was linked on. */
  | "transferred"
  /** animaquill.json is not what the format says: nothing gets saved. */
  | "manifest"
  /** What would be saved does not read as a project, see `readProject`. */
  | "invalid"
  /**
   * Both the editor and GitHub changed the same thing, and people have not chosen yet which stays,
   * see `repo_conflicts`: what GitHub has stays as it is meanwhile.
   */
  | "conflicts"
  /** Files on GitHub that the merge could not take in, see `project_repos.blocked`. */
  | "blocked"
  /**
   * The project has locked tags, and a merge writes nothing into such a project: the files wait in
   * `project_repos.blocked`, and are merged once the project changes (see `CONTENT_REASONS`).
   */
  | "locked"
  /**
   * The branch on GitHub does not go on from what the platform has of it any more: forced, set back
   * to an older commit, or a history of its own. Nothing is merged by itself, as that would bring
   * back commits people took away on purpose (a password committed by mistake): people choose,
   * see `Diverged.base`.
   */
  | "rewritten"
  /** What changed on GitHub is more than one merge takes, see `SyncLimits.mergeFiles`. */
  | "too-large"
  /** The merge itself did not take the changes, as the platform said: `detail` says why. */
  | "unmerged";

/**
 * Which side stays where the editor and GitHub changed the same thing, as people chose for a
 * project: the other one goes into the list of conflicts either way.
 */
export type MergePrefer = "editor" | "github";

/** A file on GitHub that a merge did not take in, see `project_repos.blocked`. */
export interface BlockedFile {
  readonly path: string;
  /**
   * "invalid": not what the format says, or it would break the project; "unreadable": no text the
   * editor reads (not UTF-8, larger than a merge reads, a link or a submodule), never merged;
   * "locked": the project has locked tags, so nothing was merged into it.
   */
  readonly reason: string;
  readonly detail?: string;
  /**
   * The commit whose version of the file the next merge of it goes from: the one before GitHub
   * changed it into what could not be taken in. Missing in rows from before it was kept.
   */
  readonly baseSha?: string;
}

/**
 * Why a repository is not there to the App any more, where GitHub said: "deleted", it is not on
 * GitHub any more; "removed", people took it out of what the App may touch, and it is still theirs.
 */
export type GoneCause = "deleted" | "removed";

/** What the commit of an archive is that went to GitHub, until the branch is known to have it. */
export interface PendingArchive {
  readonly parent: string;
  readonly seq: number;
  readonly kind: string;
  readonly changed: number;
  readonly removed: number;
  readonly kept: readonly string[];
  readonly byUser: string | null;
  /** The pointers of large files of the platform's that the commit has, see `lfs_paths`. */
  readonly lfsPaths?: readonly string[];
  /**
   * For the commit of an archive after a merge from GitHub: the commit of GitHub's it goes on from
   * (`merged_sha` then, its first parent), and the archive of the project as it was before the
   * merge, its second parent, where there is one.
   */
  readonly merged?: string;
  readonly ours?: string;
}

/** Files of the project that changed on GitHub, and on which commit, see `PauseReason`. */
export interface Diverged {
  readonly sha: string;
  readonly files: readonly string[];
  /**
   * Those of `files` that the commit does not have: taken away on GitHub. The rest it has, changed
   * or new. Rows from before this was kept have none.
   */
  readonly deleted?: readonly string[];
  /**
   * For "rewritten": the last commit both histories have, as GitHub says, which "merge what GitHub
   * has now" goes from; missing where they have none.
   */
  readonly base?: string;
  /**
   * Paused while merges from GitHub were on (the switch of the admin site): it stays paused when
   * they are, see `takeDue`. One without it paused before, and is looked at again then.
   */
  readonly merging?: boolean;
}

/**
 * Where the repositories of projects are kept: GitHub, or a Git repository of the server's own
 * (`local_dir`), see archive/repo-host.ts.
 */
export type RepoProvider = "github" | "local";

/**
 * The repository a project is saved to: by its number on its provider, as names change. The worker
 * archives the project into it (see archive/archiver.ts); `head_sha` is the last commit the
 * platform knows the branch to have of its own, and `pending_sha` one it made and is about to move
 * the branch to, so that a crash in between is told apart from a push elsewhere.
 */
export const projectRepos = pgTable(
  "project_repos",
  {
    projectId: text("project_id")
      .primaryKey()
      .references(() => projects.id, { onDelete: "cascade" }),
    /** The installation of the GitHub App that reaches the repository: only for GitHub. */
    installationId: githubNumber("installation_id"),
    /** Its number on `provider`: one project at most is saved to a repository. */
    repoId: githubNumber("repo_id").notNull(),
    /** The account the repository is on, by its number: a login can change. */
    ownerId: githubNumber("owner_id").notNull(),
    /** Names as they were when last seen, for showing only. */
    ownerLogin: text("owner_login").notNull(),
    name: text("name").notNull(),
    /** The default branch, which archives go to. */
    branch: text("branch").notNull(),
    private: boolean("private").notNull(),
    /** Whether the platform made it, for the project, or people chose one they had. */
    createdHere: boolean("created_here").notNull(),
    linkedBy: uuid("linked_by").references(() => users.id, {
      onDelete: "set null",
    }),
    linkedAt: moment("linked_at").notNull().defaultNow(),
    /** "ready" or "paused". */
    state: text("state").notNull().default("ready"),
    pauseReason: text("pause_reason").$type<PauseReason>(),
    /** A short word for people about why, or about the last failure: never a token or a signature. */
    detail: text("detail"),
    pausedAt: moment("paused_at"),
    /**
     * The update of the project the archive that paused had: a pause for what the project had
     * ("manifest", "invalid") ends once there is a newer one, see `takeDue`.
     */
    pausedSeq: count("paused_seq"),
    /**
     * People asked for an archive (linking, "archive now"), and it has not been done yet: whatever
     * job of the project runs next does it, and the scan queues one should none be waiting.
     */
    requestedAt: moment("requested_at"),
    requestedBy: uuid("requested_by").references(() => users.id, {
      onDelete: "set null",
    }),
    /** For "diverged": which files changed on GitHub, on which commit, see `Diverged`. */
    diverged: jsonb("diverged").$type<Diverged>(),
    headSha: text("head_sha"),
    /**
     * The commit on GitHub that people chose the project over (“以项目为准继续存档”): the archive on
     * top of it writes the project's AGENTS.md over the one there, which no archive wrote. Only
     * that choice sets it, and an archive that lands takes it away.
     */
    replacedSha: text("replaced_sha"),
    pendingSha: text("pending_sha"),
    pending: jsonb("pending").$type<PendingArchive>(),
    /** The update of the project that the last archive has. */
    archivedSeq: count("archived_seq").notNull().default(0),
    archivedAt: moment("archived_at"),
    /** Archives that failed in a row, and when the next try is. */
    failures: integer("failures").notNull().default(0),
    nextAttemptAt: moment("next_attempt_at"),
    /** Pointers of large files that archives wrote, from step 14.2 on. */
    lfsPaths: jsonb("lfs_paths").$type<string[]>().notNull().default([]),
    /** Which Git platform the repository is on: `repo_id` is its number there. */
    provider: text("provider").$type<RepoProvider>().notNull().default("github"),
    /**
     * For "local": the folder of the bare repository, from the data folder of the server. Null for
     * any other.
     */
    localDir: text("local_dir"),
    /**
     * For "local": when the repository was last read through from its tip, every object checked
     * (archive/local/), which is done once a week. Null: not yet.
     */
    verifiedAt: moment("verified_at"),
    /**
     * When the platform last looked at the repository on GitHub, as an archive or a check does: the
     * names and `private` are as they were then. Null: not since this was kept.
     */
    checkedAt: moment("checked_at"),
    /**
     * For a pause of "gone", what a webhook said became of the repository, see `GoneCause`. Null
     * where none said: an archive that finds the repository not there cannot tell which it is.
     */
    goneCause: text("gone_cause").$type<GoneCause>(),
    /**
     * Since when the repository cannot be used, as the platform first found it: archiving paused
     * for one of `UNUSABLE_REASONS` (archive/links.ts). It stays as it is while the reason changes,
     * and goes once archiving goes on, another repository is chosen, or archiving pauses for
     * another reason. Seven days after it, the project goes.
     */
    unusableSince: moment("unusable_since"),
    /**
     * When an archive first found the repository not there to the App, or the App not installed or
     * suspended, without GitHub saying so in a webhook: it pauses only where the next archive, a few
     * minutes on, finds the same (`Archiver`), as GitHub can answer 404 for a while for anything.
     * Gone once the repository is reached, or archiving pauses.
     */
    unusableSeenAt: moment("unusable_seen_at"),
    /**
     * For a repository that cannot be used: when GitHub is asked again by itself whether it can
     * (archive/recheck.ts), how many times it said no since, and when it was last asked.
     */
    recheckAt: moment("recheck_at"),
    rechecks: integer("rechecks").notNull().default(0),
    recheckedAt: moment("rechecked_at"),
    /**
     * Since when archives fail for what is nobody's to put right but GitHub's or the platform's: GitHub
     * down or limiting, no network, or an error of the platform's own (see `Archiver`). Set by the
     * first such failure, and gone with an archive that gets through, or a pause.
     */
    transientSince: moment("transient_since"),
    /** Which side stays where both changed the same thing, see `MergePrefer`. */
    prefer: text("prefer").$type<MergePrefer>().notNull().default("editor"),
    /**
     * The commit on GitHub whose changes are in the project, merged since the last archive
     * (`repo_merges`): what the next archive goes on from. Null where nothing was merged since.
     */
    mergedSha: text("merged_sha"),
    /** Files on GitHub that the last merge did not take in, see `BlockedFile`. */
    blocked: jsonb("blocked").$type<BlockedFile[]>().notNull().default([]),
    /**
     * People chose to merge what GitHub has after its history was rewritten ("rewritten"): the
     * commit both histories have, which the next merge goes from in place of `merged_sha` or
     * `head_sha`. The archive after it has GitHub's commit as its one parent, never the platform's
     * archive before, which would bring back what was taken away. Gone once that archive lands.
     */
    mergeFrom: text("merge_from"),
    /**
     * Files people chose to take out of the project before the archive that goes on with the
     * editor's content (`replace` with `drop`): files GitHub took away in a rewritten history, such
     * as a secret, which that archive would otherwise write back. The next archive takes them out
     * as a merge of its own (`RepoMergeResult.drops`) before it writes anything. Null for none.
     */
    dropping: jsonb("dropping").$type<string[]>(),
    /**
     * The merge that takes `dropping` out (`repo_merges`, `RepoMergeResult.drops`), once it is
     * made: `dropping` stays until it is applied (the hub clears both then), and an archive that
     * finds it refused pauses ("unmerged") rather than write the files back.
     */
    droppingMerge: uuid("dropping_merge"),
    /**
     * The newest merge (its `seq`) when people last went on with the editor's content
     * (`replace`), which sets `archived_seq` back to 0: an archive keeps no project from before a
     * merge as old as that, or older, in the history it writes (E, see `Archiver`).
     */
    mergeFloor: count("merge_floor"),
  },
  (table) => [
    check("project_repos_state", sql`${table.state} in ('ready', 'paused')`),
    check("project_repos_gone_cause", sql`${table.goneCause} in ('deleted', 'removed')`),
    check("project_repos_prefer", sql`${table.prefer} in ('editor', 'github')`),
    unique("project_repos_provider_repo").on(table.provider, table.repoId),
    check("project_repos_provider", sql`${table.provider} in ('github', 'local')`),
    // Only GitHub has installations; only a repository of the server's own has a folder.
    check(
      "project_repos_installation",
      sql`(${table.provider} = 'github') = (${table.installationId} is not null)`,
    ),
    check(
      "project_repos_local_dir",
      sql`(${table.provider} = 'local') = (${table.localDir} is not null)`,
    ),
  ],
);

/** The numbers of the repositories of the server's own (`project_repos.repo_id` of "local"). */
export const localRepoIds = pgSequence("local_repo_ids");

/** The archives of a project that went to its repository, one commit each. */
export const archives = pgTable(
  "archives",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    /** The repository, as `project_repos` says it: `repo_id` is its number on `provider`. */
    provider: text("provider").$type<RepoProvider>().notNull().default("github"),
    repoId: githubNumber("repo_id").notNull(),
    /** The update of the project it has. */
    seq: count("seq").notNull(),
    sha: text("sha").notNull(),
    parentSha: text("parent_sha"),
    /** "first", "auto" or "manual". */
    kind: text("kind").notNull(),
    /** What people called it, from step 17 on. */
    name: text("name"),
    /** Files written, and files taken away. */
    changed: integer("changed").notNull(),
    removed: integer("removed").notNull(),
    /** Documents that could not be written as they are: the repository keeps what it had. */
    kept: jsonb("kept").$type<string[]>().notNull().default([]),
    byUser: uuid("by_user").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: moment("created_at").notNull().defaultNow(),
  },
  (table) => [
    index("archives_project").on(table.projectId, table.createdAt),
    check("archives_provider", sql`${table.provider} in ('github', 'local')`),
  ],
);

/** What became of a merge from GitHub, see `repoMerges`. */
export type RepoMergeState = "ready" | "applied" | "superseded" | "refused";

/** What a merge came to, kept with it, see `repoMerges.result`. */
export interface RepoMergeResult {
  /**
   * Files of the commit that the worker did not read into the merge (`BlockedFile`, "unreadable"):
   * noted with the merge, and blocked once it is merged.
   */
  readonly unreadable?: readonly BlockedFile[];
  /**
   * The blob of AGENTS.md on GitHub that the merge has, where it has that file: what an archive
   * may write over afterwards, as it came into the project, see `Archiver`.
   */
  readonly instructions?: string;
  /**
   * The merge whose changes this one takes back out, as they came from history that was taken
   * away on GitHub (`merge_from`, see `Archiver`): it leaves `merged_sha` as it is.
   */
  readonly undoes?: string;
  /**
   * The files people chose to take out of the project before an archive with the editor's content
   * (`project_repos.dropping`): it leaves `merged_sha` as it is, and no archive keeps what was
   * before it (E).
   */
  readonly drops?: readonly string[];
  /** Each file of the batch, and what became of it: merged, blocked, ignored. */
  readonly files?: readonly { readonly path: string; readonly status: string }[];
  /** Why none of it came in, where it was refused: a code of the platform's or of the merge. */
  readonly refused?: string;
  readonly detail?: string;
  /** How long it took in the thread of the working copies, in milliseconds. */
  readonly ms?: number;
}

/**
 * Changes on GitHub to merge into a project, one commit at a time: the worker writes one "ready"
 * with what each file was and is (`input`), and the API merges it into the working copy
 * (sync/hub.ts, `SyncHub.mergeRepo`), in the same transaction as the update it makes, so once at
 * most. A newer push on GitHub makes an older one "superseded".
 */
export const repoMerges = pgTable(
  "repo_merges",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    /** The repository, as `project_repos` says it: `repo_id` is its number on `provider`. */
    provider: text("provider").$type<RepoProvider>().notNull().default("github"),
    repoId: githubNumber("repo_id").notNull(),
    fromSha: text("from_sha").notNull(),
    toSha: text("to_sha").notNull(),
    state: text("state").$type<RepoMergeState>().notNull().default("ready"),
    /** The files, gzipped JSON of `[{path, base, theirs}]`: gone once it is merged. */
    input: bytes("input"),
    /** The update of the project it made, and the one before it. */
    seq: count("seq"),
    oursSeq: count("ours_seq"),
    result: jsonb("result").$type<RepoMergeResult>(),
    createdAt: moment("created_at").notNull().defaultNow(),
    appliedAt: moment("applied_at"),
  },
  (table) => [
    uniqueIndex("repo_merges_ready")
      .on(table.projectId)
      .where(sql`${table.state} = 'ready'`),
    index("repo_merges_project").on(table.projectId, table.createdAt),
    check(
      "repo_merges_state",
      sql`${table.state} in ('ready', 'applied', 'superseded', 'refused')`,
    ),
    check("repo_merges_provider", sql`${table.provider} in ('github', 'local')`),
  ],
);

/**
 * A batch of changes the platform made to a project itself, such as a merge from GitHub (its id is
 * the merge's): what to tell windows of it (`project_updates.batch`, `by` of "update"), what it
 * wrote, to find what changes made without it took away (`writes`, see `PlatformBatch` of
 * @animaquill/core), and what it takes to take it back (`undo`, an `UndoRecord` of core, of the
 * format `format_version`). Its updates are kept as long as the project's.
 */
export const projectBatches = pgTable(
  "project_batches",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    /**
     * "repo", a merge from GitHub; "drop", files people chose to take out of the project as they
     * went on with the editor's content, which undoing (2E) refuses: it would bring them back;
     * "undo" and "redo", taking one of those back as a whole, or doing it again (`undoes`), which
     * is a batch of its own, see `SyncHub.takeBack`.
     */
    kind: text("kind").notNull(),
    /**
     * For "undo" and "redo": the batch taken back, or done again, whose `undo` says how, and whose
     * `undone_at` says which way it is now. Null for any other.
     */
    undoes: text("undoes"),
    mergeId: uuid("merge_id").references(() => repoMerges.id, { onDelete: "set null" }),
    /** The update it made. */
    seq: count("seq").notNull(),
    label: text("label").notNull(),
    /** How many files it came from. */
    files: integer("files").notNull(),
    /** Gzipped JSON of the `PlatformBatch`. */
    writes: bytes("writes").notNull(),
    undo: jsonb("undo"),
    formatVersion: integer("format_version").notNull(),
    /** The project as it was right before it, see `project_snapshots` ("before-repo"). */
    snapshotId: uuid("snapshot_id"),
    createdAt: moment("created_at").notNull().defaultNow(),
    /** Taken back, and not done again since, see `undoes`. */
    undoneAt: moment("undone_at"),
  },
  (table) => [
    index("project_batches_project").on(table.projectId, table.createdAt),
    index("project_batches_undoes").on(table.undoes),
  ],
);

/** Whose side went in a conflict: what a merge or a batch wrote, or what an editor did. */
export type ConflictLost = "batch" | "change";

/**
 * Where both the editor and GitHub changed the same thing, and one of them stayed: found as the
 * merge is made ("merge"), or once a change made without it arrives ("late", see late-writes.ts of
 * core). `ours` is what the project has, `theirs` what went, as `MergeConflict` of core says them,
 * so that the editor takes the other side with `conflict.take`. A newer one of the same place makes
 * the older one "stale".
 */
export const repoConflicts = pgTable(
  "repo_conflicts",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    /** The merge it is of, while the platform keeps it. */
    mergeId: uuid("merge_id").references(() => repoMerges.id, { onDelete: "set null" }),
    /** The batch of the platform it is of, see `projectBatches`: the merge's id, for a merge. */
    batch: text("batch").notNull(),
    /** "merge" or "late". */
    source: text("source").notNull(),
    lost: text("lost").$type<ConflictLost>().notNull(),
    file: text("file").notNull(),
    path: jsonb("path").$type<string[]>().notNull(),
    label: text("label").notNull(),
    kind: text("kind").notNull(),
    lines: jsonb("lines"),
    around: jsonb("around"),
    ours: jsonb("ours"),
    theirs: jsonb("theirs"),
    /** Who made what stayed, where known: the kind of change and the browser, and when. */
    oursBy: text("ours_by"),
    oursAt: moment("ours_at"),
    theirsSha: text("theirs_sha"),
    theirsAt: moment("theirs_at"),
    /**
     * For what a change wrote into what the batch took away: the change as the editor sent it. What
     * went is only in that, as the copy keeps nothing of it, so the next such change of the same
     * place is read on top of it (`SyncHub`). Null for any other, or one that was too large, and
     * once the conflict is settled or stale for a week (sync/sweep.ts).
     */
    change: bytes("change"),
    state: text("state").notNull().default("open"),
    resolvedBy: uuid("resolved_by").references(() => users.id, { onDelete: "set null" }),
    resolvedAt: moment("resolved_at"),
    createdAt: moment("created_at").notNull().defaultNow(),
  },
  (table) => [
    index("repo_conflicts_open")
      .on(table.projectId)
      .where(sql`${table.state} = 'open'`),
    check("repo_conflicts_state", sql`${table.state} in ('open', 'ours', 'theirs', 'stale')`),
    check("repo_conflicts_lost", sql`${table.lost} in ('batch', 'change')`),
  ],
);

/**
 * Objects the large file storage (Git LFS) of a repository is known to have: the platform put them
 * there, or GitHub said it had them. An archive writes the pointer of an asset only to what is
 * here, see archive/pointers.ts, never one to an object that is not there. GitHub has no way to
 * take one object out of a repository's storage, so a row stays for as long as the repository's
 * number means anything.
 */
export const lfsObjects = pgTable(
  "lfs_objects",
  {
    repoId: githubNumber("repo_id").notNull(),
    /** The SHA-256 of the content, in lower-case hexadecimal, as Git LFS names it. */
    oid: text("oid").notNull(),
    size: count("size").notNull(),
    confirmedAt: moment("confirmed_at").notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.repoId, table.oid] })],
);

/** How an upload into the large file storage goes, see `lfsUploads`. */
export type LfsUploadState = "receiving" | "received" | "pushing" | "done" | "failed" | "expired";

/** The states of an upload that has a staging file, of which one per object and repository. */
export const OPEN_LFS_STATES: readonly LfsUploadState[] = ["receiving", "received", "pushing"];

/**
 * A file on its way into the large file storage of a project's repository through the platform
 * (3.2.3): the editor sends it in pieces into a file of the staging volume, which is read through
 * for its hash once all of it is there, and the worker puts it into the storage. See lfs/. One open
 * upload of an object in a repository at a time, which another computer goes on with.
 */
export const lfsUploads = pgTable(
  "lfs_uploads",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    repoId: githubNumber("repo_id").notNull(),
    /** The SHA-256 of the file, in lower-case hexadecimal, as Git LFS names it. */
    oid: text("oid").notNull(),
    size: count("size").notNull(),
    /** Bytes of the staging file from its start that are on the disk (fdatasync). */
    received: count("received").notNull().default(0),
    state: text("state").$type<LfsUploadState>().notNull(),
    /** For "failed", and "expired" after trying: why, see `LfsFailure` of the editor's host. */
    error: text("error"),
    /** A few words of GitHub's about it, for people: never a token or an address. */
    detail: text("detail"),
    /** Tries to put it into the storage so far, and when the next one may be. */
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: moment("next_attempt_at"),
    /** When all of it was in and checked: it is tried for a day from then, see lfs/push.ts. */
    receivedAt: moment("received_at"),
    createdAt: moment("created_at").notNull().defaultNow(),
    /** The last piece that came, or the last try to put it into the storage. */
    updatedAt: moment("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("lfs_uploads_open")
      .on(table.repoId, table.oid)
      .where(sql`state in ('receiving', 'received', 'pushing')`),
    index("lfs_uploads_user").on(table.userId, table.state),
    index("lfs_uploads_state").on(table.state, table.updatedAt),
    // Those of a project go with it, found without reading the table.
    index("lfs_uploads_project").on(table.projectId),
    check(
      "lfs_uploads_state",
      sql`${table.state} in ('receiving', 'received', 'pushing', 'done', 'failed', 'expired')`,
    ),
    check(
      "lfs_uploads_received",
      sql`${table.received} >= 0 and ${table.received} <= ${table.size}`,
    ),
  ],
);

/**
 * Settings that admins change on the admin site, such as those of AI from phase 6.3: one row a key,
 * the value as JSON that the code checks, and a version that goes up with each change. What is not
 * here has the default the code has.
 */
export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  version: integer("version").notNull().default(1),
  updatedBy: uuid("updated_by").references(() => users.id, {
    onDelete: "set null",
  }),
  updatedAt: moment("updated_at").notNull().defaultNow(),
});

/**
 * The AI settings of a person that go with their account, as entries, each with when it last
 * changed, see me/ai-sync.ts: `{<name>: {at, value} | {at, deleted: true}}`, times in milliseconds
 * by the platform's clock. Nothing secret is ever in them: keys, addresses and headers are in
 * `user_ai_keys`, sealed. `enabled`: whether they went with the account for all devices, before
 * that was up to each device (0.3.72); read by nothing any more. `revision` moves on with every
 * change, for asking whether anything did. Goes with the person.
 */
export const userAiSettings = pgTable(
  "user_ai_settings",
  {
    userId: uuid("user_id")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    enabled: boolean("enabled").notNull().default(true),
    revision: bigint("revision", { mode: "number" }).notNull().default(0),
    /** The format of the entries, see `AI_SYNC_FORMAT`: a newer editor's is not written over. */
    format: integer("format").notNull().default(1),
    entries: jsonb("entries").notNull().default({}),
    /** How large the entries are as JSON, in bytes. */
    size: integer("size").notNull().default(0),
    updatedAt: moment("updated_at").notNull().defaultNow(),
  },
  (table) => [check("user_ai_settings_size", sql`${table.size} >= 0`)],
);

/**
 * What is secret of each AI service of a person that goes with their account (5.3 there): its key, address and headers, sealed with the master
 * key for its person and service (`ai-key`), so that the database and its backups alone do not open
 * them. `format` 1 is the key alone, as before 0.3.72; 2 is a `ServiceSecret` as JSON. One taken
 * away stays as such (`sealed` null), the newest 1000 of a person's, for devices that still have it
 * to take it away too. Goes with the person.
 */
export const userAiKeys = pgTable(
  "user_ai_keys",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    service: text("service").notNull(),
    sealed: bytes("sealed"),
    format: smallint("format").notNull().default(1),
    /**
     * When each part of it changed (`SecretTimes`, by the platform's clock), so that two devices
     * that each change another part keep both; null of one kept before 0.3.72, all as `at`.
     */
    fieldsAt: jsonb("fields_at"),
    /** When it last changed, as the editor said, by the platform's clock. */
    at: moment("at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.service] }),
    check("user_ai_keys_service", sql`${table.service} ~ '^[A-Za-z0-9_-]{1,100}$'`),
    check("user_ai_keys_format", sql`${table.format} in (1, 2)`),
  ],
);

/**
 * Conversations of a person with AI about a project of theirs on the platform (5.1 there): private
 * to the person, written whole over the revision they were read at. `summary` is what the list of
 * them shows, `body` the rest. Goes with the project and with the person.
 */
export const userChats = pgTable(
  "user_chats",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    chatId: text("chat_id").notNull(),
    revision: integer("revision").notNull(),
    summary: jsonb("summary").notNull(),
    body: jsonb("body").notNull(),
    size: integer("size").notNull(),
    /** When it was last written, by the platform's clock. */
    updatedAt: moment("updated_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.projectId, table.chatId] }),
    index("user_chats_project").on(table.projectId),
    check("user_chats_id", sql`${table.chatId} ~ '^[A-Za-z0-9_-]{1,100}$'`),
  ],
);

/**
 * The pictures of a person's conversations on the platform, see me/chat-images.ts: one row for each
 * picture of theirs, by the SHA-256 of its bytes, which are in the object storage at
 * `chat-images/u/<user id>/<hash>`. The same picture of a person is kept once, however many
 * conversations have it.
 *
 * - `state`: `uploading` from when the platform signed an address for it until it read it back and
 *   it was what was said (`ready`). Only a `ready` one can be referred to.
 * - `touched_at`: when it was made, or a conversation began or stopped referring to it. One nothing
 *   refers to goes 24 hours after that, as does one `uploading` 24 hours after `created_at`.
 */
export const userChatImages = pgTable(
  "user_chat_images",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    hash: text("hash").notNull(),
    bytes: integer("bytes").notNull(),
    type: text("type").notNull(),
    state: text("state").$type<"uploading" | "ready">().notNull(),
    createdAt: moment("created_at").notNull(),
    touchedAt: moment("touched_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.hash] }),
    index("user_chat_images_touched").on(table.touchedAt),
    check("user_chat_images_hash", sql`${table.hash} ~ '^[0-9a-f]{64}$'`),
    check("user_chat_images_bytes", sql`${table.bytes} > 0`),
    check("user_chat_images_state", sql`${table.state} in ('uploading', 'ready')`),
  ],
);

/**
 * Which conversation refers to which picture of its person, as the platform read it out of the
 * conversation as it was written (`user_chats.body`). Goes with the conversation; a picture that
 * something refers to cannot go.
 */
export const userChatImageRefs = pgTable(
  "user_chat_image_refs",
  {
    userId: uuid("user_id").notNull(),
    projectId: text("project_id").notNull(),
    chatId: text("chat_id").notNull(),
    hash: text("hash").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.userId, table.projectId, table.chatId, table.hash],
    }),
    foreignKey({
      columns: [table.userId, table.projectId, table.chatId],
      foreignColumns: [userChats.userId, userChats.projectId, userChats.chatId],
      name: "user_chat_image_refs_chat_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.userId, table.hash],
      foreignColumns: [userChatImages.userId, userChatImages.hash],
      name: "user_chat_image_refs_image_fk",
    }),
    index("user_chat_image_refs_image").on(table.userId, table.hash),
  ],
);

/**
 * What is of a person alone, one row each, which what is theirs takes as a lock (me/cloud.ts).
 *
 * - `organizer_sync`, `chats_sync`, their `*_epoch` and `prefs`: which cloud features a person had
 *   on for all their devices, before those were of each device (0.3.72). Read by nothing any more; to go in a later migration.
 */
export const userPrefs = pgTable("user_prefs", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  organizerSync: boolean("organizer_sync").notNull().default(true),
  organizerEpoch: integer("organizer_epoch").notNull().default(0),
  chatsSync: boolean("chats_sync").notNull().default(true),
  chatsEpoch: integer("chats_epoch").notNull().default(0),
  prefs: jsonb("prefs").notNull().default({}),
  /**
   * When the person said they know what putting files into the large file storage of their GitHub
   * account means (it cannot be taken out file by file, and it is their account's room), the first
   * time they did: never asked again, on any computer.
   */
  lfsAcknowledgedAt: moment("lfs_acknowledged_at"),
  updatedAt: moment("updated_at").notNull().defaultNow(),
});
