import { randomBytes } from "node:crypto";
import { basename, join, resolve } from "node:path";
import type { Logger } from "../../database.ts";
import { GitHubUnavailable } from "../../github/client.ts";
import {
  LfsAbsent,
  RepoPaused,
  RepoRefused,
  blobShaOf,
  bytesOf,
  type CommitInfo,
  type Comparison,
  type LfsHave,
  type LfsPiece,
  type LfsStaged,
  type LfsObject,
  type LocalPlace,
  type Person,
  type RepoHost,
  type RepoInfo,
  type RepoSession,
  type TreeChange,
  type TreeEntry,
} from "../repo-host.ts";
import { createReadStream } from "node:fs";
import { rm, statfs } from "node:fs/promises";
import { codeOf, diskError, nodeDisk, renameRetrying, type Disk } from "./disk.ts";
import {
  EMPTY_TREE,
  Objects,
  commitBytes,
  isTreeMode,
  treeBytes,
  type TreeItem,
} from "./objects.ts";
import { hasAnyRef, moveRef, readRef } from "./refs.ts";
import {
  isTheObject,
  lfsHaveOf,
  lfsObjectsIn,
  lfsPathOf,
  lfsPutInto,
  lfsReadFrom,
  lfsSizeOf,
  sweepLfsTemporary,
} from "./lfs.ts";

/**
 * The repositories of the server's own (`provider` "local"): one bare Git repository a project, in
 * `<data folder>/repos/<project>.git`, written on its branch `main` only, which `git clone` takes
 * out of there as from anywhere else, and which a `git push` of people's own goes into (merged as
 * changes in the repository, as on GitHub).
 *
 * The folder `repos/` is only used where it has the mark `.animaquill-repos`, which the server puts
 * there the first time it makes the folder (`prepare`): a volume that is not mounted is a folder
 * without it, and then every repository is "cannot be reached now", never "gone", so that nobody
 * makes a new one where the old one only is not there for a while.
 */

export const REPOS_FOLDER = "repos";
export const REPOS_MARK = ".animaquill-repos";
export const MAIN = "main";
const MAIN_REF = `refs/heads/${MAIN}`;

/** What a repository says of itself in its `config`, for restoring it: whose, and which project. */
export interface LocalRepoMeta {
  /** The person on the server whose project it was made for. */
  readonly owner?: string;
  /** The project on the server it was made for. */
  readonly project?: string;
}

/** A repository in `repos/`, as `list` finds one. */
export interface LocalRepo extends LocalRepoMeta {
  /** Its folder, from the data folder: `repos/<name>.git`. */
  readonly dir: string;
}

export interface LocalReposOptions {
  /** The data folder of the server, `AQ_DATA_DIR`. */
  readonly dataDir: string;
  readonly log: Logger;
  readonly disk?: Disk;
  readonly platform?: NodeJS.Platform;
  readonly now?: () => number;
}

/** A folder of a repository, as `project_repos.local_dir` has it: `repos/<name>.git`. */
const LOCAL_DIR = /^repos\/[A-Za-z0-9][A-Za-z0-9._-]{0,200}\.git$/;

export const localDirOf = (projectId: string) => `${REPOS_FOLDER}/${projectId}.git`;

/** A time as it goes into the name of a folder: 20261125T081500Z. */
const stampOf = (at: Date) =>
  at
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");

const CONFIG = (meta: LocalRepoMeta) =>
  [
    "[core]",
    "\trepositoryformatversion = 0",
    "\tfilemode = true",
    "\tbare = true",
    "\tlogallrefupdates = true",
    "[animaquill]",
    ...(meta.owner ? [`\towner = ${meta.owner}`] : []),
    ...(meta.project ? [`\tproject = ${meta.project}`] : []),
    "",
  ].join("\n");

/** What the `[animaquill]` section of a config says. */
const metaOf = (config: string): LocalRepoMeta => {
  let inside = false;
  const meta: { owner?: string; project?: string } = {};
  for (const raw of config.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("[")) {
      inside = /^\[animaquill\]$/i.test(line);
      continue;
    }
    if (!inside) continue;
    const match = /^(owner|project)\s*=\s*([A-Za-z0-9._-]{1,100})$/.exec(line);
    if (match) meta[match[1] as "owner" | "project"] = match[2]!;
  }
  return meta;
};

/** `repos/` is not there, where projects were archived into it: see `prepare`. */
export class ReposMissing extends Error {
  override name = "ReposMissing";
}

export class LocalGitRepoHost implements RepoHost<LocalPlace> {
  readonly dataDir: string;
  readonly #log: Logger;
  readonly #disk: Disk;
  readonly #platform: NodeJS.Platform;
  readonly #now: () => number;

  constructor(options: LocalReposOptions) {
    this.dataDir = resolve(options.dataDir);
    this.#log = options.log;
    this.#platform = options.platform ?? process.platform;
    this.#disk = options.disk ?? nodeDisk(this.#platform);
    this.#now = options.now ?? Date.now;
  }

  get #root() {
    return join(this.dataDir, REPOS_FOLDER);
  }

  /** The whole path of a repository, as people clone it. */
  pathOf(place: { readonly dir: string }): string {
    return join(this.dataDir, ...place.dir.split("/"));
  }

  /**
   * Makes sure `repos/` can be used, as the server starts: where it is not there, it is made, with
   * its mark; where it is there with the mark, it is used; where it is there without it, it is used
   * only while it is empty (and marked then), as a folder of repositories without the mark is not
   * known to be the one the server wrote. Resolves to what it found, or rejects with why not.
   */
  async prepare(options: { readonly mayMake?: boolean } = {}): Promise<"made" | "found"> {
    const root = this.#root;
    const mark = join(root, REPOS_MARK);
    if (await this.#disk.stat(mark)) return "found";
    const there = await this.#disk.stat(root);
    // Repositories are known to be here, and the folder is not: a volume that is not there yet.
    if (!there && options.mayMake === false)
      throw new ReposMissing(`${root} is not there, and projects were archived into it`);
    if (there) {
      const names = (await this.#disk.readdir(root)).filter((name) => name !== REPOS_MARK);
      if (names.length > 0)
        throw new Error(
          `${root} has repositories, and not the mark ${REPOS_MARK} the server leaves there`,
        );
    }
    await this.#disk.mkdir(root);
    try {
      await this.#disk.writeFile(mark, Buffer.from("AnimaQuill keeps repositories in here.\n"), {
        exclusive: true,
      });
    } catch (error) {
      if (codeOf(error) !== "EEXIST") throw error;
    }
    await this.#disk.syncDir(root);
    await this.#disk.syncDir(this.dataDir).catch(() => {});
    return there ? "found" : "made";
  }

  /** Rejects as for a repository that cannot be reached now where `repos/` is not as it was made. */
  async #usable(): Promise<void> {
    if (!(await this.#disk.stat(join(this.#root, REPOS_MARK))))
      // Its message is what the status says (`failure`), and what archives note.
      throw new GitHubUnavailable("reposUnreachable");
  }

  #gitdir(place: { readonly dir: string }): string {
    if (!LOCAL_DIR.test(place.dir))
      throw new RepoRefused(400, `not a folder of a repository: ${place.dir}`);
    return this.pathOf(place);
  }

  /** Whether the repository of a place is there. */
  async exists(place: { readonly dir: string }): Promise<boolean> {
    await this.#usable();
    return (await this.#disk.stat(join(this.#gitdir(place), "HEAD"))) !== undefined;
  }

  /**
   * Makes the repository of a place where it is not there: a bare repository made in a folder of
   * its own first (`repos/.tmp-…`), then renamed to its name whole. Nothing where it is there.
   */
  async create(place: { readonly dir: string }, name: string, meta: LocalRepoMeta): Promise<void> {
    await this.#usable();
    const gitdir = this.#gitdir(place);
    if (await this.#disk.stat(gitdir)) return;
    const temporary = join(this.#root, `.tmp-${randomBytes(8).toString("hex")}`);
    const disk = this.#disk;
    try {
      for (const folder of [
        "objects/info",
        "objects/pack",
        "refs/heads",
        "refs/tags",
        "info",
        "hooks",
      ])
        await disk.mkdir(join(temporary, folder));
      const file = (path: string, text: string) =>
        disk.writeFile(join(temporary, path), Buffer.from(text, "utf8"));
      await file("HEAD", `ref: ${MAIN_REF}\n`);
      await file("config", CONFIG(meta));
      await file("description", `${name.replace(/\n/g, " ").slice(0, 200)}\n`);
      await file("info/exclude", "");
      for (const folder of [
        "objects/info",
        "objects/pack",
        "refs/heads",
        "refs/tags",
        "info",
        "hooks",
        "objects",
        "refs",
        ".",
      ])
        await disk.syncDir(join(temporary, folder));
      await renameRetrying(disk, temporary, gitdir, this.#platform);
      await disk.syncDir(this.#root);
    } catch (error) {
      await removeTree(disk, temporary).catch(() => {});
      // Another process made it meanwhile.
      if (await disk.stat(join(gitdir, "HEAD"))) return;
      throw diskError(error);
    }
    this.#log.info({ dir: place.dir }, "a repository here is made");
  }

  /**
   * Puts a repository aside, as one that is broken before archiving starts over: into
   * `repos/broken/<name>-<time>.git`, which nothing takes away by itself. Resolves to where, or
   * undefined where it was not there.
   */
  async putAside(place: { readonly dir: string }, at: Date): Promise<string | undefined> {
    await this.#usable();
    const gitdir = this.#gitdir(place);
    if (!(await this.#disk.stat(gitdir))) return undefined;
    const folder = join(this.#root, "broken");
    await this.#disk.mkdir(folder);
    const name = `${basename(place.dir, ".git")}-${stampOf(at)}`;
    let to = join(folder, `${name}.git`);
    for (let n = 2; await this.#disk.stat(to); n += 1) to = join(folder, `${name}-${n}.git`);
    try {
      await renameRetrying(this.#disk, gitdir, to, this.#platform);
      await this.#disk.syncDir(folder);
      await this.#disk.syncDir(this.#root);
    } catch (error) {
      throw diskError(error);
    }
    this.#log.warn({ dir: place.dir, to }, "a repository here is put aside");
    return `${REPOS_FOLDER}/broken/${basename(to)}`;
  }

  /** What the branch of a repository has now, unchecked: undefined where it cannot be read. */
  async tipOf(place: { readonly dir: string }): Promise<string | undefined> {
    try {
      return await readRef(this.#disk, this.#gitdir(place), MAIN_REF);
    } catch {
      return undefined;
    }
  }

  /**
   * What a repository has: when its branch was last written (its commit), and how large its
   * folder is. Undefined of what cannot be read.
   */
  async summaryOf(place: { readonly dir: string }): Promise<{ at?: number; bytes: number }> {
    const gitdir = this.#gitdir(place);
    let bytes = 0;
    const walk = async (folder: string) => {
      for (const name of await this.#disk.readdir(folder).catch(() => [] as string[])) {
        const stat = await this.#disk.stat(join(folder, name)).catch(() => undefined);
        if (stat?.isDirectory()) await walk(join(folder, name));
        else if (stat) bytes += stat.size;
      }
    };
    await walk(gitdir);
    const tip = await this.tipOf(place);
    const commit =
      tip === undefined
        ? undefined
        : await new Objects(gitdir, this.#disk, this.#platform).commit(tip).catch(() => undefined);
    return { ...(commit?.at !== undefined && { at: commit.at }), bytes };
  }

  /** The repositories in `repos/`, each with what it says of itself. */
  async list(): Promise<LocalRepo[]> {
    await this.#usable();
    const found: LocalRepo[] = [];
    for (const name of (await this.#disk.readdir(this.#root)).toSorted()) {
      const dir = `${REPOS_FOLDER}/${name}`;
      if (!LOCAL_DIR.test(dir)) continue;
      const gitdir = join(this.#root, name);
      if (!(await this.#disk.stat(join(gitdir, "HEAD")))) continue;
      let meta: LocalRepoMeta = {};
      try {
        meta = metaOf((await this.#disk.readFile(join(gitdir, "config"))).toString("utf8"));
      } catch {
        // A repository without a config of ours is still one.
      }
      found.push({ dir, ...meta });
    }
    return found;
  }

  /** How large the objects of Git LFS of a repository are, in their order: undefined where not there. */
  async lfsSizes(
    place: { readonly dir: string },
    objects: readonly LfsObject[],
  ): Promise<(number | undefined)[]> {
    const gitdir = this.#gitdir(place);
    const sizes: (number | undefined)[] = [];
    for (const object of objects) sizes.push(await lfsSizeOf(this.#disk, gitdir, object.oid));
    return sizes;
  }

  /** Whether what a repository has under the oid of an object is that object, read through. */
  async lfsIsWhole(place: { readonly dir: string }, object: LfsObject): Promise<boolean> {
    return isTheObject(this.#disk, this.#gitdir(place), object);
  }

  /**
   * Puts what a repository has under an oid, which is not the object, aside into `lfs/bad/`, which
   * nothing takes away by itself: a download finds nothing there then, and an upload puts the
   * object there anew.
   */
  async lfsPutAside(place: { readonly dir: string }, oid: string, at: Date): Promise<void> {
    const gitdir = this.#gitdir(place);
    const folder = join(gitdir, "lfs", "bad");
    await this.#disk.mkdir(folder);
    try {
      await renameRetrying(
        this.#disk,
        lfsPathOf(gitdir, oid),
        join(folder, `${oid}-${stampOf(at)}`),
        this.#platform,
      );
    } catch (error) {
      if (codeOf(error) !== "ENOENT") throw diskError(error);
    }
    await this.#disk.syncDir(folder).catch(() => {});
  }

  /** Takes away what crashes left in `lfs/tmp/` of a repository. */
  async sweepLfs(place: { readonly dir: string }): Promise<number> {
    return sweepLfsTemporary(this.#disk, this.#gitdir(place), this.#now());
  }

  /**
   * Puts the objects of Git LFS of a repository that was put aside (`putAside`, by its folder from
   * the data folder) into another one: each read through and checked against its oid first, then
   * a second name of it (a copy where that cannot be), as `lfsPut` puts one. What is not the object
   * it is named as stays where it is. Resolves to the objects that are in `place` now.
   */
  async carryLfs(from: string, place: LocalPlace): Promise<LfsObject[]> {
    await this.#usable();
    const source = join(this.dataDir, ...from.split("/"));
    const gitdir = this.#gitdir(place);
    const carried: LfsObject[] = [];
    for (const object of await lfsObjectsIn(this.#disk, source)) {
      const path = lfsPathOf(source, object.oid);
      try {
        await lfsPutInto(this.#disk, gitdir, this.#platform, object, {
          path,
          open: async () => createReadStream(path),
        });
        carried.push(object);
      } catch (error) {
        this.#log.warn(
          { from, dir: place.dir, err: { name: (error as Error | undefined)?.name } },
          "an object of Git LFS is not carried over",
        );
      }
    }
    return carried;
  }

  /**
   * Bytes free on the disk of the repositories, for anybody, and how large it is, as `df` has it.
   * Undefined where it cannot be told.
   */
  async room(): Promise<{ readonly free: number; readonly total: number } | undefined> {
    try {
      const stats = await statfs(this.#root);
      return {
        free: Number(stats.bavail) * Number(stats.bsize),
        total: Number(stats.blocks) * Number(stats.bsize),
      };
    } catch {
      return undefined;
    }
  }

  /**
   * Reads what the branch has, from its tip down: the commit and every tree and file of it, each
   * checked against its name. Not the history before. Resolves where it is whole; rejects with
   * RepoPaused "broken", or "gone" where the repository is not there.
   */
  async verify(place: LocalPlace): Promise<void> {
    const session = this.open(place) as LocalRepoSession;
    await session.verify();
  }

  open(
    place: LocalPlace,
    options: { readonly signal?: AbortSignal | undefined } = {},
  ): RepoSession {
    return new LocalRepoSession(this, place, {
      gitdir: this.#gitdir(place),
      disk: this.#disk,
      platform: this.#platform,
      log: this.#log,
      now: this.#now,
      usable: () => this.#usable(),
      signal: options.signal,
    });
  }
}

/** Takes away a folder this made, and everything in it. */
const removeTree = (_disk: Disk, path: string): Promise<void> =>
  rm(path, { recursive: true, force: true });

interface SessionParts {
  readonly gitdir: string;
  readonly disk: Disk;
  readonly platform: NodeJS.Platform;
  readonly log: Logger;
  readonly now: () => number;
  readonly usable: () => Promise<void>;
  readonly signal: AbortSignal | undefined;
}

/** A change of a tree below one folder: the rest of its path, and what becomes of it. */
type Below = { readonly segments: readonly string[]; readonly text?: string };

class LocalRepoSession implements RepoSession {
  readonly #place: LocalPlace;
  readonly #parts: SessionParts;
  readonly #objects: Objects;

  constructor(_host: LocalGitRepoHost, place: LocalPlace, parts: SessionParts) {
    this.#place = place;
    this.#parts = parts;
    this.#objects = new Objects(parts.gitdir, parts.disk, parts.platform);
  }

  /** Every call: stopped where the session is, `repos/` as made, and the repository there. */
  async #ready(): Promise<void> {
    if (this.#parts.signal?.aborted) throw new GitHubUnavailable("stopped");
    await this.#parts.usable();
    if (!(await this.#parts.disk.stat(join(this.#parts.gitdir, "HEAD"))))
      throw new RepoPaused("gone", "the repository here is not there");
  }

  async info(): Promise<RepoInfo> {
    await this.#ready();
    return {
      id: this.#place.repoId,
      ownerId: 0,
      owner: "",
      name: basename(this.#place.dir, ".git"),
      branch: MAIN,
      private: true,
      archived: false,
    };
  }

  async tip(branch: string): Promise<string | undefined> {
    await this.#ready();
    if (branch !== MAIN) throw new RepoPaused("gone", `only ${MAIN} is written here`);
    const sha = await readRef(this.#parts.disk, this.#parts.gitdir, MAIN_REF).catch((error) => {
      throw new GitHubUnavailable(`reading the branch: ${codeOf(error) ?? "failed"}`);
    });
    if (sha === undefined) {
      if (await hasAnyRef(this.#parts.disk, this.#parts.gitdir))
        throw new RepoPaused("gone", `the repository has no ${MAIN} any more`);
      return undefined;
    }
    // The branch names a commit the repository has, or the repository is broken.
    await this.#objects.get(sha, "commit");
    return sha;
  }

  async commit(sha: string): Promise<CommitInfo | undefined> {
    await this.#ready();
    const commit = await this.#objects.commit(sha);
    if (!commit) return undefined;
    return { sha, tree: commit.tree, parents: commit.parents, message: commit.message };
  }

  async compare(base: string, head: string): Promise<Comparison | undefined> {
    await this.#ready();
    if (!(await this.#objects.commit(base)) || !(await this.#objects.commit(head)))
      return undefined;
    if (base === head) return { status: "identical", mergeBase: base };
    if (await this.#objects.reaches(head, base)) return { status: "ahead", mergeBase: base };
    if (await this.#objects.reaches(base, head)) return { status: "behind", mergeBase: head };
    const mergeBase = await this.#objects.mergeBase(base, head);
    if (mergeBase === undefined) return undefined;
    return { status: "diverged", mergeBase };
  }

  async tree(sha: string, options: { readonly recursive?: boolean } = {}): Promise<TreeEntry[]> {
    await this.#ready();
    const entries: TreeEntry[] = [];
    const walk = async (tree: string, prefix: string) => {
      for (const item of await this.#objects.tree(tree)) {
        const path = `${prefix}${item.name}`;
        if (isTreeMode(item.mode)) {
          entries.push({ path, mode: "040000", type: "tree", sha: item.sha });
          if (options.recursive) await walk(item.sha, `${path}/`);
        } else if (item.mode === "160000") {
          entries.push({ path, mode: item.mode, type: "commit", sha: item.sha });
        } else {
          const bytes = await this.#objects.get(item.sha, "blob");
          entries.push({ path, mode: item.mode, type: "blob", sha: item.sha, size: bytes.length });
        }
      }
    };
    await walk(sha, "");
    return entries;
  }

  async blob(sha: string): Promise<Uint8Array> {
    await this.#ready();
    return this.#objects.get(sha, "blob");
  }

  async files(
    _commit: string,
    entries: readonly TreeEntry[],
  ): Promise<ReadonlyMap<string, Uint8Array>> {
    await this.#ready();
    const found = new Map<string, Uint8Array>();
    for (const entry of entries) {
      if (entry.type !== "blob" || entry.mode === "120000") continue;
      const bytes = await this.#objects.get(entry.sha, "blob");
      if (blobShaOf(bytes) !== entry.sha)
        throw new RepoPaused("broken", `${entry.sha} is not itself`);
      found.set(entry.path, bytes);
    }
    return found;
  }

  /** A tree of `base` with `changes`, which are all of one kind: written, or taken away. */
  async #build(base: string | undefined, changes: readonly Below[]): Promise<string | undefined> {
    const entries = new Map<string, TreeItem>();
    if (base !== undefined)
      for (const item of await this.#objects.tree(base)) entries.set(item.name, item);
    const byName = new Map<string, Below[]>();
    for (const change of changes) {
      const [name, ...rest] = change.segments as [string, ...string[]];
      const list = byName.get(name) ?? [];
      list.push({ segments: rest, ...(change.text !== undefined && { text: change.text }) });
      byName.set(name, list);
    }
    for (const [name, list] of byName) {
      const current = entries.get(name);
      const here = list.filter((change) => change.segments.length === 0);
      const deeper = list.filter((change) => change.segments.length > 0);
      for (const change of here) {
        if (change.text === undefined) entries.delete(name);
        else
          entries.set(name, {
            name,
            mode: "100644",
            sha: await this.#objects.write("blob", bytesOf(change.text)),
          });
      }
      if (deeper.length > 0) {
        const now = here.length > 0 ? entries.get(name) : current;
        const below = now && isTreeMode(now.mode) ? now.sha : undefined;
        // Taking away below what is not a folder takes nothing away.
        if (below === undefined && deeper.every((change) => change.text === undefined)) continue;
        const sha = await this.#build(below, deeper);
        if (sha === undefined) entries.delete(name);
        else entries.set(name, { name, mode: "40000", sha });
      }
    }
    if (entries.size === 0) return undefined;
    return this.#objects.write("tree", treeBytes([...entries.values()]));
  }

  async writeTree(base: string, changes: readonly TreeChange[]): Promise<string> {
    await this.#ready();
    const split = (path: string) => path.split("/").filter((segment) => segment !== "");
    const removals: Below[] = [];
    const writes: Below[] = [];
    for (const change of changes) {
      if ("remove" in change) removals.push({ segments: split(change.path) });
      else writes.push({ segments: split(change.path), text: change.text });
    }
    let tree: string | undefined = base === EMPTY_TREE ? undefined : base;
    if (removals.length > 0) tree = await this.#build(tree, removals);
    if (writes.length > 0) tree = await this.#build(tree, writes);
    return tree ?? (await this.#objects.write("tree", Buffer.alloc(0)));
  }

  async writeCommit(commit: {
    readonly tree: string;
    readonly parents: readonly string[];
    readonly message: string;
    readonly author: Person;
    readonly at: Date;
  }): Promise<string> {
    await this.#ready();
    await this.#objects.get(commit.tree, "tree");
    for (const parent of commit.parents) await this.#objects.get(parent, "commit");
    return this.#objects.write("commit", commitBytes(commit));
  }

  async advance(
    branch: string,
    sha: string,
  ): Promise<"moved" | "behind" | { readonly refused: string }> {
    await this.#ready();
    if (branch !== MAIN) return { refused: `only ${MAIN} is written here` };
    await this.#objects.get(sha, "commit");
    return moveRef(
      this.#parts.disk,
      this.#parts.gitdir,
      {
        ref: MAIN_REF,
        to: sha,
        // Only as a fast-forward, never over a branch that is not there any more.
        may: async (now) => now !== undefined && (await this.#objects.reaches(sha, now)),
        message: "archive",
        at: new Date(this.#parts.now()),
      },
      this.#parts,
    );
  }

  async start(
    file: { readonly path: string; readonly text: string },
    message: string,
    author: Person,
    at: Date,
  ): Promise<string | undefined> {
    await this.#ready();
    if ((await readRef(this.#parts.disk, this.#parts.gitdir, MAIN_REF)) !== undefined)
      return undefined;
    const tree = await this.writeTree(EMPTY_TREE, [file]);
    const sha = await this.writeCommit({ tree, parents: [], message, author, at });
    const moved = await moveRef(
      this.#parts.disk,
      this.#parts.gitdir,
      {
        ref: MAIN_REF,
        to: sha,
        may: async (now) => now === undefined,
        message: "start",
        at: new Date(this.#parts.now()),
      },
      this.#parts,
    );
    return moved === "moved" ? sha : undefined;
  }

  /**
   * Before the large file storage is used: as `#ready`, but a repository that is not there has
   * nothing (it can be one the first archive did not make yet), and one to put into is waited for.
   */
  async #lfsReady(put = false): Promise<boolean> {
    try {
      await this.#ready();
      return true;
    } catch (error) {
      if (!(error instanceof RepoPaused) || error.reason !== "gone") throw error;
      if (put) throw new GitHubUnavailable("the repository here is not there yet");
      return false;
    }
  }

  async lfsHave(
    objects: readonly LfsObject[],
    purpose: "upload" | "download",
  ): Promise<readonly LfsHave[]> {
    if (objects.length === 0) return [];
    if (!(await this.#lfsReady())) return objects.map(() => ({ kind: "absent" as const }));
    return lfsHaveOf(this.#parts.disk, this.#parts.gitdir, objects, purpose);
  }

  async lfsPut(object: LfsObject, staged: LfsStaged): Promise<"put" | "present"> {
    await this.#lfsReady(true);
    let put: "put" | "present";
    try {
      put = await lfsPutInto(
        this.#parts.disk,
        this.#parts.gitdir,
        this.#parts.platform,
        object,
        staged,
      );
    } catch (error) {
      // The repository went from under it (put aside as archiving starts over, say), while the
      // staging file is still there: the file goes into the repository there is then.
      if (codeOf(error) === "ENOENT" && (await this.#parts.disk.stat(staged.path)))
        throw new GitHubUnavailable("the repository here moved while a file went in");
      throw error;
    }
    if (put === "put") this.#parts.log.info({ dir: this.#place.dir }, "a large file is put here");
    return put;
  }

  async lfsRead(
    object: LfsObject,
    range: { readonly start: number; readonly end: number },
  ): Promise<LfsPiece> {
    if (!(await this.#lfsReady())) throw new LfsAbsent("the repository here is not there");
    return lfsReadFrom(this.#parts.disk, this.#parts.gitdir, object, range);
  }

  async lfsSizes(objects: readonly LfsObject[]): Promise<readonly (number | undefined)[]> {
    if (objects.length === 0) return [];
    if (!(await this.#lfsReady())) return objects.map(() => undefined);
    const sizes: (number | undefined)[] = [];
    for (const object of objects)
      sizes.push(await lfsSizeOf(this.#parts.disk, this.#parts.gitdir, object.oid));
    return sizes;
  }

  async close(): Promise<void> {}

  /** See `LocalGitRepoHost.verify`. */
  async verify(): Promise<void> {
    await this.#ready();
    for (const file of ["HEAD", "config"])
      await this.#parts.disk.readFile(join(this.#parts.gitdir, file)).catch(() => {
        throw new RepoPaused("broken", `${file} of the repository does not read`);
      });
    const tip = await this.tip(MAIN);
    if (tip === undefined) return;
    const commit = await this.#objects.commit(tip);
    if (!commit) throw new RepoPaused("broken", `the commit ${tip} is not there`);
    await this.tree(commit.tree, { recursive: true });
  }
}
