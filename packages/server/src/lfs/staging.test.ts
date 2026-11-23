import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { Staging } from "./staging.ts";

/**
 * The staging folder of uploads into Git LFS: one file for each upload, written piece by piece where
 * the upload got, read back for its hash, and nothing else in the folder is ever touched.
 */

describe("the staging folder", () => {
  let dir: string;
  let staging: Staging;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "aq-staging-"));
    staging = new Staging(dir);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("keeps a file for each upload, written piece by piece, and reads it back for its hash", async () => {
    const id = randomUUID();
    expect(await staging.usable()).toBe(true);
    await staging.create(id);
    await expect(staging.create(id)).rejects.toMatchObject({ code: "EEXIST" });
    const content = Buffer.from("一段要放进大文件存储的内容");
    await staging.write(id, 0, content.subarray(0, 7));
    await staging.write(id, 7, content.subarray(7));
    // A piece written again where it was is the same file.
    await staging.write(id, 0, content.subarray(0, 7));
    expect(readFileSync(staging.pathOf(id))).toEqual(content);
    const oid = createHash("sha256").update(content).digest("hex");
    expect(await staging.hash(id, content.length)).toBe(oid);
    // Shorter than it should be, or not there: no hash.
    expect(await staging.hash(id, content.length + 1)).toBeUndefined();
    const read: Buffer[] = [];
    for await (const piece of await staging.reader(id, content.length)) read.push(piece as Buffer);
    expect(Buffer.concat(read)).toEqual(content);
    await expect(staging.reader(id, content.length + 1)).rejects.toMatchObject({ code: "ESHORT" });
    await staging.remove(id);
    await staging.remove(id);
    expect(await staging.hash(id, content.length)).toBeUndefined();
    await expect(staging.write(id, 0, content)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(staging.reader(id, 1)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("the hash is of what is on the disk, whatever came", async () => {
    const id = randomUUID();
    await staging.create(id);
    await staging.write(id, 0, Buffer.from("what came"));
    writeFileSync(staging.pathOf(id), "what is there");
    expect(await staging.hash(id, 9)).toBe(createHash("sha256").update("what is t").digest("hex"));
  });

  test("lists the files of uploads, and only counts everything else, which it never touches", async () => {
    const ids = [randomUUID(), randomUUID()];
    for (const id of ids) await staging.create(id);
    writeFileSync(join(dir, "notes.txt"), "of someone else");
    writeFileSync(join(dir, `${randomUUID()}.part.bak`), "x");
    mkdirSync(join(dir, `${randomUUID()}.part`));
    symlinkSync(join(dir, "notes.txt"), join(dir, `${randomUUID()}.part`));
    const listed = await staging.list();
    expect(listed.ids.toSorted()).toEqual(ids.toSorted());
    expect(listed.others).toBe(4);
    expect(await staging.freeBytes()).toBeGreaterThan(0);
  });

  test("makes no path of what is not the id of an upload", () => {
    for (const id of ["../x", "a/b", "", "0190a6b2-7c3d-7e4f-8a9b-0c1d2e3f4a5b/../../etc"])
      expect(() => staging.pathOf(id), id).toThrow();
  });

  test("is not usable where the folder is not there, or is a file", async () => {
    expect(await new Staging(join(dir, "missing")).usable()).toBe(false);
    writeFileSync(join(dir, "file"), "");
    expect(await new Staging(join(dir, "file")).usable()).toBe(false);
  });
});
