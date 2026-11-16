import type { TFunction } from "i18next";
import type { KeyCombo } from "./keys.ts";

/** Where an action is in a menu. */
export interface ActionMenu {
  readonly name: string;
  readonly group: string;
  /** A shorter name, because the menu already gives the context. */
  readonly title?: (t: TFunction) => string;
  /** Its group comes at the end of the menu, whatever was registered after it. */
  readonly last?: true;
}

/** An action as one menu has it: with only the place it has there. */
export type MenuAction = Action & { readonly menu: ActionMenu };

/**
 * Something the interface can do, such as opening a panel. Menus use these, and the command
 * palette and key bindings will too. Changes to the project are not actions: those go through
 * the command system, so that they can be validated and undone.
 */
export interface Action {
  readonly id: string;
  /** The full name, as the command palette and the list of shortcuts show it. */
  readonly title: (t: TFunction) => string;
  readonly run: () => void;
  /** Default keys. People can change them, so ask KeybindingService for the current ones. */
  readonly keys?: readonly KeyCombo[];
  /**
   * Items of the same group stay together in the menu, in the order they were registered. Several
   * when people look for it in more than one menu, such as the settings.
   */
  readonly menu?: ActionMenu | readonly ActionMenu[];
  /** Marks one choice among several, such as the current layout. */
  readonly selected?: () => boolean;
  /**
   * Marks how things are, such as a panel being in the layout, without choosing the action
   * changing it: menus tick it and screen readers hear it, but it is no on and off.
   */
  readonly ticked?: () => boolean;
  /** False for actions that make no sense from the command palette. */
  readonly palette?: false;
  /** Whether it can run right now. Menus grey it out, the palette leaves it out. */
  readonly enabled?: () => boolean;
  /**
   * Whether it has a place here at all, as moving a project into a folder has only for a project
   * of the browser. Menus and the palette leave out what has none; its keys do nothing then.
   */
  readonly visible?: () => boolean;
  /** The panel it belongs to. Its keys only work there, so that panels can use the same keys. */
  readonly scope?: string;
  /** Keeps running while the key is held down, like moving through frames. */
  readonly repeats?: boolean;
}

/** How people got an action to run. */
export type ActionWay = "menu" | "palette" | "keys";

/** Actions that come and go, such as one for each of people's own layouts. */
export type ActionSource = () => readonly Action[];

export class ActionRegistry {
  readonly #actions = new Map<string, Action>();
  /** Single actions and sources, in the order they came, which is the order of menus. */
  readonly #entries: (Action | ActionSource)[] = [];
  readonly #sources: ActionSource[] = [];
  readonly #watchers = new Set<(action: Action, way: ActionWay) => void>();

  /** Runs an action for people. Whoever watches hears of it first, so that it is on record if it fails. */
  perform(action: Action, way: ActionWay): void {
    for (const watcher of this.#watchers) watcher(action, way);
    action.run();
  }

  /** Returns how to stop. */
  watch(watcher: (action: Action, way: ActionWay) => void): () => void {
    this.#watchers.add(watcher);
    return () => this.#watchers.delete(watcher);
  }

  register(action: Action): void {
    if (this.#actions.has(action.id)) throw new Error(`Action already registered: ${action.id}`);
    this.#actions.set(action.id, action);
    this.#entries.push(action);
  }

  /**
   * Adds actions that are asked for each time, so that they can change. Their ids must not be those
   * of registered actions. Whoever keeps key bindings has to be told when they change.
   */
  provide(source: ActionSource): void {
    this.#sources.push(source);
    this.#entries.push(source);
  }

  get(id: string): Action | undefined {
    const action = this.#actions.get(id);
    if (action) return action;
    for (const source of this.#sources) {
      const found = source().find((provided) => provided.id === id);
      if (found) return found;
    }
    return undefined;
  }

  list(): readonly Action[] {
    return this.#entries.flatMap((entry) => (typeof entry === "function" ? entry() : [entry]));
  }

  /** The groups of a menu, in the order they first appeared, without what has no place now. */
  menu(name: string): readonly (readonly MenuAction[])[] {
    const groups = new Map<string, MenuAction[]>();
    const last = new Set<string>();
    for (const action of this.list()) {
      if (!action.menu || action.visible?.() === false) continue;
      const places: readonly ActionMenu[] = "name" in action.menu ? [action.menu] : action.menu;
      const place = places.find((menu) => menu.name === name);
      if (!place) continue;
      const item = { ...action, menu: place };
      if (place.last) last.add(place.group);
      const group = groups.get(place.group);
      if (group) group.push(item);
      else groups.set(place.group, [item]);
    }
    const order = [...groups.keys()];
    return [...order.filter((key) => !last.has(key)), ...order.filter((key) => last.has(key))].map(
      (key) => groups.get(key) ?? [],
    );
  }
}
