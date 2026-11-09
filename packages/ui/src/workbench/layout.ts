import type { SettingsStore, WindowMemory } from "@animaquill/host";
import type { TFunction } from "i18next";
import { Emitter } from "./emitter.ts";
import { readSetting } from "./settings.ts";

/** A layout in terms of the editor, not of the docking library. */
export type LayoutNode = LayoutSplit | LayoutTabs;

export interface LayoutSplit {
  readonly kind: "split";
  readonly direction: "row" | "column";
  /** Each child with its share of the space. Shares are relative, so they need not add up to 100. */
  readonly children: readonly (readonly [share: number, node: LayoutNode])[];
}

/** Where the tabs of a group are: across the top, or down its left or right side. */
export type TabStrip = "top" | "left" | "right";

export interface LayoutTabs {
  readonly kind: "tabs";
  readonly panels: readonly string[];
  /** The tab that shows. The first one when left out, or when it is not there. */
  readonly active?: string;
  /** Across the top when left out. */
  readonly strip?: TabStrip;
  /** Only for tabs down a side: names next to the icons all the time. Only icons when left out. */
  readonly pinned?: boolean;
}

/** A layout that comes with the editor. */
export interface LayoutPreset {
  readonly id: string;
  readonly title: (t: TFunction) => string;
  /**
   * May name panels that do not exist yet, or are still placeholders. They are left out until they
   * are ready, and then take their place here, also in layouts that people have changed since.
   */
  readonly layout: LayoutNode;
}

/** A layout people can switch to: one of the presets, or one of their own. */
export interface LayoutChoice {
  readonly id: string;
  readonly title: (t: TFunction) => string;
  readonly custom: boolean;
}

export interface DockItem {
  readonly type: string;
  /** False when another tab of the same group covers this one. */
  readonly visible: boolean;
}

/** The tabs of a group that a panel goes between, the nearest first. */
export interface PanelNeighbours {
  readonly before: readonly string[];
  readonly after: readonly string[];
}

/** All that the workbench asks of the docking library. */
export interface Dock {
  /** Nothing at all when there is no layout. */
  arrange(layout: LayoutNode | undefined): void;
  /** Throws when the state cannot be used. */
  restore(state: unknown): void;
  serialize(): unknown;
  open(type: string): void;
  /** Adds a panel next to the first of its neighbours that is there, without showing it. */
  add(type: string, neighbours: PanelNeighbours): void;
  items(): readonly DockItem[];
  /** The panel people are working in. */
  active(): string | undefined;
  onChange(listener: () => void): () => void;
}

export interface LayoutSnapshot {
  /** The layout this window shows. */
  readonly layout: string;
  readonly layouts: readonly LayoutChoice[];
  readonly visible: ReadonlySet<string>;
  readonly active: string | undefined;
}

export interface LayoutMessages {
  restoreFailed(): void;
  saveFailed(): void;
}

/** How a layout was arranged, and which panels there were to arrange at the time. */
interface Arrangement {
  readonly dock: unknown;
  readonly panels: readonly string[];
}

interface CustomLayout {
  readonly id: string;
  readonly name: string;
  /** The preset it came from, for the panels that come later. */
  readonly base: string;
  /** What it looked like when it was saved, for putting it back. */
  readonly design: Arrangement;
}

interface SavedLayouts {
  readonly version: typeof FORMAT_VERSION;
  /** Where a new window starts: the layout chosen last, in any window. */
  current: string;
  custom: CustomLayout[];
  /** Each layout remembers how the person arranged it. */
  states: Record<string, Arrangement>;
}

const SETTINGS_KEY = "layout";
const WINDOW_KEY = "layout";
const FORMAT_VERSION = 3;
/**
 * Formats of before the launch, which are dropped without a word, and without a migration: 1 had
 * workspaces, as layouts were called before people could have their own, and 2 strips that showed
 * names unless they were told not to.
 */
const RETIRED_VERSIONS: readonly unknown[] = [1, 2];
const RETIRED = Symbol("retired");
const SAVE_DELAY_MS = 500;
/** Long enough for any name worth giving, short enough for a menu. */
export const LAYOUT_NAME_MAX = 40;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isStrings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

function parseArrangement(value: unknown): Arrangement | undefined {
  if (!isObject(value) || !isObject(value["dock"]) || !isStrings(value["panels"])) return undefined;
  return { dock: value["dock"], panels: value["panels"] };
}

function parseCustom(value: unknown): CustomLayout | undefined {
  if (!isObject(value)) return undefined;
  const { id, name, base } = value;
  const design = parseArrangement(value["design"]);
  if (typeof id !== "string" || typeof name !== "string" || typeof base !== "string") {
    return undefined;
  }
  return design && { id, name, base, design };
}

function parseSaved(value: unknown): SavedLayouts | typeof RETIRED | undefined {
  if (!isObject(value)) return undefined;
  if (RETIRED_VERSIONS.includes(value["version"])) return RETIRED;
  const { version, current, custom, states } = value;
  if (version !== FORMAT_VERSION || typeof current !== "string") return undefined;
  if (!Array.isArray(custom) || !isObject(states)) return undefined;
  const layouts: CustomLayout[] = [];
  for (const item of custom) {
    const layout = parseCustom(item);
    if (!layout) return undefined;
    layouts.push(layout);
  }
  const arrangements: Record<string, Arrangement> = {};
  for (const [id, state] of Object.entries(states)) {
    const arrangement = parseArrangement(state);
    if (!arrangement) return undefined;
    arrangements[id] = arrangement;
  }
  return { version, current, custom: layouts, states: arrangements };
}

/** The panels of a layout, in order. */
export function panelsOf(node: LayoutNode): string[] {
  if (node.kind === "tabs") return [...node.panels];
  return node.children.flatMap(([, child]) => panelsOf(child));
}

/**
 * The layout with only the panels to keep. Groups left empty go, and so do splits with one part
 * left, so that nothing on screen is an empty box.
 */
export function pruneLayout(
  node: LayoutNode,
  keep: (type: string) => boolean,
): LayoutNode | undefined {
  if (node.kind === "tabs") {
    const panels = node.panels.filter(keep);
    if (panels.length === 0) return undefined;
    const { active, ...rest } = node;
    return active !== undefined && panels.includes(active)
      ? { ...rest, panels, active }
      : { ...rest, panels };
  }
  const children: (readonly [number, LayoutNode])[] = [];
  for (const [share, child] of node.children) {
    const kept = pruneLayout(child, keep);
    if (!kept) continue;
    if (kept.kind === "split" && kept.direction === node.direction) {
      // What is left of a part runs the same way as this split, so its parts become parts of this.
      const total = kept.children.reduce((sum, [part]) => sum + part, 0);
      for (const [part, grandchild] of kept.children) {
        children.push([(share * part) / total, grandchild]);
      }
    } else {
      children.push([share, kept]);
    }
  }
  const [only] = children;
  if (!only) return undefined;
  if (children.length === 1) return only[1];
  return { ...node, children };
}

/** The tabs a panel sits between in a layout, the nearest first. */
export function neighboursIn(node: LayoutNode, type: string): PanelNeighbours | undefined {
  if (node.kind === "tabs") {
    const index = node.panels.indexOf(type);
    if (index === -1) return undefined;
    return {
      before: node.panels.slice(0, index).toReversed(),
      after: node.panels.slice(index + 1),
    };
  }
  for (const [, child] of node.children) {
    const found = neighboursIn(child, type);
    if (found) return found;
  }
  return undefined;
}

/** The name as it will show, or nothing when there is nothing to show. */
function cleanName(name: string): string | undefined {
  const clean = name.replace(/\s+/g, " ").trim().slice(0, LAYOUT_NAME_MAX);
  return clean || undefined;
}

/** Decides which layout is on screen, keeps it across visits, and keeps people's own layouts. */
export class LayoutController {
  readonly #settings: SettingsStore;
  readonly #memory: WindowMemory;
  readonly #presets: readonly LayoutPreset[];
  readonly #first: LayoutPreset;
  /** The panels that can be shown. The others are still to come. */
  readonly #available: () => ReadonlySet<string>;
  readonly #messages: LayoutMessages;
  readonly #emitter = new Emitter();
  #dock: Dock | undefined;
  /** What this window shows. Other windows have their own. */
  #layout: string;
  #saved: SavedLayouts;
  #choices: readonly LayoutChoice[];
  #snapshot: LayoutSnapshot;
  #stopListening: (() => void) | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #saveFailed = false;
  /** What the store holds, so that only real changes are written. */
  #written = "";

  constructor(
    settings: SettingsStore,
    memory: WindowMemory,
    presets: readonly LayoutPreset[],
    available: () => ReadonlySet<string>,
    messages: LayoutMessages,
  ) {
    const first = presets[0];
    if (!first) throw new Error("At least one layout is required");
    this.#settings = settings;
    this.#memory = memory;
    this.#presets = presets;
    this.#first = first;
    this.#available = available;
    this.#messages = messages;
    this.#layout = first.id;
    this.#saved = { version: FORMAT_VERSION, current: first.id, custom: [], states: {} };
    this.#choices = this.#listChoices();
    this.#snapshot = {
      layout: first.id,
      layouts: this.#choices,
      visible: new Set(),
      active: undefined,
    };
  }

  subscribe = this.#emitter.subscribe;
  getSnapshot = (): LayoutSnapshot => this.#snapshot;

  /** Reads what was saved. Whatever goes wrong, the editor still opens with a default layout. */
  async load(): Promise<void> {
    const reading = await readSetting(this.#settings, SETTINGS_KEY, parseSaved);
    if (reading.kind === "broken") this.#messages.restoreFailed();
    if (reading.kind === "ok" && reading.value !== RETIRED) this.#take(reading.value);
    this.#layout = this.#startingLayout();
    this.#refresh();
    this.#settings.listen(SETTINGS_KEY, (value) => this.#adopt(value));
  }

  /** Hands over the docking library once it exists. */
  attach(dock: Dock): void {
    this.#stopListening?.();
    this.#dock = dock;
    // Only now, because a window on the start page has not chosen anything yet. From here on the
    // window stays where it is, whatever happens in other windows.
    this.#layout = this.#startingLayout();
    this.#memory.write(WINDOW_KEY, this.#layout);
    this.#apply();
    this.#capture();
    this.#written = JSON.stringify(this.#saved);
    this.#stopListening = dock.onChange(() => {
      this.#refresh();
      this.#scheduleSave();
    });
  }

  /** Lets go of the dock before it goes away, keeping how it was arranged. */
  async detach(): Promise<void> {
    this.#cancelSave();
    if (this.#dock) await this.#save();
    this.#stopListening?.();
    this.#stopListening = undefined;
    this.#dock = undefined;
  }

  switchLayout(id: string): void {
    if (id === this.#layout || !this.#find(id)) return;
    this.#capture();
    this.#show(id);
    // At once, unlike other changes: the arrangement just captured is no longer on screen, and news
    // from another window would replace it before a delayed save got to it.
    this.#saveNow();
  }

  /** Puts the current layout back as it was designed or saved. The others keep their arrangement. */
  resetLayout(): void {
    delete this.#saved.states[this.#layout];
    this.#apply();
    this.#scheduleSave();
  }

  /** Keeps what is on screen as a layout of its own, and switches to it. Returns its id. */
  saveAs(name: string): string | undefined {
    const title = cleanName(name);
    if (!title || !this.#dock) return undefined;
    this.#capture();
    const design = this.#saved.states[this.#layout];
    if (!design) return undefined;
    const id = `custom-${crypto.randomUUID()}`;
    const base = this.#presetOf(this.#layout).id;
    this.#saved.custom = [...this.#saved.custom, { id, name: title, base, design }];
    this.#saved.states[id] = design;
    this.#choices = this.#listChoices();
    this.#choose(id);
    this.#refresh();
    this.#saveNow();
    return id;
  }

  /** Only people's own layouts have a name to change. */
  rename(id: string, name: string): void {
    const title = cleanName(name);
    if (!title || !this.#custom(id)) return;
    this.#saved.custom = this.#saved.custom.map((layout) =>
      layout.id === id ? { ...layout, name: title } : layout,
    );
    this.#choices = this.#listChoices();
    this.#refresh();
    this.#saveNow();
  }

  /** Only people's own layouts can go. A window that shows one goes to the first preset. */
  remove(id: string): void {
    if (!this.#custom(id)) return;
    this.#saved.custom = this.#saved.custom.filter((layout) => layout.id !== id);
    delete this.#saved.states[id];
    if (this.#saved.current === id) this.#saved.current = this.#first.id;
    this.#choices = this.#listChoices();
    if (this.#layout === id) this.#show(this.#first.id);
    else this.#refresh();
    this.#saveNow();
  }

  isCustom(id: string): boolean {
    return this.#custom(id) !== undefined;
  }

  openPanel(type: string): void {
    this.#dock?.open(type);
  }

  /**
   * Drops every saved arrangement: the way out when one of them keeps the editor from starting.
   * People's own layouts stay in the list, but the window goes back to the first preset.
   */
  async forget(): Promise<void> {
    this.#cancelSave();
    this.#saved = { ...this.#saved, current: this.#first.id, states: {} };
    this.#memory.write(WINDOW_KEY, this.#first.id);
    await this.#settings.save(SETTINGS_KEY, this.#saved);
  }

  /** Saves right away, for when the page is about to go. */
  async flush(): Promise<void> {
    if (this.#timer === undefined) return;
    this.#cancelSave();
    await this.#save();
  }

  #listChoices(): readonly LayoutChoice[] {
    return [
      ...this.#presets.map(({ id, title }) => ({ id, title, custom: false })),
      ...this.#saved.custom.map(({ id, name }) => ({ id, title: () => name, custom: true })),
    ];
  }

  #find(id: string): LayoutChoice | undefined {
    return this.#choices.find((choice) => choice.id === id);
  }

  #custom(id: string): CustomLayout | undefined {
    return this.#saved.custom.find((layout) => layout.id === id);
  }

  /** The preset a layout is, or came from. */
  #presetOf(id: string): LayoutPreset {
    const base = this.#custom(id)?.base ?? id;
    return this.#presets.find((preset) => preset.id === base) ?? this.#first;
  }

  #take(saved: SavedLayouts): void {
    this.#saved = saved;
    this.#choices = this.#listChoices();
    if (!this.#find(saved.current)) saved.current = this.#first.id;
  }

  /** A window stays in its layout through a reload. A new one starts where people left off. */
  #startingLayout(): string {
    const own = this.#memory.read(WINDOW_KEY);
    return own !== undefined && this.#find(own) ? own : this.#saved.current;
  }

  /** Makes a layout the one of this window, and the one new windows start with. */
  #choose(id: string): void {
    this.#layout = id;
    this.#saved.current = id;
    this.#memory.write(WINDOW_KEY, id);
  }

  #show(id: string): void {
    this.#choose(id);
    this.#apply();
  }

  /**
   * Takes over what another window saved, so that saving here does not bring old arrangements back.
   * What this window shows stays as it is, and counts again as soon as it changes, unless its
   * layout was deleted over there.
   */
  #adopt(value: unknown): void {
    const saved = parseSaved(value);
    if (!saved || saved === RETIRED) return;
    this.#take(saved);
    this.#written = JSON.stringify(saved);
    if (this.#find(this.#layout)) {
      this.#refresh();
    } else if (this.#dock) {
      this.#layout = this.#first.id;
      this.#memory.write(WINDOW_KEY, this.#layout);
      this.#apply();
    } else {
      this.#layout = this.#startingLayout();
      this.#refresh();
    }
  }

  #apply(): void {
    const dock = this.#dock;
    if (!dock) return;
    const id = this.#layout;
    const preset = this.#presetOf(id);
    const available = this.#available();
    let failed = false;
    let shown: Arrangement | undefined;
    for (const arrangement of [this.#saved.states[id], this.#custom(id)?.design]) {
      if (!arrangement) continue;
      try {
        dock.restore(arrangement.dock);
        shown = arrangement;
        break;
      } catch (error) {
        console.warn(`Saved layout of ${id} is unusable`, error);
        if (arrangement === this.#saved.states[id]) delete this.#saved.states[id];
        failed = true;
      }
    }
    if (shown) this.#addNewcomers(dock, shown, preset, available);
    else dock.arrange(pruneLayout(preset.layout, (type) => available.has(type)));
    if (failed) this.#messages.restoreFailed();
    this.#refresh();
  }

  /** Panels that are ready now, and were not when the layout was arranged, take their place. */
  #addNewcomers(
    dock: Dock,
    arrangement: Arrangement,
    preset: LayoutPreset,
    available: ReadonlySet<string>,
  ): void {
    const known = new Set(arrangement.panels);
    const there = new Set(dock.items().map((item) => item.type));
    for (const type of panelsOf(preset.layout)) {
      if (!available.has(type) || known.has(type) || there.has(type)) continue;
      const neighbours = neighboursIn(preset.layout, type);
      if (neighbours) dock.add(type, neighbours);
      there.add(type);
    }
  }

  #refresh(): void {
    const visible = new Set<string>();
    for (const item of this.#dock?.items() ?? []) if (item.visible) visible.add(item.type);
    this.#snapshot = {
      layout: this.#layout,
      layouts: this.#choices,
      visible,
      active: this.#dock?.active(),
    };
    this.#emitter.emit();
  }

  #capture(): void {
    // A layout that another window deleted does not come back this way.
    if (!this.#dock || !this.#find(this.#layout)) return;
    this.#saved.states[this.#layout] = {
      dock: this.#dock.serialize(),
      panels: [...this.#available()].toSorted(),
    };
  }

  #cancelSave(): void {
    clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  #scheduleSave(): void {
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.#save();
    }, SAVE_DELAY_MS);
  }

  #saveNow(): void {
    this.#cancelSave();
    void this.#save();
  }

  async #save(): Promise<void> {
    this.#capture();
    const text = JSON.stringify(this.#saved);
    if (text === this.#written) return;
    try {
      await this.#settings.save(SETTINGS_KEY, this.#saved);
      this.#written = text;
      this.#saveFailed = false;
    } catch (error) {
      console.warn("Layout could not be saved", error);
      if (!this.#saveFailed) this.#messages.saveFailed();
      this.#saveFailed = true;
    }
  }
}
