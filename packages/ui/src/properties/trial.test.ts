import { aiTask, orderedTracks, type PropertyEdit } from "@animaquill/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TimelineEditor } from "../timeline/editor.ts";
import {
  MemoryLibrary,
  MemoryTrials,
  memoryAddress,
  memoryWindow,
} from "../workbench/memory-library.ts";
import { ProjectSession } from "../workbench/session.ts";
import { TrialSession, type TrialMessages } from "./trial.ts";

const noSession = {
  createFailed: vi.fn(),
  notFound: vi.fn(),
  openFailed: vi.fn(),
  tooNew: vi.fn(),
  damaged: vi.fn(),
  saveFailed: vi.fn(),
  saveRecovered: vi.fn(),
};

function memorySettings() {
  const values = new Map<string, unknown>();
  const listeners = new Map<string, (value: unknown) => void>();
  return {
    values,
    /** What the browser does when another window saves a setting. */
    fromElsewhere: (key: string, value: unknown) => listeners.get(key)?.(value),
    load: async (key: string) => values.get(key),
    save: async (key: string, value: unknown) => void values.set(key, value),
    listen: (key: string, listener: (value: unknown) => void) => {
      listeners.set(key, listener);
      return () => {};
    },
  };
}

function messages() {
  return {
    commandFailed: vi.fn<TrialMessages["commandFailed"]>(),
    overwrote: vi.fn<TrialMessages["overwrote"]>(),
    discarded: vi.fn<TrialMessages["discarded"]>(),
    setAside: vi.fn<TrialMessages["setAside"]>(),
    back: vi.fn<TrialMessages["back"]>(),
    asideDropped: vi.fn<TrialMessages["asideDropped"]>(),
    unsure: vi.fn<TrialMessages["unsure"]>(),
    restored: vi.fn<TrialMessages["restored"]>(),
    dropped: vi.fn<TrialMessages["dropped"]>(),
    readFailed: vi.fn<TrialMessages["readFailed"]>(),
    keepFailed: vi.fn<TrialMessages["keepFailed"]>(),
    keepRecovered: vi.fn<TrialMessages["keepRecovered"]>(),
  };
}

/** A browser: projects, what is kept and settings, shared by the windows that open on it. */
function browser() {
  return { library: new MemoryLibrary(), kept: new MemoryTrials(), settings: memorySettings() };
}

type Browser = ReturnType<typeof browser>;

/** A window on a project, like one more tab, or the same one after a reload. */
async function open(place: Browser, id: string) {
  const session = new ProjectSession(place.library, memoryAddress(), noSession);
  const said = messages();
  const timeline = new TimelineEditor(session, memoryWindow(), place.settings, {
    commandFailed: vi.fn(),
  });
  const trials = new TrialSession(session, timeline, place.kept, place.settings, said);
  await trials.load();
  await session.open(id);
  await trials.settle();
  const store = session.store;
  if (!store) throw new Error("no project");
  return { session, trials, store, said };
}

const owner = { clip: "c" };
const write = (value: number, path = "transform.x"): PropertyEdit => ({
  owner,
  path,
  op: "write",
  time: "1",
  value,
});

async function setup(place = browser()) {
  const session = new ProjectSession(place.library, memoryAddress(), noSession);
  await session.create("试改");
  const store = session.store;
  if (!store) throw new Error("no project");
  const track = orderedTracks(store.getState().timelines["main"] as never).find(
    ({ kind }) => kind === "video",
  )?.id;
  const clip = { id: "c", start: "0", duration: "5", source: { kind: "color", color: "#ff0000" } };
  store.execute({ type: "clip.add", params: { timeline: "main", track, clip } });
  await session.trySave();
  const { id } = store.getState().manifest;
  await session.close();
  return { place, id, ...(await open(place, id)) };
}

const shown = (trials: TrialSession, path = "transform.x") =>
  trials.getValues().get("c")?.get(path);

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("what the title bar shows", () => {
  it("counts properties, not steps", async () => {
    const { trials } = await setup();
    trials.write([write(1)]);
    trials.write([write(2)]);
    expect(trials.getSnapshot().count).toBe(1);
    trials.write([write(0.5, "opacity")]);
    expect(trials.getSnapshot().count).toBe(2);
  });

  it("gets a new snapshot when a value changes, although the count stays", async () => {
    const { trials } = await setup();
    trials.write([write(1)]);
    const before = trials.getSnapshot();
    const listener = vi.fn();
    trials.subscribe(listener);
    trials.write([write(2)]);
    expect(listener).toHaveBeenCalled();
    expect(trials.getSnapshot()).not.toBe(before);
  });

  it("stays the same object when nothing changed, as React wants it", async () => {
    const { trials, store } = await setup();
    trials.write([write(1)]);
    const before = trials.getSnapshot();
    store.execute({ type: "project.rename", params: { name: "别的" } });
    expect(trials.getSnapshot()).toBe(before);
  });

  it("counts what somebody else changed", async () => {
    const { trials, store } = await setup();
    trials.write([write(1)]);
    expect(trials.getSnapshot().conflicts).toBe(0);
    const edits = [{ owner, path: "transform.x", op: "set", value: 9 }];
    store.execute(
      { type: "property.edit", params: { timeline: "main", edits } },
      { origin: aiTask("t") },
    );
    expect(trials.getSnapshot().conflicts).toBe(1);
    expect(shown(trials)).toBe(1);
  });
});

describe("comparing", () => {
  it("switches what the picture and the tab go by, and nothing else", async () => {
    const { trials, store } = await setup();
    trials.write([write(1)]);
    const { revision } = store;
    trials.toggleCompare();
    expect(trials.getSnapshot()).toMatchObject({ comparing: true, count: 1 });
    expect(trials.getValues().size).toBe(0);
    expect(trials.look).toBeUndefined();
    trials.toggleCompare();
    expect(trials.getSnapshot().comparing).toBe(false);
    expect(shown(trials)).toBe(1);
    expect(trials.look).toBeDefined();
    expect(store.revision).toBe(revision);
  });

  it("has nothing to compare without anything being tried", async () => {
    const { trials } = await setup();
    trials.toggleCompare();
    expect(trials.getSnapshot().comparing).toBe(false);
  });

  it("ends with what people do next", async () => {
    const { trials } = await setup();
    trials.write([write(1)]);
    trials.toggleCompare();
    trials.write([write(2)]);
    expect(trials.getSnapshot().comparing).toBe(false);
  });

  it.each([
    ["saving", (trials: TrialSession) => void trials.save()],
    ["giving up", (trials: TrialSession) => trials.discard()],
    ["undo", (trials: TrialSession) => trials.undo()],
  ])("ends with %s", async (_, end) => {
    const { trials } = await setup();
    trials.write([write(1)]);
    trials.write([write(2)]);
    trials.toggleCompare();
    end(trials);
    expect(trials.getSnapshot().comparing).toBe(false);
  });

  it("ends when the last of it goes away with its clip", async () => {
    const { trials, store } = await setup();
    trials.write([write(1)]);
    trials.toggleCompare();
    store.execute({ type: "clip.remove", params: { timeline: "main", clips: ["c"] } });
    expect(trials.getSnapshot()).toMatchObject({ comparing: false, count: 0 });
  });
});

describe("giving up", () => {
  it("says how much, because a click is quickly made", async () => {
    const { trials, said } = await setup();
    trials.write([write(1), write(0.5, "opacity")]);
    trials.discard();
    expect(said.discarded).toHaveBeenCalledExactlyOnceWith(2);
    expect(trials.getSnapshot().count).toBe(0);
    trials.undo();
    expect(trials.getSnapshot().count).toBe(2);
  });

  it("has nothing to say when there is nothing", async () => {
    const { trials, said } = await setup();
    trials.discard();
    expect(said.discarded).not.toHaveBeenCalled();
  });

  it("can be about one property", async () => {
    const { trials } = await setup();
    trials.write([write(1), write(0.5, "opacity")]);
    trials.discardProperty("c", "opacity");
    expect(trials.getSnapshot().count).toBe(1);
    expect(shown(trials)).toBe(1);
  });
});

describe("what happens to clips", () => {
  const remove = { type: "clip.remove", params: { timeline: "main", clips: ["c"] } };

  it("tells people what got set aside with a clip, and when it is back", async () => {
    const { trials, store, said } = await setup();
    trials.write([write(1), write(0.5, "opacity")]);
    store.execute(remove);
    expect(said.setAside).toHaveBeenCalledExactlyOnceWith(2);
    expect(trials.getSnapshot()).toMatchObject({ count: 0, setAside: 2 });
    expect(trials.getValues().size).toBe(0);
    store.undo();
    expect(said.back).toHaveBeenCalledExactlyOnceWith(2);
    expect(trials.getSnapshot()).toMatchObject({ count: 2, setAside: 0 });
    expect(shown(trials)).toBe(1);
  });

  it("gets it through a reload, without calling it something that is being tried", async () => {
    const { place, id, trials, store, session } = await setup();
    trials.write([write(1)]);
    store.execute(remove);
    await session.trySave();
    await trials.settle();
    await session.close();
    const next = await open(place, id);
    expect(next.trials.getSnapshot()).toMatchObject({ count: 0, setAside: 1 });
    expect(next.said.restored).not.toHaveBeenCalled();
  });

  it("clears it along with everything else, also when nothing else is there", async () => {
    const { trials, store, said, place, id } = await setup();
    trials.write([write(1)]);
    store.execute(remove);
    await trials.settle();
    expect(place.kept.kept.get(id)?.size).toBe(1);
    trials.discard();
    expect(said.discarded).toHaveBeenCalledExactlyOnceWith(1);
    expect(trials.getSnapshot().setAside).toBe(0);
    await trials.settle();
    expect(place.kept.kept.get(id)?.size).toBe(0);
  });

  it("does not ask about it on the way out, and keeps it", async () => {
    const { trials, store, place, id } = await setup();
    trials.write([write(1)]);
    store.execute(remove);
    await trials.settle();
    expect(place.kept.writes.at(-1)).toMatchObject({ changes: [{ clip: "c" }] });
    expect(trials.notKept).toBe(false);
    expect(place.kept.kept.get(id)?.size).toBe(1);
  });

  it("still counts when it cannot be kept, because it would be gone after a reload", async () => {
    const { trials, store, place } = await setup();
    trials.write([write(1)]);
    await trials.settle();
    place.kept.failing = true;
    store.execute(remove);
    expect(await trials.settle()).toBe(false);
    expect(trials.getSnapshot()).toMatchObject({ count: 0, setAside: 1 });
    expect(trials.notKept).toBe(true);
    place.kept.failing = false;
    expect(await trials.settle()).toBe(true);
    expect(trials.notKept).toBe(false);
  });

  it("says so when it cannot tell what another window did", async () => {
    const { place, id, trials, said } = await setup();
    const key = { owner, path: "transform.x", op: "setKey", time: "1", value: 7 } as const;
    trials.write([key]);
    const other = await open(place, id);
    other.store.execute({
      type: "clip.move",
      params: { timeline: "main", clips: [{ clip: "c", start: "3" }] },
    });
    other.store.execute({
      type: "clip.trim",
      params: { timeline: "main", clip: "c", start: "1" },
    });
    await other.session.trySave();
    await vi.waitFor(() => expect(said.unsure).toHaveBeenCalledOnce());
  });
});

describe("the setting", () => {
  it("is on until somebody says otherwise", async () => {
    const { trials } = await setup();
    expect(trials.getSnapshot().enabled).toBe(true);
    expect(trials.takesEdits).toBe(true);
  });

  it("is kept, and all windows go by it", async () => {
    const { trials, place, id } = await setup();
    trials.setEnabled(false);
    expect(trials.takesEdits).toBe(false);
    await expect(place.settings.load("trial")).resolves.toEqual({ version: 1, enabled: false });
    const next = await open(place, id);
    expect(next.trials.getSnapshot().enabled).toBe(false);
  });

  it("follows another window", async () => {
    const { trials, place } = await setup();
    place.settings.fromElsewhere("trial", { version: 1, enabled: false });
    expect(trials.getSnapshot().enabled).toBe(false);
  });

  it.each([
    ["nonsense", "关"],
    ["another version", { version: 2, enabled: false }],
    ["no answer", { version: 1 }],
  ])("stays on with %s", async (_, value) => {
    const place = browser();
    const { id } = await setup(place);
    place.settings.values.set("trial", value);
    expect((await open(place, id)).trials.getSnapshot().enabled).toBe(true);
  });

  it("does not leave what is being tried without a way out", async () => {
    const { trials } = await setup();
    trials.write([write(1)]);
    trials.setEnabled(false);
    expect(trials.takesEdits).toBe(true);
    trials.save();
    expect(trials.takesEdits).toBe(false);
  });
});

describe("keeping it on the device", () => {
  it("happens with every step, and a reload brings it back", async () => {
    const { trials, place, id, said, session } = await setup();
    trials.write([write(1), write(0.5, "opacity")]);
    await trials.settle();
    await session.close();
    const next = await open(place, id);
    expect(next.trials.getSnapshot().count).toBe(2);
    expect(shown(next.trials)).toBe(1);
    expect(next.said.restored).toHaveBeenCalledExactlyOnceWith(2);
    expect(said.restored).not.toHaveBeenCalled();
  });

  it("leaves what was kept alone while the project opens, which a crash could catch it at", async () => {
    const { trials, place, id, session } = await setup();
    trials.write([write(1)]);
    await trials.settle();
    await session.close();
    place.kept.writes.length = 0;
    const next = await open(place, id);
    expect(next.trials.getSnapshot().count).toBe(1);
    expect(place.kept.writes).not.toContain(undefined);
  });

  it("has nothing to write for a project without anything being tried", async () => {
    const { place, id, session } = await setup();
    await session.close();
    place.kept.writes.length = 0;
    await open(place, id);
    expect(place.kept.writes).toEqual([]);
  });

  it("is there without closing anything, which is what a crash looks like", async () => {
    const { trials, place, id } = await setup();
    trials.write([write(1)]);
    await trials.settle();
    const kept = [...(place.kept.kept.get(id)?.values() ?? [])];
    expect(kept).toHaveLength(1);
    expect(JSON.stringify(kept[0])).toContain("transform.x");
  });

  it("leaves nothing behind after saving", async () => {
    const { trials, place, id, session } = await setup();
    trials.write([write(1)]);
    await trials.settle();
    trials.save();
    await session.trySave();
    await trials.settle();
    expect(place.kept.kept.get(id)?.size).toBe(0);
    await session.close();
    expect((await open(place, id)).trials.getSnapshot().count).toBe(0);
  });

  it("stays on the device until the project is, whatever happens in between", async () => {
    const { trials, place, id, session } = await setup();
    trials.write([write(1)]);
    await trials.settle();
    place.library.failing = true;
    expect(trials.save()).toBe(true);
    await session.trySave();
    await trials.settle();
    expect(place.kept.kept.get(id)?.size).toBe(1);
    expect(place.kept.writes).not.toContain(undefined);

    place.library.failing = false;
    await session.trySave();
    await trials.settle();
    await vi.waitFor(() => expect(place.kept.kept.get(id)?.size).toBe(0));
  });

  it("goes on keeping what comes next after saving did not work", async () => {
    const { trials, store, place, id } = await setup();
    const track = orderedTracks(store.getState().timelines["main"] as never).find(
      ({ kind }) => kind === "video",
    )?.id;
    const locked = (value: boolean) => ({
      type: "track.update",
      params: { timeline: "main", track, changes: { locked: value } },
    });
    trials.write([write(1)]);
    await trials.settle();
    store.execute(locked(true));
    expect(trials.save()).toBe(false);
    store.execute(locked(false));
    trials.write([write(2)]);
    await trials.settle();
    expect(JSON.stringify([...(place.kept.kept.get(id)?.values() ?? [])])).toContain('"value":2');
  });

  it("comes back after a crash between the two, without anything lost or doubled", async () => {
    const { trials, place, id, store } = await setup();
    trials.write([write(1)]);
    await trials.settle();
    place.library.failing = true;
    trials.save();
    await trials.settle();
    expect(store.getState().timelines["main"]?.clips["c"]?.properties).toBeDefined();
    place.library.failing = false;
    place.kept.held.clear();
    const next = await open(place, id);
    expect(next.store.getState().timelines["main"]?.clips["c"]?.properties).toBeUndefined();
    expect(shown(next.trials)).toBe(1);
  });

  it("writes off what comes back and is in the project after all", async () => {
    const { place, id, session, trials } = await setup();
    const second = await open(place, id);
    trials.write([write(1)]);
    await trials.settle();
    await session.close();
    second.store.execute({
      type: "property.edit",
      params: {
        timeline: "main",
        edits: [{ owner, path: "transform.x", op: "set", value: 1 }],
      },
    });
    await second.session.trySave();
    await second.session.close();
    const third = await open(place, id);
    expect(third.trials.getSnapshot().count).toBe(0);
    expect(third.said.restored).not.toHaveBeenCalled();
    await third.trials.settle();
    expect([...(place.kept.kept.get(id)?.values() ?? [])]).toEqual([]);
  });

  it("waits with the next window until the last write is in", async () => {
    const { trials, place, id, session } = await setup();
    const written = deferred();
    place.kept.duringSave = () => written.promise;
    trials.write([write(1)]);
    await vi.waitFor(() => expect(trials.notKept).toBe(true));
    await session.close();
    expect(place.kept.held.size).toBe(1);
    place.kept.duringSave = undefined;
    written.resolve();
    await vi.waitFor(() => expect(place.kept.held.size).toBe(0));
    expect([...(place.kept.kept.get(id)?.values() ?? [])]).toHaveLength(1);
  });

  it("leaves nothing behind after giving up", async () => {
    const { trials, place, id } = await setup();
    trials.write([write(1)]);
    trials.discard();
    await trials.settle();
    expect(place.kept.kept.get(id)?.size).toBe(0);
  });

  it("gets the last state in, and writes it once however much happens during a write", async () => {
    const { trials, place, id } = await setup();
    const write1 = deferred();
    place.kept.duringSave = () => write1.promise;
    trials.write([write(1)]);
    await vi.waitFor(() => expect(trials.notKept).toBe(true));
    for (let value = 2; value <= 20; value += 1) trials.write([write(value)]);
    place.kept.duringSave = undefined;
    write1.resolve();
    await trials.settle();
    expect(place.kept.writes).toHaveLength(2);
    const kept = [...(place.kept.kept.get(id)?.values() ?? [])];
    expect(JSON.stringify(kept)).toContain('"value":20');
    expect(trials.notKept).toBe(false);
  });

  it("counts what is on its way as not there yet, for whoever is about to close the page", async () => {
    const { trials, place } = await setup();
    const written = deferred();
    place.kept.duringSave = () => written.promise;
    expect(trials.notKept).toBe(false);
    trials.write([write(1)]);
    expect(trials.notKept).toBe(true);
    written.resolve();
    await trials.settle();
    expect(trials.notKept).toBe(false);
  });

  it("does not look at what another window is trying", async () => {
    const { trials, place, id } = await setup();
    trials.write([write(1)]);
    await trials.settle();
    const other = await open(place, id);
    expect(other.trials.getSnapshot().count).toBe(0);
    other.trials.write([write(2)]);
    other.trials.save();
    await other.trials.settle();
    expect(shown(trials)).toBe(1);
  });

  it("what one window saves does not take away what the other one keeps", async () => {
    const { trials, place, id, session } = await setup();
    trials.write([write(1)]);
    await trials.settle();
    const other = await open(place, id);
    other.trials.write([write(2, "opacity")]);
    other.trials.write([write(0.5, "opacity")]);
    other.trials.save();
    await other.trials.settle();
    await other.session.close();
    await session.close();
    const next = await open(place, id);
    expect(shown(next.trials)).toBe(1);
  });

  it("tries again by itself after a while, and says when it worked", async () => {
    const { trials, place, id, said } = await setup();
    place.kept.failing = true;
    vi.useFakeTimers();
    trials.write([write(1)]);
    await vi.advanceTimersByTimeAsync(0);
    expect(said.keepFailed).toHaveBeenCalledOnce();
    expect(trials.notKept).toBe(true);
    place.kept.failing = false;
    await vi.advanceTimersByTimeAsync(5000);
    vi.useRealTimers();
    expect(said.keepRecovered).toHaveBeenCalledOnce();
    expect(trials.notKept).toBe(false);
    expect(place.kept.kept.get(id)?.size).toBe(1);
  });

  it("gets another try for a place, and goes on from there as if nothing happened", async () => {
    const { place, id, session, trials } = await setup();
    trials.write([write(1)]);
    await trials.settle();
    await session.close();
    place.kept.failing = true;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const opening = open(place, id);
    await vi.advanceTimersByTimeAsync(0);
    const next = await opening;
    expect(next.said.keepFailed).toHaveBeenCalledOnce();
    next.trials.write([write(0.5, "opacity")]);
    expect(next.trials.notKept).toBe(true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(next.said.keepFailed).toHaveBeenCalledOnce();
    place.kept.failing = false;
    await vi.advanceTimersByTimeAsync(5000);
    vi.useRealTimers();
    expect(next.trials.notKept).toBe(false);
    expect(next.said.keepRecovered).toHaveBeenCalledOnce();
    expect(shown(next.trials)).toBe(1);
    expect(shown(next.trials, "opacity")).toBe(0.5);
    expect(JSON.stringify([...(place.kept.kept.get(id)?.values() ?? [])])).toContain("opacity");
  });

  it("lets go of a place that came too late", async () => {
    const { place, id, session, trials } = await setup();
    await trials.settle();
    await session.close();
    await vi.waitFor(() => expect(place.kept.held.size).toBe(0));
    place.kept.failing = true;
    const next = await open(place, id);
    place.kept.failing = false;
    await next.session.close();
    await vi.waitFor(() => expect(place.kept.held.size).toBe(0));
  });

  it("takes another look before saying on the way out that it could not be kept", async () => {
    const { trials, place } = await setup();
    place.kept.failing = true;
    trials.write([write(1)]);
    expect(await trials.settle()).toBe(false);
    place.kept.failing = false;
    expect(await trials.settle()).toBe(true);
    expect(trials.notKept).toBe(false);
  });

  it("does not stop anybody when the device cannot keep it, and says so once", async () => {
    const { trials, place, said } = await setup();
    place.kept.failing = true;
    trials.write([write(1)]);
    trials.write([write(2)]);
    expect(await trials.settle()).toBe(false);
    expect(shown(trials)).toBe(2);
    expect(trials.notKept).toBe(true);
    trials.write([write(3)]);
    await trials.settle();
    expect(said.keepFailed).toHaveBeenCalledOnce();
    place.kept.failing = false;
    trials.write([write(4)]);
    expect(await trials.settle()).toBe(true);
    expect(trials.notKept).toBe(false);
    expect(said.keepRecovered).toHaveBeenCalledOnce();
  });

  it("has nothing to lose once what could not be kept is in the project", async () => {
    const { trials, place } = await setup();
    place.kept.failing = true;
    trials.write([write(1)]);
    await trials.settle();
    expect(trials.notKept).toBe(true);
    trials.save();
    await trials.settle();
    expect(trials.notKept).toBe(false);
  });

  it("works without a place at all, and says so", async () => {
    const place = browser();
    const { id, session } = await setup(place);
    await session.close();
    place.kept.failing = true;
    const next = await open(place, id);
    expect(next.said.keepFailed).toHaveBeenCalledOnce();
    expect(next.trials.write([write(1)])).toBe(true);
    expect(shown(next.trials)).toBe(1);
    expect(await next.trials.settle()).toBe(false);
    expect(next.trials.notKept).toBe(true);
    expect(next.said.keepFailed).toHaveBeenCalledOnce();
  });
});

describe("what was kept can be anything", () => {
  async function reopenWith(kept: unknown) {
    const { place, id, session, trials } = await setup();
    trials.write([write(1)]);
    await trials.settle();
    await session.close();
    const places = place.kept.kept.get(id) as Map<string, unknown>;
    for (const name of places.keys()) places.set(name, kept);
    return { place, id, next: await open(place, id) };
  }

  it("opens the project all the same when it is nonsense, and says so once", async () => {
    const { place, id, next } = await reopenWith("这不是试改");
    expect(next.store).toBeDefined();
    expect(next.trials.getSnapshot().count).toBe(0);
    expect(next.said.dropped).toHaveBeenCalledOnce();
    await next.trials.settle();
    await next.session.close();
    const again = await open(place, id);
    expect(again.said.dropped).not.toHaveBeenCalled();
  });

  it("brings back what still works, and says something stayed out", async () => {
    const { next } = await reopenWith({
      version: 1,
      timeline: "main",
      changes: [
        { clip: "gone", path: "opacity", value: 0.5 },
        { clip: "c", path: "opacity", value: 7 },
        { clip: "c", path: "transform.x", value: 3 },
      ],
    });
    expect(next.trials.getSnapshot().count).toBe(1);
    expect(next.said.restored).toHaveBeenCalledExactlyOnceWith(1);
    expect(next.said.dropped).toHaveBeenCalledExactlyOnceWith(1);
    expect(next.trials.getSnapshot().setAside).toBe(1);
  });

  it("opens the project when reading fails, and says so", async () => {
    const { place, id, session, trials } = await setup();
    trials.write([write(1)]);
    await trials.settle();
    await session.close();
    place.kept.failingToRead = true;
    const next = await open(place, id);
    expect(next.store).toBeDefined();
    expect(next.trials.getSnapshot().count).toBe(0);
    expect(next.said.readFailed).toHaveBeenCalledOnce();
    expect(next.said.dropped).not.toHaveBeenCalled();
  });

  it("takes another look by itself after a while", async () => {
    const { place, id, session, trials } = await setup();
    trials.write([write(1)]);
    await trials.settle();
    await session.close();
    place.kept.failingToRead = true;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const opening = open(place, id);
    await vi.advanceTimersByTimeAsync(0);
    const next = await opening;
    expect(next.said.readFailed).toHaveBeenCalledOnce();
    place.kept.failingToRead = false;
    await vi.advanceTimersByTimeAsync(5000);
    vi.useRealTimers();
    expect(shown(next.trials)).toBe(1);
    expect(next.said.restored).toHaveBeenCalledExactlyOnceWith(1);
  });

  it("does not write over what could not be read, and brings it back when it can", async () => {
    const { place, id, session, trials } = await setup();
    trials.write([write(1)]);
    await trials.settle();
    await session.close();
    place.kept.failingToRead = true;
    place.kept.writes.length = 0;
    const next = await open(place, id);
    next.trials.write([write(0.5, "opacity")]);
    expect(await next.trials.settle()).toBe(false);
    expect(next.trials.notKept).toBe(true);
    expect(place.kept.writes).toEqual([]);

    place.kept.failingToRead = false;
    expect(await next.trials.settle()).toBe(true);
    expect(shown(next.trials)).toBe(1);
    expect(shown(next.trials, "opacity")).toBe(0.5);
    expect(next.said.restored).toHaveBeenCalledExactlyOnceWith(1);
  });

  it("is over when reading works after all, also with nothing to bring back", async () => {
    const { place, id, session } = await setup();
    await session.close();
    await vi.waitFor(() => expect(place.kept.held.size).toBe(0));
    place.kept.failingToRead = true;
    const next = await open(place, id);
    expect(next.said.readFailed).toHaveBeenCalledOnce();
    place.kept.failingToRead = false;
    expect(await next.trials.settle()).toBe(true);
  });

  it("leaves what could not be read for the next window", async () => {
    const { place, id, session, trials } = await setup();
    trials.write([write(1)]);
    await trials.settle();
    await session.close();
    place.kept.failingToRead = true;
    const next = await open(place, id);
    next.trials.write([write(0.5, "opacity")]);
    expect(await next.trials.settle()).toBe(false);
    await next.session.close();
    await vi.waitFor(() => expect(place.kept.held.size).toBe(0));
    place.kept.failingToRead = false;
    const after = await open(place, id);
    expect(shown(after.trials)).toBe(1);
    expect(after.said.restored).toHaveBeenCalledExactlyOnceWith(1);
  });

  it("goes under what was tried in the meantime, so that undo gets back to it", async () => {
    const { place, id, session, trials } = await setup();
    trials.write([write(1)]);
    await trials.settle();
    await session.close();
    const reading = deferred();
    place.kept.duringLoad = () => reading.promise;
    const window = new ProjectSession(place.library, memoryAddress(), noSession);
    const timeline = new TimelineEditor(window, memoryWindow(), place.settings, {
      commandFailed: vi.fn(),
    });
    const next = new TrialSession(window, timeline, place.kept, place.settings, messages());
    await window.open(id);
    next.write([write(0.5, "opacity")]);
    reading.resolve();
    await next.settle();
    expect(next.getSnapshot().count).toBe(2);
    next.undo();
    expect(next.getSnapshot().count).toBe(1);
    expect(shown(next)).toBe(1);
  });
});

describe("changing project", () => {
  it("leaves nothing of one project in the next", async () => {
    const { trials, session, place } = await setup();
    trials.write([write(1)]);
    await trials.settle();
    await session.close();
    expect(trials.getSnapshot().count).toBe(0);
    expect(trials.getValues().size).toBe(0);
    expect(trials.look).toBeUndefined();
    expect(trials.takesEdits).toBe(false);
    expect(trials.canUndo).toBe(false);
    await session.create("别的");
    await trials.settle();
    expect(trials.getSnapshot().count).toBe(0);
    expect(place.kept.kept.size).toBeGreaterThan(0);
  });

  it("gives the place back, so that the next window finds what was kept", async () => {
    const { trials, session, place, id } = await setup();
    trials.write([write(1)]);
    await trials.settle();
    await session.close();
    await vi.waitFor(async () => {
      const next = await open(place, id);
      expect(next.trials.getSnapshot().count).toBe(1);
    });
  });

  it("does not bring anything back into a project that was left in the meantime", async () => {
    const { trials, session, place, id } = await setup();
    trials.write([write(1)]);
    await trials.settle();
    await session.close();
    const reading = deferred();
    place.kept.duringLoad = () => reading.promise;
    place.kept.writes.length = 0;
    const said = messages();
    const window = new ProjectSession(place.library, memoryAddress(), noSession);
    const timeline = new TimelineEditor(window, memoryWindow(), place.settings, {
      commandFailed: vi.fn(),
    });
    const late = new TrialSession(window, timeline, place.kept, place.settings, said);
    await window.open(id);
    await vi.waitFor(() => expect(place.kept.held.size).toBe(1));
    const closing = window.close();
    await closing;
    reading.resolve();
    await vi.waitFor(() => expect(place.kept.held.size).toBe(0));
    expect(late.getSnapshot().count).toBe(0);
    expect(late.getValues().size).toBe(0);
    expect(said.restored).not.toHaveBeenCalled();
    expect(place.kept.writes).toEqual([]);
    expect([...(place.kept.kept.get(id)?.values() ?? [])]).toHaveLength(1);
  });

  it("starts with nothing on the next project, also where the numbers happen to be the same", async () => {
    const { trials, session } = await setup();
    trials.write([write(1)]);
    await trials.settle();
    await session.close();
    await session.create("别的");
    await trials.settle();
    const track = orderedTracks(session.store?.getState().timelines["main"] as never).find(
      ({ kind }) => kind === "video",
    )?.id;
    const clip = {
      id: "c",
      start: "0",
      duration: "5",
      source: { kind: "color", color: "#ff0000" },
    };
    session.store?.execute({ type: "clip.add", params: { timeline: "main", track, clip } });
    const listener = vi.fn();
    trials.subscribe(listener);
    trials.write([write(0.5, "opacity")]);
    expect(listener).toHaveBeenCalled();
    expect(trials.getValues().get("c")?.has("transform.x")).toBe(false);
    expect(shown(trials, "opacity")).toBe(0.5);
  });

  it("waits for what was kept before saying that nothing is being tried", async () => {
    const { trials, session, place, id } = await setup();
    trials.write([write(1)]);
    await trials.settle();
    await session.close();
    const reading = deferred();
    place.kept.duringLoad = () => reading.promise;
    const opened = session.open(id);
    await opened;
    const settling = trials.settle();
    expect(trials.getSnapshot().count).toBe(0);
    reading.resolve();
    await settling;
    expect(trials.getSnapshot().count).toBe(1);
  });
});
