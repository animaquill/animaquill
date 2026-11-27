import {
  ChatNewer,
  memoryChats,
  type AccountChatSummary,
  type ChatSyncAccess,
  type SavedChat,
} from "@animaquill/host";
import { describe, expect, test } from "vitest";
import { AccountChats } from "./account-chats.ts";

/**
 * The conversations of the online mode (account-chats.ts, docs/design/online-offline.md of
 * AnimaQuill Cloud, 2.1): the backend has them; only what did not get there yet waits in the
 * browser, and goes once it can.
 */

/** A backend that keeps conversations by revision, as me/chats.ts does. */
function backendOf() {
  const chats = new Map<string, { revision: number; chat: SavedChat }>();
  const state = { down: false };
  const reach = () => {
    if (state.down) throw new TypeError("Failed to fetch");
  };
  const access: ChatSyncAccess = {
    list: async (project) => {
      reach();
      const found: AccountChatSummary[] = [];
      for (const [key, { revision, chat }] of chats) {
        if (!key.startsWith(`${project}/`)) continue;
        const { entries: _entries, ...summary } = chat;
        found.push({ revision, summary });
      }
      return { chats: found };
    },
    load: async (project, id) => {
      reach();
      return structuredClone(chats.get(`${project}/${id}`));
    },
    save: async (project, chat, base) => {
      reach();
      const there = chats.get(`${project}/${chat.id}`);
      if ((there?.revision ?? null) !== base) throw new ChatNewer(there?.revision ?? 0);
      const revision = (there?.revision ?? 0) + 1;
      const { synced: _synced, syncedAt: _syncedAt, ...rest } = chat;
      chats.set(`${project}/${chat.id}`, { revision, chat: structuredClone(rest) });
      return revision;
    },
    remove: async (project, id) => {
      reach();
      chats.delete(`${project}/${id}`);
    },
  };
  return { chats, state, access };
}

function deviceOf(backend: ReturnType<typeof backendOf>) {
  const outbox = memoryChats();
  const copied: string[] = [];
  const chats = new AccountChats({
    remote: backend.access,
    outbox,
    projectOf: async (key) => (key === "k1" ? "p1" : undefined),
    copied: (_title, copy) => copied.push(copy),
  });
  return { outbox, chats, copied };
}

const chatOf = (id: string, text: string, updatedAt = 1): SavedChat => ({
  id,
  project: "k1",
  title: id,
  updatedAt,
  entries: [{ role: "user", text, at: 1, task: "t1" }],
});

describe("conversations of the online mode", () => {
  test("go to the backend at once, and nothing of them stays in the browser", async () => {
    const backend = backendOf();
    const device = deviceOf(backend);
    await device.chats.save(chatOf("c1", "一"));
    await device.chats.save(chatOf("c1", "二", 2));
    expect(backend.chats.get("p1/c1")).toMatchObject({ revision: 2 });
    expect(await device.outbox.list("k1")).toEqual([]);
    expect(device.chats.getSnapshot().status).toBe("synced");
    // Another computer reads the same.
    const other = deviceOf(backend);
    expect((await other.chats.list("k1")).map(({ id }) => id)).toEqual(["c1"]);
    expect((await other.chats.load("k1", "c1"))?.entries).toEqual(chatOf("c1", "二").entries);
  });

  test("wait in the browser while the backend cannot be reached, show, and go once it can", async () => {
    const backend = backendOf();
    const device = deviceOf(backend);
    await device.chats.save(chatOf("c1", "一"));
    await device.chats.list("k1");
    backend.state.down = true;
    await device.chats.save(chatOf("c1", "断网时说的", 2));
    expect(device.chats.getSnapshot().status).toBe("waiting");
    expect(await device.chats.waiting()).toBe(1);
    // What this page read last, with what waits.
    expect(
      (await device.chats.list("k1")).map(({ id, updatedAt, unsent }) => [id, updatedAt, unsent]),
    ).toEqual([["c1", 2, true]]);
    // Only how the list stands: what waits keeps no such mark.
    expect((await device.outbox.list("k1"))[0]).not.toHaveProperty("unsent");
    expect((await device.chats.load("k1", "c1"))?.entries).toEqual(
      chatOf("c1", "断网时说的").entries,
    );
    // A page that went away meanwhile: the next one sends it.
    backend.state.down = false;
    const later = new AccountChats({
      remote: backend.access,
      outbox: device.outbox,
      projectOf: async (key) => (key === "k1" ? "p1" : undefined),
    });
    await later.flush();
    expect(backend.chats.get("p1/c1")?.chat.entries).toEqual(chatOf("c1", "断网时说的").entries);
    expect(await device.outbox.list("k1")).toEqual([]);
    expect(later.getSnapshot().status).toBe("synced");
    expect((await later.list("k1"))[0]).not.toHaveProperty("unsent");
  });

  test("another device wrote it since: theirs is the conversation, and this one's a copy", async () => {
    const backend = backendOf();
    const one = deviceOf(backend);
    const other = deviceOf(backend);
    await one.chats.save(chatOf("c1", "开头"));
    await other.chats.load("k1", "c1");
    await one.chats.load("k1", "c1");
    await other.chats.save(chatOf("c1", "那边说的", 2));
    const refused = await one.chats.save(chatOf("c1", "这边说的", 3)).catch((error) => error);
    expect(refused).toBeInstanceOf(ChatNewer);
    expect(backend.chats.get("p1/c1")?.chat.entries).toEqual(chatOf("c1", "那边说的").entries);
    expect(one.copied).toEqual(["《c1》在这台设备上的副本"]);
    // The copy goes too, and nothing waits here.
    await one.chats.flush();
    const copies = [...backend.chats.values()].filter(({ chat }) => chat.id !== "c1");
    expect(copies.map(({ chat }) => [chat.title, chat.entries])).toEqual([
      ["《c1》在这台设备上的副本", chatOf("c1", "这边说的").entries],
    ]);
    // Where it went, for whoever goes on writing it there.
    expect((refused as ChatNewer).copy).toEqual({
      id: copies[0]?.chat.id,
      title: "《c1》在这台设备上的副本",
    });
    expect(await one.outbox.list("k1")).toEqual([]);
  });

  test("are taken away on the backend, and whatever of them waits here", async () => {
    const backend = backendOf();
    const device = deviceOf(backend);
    await device.chats.save(chatOf("c1", "一"));
    await device.chats.remove("k1", "c1");
    expect(backend.chats.size).toBe(0);
    backend.state.down = true;
    await device.chats.save(chatOf("c2", "二"));
    await expect(device.chats.remove("k1", "c2")).rejects.toThrow();
    // It stays, as the backend could not be told.
    expect(await device.chats.waiting()).toBe(1);
  });

  test("what waits here goes as people sign out, and says how many", async () => {
    const backend = backendOf();
    const device = deviceOf(backend);
    backend.state.down = true;
    await device.chats.save(chatOf("c1", "没存上的"));
    expect(await device.chats.waiting()).toBe(1);
    expect(await device.chats.dropWaiting()).toBe(1);
    expect(await device.chats.waiting()).toBe(0);
    expect(await device.outbox.list("k1")).toEqual([]);
  });
});
