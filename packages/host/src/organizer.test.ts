import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import type { ProjectGroup } from "./index.ts";
import {
  browserOrganizer,
  memoryOrganizer,
  mergeMarks,
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

describe("the organizer of a browser", () => {
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
