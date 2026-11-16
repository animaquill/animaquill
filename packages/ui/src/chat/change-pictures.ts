import type { StillFailure } from "@animaquill/render";
import type { PictureSide, PicturesAnswer, PicturesRequest } from "../look/looks.ts";

/**
 * The pictures before and after a change that the card of a task shows (S-D1): rendered when a
 * line opens, and kept in memory only, by what they are of and the revision of the project, for
 * as long as they are among the last few looked at. Nothing goes to the conversation, the disk or
 * AI.
 */

/** A picture by its address, for as long as it is kept, or why there is none. */
export type ShownPicture =
  | { readonly ok: true; readonly url: string; readonly width: number; readonly height: number }
  | { readonly ok: false; readonly failure: StillFailure };

export interface ShownPictures {
  readonly before: ShownPicture;
  readonly after: ShownPicture;
}

export interface PictureMaker {
  pictures(request: PicturesRequest): Promise<PicturesAnswer>;
}

/** How many pairs stay: a few lines open at a time. */
const MOST_KEPT = 24;

export class ChangePictures {
  readonly #maker: PictureMaker;
  readonly #kept = new Map<string, Promise<ShownPictures>>();

  constructor(maker: PictureMaker) {
    this.#maker = maker;
  }

  /** The pictures by `key`, rendered as `request` says when they are not kept already. */
  get(key: string, request: () => PicturesRequest): Promise<ShownPictures> {
    const known = this.#kept.get(key);
    if (known) {
      this.#kept.delete(key);
      this.#kept.set(key, known);
      return known;
    }
    const shown = (side: PictureSide): ShownPicture =>
      side.ok
        ? { ok: true, url: URL.createObjectURL(side.image), width: side.width, height: side.height }
        : side;
    const made = this.#maker.pictures(request()).then((answer): ShownPictures => ({
      before: shown(answer.before),
      after: shown(answer.after),
    }));
    this.#kept.set(key, made);
    while (this.#kept.size > MOST_KEPT) {
      const [oldest] = this.#kept;
      if (!oldest) break;
      this.#kept.delete(oldest[0]);
      void oldest[1].then(ChangePictures.#drop, () => {});
    }
    return made;
  }

  static #drop({ before, after }: ShownPictures): void {
    for (const side of [before, after]) if (side.ok) URL.revokeObjectURL(side.url);
  }

  /** Lets go of every picture. */
  clear(): void {
    for (const kept of this.#kept.values()) void kept.then(ChangePictures.#drop, () => {});
    this.#kept.clear();
  }
}

const known = new WeakMap<PictureMaker, ChangePictures>();

/** The pictures of changes of a window, which renders them with `maker`. */
export function changePicturesOf(maker: PictureMaker): ChangePictures {
  let pictures = known.get(maker);
  if (!pictures) {
    pictures = new ChangePictures(maker);
    known.set(maker, pictures);
  }
  return pictures;
}
