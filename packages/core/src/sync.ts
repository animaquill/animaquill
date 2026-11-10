import * as Y from "yjs";
import { USER, type Origin } from "./origin.ts";

/**
 * What it takes to keep a project in step with copies of it elsewhere, such as the working copy on a
 * platform: who a change comes from, what a copy has, and whether an update is one the editor could
 * have made. Updates stay opaque outside of core, see `ProjectStore`.
 */

const CLOUD = "cloud:";

/** A change that came from the platform, as its update with this number there. */
export const cloudOrigin = (seq: number): Origin => `${CLOUD}${seq}`;

/** The number on the platform of a change that came from there, or undefined for any other. */
export const cloudSeqOf = (origin: Origin): number | undefined => {
  if (!origin.startsWith(CLOUD)) return undefined;
  const seq = Number(origin.slice(CLOUD.length));
  return Number.isSafeInteger(seq) && seq >= 0 ? seq : undefined;
};

/**
 * Who made a change, as far as copies elsewhere go: the person at the editor, a batch of files that
 * changed in the project folder, an AI task, the platform, or something else. Only "user" is a
 * person, see `USER`.
 */
export type SourceKind = "user" | "folder" | "ai" | "cloud" | "other";

export const sourceKindOf = (origin: Origin): SourceKind => {
  if (origin === USER) return "user";
  if (origin.startsWith("folder:")) return "folder";
  if (origin.startsWith("ai:")) return "ai";
  if (cloudSeqOf(origin) !== undefined) return "cloud";
  return "other";
};

/** What a copy of a project has, as Yjs counts it: compare it with `isAhead`. */
export const stateVectorOfUpdate = (update: Uint8Array): Uint8Array =>
  Y.encodeStateVectorFromUpdate(update);

/**
 * Whether the copy with state vector `a` has something that the one with `b` does not. Only what
 * was added counts: what was taken away does not show in a state vector.
 */
export const isAhead = (a: Uint8Array, b: Uint8Array): boolean => {
  const theirs = Y.decodeStateVector(b);
  for (const [client, clock] of Y.decodeStateVector(a)) {
    if (clock > (theirs.get(client) ?? 0)) return true;
  }
  return false;
};

/** An update that changes nothing, such as one that only says where a copy got to. */
export const EMPTY_UPDATE: Uint8Array = Y.encodeStateAsUpdate(new Y.Doc());

/** Whether an update has nothing in it at all. */
export const isEmptyUpdate = (update: Uint8Array): boolean => {
  const { structs, ds } = Y.decodeUpdate(update);
  return structs.length === 0 && ds.clients.size === 0;
};

/** Why an update is not one the editor makes, see `checkUpdate`. */
export type UpdateFault =
  /** It cannot be read. */
  | "malformed"
  /** It writes somewhere else than the project, or kinds of values the editor never writes. */
  | "foreign"
  /** It has more pieces than a copy takes in at once, see `checkUpdate`. */
  | "too-large";

/** The name the project has in the Yjs document, see `ProjectStore`. */
export const PROJECT_ROOT = "project";

/**
 * Whether an update only holds what the editor itself writes into a project: maps, texts and plain
 * values, all in the project. A copy that takes updates from elsewhere checks them with this before
 * it takes them in, as the platform does. Reading it all is what finds a damaged one, before any of
 * it is in a document. When the editor starts to write another kind of value, it has to go in here
 * too: the platform would turn it away. `most` is how many pieces it may have, see `piecesOf`, as
 * taking in each one costs time and memory.
 *
 * It reads the update as it goes, piece by piece, and makes nothing of it: a large one costs no more
 * memory than its bytes, and one with too many pieces is known before Yjs would read them all.
 */
export const checkUpdate = (
  update: Uint8Array,
  { most = Number.POSITIVE_INFINITY }: { readonly most?: number } = {},
): UpdateFault | undefined => {
  try {
    return scanUpdate(new UpdateReader(update), most, { structs: 0, values: 0 });
  } catch {
    return "malformed";
  }
};

/** What an update is made of, as taking it in costs memory, see `piecesOf`. */
export interface Pieces {
  /** Structs of Yjs, and ranges of what it takes away. */
  structs: number;
  /** Values inside of plain values: every array, object, string or number in them, also nested. */
  values: number;
}

/**
 * The pieces of an update: what costs memory once it is in a document, much more than its bytes
 * say where they are many small ones. Undefined where it cannot be read.
 */
export function piecesOf(update: Uint8Array): Pieces | undefined {
  const pieces = { structs: 0, values: 0 };
  try {
    return scanUpdate(new UpdateReader(update), Number.POSITIVE_INFINITY, pieces)
      ? undefined
      : pieces;
  } catch {
    return undefined;
  }
}

/** Kinds of content of an item, as Yjs numbers them, that the editor writes. */
const CONTENT_DELETED = 1;
const CONTENT_JSON = 2;
const CONTENT_STRING = 4;
const CONTENT_TYPE = 7;
const CONTENT_ANY = 8;
/** Kinds Yjs has that the editor never writes: binary, embed, format, doc. */
const FOREIGN_CONTENT = new Set([3, 5, 6, 9]);
/** Types, as Yjs numbers them, that the editor makes: maps and texts. */
const TYPE_MAP = 1;
const TYPE_TEXT = 2;

/** Reads an update of Yjs (format 1) the way Yjs and lib0 do, only to skip over it. */
class UpdateReader {
  readonly #data: Uint8Array;
  #at = 0;

  constructor(data: Uint8Array) {
    this.#data = data;
  }

  byte(): number {
    const byte = this.#data[this.#at];
    if (byte === undefined) throw new RangeError("the update ends early");
    this.#at += 1;
    return byte;
  }

  /** lib0's varUint. */
  uint(): number {
    let value = 0;
    let factor = 1;
    for (;;) {
      const byte = this.byte();
      value += (byte & 0b0111_1111) * factor;
      factor *= 128;
      if (byte < 0b1000_0000) return value;
      if (value > Number.MAX_SAFE_INTEGER) throw new RangeError("a number out of range");
    }
  }

  /** lib0's varInt: six bits and a sign in the first byte. */
  skipInt(): void {
    let byte = this.byte();
    let value = byte & 0b0011_1111;
    let factor = 64;
    while (byte >= 0b1000_0000) {
      byte = this.byte();
      value += (byte & 0b0111_1111) * factor;
      factor *= 128;
      if (value > Number.MAX_SAFE_INTEGER) throw new RangeError("a number out of range");
    }
  }

  skip(bytes: number): void {
    if (this.#at + bytes > this.#data.length) throw new RangeError("the update ends early");
    this.#at += bytes;
  }

  /** A varUint8Array or a varString of lib0. */
  skipBytes(): void {
    this.skip(this.uint());
  }

  /** Whether the next varString is `ascii`, which has only ASCII in it. */
  isString(ascii: string): boolean {
    const length = this.uint();
    const start = this.#at;
    this.skip(length);
    if (length !== ascii.length) return false;
    for (let index = 0; index < length; index++) {
      if (this.#data[start + index] !== ascii.charCodeAt(index)) return false;
    }
    return true;
  }

  /**
   * lib0's `readAny`, without recursion: as deep as it may be, it is no deeper than its bytes.
   * Resolves to how many values it had, nested ones too.
   */
  skipAny(): number {
    let values = 0;
    // How many values each open array or object has still, and whether a key comes before each.
    const open: { left: number; readonly keyed: boolean }[] = [{ left: 1, keyed: false }];
    while (open.length > 0) {
      const top = open.at(-1) as { left: number; keyed: boolean };
      if (top.left === 0) {
        open.pop();
        continue;
      }
      top.left -= 1;
      if (top.keyed) this.skipBytes();
      values += 1;
      const tag = this.byte();
      switch (tag) {
        case 127: // undefined
        case 126: // null
        case 121: // false
        case 120: // true
          break;
        case 125:
          this.skipInt();
          break;
        case 124:
          this.skip(4);
          break;
        case 123:
        case 122:
          this.skip(8);
          break;
        case 119: // a string
        case 116: // bytes
          this.skipBytes();
          break;
        case 118:
          open.push({ left: this.uint(), keyed: true });
          break;
        case 117:
          open.push({ left: this.uint(), keyed: false });
          break;
        default:
          throw new RangeError(`no value of kind ${tag}`);
      }
    }
    return values;
  }
}

/** See `checkUpdate`: the structs of each client, then what is taken away. Counts into `pieces`. */
function scanUpdate(read: UpdateReader, most: number, pieces: Pieces): UpdateFault | undefined {
  const isTooMany = () => pieces.structs + pieces.values > most;
  const clients = read.uint();
  for (let client = 0; client < clients; client++) {
    const structs = read.uint();
    pieces.structs += structs;
    if (isTooMany()) return "too-large";
    read.uint(); // the client
    read.uint(); // the clock of its first struct
    for (let index = 0; index < structs; index++) {
      const info = read.byte();
      const kind = info & 0b1_1111;
      if (kind === 0 || kind === 10) {
        // GC, and Skip: lengths only.
        read.uint();
        continue;
      }
      const hasOrigin = (info & 0b1000_0000) !== 0;
      const hasRightOrigin = (info & 0b0100_0000) !== 0;
      if (hasOrigin) {
        read.uint();
        read.uint();
      }
      if (hasRightOrigin) {
        read.uint();
        read.uint();
      }
      if (!hasOrigin && !hasRightOrigin) {
        if (read.uint() === 1) {
          // A type at the top of the document, by its name.
          if (!read.isString(PROJECT_ROOT)) return "foreign";
        } else {
          read.uint();
          read.uint();
        }
        if ((info & 0b0010_0000) !== 0) read.skipBytes(); // the key in a map
      }
      if (FOREIGN_CONTENT.has(kind)) return "foreign";
      switch (kind) {
        case CONTENT_DELETED:
          read.uint();
          break;
        case CONTENT_JSON: {
          const values = read.uint();
          for (let value = 0; value < values; value++) read.skipBytes();
          pieces.values += values;
          if (isTooMany()) return "too-large";
          break;
        }
        case CONTENT_STRING:
          read.skipBytes();
          break;
        case CONTENT_TYPE: {
          const type = read.uint();
          if (type !== TYPE_MAP && type !== TYPE_TEXT) return "foreign";
          break;
        }
        case CONTENT_ANY: {
          const values = read.uint();
          for (let value = 0; value < values; value++) {
            pieces.values += read.skipAny();
            if (isTooMany()) return "too-large";
          }
          break;
        }
        default:
          return "malformed";
      }
    }
  }
  // What is taken away: ranges by client.
  const deleting = read.uint();
  for (let client = 0; client < deleting; client++) {
    read.uint();
    const ranges = read.uint();
    pieces.structs += ranges;
    if (isTooMany()) return "too-large";
    for (let range = 0; range < ranges; range++) {
      read.uint();
      read.uint();
    }
  }
  return undefined;
}

/** The ranges of what was taken away, by client, merged and in order. */
function deletedRanges(update: Uint8Array): Map<number, [number, number][]> {
  const ranges = new Map<number, [number, number][]>();
  const { ds } = Y.decodeUpdate(update);
  for (const [client, items] of ds.clients) {
    const sorted = items
      .map((item): [number, number] => [item.clock, item.clock + item.len])
      .toSorted((a, b) => a[0] - b[0]);
    const merged: [number, number][] = [];
    for (const range of sorted) {
      const last = merged.at(-1);
      if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
      else merged.push([...range]);
    }
    ranges.set(client, merged);
  }
  return ranges;
}

/**
 * Whether `have` takes away everything that `of` takes away: both updates, of which only what was
 * taken away counts, as `ProjectStore.deletions` makes them. What a state vector does not show.
 */
export function hasDeletionsOf(have: Uint8Array, of: Uint8Array): boolean {
  const mine = deletedRanges(have);
  for (const [client, ranges] of deletedRanges(of)) {
    const covering = mine.get(client) ?? [];
    let at = 0;
    for (const [start, end] of ranges) {
      while (at < covering.length && (covering[at] as [number, number])[1] <= start) at += 1;
      const cover = covering[at];
      if (!cover || cover[0] > start || cover[1] < end) return false;
    }
  }
  return true;
}
