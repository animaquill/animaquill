import type { ProjectManifest } from "@animaquill/schema";
import type { UploadBlock } from "./uploads.ts";

/**
 * Where files of assets imported from now on go (docs/design/online-offline.md of AnimaQuill Cloud,
 * 1.7): the "默认存储空间" of the project, as the project says, as the mode has it where it says
 * nothing, and as it can be here. No DOM.
 */

/**
 * The kinds of places a default can name. The format takes `lfs` and `local` so far: the cloud space
 * and the person's own storage come with their uploads, and the fallback below already knows them.
 */
export type PlaceKind = "lfs" | "local" | "platform" | "remote";

/** Why a place cannot take new assets here. */
export type PlaceUnusable =
  /** Offline: nothing goes to the backend. */
  | "offline"
  /** The backend has no large file storage. */
  | "unsupported"
  /** The project has no repository. */
  | "noRepository"
  /** The cloud space is not open to this person. */
  | "noSpace"
  /** This person has no such storage of their own. */
  | "noStore";

export interface DefaultPlace {
  /** What the project's default is: what it says, or the default of the mode. */
  readonly chosen: PlaceKind;
  /** Whether the project says it, or the mode does. */
  readonly written: boolean;
  /** Where new assets go here: `chosen`, or what it falls back to. */
  readonly effective: PlaceKind;
  /** Why `effective` is not `chosen`. */
  readonly unusable?: PlaceUnusable;
}

/** The default of a mode: online the repository, offline this computer (the project folder). */
export const modeDefault = (mode: "online" | "offline"): PlaceKind =>
  mode === "online" ? "lfs" : "local";

/**
 * Whether the repository's large file storage takes new assets of the open project here, from how
 * the uploads stand: what only waits (signing in, the repository being made or unusable a while)
 * does; uploads say themselves why they wait.
 */
export function lfsUsable(
  mode: "online" | "offline",
  blocked: UploadBlock | undefined,
  available: boolean,
): PlaceUnusable | undefined {
  if (mode === "offline" || blocked === "notCloud") return "offline";
  if (!available || blocked === "unsupported") return "unsupported";
  if (blocked === "noRepository") return "noRepository";
  return undefined;
}

/**
 * The default of the project here. A place that cannot be used falls back: the cloud space and
 * the person's own storage to the repository, the repository to this computer, which always can.
 */
export function defaultPlaceOf(
  said: { readonly kind: PlaceKind } | undefined,
  mode: "online" | "offline",
  usable: (kind: PlaceKind) => PlaceUnusable | undefined,
): DefaultPlace {
  const chosen = said?.kind ?? modeDefault(mode);
  const first = chosen === "local" ? undefined : usable(chosen);
  if (first === undefined) return { chosen, written: said !== undefined, effective: chosen };
  const fallback: PlaceKind = chosen !== "lfs" && usable("lfs") === undefined ? "lfs" : "local";
  return { chosen, written: said !== undefined, effective: fallback, unusable: first };
}

/** What `project.setDefaultStorage` writes for a choice: nothing where the mode says so already. */
export const defaultToWrite = (
  kind: "lfs" | "local",
  mode: "online" | "offline",
): ProjectManifest["defaultStorage"] | null => (kind === modeDefault(mode) ? null : { kind });

/** Of assets just imported, what goes where by default, and what people hear of. */
export interface ImportPlan {
  /** Into the large file storage. */
  readonly send: readonly string[];
  /** Of those, larger than people are told of (R-ST-3). */
  readonly large: readonly string[];
  /** Larger than the large file storage takes: they stay here. */
  readonly tooLarge: readonly string[];
}

/**
 * Assets just imported, as the default has them: into the large file storage where that is where
 * they go, with what is too large for it left here. Only imports come here: another file of an
 * asset goes where the one before went, and what people took out stays out.
 */
export function planImport(
  ids: readonly string[],
  assets: Readonly<
    Record<
      string,
      { readonly hash?: string | undefined; readonly size?: number | undefined } | undefined
    >
  >,
  effective: PlaceKind,
  sizes: { readonly large: number; readonly most: number },
): ImportPlan {
  const send: string[] = [];
  const large: string[] = [];
  const tooLarge: string[] = [];
  if (effective !== "lfs") return { send, large, tooLarge };
  for (const id of new Set(ids)) {
    const asset = assets[id];
    if (asset?.hash === undefined || asset.size === undefined) continue;
    if (asset.size > sizes.most) {
      tooLarge.push(id);
      continue;
    }
    send.push(id);
    if (asset.size > sizes.large) large.push(id);
  }
  return { send, large, tooLarge };
}
