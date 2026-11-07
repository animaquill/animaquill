type Value = string | number | boolean | undefined;

/** What went on before something went wrong. Enough to see the way there, little enough to cost nothing. */
export const TRAIL_LIMIT = 200;
/** One drag of the playhead, not a line for every frame of it. */
const MERGE_WITHIN_MS = 1000;
/**
 * Only names that the editor gives things, such as `clip.move` or `timeline`. Anything else could
 * be something people wrote, such as the name of a file, and never goes in.
 */
const NAME = /^[\w.:-]{1,60}$/;

export interface TrailEntry {
  /** Milliseconds since the page opened. */
  readonly t: number;
  readonly kind: string;
  /** How many of these came in a row, when that is more than one. */
  readonly times?: number;
  readonly [key: string]: Value;
}

function clean(data: Readonly<Record<string, Value>>): Record<string, Value> {
  const result: Record<string, Value> = {};
  for (const [key, value] of Object.entries(data)) {
    if (!NAME.test(key)) continue;
    if (typeof value === "number") result[key] = Number.isFinite(value) ? value : String(value);
    else if (typeof value === "boolean") result[key] = value;
    else if (typeof value === "string") result[key] = NAME.test(value) ? value : "?";
  }
  return result;
}

function sameWords(entry: TrailEntry, data: Readonly<Record<string, Value>>): boolean {
  const words = (values: Readonly<Record<string, Value>>) =>
    Object.entries(values)
      .filter(([key, value]) => typeof value !== "number" && key !== "t" && key !== "kind")
      .map(([key, value]) => `${key}=${String(value)}`)
      .toSorted()
      .join("&");
  return words(entry) === words(data);
}

/**
 * The black box: the last things people did and the editor went through, always, in memory only.
 * It holds names of what happened and numbers, never what people make.
 */
export class Trail {
  readonly #limit: number;
  readonly #now: () => number;
  #entries: TrailEntry[] = [];

  constructor(limit = TRAIL_LIMIT, now: () => number = () => performance.now()) {
    this.#limit = limit;
    this.#now = now;
  }

  /**
   * With `merge`, one that follows the same right away takes its place and counts: the same kind,
   * with the same words. Numbers can differ, and the last ones stay.
   */
  add(kind: string, data: Readonly<Record<string, Value>> = {}, merge = false): void {
    if (!NAME.test(kind)) return;
    const t = Math.round(this.#now());
    const cleaned = clean(data);
    const last = this.#entries.at(-1);
    if (
      merge &&
      last &&
      last.kind === kind &&
      t - last.t <= MERGE_WITHIN_MS &&
      sameWords(last, cleaned)
    ) {
      this.#entries[this.#entries.length - 1] = {
        ...cleaned,
        t,
        kind,
        times: (last.times ?? 1) + 1,
      };
      return;
    }
    this.#entries.push({ ...cleaned, t, kind });
    if (this.#entries.length > this.#limit) this.#entries.shift();
  }

  /** Oldest first. A copy, so that what goes on afterwards does not change it. */
  entries(): readonly TrailEntry[] {
    return [...this.#entries];
  }
}
