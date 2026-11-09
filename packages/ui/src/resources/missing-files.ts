import type { ProjectStore } from "@animaquill/core";
import type { AssetIssue } from "../folder/assets.ts";
import type { MediaLibrary } from "../media/library.ts";
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
}

export type MissingFiles = ReadonlyMap<string, MissingFile>;

const NONE: MissingFiles = new Map();

/**
 * Which assets of the open project have no file, for the explorer. A project folder compares its
 * files by itself, see `ProjectFolders.assetIssues`; a project in this browser can come in without
 * its files, which this looks for each time the assets change or a file comes back. Only while
 * somebody listens: nothing is read for nobody.
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
  #looked: { store: ProjectStore | undefined; assets: unknown; restored: number } | undefined;
  #round = 0;

  constructor(session: ProjectSession, media: MediaLibrary, folders: ProjectFolders | undefined) {
    this.#session = session;
    this.#media = media;
    this.#folders = folders;
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
    const assets = store?.getState().assets;
    const folders = this.#folders?.assets() ? this.#folders : undefined;
    if (folders) {
      this.#looked = undefined;
      this.#set(fromIssues(folders.assetIssues, assets));
      return;
    }
    const restored = this.#media.getRestored();
    const looked = this.#looked;
    if (
      looked &&
      looked.store === store &&
      looked.assets === assets &&
      looked.restored === restored
    ) {
      return;
    }
    this.#looked = { store, assets, restored };
    this.#round += 1;
    const round = this.#round;
    if (!store || !assets) {
      this.#set(NONE);
      return;
    }
    void Promise.all(
      Object.entries(assets).map(async ([asset, { path }]) => {
        const there = await this.#media.hasFile(asset).catch(() => true);
        return there ? [] : [{ asset, path }];
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
    if (issue.kind !== "missing" || !Object.hasOwn(known, issue.asset)) continue;
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
      other.hidden !== file.hidden
    ) {
      return false;
    }
  }
  return true;
}
