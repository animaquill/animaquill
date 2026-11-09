import { MAX_SOURCE_BYTES, isNoneOfIt, isSourceFile, isToolFolder } from "@animaquill/core";
import type { WatchOptions } from "@animaquill/host";
import { MANIFEST_FILE, documentSchema, parseDocument } from "@animaquill/schema";

/**
 * Which files of a folder are the project's, as the format has them: its documents, and the code of
 * its scenes and sounds. The editor reads, writes and takes away only these, and leaves everything
 * else as it is: notes, a README, .git, what belongs to tools. Media files of assets come with the
 * next step, see the plan of phase 5.
 */
export const isDocument = (path: string): boolean => documentSchema(path) !== undefined;

export const isProjectFile = (path: string): boolean =>
  !isNoneOfIt(path) && (isDocument(path) || isSourceFile(path));

/** Folders that can have files of the project in them. */
const PROJECT_FOLDER = /^(?:timelines|scenes|sounds|code|locales)(?:\/|$)/;

const isProjectFolder = (path: string): boolean =>
  PROJECT_FOLDER.test(path) && !path.split("/").some(isToolFolder);

/** What a watch of the project folder, and listing it, look at. */
export const includes: WatchOptions["includes"] = (path, kind) =>
  kind === "folder" ? isProjectFolder(path) : isProjectFile(path);

/**
 * In which turn a file gets written: what others refer to first, so that a program that reads the
 * folder in the middle sees at most a reference that is not there yet. Code, assets, libraries and
 * strings, then what scenes and sounds are, then timelines, then their versions and the notes on
 * them, and animaquill.json last. Taking files away goes the other way round.
 */
export function writeRank(path: string): number {
  if (path === MANIFEST_FILE) return 4;
  if (path === "notes.json" || /^timelines\/[^/]+\/overrides\//.test(path)) return 3;
  if (/^timelines\/[^/]+\/timeline\.json$/.test(path)) return 2;
  if (/^(?:scenes|sounds)\/[^/]+\/(?:scene|sound)\.json$/.test(path)) return 1;
  return 0;
}

/** Files in turns, see `writeRank`: each turn is a list of paths that can go at the same time. */
export function inRanks(paths: Iterable<string>, reverse = false): string[][] {
  const ranks = new Map<number, string[]>();
  for (const path of paths) {
    const rank = writeRank(path);
    ranks.set(rank, [...(ranks.get(rank) ?? []), path]);
  }
  const order = [...ranks.keys()].toSorted((a, b) => (reverse ? b - a : a - b));
  return order.map((rank) => (ranks.get(rank) ?? []).toSorted());
}

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
