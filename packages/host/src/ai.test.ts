import { IDBFactory, IDBIndex, IDBObjectStore, IDBTransaction } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import {
  KEYS_DATABASE,
  browserChatImages,
  browserChats,
  browserKeys,
  memoryChatImages,
  memoryChats,
} from "./ai.ts";
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
    await keys.write("a", { key: "sk-one" });
    await keys.write("b", { baseUrl: "http://localhost:11434/v1", headers: { "api-key": "x" } });
    expect(await browserKeys(() => factory).read("a")).toEqual({ key: "sk-one" });
    expect(await keys.read("b")).toEqual({
      baseUrl: "http://localhost:11434/v1",
      headers: { "api-key": "x" },
    });
    expect((await keys.list()).toSorted()).toEqual(["a", "b"]);
    await keys.remove("a");
    expect(await keys.read("a")).toBeUndefined();
    await keys.clear();
    expect(await keys.list()).toEqual([]);
  });

  it("change one part at once in two windows, and both parts stay", async () => {
    const factory = new IDBFactory();
    const one = browserKeys(() => factory);
    const two = browserKeys(() => factory);
    await one.write("a", { key: "sk-old", baseUrl: "https://old.example" });
    await Promise.all([
      one.update("a", (before) => ({ ...before, key: "sk-new" })),
      two.update("a", (before) => ({ ...before, baseUrl: "https://new.example" })),
    ]);
    expect(await one.read("a")).toEqual({ key: "sk-new", baseUrl: "https://new.example" });
    // Nothing left takes it away.
    expect(await one.update("a", () => ({}))).toBeUndefined();
    expect(await one.list()).toEqual([]);
  });

  it("write nothing over what cannot be read", async () => {
    const factory = new IDBFactory();
    const opened = factory.open(KEYS_DATABASE, 1);
    opened.onupgradeneeded = () => opened.result.createObjectStore("keys", { keyPath: "service" });
    await new Promise((resolve) => (opened.onsuccess = resolve));
    const bad = opened.result.transaction("keys", "readwrite");
    bad.objectStore("keys").put({ service: "a", key: 42 });
    await new Promise((resolve) => (bad.oncomplete = resolve));
    opened.result.close();
    const keys = browserKeys(() => factory);
    await expect(keys.update("a", () => ({ baseUrl: "https://x.example" }))).rejects.toThrow();
  });

  it("read a key as pages of before 0.3.72 kept it, and keep it where they read it", async () => {
    const factory = new IDBFactory();
    // As those pages wrote it: the key alone.
    const opened = factory.open(KEYS_DATABASE, 1);
    opened.onupgradeneeded = () => opened.result.createObjectStore("keys", { keyPath: "service" });
    await new Promise((resolve) => (opened.onsuccess = resolve));
    const old = opened.result.transaction("keys", "readwrite");
    old.objectStore("keys").put({ service: "a", key: "sk-old" });
    await new Promise((resolve) => (old.oncomplete = resolve));
    opened.result.close();
    const keys = browserKeys(() => factory);
    expect(await keys.read("a")).toEqual({ key: "sk-old" });
    await keys.write("a", { key: "sk-old", baseUrl: "https://gw.example" });
    // Where they read it.
    const again = factory.open(KEYS_DATABASE, 1);
    await new Promise((resolve) => (again.onsuccess = resolve));
    const read = again.result.transaction("keys").objectStore("keys").get("a");
    await new Promise((resolve) => (read.onsuccess = resolve));
    expect(read.result).toEqual({ service: "a", key: "sk-old", baseUrl: "https://gw.example" });
    again.result.close();
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
    await host.keys?.write("a", {
      key: "sk-secret-123456",
      baseUrl: "https://secret-gateway.example",
      headers: { "x-secret": "sk-secret-header" },
    });
    for (let index = 0; index < local.length; index += 1) {
      expect(local.getItem(local.key(index) ?? "")).not.toMatch(/sk-secret|secret-gateway/);
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

  it("write a conversation and commit it before they read anything, so that a page that goes right after keeps it", async () => {
    const factory = new IDBFactory();
    const chats = browserChats(() => factory, 2);
    await chats.save(chat("warm", 1));
    const calls: string[] = [];
    const proto = IDBObjectStore.prototype;
    const index = IDBIndex.prototype;
    const transaction = IDBTransaction.prototype;
    const put = proto.put;
    const getAll = index.getAll;
    const commit = transaction.commit;
    proto.put = function (...args: Parameters<typeof put>) {
      calls.push("put");
      return put.apply(this, args);
    };
    index.getAll = function (...args: Parameters<typeof getAll>) {
      calls.push("getAll");
      return getAll.apply(this, args);
    };
    transaction.commit = function () {
      calls.push("commit");
      commit.apply(this);
    };
    try {
      await chats.save(chat("last", 2));
    } finally {
      proto.put = put;
      index.getAll = getAll;
      transaction.commit = commit;
    }
    expect(calls.slice(0, 2)).toEqual(["put", "commit"]);
  });

  it("keep a conversation whose write was under way as the page went, though the page never hears back", async () => {
    const factory = new IDBFactory();
    const chats = browserChats(() => factory, 2);
    await chats.save(chat("warm", 1));
    const proto = IDBObjectStore.prototype;
    const put = proto.put;
    proto.put = function (...args: Parameters<typeof put>) {
      const request = put.apply(this, args);
      const writing = this.transaction;
      // The page goes right after the write starts: what it did not commit by then is taken back.
      queueMicrotask(() => {
        try {
          writing.abort();
        } catch {
          // Committed already: it stays.
        }
      });
      return request;
    };
    try {
      await chats.save(chat("last", 2)).catch(() => {});
    } finally {
      proto.put = put;
    }
    expect(await chats.load("p", "last")).toEqual(chat("last", 2));
  });

  it("keep a conversation as saved where taking the oldest away after it fails", async () => {
    const factory = new IDBFactory();
    const chats = browserChats(() => factory, 2);
    await chats.save(chat("a", 1));
    await chats.save(chat("b", 2));
    const index = IDBIndex.prototype;
    const getAll = index.getAll;
    index.getAll = function () {
      throw new DOMException("gone", "UnknownError");
    };
    try {
      await expect(chats.save(chat("c", 3))).resolves.toBeUndefined();
    } finally {
      index.getAll = getAll;
    }
    expect(await chats.load("p", "c")).toEqual(chat("c", 3));
    // The next save takes the oldest away.
    await chats.save(chat("d", 4));
    expect((await chats.list("p")).map(({ id }) => id)).toEqual(["d", "c"]);
  });

  it("say how many there are of each project, and about how much they take", async () => {
    const factory = new IDBFactory();
    for (const chats of [browserChats(() => factory), memoryChats()]) {
      expect(await chats.usage?.()).toEqual([]);
      await chats.save(chat("a", 1));
      await chats.save(chat("b", 2));
      await chats.save(chat("x", 1, "other"));
      const usage = (await chats.usage?.()) ?? [];
      const of = (project: string) => usage.find((each) => each.project === project);
      expect(usage).toHaveLength(2);
      expect(of("p")?.count).toBe(2);
      expect(of("other")?.count).toBe(1);
      const size = new Blob([JSON.stringify(chat("x", 1, "other"))]).size;
      expect(of("other")?.bytes).toBe(size);
      await chats.forget("p");
      expect(await chats.usage?.()).toEqual([{ project: "other", count: 1, bytes: size }]);
    }
  });
});

describe("pictures of conversations", () => {
  it("are kept once by the hash of their bytes, and read back", async () => {
    const factory = new IDBFactory();
    for (const images of [browserChatImages(() => factory), memoryChatImages()]) {
      const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "image/jpeg" });
      const ref = await images.save(blob, { width: 4, height: 3 });
      expect(ref).toEqual({
        image: "sha256:039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81",
        type: "image/jpeg",
        width: 4,
        height: 3,
        bytes: 3,
      });
      const again = await images.save(
        new Blob([new Uint8Array([1, 2, 3])], { type: "image/jpeg" }),
        {
          width: 4,
          height: 3,
        },
      );
      expect(again.image).toBe(ref.image);
      const read = await images.read(ref.image);
      expect(new Uint8Array((await read?.arrayBuffer()) ?? new ArrayBuffer(0))).toEqual(
        new Uint8Array([1, 2, 3]),
      );
      expect(await images.read("sha256:none")).toBeUndefined();
      expect(await images.keys()).toEqual([{ image: ref.image, bytes: 3 }]);
      await images.delete([ref.image]);
      expect(await images.keys()).toEqual([]);
      expect(await images.read(ref.image)).toBeUndefined();
    }
  });
});
