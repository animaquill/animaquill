import { elsewhereOf, type ProjectStore } from "@animaquill/core";
import type { Elsewhere } from "@animaquill/schema";
import type { AssetIssue } from "../folder/assets.ts";
import type { MediaLibrary } from "../media/library.ts";
import type { HereOf } from "../storage/places.ts";
import { Emitter } from "../workbench/emitter.ts";
import type { ProjectFolders } from "../workbench/project-folders.ts";
import type { ProjectSession } from "../workbench/session.ts";

/** An asset of the open project whose file is not there. */
export interface MissingFile {
  readonly asset: string;
  readonly path: string;
  /** The very same file somewhere else in the project folder, as after people moved it. */
  readonly found?: string;
  /** A name on the way that the browser does not show, which may well be why. */
  readonly hidden?: string;
  /**
   * Where else the file is kept, which it can be downloaded from: then it is not here, but it is
   * not missing either. See `elsewhereOf`.
   */
  readonly elsewhere?: Elsewhere;
}

/** Whether the file of an asset is missing, as opposed to not here but somewhere else. */
export const isMissing = (file: MissingFile | undefined): file is MissingFile =>
  file !== undefined && file.elsewhere === undefined;

export type MissingFiles = ReadonlyMap<string, MissingFile>;

const NONE: MissingFiles = new Map();

/**
 * Which assets of the open project have no file, for the explorer, and of those which are kept
 * somewhere else, see `MissingFile.elsewhere`. A project folder compares its files by itself, see
 * `ProjectFolders.assetIssues`; a project in this browser can come in without its files, which this
 * looks for each time the assets or their places change or a file comes back. Only while somebody
 * listens: nothing is read for nobody.
 */
export class MissingFileWatch {
  readonly #session: ProjectSession;
  readonly #media: MediaLibrary;
  readonly #folders: ProjectFolders | undefined;
  readonly #emitter = new Emitter();
  #snapshot: MissingFiles = NONE;
  #listeners = 0;
  #stop: (() => void) | undefined;
  /** What was looked at last, so that the same is not looked at again. */
  #looked:
    | {
        store: ProjectStore | undefined;
        assets: unknown;
        places: unknown;
        here: string;
        restored: number;
      }
    | undefined;
  #round = 0;

  /** Where the project is, for what a file that is not here can be downloaded from. */
  readonly #here: HereOf;

  constructor(
    session: ProjectSession,
    media: MediaLibrary,
    folders: ProjectFolders | undefined,
    here: HereOf = () => undefined,
  ) {
    this.#session = session;
    this.#media = media;
    this.#folders = folders;
    this.#here = here;
  }

  subscribe = (listener: () => void): (() => void) => {
    const unsubscribe = this.#emitter.subscribe(listener);
    this.#listeners += 1;
    if (this.#listeners === 1) this.#start();
    return () => {
      unsubscribe();
      this.#listeners -= 1;
      if (this.#listeners === 0) {
        this.#stop?.();
        this.#stop = undefined;
        this.#looked = undefined;
      }
    };
  };

  getSnapshot = (): MissingFiles => this.#snapshot;

  #start(): void {
    let storeStop: (() => void) | undefined;
    let store: ProjectStore | undefined;
    const follow = () => {
      if (this.#session.store !== store) {
        storeStop?.();
        store = this.#session.store;
        storeStop = store?.subscribe(() => this.#look());
      }
      this.#look();
    };
    const stops = [
      this.#session.subscribe(follow),
      this.#media.subscribe(() => this.#look()),
      ...(this.#folders ? [this.#folders.subscribe(() => this.#look())] : []),
    ];
    follow();
    this.#stop = () => {
      storeStop?.();
      for (const stop of stops) stop();
    };
  }

  #look(): void {
    const store = this.#session.store;
    const state = store?.getState();
    const assets = state?.assets;
    const places = state?.places;
    const folders = this.#folders?.assets() ? this.#folders : undefined;
    if (folders) {
      this.#looked = undefined;
      this.#set(fromIssues(folders.assetIssues, assets));
      return;
    }
    const restored = this.#media.getRestored();
    const where = this.#here();
    const here = JSON.stringify(where ?? null);
    const looked = this.#looked;
    if (
      looked &&
      looked.store === store &&
      looked.assets === assets &&
      looked.places === places &&
      looked.here === here &&
      looked.restored === restored
    ) {
      return;
    }
    this.#looked = { store, assets, places, here, restored };
    this.#round += 1;
    const round = this.#round;
    if (!state || !assets) {
      this.#set(NONE);
      return;
    }
    void Promise.all(
      Object.entries(assets).map(async ([asset, { path }]): Promise<MissingFile[]> => {
        const there = await this.#media.hasFile(asset).catch(() => true);
        if (there) return [];
        const elsewhere = elsewhereOf(state, asset, where);
        return [{ asset, path, ...(elsewhere && { elsewhere }) }];
      }),
    ).then((found) => {
      if (round !== this.#round) return;
      this.#set(new Map(found.flat().map((file) => [file.asset, file])));
    });
  }

  #set(next: MissingFiles): void {
    if (sameFiles(next, this.#snapshot)) return;
    this.#snapshot = next;
    this.#emitter.emit();
  }
}

function fromIssues(issues: readonly AssetIssue[], assets: unknown): MissingFiles {
  const known = (assets ?? {}) as Readonly<Record<string, unknown>>;
  const files = new Map<string, MissingFile>();
  for (const issue of issues) {
    if (!Object.hasOwn(known, issue.asset)) continue;
    if (issue.kind === "elsewhere") {
      const { asset, path, storage } = issue;
      files.set(asset, { asset, path, elsewhere: storage });
      continue;
    }
    if (issue.kind !== "missing") continue;
    const { asset, path, found, hidden } = issue;
    files.set(asset, {
      asset,
      path,
      ...(found !== undefined && { found }),
      ...(hidden !== undefined && { hidden }),
    });
  }
  return files;
}

function sameFiles(a: MissingFiles, b: MissingFiles): boolean {
  if (a.size !== b.size) return false;
  for (const [asset, file] of a) {
    const other = b.get(asset);
    if (
      !other ||
      other.path !== file.path ||
      other.found !== file.found ||
      other.hidden !== file.hidden ||
      other.elsewhere !== file.elsewhere
    ) {
      return false;
    }
  }
  return true;
}
