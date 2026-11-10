declare const TextEncoder: new () => { encode(text: string): Uint8Array };

/**
 * A file that size is not code anybody writes. A platform takes no file larger in a change, see
 * `checkWritten`, nor a change much larger: the editor and a platform keep to the same limit.
 */
export const MAX_SOURCE_BYTES = 8 * 1024 ** 2;

/** Bytes per character at the most, in UTF-8. */
const MOST_BYTES_PER_CHARACTER = 3;

/** Whether a text is larger, in UTF-8, than a file may be. */
export const isTooLargeSource = (text: string): boolean =>
  text.length * MOST_BYTES_PER_CHARACTER > MAX_SOURCE_BYTES &&
  new TextEncoder().encode(text).length > MAX_SOURCE_BYTES;
