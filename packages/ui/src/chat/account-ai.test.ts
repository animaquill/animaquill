import {
  AiSyncTooLarge,
  isLaterEntry,
  mergeSecret,
  type AccountAiChanges,
  type AccountAiSettings,
  type AiEntry,
  type AiSyncAccess,
  type AiSyncKey,
  type SettingsStore,
} from "@animaquill/host";
import { describe, expect, test } from "vitest";
import { AccountAi, AccountAiOffline, CACHE_KEY } from "./account-ai.ts";
import { AiSettingsStore } from "./settings.ts";

/**
 * The AI settings and keys of the online mode (account-ai.ts, docs/design/online-offline.md of
 * AnimaQuill Cloud, 2.1): the backend has them, the page keeps the keys in its memory only, and
 * nothing changes while the backend cannot be reached.
 */

/** A backend that keeps the later of each entry and of each part of a key, as me/ai-sync.ts. */
function backendOf(account = "u1") {
  const entries: Record<string, AiEntry> = {};
  const keys: Record<string, AiSyncKey> = {};
  const state = { revision: 0, down: false, tooLarge: false };
  const changes: AccountAiChanges[] = [];
  const now = (): AccountAiSettings => ({
    account,
    revision: state.revision,
    format: 3,
    entries: structuredClone(entries),
    keys: structuredClone(keys),
  });
  const reach = () => {
    if (state.down) throw new TypeError("Failed to fetch");
  };
  const access: AiSyncAccess = {
    async read(since) {
      reach();
      if (since === state.revision) return { account, revision: since, unchanged: true };
      return now();
    },
    async change(given) {
      reach();
      if (state.tooLarge) throw new AiSyncTooLarge();
      changes.push(structuredClone(given));
      for (const { name, ...entry } of given.entries) {
        if (isLaterEntry(entries[name], entry)) entries[name] = entry as AiEntry;
      }
      for (const { service, ...key } of given.keys) {
        const before = keys[service];
        if (key.deleted || !before || before.deleted) {
          if (isLaterEntry(before, key)) keys[service] = key as AiSyncKey;
          continue;
        }
        const merged = mergeSecret(before, key);
        keys[service] = { at: merged.at, secret: merged.secret, fieldsAt: merged.fieldsAt };
      }
      state.revision += 1;
      return { state: now(), refused: [], tooLarge: [] };
    },
  };
  return { access, state, changes, entries, keys };
}

function memorySettings(): SettingsStore & { readonly kept: Map<string, unknown> } {
  const kept = new Map<string, unknown>();
  return {
    kept,
    load: async (key) => structuredClone(kept.get(key)),
    save: async (key, value) => void kept.set(key, structuredClone(value)),
    listen: () => () => {},
  };
}

/** A page of the online mode: timers run as tests say. */
function pageOf(backend: ReturnType<typeof backendOf>, browser = memorySettings()) {
  const timers: (() => void)[] = [];
  const ai = new AccountAi({
    access: backend.access,
    account: "u1",
    browser,
    channel: () => undefined,
    setTimer: (run) => {
      timers.push(run);
      return () => {
        const at = timers.indexOf(run);
        if (at >= 0) timers.splice(at, 1);
      };
    },
  });
  return {
    ai,
    browser,
  };
}

const service = (id: string, name: string) => ({
  id,
  kind: "openai-compatible",
  name,
  enabled: [],
});

const settingsWith = (...services: ReturnType<typeof service>[]) => ({ version: 4, services });

describe("the AI settings of the online mode", () => {
  test("are read from the backend, and each change goes there", async () => {
    const backend = backendOf();
    const one = pageOf(backend);
    await one.ai.start();
    expect(one.ai.getSnapshot()).toMatchObject({ status: "ready", keysRead: true });
    await one.ai.settings.save("ai", settingsWith(service("s1", "甲")));
    await one.ai.keys.write("s1", { key: "sk-secret-1" });
    await one.ai.flush();
    expect(backend.entries["service:s1"]).toMatchObject({ value: { name: "甲" } });
    expect(backend.keys.s1).toMatchObject({ secret: { key: "sk-secret-1" } });
    // Another computer has the same, keys too.
    const other = pageOf(backend);
    await other.ai.start();
    expect(await other.ai.keys.read("s1")).toEqual({ key: "sk-secret-1" });
    expect(await other.ai.settings.load("ai")).toMatchObject({
      services: [{ id: "s1", name: "甲" }],
    });
  });

  test("keep the keys out of the browser: what it keeps for while offline has none", async () => {
    const backend = backendOf();
    const one = pageOf(backend);
    await one.ai.start();
    await one.ai.settings.save("ai", settingsWith(service("s1", "甲")));
    await one.ai.keys.write("s1", { key: "sk-secret-1", headers: { "x-key": "sk-header" } });
    await one.ai.flush();
    const kept = JSON.stringify([...one.browser.kept]);
    expect(kept).toContain("甲");
    expect(kept).not.toContain("sk-secret-1");
    expect(kept).not.toContain("sk-header");
  });

  test("two pages that change different things at once keep both", async () => {
    const backend = backendOf();
    const one = pageOf(backend);
    const other = pageOf(backend);
    await one.ai.start();
    await other.ai.start();
    await one.ai.settings.save("ai", settingsWith(service("s1", "甲")));
    await other.ai.settings.save("ai", settingsWith(service("s2", "乙")));
    await one.ai.keys.write("s1", { key: "k1" });
    await other.ai.keys.write("s1", { baseUrl: "https://b.example" });
    await one.ai.flush();
    await other.ai.flush();
    await one.ai.pull();
    const services = (await one.ai.settings.load("ai")) as { services: { id: string }[] };
    expect(services.services.map(({ id }) => id).toSorted()).toEqual(["s1", "s2"]);
    expect(await one.ai.keys.read("s1")).toEqual({ key: "k1", baseUrl: "https://b.example" });
  });

  test("are read-only while the backend cannot be reached: what changed before goes later", async () => {
    const backend = backendOf();
    const one = pageOf(backend);
    await one.ai.start();
    await one.ai.settings.save("ai", settingsWith(service("s1", "甲")));
    backend.state.down = true;
    await one.ai.flush();
    expect(one.ai.getSnapshot().status).toBe("offline");
    expect(one.ai.getSnapshot().pending).toBeGreaterThan(0);
    expect(one.ai.writable).toBe(false);
    await expect(
      one.ai.settings.save("ai", settingsWith(service("s1", "改名"))),
    ).rejects.toBeInstanceOf(AccountAiOffline);
    await expect(one.ai.keys.write("s1", { key: "k" })).rejects.toBeInstanceOf(AccountAiOffline);
    // The key this page read stays usable: the assistant goes on.
    backend.state.down = false;
    await one.ai.pull();
    await one.ai.flush();
    expect(one.ai.getSnapshot()).toMatchObject({ status: "ready", pending: 0 });
    expect(backend.entries["service:s1"]).toMatchObject({ value: { name: "甲" } });
  });

  test("a page that starts without the backend shows what it had last, without keys", async () => {
    const backend = backendOf();
    const browser = memorySettings();
    const one = pageOf(backend, browser);
    await one.ai.start();
    await one.ai.settings.save("ai", settingsWith(service("s1", "甲")));
    await one.ai.keys.write("s1", { key: "k1" });
    await one.ai.flush();
    backend.state.down = true;
    const later = pageOf(backend, browser);
    await later.ai.start();
    expect(later.ai.getSnapshot()).toMatchObject({ status: "offline", keysRead: false });
    expect(await later.ai.settings.load("ai")).toMatchObject({
      services: [{ id: "s1", name: "甲" }],
    });
    expect(await later.ai.keys.list()).toEqual([]);
    // Of this account only.
    expect(browser.kept.get(CACHE_KEY)).toMatchObject({ account: "u1" });
    // Back: the keys come.
    backend.state.down = false;
    await later.ai.pull();
    expect(later.ai.getSnapshot()).toMatchObject({ status: "ready", keysRead: true });
    expect(await later.ai.keys.read("s1")).toEqual({ key: "k1" });
  });

  test("what the backend does not take as too large goes back to what it has", async () => {
    const backend = backendOf();
    const one = pageOf(backend);
    await one.ai.start();
    await one.ai.settings.save("ai", settingsWith(service("s1", "甲")));
    await one.ai.flush();
    backend.state.tooLarge = true;
    await one.ai.settings.save("ai", settingsWith(service("s1", "甲"), service("s2", "乙")));
    await one.ai.flush();
    backend.state.tooLarge = false;
    await one.ai.pull();
    const services = (await one.ai.settings.load("ai")) as { services: { id: string }[] };
    expect(services.services.map(({ id }) => id)).toEqual(["s1"]);
  });
});

describe("the settings store over the online mode's", () => {
  test("holds everything while the backend cannot be reached, keys too", async () => {
    const backend = backendOf();
    const one = pageOf(backend);
    await one.ai.start();
    const store = new AiSettingsStore(one.ai.settings, one.ai.keys, {
      saveFailed: () => {},
      keyFailed: () => {},
    });
    await store.load();
    store.holdFor("offline");
    expect(store.getSnapshot()).toMatchObject({ held: "offline", resettable: false });
    await store.setKey("s1", "sk-not-taken");
    expect(await one.ai.keys.list()).toEqual([]);
    store.holdFor(undefined);
    expect(store.getSnapshot().held).toBeUndefined();
  });
});

describe("the settings store over the online mode's, as people set up a service", () => {
  test("a key, then an address, with the backend answering in between: both stay", async () => {
    const backend = backendOf();
    const timers: (() => void)[] = [];
    const ai = new AccountAi({
      access: backend.access,
      account: "u1",
      browser: memorySettings(),
      channel: () => undefined,
      setTimer: (run) => {
        timers.push(run);
        return () => {};
      },
    });
    await ai.start();
    const store = new AiSettingsStore(ai.settings, ai.keys, {
      saveFailed: () => {},
      keyFailed: () => {},
    });
    await store.load();
    const id = store.add("moonshot", "月之暗面") as string;
    await store.setKey(id, "sk-relay-key");
    // The backend has the key, and answers, while the address is typed.
    const pushing = ai.push();
    store.update(id, { baseUrl: "https://llm.example/v1" });
    await pushing;
    await ai.flush();
    await new Promise((resolve) => setTimeout(resolve, 10));
    await ai.flush();
    expect(await ai.keys.read(id)).toMatchObject({
      key: "sk-relay-key",
      baseUrl: "https://llm.example/v1",
    });
    expect(store.serviceOf(id)?.baseUrl).toBe("https://llm.example/v1");
    expect(await store.keyOf(id)).toBe("sk-relay-key");
    // And another page reads both.
    const other = new AccountAi({
      access: backend.access,
      account: "u1",
      browser: memorySettings(),
      channel: () => undefined,
      setTimer: () => () => {},
    });
    await other.start();
    expect(await other.keys.read(id)).toMatchObject({
      key: "sk-relay-key",
      baseUrl: "https://llm.example/v1",
    });
  });
});
