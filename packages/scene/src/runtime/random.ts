/** A small generator with good statistics (sfc32), so that a seed gives the same numbers forever. */
export function seededRandom(seed: number): () => number {
  let a = 0x9e3779b9;
  let b = 0x243f6a88;
  let c = 0xb7e15162;
  let d = seed | 0;
  const next = () => {
    const result = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = ((c << 21) | (c >>> 11)) + result;
    c |= 0;
    return result >>> 0;
  };
  for (let round = 0; round < 15; round += 1) next();
  return () => next() / 4294967296;
}

/** Fills a typed array the way `crypto.getRandomValues` does. */
export function fillRandom<T extends ArrayBufferView>(random: () => number, array: T): T {
  const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = random() * 256;
  return array;
}

/**
 * A version 4 UUID, in the form `crypto.randomUUID` has. This and the others up here travel to
 * workers as text, so they can only use what they get.
 */
export function randomUuid(random: () => number, fill: typeof fillRandom): string {
  const bytes = fill(random, new Uint8Array(16));
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const BYTES_SEED = 0x5bd1e995;

/** The seed of a frame. Frames next to each other have nothing to do with each other. */
export const seedOfFrame = (seed: number, frame: number) => seed ^ Math.imul(frame + 1, 0x9e3779b1);

export interface RandomStreams {
  /**
   * Runs code that may run again for the same frame, in any order. Numbers that depend on what ran
   * before would come out different each time, so that code gets the numbers of its frame.
   */
  forFrame(frame: number, run: () => void): void;
}

/** Replaces where randomness comes from. Each source gets a stream of its own. */
export function installRandom(seed: number): RandomStreams {
  let numbers = seededRandom(seed);
  let bytes = seededRandom(seed ^ BYTES_SEED);
  Math.random = () => numbers();
  Crypto.prototype.getRandomValues = function getRandomValues<T extends ArrayBufferView | null>(
    array: T,
  ): T {
    return array && fillRandom(bytes, array);
  };
  Crypto.prototype.randomUUID = function randomUUID() {
    return randomUuid(bytes, fillRandom) as `${string}-${string}-${string}-${string}-${string}`;
  };
  return {
    forFrame(frame, run) {
      const kept = [numbers, bytes] as const;
      numbers = seededRandom(seedOfFrame(seed, frame));
      bytes = seededRandom(seedOfFrame(seed ^ BYTES_SEED, frame));
      try {
        run();
      } finally {
        [numbers, bytes] = kept;
      }
    },
  };
}
