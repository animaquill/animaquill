import type { SettingsStore } from "@animaquill/host";
import { Emitter } from "../workbench/emitter.ts";
import { readSetting } from "../workbench/settings.ts";

/** A setting of this computer, see `DEVICE_SETTINGS` of the host: the screen is this computer's. */
export const PROPERTY_SECTIONS_KEY = "properties";
const FORMAT_VERSION = 1;
/** Groups folded up for one kind of clip that are kept: ids of effects and objects come and go. */
export const COLLAPSED_LIMIT = 100;

interface Saved {
  readonly version: typeof FORMAT_VERSION;
  /** By the kind of clip ("video", "scene", a track, the master), the ids of the folded groups. */
  readonly collapsed: Readonly<Record<string, readonly string[]>>;
}

const EMPTY: Saved = { version: FORMAT_VERSION, collapsed: {} };
const NONE: readonly string[] = [];

function parse(value: unknown): Saved | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { version, collapsed } = value as Partial<Saved>;
  if (version !== FORMAT_VERSION || typeof collapsed !== "object" || collapsed === null) {
    return undefined;
  }
  const kinds = Object.entries(collapsed).flatMap(([kind, ids]) =>
    Array.isArray(ids)
      ? [[kind, ids.filter((id): id is string => typeof id === "string").slice(-COLLAPSED_LIMIT)]]
      : [],
  );
  return { version, collapsed: Object.fromEntries(kinds) as Record<string, readonly string[]> };
}

/**
 * Which groups of the properties tab people folded up, by the kind of clip: another clip of the
 * same kind shows the same, as in After Effects. Everything shows until people fold it. Shared by
 * the windows of this computer, which follow each other; forgetting it costs little, so nobody
 * hears of a failure to save it.
 */
export class PropertySections {
  readonly #settings: SettingsStore;
  readonly #emitter = new Emitter();
  #saved: Saved = EMPTY;

  constructor(settings: SettingsStore) {
    this.#settings = settings;
  }

  subscribe = this.#emitter.subscribe;
  getSnapshot = (): Saved => this.#saved;

  async load(): Promise<void> {
    const reading = await readSetting(this.#settings, PROPERTY_SECTIONS_KEY, parse);
    if (reading.kind === "ok") this.#adopt(reading.value);
    this.#settings.listen(PROPERTY_SECTIONS_KEY, (value) => {
      const saved = parse(value);
      if (saved) this.#adopt(saved);
    });
  }

  /** The groups folded up for clips of a kind. */
  collapsedFor(kind: string): readonly string[] {
    return this.#saved.collapsed[kind] ?? NONE;
  }

  isCollapsed(kind: string, id: string): boolean {
    return this.collapsedFor(kind).includes(id);
  }

  /** Folds these groups up for clips of a kind, or opens them. */
  set(kind: string, ids: readonly string[], collapsed: boolean): void {
    const before = this.collapsedFor(kind);
    const without = before.filter((id) => !ids.includes(id));
    const next = collapsed ? [...without, ...ids].slice(-COLLAPSED_LIMIT) : without;
    if (next.length === before.length && next.every((id, index) => before[index] === id)) return;
    this.#adopt({ ...this.#saved, collapsed: { ...this.#saved.collapsed, [kind]: next } });
    this.#settings
      .save(PROPERTY_SECTIONS_KEY, this.#saved)
      .catch((error: unknown) =>
        console.warn("Folded groups of properties could not be saved", error),
      );
  }

  #adopt(saved: Saved): void {
    this.#saved = saved;
    this.#emitter.emit();
  }
}
