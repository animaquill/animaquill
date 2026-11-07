export interface OriginPoolOptions {
  /** What a pool before this one retired. A compositor can go, and the page goes on. */
  readonly retired?: readonly string[];
  /** One more is out, which whoever makes the next pool has to know. */
  readonly onRetire?: (origin: string) => void;
}

/**
 * Which origin a new scene gets. Chrome puts sandboxed pages into processes by origin, so two scenes
 * on one origin hang together, and a new scene next to a hung one never starts. This hands out a
 * fixed set of origins so that scenes stay apart, and only shares when there are more scenes than
 * origins.
 *
 * A process that hangs can outlive its frame, in Edge by minutes at least, and everything that starts
 * on its origin then waits for it. So an origin where that may have happened stays out for as long
 * as the page lives. When none are left, only a new page helps.
 */
export class OriginPool {
  readonly #uses: Map<string, number>;
  readonly #retired: Set<string>;
  readonly #onRetire: ((origin: string) => void) | undefined;
  #next = 0;

  /** `compositor` is where the scenes are shown, which must never be where they run. */
  constructor(
    origins: readonly string[],
    compositor: string,
    { retired = [], onRetire }: OriginPoolOptions = {},
  ) {
    if (origins.length === 0) throw new Error("A scene needs an origin to run on");
    if (origins.includes(compositor)) {
      throw new Error("Scenes on the compositor's origin would hang it with them");
    }
    this.#uses = new Map(origins.map((origin) => [origin, 0]));
    this.#retired = new Set(retired);
    this.#onRetire = onRetire;
  }

  /**
   * The least used origin, going round, or nothing when none are left. `except` is one that a new
   * scene must not share, as long as there is another one.
   */
  take(except?: string): string | undefined {
    const origins = [...this.#uses.keys()];
    const usable = origins.filter((origin) => !this.#retired.has(origin));
    if (usable.length === 0) return undefined;
    const candidates = usable.filter((origin) => origin !== except);
    const from = candidates.length > 0 ? candidates : usable;
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

  /** Nothing starts here again. Giving it back later changes nothing about that. */
  retire(origin: string): void {
    if (this.#retired.has(origin)) return;
    this.#retired.add(origin);
    this.#onRetire?.(origin);
  }
}
