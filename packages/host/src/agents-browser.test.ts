import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it, vi } from "vitest";
import { AWAY_MS, MAX_WATCHERS, browserAgents } from "./agents-browser.ts";
import type { AgentRoomEvents, PostedMail } from "./index.ts";

/**
 * Exclusive locks as a browser has them for all its windows: one window at a time holds each, the
 * others wait in turn, and what a window held goes with it.
 */
class Locks {
  readonly #held = new Map<string, { window: number; release: () => void }>();
  readonly #queue = new Map<string, { window: number; grant: () => void }[]>();

  forWindow(window: number): LockManager {
    const grant = (name: string, callback: (lock: Lock | null) => unknown) =>
      new Promise<void>((resolve) => {
        const release = () => {
          if (this.#held.get(name)?.release !== release) return;
          this.#held.delete(name);
          resolve();
          this.#next(name);
        };
        this.#held.set(name, { window, release });
        void Promise.resolve(callback({ name, mode: "exclusive" } as Lock)).then(release, release);
      });
    return {
      request: (
        name: string,
        options: LockOptions,
        callback: (lock: Lock | null) => unknown,
      ): Promise<unknown> => {
        if (!this.#held.has(name)) return grant(name, callback);
        if (options.ifAvailable) return Promise.resolve(callback(null));
        return new Promise<void>((resolve, reject) => {
          const waiting = { window, grant: () => void grant(name, callback).then(resolve) };
          const queue = this.#queue.get(name) ?? [];
          queue.push(waiting);
          this.#queue.set(name, queue);
          options.signal?.addEventListener("abort", () => {
            const at = queue.indexOf(waiting);
            if (at >= 0) queue.splice(at, 1);
            reject(new DOMException("aborted", "AbortError"));
          });
        });
      },
      query: async () => ({
        held: [...this.#held.keys()].map((name) => ({ name, mode: "exclusive" as const })),
        pending: [],
      }),
    } as unknown as LockManager;
  }

  #next(name: string) {
    const queue = this.#queue.get(name);
    queue?.shift()?.grant();
  }

  /** A window that crashed: the browser lets go of what it held, and of what it waited for. */
  drop(window: number) {
    for (const [name, queue] of this.#queue) {
      this.#queue.set(
        name,
        queue.filter((each) => each.window !== window),
      );
    }
    for (const { window: holder, release } of Array.from(this.#held.values())) {
      if (holder === window) release();
    }
  }
}

/** Channels between the windows of one browser: each hears what the others say. */
class Channels {
  readonly #all = new Set<{ window: number; listener: (event: MessageEvent) => void }>();
  forWindow(window: number) {
    const all = this.#all;
    return () => {
      let mine: { window: number; listener: (event: MessageEvent) => void } | undefined;
      return {
        addEventListener: (_type: string, listener: (event: MessageEvent) => void) => {
          mine = { window, listener };
          all.add(mine);
        },
        removeEventListener: () => mine && all.delete(mine),
        close: () => mine && all.delete(mine),
        postMessage: (data: unknown) => {
          for (const each of all) {
            if (each !== mine) {
              const copy = structuredClone(data);
              queueMicrotask(() => each.listener({ data: copy } as MessageEvent));
            }
          }
        },
      } as unknown as BroadcastChannel;
    };
  }
}

class Storage {
  readonly values = new Map<string, string>();
  readonly listeners = new Set<{ window: number; listener: (event: StorageEvent) => void }>();
  forWindow(window: number) {
    const storage = {
      getItem: (key: string) => this.values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        this.values.set(key, value);
        for (const each of this.listeners) {
          if (each.window !== window) each.listener({ key, newValue: value } as StorageEvent);
        }
      },
    } as unknown as globalThis.Storage;
    return {
      storage: () => storage,
      listenStorage: (listener: (event: StorageEvent) => void) => {
        const mine = { window, listener };
        this.listeners.add(mine);
        return () => void this.listeners.delete(mine);
      },
    };
  }
}

/** A browser of several windows, each with its own `AgentPost`. */
function browser() {
  const factory = new IDBFactory();
  const locks = new Locks();
  const channels = new Channels();
  const storage = new Storage();
  const hides = new Map<number, () => void>();
  const shows = new Map<number, () => void>();
  const window = (number: number, store: { storage?: () => globalThis.Storage | undefined } = {}) =>
    browserAgents({
      database: () => factory,
      locks: () => locks.forWindow(number),
      channel: channels.forWindow(number),
      ...storage.forWindow(number),
      ...store,
      listenPageHide: (listener) => {
        hides.set(number, listener);
        return () => hides.delete(number);
      },
      listenPageShow: (listener) => {
        shows.set(number, listener);
        return () => shows.delete(number);
      },
    });
  /** The page of a window goes away, as people close it: it gets to say so first. */
  const hide = (number: number) => hides.get(number)?.();
  return { locks, window, hide, shows, storage };
}

function events() {
  const owned: string[] = [];
  const waited: string[] = [];
  const mail: string[] = [];
  const queued: string[] = [];
  const wanted: string[] = [];
  const gone: string[] = [];
  let budget = 0;
  let resumed = 0;
  const said: AgentRoomEvents = {
    resumed: () => void (resumed += 1),
    owned: (id, after) => void (after ? waited : owned).push(id),
    mail: (to) => void mail.push(to),
    budget: () => void (budget += 1),
    queued: (id) => void queued.push(id),
    wanted: (id, take) => void wanted.push(`${id}${take ? ":take" : ""}`),
    gone: (id) => void gone.push(id),
  };
  return {
    said,
    owned,
    waited,
    mail,
    queued,
    wanted,
    gone,
    budget: () => budget,
    resumed: () => resumed,
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

const mailTo = (to: string, text: string, from = "chat-a", at = Date.now()): PostedMail => ({
  id: `${to}-${text}-${at}`,
  to,
  from,
  text,
  at,
  left: false,
  body: { text },
});

const LIMITS = { most: 50, repeatMs: 60_000 };

describe("the conversations of a project in the windows of a browser", () => {
  it("one window at a time has one; another that has it too takes over when that window crashes", async () => {
    const { locks, window } = browser();
    const first = events();
    const second = events();
    const a = window(1).enter("p", first.said);
    const b = window(2).enter("p", second.said);
    a.serve(["chat-x"]);
    await settle();
    b.serve(["chat-x"]);
    await settle();
    expect(a.owns("chat-x")).toBe(true);
    expect(b.owns("chat-x")).toBe(false);
    expect(first.owned).toEqual(["chat-x"]);
    expect(second.owned).toEqual([]);
    expect(await b.held("chat-x")).toBe(true);
    // A message for it while the first window has it: only the first is told.
    await b.post(mailTo("chat-x", "hello"), LIMITS);
    await settle();
    expect(first.mail).toEqual(["chat-x"]);
    expect(second.mail).toEqual([]);
    // The first window crashes: the browser lets go of its lock, and the second has it now, and
    // takes what waited for it.
    locks.drop(1);
    await settle();
    expect(b.owns("chat-x")).toBe(true);
    // It may have changed in the window that had it: this one is told it waited.
    expect(second.owned).toEqual([]);
    expect(second.waited).toEqual(["chat-x"]);
    expect((await b.claim("chat-x")).map((each) => each.text)).toEqual(["hello"]);
  });

  it("gives a message to only one of two windows that claim it at once", async () => {
    const { window } = browser();
    const a = window(1).enter("p", events().said);
    const b = window(2).enter("p", events().said);
    await a.post(mailTo("chat-x", "once"), LIMITS);
    const [one, two] = await Promise.all([a.claim("chat-x"), b.claim("chat-x")]);
    expect([...one, ...two].map((each) => each.text)).toEqual(["once"]);
    expect(await a.claim("chat-x")).toEqual([]);
  });

  it("lists what the other windows said, and one whose window went away as away", async () => {
    const { locks, window } = browser();
    const a = window(1).enter("p", events().said);
    const b = window(2).enter("p", events().said);
    a.serve(["chat-x"]);
    await settle();
    await a.publish([
      { id: "chat-x", card: { name: "X" } },
      // Only what it holds.
      { id: "chat-y", card: { name: "Y" } },
    ]);
    expect(await b.roster()).toEqual([
      { id: "chat-x", card: { name: "X" }, live: true, at: expect.any(Number) },
    ]);
    // Not its own.
    expect(await a.roster()).toEqual([]);
    locks.drop(1);
    await settle();
    expect(await b.roster()).toEqual([
      { id: "chat-x", card: { name: "X" }, live: false, at: expect.any(Number) },
    ]);
    // Half a day later it is listed no more.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + AWAY_MS + 1000);
    expect(await b.roster()).toEqual([]);
    vi.useRealTimers();
  });

  it("lets go of one it no longer has, and of what it said of it: no one takes it for away", async () => {
    const { window } = browser();
    const second = events();
    const a = window(1).enter("p", events().said);
    const b = window(2).enter("p", second.said);
    a.serve(["chat-x"]);
    await settle();
    await a.publish([{ id: "chat-x", card: { name: "X" } }]);
    b.serve(["chat-x"]);
    await settle();
    a.serve([]);
    await settle();
    expect(a.owns("chat-x")).toBe(false);
    expect(b.owns("chat-x")).toBe(true);
    expect(await b.roster()).toEqual([]);
    expect(await a.roster()).toEqual([]);
  });

  it("holds one right away only where no window has it", async () => {
    const { window } = browser();
    const a = window(1).enter("p", events().said);
    const b = window(2).enter("p", events().said);
    expect(await a.tryServe("chat-x")).toBe(true);
    expect(await b.tryServe("chat-x")).toBe(false);
    expect(b.owns("chat-x")).toBe(false);
    // `serve` right after, before it was told of the one taken, keeps it a while.
    a.serve([]);
    await settle();
    expect(a.owns("chat-x")).toBe(true);
  });

  it("takes the same words from the same one once within the while, and so many at most", async () => {
    const { window } = browser();
    const a = window(1).enter("p", events().said);
    expect(await a.post(mailTo("chat-x", "same"), LIMITS)).toBe("posted");
    expect(await a.post({ ...mailTo("chat-x", "same"), id: "again" }, LIMITS)).toBe("repeat");
    expect(await a.post(mailTo("chat-x", "same", "chat-b"), LIMITS)).toBe("posted");
    expect(await a.post(mailTo("chat-x", "other"), { most: 3, repeatMs: 60_000 })).toBe("posted");
    expect(await a.post(mailTo("chat-x", "more"), { most: 3, repeatMs: 60_000 })).toBe("full");
    // Of another project, none of them.
    const other = window(1).enter("q", events().said);
    expect(await other.claim("chat-x")).toEqual([]);
  });

  it("carries what came of a message back to the window that sent it", async () => {
    const { window } = browser();
    const a = window(1).enter("p", events().said);
    const b = window(2).enter("p", events().said);
    const waiting = a.outcome("m1", 1000);
    b.answer("m1", { sent: "turn" });
    expect(await waiting).toEqual({ sent: "turn" });
    expect(await a.outcome("m2", 20)).toBeUndefined();
  });

  it("keeps who waits to be told of one until it is idle, for any window to take once", async () => {
    const { window } = browser();
    const a = window(1).enter("p", events().said);
    const b = window(2).enter("p", events().said);
    const later = Date.now() + 60_000;
    await a.watch("chat-x", "chat-a", later);
    await a.watch("chat-x", "mcp:s", later + 1);
    expect(await b.watchers("chat-x")).toEqual([
      { watcher: "chat-a", until: later },
      { watcher: "mcp:s", until: later + 1 },
    ]);
    expect(await a.watchers("chat-x")).toEqual([]);
    await a.watch("chat-x", "chat-a", later);
    await a.post(mailTo("chat-x", "for one deleted"), LIMITS);
    await b.forget("chat-x");
    expect(await a.watchers("chat-x")).toEqual([]);
    expect(await a.claim("chat-x")).toEqual([]);
  });

  it("counts turns nobody was there for in all windows, which people reset in any", async () => {
    const { window } = browser();
    const second = events();
    const a = window(1).enter("p", events().said);
    const b = window(2).enter("p", second.said);
    a.budget.add(3);
    b.budget.add(2);
    expect(a.budget.get()).toBe(5);
    expect(second.budget()).toBe(1);
    a.budget.reset();
    expect(b.budget.get()).toBe(0);
    expect(second.budget()).toBe(2);
    expect(window(1).enter("q", events().said).budget.get()).toBe(0);
  });

  it("lets go of all it held when it takes part no more", async () => {
    const { window } = browser();
    const second = events();
    const a = window(1).enter("p", events().said);
    const b = window(2).enter("p", second.said);
    a.serve(["chat-x", "chat-y"]);
    await settle();
    b.serve(["chat-x"]);
    a.close();
    await settle();
    expect(second.waited).toEqual(["chat-x"]);
    expect(await b.held("chat-y")).toBe(false);
  });

  it("keeps a message one window took until it is done with it: a window that goes loses none", async () => {
    const { locks, window, hide } = browser();
    const a = window(1).enter("p", events().said);
    const b = window(2).enter("p", events().said);
    await settle();
    await b.post(mailTo("chat-x", "one"), LIMITS);
    await b.post(mailTo("chat-x", "two"), LIMITS);
    expect((await a.claim("chat-x")).map((each) => each.text)).toEqual(["one", "two"]);
    // Taken: nobody else gets them while the window that took them is there, nor it again.
    expect(await b.claim("chat-x")).toEqual([]);
    expect(await a.claim("chat-x")).toEqual([]);
    // The window crashes: what it took is free again, for whoever has it next.
    locks.drop(1);
    await settle();
    expect((await b.claim("chat-x")).map((each) => each.text)).toEqual(["one", "two"]);
    // A window closed gives back what it took as it goes, as left for whoever opens it.
    const c = window(3).enter("p", events().said);
    await settle();
    expect(await c.claim("chat-x")).toEqual([]);
    hide(2);
    await settle();
    const again = await c.claim("chat-x");
    expect(again.map((each) => [each.text, each.left])).toEqual([
      ["one", true],
      ["two", true],
    ]);
    // Done with one: it goes; one given back waits again.
    await c.done([again[0]?.id ?? ""]);
    await c.back([again[1]?.id ?? ""]);
    expect((await c.claim("chat-x")).map((each) => each.text)).toEqual(["two"]);
  });

  it("asks the window that has one to let go of it, which waits for it again after", async () => {
    const { window } = browser();
    const first = events();
    const second = events();
    const a = window(1).enter("p", first.said);
    const b = window(2).enter("p", second.said);
    a.serve(["chat-x"]);
    await settle();
    b.serve(["chat-x"]);
    await settle();
    expect(second.queued).toEqual(["chat-x"]);
    b.want("chat-x", true);
    await settle();
    expect(first.wanted).toEqual(["chat-x:take"]);
    a.yieldTo("chat-x");
    await settle();
    expect(b.owns("chat-x")).toBe(true);
    expect(second.waited).toEqual(["chat-x"]);
    expect(a.owns("chat-x")).toBe(false);
    expect(first.queued).toEqual(["chat-x"]);
    // Deleted in one window: those that have it hear it.
    a.gone("chat-x");
    await settle();
    expect(second.gone).toEqual(["chat-x"]);
  });

  it("counts on where the storage cannot be written, or there is none: the count never goes down for that", async () => {
    const { window } = browser();
    const full = {
      storage: () =>
        ({
          getItem: () => null,
          setItem: () => {
            throw new DOMException("full", "QuotaExceededError");
          },
        }) as unknown as globalThis.Storage,
    };
    const a = window(1, full).enter("p", events().said);
    for (let at = 0; at < 12; at += 1) a.budget.add(1);
    expect(a.budget.get()).toBe(12);
    a.budget.reset();
    expect(a.budget.get()).toBe(0);
    const none = window(2, { storage: () => undefined }).enter("q", events().said);
    for (let at = 0; at < 11; at += 1) none.budget.add(1);
    expect(none.budget.get()).toBe(11);
    const unreadable = {
      storage: () =>
        ({
          getItem: () => {
            throw new DOMException("denied", "SecurityError");
          },
          setItem: () => {
            throw new DOMException("denied", "SecurityError");
          },
        }) as unknown as globalThis.Storage,
    };
    const c = window(3, unreadable).enter("r", events().said);
    c.budget.add(10);
    expect(c.budget.get()).toBe(10);
  });

  it("keeps who waits on one for as long as asked, and so many at most", async () => {
    const { window } = browser();
    const a = window(1).enter("p", events().said);
    const now = Date.now();
    await a.watch("chat-x", "old", now - 1);
    for (let at = 0; at < MAX_WATCHERS + 5; at += 1)
      await a.watch("chat-x", `w${at}`, now + 1000 + at);
    const all = await a.watchers("chat-x");
    expect(all).toHaveLength(MAX_WATCHERS);
    expect(all.some((each) => each.watcher === "old")).toBe(false);
    expect(all.some((each) => each.watcher === `w${MAX_WATCHERS + 4}`)).toBe(true);
    // One deleted waits on none any more.
    await a.watch("chat-y", "chat-x", now + 1000);
    await a.forget("chat-x");
    expect(await a.watchers("chat-y")).toEqual([]);
  });

  it("gives back what a window took as its page goes, and says when the page comes back", async () => {
    const { window, hide, shows } = browser();
    const first = events();
    const a = window(1).enter("p", first.said);
    const b = window(2).enter("p", events().said);
    await settle();
    await b.post(mailTo("chat-x", "taken"), LIMITS);
    expect((await a.claim("chat-x")).map((each) => each.left)).toEqual([false]);
    hide(1);
    await settle();
    // Free again, as left for whoever opens it, while the window is still there.
    expect((await b.claim("chat-x")).map((each) => [each.text, each.left])).toEqual([
      ["taken", true],
    ]);
    shows.get(1)?.();
    expect(first.resumed()).toBe(1);
  });

  it("lets what a conversation read go as the page goes, rather than back: nobody gets it again", async () => {
    const { window, hide } = browser();
    const a = window(1).enter("p", events().said);
    const b = window(2).enter("p", events().said);
    await settle();
    await b.post(mailTo("chat-x", "read"), LIMITS);
    await b.post(mailTo("chat-x", "unread"), LIMITS);
    const taken = await a.claim("chat-x");
    a.read([taken[0]?.id ?? ""]);
    hide(1);
    await settle();
    expect((await b.claim("chat-x")).map((each) => each.text)).toEqual(["unread"]);
  });
});
