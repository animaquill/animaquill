import { describe, expect, it } from "vitest";
import type { ChangeRecordLike, DirectoryHandleLike } from "./handles.ts";
import { MemoryDisk, type MemoryDiskOptions } from "./memory-disk.ts";

/** The folder as a page has it, from the dialog. */
async function picked(options?: MemoryDiskOptions) {
  const disk = new MemoryDisk(options);
  disk.chooseNext("文件夹");
  const root = await disk.environment().pick();
  return { disk, root };
}

async function names(folder: DirectoryHandleLike) {
  const all: string[] = [];
  for await (const entry of folder.values()) all.push(entry.name);
  return all.toSorted();
}

describe("a disk in memory", () => {
  it("has writers that do not keep others out replace each other, the last one to close", async () => {
    const { disk, root } = await picked();
    const file = await root.getFileHandle("a.txt", { create: true });
    const first = await file.createWritable();
    const second = await file.createWritable();
    expect(disk.names("文件夹").toSorted()).toEqual(["a.txt", "a.txt.1.crswap", "a.txt.crswap"]);
    await new Blob(["第二个"]).stream().pipeTo(second);
    await new Blob(["第一个"]).stream().pipeTo(first);
    expect(disk.text("文件夹/a.txt")).toBe("第一个");
    expect(disk.names("文件夹")).toEqual(["a.txt"]);
    await expect(file.createWritable({ mode: "exclusive" })).resolves.toBeDefined();
  });

  it("lets other programs write a file that a page is writing", async () => {
    const { disk, root } = await picked();
    const file = await root.getFileHandle("a.txt", { create: true });
    const writer = await file.createWritable({ mode: "exclusive" });
    disk.write("文件夹/a.txt", "外面的");
    await new Blob(["页面的"]).stream().pipeTo(writer);
    expect(disk.text("文件夹/a.txt")).toBe("页面的");
  });

  it.each([
    ["linux", ["a.txt", "a.txt.crswap"]],
    ["windows", ["a.txt"]],
  ] as const)("leaves temporary files on %s when the browser goes away", async (system, left) => {
    const { disk, root } = await picked({ system });
    disk.write("文件夹/a.txt", "旧的");
    const writer = await (await root.getFileHandle("a.txt")).createWritable();
    await writer.getWriter().write(new TextEncoder().encode("一半"));
    disk.crash();
    expect(disk.names("文件夹").toSorted()).toEqual(left);
    expect(disk.text("文件夹/a.txt")).toBe("旧的");
  });

  it("does not tell case apart on Windows, and lists the names as they are on the disk", async () => {
    const { disk, root } = await picked({ system: "windows" });
    disk.write("文件夹/UPPER.txt", "大写");
    const file = await root.getFileHandle("upper.TXT", { create: true });
    expect(await (await file.getFile()).text()).toBe("大写");
    expect(await names(root)).toEqual(["UPPER.txt"]);
    const linux = await picked({ system: "linux" });
    linux.disk.write("文件夹/UPPER.txt", "大写");
    await linux.root.getFileHandle("upper.TXT", { create: true });
    expect(await names(linux.root)).toEqual(["UPPER.txt", "upper.TXT"]);
  });

  it("hides what Chrome does not allow there", async () => {
    for (const system of ["windows", "linux"] as const) {
      const { disk, root } = await picked({ system });
      disk.write("文件夹/aux.js", "x");
      disk.write("文件夹/第1~3集.txt", "x");
      disk.write("文件夹/a.txt", "x");
      const expected = system === "windows" ? ["a.txt"] : ["a.txt", "第1~3集.txt"];
      expect(await names(root), system).toEqual(expected);
    }
  });

  it("tells about changes, its own too, unless it misses them", async () => {
    const { disk, root } = await picked();
    const records: ChangeRecordLike[] = [];
    const { Observer } = disk.environment();
    if (!Observer) throw new Error("No observer");
    const observer = new Observer((more) => records.push(...more));
    await observer.observe(root, { recursive: true });
    disk.write("文件夹/a.txt", "外面的");
    await root.getFileHandle("b.txt", { create: true });
    disk.write("文件夹/c.txt", "悄悄的", { quietly: true });
    disk.missesChanges = true;
    disk.write("文件夹/d.txt", "漏掉的");
    await Promise.resolve();
    expect(
      records.map(({ type, relativePathComponents }) => [type, ...relativePathComponents]),
    ).toEqual([
      ["appeared", "a.txt"],
      ["modified", "a.txt"],
      ["appeared", "b.txt"],
    ]);
    observer.disconnect();
  });

  it("asks people only right after they did something", async () => {
    const { disk, root } = await picked();
    disk.forgetPermissions();
    await expect(root.requestPermission?.({ mode: "readwrite" })).rejects.toMatchObject({
      name: "SecurityError",
    });
    disk.activation = true;
    disk.answer = "refuse";
    expect(await root.requestPermission?.({ mode: "readwrite" })).toBe("prompt");
    disk.answer = "allow";
    expect(await root.requestPermission?.({ mode: "readwrite" })).toBe("granted");
    expect(await root.queryPermission?.({ mode: "read" })).toBe("granted");
  });
});
