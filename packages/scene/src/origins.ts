/**
 * Which origin a new scene gets. Chrome puts sandboxed pages into processes by origin, so two scenes
 * on one origin hang together, and a new scene next to a hung one never starts. This hands out a
 * fixed set of origins so that scenes stay apart, and only shares when there are more scenes than
 * origins.
 */
export class OriginPool {
  readonly #uses: Map<string, number>;
  #next = 0;

  /** `compositor` is where the scenes are shown, which must never be where they run. */
  constructor(origins: readonly string[], compositor: string) {
    if (origins.length === 0) throw new Error("A scene needs an origin to run on");
    if (origins.includes(compositor)) {
      throw new Error("Scenes on the compositor's origin would hang it with them");
    }
    this.#uses = new Map(origins.map((origin) => [origin, 0]));
  }

  /** The least used origin, going round. `except` is one that a new scene must not share. */
  take(except?: string): string {
    const origins = [...this.#uses.keys()];
    const candidates = origins.filter((origin) => origin !== except);
    const from = candidates.length > 0 ? candidates : origins;
    const fewest = Math.min(...from.map((origin) => this.#uses.get(origin) ?? 0));
    for (let step = 0; step < origins.length; step += 1) {
      const origin = origins[(this.#next + step) % origins.length] as string;
      if (from.includes(origin) && this.#uses.get(origin) === fewest) {
        this.#next = (this.#next + step + 1) % origins.length;
        this.#uses.set(origin, fewest + 1);
        return origin;
      }
    }
    throw new Error("Unreachable: there is always a least used origin");
  }

  give(origin: string): void {
    const uses = this.#uses.get(origin);
    if (uses) this.#uses.set(origin, uses - 1);
  }
}
