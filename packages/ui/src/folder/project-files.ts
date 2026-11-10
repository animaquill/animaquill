import {
  MAX_SOURCE_BYTES,
  isDocument,
  isProjectFile,
  isProjectFolder,
  isSourceFile,
} from "@animaquill/core";
import type { WatchOptions } from "@animaquill/host";
import { documentSchema, parseDocument } from "@animaquill/schema";

/**
 * What the editor needs to know about the files of a project folder, besides which files are the
 * project's: that is the format's, in core (`isProjectFile`, `writeRank`), which a platform that saves
 * projects to Git uses as well.
 */

/** What a watch of the project folder, and listing it, look at. */
export const includes: WatchOptions["includes"] = (path, kind) =>
  kind === "folder" ? isProjectFolder(path) : isProjectFile(path);

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/**
 * The text of a file, as it is: a byte order mark that an editor on Windows put in front stays, and
 * the merge knows what to do with it. Undefined for what is no UTF-8.
 */
export function textOf(bytes: Uint8Array): string | undefined {
  try {
    return decoder.decode(bytes);
  } catch {
    return undefined;
  }
}

/**
 * Whether a file holds what a write leaves when the power goes right after it: a document that is
 * no JSON of its kind any more, code that is empty or only zeros, or anything that is no text.
 */
export const looksDamaged = (path: string, text: string | undefined): boolean =>
  text === undefined ||
  isUnreadableDocument(path, text) ||
  (isSourceFile(path) && /^\0*$/.test(text));

/** Whether a document cannot be read at all, as JSON of its kind. Code always can. */
export function isUnreadableDocument(path: string, text: string): boolean {
  const schema = documentSchema(path);
  return (
    schema !== undefined && parseDocument(path, text.replace(/^﻿/, ""), schema).problems.length > 0
  );
}

/** Code this large is something else, such as a video, as when a project is read. */
export const isTooLarge = (path: string, size: number): boolean =>
  !isDocument(path) && size > MAX_SOURCE_BYTES;

/** The version of the format in a text of animaquill.json, undefined when that cannot be told. */
export function formatVersionOf(text: string): number | undefined {
  try {
    const manifest: unknown = JSON.parse(text.replace(/^\uFEFF/, ""));
    const version = (manifest as { readonly formatVersion?: unknown } | null)?.formatVersion;
    return typeof version === "number" ? version : undefined;
  } catch {
    return undefined;
  }
}

/** The id in a text of animaquill.json, undefined when that cannot be told. */
export function projectIdOf(text: string): string | undefined {
  try {
    const manifest: unknown = JSON.parse(text.replace(/^\uFEFF/, ""));
    const id = (manifest as { readonly id?: unknown } | null)?.id;
    return typeof id === "string" ? id : undefined;
  } catch {
    return undefined;
  }
}
