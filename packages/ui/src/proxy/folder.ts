/**
 * The proxies of a project folder, in `PROXY_FOLDER`. The editor writes and takes away only what it
 * made there, and outside of it nothing but .animaquill/.gitignore where there is none. A proxy is
 * written under a name of its own first (`partOf`), checked once it is whole, and only then gets
 * its name: so whatever a crash leaves, nothing at the name of a proxy is half of one.
 */
import { FolderError, type LocalFolder, type LocalGrowingFile } from "@animaquill/host";
import { PROXY_FOLDER, isMadeHere, partOf } from "./spec.ts";

/** Keeps .animaquill out of Git, without changing the .gitignore of the project. */
const IGNORE_FILE = ".animaquill/.gitignore";

const isFolderError = (error: unknown, ...reasons: readonly FolderError["reason"][]) =>
  error instanceof FolderError && reasons.includes(error.reason);

export class ProxyFolder {
  readonly #root: () => LocalFolder;
  /** The folder of the proxies, to write it, of the project folder it is in. */
  #proxies: { readonly root: LocalFolder; readonly folder: Promise<LocalFolder> } | undefined;

  /** `root` is the project folder, which can be another one once people found it somewhere else. */
  constructor(root: () => LocalFolder) {
    this.#root = root;
  }

  /**
   * The proxy of this name as it is now, or undefined where there is none. Rejects with a
   * `FolderError` when the folder cannot be read now. Only reads: it makes nothing.
   */
  async find(name: string): Promise<File | undefined> {
    try {
      return await this.#root().file(`${PROXY_FOLDER}/${name}`);
    } catch (error) {
      if (isFolderError(error, "missing", "refused")) return undefined;
      throw error;
    }
  }

  /**
   * Starts writing a proxy, under the name it has until it is whole. What an earlier try left of it,
   * as a crash does, goes first: nothing else gets that name.
   */
  start(name: string): Promise<LocalGrowingFile> {
    return this.#inFolder(async (folder) => {
      const part = partOf(name);
      await folder.remove(part);
      return folder.grow(part);
    });
  }

  /**
   * Gives a proxy that `start` wrote its name, once it is whole and checked. What is at the name is
   * no proxy, or there would be no new one: it goes. Resolves to the proxy as it is now.
   */
  commit(name: string): Promise<File> {
    return this.#inFolder(async (folder) => {
      await folder.remove(name);
      await folder.move(partOf(name), name);
      return folder.file(name);
    });
  }

  /** Takes away a proxy that is not right. */
  async remove(name: string): Promise<void> {
    await this.#inFolder((folder) => folder.remove(name));
  }

  /** Takes away what `start` wrote of a proxy, once it is not going to get its name. */
  async discard(name: string): Promise<void> {
    await this.#inFolder((folder) => folder.remove(partOf(name)));
  }

  /**
   * Takes away what the editor made in the folder of proxies that is of no use any more, as
   * `isUseless` says of each name, such as what crashes left of proxies on their way. Nothing else
   * there is ever taken away. What is in use stays. Resolves to what went. Never call this while a
   * proxy is on its way: what it writes looks like what a crash leaves.
   */
  async tidy(isUseless: (name: string) => boolean): Promise<readonly string[]> {
    let folder: LocalFolder;
    try {
      folder = await (await this.#root().inside(".animaquill")).inside("proxies");
    } catch {
      // Nothing there, or nothing that can be looked at now.
      return [];
    }
    const removed: string[] = [];
    try {
      for await (const path of folder.list()) {
        if (path.includes("/") || !isMadeHere(path) || !isUseless(path)) continue;
        try {
          await folder.remove(path);
          removed.push(path);
        } catch {
          // In use, or gone already.
        }
      }
    } catch {
      // The folder went away while it was looked through: there is nothing more to take away.
    }
    return removed;
  }

  /** Does something in the folder of proxies, which is made again when it went away meanwhile. */
  async #inFolder<T>(work: (folder: LocalFolder) => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
      const folder = await this.#writable();
      try {
        return await work(folder);
      } catch (error) {
        // Somebody took away the folder of proxies, or all of .animaquill.
        if (attempt === 1 && isFolderError(error, "gone")) {
          this.#proxies = undefined;
          continue;
        }
        throw error;
      }
    }
  }

  #writable(): Promise<LocalFolder> {
    const root = this.#root();
    if (this.#proxies?.root !== root) {
      const folder = made(root);
      this.#proxies = { root, folder };
      // The next try makes it again.
      folder.catch(() => {
        if (this.#proxies?.folder === folder) this.#proxies = undefined;
      });
    }
    return this.#proxies.folder;
  }
}

/** The folder of proxies of a project folder, made where it is not there. */
async function made(root: LocalFolder): Promise<LocalFolder> {
  // Only where there is none: what is there, whatever it says, stays as it is.
  const ignore = await root.file(IGNORE_FILE).catch(() => undefined);
  if (!ignore) {
    try {
      await root.write(IGNORE_FILE, "*\n", { expected: "absent" });
    } catch (error) {
      if (!isFolderError(error, "changed")) throw error;
    }
  }
  const local = await root.inside(".animaquill", { create: true });
  return local.inside("proxies", { create: true });
}
