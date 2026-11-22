import { INCOMPLETE_FILE, ProjectStore } from "@animaquill/core";
import {
  FolderError,
  type FolderRecord,
  type KeptFile,
  type LocalFolders,
  type MediaStore,
  type ProjectLibrary,
} from "@animaquill/host";
import { isSameHash } from "@animaquill/media";
import type { Asset } from "@animaquill/schema";
import type { FolderAssets } from "./assets.ts";

/**
 * What this browser keeps for a project that is a folder besides its log: copies of the files of
 * its assets, which people can let go of once the folder has them, and the file that says a write
 * that stopped right at the end is not done, see `FolderCopies.settle`. Nothing here asks people
 * anything: that is `ProjectFolders`.
 */

/** What letting go of the copies in the browser came to, see `FolderCopies.release`. */
export interface Release {
  /** Bytes that are free now. */
  readonly released: number;
  /** Copies that stay, because the folder does not have their files as the project says. */
  readonly missing: readonly KeptFile[];
  /**
   * Copies of files that no asset uses now, which stay while the project is open somewhere: undo
   * can bring back an asset that uses one, and then it can go back to the folder.
   */
  readonly unused: readonly KeptFile[];
}

/**
 * A project as it goes into a folder as a copy, see `SaveToFolder`: what it is now, and where the
 * files of its assets come from. Let go of once it is written.
 */
export interface CopySource {
  readonly store: ProjectStore;
  readonly media: Pick<MediaStore, "get">;
  close(): void;
}

/** A project read from its log, which takes what changes in it there too. */
export interface LoadedProject {
  readonly store: ProjectStore;
  /** Resolves once what changed is in the log, to whether it is. */
  saved(): Promise<boolean>;
  close(): void;
}

const isFolderError = (error: unknown, reason: string): boolean =>
  error instanceof FolderError && error.reason === reason;

/**
 * The project of a log, as it is now, or undefined when there is nothing of it. What changes in it
 * goes into the log, as for an open project, see `ProjectSession`.
 */
export async function loadProject(
  projects: ProjectLibrary,
  key: string,
): Promise<LoadedProject | undefined> {
  const log = await projects.open(key);
  let store: ProjectStore | undefined;
  try {
    const updates = await log.load();
    store = updates.length === 0 ? undefined : ProjectStore.fromUpdates(updates).store;
  } catch (error) {
    log.close();
    throw error;
  }
  if (!store) {
    log.close();
    return undefined;
  }
  const loaded = store;
  let pending: Promise<boolean> = Promise.resolve(true);
  const stop = loaded.onLocalUpdate((update) => {
    pending = pending.then((isSaved) =>
      log.append(update, loaded.getState().manifest.name).then(
        () => isSaved,
        () => false,
      ),
    );
  });
  return {
    store: loaded,
    saved: () => pending,
    close() {
      stop();
      loaded.destroy();
      log.close();
    },
  };
}

export class FolderCopies {
  readonly #folders: Pick<LocalFolders, "records">;
  readonly #projects: ProjectLibrary;

  constructor(folders: Pick<LocalFolders, "records">, projects: ProjectLibrary) {
    this.#folders = folders;
    this.#projects = projects;
  }

  /**
   * Takes away what a move that stopped right at the end left of the file that says it is not done,
   * once the folder opens: only while it is the very file the move wrote, see
   * `FolderRecord.unfinished`. Resolves to the record as it is after that.
   */
  async settle(record: FolderRecord): Promise<FolderRecord> {
    const { unfinished } = record;
    if (!unfinished) return record;
    try {
      await record.folder.remove(INCOMPLETE_FILE, { expected: unfinished });
    } catch (error) {
      // Not the file of the move any more: somebody else's. Anything else is tried again next time.
      if (!isFolderError(error, "changed")) return record;
    }
    const { unfinished: _, ...settled } = record;
    await this.#folders.records.put(settled).catch(() => {});
    return settled;
  }

  /**
   * What the copies of the files of the assets take in the browser, of a project that is a folder
   * now, in bytes.
   */
  async copiesOf(key: string): Promise<number> {
    const copies = await this.#projects.copies(key);
    return copies.reduce((sum, { size }) => sum + size, 0);
  }

  /**
   * Lets go of the copies in the browser of the files of the assets of a project that is a folder
   * now, as people say: of the files that the folder has as the project says. A copy of a file
   * that no asset uses now stays while the project is open somewhere, `open`, as undo can bring
   * back an asset that uses it: once it is open nowhere, nothing can. `assets` are those of the
   * project now, and `files` how the folder has them.
   */
  async release(
    key: string,
    assets: Readonly<Record<string, Asset>>,
    files: FolderAssets,
    { open }: { readonly open: boolean },
  ): Promise<Release> {
    const copies = await this.#projects.copies(key);
    const going: KeptFile[] = [];
    const missing: KeptFile[] = [];
    const unused: KeptFile[] = [];
    for (const copy of copies) {
      const users = Object.values(assets).filter(
        ({ hash }) => hash !== undefined && isSameHash(hash, copy.name),
      );
      if (users.length === 0) {
        (open ? unused : going).push(copy);
        continue;
      }
      let isThere = false;
      for (const { path } of users) {
        const found = await files.fileAt(path);
        if (found.kind === "there" && isSameHash(found.hash, copy.name)) {
          isThere = true;
          break;
        }
      }
      (isThere ? going : missing).push(copy);
    }
    if (going.length > 0) {
      // A move that stopped right at the end may not have got to this: the project is a folder.
      await this.#projects.toFolder(key);
      await this.#projects.dropCopies(
        key,
        going.map(({ name }) => name),
      );
    }
    return { released: going.reduce((sum, { size }) => sum + size, 0), missing, unused };
  }
}
