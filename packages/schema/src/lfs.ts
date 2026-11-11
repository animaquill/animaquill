import { hexDigestOf } from "./documents.ts";

/**
 * The pointer files of Git LFS, spec v1 (https://github.com/git-lfs/git-lfs/blob/main/docs/spec.md):
 * what a repository has at the path of an asset kept in its large file storage, `storage: "lfs"`,
 * made of the `hash` and `size` of the asset. A folder cloned without Git LFS has the pointer there
 * in place of the file: the file is not on this computer, and can be downloaded, see `isLfsPointerOf`.
 */

/** The version a pointer file says first. */
export const LFS_POINTER_VERSION = "https://git-lfs.github.com/spec/v1";
/** What the same version was called before Git LFS had its name, which readers still take. */
const EARLIER_VERSION = "https://hawser.github.com/spec/v1";
/** A pointer file is smaller than this: a file of this size or more is never one. */
export const LFS_POINTER_MAX_BYTES = 1024;

/** An object of Git LFS: the SHA-256 of its content in lower-case hexadecimal, and its size. */
export interface LfsObjectId {
  readonly oid: string;
  readonly size: number;
}

/** What Git LFS knows the content of a hash of the format by, or undefined for no hash. */
export const lfsOidOf = (hash: string): string | undefined => hexDigestOf(hash);

/** The pointer file of the content of this hash and size, or undefined for what is none. */
export function lfsPointer(hash: string, size: number): string | undefined {
  const oid = lfsOidOf(hash);
  if (oid === undefined || !Number.isSafeInteger(size) || size < 0) return undefined;
  return `version ${LFS_POINTER_VERSION}\noid sha256:${oid}\nsize ${size}\n`;
}

const LINE = /^([a-z0-9.-]+) ([^\r\n]*)$/;

/**
 * What a pointer file says, or undefined for a text that is not one. As the spec has it: `version`
 * first, then one key and value a line, each key once, with `oid` and `size` among them. What is
 * read is taken as it comes, also with a line end of Windows or without the last one.
 */
export function readLfsPointer(text: string): LfsObjectId | undefined {
  if (text.length === 0 || text.length >= LFS_POINTER_MAX_BYTES) return undefined;
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const values = new Map<string, string>();
  for (const [index, line] of lines.entries()) {
    const match = LINE.exec(line.endsWith("\r") ? line.slice(0, -1) : line);
    if (!match) return undefined;
    const [, key, value] = match as unknown as [string, string, string];
    if (values.has(key) || (index === 0) !== (key === "version")) return undefined;
    values.set(key, value);
  }
  const version = values.get("version");
  if (version !== LFS_POINTER_VERSION && version !== EARLIER_VERSION) return undefined;
  const oid = /^sha256:([0-9a-f]{64})$/.exec(values.get("oid") ?? "")?.[1];
  const size = values.get("size") ?? "";
  if (oid === undefined || !/^(?:0|[1-9][0-9]{0,15})$/.test(size)) return undefined;
  const bytes = Number(size);
  return Number.isSafeInteger(bytes) ? { oid, size: bytes } : undefined;
}

/**
 * Whether a text is the pointer file of the content of this hash, of this size where that is known:
 * what a folder cloned without Git LFS has at the path of the asset, in place of its file.
 */
export function isLfsPointerOf(
  text: string,
  file: { readonly hash: string; readonly size?: number | undefined },
): boolean {
  const pointer = readLfsPointer(text);
  const oid = lfsOidOf(file.hash);
  if (!pointer || oid === undefined || pointer.oid !== oid) return false;
  return file.size === undefined || pointer.size === file.size;
}
