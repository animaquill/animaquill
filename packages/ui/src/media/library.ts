import type { ProjectStore } from "@animaquill/core";
import type { ProjectLibrary } from "@animaquill/host";
import { probeMedia, type MediaFacts } from "@animaquill/media";
import { fromSeconds, formatTime, newId, type Asset } from "@animaquill/schema";
import { Emitter } from "../workbench/emitter.ts";
import type { ProjectSession } from "../workbench/session.ts";

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
  #store: ProjectStore | undefined;
  #importing = 0;

  constructor(session: ProjectSession, projects: ProjectLibrary, messages: MediaMessages) {
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
