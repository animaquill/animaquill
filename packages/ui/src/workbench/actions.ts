import type { TFunction } from "i18next";
import type { KeyCombo } from "./keys.ts";

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
  /** Items of the same group stay together in the menu, in the order they were registered. */
  readonly menu?: {
    readonly name: string;
    readonly group: string;
    /** A shorter name, because the menu already gives the context. */
    readonly title?: (t: TFunction) => string;
  };
  /** Marks one choice among several, such as the current workspace. */
  readonly selected?: () => boolean;
  /** False for actions that make no sense from the command palette. */
  readonly palette?: false;
}

export class ActionRegistry {
  readonly #actions = new Map<string, Action>();

  register(action: Action): void {
    if (this.#actions.has(action.id)) throw new Error(`Action already registered: ${action.id}`);
    this.#actions.set(action.id, action);
  }

  get(id: string): Action | undefined {
    return this.#actions.get(id);
  }

  list(): readonly Action[] {
    return [...this.#actions.values()];
  }

  /** The groups of a menu, in the order they first appeared. */
  menu(name: string): readonly (readonly Action[])[] {
    const groups = new Map<string, Action[]>();
    for (const action of this.#actions.values()) {
      if (action.menu?.name !== name) continue;
      const group = groups.get(action.menu.group);
      if (group) group.push(action);
      else groups.set(action.menu.group, [action]);
    }
    return [...groups.values()];
  }
}
