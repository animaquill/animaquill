import {
  ChatNewer,
  MemoryCloudLinks,
  memoryChats,
  type AccountAccess,
  type AccountSnapshot,
  type ChatSyncAccess,
  type SavedChat,
} from "@animaquill/host";
import { describe, expect, test } from "vitest";
import { CloudChats, type CloudChatsOptions } from "./cloud-chats.ts";

/**
 * Conversations of projects of the platform going with the account (cloud-chats.ts): written whole
 * over the revision they were read at, the other device's taken where it wrote since, gone here as
 * they go from the account, and gone from this browser as people sign out.
 */

const PLATFORM = "https://app.example";

function accountAs(snapshot: AccountSnapshot): AccountAccess {
  return {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    refresh: async () => {},
    takeOutcome: () => undefined,
    signIn: () => {},
    installApp: () => {},
    signOut: async () => {},
  };
}

/** The account's conversations, as me/chats.ts of AnimaQuill Cloud keeps them. */
function platformChats() {
  const kept = new Map<string, { revision: number; chat: SavedChat }>();
  /** Moves on as people turn the conversations off, see `CloudSwitches.chatsEpoch`. */
  const state = { epoch: 0 };
  const access: ChatSyncAccess = {
    list: async (project) => ({
      chats: [...kept.entries()]
        .filter(([key]) => key.startsWith(`${project}/`))
        .map(([, { revision, chat }]) => ({
          revision,
          summary: { id: chat.id, title: chat.title, updatedAt: chat.updatedAt },
        })),
      epoch: state.epoch,
    }),
    load: async (project, id) => {
      const there = kept.get(`${project}/${id}`);
      return there && { ...structuredClone(there), epoch: state.epoch };
    },
    save: async (project, chat, base) => {
      const there = kept.get(`${project}/${chat.id}`);
      if (there && there.revision !== base) throw new ChatNewer(there.revision);
      const revision = (there?.revision ?? 0) + 1;
      const { synced: _synced, ...rest } = chat;
      kept.set(`${project}/${chat.id}`, { revision, chat: structuredClone(rest) });
      return revision;
    },
    remove: async (project, id) => void kept.delete(`${project}/${id}`),
  };
  /** Turned off on another device, and on again: the platform has none of them any more. */
  const offAndOn = () => {
    kept.clear();
    state.epoch += 1;
  };
  return { kept, access, offAndOn };
}

async function deviceOf(
  platform: ReturnType<typeof platformChats>,
  allowed?: (account: string) => boolean,
  heardEpoch?: CloudChatsOptions["heardEpoch"],
) {
  const links = new MemoryCloudLinks();
  await links.put({
    key: "local-1",
    platform: PLATFORM,
    project: "p1",
    seq: 0,
    pushed: 0,
    linkedAt: 0,
    owner: "u1",
  });
  const local = memoryChats();
  const chats = new CloudChats({
    local,
    remote: platform.access,
    account: accountAs({ status: "signedIn", id: "u1", name: "u1", appInstalled: true }),
    links,
    platform: PLATFORM,
    ...(allowed && { allowed }),
    ...(heardEpoch && { heardEpoch }),
  });
  return { local, chats, links };
}

const chat = (id: string, said: string[], updatedAt: number): SavedChat => ({
  id,
  project: "local-1",
  title: said[0] ?? "",
  updatedAt,
  entries: said.map((text) => ({ kind: "user", text })),
});

describe("conversations of projects of the platform", () => {
  test("turned off and on again elsewhere, unheard of here: what this browser has stays, and goes again", async () => {
    // Review S-W: the account's empty list was taken for "taken away there", and the only copy went.
    const platform = platformChats();
    let seen = 0;
    const heard: number[] = [];
    let device: Awaited<ReturnType<typeof deviceOf>> | undefined;
    // As `CloudSync.heardChatsEpoch`: a new epoch has this browser's go again first.
    const heardEpoch = async (account: string, epoch: number) => {
      heard.push(epoch);
      if (epoch === seen) return;
      await device!.chats.detach(account);
      seen = epoch;
    };
    device = await deviceOf(platform, undefined, heardEpoch);
    await device.chats.save(chat("c1", ["只在这台上"], 1));
    expect(platform.kept.has("p1/c1")).toBe(true);
    platform.offAndOn();
    expect((await device.chats.list("local-1")).map(({ id }) => id)).toEqual(["c1"]);
    expect(await device.local.load("local-1", "c1")).toBeDefined();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(platform.kept.has("p1/c1")).toBe(true);
    expect(heard).toContain(1);
    // The same epoch again: taken away there is taken away here, as before.
    await platform.access.remove("p1", "c1");
    await device.chats.list("local-1");
    expect(await device.local.load("local-1", "c1")).toBeUndefined();
  });

  test("off and on elsewhere, given again there as it was: read here, no copy, nobody told", async () => {
    const platform = platformChats();
    let seen = 0;
    const copied: string[] = [];
    let device: CloudChats | undefined;
    const links = new MemoryCloudLinks();
    await links.put({
      key: "local-1",
      platform: PLATFORM,
      project: "p1",
      seq: 0,
      pushed: 0,
      linkedAt: 0,
      owner: "u1",
    });
    const local = memoryChats();
    device = new CloudChats({
      local,
      remote: platform.access,
      account: accountAs({ status: "signedIn", id: "u1", name: "u1", appInstalled: true }),
      links,
      platform: PLATFORM,
      copied: (title) => copied.push(title),
      heardEpoch: async (account, epoch) => {
        if (epoch === seen) return;
        await device!.detach(account);
        seen = epoch;
      },
    });
    const other = await deviceOf(platform);
    const said = chat("c1", ["没改过的"], 1);
    await device.save(said);
    platform.offAndOn();
    // The other device gives the same conversation again, unchanged.
    await other.local.save(said);
    await other.chats.retry();
    const read = await device.load("local-1", "c1");
    expect(read?.entries).toEqual(said.entries);
    expect(copied).toEqual([]);
    expect((await local.list("local-1")).map(({ id }) => id)).toEqual(["c1"]);
    expect((await local.load("local-1", "c1"))?.synced).toBe(platform.kept.get("p1/c1")?.revision);
  });

  test("read one by one after it was off and on elsewhere: kept, and the account's is another", async () => {
    const platform = platformChats();
    let seen = 0;
    let device: Awaited<ReturnType<typeof deviceOf>> | undefined;
    const heardEpoch = async (account: string, epoch: number) => {
      if (epoch === seen) return;
      await device!.chats.detach(account);
      seen = epoch;
    };
    device = await deviceOf(platform, undefined, heardEpoch);
    const other = await deviceOf(platform);
    await device.chats.save(chat("c1", ["这台的"], 1));
    platform.offAndOn();
    // Another device gave one of the same id since, at the same revision as this one had.
    await other.local.remove("local-1", "c1");
    await other.chats.save(chat("c1", ["那台的"], 2));
    const read = await device.chats.load("local-1", "c1");
    expect(read?.entries).toEqual([{ kind: "user", text: "那台的" }]);
    const titles = (await device.local.list("local-1")).map(({ title }) => title);
    expect(titles).toContain("《这台的》在这台设备上的副本");
  });

  test("turned off for the account: only of this browser; on again, they go", async () => {
    const platform = platformChats();
    let on = false;
    const one = await deviceOf(platform, () => on);
    await one.chats.save(chat("c1", ["关着时聊的"], 1));
    expect(platform.kept.size).toBe(0);
    expect((await one.chats.list("local-1")).map(({ id }) => id)).toEqual(["c1"]);
    on = true;
    await one.chats.retry();
    expect(platform.kept.has("p1/c1")).toBe(true);
    expect(one.chats.getSnapshot().status).toBe("synced");
  });

  test("the account's copy gone as they were turned off: kept here, and they go again once on", async () => {
    const platform = platformChats();
    const one = await deviceOf(platform);
    await one.chats.save(chat("c1", ["a"], 1));
    expect((await one.local.load("local-1", "c1"))?.synced).toBe(1);
    // Off, on another device: the platform keeps none.
    platform.kept.clear();
    await one.chats.detach("u1");
    expect((await one.local.load("local-1", "c1"))?.synced).toBeUndefined();
    // On again: read, it is not taken for gone from the account, and goes.
    expect((await one.chats.list("local-1")).map(({ id }) => id)).toEqual(["c1"]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(platform.kept.has("p1/c1")).toBe(true);
  });

  test("go to the account, and another device reads them", async () => {
    const platform = platformChats();
    const one = await deviceOf(platform);
    const two = await deviceOf(platform);
    await one.chats.save(chat("c1", ["开场放慢"], 1));
    expect(platform.kept.get("p1/c1")?.revision).toBe(1);
    expect((await two.chats.list("local-1")).map(({ id }) => id)).toEqual(["c1"]);
    expect((await two.chats.load("local-1", "c1"))?.entries).toHaveLength(1);
  });

  test("written over an old revision: refused, and the other device's is taken here", async () => {
    const platform = platformChats();
    const one = await deviceOf(platform);
    const two = await deviceOf(platform);
    await one.chats.save(chat("c1", ["a"], 1));
    await two.chats.load("local-1", "c1");
    await one.chats.save(chat("c1", ["a", "one"], 2));
    await expect(two.chats.save(chat("c1", ["a", "two"], 3))).rejects.toBeInstanceOf(ChatNewer);
    expect(platform.kept.get("p1/c1")?.chat.entries).toEqual([
      { kind: "user", text: "a" },
      { kind: "user", text: "one" },
    ]);
    expect((await two.local.load("local-1", "c1"))?.entries).toHaveLength(2);
    expect((await two.local.load("local-1", "c1"))?.synced).toBe(2);
  });

  test("gone from the account, gone here; never on it, it goes", async () => {
    const platform = platformChats();
    const one = await deviceOf(platform);
    await one.chats.save(chat("c1", ["a"], 1));
    // Written here while nobody could reach the platform.
    await one.local.save(chat("c2", ["offline"], 2));
    await platform.access.remove("p1", "c1");
    const listed = await one.chats.list("local-1");
    expect(listed.map(({ id }) => id)).toEqual(["c2"]);
    expect(await one.local.load("local-1", "c1")).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(platform.kept.has("p1/c2")).toBe(true);
  });

  test("signing out: what the account has leaves this browser, what it does not stays", async () => {
    const platform = platformChats();
    const one = await deviceOf(platform);
    await one.chats.save(chat("c1", ["a"], 1));
    await one.local.save(chat("c2", ["only here"], 2));
    await one.chats.beforeSignOut();
    expect(await one.local.load("local-1", "c1")).toBeUndefined();
    expect(await one.local.load("local-1", "c2")).toBeDefined();
  });

  test("signing out: what changed here and did not go stays, and goes once signed in again", async () => {
    // Review CM5, G1.
    const platform = platformChats();
    const one = await deviceOf(platform);
    await one.chats.save(chat("c1", ["a"], 1));
    const save = platform.access.save;
    platform.access.save = async () => {
      throw new TypeError("network");
    };
    await one.chats.save(chat("c1", ["a", "an hour of paid AI work"], 2));
    await one.chats.beforeSignOut();
    expect((await one.local.load("local-1", "c1"))?.entries).toHaveLength(2);
    // Online, signed in again: it goes as the list is read.
    platform.access.save = save;
    await one.chats.list("local-1");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(platform.kept.get("p1/c1")?.chat.entries).toHaveLength(2);
    // As the account has it now: it goes with signing out.
    await one.chats.beforeSignOut();
    expect(await one.local.load("local-1", "c1")).toBeUndefined();
  });

  test("another device wrote it since: this browser's is kept as a new conversation, and people told", async () => {
    // Review CM5, G2.
    const platform = platformChats();
    const one = await deviceOf(platform);
    const copied: string[] = [];
    const chats = new CloudChats({
      local: one.local,
      remote: platform.access,
      account: accountAs({ status: "signedIn", id: "u1", name: "u1", appInstalled: true }),
      links: one.links,
      platform: PLATFORM,
      copied: (_title, copy) => copied.push(copy),
    });
    await chats.save(chat("c1", ["a"], 1));
    platform.kept.set("p1/c1", { revision: 2, chat: chat("c1", ["a", "from device B"], 5) });
    await expect(chats.save(chat("c1", ["a", "from device A"], 6))).rejects.toBeInstanceOf(
      ChatNewer,
    );
    expect(copied).toEqual(["《a》在这台设备上的副本"]);
    const listed = await one.local.list("local-1");
    const copy = listed.find(({ title }) => title === "《a》在这台设备上的副本")!;
    expect(copy).toBeDefined();
    expect(JSON.stringify((await one.local.load("local-1", copy.id))?.entries)).toContain(
      "from device A",
    );
    expect(JSON.stringify((await one.local.load("local-1", "c1"))?.entries)).toContain(
      "from device B",
    );
    // The copy goes to the account too.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(platform.kept.has(`p1/${copy.id}`)).toBe(true);
  });

  test("read while the account has a newer version and this browser changed it: kept as a copy", async () => {
    const platform = platformChats();
    const one = await deviceOf(platform);
    await one.chats.save(chat("c1", ["a"], 1));
    // Changed here without going (offline), and elsewhere meanwhile.
    const kept = (await one.local.load("local-1", "c1"))!;
    await one.local.save({
      ...kept,
      entries: [...kept.entries, { kind: "user", text: "here" }],
      updatedAt: 3,
    });
    platform.kept.set("p1/c1", { revision: 2, chat: chat("c1", ["a", "there"], 4) });
    const read = await one.chats.load("local-1", "c1");
    expect(JSON.stringify(read?.entries)).toContain("there");
    const titles = (await one.local.list("local-1")).map(({ title }) => title);
    expect(titles).toContain("《a》在这台设备上的副本");
  });
});
