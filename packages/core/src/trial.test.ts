import { createProject } from "@animaquill/schema";
import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { orderedTracks } from "./model.ts";
import type { KeyEase, PropertyEdit } from "./property-edit.ts";
import { ProjectStore, USER, aiTask, type CommandCall } from "./store.ts";
import { Trial, type TrialNotice } from "./trial.ts";

function setup() {
  const store = ProjectStore.create(createProject({ name: "试改" }));
  const main = () => store.getState().timelines["main"];
  const track = orderedTracks(main() as never).find(({ kind }) => kind === "video")?.id as string;
  const run = (call: CommandCall) => {
    const result = store.execute(call);
    if (!result.ok) throw new Error(result.error.message);
    return result;
  };
  const clip = { id: "c", start: "2", duration: "6", source: { kind: "color", color: "#ff0000" } };
  run({ type: "clip.add", params: { timeline: "main", track, clip } });
  const trial = new Trial(store, "main");
  const heard: TrialNotice[] = [];
  trial.onNotice((notice) => heard.push(notice));
  const saved = (path: string, id = "c") => main()?.clips[id]?.properties?.[path];
  const tried = (path: string, id = "c") => trial.changes.get(id)?.get(path)?.value;
  return { store, run, trial, heard, saved, tried, track, main };
}

/** Another window on the same project, which is one update away. */
function window(store: ProjectStore) {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(store.doc));
  const other = new ProjectStore(doc);
  const arrive = () => {
    store.applyUpdates([Y.encodeStateAsUpdate(doc, Y.encodeStateVector(store.doc))]);
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(store.doc, Y.encodeStateVector(doc)), "sync");
  };
  return { other, arrive };
}

const owner = { clip: "c" };
const write = (value: number, path = "transform.x", time = "1"): PropertyEdit => ({
  owner,
  path,
  op: "write",
  time,
  value,
});
const set = (value: unknown, path = "transform.x", clip = "c"): CommandCall => ({
  type: "property.edit",
  params: { timeline: "main", edits: [{ owner: { clip }, path, op: "set", value }] },
});
const twoKeys = {
  keys: [
    { time: "0", value: 0 },
    { time: "2", value: 2 },
  ],
};

describe("trying something out", () => {
  it("shows up here and leaves the project alone", () => {
    const { store, trial, saved, tried } = setup();
    const { revision } = store;
    const steps = store.history.length;
    expect(trial.write([write(10)])).toEqual({ ok: true });
    expect(tried("transform.x")).toBe(10);
    expect(trial.count).toBe(1);
    expect(saved("transform.x")).toBeUndefined();
    expect(store.revision).toBe(revision);
    expect(store.history).toHaveLength(steps);
  });

  it("follows the same rule as writing: with keys, an edit writes a key", () => {
    const { run, trial, tried } = setup();
    run(set(twoKeys));
    trial.write([write(9)]);
    expect(tried("transform.x")).toEqual({
      keys: [
        { time: "0", value: 0 },
        { time: "1", value: 9 },
        { time: "2", value: 2 },
      ],
    });
  });

  it("goes on from what is being tried, not from what is saved", () => {
    const { trial, tried } = setup();
    const x = { owner, path: "transform.x" };
    trial.write([{ ...x, op: "setKey", time: "0", value: 1 }]);
    trial.write([{ ...x, op: "setKey", time: "1", value: 2 }]);
    trial.write([{ ...x, op: "removeKey", time: "0" }]);
    expect(tried("transform.x")).toEqual({ keys: [{ time: "1", value: 2 }] });
  });

  it("gives a time its one spelling, as a command does", () => {
    const { trial, tried } = setup();
    trial.write([{ owner, path: "transform.x", op: "setKey", time: "0.50", value: 1 }]);
    expect(tried("transform.x")).toEqual({ keys: [{ time: "0.5", value: 1 }] });
  });

  it("can take a property away", () => {
    const { run, trial, saved } = setup();
    run(set(5));
    trial.write([{ owner, path: "transform.x", op: "clear" }]);
    expect(trial.holds("c", "transform.x")).toBe(true);
    expect(trial.changes.get("c")?.get("transform.x")?.value).toBeUndefined();
    expect(saved("transform.x")).toBe(5);
  });

  it("does not count what ends up the way the project has it", () => {
    const { run, trial } = setup();
    run(set(5));
    trial.write([write(6)]);
    expect(trial.count).toBe(1);
    trial.write([write(5)]);
    expect(trial.count).toBe(0);
    expect(trial.changes.size).toBe(0);
  });

  it("takes no step for what changes nothing", () => {
    const { trial } = setup();
    trial.write([write(6)]);
    trial.write([write(6)]);
    trial.undo();
    expect(trial.count).toBe(0);
    expect(trial.canUndo).toBe(false);
  });

  it("is told apart from the rest of the clip", () => {
    const { trial, store } = setup();
    trial.write([write(6)]);
    const clip = store.getState().timelines["main"]?.clips["c"];
    if (!clip) throw new Error("no clip");
    expect(trial.apply(clip).properties?.["transform.x"]).toBe(6);
    expect(clip.properties).toBeUndefined();
    expect(trial.holds("c", "transform.x")).toBe(true);
    expect(trial.holds("c", "opacity")).toBe(false);
  });

  it("leaves a clip it knows nothing about as it is", () => {
    const { trial, store } = setup();
    const clip = store.getState().timelines["main"]?.clips["c"];
    if (!clip) throw new Error("no clip");
    expect(trial.apply(clip)).toBe(clip);
  });
});

describe("what writing would refuse", () => {
  it("is refused here too, so that nothing gets in that cannot be saved", () => {
    const { trial } = setup();
    const result = trial.write([write(5, "opacity")]);
    expect(result).toMatchObject({ ok: false, error: { code: "invalid-value" } });
    expect(trial.count).toBe(0);
  });

  it("keys on what cannot have them", () => {
    const { trial } = setup();
    const edit: PropertyEdit = { owner, path: "fit", op: "setKey", time: "0", value: "cover" };
    expect(trial.write([edit])).toMatchObject({ ok: false, error: { code: "not-animatable" } });
  });

  it("a clip that is not there", () => {
    const { trial } = setup();
    const edit: PropertyEdit = { owner: { clip: "gone" }, path: "opacity", op: "clear" };
    expect(trial.write([edit])).toMatchObject({ ok: false, error: { code: "not-found" } });
  });

  it("a key that is not there", () => {
    const { trial } = setup();
    const edit: PropertyEdit = { owner, path: "opacity", op: "removeKey", time: "1" };
    expect(trial.write([edit])).toMatchObject({ ok: false, error: { code: "not-found" } });
  });

  it("a locked track", () => {
    const { run, trial, track } = setup();
    run({ type: "track.update", params: { timeline: "main", track, changes: { locked: true } } });
    expect(trial.write([write(1)])).toMatchObject({ ok: false, error: { code: "track-locked" } });
  });

  it("a time that is no time", () => {
    const { trial } = setup();
    const edit = { owner, path: "opacity", op: "setKey", time: "昨天", value: 1 } as PropertyEdit;
    expect(trial.write([edit])).toMatchObject({ ok: false, error: { code: "invalid-params" } });
    expect(trial.count).toBe(0);
  });

  it("is all or nothing for a step", () => {
    const { trial } = setup();
    expect(trial.write([write(1), write(5, "opacity")]).ok).toBe(false);
    expect(trial.count).toBe(0);
    expect(trial.canUndo).toBe(false);
  });
});

describe("undo and redo", () => {
  it("go through what was tried, and the project stays out of it", () => {
    const { store, trial, tried } = setup();
    const { revision } = store;
    const { canUndo } = store;
    trial.write([write(1)]);
    trial.write([write(2)]);
    expect(trial.undo()).toBe(true);
    expect(tried("transform.x")).toBe(1);
    expect(trial.undo()).toBe(true);
    expect(trial.count).toBe(0);
    expect(trial.undo()).toBe(false);
    expect(trial.redo()).toBe(true);
    expect(trial.redo()).toBe(true);
    expect(trial.redo()).toBe(false);
    expect(tried("transform.x")).toBe(2);
    expect(store.revision).toBe(revision);
    expect(store.canUndo).toBe(canUndo);
  });

  it("are one step for one write, however many properties it has", () => {
    const { trial } = setup();
    trial.write([write(1), write(0.5, "opacity")]);
    expect(trial.count).toBe(2);
    trial.undo();
    expect(trial.count).toBe(0);
  });

  it("start over after something new", () => {
    const { trial, tried } = setup();
    trial.write([write(1)]);
    trial.undo();
    trial.write([write(2)]);
    expect(trial.canRedo).toBe(false);
    expect(trial.redo()).toBe(false);
    expect(tried("transform.x")).toBe(2);
  });

  it("start over after people went on in the project too, also with no clip involved", () => {
    const { run, trial } = setup();
    trial.write([write(1)]);
    trial.undo();
    run({ type: "project.rename", params: { name: "别的名字" } });
    expect(trial.canRedo).toBe(false);
  });

  it("keep what is ahead when the project only goes back and forward", () => {
    const { run, store, trial } = setup();
    run({ type: "project.rename", params: { name: "别的名字" } });
    trial.write([write(1)]);
    trial.undo();
    store.undo();
    store.redo();
    expect(trial.canRedo).toBe(true);
  });

  it("keep what is ahead when somebody else goes on", () => {
    const { store, trial } = setup();
    trial.write([write(1)]);
    trial.undo();
    store.execute({ type: "project.rename", params: { name: "改名" } }, { origin: aiTask("t") });
    const { other, arrive } = window(store);
    other.execute({ type: "project.rename", params: { name: "又改名" } });
    arrive();
    expect(trial.canRedo).toBe(true);
  });

  it("go first when that is what people did last", () => {
    const { run, store, trial } = setup();
    run(set(0.3, "opacity"));
    trial.write([write(1)]);
    expect(trial.undoesFirst).toBe(true);
    run(set(0.4, "opacity"));
    expect(trial.undoesFirst).toBe(false);
    store.undo();
    expect(trial.undoesFirst).toBe(true);
    trial.undo();
    expect(trial.undoesFirst).toBe(false);
    expect(trial.redoesFirst).toBe(true);
    trial.redo();
    expect(trial.redoesFirst).toBe(false);
  });

  it("go forward in the opposite order of going back, also past what could not go back", () => {
    const { run, store, trial, track, tried } = setup();
    const clip = {
      id: "d",
      start: "20",
      duration: "1",
      source: { kind: "color", color: "#00ff00" },
    };
    run({ type: "clip.add", params: { timeline: "main", track, clip } });
    const moved = { timeline: "main", clips: [{ clip: "d", start: "22" }] };
    trial.write([write(1)]);
    run({ type: "clip.move", params: moved });
    trial.write([write(2)]);
    run(set(0.5, "opacity"));
    store.execute(
      {
        type: "clip.move",
        params: { timeline: "main", clips: [{ clip: "d", start: "24" }] },
      },
      { origin: aiTask("t") },
    );
    const undo = () => (trial.undoesFirst ? trial.undo() : store.undo());
    const redo = () => (trial.redoesFirst ? trial.redo() : store.redo());
    undo();
    undo();
    expect(tried("transform.x")).toBe(1);
    expect(undo()).toMatchObject({ ok: false, error: { obstacle: "changed" } });
    undo();
    expect(trial.count).toBe(0);
    redo();
    expect(tried("transform.x")).toBe(1);
    redo();
    expect(tried("transform.x")).toBe(2);
    expect(store.canRedo).toBe(true);
    redo();
    expect(store.canRedo).toBe(false);
  });

  it("keep their place after going back and forward past the project", () => {
    const { run, store, trial } = setup();
    run(set(0.3, "opacity"));
    trial.write([write(1)]);
    trial.undo();
    store.undo();
    store.redo();
    trial.redo();
    expect(trial.undoesFirst).toBe(true);
  });

  it("go on with the project when that is all there is left to go forward", () => {
    const { run, store, trial } = setup();
    run(set(0.3, "opacity"));
    run(set(0.4, "opacity"));
    trial.write([write(1)]);
    trial.undo();
    store.undo();
    store.undo();
    expect(trial.redoesFirst).toBe(false);
    run(set(0.2, "opacity"));
    expect(trial.canRedo).toBe(false);
    expect(trial.redoesFirst).toBe(false);
  });

  it("go on here when the project cannot go forward after all", () => {
    const { run, store, trial, tried } = setup();
    run(set(0.3, "opacity"));
    trial.write([write(1)]);
    trial.undo();
    store.undo();
    expect(trial.redoesFirst).toBe(false);
    store.execute(set(0.9, "opacity"), { origin: aiTask("t") });
    expect(store.redo()).toMatchObject({ ok: false, error: { obstacle: "changed" } });
    expect(store.canRedo).toBe(false);
    expect(trial.redoesFirst).toBe(true);
    trial.redo();
    expect(tried("transform.x")).toBe(1);
  });

  it("do not count steps of the project that could not go back as coming after them", () => {
    const { run, store, trial, track } = setup();
    trial.write([write(1)]);
    run(set(0.3, "opacity"));
    const changes = { locked: true };
    store.execute(
      { type: "track.update", params: { timeline: "main", track, changes } },
      { origin: aiTask("t") },
    );
    expect(store.undo()).toMatchObject({ ok: false, error: { obstacle: "locked" } });
    store.execute(
      { type: "track.update", params: { timeline: "main", track, changes: { locked: false } } },
      { origin: aiTask("t") },
    );
    run(set(0.4, "opacity"));
    expect(trial.undoesFirst).toBe(false);
    store.undo();
    expect(trial.undoesFirst).toBe(true);
  });

  describe("past as many steps as the project remembers", () => {
    const steps = (run: (call: CommandCall) => unknown, count: number) => {
      for (let step = 0; step < count; step += 1) run(set(step, "transform.y"));
    };

    it("still go by what people did last", () => {
      const { run, trial } = setup();
      steps(run, 520);
      trial.write([write(1)]);
      expect(trial.undoesFirst).toBe(true);
      run(set(999, "transform.y"));
      expect(trial.undoesFirst).toBe(false);
    });

    it("come at the right place on the way back", () => {
      const { run, store, trial } = setup();
      steps(run, 100);
      trial.write([write(1)]);
      steps(run, 450);
      let before = 0;
      while (!trial.undoesFirst && store.canUndo) {
        store.undo();
        before += 1;
      }
      expect(before).toBe(450);
    });

    it("stay within reach when the project forgot what came before them", () => {
      const { run, store, trial } = setup();
      trial.write([write(1)]);
      steps(run, 510);
      while (store.canUndo) store.undo();
      expect(trial.undoesFirst).toBe(true);
    });
  });

  it("do not bring back what the project holds by now", () => {
    const { run, trial } = setup();
    trial.write([write(1)]);
    trial.write([write(2)]);
    run(set(1));
    trial.undo();
    expect(trial.count).toBe(0);
  });

  it("give up on old steps after a while, and stay usable", () => {
    const { trial } = setup();
    for (let step = 1; step <= 250; step += 1) trial.write([write(step)]);
    let steps = 0;
    while (trial.undo()) steps += 1;
    expect(steps).toBe(200);
  });
});

describe("keys that move and ease", () => {
  const x = { owner, path: "transform.x" };
  const start = (trial: Trial, run: (call: CommandCall) => unknown) => {
    run(set(twoKeys));
    expect(trial.count).toBe(0);
  };

  it("moving keys only reaches what is tried, and goes back and forward as one step", () => {
    const { run, trial, saved, tried } = setup();
    start(trial, run);
    const moves = [
      { from: "0", to: "1" },
      { from: "2", to: "3" },
    ];
    expect(trial.write([{ ...x, op: "moveKey", moves }]).ok).toBe(true);
    expect(tried("transform.x")).toEqual({
      keys: [
        { time: "1", value: 0 },
        { time: "3", value: 2 },
      ],
    });
    expect(saved("transform.x")).toEqual(twoKeys);
    expect(trial.undo()).toBe(true);
    expect(trial.count).toBe(0);
    expect(trial.canUndo).toBe(false);
    expect(trial.redo()).toBe(true);
    expect(tried("transform.x")).toMatchObject({ keys: [{ time: "1" }, { time: "3" }] });
  });

  it("how keys go on works the same way, and saving is one step of the project", () => {
    const { run, store, trial, saved, tried } = setup();
    start(trial, run);
    const ease: KeyEase = { interp: "bezier", out: [0.42, 0], in: [0.58, 1] };
    expect(trial.write([{ ...x, op: "setInterp", times: ["0"], ease }]).ok).toBe(true);
    expect(tried("transform.x")).toEqual({
      keys: [
        { time: "0", value: 0, interp: "bezier", out: [0.42, 0] },
        { time: "2", value: 2, in: [0.58, 1] },
      ],
    });
    expect(trial.write([{ ...x, op: "moveKey", moves: [{ from: "2", to: "4" }] }]).ok).toBe(true);
    expect(trial.save().ok).toBe(true);
    expect(saved("transform.x")).toEqual({
      keys: [
        { time: "0", value: 0, interp: "bezier", out: [0.42, 0] },
        { time: "4", value: 2, in: [0.58, 1] },
      ],
    });
    store.undo();
    expect(saved("transform.x")).toEqual(twoKeys);
  });

  it("refuses what a command would refuse, and keeps what was there", () => {
    const { run, trial, tried } = setup();
    start(trial, run);
    const gone = trial.write([{ ...x, op: "moveKey", moves: [{ from: "7", to: "8" }] }]);
    expect(gone.ok).toBe(false);
    const twice = trial.write([
      {
        ...x,
        op: "moveKey",
        moves: [
          { from: "0", to: "5" },
          { from: "2", to: "5" },
        ],
      },
    ]);
    expect(twice.ok).toBe(false);
    expect(tried("transform.x")).toBeUndefined();
    expect(trial.canUndo).toBe(false);
  });

  it("moving keys that end up where they were counts as nothing", () => {
    const { run, trial } = setup();
    start(trial, run);
    trial.write([{ ...x, op: "moveKey", moves: [{ from: "2", to: "3" }] }]);
    trial.write([{ ...x, op: "moveKey", moves: [{ from: "3", to: "2" }] }]);
    expect(trial.count).toBe(0);
  });

  it("keys put in with their easing come out when it is saved", () => {
    const { run, trial, saved } = setup();
    start(trial, run);
    const keys = [{ time: "5", value: 7, interp: "hold" as const }];
    expect(trial.write([{ ...x, op: "putKeys", keys }]).ok).toBe(true);
    expect(trial.save().ok).toBe(true);
    expect(saved("transform.x")).toMatchObject({
      keys: [{ time: "0" }, { time: "2" }, { time: "5", value: 7, interp: "hold" }],
    });
  });

  it("the keys of a clip that moves its clock take what is tried with them", () => {
    const { run, trial, tried } = setup();
    start(trial, run);
    trial.write([{ ...x, op: "moveKey", moves: [{ from: "2", to: "3" }] }]);
    run({ type: "clip.trim", params: { timeline: "main", clip: "c", start: "1" } });
    expect(tried("transform.x")).toMatchObject({ keys: [{ time: "1" }, { time: "4" }] });
  });
});

describe("giving up", () => {
  it("goes back to what the project holds", () => {
    const { trial } = setup();
    trial.write([write(1), write(0.5, "opacity")]);
    trial.discard();
    expect(trial.count).toBe(0);
  });

  it("can be about one property", () => {
    const { trial, tried } = setup();
    trial.write([write(1), write(0.5, "opacity")]);
    trial.discard({ clip: "c", path: "opacity" });
    expect(trial.holds("c", "opacity")).toBe(false);
    expect(tried("transform.x")).toBe(1);
  });

  it("can be taken back, because it can be a slip", () => {
    const { trial, tried } = setup();
    trial.write([write(1), write(0.5, "opacity")]);
    trial.discard();
    trial.undo();
    expect(trial.count).toBe(2);
    trial.discard({ clip: "c", path: "opacity" });
    trial.undo();
    expect(tried("opacity")).toBe(0.5);
  });

  it("takes no step when there is nothing to give up", () => {
    const { trial } = setup();
    trial.discard();
    trial.discard({ clip: "c", path: "opacity" });
    expect(trial.canUndo).toBe(false);
  });
});

describe("saving", () => {
  it("is one command and one step to undo, whatever it took to get there", () => {
    const { store, trial, saved } = setup();
    trial.write([write(1)]);
    trial.write([write(2)]);
    trial.write([write(0.5, "opacity")]);
    const before = store.history.length;
    const depth = store.lastStep;
    expect(trial.save()).toEqual({ ok: true, saved: 2, overwritten: 0 });
    expect(store.history).toHaveLength(before + 1);
    expect(store.history.at(-1)?.commands).toEqual(["property.edit"]);
    expect(store.lastStep).toBe(depth + 1);
    expect(saved("transform.x")).toBe(2);
    expect(saved("opacity")).toBe(0.5);
    store.undo();
    expect(saved("transform.x")).toBeUndefined();
    expect(saved("opacity")).toBeUndefined();
  });

  it("leaves nothing to try, and nothing to go back to", () => {
    const { trial } = setup();
    trial.write([write(1)]);
    trial.write([write(2)]);
    trial.write([write(3)]);
    trial.undo();
    trial.save();
    expect(trial.count).toBe(0);
    expect(trial.canUndo).toBe(false);
    expect(trial.canRedo).toBe(false);
  });

  it("is over, also when the project goes on with a part that never arrived", () => {
    const { store, trial, saved } = setup();
    const doc = new Y.Doc();
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(store.doc));
    const other = new ProjectStore(doc);
    const updates: Uint8Array[] = [];
    doc.on("update", (update: Uint8Array) => updates.push(update));
    other.execute({ type: "project.rename", params: { name: "一" } });
    other.execute({ type: "project.rename", params: { name: "二" } });
    store.applyUpdates(updates.slice(1));
    store.catchUp([]);
    expect(store.isMissingUpdates).toBe(true);
    trial.write([write(1)]);
    expect(trial.save()).toMatchObject({ ok: true, saved: 1 });
    expect(saved("transform.x")).toBe(1);
    expect(trial.count).toBe(0);
  });

  it("takes a property away that was taken away", () => {
    const { run, trial, saved } = setup();
    run(set(5));
    trial.write([{ owner, path: "transform.x", op: "clear" }]);
    trial.save();
    expect(saved("transform.x")).toBeUndefined();
  });

  it("writes keys the way writing them one by one does", () => {
    const { run, trial, saved } = setup();
    run(set(twoKeys));
    trial.write([write(9)]);
    trial.save();
    expect(saved("transform.x")).toEqual({
      keys: [
        { time: "0", value: 0 },
        { time: "1", value: 9 },
        { time: "2", value: 2 },
      ],
    });
  });

  it("with nothing to save changes nothing", () => {
    const { store, trial } = setup();
    const { revision } = store;
    expect(trial.save()).toEqual({ ok: true, saved: 0, overwritten: 0 });
    expect(store.revision).toBe(revision);
  });

  it("keeps everything when it fails", () => {
    const { run, trial, track, tried } = setup();
    trial.write([write(1)]);
    run({ type: "track.update", params: { timeline: "main", track, changes: { locked: true } } });
    expect(trial.save()).toMatchObject({ ok: false, error: { code: "track-locked" } });
    expect(tried("transform.x")).toBe(1);
    expect(trial.canUndo).toBe(true);
  });

  it("goes through several clips in one step", () => {
    const { run, store, trial, track, saved } = setup();
    const clip = {
      id: "d",
      start: "20",
      duration: "1",
      source: { kind: "color", color: "#00ff00" },
    };
    run({ type: "clip.add", params: { timeline: "main", track, clip } });
    trial.write([write(1), { owner: { clip: "d" }, path: "opacity", op: "set", value: 0.5 }]);
    trial.save();
    expect(saved("transform.x")).toBe(1);
    expect(saved("opacity", "d")).toBe(0.5);
    store.undo();
    expect(saved("transform.x")).toBeUndefined();
    expect(saved("opacity", "d")).toBeUndefined();
  });
});

describe("cutting a clip", () => {
  const cut = (at = "5", id = "right"): CommandCall => ({
    type: "clip.split",
    params: { timeline: "main", clip: "c", at, id },
  });

  it("takes what is being tried to both parts", () => {
    const { run, trial, tried } = setup();
    trial.write([write(1), write(0.5, "opacity")]);
    run(cut());
    expect(tried("transform.x", "right")).toBe(1);
    expect(tried("opacity", "right")).toBe(0.5);
    expect(tried("transform.x")).toBe(1);
    expect(trial.count).toBe(4);
  });

  it("leaves the parts on their own from then on", () => {
    const { run, trial, tried } = setup();
    trial.write([write(1)]);
    run(cut());
    trial.write([{ owner: { clip: "right" }, path: "transform.x", op: "set", value: 2 }]);
    expect(tried("transform.x")).toBe(1);
    expect(tried("transform.x", "right")).toBe(2);
  });

  it("does not go for steps from before: they stay about the clip they were about", () => {
    const { run, trial, tried } = setup();
    trial.write([write(1)]);
    trial.write([write(2)]);
    run(cut());
    trial.undo();
    expect(tried("transform.x")).toBe(1);
    expect(tried("transform.x", "right")).toBe(2);
  });

  it("is a change here even when the same thing happens to come back from elsewhere", () => {
    const { run, store, trial, tried } = setup();
    trial.write([write(1)]);
    run(cut());
    store.undo();
    expect(trial.changes.has("right")).toBe(false);
    expect(tried("transform.x")).toBe(1);
  });

  it("does not mix up what is saved: both parts save what was tried", () => {
    const { run, trial, saved } = setup();
    trial.write([write(1)]);
    run(cut());
    trial.save();
    expect(saved("transform.x")).toBe(1);
    expect(saved("transform.x", "right")).toBe(1);
  });

  it("works however a clip gets cut, also by overwriting the middle of it", () => {
    const { run, trial, track, main } = setup();
    trial.write([write(1)]);
    const clip = {
      id: "d",
      start: "20",
      duration: "1",
      source: { kind: "color", color: "#00ff00" },
    };
    run({ type: "clip.add", params: { timeline: "main", track, clip } });
    run({
      type: "clip.move",
      params: { timeline: "main", clips: [{ clip: "d", start: "4" }], overlap: "overwrite" },
    });
    const right = Object.keys(main()?.clips ?? {}).find((id) => id !== "c" && id !== "d");
    expect(right).toBeDefined();
    expect(trial.holds(right as string, "transform.x")).toBe(true);
  });

  it("works when it happens in another window", () => {
    const { store, trial, tried, heard } = setup();
    trial.write([write(1)]);
    const { other, arrive } = window(store);
    expect(other.execute(cut()).ok).toBe(true);
    arrive();
    expect(tried("transform.x", "right")).toBe(1);
    expect(heard).toEqual([]);
  });

  it("takes keys along, on the clock they are on", () => {
    const { run, trial, tried } = setup();
    trial.write([{ owner, path: "transform.x", op: "setKey", time: "1", value: 7 }]);
    run(cut());
    expect(tried("transform.x", "right")).toEqual({ keys: [{ time: "1", value: 7 }] });
  });

  it("is not what copying a clip does", () => {
    const { run, trial, track } = setup();
    trial.write([write(1)]);
    const copy = {
      id: "copy",
      start: "30",
      duration: "6",
      source: { kind: "color", color: "#ff0000" },
    };
    run({ type: "clip.add", params: { timeline: "main", track, clip: copy } });
    expect(trial.changes.has("copy")).toBe(false);
  });

  it("is not what trimming a clip and adding one behind it does", () => {
    const { run, trial, track } = setup();
    trial.write([write(1)]);
    run({ type: "clip.trim", params: { timeline: "main", clip: "c", end: "5" } });
    const other = {
      id: "other",
      start: "5",
      duration: "1",
      source: { kind: "color", color: "#00ff00" },
    };
    run({ type: "clip.add", params: { timeline: "main", track, clip: other } });
    expect(trial.changes.has("other")).toBe(false);
  });

  describe("that arrives from elsewhere, which is told from what only looks like it", () => {
    const red = { kind: "color", color: "#ff0000" };

    /** What a cut does to the document, in another window, in one change. */
    function shortenAndAdd(clip: object, track?: string) {
      const context = setup();
      context.trial.write([write(1)]);
      const { other, arrive } = window(context.store);
      const add = { id: "new", source: red, ...clip };
      const result = other.executeBatch([
        { type: "clip.trim", params: { timeline: "main", clip: "c", end: "5" } },
        {
          type: "clip.add",
          params: { timeline: "main", track: track ?? context.track, clip: add },
        },
      ]);
      expect(result.ok).toBe(true);
      arrive();
      return context;
    }

    it("which it is when all of it fits", () => {
      const { trial, heard } = shortenAndAdd({ start: "5", duration: "3", offset: "3" });
      expect(trial.changes.has("new")).toBe(true);
      expect(heard).toEqual([]);
    });

    it("not when the new clip runs on another clock, which is reported", () => {
      const { trial, heard } = shortenAndAdd({ start: "5", duration: "3" });
      expect(trial.changes.has("new")).toBe(false);
      expect(heard).toEqual([{ kind: "unsure" }]);
    });

    it("not when it starts where the clip started: a cut leaves the first part on the clip", () => {
      const { store, trial, track, heard } = setup();
      trial.write([write(1)]);
      const { other, arrive } = window(store);
      const add = { id: "new", start: "2", duration: "2", source: red };
      const result = other.executeBatch([
        { type: "clip.trim", params: { timeline: "main", clip: "c", start: "4" } },
        { type: "clip.add", params: { timeline: "main", track, clip: add } },
      ]);
      expect(result.ok).toBe(true);
      arrive();
      expect(trial.changes.has("new")).toBe(false);
      expect(trial.holds("c", "transform.x")).toBe(true);
      expect(heard).toEqual([]);
    });

    it("not when the clip stays as long as it was, and nobody has to hear about that", () => {
      const { store, trial, track, heard } = setup();
      trial.write([write(1)]);
      const { other, arrive } = window(store);
      const add = { id: "new", start: "20", duration: "1", source: red };
      const moved = { timeline: "main", clips: [{ clip: "c", start: "3" }] };
      const result = other.executeBatch([
        { type: "clip.move", params: moved },
        { type: "clip.add", params: { timeline: "main", track, clip: add } },
      ]);
      expect(result.ok).toBe(true);
      arrive();
      expect(trial.changes.has("new")).toBe(false);
      expect(heard).toEqual([]);
    });

    it("not when it shows something else, and nobody has to hear about that", () => {
      const green = { kind: "color", color: "#00ff00" };
      const clip = { start: "5", duration: "3", offset: "3", source: green };
      const { trial, heard } = shortenAndAdd(clip);
      expect(trial.changes.has("new")).toBe(false);
      expect(heard).toEqual([]);
    });

    it("not when it lies outside of what the clip gave up, which is reported", () => {
      const { trial, heard } = shortenAndAdd({ start: "20", duration: "3", offset: "18" });
      expect(trial.changes.has("new")).toBe(false);
      expect(heard).toEqual([{ kind: "unsure" }]);
    });

    it("not when it is on another track, which is reported", () => {
      const context = setup();
      context.trial.write([write(1)]);
      context.run({
        type: "track.add",
        params: { timeline: "main", kind: "video", id: "other" },
      });
      const { other, arrive } = window(context.store);
      other.executeBatch([
        { type: "clip.trim", params: { timeline: "main", clip: "c", end: "5" } },
        {
          type: "clip.add",
          params: {
            timeline: "main",
            track: "other",
            clip: { id: "new", start: "5", duration: "3", offset: "3", source: red },
          },
        },
      ]);
      arrive();
      expect(context.trial.changes.has("new")).toBe(false);
      expect(context.heard).toEqual([{ kind: "unsure" }]);
    });

    it("not when the part already moved on in the same update, which is reported", () => {
      const { store, trial, tried, heard } = setup();
      trial.write([write(1)]);
      const { other, arrive } = window(store);
      other.execute(cut());
      other.execute({
        type: "clip.move",
        params: { timeline: "main", clips: [{ clip: "right", start: "20" }] },
      });
      arrive();
      expect(tried("transform.x")).toBe(1);
      expect(trial.changes.has("right")).toBe(false);
      expect(heard).toEqual([{ kind: "unsure" }]);
    });

    it("and here nobody guesses: a clip that gets shorter and one that gets added are that", () => {
      const { store, trial, track, heard } = setup();
      trial.write([write(1)]);
      const clip = { id: "new", start: "5", duration: "3", offset: "3", source: red };
      store.executeBatch([
        { type: "clip.trim", params: { timeline: "main", clip: "c", end: "5" } },
        { type: "clip.add", params: { timeline: "main", track, clip } },
      ]);
      expect(trial.changes.has("new")).toBe(false);
      expect(heard).toEqual([]);
    });
  });

  it("and taking it back in another window sets aside what the part has, like any clip", () => {
    const { store, trial, heard } = setup();
    trial.write([write(1)]);
    const { other, arrive } = window(store);
    other.execute({
      type: "clip.split",
      params: { timeline: "main", clip: "c", at: "5", id: "r" },
    });
    arrive();
    expect(trial.count).toBe(2);
    other.undo();
    arrive();
    expect(trial.count).toBe(1);
    expect(trial.setAside).toBe(1);
    expect(heard).toEqual([{ kind: "aside", count: 1 }]);
    other.redo();
    arrive();
    expect(trial.count).toBe(2);
    expect(trial.setAside).toBe(0);
  });

  it("and taking the cut back says nothing, because the clip still has it all", () => {
    const { run, store, trial, tried, heard } = setup();
    trial.write([write(1)]);
    run(cut());
    store.undo();
    expect(trial.changes.has("right")).toBe(false);
    expect(trial.setAside).toBe(0);
    expect(tried("transform.x")).toBe(1);
    expect(heard).toEqual([]);
  });

  it("and doing it again brings it to both parts again", () => {
    const { run, store, trial, tried } = setup();
    trial.write([write(1)]);
    run(cut());
    store.undo();
    store.redo();
    expect(tried("transform.x", "right")).toBe(1);
  });

  it("and taking the cut back sets aside what the part that goes had on its own", () => {
    const { run, store, trial, heard } = setup();
    trial.write([write(1)]);
    run(cut());
    trial.write([{ owner: { clip: "right" }, path: "transform.x", op: "set", value: 2 }]);
    store.undo();
    expect(trial.count).toBe(1);
    expect(trial.setAside).toBe(1);
    expect(heard).toEqual([{ kind: "aside", count: 1 }]);
  });

  it("and doing it again brings that back, on top of what the clip gives both parts", () => {
    const { run, store, trial, tried } = setup();
    trial.write([write(1), write(0.5, "opacity")]);
    run(cut());
    trial.write([{ owner: { clip: "right" }, path: "transform.x", op: "set", value: 2 }]);
    store.undo();
    store.redo();
    expect(tried("transform.x", "right")).toBe(2);
    expect(tried("opacity", "right")).toBe(0.5);
  });
});

describe("deleting a clip", () => {
  const remove: CommandCall = { type: "clip.remove", params: { timeline: "main", clips: ["c"] } };
  const second = {
    id: "d",
    start: "20",
    duration: "1",
    source: { kind: "color", color: "#00ff00" },
  };

  it("sets aside what was tried on it, and says how much that is", () => {
    const { run, trial, heard } = setup();
    trial.write([write(1), write(0.5, "opacity")]);
    run(remove);
    expect(trial.count).toBe(0);
    expect(trial.changes.size).toBe(0);
    expect(trial.setAside).toBe(2);
    expect(heard).toEqual([{ kind: "aside", count: 2 }]);
  });

  it("brings it all back when the clip comes back, and says so", () => {
    const { run, store, trial, tried, heard } = setup();
    trial.write([write(1), write(0.5, "opacity")]);
    run(remove);
    store.undo();
    expect(trial.count).toBe(2);
    expect(trial.setAside).toBe(0);
    expect(tried("transform.x")).toBe(1);
    expect(heard.at(-1)).toEqual({ kind: "back", count: 2 });
  });

  it("leaves other clips as they are", () => {
    const { run, trial, track, tried } = setup();
    run({ type: "clip.add", params: { timeline: "main", track, clip: second } });
    trial.write([{ owner: { clip: "d" }, path: "opacity", op: "set", value: 0.5 }, write(1)]);
    run(remove);
    expect(tried("opacity", "d")).toBe(0.5);
    expect(trial.count).toBe(1);
    expect(trial.setAside).toBe(1);
  });

  it("keeps it out of what gets saved, and it is still there afterwards", () => {
    const { run, store, trial, track, saved, tried } = setup();
    run({ type: "clip.add", params: { timeline: "main", track, clip: second } });
    trial.write([{ owner: { clip: "d" }, path: "opacity", op: "set", value: 0.5 }, write(1)]);
    run(remove);
    expect(trial.save()).toEqual({ ok: true, saved: 1, overwritten: 0 });
    expect(saved("opacity", "d")).toBe(0.5);
    expect(trial.setAside).toBe(1);
    store.undo();
    store.undo();
    expect(tried("transform.x")).toBe(1);
  });

  it("gives up on it along with everything else, and that can be taken back as well", () => {
    const { run, store, trial, tried } = setup();
    trial.write([write(1)]);
    run(remove);
    trial.discard();
    expect(trial.setAside).toBe(0);
    store.undo();
    expect(trial.count).toBe(0);
    store.redo();
    trial.undo();
    expect(trial.setAside).toBe(1);
    store.undo();
    expect(tried("transform.x")).toBe(1);
  });

  it("says nothing when nothing was tried on it", () => {
    const { run, heard } = setup();
    run(remove);
    expect(heard).toEqual([]);
  });

  it("goes the same way for the track it is on", () => {
    const { run, store, trial, track, tried, heard } = setup();
    trial.write([write(1)]);
    run({ type: "track.remove", params: { timeline: "main", track } });
    expect(trial.setAside).toBe(1);
    expect(heard).toEqual([{ kind: "aside", count: 1 }]);
    store.undo();
    expect(tried("transform.x")).toBe(1);
  });

  it("goes the same way when something else takes its place", () => {
    const { run, store, trial, track, tried } = setup();
    trial.write([write(1)]);
    run({ type: "clip.add", params: { timeline: "main", track, clip: second } });
    const clips = [{ clip: "d", start: "1" }];
    run({
      type: "clip.update",
      params: { timeline: "main", clip: "d", changes: { duration: "9" } },
    });
    run({ type: "clip.move", params: { timeline: "main", clips, overlap: "overwrite" } });
    expect(trial.count).toBe(0);
    expect(trial.setAside).toBe(1);
    store.undo();
    expect(tried("transform.x")).toBe(1);
  });

  it("goes the same way when another window does it, and takes it back", () => {
    const { store, trial, tried, heard } = setup();
    trial.write([write(1)]);
    const { other, arrive } = window(store);
    other.execute(remove);
    arrive();
    expect(trial.count).toBe(0);
    expect(trial.setAside).toBe(1);
    expect(heard).toEqual([{ kind: "aside", count: 1 }]);
    other.undo();
    arrive();
    expect(tried("transform.x")).toBe(1);
  });

  it("keeps steps working on what is set aside, for when the clip comes back", () => {
    const { store, trial, tried } = setup();
    trial.write([write(1)]);
    trial.write([write(2)]);
    const { other, arrive } = window(store);
    other.execute(remove);
    arrive();
    trial.undo();
    expect(trial.count).toBe(0);
    other.undo();
    arrive();
    expect(tried("transform.x")).toBe(1);
    trial.redo();
    expect(tried("transform.x")).toBe(2);
  });

  it("has a limit, where what has waited longest goes, and people get to hear about it", () => {
    const { run, trial, track, heard } = setup();
    const clip = (index: number) => ({
      id: `many${index}`,
      start: String(100 + index),
      duration: "1",
      source: { kind: "color", color: "#00ff00" },
    });
    const clips = Array.from({ length: 205 }, (_, index) => clip(index));
    for (const one of clips) {
      run({ type: "clip.add", params: { timeline: "main", track, clip: one } });
    }
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const half = (id: string) => ({
      owner: { clip: id },
      path: "opacity",
      op: "set" as const,
      value: 0.5,
    });
    trial.write(clips.slice(0, 5).map(({ id }) => half(id)));
    run({
      type: "clip.remove",
      params: { timeline: "main", clips: clips.slice(0, 5).map(({ id }) => id) },
    });
    vi.setSystemTime(2000);
    trial.write(clips.slice(5).map(({ id }) => half(id)));
    run({
      type: "clip.remove",
      params: { timeline: "main", clips: clips.slice(5).map(({ id }) => id) },
    });
    vi.useRealTimers();
    expect(trial.setAside).toBe(200);
    expect(heard.at(-1)).toEqual({ kind: "dropped", count: 5 });
    expect(trial.kept.has("many0")).toBe(false);
    expect(trial.kept.has("many5")).toBe(true);
  });

  it("starts waiting all over when it goes away again", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const { run, store, trial } = setup();
    trial.write([write(1)]);
    run(remove);
    expect(trial.kept.get("c")?.get("transform.x")?.asideSince).toBe(1000);
    store.undo();
    expect(trial.kept.get("c")?.get("transform.x")?.asideSince).toBeUndefined();
    vi.setSystemTime(2000);
    run(remove);
    vi.useRealTimers();
    expect(trial.kept.get("c")?.get("transform.x")?.asideSince).toBe(2000);
  });

  it("has that limit for what comes back from the device as well", () => {
    const { trial, heard } = setup();
    const changes = Array.from({ length: 201 }, (_, index) => ({
      clip: `gone${index}`,
      path: "opacity",
      value: 0.5,
      asideSince: Date.now() - 1000 + index,
    }));
    trial.restore({ version: 1, timeline: "main", changes });
    expect(trial.setAside).toBe(200);
    expect(heard).toEqual([{ kind: "dropped", count: 1 }]);
    expect(trial.kept.has("gone0")).toBe(false);
    expect(trial.kept.has("gone1")).toBe(true);
  });

  describe("while an update is missing", () => {
    /** A change that needs an earlier one, which has not arrived. Returns how to deliver that. */
    function withHoles() {
      const context = setup();
      context.trial.write([write(1)]);
      const other = new Y.Doc();
      Y.applyUpdate(other, Y.encodeStateAsUpdate(context.store.doc));
      const replica = new ProjectStore(other);
      const updates: Uint8Array[] = [];
      other.on("update", (update: Uint8Array) => updates.push(update));
      replica.execute({
        type: "clip.update",
        params: { timeline: "main", clip: "c", changes: { name: "一" } },
      });
      replica.execute(remove);
      context.store.applyUpdates(updates.slice(1));
      expect(context.store.isMissingUpdates).toBe(true);
      return { ...context, deliver: () => context.store.applyUpdates(updates.slice(0, 1)) };
    }

    it("the clip is only out of sight, so what is tried on it stays", () => {
      const { tried, heard } = withHoles();
      expect(tried("transform.x")).toBe(1);
      expect(heard).toEqual([]);
    });

    it("nothing gets written, also not what is tried, and it all stays", () => {
      const { trial, tried } = withHoles();
      expect(trial.write([write(2)])).toMatchObject({
        ok: false,
        error: { code: "missing-updates" },
      });
      expect(trial.save()).toMatchObject({ ok: false, error: { code: "missing-updates" } });
      expect(tried("transform.x")).toBe(1);
    });

    it("the clip goes when the update arrives", () => {
      const { trial, heard, deliver } = withHoles();
      deliver();
      expect(trial.count).toBe(0);
      expect(heard).toEqual([{ kind: "aside", count: 1 }]);
    });

    it("the clip goes when it is clear that the update will never arrive", () => {
      const { store, trial, heard } = withHoles();
      store.catchUp([]);
      expect(store.isMissingUpdates).toBe(true);
      expect(trial.count).toBe(0);
      expect(heard).toEqual([{ kind: "aside", count: 1 }]);
    });

    it("cutting is followed again after the project went on without the update", () => {
      const { store, run, trial, tried, track } = withHoles();
      store.catchUp([]);
      const clip = {
        id: "d",
        start: "20",
        duration: "6",
        source: { kind: "color", color: "#0000ff" },
      };
      run({ type: "clip.add", params: { timeline: "main", track, clip } });
      trial.write([{ owner: { clip: "d" }, path: "opacity", op: "set", value: 0.5 }]);
      run({ type: "clip.split", params: { timeline: "main", clip: "d", at: "22", id: "e" } });
      expect(tried("opacity", "e")).toBe(0.5);
    });
  });
});

describe("other structural changes", () => {
  it("moving a clip leaves what is tried on it as it is, because keys go with the clip", () => {
    const { run, trial, tried } = setup();
    trial.write([{ owner, path: "transform.x", op: "setKey", time: "1", value: 7 }]);
    run({ type: "clip.move", params: { timeline: "main", clips: [{ clip: "c", start: "30" }] } });
    expect(tried("transform.x")).toEqual({ keys: [{ time: "1", value: 7 }] });
  });

  it("trimming leaves keys where they are, like it does in the project", () => {
    const { run, trial, tried } = setup();
    trial.write([{ owner, path: "transform.x", op: "setKey", time: "1", value: 7 }]);
    run({ type: "clip.trim", params: { timeline: "main", clip: "c", start: "3" } });
    expect(tried("transform.x")).toEqual({ keys: [{ time: "1", value: 7 }] });
  });

  it("growing past the start of the clock moves keys along, like it does in the project", () => {
    const { run, trial, tried, saved } = setup();
    run(set({ keys: [{ time: "1", value: 1 }] }, "opacity"));
    trial.write([{ owner, path: "transform.x", op: "setKey", time: "1", value: 7 }]);
    trial.write([{ owner, path: "opacity", op: "setKey", time: "2", value: 0.5 }]);
    run({ type: "clip.trim", params: { timeline: "main", clip: "c", start: "1" } });
    expect(saved("opacity")).toEqual({ keys: [{ time: "2", value: 1 }] });
    expect(tried("transform.x")).toEqual({ keys: [{ time: "2", value: 7 }] });
    expect(tried("opacity")).toEqual({
      keys: [
        { time: "2", value: 1 },
        { time: "3", value: 0.5 },
      ],
    });
    expect(trial.conflicts).toBe(0);
  });

  it("taking that back moves them back", () => {
    const { run, store, trial, tried } = setup();
    trial.write([{ owner, path: "transform.x", op: "setKey", time: "1", value: 7 }]);
    run({ type: "clip.trim", params: { timeline: "main", clip: "c", start: "1" } });
    store.undo();
    expect(tried("transform.x")).toEqual({ keys: [{ time: "1", value: 7 }] });
  });

  it("does the same when both ends of the clip change at once", () => {
    const { run, trial, tried, saved } = setup();
    run(set({ keys: [{ time: "1", value: 1 }] }, "opacity"));
    trial.write([{ owner, path: "transform.x", op: "setKey", time: "1", value: 7 }]);
    run({ type: "clip.trim", params: { timeline: "main", clip: "c", start: "1", end: "9" } });
    expect(saved("opacity")).toEqual({ keys: [{ time: "2", value: 1 }] });
    expect(tried("transform.x")).toEqual({ keys: [{ time: "2", value: 7 }] });
    expect(trial.conflicts).toBe(0);
  });

  it("does not take a new start for a clock that moved: that leaves keys alone in the project", () => {
    const { run, trial, tried, saved, heard } = setup();
    run(set({ keys: [{ time: "1", value: 1 }] }, "opacity"));
    trial.write([{ owner, path: "transform.x", op: "setKey", time: "1", value: 7 }]);
    const changes = { start: "1", duration: "7" };
    run({ type: "clip.update", params: { timeline: "main", clip: "c", changes } });
    expect(saved("opacity")).toEqual({ keys: [{ time: "1", value: 1 }] });
    expect(tried("transform.x")).toEqual({ keys: [{ time: "1", value: 7 }] });
    expect(heard).toEqual([]);
  });

  it("has nothing to do with the transitions of a clip, which are no properties", () => {
    const { store, run, trial, tried, heard, main } = setup();
    trial.write([{ owner, path: "transform.x", op: "setKey", time: "1", value: 7 }]);
    const fade = (duration: string) => ({ type: "fade", duration });
    const transition = (changes: object) =>
      run({ type: "clip.setTransition", params: { timeline: "main", clip: "c", ...changes } });
    transition({ enter: fade("1"), exit: fade("2") });
    run({ type: "clip.trim", params: { timeline: "main", clip: "c", end: "4.5" } });
    expect(main()?.clips["c"]?.exit).toEqual(fade("1.5"));
    transition({ enter: null });
    store.undo();
    store.undo();
    expect(main()?.clips["c"]?.exit).toEqual(fade("2"));
    expect(tried("transform.x")).toEqual({ keys: [{ time: "1", value: 7 }] });
    expect(trial.count).toBe(1);
    expect(heard).toEqual([]);
  });

  it("does not take moving a clip and giving it another length for that", () => {
    const { run, trial, tried } = setup();
    trial.write([{ owner, path: "transform.x", op: "setKey", time: "1", value: 7 }]);
    run({
      type: "clip.update",
      params: { timeline: "main", clip: "c", changes: { start: "1", duration: "3" } },
    });
    expect(tried("transform.x")).toEqual({ keys: [{ time: "1", value: 7 }] });
  });

  describe("from elsewhere", () => {
    const key = (time: string, value: number, path = "transform.x"): PropertyEdit => ({
      owner,
      path,
      op: "setKey",
      time,
      value,
    });

    describe("when only the keys of the clip moved", () => {
      /** Somebody moved the keys of a saved property, and the clip stayed where it was. */
      function keysMoved(from: string, to: string) {
        const context = setup();
        context.run(set({ keys: [{ time: from, value: 1 }] }, "opacity"));
        return {
          ...context,
          move: () => {
            const { other, arrive } = window(context.store);
            other.execute(set({ keys: [{ time: to, value: 1 }] }, "opacity"));
            arrive();
          },
        };
      }

      it("leaves what is tried on another property as it is, and saves that", () => {
        const { trial, tried, heard, saved, move } = keysMoved("1", "2");
        trial.write([key("1", 7), key("3", 8)]);
        const shown = tried("transform.x");
        move();
        expect(tried("transform.x")).toEqual(shown);
        expect(heard).toEqual([]);
        trial.save();
        expect(saved("transform.x")).toEqual(shown);
      });

      it("marks the same property as changed by somebody else", () => {
        const { trial, tried, move } = keysMoved("1", "2");
        trial.write([key("3", 0.5, "opacity")]);
        const shown = tried("opacity");
        move();
        expect(tried("opacity")).toEqual(shown);
        expect(trial.conflicts).toBe(1);
      });

      it("does not take what is tried out of sight when they went earlier", () => {
        const { trial, tried, heard, move } = keysMoved("2", "0.5");
        trial.write([key("1", 7)]);
        move();
        expect(trial.count).toBe(1);
        expect(trial.setAside).toBe(0);
        expect(tried("transform.x")).toEqual({ keys: [{ time: "1", value: 7 }] });
        expect(heard).toEqual([]);
      });

      it("raises no alarm when other keys stayed", () => {
        const { run, trial, heard, move } = keysMoved("1", "2");
        run(set({ keys: [{ time: "1", value: 1 }] }, "transform.y"));
        trial.write([key("1", 7)]);
        move();
        expect(heard).toEqual([]);
      });
    });

    it.each([
      [
        "start",
        { type: "clip.move", params: { timeline: "main", clips: [{ clip: "c", start: "3" }] } },
      ],
      ["end", { type: "clip.trim", params: { timeline: "main", clip: "c", end: "7" } }],
      [
        "offset",
        { type: "clip.update", params: { timeline: "main", clip: "c", changes: { offset: "1" } } },
      ],
    ])("goes by the keys when the %s of the clip changed with them", (_, change) => {
      const { run, store, trial, tried } = setup();
      run(set({ keys: [{ time: "1", value: 1 }] }, "opacity"));
      trial.write([key("1", 7)]);
      const { other, arrive } = window(store);
      other.executeBatch([change, set({ keys: [{ time: "2", value: 1 }] }, "opacity")]);
      arrive();
      expect(tried("transform.x")).toEqual({ keys: [{ time: "2", value: 7 }] });
    });

    it("goes by the keys of the clip, also when more happened in the same update", () => {
      const { run, store, trial, tried, heard } = setup();
      run(set({ keys: [{ time: "1", value: 1 }] }, "opacity"));
      trial.write([key("3", 0.5, "opacity"), key("1", 7)]);
      const { other, arrive } = window(store);
      other.execute({ type: "clip.trim", params: { timeline: "main", clip: "c", start: "1" } });
      other.execute({
        type: "clip.move",
        params: { timeline: "main", clips: [{ clip: "c", start: "30" }] },
      });
      arrive();
      expect(tried("transform.x")).toEqual({ keys: [{ time: "2", value: 7 }] });
      expect(trial.conflicts).toBe(0);
      expect(heard).toEqual([]);
    });

    it("leaves keys where they are when the keys of the clip stayed", () => {
      const { run, store, trial, tried, heard } = setup();
      run(set({ keys: [{ time: "1", value: 1 }] }, "opacity"));
      trial.write([key("1", 7)]);
      const { other, arrive } = window(store);
      const changes = { start: "1", duration: "7" };
      other.execute({ type: "clip.update", params: { timeline: "main", clip: "c", changes } });
      arrive();
      expect(tried("transform.x")).toEqual({ keys: [{ time: "1", value: 7 }] });
      expect(heard).toEqual([]);
    });

    it("moves nothing and says so when there are no keys to go by", () => {
      const { store, trial, tried, heard } = setup();
      trial.write([key("1", 7)]);
      const { other, arrive } = window(store);
      other.execute({ type: "clip.trim", params: { timeline: "main", clip: "c", start: "1" } });
      arrive();
      expect(tried("transform.x")).toEqual({ keys: [{ time: "1", value: 7 }] });
      expect(heard).toEqual([{ kind: "unsure" }]);
    });

    it("moves nothing and says so when that gets taken back, with no keys to go by", () => {
      const { store, trial, tried, heard } = setup();
      const { other, arrive } = window(store);
      other.execute({ type: "clip.trim", params: { timeline: "main", clip: "c", start: "1" } });
      arrive();
      trial.write([key("1", 7)]);
      other.undo();
      arrive();
      expect(tried("transform.x")).toEqual({ keys: [{ time: "1", value: 7 }] });
      expect(heard).toEqual([{ kind: "unsure" }]);
    });

    it("does not take keys that got another time for a clock that moved", () => {
      const { run, store, trial, tried, heard } = setup();
      const keys = (first: string) => [
        { time: first, value: 1 },
        { time: "3", value: 0.5 },
      ];
      run(set({ keys: keys("1") }, "opacity"));
      trial.write([key("1", 7)]);
      const { other, arrive } = window(store);
      const moved = { timeline: "main", clips: [{ clip: "c", start: "3" }] };
      other.executeBatch([
        { type: "clip.move", params: moved },
        set({ keys: keys("2") }, "opacity"),
      ]);
      arrive();
      expect(tried("transform.x")).toEqual({ keys: [{ time: "1", value: 7 }] });
      expect(heard).toEqual([]);
    });

    it("does not take a clip with a start of its own for one that grew", () => {
      const { store, trial, tried, heard } = setup();
      trial.write([key("1", 7)]);
      const { other, arrive } = window(store);
      const changes = { start: "1", duration: "7", offset: "1" };
      other.execute({ type: "clip.update", params: { timeline: "main", clip: "c", changes } });
      arrive();
      expect(tried("transform.x")).toEqual({ keys: [{ time: "1", value: 7 }] });
      expect(heard).toEqual([]);
    });

    it("does not take a video for a clip that grew: there is nothing before its start", () => {
      const { run, store, trial, track, heard } = setup();
      const source = { kind: "video", media: { asset: "a" } };
      const clip = { id: "v", start: "20", duration: "2", source };
      run({ type: "clip.add", params: { timeline: "main", track, clip } });
      trial.write([
        { owner: { clip: "v" }, path: "transform.x", op: "setKey", time: "1", value: 7 },
      ]);
      const { other, arrive } = window(store);
      const changes = { start: "19", duration: "3" };
      other.execute({ type: "clip.update", params: { timeline: "main", clip: "v", changes } });
      arrive();
      expect(heard).toEqual([]);
    });

    it("says nothing for what is no clock at all: moving a clip, or trimming it", () => {
      const { store, trial, heard } = setup();
      trial.write([key("1", 7)]);
      const { other, arrive } = window(store);
      other.execute({
        type: "clip.move",
        params: { timeline: "main", clips: [{ clip: "c", start: "1" }] },
      });
      arrive();
      other.execute({ type: "clip.trim", params: { timeline: "main", clip: "c", start: "2" } });
      arrive();
      other.execute({ type: "clip.trim", params: { timeline: "main", clip: "c", end: "5" } });
      arrive();
      expect(heard).toEqual([]);
      expect(trial.count).toBe(1);
    });

    it("moves nothing and says so when the keys of the clip disagree", () => {
      const { run, store, trial, tried, heard } = setup();
      run(set({ keys: [{ time: "1", value: 1 }] }, "opacity"));
      run(set({ keys: [{ time: "2", value: 1 }] }));
      trial.write([key("3", 0.5, "opacity")]);
      const { other, arrive } = window(store);
      other.executeBatch([
        { type: "clip.trim", params: { timeline: "main", clip: "c", start: "1" } },
        set({ keys: [{ time: "2", value: 1 }] }),
      ]);
      arrive();
      expect(tried("opacity")).toMatchObject({ keys: [{ time: "1" }, { time: "3" }] });
      expect(heard).toEqual([{ kind: "unsure" }]);
    });

    it("sets aside keys that do not fit any more when another window takes growing back", () => {
      const { run, store, trial, tried, heard } = setup();
      run(set({ keys: [{ time: "3", value: 1 }] }, "opacity"));
      const { other, arrive } = window(store);
      other.execute({ type: "clip.trim", params: { timeline: "main", clip: "c", start: "0" } });
      arrive();
      trial.write([key("1", 7), key("6", 8), key("5", 0.5, "transform.y")]);
      const shown = tried("transform.x");
      other.undo();
      arrive();
      expect(trial.holds("c", "transform.x")).toBe(false);
      expect(trial.setAside).toBe(1);
      expect(tried("transform.y")).toEqual({ keys: [{ time: "3", value: 0.5 }] });
      expect(heard).toEqual([{ kind: "aside", count: 1 }]);
      other.redo();
      arrive();
      expect(tried("transform.x")).toEqual(shown);
      expect(heard.at(-1)).toEqual({ kind: "back", count: 1 });
    });

    it("starts over from what is saved when people try that property again", () => {
      const { run, store, trial, tried } = setup();
      run(set({ keys: [{ time: "3", value: 1 }] }, "opacity"));
      const { other, arrive } = window(store);
      other.execute({ type: "clip.trim", params: { timeline: "main", clip: "c", start: "0" } });
      arrive();
      trial.write([key("1", 7)]);
      other.undo();
      arrive();
      expect(trial.setAside).toBe(1);
      trial.write([key("4", 9)]);
      expect(tried("transform.x")).toEqual({ keys: [{ time: "4", value: 9 }] });
      expect(trial.setAside).toBe(0);
      trial.undo();
      expect(trial.setAside).toBe(1);
      expect(trial.count).toBe(0);
    });

    it("leaves keys that do not fit out of what gets saved", () => {
      const { run, store, trial, saved } = setup();
      run(set({ keys: [{ time: "3", value: 1 }] }, "opacity"));
      const { other, arrive } = window(store);
      other.execute({ type: "clip.trim", params: { timeline: "main", clip: "c", start: "0" } });
      arrive();
      trial.write([key("1", 7), key("5", 0.5, "transform.y")]);
      other.undo();
      arrive();
      expect(trial.save()).toEqual({ ok: true, saved: 1, overwritten: 0 });
      expect(saved("transform.x")).toBeUndefined();
      expect(saved("transform.y")).toEqual({ keys: [{ time: "3", value: 0.5 }] });
      expect(trial.setAside).toBe(1);
    });

    it("gets those keys through a reload", () => {
      const { run, store, trial } = setup();
      run(set({ keys: [{ time: "3", value: 1 }] }, "opacity"));
      const { other, arrive } = window(store);
      other.execute({ type: "clip.trim", params: { timeline: "main", clip: "c", start: "0" } });
      arrive();
      trial.write([key("1", 7)]);
      other.undo();
      arrive();
      const kept = JSON.parse(JSON.stringify(trial.toStored()));
      expect(kept.changes[0]).toMatchObject({ moved: "-2" });
      const next = new Trial(store, "main");
      next.restore(kept);
      expect(next.count).toBe(0);
      expect(next.setAside).toBe(1);
      other.redo();
      arrive();
      expect(next.changes.get("c")?.get("transform.x")?.value).toEqual({
        keys: [{ time: "1", value: 7 }],
      });
    });
  });

  it("stays out of the way of what has nothing to do with clips", () => {
    const { store, trial } = setup();
    trial.write([write(1)]);
    const changed = vi.fn();
    trial.subscribe(changed);
    store.execute({ type: "project.rename", params: { name: "别的名字" } });
    expect(changed).not.toHaveBeenCalled();
  });
});

describe("going back past what happened to clips, and forward again", () => {
  const key = (time: string, value: number, clip = "c"): PropertyEdit => ({
    owner: { clip },
    path: "transform.x",
    op: "setKey",
    time,
    value,
  });

  /** Undo the way people get it: whatever they did last goes first. */
  function historyOf(store: ProjectStore, trial: Trial) {
    return {
      undo: () => (trial.undoesFirst ? trial.undo() : store.undo()),
      redo: () => (trial.redoesFirst ? trial.redo() : store.redo()),
    };
  }

  it("brings back keys in the part of a clip that grew", () => {
    const { run, store, trial, tried } = setup();
    const { undo, redo } = historyOf(store, trial);
    trial.write([key("3", 30)]);
    run({ type: "clip.trim", params: { timeline: "main", clip: "c", start: "0" } });
    trial.write([key("1", 10)]);
    const shown = tried("transform.x");
    expect(shown).toEqual({
      keys: [
        { time: "1", value: 10 },
        { time: "5", value: 30 },
      ],
    });
    undo();
    undo();
    expect(tried("transform.x")).toEqual({ keys: [{ time: "3", value: 30 }] });
    undo();
    expect(trial.count).toBe(0);
    redo();
    redo();
    redo();
    expect(tried("transform.x")).toEqual(shown);
    expect(trial.count).toBe(1);
    expect(trial.setAside).toBe(0);
  });

  it("does not move what was tried on one part of a clip to the other", () => {
    const { run, store, trial, tried } = setup();
    const { undo, redo } = historyOf(store, trial);
    run({ type: "clip.split", params: { timeline: "main", clip: "c", at: "5", id: "right" } });
    trial.write([key("1", 10)]);
    undo();
    undo();
    redo();
    redo();
    expect(tried("transform.x")).toEqual({ keys: [{ time: "1", value: 10 }] });
    expect(trial.changes.has("right")).toBe(false);
    expect(trial.count).toBe(1);
  });

  it("gets the parts of a clip back as they were, each with its own", () => {
    const { run, store, trial, tried } = setup();
    const { undo, redo } = historyOf(store, trial);
    trial.write([key("1", 10)]);
    run({ type: "clip.split", params: { timeline: "main", clip: "c", at: "5", id: "right" } });
    trial.write([key("4", 40, "right")]);
    trial.write([key("2", 20)]);
    const left = tried("transform.x");
    const right = tried("transform.x", "right");
    for (let step = 0; step < 4; step += 1) undo();
    expect(trial.count).toBe(0);
    for (let step = 0; step < 4; step += 1) redo();
    expect(tried("transform.x")).toEqual(left);
    expect(tried("transform.x", "right")).toEqual(right);
  });

  it("gets through deleting a clip as well", () => {
    const { run, store, trial, tried } = setup();
    const { undo, redo } = historyOf(store, trial);
    trial.write([key("1", 10)]);
    run({ type: "clip.remove", params: { timeline: "main", clips: ["c"] } });
    undo();
    expect(tried("transform.x")).toMatchObject({ keys: [{ value: 10 }] });
    undo();
    expect(trial.count).toBe(0);
    redo();
    redo();
    expect(trial.count).toBe(0);
    expect(trial.setAside).toBe(1);
  });

  it("leaves a step alone that something else happened to since", () => {
    const { store, trial, tried } = setup();
    trial.write([key("1", 10)]);
    const { other, arrive } = window(store);
    other.execute({
      type: "clip.split",
      params: { timeline: "main", clip: "c", at: "5", id: "r" },
    });
    arrive();
    trial.undo();
    expect(trial.holds("c", "transform.x")).toBe(false);
    expect(tried("transform.x", "r")).toEqual({ keys: [{ time: "1", value: 10 }] });
    trial.redo();
    expect(tried("transform.x")).toEqual({ keys: [{ time: "1", value: 10 }] });
  });

  it("takes along what happened to the clock in another window since a step", () => {
    const { run, store, trial, tried } = setup();
    run(set({ keys: [{ time: "3", value: 1 }] }, "opacity"));
    trial.write([key("1", 10)]);
    trial.write([key("4", 40)]);
    const { other, arrive } = window(store);
    other.execute({ type: "clip.trim", params: { timeline: "main", clip: "c", start: "0" } });
    arrive();
    const shown = tried("transform.x");
    expect(shown).toMatchObject({ keys: [{ time: "3" }, { time: "6" }] });
    trial.undo();
    expect(tried("transform.x")).toEqual({ keys: [{ time: "3", value: 10 }] });
    trial.redo();
    expect(tried("transform.x")).toEqual(shown);
  });

  it("takes that along for a clip nothing but a step to go forward is about", () => {
    const { run, store, trial, tried } = setup();
    run(set({ keys: [{ time: "3", value: 1 }] }, "opacity"));
    trial.write([key("1", 10)]);
    trial.undo();
    expect(trial.count).toBe(0);
    const { other, arrive } = window(store);
    other.execute({ type: "clip.trim", params: { timeline: "main", clip: "c", start: "0" } });
    arrive();
    trial.redo();
    expect(tried("transform.x")).toEqual({ keys: [{ time: "3", value: 10 }] });
  });

  it("takes that along for a clip nothing but a step to go back to is about", () => {
    const { run, store, trial, tried } = setup();
    run(set({ keys: [{ time: "3", value: 1 }] }, "opacity"));
    trial.write([key("1", 10)]);
    trial.discard();
    expect(trial.count).toBe(0);
    const { other, arrive } = window(store);
    other.execute({ type: "clip.trim", params: { timeline: "main", clip: "c", start: "0" } });
    arrive();
    trial.undo();
    expect(tried("transform.x")).toEqual({ keys: [{ time: "3", value: 10 }] });
  });

  it("leaves out what the project holds by now, on the way back", () => {
    const { store, trial } = setup();
    trial.write([write(1)]);
    trial.write([write(2)]);
    store.execute(set(1), { origin: aiTask("t") });
    trial.undo();
    expect(trial.count).toBe(0);
  });

  it("leaves out what the project holds by now, on the way forward", () => {
    const { store, trial } = setup();
    trial.write([write(2)]);
    trial.undo();
    store.execute(set(2), { origin: aiTask("t") });
    trial.redo();
    expect(trial.count).toBe(0);
  });

  it("is the exact opposite of what it did, whatever the steps were at first", () => {
    const { run, store, trial, tried } = setup();
    trial.write([write(1)]);
    run({ type: "clip.split", params: { timeline: "main", clip: "c", at: "5", id: "right" } });
    store.undo();
    trial.undo();
    trial.redo();
    expect(tried("transform.x")).toBe(1);
    store.redo();
    expect(tried("transform.x", "right")).toBe(1);
  });
});

describe("what is left after saving, when the project goes back past it", () => {
  const second = {
    id: "d",
    start: "30",
    duration: "1",
    source: { kind: "color", color: "#00ff00" },
  };
  const remove: CommandCall = { type: "clip.remove", params: { timeline: "main", clips: ["c"] } };
  const clear: PropertyEdit = { owner, path: "transform.x", op: "clear" };
  const key: PropertyEdit = { owner, path: "transform.x", op: "setKey", time: "1", value: 7 };
  const elsewhere: PropertyEdit = { ...key, owner: { clip: "d" }, path: "transform.y" };
  const keys = { keys: [{ time: "1", value: 7 }] };

  it("loses nothing to a value that only matches for a while", () => {
    const { run, store, trial, track } = setup();
    run({ type: "clip.add", params: { timeline: "main", track, clip: second } });
    run(set(5));
    trial.write([clear]);
    run(remove);
    trial.write([elsewhere]);
    trial.save();
    expect(trial.setAside).toBe(1);
    store.undo();
    store.undo();
    expect(trial.count).toBe(1);
    store.undo();
    expect(trial.count).toBe(0);
    store.redo();
    expect(trial.count).toBe(1);
    store.redo();
    store.redo();
    expect(trial.setAside).toBe(1);
    expect(trial.toStored()?.changes).toMatchObject([{ clip: "c", base: 5 }]);
  });

  it("gets no copy on the part that did not have it", () => {
    const { run, store, trial, track, tried } = setup();
    run({ type: "clip.add", params: { timeline: "main", track, clip: second } });
    run({ type: "clip.split", params: { timeline: "main", clip: "c", at: "5", id: "p" } });
    trial.write([key]);
    run(remove);
    trial.write([elsewhere]);
    trial.save();
    store.undo();
    store.undo();
    store.undo();
    store.redo();
    expect(tried("transform.x", "p")).toBeUndefined();
    expect(tried("transform.x")).toEqual(keys);
    store.redo();
    store.redo();
    expect(trial.count).toBe(0);
    expect(trial.setAside).toBe(1);
  });

  it("gets the copy back on the part that had it", () => {
    const { run, store, trial, tried } = setup();
    trial.write([key]);
    run({ type: "clip.split", params: { timeline: "main", clip: "c", at: "5", id: "p" } });
    expect(tried("transform.x", "p")).toEqual(keys);
    store.undo();
    expect(trial.holds("p", "transform.x")).toBe(false);
    store.redo();
    expect(tried("transform.x", "p")).toEqual(keys);
  });

  it("gets to the part what was tried on the clip since, like a cut does", () => {
    const { run, store, trial, tried } = setup();
    run({ type: "clip.split", params: { timeline: "main", clip: "c", at: "5", id: "p" } });
    store.undo();
    trial.write([key]);
    store.redo();
    expect(tried("transform.x", "p")).toEqual(keys);
  });

  it("leaves out what people gave up on in the meantime", () => {
    const { run, store, trial } = setup();
    trial.write([key]);
    run({ type: "clip.trim", params: { timeline: "main", clip: "c", start: "0" } });
    store.undo();
    trial.discard();
    store.redo();
    expect(trial.count).toBe(0);
  });

  it("gets to the part what the clip holds by then, not what it held", () => {
    const { run, store, trial, tried } = setup();
    trial.write([{ owner, path: "opacity", op: "set", value: 0.5 }]);
    run({ type: "clip.split", params: { timeline: "main", clip: "c", at: "5", id: "p" } });
    store.undo();
    trial.write([{ owner, path: "opacity", op: "set", value: 0.25 }]);
    store.redo();
    expect(tried("opacity", "p")).toBe(0.25);
  });

  it("goes back the other way as well", () => {
    const { run, store, trial, tried } = setup();
    run(set(5));
    store.undo();
    trial.write([{ owner, path: "transform.x", op: "set", value: 5 }]);
    expect(tried("transform.x")).toBe(5);
    store.redo();
    expect(trial.count).toBe(0);
    store.undo();
    expect(tried("transform.x")).toBe(5);
  });

  it("comes second to what was tried on the property since", () => {
    const { run, store, trial, tried } = setup();
    run(set(5));
    trial.write([clear]);
    store.undo();
    expect(trial.count).toBe(0);
    trial.write([{ owner, path: "transform.x", op: "set", value: 9 }]);
    store.redo();
    expect(tried("transform.x")).toBe(9);
  });
});

describe("cutting a clip out and pasting it", () => {
  const paste = (id = "moved") => [
    { type: "clip.remove", params: { timeline: "main", clips: ["c"] } },
    {
      type: "clip.add",
      params: {
        timeline: "main",
        track: "",
        movedFrom: "c",
        clip: { id, start: "30", duration: "6", source: { kind: "color", color: "#ff0000" } },
      },
    },
  ];
  const move = (track: string, id?: string) =>
    paste(id).map((call, index) =>
      index === 1 ? { ...call, params: { ...call.params, track } } : call,
    );

  it("takes what is tried to the new clip, and nothing is set aside", () => {
    const { store, trial, track, tried, heard } = setup();
    trial.write([write(1)]);
    expect(store.executeBatch(move(track)).ok).toBe(true);
    expect(tried("transform.x", "moved")).toBe(1);
    expect(trial.count).toBe(1);
    expect(trial.setAside).toBe(0);
    expect(heard).toEqual([]);
  });

  it("goes back with undo and forward with redo", () => {
    const { store, trial, track, tried } = setup();
    trial.write([write(1)]);
    store.executeBatch(move(track));
    store.undo();
    expect(tried("transform.x")).toBe(1);
    expect(trial.changes.has("moved")).toBe(false);
    store.redo();
    expect(tried("transform.x", "moved")).toBe(1);
    expect(trial.count).toBe(1);
  });

  it("saves on the clip it ended up on", () => {
    const { store, trial, track, saved } = setup();
    trial.write([write(1)]);
    store.executeBatch(move(track));
    trial.save();
    expect(saved("transform.x", "moved")).toBe(1);
  });

  it("is not what deleting a clip and adding another one does", () => {
    const { store, trial, track, heard } = setup();
    trial.write([write(1)]);
    const [remove, add] = move(track) as [CommandCall, CommandCall];
    const { movedFrom: _movedFrom, ...params } = add.params as { movedFrom: string };
    store.executeBatch([remove, { type: "clip.add", params }]);
    expect(trial.changes.has("moved")).toBe(false);
    expect(trial.setAside).toBe(1);
    expect(heard).toEqual([{ kind: "aside", count: 1 }]);
  });

  it("takes along what was tried since it got taken back, when it goes forward again", () => {
    const { store, trial, track, tried } = setup();
    trial.write([write(1)]);
    store.executeBatch(move(track));
    store.undo();
    trial.write([write(2)]);
    store.redo();
    expect(tried("transform.x", "moved")).toBe(2);
    expect(trial.count).toBe(1);
  });

  it("is for clips that went away in the same change", () => {
    const { store, trial, track, tried } = setup();
    trial.write([write(1)]);
    const clip = {
      id: "x",
      start: "20",
      duration: "2",
      source: { kind: "color", color: "#00ff00" },
    };
    const add = (movedFrom: string) => ({
      type: "clip.add",
      params: { timeline: "main", track, clip, movedFrom },
    });
    expect(store.execute(add("c"))).toMatchObject({ ok: false, error: { code: "not-moved" } });
    expect(store.execute(add("nothing"))).toMatchObject({
      ok: false,
      error: { code: "not-moved" },
    });
    store.execute({ type: "clip.remove", params: { timeline: "main", clips: ["c"] } });
    expect(store.execute(add("c"))).toMatchObject({ ok: false, error: { code: "not-moved" } });
    expect(tried("transform.x", "x")).toBeUndefined();
    expect(trial.setAside).toBe(1);
  });

  it("is not for AI, which does not even see what is tried", () => {
    const { store, trial, track, tried } = setup();
    trial.write([write(1)]);
    const result = store.executeBatch(move(track), { origin: aiTask("t") });
    expect(result).toMatchObject({ ok: false, error: { code: "user-only" } });
    expect(tried("transform.x")).toBe(1);
    expect(store.getState().timelines["main"]?.clips["c"]).toBeDefined();
  });

  it("from another window sets it aside, because nobody can say", () => {
    const { store, trial, track, heard } = setup();
    trial.write([write(1)]);
    const { other, arrive } = window(store);
    other.executeBatch(move(track));
    arrive();
    expect(trial.count).toBe(0);
    expect(trial.setAside).toBe(1);
    expect(heard).toEqual([{ kind: "aside", count: 1 }]);
  });
});

describe("a file that changed outside of the editor", () => {
  const path = "timelines/main/timeline.json";

  /** What opening a file with the clip cut in two comes to. */
  function cutInFile(store: ProjectStore) {
    const file = JSON.parse(store.exportFiles().files.get(path) as string);
    const [track] = file.tracks;
    const [clip] = track.clips;
    track.clips = [
      { ...clip, duration: "3" },
      { ...clip, id: "piece", start: "5", duration: "3", offset: "3" },
    ];
    return JSON.stringify(file);
  }

  const key: PropertyEdit = { owner, path: "transform.x", op: "setKey", time: "1", value: 7 };

  it("counts as what another window sends: a cut takes what is tried to both parts", () => {
    const { store, trial, tried, heard } = setup();
    trial.write([key]);
    expect(store.importFile(path, cutInFile(store), { origin: USER }).ok).toBe(true);
    expect(tried("transform.x", "piece")).toEqual({ keys: [{ time: "1", value: 7 }] });
    expect(heard).toEqual([]);
  });

  it("moves nothing when it does not say what happened, and tells", () => {
    const { store, trial, tried, heard } = setup();
    trial.write([key]);
    const file = JSON.parse(store.exportFiles().files.get(path) as string);
    const [clip] = file.tracks[0].clips;
    clip.start = "1";
    clip.duration = "7";
    expect(store.importFile(path, JSON.stringify(file), { origin: USER }).ok).toBe(true);
    expect(tried("transform.x")).toEqual({ keys: [{ time: "1", value: 7 }] });
    expect(heard).toEqual([{ kind: "unsure" }]);
  });
});

describe("what the project says about a change", () => {
  it("is there while listeners hear about it, and gone afterwards", () => {
    const { store, run } = setup();
    const seen: unknown[] = [];
    store.subscribe(() => seen.push(store.change?.facts));
    run({ type: "clip.split", params: { timeline: "main", clip: "c", at: "5", id: "right" } });
    store.undo();
    store.redo();
    expect(seen).toEqual([
      [{ kind: "cut", clip: "c", piece: "right" }],
      [{ kind: "joined", clip: "c", piece: "right" }],
      [{ kind: "cut", clip: "c", piece: "right" }],
    ]);
    expect(store.change).toBeUndefined();
  });

  it("comes in the order things happened, and back in the other order", () => {
    const { store, run } = setup();
    const seen: unknown[] = [];
    store.subscribe(() => seen.push(store.change?.facts));
    run({ type: "clip.trim", params: { timeline: "main", clip: "c", start: "0" } });
    store.undo();
    expect(seen).toEqual([
      [{ kind: "clock", clip: "c", by: "2" }],
      [{ kind: "clock", clip: "c", by: "-2" }],
    ]);
  });

  it("goes back in the other order within one change as well", () => {
    const { store } = setup();
    const seen: unknown[] = [];
    store.subscribe(() => seen.push(store.change?.facts));
    store.executeBatch([
      { type: "clip.trim", params: { timeline: "main", clip: "c", start: "0" } },
      { type: "clip.split", params: { timeline: "main", clip: "c", at: "4", id: "r" } },
    ]);
    store.undo();
    expect(seen).toEqual([
      [
        { kind: "clock", clip: "c", by: "2" },
        { kind: "cut", clip: "c", piece: "r" },
      ],
      [
        { kind: "joined", clip: "c", piece: "r" },
        { kind: "clock", clip: "c", by: "-2" },
      ],
    ]);
  });

  it("does not stay around when a listener fails", () => {
    const { store, run } = setup();
    const stop = store.subscribe(() => {
      throw new Error("listener");
    });
    expect(() =>
      store.execute({
        type: "clip.split",
        params: { timeline: "main", clip: "c", at: "5", id: "r" },
      }),
    ).toThrow("listener");
    stop();
    expect(store.change).toBeUndefined();
    const seen: unknown[] = [];
    store.subscribe(() => seen.push(store.change?.facts));
    run(set(1));
    expect(seen).toEqual([[]]);
  });

  it("is nothing for a file, which only has its outcome", () => {
    const { store } = setup();
    const seen: unknown[] = [];
    const path = "timelines/main/timeline.json";
    const file = JSON.parse(store.exportFiles().files.get(path) as string);
    file.tracks[0].clips[0].start = "3";
    store.subscribe(() => seen.push(store.change?.facts));
    expect(store.importFile(path, JSON.stringify(file), { origin: USER }).ok).toBe(true);
    store.undo();
    store.redo();
    expect(seen).toEqual([undefined, undefined, undefined]);
  });

  it("is nothing for what comes from elsewhere", () => {
    const { store } = setup();
    const { other, arrive } = window(store);
    const seen: unknown[] = [];
    store.subscribe(() => seen.push(store.change?.facts));
    other.execute({ type: "clip.split", params: { timeline: "main", clip: "c", at: "5" } });
    arrive();
    expect(seen).toEqual([undefined]);
  });

  it("is nothing when only a part of something goes back", () => {
    const { store, run, track } = setup();
    run({ type: "clip.trim", params: { timeline: "main", clip: "c", start: "0" } });
    store.execute({
      type: "track.update",
      params: { timeline: "main", track, changes: { locked: true } },
    });
    store.execute(
      { type: "track.update", params: { timeline: "main", track, changes: { locked: false } } },
      { origin: aiTask("t") },
    );
    store.execute(set(5), { origin: aiTask("t") });
    const { other, arrive } = window(store);
    other.execute({
      type: "clip.update",
      params: { timeline: "main", clip: "c", changes: { name: "新" } },
    });
    arrive();
    const seen: unknown[] = [];
    const stop = store.subscribe(() => seen.push(store.change?.facts));
    other.execute({
      type: "clip.move",
      params: { timeline: "main", clips: [{ clip: "c", start: "1" }] },
    });
    arrive();
    store.undo();
    store.undo();
    stop();
    expect(seen.at(-1)).toBeUndefined();
  });
});

describe("somebody else changing what is being tried", () => {
  const ai = { origin: aiTask("t") };

  it("does not touch what is shown, and marks the property", () => {
    const { store, trial, tried, saved } = setup();
    trial.write([write(1), write(0.5, "opacity")]);
    expect(trial.changedElsewhere("c", "transform.x")).toBe(false);
    store.execute(set(9), ai);
    expect(saved("transform.x")).toBe(9);
    expect(tried("transform.x")).toBe(1);
    expect(trial.changedElsewhere("c", "transform.x")).toBe(true);
    expect(trial.changedElsewhere("c", "opacity")).toBe(false);
    expect(trial.conflicts).toBe(1);
  });

  it("tells who is listening", () => {
    const { store, trial } = setup();
    trial.write([write(1)]);
    const changed = vi.fn();
    trial.subscribe(changed);
    store.execute(set(9), ai);
    expect(changed).toHaveBeenCalled();
  });

  it("is noticed when it comes from another window", () => {
    const { store, trial } = setup();
    trial.write([write(1)]);
    const doc = new Y.Doc();
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(store.doc));
    new ProjectStore(doc).execute(set(9));
    store.applyUpdates([Y.encodeStateAsUpdate(doc, Y.encodeStateVector(store.doc))]);
    expect(trial.changedElsewhere("c", "transform.x")).toBe(true);
  });

  it("stays marked when people go on with the property", () => {
    const { store, trial } = setup();
    trial.write([write(1)]);
    store.execute(set(9), ai);
    trial.write([write(2)]);
    expect(trial.changedElsewhere("c", "transform.x")).toBe(true);
  });

  it("loses to what people tried when they save, and they get to hear about it", () => {
    const { store, trial, saved } = setup();
    trial.write([write(1), write(0.5, "opacity")]);
    store.execute(set(9), ai);
    expect(trial.save()).toEqual({ ok: true, saved: 2, overwritten: 1 });
    expect(saved("transform.x")).toBe(1);
  });

  it("can be taken back after saving, to what that somebody wrote", () => {
    const { store, trial, saved } = setup();
    trial.write([write(1)]);
    store.execute(set(9), ai);
    trial.save();
    store.undo();
    expect(saved("transform.x")).toBe(9);
  });

  it("is what remains after giving up", () => {
    const { store, trial, saved } = setup();
    trial.write([write(1)]);
    store.execute(set(9), ai);
    trial.discard();
    expect(saved("transform.x")).toBe(9);
    expect(trial.conflicts).toBe(0);
  });

  it("settles it when both come to the same value", () => {
    const { store, trial } = setup();
    trial.write([write(1)]);
    store.execute(set(1), ai);
    expect(trial.count).toBe(0);
  });
});

describe("keeping it for later", () => {
  const stored = (changes: readonly unknown[], extra = {}) => ({
    version: 1,
    timeline: "main",
    changes,
    ...extra,
  });

  it("has nothing to keep when nothing is being tried", () => {
    expect(setup().trial.toStored()).toBeUndefined();
  });

  it("comes back the way it was", () => {
    const { store, trial } = setup();
    trial.write([write(1), { owner, path: "opacity", op: "setKey", time: "1", value: 0.5 }]);
    const kept = JSON.parse(JSON.stringify(trial.toStored()));
    const next = new Trial(store, "main");
    expect(next.restore(kept)).toEqual({ restored: 2, dropped: 0, stale: 0, unreadable: false });
    expect(next.changes).toEqual(trial.changes);
  });

  it("keeps a property that was taken away", () => {
    const { run, store, trial } = setup();
    run(set(5));
    trial.write([{ owner, path: "transform.x", op: "clear" }]);
    const next = new Trial(store, "main");
    next.restore(JSON.parse(JSON.stringify(trial.toStored())));
    expect(next.holds("c", "transform.x")).toBe(true);
    next.save();
    expect(store.getState().timelines["main"]?.clips["c"]?.properties).toBeUndefined();
  });

  it("notices what somebody else did in the meantime", () => {
    const { run, store, trial } = setup();
    trial.write([write(1)]);
    const kept = JSON.parse(JSON.stringify(trial.toStored()));
    run(set(9));
    const next = new Trial(store, "main");
    next.restore(kept);
    expect(next.changedElsewhere("c", "transform.x")).toBe(true);
  });

  it("does not count as a step, and what was tried in the meantime goes first", () => {
    const { store, trial } = setup();
    trial.write([write(1)]);
    const kept = trial.toStored();
    const next = new Trial(store, "main");
    next.write([write(2)]);
    expect(next.restore(kept).restored).toBe(0);
    expect(next.changes.get("c")?.get("transform.x")?.value).toBe(2);
    expect(new Trial(store, "main").canUndo).toBe(false);
  });

  it("calls what is the same as the project by now stale, so that it gets written off", () => {
    const { run, store } = setup();
    run(set(1));
    const kept = stored([{ clip: "c", path: "transform.x", value: 1 }]);
    expect(new Trial(store, "main").restore(kept)).toEqual({
      restored: 0,
      dropped: 0,
      stale: 1,
      unreadable: false,
    });
  });

  it("sets aside what was tried on a clip that is gone, and it is back with the clip", () => {
    const { run, store } = setup();
    run({ type: "clip.remove", params: { timeline: "main", clips: ["c"] } });
    const next = new Trial(store, "main");
    const kept = stored([{ clip: "c", path: "opacity", value: 0.5 }]);
    expect(next.restore(kept)).toEqual({ restored: 0, dropped: 0, stale: 0, unreadable: false });
    expect(next.count).toBe(0);
    expect(next.setAside).toBe(1);
    store.undo();
    expect(next.count).toBe(1);
  });

  it("gets what is set aside through a reload, with how long it has been waiting", () => {
    const { run, store, trial } = setup();
    trial.write([write(1)]);
    run({ type: "clip.remove", params: { timeline: "main", clips: ["c"] } });
    const kept = JSON.parse(JSON.stringify(trial.toStored()));
    expect(kept.changes[0].asideSince).toBeGreaterThan(0);
    const next = new Trial(store, "main");
    next.restore(kept);
    expect(next.setAside).toBe(1);
    expect(next.toStored()).toEqual(kept);
  });

  it("writes off what has been set aside for too long, and nothing else", () => {
    const { run, store } = setup();
    run({ type: "clip.remove", params: { timeline: "main", clips: ["c"] } });
    const day = 24 * 60 * 60 * 1000;
    const next = new Trial(store, "main");
    const kept = stored([
      { clip: "c", path: "opacity", value: 0.5, asideSince: Date.now() - 31 * day },
      { clip: "c", path: "transform.y", value: 3, asideSince: Date.now() - 29 * day },
    ]);
    expect(next.restore(kept)).toEqual({ restored: 0, dropped: 0, stale: 1, unreadable: false });
    expect(next.setAside).toBe(1);
  });

  it("does not write off what is in use again, however long it was set aside", () => {
    const { store } = setup();
    const next = new Trial(store, "main");
    const long = Date.now() - 365 * 24 * 60 * 60 * 1000;
    const kept = stored([{ clip: "c", path: "opacity", value: 0.5, asideSince: long }]);
    expect(next.restore(kept).restored).toBe(1);
  });

  it("goes under the steps of this page, so that undo gets back to what was kept", () => {
    const { store, trial } = setup();
    trial.write([write(1)]);
    const kept = trial.toStored();
    const next = new Trial(store, "main");
    next.write([write(0.5, "opacity")]);
    next.write([write(2)]);
    next.restore(kept);
    expect(next.changes.get("c")?.get("transform.x")?.value).toBe(2);
    next.undo();
    expect(next.changes.get("c")?.get("transform.x")?.value).toBe(1);
    next.undo();
    expect(next.changes.get("c")?.get("transform.x")?.value).toBe(1);
    expect(next.count).toBe(1);
  });

  it.each([
    ["a value out of range", { clip: "c", path: "opacity", value: 5 }],
    ["a value of the wrong kind", { clip: "c", path: "opacity", value: "半透明" }],
    ["a property that does not exist", { clip: "c", path: "transform.nope", value: 1 }],
    [
      "keys on what cannot have them",
      { clip: "c", path: "fit", value: { keys: [{ time: "0", value: "cover" }] } },
    ],
    [
      "keys out of order",
      {
        clip: "c",
        path: "opacity",
        value: {
          keys: [
            { time: "2", value: 0 },
            { time: "1", value: 0 },
          ],
        },
      },
    ],
    ["a key without a time", { clip: "c", path: "opacity", value: { keys: [{ value: 0 }] } }],
    ["a path that reaches into objects", { clip: "c", path: "__proto__", value: 1 }],
    ["a clip with a name no clip has", { clip: "__proto__", path: "opacity", value: 1 }],
    ["fields nobody knows", { clip: "c", path: "opacity", value: 0.5, more: true }],
    ["something that is no change at all", 7],
    ["nothing", null],
  ])("drops %s, and keeps the rest", (_, bad) => {
    const { store } = setup();
    const next = new Trial(store, "main");
    const good = { clip: "c", path: "transform.y", value: 3 };
    expect(next.restore(stored([bad, good]))).toEqual({
      restored: 1,
      dropped: 1,
      stale: 0,
      unreadable: false,
    });
    expect(next.count).toBe(1);
    expect(next.save().ok).toBe(true);
  });

  it.each([
    ["no object", "试改"],
    ["a number", 7],
    ["null", null],
    ["an array", []],
    ["another version", { version: 2, timeline: "main", changes: [] }],
    ["no list of changes", { version: 1, timeline: "main", changes: {} }],
    ["fields nobody knows", { version: 1, timeline: "main", changes: [], more: 1 }],
  ])("reads %s as nothing, and says so", (_, bad) => {
    const next = new Trial(setup().store, "main");
    expect(next.restore(bad)).toEqual({ restored: 0, dropped: 0, stale: 0, unreadable: true });
    expect(next.count).toBe(0);
  });

  it("has nothing to say when nothing was kept", () => {
    const next = new Trial(setup().store, "main");
    expect(next.restore(undefined)).toEqual({
      restored: 0,
      dropped: 0,
      stale: 0,
      unreadable: false,
    });
  });

  it("does not take what was tried on another timeline", () => {
    const next = new Trial(setup().store, "main");
    const kept = stored([{ clip: "c", path: "opacity", value: 0.5 }], { timeline: "other" });
    expect(next.restore(kept).restored).toBe(0);
  });

  it("brings back what cannot be saved right now, like on a locked track", () => {
    const { run, store, track } = setup();
    run({ type: "track.update", params: { timeline: "main", track, changes: { locked: true } } });
    const next = new Trial(store, "main");
    expect(next.restore(stored([{ clip: "c", path: "opacity", value: 0.5 }])).restored).toBe(1);
  });
});

describe("going away", () => {
  it("stops following the project", () => {
    const { run, trial } = setup();
    trial.write([write(1)]);
    trial.dispose();
    run({ type: "clip.remove", params: { timeline: "main", clips: ["c"] } });
    expect(trial.count).toBe(1);
  });
});

describe("what is tried on a property that gets another path", () => {
  const rename = (from: string, to: string, extra: object = {}): CommandCall => ({
    type: "property.rename",
    params: { timeline: "main", renames: [{ owner, from, to, ...extra }] },
  });

  it("goes along, and back again with undo", () => {
    const { run, store, trial, tried } = setup();
    run(set(1, "object.arm.x"));
    trial.write([write(5, "object.arm.x")]);
    run(rename("object.arm.x", "object.arm_l.x"));
    expect(trial.holds("c", "object.arm.x")).toBe(false);
    expect(tried("object.arm_l.x")).toBe(5);
    store.undo();
    expect(trial.holds("c", "object.arm_l.x")).toBe(false);
    expect(tried("object.arm.x")).toBe(5);
    expect(trial.count).toBe(1);
  });

  it("goes along in the new unit, and back in the old one", () => {
    const { run, store, trial, tried } = setup();
    run(set(1, "object.arm.r"));
    trial.write([write(10, "object.arm.r")]);
    run(rename("object.arm.r", "object.arm.turns", { scale: 0.5 }));
    expect(tried("object.arm.turns")).toBe(5);
    expect(trial.changes.get("c")?.get("object.arm.turns")?.base).toBe(0.5);
    store.undo();
    expect(tried("object.arm.r")).toBe(10);
  });

  it("goes along with two properties that swap, and with one that goes where another left", () => {
    const { run, trial, tried } = setup();
    run(set(1, "object.o.a"));
    run(set(2, "object.o.b"));
    trial.write([write(100, "object.o.a"), write(200, "object.o.b")]);
    const move = (from: string, to: string) => ({ owner, from, to });
    run({
      type: "property.rename",
      params: {
        timeline: "main",
        renames: [move("object.o.a", "object.o.b"), move("object.o.b", "object.o.a")],
      },
    });
    expect(tried("object.o.b")).toBe(100);
    expect(tried("object.o.a")).toBe(200);
    run({
      type: "property.rename",
      params: {
        timeline: "main",
        renames: [move("object.o.b", "object.o.c"), move("object.o.a", "object.o.b")],
      },
    });
    expect(tried("object.o.c")).toBe(100);
    expect(tried("object.o.b")).toBe(200);
  });

  it("leaves what is tried under the new path as it is", () => {
    const { run, trial, tried } = setup();
    run(set(1, "object.a.x"));
    trial.write([write(5, "object.a.x"), write(7, "object.b.x")]);
    run(rename("object.a.x", "object.b.x"));
    expect(tried("object.b.x")).toBe(7);
  });
});
