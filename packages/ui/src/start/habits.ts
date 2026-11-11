import type { SettingsStore } from "@animaquill/host";
import { Emitter } from "../workbench/emitter.ts";
import { DEFAULT_HABITS, readHabits, writeHabits, type ViewHabits } from "./views.ts";

const SETTINGS_KEY = "startPage";

/**
 * How people sort each view of the start page, and whether as cards or as a list, see the design
 * of the start page, 6.2: each view its own, kept in this browser and shared by its windows, as
 * preferences are. Forgetting it costs little, so nobody is told about a failure.
 */
export class StartHabits {
  readonly #settings: SettingsStore;
  readonly #emitter = new Emitter();
  #habits: ReadonlyMap<string, ViewHabits> = new Map();

  constructor(settings: SettingsStore) {
    this.#settings = settings;
    settings.listen(SETTINGS_KEY, (value) => {
      this.#habits = readHabits(value);
      this.#emitter.emit();
    });
  }

  subscribe = this.#emitter.subscribe;
  getSnapshot = (): ReadonlyMap<string, ViewHabits> => this.#habits;

  async load(): Promise<void> {
    try {
      this.#habits = readHabits(await this.#settings.load(SETTINGS_KEY));
      this.#emitter.emit();
    } catch (error) {
      console.warn("How the views of the start page are shown could not be read", error);
    }
  }

  of(view: string): ViewHabits {
    return this.#habits.get(view) ?? DEFAULT_HABITS;
  }

  set(view: string, change: Partial<ViewHabits>): void {
    const next = new Map(this.#habits);
    next.set(view, { ...this.of(view), ...change });
    this.#habits = next;
    this.#emitter.emit();
    this.#settings.save(SETTINGS_KEY, writeHabits(next)).catch((error: unknown) => {
      console.warn("How the views of the start page are shown could not be kept", error);
    });
  }
}
