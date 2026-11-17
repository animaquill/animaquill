import { IDBFactory, IDBObjectStore } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import {
  MemoryUndoPlace,
  UNDO_DAYS,
  UNDO_KEPT,
  browserUndo,
  memoryUndo,
  undoDropped,
} from "./undo.ts";
import type { UndoStore } from "./index.ts";

const DAY = 24 * 60 * 60 * 1000;

const saved = (origin: string, project = "p") => ({
  project,
  origin,
  record: { origin },
  about: { kind: "ai" },
});

describe("which undo logs go", () => {
  it("are those past the newest 50, or older than 30 days, whichever comes first", () => {
    const now = 100 * DAY;
    const rows = Array.from({ length: 52 }, (_, index) => ({
      origin: `o${index}`,
      madeAt: now - index * 1000,
    }));
    expect(undoDropped(rows, now)).toEqual([
      { origin: "o50", why: "count" },
      { origin: "o51", why: "count" },
    ]);
    const old = [
      { origin: "old", madeAt: now - (UNDO_DAYS * DAY + 1) },
      { origin: "new", madeAt: now },
    ];
    expect(undoDropped(old, now)).toEqual([{ origin: "old", why: "age" }]);
  });
});

describe.each([
  [
    "in the browser",
    (clock: () => number) =>
      browserUndo(
        () => new IDBFactory(),
        () => undefined,
        clock,
      ),
  ],
  ["in memory", (clock: () => number) => memoryUndo(new MemoryUndoPlace(), clock)],
] as const)("undo logs %s", (_, make) => {
  it("keep each origin once, made when its changes began, and drop the oldest", async () => {
    let now = 1000;
    const store: UndoStore = make(() => now);
    await store.save({ ...saved("a"), madeAt: 1000 });
    now += 1;
    await store.save({ ...saved("a"), record: { again: true }, madeAt: 1000 });
    const a = await store.get("p", "a");
    expect(a).toMatchObject({
      record: { again: true },
      madeAt: 1000,
      savedAt: 1001,
      window: store.window,
    });
    for (let index = 0; index < UNDO_KEPT; index++) {
      now += 1;
      const { dropped } = await store.save(saved(`b${index}`));
      expect(dropped).toEqual(index === UNDO_KEPT - 1 ? ["a"] : []);
    }
    expect(await store.get("p", "a")).toBeUndefined();
    expect(await store.gone("p")).toEqual(new Map([["a", "count"]]));
    expect((await store.list("p")).map(({ origin }) => origin)).toHaveLength(UNDO_KEPT);
    await store.save(saved("x", "q"));
    expect(await store.usage()).toMatchObject({ projects: 2 });
    expect((await store.usage()).bytes).toBeGreaterThan(0);
    await store.forget("q");
    expect(await store.usage()).toMatchObject({ projects: 1 });
    await store.clear();
    expect(await store.usage()).toEqual({ projects: 0, bytes: 0 });
    expect(await store.gone("p")).toEqual(new Map());
  });
});

describe("windows that share undo logs", () => {
  it("hear what the others save, and take turns", async () => {
    const place = new MemoryUndoPlace();
    const one = memoryUndo(place);
    const two = memoryUndo(place);
    const heard: string[] = [];
    two.listen((project, origin) => heard.push(`${project}/${origin}`));
    await one.save(saved("a"));
    await Promise.resolve();
    expect(heard).toEqual(["p/a"]);

    // Both ask at once: the second runs once the first is done, and sees what it did.
    let taken = 0;
    const undo = (store: UndoStore) =>
      store.exclusive("p", async () => {
        const seen = taken;
        await new Promise((resolve) => setTimeout(resolve, 5));
        if (seen === 0) taken += 1;
        return seen;
      });
    expect(await Promise.all([undo(one), undo(two)])).toEqual([0, 1]);
    expect(taken).toBe(1);
  });
});

describe("undo logs in the browser, as the page goes right after they are saved", () => {
  /** A transaction the page did not commit by then is taken back, as a browser does. */
  async function goingRightAfter<T>(run: () => Promise<T>) {
    const proto = IDBObjectStore.prototype;
    const put = proto.put;
    proto.put = function (this: IDBObjectStore, ...args: Parameters<typeof put>) {
      const request = put.apply(this, args);
      const transaction = this.transaction;
      queueMicrotask(() => {
        try {
          transaction.abort();
        } catch {
          // Committed already: it stays.
        }
      });
      return request;
    };
    try {
      return await run().catch(() => undefined);
    } finally {
      proto.put = put;
    }
  }

  it("are kept, though the page never hears back from the write", async () => {
    const factory = new IDBFactory();
    const store = browserUndo(
      () => factory,
      () => undefined,
    );
    await goingRightAfter(() => store.save(saved("a")));
    expect(await store.get("p", "a")).toMatchObject({ record: { origin: "a" } });
  });

  it("are kept all, several at once, and one taken away with them", async () => {
    const factory = new IDBFactory();
    const store = browserUndo(
      () => factory,
      () => undefined,
    );
    await store.save(saved("gone"));
    await goingRightAfter(() => store.saveAll("p", [saved("a"), saved("b")], ["gone"]));
    expect((await store.list("p")).map(({ origin }) => origin).toSorted()).toEqual(["a", "b"]);
  });
});
