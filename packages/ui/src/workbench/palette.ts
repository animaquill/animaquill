import type { SettingsStore } from "@animaquill/host";
import type { TFunction } from "i18next";
import type { Action, ActionRegistry } from "./actions.ts";
import { Emitter } from "./emitter.ts";
import { fuzzyMatch } from "./fuzzy.ts";
import { readSetting } from "./settings.ts";

export interface PaletteEntry {
  readonly action: Action;
  readonly title: string;
  readonly positions: readonly number[];
  readonly recent: boolean;
}

interface SavedPalette {
  readonly version: typeof FORMAT_VERSION;
  readonly recent: readonly string[];
}

const SETTINGS_KEY = "palette";
const FORMAT_VERSION = 1;
const RECENT_LIMIT = 6;
/** The internal name helps people who type English, but a match in the title counts more. */
const ID_MATCH_WEIGHT = 0.5;

function parseSaved(value: unknown): SavedPalette | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { version, recent } = value as Partial<SavedPalette>;
  if (version !== FORMAT_VERSION || !Array.isArray(recent)) return undefined;
  return { version, recent: recent.filter((id) => typeof id === "string") };
}

/** Finds and runs actions by name. */
export class CommandPalette {
  readonly #settings: SettingsStore;
  readonly #actions: ActionRegistry;
  readonly #emitter = new Emitter();
  #open = false;
  #recent: readonly string[] = [];

  constructor(settings: SettingsStore, actions: ActionRegistry) {
    this.#settings = settings;
    this.#actions = actions;
  }

  subscribe = this.#emitter.subscribe;
  isOpen = (): boolean => this.#open;

  /** Forgetting what was used recently costs little, so nobody is told about a failure here. */
  async load(): Promise<void> {
    const reading = await readSetting(this.#settings, SETTINGS_KEY, parseSaved);
    if (reading.kind === "ok") this.#recent = reading.value.recent;
  }

  toggle(): void {
    this.#setOpen(!this.#open);
  }

  close(): void {
    this.#setOpen(false);
  }

  run(action: Action): void {
    this.#setOpen(false);
    this.#recent = [action.id, ...this.#recent.filter((id) => id !== action.id)].slice(
      0,
      RECENT_LIMIT,
    );
    this.#settings
      .save(SETTINGS_KEY, { version: FORMAT_VERSION, recent: this.#recent })
      .catch((error: unknown) => console.warn("Recent commands could not be saved", error));
    this.#actions.perform(action, "palette");
  }

  #setOpen(open: boolean): void {
    if (open === this.#open) return;
    this.#open = open;
    this.#emitter.emit();
  }

  /** Without a query: what was used recently, then everything. With one: the best matches. */
  search(query: string, t: TFunction): readonly PaletteEntry[] {
    const rank = (action: Action) => {
      const index = this.#recent.indexOf(action.id);
      return index === -1 ? this.#recent.length : index;
    };
    const candidates = this.#actions
      .list()
      .filter((action) => action.palette !== false && action.enabled?.() !== false);

    if (!query.trim()) {
      return candidates
        .map((action) => ({
          action,
          title: action.title(t),
          positions: [],
          recent: this.#recent.includes(action.id),
        }))
        .toSorted((a, b) => rank(a.action) - rank(b.action));
    }

    const found: (PaletteEntry & { readonly score: number })[] = [];
    for (const action of candidates) {
      const title = action.title(t);
      const byTitle = fuzzyMatch(query, title);
      const byId = fuzzyMatch(query, action.id);
      const idScore = byId ? byId.score * ID_MATCH_WEIGHT : undefined;
      if (byTitle === undefined && idScore === undefined) continue;
      const useTitle = byTitle !== undefined && (idScore === undefined || byTitle.score >= idScore);
      found.push({
        action,
        title,
        positions: useTitle ? byTitle.positions : [],
        recent: false,
        score: useTitle ? byTitle.score : (idScore as number),
      });
    }
    return found.toSorted((a, b) => b.score - a.score || rank(a.action) - rank(b.action));
  }
}
