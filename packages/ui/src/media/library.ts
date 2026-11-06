import { computePeaks, readSound } from "@animaquill/audio";
import type { ClipState, ProjectStore } from "@animaquill/core";
import type { ProjectLibrary } from "@animaquill/host";
import { probeMedia, type MediaFacts } from "@animaquill/media";
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
import type { ProjectSession } from "../workbench/session.ts";

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
}

async function hashOf(file: Blob): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  const text = String.fromCharCode(...new Uint8Array(digest));
  return `sha256-${btoa(text).replaceAll("+", "-").replaceAll("/", "_")}`;
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
  readonly #urls = new Map<string, Promise<string | undefined>>();
  /** By file. Undefined means it is on its way or there is nothing to show. */
  readonly #peaks = new Map<string, Uint8Array | undefined>();
  /** One at a time, because decoding takes the whole file. */
  #peaksQueue: Promise<void> = Promise.resolve();
  readonly #strips = new Map<string, FilmStrip | undefined>();
  #stripsQueue: Promise<void> = Promise.resolve();
  readonly #stripMaker: StripMaker;
  #store: ProjectStore | undefined;
  #importing = 0;

  constructor(
    session: ProjectSession,
    projects: ProjectLibrary,
    messages: MediaMessages,
    compositorUrl: string,
  ) {
    this.#stripMaker = new StripMaker(compositorUrl);
    this.#session = session;
    this.#projects = projects;
    this.#messages = messages;
    session.subscribe(() => this.#followSession());
  }

  subscribe = this.#emitter.subscribe;
  /** How many files are on their way in. */
  getImporting = (): number => this.#importing;

  #followSession(): void {
    if (this.#session.store === this.#store) return;
    this.#store = this.#session.store;
    for (const url of this.#urls.values()) {
      void url.then((value) => value && URL.revokeObjectURL(value));
    }
    this.#urls.clear();
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

  /** The waveform of a clip. It shows up later when it has to be worked out first. */
  peaksOf(clip: ClipState): Uint8Array | undefined {
    const { media } = clip.source as { media?: { asset?: string } };
    const store = this.#store;
    const asset = media?.asset === undefined ? undefined : store?.getState().assets?.[media.asset];
    const hash = asset?.hash;
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

  /** One at a time, because each one is read into memory. A file that fails does not stop others. */
  async importFiles(files: readonly File[]): Promise<readonly string[]> {
    const ids: string[] = [];
    this.#setImporting(this.#importing + files.length);
    for (const file of files) {
      const id = await this.#importFile(file);
      if (id !== undefined) ids.push(id);
      this.#setImporting(this.#importing - 1);
    }
    return ids;
  }

  #setImporting(count: number): void {
    this.#importing = count;
    this.#emitter.emit();
  }

  async #importFile(file: File): Promise<string | undefined> {
    const store = this.#session.store;
    if (!store) return undefined;
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
    const known = assets.find(([, asset]) => asset.hash === hash)?.[0];
    if (known !== undefined) return known;
    try {
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
    return result.ok ? id : undefined;
  }

  #media(store: ProjectStore) {
    return this.#projects.media(store.getState().manifest.id);
  }

  /** Something an image element can show, or undefined when the file is not in this browser. */
  urlOf(assetId: string): Promise<string | undefined> {
    const cached = this.#urls.get(assetId);
    if (cached) return cached;
    const url = this.#load(assetId);
    this.#urls.set(assetId, url);
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
