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
  it("changes what is given and keeps the rest", () => {
    const before = mergeMarks(undefined, { starredAt: 10, group: "g", at: 10 });
    expect(mergeMarks(before, { group: null, at: 20 })).toEqual({
      starredAt: 10,
      group: null,
      at: 20,
    });
    expect(mergeMarks(before, { starredAt: null, at: 30 })).toEqual({
      starredAt: null,
      group: "g",
      at: 30,
    });
  });

  it("does not take opening for organising: the time to merge by stays", () => {
    const before = mergeMarks(undefined, { starredAt: 10, at: 10 });
    expect(mergeMarks(before, { openedAt: 50, at: 50 })).toEqual({
      starredAt: 10,
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
    expect(marks.get("a")).toEqual({ starredAt: 5, group: "g", at: 6 });
    expect(marks.get("cloud:p")).toEqual({ group: "g", at: 7 });
    expect(groups).toEqual([group("g", "频道", { at: 2 })]);
    await organizer.forget("a");
    expect([...(await organizer.read()).marks.keys()]).toEqual(["cloud:p"]);
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
    expect((await other.read()).marks.get("a")).toEqual({ starredAt: 1, at: 1 });
  });
});
