import * as Y from "yjs";
import { undoubled, type Insertion } from "./doubled-text.ts";
import { conflictAt, orderAt, type ConflictKind, type MergeConflict } from "./merge-files.ts";
import type { ProjectState } from "./model.ts";
import { deepEqual, getIn } from "./patch.ts";
import { ProjectStore } from "./store.ts";
import { flatParts, type Path } from "./structure.ts";
import { PLATFORM_CLIENT, PROJECT_ROOT } from "./sync.ts";

/**
 * What the platform wrote as a batch of its own, such as a merge from GitHub, kept so that changes
 * made without it, which arrive after it, can be told where they took something of it away, or it
 * something of theirs (docs/design/start-and-cloud-plan.md of AnimaQuill Cloud, A3). Yjs keeps
 * both sides where they did not change the same key, and of the same key the person's change, see
 * `PLATFORM_CLIENT`. What it does not keep, and no number decides:
 *
 * - a key the change took away, where the batch wrote it: the value of the batch stays, as the
 *   change took away only the value it had seen;
 * - a map the change took away, such as a clip, where the batch wrote into it: that goes with it;
 * - a value that is one key, such as an asset or a note, of which both changed other fields: the
 *   change's whole value stays, without what the batch changed;
 * - and the other way round, what the change wrote into a map, or a text, that the batch took away.
 *
 * Each of these is one side gone from the project without a word, which a conflict says, with what
 * the project has there (`ours`) and what went (`theirs`), so that people can take that back with
 * `conflict.take`. The batch keeps what it wrote at each key, as values the way the project has them,
 * the clocks it wrote with as the platform, and every id inside of the maps and texts it took away:
 * those are gone from the document by then, and an update that writes into them only says their ids.
 *
 * Whether a change was made without the batch is known where Yjs says it (it wrote a key over what
 * the batch wrote, or over what was there before), and otherwise from which update of the platform
 * its window had (`concurrent`), which can be older than the change, never newer: a change can then
 * count as made without a batch it saw, never the other way round.
 */

/** Ids of Yjs by client, as ranges of clocks, `[clock, length]`, in order. */
export type IdRanges = readonly (readonly [number, readonly (readonly [number, number])[]])[];

/** What a batch wrote at a key, see `PlatformBatch`. */
export interface BatchWrite {
  readonly path: Path;
  /** What was there before, where the batch took a value away or wrote over it. */
  readonly before?: unknown;
  /** What the batch put there: nothing where it took it away. */
  readonly after?: unknown;
  /** It changed a text, as one of code: by characters, so it has no value of its own. */
  readonly text?: true;
}

/** A map or a text that a batch took away, with every id that was inside of it. */
export interface BatchRemoved {
  readonly path: Path;
  readonly ids: IdRanges;
}

/** A file of code that a batch took as GitHub has it, see `MergedFile.copied`. */
export interface BatchCopy {
  readonly file: string;
  readonly insertion: Insertion;
}

/** What a batch of the platform wrote, see above. It goes into JSON as it is. */
export interface PlatformBatch {
  /** Its id: its origin is `repoBatch(batch)`. */
  readonly batch: string;
  /** The update of the platform that has it, which windows that have it know of. */
  readonly seq: number;
  /** The clocks of `PLATFORM_CLIENT` it wrote with, from the first to after the last. */
  readonly clocks: readonly [number, number];
  /** Each key it wrote, only the uppermost of what it wrote into. */
  readonly writes: readonly BatchWrite[];
  readonly removed: readonly BatchRemoved[];
  readonly copied: readonly BatchCopy[];
  /** The order of tracks or sections it left, where it wrote some of their numbers. */
  readonly orders: readonly BatchOrder[];
}

/** The order of the tracks or the sections of a timeline, by their ids. */
export interface BatchOrder {
  readonly timeline: string;
  readonly level: "tracks" | "sections";
  readonly ids: readonly string[];
}

/** A key a change wrote, as the project had it before and after. */
export interface KeyChange {
  readonly path: Path;
  readonly before: unknown;
  readonly after: unknown;
  /** Only characters of a text changed. */
  readonly text?: true;
  /** Where Yjs keeps it, while the document is at hand. */
  readonly at?: { readonly map: Y.Map<unknown>; readonly key: string };
}

/** What a change did, as `watch` saw it. */
export interface Watched<T> {
  readonly result: T;
  readonly before: ProjectState;
  readonly after: ProjectState;
  readonly changes: readonly KeyChange[];
  readonly removed: readonly BatchRemoved[];
}

type Ranges = Map<number, [number, number][]>;

const keyOf = (path: Path) => path.join("\u0000");

const isPrefix = (prefix: Path, path: Path) =>
  prefix.length <= path.length && prefix.every((part, index) => path[index] === part);

/** What Yjs keeps of each key of a map, also of one whose value is gone. */
const entriesOf = (map: Y.Map<unknown> | Y.AbstractType<unknown>): Map<string, Y.Item> =>
  // oxlint-disable-next-line no-underscore-dangle -- what Yjs has no other way to read
  (map as unknown as { _map: Map<string, Y.Item> })._map;

/** The item of Yjs that holds a type, where it is inside of another one. */
const itemOf = (type: Y.AbstractType<unknown>): Y.Item | null =>
  // oxlint-disable-next-line no-underscore-dangle -- what Yjs has no other way to read
  type._item;

/** The first piece of a type that is a list, such as a text. */
const startOf = (type: Y.AbstractType<unknown>): Y.Item | null =>
  // oxlint-disable-next-line no-underscore-dangle -- what Yjs has no other way to read
  type._start;

/** The keys of Yjs from the project down to a type: undefined for one that is not in it any more. */
function keysOfType(root: Y.Map<unknown>, type: Y.AbstractType<unknown>): string[] | undefined {
  const keys: string[] = [];
  let at: Y.AbstractType<unknown> = type;
  while (at !== root) {
    const item = itemOf(at);
    if (!item || item.parentSub === null || !(item.parent instanceof Y.AbstractType)) {
      return undefined;
    }
    keys.unshift(item.parentSub);
    at = item.parent as Y.AbstractType<unknown>;
  }
  return keys;
}

/** The path in the project of a key of a map at these keys, as `ProjectStore` reads it. */
function pathOfKey(keys: Path, key: string): Path {
  const parts = flatParts(keys, key);
  return parts ? [...keys, ...parts] : [...keys, key];
}

function addRange(ranges: Ranges, client: number, clock: number, length: number): void {
  let list = ranges.get(client);
  if (!list) ranges.set(client, (list = []));
  list.push([clock, length]);
}

/** Every id inside of an item, also of what was written over or taken away there before. */
function idsInside(item: Y.Item, ranges: Ranges): void {
  addRange(ranges, item.id.client, item.id.clock, item.length);
  if (!(item.content instanceof Y.ContentType)) return;
  const type = item.content.type as Y.AbstractType<unknown>;
  const visit = (each: Y.Item | null) => {
    if (each instanceof Y.Item) idsInside(each, ranges);
  };
  for (const last of entriesOf(type).values()) {
    for (let each: Y.Item | null = last; each; each = each.left) visit(each);
  }
  for (let each = startOf(type); each; each = each.right) visit(each);
}

function sortedRanges(ranges: Ranges): IdRanges {
  return [...ranges.entries()]
    .toSorted(([a], [b]) => a - b)
    .map(([client, list]) => {
      const merged: [number, number][] = [];
      for (const [clock, length] of list.toSorted(([a], [b]) => a - b)) {
        const last = merged.at(-1);
        if (last && clock <= last[0] + last[1]) {
          last[1] = Math.max(last[1], clock + length - last[0]);
        } else merged.push([clock, length]);
      }
      return [client, merged] as const;
    });
}

/** Whether an id is in some ranges. */
function hasId(ranges: ReadonlyMap<number, readonly (readonly [number, number])[]>, id: Y.ID) {
  const list = ranges.get(id.client);
  if (!list) return false;
  let low = 0;
  let high = list.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const [clock, length] = list[middle] as readonly [number, number];
    if (id.clock < clock) high = middle - 1;
    else if (id.clock >= clock + length) low = middle + 1;
    else return true;
  }
  return false;
}

/** The structs of the document in a range of a client, as they are now. */
function* structsIn(doc: Y.Doc, client: number, clock: number, length: number) {
  const structs = doc.store.clients.get(client);
  if (!structs || structs.length === 0) return;
  const last = structs.at(-1) as Y.Item | Y.GC;
  const first = structs[0] as Y.Item | Y.GC;
  if (clock >= last.id.clock + last.length || clock + length <= first.id.clock) return;
  const start = Y.findIndexSS(structs, Math.max(clock, first.id.clock));
  for (let index = start; index < structs.length; index++) {
    const struct = structs[index] as Y.Item | Y.GC;
    if (struct.id.clock >= clock + length) return;
    yield struct;
  }
}

/** The maps and texts that a transaction took away, at the top: what was in them goes with them. */
function removedIn(transaction: Y.Transaction, root: Y.Map<unknown>, into: BatchRemoved[]): void {
  transaction.deleteSet.clients.forEach((items, client) => {
    for (const { clock, len } of items) {
      for (const struct of structsIn(transaction.doc, client, clock, len)) {
        if (!(struct instanceof Y.Item) || !(struct.content instanceof Y.ContentType)) continue;
        if (struct.parentSub === null || !(struct.parent instanceof Y.AbstractType)) continue;
        const parent = struct.parent as Y.AbstractType<unknown>;
        if (itemOf(parent)?.deleted) continue;
        const keys = keysOfType(root, parent);
        if (!keys) continue;
        const ranges: Ranges = new Map();
        idsInside(struct, ranges);
        into.push({ path: pathOfKey(keys, struct.parentSub), ids: sortedRanges(ranges) });
      }
    }
  });
}

/**
 * Runs `run`, which changes the project, and says what it changed at each key, with the project as
 * it was and is, and the maps and texts it took away.
 */
export function watch<T>(store: ProjectStore, run: () => T): Watched<T> {
  const doc = store.doc;
  const root = doc.getMap<unknown>(PROJECT_ROOT);
  const before = store.getState();
  const touched = new Map<string, { path: Path; text: boolean; at?: KeyChange["at"] }>();
  const removed: BatchRemoved[] = [];
  const onAfter = (transaction: Y.Transaction) => {
    transaction.changed.forEach((keys, type) => {
      const above = keysOfType(root, type as Y.AbstractType<unknown>);
      if (!above) return;
      for (const key of keys) {
        if (key === null) {
          const item = itemOf(type as Y.AbstractType<unknown>);
          if (!(type instanceof Y.Text) || !item?.parentSub || !(item.parent instanceof Y.Map)) {
            continue;
          }
          const id = keyOf(above);
          const at = { map: item.parent as Y.Map<unknown>, key: item.parentSub };
          if (!touched.has(id)) touched.set(id, { path: above, text: true, at });
          continue;
        }
        if (!(type instanceof Y.Map)) continue;
        const path = pathOfKey(above, key);
        touched.set(keyOf(path), { path, text: false, at: { map: type as Y.Map<unknown>, key } });
      }
    });
    removedIn(transaction, root, removed);
  };
  doc.on("afterTransaction", onAfter);
  let result: T;
  try {
    result = run();
  } finally {
    doc.off("afterTransaction", onAfter);
  }
  const after = store.getState();
  const changes: KeyChange[] = [];
  for (const { path, text, at } of touched.values()) {
    const was = getIn(before, path);
    const is = getIn(after, path);
    if (!text && deepEqual(was, is)) continue;
    if (text && was === is) continue;
    changes.push({ path, before: was, after: is, ...(text && { text: true }), ...(at && { at }) });
  }
  return { result, before, after, changes, removed };
}

/** The item of Yjs that holds the value at a path of maps, if it is one. */
function itemAt(root: Y.Map<unknown>, path: Path): Y.Item | undefined {
  let map: Y.Map<unknown> = root;
  for (const key of path.slice(0, -1)) {
    const next = map.get(key);
    if (!(next instanceof Y.Map)) return undefined;
    map = next as Y.Map<unknown>;
  }
  const item = entriesOf(map).get(path.at(-1) as string);
  return item && !item.deleted ? item : undefined;
}

/** Only what nothing else of them is above. */
function uppermost<T extends { readonly path: Path }>(items: readonly T[]): T[] {
  const sorted = items.toSorted((a, b) => a.path.length - b.path.length);
  const kept: T[] = [];
  for (const item of sorted) {
    if (!kept.some((above) => isPrefix(above.path, item.path))) kept.push(item);
  }
  return kept;
}

/**
 * Writes what `write` does as the platform (`ProjectStore.writeAsPlatform`), as the batch `batch`,
 * and says what it wrote, see `PlatformBatch`: `seq` and `copied` are for whoever keeps it to say.
 */
export function writeBatch<T>(
  store: ProjectStore,
  batch: string,
  write: () => T,
): { readonly result: T; readonly batch: PlatformBatch; readonly watched: Watched<T> } {
  const from = Y.getState(store.doc.store, PLATFORM_CLIENT);
  const watched = watch(store, () => store.writeAsPlatform(write));
  const to = Y.getState(store.doc.store, PLATFORM_CLIENT);
  const writes = uppermost(watched.changes).map(({ path, before, after, text }): BatchWrite =>
    text
      ? { path, text: true }
      : {
          path,
          ...(before !== undefined && { before }),
          ...(after !== undefined && { after }),
        },
  );
  const levels = new Map<string, BatchOrder>();
  for (const { path } of writes) {
    const [root, timeline = "", level] = path;
    if (root !== "timelines" || (level !== "tracks" && level !== "sections")) continue;
    if (path.length !== 4 && !isOrderLeaf(path)) continue;
    if (!Object.hasOwn(watched.after.timelines, timeline)) continue;
    levels.set(`${timeline}\u0001${level}`, {
      timeline,
      level,
      ids: orderAt(watched.after, timeline, level),
    });
  }
  return {
    result: watched.result,
    watched,
    batch: {
      batch,
      seq: 0,
      clocks: [from, to],
      writes,
      removed: uppermost(watched.removed),
      copied: [],
      orders: [...levels.values()],
    },
  };
}

/** Whether an item is one that a batch wrote. */
const isOf = (batch: PlatformBatch, item: { readonly id: Y.ID } | null | undefined) =>
  !!item &&
  item.id.client === PLATFORM_CLIENT &&
  item.id.clock >= batch.clocks[0] &&
  item.id.clock < batch.clocks[1];

const isOfId = (batch: PlatformBatch, id: Y.ID | null) =>
  !!id &&
  id.client === PLATFORM_CLIENT &&
  id.clock >= batch.clocks[0] &&
  id.clock < batch.clocks[1];

/** A conflict found late, of a batch. */
export interface LateConflict extends MergeConflict {
  /** The batch it is of. */
  readonly batch: string;
  /**
   * Whose went: what the batch wrote, which counts as it was the first time it went, or what the
   * change did, which counts as the latest change says it, as those of a window come one by one.
   */
  readonly lost: "batch" | "change";
  /**
   * What went is what the change wrote into what the batch took away: it is only in the project as
   * it would be without the batch, see `valuesWithout`. Until then `theirs` is what was there before
   * the batch, without the change.
   */
  readonly without?: true;
}

/** What came of a change that arrived after batches it may not have had. */
export interface LateOutcome {
  readonly conflicts: readonly LateConflict[];
  /** Files of code where a batch's text is there more than once, as it is to be, once. */
  readonly doubled: readonly {
    readonly batch: string;
    readonly file: string;
    readonly text: string;
  }[];
}

const isOrderLeaf = (path: Path) =>
  path.length === 5 &&
  path[0] === "timelines" &&
  (path[2] === "tracks" || path[2] === "sections") &&
  path[4] === "order";

const kindAt = (path: Path): ConflictKind =>
  path[0] === "files" && path.length === 2 ? "file" : path[0] === "places" ? "asset-file" : "value";

/** The value of an item of an update, as it came: what is inside of a map or a text comes apart. */
function valueOfItem(item: Y.Item): unknown {
  const [value] = item.content.getContent() as unknown[];
  return value instanceof Y.AbstractType ? (value as Y.AbstractType<unknown>).toJSON() : value;
}

/**
 * What a change, as `watch` saw it while it went into the copy of the platform, took away of the
 * batches it may not have had (`concurrent`), and they of it, as conflicts, see above; and the
 * files of code where it brought in what a batch did once more. `update` is the change as it came.
 */
export function lateOf(
  store: ProjectStore,
  batches: readonly PlatformBatch[],
  change: { readonly update: Uint8Array; readonly watched: Watched<unknown> },
  concurrent: (batch: PlatformBatch) => boolean,
): LateOutcome {
  const late = batches.filter(concurrent);
  if (late.length === 0) return { conflicts: [], doubled: [] };
  const { after, changes } = change.watched;
  const doc = store.doc;
  const root = doc.getMap<unknown>(PROJECT_ROOT);
  const conflicts = new Map<string, LateConflict>();
  const doubled: { batch: string; file: string; text: string }[] = [];
  const add = (
    batch: PlatformBatch,
    path: Path,
    ours: unknown,
    theirs: unknown,
    extra: { kind?: ConflictKind; lost: LateConflict["lost"]; without?: true },
  ) => {
    const id = `${batch.batch}\u0001${extra.lost}\u0001${keyOf(path)}`;
    if (conflicts.has(id)) return;
    const conflict = conflictAt(after, { path, kind: extra.kind ?? kindAt(path), ours, theirs });
    conflicts.set(id, {
      ...conflict,
      batch: batch.batch,
      lost: extra.lost,
      ...(extra.without && { without: true }),
    });
  };

  // What the change took away or wrote over, of what a batch wrote: it shows in the project.
  for (const batch of late) {
    for (const key of changes) {
      if (key.text) continue;
      for (const write of batch.writes) {
        if (isPrefix(key.path, write.path) && key.path.length < write.path.length) {
          // A map above what the batch wrote, taken away or written over.
          const rest = write.path.slice(key.path.length);
          const was = getIn(key.before, rest);
          const is = getIn(key.after, rest);
          const isIntact = write.text ? was !== undefined : deepEqual(was, write.after);
          if (!isIntact || (write.text ? was === is : deepEqual(is, write.after))) continue;
          add(batch, key.path, key.after, key.before, { lost: "batch" });
          continue;
        }
        if (keyOf(key.path) !== keyOf(write.path)) continue;
        const isIntact = write.text ? key.before !== undefined : deepEqual(key.before, write.after);
        if (!isIntact) continue;
        const item = key.at && entriesOf(key.at.map).get(key.at.key);
        // It took away what the batch put there, or wrote over it: it had it.
        if (item?.deleted && isOf(batch, item)) continue;
        if (item && !item.deleted && isOfId(batch, item.origin)) continue;
        // The numbers of an order only say something together, see below.
        if (isOrderLeaf(key.path)) continue;
        add(batch, key.path, key.after, key.before, { lost: "batch" });
      }
    }
  }

  // The order of tracks or sections, which is in all of their numbers together: of a level where
  // both the change and the batch wrote some of them.
  const changedOrders = changes.filter((key) => isOrderLeaf(key.path));
  const levels = new Set(changedOrders.map((key) => `${key.path[1]}\u0001${key.path[2]}`));
  for (const batch of late) {
    for (const level of levels) {
      const [timeline = "", which] = level.split("\u0001") as [string, "tracks" | "sections"];
      const wrote = batch.writes.filter(
        (write) =>
          write.path[0] === "timelines" &&
          write.path[1] === timeline &&
          write.path[2] === which &&
          (write.path.length === 4 || isOrderLeaf(write.path)),
      );
      if (wrote.length > 0) orderConflicts(batch, timeline, which, wrote);
    }
  }

  function orderConflicts(
    batch: PlatformBatch,
    timeline: string,
    level: "tracks" | "sections",
    wrote: readonly BatchWrite[],
  ) {
    const now = orderAt(after, timeline, level);
    const path = ["timelines", timeline, level];
    // The order the batch left, of what is still there.
    const left = batch.orders.find((each) => each.timeline === timeline && each.level === level);
    if (left) {
      const was = left.ids.filter((id) => now.includes(id));
      const is = now.filter((id) => was.includes(id));
      if (!deepEqual(was, is)) add(batch, path, is, was, { kind: "order", lost: "batch" });
    }
    // The order the change meant: its numbers, and those before the batch where the batch wrote.
    const made = new Set<string>();
    const old = new Map<string, unknown>();
    for (const write of wrote) {
      const id = write.path[3];
      if (id === undefined) continue;
      if (write.path.length === 4 && write.before === undefined) made.add(id);
      else if (isOrderLeaf(write.path)) old.set(id, write.before);
      else old.set(id, (write.before as { order?: unknown } | undefined)?.order);
    }
    const timelineNow = after.timelines[timeline];
    if (!timelineNow || !Object.hasOwn(after.timelines, timeline)) return;
    const items = { ...(timelineNow[level] as Record<string, { order: number }>) };
    for (const [id, item] of Object.entries(items)) {
      // Where the batch's number is still there, the change did not write one.
      const was = old.get(id);
      const isTheBatch = isOf(batch, itemAt(root, ["timelines", timeline, level, id, "order"]));
      if (isTheBatch && typeof was === "number" && was !== item.order) {
        items[id] = { ...item, order: was };
      }
    }
    const meantState: ProjectState = {
      ...after,
      timelines: { ...after.timelines, [timeline]: { ...timelineNow, [level]: items } },
    };
    const meant = orderAt(meantState, timeline, level).filter((id) => !made.has(id));
    const kept = now.filter((id) => !made.has(id));
    if (!deepEqual(meant, kept)) add(batch, path, kept, meant, { kind: "order", lost: "change" });
  }

  // What the change wrote into what a batch took away, or took away of what it wrote: that does not
  // show in the project, only in the change.
  const { structs, ds } = Y.decodeUpdate(change.update);
  for (const batch of late) {
    const removed = batch.removed.map((each) => ({
      path: each.path,
      ids: new Map(each.ids.map(([client, list]) => [client, list])),
    }));
    if (removed.length > 0) {
      // Each struct of the change that points into a map or a text that the batch took away, or
      // into what the change itself put there.
      const own = new Map<number, [number, number, Path][]>();
      const lostIn = (id: Y.ID | null): Path | undefined => {
        if (!id) return undefined;
        for (const each of removed) if (hasId(each.ids, id)) return each.path;
        for (const [clock, length, path] of own.get(id.client) ?? []) {
          if (id.clock >= clock && id.clock < clock + length) return path;
        }
        return undefined;
      };
      const into = new Map<Y.Item, Path>();
      for (let isMore = true; isMore;) {
        isMore = false;
        for (const struct of structs) {
          if (!(struct instanceof Y.Item) || into.has(struct)) continue;
          const parent = struct.parent instanceof Y.ID ? struct.parent : null;
          const path = lostIn(struct.origin) ?? lostIn(struct.rightOrigin) ?? lostIn(parent);
          if (!path) continue;
          into.set(struct, path);
          let list = own.get(struct.id.client);
          if (!list) own.set(struct.id.client, (list = []));
          list.push([struct.id.clock, struct.length, path]);
          isMore = true;
        }
      }
      for (const path of new Set([...into.values()].map(keyOf))) {
        const at = path.split("\u0000");
        const write = batch.writes.find((each) => keyOf(each.path) === path);
        add(batch, at, getIn(after, at), write?.before, { lost: "change", without: true });
      }
    }

    // What the change wrote at a key where the batch's value came out on top after all.
    for (const struct of structs) {
      if (!(struct instanceof Y.Item)) continue;
      let item: Y.Item | Y.GC;
      try {
        item = Y.getItem(doc.store, struct.id);
      } catch {
        continue;
      }
      if (!(item instanceof Y.Item) || !item.deleted || Y.isDeleted(ds, struct.id)) continue;
      if (
        item.parentSub === null ||
        !(item.parent instanceof Y.Map) ||
        itemOf(item.parent as Y.AbstractType<unknown>)?.deleted
      ) {
        continue;
      }
      const now = entriesOf(item.parent as Y.Map<unknown>).get(item.parentSub);
      if (!now || now.deleted || !isOf(batch, now)) continue;
      const keys = keysOfType(root, item.parent as Y.AbstractType<unknown>);
      if (!keys) continue;
      const path = pathOfKey(keys, item.parentSub);
      add(batch, path, getIn(after, path), valueOfItem(struct), { lost: "change" });
    }

    // What the change took away where the batch wrote over it: the batch's value stays.
    ds.clients.forEach((items, client) => {
      for (const { clock, len } of items) {
        for (const struct of structsIn(doc, client, clock, len)) {
          if (!(struct instanceof Y.Item) || struct.parentSub === null || isOf(batch, struct))
            continue;
          if (
            !(struct.parent instanceof Y.Map) ||
            itemOf(struct.parent as Y.AbstractType<unknown>)?.deleted
          )
            continue;
          const now = entriesOf(struct.parent as Y.Map<unknown>).get(struct.parentSub);
          if (!now || now.deleted || now === struct || !isOf(batch, now)) continue;
          const keys = keysOfType(root, struct.parent as Y.AbstractType<unknown>);
          if (!keys) continue;
          const path = pathOfKey(keys, struct.parentSub);
          add(batch, path, getIn(after, path), undefined, { lost: "change" });
        }
      }
    });

    // The same lines of code from GitHub and from a folder that is a clone of the repository.
    for (const key of changes) {
      if (!key.text || key.path[0] !== "files" || key.path.length !== 2) continue;
      const file = key.path[1] as string;
      const copy = batch.copied.find((each) => each.file === file);
      if (!copy) {
        // The batch merged the file with what the platform had, which `undoubled` cannot put
        // right: where the change wrote it too, the same lines may be there twice, as from a
        // folder that came in before the platform's, see `ProjectOpening` of the editor.
        const wrote = batch.writes.some(
          (write) => write.text === true && keyOf(write.path) === keyOf(key.path),
        );
        if (wrote) {
          add(batch, key.path, key.after, undefined, { kind: "check-duplicate", lost: "change" });
        }
        continue;
      }
      if (typeof key.after !== "string") continue;
      const once = undoubled(key.after, copy.insertion);
      if (once !== undefined && once !== key.after) {
        doubled.push({ batch: batch.batch, file, text: once });
      } else {
        add(batch, key.path, key.after, undefined, { kind: "check-duplicate", lost: "change" });
      }
    }
  }
  return { conflicts: [...conflicts.values()], doubled };
}

/**
 * The values at some paths of the project as it would be without a batch, for what a change wrote
 * into what the batch took away (`LateConflict.without`): from the project as it was right before
 * the batch, and the updates since then but the batch's, the change last. Whatever of them waits
 * for something that is not there is left out, which `whole` says.
 */
export function valuesWithout(
  parts: readonly Uint8Array[],
  paths: readonly Path[],
): { readonly values: readonly unknown[]; readonly whole: boolean } {
  const { store } = ProjectStore.fromUpdates(parts);
  if (!store) return { values: paths.map(() => undefined), whole: false };
  const whole = !store.isMissingUpdates;
  if (!whole) store.catchUp([]);
  const state = store.getState();
  store.destroy();
  return { values: paths.map((path) => getIn(state, path)), whole };
}
