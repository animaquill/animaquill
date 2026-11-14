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
  it("gives every setting a group there is, a name, what it does and words to find it by", () => {
    const texts = zhCN.settings.items as Record<string, Record<string, Record<string, string>>>;
    for (const item of SETTING_ITEMS) {
      expect(all, item.id).toContain(item.group);
      const [group, name] = item.id.split(".") as [string, string];
      expect(group, item.id).toBe(item.group);
      const words = texts[group]?.[name];
      expect(words?.name?.trim(), item.id).toBeTruthy();
      expect(words?.help?.trim(), item.id).toBeTruthy();
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
    expect(ids).toContain("cloud.ai");
    expect(found("KEY")).toEqual(ids);
  });

  it("finds by words a setting is also known by", () => {
    expect(found("帧率")).toContain("playback.quality");
    expect(found("暗色")).toEqual(["general.theme"]);
    expect(found("回车")).toEqual(["chat.sendWith"]);
    expect(found("mcp")).toEqual(["tools.connect"]);
    expect(found("额度")).toContain("account.space");
  });

  it("finds by the name of a group, and by every word given", () => {
    expect(found("导出")).toEqual(expect.arrayContaining(["export.quality", "export.hardware"]));
    expect(found("导出 显卡")).toEqual(["export.hardware"]);
    expect(found("没有这种设置")).toEqual([]);
    expect(found("   ")).toEqual([]);
  });

  it("only in the groups there are now", () => {
    const signedOut = visibleGroups({ account: true, cloud: false });
    expect(signedOut).not.toContain("cloud");
    expect(found("收藏", signedOut)).toEqual([]);
    expect(found("收藏")).toContain("cloud.organizer");
    const noPlatform = visibleGroups({ account: false, cloud: false });
    expect(noPlatform).not.toContain("account");
    expect(found("额度", noPlatform)).toEqual([]);
  });
});
