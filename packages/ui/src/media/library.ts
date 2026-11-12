import { computePeaks, readSound } from "@animaquill/audio";
import { madeSoundOf, type ClipState, type ProjectStore } from "@animaquill/core";
import { FolderError, type ProjectLibrary } from "@animaquill/host";
import { formatHash, isSameHash, probeMedia, type MediaFacts } from "@animaquill/media";
import {
  fromSeconds,
  formatTime,
  newId,
  parseTime,
  toSeconds,
  type Asset,
} from "@animaquill/schema";
import { Emitter } from "../workbench/emitter.ts";
import { encodeStrip, stripCount, StripMaker } from "./strips.ts";
import { projectKeyOf, type ProjectSession } from "../workbench/session.ts";
import type { FolderAssets } from "../folder/assets.ts";

/** Peaks are worked out from a file. A new way of doing that gets a new key, and old ones stay unused. */
const peaksKey = (hash: string) => `peaks-1:${hash}`;

const stripKey = (hash: string) => `strip-1:${hash}`;

/** Frames of a video side by side, evenly spread over its length. */
export interface FilmStrip {
  readonly image: ImageBitmap;
  readonly count: number;
  /** Seconds. */
  readonly duration: number;
}

/** Hashing reads a whole file into memory, and browsers stop somewhere around here. */
const MAX_FILE_BYTES = 2 * 1024 ** 3;

export interface MediaMessages {
  unsupported(name: string): void;
  tooLarge(name: string): void;
  saveFailed(name: string): void;
  commandFailed(message: string): void;
  /**
   * A large file is about to be copied into the project folder, where it takes as much room again,
   * see `ASK_BEFORE_COPYING_BYTES`. Resolves to whether people want that.
   */
  confirmCopy(name: string, bytes: number): Promise<boolean>;
  /** A file did not get into the project folder, and why, as far as is known. */
  copyFailed(name: string, reason: CopyFailure): void;
  /** A file in the project folder could not be read, so it did not come in. */
  readFailed(name: string): void;
  /** The file that took the place of the file of an asset is another kind of file. */
  otherKind(name: string): void;
  /**
   * The project cannot be edited now, see `ProjectStore.readOnly`: nothing came in, and nothing
   * was copied into its folder.
   */
  readOnly(): void;
}

/** Why a file did not get into the project folder. */
export type CopyFailure =
  /** The path is too long for the system, see `FolderFailure`. */
  | "too-long"
  /** The disk is full. */
  | "full"
  /** The editor may not write the folder now: the folder itself says why. */
  | "folder"
  | "other";

const failureOf = (error: unknown): CopyFailure => {
  if (!(error instanceof FolderError)) return "other";
  if (error.reason === "too-long" || error.reason === "full") return error.reason;
  return error.reason === "denied" || error.reason === "gone" ? "folder" : "other";
};

/**
 * From this size on, people are asked before a file gets copied into a project folder: it takes as
 * much room again, which putting it into the folder first would not. See the design, 5.
 */
export const ASK_BEFORE_COPYING_BYTES = 1024 ** 3;

/** What goes into the project folder right now, for people to see, and to stop. */
export interface Copying {
  readonly name: string;
  /** Reading it to tell whether the project has it already, or copying it. */
  readonly stage: "checking" | "copying";
  /** Whole percent. */
  readonly percent: number;
  readonly stop: () => void;
}

/** Whether the file of an asset is at its path, and is still that file. */
async function hasItsFile(folder: FolderAssets, path: string, hash: string): Promise<boolean> {
  const found = await folder.fileAt(path);
  return found.kind === "there" && isSameHash(found.hash, hash);
}

async function hashOf(file: Blob): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return formatHash(new Uint8Array(digest));
}

const extensionOf = (name: string) => /\.([A-Za-z0-9]{1,8})$/.exec(name)?.[1]?.toLowerCase();

function infoOf(facts: MediaFacts): Asset["info"] {
  const { duration, width, height, fps, sampleRate, hasAudio } = facts;
  return {
    ...(duration ? { duration: formatTime(fromSeconds(duration)) } : {}),
    ...(width ? { width } : {}),
    ...(height ? { height } : {}),
    ...(fps ? { fps: String(Number(fps.toFixed(3))) } : {}),
    ...(sampleRate ? { sampleRate } : {}),
    ...(hasAudio === undefined ? {} : { hasAudio }),
  };
}

/** The files of the open project: bringing them in, and getting at them later. */
export class MediaLibrary {
  readonly #session: ProjectSession;
  readonly #projects: ProjectLibrary;
  readonly #messages: MediaMessages;
  readonly #emitter = new Emitter();
  /** By asset, for the file it had: another hash or path is another file. */
  readonly #urls = new Map<
    string,
    { readonly key: string; readonly url: Promise<string | undefined> }
  >();
  /** By file. Undefined means it is on its way or there is nothing to show. */
  readonly #peaks = new Map<string, Uint8Array | undefined>();
  /** One at a time, because decoding takes the whole file. */
  #peaksQueue: Promise<void> = Promise.resolve();
  readonly #strips = new Map<string, FilmStrip | undefined>();
  #stripsQueue: Promise<void> = Promise.resolve();
  readonly #stripMaker: StripMaker;
  readonly #restoredListeners = new Set<(hash: string) => void>();
  #store: ProjectStore | undefined;
  #importing = 0;
  readonly #folder: () => FolderAssets | undefined;
  #copying: Copying | undefined;
  #restored = 0;

  constructor(
    session: ProjectSession,
    projects: ProjectLibrary,
    messages: MediaMessages,
    compositorUrl: string,
    /** The files of the open project where it is a folder: they go there, see `FolderAssets`. */
    folder: () => FolderAssets | undefined = () => undefined,
  ) {
    this.#stripMaker = new StripMaker(compositorUrl);
    this.#session = session;
    this.#projects = projects;
    this.#messages = messages;
    this.#folder = folder;
    session.subscribe(() => this.#followSession());
  }

  subscribe = this.#emitter.subscribe;
  /** How many files are on their way in. */
  getImporting = (): number => this.#importing;
  /** What goes into the project folder right now, see `Copying`. */
  getCopying = (): Copying | undefined => this.#copying;
  /** Changes when a file came back, for what has to look again. */
  getRestored = (): number => this.#restored;

  /** Calls back with the hash of a file that was missing and is here now. */
  onRestored(listener: (hash: string) => void): () => void {
    this.#restoredListeners.add(listener);
    return () => this.#restoredListeners.delete(listener);
  }

  #followSession(): void {
    if (this.#session.store === this.#store) return;
    this.#store = this.#session.store;
    // What was on its way into the folder of the project before does not go on.
    this.#copying?.stop();
    for (const id of this.#urls.keys()) this.#dropUrl(id);
    this.#peaks.clear();
    for (const strip of this.#strips.values()) strip?.image.close();
    this.#strips.clear();
  }

  /** The frames of a video. They show up later when they have to be made first. */
  stripOf(assetId: string): FilmStrip | undefined {
    const store = this.#store;
    const asset = store?.getState().assets?.[assetId];
    if (!store || asset?.kind !== "video" || asset.hash === undefined) return undefined;
    const { hash } = asset;
    if (!this.#strips.has(hash)) {
      this.#strips.set(hash, undefined);
      const known = asset.info?.duration;
      const duration = known === undefined ? 0 : toSeconds(parseTime(known));
      this.#stripsQueue = this.#stripsQueue.then(() => this.#loadStrip(store, hash, duration));
    }
    return this.#strips.get(hash);
  }

  stripOfClip(clip: ClipState): FilmStrip | undefined {
    const { media } = clip.source as { media?: { asset?: string } };
    return media?.asset === undefined ? undefined : this.stripOf(media.asset);
  }

  async #loadStrip(store: ProjectStore, hash: string, duration: number): Promise<void> {
    try {
      const image = await this.#readStrip(store, hash, stripCount(duration));
      if (!image) return;
      if (store !== this.#store) {
        image.close();
        return;
      }
      this.#strips.set(hash, { image, count: stripCount(duration), duration });
      this.#emitter.emit();
    } catch (error) {
      // Pictures on clips are a help. The preview says so when a video cannot be read.
      console.warn("No frames for this video", error);
    }
  }

  async #readStrip(
    store: ProjectStore,
    hash: string,
    count: number,
  ): Promise<ImageBitmap | undefined> {
    const media = this.#media(store);
    const saved = await media.get(stripKey(hash));
    if (saved) return createImageBitmap(saved);
    const file = await media.get(hash);
    const image = file && (await this.#stripMaker.make(file, count));
    if (image) await media.put(stripKey(hash), await encodeStrip(image));
    return image;
  }

  /** Which file a clip with sound plays. Code may still be making it. */
  #soundFileOf(store: ProjectStore, clip: ClipState): string | undefined {
    const state = store.getState();
    if (clip.source.kind === "sound") return madeSoundOf(state, clip)?.file;
    const { media } = clip.source as { media?: { asset?: string } };
    return media?.asset === undefined ? undefined : state.assets?.[media.asset]?.hash;
  }

  /** The waveform of the file of an asset, as `peaksOf` has it for a clip. */
  peaksOfAsset(assetId: string): Uint8Array | undefined {
    return this.peaksOf({ source: { kind: "audio", media: { asset: assetId } } } as ClipState);
  }

  /** The waveform of a clip. It shows up later when it has to be worked out first. */
  peaksOf(clip: ClipState): Uint8Array | undefined {
    const store = this.#store;
    const hash = store && this.#soundFileOf(store, clip);
    if (!store || hash === undefined) return undefined;
    if (!this.#peaks.has(hash)) {
      this.#peaks.set(hash, undefined);
      this.#peaksQueue = this.#peaksQueue.then(() => this.#loadPeaks(store, hash));
    }
    return this.#peaks.get(hash);
  }

  async #loadPeaks(store: ProjectStore, hash: string): Promise<void> {
    try {
      const peaks = await this.#readPeaks(store, hash);
      if (store !== this.#store || !peaks) return;
      this.#peaks.set(hash, peaks);
      this.#emitter.emit();
    } catch (error) {
      // A waveform is a help. Playing says so when the sound itself cannot be read.
      console.warn("No waveform", error);
    }
  }

  async #readPeaks(store: ProjectStore, hash: string): Promise<Uint8Array | undefined> {
    const media = this.#media(store);
    const saved = await media.get(peaksKey(hash));
    if (saved) return new Uint8Array(await saved.arrayBuffer());
    const file = await media.get(hash);
    if (!file) return undefined;
    const peaks = await computePeaks(readSound(file, 0, Number.POSITIVE_INFINITY));
    await media.put(peaksKey(hash), new Blob([peaks as Uint8Array<ArrayBuffer>]));
    return peaks;
  }

  /** Code finished making a sound, so whatever looked for that file has to look again. */
  soundArrived(file: string): void {
    this.#peaks.delete(file);
    this.#emitter.emit();
  }

  /** Lets people choose files. Resolves to the assets they became. */
  pickFiles(): Promise<readonly string[]> {
    return new Promise((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      input.multiple = true;
      input.accept = "video/*,audio/*,image/*";
      input.addEventListener("change", () => {
        void this.importFiles([...(input.files ?? [])]).then(resolve);
      });
      input.addEventListener("cancel", () => resolve([]));
      input.click();
    });
  }

  /** Lets people choose one file, of a kind of media. Resolves to nothing when they do not. */
  chooseFile(kind: Asset["kind"]): Promise<File | undefined> {
    return new Promise((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = kind === "video" || kind === "audio" || kind === "image" ? `${kind}/*` : "";
      input.addEventListener("change", () => resolve(input.files?.[0]));
      input.addEventListener("cancel", () => resolve(undefined));
      input.click();
    });
  }

  /**
   * Whether this browser has the file of an asset, for a project that is kept in the browser: one
   * can come in without its files. Those of a project folder are up to `ProjectFolders`. A file
   * that is kept somewhere else too is kept here as well, so where it is says nothing about this.
   */
  async hasFile(assetId: string): Promise<boolean> {
    const store = this.#store;
    const asset = store?.getState().assets?.[assetId];
    if (!store || !asset) return false;
    if (asset.hash === undefined) return false;
    return (await this.#media(store).get(asset.hash)) !== undefined;
  }

  /**
   * Another file for an asset, which its clips show from then on: one that people chose to replace
   * it with, or the file of a missing asset found again. It has to be the same kind of media, so that
   * the clips can still show it. In a project folder, a file that is in it already is used where it
   * is, by its path, and any other gets copied in. Resolves to whether the asset has it now.
   */
  async replaceFile(
    assetId: string,
    source: { readonly file: File } | { readonly path: string },
  ): Promise<boolean> {
    const store = this.#store;
    const asset = store?.getState().assets?.[assetId];
    if (!store || !asset) return false;
    if (store.readOnly) {
      this.#messages.readOnly();
      return false;
    }
    const folder = this.#folder();
    let file: File;
    let place: { readonly path: string; readonly hash: string } | undefined;
    if ("path" in source) {
      const found = folder && (await folder.fileAt(source.path));
      if (found?.kind !== "there") {
        this.#messages.readFailed(source.path);
        return false;
      }
      file = found.file;
      place = { path: source.path, hash: found.hash };
    } else {
      file = source.file;
    }
    const facts = await probeMedia(file);
    if (!facts) {
      this.#messages.unsupported(file.name);
      return false;
    }
    // Clips of a video cannot play a sound file in its place.
    if (facts.kind !== asset.kind) {
      this.#messages.otherKind(file.name);
      return false;
    }
    try {
      if (folder) place ??= await this.#copyIn(store, folder, file);
      else place = await this.#keep(store, assetId, asset, file);
    } catch (error) {
      console.warn("A file could not be taken for an asset", error);
      this.#messages.saveFailed(file.name);
      return false;
    }
    if (!place || this.#session.store !== store) return false;
    const result = store.execute({
      type: "asset.update",
      params: {
        asset: assetId,
        changes: { path: place.path, hash: place.hash, size: file.size, info: infoOf(facts) },
      },
    });
    if (!result.ok) {
      this.#messages.commandFailed(result.error.message);
      return false;
    }
    this.filesChanged([asset.path, place.path]);
    return true;
  }

  /** Keeps a file in this browser for an asset, at a path with the extension of the file. */
  async #keep(
    store: ProjectStore,
    assetId: string,
    asset: Asset,
    file: File,
  ): Promise<{ readonly path: string; readonly hash: string } | undefined> {
    if (file.size > MAX_FILE_BYTES) {
      this.#messages.tooLarge(file.name);
      return undefined;
    }
    const hash = await hashOf(file);
    await this.#media(store).put(hash, file);
    const extension = extensionOf(file.name);
    const path =
      extensionOf(asset.path) === extension
        ? asset.path
        : `assets/${assetId}${extension ? `.${extension}` : ""}`;
    return { path, hash };
  }

  /** Copies a file into the project folder as `#bringIntoFolder` does, asking first for a large one. */
  async #copyIn(
    store: ProjectStore,
    folder: FolderAssets,
    file: File,
  ): Promise<{ readonly path: string; readonly hash: string } | undefined> {
    if (
      file.size >= ASK_BEFORE_COPYING_BYTES &&
      !(await this.#messages.confirmCopy(file.name, file.size))
    ) {
      return undefined;
    }
    const stopper = new AbortController();
    const show = (bytes: number) => {
      const percent = file.size > 0 ? Math.floor((bytes / file.size) * 100) : 100;
      if (this.#copying?.percent === percent) return;
      this.#copying = { name: file.name, stage: "copying", percent, stop: () => stopper.abort() };
      this.#emitter.emit();
    };
    try {
      show(0);
      const copied = await folder.copyIn(file, { signal: stopper.signal, onProgress: show });
      if (this.#session.store !== store) {
        await folder.remove(copied.path, copied.written);
        return undefined;
      }
      return { path: copied.path, hash: copied.hash };
    } catch (error) {
      if (stopper.signal.aborted) return undefined;
      this.#messages.copyFailed(file.name, failureOf(error));
      return undefined;
    } finally {
      this.#copying = undefined;
      this.#emitter.emit();
    }
  }

  /** One at a time, because each one is read into memory. A file that fails does not stop others. */
  async importFiles(files: readonly File[]): Promise<readonly string[]> {
    const store = this.#session.store;
    // Nothing goes into the folder of a project that cannot take it in.
    if (store?.readOnly && files.length > 0) {
      this.#messages.readOnly();
      return [];
    }
    const ids: string[] = [];
    this.#setImporting(this.#importing + files.length);
    for (const [index, file] of files.entries()) {
      // Another project opened meanwhile: what is left was not meant for it.
      if (this.#session.store !== store) {
        this.#setImporting(this.#importing - (files.length - index));
        break;
      }
      const id = await this.#importFile(file);
      if (id !== undefined && this.#session.store === store) ids.push(id);
      this.#setImporting(this.#importing - 1);
    }
    return ids;
  }

  #setImporting(count: number): void {
    this.#importing = count;
    this.#emitter.emit();
  }

  /**
   * Files that are in the project folder already, by their path there: they are used where they
   * are, nothing gets copied.
   */
  async importPaths(paths: readonly string[]): Promise<readonly string[]> {
    const store = this.#session.store;
    const folder = this.#folder();
    if (!store || !folder) return [];
    if (store.readOnly && paths.length > 0) {
      this.#messages.readOnly();
      return [];
    }
    const ids: string[] = [];
    this.#setImporting(this.#importing + paths.length);
    for (const path of paths) {
      try {
        if (this.#session.store !== store) continue;
        const found = await folder.fileAt(path);
        if (found.kind !== "there") {
          this.#messages.readFailed(path);
          continue;
        }
        const facts = await probeMedia(found.file);
        if (!facts) {
          this.#messages.unsupported(found.file.name);
          continue;
        }
        if (this.#session.store !== store) continue;
        const id = this.#add(store, found.file, path, found.hash, facts);
        if (id !== undefined) ids.push(id);
      } finally {
        this.#setImporting(this.#importing - 1);
      }
    }
    return ids;
  }

  async #importFile(file: File): Promise<string | undefined> {
    const store = this.#session.store;
    if (!store) return undefined;
    const folder = this.#folder();
    if (folder) return this.#bringIntoFolder(store, folder, file);
    if (file.size > MAX_FILE_BYTES) {
      this.#messages.tooLarge(file.name);
      return undefined;
    }
    const facts = await probeMedia(file);
    if (!facts) {
      this.#messages.unsupported(file.name);
      return undefined;
    }
    const hash = await hashOf(file);
    const assets = Object.entries(store.getState().assets ?? {});
    const known = assets.filter(
      ([, asset]) => asset.hash !== undefined && isSameHash(asset.hash, hash),
    );
    try {
      if (known.length > 0) {
        await this.#restore(store, known, file);
        return known[0]?.[0];
      }
      await this.#media(store).put(hash, file);
    } catch (error) {
      console.warn("A file could not be saved", error);
      this.#messages.saveFailed(file.name);
      return undefined;
    }
    const id = newId("asset");
    const extension = extensionOf(file.name);
    const asset = {
      name: file.name,
      kind: facts.kind,
      path: `assets/${id}${extension ? `.${extension}` : ""}`,
      storage: "local",
      hash,
      size: file.size,
      info: infoOf(facts),
    };
    const result = store.execute({ type: "asset.add", params: { id, asset } });
    if (result.ok) return id;
    this.#messages.commandFailed(result.error.message);
    return undefined;
  }

  /**
   * A project can know a file that is not here, for example after an import without it. Bringing in
   * that very file is how it gets back, and whatever looked for it has to look again.
   */
  async #restore(
    store: ProjectStore,
    assets: readonly (readonly [string, Asset])[],
    file: File,
  ): Promise<void> {
    const media = this.#media(store);
    for (const [id, { hash }] of assets) {
      if (hash === undefined || (await media.get(hash))) continue;
      await media.put(hash, file);
      this.#dropUrl(id);
      this.#peaks.delete(hash);
      this.#strips.delete(hash);
      this.#restored += 1;
      for (const listener of this.#restoredListeners) listener(hash);
      this.#emitter.emit();
    }
  }

  #media(store: ProjectStore) {
    return this.#projects.media(projectKeyOf(store));
  }

  /**
   * A file from outside into the assets folder of the project, whatever its size: it is written as
   * it is read, and its hash comes with that. It is in the project once all of it is there. A file
   * the project has already is not copied again, and people are asked before a large one is.
   */
  async #bringIntoFolder(
    store: ProjectStore,
    folder: FolderAssets,
    file: File,
  ): Promise<string | undefined> {
    const facts = await probeMedia(file);
    if (!facts) {
      this.#messages.unsupported(file.name);
      return undefined;
    }
    const stopper = new AbortController();
    const { signal } = stopper;
    const show = (stage: Copying["stage"], bytes: number) => {
      const percent = file.size > 0 ? Math.floor((bytes / file.size) * 100) : 100;
      const now = this.#copying;
      if (now?.stage === stage && now.percent === percent && now.name === file.name) return;
      this.#copying = { name: file.name, stage, percent, stop: () => stopper.abort() };
      this.#emitter.emit();
    };
    try {
      // Only a file of a size the project has can be one that it has.
      const sameSize = Object.entries(store.getState().assets ?? {}).filter(
        ([, asset]) => asset.size === file.size && asset.hash !== undefined,
      );
      if (sameSize.length > 0) {
        show("checking", 0);
        const hash = await folder.hashOutside(file, {
          signal,
          onProgress: (bytes) => show("checking", bytes),
        });
        const known = sameSize.find(([, asset]) => isSameHash(asset.hash as string, hash));
        // Only where that very file is still at its path: one put in its place is not it.
        if (known && (await hasItsFile(folder, known[1].path, hash))) return known[0];
      }
      this.#copying = undefined;
      this.#emitter.emit();
      if (
        file.size >= ASK_BEFORE_COPYING_BYTES &&
        !(await this.#messages.confirmCopy(file.name, file.size))
      ) {
        return undefined;
      }
      show("copying", 0);
      const copied = await folder.copyIn(file, {
        signal,
        onProgress: (bytes) => show("copying", bytes),
      });
      // The project closed meanwhile: the copy came for nothing.
      if (this.#session.store !== store) {
        await folder.remove(copied.path, copied.written);
        return undefined;
      }
      const known = Object.entries(store.getState().assets ?? {}).find(
        ([, asset]) => asset.hash !== undefined && isSameHash(asset.hash, copied.hash),
      );
      if (!known) return this.#add(store, file, copied.path, copied.hash, facts);
      // The project has it: the copy goes, unless the file it has is not there any more, or another
      // file took its place, which stays as it is: then the asset gets the copy.
      const [id, asset] = known;
      if (await hasItsFile(folder, asset.path, copied.hash)) {
        await folder.remove(copied.path, copied.written);
        return id;
      }
      const result = store.execute({
        type: "asset.update",
        params: { asset: id, changes: { path: copied.path } },
      });
      if (!result.ok) this.#messages.commandFailed(result.error.message);
      this.filesChanged([copied.path, asset.path]);
      return id;
    } catch (error) {
      if (signal.aborted) return undefined;
      console.warn("A file could not be copied into the project folder", error);
      this.#messages.copyFailed(file.name, failureOf(error));
      return undefined;
    } finally {
      this.#copying = undefined;
      this.#emitter.emit();
    }
  }

  /** Adds a file of the project folder as an asset, once it is all there. */
  #add(
    store: ProjectStore,
    file: File,
    path: string,
    hash: string,
    facts: MediaFacts,
  ): string | undefined {
    const known = Object.entries(store.getState().assets ?? {}).find(
      ([, asset]) => asset.path === path,
    );
    if (known) return known[0];
    const id = newId("asset");
    const asset = {
      name: file.name,
      kind: facts.kind,
      path,
      storage: "local",
      hash,
      size: file.size,
      info: infoOf(facts),
    };
    const result = store.execute({ type: "asset.add", params: { id, asset } });
    if (result.ok) return id;
    this.#messages.commandFailed(result.error.message);
    return undefined;
  }

  /**
   * The file of an asset in the project folder is another one now, as when people replaced it
   * outside: the project takes it as it is, and what was made of the old one is made again.
   */
  async useNewFile(assetId: string): Promise<boolean> {
    const store = this.#store;
    const folder = this.#folder();
    const asset = store?.getState().assets?.[assetId];
    if (!store || !folder || !asset) return false;
    const name = asset.name ?? asset.path;
    const found = await folder.fileAt(asset.path);
    if (found.kind !== "there") {
      this.#messages.readFailed(asset.path);
      return false;
    }
    const facts = await probeMedia(found.file);
    if (!facts) {
      this.#messages.unsupported(name);
      return false;
    }
    // Clips of a video cannot play a sound file in its place.
    if (facts.kind !== asset.kind) {
      this.#messages.otherKind(name);
      return false;
    }
    const result = store.execute({
      type: "asset.update",
      params: {
        asset: assetId,
        changes: { hash: found.hash, size: found.file.size, info: infoOf(facts) },
      },
    });
    if (!result.ok) {
      this.#messages.commandFailed(result.error.message);
      return false;
    }
    this.filesChanged([asset.path]);
    return true;
  }

  /** The file of an asset is at another path of the project folder now: the asset goes there. */
  async usePlace(assetId: string, path: string): Promise<boolean> {
    const store = this.#store;
    const folder = this.#folder();
    const asset = store?.getState().assets?.[assetId];
    if (!store || !folder || !asset?.hash) return false;
    const found = await folder.fileAt(path);
    if (found.kind !== "there" || !isSameHash(found.hash, asset.hash)) {
      this.#messages.readFailed(path);
      return false;
    }
    const result = store.execute({
      type: "asset.update",
      params: { asset: assetId, changes: { path } },
    });
    if (!result.ok) {
      this.#messages.commandFailed(result.error.message);
      return false;
    }
    this.filesChanged([path]);
    return true;
  }

  /**
   * Files of assets changed on the disk, by path, as a project folder tells: whatever has them has
   * to get them again, see `onRestored`, and what could not be made of them before gets another go.
   */
  filesChanged(paths: readonly string[]): void {
    const store = this.#store;
    if (!store) return;
    const changed = new Set(paths);
    const hashes = new Set<string>();
    for (const [id, asset] of Object.entries(store.getState().assets ?? {})) {
      if (!changed.has(asset.path)) continue;
      this.#dropUrl(id);
      const { hash } = asset;
      if (hash === undefined) continue;
      hashes.add(hash);
      // What was made of the file stays: it is the same content, by its hash.
      if (this.#peaks.has(hash) && this.#peaks.get(hash) === undefined) this.#peaks.delete(hash);
      if (this.#strips.has(hash) && this.#strips.get(hash) === undefined) this.#strips.delete(hash);
    }
    if (hashes.size === 0) return;
    this.#restored += 1;
    for (const hash of hashes) for (const listener of this.#restoredListeners) listener(hash);
    this.#emitter.emit();
  }

  #dropUrl(assetId: string): void {
    const cached = this.#urls.get(assetId);
    if (!cached) return;
    this.#urls.delete(assetId);
    void cached.url.then((value) => value && URL.revokeObjectURL(value));
  }

  /** Something an image element can show, or undefined when the file is not in this browser. */
  urlOf(assetId: string): Promise<string | undefined> {
    const asset = this.#session.store?.getState().assets?.[assetId];
    const key = `${asset?.hash ?? ""}\n${asset?.path ?? ""}`;
    const cached = this.#urls.get(assetId);
    if (cached?.key === key) return cached.url;
    this.#dropUrl(assetId);
    const url = this.#load(assetId);
    this.#urls.set(assetId, { key, url });
    return url;
  }

  async #load(assetId: string): Promise<string | undefined> {
    const store = this.#session.store;
    const hash = store?.getState().assets?.[assetId]?.hash;
    if (!store || !hash) return undefined;
    const file = await this.#media(store).get(hash);
    return file && URL.createObjectURL(file);
  }
}
