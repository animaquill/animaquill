import { placedAssets, usesOf, type Here, type ProjectState } from "@animaquill/core";
import { isSameHash } from "@animaquill/media";
import { LFS_FILE_MOST, type UploadItem } from "./uploads.ts";

/**
 * The dialog "素材放在哪" as rows (docs/design/asset-storage.md of AnimaQuill Cloud, 4.3, screen U2):
 * every asset with a file, how large, where it is used, where it is now, and whether it can be
 * chosen; the quick choices, the order, and what the choice comes to. No DOM.
 */

/** Where the file of an asset is now, as far as the dialog goes. */
export type PlaceWhere =
  /** Only on this computer: it can go. */
  | "here"
  /** In the large file storage already, for this very content. */
  | "there"
  /** On its way there. */
  | "on"
  /** Larger than the storage takes. */
  | "tooLarge"
  /** Not on this computer: only where it is can it be sent from. */
  | "noFile";

export interface PlaceRow {
  readonly asset: string;
  readonly name: string;
  readonly kind: string;
  readonly size: number;
  /** Clips and other places it is used in. */
  readonly uses: number;
  readonly where: PlaceWhere;
}

export type QuickChoice = "all" | "used" | "large" | "videos";
export type PlaceOrder = "size" | "name";

/** "大于 100 MB 的". */
export const LARGE_BYTES = 100 * 1024 * 1024;
/** Rows of files smaller than this are folded away where there are many rows. */
export const SMALL_BYTES = 5 * 1024 * 1024;
/** From so many rows on, the small ones are folded away. */
export const FOLD_FROM = 10;

export const canChoose = (row: PlaceRow): boolean => row.where === "here";

/**
 * The rows of the assets of a project that have a file: `missing` those whose file is not on this
 * computer, `uploads` how the files on their way go.
 */
export function placeRows(
  state: ProjectState,
  uploads: readonly UploadItem[],
  missing: ReadonlySet<string>,
  here?: Here,
): PlaceRow[] {
  const rows: PlaceRow[] = [];
  const going = new Map(uploads.map((item) => [item.asset, item]));
  const placed = placedAssets(state, here) ?? {};
  for (const [asset, found] of Object.entries(placed)) {
    if (found.hash === undefined || found.size === undefined) continue;
    if (!["video", "audio", "image", "font"].includes(found.kind)) continue;
    const item = going.get(asset);
    const there = found.storage === "lfs";
    const where: PlaceWhere = there
      ? "there"
      : item &&
          isSameHash(item.hash, found.hash) &&
          item.phase !== "done" &&
          item.phase !== "failed"
        ? "on"
        : found.size > LFS_FILE_MOST
          ? "tooLarge"
          : missing.has(asset)
            ? "noFile"
            : "here";
    rows.push({
      asset,
      name: found.name ?? found.path,
      kind: found.kind,
      size: found.size,
      uses: usesOf(state, { kind: "asset", id: asset }).length,
      where,
    });
  }
  return rows;
}

/** What a quick choice chooses: of what can be chosen. */
export function quickChoice(rows: readonly PlaceRow[], quick: QuickChoice): Set<string> {
  const chosen = new Set<string>();
  for (const row of rows) {
    if (!canChoose(row)) continue;
    const take =
      quick === "all" ||
      (quick === "used" && row.uses > 0) ||
      (quick === "large" && row.size > LARGE_BYTES) ||
      (quick === "videos" && row.kind === "video");
    if (take) chosen.add(row.asset);
  }
  return chosen;
}

/** The rows in an order: the largest first, or by name. */
export function sortRows(rows: readonly PlaceRow[], order: PlaceOrder): PlaceRow[] {
  return rows.toSorted((a, b) =>
    order === "size"
      ? b.size - a.size || a.name.localeCompare(b.name, "zh-CN")
      : a.name.localeCompare(b.name, "zh-CN") || b.size - a.size,
  );
}

/** Rows shown at once, and the small ones folded away where there are many. */
export function foldRows(rows: readonly PlaceRow[]): {
  readonly shown: readonly PlaceRow[];
  readonly folded: readonly PlaceRow[];
} {
  if (rows.length < FOLD_FROM) return { shown: rows, folded: [] };
  return {
    shown: rows.filter((row) => row.size >= SMALL_BYTES),
    folded: rows.filter((row) => row.size < SMALL_BYTES),
  };
}

/** What the choice comes to: how many files, how many bytes. */
export function totalOf(
  rows: readonly PlaceRow[],
  chosen: ReadonlySet<string>,
): { readonly count: number; readonly bytes: number } {
  let count = 0;
  let bytes = 0;
  for (const row of rows)
    if (chosen.has(row.asset) && canChoose(row)) {
      count += 1;
      bytes += row.size;
    }
  return { count, bytes };
}

/** Of the assets of a project, how many are in the storage, how large, and how many only here. */
export function placeSummary(rows: readonly PlaceRow[]): {
  readonly there: number;
  readonly thereBytes: number;
  readonly here: number;
} {
  let there = 0;
  let thereBytes = 0;
  let here = 0;
  for (const row of rows) {
    if (row.where === "there") {
      there += 1;
      thereBytes += row.size;
    } else if (row.where !== "on") here += 1;
  }
  return { there, thereBytes, here };
}
