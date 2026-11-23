/** Why something that goes through the relay is ended from outside. */
export type EndedBecause = "signedOut" | "off";

/**
 * What goes through the relay now, by person and by session: disabling someone, signing them out
 * everywhere or signing a browser out ends what they have going through it at once, as it ends
 * their syncing (sync/hub.ts `closeUser`, `closeSession`), and turning the relay off ends all of it.
 */
export class RelayExchanges {
  readonly #byUser = new Map<string, Set<(why: EndedBecause) => void>>();
  readonly #bySession = new Map<string, Set<(why: EndedBecause) => void>>();

  /**
   * Notes a request of a person, from a session (by its hash, as auth/routes.ts says it), until it
   * ends: `stop` ends it. Returns how to forget it.
   */
  add(userId: string, session: string, stop: (why: EndedBecause) => void): () => void {
    const into = (map: Map<string, Set<(why: EndedBecause) => void>>, key: string) => {
      let set = map.get(key);
      if (!set) map.set(key, (set = new Set()));
      set.add(stop);
    };
    const out = (map: Map<string, Set<(why: EndedBecause) => void>>, key: string) => {
      const set = map.get(key);
      set?.delete(stop);
      if (set?.size === 0) map.delete(key);
    };
    into(this.#byUser, userId);
    into(this.#bySession, session);
    return () => {
      out(this.#byUser, userId);
      out(this.#bySession, session);
    };
  }

  /** Ends everything of a person. */
  closeUser(userId: string): void {
    for (const stop of Array.from(this.#byUser.get(userId) ?? [])) stop("signedOut");
  }

  /** Ends everything of a session, by its hash. */
  closeSession(session: string): void {
    for (const stop of Array.from(this.#bySession.get(session) ?? [])) stop("signedOut");
  }

  /** Ends everything, as when the relay is turned off. */
  closeAll(why: EndedBecause): void {
    for (const stops of Array.from(this.#byUser.values()))
      for (const stop of Array.from(stops)) stop(why);
  }

  /** How many requests go through now. */
  get size(): number {
    let count = 0;
    for (const set of this.#byUser.values()) count += set.size;
    return count;
  }
}
