import { describe, expect, it } from "vitest";
import { browserPresence } from "./presence.ts";

/** Shared locks as the browser has them, for all windows of a browser, which `query` lists. */
class Locks {
  readonly held: { readonly name: string; readonly window: number }[] = [];

  forWindow(window: number): LockManager {
    const held = this.held;
    return {
      async request(
        name: string,
        _options: LockOptions,
        callback: (lock: Lock | null) => Promise<void> | undefined,
      ) {
        const entry = { name, window };
        held.push(entry);
        try {
          await callback({ name, mode: "shared" } as Lock);
        } finally {
          held.splice(held.indexOf(entry), 1);
        }
      },
      async query() {
        return { held: held.map(({ name }) => ({ name, mode: "shared" as const })), pending: [] };
      },
    } as unknown as LockManager;
  }

  /** What a window that went away held goes with it. */
  drop(window: number) {
    for (let index = this.held.length - 1; index >= 0; index--) {
      if (this.held[index]?.window === window) this.held.splice(index, 1);
    }
  }
}

/** Windows that hear each other, as BroadcastChannel has it: never what they said themselves. */
function channels() {
  const all = new Set<{ deliver: (data: unknown) => void }>();
  return () => {
    const listeners = new Set<(event: MessageEvent) => void>();
    const own = {
      deliver: (data: unknown) => {
        for (const listener of listeners) listener({ data } as MessageEvent);
      },
    };
    all.add(own);
    return {
      addEventListener: (_type: string, listener: (event: MessageEvent) => void) =>
        listeners.add(listener),
      postMessage(data: unknown) {
        for (const other of all) if (other !== own) other.deliver(data);
      },
    } as unknown as BroadcastChannel;
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("which windows have a project open", () => {
  it("counts the other windows, and what one lets go of or takes away with it goes", async () => {
    const locks = new Locks();
    const channel = channels();
    const first = browserPresence(() => locks.forWindow(1), channel);
    const second = browserPresence(() => locks.forWindow(2), channel);
    const leave = first.enter("project_a");
    await tick();
    expect(await first.others("project_a")).toBe(0);
    expect(await second.others("project_a")).toBe(1);
    expect(await second.others("project_b")).toBe(0);
    second.enter("project_a");
    await tick();
    expect(await first.others("project_a")).toBe(1);
    leave();
    await tick();
    expect(await second.others("project_a")).toBe(0);
    // A window that goes away lets go of it as well, as the browser does.
    locks.drop(2);
    expect(await first.others("project_a")).toBe(0);
  });

  it("says that it cannot tell, rather than that no other window has the project open", async () => {
    const locks = new Locks();
    const manager = locks.forWindow(1);
    // The browser has the locks, and does not say what is held.
    const silent = { ...manager, query: async () => Promise.reject(new Error("not allowed")) };
    const presence = browserPresence(() => silent as unknown as LockManager, channels());
    await expect(presence.others("project_a")).rejects.toThrow("not allowed");
    // A browser without them at all has nothing to ask: every window is on its own.
    expect(await browserPresence(() => undefined, channels()).others("project_a")).toBe(0);
  });

  it("tells the other windows that a project moved, and not itself", () => {
    const channel = channels();
    const first = browserPresence(() => undefined, channel);
    const second = browserPresence(() => undefined, channel);
    const heardFirst: string[] = [];
    const heardSecond: string[] = [];
    first.onMoved((project) => heardFirst.push(project));
    const stop = second.onMoved((project) => heardSecond.push(project));
    first.moved("project_a");
    expect(heardSecond).toEqual(["project_a"]);
    expect(heardFirst).toEqual([]);
    stop();
    first.moved("project_b");
    expect(heardSecond).toEqual(["project_a"]);
  });

  it("counts nobody where the browser cannot tell", async () => {
    const presence = browserPresence(
      () => undefined,
      () => undefined,
    );
    presence.enter("project_a");
    expect(await presence.others("project_a")).toBe(0);
    presence.moved("project_a");
  });
});
