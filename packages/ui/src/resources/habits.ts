import type { SettingsStore } from "@animaquill/host";
import { Emitter } from "../workbench/emitter.ts";
import { readSetting } from "../workbench/settings.ts";
import { GROUPINGS, usedNow, type Grouping } from "./resources.ts";

const SETTINGS_KEY = "resources";
const FORMAT_VERSION = 1;
/** Enough for every tab of resources to have a few of its own. */
const RECENT_LIMIT = 40;

interface SavedHabits {
  readonly version: typeof FORMAT_VERSION;
  /** Ids of resources, the most recently used first. */
  readonly recent: readonly string[];
  /** How each tab of resources groups them, by the type of the tab. */
  readonly grouping: Readonly<Record<string, Grouping>>;
}

const EMPTY: SavedHabits = { version: FORMAT_VERSION, recent: [], grouping: {} };

function parseSaved(value: unknown): SavedHabits | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { version, recent, grouping } = value as Partial<SavedHabits>;
  if (version !== FORMAT_VERSION || !Array.isArray(recent)) return undefined;
  const groupings = Object.entries(
    typeof grouping === "object" && grouping !== null ? grouping : {},
  );
  return {
    version,
    recent: recent.filter((id): id is string => typeof id === "string").slice(0, RECENT_LIMIT),
    grouping: Object.fromEntries(groupings.filter(([, by]) => GROUPINGS.includes(by))) as Record<
      string,
      Grouping
    >,
  };
}

/**
 * What people used of the resources lately, and how they like each tab of them grouped. Shared by
 * all windows, as preferences are: what another window saves comes in here, so that saving here
 * does not bring back what it had. Forgetting it costs little, so nobody is told about a failure.
 */
export class ResourceHabits {
  readonly #settings: SettingsStore;
  readonly #emitter = new Emitter();
  #saved: SavedHabits = EMPTY;

  constructor(settings: SettingsStore) {
    this.#settings = settings;
  }

  subscribe = this.#emitter.subscribe;
  getSnapshot = (): SavedHabits => this.#saved;

  async load(): Promise<void> {
    const reading = await readSetting(this.#settings, SETTINGS_KEY, parseSaved);
    if (reading.kind === "ok") this.#adopt(reading.value);
    this.#settings.listen(SETTINGS_KEY, (value) => {
      const saved = parseSaved(value);
      if (saved) this.#adopt(saved);
    });
  }

  /** Ids of resources, the most recently used first. */
  get recent(): readonly string[] {
    return this.#saved.recent;
  }

  groupingOf(tab: string, fallback: Grouping): Grouping {
    return this.#saved.grouping[tab] ?? fallback;
  }

  used(id: string): void {
    if (this.#saved.recent[0] === id) return;
    this.#save({ ...this.#saved, recent: usedNow(this.#saved.recent, id, RECENT_LIMIT) });
  }

  setGrouping(tab: string, grouping: Grouping): void {
    if (this.#saved.grouping[tab] === grouping) return;
    this.#save({ ...this.#saved, grouping: { ...this.#saved.grouping, [tab]: grouping } });
  }

  #adopt(saved: SavedHabits): void {
    this.#saved = saved;
    this.#emitter.emit();
  }

  #save(saved: SavedHabits): void {
    this.#adopt(saved);
    this.#settings
      .save(SETTINGS_KEY, saved)
      .catch((error: unknown) => console.warn("Resource habits could not be saved", error));
  }
}
