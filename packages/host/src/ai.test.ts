import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import { KEYS_DATABASE, browserChats, browserKeys } from "./ai.ts";
import { createBrowserHost } from "./browser.ts";

const storage = (): Storage => {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => void values.delete(key),
    setItem: (key, value) => void values.set(key, value),
  };
};

describe("keys of AI services", () => {
  it("are kept in a database of their own, and can go again", async () => {
    const factory = new IDBFactory();
    const keys = browserKeys(() => factory);
    expect(keys.where).toBe(KEYS_DATABASE);
    await keys.write("a", "sk-one");
    await keys.write("b", "sk-two");
    expect(await browserKeys(() => factory).read("a")).toBe("sk-one");
    expect((await keys.list()).toSorted()).toEqual(["a", "b"]);
    await keys.remove("a");
    expect(await keys.read("a")).toBeUndefined();
    await keys.clear();
    expect(await keys.list()).toEqual([]);
  });

  it("are nowhere settings are", async () => {
    const factory = new IDBFactory();
    const local = storage();
    const host = createBrowserHost(
      () => local,
      () => factory,
      storage,
      () => undefined,
    );
    await host.settings.save("ai", { services: [{ id: "a" }] });
    await host.keys?.write("a", "sk-secret-123456");
    for (let index = 0; index < local.length; index += 1) {
      expect(local.getItem(local.key(index) ?? "")).not.toContain("sk-secret");
    }
    const databases = await factory.databases();
    expect(databases.map(({ name }) => name)).toContain(KEYS_DATABASE);
  });
});

describe("conversations with AI", () => {
  const chat = (id: string, updatedAt: number, project = "p") => ({
    id,
    project,
    title: id,
    updatedAt,
    entries: [{ role: "user", text: id }],
  });

  it("are kept by project, newest first, and only so many", async () => {
    const factory = new IDBFactory();
    const chats = browserChats(() => factory, 2);
    await chats.save(chat("a", 1));
    await chats.save(chat("b", 2));
    await chats.save(chat("x", 1, "other"));
    await chats.save(chat("c", 3));
    expect((await chats.list("p")).map(({ id }) => id)).toEqual(["c", "b"]);
    expect(await chats.load("p", "b")).toEqual(chat("b", 2));
    await chats.forget("p");
    expect(await chats.list("p")).toEqual([]);
    expect((await chats.list("other")).map(({ id }) => id)).toEqual(["x"]);
  });
});
