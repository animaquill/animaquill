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

export interface LayoutTabs {
  readonly kind: "tabs";
  /** The first tab is the visible one. */
  readonly panels: readonly string[];
}

/** A named arrangement of panels for one kind of work. */
export interface WorkspaceDefinition {
  readonly id: string;
  readonly title: (t: TFunction) => string;
  readonly layout: LayoutNode;
}

export interface DockItem {
  readonly type: string;
  /** False when another tab of the same group covers this one. */
  readonly visible: boolean;
}

/** All that the workbench asks of the docking library. */
export interface Dock {
  arrange(layout: LayoutNode): void;
  /** Throws when the state cannot be used. */
  restore(state: unknown): void;
  serialize(): unknown;
  open(type: string): void;
  items(): readonly DockItem[];
  /** The panel people are working in. */
  active(): string | undefined;
  onChange(listener: () => void): () => void;
}

export interface LayoutSnapshot {
  readonly workspace: string;
  readonly visible: ReadonlySet<string>;
  readonly active: string | undefined;
}

export interface LayoutMessages {
  restoreFailed(): void;
  saveFailed(): void;
}

interface SavedLayouts {
  readonly version: typeof FORMAT_VERSION;
  /** Where a new window starts: the workspace chosen last, in any window. */
  workspace: string;
  /** Each workspace remembers how the person arranged it. */
  states: Record<string, unknown>;
}

const SETTINGS_KEY = "layout";
const WINDOW_KEY = "workspace";
const FORMAT_VERSION = 1;
const SAVE_DELAY_MS = 500;

function parseSaved(value: unknown): SavedLayouts | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { version, workspace, states } = value as Partial<SavedLayouts>;
  if (version !== FORMAT_VERSION || typeof workspace !== "string") return undefined;
  if (typeof states !== "object" || states === null) return undefined;
  return { version, workspace, states: { ...states } };
}

/** Decides which layout is on screen and keeps it across visits. */
export class LayoutController {
  readonly #settings: SettingsStore;
  readonly #memory: WindowMemory;
  readonly #workspaces: readonly WorkspaceDefinition[];
  readonly #messages: LayoutMessages;
  readonly #emitter = new Emitter();
  #dock: Dock | undefined;
  /** What this window shows. Other windows have their own. */
  #workspace: string;
  #saved: SavedLayouts;
  #snapshot: LayoutSnapshot;
  #stopListening: (() => void) | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #saveFailed = false;
  /** What the store holds, so that only real changes are written. */
  #written = "";

  constructor(
    settings: SettingsStore,
    memory: WindowMemory,
    workspaces: readonly WorkspaceDefinition[],
    messages: LayoutMessages,
  ) {
    const first = workspaces[0];
    if (!first) throw new Error("At least one workspace is required");
    this.#settings = settings;
    this.#memory = memory;
    this.#workspaces = workspaces;
    this.#messages = messages;
    this.#workspace = first.id;
    this.#saved = { version: FORMAT_VERSION, workspace: first.id, states: {} };
    this.#snapshot = { workspace: first.id, visible: new Set(), active: undefined };
  }

  subscribe = this.#emitter.subscribe;
  getSnapshot = (): LayoutSnapshot => this.#snapshot;

  get workspaces(): readonly WorkspaceDefinition[] {
    return this.#workspaces;
  }

  /** Reads what was saved. Whatever goes wrong, the editor still opens with a default layout. */
  async load(): Promise<void> {
    const reading = await readSetting(this.#settings, SETTINGS_KEY, parseSaved);
    if (reading.kind === "broken") this.#messages.restoreFailed();
    if (reading.kind === "ok") {
      const saved = reading.value;
      if (!this.#find(saved.workspace)) saved.workspace = this.#saved.workspace;
      this.#saved = saved;
    }
    this.#workspace = this.#startingWorkspace();
    this.#snapshot = { ...this.#snapshot, workspace: this.#workspace };
    this.#settings.listen(SETTINGS_KEY, (value) => this.#adopt(value));
  }

  /** Hands over the docking library once it exists. */
  attach(dock: Dock): void {
    this.#stopListening?.();
    this.#dock = dock;
    // Only now, because a window on the start page has not chosen anything yet. From here on the
    // window stays where it is, whatever happens in other windows.
    this.#workspace = this.#startingWorkspace();
    this.#memory.write(WINDOW_KEY, this.#workspace);
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

  switchWorkspace(id: string): void {
    if (id === this.#workspace || !this.#find(id)) return;
    this.#capture();
    this.#workspace = id;
    this.#saved.workspace = id;
    this.#memory.write(WINDOW_KEY, id);
    this.#apply();
    // At once, unlike other changes: the arrangement just captured is no longer on screen, and news
    // from another window would replace it before a delayed save got to it.
    this.#cancelSave();
    void this.#save();
  }

  /** Puts the current workspace back as it was designed. The others keep their arrangement. */
  resetWorkspace(): void {
    delete this.#saved.states[this.#workspace];
    this.#apply();
    this.#scheduleSave();
  }

  openPanel(type: string): void {
    this.#dock?.open(type);
  }

  /** Drops every saved arrangement: the way out when one of them keeps the editor from starting. */
  async forget(): Promise<void> {
    this.#cancelSave();
    this.#saved = { ...this.#saved, states: {} };
    await this.#settings.save(SETTINGS_KEY, this.#saved);
  }

  /** Saves right away, for when the page is about to go. */
  async flush(): Promise<void> {
    if (this.#timer === undefined) return;
    this.#cancelSave();
    await this.#save();
  }

  #find(id: string): WorkspaceDefinition | undefined {
    return this.#workspaces.find((workspace) => workspace.id === id);
  }

  /** A window stays in its workspace through a reload. A new one starts where people left off. */
  #startingWorkspace(): string {
    const own = this.#memory.read(WINDOW_KEY);
    return own !== undefined && this.#find(own) ? own : this.#saved.workspace;
  }

  /**
   * Takes over what another window saved, so that saving here does not bring old arrangements back.
   * What this window shows stays as it is, and counts again as soon as it changes.
   */
  #adopt(value: unknown): void {
    const saved = parseSaved(value);
    if (!saved) return;
    this.#saved = saved;
    this.#written = JSON.stringify(saved);
  }

  #apply(): void {
    const dock = this.#dock;
    const workspace = this.#find(this.#workspace);
    if (!dock || !workspace) return;
    const state = this.#saved.states[workspace.id];
    if (state === undefined) {
      dock.arrange(workspace.layout);
    } else {
      try {
        dock.restore(state);
      } catch (error) {
        console.warn(`Saved layout of ${workspace.id} is unusable`, error);
        delete this.#saved.states[workspace.id];
        dock.arrange(workspace.layout);
        this.#messages.restoreFailed();
      }
    }
    this.#refresh();
  }

  #refresh(): void {
    const visible = new Set<string>();
    for (const item of this.#dock?.items() ?? []) if (item.visible) visible.add(item.type);
    this.#snapshot = { workspace: this.#workspace, visible, active: this.#dock?.active() };
    this.#emitter.emit();
  }

  #capture(): void {
    if (this.#dock) this.#saved.states[this.#workspace] = this.#dock.serialize();
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
