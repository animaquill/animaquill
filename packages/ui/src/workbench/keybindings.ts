import type { SettingsStore } from "@animaquill/host";
import type { Action, ActionRegistry } from "./actions.ts";
import { Emitter } from "./emitter.ts";
import {
  comboOf,
  worksWhileTyping,
  type KeyCombo,
  type KeyEventFacts,
  type Platform,
} from "./keys.ts";
import { readSetting } from "./settings.ts";

export type KeyDown = KeyEventFacts &
  Pick<KeyboardEvent, "isComposing" | "repeat" | "defaultPrevented" | "target" | "preventDefault">;

export interface KeybindingMessages {
  restoreFailed(): void;
  saveFailed(): void;
}

interface SavedKeybindings {
  readonly version: typeof FORMAT_VERSION;
  /** Only what the person changed. An empty list means the action has no key on purpose. */
  readonly overrides: Readonly<Record<string, readonly KeyCombo[]>>;
}

const SETTINGS_KEY = "keybindings";
const FORMAT_VERSION = 1;

function parseSaved(value: unknown): SavedKeybindings | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { version, overrides } = value as Partial<SavedKeybindings>;
  if (version !== FORMAT_VERSION || typeof overrides !== "object" || overrides === null) {
    return undefined;
  }
  const valid = Object.entries(overrides).filter(
    ([, keys]) => Array.isArray(keys) && keys.every((key) => typeof key === "string"),
  );
  return { version, overrides: Object.fromEntries(valid) };
}

/** Inputs that take no typing, so that shortcuts keep working while one has the focus. */
const NO_TEXT_INPUTS = new Set(["range", "checkbox", "radio", "button", "color", "file"]);

function isTextEntry(target: EventTarget | null): boolean {
  const element = target as Partial<HTMLInputElement> | null;
  if (!element?.tagName) return false;
  if (element.tagName === "INPUT") return !NO_TEXT_INPUTS.has(element.type ?? "text");
  return element.isContentEditable === true || /^(TEXTAREA|SELECT)$/.test(element.tagName);
}

/** The keys a slider moves with. Everything else is free for shortcuts. */
const SLIDER_KEYS = new Set(["left", "right", "up", "down", "home", "end", "pageup", "pagedown"]);

const isSlider = (target: EventTarget | null) =>
  (target as Partial<HTMLInputElement> | null)?.type === "range";

/** The panel an element is in. */
function panelOf(target: EventTarget | null): string | undefined {
  const element = target as Partial<Element> | null;
  return element?.closest?.("[data-panel]")?.getAttribute("data-panel") ?? undefined;
}

function isInMenu(target: EventTarget | null): boolean {
  const element = target as Partial<Element> | null;
  return element?.closest?.('[role="menu"]') != null;
}

const sameKeys = (a: readonly KeyCombo[], b: readonly KeyCombo[]) =>
  a.length === b.length && a.every((key) => b.includes(key));

/** Where a combination is kept: panels have their own, next to the ones that work everywhere. */
const slot = (combo: KeyCombo, scope: string | undefined) =>
  scope === undefined ? combo : `${scope} ${combo}`;

/**
 * Which key runs which action. In one panel, and among the actions for everywhere, a combination
 * belongs to one action at a time. A panel goes first while it is in use.
 */
export class KeybindingService {
  readonly #settings: SettingsStore;
  readonly #actions: ActionRegistry;
  readonly #messages: KeybindingMessages;
  readonly #emitter = new Emitter();
  readonly #overrides = new Map<string, readonly KeyCombo[]>();
  #keys = new Map<string, readonly KeyCombo[]>();
  #owners = new Map<string, string>();
  /** The panel in use. Menus and the like take the focus, but people stay with that panel. */
  #panel: string | undefined;
  #revision = 0;
  #saveFailed = false;

  readonly platform: Platform;

  constructor(
    settings: SettingsStore,
    actions: ActionRegistry,
    platform: Platform,
    messages: KeybindingMessages,
  ) {
    this.#settings = settings;
    this.#actions = actions;
    this.platform = platform;
    this.#messages = messages;
  }

  subscribe = this.#emitter.subscribe;
  /** Changes with every change of the bindings. */
  getSnapshot = (): number => this.#revision;

  async load(): Promise<void> {
    const reading = await readSetting(this.#settings, SETTINGS_KEY, parseSaved);
    if (reading.kind === "broken") this.#messages.restoreFailed();
    if (reading.kind === "ok") this.#adopt(reading.value);
    this.#rebuild();
    this.#settings.listen(SETTINGS_KEY, (value) => {
      const saved = parseSaved(value);
      if (!saved) return;
      this.#adopt(saved);
      this.#rebuild();
    });
  }

  keysFor(actionId: string): readonly KeyCombo[] {
    return this.#keys.get(actionId) ?? [];
  }

  /** The action that has this combination, among those of a panel or those for everywhere. */
  ownerOf(combo: KeyCombo, scope?: string): string | undefined {
    return this.#owners.get(slot(combo, scope));
  }

  isCustomized(actionId: string): boolean {
    return this.#overrides.has(actionId);
  }

  get hasCustomizations(): boolean {
    return this.#overrides.size > 0;
  }

  /** Gives a combination to an action, taking it away from the action that had it. */
  assign(actionId: string, combo: KeyCombo): void {
    const owner = this.ownerOf(combo, this.#actions.get(actionId)?.scope);
    if (owner === actionId) return;
    if (owner)
      this.#override(
        owner,
        this.keysFor(owner).filter((key) => key !== combo),
      );
    this.#override(actionId, [...this.keysFor(actionId), combo]);
    this.#changed();
  }

  remove(actionId: string, combo: KeyCombo): void {
    this.#override(
      actionId,
      this.keysFor(actionId).filter((key) => key !== combo),
    );
    this.#changed();
  }

  reset(actionId: string): void {
    this.#overrides.delete(actionId);
    this.#changed();
  }

  resetAll(): void {
    this.#overrides.clear();
    this.#changed();
  }

  /** Takes note of the panel people are working in. */
  notePanel(panel: string | undefined): void {
    this.#panel = panel;
  }

  /** Runs the action of a key press, if it has one. */
  handle(event: KeyDown): void {
    // During composition the keys belong to the input method.
    if (event.defaultPrevented || event.isComposing) return;
    const combo = comboOf(event, this.platform);
    if (!combo) return;
    const action = this.#actionFor(combo, this.#scopeOf(event.target));
    if (!action) return;
    if (isTextEntry(event.target) && !worksWhileTyping(combo)) return;
    if (isSlider(event.target) && SLIDER_KEYS.has(combo)) return;
    // Also for a key that is held down, or the browser would get it the second time around.
    event.preventDefault();
    if (!event.repeat || action.repeats) action.run();
  }

  /**
   * The panel in use, even when the focus is in a tab or on the status bar. Only the command palette
   * and menus are something else people are doing, and then panels do not get their keys.
   */
  #scopeOf(target: EventTarget | null): string | undefined {
    const panel = panelOf(target);
    if (panel === undefined && (isTextEntry(target) || isInMenu(target))) return undefined;
    return this.#panel ?? panel;
  }

  #actionFor(combo: KeyCombo, panel: string | undefined): Action | undefined {
    const ids = [this.ownerOf(combo, panel), this.ownerOf(combo)];
    return ids
      .map((id) => (id === undefined ? undefined : this.#actions.get(id)))
      .find((action) => action !== undefined && action.enabled?.() !== false);
  }

  #adopt(saved: SavedKeybindings): void {
    this.#overrides.clear();
    for (const [id, keys] of Object.entries(saved.overrides)) this.#overrides.set(id, keys);
  }

  #override(actionId: string, keys: readonly KeyCombo[]): void {
    const defaults = this.#actions.get(actionId)?.keys ?? [];
    if (sameKeys(keys, defaults)) this.#overrides.delete(actionId);
    else this.#overrides.set(actionId, keys);
  }

  /** The person's choices come first, so a new default never takes a key away from them. */
  #rebuild(): void {
    const owners = new Map<string, string>();
    const keys = new Map<string, readonly KeyCombo[]>();
    const claim = (id: string, wanted: readonly KeyCombo[]) => {
      const { scope } = this.#actions.get(id) ?? {};
      const mine = wanted.filter((combo) => !owners.has(slot(combo, scope)));
      for (const combo of mine) owners.set(slot(combo, scope), id);
      keys.set(id, mine);
    };
    for (const [id, wanted] of this.#overrides) claim(id, wanted);
    for (const action of this.#actions.list()) {
      if (!this.#overrides.has(action.id)) claim(action.id, action.keys ?? []);
    }
    this.#owners = owners;
    this.#keys = keys;
    this.#revision += 1;
    this.#emitter.emit();
  }

  #changed(): void {
    this.#rebuild();
    void this.#save();
  }

  async #save(): Promise<void> {
    const saved: SavedKeybindings = {
      version: FORMAT_VERSION,
      overrides: Object.fromEntries(this.#overrides),
    };
    try {
      await this.#settings.save(SETTINGS_KEY, saved);
      this.#saveFailed = false;
    } catch (error) {
      console.warn("Keybindings could not be saved", error);
      if (!this.#saveFailed) this.#messages.saveFailed();
      this.#saveFailed = true;
    }
  }
}
