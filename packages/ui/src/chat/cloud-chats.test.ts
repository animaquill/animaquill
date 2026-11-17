import {
  ChatNewer,
  ChatOutdated,
  MemoryCloudLinks,
  memoryChats,
  type AccountAccess,
  type AccountSnapshot,
  type ChatSyncAccess,
  type SavedChat,
} from "@animaquill/host";
import { readEntry } from "@animaquill/agent";
import { describe, expect, test } from "vitest";
import { CloudChats } from "./cloud-chats.ts";

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
  const access: ChatSyncAccess = {
    list: async (project) => ({
      chats: [...kept.entries()]
        .filter(([key]) => key.startsWith(`${project}/`))
        .map(([, { revision, chat }]) => ({
          revision,
          summary: { id: chat.id, title: chat.title, updatedAt: chat.updatedAt },
        })),
    }),
    load: async (project, id) => {
      const there = kept.get(`${project}/${id}`);
      return there && structuredClone(there);
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
  return { kept, access };
}

async function deviceOf(
  platform: ReturnType<typeof platformChats>,
  allowed?: (account: string) => boolean,
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

  test("turned off on this device: the account's stay, another device goes on, and on again this one has them", async () => {
    const platform = platformChats();
    let on = true;
    const one = await deviceOf(platform, () => on);
    const two = await deviceOf(platform);
    await one.chats.save(chat("c1", ["开着时聊的"], 1));
    on = false;
    await one.chats.save(chat("c2", ["关着时聊的"], 2));
    // Nothing taken away, and nothing of what was said here meanwhile went.
    expect([...platform.kept.keys()]).toEqual(["p1/c1"]);
    await two.chats.save(chat("c3", ["另一台聊的"], 3));
    expect((await one.chats.list("local-1")).map(({ id }) => id).toSorted()).toEqual(["c1", "c2"]);
    on = true;
    expect((await one.chats.list("local-1")).map(({ id }) => id).toSorted()).toEqual([
      "c1",
      "c2",
      "c3",
    ]);
    await one.chats.retry();
    expect(platform.kept.has("p1/c2")).toBe(true);
  });

  test("先出方案 goes with it: the switch, the messages that asked for a plan, and the one that accepted it", async () => {
    const platform = platformChats();
    const one = await deviceOf(platform);
    const two = await deviceOf(platform);
    const said = [
      { role: "user", text: "做个片头", task: "t1", at: 1, plan: true },
      { role: "user", text: "按这个做：片头", task: "t2", at: 2, fromPlan: "toolu_1" },
    ];
    await one.chats.save({ ...chat("c1", [], 1), entries: said, planFirst: true });
    const read = await two.chats.load("local-1", "c1");
    expect(read?.planFirst).toBe(true);
    expect((read?.entries ?? []).map(readEntry)).toEqual(said);
  });

  test("a summary of the earlier conversation goes with it, and the other device has it as it was", async () => {
    const platform = platformChats();
    const one = await deviceOf(platform);
    const two = await deviceOf(platform);
    const summary = {
      role: "summary",
      kind: "summary",
      through: 2,
      text: "1. What the user wants: the title lower.",
      count: 2,
      before: 170_000,
      after: 40_000,
      window: 200_000,
      by: "auto",
      at: 5,
    };
    await one.chats.save({
      ...chat("c1", [], 1),
      entries: [
        { role: "user", text: "把标题挪下来", task: "t1", at: 1 },
        {
          role: "assistant",
          text: "好",
          calls: [],
          at: 2,
          end: "done",
          service: "s",
          protocol: "p",
          model: "m",
        },
        { role: "user", text: "再小一点", task: "t2", at: 3 },
        summary,
      ],
    });
    const read = await two.chats.load("local-1", "c1");
    const entries = (read?.entries ?? []).map(readEntry);
    expect(entries.at(-1)).toEqual(summary);
  });

  test("refused as this page is too old: it stays here, and the status says to reload", async () => {
    const platform = platformChats();
    const one = await deviceOf({
      ...platform,
      access: {
        ...platform.access,
        save: async () => {
          throw new ChatOutdated();
        },
      },
    });
    await one.chats.save(chat("c1", ["旧页面写的"], 1));
    expect(one.chats.getSnapshot().status).toBe("outdated");
    expect(platform.kept.size).toBe(0);
    expect((await one.local.load("local-1", "c1"))?.entries).toHaveLength(1);
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

  test("what the editor showed as each message was sent goes with it, and another device reads it", async () => {
    const platform = platformChats();
    const one = await deviceOf(platform);
    const two = await deviceOf(platform);
    const selection = {
      timeline: "main",
      playhead: "12.5",
      clips: ["clip_title", "clip_logo"],
      transition: { clip: "clip_title", edge: "exit" },
    };
    await one.chats.save({
      ...chat("c1", [], 1),
      entries: [{ role: "user", text: "把这两个放慢", at: 1, task: "chat-t1", selection }],
    });
    const there = await two.chats.load("local-1", "c1");
    const [entry] = (there?.entries ?? []).map(readEntry);
    expect(entry?.role === "user" && entry.selection).toEqual(selection);
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

  test("a save writes here before it reads anything, so that a page that goes right after keeps the answer", async () => {
    const platform = platformChats();
    const one = await deviceOf(platform);
    await one.chats.save(chat("c1", ["第一句"], 1));
    const calls: string[] = [];
    const { save, load } = one.local;
    one.local.save = (value) => {
      calls.push("save");
      return save.call(one.local, value);
    };
    one.local.load = (project, id) => {
      calls.push("load");
      return load.call(one.local, project, id);
    };
    await one.chats.save(chat("c1", ["第一句", "最后一句"], 2));
    expect(calls[0]).toBe("save");
  });

  test("the first save of a new conversation writes while a read of this browser never comes back, as the page goes", async () => {
    const platform = platformChats();
    const one = await deviceOf(platform);
    const { save } = one.local;
    let written: SavedChat | undefined;
    one.local.save = (value) => {
      written = value;
      return save.call(one.local, value);
    };
    // The page is on its way out: nothing read from this browser comes back any more.
    one.local.load = () => new Promise(() => {});
    void one.chats.save(chat("c1", ["说一句话", "这是最后一句。"], 1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(JSON.stringify(written?.entries)).toContain("这是最后一句。");
  });

  test("a save goes over the revision this window saw, not one another window wrote here since", async () => {
    const platform = platformChats();
    const one = await deviceOf(platform);
    await one.chats.save(chat("c1", ["a"], 1));
    // Another window of this browser opens it, adds to it, and it goes.
    const other = new CloudChats({
      local: one.local,
      remote: platform.access,
      account: accountAs({ status: "signedIn", id: "u1", name: "u1", appInstalled: true }),
      links: one.links,
      platform: PLATFORM,
    });
    await other.load("local-1", "c1");
    await other.save(chat("c1", ["a", "from the other window"], 2));
    // This window goes on from what it had: the other window's words are not written over on the
    // account, and this one's are kept as a copy.
    await expect(one.chats.save(chat("c1", ["a", "from this window"], 3))).rejects.toBeInstanceOf(
      ChatNewer,
    );
    expect(JSON.stringify(platform.kept.get("p1/c1")?.chat.entries)).toContain(
      "from the other window",
    );
    const titles = (await one.local.list("local-1")).map(({ title }) => title);
    expect(titles).toContain("《a》在这台设备上的副本");
  });

  test("a conversation gone from the account and written again goes as a new one", async () => {
    const platform = platformChats();
    const one = await deviceOf(platform);
    await one.chats.save(chat("c1", ["a"], 1));
    await one.chats.remove("local-1", "c1");
    let base: number | null | undefined;
    const { save } = platform.access;
    platform.access.save = (project, value, from) => {
      base = from;
      return save.call(platform.access, project, value, from);
    };
    await one.chats.save(chat("c1", ["a", "again"], 2));
    expect(base).toBeNull();
  });
});
