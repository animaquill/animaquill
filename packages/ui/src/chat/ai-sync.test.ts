import {
  EMPTY_AI_SETTINGS,
  readAiSettings,
  writeAiSettings,
  type AiSettings,
} from "@animaquill/agent";
import {
  AiSyncOff,
  isLaterEntry,
  memoryAccountKeys,
  memoryKeys,
  type AccountAccess,
  type AccountAiChanges,
  type AccountAiSettings,
  type AccountSnapshot,
  type AiEntry,
  type AiSyncAccess,
  type AiSyncKey,
  type SettingsStore,
} from "@animaquill/host";
import { afterEach, describe, expect, test, vi } from "vitest";
import { AiSync } from "./ai-sync.ts";
import { AiSettingsStore } from "./settings.ts";

/**
 * The AI settings going with the account (ai-sync.ts): devices and windows that change them at
 * once keep each other's changes, what changed offline goes later, signing out leaves this device's
 * settings, and accounts never mix.
 */

/** A platform as me/ai-sync.ts of AnimaQuill Cloud keeps them, with one clock for all. */
function platformOf() {
  const accounts = new Map<
    string,
    {
      enabled: boolean;
      revision: number;
      entries: Record<string, AiEntry>;
      keys: Record<string, AiSyncKey>;
    }
  >();
  let offline = false;
  /** What the platform says is older than what it forgot it took away. */
  const stale = new Set<string>();
  const of = (account: string) => {
    let kept = accounts.get(account);
    if (!kept)
      accounts.set(account, (kept = { enabled: true, revision: 0, entries: {}, keys: {} }));
    return kept;
  };
  const stateOf = (account: string): AccountAiSettings => {
    const kept = of(account);
    return structuredClone({ account, format: 1, ...kept });
  };
  const access = (who: () => string): AiSyncAccess => ({
    async read() {
      if (offline) throw new TypeError("Failed to fetch");
      return stateOf(who());
    },
    async change(changes: AccountAiChanges) {
      if (offline) throw new TypeError("Failed to fetch");
      const kept = of(who());
      if (!kept.enabled && !changes.enable) throw new AiSyncOff("off");
      if (!kept.enabled) kept.entries = {};
      kept.enabled = true;
      const old: string[] = [];
      for (const { name, ...entry } of changes.entries)
        if (stale.has(name)) old.push(name);
        else if (isLaterEntry(kept.entries[name], entry)) kept.entries[name] = entry as AiEntry;
      for (const { service, ...key } of changes.keys)
        if (stale.has(`key:${service}`)) old.push(`key:${service}`);
        else if (isLaterEntry(kept.keys[service], key)) kept.keys[service] = key as AiSyncKey;
      kept.revision += 1;
      return { state: stateOf(who()), refused: [], tooLarge: [], stale: old };
    },
    async turnOff(account) {
      const kept = of(account);
      Object.assign(kept, { enabled: false, entries: {}, keys: {}, revision: kept.revision + 1 });
    },
  });
  return {
    accounts,
    access,
    stale,
    setOffline: (value: boolean) => (offline = value),
  };
}

/** The settings of a browser, which every window of it shares, as localStorage. */
function browserOf() {
  const values = new Map<string, unknown>();
  const listeners = new Set<{ owner: object; key: string; call: (value: unknown) => void }>();
  const windowStore = (): SettingsStore => {
    const owner = {};
    return {
      load: async (key) => structuredClone(values.get(key)),
      save: async (key, value) => {
        values.set(key, structuredClone(value));
        for (const each of listeners)
          if (each.owner !== owner && each.key === key) each.call(structuredClone(value));
      },
      remove: async (key) => void values.delete(key),
      listen: (key, call) => {
        const each = { owner, key, call };
        listeners.add(each);
        return () => listeners.delete(each);
      },
    };
  };
  return { values, windowStore, keys: memoryKeys(), accountKeys: memoryAccountKeys() };
}

function accountOf(id: string | undefined) {
  let snapshot: AccountSnapshot =
    id === undefined
      ? { status: "signedOut" }
      : { status: "signedIn", id, name: id, appInstalled: true };
  const listeners = new Set<() => void>();
  const access: AccountAccess = {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => snapshot,
    refresh: async () => {},
    takeOutcome: () => undefined,
    signIn: () => {},
    installApp: () => {},
    signOut: async () => {},
  };
  return {
    access,
    as(next: string | undefined) {
      snapshot =
        next === undefined
          ? { status: "signedOut" }
          : { status: "signedIn", id: next, name: next, appInstalled: true };
      for (const listener of listeners) listener();
    },
    get id() {
      return snapshot.status === "signedIn" ? snapshot.id : undefined;
    },
  };
}

const opened: AiSync[] = [];
afterEach(() => {
  for (const sync of opened.splice(0)) sync.dispose();
});

const settle = async () => {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

/** A window of a browser, with its settings store going through the sync. */
async function windowOf(
  browser: ReturnType<typeof browserOf>,
  platform: ReturnType<typeof platformOf>,
  account: ReturnType<typeof accountOf>,
  answer: "put" | "skip" = "put",
) {
  const ask = vi.fn(async () => answer);
  const sync = new AiSync({
    settings: browser.windowStore(),
    keys: browser.keys,
    accountKeys: browser.accountKeys,
    access: platform.access(() => account.id ?? "nobody"),
    account: account.access,
    locks: () => undefined,
    ask,
  });
  opened.push(sync);
  const ai = new AiSettingsStore(sync.settings, sync.keys, {
    saveFailed: vi.fn(),
    keyFailed: vi.fn(),
  });
  await ai.load();
  await sync.start();
  await settle();
  await sync.sync();
  await settle();
  return { sync, ai, ask };
}

const names = (ai: AiSettingsStore) =>
  ai
    .getSnapshot()
    .services.map(({ name }) => name)
    .toSorted();

describe("AI settings going with the account", () => {
  test("two devices each add a service: both have both, keys too", async () => {
    const platform = platformOf();
    const one = browserOf();
    const two = browserOf();
    const a = await windowOf(one, platform, accountOf("u1"));
    const b = await windowOf(two, platform, accountOf("u1"));
    const first = a.ai.add("anthropic", "甲", { enabled: ["claude-opus-5"] })!;
    await a.ai.setKey(first, "sk-one");
    const second = b.ai.add("deepseek", "乙", { enabled: ["deepseek-v4"] })!;
    await settle();
    await a.sync.sync();
    await b.sync.sync();
    await a.sync.sync();
    await settle();
    expect(names(a.ai)).toEqual(["乙", "甲"]);
    expect(names(b.ai)).toEqual(["乙", "甲"]);
    expect(await one.accountKeys.of("u1").read(first)).toBe("sk-one");
    expect(await two.accountKeys.of("u1").read(first)).toBe("sk-one");
    expect(b.ai.getSnapshot().keyed.has(first)).toBe(true);
    expect(second).toBeDefined();
    // Not on the device: the device's own keys never had it.
    expect(await one.keys.list()).toEqual([]);
    expect(b.sync.getSnapshot().status).toBe("synced");
  });

  test("a window that has not heard of another's change does not take it back", async () => {
    const platform = platformOf();
    const browser = browserOf();
    const account = accountOf("u1");
    const a = await windowOf(browser, platform, account);
    const b = await windowOf(browser, platform, account);
    // b adds a service; a's settings store has not heard of it yet as it changes the limit.
    b.ai.add("anthropic", "乙");
    await settle();
    const stale = { ...a.ai.getSnapshot() };
    a.ai.add("deepseek", "甲");
    await settle();
    expect(stale).toBeDefined();
    await b.sync.sync();
    await settle();
    const saved = readAiSettings(browser.values.get("ai@u1"));
    expect(
      saved.kind === "ok" && saved.settings.services.map(({ name }) => name).toSorted(),
    ).toEqual(["乙", "甲"]);
    expect(names(a.ai)).toEqual(["乙", "甲"]);
    expect(
      Object.keys(platform.accounts.get("u1")!.entries).filter((n) => n.startsWith("service:")),
    ).toHaveLength(2);
  });

  test("changes made offline go once the platform can be reached, merged with the others", async () => {
    const platform = platformOf();
    const a = await windowOf(browserOf(), platform, accountOf("u1"));
    const b = await windowOf(browserOf(), platform, accountOf("u1"));
    platform.setOffline(true);
    a.ai.add("anthropic", "离线加的");
    await settle();
    await a.sync.sync();
    expect(a.sync.getSnapshot().status).toMatch(/offline|failed/);
    platform.setOffline(false);
    b.ai.add("deepseek", "在线加的");
    await settle();
    await b.sync.sync();
    await a.sync.sync();
    await b.sync.sync();
    await settle();
    expect(names(a.ai)).toEqual(["在线加的", "离线加的"]);
    expect(names(b.ai)).toEqual(["在线加的", "离线加的"]);
    expect(a.sync.getSnapshot().status).toBe("synced");
  });

  test("taken away on one device is gone on the other, also its key", async () => {
    const platform = platformOf();
    const one = browserOf();
    const a = await windowOf(one, platform, accountOf("u1"));
    const b = await windowOf(browserOf(), platform, accountOf("u1"));
    const id = a.ai.add("anthropic", "甲")!;
    await a.ai.setKey(id, "sk-one");
    await settle();
    await a.sync.sync();
    await b.sync.sync();
    await settle();
    expect(names(b.ai)).toEqual(["甲"]);
    await b.ai.remove(id);
    await settle();
    await b.sync.sync();
    await a.sync.sync();
    await settle();
    expect(names(a.ai)).toEqual([]);
    expect(await one.accountKeys.of("u1").read(id)).toBeUndefined();
    expect(platform.accounts.get("u1")!.keys[id]).toMatchObject({ deleted: true });
  });

  test("the first time: people are asked, and this device's go into the account, merged", async () => {
    const platform = platformOf();
    const browser = browserOf();
    const account = accountOf(undefined);
    // Set up before signing in: this device's.
    const window = await windowOf(browser, platform, account);
    const mine = window.ai.add("anthropic", "设备上的", { enabled: ["claude-opus-5"] })!;
    await window.ai.setKey(mine, "sk-device");
    window.ai.add("deepseek", "同一个", { baseUrl: "https://api.deepseek.com" });
    await settle();
    // The account has one of the same kind at the same address already.
    const elsewhere = await windowOf(browserOf(), platform, accountOf("u1"));
    elsewhere.ai.add("deepseek", "账号里的", { baseUrl: "https://api.deepseek.com" });
    await settle();
    await elsewhere.sync.sync();

    account.as("u1");
    await settle();
    await window.sync.sync();
    await settle();
    expect(window.ask).toHaveBeenCalledWith({ services: 2, accountServices: 1 });
    expect(window.sync.scope).toBe("u1");
    expect(names(window.ai)).toEqual(["账号里的", "设备上的"].toSorted());
    expect(await browser.accountKeys.of("u1").read(mine)).toBe("sk-device");
    expect(platform.accounts.get("u1")!.keys[mine]).toMatchObject({ key: "sk-device" });
    // This device's stay as they were, for when people sign out.
    expect(await browser.keys.read(mine)).toBe("sk-device");
  });

  test("signing out: the account's leave this browser, this device's come back; no mixing", async () => {
    const platform = platformOf();
    const browser = browserOf();
    const account = accountOf(undefined);
    const window = await windowOf(browser, platform, account, "skip");
    window.ai.add("anthropic", "设备上的");
    await settle();
    account.as("u1");
    await settle();
    expect(names(window.ai)).toEqual([]);
    const theirs = window.ai.add("deepseek", "u1 的")!;
    await window.ai.setKey(theirs, "sk-u1");
    await settle();
    await window.sync.sync();
    await window.sync.beforeSignOut();

    account.as(undefined);
    await settle();
    expect(window.sync.scope).toBeUndefined();
    expect(names(window.ai)).toEqual(["设备上的"]);
    expect(browser.values.has("ai@u1")).toBe(false);
    expect(browser.values.has("ai.sync@u1")).toBe(false);
    expect(await browser.accountKeys.of("u1").list()).toEqual([]);
    expect(window.ai.getSnapshot().keyed.has(theirs)).toBe(false);

    // Somebody else signs in on this browser: nothing of the first.
    account.as("u2");
    await settle();
    await window.sync.sync();
    await settle();
    expect(window.sync.scope).toBe("u2");
    // Asked, and people said no: the account's own, which are none.
    expect(names(window.ai)).toEqual([]);
    expect(await browser.accountKeys.of("u2").read(theirs)).toBeUndefined();
    expect(platform.accounts.get("u2")!.keys[theirs]).toBeUndefined();
  });

  test("what was not given yet stays as people sign out, for the next time", async () => {
    const platform = platformOf();
    const browser = browserOf();
    const account = accountOf("u1");
    const window = await windowOf(browser, platform, account);
    platform.setOffline(true);
    window.ai.add("anthropic", "没传上去的");
    await settle();
    account.as(undefined);
    await settle();
    expect(browser.values.has("ai@u1")).toBe(true);
    platform.setOffline(false);
    account.as("u1");
    await settle();
    await window.sync.sync();
    await settle();
    expect(names(window.ai)).toEqual(["没传上去的"]);
    expect(
      Object.keys(platform.accounts.get("u1")!.entries).some((n) => n.startsWith("service:")),
    ).toBe(true);
  });

  test("turned off: the platform keeps nothing, other devices stop, and keep what they have", async () => {
    const platform = platformOf();
    const a = await windowOf(browserOf(), platform, accountOf("u1"));
    const b = await windowOf(browserOf(), platform, accountOf("u1"));
    const id = a.ai.add("anthropic", "甲")!;
    await a.ai.setKey(id, "sk-one");
    await settle();
    await a.sync.sync();
    await b.sync.sync();
    await settle();
    await a.sync.setEnabled(false);
    expect(platform.accounts.get("u1")).toMatchObject({ enabled: false, entries: {}, keys: {} });
    expect(a.sync.getSnapshot().status).toBe("off");
    await b.sync.sync();
    expect(b.sync.getSnapshot().status).toBe("off");
    // Changes stay on the device.
    b.ai.add("deepseek", "乙");
    await settle();
    await b.sync.sync();
    expect(platform.accounts.get("u1")!.entries).toEqual({});
    expect(names(b.ai)).toEqual(["乙", "甲"]);
    // On again from a: a's go; b gives its own as it hears.
    await a.sync.setEnabled(true);
    await b.sync.sync();
    await a.sync.sync();
    await settle();
    expect(names(a.ai)).toEqual(["乙", "甲"]);
    expect(platform.accounts.get("u1")!.keys[id]).toMatchObject({ key: "sk-one" });
  });

  test("settings of the account start as the page loads, without this device's first", async () => {
    const platform = platformOf();
    const browser = browserOf();
    await windowOf(browser, platform, accountOf("u1"));
    browser.values.set("ai", writeAiSettings({ ...EMPTY_AI_SETTINGS, services: [] } as AiSettings));
    const sync = new AiSync({
      settings: browser.windowStore(),
      keys: browser.keys,
      accountKeys: browser.accountKeys,
      locks: () => undefined,
      access: platform.access(() => "u1"),
      account: accountOf("u1").access,
    });
    opened.push(sync);
    await sync.ready;
    expect(sync.scope).toBe("u1");
  });

  test("what the platform says is older than what it forgot it took away goes here too", async () => {
    // Review CM5, 5: a device away more than thirty days does not bring back what was taken away.
    const platform = platformOf();
    const browser = browserOf();
    const window = await windowOf(browser, platform, accountOf("u1"));
    platform.setOffline(true);
    const id = window.ai.add("anthropic", "早就删掉的")!;
    await window.ai.setKey(id, "sk-old");
    await settle();
    platform.stale.add(`service:${id}`);
    platform.stale.add(`key:${id}`);
    platform.setOffline(false);
    await window.sync.sync();
    await settle();
    expect(names(window.ai)).toEqual([]);
    expect(await browser.accountKeys.of("u1").read(id)).toBeUndefined();
    expect(platform.accounts.get("u1")!.keys[id]).toBeUndefined();
    await window.sync.sync();
    expect(names(window.ai)).toEqual([]);
  });
});
