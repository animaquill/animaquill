import type {
  AccountAccess,
  AccountSnapshot,
  CloudSwitchChanges,
  CloudSwitches,
  CloudSwitchesAccess,
  SettingsStore,
} from "@animaquill/host";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { AiSync, AiSyncQuestion } from "../chat/ai-sync.ts";
import { CloudSync } from "./cloud-sync.ts";

/**
 * The cloud features people turn on and off for their account, and the welcome (docs/design/
 * settings-and-properties.md of AnimaQuill Cloud, 9): asked once per account in a browser, nothing
 * goes before; both ways out start the switches as they are; an account that went with the AI
 * settings before is never asked; one turned off elsewhere stops here, and what this browser took
 * for the account's goes again once on.
 */

function platformOf() {
  type Kept = { -readonly [K in Exclude<keyof CloudSwitches, "account">]: CloudSwitches[K] };
  const kept = new Map<string, Kept>();
  let offline = false;
  const of = (account: string) => {
    let switches = kept.get(account);
    if (!switches)
      kept.set(
        account,
        (switches = {
          ai: true,
          organizer: true,
          organizerEpoch: 0,
          chats: true,
          chatsEpoch: 0,
          newProjectsInCloud: true,
        }),
      );
    return switches;
  };
  const changes: CloudSwitchChanges[] = [];
  const access = (who: () => string): CloudSwitchesAccess => ({
    async read() {
      if (offline) throw new TypeError("Failed to fetch");
      return { account: who(), ...of(who()) };
    },
    async change(account, change) {
      if (offline) throw new TypeError("Failed to fetch");
      changes.push(change);
      const switches = of(account);
      if (change.organizer === false && switches.organizer) switches.organizerEpoch += 1;
      if (change.chats === false && switches.chats) switches.chatsEpoch += 1;
      Object.assign(switches, change);
      return { account, ...switches };
    },
  });
  return {
    kept,
    of,
    changes,
    access,
    set offline(value: boolean) {
      offline = value;
    },
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

const question = (account: string, enabled = true): AiSyncQuestion => ({
  account,
  device: { services: 2, models: 5, packs: 1 },
  accountServices: 1,
  enabled,
});

const opened: CloudSync[] = [];
afterEach(() => {
  for (const each of opened.splice(0)) each.dispose();
});

function windowOf(
  browser: ReturnType<typeof browserOf>,
  platform: ReturnType<typeof platformOf>,
  account: ReturnType<typeof accountOf>,
  held: ReadonlySet<string> = new Set(),
) {
  const resendOrganizer = vi.fn(async (_account: string) => {});
  const detachChats = vi.fn(async (_account: string) => {});
  const changed = vi.fn();
  const aiSync = {
    holds: async (id: string) => held.has(id),
    setEnabled: vi.fn(async () => {}),
  } as unknown as AiSync;
  const sync = new CloudSync({
    settings: browser.windowStore(),
    access: platform.access(() => {
      const snapshot = account.access.getSnapshot();
      return snapshot.status === "signedIn" ? snapshot.id! : "nobody";
    }),
    account: account.access,
    aiSync,
    resendOrganizer,
    detachChats,
    changed,
  });
  opened.push(sync);
  sync.start();
  return { sync, resendOrganizer, detachChats, changed };
}

describe("the welcome", () => {
  test("the first time: nothing goes until it is answered; then as the switches say", async () => {
    const platform = platformOf();
    const browser = browserOf();
    const account = accountOf("u1");
    const { sync, changed } = windowOf(browser, platform, account);
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
      switches: { ai: true, organizer: true, chats: true, newProjectsInCloud: true },
    });
    // People turn two off, and press either button: the same.
    expect(
      await sync.answerWelcome({
        ai: true,
        organizer: false,
        chats: true,
        newProjectsInCloud: false,
      }),
    ).toBe(true);
    expect(await asked).toEqual({ on: true, put: true });
    expect(platform.changes).toEqual([{ organizer: false, newProjectsInCloud: false }]);
    expect(platform.of("u1")).toMatchObject({ organizer: false, newProjectsInCloud: false });
    expect(sync.getSnapshot()).toMatchObject({ welcomed: true, welcome: undefined });
    expect(sync.allows("organizer", "u1")).toBe(false);
    expect(sync.allows("chats", "u1")).toBe(true);
    expect(sync.newProjectsInCloud).toBe(false);
    expect(browser.values.get("welcome@u1")).toMatchObject({
      switches: { ai: true, organizer: false, chats: true, newProjectsInCloud: false },
    });
    expect(changed).toHaveBeenCalled();
  });

  test("the switches start as the account has them; the AI settings as the platform says", async () => {
    const platform = platformOf();
    Object.assign(platform.of("u1"), { chats: false, newProjectsInCloud: false });
    const { sync } = windowOf(browserOf(), platform, accountOf("u1"));
    await settle();
    const asked = sync.ask(question("u1", false));
    await settle();
    expect(sync.getSnapshot().welcome?.switches).toEqual({
      ai: false,
      organizer: true,
      chats: false,
      newProjectsInCloud: false,
    });
    // Answered as they were: nothing to change on the platform.
    await sync.answerWelcome(sync.getSnapshot().welcome!.switches);
    expect(await asked).toEqual({ on: false, put: true });
    expect(platform.changes).toEqual([]);
  });

  test("signed out and in again, or another window of the browser: not again", async () => {
    const platform = platformOf();
    const browser = browserOf();
    const account = accountOf("u1");
    const first = windowOf(browser, platform, account);
    await settle();
    const asked = first.sync.ask(question("u1"));
    await settle();
    await first.sync.answerWelcome(first.sync.getSnapshot().welcome!.switches);
    await asked;
    account.as(undefined);
    await settle();
    expect(first.sync.getSnapshot()).toMatchObject({ account: undefined, welcomed: false });
    account.as("u1");
    await settle();
    expect(first.sync.getSnapshot().welcomed).toBe(true);
    // The AI settings go as the account says; this device's are not put into them again.
    expect(await first.sync.ask(question("u1"))).toEqual({ on: true, put: false });
    expect(first.sync.getSnapshot().welcome).toBeUndefined();
    const second = windowOf(browser, platform, account);
    await settle();
    expect(second.sync.getSnapshot().welcomed).toBe(true);
    expect(await second.sync.ask(question("u1", false))).toEqual({ on: false, put: false });

    // Another account: asked.
    account.as("u2");
    await settle();
    void first.sync.ask(question("u2"));
    await settle();
    expect(first.sync.getSnapshot().welcome?.account).toBe("u2");
  });

  test("an account whose AI settings went with it here before: never asked", async () => {
    const browser = browserOf();
    const { sync } = windowOf(browser, platformOf(), accountOf("u1"), new Set(["u1"]));
    await settle();
    expect(sync.getSnapshot()).toMatchObject({ welcomed: true, welcome: undefined });
    expect(sync.allows("organizer", "u1")).toBe(true);
    expect(browser.values.get("welcome@u1")).toBeDefined();
  });

  test("answered in another window: it goes away here, and that window starts them", async () => {
    const platform = platformOf();
    const browser = browserOf();
    const account = accountOf("u1");
    const one = windowOf(browser, platform, account);
    const two = windowOf(browser, platform, account);
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

  test("the platform cannot be reached: it stays; put off, it comes again once it can", async () => {
    const platform = platformOf();
    const { sync } = windowOf(browserOf(), platform, accountOf("u1"));
    await settle();
    const asked = sync.ask(question("u1"));
    await settle();
    platform.offline = true;
    const values = { ai: true, organizer: false, chats: true, newProjectsInCloud: true };
    expect(await sync.answerWelcome(values)).toBe(false);
    expect(sync.getSnapshot().welcome).toMatchObject({ failed: true, switches: values });
    expect(sync.allows("chats", "u1")).toBe(false);
    sync.postponeWelcome();
    expect(sync.getSnapshot().welcome).toBeUndefined();
    platform.offline = false;
    await sync.refresh();
    expect(sync.getSnapshot().welcome).toMatchObject({ failed: false, switches: values });
    await sync.answerWelcome(values);
    expect(await asked).toEqual({ on: true, put: true });
    expect(platform.of("u1").organizer).toBe(false);
  });
});

describe("the switches", () => {
  test("turned off and on: the platform's copy is gone, and what this browser had goes again", async () => {
    const platform = platformOf();
    const browser = browserOf();
    const one = windowOf(browser, platform, accountOf("u1"), new Set(["u1"]));
    await settle();
    expect(one.resendOrganizer).not.toHaveBeenCalled();
    await one.sync.set("organizer", false);
    expect(one.sync.getSnapshot().switches).toMatchObject({ organizer: false, organizerEpoch: 1 });
    expect(one.sync.allows("organizer", "u1")).toBe(false);
    expect(one.resendOrganizer).toHaveBeenCalledWith("u1");
    await one.sync.set("organizer", true);
    expect(one.sync.allows("organizer", "u1")).toBe(true);
    expect(one.resendOrganizer).toHaveBeenCalledTimes(1);

    // Another device of the account, which did not hear of it: it does as it reads the switches.
    await one.sync.set("chats", false);
    await one.sync.set("chats", true);
    const two = windowOf(browserOf(), platform, accountOf("u1"), new Set(["u1"]));
    await settle();
    expect(two.resendOrganizer).toHaveBeenCalledWith("u1");
    expect(two.detachChats).toHaveBeenCalledWith("u1");
    // Read again: nothing more.
    await two.sync.refresh();
    expect(two.resendOrganizer).toHaveBeenCalledTimes(1);
    expect(two.detachChats).toHaveBeenCalledTimes(1);
  });

  test("turned off on another device: stops here as this browser hears", async () => {
    const platform = platformOf();
    const { sync, changed } = windowOf(browserOf(), platform, accountOf("u1"), new Set(["u1"]));
    await settle();
    expect(sync.allows("chats", "u1")).toBe(true);
    changed.mockClear();
    Object.assign(platform.of("u1"), { chats: false, chatsEpoch: 1 });
    await sync.refresh();
    expect(sync.allows("chats", "u1")).toBe(false);
    expect(changed).toHaveBeenCalled();
  });

  test("known as a page starts, from what this browser heard last; not of another account", async () => {
    const platform = platformOf();
    const browser = browserOf();
    Object.assign(platform.of("u1"), { newProjectsInCloud: false });
    const one = windowOf(browser, platform, accountOf("u1"), new Set(["u1"]));
    await settle();
    expect(one.sync.newProjectsInCloud).toBe(false);
    platform.offline = true;
    const two = windowOf(browser, platform, accountOf("u1"), new Set(["u1"]));
    await settle();
    expect(two.sync.getSnapshot()).toMatchObject({ status: "failed" });
    expect(two.sync.newProjectsInCloud).toBe(false);
    const other = windowOf(browser, platform, accountOf("u2"), new Set(["u2"]));
    await settle();
    expect(other.sync.newProjectsInCloud).toBe(true);
    // Changing needs the platform: nothing changes where it cannot be reached.
    await expect(two.sync.set("newProjectsInCloud", true)).rejects.toThrow();
    expect(two.sync.newProjectsInCloud).toBe(false);
  });

  test("the AI settings are turned on and off by them", async () => {
    const platform = platformOf();
    const browser = browserOf();
    const aiSync = {
      holds: async () => true,
      setEnabled: vi.fn(async () => {}),
    } as unknown as AiSync;
    const sync = new CloudSync({
      settings: browser.windowStore(),
      access: platform.access(() => "u1"),
      account: accountOf("u1").access,
      aiSync,
    });
    opened.push(sync);
    sync.start();
    await settle();
    await sync.set("ai", false);
    expect(aiSync.setEnabled).toHaveBeenCalledWith(false);
  });

  test("without a platform for them: everything goes as before, and nobody is asked", async () => {
    const sync = new CloudSync({
      settings: browserOf().windowStore(),
      aiSync: { holds: async () => false } as unknown as AiSync,
    });
    opened.push(sync);
    sync.start();
    expect(sync.allows("organizer", "u1")).toBe(true);
    expect(await sync.ask(question("u1"))).toEqual({ on: true, put: true });
  });
});
