import type { CoverAccess, CoverStore, ProjectCover } from "@animaquill/host";
import { Emitter } from "../workbench/emitter.ts";
import { cloudMarksKey, type ProjectCard } from "./cards.ts";

/**
 * The covers on the cards of the start page, see the design of the start page
 * (docs/design/start-and-cloud.md of AnimaQuill Cloud), 6.4: the one this browser keeps of a project
 * it opened (`Host.covers`, by what it keeps the project by), or the platform's, where that is newer,
 * as made on another computer, or the project was never opened here. One of the platform is fetched
 * once for each etag its list says, and kept in this browser by `cloud:` and its id, see
 * `cloudMarksKey`. Without either a card shows a colour and a letter.
 */

export interface CardCover {
  /** An address of the picture for an `<img>`, or undefined where there is none. */
  readonly url: string | undefined;
  /** How long the main timeline is, in milliseconds, where that is known. */
  readonly durationMs: number | undefined;
  /** People chose the picture themselves, see `ProjectCover.chosen`. */
  readonly chosen: boolean;
}

/** Addresses of pictures: object URLs in a browser. */
export interface PictureUrls {
  create(picture: Blob): string;
  revoke(url: string): void;
}

export interface StartCoversOptions {
  readonly covers?: CoverStore;
  /** The covers of the platform, where the editor is hosted on one. */
  readonly cloud?: Pick<CoverAccess, "get">;
  readonly urls?: PictureUrls;
  /** How many covers are fetched from the platform at once. */
  readonly parallel?: number;
}

const objectUrls: PictureUrls = {
  create: (picture) => URL.createObjectURL(picture),
  revoke: (url) => URL.revokeObjectURL(url),
};

const NONE: ReadonlyMap<string, CardCover> = new Map();

interface Wanted {
  readonly project: string;
  readonly etag: string;
  readonly at: number;
  readonly chosen?: true;
  readonly durationMs: number | undefined;
}

export class StartCovers {
  readonly #options: StartCoversOptions;
  readonly #urls: PictureUrls;
  readonly #emitter = new Emitter();
  #snapshot: ReadonlyMap<string, CardCover> = NONE;
  #cards: readonly ProjectCard[] = [];
  /** What this browser keeps, by its key, as last read; also what was fetched where it keeps none. */
  readonly #kept = new Map<string, ProjectCover>();
  /** Keys that were read, whether there was a cover or not. */
  readonly #read = new Set<string>();
  /** Keys whose cover changed since they were read. */
  readonly #stale = new Set<string>();
  /** Keys whose cover people chose is going back to the editor's, see `#unchoose`. */
  readonly #unchoosing = new Set<string>();
  /** An address for each picture shown, by the key it is kept by. */
  readonly #shown = new Map<string, { readonly cover: ProjectCover; readonly url: string }>();
  /** What is to be fetched from the platform, in the order of the cards. */
  #queue: Wanted[] = [];
  /** Fetched, being fetched, or not there: by project and etag, never asked for again. */
  readonly #asked = new Set<string>();
  #fetching = 0;
  /** When the list the cards say the platform's covers from came. */
  #listedAt: number | undefined;
  /** Only the covers of cards people see are fetched, see `show`. */
  #onlySeen = false;
  readonly #seen = new Set<string>();
  #reading: Promise<void> | undefined;
  #closed = false;
  readonly #stop: () => void;

  constructor(options: StartCoversOptions) {
    this.#options = options;
    this.#urls = options.urls ?? objectUrls;
    // A cover made in a window, also as people left a project in this one.
    this.#stop =
      options.covers?.listen((key) => {
        this.#stale.add(key);
        void this.#readKept();
      }) ?? (() => {});
  }

  subscribe = this.#emitter.subscribe;
  /** By the id of each card, see `ProjectCard.id`. */
  getSnapshot = (): ReadonlyMap<string, CardCover> => this.#snapshot;

  /**
   * The cards there are now: their covers are read, and fetched where they have to be. With
   * `onlySeen`, only for the cards people can see, as `seen` says: of hundreds of projects, those
   * on the screen, and the others once they are scrolled to.
   */
  show(
    cards: readonly ProjectCard[],
    {
      onlySeen = false,
      listedAt,
    }: {
      readonly onlySeen?: boolean;
      /** When the platform's list the cards say its covers from came, see `StartListSnapshot`. */
      readonly listedAt?: number | undefined;
    } = {},
  ): void {
    if (this.#closed) return;
    this.#cards = cards;
    this.#onlySeen = onlySeen;
    this.#listedAt = listedAt;
    this.#compose();
    void this.#readKept();
  }

  /** Whether people can see the card `id` now, or are about to. */
  seen(id: string, isSeen: boolean): void {
    if (isSeen === this.#seen.has(id)) return;
    if (isSeen) this.#seen.add(id);
    else this.#seen.delete(id);
    if (isSeen && this.#onlySeen && !this.#closed) this.#compose();
  }

  close(): void {
    this.#closed = true;
    this.#stop();
    for (const { url } of this.#shown.values()) this.#urls.revoke(url);
    this.#shown.clear();
    this.#queue = [];
  }

  /** Reads what this browser keeps for the cards that were not read yet, one read at a time. */
  async #readKept(): Promise<void> {
    if (this.#reading) {
      await this.#reading;
      if (this.#keysToRead().length > 0) return this.#readKept();
      return;
    }
    const keys = this.#keysToRead();
    const { covers } = this.#options;
    if (keys.length === 0 || !covers) return;
    for (const key of keys) this.#stale.delete(key);
    this.#reading = (async () => {
      try {
        const found = await covers.read(keys);
        for (const key of keys) {
          const cover = found.get(key);
          const before = this.#kept.get(key);
          // The same as before keeps its address, and the picture does not flicker.
          if (cover && !isSame(cover, before)) this.#kept.set(key, cover);
          // Fetched here, and could not be kept: what was fetched stays.
          else if (!cover && !key.startsWith("cloud:")) this.#kept.delete(key);
        }
      } catch (error) {
        console.warn("The covers of projects could not be read", error);
      }
      // Also where it failed: the platform's covers are fetched all the same.
      for (const key of keys) this.#read.add(key);
    })();
    await this.#reading;
    this.#reading = undefined;
    if (!this.#closed) this.#compose();
  }

  #keysToRead(): string[] {
    const keys = new Set<string>();
    for (const card of this.#cards) {
      if (card.key !== undefined) keys.add(card.key);
      if (card.project !== undefined) keys.add(cloudMarksKey(card.project));
    }
    return [...keys].filter((key) => !this.#read.has(key) || this.#stale.has(key));
  }

  /** What each card shows, and what has to be fetched for it. */
  #compose(): void {
    const next = new Map<string, CardCover>();
    const used = new Set<string>();
    const wanted: Wanted[] = [];
    for (const card of this.#cards) {
      const theirsKey = card.project === undefined ? undefined : cloudMarksKey(card.project);
      // What this browser has of the project: by its key, or for one never opened here, what was
      // fetched of it or chosen for it here.
      const ownKey = card.key ?? theirsKey;
      const kept = ownKey === undefined ? undefined : this.#kept.get(ownKey);
      const theirs = theirsKey === undefined ? undefined : this.#kept.get(theirsKey);
      const listed = card.cover;
      // One people chose here, which the platform had and has no longer, as a list read after it
      // got it says: they went back to the one the editor makes on another computer.
      const undone =
        kept?.chosen === true &&
        kept.sent === kept.etag &&
        kept.sentAt !== undefined &&
        this.#listedAt !== undefined &&
        this.#listedAt > kept.sentAt &&
        listed !== undefined &&
        listed?.etag !== kept.etag &&
        listed?.chosen !== true;
      if (undone && ownKey !== undefined) this.#unchoose(ownKey, kept);
      const own = undone ? autoOf(kept) : kept;
      let shown: { readonly key: string; readonly cover: ProjectCover } | undefined =
        own && ownKey !== undefined ? { key: ownKey, cover: own } : undefined;
      let durationMs = own?.durationMs ?? card.durationMs;
      if (
        listed &&
        theirsKey !== undefined &&
        card.project !== undefined &&
        isBetter(listed, own)
      ) {
        // The platform's is another one, and comes first: made on another computer, or here first.
        durationMs = card.durationMs ?? durationMs;
        if (theirs?.etag === listed.etag) shown = { key: theirsKey, cover: theirs };
        else {
          const ready = this.#read.has(theirsKey) || !this.#options.covers;
          const isSeen = !this.#onlySeen || this.#seen.has(card.id);
          if (ready && isSeen && !this.#asked.has(`${card.project}:${listed.etag}`))
            wanted.push({
              project: card.project,
              ...listed,
              durationMs: card.durationMs,
            });
          // Meanwhile the older one, where there is one.
          shown ??= theirs && { key: theirsKey, cover: theirs };
        }
      } else if (!shown && theirs && theirsKey !== undefined && listed === undefined) {
        // The list cannot be read now: what was fetched before.
        shown = { key: theirsKey, cover: theirs };
        durationMs = theirs.durationMs ?? durationMs;
      }
      if (shown) used.add(shown.key);
      next.set(card.id, {
        url: shown && this.#urlOf(shown.key, shown.cover),
        durationMs,
        chosen: shown?.cover.chosen === true,
      });
    }
    // Pictures no card shows any more.
    for (const [key, { url }] of this.#shown) {
      if (used.has(key)) continue;
      this.#urls.revoke(url);
      this.#shown.delete(key);
    }
    this.#queue = wanted;
    if (!sameCovers(this.#snapshot, next)) {
      this.#snapshot = next;
      this.#emitter.emit();
    }
    this.#pump();
  }

  /**
   * Keeps what people chose elsewhere: the one the editor made here, or none, in place of the one
   * they chose here before, while that is still what is kept.
   */
  #unchoose(key: string, chosen: ProjectCover): void {
    const { covers } = this.#options;
    if (!covers || this.#unchoosing.has(key)) return;
    this.#unchoosing.add(key);
    void (async () => {
      const now = (await covers.read([key])).get(key);
      if (now?.chosen !== true || now.etag !== chosen.etag) return;
      const auto = autoOf(now);
      await (auto ? covers.put(key, auto) : covers.forget(key));
    })()
      .catch((error: unknown) => console.warn("A cover could not be kept", error))
      .finally(() => this.#unchoosing.delete(key));
  }

  #urlOf(key: string, cover: ProjectCover): string {
    const shown = this.#shown.get(key);
    // The same etag is the same picture, whatever else was kept with it.
    if (shown?.cover.etag === cover.etag) return shown.url;
    if (shown) this.#urls.revoke(shown.url);
    const url = this.#urls.create(cover.picture);
    this.#shown.set(key, { cover, url });
    return url;
  }

  /** Fetches what the cards want, in their order, a few at a time. */
  #pump(): void {
    const { cloud } = this.#options;
    if (!cloud) return;
    const limit = this.#options.parallel ?? 4;
    while (this.#fetching < limit && !this.#closed) {
      const next = this.#queue.shift();
      if (!next) return;
      const asked = `${next.project}:${next.etag}`;
      if (this.#asked.has(asked)) continue;
      this.#asked.add(asked);
      this.#fetching += 1;
      void this.#fetch(cloud, next).finally(() => {
        this.#fetching -= 1;
        if (!this.#closed) this.#pump();
      });
    }
  }

  async #fetch(cloud: Pick<CoverAccess, "get">, wanted: Wanted): Promise<void> {
    let picture: Blob | undefined;
    try {
      picture = await cloud.get(wanted.project);
    } catch (error) {
      console.warn("A cover could not be fetched", error);
    }
    if (!picture || this.#closed) return;
    const key = cloudMarksKey(wanted.project);
    const cover: ProjectCover = {
      picture,
      at: wanted.at,
      etag: wanted.etag,
      ...(wanted.durationMs !== undefined && { durationMs: wanted.durationMs }),
      ...(wanted.chosen && { chosen: true as const }),
      // The platform has it: where a later list says it no longer does, see `#compose`.
      sent: wanted.etag,
      sentAt: Date.now(),
    };
    this.#kept.set(key, cover);
    this.#compose();
    // Kept for the next time: what the store says of it after that is read again.
    await this.#options.covers?.put(key, cover).catch((error: unknown) => {
      console.warn("A cover could not be kept", error);
    });
  }
}

/** The one the editor made of a project whose cover people chose, as a cover of its own. */
export function autoOf(cover: ProjectCover): ProjectCover | undefined {
  const { auto, chosen: _chosen, sent: _sent, ...rest } = cover;
  return auto && { ...rest, picture: auto.picture, at: auto.at, etag: auto.etag };
}

/**
 * Whether the platform's cover comes before the one kept here: it is another one, and there is
 * none here, or people chose it and not this one, or it is newer and both are of the same kind.
 */
const isBetter = (
  listed: { readonly etag: string; readonly at: number; readonly chosen?: true },
  own: ProjectCover | undefined,
) => {
  if (!own) return true;
  if (listed.etag === own.etag) return false;
  const theirs = listed.chosen === true;
  const mine = own.chosen === true;
  return theirs === mine ? listed.at > own.at : theirs;
};

const isSame = (a: ProjectCover, b: ProjectCover | undefined) =>
  b !== undefined &&
  a.etag === b.etag &&
  a.at === b.at &&
  a.durationMs === b.durationMs &&
  a.chosen === b.chosen &&
  a.sent === b.sent &&
  a.auto?.etag === b.auto?.etag;

function sameCovers(a: ReadonlyMap<string, CardCover>, b: ReadonlyMap<string, CardCover>) {
  if (a.size !== b.size) return false;
  for (const [id, cover] of a) {
    const other = b.get(id);
    if (
      !other ||
      other.url !== cover.url ||
      other.durationMs !== cover.durationMs ||
      other.chosen !== cover.chosen
    )
      return false;
  }
  return true;
}
