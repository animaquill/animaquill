import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import type { ProjectGroup } from "./index.ts";
import { cleanGroupName, groupNameOf } from "./organize-rules.ts";
import {
  browserOrganizer,
  memoryOrganizer,
  mergeMarks,
  unsentOf,
  type OrganizerChannel,
} from "./organizer.ts";

/** Windows of one browser: what one posts, the others hear. */
function browserOf() {
  const factory = new IDBFactory();
  const windows = new Set<() => void>();
  const channel = (): OrganizerChannel => {
    let own: (() => void) | undefined;
    return {
      post: () => {
        for (const listener of windows) if (listener !== own) listener();
      },
      listen(listener) {
        own = listener;
        windows.add(listener);
        return () => windows.delete(listener);
      },
    };
  };
  return () => browserOrganizer(() => factory, channel);
}

const group = (id: string, name: string, more: Partial<ProjectGroup> = {}): ProjectGroup => ({
  id,
  name,
  scope: "browser",
  at: 1,
  ...more,
});

describe("merging the marks of a project", () => {
  it("changes what is given and keeps the rest, each with when it changed", () => {
    const before = mergeMarks(undefined, { starredAt: 10, group: "g", at: 10 });
    expect(mergeMarks(before, { group: null, at: 20 })).toEqual({
      starredAt: 10,
      starAt: 10,
      group: null,
      groupAt: 20,
      at: 20,
    });
    expect(mergeMarks(before, { starredAt: null, at: 30 })).toEqual({
      starredAt: null,
      starAt: 30,
      group: "g",
      groupAt: 10,
      at: 30,
    });
  });

  it("keeps a star or a group changed later than the change, each on its own", () => {
    // Starred at 30 elsewhere; this window takes it out of its group at 20, with a star from 10.
    const starred = mergeMarks(mergeMarks(undefined, { starredAt: null, at: 10 }), {
      starredAt: 30,
      at: 30,
    });
    const moved = mergeMarks(starred, { group: null, starredAt: null, at: 20 });
    expect(moved).toMatchObject({ starredAt: 30, starAt: 30, group: null, groupAt: 20, at: 30 });
    // What was kept with one time for both counts as changed then.
    expect(mergeMarks({ starredAt: 5, group: "g", at: 50 }, { group: null, at: 40 })).toEqual({
      starredAt: 5,
      group: "g",
      at: 50,
    });
  });

  it("remembers whose project of the platform it is", () => {
    const marks = mergeMarks(undefined, { starredAt: 1, account: "user-ada", at: 1 });
    expect(mergeMarks(marks, { group: "g", at: 2 })).toMatchObject({ account: "user-ada" });
  });

  it("has what people do here come after whatever is kept, also a time still to come", () => {
    const ahead = mergeMarks(undefined, { starredAt: 900, at: 900, group: "g" });
    // A change of before that time is older; one people made here is not.
    expect(mergeMarks(ahead, { starredAt: null, at: 100 }).starredAt).toBe(900);
    expect(mergeMarks(ahead, { starredAt: null, at: 100, mine: true })).toMatchObject({
      starredAt: null,
      starAt: 901,
      group: "g",
      groupAt: 900,
    });
  });

  it("has times kept here that are still to come become now, values as they are", () => {
    const ahead = mergeMarks(undefined, {
      starredAt: 900,
      group: "g",
      at: 900,
      sent: { star: 900, group: 50 },
    });
    expect(mergeMarks(ahead, { at: 900, notAfter: 200 })).toEqual({
      starredAt: 900,
      starAt: 200,
      group: "g",
      groupAt: 200,
      at: 200,
      sent: { star: 200, group: 50 },
    });
  });

  it("does not take opening for organising: the time to merge by stays", () => {
    const before = mergeMarks(undefined, { starredAt: 10, at: 10 });
    expect(mergeMarks(before, { openedAt: 50, at: 50 })).toEqual({
      starredAt: 10,
      starAt: 10,
      openedAt: 50,
      at: 10,
    });
    expect(mergeMarks(undefined, { openedAt: 50, at: 50 })).toEqual({ openedAt: 50, at: 50 });
  });
});

describe.each([
  ["in this browser", () => browserOf()()],
  ["in memory", memoryOrganizer],
])("the organizer %s", (_, make) => {
  it("keeps marks and groups", async () => {
    const organizer = make();
    expect(await organizer.read()).toEqual({ marks: new Map(), groups: [] });
    await organizer.mark("a", { starredAt: 5, at: 5 });
    await organizer.mark("a", { group: "g", at: 6 });
    await organizer.mark("cloud:p", { group: "g", at: 7 });
    await organizer.putGroup(group("g", "工作"));
    await organizer.putGroup(group("g", "频道", { at: 2 }));
    const { marks, groups } = await organizer.read();
    expect(marks.get("a")).toEqual({ starredAt: 5, starAt: 5, group: "g", groupAt: 6, at: 6 });
    expect(marks.get("cloud:p")).toEqual({ group: "g", groupAt: 7, at: 7 });
    expect(groups).toEqual([group("g", "频道", { at: 2 })]);
    await organizer.forget("a");
    expect([...(await organizer.read()).marks.keys()]).toEqual(["cloud:p"]);
  });

  it("keeps the later change of a group, and one name once", async () => {
    const organizer = make();
    expect(await organizer.putGroup(group("g", "工作", { at: 10 }))).toBe("kept");
    // Taken away in one window; renamed a moment before in another, which comes after.
    expect(await organizer.putGroup(group("g", "工作", { at: 20, deleted: true }))).toBe("kept");
    expect(await organizer.putGroup(group("g", "工作 2", { at: 15 }))).toBe("older");
    expect(await organizer.putGroup(group("g", "工作 3", { at: 30 }))).toBe("older");
    // Made with the same name in two windows: the second is the first one.
    expect(await organizer.putGroup(group("a", "频道", { at: 40 }))).toBe("kept");
    expect(await organizer.putGroup(group("b", " 频道 ", { at: 41 }))).toEqual({ taken: "a" });
    expect(await organizer.putGroup(group("c", "工作", { at: 42 }))).toBe("kept");
    const { groups } = await organizer.read();
    expect(groups.map((each) => [each.id, each.name, each.deleted ?? false]).toSorted()).toEqual([
      ["a", "频道", false],
      ["c", "工作", false],
      ["g", "工作", true],
    ]);
  });

  it("keeps groups as an account has them, by their time, and what it has of each", async () => {
    const organizer = make();
    const theirs = (id: string, name: string, at: number, more: Partial<ProjectGroup> = {}) =>
      group(id, name, { scope: { account: "ada" }, at, sent: at, ...more });
    await organizer.putGroup(group("a", "改过", { scope: { account: "ada" }, at: 50, sent: 10 }));
    await organizer.putGroup(group("b", "旧", { scope: { account: "ada" }, at: 10, sent: 10 }));
    await organizer.adoptGroups([
      // Changed here later: stays, still to be given.
      theirs("a", "那边", 30),
      // Changed there later: taken.
      theirs("b", "新", 40),
      // Taken away there.
      theirs("c", "删了", 5, { deleted: true }),
    ]);
    const { groups } = await organizer.read();
    expect(groups.toSorted((x, y) => x.id.localeCompare(y.id))).toEqual([
      group("a", "改过", { scope: { account: "ada" }, at: 50, sent: 30 }),
      theirs("b", "新", 40),
      theirs("c", "删了", 5, { deleted: true }),
    ]);
    // Without a word on names: the account keeps them apart.
    await organizer.adoptGroups([theirs("d", "新", 60)]);
    expect((await organizer.read()).groups).toHaveLength(4);
  });

  it("has the groups of this browser become an account's, one name once", async () => {
    const organizer = make();
    await organizer.putGroup(group("x", " WORK", { at: 10 }));
    await organizer.putGroup(group("y", "自己的", { at: 11 }));
    await organizer.putGroup(group("z", "删掉的", { at: 12, deleted: true }));
    await organizer.adoptGroups([
      group("w", "work", { scope: { account: "ada" }, at: 5, sent: 5 }),
    ]);
    await organizer.mark("a", { group: "x", at: 20 });
    await organizer.mark("cloud:p", { group: "x", account: "ada", at: 21, sent: { group: 21 } });
    await organizer.mark("b", { group: "y", at: 22 });
    await organizer.claimGroups("ada");
    const { groups, marks } = await organizer.read();
    const byId = new Map(groups.map((each) => [each.id, each]));
    // The one of a name the account has became that one; projects in it are in that one, the time
    // they went in as it was, and the account is given it again.
    expect(byId.get("x")).toMatchObject({ deleted: true, into: "w", scope: "browser" });
    expect(marks.get("a")).toMatchObject({ group: "w", groupAt: 20 });
    expect(marks.get("cloud:p")).toEqual({ group: "w", groupAt: 21, account: "ada", at: 21 });
    // The other one is the account's, as it is, still to be given to it.
    expect(byId.get("y")).toEqual(group("y", "自己的", { scope: { account: "ada" }, at: 11 }));
    expect(marks.get("b")).toMatchObject({ group: "y" });
    // One taken away stays as it is.
    expect(byId.get("z")).toEqual(group("z", "删掉的", { at: 12, deleted: true }));
    // Again: nothing more changes.
    await organizer.claimGroups("ada");
    expect((await organizer.read()).groups).toEqual(groups);
  });

  it("has a group become another, and gives the account taking away what it had", async () => {
    const organizer = make();
    const ada = { scope: { account: "ada" } } as const;
    await organizer.adoptGroups([group("w", "频道", { ...ada, at: 25, sent: 25 })]);
    await organizer.adoptGroups([group("x", "频道", { ...ada, at: 30, sent: 10 })]);
    await organizer.mark("cloud:p", { group: "x", account: "ada", at: 20, sent: { group: 20 } });
    await organizer.mergeGroup("x", "w");
    const content = await organizer.read();
    expect(content.groups.find(({ id }) => id === "x")).toEqual(
      group("x", "频道", { ...ada, at: 30, sent: 10, deleted: true, into: "w" }),
    );
    expect(unsentOf(content, "ada")).toEqual({
      account: "ada",
      groups: [{ id: "x", name: "频道", at: 30, deleted: true }],
      marks: [{ project: "p", group: { id: "w", at: 20 } }],
    });
    // The account changed it later than that: it is that one again.
    await organizer.adoptGroups([group("x", "又改了", { ...ada, at: 40, sent: 40 })]);
    expect((await organizer.read()).groups.find(({ id }) => id === "x")).toEqual(
      group("x", "又改了", { ...ada, at: 40, sent: 40 }),
    );
  });

  it("shows the groups of this browser with those of the account last signed in: one name once", async () => {
    const organizer = make();
    await organizer.noteAccount("ada");
    expect((await organizer.read()).account).toBe("ada");
    await organizer.adoptGroups([group("w", "工作", { scope: { account: "ada" }, sent: 1 })]);
    await organizer.adoptGroups([group("v", "频道", { scope: { account: "bob" }, sent: 1 })]);
    expect(await organizer.putGroup(group("x", "工作", { at: 5 }))).toEqual({ taken: "w" });
    // Another account's is not shown with them.
    expect(await organizer.putGroup(group("y", "频道", { at: 5 }))).toBe("kept");
    expect(
      await organizer.putGroup(group("z", "频道", { scope: { account: "bob" }, at: 5 })),
    ).toEqual({ taken: "v" });
  });

  it("tells its own window what changed", async () => {
    const organizer = make();
    let heard = 0;
    const stop = organizer.listen(() => (heard += 1));
    await organizer.mark("a", { starredAt: 1, at: 1 });
    await organizer.putGroup(group("g", "工作"));
    stop();
    await organizer.forget("a");
    expect(heard).toBe(2);
  });
});

describe("names of groups", () => {
  it("have no control or format characters, nor separators of lines: those become a space", () => {
    expect(cleanGroupName(" A\tB ")).toBe("A B");
    expect(cleanGroupName("工作\u200b")).toBe("工作");
    expect(cleanGroupName("a\u2028b\u2029c\u0085d\u202ee")).toBe("a b c d e");
    expect(groupNameOf(" 工作 ")).toBe("工作");
    expect(groupNameOf("😀".repeat(60))).toBe("😀".repeat(60));
    for (const no of ["", " ", "A\tB", "工作\u200b", "\u200b", "字".repeat(61), 5, undefined])
      expect(groupNameOf(no), JSON.stringify(no)).toBeUndefined();
  });
});

describe("what is still to be given to an account", () => {
  it("is what changed here later than the account has it, of that account", () => {
    const ada = { scope: { account: "ada" } } as const;
    const unsent = unsentOf(
      {
        groups: [
          group("new", "新", { ...ada, at: 5 }),
          group("same", "一样", { ...ada, at: 5, sent: 5 }),
          group("renamed", "改名", { ...ada, at: 9, sent: 5 }),
          group("gone", "删了", { ...ada, at: 9, sent: 5, deleted: true }),
          // Made and taken away before the account heard of it.
          group("never", "没有", { ...ada, at: 9, deleted: true }),
          group("bob", "别人", { scope: { account: "bob" }, at: 5 }),
          group("here", "浏览器", { at: 5 }),
        ],
        marks: new Map([
          [
            "cloud:p1",
            { starredAt: 7, starAt: 7, group: "new", groupAt: 3, at: 7, sent: { group: 3 } },
          ],
          ["cloud:p2", { starredAt: null, starAt: 4, at: 4, sent: { star: 4 } }],
          // Of another account, or none known.
          ["cloud:p3", { starredAt: 7, starAt: 7, at: 7, account: "bob" }],
          ["cloud:p4", { group: null, groupAt: 8, at: 8 }],
          // A group that is no group of the account is not given.
          ["cloud:p5", { group: "here", groupAt: 8, at: 8 }],
          ["cloud:p6", { group: "bob", groupAt: 8, starredAt: 8, starAt: 8, at: 8 }],
          // What only this browser keeps.
          ["local", { starredAt: 7, starAt: 7, at: 7 }],
          // From before each had a time of its own.
          ["cloud:old", { starredAt: 2, group: "same", at: 6 }],
        ]),
      },
      "ada",
    );
    expect(unsent.groups).toEqual([
      { id: "new", name: "新", at: 5 },
      { id: "renamed", name: "改名", at: 9 },
      { id: "gone", name: "删了", at: 9, deleted: true },
    ]);
    expect(unsent.marks).toEqual([
      { project: "p1", star: { starred: true, at: 7 } },
      { project: "p4", group: { id: null, at: 8 } },
      { project: "p6", star: { starred: true, at: 8 } },
      { project: "old", star: { starred: true, at: 6 }, group: { id: "same", at: 6 } },
    ]);
  });
});

describe("the organizer of a browser", () => {
  it("keeps what a page of the version before kept", async () => {
    const factory = new IDBFactory();
    const before = factory.open("animaquill-organizer", 1);
    before.addEventListener("upgradeneeded", () => {
      const database = before.result;
      database
        .createObjectStore("marks", { keyPath: "project" })
        .put({ project: "a", starredAt: 5, at: 5 });
      database.createObjectStore("groups", { keyPath: "id" }).put(group("g", "工作"));
    });
    await new Promise((resolve) => before.addEventListener("success", resolve));
    before.result.close();
    const organizer = browserOrganizer(
      () => factory,
      () => undefined,
    );
    expect(await organizer.read()).toEqual({
      marks: new Map([["a", { starredAt: 5, at: 5 }]]),
      groups: [group("g", "工作")],
    });
    await organizer.noteAccount("ada");
    expect((await organizer.read()).account).toBe("ada");
  });

  it("is the same in every window, and tells the others what one changed", async () => {
    const window = browserOf();
    const one = window();
    const other = window();
    let heard = 0;
    other.listen(() => (heard += 1));
    await one.mark("a", { starredAt: 1, at: 1 });
    expect(heard).toBe(1);
    expect((await other.read()).marks.get("a")).toEqual({ starredAt: 1, starAt: 1, at: 1 });
  });
});
