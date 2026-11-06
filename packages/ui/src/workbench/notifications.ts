import { Emitter } from "./emitter.ts";

export interface Notification {
  readonly id: number;
  readonly message: string;
}

const LIFETIME_MS = 10_000;

/** Short messages in the corner of the window. */
export class Notifications {
  readonly #emitter = new Emitter();
  #items: readonly Notification[] = [];
  #nextId = 1;

  subscribe = this.#emitter.subscribe;
  getSnapshot = (): readonly Notification[] => this.#items;

  /** Goes away by itself, unless it has to stay until whoever asked for it dismisses it. */
  push(message: string, { stays = false } = {}): number {
    const id = this.#nextId++;
    this.#items = [...this.#items, { id, message }];
    this.#emitter.emit();
    if (!stays) setTimeout(() => this.dismiss(id), LIFETIME_MS);
    return id;
  }

  dismiss(id: number): void {
    const items = this.#items.filter((item) => item.id !== id);
    if (items.length === this.#items.length) return;
    this.#items = items;
    this.#emitter.emit();
  }
}
