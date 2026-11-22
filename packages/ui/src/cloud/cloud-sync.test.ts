import type { AccountAccess, AccountSnapshot, SettingsStore } from "@animaquill/host";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { AiSync, AiSyncQuestion } from "../chat/ai-sync.ts";
import { CloudSync, deviceSwitchesOf } from "./cloud-sync.ts";

/**
 * The cloud features people turn on and off, each on this device, and the welcome (docs/design/
 * settings-and-properties.md of AnimaQuill Cloud, 9): asked once per account in a browser, nothing
 * goes before; both ways out start the switches as they are; an account that went with the AI
 * settings before is never asked; a switch is of this device only, and every window of it.
 */

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
  return { values, windowStore };
}

function accountOf(id: string | undefined) {
  let snapshot: AccountSnapshot =
    id === undefined
      ? { status: "signedOut" }
      : { status: "signedIn", id, name: `name-${id}`, appInstalled: false };
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
          : { status: "signedIn", id: next, name: `name-${next}`, appInstalled: false };
      for (const listener of listeners) listener();
    },
  };
}

const settle = async () => {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

const question = (account: string): AiSyncQuestion => ({
  account,
  device: { services: 2, models: 5, packs: 1 },
  deviceKeys: 1,
  accountServices: 1,
});

const opened: CloudSync[] = [];
afterEach(() => {
  for (const each of opened.splice(0)) each.dispose();
});

function windowOf(
  browser: ReturnType<typeof browserOf>,
  account: ReturnType<typeof accountOf>,
  held: ReadonlySet<string> = new Set(),
) {
  const changed = vi.fn();
  const aiSync = {
    holds: async (id: string) => held.has(id),
    setEnabled: vi.fn(async () => {}),
  } as unknown as AiSync;
  const sync = new CloudSync({
    settings: browser.windowStore(),
    platform: true,
    account: account.access,
    aiSync,
    changed,
  });
  opened.push(sync);
  sync.start();
  return { sync, changed, aiSync };
}

describe("the welcome", () => {
  test("the first time: nothing goes until it is answered; then as the switches say", async () => {
    const browser = browserOf();
    const account = accountOf("u1");
    const { sync, changed } = windowOf(browser, account);
    await settle();
    expect(sync.getSnapshot()).toMatchObject({
      account: "u1",
      welcomed: false,
      welcome: undefined,
    });
    // Nothing goes yet.
    expect(sync.allows("organizer", "u1")).toBe(false);
    expect(sync.allows("chats", "u1")).toBe(false);

    const asked = sync.ask(question("u1"));
    await settle();
    const { welcome } = sync.getSnapshot();
    expect(welcome).toMatchObject({
      account: "u1",
      name: "name-u1",
      switches: { ai: true, organizer: true, chats: true },
    });
    // People turn two off, and press either button: the same.
    await sync.answerWelcome({
      ai: true,
      organizer: false,
      chats: true,
    });
    expect(await asked).toEqual({ on: true, put: true });
    expect(sync.getSnapshot()).toMatchObject({ welcomed: true, welcome: undefined });
    expect(sync.allows("organizer", "u1")).toBe(false);
    expect(sync.allows("chats", "u1")).toBe(true);
    // Kept on this device, which is where they are.
    expect(deviceSwitchesOf(browser.values.get("cloud@u1"))).toEqual({
      ai: true,
      organizer: false,
      chats: true,
    });
    expect(browser.values.get("welcome@u1")).toMatchObject({
      switches: { ai: true, organizer: false, chats: true },
    });
    expect(changed).toHaveBeenCalled();
  });

  test("signed out and in again, or another window of the browser: not again", async () => {
    const browser = browserOf();
    const account = accountOf("u1");
    const first = windowOf(browser, account);
    await settle();
    const asked = first.sync.ask(question("u1"));
    await settle();
    await first.sync.answerWelcome({ ...first.sync.getSnapshot().welcome!.switches, ai: false });
    await asked;
    account.as(undefined);
    await settle();
    expect(first.sync.getSnapshot()).toMatchObject({ account: undefined, welcomed: false });
    account.as("u1");
    await settle();
    expect(first.sync.getSnapshot().welcomed).toBe(true);
    // The AI settings go as this device says; this device's go in as `AiSync` says.
    expect(await first.sync.ask(question("u1"))).toEqual({ on: false, put: false });
    expect(first.sync.getSnapshot().welcome).toBeUndefined();
    const second = windowOf(browser, account);
    await settle();
    expect(second.sync.getSnapshot().welcomed).toBe(true);
    expect(await second.sync.ask(question("u1"))).toEqual({ on: false, put: false });

    // Another account: asked.
    account.as("u2");
    await settle();
    void first.sync.ask(question("u2"));
    await settle();
    expect(first.sync.getSnapshot().welcome?.account).toBe("u2");
  });

  test("an account whose AI settings went with it here before: never asked", async () => {
    const browser = browserOf();
    const { sync } = windowOf(browser, accountOf("u1"), new Set(["u1"]));
    await settle();
    expect(sync.getSnapshot()).toMatchObject({ welcomed: true, welcome: undefined });
    expect(sync.allows("organizer", "u1")).toBe(true);
    expect(browser.values.get("welcome@u1")).toBeDefined();
  });

  test("answered in another window: it goes away here, and that window starts them", async () => {
    const browser = browserOf();
    const account = accountOf("u1");
    const one = windowOf(browser, account);
    const two = windowOf(browser, account);
    await settle();
    const askedOne = one.sync.ask(question("u1"));
    const askedTwo = two.sync.ask(question("u1"));
    await settle();
    expect(two.sync.getSnapshot().welcome).toBeDefined();
    await one.sync.answerWelcome(one.sync.getSnapshot().welcome!.switches);
    await settle();
    expect(await askedOne).toEqual({ on: true, put: true });
    expect(await askedTwo).toBe("elsewhere");
    expect(two.sync.getSnapshot()).toMatchObject({ welcome: undefined, welcomed: true });
  });

  test("what people changed stays with the welcome, as another dialog takes its place for a while", async () => {
    const { sync } = windowOf(browserOf(), accountOf("u1"));
    await settle();
    void sync.ask(question("u1"));
    await settle();
    const changed = { ...sync.getSnapshot().welcome!.switches, chats: false };
    sync.editWelcome(changed);
    expect(sync.getSnapshot().welcome?.switches).toEqual(changed);
  });
});

describe("the switches", () => {
  test("of this device: turned off, nothing goes here; another device is not told", async () => {
    const browser = browserOf();
    const one = windowOf(browser, accountOf("u1"), new Set(["u1"]));
    const other = windowOf(browserOf(), accountOf("u1"), new Set(["u1"]));
    await settle();
    await one.sync.set("organizer", false);
    await one.sync.set("chats", false);
    expect(one.sync.allows("organizer", "u1")).toBe(false);
    expect(one.sync.allows("chats", "u1")).toBe(false);
    await settle();
    expect(other.sync.allows("organizer", "u1")).toBe(true);
    expect(other.sync.allows("chats", "u1")).toBe(true);
    await one.sync.set("organizer", true);
    expect(one.sync.allows("organizer", "u1")).toBe(true);
    expect(one.sync.allows("chats", "u1")).toBe(false);
  });

  test("another window of this browser hears of a switch", async () => {
    const browser = browserOf();
    const one = windowOf(browser, accountOf("u1"), new Set(["u1"]));
    const two = windowOf(browser, accountOf("u1"), new Set(["u1"]));
    await settle();
    two.changed.mockClear();
    await one.sync.set("chats", false);
    await settle();
    expect(two.sync.allows("chats", "u1")).toBe(false);
    expect(two.changed).toHaveBeenCalled();
  });

  test("as they were for the account before they were of each device: those are this device's", () => {
    // As this browser heard them from the platform last, before 0.3.72.
    const before = {
      version: 1,
      switches: {
        account: "u1",
        ai: true,
        organizer: false,
        organizerEpoch: 1,
        chats: true,
        chatsEpoch: 0,
      },
    };
    expect(deviceSwitchesOf(before)).toEqual({
      ai: true,
      organizer: false,
      chats: true,
    });
    expect(
      deviceSwitchesOf({ ...before, device: { ...before.switches, organizer: true } }),
    ).toMatchObject({ organizer: true });
    expect(deviceSwitchesOf(undefined)).toBeUndefined();
  });

  test("known as a page starts; not of another account", async () => {
    const browser = browserOf();
    const one = windowOf(browser, accountOf("u1"), new Set(["u1"]));
    await settle();
    await one.sync.set("organizer", false);
    const two = windowOf(browser, accountOf("u1"), new Set(["u1"]));
    await settle();
    expect(two.sync.allows("organizer", "u1")).toBe(false);
    const other = windowOf(browser, accountOf("u2"), new Set(["u2"]));
    await settle();
    expect(other.sync.allows("organizer", "u2")).toBe(true);
  });

  test("the AI settings are turned on and off by them", async () => {
    const { sync, aiSync } = windowOf(browserOf(), accountOf("u1"), new Set(["u1"]));
    await settle();
    await sync.set("ai", false);
    expect(aiSync.setEnabled).toHaveBeenCalledWith(false);
    expect(sync.getSnapshot().switches?.ai).toBe(false);
  });

  test("without a platform for them: everything goes as before, and nobody is asked", async () => {
    const sync = new CloudSync({
      settings: browserOf().windowStore(),
      platform: false,
      aiSync: { holds: async () => false } as unknown as AiSync,
    });
    opened.push(sync);
    sync.start();
    expect(sync.allows("organizer", "u1")).toBe(true);
    expect(await sync.ask(question("u1"))).toEqual({ on: true, put: true });
  });
});
