import { Emitter } from "./emitter.ts";

/** The pages of the settings, in the order of their list. */
export type SettingsPage = "editing" | "models" | "packs";
export const SETTINGS_PAGES: readonly SettingsPage[] = ["editing", "models", "packs"];

/**
 * Where the settings of a window are: which page, and on the page of AI models which service, or
 * the cards of services to add. Where the settings are narrow they show one level at a time, and
 * `depth` is the level: the list of pages (0), a page (1), what a page opened (2). Where they are
 * wide, the list of pages and a page show side by side, and only what a page opened counts.
 */
export interface SettingsPlace {
  readonly page: SettingsPage;
  readonly depth: 0 | 1 | 2;
  /** The service shown, on the page of AI models. */
  readonly service?: string | undefined;
  /** The cards of services to add are shown, with one picked where it says which kind. */
  readonly adding?: true | string | undefined;
  /** Where to go once a service is added: back to the chat, which sent people here. */
  readonly back?: "chat" | undefined;
}

/** Where the settings of this window are, which a window keeps for itself, see `SettingsPlace`. */
export class SettingsNav {
  readonly #emitter = new Emitter();
  #place: SettingsPlace = { page: "editing", depth: 0 };

  subscribe = this.#emitter.subscribe;
  getSnapshot = (): SettingsPlace => this.#place;

  go(place: SettingsPlace): void {
    this.#place = place;
    this.#emitter.emit();
  }

  /** One level up, where the settings are narrow. */
  back(): void {
    const { page, depth } = this.#place;
    this.go(depth === 2 ? { page, depth: 1 } : { page, depth: 0 });
  }
}
