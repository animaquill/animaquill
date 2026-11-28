import type { TFunction } from "i18next";
import type zhCN from "../i18n/zh-CN.json";
import type { SettingsGroup } from "../workbench/settings-nav.ts";

type Items = (typeof zhCN)["settings"]["items"];

/** What a setting is known by: its group in the texts, and its own name there. */
export type SettingId = {
  [G in keyof Items]: `${G & string}.${keyof Items[G] & string}`;
}[keyof Items];

/**
 * Where a setting is kept, as the settings show left of it in the online mode: on this device only
 * (the device's preferences, docs/design/online-offline.md of AnimaQuill Cloud, 2.1), or on the
 * backend (the AI settings).
 */
export type SettingWhere = "device" | "account";

/**
 * One setting, as searching finds it and as the settings go to it: its group, and where it is kept.
 * What it is called and other words people may look for it by are in the texts, under
 * `settings.items.<id>`: `name` and `keywords`, and `help` where what it does needs saying under
 * its name (most do not: a setting should be clear without it).
 */
export interface SettingItem {
  readonly id: SettingId;
  readonly group: SettingsGroup;
  readonly where?: SettingWhere;
}

/**
 * Every setting there is, in the order of the groups and of each group (docs/design/
 * settings-and-properties.md of AnimaQuill Cloud, 1 and 4.3). The groups that show a page of their
 * own (AI models, model packs) have theirs here too, so that searching finds them.
 */
export const SETTING_ITEMS: readonly SettingItem[] = [
  { id: "general.language", group: "general", where: "device" },
  { id: "general.theme", group: "general", where: "device" },
  { id: "general.fontSize", group: "general", where: "device" },
  { id: "editing.trial", group: "editing", where: "device" },
  { id: "editing.removeEmptyTracks", group: "editing", where: "device" },
  { id: "playback.proxyOffer", group: "playback", where: "device" },
  { id: "export.hardware", group: "export", where: "device" },
  { id: "keys.bindings", group: "keys", where: "device" },
  { id: "models.services", group: "models", where: "account" },
  { id: "models.default", group: "models", where: "account" },
  { id: "models.reasoning", group: "models", where: "account" },
  { id: "models.headers", group: "models", where: "account" },
  { id: "models.list", group: "models", where: "account" },
  { id: "models.details", group: "models", where: "account" },
  { id: "packs.installed", group: "packs", where: "account" },
  { id: "packs.hidden", group: "packs", where: "account" },
  { id: "chat.maxToolCalls", group: "chat", where: "account" },
  { id: "chat.askBeforeEdit", group: "chat", where: "account" },
  { id: "chat.fromAgents", group: "chat", where: "account" },
  { id: "chat.autoTitle", group: "chat", where: "account" },
  { id: "chat.expandThinking", group: "chat", where: "account" },
  { id: "chat.sendWith", group: "chat", where: "account" },
  { id: "chat.shotSize", group: "chat", where: "account" },
  { id: "chat.lookSize", group: "chat", where: "account" },
  { id: "chat.lookWaits", group: "chat", where: "account" },
  { id: "chat.autoCompact", group: "chat", where: "account" },
  { id: "localAi.connect", group: "localAi" },
  { id: "localAi.recent", group: "localAi" },
  { id: "localAi.autoConnect", group: "localAi", where: "device" },
  { id: "localAi.agentsFile", group: "localAi", where: "device" },
  { id: "account.who", group: "account" },
  { id: "account.github", group: "account" },
  { id: "account.space", group: "account" },
  { id: "account.server", group: "account" },
  { id: "account.chatImages", group: "account" },
  { id: "server.masterKey", group: "server" },
  { id: "server.dataDir", group: "server" },
  { id: "server.database", group: "server" },
  { id: "server.old", group: "server" },
  { id: "server.backup", group: "server" },
  { id: "storage.persist", group: "storage", where: "device" },
  { id: "storage.keys", group: "storage", where: "device" },
  { id: "storage.chats", group: "storage", where: "device" },
  { id: "storage.undo", group: "storage", where: "device" },
  { id: "storage.usage", group: "storage", where: "device" },
  { id: "storage.leftOver", group: "storage", where: "device" },
  { id: "storage.clear", group: "storage", where: "device" },
  { id: "about.version", group: "about" },
  { id: "about.license", group: "about" },
  { id: "about.feedback", group: "about" },
  { id: "about.performance", group: "about" },
];

const itemsById = new Map<string, SettingItem>(SETTING_ITEMS.map((item) => [item.id, item]));

export const settingItem = (id: string): SettingItem | undefined => itemsById.get(id);

/** What searching found: a setting, and how well, the best first. */
export interface SettingMatch {
  readonly item: SettingItem;
  readonly name: string;
  readonly group: string;
}

const fold = (text: string) => text.toLowerCase().normalize("NFKC");

/**
 * The settings that every word of `query` is found in: in its name, what it does, the words it is
 * also known by, or the name of its group. Those whose name has it come first. Only of `groups`,
 * the groups there are now.
 */
export function searchSettings(
  t: TFunction,
  query: string,
  groups: readonly SettingsGroup[],
): readonly SettingMatch[] {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const found: (SettingMatch & { readonly rank: number })[] = [];
  for (const item of SETTING_ITEMS) {
    if (!groups.includes(item.group)) continue;
    const name = t(`settings.items.${item.id}.name`);
    const group = t(`settings.groups.${item.group}`);
    const named = fold(`${name} ${group}`);
    const all = fold(
      `${named} ${t(`settings.items.${item.id}.help`, { defaultValue: "" })} ${t(`settings.items.${item.id}.keywords`)}`,
    );
    if (!words.every((word) => all.includes(word))) continue;
    const rank = words.every((word) => fold(name).includes(word))
      ? 0
      : words.every((word) => named.includes(word))
        ? 1
        : 2;
    found.push({ item, name, group, rank });
  }
  return found
    .toSorted((a, b) => a.rank - b.rank)
    .map(({ item, name, group }) => ({ item, name, group }));
}
