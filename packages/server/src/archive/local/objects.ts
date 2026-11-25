import { createHash, randomBytes } from "node:crypto";
import * as nodeFs from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { readObject } from "isomorphic-git";
import { GitHubUnavailable } from "../../github/client.ts";
import { RepoPaused } from "../repo-host.ts";
import { codeOf, diskError, renameRetrying, type Disk } from "./disk.ts";

/**
 * The objects of a bare Git repository of the server's own: read through isomorphic-git, which
 * knows loose objects and packs (after `git gc`), and written by this, loose, each whole before it
 * is there. Every object read is checked against its name: one that is not what its name says, or
 * that a commit or a tree names and is not there, is a broken repository (`RepoPaused` "broken"),
 * nothing to try again.
 */

export type ObjectType = "blob" | "tree" | "commit";

export interface GitObject {
  readonly type: ObjectType | "tag";
  readonly data: Buffer;
}

/** An entry of a tree as Git writes it: "40000" for a tree. */
export interface TreeItem {
  readonly name: string;
  readonly mode: string;
  readonly sha: string;
}

export interface CommitObject {
  readonly tree: string;
  readonly parents: readonly string[];
  readonly message: string;
}

/** The tree with nothing in it, which every Git knows by this name. */
export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

const SHA = /^[0-9a-f]{40}$/;

export const shaOf = (type: string, data: Uint8Array): string =>
  createHash("sha1").update(`${type} ${data.length}\0`).update(data).digest("hex");

export const isTreeMode = (mode: string) => mode === "40000" || mode === "040000";

/** Git sorts a tree by name, a tree's name as if it ended in "/". */
const sortKey = (item: TreeItem) =>
  Buffer.from(isTreeMode(item.mode) ? `${item.name}/` : item.name);

export const treeBytes = (items: readonly TreeItem[]): Buffer => {
  const parts: Buffer[] = [];
  for (const item of [...items].toSorted((a, b) => Buffer.compare(sortKey(a), sortKey(b))))
    parts.push(
      Buffer.from(`${isTreeMode(item.mode) ? "40000" : item.mode} ${item.name}\0`),
      Buffer.from(item.sha, "hex"),
    );
  return Buffer.concat(parts);
};

export const parseTree = (data: Buffer, sha: string): TreeItem[] => {
  const items: TreeItem[] = [];
  let at = 0;
  while (at < data.length) {
    const space = data.indexOf(0x20, at);
    const nul = space < 0 ? -1 : data.indexOf(0, space);
    if (space < 0 || nul < 0 || nul + 21 > data.length)
      throw new RepoPaused("broken", `the tree ${sha} does not read as a tree`);
    items.push({
      mode: data.subarray(at, space).toString(),
      name: data.subarray(space + 1, nul).toString(),
      sha: data.subarray(nul + 1, nul + 21).toString("hex"),
    });
    at = nul + 21;
  }
  return items;
};

/** A name or an address as Git keeps it in a commit: nothing that would end it early. */
const clean = (text: string) => text.replace(/[<>\n\r\0]/g, "").trim() || "AnimaQuill";

export const commitBytes = (commit: {
  readonly tree: string;
  readonly parents: readonly string[];
  readonly message: string;
  readonly author: { readonly name: string; readonly email: string };
  readonly at: Date;
}): Buffer => {
  const seconds = Math.floor(commit.at.getTime() / 1000);
  const who = `${clean(commit.author.name)} <${clean(commit.author.email)}> ${seconds} +0000`;
  const lines = [`tree ${commit.tree}`];
  for (const parent of commit.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${who}`, `committer ${who}`);
  const message = commit.message.endsWith("\n") ? commit.message : `${commit.message}\n`;
  return Buffer.from(`${lines.join("\n")}\n\n${message}`, "utf8");
};

export const parseCommit = (data: Buffer, sha: string): CommitObject => {
  const text = data.toString("utf8");
  const split = text.indexOf("\n\n");
  const head = (split < 0 ? text : text.slice(0, split)).split("\n");
  let tree: string | undefined;
  const parents: string[] = [];
  for (const line of head) {
    if (line.startsWith("tree ")) tree ??= line.slice(5);
    else if (line.startsWith("parent ")) parents.push(line.slice(7));
  }
  if (tree === undefined || !SHA.test(tree) || parents.some((parent) => !SHA.test(parent)))
    throw new RepoPaused("broken", `the commit ${sha} does not read as a commit`);
  return { tree, parents, message: split < 0 ? "" : text.slice(split + 2) };
};

/** A failure of reading that the disk had now, not the repository: tried again later. */
const TRANSIENT = new Set(["EIO", "EMFILE", "ENFILE", "EAGAIN", "EBUSY", "ETIMEDOUT", "ENOMEM"]);

/** The objects of one repository, for one session: packs read once are kept meanwhile. */
export class Objects {
  readonly #gitdir: string;
  readonly #disk: Disk;
  readonly #platform: NodeJS.Platform;
  readonly #cache: object = {};
  /** What this session read already, checked. */
  readonly #read = new Map<string, GitObject>();

  constructor(gitdir: string, disk: Disk, platform: NodeJS.Platform) {
    this.#gitdir = gitdir;
    this.#disk = disk;
    this.#platform = platform;
  }

  /**
   * An object, checked against its name, or undefined where the repository does not have it.
   * Rejects with RepoPaused "broken" where what is there is not what the name says.
   */
  async find(sha: string): Promise<GitObject | undefined> {
    if (!SHA.test(sha)) return undefined;
    const known = this.#read.get(sha);
    if (known) return known;
    let found: { type?: string; object: unknown };
    try {
      found = await readObject({
        fs: nodeFs,
        gitdir: this.#gitdir,
        oid: sha,
        format: "content",
        cache: this.#cache,
      });
    } catch (error) {
      if ((error as { code?: unknown }).code === "NotFoundError") return undefined;
      const code = codeOf(error);
      if (code !== undefined && TRANSIENT.has(code))
        throw new GitHubUnavailable(`reading ${sha}: ${code}`);
      throw new RepoPaused(
        "broken",
        `the object ${sha} does not read: ${error instanceof Error ? error.message : "failed"}`.slice(
          0,
          300,
        ),
      );
    }
    const type = found.type;
    const data = Buffer.from(found.object as Uint8Array);
    if (type !== "blob" && type !== "tree" && type !== "commit" && type !== "tag")
      throw new RepoPaused("broken", `the object ${sha} is of no kind Git has`);
    if (shaOf(type, data) !== sha)
      throw new RepoPaused("broken", `the object ${sha} is not what its name says`);
    const object = { type, data } as const;
    // Only what is small is kept: a session reads a project, which is text.
    if (data.length <= 1024 * 1024) this.#read.set(sha, object);
    return object;
  }

  /** An object that has to be there, as a commit or a tree names it, of this kind. */
  async get(sha: string, type: ObjectType): Promise<Buffer> {
    const object = await this.find(sha);
    if (!object) throw new RepoPaused("broken", `the ${type} ${sha} is not there`);
    if (object.type !== type) throw new RepoPaused("broken", `${sha} is no ${type}`);
    return object.data;
  }

  async commit(sha: string): Promise<CommitObject | undefined> {
    const object = await this.find(sha);
    if (!object || object.type !== "commit") return undefined;
    return parseCommit(object.data, sha);
  }

  async tree(sha: string): Promise<TreeItem[]> {
    if (sha === EMPTY_TREE) return [];
    return parseTree(await this.get(sha, "tree"), sha);
  }

  /**
   * Writes an object, loose, unless the repository has it: deflated into a name of its own in its
   * folder, synced, renamed to its name, and the folder synced. Resolves to its name.
   */
  async write(type: ObjectType, data: Buffer): Promise<string> {
    const sha = shaOf(type, data);
    if (this.#read.has(sha)) return sha;
    const folder = join(this.#gitdir, "objects", sha.slice(0, 2));
    const path = join(folder, sha.slice(2));
    if (await this.#disk.stat(path)) return sha;
    const made = !(await this.#disk.stat(folder));
    const temporary = join(folder, `tmp_obj_${randomBytes(8).toString("hex")}`);
    try {
      if (made) {
        await this.#disk.mkdir(folder);
        await this.#disk.syncDir(join(this.#gitdir, "objects"));
      }
      const wrapped = Buffer.concat([Buffer.from(`${type} ${data.length}\0`), data]);
      await this.#disk.writeFile(temporary, deflateSync(wrapped), { exclusive: true });
      try {
        await renameRetrying(this.#disk, temporary, path, this.#platform);
      } catch (error) {
        // Another writer put the same object there meanwhile: it is the same bytes.
        if (!(await this.#disk.stat(path))) throw error;
        await this.#disk.unlink(temporary).catch(() => {});
      }
      await this.#disk.syncDir(folder);
    } catch (error) {
      await this.#disk.unlink(temporary).catch(() => {});
      throw diskError(error);
    }
    if (data.length <= 1024 * 1024) this.#read.set(sha, { type, data });
    return sha;
  }

  /** Whether `ancestor` is `sha` or one of its parents, however far back. */
  async reaches(sha: string, ancestor: string): Promise<boolean> {
    const seen = new Set<string>();
    const queue = [sha];
    while (queue.length > 0) {
      const next = queue.shift() as string;
      if (next === ancestor) return true;
      if (seen.has(next)) continue;
      seen.add(next);
      const commit = await this.commit(next);
      if (commit) queue.push(...commit.parents);
    }
    return false;
  }

  /**
   * The last commit both have, as `git merge-base` finds one: of the ancestors of `b`, the nearest
   * to `a` by a walk from `a`. Undefined where they have none.
   */
  async mergeBase(a: string, b: string): Promise<string | undefined> {
    const ofB = new Set<string>();
    const queue = [b];
    while (queue.length > 0) {
      const next = queue.shift() as string;
      if (ofB.has(next)) continue;
      const commit = await this.commit(next);
      if (!commit) continue;
      ofB.add(next);
      queue.push(...commit.parents);
    }
    const seen = new Set<string>();
    const walk = [a];
    while (walk.length > 0) {
      const next = walk.shift() as string;
      if (ofB.has(next)) return next;
      if (seen.has(next)) continue;
      seen.add(next);
      const commit = await this.commit(next);
      if (commit) walk.push(...commit.parents);
    }
    return undefined;
  }
}
