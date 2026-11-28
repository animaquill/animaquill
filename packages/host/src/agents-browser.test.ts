import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it, vi } from "vitest";
import { AWAY_MS, browserAgents } from "./agents-browser.ts";
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
  const window = (number: number) =>
    browserAgents({
      database: () => factory,
      locks: () => locks.forWindow(number),
      channel: channels.forWindow(number),
      ...storage.forWindow(number),
    });
  return { locks, window };
}

function events() {
  const owned: string[] = [];
  const waited: string[] = [];
  const mail: string[] = [];
  let budget = 0;
  const said: AgentRoomEvents = {
    owned: (id, after) => void (after ? waited : owned).push(id),
    mail: (to) => void mail.push(to),
    budget: () => void (budget += 1),
  };
  return { said, owned, waited, mail, budget: () => budget };
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
    await a.watch("chat-x", "chat-a", 123);
    await a.watch("chat-x", "mcp:s", 456);
    expect(await b.watchers("chat-x")).toEqual([
      { watcher: "chat-a", until: 123 },
      { watcher: "mcp:s", until: 456 },
    ]);
    expect(await a.watchers("chat-x")).toEqual([]);
    await a.watch("chat-x", "chat-a", 1);
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
});
