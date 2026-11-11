import type { ProjectGroup } from "@animaquill/host";
import { describe, expect, it } from "vitest";
import type { CardKind, ProjectCard } from "./cards.ts";
import {
  cardsOfView,
  filtersOf,
  isWelcome,
  readHabits,
  remoteCards,
  sectionsOf,
  sortCards,
  viewCards,
  viewThere,
  writeHabits,
  type ViewChoice,
} from "./views.ts";

/** The views of the start page: the design of the start page, 6.1 and 6.2. */

const card = (
  name: string,
  kind: CardKind,
  more: Partial<Omit<ProjectCard, "name" | "kind">> = {},
): ProjectCard => ({
  id: name,
  kind,
  name,
  key: kind === "cloudRemote" ? undefined : name,
  project: undefined,
  marksKey: name,
  openedAt: kind === "cloudRemote" ? undefined : 1,
  updatedAt: 1,
  starred: false,
  group: undefined,
  durationMs: undefined,
  source: { kind: "browser", summary: { id: name, name, updatedAt: 1 }, known: true },
  ...more,
});

const group = (id: string, name: string): ProjectGroup => ({ id, name, scope: "browser", at: 1 });

const CARDS = [
  card("课程片头", "local", { openedAt: 50, updatedAt: 10, starred: true, group: "work" }),
  card("旅行 Vlog", "cloudFolder", { openedAt: 40, updatedAt: 60, group: "work" }),
  card("产品发布", "cloudHere", { openedAt: 80, updatedAt: 20 }),
  card("年会开场", "cloudRemote", { updatedAt: 90, group: "channel" }),
  card("旧项目", "onlyHere", { openedAt: 7, updatedAt: 7 }),
];

const names = (cards: readonly ProjectCard[]) => cards.map((each) => each.name);
const choice = (more: Partial<ViewChoice>): ViewChoice => ({
  view: "all",
  filter: "all",
  search: "",
  sort: "updated",
  ...more,
});

describe("the views of the start page", () => {
  it("lists what was opened in this browser as recent, the last first, whatever the sort", () => {
    expect(names(viewCards(CARDS, choice({ view: "recent", sort: "name" })))).toEqual([
      "产品发布",
      "课程片头",
      "旅行 Vlog",
      "旧项目",
    ]);
  });

  it("lists everything, by when it changed unless people say otherwise", () => {
    expect(names(viewCards(CARDS, choice({})))).toEqual([
      "年会开场",
      "旅行 Vlog",
      "产品发布",
      "课程片头",
      "旧项目",
    ]);
    // By how the names are read, as people look things up.
    expect(names(viewCards(CARDS, choice({ sort: "name" })))).toEqual([
      "产品发布",
      "旧项目",
      "课程片头",
      "旅行 Vlog",
      "年会开场",
    ]);
    // What was never opened here goes after what was.
    expect(names(viewCards(CARDS, choice({ sort: "opened" }))).at(-1)).toBe("年会开场");
  });

  it("lists the starred ones, and those of a group", () => {
    expect(names(viewCards(CARDS, choice({ view: "starred" })))).toEqual(["课程片头"]);
    expect(names(viewCards(CARDS, choice({ view: "group:work" })))).toEqual([
      "旅行 Vlog",
      "课程片头",
    ]);
    expect(names(viewCards(CARDS, choice({ view: "group:channel" })))).toEqual(["年会开场"]);
  });

  it("filters to the projects of the platform or the folders, in every view", () => {
    expect(names(viewCards(CARDS, choice({ filter: "cloud" })))).toEqual([
      "年会开场",
      "旅行 Vlog",
      "产品发布",
    ]);
    expect(names(viewCards(CARDS, choice({ filter: "local" })))).toEqual(["课程片头"]);
    expect(names(viewCards(CARDS, choice({ view: "group:work", filter: "cloud" })))).toEqual([
      "旅行 Vlog",
    ]);
    // "最近打开" never has a project that was not opened here.
    expect(names(viewCards(CARDS, choice({ view: "recent", filter: "cloud" })))).toEqual([
      "产品发布",
      "旅行 Vlog",
    ]);
  });

  it("searches the names of the view, whatever the case and width of the letters", () => {
    expect(names(viewCards(CARDS, choice({ search: " vlog " })))).toEqual(["旅行 Vlog"]);
    expect(names(viewCards(CARDS, choice({ search: "ＶＬＯＧ" })))).toEqual(["旅行 Vlog"]);
    expect(names(viewCards(CARDS, choice({ view: "starred", search: "vlog" })))).toEqual([]);
    expect(names(viewCards(CARDS, choice({ search: "项目" })))).toEqual(["旧项目"]);
  });

  it("sorts names as people count, and keeps the same order for the same time", () => {
    const same = [card("片段 10", "local"), card("片段 9", "local"), card("片段 1", "local")];
    expect(names(sortCards(same, "name"))).toEqual(["片段 1", "片段 9", "片段 10"]);
    expect(names(sortCards(same, "updated"))).toEqual(["片段 1", "片段 9", "片段 10"]);
  });
});

describe("the side bar", () => {
  it("has the views of my projects and each group, with how many projects are in each", () => {
    const sections = sectionsOf({
      cards: CARDS,
      groups: [group("work", "工作"), group("channel", "频道"), group("empty", "空的")],
      unfinishedExports: 2,
    });
    expect(sections.map((section) => [section.id, section.block, section.count])).toEqual([
      ["recent", "projects", undefined],
      ["all", "projects", 5],
      ["starred", "projects", 1],
      ["exports", "projects", 2],
      ["group:work", "groups", 2],
      ["group:channel", "groups", 1],
      ["group:empty", "groups", 0],
    ]);
    expect(sections.at(-1)?.label).toEqual({ text: "空的" });
  });

  it("has no starred, and no unfinished exports, where there are none", () => {
    const sections = sectionsOf({
      cards: CARDS.map((each) => ({ ...each, starred: false })),
      groups: [],
      unfinishedExports: 0,
    });
    expect(sections.map((section) => section.id)).toEqual(["recent", "all"]);
    // A view that went, as a group taken away elsewhere: back to the first one.
    expect(viewThere("starred", sections)).toBe("recent");
    expect(viewThere("group:work", sections)).toBe("recent");
    expect(viewThere("all", sections)).toBe("all");
  });

  it("has filters only where both kinds of projects can be here", () => {
    expect(filtersOf({ hasPlatform: true, canFolders: true })).toEqual(["all", "cloud", "local"]);
    expect(filtersOf({ hasPlatform: true, canFolders: false })).toEqual([]);
    expect(filtersOf({ hasPlatform: false, canFolders: true })).toEqual([]);
  });
});

describe("when there is nothing to show", () => {
  it("welcomes people with no project at all", () => {
    expect(isWelcome([], "recent")).toBe(true);
    expect(isWelcome([], "all")).toBe(true);
    expect(isWelcome([], "starred")).toBe(false);
  });

  it("welcomes them as well where nothing was opened here, with their projects of the platform under it", () => {
    const remote = [
      card("年会开场", "cloudRemote", { updatedAt: 1 }),
      card("片尾", "cloudRemote", { updatedAt: 9 }),
    ];
    expect(isWelcome(remote, "recent")).toBe(true);
    expect(isWelcome(remote, "all")).toBe(false);
    expect(
      names(remoteCards([...remote, ...CARDS.filter((each) => each.kind !== "cloudRemote")])),
    ).toEqual(["片尾", "年会开场"]);
    expect(isWelcome(CARDS, "recent")).toBe(false);
  });

  it("does not show an empty view as one", () => {
    expect(cardsOfView(CARDS, "exports")).toEqual([]);
    expect(cardsOfView(CARDS, "group:nothing")).toEqual([]);
  });
});

describe("the habits of each view", () => {
  it("are kept for each view, and what is not understood goes", () => {
    const kept = writeHabits(
      new Map([
        ["all", { sort: "name", display: "list" }],
        ["group:work", { sort: "opened", display: "cards" }],
      ] as const),
    );
    const read = readHabits(JSON.parse(JSON.stringify(kept)));
    expect(read.get("all")).toEqual({ sort: "name", display: "list" });
    expect(read.get("group:work")).toEqual({ sort: "opened", display: "cards" });
    expect(readHabits({ views: { all: { sort: "size", display: "grid" } } }).get("all")).toEqual({
      sort: "updated",
      display: "cards",
    });
    expect(readHabits("nonsense").size).toBe(0);
    expect(readHabits(undefined).size).toBe(0);
  });
});
