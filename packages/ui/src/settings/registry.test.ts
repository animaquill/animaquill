import { createInstance } from "i18next";
import { describe, expect, it } from "vitest";
import zhCN from "../i18n/zh-CN.json" with { type: "json" };
import { SETTINGS_GROUPS, visibleGroups } from "../workbench/settings-nav.ts";
import { SETTING_ITEMS, searchSettings } from "./registry.ts";

/**
 * The list of every setting (docs/design/settings-and-properties.md of AnimaQuill Cloud, 1 and 4.3):
 * each has its group, a name and what it does, and searching finds it by other words too.
 */

const i18n = createInstance();
await i18n.init({
  lng: "zh-CN",
  resources: { "zh-CN": { translation: zhCN } },
  interpolation: { escapeValue: false },
});
const t = i18n.t;
const all = SETTINGS_GROUPS;
const found = (query: string, groups = all) =>
  searchSettings(t, query, groups).map(({ item }) => item.id);

describe("the list", () => {
  it("gives every setting a group there is, a name and words to find it by; what it does only where said", () => {
    const texts = zhCN.settings.items as Record<string, Record<string, Record<string, string>>>;
    for (const item of SETTING_ITEMS) {
      expect(all, item.id).toContain(item.group);
      const [group, name] = item.id.split(".") as [string, string];
      expect(group, item.id).toBe(item.group);
      const words = texts[group]?.[name];
      expect(words?.name?.trim(), item.id).toBeTruthy();
      if (words?.help !== undefined) expect(words.help.trim(), item.id).toBeTruthy();
      expect(words?.keywords?.trim(), item.id).toBeTruthy();
    }
  });

  it("has each setting once, and something in every group", () => {
    const ids = SETTING_ITEMS.map(({ id }) => id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const group of all) {
      expect(
        SETTING_ITEMS.some((item) => item.group === group),
        group,
      ).toBe(true);
    }
    // Nothing in the texts that the list does not have, which searching would never find.
    const texts = zhCN.settings.items as Record<string, Record<string, unknown>>;
    const named = Object.entries(texts).flatMap(([group, items]) =>
      Object.keys(items).map((name) => `${group}.${name}`),
    );
    expect(named.toSorted()).toEqual(ids.toSorted());
  });

  it("has none of what is not a setting: what is changed while editing, or not made yet", () => {
    const ids = SETTING_ITEMS.map(({ id }) => id as string);
    for (const gone of [
      "general.input",
      "general.layout",
      "editing.snapping",
      "editing.overwriting",
      "editing.multiSelecting",
      "editing.timecode",
      "playback.quality",
      "export.quality",
      "cloud.device",
      "cloud.ai",
      "cloud.organizer",
      "cloud.chats",
    ])
      expect(ids, gone).not.toContain(gone);
    // What needs saying under its name: only these.
    const texts = zhCN.settings.items as Record<string, Record<string, { help?: string }>>;
    const said = SETTING_ITEMS.filter(({ id }) => {
      const [group, name] = id.split(".") as [string, string];
      return texts[group]?.[name]?.help !== undefined;
    }).map(({ id }) => id);
    for (const id of [
      "general.language",
      "general.theme",
      "general.fontSize",
      "account.space",
      "storage.persist",
      "storage.keys",
    ])
      expect(said, id).not.toContain(id);
    for (const id of ["editing.trial", "playback.proxyOffer", "export.hardware", "account.server"])
      expect(said, id).toContain(id);
  });

  it("names every group", () => {
    for (const group of all)
      expect(t(`settings.groups.${group}`)).not.toBe(`settings.groups.${group}`);
  });
});

describe("searching", () => {
  it("finds a key where it is set up, also in other groups, by the name first", () => {
    const ids = found("key");
    expect(ids[0]).toBe("models.services");
    expect(ids).toContain("storage.keys");
    expect(ids).toContain("account.server");
    expect(found("KEY")).toEqual(ids);
  });

  it("finds by words a setting is also known by", () => {
    expect(found("暗色")).toEqual(["general.theme"]);
    expect(found("字体")).toEqual(["general.fontSize"]);
    expect(found("回车")).toEqual(["chat.sendWith"]);
    expect(found("代理")).toContain("playback.proxyOffer");
    expect(found("额度")).toContain("account.space");
  });

  it("finds by the name of a group, and by every word given", () => {
    expect(found("导出")).toEqual(expect.arrayContaining(["export.hardware"]));
    expect(found("导出 显卡")).toEqual(["export.hardware"]);
    expect(found("没有这种设置")).toEqual([]);
    expect(found("   ")).toEqual([]);
  });

  it("only in the groups there are now", () => {
    const noPlatform = visibleGroups({ account: false });
    expect(noPlatform).not.toContain("account");
    expect(found("额度", noPlatform)).toEqual([]);
    expect(found("额度", visibleGroups({ account: true }))).toContain("account.space");
  });
});
