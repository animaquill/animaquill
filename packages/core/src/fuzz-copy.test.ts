/**
 * A copy and its project stay apart over random work both ways, a discarded copy can be collected,
 * and changes() goes by the state, whatever way it came to be.
 */
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { ProjectCopy } from "./copy.ts";
import { FUZZ, openUnlocked, randomCommand, randomFrom, seedIds } from "./fuzz-support.ts";
import { sceneSourceOf } from "./scene-plan.ts";
import { ProjectStore, USER, aiTask, type CommandCall, type CommandResult } from "./store.ts";

const AI = aiTask("t1");

function fork(source: ProjectStore): ProjectCopy {
  const forked = ProjectCopy.fork(source);
  if (!forked.ok) throw new Error(forked.error.code);
  return forked.copy;
}

function ok(result: CommandResult) {
  if (!result.ok) throw new Error(`${result.error.code}: ${JSON.stringify(result.error.params)}`);
  return result;
}

function listen(store: ProjectStore) {
  const heard: string[] = [];
  store.subscribe(() => heard.push("state"));
  store.onLocalUpdate(() => heard.push("update"));
  store.watchCommands(({ commands }) => heard.push(`command ${commands.join()}`));
  store.doc.on("update", () => heard.push("doc"));
  return heard;
}

function snapshot(store: ProjectStore) {
  return {
    bytes: Buffer.from(store.encodeState()).toString("base64"),
    state: store.getState(),
    revision: store.revisionId,
    history: store.history.length,
    lastHistory: store.history.at(-1),
    canUndo: store.canUndo,
    canRedo: store.canRedo,
    canUndoAi: store.canUndoOrigin(AI),
    changes: store.changesSince(0)?.length,
    exported: [...store.exportFiles().files].join("\n\n"),
  };
}

/** One random step on a store: a command or batch as a person or AI, undo, redo, or a refused batch. */
function step(store: ProjectStore, random: ReturnType<typeof randomFrom>): string {
  const what = random.int(10);
  if (what === 0) return `undo ${store.undo().ok}`;
  if (what === 1) return `redo ${store.redo().ok}`;
  if (what === 2) return `undoOrigin ${store.undoOrigin(AI).ok}`;
  if (what === 3) {
    // A batch that fails at its last call: nothing of it is written.
    const calls: CommandCall[] = [randomCommand(store, random), { type: "no.such", params: {} }];
    return `refused ${store.executeBatch(calls).ok}`;
  }
  const batch = Array.from({ length: 1 + random.int(3) }, () => randomCommand(store, random));
  const origin = random.chance(0.5) ? USER : AI;
  try {
    const result = store.executeBatch(batch, {
      origin,
      ...(random.chance(0.2) && { dryRun: true }),
    });
    return `${batch.map(({ type }) => type).join(",")} ${result.ok ? "ok" : result.error.code}`;
  } catch (error) {
    return `threw ${String(error)}`;
  }
}

describe.each(Array.from({ length: 12 }, (_, i) => i + 1))(
  "a copy and its project, seed %i",
  FUZZ,
  (seed) => {
    it("stay apart: random work on the copy leaves the project as it was, to the byte", () => {
      seedIds(seed);
      const random = randomFrom(seed);
      const source = openUnlocked();
      // Some history of its own first.
      for (let i = 0; i < 20; i++) step(source, random);
      const before = snapshot(source);
      const heard = listen(source);
      const copy = fork(source);
      const log: string[] = [];
      let wrote = 0;
      for (let i = 0; i < 300; i++) {
        const said = step(copy.store, random);
        if (said.endsWith(" ok") || said.startsWith("undo true") || said.startsWith("redo true"))
          wrote++;
        log.push(said);
        expect({ i, said, source: snapshot(source) }).toEqual({ i, said, source: before });
        expect(heard).toEqual([]);
      }
      expect(wrote).toBeGreaterThan(30);
      // Its base is still the project of then.
      expect(copy.baseState()).toEqual(before.state);
      expect([...copy.baseFiles()].join("\n\n")).toBe(before.exported);
      copy.discard();
      expect(snapshot(source)).toEqual(before);
    });

    it("stay apart: random work on the project leaves the copy as it was", () => {
      seedIds(seed + 100);
      const random = randomFrom(seed + 100);
      const source = openUnlocked();
      const copy = fork(source);
      for (let i = 0; i < 30; i++) step(copy.store, random);
      const before = snapshot(copy.store);
      const baseFiles = [...copy.baseFiles()].join("\n\n");
      const baseState = copy.baseState();
      const changes = JSON.stringify(copy.changes());
      const heard = listen(copy.store);
      for (let i = 0; i < 300; i++) {
        step(source, random);
        expect(snapshot(copy.store)).toEqual(before);
      }
      expect(heard).toEqual([]);
      expect(copy.baseState()).toBe(baseState);
      expect([...copy.baseFiles()].join("\n\n")).toBe(baseFiles);
      expect(JSON.stringify(copy.changes())).toBe(changes);
    });

    it("has no changes after everything is undone", () => {
      seedIds(seed + 200);
      const random = randomFrom(seed + 200);
      const copy = fork(openUnlocked());
      const { store } = copy;
      let steps = 0;
      for (let i = 0; i < 80; i++) {
        const batch = [randomCommand(store, random)];
        if (store.executeBatch(batch).ok) steps++;
      }
      while (store.canUndo) store.undo();
      expect({ steps, changes: copy.changes() }).toEqual({ steps, changes: [] });
    });
  },
);

describe("the changes of a copy", () => {
  it("has no clip that was removed and put back as it was", () => {
    const source = openUnlocked();
    const copy = fork(source);
    const { store } = copy;
    const clip = store.getState().timelines.main?.clips.clip_title;
    if (!clip) throw new Error("no clip");
    const { track } = clip as unknown as Record<string, unknown>;
    const file = (copy.baseFiles().get("timelines/main/timeline.json") as string) ?? "";
    const fromFile = JSON.parse(file)
      .tracks.flatMap((t: { clips: unknown[] }) => t.clips)
      .find((c: { id: string }) => c.id === "clip_title");
    ok(store.execute({ type: "clip.remove", params: { timeline: "main", clips: ["clip_title"] } }));
    ok(store.execute({ type: "clip.add", params: { timeline: "main", track, ...fromFile } }));
    const listed = copy
      .changes()
      .map(({ object, change }) => `${change} ${object.kind} ${object.id}`);
    // Joins taken away with the clip are not back: those are what changed, if any.
    expect(listed.filter((line) => line.includes("clip_title"))).toEqual([]);
  });

  it("has only the moved track when tracks change their order", () => {
    const copy = fork(openUnlocked());
    const { store } = copy;
    const tracks = Object.values(store.getState().timelines.main?.tracks ?? {}).toSorted(
      (a, b) => a.order - b.order,
    );
    const [first, second] = tracks;
    ok(
      store.execute({
        type: "track.move",
        params: { timeline: "main", track: second?.id, before: first?.id },
      }),
    );
    const listed = copy
      .changes()
      .map(({ object, change }) => `${change} ${object.kind} ${object.id}`);
    expect(listed.length).toBeGreaterThan(0);
    expect(listed.every((line) => line.startsWith("changed track"))).toBe(true);
  });
});

describe("a discarded copy", () => {
  setFlagsFromString("--expose-gc");
  const gc = runInNewContext("gc") as () => void;

  it("can be collected, with its store, document and state, while the project lives on", async () => {
    const source = openUnlocked();
    const refs: WeakRef<object>[] = [];
    (() => {
      const copy = fork(source);
      const { store } = copy;
      listen(store);
      ok(
        store.execute(
          {
            type: "clip.update",
            params: { timeline: "main", clip: "clip_title", changes: { name: "x" } },
          },
          { origin: AI },
        ),
      );
      sceneSourceOf(store.getState(), "title");
      copy.changes();
      copy.baseFiles();
      refs.push(
        new WeakRef(copy),
        new WeakRef(store),
        new WeakRef(store.doc),
        new WeakRef(store.getState()),
        new WeakRef(copy.baseState()),
      );
      copy.discard();
      // A store kept from before is still safe to use.
      expect(store.execute({ type: "project.rename", params: { name: "y" } }).ok).toBe(false);
      expect(store.redo().ok).toBe(false);
      expect(() => store.getState()).not.toThrow();
    })();
    for (let i = 0; i < 5; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      gc();
    }
    expect(refs.map((ref) => ref.deref() === undefined)).toEqual([true, true, true, true, true]);
    expect(source.getState().timelines.main).toBeDefined();
  });
});
