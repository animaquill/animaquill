import type { Here } from "@animaquill/core";
import { downloadableFrom, type Asset, type Elsewhere } from "@animaquill/schema";
import type { TFunction } from "i18next";

/**
 * Where the open project is, as far as the places of files go, see `Here`: what a file that is
 * not here can be downloaded from depends on it. Undefined while nobody knows, which takes every
 * place as it is written down.
 */
export type HereOf = () => Here | undefined;

/** An asset whose file is not here, but can come from where it is kept, see `downloadableFrom`. */
export interface ElsewhereFile {
  readonly name: string;
  readonly storage: Elsewhere;
  /** Where a `remote` one is. */
  readonly url?: string;
}

/**
 * An asset whose file is not here, as a report says it: where it can come from, or undefined for
 * one that is missing. `asset` as files have it, see `placedAsset`.
 */
export function elsewhereFile(asset: Asset, name: string): ElsewhereFile | undefined {
  const storage = downloadableFrom(asset);
  if (storage === undefined) return undefined;
  return { name, storage, ...(asset.url !== undefined && { url: asset.url }) };
}

/** The name of the computer at an address, or undefined for none that can be read. */
function hostOf(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  try {
    return new URL(url).host || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Where a file that is not here can be downloaded from, in words: GitHub, the cloud space, or the
 * computer at its address, which can need keys that only one computer has.
 */
export function downloadFrom(t: TFunction, storage: Elsewhere, url: string | undefined): string {
  if (storage !== "remote") return t(`storage.download.${storage}`);
  const host = hostOf(url);
  return host === undefined
    ? t("storage.download.remoteUnknown")
    : t("storage.download.remote", { host });
}

/** Files that are not here, in a list for people: where each can come from. */
export const downloadableItems = (t: TFunction, files: readonly ElsewhereFile[]): string[] =>
  files.map(({ name, storage, url }) =>
    t("transfer.elsewhereItem", { name, download: downloadFrom(t, storage, url) }),
  );
