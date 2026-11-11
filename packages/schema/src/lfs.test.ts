import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  LFS_POINTER_VERSION,
  isLfsPointerOf,
  lfsOidOf,
  lfsPointer,
  readLfsPointer,
} from "./lfs.ts";

/** The pointer files of Git LFS, as the spec has them and as a clone without Git LFS has them. */

const CONTENT = Buffer.from("a video\n");
const OID = createHash("sha256").update(CONTENT).digest("hex");
const HASH = `sha256-${createHash("sha256").update(CONTENT).digest("base64url")}=`;
const SIZE = CONTENT.length;
/** What `git lfs pointer --file` writes for the same content. */
const POINTER = `version https://git-lfs.github.com/spec/v1\noid sha256:${OID}\nsize ${SIZE}\n`;

describe("the pointer files of Git LFS", () => {
  it("names the content of a hash as Git LFS does, however the hash is written", () => {
    expect(lfsOidOf(HASH)).toBe(OID);
    expect(lfsOidOf(`sha256-${OID.toUpperCase()}`)).toBe(OID);
    expect(lfsOidOf(HASH.replace(/=$/, ""))).toBe(OID);
    expect(lfsOidOf("sha256-short")).toBeUndefined();
    expect(lfsOidOf(OID)).toBeUndefined();
  });

  it("writes what Git LFS writes, and reads it back", () => {
    expect(lfsPointer(HASH, SIZE)).toBe(POINTER);
    expect(readLfsPointer(POINTER)).toEqual({ oid: OID, size: SIZE });
    expect(lfsPointer("sha256-short", SIZE)).toBeUndefined();
    expect(lfsPointer(HASH, -1)).toBeUndefined();
    expect(lfsPointer(HASH, 1.5)).toBeUndefined();
  });

  it("reads one as it can come: with the earlier name of the version, other keys, Windows line ends, without the last one", () => {
    const earlier = POINTER.replace(LFS_POINTER_VERSION, "https://hawser.github.com/spec/v1");
    const extension = POINTER.replace("oid", `ext-0-foo sha256:${"1".repeat(64)}\noid`);
    for (const text of [earlier, extension, POINTER.replaceAll("\n", "\r\n"), POINTER.trimEnd()])
      expect(readLfsPointer(text), text).toEqual({ oid: OID, size: SIZE });
  });

  it.each([
    ["nothing", ""],
    ["no version", `oid sha256:${OID}\nsize ${SIZE}\n`],
    ["the version not first", `oid sha256:${OID}\nversion ${LFS_POINTER_VERSION}\nsize ${SIZE}\n`],
    ["another version", POINTER.replace("v1", "v2")],
    ["no oid", `version ${LFS_POINTER_VERSION}\nsize ${SIZE}\n`],
    ["no size", `version ${LFS_POINTER_VERSION}\noid sha256:${OID}\n`],
    ["an oid in upper case", POINTER.replace(OID, OID.toUpperCase())],
    ["an oid of another kind", POINTER.replace("sha256:", "sha1:")],
    ["a short oid", POINTER.replace(OID, OID.slice(1))],
    ["a size that is no number", POINTER.replace(`size ${SIZE}`, "size -1")],
    ["a size with a zero in front", POINTER.replace(`size ${SIZE}`, `size 0${SIZE}`)],
    ["a size too large to count", POINTER.replace(`size ${SIZE}`, "size 99999999999999999")],
    ["a key twice", `${POINTER}size ${SIZE}\n`],
    ["two spaces", POINTER.replace("size ", "size  ")],
    ["an empty line", POINTER.replace("\nsize", "\n\nsize")],
    ["a file that only starts like one", `${POINTER}\u0000\u0001binary`],
    ["a text as large as no pointer is", `${POINTER}${"x".repeat(1024)}`],
  ])("takes %s for no pointer", (_, text) => {
    expect(readLfsPointer(text)).toBeUndefined();
  });

  it("knows the pointer of an asset: the same content, and the same size where the asset knows it", () => {
    expect(isLfsPointerOf(POINTER, { hash: HASH, size: SIZE })).toBe(true);
    expect(isLfsPointerOf(POINTER, { hash: HASH })).toBe(true);
    expect(isLfsPointerOf(POINTER, { hash: `sha256-${OID}`, size: SIZE })).toBe(true);
    expect(isLfsPointerOf(POINTER, { hash: HASH, size: SIZE + 1 })).toBe(false);
    const other = `sha256-${createHash("sha256").update("another").digest("base64url")}=`;
    expect(isLfsPointerOf(POINTER, { hash: other, size: SIZE })).toBe(false);
    expect(isLfsPointerOf("a video\n", { hash: HASH, size: SIZE })).toBe(false);
  });
});
