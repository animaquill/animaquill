import {
  CloudOtherAccount,
  groupNameKey,
  groupNameOf,
  memoryOrganizer,
  type AccountChanges,
  type AccountGroupOutcome,
  type AccountMarksOutcome,
  type AccountOrganized,
  type AccountSnapshot,
  type AccountAccess,
  type OrganizerAccess,
} from "@animaquill/host";
import { describe, expect, it } from "vitest";
import { OrganizerSync, syncOrganizer } from "./organize-sync.ts";
import { StartOrganizer } from "./organize.ts";

/**
 * Stars and groups that go with the account (organize-sync.ts): computers, each a browser with its
 * copy, and a platform that keeps them as apps/api/src/sync/organize.ts does, by its own clock.
 */

interface PlatformGroup {
  name: string;
  at: number;
  deleted: boolean;
}

/**
 * The platform, as sync/organize.ts keeps it for `account`, whose session it is: the later change
 * of each field.
 */
function platformOf(projects: readonly string[], account = "ada") {
  const groups = new Map<string, PlatformGroup>();
  const marks = new Map<
    string,
    { star?: { starred: boolean; at: number }; group?: { id: string | null; at: number } }
  >();
  const own = new Set(projects);
  let reachable = true;
  const state = (): AccountOrganized => ({
    account,
    groups: [...groups].map(([id, group]) => ({
      id,
      name: group.name,
      at: group.at,
      ...(group.deleted && { deleted: true as const }),
    })),
    marks: [...marks].map(([project, each]) => ({ project, ...each })),
  });
  const apply = (changes: AccountChanges, time: (at: number) => number) => {
    const groupOutcomes = (changes.groups ?? []).map((change): AccountGroupOutcome => {
      const at = time(change.at);
      const row = groups.get(change.id);
      const isLater = (deleted: boolean) =>
        !row || at > row.at || (at === row.at && (deleted || !row.deleted));
      if (change.deleted) {
        if (!row) return "missing";
        if (!isLater(true)) return "older";
        groups.set(change.id, { ...row, deleted: true, at });
        return "kept";
      }
      if (!isLater(false)) return "older";
      if (groupNameOf(change.name) === undefined) return "invalid";
      const other = [...groups].find(
        ([id, group]) =>
          id !== change.id &&
          !group.deleted &&
          groupNameKey(group.name) === groupNameKey(change.name),
      );
      if (other) return { taken: other[0] };
      groups.set(change.id, { name: change.name.trim(), at, deleted: false });
      return "kept";
    });
    const marksOutcomes = (changes.marks ?? []).map((change): AccountMarksOutcome => {
      if (!own.has(change.project)) return { project: change.project, missing: true };
      const row = { ...marks.get(change.project) };
      let star: AccountMarksOutcome["star"];
      let group: AccountMarksOutcome["group"];
      if (change.star) {
        const at = time(change.star.at);
        star = !row.star || at >= row.star.at ? "kept" : "older";
        if (star === "kept") row.star = { starred: change.star.starred, at };
      }
      if (change.group) {
        const at = time(change.group.at);
        if (change.group.id !== null && !groups.has(change.group.id)) group = "noGroup";
        else {
          group = !row.group || at >= row.group.at ? "kept" : "older";
          if (group === "kept") row.group = { id: change.group.id, at };
        }
      }
      marks.set(change.project, row);
      return {
        project: change.project,
        ...(star && { star }),
        ...(group && { group }),
      };
    });
    return { groups: groupOutcomes, marks: marksOutcomes };
  };
  return {
    groups,
    marks,
    own,
    set reachable(now: boolean) {
      reachable = now;
    },
    /**
     * How a computer whose clock is `offset` off the platform's reaches it: its times by its own
     * clock both ways, as the host has them, and none later than the platform's now.
     */
    access(platformNow: () => number, offset = 0): OrganizerAccess {
      const local = (organized: AccountOrganized): AccountOrganized => ({
        account: organized.account,
        groups: organized.groups.map((group) => ({ ...group, at: group.at + offset })),
        marks: organized.marks.map((each) => ({
          project: each.project,
          ...(each.star && { star: { ...each.star, at: each.star.at + offset } }),
          ...(each.group && { group: { ...each.group, at: each.group.at + offset } }),
        })),
      });
      const check = () => {
        if (!reachable) throw new Error("offline");
      };
      return {
        async read() {
          check();
          return local(state());
        },
        async change(changes) {
          check();
          if (changes.account !== account) throw new CloudOtherAccount("otherAccount");
          const done = apply(changes, (at) => Math.min(platformNow(), at - offset));
          return { ...done, state: local(state()) };
        },
      };
    },
  };
}

/** One clock that every computer reads, each `offset` off it: no two changes at one time. */
function world(projects: readonly string[] = ["p", "q"]) {
  let time = 1000;
  /** Each account has its own. */
  const platforms = new Map<string, ReturnType<typeof platformOf>>();
  const platformFor = (account: string) => {
    let platform = platforms.get(account);
    if (!platform)
      platforms.set(account, (platform = platformOf(account === "ada" ? projects : [], account)));
    return platform;
  };
  const platform = platformFor("ada");
  const computer = (offset = 0, signedIn: string | null = "ada") => {
    const local = memoryOrganizer();
    let snapshot: AccountSnapshot =
      signedIn === null
        ? { status: "signedOut" }
        : { status: "signedIn", id: signedIn, name: signedIn, appInstalled: true };
    const listeners = new Set<() => void>();
    const access: AccountAccess = {
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      getSnapshot: () => snapshot,
      refresh: async () => {},
      takeOutcome: () => undefined,
      signIn() {},
      installApp() {},
      signOut: async () => {},
    };
    const remoteOf = (account: string) => platformFor(account).access(() => time, offset);
    const remote = remoteOf("ada");
    let ids = 0;
    const organizer = new StartOrganizer({
      organizer: local,
      account: access,
      cloud: remote,
      now: () => (time += 1) + offset,
      newId: () => `${offset}-${(ids += 1)}-${Math.random().toString(36).slice(2, 6)}`,
    });
    organizer.subscribe(() => {});
    organizer.close(); // No timers in tests: rounds go as the test says.
    organizer.subscribe(() => {});
    return {
      local,
      organizer,
      remote,
      signIn(id: string | undefined) {
        snapshot =
          id === undefined
            ? { status: "signedOut" }
            : { status: "signedIn", id, name: id, appInstalled: true };
        for (const listener of listeners) listener();
      },
      sync: (as = "ada") => syncOrganizer(local, remoteOf(as), as, () => time + offset),
      /** This window takes `as` to be signed in; the platform's session is of `session`. */
      staleSync: (as: string, session: string) =>
        syncOrganizer(local, remoteOf(session), as, () => time + offset),
      async refreshed() {
        await organizer.refresh();
        return organizer.getSnapshot();
      },
    };
  };
  return { platform, platformFor, computer, tick: (ms = 1) => (time += ms) };
}

const cloud = (project: string, account = "ada") => ({ key: `cloud:${project}`, account });

const shown = async (computer: {
  refreshed(): Promise<{
    marks: ReadonlyMap<string, any>;
    groups: readonly { id: string; name: string }[];
  }>;
}) => {
  const { marks, groups } = await computer.refreshed();
  const names = new Map(groups.map((group) => [group.id, group.name]));
  const of = (project: string) => {
    const each = marks.get(`cloud:${project}`);
    return {
      starred: each?.starredAt !== undefined && each.starredAt !== null,
      group: typeof each?.group === "string" ? names.get(each.group) : undefined,
    };
  };
  return { groups: groups.map((group) => group.name).toSorted(), p: of("p"), q: of("q") };
};

describe("stars and groups that go with the account", () => {
  it("are the same on another computer", async () => {
    const { computer } = world();
    const one = computer();
    const made = await one.organizer.createGroup("工作");
    if (!made || !("id" in made)) throw new Error("no group");
    await one.organizer.star(cloud("p"), true);
    await one.organizer.moveToGroup(cloud("p"), made.id);
    await one.sync();
    const other = computer();
    await other.sync();
    expect(await shown(other)).toEqual({
      groups: ["工作"],
      p: { starred: true, group: "工作" },
      q: { starred: false, group: undefined },
    });
  });

  // The later change of each field wins, and each field goes on its own: a computer that changed
  // only the group gives only the group, so what another did to the star stays. Taken whole, the
  // star it had from before would take the place of the later one.
  it("both changed it: the later change of each field, and each field on its own", async () => {
    const { computer, platform } = world();
    const one = computer();
    const other = computer();
    const made = await one.organizer.createGroup("工作");
    if (!made || !("id" in made)) throw new Error("no group");
    // Both know p as starred, and in no group.
    await one.organizer.star(cloud("p"), true);
    await one.sync();
    await other.sync();
    // Offline: one takes the star away; the other, later, moves it, from the star it had.
    platform.reachable = false;
    await one.organizer.star(cloud("p"), false);
    await other.organizer.moveToGroup(cloud("p"), made.id);
    // ...and then stars q, after which one stars it too: the later is one's.
    await other.organizer.star(cloud("q"), false);
    await one.organizer.star(cloud("q"), true);
    platform.reachable = true;
    await other.sync();
    await one.sync();
    await other.sync();
    const expected = {
      groups: ["工作"],
      p: { starred: false, group: "工作" },
      q: { starred: true, group: undefined },
    };
    expect(await shown(one)).toEqual(expected);
    expect(await shown(other)).toEqual(expected);
  });

  // The group goes, as taking it away is a change of the group, and putting a project in is not:
  // the project says it is in it still, and shows in none, as everywhere a group goes. A rename
  // later than taking it away brings it back, with what is in it: nothing is lost either way.
  it("a group taken away on one computer, a project put into it on another", async () => {
    const { computer } = world();
    const one = computer();
    const other = computer();
    const made = await one.organizer.createGroup("工作");
    if (!made || !("id" in made)) throw new Error("no group");
    await one.sync();
    await other.sync();
    await one.organizer.deleteGroup(made.id);
    await other.organizer.moveToGroup(cloud("p"), made.id);
    await one.sync();
    await other.sync();
    await one.sync();
    const expected = {
      groups: [],
      p: { starred: false, group: undefined },
      q: { starred: false, group: undefined },
    };
    expect(await shown(one)).toEqual(expected);
    expect(await shown(other)).toEqual(expected);
    expect((await other.local.read()).marks.get("cloud:p")?.group).toBe(made.id);
  });

  it("a group renamed on one computer after another took it away comes back", async () => {
    const { computer } = world();
    const one = computer();
    const other = computer();
    const made = await one.organizer.createGroup("工作");
    if (!made || !("id" in made)) throw new Error("no group");
    await one.organizer.moveToGroup(cloud("p"), made.id);
    await one.sync();
    await other.sync();
    await one.organizer.deleteGroup(made.id);
    await one.sync();
    // The other did not hear of it, and renames it later.
    expect(await other.organizer.renameGroup(made.id, "频道")).toBe(true);
    await other.sync();
    await one.sync();
    const expected = {
      groups: ["频道"],
      p: { starred: false, group: "频道" },
      q: { starred: false, group: undefined },
    };
    expect(await shown(one)).toEqual(expected);
    expect(await shown(other)).toEqual(expected);
  });

  // Two groups of one name are one: the account's, which was there first, and what is in the
  // other moves into it. 6.6: "同名的合成一个，两边都不丢".
  it("groups of one name made on two computers become one, with what was in each", async () => {
    const { computer } = world();
    const one = computer();
    const other = computer();
    const first = await one.organizer.createGroup("工作");
    const second = await other.organizer.createGroup(" 工作");
    if (!first || !("id" in first) || !second || !("id" in second)) throw new Error("no group");
    await one.organizer.moveToGroup(cloud("p"), first.id);
    await other.organizer.moveToGroup(cloud("q"), second.id);
    await one.sync();
    await other.sync();
    await one.sync();
    const expected = {
      groups: ["工作"],
      p: { starred: false, group: "工作" },
      q: { starred: false, group: "工作" },
    };
    expect(await shown(one)).toEqual(expected);
    expect(await shown(other)).toEqual(expected);
  });

  it("groups made while nobody was signed in become the account's, one of a name", async () => {
    const { computer } = world();
    const one = computer();
    const theirs = await one.organizer.createGroup("Work");
    if (!theirs || !("id" in theirs)) throw new Error("no group");
    await one.organizer.moveToGroup(cloud("p"), theirs.id);
    await one.sync();
    // Another computer, signed out: two groups of its own, a local project in one, a project of
    // the platform in the other.
    const other = computer(0, null);
    const work = await other.organizer.createGroup("ＷＯＲＫ");
    const own = await other.organizer.createGroup("自己的");
    if (!work || !("id" in work) || !own || !("id" in own)) throw new Error("no group");
    expect((await other.local.read()).groups.every((group) => group.scope === "browser")).toBe(
      true,
    );
    await other.organizer.moveToGroup({ key: "local-1" }, work.id);
    await other.organizer.moveToGroup(cloud("q"), own.id);
    other.signIn("ada");
    await other.sync();
    await one.sync();
    const expected = {
      groups: ["Work", "自己的"],
      p: { starred: false, group: "Work" },
      q: { starred: false, group: "自己的" },
    };
    expect(await shown(other)).toEqual(expected);
    expect(await shown(one)).toEqual(expected);
    // The local project is in the account's group of that name.
    const local = (await other.refreshed()).marks.get("local-1");
    expect(local?.group).toBe(theirs.id);
  });

  it("another account: what the one before had is not shown, nor taken away", async () => {
    const { computer } = world();
    const one = computer();
    const made = await one.organizer.createGroup("工作");
    if (!made || !("id" in made)) throw new Error("no group");
    await one.organizer.star(cloud("p"), true);
    await one.sync();
    // Bob signs in here: his groups only; Ada's stay here, as they were.
    one.signIn("bob");
    await one.sync("bob");
    expect((await shown(one)).groups).toEqual([]);
    await one.organizer.createGroup("工作");
    const kept = await one.local.read();
    expect(kept.groups.map((group) => [group.name, group.scope])).toEqual(
      expect.arrayContaining([
        ["工作", { account: "ada" }],
        ["工作", { account: "bob" }],
      ]),
    );
    expect(kept.marks.get("cloud:p")).toMatchObject({
      account: "ada",
      starredAt: expect.any(Number),
    });
    // Ada again.
    one.signIn("ada");
    expect((await shown(one)).groups).toEqual(["工作"]);
    expect((await shown(one)).p.starred).toBe(true);
  });

  it("a project that is gone: what was kept of it here goes", async () => {
    const { computer, platform } = world();
    const one = computer();
    await one.organizer.star(cloud("p"), true);
    platform.own.delete("p");
    await one.sync();
    expect((await one.local.read()).marks.has("cloud:p")).toBe(false);
    // One of no account known is only not given again.
    await one.local.mark("cloud:q", { starredAt: 5, at: 5 });
    platform.own.delete("q");
    await one.sync();
    expect((await one.local.read()).marks.get("cloud:q")).toMatchObject({ sent: { star: 5 } });
  });

  // Each computer's times are by its clock; the platform takes them by its own, as far off as the
  // computer's clock was as it sent them (`OrganizerAccess`). The change that came later wins, not
  // the one whose clock was ahead.
  it("clocks that do not agree: the change that came later wins", async () => {
    const { computer, tick } = world();
    const ahead = computer(3600_000);
    const right = computer();
    await ahead.organizer.star(cloud("p"), true);
    await ahead.sync();
    tick(1000);
    await right.sync();
    await right.organizer.star(cloud("p"), false);
    await right.sync();
    await ahead.sync();
    expect((await shown(ahead)).p.starred).toBe(false);
    expect((await shown(right)).p.starred).toBe(false);
  });

  // Nothing is said and nothing is lost: what changed here stays, to be given next time.
  it("offline, or the platform fails: what changed here stays, and goes next time", async () => {
    const { computer, platform } = world();
    const one = computer();
    platform.reachable = false;
    const made = await one.organizer.createGroup("工作");
    if (!made || !("id" in made)) throw new Error("no group");
    await one.organizer.moveToGroup(cloud("p"), made.id);
    await expect(one.sync()).rejects.toThrow("offline");
    expect(await shown(one)).toMatchObject({ groups: ["工作"], p: { group: "工作" } });
    platform.reachable = true;
    await one.sync();
    expect([...platform.groups.values()].map((group) => group.name)).toEqual(["工作"]);
    expect(platform.marks.get("p")?.group?.id).toBe(made.id);
  });

  it("does not take the place of what changed here while it went", async () => {
    const { computer, platform } = world();
    const one = computer();
    const other = computer();
    await other.organizer.star(cloud("p"), true);
    await other.sync();
    // While one reads the platform, it is unstarred here.
    const remote = one.remote;
    const slow: OrganizerAccess = {
      read: async () => {
        const read = await remote.read();
        await one.organizer.star(cloud("p"), false);
        return read;
      },
      change: (changes) => remote.change(changes),
    };
    await syncOrganizer(one.local, slow, "ada");
    expect((await shown(one)).p.starred).toBe(false);
    expect(platform.marks.get("p")?.star?.starred).toBe(false);
  });
});

const DEBUG = false;

describe("what the review of R8 found", () => {
  // Another window signed out and in as bob; this one still takes ada to be signed in. Nothing of
  // ada's goes to bob, nothing of ada's is forgotten as gone, nothing of bob's is kept as ada's.
  it("the platform's session is of somebody else: nothing is given, taken or forgotten", async () => {
    const { computer, platform, platformFor } = world();
    const one = computer();
    platformFor("bob").groups.set("bob-g", { name: "bob 的分组", at: 1, deleted: false });
    platform.reachable = false;
    const made = await one.organizer.createGroup("ada 的私人分组");
    if (!made || !("id" in made)) throw new Error("no group");
    await one.organizer.star(cloud("p"), true);
    platform.reachable = true;
    await expect(one.staleSync("ada", "bob")).rejects.toThrow(CloudOtherAccount);
    expect([...platformFor("bob").groups.values()].map((g) => g.name)).toEqual(["bob 的分组"]);
    const kept = await one.local.read();
    expect(kept.marks.get("cloud:p")?.starredAt).toEqual(expect.any(Number));
    expect(kept.groups.map((g) => g.name)).toEqual(["ada 的私人分组"]);
    // The platform itself takes nothing of another account either.
    await expect(
      platformFor("bob")
        .access(() => 1)
        .change({ account: "ada", groups: [{ id: "x", name: "x", at: 1 }] }),
    ).rejects.toThrow(CloudOtherAccount);
    // Once ada is signed in there again, all of it goes.
    await one.sync();
    expect([...platform.groups.values()].map((g) => g.name)).toEqual(["ada 的私人分组"]);
    expect(platform.marks.get("p")?.star?.starred).toBe(true);
  });

  it("asks who is signed in again, and goes no further, where the session is of somebody else", async () => {
    const { platformFor } = world();
    let asked = 0;
    const timers: unknown[] = [];
    const sync = new OrganizerSync({
      local: memoryOrganizer(),
      remote: platformFor("bob").access(() => 1),
      account: () => "ada",
      setTimer: (run, ms) => {
        timers.push(ms);
        return () => {};
      },
      otherAccount: () => (asked += 1),
    });
    await sync.run();
    expect(asked).toBe(1);
    expect(timers).toEqual([]);
  });

  // A tab pasted from a table, or a group of R5 that was never looked at: what no name has is a
  // space, as the platform keeps it, and the rest goes; one that is nothing then stays here.
  it("a name with characters no name has does not keep anything else from going", async () => {
    const { computer, platform } = world();
    const one = computer();
    // Like a platform that turns the whole of a request away for such a name.
    const strict: OrganizerAccess = {
      read: () => one.remote.read(),
      async change(changes) {
        if ((changes.groups ?? []).some((g) => !g.deleted && groupNameOf(g.name) !== g.name))
          throw new Error("The platform answered 400");
        return one.remote.change(changes);
      },
    };
    const ada = { scope: { account: "ada" } } as const;
    await one.local.putGroup({ id: "tab", name: "A\tB", ...ada, at: 5 });
    await one.local.putGroup({ id: "wide", name: "工作\u200b", ...ada, at: 6 });
    await one.local.putGroup({ id: "none", name: "\u200b\u2028", ...ada, at: 7 });
    await one.local.mark("cloud:q", { group: "none", groupAt: 8, at: 8, account: "ada" });
    await one.organizer.star(cloud("p"), true);
    for (let i = 0; i < 2; i += 1) await syncOrganizer(one.local, strict, "ada");
    expect(platform.marks.get("p")?.star?.starred).toBe(true);
    expect([...platform.groups.values()].map((g) => g.name).toSorted()).toEqual(["A B", "工作"]);
    const kept = await one.local.read();
    expect(kept.groups.find((g) => g.id === "tab")?.name).toBe("A B");
    // Nothing once cleaned: it stays here, and so does the project in it.
    expect(platform.groups.has("none")).toBe(false);
    expect(platform.marks.has("q")).toBe(false);
    // The editor makes no such name any more.
    expect(await one.organizer.createGroup("C\tD")).toEqual({ id: expect.any(String) });
    expect((await one.local.read()).groups.some((g) => g.name === "C D")).toBe(true);
    expect(await one.organizer.createGroup("\u200b")).toEqual({ problem: "empty" });
  });

  // A clock that was ahead a day left a time to come here: changes elsewhere come after it all the
  // same, and so does what people do here.
  it("times kept here that are still to come do not keep later changes out", async () => {
    const { computer, tick } = world();
    const one = computer();
    const other = computer();
    const future = 1000 + 24 * 3600_000;
    await one.local.mark("cloud:p", {
      starredAt: future,
      starAt: future,
      at: future,
      account: "ada",
    });
    await one.sync();
    tick(1000);
    await other.sync();
    await other.organizer.star(cloud("p"), false);
    await other.sync();
    await one.sync();
    expect((await shown(other)).p.starred).toBe(false);
    expect((await shown(one)).p.starred).toBe(false);
    // What people do here comes after whatever is kept here.
    const third = computer();
    await third.local.mark("cloud:q", { starredAt: null, starAt: future, at: future });
    await third.organizer.star(cloud("q"), true);
    expect((await shown(third)).q.starred).toBe(true);
  });

  // R5: a folder that is disconnected keeps how it was organised while it was connected.
  it("a folder that is disconnected keeps its star and group, also once the account has them", async () => {
    const { computer } = world();
    const one = computer();
    const made = await one.organizer.createGroup("工作");
    if (!made || !("id" in made)) throw new Error("no group");
    const target = { key: "cloud:p", also: "f", account: "ada" };
    await one.organizer.star(target, true);
    await one.organizer.moveToGroup(target, made.id);
    await one.sync();
    const { marks } = await one.refreshed();
    expect(marks.get("f")).toMatchObject({ starredAt: expect.any(Number), group: made.id });
    expect(marks.get("f")?.account).toBeUndefined();
  });
});

describe("when it goes to the account", () => {
  /** Timers that go as the test says. */
  function timers() {
    const due: { run: () => void; ms: number }[] = [];
    return {
      due,
      setTimer(run: () => void, ms: number) {
        const timer = { run, ms };
        due.push(timer);
        return () => due.splice(due.indexOf(timer), 1);
      },
      async fire() {
        const timer = due.shift();
        timer?.run();
        await new Promise((resolve) => setTimeout(resolve, 0));
        return timer?.ms;
      },
    };
  }

  it("soon after a change, once for changes in a row; again later, longer each time, where it failed", async () => {
    const { platform } = world();
    const local = memoryOrganizer();
    const clock = timers();
    let account: string | undefined = "ada";
    const sync = new OrganizerSync({
      local,
      remote: platform.access(() => 1_000_000),
      account: () => account,
      setTimer: clock.setTimer,
    });
    sync.soon();
    sync.soon();
    expect(clock.due).toHaveLength(1);
    platform.reachable = false;
    const quiet = console.warn;
    console.warn = () => {};
    try {
      expect(await clock.fire()).toBe(800);
      expect(clock.due.map(({ ms }) => ms)).toEqual([5000]);
      await clock.fire();
      expect(clock.due.map(({ ms }) => ms)).toEqual([10_000]);
    } finally {
      console.warn = quiet;
    }
    platform.reachable = true;
    await local.putGroup({ id: "g", name: "工作", scope: { account: "ada" }, at: 5 });
    await clock.fire();
    expect(clock.due).toEqual([]);
    expect(platform.groups.get("g")?.name).toBe("工作");
    // Nobody signed in: nothing goes.
    account = undefined;
    await local.putGroup({ id: "h", name: "频道", scope: { account: "ada" }, at: 6 });
    await sync.run();
    expect(platform.groups.has("h")).toBe(false);
    sync.close();
    sync.soon();
    expect(clock.due).toEqual([]);
  });
});

/** Random changes on three computers, offline and on, and the platform's: nothing is lost. */
describe("stars and groups, at random", () => {
  const random = (seed: number) => () => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return seed / 2_147_483_648;
  };

  it.each(Array.from({ length: 40 }, (_, i) => i + 1))("seed %i", async (seed) => {
    const next = random(seed);
    const pick = <T>(items: readonly T[]): T | undefined =>
      items.length === 0 ? undefined : items[Math.floor(next() * items.length)];
    const projects = ["p", "q", "r"];
    const { computer, platform } = world(projects);
    // Clocks that do not agree, one of them by a lot.
    const computers = [computer(), computer(7000), computer(-3600_000, null)];
    const signedIn = [true, true, false];
    const made: string[] = [];
    const deleted = new Set<string>();
    /** The last star and group each project was given, by the clock they all share. */
    const lastStar = new Map<string, boolean>();
    const lastGroup = new Map<string, string | null>();
    const log: string[] = [];
    for (let step = 0; step < 60; step += 1) {
      const index = Math.floor(next() * computers.length);
      const one = computers[index]!;
      const { groups } = await one.refreshed();
      const ids = groups.map((group) => group.id);
      const choice = next();
      if (choice < 0.15) {
        const name = pick(["工作", "频道", "WORK", "旧的", "新"])!;
        const outcome = await one.organizer.createGroup(name);
        if (outcome && "id" in outcome) made.push(outcome.id);
        log.push(`${index} create ${name}: ${JSON.stringify(outcome)}`);
      } else if (choice < 0.25) {
        const id = pick(ids);
        const name = pick(["改", "工作 2", "频道"])!;
        const outcome = id && (await one.organizer.renameGroup(id, name));
        if (outcome === true) made.push(id!);
        log.push(`${index} rename ${id} ${name}: ${outcome}`);
      } else if (choice < 0.32) {
        const id = pick(ids);
        if (id && (await one.organizer.deleteGroup(id))) deleted.add(id);
        log.push(`${index} delete ${id}`);
      } else if (choice < 0.55) {
        const project = pick(projects)!;
        const starred = next() > 0.4;
        if (await one.organizer.star(cloud(project), starred)) lastStar.set(project, starred);
        log.push(`${index} star ${project} ${starred}`);
      } else if (choice < 0.8) {
        const project = pick(projects)!;
        const into = next() > 0.25 ? (pick(ids) ?? null) : null;
        if (await one.organizer.moveToGroup(cloud(project), into ?? undefined))
          lastGroup.set(project, into);
        log.push(`${index} move ${project} ${into}`);
      } else if (choice < 0.9 && !signedIn[index]) {
        signedIn[index] = true;
        one.signIn("ada");
        log.push(`${index} signs in`);
      } else if (signedIn[index]) {
        const reachable = next() > 0.2;
        platform.reachable = reachable;
        await one.sync().catch(() => {});
        log.push(`${index} sync ${reachable ? "" : "(offline)"}`);
      }
    }
    platform.reachable = true;
    for (const [index, one] of computers.entries()) if (!signedIn[index]) one.signIn("ada");
    for (let round = 0; round < 3; round += 1) for (const one of computers) await one.sync();

    if (DEBUG) console.log(log.join("\n"));
    // Every computer shows the same.
    const views = await Promise.all(computers.map((one) => shown(one)));
    for (const view of views) expect(view).toEqual(views[0]);
    const contents = await Promise.all(computers.map((one) => one.local.read()));
    const into = new Map(
      contents.flatMap((content) =>
        content.groups.flatMap((group) => (group.into ? [[group.id, group.into] as const] : [])),
      ),
    );
    const finalOf = (id: string) => {
      let at = id;
      while (into.has(at)) at = into.get(at)!;
      return at;
    };
    const live = new Set(
      [...platform.groups].filter(([, group]) => !group.deleted).map(([id]) => id),
    );
    // No group that was made is lost: it is there, as itself or as the one of its name, unless
    // somebody took it away.
    for (const id of made)
      if (
        !deleted.has(id) &&
        !deleted.has(finalOf(id)) &&
        ![...deleted].some((gone) => finalOf(gone) === finalOf(id))
      )
        expect(live.has(finalOf(id)), `group ${id}`).toBe(true);
    // Each project is starred and in the group as it was last said, on every computer: the one
    // that group became, where it is there.
    const seen = (id: string | null | undefined) => {
      if (id === null || id === undefined) return null;
      const final = finalOf(id);
      return live.has(final) ? final : null;
    };
    for (const content of contents)
      for (const project of projects) {
        const marks = content.marks.get(`cloud:${project}`);
        if (lastStar.has(project))
          expect(
            marks?.starredAt !== null && marks?.starredAt !== undefined,
            `star of ${project}`,
          ).toBe(lastStar.get(project));
        if (lastGroup.has(project))
          expect(seen(marks?.group), `group of ${project}`).toBe(seen(lastGroup.get(project)));
      }
  });
});
