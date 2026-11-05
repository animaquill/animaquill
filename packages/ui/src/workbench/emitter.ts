/** Change notifications in the shape React's useSyncExternalStore expects. */
export class Emitter {
  readonly #listeners = new Set<() => void>();

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  emit(): void {
    for (const listener of this.#listeners) listener();
  }
}
