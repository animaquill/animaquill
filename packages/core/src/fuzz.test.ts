import { readProject } from "@animaquill/schema";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { loadFixture } from "../../schema/scripts/fixture.ts";
import { deepEqual } from "./patch.ts";
import { ProjectStore, aiTask, type CommandCall } from "./store.ts";

/** Small and repeatable: a failure can be reproduced from its seed. */
function randomFrom(seed: number) {
  let state = seed;
  const next = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
  return {
    int: (limit: number) => Math.floor(next() * limit),
    pick: <T>(items: readonly T[]): T | undefined => items[Math.floor(next() * items.length)],
    chance: (probability: number) => next() < probability,
  };
}

function openUnlocked(): ProjectStore {
  const files = loadFixture("v1");
  const manifest = JSON.parse(files.get("animaquill.json") as string);
  delete manifest.tags;
  files.set("animaquill.json", JSON.stringify(manifest));
  const { store } = ProjectStore.open(files);
  if (!store) throw new Error("fixture did not open");
  return store;
}

function replica(store: ProjectStore): ProjectStore {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(store.doc), "sync");
  return new ProjectStore(doc);
}

function sync(a: ProjectStore, b: ProjectStore): void {
  Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc, Y.encodeStateVector(b.doc)), "sync");
  Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(b.doc, Y.encodeStateVector(a.doc)), "sync");
}

function randomCommand(store: ProjectStore, random: ReturnType<typeof randomFrom>): CommandCall {
  const main = store.getState().timelines["main"];
  const clips = Object.keys(main?.clips ?? {});
  const tracks = Object.keys(main?.tracks ?? {});
  const sections = Object.keys(main?.sections ?? {});
  const clip = random.pick(clips) ?? "none";
  const track = random.pick(tracks) ?? "none";
  const section = random.pick(sections) ?? "none";
  const timeline = "main";
  const color = { kind: "color", color: "#112233" };
  const calls: (() => CommandCall)[] = [
    () => ({
      type: "clip.move",
      params: { timeline, clips: [{ clip, start: String(random.int(60)) }] },
    }),
    () => ({
      type: "clip.move",
      params: { timeline, clips: [{ clip, start: String(random.int(60)) }], overlap: "overwrite" },
    }),
    () => ({
      type: "clip.move",
      params: {
        timeline,
        clips: clips
          .filter(() => random.chance(0.3))
          .map((id) => ({ clip: id, start: String(random.int(60)) })),
        overlap: "overwrite",
      },
    }),
    () => ({ type: "clip.move", params: { timeline, clips: [{ clip, track }] } }),
    () => ({
      type: "clip.move",
      params: { timeline, clips: [{ clip, track }], overlap: "overwrite" },
    }),
    () => ({
      type: "clip.trim",
      params: { timeline, clip, end: String(1 + random.int(80)) },
    }),
    () => ({
      type: "clip.trim",
      params: { timeline, clip, start: String(random.int(40)) },
    }),
    () => ({ type: "clip.split", params: { timeline, clip, at: String(random.int(60)) } }),
    () => ({
      type: "clip.setProperty",
      params: { timeline, clip, path: "opacity", value: random.int(100) / 100 },
    }),
    () => ({
      type: "clip.setProperty",
      params: { timeline, clip, path: "transform.x", value: random.int(100) / 100 },
    }),
    () => ({
      type: "clip.update",
      params: { timeline, clip, changes: { name: `n${random.int(9)}` } },
    }),
    () => ({ type: "clip.remove", params: { timeline, clips: [clip] } }),
    () => ({
      type: "clip.add",
      params: {
        timeline,
        track,
        clip: { start: String(random.int(60)), duration: "1", source: color },
        overlap: "overwrite",
      },
    }),
    () => ({ type: "track.add", params: { timeline, kind: "video" } }),
    () => ({ type: "track.remove", params: { timeline, track } }),
    () => ({ type: "track.move", params: { timeline, track, before: random.pick(tracks) } }),
    () => ({ type: "section.add", params: { timeline, duration: "2" } }),
    () => ({ type: "section.remove", params: { timeline, section } }),
    () => ({ type: "section.update", params: { timeline, section, duration: "3" } }),
    () => ({ type: "marker.add", params: { timeline, marker: { time: String(random.int(60)) } } }),
    () => ({ type: "project.rename", params: { name: `name ${random.int(9)}` } }),
  ];
  return (random.pick(calls) as () => CommandCall)();
}

describe.each([1, 2, 3, 4, 5, 6, 7, 8])("random work on two devices, seed %i", (seed) => {
  it("converges, and always gives valid files", () => {
    const random = randomFrom(seed);
    const a = openUnlocked();
    const b = replica(a);

    for (let round = 0; round < 400; round++) {
      const store = random.chance(0.5) ? a : b;
      if (random.chance(0.1)) store.undo();
      else if (random.chance(0.05)) store.redo();
      else {
        const origin = random.chance(0.3) ? aiTask(`t${random.int(3)}`) : undefined;
        store.execute(randomCommand(store, random), origin ? { origin } : {});
      }
      if (random.chance(0.05)) a.undoTask(`t${random.int(3)}`);
      if (random.chance(0.15)) sync(a, b);

      if (round % 50 === 0) {
        const { files, problems } = store.exportFiles();
        expect(problems).toEqual([]);
        const errors = readProject(files).problems.filter(
          (problem) => problem.severity === "error",
        );
        expect(errors).toEqual([]);
      }
    }

    sync(a, b);
    sync(a, b);
    expect(deepEqual(a.getState(), b.getState())).toBe(true);
    expect(a.exportFiles().files).toEqual(b.exportFiles().files);
    expect(a.exportFiles().problems).toEqual([]);

    // The state kept up with every change along the way, so it has to match a fresh read.
    const fresh = new ProjectStore(a.doc);
    expect(deepEqual(fresh.getState(), a.getState())).toBe(true);
  });
});

/**
 * Undo can leave an empty `properties` behind where a first property was added. Taking the object
 * away as well could take what somebody else put in it, and an empty one means the same.
 */
function withoutEmptyObjects(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  const entries = Object.entries(value)
    .map(([key, item]) => [key, withoutEmptyObjects(item)] as const)
    .filter(([, item]) => item !== undefined);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

describe.each([1, 2, 3, 4, 5, 6, 7, 8])("random work, undone step by step, seed %i", (seed) => {
  const same = (a: unknown, b: unknown) =>
    deepEqual(withoutEmptyObjects(a), withoutEmptyObjects(b));

  it("comes back exactly, and goes forward exactly", () => {
    const random = randomFrom(seed);
    const store = openUnlocked();
    for (let round = 0; round < 300; round++) {
      const before = store.getState();
      const result = store.execute(randomCommand(store, random));
      if (!result.ok || store.getState() === before) continue;
      const after = store.getState();
      expect(store.undo()).toBe(true);
      expect(same(store.getState(), before)).toBe(true);
      expect(store.redo()).toBe(true);
      expect(same(store.getState(), after)).toBe(true);
    }
  });
});
