/**
 * The files of the assets of a project that is a folder: they are in the folder, at the path that
 * assets.json gives, and read from there, never copied into the browser. What the browser keeps of
 * them is what it can make again: their hashes, thumbnails and waveforms, and sounds made by code.
 * See the design of local projects, section 5.
 */
import type { ProjectStore } from "@animaquill/core";
import { isNoneOfIt } from "@animaquill/core";
import {
  FolderError,
  isRefusedByChrome,
  newNameFor,
  type FolderBases,
  type FolderHash,
  type LocalFolder,
  type MediaStore,
} from "@animaquill/host";
import { isSameHash, type HashOptions } from "@animaquill/media";
import type { Asset } from "@animaquill/schema";
import { hasherHere, type Hasher } from "../media/hasher.ts";
import { isProjectFile } from "./project-files.ts";

/** Where files that people bring in go, in the folder of a project. */
export const ASSETS_FOLDER = "assets";

/** What the folder has of the file of an asset, as far as the project goes. */
export type AssetFile =
  | { readonly kind: "there"; readonly file: File; readonly hash: string }
  /** Nothing at its path. */
  | { readonly kind: "missing" }
  /** It cannot be read now, as while another program holds on to it: it is looked at again. */
  | { readonly kind: "unknown" };

/** What is not right with the file of an asset, for people to put right. */
export type AssetIssue =
  | {
      readonly kind: "missing";
      readonly asset: string;
      readonly path: string;
      /** The very same file somewhere else in the folder, as after people moved it. */
      readonly found?: string;
      /** A name on the way that the browser does not show, which may well be why. */
      readonly hidden?: string;
    }
  | {
      /** Another file is at its path, as after people replaced it outside. */
      readonly kind: "changed";
      readonly asset: string;
      readonly path: string;
    };

export interface FolderAssetsOptions {
  /** The folder of the project, which can be another one after people found it again. */
  readonly folder: () => LocalFolder;
  /** What this browser knows the folder by, see `FolderRecord.id`. */
  readonly key: string;
  readonly bases: FolderBases;
  /** What the browser keeps for the project that it can make again. */
  readonly browser: MediaStore;
  readonly hasher?: Hasher;
}

/** A content hash, which is what assets are known by: everything else is made by the editor. */
const isAssetKey = (key: string): boolean => key.startsWith("sha256-");

/** At most this many files are looked at to find a file that moved: more is no project folder. */
const MAX_LOOKED_AT = 5000;

/** Whether a path is in the assets folder, where people put files to bring in. */
const isInAssets = (path: string): boolean => path.startsWith(`${ASSETS_FOLDER}/`);

/** The sizes and times that a hash holds for, by path, see `FolderHash`. */
const isStill = (known: FolderHash | undefined, file: File): known is FolderHash =>
  known !== undefined && known.size === file.size && known.lastModified === file.lastModified;

const isNamed = (error: unknown, name: string): boolean =>
  typeof error === "object" && error !== null && (error as { name?: unknown }).name === name;

export class FolderAssets {
  readonly #options: FolderAssetsOptions;
  readonly #hasher: Hasher;
  /** What was found out in this window, so that the database is asked once for each. */
  readonly #known = new Map<string, FolderHash>();
  /** Hashes on their way, by path, size and time: one read for all who want one. */
  readonly #hashing = new Map<string, Promise<string>>();

  constructor(options: FolderAssetsOptions) {
    this.#options = options;
    this.#hasher = options.hasher ?? hasherHere;
  }

  get #folder(): LocalFolder {
    return this.#options.folder();
  }

  /**
   * The file at a path and its hash. The hash is found out once for each size and time of the
   * file, as Git does: reading a large video again each time is what this saves. A file that
   * changed while it was read is read again once, see `LocalFolder.file`.
   */
  async fileAt(path: string): Promise<AssetFile> {
    for (let attempt = 1; ; attempt++) {
      let file: File;
      try {
        file = await this.#folder.file(path);
      } catch (error) {
        if (
          error instanceof FolderError &&
          (error.reason === "missing" || error.reason === "refused")
        ) {
          return { kind: "missing" };
        }
        return { kind: "unknown" };
      }
      try {
        return { kind: "there", file, hash: await this.#hashOf(path, file) };
      } catch (error) {
        if (attempt === 1 && isNamed(error, "NotReadableError")) continue;
        if (isNamed(error, "NotFoundError")) return { kind: "missing" };
        return { kind: "unknown" };
      }
    }
  }

  async #hashOf(path: string, file: File): Promise<string> {
    const kept = this.#known.get(path);
    if (isStill(kept, file)) return kept.hash;
    const { bases, key } = this.#options;
    const stored = await bases.hashOf(key, path).catch(() => undefined);
    if (isStill(stored, file)) {
      this.#known.set(path, stored);
      return stored.hash;
    }
    const job = `${path}\n${file.size}\n${file.lastModified}`;
    let hashing = this.#hashing.get(job);
    if (!hashing) {
      hashing = this.#hasher.file(file).finally(() => this.#hashing.delete(job));
      this.#hashing.set(job, hashing);
    }
    const hash = await hashing;
    this.#note({ path, size: file.size, lastModified: file.lastModified, hash });
    return hash;
  }

  #note(hash: FolderHash): void {
    this.#known.set(hash.path, hash);
    const { bases, key } = this.#options;
    void bases.keepHash(key, hash).catch(() => {});
  }

  /**
   * The files of the project as a media store: an asset from its path in the folder, by its hash,
   * while it is still that file; what the editor makes, from the browser. `assets` are those of
   * the project as it is now, also while it opens.
   */
  media(assets: () => Readonly<Record<string, Asset>> | undefined): MediaStore {
    const { browser } = this.#options;
    return {
      put: (hash, file) =>
        isAssetKey(hash)
          ? Promise.reject(new Error("The file of an asset goes into the project folder"))
          : browser.put(hash, file),
      get: async (hash) => {
        if (!isAssetKey(hash)) return browser.get(hash);
        const paths = Object.values(assets() ?? {})
          .filter((asset) => asset.hash !== undefined && isSameHash(asset.hash, hash))
          .map(({ path }) => path);
        for (const path of new Set(paths)) {
          const found = await this.fileAt(path);
          if (found.kind === "there" && isSameHash(found.hash, hash)) return found.file;
        }
        return undefined;
      },
      listMade: () => browser.listMade(),
      touchMade: (name) => browser.touchMade(name),
      removeMade: (name) => browser.removeMade(name),
    };
  }

  /** The hash of a file from outside the folder, as before copying it in, see `copyIn`. */
  hashOutside(file: Blob, options: HashOptions = {}): Promise<string> {
    return this.#hasher.file(file, options);
  }

  /**
   * Copies a file that people brought in into the assets folder, under the name it has as far as
   * it can, and finds out its hash while it is written: one read for both. It is in the project only
   * once all of it is there, which is up to whoever adds the asset.
   */
  async copyIn(
    file: File,
    { signal, onProgress }: { signal?: AbortSignal; onProgress?: (bytes: number) => void } = {},
  ): Promise<{ readonly path: string; readonly hash: string; readonly written: File }> {
    const folder = this.#folder;
    const taken = new Set<string>();
    for await (const path of folder.list({
      includes: (inner, kind) =>
        kind === "folder" ? inner === ASSETS_FOLDER || isInAssets(inner) : isInAssets(inner),
    })) {
      // A folder in it has a name too.
      taken.add(path.slice(ASSETS_FOLDER.length + 1).split("/")[0] as string);
    }
    for (let attempt = 1; ; attempt++) {
      const path = `${ASSETS_FOLDER}/${newNameFor(file.name, taken, ASSETS_FOLDER)}`;
      const copy = this.#hasher.copy(file);
      let written: File;
      try {
        written = await folder.write(path, copy.content, {
          expected: "absent",
          ...(signal && { signal }),
          ...(onProgress && { onProgress }),
        });
      } catch (error) {
        copy.abandon();
        // Another window, or another program, took the name just now, or an empty folder has it.
        const isTaken =
          error instanceof FolderError && (error.reason === "changed" || error.reason === "exists");
        if (isTaken && attempt < 5) {
          taken.add(path.slice(ASSETS_FOLDER.length + 1));
          continue;
        }
        throw error;
      }
      const hash = (await copy.hash()) ?? (await this.#hasher.file(written));
      this.#note({ path, size: written.size, lastModified: written.lastModified, hash });
      return { path, hash, written };
    }
  }

  /** Takes back a copy that came in for nothing, while it is still the one that was written. */
  async remove(path: string, written: File): Promise<void> {
    await this.#folder.remove(path, { expected: written }).catch(() => {});
  }

  /**
   * Compares every asset of the project with its file: what is not there, and what another file
   * took the place of. A missing one may be somewhere else in the folder, as after people moved it,
   * which is the file of the same size and hash.
   */
  async check(store: ProjectStore): Promise<readonly AssetIssue[]> {
    const issues: AssetIssue[] = [];
    const missing: {
      readonly asset: string;
      readonly path: string;
      readonly hash: string;
      readonly size: number;
    }[] = [];
    for (const [asset, { path, hash, size, storage }] of Object.entries(
      store.getState().assets ?? {},
    )) {
      // What is somewhere else on purpose has no file here.
      if (storage === "remote") continue;
      const found = await this.fileAt(path);
      if (found.kind === "unknown") continue;
      if (found.kind === "missing") {
        const hidden = path.split("/").find(isRefusedByChrome);
        if (hidden !== undefined) issues.push({ kind: "missing", asset, path, hidden });
        else if (hash !== undefined && size !== undefined)
          missing.push({ asset, path, hash, size });
        else issues.push({ kind: "missing", asset, path });
        continue;
      }
      if (hash !== undefined && !isSameHash(hash, found.hash)) {
        issues.push({ kind: "changed", asset, path });
      }
    }
    if (missing.length > 0) {
      const places = await this.#lookFor(missing, store);
      for (const { asset, path, hash } of missing) {
        const found = places.get(hash);
        issues.push({ kind: "missing", asset, path, ...(found !== undefined && { found }) });
      }
    }
    return issues;
  }

  /**
   * Files of the folder that have the size and hash of files that are missing, by hash. Only files
   * of a size that is missing get read, and no file that an asset has already.
   */
  async #lookFor(
    missing: readonly { readonly hash: string; readonly size: number }[],
    store: ProjectStore,
  ): Promise<Map<string, string>> {
    const sizes = new Set(missing.map(({ size }) => size));
    const used = new Set(Object.values(store.getState().assets ?? {}).map(({ path }) => path));
    const found = new Map<string, string>();
    let looked = 0;
    try {
      for await (const path of this.#folder.list({
        includes: (inner, kind) =>
          kind === "folder" || (!isNoneOfIt(inner) && !isProjectFile(inner)),
      })) {
        if (++looked > MAX_LOOKED_AT) break;
        if (used.has(path)) continue;
        let file: File;
        try {
          file = await this.#folder.file(path);
        } catch {
          continue;
        }
        if (!sizes.has(file.size)) continue;
        const hash = await this.#hashOf(path, file).catch(() => undefined);
        const match = hash && missing.find((each) => isSameHash(each.hash, hash));
        if (match && !found.has(match.hash)) found.set(match.hash, path);
        if (found.size === missing.length) break;
      }
    } catch {
      // The folder cannot be looked through now: what is missing is still missing.
    }
    return found;
  }

  /**
   * Tells which files of assets changed outside, by path, also those that came back or went away,
   * and new files in the assets folder: whatever holds on to a file has to get it again, see
   * `LocalFolder.file`. The folder session tells about the folder itself. Returns how to stop.
   */
  watch(paths: () => Iterable<string>, onChange: (paths: readonly string[]) => void): () => void {
    const watch = this.#folder.watch({
      includes: (path, kind) =>
        kind === "folder"
          ? path === ASSETS_FOLDER || isInAssets(path)
          : isInAssets(path) && !isNoneOfIt(path),
      files: paths,
      // A file that only got a new time cannot be read through a File from before any more.
      newTimes: true,
      onChange: (changes) => onChange(changes.map(({ path }) => path)),
      onProblem: () => {},
    });
    watch.ready.catch(() => {});
    return () => watch.stop();
  }
}
