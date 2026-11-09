import type { SettingsStore } from "@animaquill/host";
import { Emitter } from "../workbench/emitter.ts";
import { readSetting } from "../workbench/settings.ts";
import { GROUPINGS, usedNow, type Grouping } from "./resources.ts";

const SETTINGS_KEY = "resources";
const FORMAT_VERSION = 1;
/** Enough for every tab of resources to have a few of its own. */
const RECENT_LIMIT = 40;
/** Groups closed in one tab that are kept: tags come and go, and old ones need not stay forever. */
const COLLAPSED_LIMIT = 100;

interface SavedHabits {
  readonly version: typeof FORMAT_VERSION;
  /** Ids of resources, the most recently used first. */
  readonly recent: readonly string[];
  /** How each tab of resources groups them, by the type of the tab. */
  readonly grouping: Readonly<Record<string, Grouping>>;
  /** The groups people closed in each tab of resources, by the type of the tab and their ids. */
  readonly collapsed: Readonly<Record<string, readonly string[]>>;
}

const EMPTY: SavedHabits = { version: FORMAT_VERSION, recent: [], grouping: {}, collapsed: {} };
const NONE: readonly string[] = [];

const isObject = (value: unknown): value is object => typeof value === "object" && value !== null;

function parseSaved(value: unknown): SavedHabits | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { version, recent, grouping, collapsed } = value as Partial<SavedHabits>;
  if (version !== FORMAT_VERSION || !Array.isArray(recent)) return undefined;
  const groupings = Object.entries(isObject(grouping) ? grouping : {});
  // Saved before groups could be closed, or by something else: what is not a list of ids goes.
  const closed = Object.entries(isObject(collapsed) ? collapsed : {}).flatMap(([tab, ids]) =>
    Array.isArray(ids)
      ? [[tab, ids.filter((id): id is string => typeof id === "string").slice(-COLLAPSED_LIMIT)]]
      : [],
  );
  return {
    version,
    recent: recent.filter((id): id is string => typeof id === "string").slice(0, RECENT_LIMIT),
    grouping: Object.fromEntries(groupings.filter(([, by]) => GROUPINGS.includes(by))) as Record<
      string,
      Grouping
    >,
    collapsed: Object.fromEntries(closed) as Record<string, readonly string[]>,
  };
}

/**
 * What people used of the resources lately, how they like each tab of them grouped, and which
 * groups they closed there. Shared by
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

  /** The ids of the groups closed in a tab. */
  collapsedIn(tab: string): readonly string[] {
    return this.#saved.collapsed[tab] ?? NONE;
  }

  /** Closes or opens a group of a tab, which stays that way there until people change it. */
  setCollapsed(tab: string, group: string, collapsed: boolean): void {
    const closed = this.collapsedIn(tab);
    if (closed.includes(group) === collapsed) return;
    const next = collapsed
      ? [...closed, group].slice(-COLLAPSED_LIMIT)
      : closed.filter((id) => id !== group);
    this.#save({ ...this.#saved, collapsed: { ...this.#saved.collapsed, [tab]: next } });
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
