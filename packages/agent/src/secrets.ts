/**
 * Keys of AI services must not show anywhere but in the field people typed them into: not in what
 * the chat shows or keeps, not in logs, not in reports. Services sometimes repeat the key in what
 * they answer, as a whole or with stars in the middle, so everything they say goes through here.
 */

/** Shapes keys of the common services have, also with stars in them. */
const KEY_SHAPES = [
  /\b(?:sk|rk|pk)-[A-Za-z0-9_*.-]{6,}/g,
  /\bAIza[A-Za-z0-9_*-]{10,}/g,
  /\bBearer\s+[A-Za-z0-9_*.~+/=-]{8,}/gi,
];
/** Shorter ones would take words out of plain text. */
const MIN_KEY = 8;
export const HIDDEN_KEY = "<key>";

/** The text without the keys and without anything shaped like a key. */
export function withoutKeys(text: string, keys: Iterable<string | undefined> = []): string {
  let clean = text;
  for (const key of keys) {
    if (key === undefined) continue;
    const trimmed = key.trim();
    if (trimmed.length < MIN_KEY) continue;
    clean = clean.split(trimmed).join(HIDDEN_KEY);
    // What services show of a key they do not accept: its start or its end.
    for (const part of [trimmed.slice(0, 12), trimmed.slice(-8)]) {
      if (part.length >= MIN_KEY) clean = clean.split(part).join(HIDDEN_KEY);
    }
  }
  for (const shape of KEY_SHAPES) clean = clean.replaceAll(shape, HIDDEN_KEY);
  return clean;
}
