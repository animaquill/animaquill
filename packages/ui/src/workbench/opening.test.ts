import type { ProjectStore } from "@animaquill/core";
import { describe, expect, it } from "vitest";
import { TestTime, settle } from "../cloud/cloud-support.ts";
import type { CloudState } from "../cloud/session.ts";
import { Emitter } from "./emitter.ts";
import { ProjectOpening, type OpeningOptions } from "./opening.ts";

/** The open project, as a test says. */
class TestSession {
  readonly #emitter = new Emitter();
  #snapshot: { store?: ProjectStore; key?: string } = {};
  subscribe = this.#emitter.subscribe;
  getSnapshot = () => this.#snapshot;
  open(key: string): ProjectStore {
    const store = { key } as unknown as ProjectStore;
    this.#snapshot = { store, key };
    this.#emitter.emit();
    return store;
  }
  close(): void {
    this.#snapshot = {};
    this.#emitter.emit();
  }
}

/** How the project syncs, as a test says. */
class TestSync {
  readonly #emitter = new Emitter();
  state: CloudState = "connecting";
  subscribe = this.#emitter.subscribe;
  getSnapshot = () => ({ state: this.state });
  set(state: CloudState): void {
    this.state = state;
    this.#emitter.emit();
  }
}

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** An opening with everything a test watches, in the order it happened. */
function opening({
  folder = false,
  synced = true,
  undo = () => Promise.resolve(),
}: {
  readonly folder?: boolean;
  readonly synced?: boolean;
  readonly undo?: () => Promise<void>;
} = {}) {
  const session = new TestSession();
  const sync = new TestSync();
  const time = new TestTime();
  const events: string[] = [];
  const options: OpeningOptions = {
    session,
    undoLoaded: async () => {
      events.push("undo asked");
      await undo();
      events.push("undo taken up");
    },
    cloud: {
      follow: async () => {
        events.push("cloud followed");
      },
      syncOf: () => (synced ? sync : undefined),
    },
    isFolder: () => folder,
    live: (store) => events.push(`live ${(store as unknown as { key: string }).key}`),
    timing: { catchUpMs: 1000, undoMs: 500 },
    environment: time,
  };
  const flow = new ProjectOpening(options);
  /** What the folder does as it starts, which a test says is over. */
  const folderStart = (name = "folder") => {
    const started = deferred();
    return {
      start: async () => {
        events.push(`${name} started`);
        await started.promise;
        events.push(`${name} compared`);
      },
      compared: started.resolve,
    };
  };
  return { session, sync, time, events, flow, folderStart };
}

describe("opening a project", () => {
  it("takes up what the device kept, then what the platform has, then the folder, then goes live", async () => {
    const { session, sync, events, flow, folderStart } = opening({ folder: true });
    const store = session.open("p");
    expect(flow.getSnapshot()).toMatchObject({ key: "p", step: "log" });
    const folder = folderStart();
    const attached = flow.folder(store, folder.start);
    await settle();
    expect(flow.getSnapshot()).toMatchObject({ step: "cloud", cloud: undefined });
    // Nothing of the folder before the platform's.
    expect(events).toEqual(["undo asked", "undo taken up", "cloud followed"]);
    sync.set("online");
    await settle();
    expect(flow.getSnapshot()).toMatchObject({ step: "folder", cloud: "caught-up" });
    expect(events.at(-1)).toBe("folder started");
    expect(flow.isLive(store)).toBe(false);
    folder.compared();
    await attached;
    await settle();
    expect(flow.getSnapshot().step).toBe("live");
    expect(flow.isLive(store)).toBe(true);
    // What AI tools wrote, and what downloads, only once the folder is compared.
    expect(events).toEqual([
      "undo asked",
      "undo taken up",
      "cloud followed",
      "folder started",
      "folder compared",
      "live p",
    ]);
  });

  it("asks the platform only once the undo logs are taken up", async () => {
    const undo = deferred();
    const { session, events, flow } = opening({ undo: () => undo.promise });
    session.open("p");
    await settle();
    expect(flow.getSnapshot().step).toBe("log");
    expect(events).toEqual(["undo asked"]);
    undo.resolve();
    await settle();
    expect(events).toContain("cloud followed");
  });

  it("does not wait for the undo logs for ever", async () => {
    const { session, time, events, flow } = opening({ undo: () => new Promise(() => {}) });
    session.open("p");
    await time.advance(499);
    expect(flow.getSnapshot().step).toBe("log");
    await time.advance(1);
    expect(flow.getSnapshot().step).toBe("cloud");
    expect(events).toEqual(["undo asked", "cloud followed"]);
  });

  it("finds out how a folder syncs once the folder is there", async () => {
    const { session, sync, events, flow, folderStart } = opening({ folder: true });
    const store = session.open("p");
    await settle();
    expect(flow.getSnapshot().step).toBe("log");
    expect(events).not.toContain("cloud followed");
    sync.set("online");
    const folder = folderStart();
    void flow.folder(store, folder.start);
    await settle();
    expect(events.slice(-2)).toEqual(["cloud followed", "folder started"]);
  });

  it("compares the folder once it waited too long for the platform", async () => {
    const { session, time, events, flow, folderStart } = opening({ folder: true });
    const store = session.open("p");
    const folder = folderStart();
    void flow.folder(store, folder.start);
    await time.advance(999);
    expect(events).not.toContain("folder started");
    await time.advance(1);
    expect(flow.getSnapshot()).toMatchObject({ step: "folder", cloud: "timeout" });
    expect(events.at(-1)).toBe("folder started");
  });

  it("does not wait for the platform offline", async () => {
    const { session, time, events, flow, folderStart } = opening({ folder: true });
    time.online = false;
    const store = session.open("p");
    const folder = folderStart();
    void flow.folder(store, folder.start);
    await settle();
    expect(flow.getSnapshot()).toMatchObject({ step: "folder", cloud: "offline" });
    expect(events.at(-1)).toBe("folder started");
  });

  it("stops waiting where the network goes away meanwhile", async () => {
    const { session, sync, events, flow, folderStart } = opening({ folder: true });
    const store = session.open("p");
    void flow.folder(store, folderStart().start);
    await settle();
    expect(flow.getSnapshot().step).toBe("cloud");
    sync.set("offline");
    await settle();
    expect(flow.getSnapshot()).toMatchObject({ step: "folder", cloud: "offline" });
    expect(events.at(-1)).toBe("folder started");
  });

  it.each(["reconnecting", "paused", "closed"] as const)(
    "stops waiting where catching up fails (%s)",
    async (state) => {
      const { session, sync, events, flow, folderStart } = opening({ folder: true });
      const store = session.open("p");
      void flow.folder(store, folderStart().start);
      await settle();
      sync.set(state);
      await settle();
      expect(flow.getSnapshot()).toMatchObject({ step: "folder", cloud: "failed" });
      expect(events.at(-1)).toBe("folder started");
    },
  );

  it("waits for nothing of a project that does not sync", async () => {
    const { session, events, flow } = opening({ synced: false });
    const store = session.open("p");
    await settle();
    expect(flow.getSnapshot()).toMatchObject({ step: "live", cloud: "none" });
    expect(flow.isLive(store)).toBe(true);
    expect(events.at(-1)).toBe("live p");
  });

  it("starts nothing of a project that closed while it waited", async () => {
    const { session, events, flow, folderStart } = opening({ folder: true });
    const store = session.open("p");
    const attached = flow.folder(store, folderStart().start);
    await settle();
    session.close();
    await attached;
    await settle();
    expect(events).not.toContain("folder started");
    expect(events.some((event) => event.startsWith("live"))).toBe(false);
    expect(flow.isLive(store)).toBe(false);
    expect(flow.getSnapshot().step).toBeUndefined();
    // Its folder, should it come late, does not start either.
    await flow.folder(store, folderStart("late").start);
    expect(events).not.toContain("late started");
  });

  it("goes on with the next project as it opens", async () => {
    const { session, sync, events, flow, folderStart } = opening({ folder: true });
    const first = session.open("p");
    void flow.folder(first, folderStart("first").start);
    await settle();
    const next = session.open("q");
    sync.set("online");
    const folder = folderStart("next");
    void flow.folder(next, folder.start);
    await settle();
    expect(events).not.toContain("first started");
    expect(events.at(-1)).toBe("next started");
    folder.compared();
    await settle();
    expect(flow.isLive(next)).toBe(true);
    expect(flow.isLive(first)).toBe(false);
  });

  it("starts the folder of a project that is open already at once", async () => {
    const { session, events, flow, folderStart } = opening({ synced: false });
    const store = session.open("p");
    await settle();
    expect(flow.isLive(store)).toBe(true);
    // It moved into a folder.
    const folder = folderStart();
    void flow.folder(store, folder.start);
    expect(events.at(-1)).toBe("folder started");
  });

  it("goes live where comparing the folder failed", async () => {
    const { session, sync, events, flow } = opening({ folder: true });
    const store = session.open("p");
    sync.set("online");
    const attached = flow.folder(store, async () => {
      events.push("folder started");
      throw new Error("the folder is not there");
    });
    await expect(attached).rejects.toThrow();
    await settle();
    expect(flow.getSnapshot().step).toBe("live");
    expect(events.at(-1)).toBe("live p");
  });
});
