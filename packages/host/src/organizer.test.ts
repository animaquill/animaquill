import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import {
  CloudOtherAccount,
  OrganizerOffline,
  type AccountChanges,
  type AccountOrganized,
  type OrganizerAccess,
  type ProjectGroup,
  type SettingsStore,
} from "./index.ts";
import { cleanGroupName, groupNameOf } from "./organize-rules.ts";
import {
  browserOrganizer,
  memoryOrganizer,
  mergeMarks,
  platformOrganizer,
  type OrganizerChannel,
} from "./organizer.ts";

/** Windows of one browser: what one posts, the others hear. */
function channels() {
  const windows = new Set<() => void>();
  return (): OrganizerChannel => {
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
}

function browserOf() {
  const factory = new IDBFactory();
  const channel = channels();
  return () => browserOrganizer(() => factory, channel);
}

const group = (id: string, name: string, more: Partial<ProjectGroup> = {}): ProjectGroup => ({
  id,
  name,
  at: 1,
  ...more,
});

describe("the marks of a project", () => {
  it("change what is given and keep the rest", () => {
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

  it("do not take opening for organising", () => {
    const before = mergeMarks(undefined, { starredAt: 10, at: 10 });
    expect(mergeMarks(before, { openedAt: 50, at: 50 })).toEqual({
      openedAt: 50,
      starredAt: 10,
      at: 10,
    });
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
    await organizer.putGroup(group("g", "工作"));
    await organizer.putGroup(group("g", "频道", { at: 2 }));
    const { marks, groups } = await organizer.read();
    expect(marks.get("a")).toEqual({ starredAt: 5, group: "g", at: 6 });
    expect(groups).toEqual([group("g", "频道", { at: 2 })]);
    await organizer.forget("a");
    expect([...(await organizer.read()).marks.keys()]).toEqual([]);
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

describe("names of groups", () => {
  it("have no control or format characters, nor separators of lines: those become a space", () => {
    expect(cleanGroupName(" A\tB ")).toBe("A B");
    expect(cleanGroupName("工作​")).toBe("工作");
    expect(cleanGroupName("a b c\u0085d‮e")).toBe("a b c d e");
    expect(groupNameOf(" 工作 ")).toBe("工作");
    expect(groupNameOf("😀".repeat(60))).toBe("😀".repeat(60));
    for (const no of ["", " ", "A\tB", "工作​", "​", "字".repeat(61), 5, undefined])
      expect(groupNameOf(no), JSON.stringify(no)).toBeUndefined();
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

/** A backend that keeps how one person organises, the later of each field, as sync/organize.ts. */
function backendOf(account = "u1") {
  const state: { groups: AccountOrganized["groups"][number][]; marks: Map<string, any> } = {
    groups: [],
    marks: new Map(),
  };
  let reachable = true;
  const changes: AccountChanges[] = [];
  const now = (): AccountOrganized => ({
    account,
    groups: [...state.groups],
    marks: [...state.marks.values()],
  });
  const access: OrganizerAccess = {
    async read() {
      if (!reachable) throw new TypeError("Failed to fetch");
      return now();
    },
    async change(given) {
      if (!reachable) throw new TypeError("Failed to fetch");
      if (given.account !== account) throw new CloudOtherAccount("Somebody else");
      changes.push(given);
      const groups = (given.groups ?? []).map((each) => {
        const index = state.groups.findIndex(({ id }) => id === each.id);
        const before = state.groups[index];
        if (before && before.at > each.at) return "older" as const;
        if (index >= 0) state.groups[index] = each;
        else state.groups.push(each);
        return "kept" as const;
      });
      const marks = (given.marks ?? []).map((each) => {
        const before = state.marks.get(each.project) ?? { project: each.project };
        const after = { ...before };
        if (each.star && (before.star?.at ?? -1) <= each.star.at) after.star = each.star;
        if (each.group && (before.group?.at ?? -1) <= each.group.at) after.group = each.group;
        if (each.opened && (before.opened ?? -1) < each.opened.at) after.opened = each.opened.at;
        state.marks.set(each.project, after);
        return { project: each.project };
      });
      return { groups, marks, state: now() };
    },
  };
  return {
    access,
    changes,
    setReachable: (value: boolean) => {
      reachable = value;
    },
  };
}

function memorySettings(): SettingsStore {
  const kept = new Map<string, unknown>();
  return {
    load: async (key) => structuredClone(kept.get(key)),
    save: async (key, value) => void kept.set(key, structuredClone(value)),
    listen: () => () => {},
  };
}

describe("the organizer of the online mode, on the backend", () => {
  it("writes each change to the backend at once: another computer reads the same", async () => {
    const backend = backendOf();
    const one = platformOrganizer({ access: backend.access, account: "u1", watch: false });
    const other = platformOrganizer({ access: backend.access, account: "u1", watch: false });
    await one.putGroup(group("g", "工作", { at: 5 }));
    await one.mark("cloud:p1", { starredAt: 10, at: 10 });
    await other.mark("cloud:p2", { group: "g", at: 11 });
    await other.mark("cloud:p1", { openedAt: 12, at: 12 });
    for (const each of [one, other]) {
      const { marks, groups } = await each.read();
      expect(groups).toEqual([group("g", "工作", { at: 5 })]);
      expect(marks.get("cloud:p1")).toEqual({ starredAt: 10, openedAt: 12, at: 10 });
      expect(marks.get("cloud:p2")).toEqual({ group: "g", at: 11 });
    }
    // Opening says when, not a star or a group.
    expect(backend.changes.at(-1)?.marks).toEqual([{ project: "p1", opened: { at: 12 } }]);
  });

  it("changes nothing while the backend cannot be reached, and shows what it had last", async () => {
    const backend = backendOf();
    const cache = memorySettings();
    const one = platformOrganizer({
      access: backend.access,
      account: "u1",
      cache,
      watch: false,
    });
    await one.mark("cloud:p1", { starredAt: 10, at: 10 });
    expect((await one.read()).marks.get("cloud:p1")?.starredAt).toBe(10);
    backend.setReachable(false);
    await expect(one.mark("cloud:p1", { starredAt: null, at: 20 })).rejects.toBeInstanceOf(
      OrganizerOffline,
    );
    await expect(one.putGroup(group("g", "工作"))).rejects.toBeInstanceOf(OrganizerOffline);
    expect((await one.read()).marks.get("cloud:p1")?.starredAt).toBe(10);
    // A page that starts without the backend: what the browser kept of it.
    const later = platformOrganizer({ access: backend.access, account: "u1", cache, watch: false });
    expect((await later.read()).marks.get("cloud:p1")?.starredAt).toBe(10);
    // Not another account's.
    const other = platformOrganizer({ access: backend.access, account: "u2", cache, watch: false });
    await expect(other.read()).rejects.toThrow();
  });

  it("takes a backend that answers badly, or not in time, for one that cannot be reached", async () => {
    const backend = backendOf();
    const one = platformOrganizer({
      access: {
        read: backend.access.read,
        change: async () => {
          throw new Error("The platform answered 502");
        },
      },
      account: "u1",
      watch: false,
    });
    const warn = console.warn;
    console.warn = () => {};
    try {
      await expect(one.mark("cloud:p1", { starredAt: 1, at: 1 })).rejects.toBeInstanceOf(
        OrganizerOffline,
      );
    } finally {
      console.warn = warn;
    }
  });

  it("tells the other windows of this browser what one changed", async () => {
    const backend = backendOf();
    const channel = channels();
    const one = platformOrganizer({ access: backend.access, account: "u1", channel, watch: false });
    const other = platformOrganizer({
      access: backend.access,
      account: "u1",
      channel,
      watch: false,
    });
    let heard = 0;
    other.listen(() => (heard += 1));
    await one.mark("cloud:p1", { starredAt: 1, at: 1 });
    expect(heard).toBe(1);
    expect((await other.read()).marks.get("cloud:p1")?.starredAt).toBe(1);
  });

  it("asks who is signed in again where the session is somebody else's", async () => {
    const backend = backendOf("u2");
    let asked = 0;
    const one = platformOrganizer({
      access: backend.access,
      account: "u1",
      watch: false,
      signedOut: () => (asked += 1),
    });
    await expect(one.mark("cloud:p1", { starredAt: 1, at: 1 })).rejects.toBeInstanceOf(
      CloudOtherAccount,
    );
    expect(asked).toBe(1);
  });
});
