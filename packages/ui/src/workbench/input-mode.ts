import type { SettingsStore } from "@animaquill/host";
import { Emitter } from "./emitter.ts";
import { readSetting } from "./settings.ts";

export type InputDevice = "mouse" | "trackpad" | "touch";
export type InputChoice = InputDevice | "auto";

export interface InputSnapshot {
  readonly choice: InputChoice;
  /** What is in use right now: the choice, or else what was noticed last. */
  readonly device: InputDevice;
}

const SETTINGS_KEY = "input";
const SETTINGS_VERSION = 1;
const CHOICES: readonly InputChoice[] = ["auto", "mouse", "trackpad", "touch"];

function parseSaved(value: unknown): InputChoice | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { version, choice } = value as { version?: unknown; choice?: InputChoice };
  return version === SETTINGS_VERSION && CHOICES.includes(choice as InputChoice)
    ? choice
    : undefined;
}

/**
 * How people work with the editor. Browsers do not say what a wheel event comes from, and a guess
 * can be wrong, so people can also just say.
 */
export class InputMode {
  readonly #settings: SettingsStore;
  readonly #emitter = new Emitter();
  #choice: InputChoice = "auto";
  #noticed: InputDevice = "mouse";
  #snapshot: InputSnapshot = { choice: "auto", device: "mouse" };

  constructor(settings: SettingsStore) {
    this.#settings = settings;
  }

  subscribe = this.#emitter.subscribe;
  getSnapshot = (): InputSnapshot => this.#snapshot;

  async load(): Promise<void> {
    const reading = await readSetting(this.#settings, SETTINGS_KEY, parseSaved);
    if (reading.kind === "ok") this.#adopt(reading.value);
    this.#settings.listen(SETTINGS_KEY, (value) => {
      const choice = parseSaved(value);
      if (choice) this.#adopt(choice);
    });
  }

  choose(choice: InputChoice): void {
    this.#adopt(choice);
    this.#settings
      .save(SETTINGS_KEY, { version: SETTINGS_VERSION, choice })
      .catch((error: unknown) => console.warn("Input mode could not be saved", error));
  }

  /** Something was used. It only counts while people left the choice to the editor. */
  notice(device: InputDevice): void {
    if (device === this.#noticed) return;
    this.#noticed = device;
    this.#update();
  }

  /** A press tells touch from the rest. A mouse and a trackpad press the same way. */
  noticePointer(pointerType: string): void {
    if (pointerType === "touch") this.notice("touch");
    else if (this.#noticed === "touch") this.notice("mouse");
  }

  /** Whether this pointer works like a finger. */
  isTouch(pointerType: string): boolean {
    if (this.#choice === "auto") return pointerType === "touch";
    return this.#choice === "touch";
  }

  /** What a wheel event has to be taken for. Undefined leaves it to the steps it takes. */
  get wheelDevice(): "mouse" | "trackpad" | undefined {
    return this.#choice === "mouse" || this.#choice === "trackpad" ? this.#choice : undefined;
  }

  #adopt(choice: InputChoice): void {
    this.#choice = choice;
    this.#update();
  }

  #update(): void {
    const device = this.#choice === "auto" ? this.#noticed : this.#choice;
    this.#snapshot = { choice: this.#choice, device };
    this.#emitter.emit();
  }
}
