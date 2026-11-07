/** One key: which clip, which property, and where on the clock of the clip, exactly. */
export interface KeyRef {
  readonly clip: string;
  readonly path: string;
  readonly time: string;
}

type Times = ReadonlySet<string>;
type Channels = ReadonlyMap<string, Times>;

/** Some keys. It never changes: a change is a new one, so that it can be compared by identity. */
export class KeySelection {
  readonly #clips: ReadonlyMap<string, Channels>;
  readonly size: number;

  private constructor(clips: ReadonlyMap<string, Channels>) {
    this.#clips = clips;
    let size = 0;
    for (const channels of clips.values()) {
      for (const times of channels.values()) size += times.size;
    }
    this.size = size;
  }

  static of(keys: Iterable<KeyRef>): KeySelection {
    const clips = new Map<string, Map<string, Set<string>>>();
    for (const { clip, path, time } of keys) {
      let channels = clips.get(clip);
      if (!channels) clips.set(clip, (channels = new Map()));
      let times = channels.get(path);
      if (!times) channels.set(path, (times = new Set()));
      times.add(time);
    }
    return new KeySelection(clips);
  }

  has({ clip, path, time }: KeyRef): boolean {
    return this.#clips.get(clip)?.get(path)?.has(time) === true;
  }

  /** The selected keys of one property, for looking through a lot of them. */
  timesOf(clip: string, path: string): Times | undefined {
    return this.#clips.get(clip)?.get(path);
  }

  hasClip(clip: string): boolean {
    return this.#clips.has(clip);
  }

  /** Keys by property, which is how edits go. */
  *channels(): Generator<{ clip: string; path: string; times: Times }> {
    for (const [clip, channels] of this.#clips) {
      for (const [path, times] of channels) yield { clip, path, times };
    }
  }

  *[Symbol.iterator](): Generator<KeyRef> {
    for (const { clip, path, times } of this.channels()) {
      for (const time of times) yield { clip, path, time };
    }
  }

  with(keys: Iterable<KeyRef>): KeySelection {
    return KeySelection.of([...this, ...keys]);
  }

  without(keys: Iterable<KeyRef>): KeySelection {
    const gone = KeySelection.of(keys);
    return KeySelection.of([...this].filter((key) => !gone.has(key)));
  }

  /** What stays of it. The same one when all of it does. */
  keeping(stays: (key: KeyRef) => boolean): KeySelection {
    const kept = [...this].filter(stays);
    return kept.length === this.size ? this : KeySelection.of(kept);
  }

  includes(keys: readonly KeyRef[]): boolean {
    return keys.every((key) => this.has(key));
  }
}

export const NO_KEYS = KeySelection.of([]);
