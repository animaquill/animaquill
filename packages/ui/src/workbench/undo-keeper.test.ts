import { ProjectStore, aiTask, orderedTracks } from "@animaquill/core";
import { MemoryUndoPlace, memoryUndo, type UndoStore } from "@animaquill/host";
import { createProject } from "@animaquill/schema";
import { describe, expect, it, vi } from "vitest";
import { Emitter } from "./emitter.ts";
import { OperationLog } from "./operations.ts";
import { UndoKeeper, planKey } from "./undo-keeper.ts";

const KEY = "project-1";
const TASK = aiTask("t1");

/** A window with a project open, as the session gives it. */
function window(store: ProjectStore, host: UndoStore, options: { cloud?: boolean } = {}) {
  const emitter = new Emitter();
  const snapshot = { store, key: KEY };
  const session = { subscribe: emitter.subscribe, getSnapshot: () => snapshot };
  const keeper = new UndoKeeper({
    host,
    session,
    describe: () => ({ count: 1, label: "加一个片段" }),
    isCloud: () => options.cloud === true,
  });
  return { keeper, operations: new OperationLog(session, keeper) };
}

function opened() {
  const store = ProjectStore.create(createProject({ name: "撤销" }));
  const timeline = store.getState().timelines["main"];
  const track = timeline && orderedTracks(timeline).find(({ kind }) => kind === "video")?.id;
  const add = (target: ProjectStore, id: string, origin?: string, start = "0") => {
    const clip = { id, start, duration: "1", source: { kind: "color", color: "#ff0000" } };
    const result = target.execute(
      { type: "clip.add", params: { timeline: "main", track, ...clip } },
      origin === undefined ? {} : { origin },
    );
    if (!result.ok) throw new Error(result.error.code);
  };
  return { store, add };
}

/** The project as it is saved now, opened again. */
const reopened = (store: ProjectStore) =>
  ProjectStore.fromUpdates([store.encodeState()]).store as ProjectStore;

/** Two windows of one browser, which pass each other what they change, a moment later. */
function sync(a: ProjectStore, b: ProjectStore) {
  const pass = (to: ProjectStore) => (update: Uint8Array, from: unknown) => {
    if (from !== "remote") setTimeout(() => to.applyUpdates([update]), 30);
  };
  a.doc.on("update", pass(b));
  b.doc.on("update", pass(a));
}

/** A browser where reading takes a moment, and what other windows say comes late. */
function slow(host: UndoStore): UndoStore {
  const later = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  return {
    ...host,
    window: host.window,
    get: async (project, origin) => {
      const read = await host.get(project, origin);
      await later(10);
      return read;
    },
    listen: (listener) =>
      host.listen((project, origin) => void later(200).then(() => listener(project, origin))),
  };
}

const settle = () => vi.waitFor(() => Promise.resolve());

describe("undo logs that last across reloads", () => {
  it("are saved a moment after AI changed the project, and taken up when it opens again", async () => {
    vi.useFakeTimers();
    try {
      const place = new MemoryUndoPlace();
      const { store, add } = opened();
      const first = window(store, memoryUndo(place));
      add(store, "c1", TASK);
      expect(place.rows.size).toBe(0);
      await vi.advanceTimersByTimeAsync(500);
      expect(place.rows.size).toBe(1);

      const again = reopened(store);
      const second = window(again, memoryUndo(place));
      await vi.waitFor(() => expect(second.keeper.getSnapshot().restored).toHaveLength(1));
      expect(second.keeper.stateOf(TASK)).toEqual({ direction: "undo" });
      expect(second.operations.getSnapshot()).toMatchObject([
        { source: "ai", origin: TASK, label: "加一个片段", count: 1 },
      ]);
      const result = await second.keeper.takeBack(TASK, "undo");
      expect(result?.ok).toBe(true);
      expect(again.getState().timelines["main"]?.clips["c1"]).toBeUndefined();
      expect(second.keeper.stateOf(TASK)).toEqual({ direction: "redo" });
      first.keeper.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("saves the logs of several origins in one write, so that a page that goes right after has all", async () => {
    const place = new MemoryUndoPlace();
    const { store, add } = opened();
    const host = memoryUndo(place);
    const writes: string[][] = [];
    const saveAll = host.saveAll;
    const first = window(store, {
      ...host,
      window: host.window,
      saveAll: (project, saved, removed) => {
        writes.push(saved.map(({ origin }) => origin));
        return saveAll(project, saved, removed);
      },
    });
    add(store, "c1", TASK);
    add(store, "c2", aiTask("t2"), "2");
    await first.keeper.flush();
    expect(writes).toEqual([[TASK, aiTask("t2")]]);
    expect(place.rows.size).toBe(2);
    first.keeper.destroy();
  });

  it("says once what was saved is taken up, which a change of the same origin before keeps out", async () => {
    const place = new MemoryUndoPlace();
    const { store, add } = opened();
    const first = window(store, memoryUndo(place));
    add(store, "c1", TASK);
    await first.keeper.flush();
    first.keeper.destroy();

    // Taken up before the batch goes on, as opening a project waits for: all of it goes back.
    const again = reopened(store);
    const second = window(again, memoryUndo(place));
    await second.keeper.loaded(again);
    expect(second.keeper.getSnapshot().restored).toHaveLength(1);
    add(again, "c2", TASK, "2");
    expect((await second.keeper.takeBack(TASK, "undo"))?.ok).toBe(true);
    expect(again.getState().timelines["main"]?.clips["c1"]).toBeUndefined();
    expect(again.getState().timelines["main"]?.clips["c2"]).toBeUndefined();
    second.keeper.destroy();

    // The batch went on first: what was saved of it does not come back.
    const late = reopened(store);
    const third = window(late, memoryUndo(place));
    add(late, "c2", TASK, "2");
    await third.keeper.loaded(late);
    expect(third.keeper.getSnapshot().restored).toHaveLength(0);
    third.keeper.destroy();
  });

  it("take back only once when two windows ask at the same time", async () => {
    const place = new MemoryUndoPlace();
    const { store, add } = opened();
    const twin = reopened(store);
    sync(store, twin);
    const one = window(store, slow(memoryUndo(place)));
    const two = window(twin, slow(memoryUndo(place)));
    add(store, "c1", TASK);
    await one.keeper.flush();
    await vi.waitFor(() => expect(twin.canUndoOrigin(TASK)).toBe(true), { timeout: 2000 });
    const results = await Promise.all([
      one.keeper.takeBack(TASK, "undo"),
      two.keeper.takeBack(TASK, "undo"),
    ]);
    expect(results.map((result) => result?.ok)).toEqual([true, false]);
    await vi.waitFor(() => expect(store.getState()).toEqual(twin.getState()));
    expect(store.getState().timelines["main"]?.clips["c1"]).toBeUndefined();
    // The second sees it can be done again, as the first saved, once what it did came.
    await vi.waitFor(() => expect(two.keeper.stateOf(TASK)).toEqual({ direction: "redo" }), {
      timeout: 2000,
    });
    expect((await two.keeper.takeBack(TASK, "redo"))?.ok).toBe(true);
    await vi.waitFor(() => expect(store.getState().timelines["main"]?.clips["c1"]).toBeDefined());
  });

  it("take back several tasks only once when two windows ask at the same time", async () => {
    const place = new MemoryUndoPlace();
    const { store, add } = opened();
    const twin = reopened(store);
    sync(store, twin);
    const one = window(store, slow(memoryUndo(place)));
    const two = window(twin, slow(memoryUndo(place)));
    const second = aiTask("t2");
    add(store, "c1", TASK);
    add(store, "c2", second, "1");
    await one.keeper.flush();
    await vi.waitFor(() => expect(twin.canUndoOrigin(second)).toBe(true), { timeout: 2000 });
    // Both show people the same list.
    const shown = planKey(one.keeper.planMany([TASK, second], "undo") as never);
    expect(planKey(two.keeper.planMany([TASK, second], "undo") as never)).toBe(shown);
    const results = await Promise.all([
      one.keeper.takeBackMany([TASK, second], "undo", shown),
      two.keeper.takeBackMany([TASK, second], "undo", shown),
    ]);
    // The second sees in its turn that nothing is as it was shown, and leaves it.
    expect(results.map((result) => result?.done)).toEqual([true, false]);
    await vi.waitFor(() => expect(store.getState()).toEqual(twin.getState()));
    expect(store.getState().timelines["main"]?.clips["c1"]).toBeUndefined();
    expect(store.getState().timelines["main"]?.clips["c2"]).toBeUndefined();
    // Done again as a whole in the other window, as the first saved.
    await vi.waitFor(() => expect(two.keeper.stateOf(TASK)).toEqual({ direction: "redo" }), {
      timeout: 2000,
    });
    const again = await two.keeper.takeBackMany([TASK, second], "redo");
    expect(
      again?.done && again.result.ok && again.result.each.map(({ result }) => result.ok),
    ).toEqual([true, true]);
    await vi.waitFor(() => expect(store.getState().timelines["main"]?.clips["c2"]).toBeDefined());
  });

  it("take back once when one window takes back a task and another all of them", async () => {
    const place = new MemoryUndoPlace();
    const { store, add } = opened();
    const twin = reopened(store);
    sync(store, twin);
    const one = window(store, slow(memoryUndo(place)));
    const two = window(twin, slow(memoryUndo(place)));
    const second = aiTask("t2");
    add(store, "c1", TASK);
    add(store, "c2", second, "1");
    await one.keeper.flush();
    await vi.waitFor(() => expect(twin.canUndoOrigin(second)).toBe(true), { timeout: 2000 });
    const shown = planKey(two.keeper.planMany([TASK, second], "undo") as never);
    const [single, many] = await Promise.all([
      one.keeper.takeBack(second, "undo"),
      two.keeper.takeBackMany([TASK, second], "undo", shown),
    ]);
    expect(single?.ok).toBe(true);
    // What it showed is not what would go now: the second task went already.
    expect(many?.done).toBe(false);
    await vi.waitFor(() => expect(store.getState()).toEqual(twin.getState()));
    expect(store.getState().timelines["main"]?.clips["c1"]).toBeDefined();
    expect(store.getState().timelines["main"]?.clips["c2"]).toBeUndefined();
  });

  it("take back nothing of several when the project changed since people saw the list", async () => {
    const place = new MemoryUndoPlace();
    const { store, add } = opened();
    const here = window(store, memoryUndo(place));
    const second = aiTask("t2");
    add(store, "c1", TASK);
    add(store, "c2", second, "1");
    const shown = planKey(here.keeper.planMany([TASK, second], "undo") as never);
    // People change what the second task added while the list is open.
    const moved = store.execute({
      type: "clip.update",
      params: { timeline: "main", clip: "c2", changes: { start: "2" } },
    });
    expect(moved.ok).toBe(true);
    const outcome = await here.keeper.takeBackMany([TASK, second], "undo", shown);
    expect(outcome?.done).toBe(false);
    expect(store.getState().timelines["main"]?.clips["c1"]).toBeDefined();
    expect(store.canUndoOrigin(TASK)).toBe(true);
    // What would go now is what it says, and that goes.
    const now = outcome && !outcome.done ? planKey(outcome.plan) : "";
    expect((await here.keeper.takeBackMany([TASK, second], "undo", now))?.done).toBe(true);
    expect(store.getState().timelines["main"]?.clips["c1"]).toBeUndefined();
  });

  it("say why a task cannot be taken back here", async () => {
    const place = new MemoryUndoPlace();
    const { store, add } = opened();
    const here = window(store, memoryUndo(place), { cloud: true });
    // Made on another device: its log is there.
    expect(here.keeper.stateOf(aiTask("elsewhere"))).toEqual({
      direction: undefined,
      whyNot: "elsewhere",
    });
    add(store, "c1", TASK);
    store.execute({ type: "clip.remove", params: { timeline: "main", clips: ["c1"] } });
    expect(here.keeper.stateOf(TASK)).toMatchObject({ direction: "undo", whyNot: "changed" });
    await here.keeper.flush();
    // Logs past the newest 50 go, and say so.
    place.gone.set(JSON.stringify([KEY, aiTask("old")]), "count");
    const later = window(reopened(store), memoryUndo(place));
    await settle();
    await vi.waitFor(() =>
      expect(later.keeper.stateOf(aiTask("old"))).toEqual({
        direction: undefined,
        whyNot: "count",
      }),
    );
  });

  it("are cleared, here and in what the window can take back", async () => {
    const place = new MemoryUndoPlace();
    const { store, add } = opened();
    const here = window(store, memoryUndo(place));
    add(store, "c1", TASK);
    await here.keeper.flush();
    expect(await here.keeper.usage()).toMatchObject({ projects: 1 });
    await here.keeper.clear();
    expect(await here.keeper.usage()).toEqual({ projects: 0, bytes: 0 });
    expect(store.canUndoOrigin(TASK)).toBe(false);
  });
});
