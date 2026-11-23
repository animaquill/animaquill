import { createHash } from "node:crypto";

/**
 * Where projects are archived, as the archive needs it and whatever the Git platform: one
 * repository, by a number that stays as it is renamed or moved, written as the platform (on GitHub,
 * the App). Writing is in two steps, so that the platform can note a commit before the branch has
 * it: a tree on top of the parent's, with the files that changed and those that go, and a commit;
 * then the branch, only if that is a fast-forward. See: GitHub's Git Data API now, another platform
 * with isomorphic-git later.
 */

export interface RepoPlace {
  /** The installation of the App that covers the repository. */
  readonly installationId: number;
  readonly repoId: number;
}

export interface RepoInfo {
  readonly id: number;
  /** The account it is on, by its number, and by its name now. */
  readonly ownerId: number;
  readonly owner: string;
  readonly name: string;
  /** The default branch, which archives go to. */
  readonly branch: string;
  readonly private: boolean;
  /** Archived on GitHub: read-only. */
  readonly archived: boolean;
  /** Where people see it. */
  readonly url: string;
}

export interface TreeEntry {
  /** From the top of the tree that was listed. */
  readonly path: string;
  readonly mode: string;
  /** "commit": a submodule. */
  readonly type: "blob" | "tree" | "commit";
  readonly sha: string;
  /** Bytes, for a blob. */
  readonly size?: number;
}

export interface CommitInfo {
  readonly sha: string;
  readonly tree: string;
  readonly parents: readonly string[];
  readonly message: string;
}

/**
 * How one commit stands to another, as GitHub's compare API says it of `head` against `base`:
 * "ahead", `head` goes on from `base` (`base` is one of its ancestors); "identical", the same
 * commit; "behind", `head` is one of the ancestors of `base`; "diverged", neither, with the last
 * commit both have (`mergeBase`), where there is one.
 */
export interface Comparison {
  readonly status: "ahead" | "behind" | "identical" | "diverged";
  readonly mergeBase?: string;
}

/** Who a commit is by, as Git has it. */
export interface Person {
  readonly name: string;
  readonly email: string;
}

/** A file of a new tree with this text, or one that goes. */
export type TreeChange =
  | { readonly path: string; readonly text: string }
  | { readonly path: string; readonly remove: true };

/**
 * An object of the large file storage of a repository (Git LFS): the SHA-256 of its content in
 * lower-case hexadecimal, and its size.
 */
export interface LfsObject {
  readonly oid: string;
  readonly size: number;
}

/**
 * Where to put or get an object, as the storage says: an address, with headers it wants (which can
 * carry a credential of their own: neither goes into a log or an answer), until `expiresAt`.
 */
export interface LfsAction {
  readonly href: string;
  readonly header: Readonly<Record<string, string>>;
  /** Milliseconds since 1970, where the storage says. */
  readonly expiresAt?: number;
}

/** What the large file storage says about an object it was asked about. */
export type LfsAnswer =
  /**
   * It has an object of that oid: nothing to put there. `size`, where it says one, can be the size
   * it was asked about and nothing more: how large what it has is, `lfsSizes` finds out.
   */
  | { readonly kind: "present"; readonly size?: number }
  /** Where to put it, and where to say so afterwards, where it wants that. */
  | { readonly kind: "upload"; readonly upload: LfsAction; readonly verify?: LfsAction }
  | { readonly kind: "download"; readonly download: LfsAction }
  /** It does not take, or does not have, the object: an HTTP status, and its words. */
  | { readonly kind: "refused"; readonly code: number; readonly message: string };

/** The large file storage of the account has no room left, or no traffic: nothing goes in now. */
export class LfsQuota extends Error {
  override name = "LfsQuota";
}

export interface RepoSession {
  /** The repository as it is now. Rejects with RepoPaused "gone" where it is not there to the App. */
  info(): Promise<RepoInfo>;
  /**
   * The last commit of a branch, or undefined for a repository without commits. A branch that is
   * not there in a repository that has commits rejects with RepoPaused "gone".
   */
  tip(branch: string): Promise<string | undefined>;
  /** A commit, or undefined where the repository does not have it (any more). */
  commit(sha: string): Promise<CommitInfo | undefined>;
  /**
   * How `head` stands to `base`, see `Comparison`. Undefined where either is not in the repository
   * (any more), or the two have no commit in common: GitHub answers both alike.
   */
  compare(base: string, head: string): Promise<Comparison | undefined>;
  /**
   * What a tree has: with `recursive`, everything below it, files and folders. All of it, or it
   * rejects: an archive never works from part of a tree.
   */
  tree(sha: string, options?: { readonly recursive?: boolean }): Promise<readonly TreeEntry[]>;
  blob(sha: string): Promise<Uint8Array>;
  /**
   * Many files of a commit at once: the bytes of each of `entries`, as a listing of its tree has
   * them, by path. Each is checked against the sha its entry says, so what comes is what the commit
   * has, or it rejects. Only blobs: links and submodules are not files to read. All of them, or it
   * rejects.
   */
  files(commit: string, entries: readonly TreeEntry[]): Promise<ReadonlyMap<string, Uint8Array>>;
  /**
   * A tree: `base` with these changes. Resolves to its sha. What goes is taken away before what
   * comes is written, so that a file can become a folder of the same name, or the other way round.
   */
  writeTree(base: string, changes: readonly TreeChange[]): Promise<string>;
  writeCommit(commit: {
    readonly tree: string;
    readonly parents: readonly string[];
    readonly message: string;
    readonly author: Person;
    readonly at: Date;
  }): Promise<string>;
  /**
   * Moves a branch on to `sha`, only as a fast-forward: never anything else. "behind" where it is
   * not one, as the branch moved meanwhile; `refused`, with what the platform said, where it does
   * not let the branch move at all, as a protected branch.
   */
  advance(branch: string, sha: string): Promise<"moved" | "behind" | { readonly refused: string }>;
  /**
   * The first commit of an empty repository, of one file, on its default branch. Resolves to the
   * commit, or undefined where the repository has commits by now.
   */
  start(
    file: { readonly path: string; readonly text: string },
    message: string,
    author: Person,
    at: Date,
  ): Promise<string | undefined>;
  /**
   * Asks the large file storage of the repository about objects (Git LFS's batch API, basic
   * transfers): for "upload", what it has and where to put the rest; for "download", where to get
   * them. An answer for each object, in their order. Rejects with LfsQuota where the storage of the
   * account is full, and RepoPaused where the repository is not there to the App.
   */
  lfsBatch(
    operation: "upload" | "download",
    objects: readonly LfsObject[],
  ): Promise<readonly LfsAnswer[]>;
  /**
   * How large the storage has each of these objects, in their order, as the storage itself says of
   * what it keeps, whatever size it was asked about: undefined for one it does not have. An object
   * is only noted as there (`lfs_objects`) with the size found here, as a pointer says both, and
   * the storage goes by the oid alone when it says it has one. Each oid once in a call: the storage
   * answers by oid. Rejects as `lfsBatch` does, and with GitHubUnavailable where the storage could
   * not be asked.
   */
  lfsSizes(objects: readonly LfsObject[]): Promise<readonly (number | undefined)[]>;
  /**
   * Done with the repository: whatever the session holds of it goes. Nothing for GitHub's, which
   * holds nothing; one that works on a clone of its own would take it away here.
   */
  close(): Promise<void>;
}

export interface RepoHost {
  /**
   * A session of a repository. `signal`: every call of it stops once that says so, as for a piece
   * of work that ran out of its time, and rejects then as for GitHub that could not be reached.
   */
  open(place: RepoPlace, options?: { readonly signal?: AbortSignal | undefined }): RepoSession;
}

/** Why archiving into a repository has to wait for people to do something. */
export type RepoTrouble = "gone" | "uninstalled" | "suspended" | "archived";

/** The repository cannot be written now, and will not be until someone does something. */
export class RepoPaused extends Error {
  override name = "RepoPaused";
  readonly reason: RepoTrouble;
  constructor(reason: RepoTrouble, message: string) {
    super(message);
    this.reason = reason;
  }
}

/**
 * The Git platform refused something that should have worked, such as a tree: not something people
 * can do anything about, so it is tried again later, as when the platform is down.
 */
export class RepoRefused extends Error {
  override name = "RepoRefused";
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** The SHA-1 that Git names a file of these bytes by. */
export const blobShaOf = (bytes: Uint8Array): string =>
  createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");

/** The bytes of a text as Git keeps them: UTF-8. */
export const bytesOf = (text: string): Buffer => Buffer.from(text, "utf8");
