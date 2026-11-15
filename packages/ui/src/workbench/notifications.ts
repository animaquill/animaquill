import { Emitter } from "./emitter.ts";

/** Something people can do about what a notification says, right there. */
export interface NotificationAction {
  readonly label: string;
  readonly run: () => void;
}

export interface Notification {
  readonly id: number;
  readonly message: string;
  /** Doing one of them is the end of the notification. */
  readonly actions?: readonly NotificationAction[];
  /** A line under it that needs looking at, such as what of people's own changes stayed. */
  readonly warning?: { readonly text: string; readonly action?: NotificationAction };
}

export interface NotificationOptions {
  readonly stays?: boolean;
  readonly actions?: readonly NotificationAction[];
  readonly warning?: Notification["warning"];
}

const LIFETIME_MS = 10_000;
/** What is left to read once the pointer leaves one it was resting on. */
const AFTER_HOLD_MS = 4_000;

/** Short messages in the corner of the window. */
export class Notifications {
  readonly #emitter = new Emitter();
  #items: readonly Notification[] = [];
  #nextId = 1;
  readonly #timers = new Map<number, ReturnType<typeof setTimeout> | undefined>();

  subscribe = this.#emitter.subscribe;
  getSnapshot = (): readonly Notification[] => this.#items;

  /** Goes away by itself, unless it has to stay until whoever asked for it dismisses it. */
  push(message: string, { stays = false, actions, warning }: NotificationOptions = {}): number {
    const id = this.#nextId++;
    this.#items = [
      ...this.#items,
      { id, message, ...(actions && { actions }), ...(warning && { warning }) },
    ];
    this.#emitter.emit();
    if (!stays)
      this.#timers.set(
        id,
        setTimeout(() => this.dismiss(id), LIFETIME_MS),
      );
    return id;
  }

  /**
   * Says something new in place of a notification that is still there, which starts its time
   * again unless someone is reading it; where it went already, it comes again as a new one.
   * Resolves to its id.
   */
  update(id: number | undefined, message: string, options: NotificationOptions = {}): number {
    const at = this.#items.findIndex((item) => item.id === id);
    if (id === undefined || at < 0) return this.push(message, options);
    const { actions, warning } = options;
    const items = [...this.#items];
    items[at] = { id, message, ...(actions && { actions }), ...(warning && { warning }) };
    this.#items = items;
    this.#emitter.emit();
    if (this.#timers.get(id) !== undefined) {
      clearTimeout(this.#timers.get(id));
      this.#timers.set(
        id,
        setTimeout(() => this.dismiss(id), LIFETIME_MS),
      );
    }
    return id;
  }

  /** Someone is reading it, with the pointer or the keyboard on it: it stays until they leave. */
  hold(id: number): void {
    // Only what goes by itself has an entry, and it has none while it is held.
    if (!this.#timers.has(id)) return;
    clearTimeout(this.#timers.get(id));
    this.#timers.set(id, undefined);
  }

  /** They left it: a few more seconds, for the end of the line. */
  release(id: number): void {
    if (!this.#timers.has(id)) return;
    this.#timers.set(
      id,
      setTimeout(() => this.dismiss(id), AFTER_HOLD_MS),
    );
  }

  dismiss(id: number): void {
    const items = this.#items.filter((item) => item.id !== id);
    clearTimeout(this.#timers.get(id));
    this.#timers.delete(id);
    if (items.length === this.#items.length) return;
    this.#items = items;
    this.#emitter.emit();
  }
}
