import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * The one-time tokens of the backend of `npx animaquill` (design O4 of AnimaQuill Cloud, section 2):
 * each start, and each `npx animaquill open`, makes one, which goes to the browser in the address
 * (`#aq-token=`, never sent to any server) and is given back once for a session. Only in memory,
 * only their hashes, for ten minutes; a restart forgets them all.
 */

export const TOKEN_MS = 10 * 60 * 1000;
/** Tokens waiting at the most: the oldest goes for a new one. */
const MOST = 32;

const hash = (token: string) => createHash("sha256").update(token).digest();

export class OneTimeTokens {
  readonly #waiting: { readonly hash: Buffer; readonly until: number }[] = [];
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  /** A new token. */
  issue(): string {
    const token = randomBytes(32).toString("base64url");
    this.#forgetOld();
    if (this.#waiting.length >= MOST) this.#waiting.shift();
    this.#waiting.push({ hash: hash(token), until: this.#now() + TOKEN_MS });
    return token;
  }

  /** Whether `token` is one waiting, which it is not any more. Compares every one, in fixed time. */
  take(token: unknown): boolean {
    if (typeof token !== "string" || token.length > 128) return false;
    this.#forgetOld();
    const given = hash(token);
    let found = -1;
    for (const [index, each] of this.#waiting.entries())
      if (timingSafeEqual(each.hash, given)) found = index;
    if (found < 0) return false;
    this.#waiting.splice(found, 1);
    return true;
  }

  #forgetOld() {
    const now = this.#now();
    for (let index = this.#waiting.length - 1; index >= 0; index--)
      if (this.#waiting[index]!.until <= now) this.#waiting.splice(index, 1);
  }
}
