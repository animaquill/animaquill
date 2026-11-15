import * as Y from "yjs";
import { flatKey, flatParts, isRetired, isStanding, isFlat, type Path } from "./structure.ts";

/**
 * What the document holds at a place, in a way that is the same after it was saved and opened
 * again: which change of Yjs put it there. A key of a map is the item that holds its value, by the
 * id of its last part (`<client>:<clock>`), with `-` when the value was taken away. Yjs joins items
 * of one client that follow each other once they are both gone, and splits them where something
 * points into one, but the last part keeps its id either way, so that is what this goes by. The text
 * of a file also says which pieces it is made of, and which of them are gone: an edit adds or takes
 * away a piece, also one that comes back to the same text. Nothing at all is "". A place whose maps
 * above are not there is "^".
 *
 * Measured on Yjs 13.6.33 (undo-marks.test.ts): the garbage collector keeps the items of a map that
 * is still there, with their ids, and only empties a map that went away itself; joining and
 * splitting items keep the id of the last part. Another value for the same key, also the same value
 * again, is always another item.
 */
export type Mark = string;

/** Where a place is in the document: a map, and the key in it. See `writePathOf`. */
interface Place {
  readonly maps: Path;
  readonly key: string;
}

const UNSAFE_KEY = "__proto__";
const NOWHERE: Mark = "^";
const NOTHING: Mark = "";

/** How far down a path the maps of their own go, as in store.ts. */
function mapDepth(path: Path): number {
  let depth = path.length - 1;
  while (depth > 0 && isFlat(path.slice(0, depth))) depth -= 1;
  return depth;
}

/** The place of what a change wrote at a path, as the store says where it wrote, see `Written`. */
function placeOf(where: Path): Place {
  // That a standing level is there is written down at `[...level, ""]`, see `writePathOf`.
  const isStandingMark = where.at(-1) === "" && isStanding(where.slice(0, -1));
  const path = isStandingMark ? where.slice(0, -1) : where;
  const depth = mapDepth(path);
  return { maps: path.slice(0, depth), key: flatKey(path.slice(depth)) };
}

type Entry = Y.Item;

/** What Yjs keeps of each key of a map, also of one whose value is gone. */
const entriesOf = (map: Y.Map<unknown>): Map<string, Entry> =>
  // oxlint-disable-next-line no-underscore-dangle -- what Yjs has no other way to read
  (map as unknown as { _map: Map<string, Entry> })._map;

/** A value of the document that is a map, or a text, or neither. */
const typeOf = (entry: Entry): Y.AbstractType<unknown> | undefined =>
  !entry.deleted && entry.content instanceof Y.ContentType
    ? (entry.content.type as Y.AbstractType<unknown>)
    : undefined;

function idOf(entry: Entry): string {
  return `${entry.id.client}:${entry.id.clock + entry.length - 1}${entry.deleted ? "-" : ""}`;
}

/** cyrb53: enough to tell two lists of pieces apart, in a few characters. */
function hash(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/**
 * The pieces a text is made of, and which are gone, as ranges of ids of each client: joined and
 * split pieces cover the same ranges.
 */
function piecesOf(text: Y.Text): string {
  const ranges = new Map<number, [number, number, boolean][]>();
  // oxlint-disable-next-line no-underscore-dangle -- what Yjs has no other way to read
  for (let item = text._start; item !== null; item = item.right) {
    const { client, clock } = item.id;
    let list = ranges.get(client);
    if (!list) ranges.set(client, (list = []));
    list.push([clock, item.length, item.deleted]);
  }
  const parts: string[] = [];
  for (const client of [...ranges.keys()].toSorted((a, b) => a - b)) {
    const list = (ranges.get(client) ?? []).toSorted((a, b) => a[0] - b[0]);
    const joined: [number, number, boolean][] = [];
    for (const [clock, length, deleted] of list) {
      const last = joined.at(-1);
      if (last && last[0] + last[1] === clock && last[2] === deleted) last[1] += length;
      else joined.push([clock, length, deleted]);
    }
    parts.push(`${client}:${joined.map(([c, l, d]) => `${c}+${l}${d ? "-" : ""}`).join(",")}`);
  }
  return hash(parts.join(";"));
}

function markOfEntry(entry: Entry | undefined): Mark {
  if (!entry) return NOTHING;
  const type = typeOf(entry);
  return type instanceof Y.Text ? `${idOf(entry)}|${piecesOf(type)}` : idOf(entry);
}

/** The map at a path, or undefined where a map on the way is not there. */
function mapAt(root: Y.Map<unknown>, path: Path): Y.Map<unknown> | undefined {
  let map = root;
  for (const key of path) {
    const next = map.get(key);
    if (!(next instanceof Y.Map)) return undefined;
    map = next as Y.Map<unknown>;
  }
  return map;
}

/**
 * Where a key of a map in the document was written, as the store says it, see `#onChange` in
 * store.ts. Undefined for what the store does not keep track of.
 */
export function writtenPathOf(base: Path, key: string, isMap: boolean): Path | undefined {
  const parts = flatParts(base, key);
  const path = parts ? [...base, ...parts] : [...base, key];
  if (path.includes(UNSAFE_KEY) || isRetired(path)) return undefined;
  return isStanding(path) && !isMap ? [...path, ""] : path;
}

const keyOf = (path: Path): string => path.join("\n");

/** Marks of places, by their path, see `marksAround`. */
export type Marks = Map<string, { readonly path: Path; readonly mark: Mark }>;

/**
 * The marks of what a write at a path is about: the maps it is in, the place itself, and everything
 * in it, where it is a map. Each of these changes when something is written there: whatever is
 * written above takes along what is below, and what is written below a map is part of it. A text is
 * part of its own mark.
 */
export function marksAround(root: Y.Map<unknown>, where: Path, into: Marks): void {
  const { maps, key } = placeOf(where);
  let map: Y.Map<unknown> | undefined = root;
  for (let depth = 0; depth < maps.length; depth++) {
    const path = maps.slice(0, depth + 1);
    const name = path[depth] as string;
    if (into.has(keyOf(path))) {
      map = mapAt(root, path);
      continue;
    }
    const entry: Entry | undefined = map ? entriesOf(map).get(name) : undefined;
    into.set(keyOf(path), { path, mark: map ? markOfEntry(entry) : NOWHERE });
    const next = entry && typeOf(entry);
    map = next instanceof Y.Map ? (next as Y.Map<unknown>) : undefined;
  }
  const entry = map ? entriesOf(map).get(key) : undefined;
  into.set(keyOf(where), { path: where, mark: map ? markOfEntry(entry) : NOWHERE });
  const type = entry && typeOf(entry);
  if (type instanceof Y.Map) marksBelow(type as Y.Map<unknown>, placePath(where), into);
}

/** The path of the map at a place, as the store reads what is in it. */
const placePath = (where: Path): Path =>
  where.at(-1) === "" && isStanding(where.slice(0, -1)) ? where.slice(0, -1) : where;

function marksBelow(map: Y.Map<unknown>, base: Path, into: Marks): void {
  for (const [key, entry] of entriesOf(map)) {
    const type = typeOf(entry);
    const path = writtenPathOf(base, key, type instanceof Y.Map);
    if (!path) continue;
    into.set(keyOf(path), { path, mark: markOfEntry(entry) });
    if (type instanceof Y.Map) marksBelow(type as Y.Map<unknown>, path, into);
  }
}

/** The mark of the manifest, which tells one document from another one of the same project. */
export const documentMark = (root: Y.Map<unknown>): Mark =>
  markOfEntry(entriesOf(root).get("manifest"));
