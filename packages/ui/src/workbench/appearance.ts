import type { SettingsStore } from "@animaquill/host";
import { Emitter } from "./emitter.ts";
import { readSetting } from "./settings.ts";

/** The colours of the editor: one of the two themes, or that of the system, which can change. */
export type ThemeChoice = "dark" | "light" | "system";
/** How large the words of the editor are, see `--aq-font-scale` in theme/tokens.css. */
export type FontSize = "small" | "normal" | "large";

export interface AppearanceChoice {
  readonly theme: ThemeChoice;
  readonly fontSize: FontSize;
}

export const THEME_CHOICES: readonly ThemeChoice[] = ["system", "light", "dark"];
export const FONT_SIZES: readonly FontSize[] = ["small", "normal", "large"];

/**
 * Following the system unless people chose, as most of what people use does: the dark theme for
 * those whose system is dark, which is what everybody had before there were two.
 */
export const DEFAULT_APPEARANCE: AppearanceChoice = { theme: "system", fontSize: "normal" };

/** Kept under `animaquill.appearance`: web/public/boot.js reads it too, before the editor is there. */
const KEY = "appearance";
const VERSION = 1;

/** Where the choice shows: the page, and what the system prefers. */
export interface AppearancePage {
  /** Puts the theme and the size on the page, as `data-theme` and `data-font-size` of its root. */
  show(theme: "dark" | "light", fontSize: FontSize): void;
  /** Whether the system prefers light colours now. */
  prefersLight(): boolean;
  /** What the system prefers from now on, as it changes. Returns how to stop. */
  watchSystem(listener: () => void): () => void;
}

/** The page the editor is on. Nothing where there is none, as in the unit tests. */
export function browserPage(): AppearancePage {
  const query =
    typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: light)") : undefined;
  return {
    show(theme, fontSize) {
      if (typeof document === "undefined") return;
      const root = document.documentElement;
      root.dataset["theme"] = theme;
      root.dataset["fontSize"] = fontSize;
    },
    prefersLight: () => query?.matches === true,
    watchSystem(listener) {
      query?.addEventListener("change", listener);
      return () => query?.removeEventListener("change", listener);
    },
  };
}

/**
 * The colours and the size of the words of the editor: a preference of this device, shared by its
 * windows, as the other settings of how the editor looks. What another window chooses is taken
 * here too, and with "system" the theme follows the system as it changes.
 */
export class Appearance {
  readonly #settings: SettingsStore;
  readonly #page: AppearancePage;
  readonly #emitter = new Emitter();
  #choice: AppearanceChoice = DEFAULT_APPEARANCE;
  #stopSystem: (() => void) | undefined;

  constructor(settings: SettingsStore, page: AppearancePage = browserPage()) {
    this.#settings = settings;
    this.#page = page;
  }

  subscribe = this.#emitter.subscribe;
  getSnapshot = (): AppearanceChoice => this.#choice;

  /** The theme that shows now: the chosen one, or the system's. */
  get shown(): "dark" | "light" {
    const { theme } = this.#choice;
    if (theme !== "system") return theme;
    return this.#page.prefersLight() ? "light" : "dark";
  }

  /** Reads what was saved and shows it. Whatever goes wrong, it is as it is by default. */
  async load(): Promise<void> {
    const reading = await readSetting(this.#settings, KEY, parse);
    this.#adopt(reading.kind === "ok" ? reading.value : DEFAULT_APPEARANCE, true);
    this.#settings.listen(KEY, (value) => {
      const choice = parse(value);
      if (choice) this.#adopt(choice);
    });
  }

  set(change: Partial<AppearanceChoice>): void {
    const choice = { ...this.#choice, ...change };
    this.#adopt(choice);
    this.#settings
      .save(KEY, { version: VERSION, ...choice })
      .catch((error: unknown) => console.warn(`Setting ${KEY} could not be saved`, error));
  }

  #adopt(choice: AppearanceChoice, always = false): void {
    if (!always && choice.theme === this.#choice.theme && choice.fontSize === this.#choice.fontSize)
      return;
    this.#choice = choice;
    this.#stopSystem?.();
    this.#stopSystem =
      choice.theme === "system" ? this.#page.watchSystem(() => this.#show()) : undefined;
    this.#show();
    this.#emitter.emit();
  }

  #show(): void {
    this.#page.show(this.shown, this.#choice.fontSize);
  }
}

/** What was saved, where it is something this knows: a part it does not know is as by default. */
function parse(value: unknown): AppearanceChoice | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { version, theme, fontSize } = value as Record<string, unknown>;
  if (version !== VERSION) return undefined;
  return {
    theme: THEME_CHOICES.includes(theme as ThemeChoice)
      ? (theme as ThemeChoice)
      : DEFAULT_APPEARANCE.theme,
    fontSize: FONT_SIZES.includes(fontSize as FontSize)
      ? (fontSize as FontSize)
      : DEFAULT_APPEARANCE.fontSize,
  };
}
