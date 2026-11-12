import { timelineLength, type ProjectState, type ProjectStore } from "@animaquill/core";
import {
  COVER_BYTES,
  coverEtag,
  type CoverAccess,
  type CoverStore,
  type ProjectCover,
} from "@animaquill/host";
import { toSeconds } from "@animaquill/schema";

/**
 * The cover of a project for its card on the start page, see the design of the start page
 * (docs/design/start-and-cloud.md of AnimaQuill Cloud), 6.4, and its plan, 8.2. The editor makes
 * one while people leave it alone: a frame of the main timeline, as the still export draws it, made
 * small, kept in this browser (`Host.covers`) and, for a project of the platform, sent there too
 * (`CloudAccess.cover`). It never gets in the way: not while the preview plays, an export runs, a
 * dialog is open or the page is in the background; not in the project, its undo or its changes;
 * and when it fails nobody hears of it.
 */

export interface CoverTiming {
  /** How long the project has to stay as it is before a cover is made of it. */
  readonly idleMs: number;
  /** A project gets a cover once in this long at most. */
  readonly everyMs: number;
  /** When something else needs the computer, how long until it is asked again. */
  readonly retryMs: number;
  /** How long a picture may take before it is given up on. */
  readonly pictureMs: number;
}

export const COVER_TIMING: CoverTiming = {
  idleMs: 30_000,
  everyMs: 5 * 60_000,
  retryMs: 15_000,
  pictureMs: 60_000,
};

/** The longer side of a cover, in pixels: sharp on a card, and a few dozen kilobytes. */
export const COVER_SIDE = 480;
/** The qualities a cover is tried at, until it is small enough, see `COVER_BYTES`. */
export const COVER_QUALITIES: readonly number[] = [0.75, 0.6, 0.45, 0.3];
/** WebP where the browser makes it, JPEG where not, as Safari: the platform takes both. */
const COVER_TYPES = ["image/webp", "image/jpeg"] as const;

/** How large a cover of a picture of `width` × `height` is: its longer side `COVER_SIDE`. */
export function coverSize(width: number, height: number): { width: number; height: number } {
  const scale = Math.min(1, COVER_SIDE / Math.max(width, height, 1));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** A picture made small, to be encoded at a type and a quality. */
export type CoverEncoder = (type: string, quality: number) => Promise<Blob>;

/**
 * The cover of a picture: the first type the browser makes, at the best quality that is small
 * enough. Undefined where none is, and the project gets no cover this time.
 */
export async function encodeCover(encode: CoverEncoder): Promise<Blob | undefined> {
  for (const type of COVER_TYPES) {
    for (const quality of COVER_QUALITIES) {
      const blob = await encode(type, quality);
      // The browser does not make this type, and makes a PNG instead.
      if (blob.type !== type) break;
      if (blob.size <= COVER_BYTES) return blob;
    }
  }
  return undefined;
}

/** In the browser: drawn small on a canvas of its own. The picture stays whoever's it was. */
export function canvasEncoder(image: ImageBitmap): CoverEncoder {
  const { width, height } = coverSize(image.width, image.height);
  const canvas = new OffscreenCanvas(width, height);
  const painter = canvas.getContext("2d");
  if (!painter) throw new Error("No 2D context");
  painter.imageSmoothingQuality = "high";
  painter.drawImage(image, 0, 0, width, height);
  return (type, quality) => canvas.convertToBlob({ type, quality });
}

/** What a cover is made of: a moment of a timeline of the project as it was. */
export interface CoverShot {
  readonly state: ProjectState;
  /** What this browser keeps the project by. */
  readonly key: string;
  readonly timeline: string;
  readonly seconds: number;
}

/**
 * The moment of the main timeline a cover shows, and how long that timeline is: one second in,
 * past a fade from black, or the middle of a shorter one, see the plan, 8.2. Undefined for a
 * project without a timeline.
 */
export function coverShotOf(
  state: ProjectState,
  key: string,
): (CoverShot & { readonly durationMs: number }) | undefined {
  const timeline = state.manifest.timelines?.find((name) => state.timelines[name]);
  const main = timeline === undefined ? undefined : state.timelines[timeline];
  if (timeline === undefined || !main) return undefined;
  const length = toSeconds(timelineLength(main));
  return {
    state,
    key,
    timeline,
    seconds: length >= 1 ? 1 : length / 2,
    durationMs: Math.round(length * 1000),
  };
}

/** What the project is, as versions of it are told apart: the same anywhere it is the same. */
export async function versionOf(store: Pick<ProjectStore, "stateVector" | "deletions">) {
  const vector = store.stateVector();
  const deletions = store.deletions();
  const both = new Uint8Array(vector.length + deletions.length);
  both.set(vector);
  both.set(deletions, vector.length);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", both));
  return [...digest.subarray(0, 16)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

// ---- sending covers to the platform

export interface CoverUploadsOptions {
  readonly covers: CoverStore;
  readonly cloud: Pick<CoverAccess, "put">;
  /** How long until the same project is sent again: the platform takes one a minute. */
  readonly everyMs?: number;
  readonly now?: () => number;
}

/**
 * Sends the covers of projects of the platform there, for the start page on other computers: the
 * one kept in this browser, once a minute at most for a project, and never one the platform took
 * from here already (`ProjectCover.sent`). For as long as the page is open; a cover that did not
 * get there is sent the next time the project opens. Nobody hears of it when it fails.
 */
export class CoverUploads {
  readonly #options: CoverUploadsOptions;
  /** What waits to be sent, by the key the browser keeps it by: the project of the platform. */
  readonly #waiting = new Map<string, { project: string; timer?: ReturnType<typeof setTimeout> }>();
  readonly #sending = new Set<string>();
  /** When each project of the platform was last sent. */
  readonly #last = new Map<string, number>();
  #closed = false;

  constructor(options: CoverUploadsOptions) {
    this.#options = options;
  }

  get #now(): number {
    return (this.#options.now ?? Date.now)();
  }

  get #everyMs(): number {
    return this.#options.everyMs ?? 60_000;
  }

  /** Sends the cover kept by `key` to the project `project` of the platform, when it may. */
  offer(key: string, project: string): void {
    if (this.#closed) return;
    const waiting = this.#waiting.get(key);
    if (waiting) {
      waiting.project = project;
      return;
    }
    this.#later(key, project, (this.#last.get(project) ?? -Infinity) + this.#everyMs - this.#now);
  }

  close(): void {
    this.#closed = true;
    for (const { timer } of this.#waiting.values()) clearTimeout(timer);
    this.#waiting.clear();
  }

  #later(key: string, project: string, ms: number): void {
    const waiting: { project: string; timer?: ReturnType<typeof setTimeout> } = { project };
    this.#waiting.set(key, waiting);
    waiting.timer = setTimeout(() => void this.#send(key), Math.max(0, ms));
  }

  async #send(key: string): Promise<void> {
    const waiting = this.#waiting.get(key);
    if (!waiting || this.#closed) return;
    // One at a time for a key: the next waits for this one.
    if (this.#sending.has(key)) {
      this.#later(key, waiting.project, this.#everyMs);
      return;
    }
    this.#waiting.delete(key);
    const { project } = waiting;
    const { covers, cloud } = this.#options;
    this.#sending.add(key);
    try {
      const cover = (await covers.read([key])).get(key);
      if (!cover || cover.sent === cover.etag) return;
      this.#last.set(project, this.#now);
      const put = await cloud.put(project, cover.picture, cover.durationMs);
      if (put.kind === "kept") await covers.sent(key, cover.etag);
      else if (put.kind === "busy" && !this.#waiting.has(key) && !this.#closed)
        this.#later(key, project, put.retryAfterMs);
      // "missing": not a project of whoever is signed in; "refused": never will be. Both stay here.
    } catch (error) {
      // Offline, or nobody is signed in: the next cover, or the next time it opens.
      console.warn("A cover could not be sent", error);
    } finally {
      this.#sending.delete(key);
    }
  }
}

// ---- making covers of the open project

export interface CoverMakerOptions {
  /** The open project, and what this browser keeps it by. */
  readonly session: {
    readonly store: ProjectStore | undefined;
    readonly key: string | undefined;
    subscribe(listener: () => void): () => void;
  };
  readonly covers: CoverStore;
  /**
   * The picture of a moment, as the still export draws it. It has to take what it needs of the
   * project before it first waits: the project may be closed by then.
   */
  readonly picture: (shot: CoverShot, signal: AbortSignal) => Promise<ImageBitmap>;
  /** Makes a cover of a picture, see `encodeCover`. */
  readonly encode?: (image: ImageBitmap) => Promise<Blob | undefined>;
  /** Whether people need the computer for something else now: playing, an export, a dialog. */
  readonly isBusy: () => boolean;
  /** Whether a cover may be made as people leave the project: not while an export runs. */
  readonly mayLeave?: () => boolean;
  /**
   * The project of the platform the open project is, where its cover goes there too: undefined for
   * any other, and one that cannot be edited now, as its repository cannot be used.
   */
  readonly sendTo?: () => string | undefined;
  readonly uploads?: CoverUploads;
  readonly timing?: Partial<CoverTiming>;
  readonly now?: () => number;
}

interface Open {
  readonly store: ProjectStore;
  readonly key: string;
  /** How many times the project changed while it was open here. */
  changes: number;
  /** Which of those the kept cover shows: -1 where that is not known, or none. */
  shows: number;
  /** When its cover was last made, as far as this window knows. */
  lastAt: number;
  /** Its cover was looked at. */
  isLooked: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
  stop: () => void;
}

const isYield = (error: unknown) => error instanceof DOMException && error.name === "AbortError";

const defaultEncode = (image: ImageBitmap) => encodeCover(canvasEncoder(image));

export class CoverMaker {
  readonly #options: CoverMakerOptions;
  readonly #timing: CoverTiming;
  #open: Open | undefined;
  /** One picture at a time, whatever it is of. */
  #making = false;
  /** Stops the picture being made, see `yieldNow`. */
  #stopping: AbortController | undefined;
  readonly #stop: () => void;

  constructor(options: CoverMakerOptions) {
    this.#options = options;
    this.#timing = { ...COVER_TIMING, ...options.timing };
    this.#stop = options.session.subscribe(this.#follow);
    this.#follow();
  }

  get #now(): number {
    return (this.#options.now ?? Date.now)();
  }

  close(): void {
    this.#stop();
    this.#let();
  }

  /**
   * People leave the open project: where it changed since its cover was made, a cover is made of
   * it as it is now. Nothing waits for it, and where it cannot be made, it is not.
   */
  leaving(): void {
    const open = this.#open;
    if (!open || open.shows === open.changes || this.#making) return;
    // Nothing is known of its cover yet, and nothing changed: the next time it opens.
    if (!open.isLooked && open.changes === 0) return;
    if (this.#options.mayLeave && !this.#options.mayLeave()) return;
    clearTimeout(open.timer);
    open.timer = undefined;
    void this.#make(open);
  }

  /**
   * Something else needs the computer now, as an export that begins: a picture being made stops at
   * once, and is made again later.
   */
  yieldNow(): void {
    this.#stopping?.abort(new DOMException("Something else needs the computer", "AbortError"));
  }

  /**
   * The open project may have become one of the platform, as its link was read: a cover of it that
   * did not get there yet goes now.
   */
  offerToPlatform(): void {
    if (this.#open?.isLooked) this.#send(this.#open.key);
  }

  #follow = (): void => {
    const { store, key } = this.#options.session;
    if (store === this.#open?.store) return;
    this.#let();
    if (!store || key === undefined) return;
    const open: Open = {
      store,
      key,
      changes: 0,
      shows: -1,
      lastAt: -Infinity,
      isLooked: false,
      timer: undefined,
      stop: () => {},
    };
    open.stop = store.subscribe(() => {
      open.changes += 1;
      this.#schedule(open, this.#timing.idleMs);
    });
    this.#open = open;
    void this.#look(open);
  };

  #let(): void {
    const open = this.#open;
    if (!open) return;
    this.#open = undefined;
    open.stop();
    clearTimeout(open.timer);
  }

  /** What is kept of the cover of a project that opened: whether it shows it as it is. */
  async #look(open: Open): Promise<void> {
    const changes = open.changes;
    try {
      const [kept, version] = await Promise.all([
        this.#options.covers.read([open.key]).then((found) => found.get(open.key)),
        versionOf(open.store),
      ]);
      if (kept) open.lastAt = Math.max(open.lastAt, kept.at);
      if (kept?.made === version && open.changes === changes) open.shows = changes;
      // One that did not get to the platform before goes now.
      if (kept && kept.sent !== kept.etag) this.#send(open.key);
    } catch (error) {
      console.warn("The cover of the project could not be read", error);
    }
    open.isLooked = true;
    if (this.#open === open && open.shows !== open.changes)
      this.#schedule(open, this.#timing.idleMs);
  }

  #schedule(open: Open, ms: number): void {
    if (this.#open !== open) return;
    clearTimeout(open.timer);
    const at = Math.max(this.#now + ms, open.lastAt + this.#timing.everyMs);
    open.timer = setTimeout(() => this.#attempt(open), at - this.#now);
  }

  #attempt(open: Open): void {
    open.timer = undefined;
    if (this.#open !== open || open.shows === open.changes || !open.isLooked) return;
    if (this.#making || this.#options.isBusy()) {
      this.#schedule(open, this.#timing.retryMs);
      return;
    }
    void this.#make(open);
  }

  #send(key: string): void {
    const project = this.#options.sendTo?.();
    if (project !== undefined) this.#options.uploads?.offer(key, project);
  }

  async #make(open: Open): Promise<void> {
    const { covers } = this.#options;
    const changes = open.changes;
    const shot = coverShotOf(open.store.getState(), open.key);
    if (!shot) return;
    const project = this.#options.sendTo?.();
    this.#making = true;
    const lastAt = open.lastAt;
    open.lastAt = this.#now;
    const stopping = new AbortController();
    this.#stopping = stopping;
    const { signal } = stopping;
    try {
      // The picture first: it takes what it needs before the project may be closed, and so does
      // what tells this version of it apart.
      const timer = setTimeout(
        () => stopping.abort(new Error("The cover took too long")),
        this.#timing.pictureMs,
      );
      const picturing = this.#options.picture(shot, signal);
      const version = versionOf(open.store);
      // Not heard of where the picture failed first.
      version.catch(() => {});
      let picture: Blob | undefined;
      // Over when it is stopped, whatever the picture does about it.
      const stopped = new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
      stopped.catch(() => {});
      // A picture that comes after it was stopped is nobody's.
      picturing.then(
        (late) => signal.aborted && late.close(),
        () => {},
      );
      const image = await Promise.race([picturing, stopped]).finally(() => clearTimeout(timer));
      signal.throwIfAborted();
      try {
        picture = await (this.#options.encode ?? defaultEncode)(image);
      } finally {
        image.close();
      }
      if (!picture) return;
      const [etag, made, before] = await Promise.all([
        coverEtag(picture),
        version,
        covers.read([open.key]).then((found) => found.get(open.key)),
      ]);
      const cover: ProjectCover = {
        // The same picture as before stays the one that was sent.
        picture: before?.etag === etag ? before.picture : picture,
        at: this.#now,
        etag,
        durationMs: shot.durationMs,
        made,
        ...(before?.sent !== undefined && { sent: before.sent }),
      };
      await covers.put(open.key, cover);
      if (open.shows < changes) open.shows = changes;
      if (project !== undefined) this.#options.uploads?.offer(open.key, project);
    } catch (error) {
      // What gave way to something else is made again: not five minutes later for that.
      if (isYield(error)) open.lastAt = lastAt;
      else console.warn("No cover of the project", error);
    } finally {
      this.#making = false;
      if (this.#stopping === stopping) this.#stopping = undefined;
    }
    // It changed while the picture was made.
    if (this.#open === open && open.shows !== open.changes)
      this.#schedule(open, this.#timing.idleMs);
  }
}
