import { createHash } from "node:crypto";
import type { Readable } from "node:stream";

/**
 * Where projects are archived, as the archive needs it and whatever the Git platform: one
 * repository, by a number that stays as it is renamed or moved, written as the platform (on GitHub,
 * the App). Writing is in two steps, so that the platform can note a commit before the branch has
 * it: a tree on top of the parent's, with the files that changed and those that go, and a commit;
 * then the branch, only if that is a fast-forward: GitHub's Git Data API now, other places that keep
 * repositories later.
 */

import { GitHubUnavailable } from "../github/client.ts";
import type { RepoProvider } from "../schema.ts";
import type { LocalGitRepoHost } from "./local/host.ts";

export type { RepoProvider };

/** A repository on GitHub, reached through an installation of the App. */
export interface GitHubPlace {
  readonly provider: "github";
  /** The installation of the App that covers the repository. */
  readonly installationId: number;
  readonly repoId: number;
}

/** A bare Git repository of the server's own, in its data folder. */
export interface LocalPlace {
  readonly provider: "local";
  readonly repoId: number;
  /** The folder of the repository, from the data folder of the server. */
  readonly dir: string;
}

/** Where a repository is: one of the providers, each with what it takes to reach one there. */
export type RepoPlace = GitHubPlace | LocalPlace;

/** A repository of a project as `project_repos` keeps it. */
export interface RepoRow {
  readonly provider: RepoProvider;
  readonly repoId: number;
  readonly installationId: number | null;
  readonly localDir: string | null;
}

/**
 * The place of a repository a project is saved to, from its row: the one way from what the
 * database keeps to a `RepoPlace`. The checks of `project_repos` keep a row from being anything
 * else; one that still is, is a mistake of the server's.
 */
export const placeOf = (row: RepoRow): RepoPlace => {
  if (row.provider === "github") {
    if (row.installationId === null)
      throw new Error(`the repository ${row.repoId} on GitHub has no installation`);
    return { provider: "github", installationId: row.installationId, repoId: row.repoId };
  }
  if (row.localDir === null) throw new Error(`the repository ${row.repoId} here has no folder`);
  return { provider: "local", repoId: row.repoId, dir: row.localDir };
};

/**
 * What a repository is called where the project says where the files of its assets are (the `repo`
 * of a place in Git LFS, core/src/places.ts): its number on GitHub, as ever; `local:<number>` for
 * one of the server's own, which no number on GitHub can be. The editor says it the same way
 * (`repoHereOf` of @animaquill/host, which this does not import: it is of the browser).
 */
export const hereOf = (link: {
  readonly provider: RepoProvider;
  readonly repoId: number;
}): { readonly repo: string } => ({
  repo: link.provider === "github" ? String(link.repoId) : `local:${link.repoId}`,
});

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
  /** Where people see it: only on GitHub. */
  readonly url?: string;
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

/**
 * What the large file storage of a repository says it has of an object, see `RepoSession.lfsHave`.
 */
export type LfsHave =
  /**
   * It has an object of that oid. `size`, where it says one, can be the size it was asked about and
   * nothing more (GitHub's): how large what it has is, `lfsSizes` finds out. The server's own
   * repositories say what they keep.
   */
  | { readonly kind: "present"; readonly size?: number }
  /** Not there: for an upload, it takes it. */
  | { readonly kind: "absent" }
  /** It does not take, or does not give, the object: an HTTP status, and its words. */
  | { readonly kind: "refused"; readonly code: number; readonly message: string };

/** The file of an upload as it waits in the staging folder, for `RepoSession.lfsPut`. */
export interface LfsStaged {
  /** Where it is, a whole path. */
  readonly path: string;
  /** Reads it from its start, once; rejects with ENOENT where it is gone. */
  open(): Promise<Readable>;
}

/** Part of an object, as `RepoSession.lfsRead` gives it. */
export interface LfsPiece {
  /** Where the part starts in the object: the start that was asked for. */
  readonly start: number;
  /** How large all of the object is. */
  readonly size: number;
  /**
   * From `start` on: at least to the end that was asked for, perhaps beyond (a storage that does not
   * take ranges sends all of it), which the reader does not read.
   */
  readonly body: Readable;
}

/** The storage has no object of that oid. */
export class LfsAbsent extends Error {
  override name = "LfsAbsent";
}

/** The storage has the oid, as another size than the object: not the file. */
export class LfsChanged extends Error {
  override name = "LfsChanged";
}

/** The storage did not take an object, or does not give it: an HTTP status, and its words. */
export class LfsRefused extends Error {
  override name = "LfsRefused";
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

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
   * What the large file storage of the repository has of these objects, an answer for each, in
   * their order: for an "upload", whether it has it, or takes it; for a "download", whether it gives
   * it. Rejects with LfsQuota where the storage of the account is full, and RepoPaused where the
   * repository is not there to the App. What GitHub says on the way is kept for `lfsPut` and
   * `lfsRead`, which then need not ask again.
   */
  lfsHave(
    objects: readonly LfsObject[],
    purpose: "upload" | "download",
  ): Promise<readonly LfsHave[]>;
  /**
   * Puts the file of an upload into the storage as `object`: all of it, and only where it is the
   * object (its SHA-256 and length), or it rejects with `NotTheObject` (lfs/transfer.ts) and the
   * storage has nothing of it. "present" where the storage has the oid already, and nothing was put
   * there: how large what it has is, `lfsSizes` says. Rejects with `LfsRefused` where the storage
   * does not take it, as `lfsHave` does otherwise. `timeoutMs`: how long sending it may take.
   */
  lfsPut(
    object: LfsObject,
    staged: LfsStaged,
    options?: { readonly timeoutMs?: number },
  ): Promise<"put" | "present">;
  /**
   * Part of an object, from `start` to `end` (bytes, both in it). Rejects with `LfsAbsent` where the
   * storage does not have it, `LfsChanged` where what it has is of another size, and as `lfsHave`
   * does otherwise; GitHubUnavailable where it cannot be read now.
   */
  lfsRead(
    object: LfsObject,
    range: { readonly start: number; readonly end: number },
  ): Promise<LfsPiece>;
  /**
   * How large the storage has each of these objects, in their order, as the storage itself says of
   * what it keeps, whatever size it was asked about: undefined for one it does not have. An object
   * is only noted as there (`lfs_objects`) with the size found here, as a pointer says both, and
   * the storage goes by the oid alone when it says it has one. Each oid once in a call: the storage
   * answers by oid. Rejects as `lfsHave` does, and with GitHubUnavailable where the storage could
   * not be asked.
   */
  lfsSizes(objects: readonly LfsObject[]): Promise<readonly (number | undefined)[]>;
  /**
   * Done with the repository: whatever the session holds of it goes. Nothing for GitHub's, which
   * holds nothing; one that works on a clone of its own would take it away here.
   */
  close(): Promise<void>;
}

export interface RepoHost<Place extends RepoPlace = RepoPlace> {
  /**
   * A session of a repository. `signal`: every call of it stops once that says so, as for a piece
   * of work that ran out of its time, and rejects then as for GitHub that could not be reached.
   */
  open(place: Place, options?: { readonly signal?: AbortSignal | undefined }): RepoSession;
}

/** The host of each provider this server keeps repositories on: none for one it does not. */
export interface RepoHostsOf {
  readonly github?: RepoHost<GitHubPlace> | undefined;
  readonly local?: LocalGitRepoHost | undefined;
}

/**
 * Every repository, whichever provider it is on: the one way archiving, making working copies
 * again, and the large file storage reach one (archive/, lfs/). A provider this server is not set
 * up for (GitHub without the App's key) has no repository to reach: nothing is archived there,
 * and what asks anyway is told what it is told of GitHub that cannot be reached, so that nothing
 * pauses or goes for it.
 */
export class RepoHosts implements RepoHost {
  readonly #hosts: RepoHostsOf;

  constructor(hosts: RepoHostsOf) {
    this.#hosts = hosts;
  }

  /** Those of one host on GitHub, as most tests and the platform have them. */
  static github(host: RepoHost<GitHubPlace> | undefined): RepoHosts {
    return new RepoHosts({ github: host });
  }

  /** Whether repositories on this provider can be reached here. */
  has(provider: RepoProvider): boolean {
    return this.#hosts[provider] !== undefined;
  }

  /** The providers repositories can be reached on here. */
  get providers(): readonly RepoProvider[] {
    return (["github", "local"] as const).filter((provider) => this.has(provider));
  }

  /** The repositories of the server's own, for what only they have (making one, restoring). */
  get local(): LocalGitRepoHost | undefined {
    return this.#hosts.local;
  }

  /** The host on GitHub, for what only GitHub has (people's repositories, installations). */
  get github(): RepoHost<GitHubPlace> | undefined {
    return this.#hosts.github;
  }

  open(place: RepoPlace, options?: { readonly signal?: AbortSignal | undefined }): RepoSession {
    if (place.provider === "github") {
      const host = this.#hosts.github;
      if (host) return host.open(place, options);
    } else {
      const host = this.#hosts.local;
      if (host) return host.open(place, options);
    }
    return unhosted(place.provider);
  }
}

/** A session of a repository on a provider this server is not set up for: every call fails. */
const unhosted = (provider: RepoProvider): RepoSession => {
  const fail = async (): Promise<never> => {
    throw new GitHubUnavailable(`this server is not set up for repositories on ${provider}`);
  };
  return {
    info: fail,
    tip: fail,
    commit: fail,
    compare: fail,
    tree: fail,
    blob: fail,
    files: fail,
    writeTree: fail,
    writeCommit: fail,
    advance: fail,
    start: fail,
    lfsHave: fail,
    lfsPut: fail,
    lfsRead: fail,
    lfsSizes: fail,
    close: async () => {},
  };
};

/** Why archiving into a repository has to wait for people to do something. */
export type RepoTrouble = "gone" | "uninstalled" | "suspended" | "archived" | "broken";

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
