import type { Path } from "./structure.ts";

/** One change to the document, made here or anywhere else. Only its identity means something. */
export type WriteId = symbol;

/**
 * Which write put what is at a path there. A value cannot say: two writes can leave the same value,
 * and only one of them is what the document holds. Taking back a write is only fair while it is
 * that one.
 *
 * This is about the writes this window knows of, and it lives as long as the undo history, so it
 * has no need for the items of Yjs, which go away and merge. A write from elsewhere that loses to
 * one made here never shows up, which is right: what the document holds is still the one from here.
 *
 * Taking a write back is no write of its own. What it puts back belongs to the write it restores,
 * so the path goes back to whoever had it: to an AI task when that wrote it before, to nobody when
 * it has been like this since the project opened. Redoing hands it back again. In another window
 * all of this arrives as one more write from elsewhere.
 */
export interface Written {
  /** The write that last replaced this path, or something above it. */
  readonly by: WriteId | undefined;
  /** Where something below this path was written by anything else since then. */
  readonly below?: ReadonlyMap<string, Written>;
}

/** A project that was just opened: nobody here wrote any of it. */
export const UNWRITTEN: Written = { by: undefined };

const hasBelow = ({ below }: Written) => below !== undefined && below.size > 0;

/** Whether nothing happened at or below a path between these two looks at it. */
export function sameWrites(a: Written, b: Written): boolean {
  if (a === b) return true;
  if (a.by !== b.by || (a.below?.size ?? 0) !== (b.below?.size ?? 0)) return false;
  for (const [key, inner] of a.below ?? []) {
    const other = b.below?.get(key);
    if (!other || !sameWrites(inner, other)) return false;
  }
  return true;
}

interface OwnedNode {
  readonly by: WriteId | undefined;
  readonly below: Map<string, Written>;
}

/**
 * Records writes on top of what was written so far, which stays as it is, so that a step can keep
 * what it replaced and hand it back later. Like `Mutator`, it copies what it changes only once, or
 * a file that touches every clip of a big project would take quadratic time.
 */
export class WriteTree {
  readonly #owned = new WeakSet<Written>();
  #root: Written;

  constructor(root: Written = UNWRITTEN) {
    this.#root = root;
  }

  /** Everything so far. Writing on goes on top of it. */
  get root(): Written {
    this.#release(this.#root);
    return this.#root;
  }

  /** What was written at a path. It stays what it is, whatever gets written after this. */
  at(path: Path): Written {
    let node = this.#root;
    for (const key of path) node = node.below?.get(key) ?? { by: node.by };
    this.#release(node);
    return node;
  }

  /** Makes this what was written at a path. Whatever was written below it no longer counts. */
  put(path: Path, written: Written): void {
    this.#root = this.#put(this.#root, path, 0, written);
  }

  #put(node: Written, path: Path, depth: number, written: Written): Written {
    const key = path[depth];
    if (key === undefined) return written;
    const inner = this.#put(node.below?.get(key) ?? { by: node.by }, path, depth + 1, written);
    const owned = this.#own(node);
    if (inner.by === owned.by && !hasBelow(inner)) owned.below.delete(key);
    else owned.below.set(key, inner);
    return owned;
  }

  #own(node: Written): OwnedNode {
    if (this.#owned.has(node)) return node as OwnedNode;
    const owned = { by: node.by, below: new Map(node.below) };
    this.#owned.add(owned);
    return owned;
  }

  /** Something that leaves this tree can no longer change. */
  #release(node: Written): void {
    if (this.#owned.delete(node)) node.below?.forEach((inner) => this.#release(inner));
  }
}
