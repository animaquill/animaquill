import { memoryOrganizer, type ProjectGroup, type ProjectOrganizer } from "@animaquill/host";
import { describe, expect, it } from "vitest";
import { composeStartList } from "../cloud/start-list.ts";
import { composeCards } from "./cards.ts";
import { groupNameProblem, StartOrganizer } from "./organize.ts";
import { viewCards } from "./views.ts";

/** Stars and groups, kept in this browser: the design of the start page, 6.6. */

const group = (id: string, name: string, more: Partial<ProjectGroup> = {}): ProjectGroup => ({
  id,
  name,
  scope: "browser",
  at: 1,
  ...more,
});

function organizerOf(kept: ProjectOrganizer = memoryOrganizer()) {
  let clock = 100;
  let ids = 0;
  const organizer = new StartOrganizer({
    organizer: kept,
    now: () => (clock += 1),
    newId: () => `g${(ids += 1)}`,
  });
  // Listening is what has it read and keep up.
  organizer.subscribe(() => {});
  return organizer;
}

const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

/** The projects of this browser, as the start page lists them. */
const lists = composeStartList({
  records: [],
  projects: [
    { id: "a", name: "片头", updatedAt: 3 },
    { id: "b", name: "片尾", updatedAt: 2 },
  ],
  platform: undefined,
  links: undefined,
  listed: "loading",
  account: undefined,
  canDelete: false,
});

describe("the names of groups", () => {
  it("can be neither empty, nor longer than 60, nor that of another group", () => {
    const groups = [group("w", "工作"), group("gone", "删掉的", { deleted: true })];
    expect(groupNameProblem("  ", groups)).toBe("empty");
    expect(groupNameProblem("字".repeat(60), groups)).toBeUndefined();
    expect(groupNameProblem("字".repeat(61), groups)).toBe("tooLong");
    expect(groupNameProblem(" 工作 ", groups)).toBe("taken");
    // The group itself, as it is renamed, and one that was taken away do not count.
    expect(groupNameProblem("工作", groups, "w")).toBeUndefined();
    expect(groupNameProblem("删掉的", groups)).toBeUndefined();
  });

  it("are the same whatever the case or width of the letters", () => {
    expect(groupNameProblem("ＶＬＯＧ", [group("v", "vlog")])).toBe("taken");
  });
});

describe("organising projects", () => {
  it("stars and unstars, and keeps when a project was opened", async () => {
    const kept = memoryOrganizer();
    const organizer = organizerOf(kept);
    await organizer.star("a", true);
    await organizer.noteOpened("b");
    await organizer.star("a", false);
    await organizer.star("b", true);
    await settled();
    const { marks } = organizer.getSnapshot();
    expect(marks.get("a")).toMatchObject({ starredAt: null });
    expect(marks.get("b")).toMatchObject({
      starredAt: expect.any(Number),
      openedAt: expect.any(Number),
    });
    const cards = composeCards(lists, organizer.getSnapshot());
    expect(
      viewCards(cards, { view: "starred", filter: "all", search: "", sort: "updated" }).map(
        (card) => card.name,
      ),
    ).toEqual(["片尾"]);
  });

  it("makes groups, which every window of the browser sees, by name", async () => {
    const kept = memoryOrganizer();
    const organizer = organizerOf(kept);
    expect(await organizer.createGroup(" 频道 ")).toEqual({ id: "g1" });
    expect(await organizer.createGroup("工作")).toEqual({ id: "g2" });
    expect(await organizer.createGroup("工作")).toEqual({ problem: "taken" });
    expect(organizer.getSnapshot().groups.map((each) => each.name)).toEqual(["工作", "频道"]);
    const other = organizerOf(kept);
    await settled();
    expect(other.getSnapshot().groups.map((each) => [each.id, each.name, each.scope])).toEqual([
      ["g2", "工作", "browser"],
      ["g1", "频道", "browser"],
    ]);
  });

  it("renames a group, not into the name of another", async () => {
    const organizer = organizerOf();
    await organizer.createGroup("工作");
    await organizer.createGroup("频道");
    expect(await organizer.renameGroup("g1", "频道")).toBe("taken");
    expect(await organizer.renameGroup("g1", "工作 2026")).toBe(true);
    await settled();
    expect(organizer.getSnapshot().groups.map((each) => each.name)).toEqual(["工作 2026", "频道"]);
  });

  it("takes a group away, and its projects are in none from then on, and stay", async () => {
    const organizer = organizerOf();
    await organizer.createGroup("工作");
    await organizer.moveToGroup("a", "g1");
    await organizer.moveToGroup("b", "g1");
    await organizer.moveToGroup("b", undefined);
    await settled();
    let cards = composeCards(lists, organizer.getSnapshot());
    expect(cards.map((card) => [card.name, card.group])).toEqual([
      ["片头", "g1"],
      ["片尾", undefined],
    ]);
    expect(await organizer.deleteGroup("g1")).toBe(true);
    await settled();
    expect(organizer.getSnapshot().groups).toEqual([]);
    cards = composeCards(lists, organizer.getSnapshot());
    expect(cards.map((card) => [card.name, card.group])).toEqual([
      ["片头", undefined],
      ["片尾", undefined],
    ]);
    // A group of the same name is another group: what was in the old one is not in it.
    await organizer.createGroup("工作");
    await settled();
    cards = composeCards(lists, organizer.getSnapshot());
    expect(cards.every((card) => card.group === undefined)).toBe(true);
  });

  it("lists projects as they are where nothing can be read or kept", async () => {
    const broken: ProjectOrganizer = {
      read: () => Promise.reject(new Error("blocked")),
      mark: () => Promise.reject(new Error("blocked")),
      putGroup: () => Promise.reject(new Error("blocked")),
      forget: () => Promise.reject(new Error("blocked")),
      listen: () => () => {},
    };
    const organizer = organizerOf(broken);
    await settled();
    expect(organizer.getSnapshot()).toMatchObject({ failed: true, groups: [] });
    expect(await organizer.star("a", true)).toBe(false);
    expect(await organizer.createGroup("工作")).toBeUndefined();
  });
});
