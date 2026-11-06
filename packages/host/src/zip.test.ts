import { describe, expect, it, vi } from "vitest";
import { buildZip, updateCrc, zipParts, zipTarget, type ZipEntry } from "./zip.ts";

const textOf = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

interface Read {
  readonly name: string;
  readonly crc: number;
  readonly size: number;
  readonly offset: number;
  readonly flags: number;
  readonly method: number;
}

/** Reads a file by the book, from its end, the way unzip does. */
async function readZip(file: Blob) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const view = new DataView(bytes.buffer);
  let end = bytes.length - 22;
  while (view.getUint32(end, true) !== 0x06054b50) end -= 1;
  let count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  if (at === 0xffffffff || count === 0xffff) {
    const locator = end - 20;
    expect(view.getUint32(locator, true)).toBe(0x07064b50);
    const record = Number(view.getBigUint64(locator + 8, true));
    expect(view.getUint32(record, true)).toBe(0x06064b50);
    count = Number(view.getBigUint64(record + 32, true));
    at = Number(view.getBigUint64(record + 48, true));
  }
  const entries: Read[] = [];
  for (let index = 0; index < count; index++) {
    expect(view.getUint32(at, true)).toBe(0x02014b50);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const name = textOf(bytes.subarray(at + 46, at + 46 + nameLength));
    entries.push({
      name,
      flags: view.getUint16(at + 8, true),
      method: view.getUint16(at + 10, true),
      crc: view.getUint32(at + 16, true),
      size: view.getUint32(at + 24, true),
      offset: view.getUint32(at + 42, true),
    });
    at += 46 + nameLength + extraLength + commentLength;
  }
  const contentOf = ({ offset, size }: Read) => {
    expect(view.getUint32(offset, true)).toBe(0x04034b50);
    const start =
      offset + 30 + view.getUint16(offset + 26, true) + view.getUint16(offset + 28, true);
    return bytes.subarray(start, start + size);
  };
  return { entries, contentOf };
}

const entry = (path: string, text: string): ZipEntry => {
  const bytes = new TextEncoder().encode(text);
  return { path, content: new Blob([bytes]), crc: updateCrc(0, bytes) };
};

const NOW = new Date(2026, 10, 6, 12, 30, 10);

describe("the checksum of a zip file", () => {
  it("is what everybody else gets", () => {
    expect(updateCrc(0, new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
    expect(updateCrc(0, new Uint8Array())).toBe(0);
  });

  it("goes on from part to part", () => {
    const encoder = new TextEncoder();
    const first = updateCrc(0, encoder.encode("1234"));
    expect(updateCrc(first, encoder.encode("56789"))).toBe(0xcbf43926);
  });
});

describe("a zip file", () => {
  it("holds its files as they are, under their names", async () => {
    const { entries, contentOf } = await readZip(
      buildZip([entry("项目/animaquill.json", "{}"), entry("项目/assets/a.txt", "素材")], NOW),
    );
    expect(entries.map(({ name }) => name)).toEqual(["项目/animaquill.json", "项目/assets/a.txt"]);
    expect(textOf(contentOf(entries[1] as Read))).toBe("素材");
  });

  it("stores instead of compressing, and says that names are UTF-8", async () => {
    const { entries } = await readZip(buildZip([entry("文件.txt", "内容")], NOW));
    expect(entries[0]?.method).toBe(0);
    expect((entries[0]?.flags ?? 0) & 0x0800).toBe(0x0800);
  });

  it("can be empty", async () => {
    expect((await readZip(buildZip([], NOW))).entries).toEqual([]);
  });

  it(
    "uses the longer fields once there are too many files for the short ones",
    { timeout: 30_000 },
    async () => {
      const content = new Blob([]);
      const entries = Array.from({ length: 0xffff }, (_, index) => ({
        path: String(index),
        content,
        crc: 0,
      }));
      const read = await readZip(buildZip(entries, NOW));
      expect(read.entries).toHaveLength(0xffff);
      expect(read.entries.at(-1)?.name).toBe("65534");
    },
  );

  it("does not hold on to more than the parts it was given", () => {
    const part = new Blob([new Uint8Array(1024 ** 2)]);
    const parts = Array.from({ length: 6000 }, (_, index) => ({
      path: String(index),
      content: part,
      crc: 0,
    }));
    // Past 4 GiB, which only works with the longer fields, and with nothing being copied.
    expect(buildZip(parts, NOW).size).toBeGreaterThan(6000 * 1024 ** 2);
  });
});

interface LargeEntry {
  readonly name: string;
  readonly crc: number;
  /** As the fields say, before looking at the longer ones. */
  readonly sizeField: number;
  readonly offsetField: number;
  /** The longer fields, in the order they come. */
  readonly longer: readonly number[];
  readonly localSizeField: number;
  readonly localLonger: readonly number[];
  /** Where the content starts, once the longer fields are taken into account. */
  readonly content: number;
}

const u64At = (view: DataView, at: number) => Number(view.getBigUint64(at, true));

const longerFields = (view: DataView, start: number, length: number): number[] => {
  if (length === 0) return [];
  expect(view.getUint16(start, true)).toBe(1);
  const size = view.getUint16(start + 2, true);
  expect(size + 4).toBe(length);
  return Array.from({ length: size / 8 }, (_, index) => u64At(view, start + 4 + index * 8));
};

/** Looks at a place in a file too large for memory, and for what Node can do with a Blob. */
function reader(parts: ReturnType<typeof zipParts>) {
  let size = 0;
  const spans = parts.map((part) => {
    const span = { part, start: size };
    size += part instanceof Blob ? part.size : part.length;
    return span;
  });
  const at = async (start: number, length: number) => {
    const bytes = new Uint8Array(length);
    for (const { part, start: partStart } of spans) {
      const partEnd = partStart + (part instanceof Blob ? part.size : part.length);
      const from = Math.max(start, partStart);
      const to = Math.min(start + length, partEnd);
      if (from >= to) continue;
      const range = [from - partStart, to - partStart] as const;
      const piece =
        part instanceof Blob
          ? new Uint8Array(await part.slice(...range).arrayBuffer())
          : part.subarray(...range);
      bytes.set(piece, from - start);
    }
    return new DataView(bytes.buffer);
  };
  return { size, at };
}

/** Reads only the parts it needs, as nothing of this size fits in memory. */
async function readLargeZip(parts: ReturnType<typeof zipParts>) {
  const { size, at } = reader(parts);
  const end = await at(size - 22, 22);
  expect(end.getUint32(0, true)).toBe(0x06054b50);
  const locator = await at(size - 42, 20);
  expect(locator.getUint32(0, true)).toBe(0x07064b50);
  expect(locator.getUint32(4, true)).toBe(0);
  expect(locator.getUint32(16, true)).toBe(1);
  const recordAt = u64At(locator, 8);
  const record = await at(recordAt, 56);
  expect(record.getUint32(0, true)).toBe(0x06064b50);
  expect(u64At(record, 4)).toBe(44);
  expect(record.getUint16(12, true)).toBe(45);
  const count = u64At(record, 32);
  expect(u64At(record, 24)).toBe(count);
  const directorySize = u64At(record, 40);
  const directoryAt = u64At(record, 48);
  expect(directoryAt + directorySize).toBe(recordAt);
  expect(size).toBe(recordAt + 56 + 20 + 22);

  const directory = await at(directoryAt, directorySize);
  const entries: LargeEntry[] = [];
  let position = 0;
  for (let index = 0; index < count; index++) {
    expect(directory.getUint32(position, true)).toBe(0x02014b50);
    expect(directory.getUint16(position + 6, true)).toBe(45);
    const nameLength = directory.getUint16(position + 28, true);
    const extraLength = directory.getUint16(position + 30, true);
    const name = textOf(
      new Uint8Array(directory.buffer, directory.byteOffset + position + 46, nameLength),
    );
    const longer = longerFields(directory, position + 46 + nameLength, extraLength);
    const sizeField = directory.getUint32(position + 24, true);
    expect(directory.getUint32(position + 20, true)).toBe(sizeField);
    const offsetField = directory.getUint32(position + 42, true);
    const offset = offsetField === 0xffffffff ? (longer.at(-1) as number) : offsetField;

    const head = await at(offset, 30);
    expect(head.getUint32(0, true)).toBe(0x04034b50);
    const localName = head.getUint16(26, true);
    const localExtra = head.getUint16(28, true);
    const extra = await at(offset + 30 + localName, localExtra);
    const localSizeField = head.getUint32(22, true);
    expect(head.getUint32(18, true)).toBe(localSizeField);
    expect(localName).toBe(nameLength);
    entries.push({
      name,
      crc: directory.getUint32(position + 16, true),
      sizeField,
      offsetField,
      longer,
      localSizeField,
      localLonger: longerFields(extra, 0, localExtra),
      content: offset + 30 + localName + localExtra,
    });
    position += 46 + nameLength + extraLength;
  }
  /** The content of an entry that is small enough to look at. */
  const textIn = async ({ content, sizeField }: LargeEntry) =>
    textOf(new Uint8Array((await at(content, sizeField)).buffer));
  return { entries, end, directoryAt, directorySize, count, textIn };
}

describe("a zip file past what the short fields can say", () => {
  const MIB = 1024 ** 2;
  const LIMIT = 0xffffffff;
  const part = new Blob([new Uint8Array(MIB)]);
  const big = (mib: number, rest = 0) =>
    new Blob([...Array.from({ length: mib }, () => part), new Uint8Array(rest)]);
  const named = (path: string, content: Blob) => ({ path, content, crc: 123 });

  it("says where files are that start after 4 GiB", { timeout: 30_000 }, async () => {
    const parts = zipParts(
      [
        entry("项目/第一个.txt", "第一个文件"),
        named("项目/大文件0", big(3900)),
        named("项目/大文件1", big(500)),
        entry("项目/素材/后面.txt", "在 4 GiB 之后"),
      ],
      NOW,
    );
    const zip = await readLargeZip(parts);
    const { entries, end, directoryAt, directorySize, count, textIn } = zip;
    const [first, second, third, last] = entries as [
      LargeEntry,
      LargeEntry,
      LargeEntry,
      LargeEntry,
    ];

    expect(count).toBe(4);
    expect(entries.map(({ name }) => name)).toEqual([
      "项目/第一个.txt",
      "项目/大文件0",
      "项目/大文件1",
      "项目/素材/后面.txt",
    ]);
    // A short field stays short as long as it can say what it has to.
    expect(first.longer).toEqual([]);
    expect(second.longer).toEqual([]);
    expect(third).toMatchObject({ sizeField: 500 * MIB, longer: [], localLonger: [] });
    expect(third.offsetField).toBeLessThan(LIMIT);

    expect(last.offsetField).toBe(LIMIT);
    expect(last.longer).toHaveLength(1);
    expect(last.longer[0]).toBeGreaterThan(LIMIT);
    expect(last.localLonger).toEqual([]);
    expect(last.sizeField).toBe(new TextEncoder().encode("在 4 GiB 之后").length);
    expect(await textIn(last)).toBe("在 4 GiB 之后");

    expect(end.getUint16(8, true)).toBe(4);
    expect(end.getUint16(10, true)).toBe(4);
    expect(end.getUint32(12, true)).toBe(directorySize);
    expect(end.getUint32(16, true)).toBe(LIMIT);
    expect(directoryAt).toBeGreaterThan(LIMIT);
  });

  it("says how large a file is that is larger than 4 GiB", { timeout: 30_000 }, async () => {
    const size = 4200 * MIB;
    const parts = zipParts([named("大文件", big(4200)), entry("后面.txt", "在大文件之后")], NOW);
    const { entries, textIn } = await readLargeZip(parts);
    const [huge, after] = entries as [LargeEntry, LargeEntry];

    expect(huge.crc).toBe(123);
    expect(huge.sizeField).toBe(LIMIT);
    expect(huge.localSizeField).toBe(LIMIT);
    expect(huge.longer).toEqual([size, size]);
    expect(huge.localLonger).toEqual([size, size]);
    expect(huge.offsetField).toBe(0);

    expect(after.sizeField).toBe(new TextEncoder().encode("在大文件之后").length);
    expect(after.longer).toHaveLength(1);
    expect(after.longer[0]).toBeGreaterThan(size);
    expect(await textIn(after)).toBe("在大文件之后");
  });

  it(
    "uses the longer field for a file of exactly the largest size",
    { timeout: 30_000 },
    async () => {
      const mib = Math.floor(LIMIT / MIB);
      const content = big(mib, LIMIT - mib * MIB);
      const parts = zipParts([named("边界", content), entry("后面.txt", "下一个")], NOW);
      const [edge] = (await readLargeZip(parts)).entries as [LargeEntry];
      expect(edge.sizeField).toBe(LIMIT);
      expect(edge.longer).toEqual([LIMIT, LIMIT]);
      expect(edge.localLonger).toEqual([LIMIT, LIMIT]);
    },
  );

  /** A file that makes what comes after it start at exactly the largest offset. */
  const upToTheLimit = () => {
    const header = 30 + new TextEncoder().encode("边界").length;
    const size = LIMIT - header;
    const mib = Math.floor(size / MIB);
    return named("边界", big(mib, size - mib * MIB));
  };

  it(
    "uses the longer field for a file at exactly the largest offset",
    { timeout: 30_000 },
    async () => {
      const parts = zipParts([upToTheLimit(), entry("后面.txt", "下一个")], NOW);
      const [edge, after] = (await readLargeZip(parts)).entries as [LargeEntry, LargeEntry];
      expect(edge.longer).toEqual([]);
      expect(after.offsetField).toBe(LIMIT);
      expect(after.longer).toEqual([LIMIT]);
    },
  );

  it(
    "uses the longer records when the list starts at the largest offset",
    { timeout: 30_000 },
    async () => {
      const { directoryAt, end } = await readLargeZip(zipParts([upToTheLimit()], NOW));
      expect(directoryAt).toBe(LIMIT);
      expect(end.getUint32(16, true)).toBe(LIMIT);
    },
  );

  it("uses the short field for a file of one byte less", { timeout: 30_000 }, async () => {
    const size = LIMIT - 1;
    const mib = Math.floor(size / MIB);
    const content = big(mib, size - mib * MIB);
    const parts = zipParts([named("边界", content), entry("后面.txt", "下一个")], NOW);
    const [edge, after] = (await readLargeZip(parts)).entries as [LargeEntry, LargeEntry];
    expect(edge.sizeField).toBe(size);
    expect(edge.longer).toEqual([]);
    expect(edge.localLonger).toEqual([]);
    expect(after.offsetField).toBe(LIMIT);
    expect(after.longer).toHaveLength(1);
  });
});

describe("zip files for browsers without folders", () => {
  const content = (text: string) => new Blob([text]);

  function start() {
    const save = vi.fn<(file: Blob, name: string) => void>();
    return { save, target: zipTarget("我的项目", save) };
  }

  it("puts one folder inside and saves when it is finished", async () => {
    const { save, target } = start();
    await target.write("animaquill.json", content("{}"));
    await target.write("assets/a.mp4", content("视频"));
    expect(save).not.toHaveBeenCalled();
    await target.finish();

    const [file, name] = save.mock.calls[0] as [Blob, string];
    expect(name).toBe("我的项目.zip");
    expect(target.name).toBe("我的项目.zip");
    expect(target.kind).toBe("archive");
    const { entries, contentOf } = await readZip(file);
    expect(entries.map((item) => item.name)).toEqual([
      "我的项目/animaquill.json",
      "我的项目/assets/a.mp4",
    ]);
    expect(textOf(contentOf(entries[1] as Read))).toBe("视频");
    expect(entries[1]?.crc).toBe(updateCrc(0, new TextEncoder().encode("视频")));
  });

  it("leaves out what was removed again", async () => {
    const { save, target } = start();
    await target.write("导出未完成.txt", content("没有完成"));
    await target.write("animaquill.json", content("{}"));
    await target.remove("导出未完成.txt");
    await target.finish();
    const { entries } = await readZip(save.mock.calls[0]?.[0] as Blob);
    expect(entries.map((item) => item.name)).toEqual(["我的项目/animaquill.json"]);
  });

  it("saves nothing when it does not get to the end", async () => {
    const { save, target } = start();
    await target.write("animaquill.json", content("{}"));
    await target.abandon();
    expect(save).not.toHaveBeenCalled();
  });

  it("works out checksums piece by piece, however large a file is", async () => {
    class OnlyInPieces extends Blob {
      override async arrayBuffer(): Promise<ArrayBuffer> {
        throw new Error("Read as a whole");
      }
    }
    const { save, target } = start();
    await target.write("a.bin", new OnlyInPieces(["内容"]));
    await target.finish();
    const { entries } = await readZip(save.mock.calls[0]?.[0] as Blob);
    expect(entries[0]?.crc).toBe(updateCrc(0, new TextEncoder().encode("内容")));
  });

  it("reports how far it got", async () => {
    const { target } = start();
    const onProgress = vi.fn<(bytes: number) => void>();
    await target.write("a.bin", new Blob([new Uint8Array(1000)]), { onProgress });
    expect(onProgress).toHaveBeenLastCalledWith(1000);
  });

  it("stops when asked to", async () => {
    const { target } = start();
    const controller = new AbortController();
    controller.abort(new Error("stop"));
    await expect(target.write("a.bin", content("x"), controller)).rejects.toThrow("stop");
  });

  it.each(["../outside.txt", "/etc/passwd", "a/../../b", "a\\b", "C:/x", "a//b", "a/./b", ""])(
    "does not put %s in a file that gets unpacked somewhere",
    async (path) => {
      const { save, target } = start();
      expect(await target.write(path, content("x"))).toBe(false);
      expect(await target.write("animaquill.json", content("{}"))).toBe(true);
      await target.finish();
      const { entries } = await readZip(save.mock.calls[0]?.[0] as Blob);
      expect(entries.map((item) => item.name)).toEqual(["我的项目/animaquill.json"]);
    },
  );

  it("has no trouble with names that browsers do not allow in a folder", async () => {
    const { save, target } = start();
    expect(await target.write("code/aux.js", content("代码"))).toBe(true);
    await target.finish();
    const { entries } = await readZip(save.mock.calls[0]?.[0] as Blob);
    expect(entries.map((item) => item.name)).toEqual(["我的项目/code/aux.js"]);
  });
});
