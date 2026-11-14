import type { WindowMemory } from "@animaquill/host";
import { Emitter } from "./emitter.ts";
import { Flag } from "./flag.ts";

/**
 * The groups of the settings, in the order of their list (docs/design/settings-and-properties.md of
 * AnimaQuill Cloud, 4.3). "电脑上的 AI 工具" comes with the local MCP (6.16a), not before. "cloud" only where people are signed in to a platform, "account" only
 * where there is a platform, see `visibleGroups`.
 */
export type SettingsGroup =
  | "general"
  | "editing"
  | "playback"
  | "export"
  | "keys"
  | "models"
  | "packs"
  | "chat"
  | "account"
  | "cloud"
  | "storage"
  | "about";

/** The groups in the order of the list, each in its section. */
export const SETTINGS_SECTIONS: readonly (readonly [
  section: "editor" | "ai" | "account" | "other",
  groups: readonly SettingsGroup[],
])[] = [
  ["editor", ["general", "editing", "playback", "export", "keys"]],
  ["ai", ["models", "packs", "chat"]],
  ["account", ["account", "cloud"]],
  ["other", ["storage", "about"]],
];

export const SETTINGS_GROUPS: readonly SettingsGroup[] = SETTINGS_SECTIONS.flatMap(
  ([, groups]) => groups,
);

export const isSettingsGroup = (value: unknown): value is SettingsGroup =>
  SETTINGS_GROUPS.includes(value as SettingsGroup);

/** What there is of the platform, which decides whether "account" and "cloud" are there. */
export interface GroupsShown {
  /** The host has accounts: the group of the account, signed in or not. */
  readonly account: boolean;
  /** People are signed in to a platform that has cloud features. */
  readonly cloud: boolean;
}

export const visibleGroups = (shown: GroupsShown): readonly SettingsGroup[] =>
  SETTINGS_GROUPS.filter(
    (group) => (group !== "account" || shown.account) && (group !== "cloud" || shown.cloud),
  );

/**
 * Where the settings of a window are: which group, and in the group of AI models which service, or
 * the cards of services to add, and a model of it. Where the settings are narrow they show one level
 * at a time, and `depth` is the level: the list of groups (0), a group (1), what a group opened
 * (2), a model of a service (3). Where they are wide, the list of groups and a group show side by
 * side, and only what a group opened counts.
 */
export interface SettingsPlace {
  readonly group: SettingsGroup;
  readonly depth: 0 | 1 | 2 | 3;
  /** The service shown, in the group of AI models. */
  readonly service?: string | undefined;
  /** The model of that service whose details are shown (`depth` 3). */
  readonly model?: string | undefined;
  /** The cards of services to add are shown, with one picked where it says which kind. */
  readonly adding?: true | string | undefined;
  /** Where to go once a service is added: back to the chat, which sent people here. */
  readonly back?: "chat" | undefined;
  /** A setting to show and make stand out for a moment, as one found by searching. */
  readonly item?: string | undefined;
}

/** Where the window keeps the group the settings were last in, see `WindowMemory`. */
const MEMORY_KEY = "settings.group";

/**
 * The settings of a window: whether they are open, and where in them, see `SettingsPlace`. Both are
 * the window's own; the group they were in last survives a reload, so that they open there again.
 */
export class SettingsNav {
  readonly #emitter = new Emitter();
  readonly #memory: WindowMemory | undefined;
  #place: SettingsPlace;
  /** Whether the settings are open in this window. */
  readonly shown = new Flag();

  constructor(memory?: WindowMemory) {
    this.#memory = memory;
    const kept = memory?.read(MEMORY_KEY);
    this.#place = { group: isSettingsGroup(kept) ? kept : "general", depth: 1 };
  }

  subscribe = this.#emitter.subscribe;
  getSnapshot = (): SettingsPlace => this.#place;

  get isOpen(): boolean {
    return this.shown.getSnapshot();
  }

  /** Opens the settings at a place, or in the group they were in last. */
  open(place?: SettingsPlace): void {
    this.go(place ?? { group: this.#place.group, depth: 1 });
    this.shown.set(true);
  }

  close(): void {
    this.shown.set(false);
  }

  go(place: SettingsPlace): void {
    this.#place = place;
    this.#memory?.write(MEMORY_KEY, place.group);
    this.#emitter.emit();
  }

  /** One level up, where the settings are narrow. */
  back(): void {
    const { group, depth, service } = this.#place;
    this.go(
      depth === 3
        ? { group, depth: 2, service }
        : depth === 2
          ? { group, depth: 1 }
          : { group, depth: 0 },
    );
  }
}
