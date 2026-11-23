import { Readable } from "node:stream";
import { createGunzip } from "node:zlib";

/**
 * Reads the files out of a tarball of a repository, as GitHub gives one of a commit:
 * gzip around tar, every path under one folder at the
 * top that names the repository and the commit, long paths in pax headers. As it comes, without a
 * disk: only the files asked for are kept, the rest is passed over. Whatever does not read as such
 * a tarball, or is larger than it may be, rejects, and nothing of it counts: the caller gets the
 * files another way.
 */

/** What came is no tarball, or not all of one. */
export class TarballBroken extends Error {
  override name = "TarballBroken";
}

/** What came is larger than it may be. */
export class TarballTooLarge extends Error {
  override name = "TarballTooLarge";
}

export interface TarballOptions {
  /** Whether a file is wanted, by its path from the top of the repository. */
  readonly wanted: (path: string) => boolean;
  /** Bytes of the tarball as it comes, packed, at most. */
  readonly mostBytes: number;
  /** Bytes of the files kept, together, at most. */
  readonly mostKept: number;
}

const BLOCK = 512;

/** A number of a tar header: octal text, or binary where its first byte has the high bit. */
const numberAt = (header: Uint8Array, start: number, length: number): number => {
  const field = header.subarray(start, start + length);
  if ((field[0]! & 0x80) !== 0) {
    let value = field[0]! & 0x7f;
    for (let at = 1; at < field.length; at++) value = value * 256 + field[at]!;
    if (!Number.isSafeInteger(value)) throw new TarballBroken("a size too large");
    return value;
  }
  const text = Buffer.from(field).toString("latin1").replace(/\0.*$/s, "").trim();
  if (text === "") return 0;
  if (!/^[0-7]+$/.test(text)) throw new TarballBroken("a number that is none");
  return Number.parseInt(text, 8);
};

const textAt = (header: Uint8Array, start: number, length: number): string => {
  const field = header.subarray(start, start + length);
  const end = field.indexOf(0);
  return Buffer.from(end === -1 ? field : field.subarray(0, end)).toString("utf8");
};

/** Whether the header's checksum is what its bytes add up to, its own field as spaces. */
const isWhole = (header: Uint8Array): boolean => {
  let sum = 0;
  for (let at = 0; at < BLOCK; at++) sum += at >= 148 && at < 156 ? 32 : header[at]!;
  return sum === numberAt(header, 148, 8);
};

/** The records of a pax header: `<length> <key>=<value>\n`, each. */
const paxOf = (data: Uint8Array): Map<string, string> => {
  const records = new Map<string, string>();
  let at = 0;
  while (at < data.length) {
    const space = data.indexOf(0x20, at);
    if (space === -1) throw new TarballBroken("a pax record without its length");
    const length = Number(Buffer.from(data.subarray(at, space)).toString("latin1"));
    if (!Number.isSafeInteger(length) || length <= space - at || at + length > data.length)
      throw new TarballBroken("a pax record of a length that is none");
    const record = Buffer.from(data.subarray(space + 1, at + length - 1)).toString("utf8");
    const equals = record.indexOf("=");
    if (equals > 0) records.set(record.slice(0, equals), record.slice(equals + 1));
    at += length;
  }
  return records;
};

/** The path below the folder at the top of the tarball, which names the repository and commit. */
const belowTop = (path: string): string | undefined => {
  const slash = path.indexOf("/");
  if (slash === -1) return undefined;
  const rest = path.slice(slash + 1);
  return rest === "" ? undefined : rest;
};

/**
 * Reads a tar stream as it comes. Each block is looked at once: a header, the data of an entry
 * (kept only where it is wanted), or the end.
 */
class TarReader {
  readonly #options: TarballOptions;
  readonly files = new Map<string, Uint8Array>();
  #kept = 0;
  #pending: Buffer[] = [];
  #pendingBytes = 0;
  /** The entry whose data comes now: its path, size, what of it came, and whether it is kept. */
  #entry:
    | {
        readonly path: string | undefined;
        readonly kind: string;
        readonly size: number;
        readonly padded: number;
        readonly parts: Buffer[] | undefined;
        got: number;
      }
    | undefined;
  /** What a pax or long-name header says of the entry after it. */
  #next: { path?: string; size?: number } = {};
  #zeros = 0;
  ended = false;

  constructor(options: TarballOptions) {
    this.#options = options;
  }

  push(chunk: Buffer): void {
    if (this.ended) return;
    this.#pending.push(chunk);
    this.#pendingBytes += chunk.length;
    for (;;) {
      if (this.ended) return;
      if (this.#entry) {
        const left = this.#entry.padded - this.#entry.got;
        if (left === 0) {
          this.#finish();
          continue;
        }
        if (this.#pendingBytes === 0) return;
        const piece = this.#take(Math.min(left, this.#pendingBytes));
        const dataLeft = this.#entry.size - this.#entry.got;
        if (dataLeft > 0 && this.#entry.parts)
          this.#entry.parts.push(piece.subarray(0, Math.min(dataLeft, piece.length)));
        this.#entry.got += piece.length;
        continue;
      }
      if (this.#pendingBytes < BLOCK) return;
      this.#header(this.#take(BLOCK));
    }
  }

  /** The tar ended: whatever is not done means it is not all there. */
  end(): void {
    if (!this.ended) throw new TarballBroken("the tarball ends before its end");
  }

  #take(bytes: number): Buffer {
    const whole = this.#pending.length === 1 ? this.#pending[0]! : Buffer.concat(this.#pending);
    const piece = whole.subarray(0, bytes);
    const rest = whole.subarray(bytes);
    this.#pending = rest.length > 0 ? [rest] : [];
    this.#pendingBytes = rest.length;
    return piece;
  }

  #header(header: Buffer): void {
    if (header.every((byte) => byte === 0)) {
      this.#zeros += 1;
      if (this.#zeros === 2) this.ended = true;
      return;
    }
    if (this.#zeros > 0) throw new TarballBroken("an empty block between entries");
    if (!isWhole(header)) throw new TarballBroken("a header whose checksum is wrong");
    const kind = String.fromCharCode(header[156]!);
    let size = numberAt(header, 124, 12);
    const isUstar = textAt(header, 257, 6) === "ustar";
    let path = textAt(header, 0, 100);
    const prefix = isUstar ? textAt(header, 345, 155) : "";
    if (prefix !== "") path = `${prefix}/${path}`;
    const next = this.#next;
    // What a header before it said counts for an entry that is a file or a folder.
    if (kind !== "x" && kind !== "g" && kind !== "L") {
      if (next.path !== undefined) path = next.path;
      if (next.size !== undefined) size = next.size;
      this.#next = {};
    }
    const isFile = kind === "0" || kind === "\0" || kind === "7";
    const below = isFile ? belowTop(path) : undefined;
    const keep =
      kind === "x" || kind === "L" || (below !== undefined && this.#options.wanted(below));
    if (keep && isFile) {
      this.#kept += size;
      if (this.#kept > this.#options.mostKept)
        throw new TarballTooLarge("the files asked for are larger than they may be");
    }
    if (kind === "x" || kind === "L") {
      // Read whole: a header of its own, small, about the entry after it.
      if (size > 1024 * 1024) throw new TarballTooLarge("a header of an entry is too large");
    }
    this.#entry = {
      path: below,
      kind,
      size,
      padded: Math.ceil(size / BLOCK) * BLOCK,
      parts: keep ? [] : undefined,
      got: 0,
    };
  }

  #finish(): void {
    const entry = this.#entry!;
    this.#entry = undefined;
    if (!entry.parts) return;
    const data = Buffer.concat(entry.parts);
    if (entry.kind === "x") {
      const records = paxOf(data);
      const path = records.get("path");
      const size = records.get("size");
      if (path !== undefined) this.#next.path = path;
      if (size !== undefined) {
        if (!/^\d{1,15}$/.test(size)) throw new TarballBroken("a pax size that is none");
        this.#next.size = Number(size);
      }
      return;
    }
    if (entry.kind === "L") {
      this.#next.path = data.toString("utf8").replace(/\0+$/, "");
      return;
    }
    if (entry.path !== undefined) this.files.set(entry.path, new Uint8Array(data));
  }
}

/**
 * The files of a gzipped tarball that `wanted` asks for, by their path below its folder at the top.
 * Links, folders and everything else of it are passed over. Rejects with TarballBroken where it does
 * not read as one to its end, and TarballTooLarge where it is larger than it may be.
 */
export const readTarball = async (
  body: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>,
  options: TarballOptions,
): Promise<Map<string, Uint8Array>> => {
  const source =
    body instanceof ReadableStream
      ? Readable.fromWeb(body as import("node:stream/web").ReadableStream<Uint8Array>)
      : Readable.from(body);
  const gunzip = createGunzip();
  const reader = new TarReader(options);
  let packed = 0;
  let failed: Error | undefined;
  source.on("data", (chunk: Buffer) => {
    packed += chunk.length;
    if (packed > options.mostBytes) {
      failed ??= new TarballTooLarge("the tarball is larger than it may be");
      source.destroy();
      gunzip.destroy();
    }
  });
  source.on("error", (error) => {
    failed ??= error;
    gunzip.destroy();
  });
  source.pipe(gunzip);
  try {
    for await (const chunk of gunzip) {
      reader.push(chunk as Buffer);
      if (reader.ended) break;
    }
  } catch (error) {
    if (failed) throw failed;
    if (error instanceof TarballBroken || error instanceof TarballTooLarge) throw error;
    throw new TarballBroken(
      `the tarball does not unpack: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    source.destroy();
    gunzip.destroy();
  }
  if (failed) throw failed;
  reader.end();
  return reader.files;
};
