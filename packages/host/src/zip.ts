import type { TargetFolder, WriteOptions } from "./index.ts";
import { partsOf } from "./paths.ts";

const crcTable = Int32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value;
});

/** Goes on from the value of the bytes before. Start with 0. */
export function updateCrc(crc: number, bytes: Uint8Array): number {
  let value = ~crc;
  for (const byte of bytes) {
    value = (crcTable[(value ^ byte) & 0xff] as number) ^ (value >>> 8);
  }
  return ~value >>> 0;
}

async function crcOf(content: Blob, { signal, onProgress }: WriteOptions): Promise<number> {
  const reader = content.stream().getReader();
  let crc = 0;
  let bytes = 0;
  try {
    for (;;) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) return crc;
      crc = updateCrc(crc, value);
      bytes += value.byteLength;
      onProgress?.(bytes);
    }
  } finally {
    // Whatever stopped this, the file does not have to stay open.
    await reader.cancel().catch(() => {});
  }
}

/** Fields that do not fit say so with this value, and the real one follows in a longer field. */
const OVERFLOW = 0xffffffff;
const MANY_ENTRIES = 0xffff;
/** What readers need for the longer fields of zip64. */
const VERSION = 45;
const NAMES_ARE_UTF8 = 0x0800;
const STORED = 0;

interface Field {
  readonly bytes: 2 | 4 | 8;
  readonly value: number;
}

const u16 = (value: number): Field => ({ bytes: 2, value });
const u32 = (value: number): Field => ({ bytes: 4, value });
const u64 = (value: number): Field => ({ bytes: 8, value });

function record(...parts: readonly (Field | Uint8Array)[]): Uint8Array<ArrayBuffer> {
  const size = parts.reduce(
    (sum, part) => sum + (part instanceof Uint8Array ? part.length : part.bytes),
    0,
  );
  const result = new Uint8Array(size);
  const view = new DataView(result.buffer);
  let at = 0;
  for (const part of parts) {
    if (part instanceof Uint8Array) {
      result.set(part, at);
      at += part.length;
    } else {
      if (part.bytes === 2) view.setUint16(at, part.value, true);
      else if (part.bytes === 4) view.setUint32(at, part.value, true);
      else view.setBigUint64(at, BigInt(part.value), true);
      at += part.bytes;
    }
  }
  return result;
}

/** The time as zip files have it, which is in the local time of whoever writes them. */
function dosTime(date: Date): { readonly time: number; readonly date: number } {
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

export interface ZipEntry {
  readonly path: string;
  readonly content: Blob;
  readonly crc: number;
}

/**
 * A zip file without compression, because videos and pictures are compressed already. It is made of
 * references to the files, so nothing gets copied and any size fits in memory.
 */
export function buildZip(entries: readonly ZipEntry[], modified: Date): Blob {
  const parts: (Uint8Array<ArrayBuffer> | Blob)[] = [];
  const central: Uint8Array<ArrayBuffer>[] = [];
  const { time, date } = dosTime(modified);
  const encoder = new TextEncoder();
  let offset = 0;

  for (const { path, content, crc } of entries) {
    const name = encoder.encode(path);
    const { size } = content;
    const large = size >= OVERFLOW;
    const shared = [
      u16(VERSION),
      u16(NAMES_ARE_UTF8),
      u16(STORED),
      u16(time),
      u16(date),
      u32(crc),
      u32(large ? OVERFLOW : size),
      u32(large ? OVERFLOW : size),
      u16(name.length),
    ];

    const extra = large ? record(u16(1), u16(16), u64(size), u64(size)) : new Uint8Array(0);
    const header = record(u32(0x04034b50), ...shared, u16(extra.length), name, extra);
    parts.push(header, content);

    const far = offset >= OVERFLOW;
    const longer = [...(large ? [u64(size), u64(size)] : []), ...(far ? [u64(offset)] : [])];
    const centralExtra =
      longer.length > 0 ? record(u16(1), u16(longer.length * 8), ...longer) : new Uint8Array(0);
    central.push(
      record(
        u32(0x02014b50),
        u16(VERSION),
        ...shared,
        u16(centralExtra.length),
        u16(0),
        u16(0),
        u16(0),
        u32(0),
        u32(far ? OVERFLOW : offset),
        name,
        centralExtra,
      ),
    );
    offset += header.length + size;
  }

  const directorySize = central.reduce((sum, item) => sum + item.length, 0);
  const count = entries.length;
  parts.push(...central);
  if (count >= MANY_ENTRIES || directorySize >= OVERFLOW || offset >= OVERFLOW) {
    const end = offset + directorySize;
    parts.push(
      record(
        u32(0x06064b50),
        u64(44),
        u16(VERSION),
        u16(VERSION),
        u32(0),
        u32(0),
        u64(count),
        u64(count),
        u64(directorySize),
        u64(offset),
      ),
      record(u32(0x07064b50), u32(0), u64(end), u32(1)),
    );
  }
  parts.push(
    record(
      u32(0x06054b50),
      u16(0),
      u16(0),
      u16(Math.min(count, MANY_ENTRIES)),
      u16(Math.min(count, MANY_ENTRIES)),
      u32(Math.min(directorySize, OVERFLOW)),
      u32(Math.min(offset, OVERFLOW)),
      u16(0),
    ),
  );
  return new Blob(parts, { type: "application/zip" });
}

/**
 * For browsers that cannot write to a folder. Nothing is saved before all of it is there, so an
 * export that stops leaves nothing at all. Inside is one folder, as if it had been zipped by hand.
 */
export function zipTarget(name: string, save: (file: Blob, name: string) => void): TargetFolder {
  const entries = new Map<string, ZipEntry>();
  const fileName = `${name}.zip`;
  return {
    name: fileName,
    kind: "archive",
    async write(path, content, options = {}) {
      partsOf(path);
      const crc = await crcOf(content, options);
      entries.set(path, { path: `${name}/${path}`, content, crc });
    },
    async remove(path) {
      entries.delete(path);
    },
    async finish() {
      save(buildZip([...entries.values()], new Date()), fileName);
    },
    async abandon() {
      entries.clear();
    },
  };
}
