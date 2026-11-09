import type { SettingsStore } from "@animaquill/host";
import type { TFunction } from "i18next";
import { describe, expect, it } from "vitest";
import zhCN from "../i18n/zh-CN.json";
import { ResourceHabits } from "./habits.ts";
import { browse, type Resource } from "./resources.ts";
import { loopShare } from "./transition-preview.ts";
import { builtInTransitions } from "./transitions.ts";

const resource = (
  id: string,
  type: string,
  tags: readonly string[] = [],
  source: Resource["source"] = { kind: "built-in" },
): Resource<null> => ({ id, source, type, name: id, tags, data: null });

const list = [
  resource("淡入", "transition.enter", ["柔和"]),
  resource("叠化", "transition.join", ["柔和"]),
  resource("推入", "transition.enter", ["运动", "有方向"]),
  resource("墨迹", "transition.join", [], { kind: "library", library: "lib", name: "品牌库" }),
  resource("我的", "transition.exit", [], { kind: "project" }),
];
const types = ["transition.enter", "transition.join", "transition.exit"];
const shape = (groups: ReturnType<typeof browse<null>>) =>
  groups.map(({ id, items }) => [id, items.map((item) => item.id)]);

describe("browsing resources", () => {
  it("groups by type in the order given, with what was used recently first", () => {
    const groups = browse(list, { query: "", grouping: "type", recent: ["叠化", "gone"], types });
    expect(shape(groups)).toEqual([
      ["recent", ["叠化"]],
      ["type:transition.enter", ["淡入", "推入"]],
      ["type:transition.join", ["叠化", "墨迹"]],
      ["type:transition.exit", ["我的"]],
    ]);
  });

  it("puts the type that the selection is about first", () => {
    const groups = browse(list, {
      query: "",
      grouping: "type",
      recent: [],
      types,
      firstType: "transition.join",
    });
    expect(groups[0]?.id).toBe("type:transition.join");
  });

  it("groups by where they are: built in, the project, then libraries by name", () => {
    const groups = browse(list, { query: "", grouping: "source", recent: [], types });
    expect(shape(groups)).toEqual([
      ["source:built-in", ["淡入", "叠化", "推入"]],
      ["source:project", ["我的"]],
      ["source:library:lib", ["墨迹"]],
    ]);
  });

  it("groups by tag, one in each of its tags, and those without one last", () => {
    const groups = browse(list, { query: "", grouping: "tag", recent: [], types });
    expect(groups.at(-1)).toMatchObject({ id: "tag:", items: [{ id: "墨迹" }, { id: "我的" }] });
    expect(groups.find(({ id }) => id === "tag:柔和")?.items.map(({ id }) => id)).toEqual([
      "淡入",
      "叠化",
    ]);
    expect(groups.filter(({ items }) => items.some(({ id }) => id === "推入"))).toHaveLength(2);
  });

  it("keeps what fits a search, by its name or its tags, and drops empty groups", () => {
    const byName = browse(list, { query: "叠", grouping: "type", recent: ["淡入"], types });
    expect(shape(byName)).toEqual([["type:transition.join", ["叠化"]]]);
    const byTag = browse(list, { query: "运动", grouping: "type", recent: [], types });
    expect(shape(byTag)).toEqual([["type:transition.enter", ["推入"]]]);
    expect(browse(list, { query: "没有", grouping: "type", recent: [], types })).toEqual([]);
  });
});

describe("the habits of people with resources", () => {
  function settings() {
    const saved = new Map<string, unknown>();
    let other: (value: unknown) => void = () => {};
    const store: SettingsStore = {
      load: async (key) => saved.get(key),
      save: async (key, value) => void saved.set(key, value),
      listen: (_, listener) => {
        other = listener;
        return () => {};
      },
    };
    return { store, saved, fromOtherWindow: (value: unknown) => other(value) };
  }

  it("keeps what was used, the most recent first, and the grouping of each tab", async () => {
    const { store, saved } = settings();
    const habits = new ResourceHabits(store);
    await habits.load();
    habits.used("a");
    habits.used("b");
    habits.used("a");
    habits.setGrouping("transitions", "tag");
    expect(habits.recent).toEqual(["a", "b"]);
    expect(habits.groupingOf("transitions", "type")).toBe("tag");
    expect(habits.groupingOf("effects", "type")).toBe("type");
    const again = new ResourceHabits(store);
    await again.load();
    expect(again.recent).toEqual(["a", "b"]);
    expect(saved.get("resources")).toMatchObject({ version: 1 });
  });

  it("follows other windows, and ignores what it cannot read", async () => {
    const { store, fromOtherWindow } = settings();
    const habits = new ResourceHabits(store);
    await habits.load();
    fromOtherWindow({ version: 1, recent: ["x", 3], grouping: { transitions: "nonsense" } });
    expect(habits.recent).toEqual(["x"]);
    expect(habits.groupingOf("transitions", "type")).toBe("type");
    fromOtherWindow("broken");
    expect(habits.recent).toEqual(["x"]);
  });

  it("keeps which groups are closed in each tab, and reads what was saved before that", async () => {
    const { store, fromOtherWindow } = settings();
    const habits = new ResourceHabits(store);
    await habits.load();
    expect(habits.collapsedIn("assets")).toEqual([]);
    habits.setCollapsed("assets", "type:media_image", true);
    habits.setCollapsed("assets", "recent", true);
    habits.setCollapsed("assets", "recent", true);
    habits.setCollapsed("effects", "type:effect.blur", true);
    habits.setCollapsed("assets", "type:media_image", false);
    expect(habits.collapsedIn("assets")).toEqual(["recent"]);
    expect(habits.collapsedIn("effects")).toEqual(["type:effect.blur"]);
    expect(habits.collapsedIn("transitions")).toEqual([]);
    const again = new ResourceHabits(store);
    await again.load();
    expect(again.collapsedIn("assets")).toEqual(["recent"]);
    // The last window to listen hears the others.
    fromOtherWindow({ version: 1, recent: [], grouping: {} });
    expect(again.collapsedIn("assets")).toEqual([]);
    fromOtherWindow({ version: 1, recent: [], grouping: {}, collapsed: { a: ["x", 1], b: "y" } });
    expect(again.collapsedIn("a")).toEqual(["x"]);
    expect(again.collapsedIn("b")).toEqual([]);
  });
});

describe("the transitions that come with the editor", () => {
  const t = ((key: string) => {
    const value = key
      .split(".")
      .reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], zhCN);
    return typeof value === "string" ? value : key;
  }) as unknown as TFunction;

  it("are listed once for each place they go, each kind on its own, with their names there", () => {
    const transitions = builtInTransitions(t);
    // One of each kind, in, between and out: which way and what color are its properties.
    expect(transitions).toHaveLength(4 * 3);
    expect(new Set(transitions.map(({ id }) => id)).size).toBe(transitions.length);
    const names = (type: string) =>
      transitions.filter((item) => item.type === type).map(({ name }) => name);
    expect(names("transition.enter")).toEqual(["淡入", "闪入", "擦入", "推入"]);
    expect(names("transition.join")).toEqual(["叠化", "闪色", "擦除", "推移"]);
    expect(names("transition.exit")).toEqual(["淡出", "闪出", "擦出", "推出"]);
    expect(transitions.find(({ name }) => name === "推入")?.data.pick.name).toEqual({
      type: "push",
    });
    expect(transitions.find(({ name }) => name === "闪色")?.tags).toEqual(["柔和", "纯色"]);
  });
});

describe("a moving preview", () => {
  it("holds at the start, plays at least long enough to see, holds at the end, and loops", () => {
    expect(loopShare(0, 0.5)).toBe(0);
    expect(loopShare(350 + 400, 0.5)).toBeCloseTo(0.5);
    expect(loopShare(350 + 800 + 100, 0.5)).toBe(1);
    expect(loopShare(350 + 800 + 350 + 350 + 400, 0.5)).toBeCloseTo(0.5);
    expect(loopShare(350 + 1000, 2)).toBeCloseTo(0.5);
  });
});
