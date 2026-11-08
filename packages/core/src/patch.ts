import {
  isFlat,
  isFlatLevel,
  isStanding,
  isStandingLevel,
  levelAt,
  levelIn,
  type Level,
  type Path,
} from "./structure.ts";

/** One change to a project. A command turns into a list of these, which also records what it did. */
export type Patch =
  | { readonly op: "set"; readonly path: Path; readonly value: unknown }
  | { readonly op: "delete"; readonly path: Path }
  /** Replaces the text of a file, as a small edit so that it merges with other edits. */
  | { readonly op: "text"; readonly path: Path; readonly value: string };

type Plain = Record<string, unknown>;

const isPlainObject = (value: unknown): value is Plain =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a)) {
    return Array.isArray(b) && a.length === b.length && a.every((item, i) => deepEqual(item, b[i]));
  }
  if (!isPlainObject(a) || !isPlainObject(b)) return false;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => Object.hasOwn(b, key) && deepEqual(a[key], b[key]));
}

/** The patches that turn what is in one object into what is in the other. */
function diffEntries(
  path: Path,
  level: Level,
  before: Plain,
  after: Plain,
  patches: Patch[],
): void {
  for (const key of Object.keys(before)) {
    if (!Object.hasOwn(after, key)) patches.push({ op: "delete", path: [...path, key] });
  }
  for (const [key, value] of Object.entries(after)) {
    const known = Object.hasOwn(before, key) ? before[key] : undefined;
    // What did not change at all is skipped right away: there can be thousands of it.
    if (known !== value) diffAt([...path, key], levelIn(level, key), known, value, patches);
  }
}

function diffAt(
  path: Path,
  level: Level | undefined,
  before: unknown,
  after: unknown,
  patches: Patch[],
): void {
  if (deepEqual(before, after)) return;
  if (level !== undefined && isFlatLevel(level)) {
    if (isStandingLevel(level) && (before === undefined) !== (after === undefined)) {
      patches.push(
        after === undefined ? { op: "delete", path } : { op: "set", path, value: after },
      );
      return;
    }
    const entries = (value: unknown) => (isPlainObject(value) ? value : {});
    diffEntries(path, level, entries(before), entries(after), patches);
    return;
  }
  if (after === undefined) {
    patches.push({ op: "delete", path });
  } else if (level === undefined || !isPlainObject(before) || !isPlainObject(after)) {
    patches.push({ op: "set", path, value: after });
  } else {
    diffEntries(path, level, before, after, patches);
  }
}

/**
 * The patches that turn one value at a path into another, as fine-grained as the document is. A flat
 * level has nothing of its own to change, so it always comes down to its entries, apart from a
 * standing one that comes or goes: that is a patch of its own, which `Draft` takes apart.
 */
export function diff(path: Path, before: unknown, after: unknown): Patch[] {
  const patches: Patch[] = [];
  diffAt(path, levelAt(path), before, after, patches);
  return patches;
}

export function getIn(root: unknown, path: Path): unknown {
  let node = root;
  for (const key of path) {
    if (!isPlainObject(node) || !Object.hasOwn(node, key)) return undefined;
    node = node[key];
  }
  return node;
}

/**
 * A value the way the document will hold it, which is also how it comes back: nothing is undefined,
 * and a level without entries that has no map of its own is not there at all, unless it is one that
 * stands on its own.
 */
export function settled(path: Path, value: unknown): unknown {
  const level = levelAt(path);
  return level === undefined ? value : settledIn(level, value);
}

/**
 * See `settled`. A value that is that way already comes back as it is, the same object, so that what
 * did not change is quick to tell apart, see `diff`.
 */
function settledIn(level: Level, value: unknown): unknown {
  if (!isPlainObject(value)) return value;
  let changed = false;
  const entries: [string, unknown][] = [];
  for (const [key, item] of Object.entries(value)) {
    const inner = levelIn(level, key);
    const kept = inner === undefined ? item : settledIn(inner, item);
    if (kept === undefined) {
      changed = true;
      continue;
    }
    if (kept !== item) changed = true;
    entries.push([key, kept]);
  }
  if (entries.length === 0 && isFlatLevel(level) && !isStandingLevel(level)) return undefined;
  return changed ? Object.fromEntries(entries) : value;
}

/** A change the way the document will hold it. */
export function settledPatch(patch: Patch): Patch {
  if (patch.op !== "set") return patch;
  const value = settled(patch.path, patch.value);
  return value === undefined ? { op: "delete", path: patch.path } : { ...patch, value };
}

/**
 * Changes a plain object without touching the original: only what changes is copied, the rest is
 * shared. Objects that did not change keep their identity, so the interface can skip them.
 */
export class Mutator<T extends object> {
  readonly #owned = new WeakSet<object>();
  /** How many entries a level has left. Counting them for each one that goes takes too long. */
  readonly #entries = new WeakMap<object, number>();
  #root: T;

  constructor(root: T) {
    this.#root = root;
  }

  get root(): T {
    return this.#root;
  }

  #own(node: Plain): Plain {
    if (this.#owned.has(node)) return node;
    const copy = { ...node };
    this.#owned.add(copy);
    return copy;
  }

  /** The owned object at the parent of a path, creating what is missing on the way. */
  #parent(path: Path): Plain {
    const root = this.#own(this.#root as unknown as Plain);
    this.#root = root as unknown as T;
    let node = root;
    for (const key of path.slice(0, -1)) {
      const child = node[key];
      const owned = this.#own(isPlainObject(child) ? child : {});
      node[key] = owned;
      node = owned;
    }
    return node;
  }

  set(path: Path, value: unknown): void {
    const key = path.at(-1);
    if (key === undefined) return;
    const parent = this.#parent(path);
    const left = this.#entries.get(parent);
    if (left !== undefined && !Object.hasOwn(parent, key)) this.#entries.set(parent, left + 1);
    parent[key] = value;
  }

  delete(path: Path): void {
    const key = path.at(-1);
    if (key === undefined || getIn(this.#root, path) === undefined) return;
    const parent = this.#parent(path);
    const level = path.slice(0, -1);
    if (!isFlat(level)) {
      delete parent[key];
      return;
    }
    const left = (this.#entries.get(parent) ?? Object.keys(parent).length) - 1;
    delete parent[key];
    this.#entries.set(parent, left);
    // A standing level stays without its last entry. Whether it is still there is for the document.
    if (left === 0 && !isStanding(level)) this.delete(level);
  }

  apply(patch: Patch): void {
    if (patch.op === "delete") this.delete(patch.path);
    else this.set(patch.path, patch.value);
  }
}
