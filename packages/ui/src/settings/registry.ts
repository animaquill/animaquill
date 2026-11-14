import type { TFunction } from "i18next";
import type zhCN from "../i18n/zh-CN.json";
import type { SettingsGroup } from "../workbench/settings-nav.ts";

type Items = (typeof zhCN)["settings"]["items"];

/** What a setting is known by: its group in the texts, and its own name there. */
export type SettingId = {
  [G in keyof Items]: `${G & string}.${keyof Items[G] & string}`;
}[keyof Items];

/**
 * Where a setting is kept, as the settings say beside it once people are signed in: on this device
 * only, with the account, or with the account where the AI settings go with it ("ai", see
 * `CloudSync`), else on this device.
 */
export type SettingWhere = "device" | "account" | "ai";

/**
 * One setting, as searching finds it and as the settings go to it: its group, and where it is kept.
 * What it is called, what it does and other words people may look for it by are in the texts, under
 * `settings.items.<id>`: `name`, `help` and `keywords`.
 */
export interface SettingItem {
  readonly id: SettingId;
  readonly group: SettingsGroup;
  readonly where?: SettingWhere;
}

/**
 * Every setting there is, in the order of the groups and of each group (docs/design/
 * settings-and-properties.md of AnimaQuill Cloud, 1 and 4.3). The groups that show a page of their
 * own (AI models, model packs, cloud sync) have theirs here too, so that searching finds them.
 */
export const SETTING_ITEMS: readonly SettingItem[] = [
  { id: "general.language", group: "general", where: "device" },
  { id: "general.theme", group: "general", where: "device" },
  { id: "general.fontSize", group: "general", where: "device" },
  { id: "general.input", group: "general", where: "device" },
  { id: "general.layout", group: "general", where: "device" },
  { id: "editing.trial", group: "editing", where: "device" },
  { id: "editing.snapping", group: "editing", where: "device" },
  { id: "editing.overwriting", group: "editing", where: "device" },
  { id: "editing.multiSelecting", group: "editing", where: "device" },
  { id: "editing.timecode", group: "editing" },
  { id: "playback.quality", group: "playback", where: "device" },
  { id: "playback.proxyOffer", group: "playback", where: "device" },
  { id: "export.quality", group: "export", where: "device" },
  { id: "export.hardware", group: "export", where: "device" },
  { id: "keys.bindings", group: "keys", where: "device" },
  { id: "models.services", group: "models", where: "ai" },
  { id: "models.default", group: "models", where: "ai" },
  { id: "models.reasoning", group: "models", where: "ai" },
  { id: "packs.choice", group: "packs", where: "ai" },
  { id: "packs.installed", group: "packs", where: "ai" },
  { id: "packs.hidden", group: "packs", where: "ai" },
  { id: "chat.maxToolCalls", group: "chat", where: "ai" },
  { id: "chat.autoTitle", group: "chat", where: "ai" },
  { id: "chat.expandThinking", group: "chat", where: "ai" },
  { id: "chat.sendWith", group: "chat", where: "ai" },
  { id: "tools.connect", group: "tools" },
  { id: "account.who", group: "account" },
  { id: "account.github", group: "account" },
  { id: "account.space", group: "account" },
  { id: "cloud.ai", group: "cloud", where: "account" },
  { id: "cloud.organizer", group: "cloud", where: "account" },
  { id: "cloud.chats", group: "cloud", where: "account" },
  { id: "cloud.newProjectsInCloud", group: "cloud", where: "account" },
  { id: "cloud.device", group: "cloud", where: "device" },
  { id: "storage.persist", group: "storage", where: "device" },
  { id: "storage.keys", group: "storage", where: "device" },
  { id: "storage.chats", group: "storage", where: "device" },
  { id: "storage.usage", group: "storage", where: "device" },
  { id: "about.version", group: "about" },
  { id: "about.license", group: "about" },
  { id: "about.feedback", group: "about" },
  { id: "about.performance", group: "about" },
  { id: "about.errors", group: "about" },
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
      `${named} ${t(`settings.items.${item.id}.help`)} ${t(`settings.items.${item.id}.keywords`)}`,
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
