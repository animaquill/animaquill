import { Emitter } from "./emitter.ts";

/**
 * Something of the window that is on or off, which one part asks for and another shows: the panel
 * of the platform, which the menu opens and the status bar shows. Never kept: a reload starts off.
 */
export class Flag {
  readonly #emitter = new Emitter();
  #on = false;

  subscribe = this.#emitter.subscribe;
  getSnapshot = (): boolean => this.#on;

  set(on: boolean): void {
    if (on === this.#on) return;
    this.#on = on;
    this.#emitter.emit();
  }
}
