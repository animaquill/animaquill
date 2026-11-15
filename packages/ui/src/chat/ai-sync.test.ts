import {
  EMPTY_AI_SETTINGS,
  readAiSettings,
  writeAiSettings,
  type AiSettings,
} from "@animaquill/agent";
import {
  AiSyncNewer,
  isLaterEntry,
  memoryAccountKeys,
  mergeSecret,
  memoryKeys,
  type AccountAccess,
  type AccountAiChanges,
  type AccountAiSettings,
  type AccountSnapshot,
  type AiEntry,
  type AiSyncAccess,
  type AiSyncKey,
  type SettingsStore,
  type TimedSecret,
} from "@animaquill/host";
import { afterEach, describe, expect, test, vi } from "vitest";
import { AiSync, type AiSyncAnswer, type AiSyncQuestion } from "./ai-sync.ts";
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
      revision: number;
      format?: number;
      entries: Record<string, AiEntry>;
      keys: Record<string, AiSyncKey>;
    }
  >();
  let offline = false;
  /** Entries the platform takes as too large. */
  const tooLarge = new Set<string>();
  const of = (account: string) => {
    let kept = accounts.get(account);
    if (!kept) accounts.set(account, (kept = { revision: 0, entries: {}, keys: {} }));
    return kept;
  };
  const stateOf = (account: string): AccountAiSettings => {
    const kept = of(account);
    return structuredClone({ account, ...kept, format: kept.format ?? 1 });
  };
  const access = (who: () => string): AiSyncAccess => ({
    async read() {
      if (offline) throw new TypeError("Failed to fetch");
      return stateOf(who());
    },
    async change(changes: AccountAiChanges) {
      if (offline) throw new TypeError("Failed to fetch");
      const kept = of(who());
      // A newer editor wrote them: what one of an older format gives is not taken.
      if ((kept.format ?? 1) > (changes.format ?? 1)) throw new AiSyncNewer("newer");
      kept.format = Math.max(kept.format ?? 1, changes.format ?? 1);
      const large: string[] = [];
      for (const { name, ...entry } of changes.entries)
        if (tooLarge.has(name) && !entry.deleted) large.push(name);
        else if (isLaterEntry(kept.entries[name], entry)) kept.entries[name] = entry as AiEntry;
      for (const { service, ...key } of changes.keys) {
        const before = kept.keys[service];
        // As the platform does: two of what is secret of a service, part by part.
        if (before && !before.deleted && !key.deleted)
          kept.keys[service] = mergeSecret(before, key as TimedSecret);
        else if (isLaterEntry(before, key)) kept.keys[service] = key as AiSyncKey;
      }
      kept.revision += 1;
      return { state: stateOf(who()), refused: [], tooLarge: large };
    },
  });
  return {
    accounts,
    access,
    tooLarge,
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
  /** "unanswered": people never answer. */
  answer: AiSyncAnswer | "unanswered" = { on: true, put: true },
  /** The locks of the browser, which its windows share; without them, each window has its own. */
  locks?: LockManager,
) {
  const ask = vi.fn(async (_question: AiSyncQuestion) =>
    answer === "unanswered" ? undefined : answer,
  );
  const sync = new AiSync({
    settings: browser.windowStore(),
    keys: browser.keys,
    accountKeys: browser.accountKeys,
    access: platform.access(() => account.id ?? "nobody"),
    account: account.access,
    locks: () => locks,
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
    expect((await one.accountKeys.of("u1").read(first))?.key).toBe("sk-one");
    expect((await two.accountKeys.of("u1").read(first))?.key).toBe("sk-one");
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
    expect(window.ask).toHaveBeenCalledWith({
      account: "u1",
      device: { services: 2, models: 1, packs: 0 },
      deviceKeys: 1,
      accountServices: 1,
    });
    expect(window.sync.scope).toBe("u1");
    // The two at the same address, which is secret of each, are one.
    expect(names(window.ai)).toEqual(["账号里的", "设备上的"].toSorted());
    expect((await browser.accountKeys.of("u1").read(mine))?.key).toBe("sk-device");
    // Noted, so that it does not go in again unless it changed here.
    expect(await window.sync.deviceMerged()).toEqual(expect.any(Number));
    expect(platform.accounts.get("u1")!.keys[mine]).toMatchObject({
      secret: { key: "sk-device", baseUrl: "https://api.anthropic.com" },
    });
    // This device's stay as they were, for when people sign out.
    expect((await browser.keys.read(mine))?.key).toBe("sk-device");
    // Changed on this device since: not as it went into the account any more.
    await browser.keys.write(mine, { key: "sk-device-changed" });
    expect(await window.sync.deviceMerged()).toBeUndefined();
  });

  test("signing out: the account's leave this browser, this device's come back; no mixing", async () => {
    const platform = platformOf();
    const browser = browserOf();
    const account = accountOf(undefined);
    // Off: this device's do not go into the account.
    const window = await windowOf(browser, platform, account, { on: false, put: false });
    window.ai.add("anthropic", "设备上的");
    await settle();
    account.as("u1");
    await settle();
    expect(names(window.ai)).toEqual([]);
    await window.sync.setEnabled(true);
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
    window.ask.mockResolvedValue({ on: false, put: false });
    account.as("u2");
    await settle();
    await window.sync.sync();
    await settle();
    expect(window.sync.scope).toBe("u2");
    // Off there too: the account's own, which are none.
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

  test("turned off on one device: only that one stops; the platform and the others go on", async () => {
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
    expect(a.sync.getSnapshot().status).toBe("off");
    // Nothing is taken away from the platform.
    const kept = platform.accounts.get("u1")!;
    expect(kept.entries[`service:${id}`]).toBeDefined();
    expect(kept.keys[id]).toMatchObject({ secret: { key: "sk-one" } });
    // The other device goes on, both ways.
    await b.sync.sync();
    expect(b.sync.getSnapshot().status).toBe("synced");
    const theirs = b.ai.add("deepseek", "乙")!;
    await settle();
    await b.sync.sync();
    expect(kept.entries[`service:${theirs}`]).toBeDefined();
    // This one neither takes nor gives meanwhile.
    a.ai.add("openai", "只在这台");
    await settle();
    await a.sync.sync();
    await settle();
    expect(names(a.ai)).toEqual(["只在这台", "甲"]);
    expect(Object.keys(kept.entries).filter((n) => n.startsWith("service:"))).toHaveLength(2);
    // On again: merged both ways, entry by entry.
    await a.sync.setEnabled(true);
    await settle();
    await b.sync.sync();
    await settle();
    expect(names(a.ai)).toEqual(["乙", "只在这台", "甲"]);
    expect(names(b.ai)).toEqual(["乙", "只在这台", "甲"]);
    expect(a.sync.getSnapshot().status).toBe("synced");
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

  test("too large: shown, and given again once room is made, or once it changed", async () => {
    // Review CM5: what was too large stayed so for good.
    const platform = platformOf();
    const window = await windowOf(browserOf(), platform, accountOf("u1"));
    const big = window.ai.add("anthropic", "太大的")!;
    platform.tooLarge.add(`service:${big}`);
    await settle();
    await window.sync.sync();
    expect(window.sync.getSnapshot().status).toBe("tooLarge");
    expect(platform.accounts.get("u1")!.entries[`service:${big}`]).toBeUndefined();
    // Room made: something else taken away; it goes again, and is taken now.
    const other = window.ai.add("deepseek", "别的")!;
    await settle();
    await window.sync.sync();
    platform.tooLarge.clear();
    await window.ai.remove(other);
    await settle();
    await window.sync.sync();
    expect(window.sync.getSnapshot().status).toBe("synced");
    expect(platform.accounts.get("u1")!.entries[`service:${big}`]).toBeDefined();
  });

  test("not answered yet: nothing of this device goes, and it is not the account's yet", async () => {
    const platform = platformOf();
    const browser = browserOf();
    const account = accountOf(undefined);
    const window = await windowOf(browser, platform, account, "unanswered");
    const mine = window.ai.add("anthropic", "设备上的")!;
    await window.ai.setKey(mine, "sk-device");
    await settle();
    account.as("u1");
    await settle();
    await window.sync.sync();
    expect(window.ask).toHaveBeenCalled();
    expect(window.sync.getSnapshot().status).toBe("waiting");
    expect(window.sync.scope).toBeUndefined();
    expect(platform.accounts.get("u1")?.entries ?? {}).toEqual({});
    expect(platform.accounts.get("u1")?.keys ?? {}).toEqual({});
    expect(browser.values.has("ai.sync@u1")).toBe(false);
  });

  test("answered with the switch off: nothing goes or comes; the platform keeps its own", async () => {
    const platform = platformOf();
    const browser = browserOf();
    const account = accountOf(undefined);
    // Another device gave the account something already.
    const elsewhere = await windowOf(browserOf(), platform, accountOf("u1"));
    elsewhere.ai.add("deepseek", "账号里的");
    await settle();
    await elsewhere.sync.sync();
    const window = await windowOf(browser, platform, account, { on: false, put: true });
    const mine = window.ai.add("anthropic", "设备上的")!;
    await window.ai.setKey(mine, "sk-device");
    await settle();
    account.as("u1");
    await settle();
    await window.sync.sync();
    await settle();
    expect(window.sync.scope).toBe("u1");
    expect(window.sync.getSnapshot().status).toBe("off");
    const before = structuredClone(platform.accounts.get("u1")!);
    expect(Object.keys(before.entries).filter((n) => n.startsWith("service:"))).toHaveLength(1);
    // What this device has, also while signed in; nothing of the account's.
    expect(names(window.ai)).toEqual(["设备上的"]);
    expect((await browser.accountKeys.of("u1").read(mine))?.key).toBe("sk-device");
    // Changed afterwards: still nothing goes.
    window.ai.add("openai", "后来的");
    await settle();
    await window.sync.sync();
    expect(platform.accounts.get("u1")).toEqual(before);
  });

  test("this device's, of before signing in: put into the account as people sign in with it on, where it changed", async () => {
    const platform = platformOf();
    const browser = browserOf();
    const account = accountOf(undefined);
    // As the welcome answered before, on: they go in as they never did.
    const window = await windowOf(browser, platform, account, { on: true, put: false });
    const mine = window.ai.add("anthropic", "设备上的", {
      enabled: ["claude-opus-5", "claude-x"],
    })!;
    await window.ai.setKey(mine, "sk-device");
    await settle();
    expect(await window.sync.deviceCounts()).toEqual({ services: 1, models: 2, packs: 0 });
    account.as("u1");
    await settle();
    await window.sync.sync();
    await settle();
    expect(await window.sync.deviceMerged()).toEqual(expect.any(Number));
    expect(names(window.ai)).toEqual(["设备上的"]);
    expect(platform.accounts.get("u1")!.keys[mine]).toMatchObject({ secret: { key: "sk-device" } });
    expect(await window.sync.counts()).toEqual({ services: 1, models: 2, packs: 0 });
    // Again: nothing new.
    expect(await window.sync.mergeDevice()).toEqual([]);
  });

  test("signed in again with it on: this device's go in only where they changed since", async () => {
    const platform = platformOf();
    const browser = browserOf();
    const account = accountOf(undefined);
    // As the welcome answered before: this device's go in as they changed, never merged yet.
    const window = await windowOf(browser, platform, account, { on: true, put: false });
    const mine = window.ai.add("anthropic", "设备上的")!;
    await settle();
    account.as("u1");
    await settle();
    await window.sync.sync();
    await settle();
    expect(names(window.ai)).toEqual(["设备上的"]);
    // Taken away elsewhere, while this device is signed out.
    await window.sync.beforeSignOut();
    account.as(undefined);
    await settle();
    const elsewhere = await windowOf(browserOf(), platform, accountOf("u1"));
    await elsewhere.ai.remove(mine);
    await settle();
    await elsewhere.sync.sync();
    // Back, unchanged here: what was taken away does not come back.
    account.as("u1");
    await settle();
    await window.sync.sync();
    await settle();
    expect(names(window.ai)).toEqual([]);
    // Changed here, signed out, and in again: it goes in.
    await window.sync.beforeSignOut();
    account.as(undefined);
    await settle();
    window.ai.add("deepseek", "后来加的");
    await settle();
    account.as("u1");
    await settle();
    await window.sync.sync();
    await settle();
    expect(names(window.ai)).toContain("后来加的");
    expect(
      Object.values(platform.accounts.get("u1")!.entries).some(
        (entry) => (entry.value as { name?: string } | undefined)?.name === "后来加的",
      ),
    ).toBe(true);
  });

  test("set up before this editor, and not put in then: it stays out until it changes", async () => {
    const platform = platformOf();
    const browser = browserOf();
    const account = accountOf(undefined);
    // As a page of before left it: this device's settings, never put into the account.
    const before = await windowOf(browser, platform, account, { on: true, put: false });
    before.ai.add("anthropic", "以前不要的");
    await settle();
    browser.values.delete("device.baseline");
    before.sync.dispose();
    const window = await windowOf(browser, platform, account, { on: true, put: false });
    account.as("u1");
    await settle();
    await window.sync.sync();
    await settle();
    expect(window.sync.scope).toBe("u1");
    expect(names(window.ai)).toEqual([]);
    // Changed while signed out: it goes in, the next time.
    await window.sync.beforeSignOut();
    account.as(undefined);
    await settle();
    window.ai.add("deepseek", "后来改的");
    await settle();
    account.as("u1");
    await settle();
    await window.sync.sync();
    await settle();
    expect(names(window.ai)).toEqual(["以前不要的", "后来改的"].toSorted());
  });

  test("another window answered: this one takes the account's as that one starts them", async () => {
    const platform = platformOf();
    const browser = browserOf();
    const one = accountOf(undefined);
    const two = accountOf(undefined);
    const first = await windowOf(browser, platform, one, { on: true, put: true });
    const second = await windowOf(browser, platform, two, "elsewhere");
    const mine = first.ai.add("anthropic", "设备上的")!;
    await first.ai.setKey(mine, "sk-device");
    await settle();
    two.as("u1");
    await settle();
    // The second waits: nothing of it goes.
    expect(second.sync.scope).toBeUndefined();
    one.as("u1");
    await settle();
    await first.sync.sync();
    await settle();
    expect(second.sync.scope).toBe("u1");
    expect(names(second.ai)).toEqual(["设备上的"]);
  });
});

describe("the settings of this device, while nobody is signed in", () => {
  test("two windows that change two models of a service at once both keep theirs", async () => {
    const platform = platformOf();
    const browser = browserOf();
    const nobody = accountOf(undefined);
    // The browser's locks, which all its windows share, one after the other by name.
    const chains = new Map<string, Promise<unknown>>();
    const locks = {
      request: (name: string, work: () => Promise<unknown>) => {
        const next = (chains.get(name) ?? Promise.resolve()).then(work, work);
        chains.set(
          name,
          next.catch(() => {}),
        );
        return next;
      },
    } as unknown as LockManager;
    const a = await windowOf(browser, platform, nobody, undefined, locks);
    const b = await windowOf(browser, platform, nobody, undefined, locks);
    const id = a.ai.add("openai-compatible", "网关", { baseUrl: "https://gw.example/v1" })!;
    a.ai.addModels(id, [
      { id: "x", added: "hand" },
      { id: "y", added: "hand" },
    ]);
    await settle();
    expect(b.ai.modelsFor(id).map((model) => model.id)).toEqual(["x", "y"]);
    // At once: neither has heard of the other's change as it makes its own.
    a.ai.editModel(id, "x", "maxTokens", 1000);
    b.ai.editModel(id, "y", "contextWindow", 64_000);
    await settle();
    for (const window of [a, b]) {
      expect(window.ai.modelOf(id, "x")?.values.maxTokens).toBe(1000);
      expect(window.ai.modelOf(id, "y")?.values.contextWindow).toBe(64_000);
    }
    const saved = readAiSettings(browser.values.get("ai"));
    expect(saved.kind === "ok" && saved.settings.services[0]?.models).toEqual([
      { id: "x", added: "hand", maxTokens: 1000, edited: ["maxTokens"] },
      { id: "y", added: "hand", contextWindow: 64_000, edited: ["contextWindow"] },
    ]);
  });
});

describe("entries of models, which editors before them would write back without", () => {
  test("go with format 3, without addresses, which an editor of format 2 then leaves alone", async () => {
    const platform = platformOf();
    const a = await windowOf(browserOf(), platform, accountOf("u1"));
    const id = a.ai.add("openai-compatible", "网关", { baseUrl: "https://gw.example/v1" })!;
    a.ai.addModels(id, [{ id: "mine", added: "hand" }]);
    await settle();
    await a.sync.sync();
    expect(platform.accounts.get("u1")?.format).toBe(3);
    expect(platform.accounts.get("u1")?.entries[`model:${id}/mine`]).toBeDefined();
    // The address is in what is secret of the service, which the platform seals.
    expect(JSON.stringify(platform.accounts.get("u1")?.entries)).not.toContain("gw.example");
    expect(platform.accounts.get("u1")?.keys[id]).toMatchObject({
      secret: { baseUrl: "https://gw.example/v1" },
    });
    await expect(
      platform.access(() => "u1").change({ account: "u1", entries: [], keys: [], format: 2 }),
    ).rejects.toBeInstanceOf(AiSyncNewer);
    // An editor of format 1 that gives anything now is told a newer one wrote them.
    await expect(
      platform.access(() => "u1").change({ account: "u1", entries: [], keys: [] }),
    ).rejects.toBeInstanceOf(AiSyncNewer);
  });
});

describe("turned off on this device and on again (review of S-A2)", () => {
  test("a service and a key taken away here while it was off stay away, here and everywhere", async () => {
    const platform = platformOf();
    const a = await windowOf(browserOf(), platform, accountOf("u1"));
    const b = await windowOf(browserOf(), platform, accountOf("u1"));
    const x = a.ai.add("anthropic", "要删的")!;
    const y = a.ai.add("deepseek", "只删key")!;
    await a.ai.setKey(y, "sk-y");
    await settle();
    await a.sync.sync();
    await b.sync.sync();
    await settle();
    expect(names(b.ai)).toEqual(["只删key", "要删的"]);
    await b.sync.setEnabled(false);
    await b.ai.remove(x);
    await b.ai.removeKey(y);
    await settle();
    await b.sync.setEnabled(true);
    await settle();
    await a.sync.sync();
    await b.sync.sync();
    await settle();
    expect(names(b.ai)).toEqual(["只删key"]);
    expect(names(a.ai)).toEqual(["只删key"]);
    expect(a.ai.getSnapshot().keyed.has(y)).toBe(false);
  });
  test("what changed elsewhere meanwhile is not taken back by this device, which did not change it", async () => {
    const platform = platformOf();
    const a = await windowOf(browserOf(), platform, accountOf("u1"));
    const b = await windowOf(browserOf(), platform, accountOf("u1"));
    const x = a.ai.add("anthropic", "旧名")!;
    await settle();
    await a.sync.sync();
    await b.sync.sync();
    await settle();
    await b.sync.setEnabled(false);
    a.ai.update(x, { name: "新名" });
    await settle();
    await a.sync.sync();
    await settle();
    await b.sync.setEnabled(true);
    await settle();
    await a.sync.sync();
    await b.sync.sync();
    await settle();
    expect(names(a.ai)).toEqual(["新名"]);
    expect(names(b.ai)).toEqual(["新名"]);
  });
});

const gw = (extra = {}) => ({
  id: "g",
  kind: "openai-compatible",
  name: "网关",
  baseUrl: "https://gw.example/v1",
  route: "direct",
  api: "openai-completions",
  headers: { "x-team": "v" },
  enabled: ["m"],
  models: [
    { id: "m", added: "hand", baseUrl: "https://gw.example/claude", headers: { "x-m": "1" } },
  ],
  ...extra,
});
describe("what this device had before signing in, as settings of before version 4 move (review of S-A2)", () => {
  for (const keyHeader of [undefined, "api-key"]) {
    test(`untouched, they do not go into the account once moved; a header for the key: ${keyHeader ?? "none"}`, async () => {
      const platform = platformOf();
      const browser = browserOf();
      browser.values.set("ai", {
        version: 3,
        services: [gw(keyHeader ? { keyHeader } : {})],
        default: null,
      });
      await browser.keys.write("g", { key: "sk-gw-0123456789" });
      const account = accountOf(undefined);
      const w = await windowOf(browser, platform, account, { on: true, put: false });
      await settle();
      account.as("u1");
      await settle();
      await w.sync.sync();
      await settle();
      const ents = Object.keys(platform.accounts.get("u1")?.entries ?? {});
      expect(ents.filter((n) => n.startsWith("service:"))).toEqual([]);
    });
  }
});

describe("an account as a platform of before 0.3.72 has it (review of S-A2)", () => {
  test("entries with addresses in them and keys alone reach another device, and the platform has no address left", async () => {
    const platform = platformOf();
    const account = accountOf("u1");
    platform.accounts.set("u1", {
      revision: 1,
      format: 2,
      entries: {
        "service:g": {
          at: 1000,
          value: {
            id: "g",
            kind: "openai-compatible",
            name: "GW",
            baseUrl: "https://gw.example/v1",
            route: "direct",
            headers: { "x-team": "v" },
            enabled: ["m"],
          },
        },
        order: { at: 1000, value: ["g"] },
      },
      keys: { g: { at: 1000, secret: { key: "sk-legacy-0123456789" } } },
    });
    const one = browserOf();
    const a = await windowOf(one, platform, account, { on: true, put: true });
    await settle();
    expect(a.ai.serviceOf("g")?.baseUrl).toBe("https://gw.example/v1");
    await a.sync.sync();
    await settle();
    const kept = platform.accounts.get("u1")!;
    const two = browserOf();
    const b = await windowOf(two, platform, account, { on: true, put: true });
    await settle();
    expect(b.ai.serviceOf("g")?.baseUrl).toBe("https://gw.example/v1");
    expect(b.ai.serviceOf("g")?.headers).toEqual({ "x-team": "v" });
    expect(JSON.stringify(kept.entries)).not.toMatch(/gw\.example|x-team/);
  });
});

describe("what is secret of a service, changed on two devices at once (review of S-A2)", () => {
  test("the key on one, the address on the other: both, everywhere, whichever goes first", async () => {
    for (const first of ["a", "b"] as const) {
      const platform = platformOf();
      const a = await windowOf(browserOf(), platform, accountOf("u1"));
      const b = await windowOf(browserOf(), platform, accountOf("u1"));
      const id = a.ai.add("openai-compatible", "网关", { baseUrl: "https://gw.example/v1" })!;
      await a.ai.setKey(id, "sk-old-0123456789");
      await settle();
      await a.sync.sync();
      await b.sync.sync();
      await settle();
      platform.setOffline(true);
      await a.ai.setKey(id, "sk-new-0123456789");
      b.ai.update(id, { baseUrl: "https://new.example/v1" });
      await settle();
      platform.setOffline(false);
      const order = first === "a" ? [a, b, a] : [b, a, b];
      for (const each of order) await each.sync.sync();
      await settle();
      await settle();
      for (const each of [a, b]) {
        expect(each.ai.serviceOf(id)?.baseUrl, first).toBe("https://new.example/v1");
        expect(await each.ai.keyOf(id), first).toBe("sk-new-0123456789");
      }
    }
  });
});
