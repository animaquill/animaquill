import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";

/**
 * Git objects as Git itself writes them, for the fake GitHub: blobs, trees and commits by their
 * real SHA-1, so that what the platform computes about a file (archive/repo-host.ts `blobShaOf`) is
 * what a repository has, and so that a test can put the objects into a real repository and have
 * `git fsck` look at them, see `writeLooseObjects`.
 */

export type ObjectType = "blob" | "tree" | "commit";

export interface TreeItem {
  readonly name: string;
  /** As Git writes it in a tree: "100644", "100755", "120000", "160000", or "40000" for a tree. */
  readonly mode: string;
  readonly sha: string;
}

export interface Signature {
  readonly name: string;
  readonly email: string;
  /** Seconds since 1970. */
  readonly time: number;
}

export interface CommitObject {
  readonly tree: string;
  readonly parents: readonly string[];
  readonly author: Signature;
  readonly committer: Signature;
  readonly message: string;
}

/** A file in a flat listing of a tree. */
export interface FlatFile {
  readonly mode: string;
  readonly sha: string;
}

const isTreeMode = (mode: string) => mode === "40000";

/** Git sorts a tree by name, a tree's name as if it ended in "/". */
const sortKey = (item: TreeItem) => (isTreeMode(item.mode) ? `${item.name}/` : item.name);
const byGitOrder = (a: TreeItem, b: TreeItem) => {
  const left = Buffer.from(sortKey(a));
  const right = Buffer.from(sortKey(b));
  return Buffer.compare(left, right);
};

const signatureText = (who: Signature) =>
  `${who.name} <${who.email}> ${Math.floor(who.time)} +0000`;

export class GitObjects {
  readonly #objects = new Map<string, { readonly type: ObjectType; readonly data: Buffer }>();

  /** Keeps an object; resolves to its SHA-1, as Git computes it. */
  put(type: ObjectType, data: Buffer): string {
    const sha = createHash("sha1").update(`${type} ${data.length}\0`).update(data).digest("hex");
    if (!this.#objects.has(sha)) this.#objects.set(sha, { type, data });
    return sha;
  }

  get(sha: string) {
    return this.#objects.get(sha);
  }

  has(sha: string, type?: ObjectType): boolean {
    const object = this.#objects.get(sha);
    return object !== undefined && (type === undefined || object.type === type);
  }

  /** Every object, for writing them into a real repository. */
  all(): readonly [string, { readonly type: ObjectType; readonly data: Buffer }][] {
    return [...this.#objects];
  }

  blob(content: Buffer | string): string {
    return this.put("blob", Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8"));
  }

  tree(items: readonly TreeItem[]): string {
    const parts: Buffer[] = [];
    for (const item of [...items].toSorted(byGitOrder)) {
      parts.push(Buffer.from(`${item.mode} ${item.name}\0`), Buffer.from(item.sha, "hex"));
    }
    return this.put("tree", Buffer.concat(parts));
  }

  readTree(sha: string): TreeItem[] {
    const object = this.#objects.get(sha);
    if (!object || object.type !== "tree") throw new Error(`no tree ${sha}`);
    const items: TreeItem[] = [];
    const data = object.data;
    let at = 0;
    while (at < data.length) {
      const space = data.indexOf(0x20, at);
      const nul = data.indexOf(0, space);
      items.push({
        mode: data.subarray(at, space).toString(),
        name: data.subarray(space + 1, nul).toString(),
        sha: data.subarray(nul + 1, nul + 21).toString("hex"),
      });
      at = nul + 21;
    }
    return items;
  }

  commit(commit: CommitObject): string {
    const lines = [`tree ${commit.tree}`];
    for (const parent of commit.parents) lines.push(`parent ${parent}`);
    lines.push(`author ${signatureText(commit.author)}`);
    lines.push(`committer ${signatureText(commit.committer)}`);
    return this.put("commit", Buffer.from(`${lines.join("\n")}\n\n${commit.message}`, "utf8"));
  }

  readCommit(sha: string): CommitObject {
    const object = this.#objects.get(sha);
    if (!object || object.type !== "commit") throw new Error(`no commit ${sha}`);
    const text = object.data.toString("utf8");
    const split = text.indexOf("\n\n");
    const head = text.slice(0, split).split("\n");
    const parse = (line: string): Signature => {
      const match = /^(.*) <(.*)> (\d+) [+-]\d{4}$/.exec(line);
      if (!match) throw new Error(`not a signature: ${line}`);
      return { name: match[1] as string, email: match[2] as string, time: Number(match[3]) };
    };
    let tree = "";
    const parents: string[] = [];
    let author: Signature | undefined;
    let committer: Signature | undefined;
    for (const line of head) {
      if (line.startsWith("tree ")) tree = line.slice(5);
      else if (line.startsWith("parent ")) parents.push(line.slice(7));
      else if (line.startsWith("author ")) author = parse(line.slice(7));
      else if (line.startsWith("committer ")) committer = parse(line.slice(10));
    }
    if (!author || !committer) throw new Error(`a commit without an author: ${sha}`);
    return { tree, parents, author, committer, message: text.slice(split + 2) };
  }

  /** Every file below a tree, by its path: blobs and submodules, not the trees in between. */
  flatten(sha: string, prefix = "", into = new Map<string, FlatFile>()): Map<string, FlatFile> {
    for (const item of this.readTree(sha)) {
      const path = `${prefix}${item.name}`;
      if (isTreeMode(item.mode)) this.flatten(item.sha, `${path}/`, into);
      else into.set(path, { mode: item.mode, sha: item.sha });
    }
    return into;
  }

  /** A tree of these files, with the trees in between. An empty one for none. */
  treeOf(files: ReadonlyMap<string, FlatFile>): string {
    const here: TreeItem[] = [];
    const below = new Map<string, Map<string, FlatFile>>();
    for (const [path, file] of files) {
      const slash = path.indexOf("/");
      if (slash < 0) {
        here.push({ name: path, mode: file.mode, sha: file.sha });
        continue;
      }
      const folder = path.slice(0, slash);
      const inner = below.get(folder) ?? new Map<string, FlatFile>();
      inner.set(path.slice(slash + 1), file);
      below.set(folder, inner);
    }
    for (const [folder, inner] of below) {
      here.push({ name: folder, mode: "40000", sha: this.treeOf(inner) });
    }
    return this.tree(here);
  }

  /** Whether `ancestor` is `sha` or one of its parents, however far back. */
  /**
   * The last commit both have, as `git merge-base` finds one: of the ancestors of `b` (itself
   * too), the nearest to `a` that is one of `a`'s, by a walk from `a`. Undefined where none is.
   */
  mergeBase(a: string, b: string): string | undefined {
    const ofB = new Set<string>();
    const queue = [b];
    while (queue.length > 0) {
      const next = queue.shift() as string;
      if (ofB.has(next) || !this.has(next, "commit")) continue;
      ofB.add(next);
      queue.push(...this.readCommit(next).parents);
    }
    const seen = new Set<string>();
    const walk = [a];
    while (walk.length > 0) {
      const next = walk.shift() as string;
      if (ofB.has(next)) return next;
      if (seen.has(next) || !this.has(next, "commit")) continue;
      seen.add(next);
      walk.push(...this.readCommit(next).parents);
    }
    return undefined;
  }

  isAncestor(ancestor: string, sha: string): boolean {
    const seen = new Set<string>();
    const queue = [sha];
    while (queue.length > 0) {
      const next = queue.shift() as string;
      if (next === ancestor) return true;
      if (seen.has(next) || !this.has(next, "commit")) continue;
      seen.add(next);
      queue.push(...this.readCommit(next).parents);
    }
    return false;
  }
}

/**
 * The objects as files of a repository's `objects/` folder, for a real Git to read: each one
 * compressed, at objects/<first two>/<the rest>.
 */
export const looseObjects = (objects: GitObjects): [string, Buffer][] =>
  objects
    .all()
    .map(([sha, { type, data }]) => [
      `objects/${sha.slice(0, 2)}/${sha.slice(2)}`,
      deflateSync(Buffer.concat([Buffer.from(`${type} ${data.length}\0`), data])),
    ]);
