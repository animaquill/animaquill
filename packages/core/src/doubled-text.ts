/**
 * The same change of a code file, made twice from the same text, once by each of two copies of a
 * project that had not heard of each other: the platform taking in a batch from GitHub, and an
 * editor taking in the same change from its folder, where the folder is a clone of the repository.
 * Yjs keeps both inserts of a text, so the new lines are there twice. What a change inserts is told
 * by `editSpan`, the way `ProjectStore` writes a text: both copies cut the same piece and insert the
 * same text at the same place, and Yjs puts the two inserts next to each other. `insertionOf` says
 * what a change inserted, without the text itself, and `undoubled` finds it again where it came
 * more than once.
 */

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;

/**
 * What changes when `current` becomes `next`, as little as possible: what stays at the start and at
 * the end, by their lengths, and what goes in between, which is cut and written anew. A character
 * made of two code units stays whole.
 */
export function editSpan(
  current: string,
  next: string,
): { readonly start: number; readonly end: number } {
  const shortest = Math.min(current.length, next.length);
  let start = 0;
  while (start < shortest && current[start] === next[start]) start++;
  if (start > 0 && isHighSurrogate(current.charCodeAt(start - 1))) start--;
  let end = 0;
  while (
    end < shortest - start &&
    current[current.length - 1 - end] === next[next.length - 1 - end]
  ) {
    end++;
  }
  if (end > 0 && isHighSurrogate(next.charCodeAt(next.length - end - 1))) end--;
  return { start, end };
}

/** A piece of a text, by its length and a hash of it, which is all it takes to know it again. */
export interface TextPiece {
  readonly length: number;
  readonly hash: string;
}

/**
 * What a change of a code file inserted, see `editSpan`: what stayed before and after it, and what
 * went in between. Small to keep, as the platform keeps one for each file a merge copied as is.
 */
export interface Insertion {
  readonly head: TextPiece;
  readonly inserted: TextPiece;
  readonly tail: TextPiece;
}

/**
 * Two hashes of 53 bits each, cyrb53 with two seeds: no secret, only to tell texts apart. Pieces
 * that are compared also have the same length, and a doubled text has two of them that are the
 * same, so a match by chance does not happen.
 */
function hashOf(text: string, from = 0, to = text.length): string {
  const one = (seed: number) => {
    let h1 = 0xdeadbeef ^ seed;
    let h2 = 0x41c6ce57 ^ seed;
    for (let index = from; index < to; index++) {
      const code = text.charCodeAt(index);
      h1 = Math.imul(h1 ^ code, 2654435761);
      h2 = Math.imul(h2 ^ code, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
    h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
    h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
  };
  return `${one(1)}.${one(2)}`;
}

const pieceOf = (text: string, from: number, to: number): TextPiece => ({
  length: to - from,
  hash: hashOf(text, from, to),
});

const isPiece = (text: string, from: number, piece: TextPiece) =>
  from >= 0 &&
  from + piece.length <= text.length &&
  hashOf(text, from, from + piece.length) === piece.hash;

/**
 * What writing `after` over `before` inserts, the way `ProjectStore` writes a text, see `editSpan`.
 * Undefined where it inserts nothing: what is only cut cannot come twice.
 */
export function insertionOf(before: string, after: string): Insertion | undefined {
  const { start, end } = editSpan(before, after);
  const to = after.length - end;
  if (to <= start) return undefined;
  return {
    head: pieceOf(after, 0, start),
    inserted: pieceOf(after, start, to),
    tail: pieceOf(after, to, after.length),
  };
}

/**
 * The text with what was inserted there once, where it is exactly what `insertion` gave, only with
 * the inserted piece more than once in a row. Undefined for any other text: then nothing is to be
 * done about it here, as anything else could be what people wrote.
 */
export function undoubled(text: string, insertion: Insertion): string | undefined {
  const { head, inserted, tail } = insertion;
  const middle = text.length - head.length - tail.length;
  if (inserted.length === 0 || middle < 2 * inserted.length || middle % inserted.length !== 0) {
    return undefined;
  }
  if (!isPiece(text, 0, head) || !isPiece(text, text.length - tail.length, tail)) return undefined;
  for (let at = head.length; at < text.length - tail.length; at += inserted.length) {
    if (!isPiece(text, at, inserted)) return undefined;
  }
  return text.slice(0, head.length + inserted.length) + text.slice(text.length - tail.length);
}
