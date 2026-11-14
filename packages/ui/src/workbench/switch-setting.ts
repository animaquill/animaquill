import type { SettingsStore } from "@animaquill/host";
import { Emitter } from "./emitter.ts";
import { readSetting } from "./settings.ts";

const VERSION = 1;

/**
 * A preference that is on or off, shared by every window and kept under its own key, such as whether
 * the preview offers to make a proxy of a video that plays too slowly. What another window sets is
 * taken here too.
 */
export class SwitchSetting {
  readonly #settings: SettingsStore;
  readonly #key: string;
  readonly #emitter = new Emitter();
  #on: boolean;

  constructor(settings: SettingsStore, key: string, byDefault: boolean) {
    this.#settings = settings;
    this.#key = key;
    this.#on = byDefault;
  }

  subscribe = this.#emitter.subscribe;
  getSnapshot = (): boolean => this.#on;

  /** Reads what was saved. Whatever goes wrong, it is as it is by default. */
  async load(): Promise<void> {
    const reading = await readSetting(this.#settings, this.#key, parse);
    if (reading.kind === "ok") this.#adopt(reading.value);
    this.#settings.listen(this.#key, (value) => {
      const on = parse(value);
      if (on !== undefined) this.#adopt(on);
    });
  }

  set(on: boolean): void {
    this.#adopt(on);
    this.#settings
      .save(this.#key, { version: VERSION, on })
      .catch((error: unknown) => console.warn(`Setting ${this.#key} could not be saved`, error));
  }

  #adopt(on: boolean): void {
    if (on === this.#on) return;
    this.#on = on;
    this.#emitter.emit();
  }
}

function parse(value: unknown): boolean | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { version, on } = value as { version?: unknown; on?: unknown };
  return version === VERSION && typeof on === "boolean" ? on : undefined;
}
