import { describe, expect, it, vi } from "vitest";
import { buildZip, updateCrc, zipTarget, type ZipEntry } from "./zip.ts";

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
      await expect(start().target.write(path, content("x"))).rejects.toThrow(TypeError);
    },
  );
});
