import {
  compare,
  createProject,
  isAnimation,
  parseTime,
  readProject,
  type Rational,
} from "@animaquill/schema";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { loadFixture } from "../../schema/scripts/fixture.ts";
import { sample } from "./curve.ts";
import { deepEqual } from "./patch.ts";
import { buildRenderPlan } from "./render-plan.ts";
import { ProjectStore, aiTask, type CommandCall } from "./store.ts";
import { clockOf } from "./view.ts";

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

/** Few moments and few properties, so that edits land on each other's keys all the time. */
function randomEdit(clip: string, random: ReturnType<typeof randomFrom>): object {
  const owner = { clip };
  const path = random.pick(["opacity", "transform.x", "transform.rotation"]) as string;
  const time = random.pick(["0", "1/3", "1", "2.5", "7/3"]) as string;
  const value = random.int(100) / 100;
  const edits = [
    { owner, path, op: "write", time, value },
    { owner, path, op: "setKey", time, value },
    { owner, path, op: "removeKey", time },
    { owner, path, op: "set", value },
    { owner, path, op: "clear" },
  ];
  return random.pick(edits) as object;
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
    () => ({ type: "property.edit", params: { timeline, edits: [randomEdit(clip, random)] } }),
    () => ({ type: "property.edit", params: { timeline, edits: [randomEdit(clip, random)] } }),
    () => ({
      type: "property.edit",
      params: {
        timeline,
        edits: clips
          .filter(() => random.chance(0.3))
          .flatMap((id) => [randomEdit(id, random), randomEdit(id, random)]),
      },
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
  it("a curve is always one that can be read", () => {
    const random = randomFrom(seed);
    const store = openUnlocked();
    for (let round = 0; round < 300; round++) {
      store.execute(randomCommand(store, random));
    }
    const clips = Object.values(store.getState().timelines["main"]?.clips ?? {});
    for (const clip of clips) {
      for (const value of Object.values(clip.properties ?? {})) {
        if (!isAnimation(value)) continue;
        const times = value.keys.map(({ time }) => parseTime(time));
        expect(value.keys.length).toBeGreaterThan(0);
        times.slice(1).forEach((time, index) => {
          expect(compare(times[index] as Rational, time)).toBeLessThan(0);
        });
      }
    }
  });

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

describe.each([1, 2, 3, 4, 5, 6, 7, 8])(
  "two devices, each with its own properties, seed %i",
  (seed) => {
    const PATHS: readonly (readonly string[])[] = [
      ["opacity", "transform.x", "transform.rotation"],
      ["transform.y", "transform.scale", "transform.width"],
    ];

    it("never loses what either of them wrote", () => {
      const random = randomFrom(seed);
      const a = ProjectStore.create(createProject({ name: "并发" }));
      const main = () => a.getState().timelines["main"];
      const track = Object.values(main()?.tracks ?? {}).find(({ kind }) => kind === "video")?.id;
      // Many clips and few writes, so that most of them is the first one on its clip, on both sides.
      const clips = Array.from({ length: 40 }, (_, index) => `clip${index}`);
      clips.forEach((id, index) => {
        const properties = index % 4 === 0 ? { properties: { "transform.height": 100 } } : {};
        const clip = {
          id,
          start: String(index * 10),
          duration: "5",
          source: { kind: "color", color: "#112233" },
          ...properties,
        };
        expect(a.execute({ type: "clip.add", params: { timeline: "main", track, clip } }).ok).toBe(
          true,
        );
      });
      const b = replica(a);
      const wrote = new Map<string, number>();

      for (let round = 0; round < 120; round++) {
        const side = random.int(2);
        const store = side === 0 ? a : b;
        const clip = random.pick(clips) as string;
        const path = random.pick(PATHS[side] as readonly string[]) as string;
        const value = (random.int(100) + 1) / 100;
        const edits = [{ owner: { clip }, path, op: "set", value }];
        expect(
          store.execute({ type: "property.edit", params: { timeline: "main", edits } }).ok,
        ).toBe(true);
        wrote.set(`${clip} ${path}`, value);
        if (random.chance(0.2)) {
          const changes = { name: `n${random.int(9)}` };
          store.execute({
            type: "clip.update",
            params: { timeline: "main", clip: random.pick(clips), changes },
          });
        }
        if (random.chance(0.03)) sync(a, b);
      }

      sync(a, b);
      sync(a, b);
      for (const store of [a, b]) {
        const held = store.getState().timelines["main"]?.clips ?? {};
        for (const [place, value] of wrote) {
          const [clip = "", path = ""] = place.split(" ");
          expect(held[clip]?.properties?.[path], place).toBe(value);
        }
      }
      expect(deepEqual(a.getState(), b.getState())).toBe(true);
    });
  },
);

describe.each([1, 2, 3, 4, 5, 6, 7, 8])("keys through cuts and trims, seed %i", (seed) => {
  const FRAMES = 240;
  const moment = (frame: number) => frame / 30;

  /** What a clip of the example shows on each frame of the timeline. */
  function picture(store: ProjectStore): (number | undefined)[] {
    const plan = buildRenderPlan(store.getState(), "main");
    const track = (id: string) => store.getState().timelines["main"]?.clips[id]?.track;
    const first = plan?.layers[0];
    const mine = plan?.layers.filter(({ id }) => track(id) === (first && track(first.id)));
    return Array.from({ length: FRAMES }, (_, frame) => {
      const seconds = moment(frame);
      const layer = mine?.find(({ start, end }) => seconds >= start && seconds < end);
      const channel = layer?.channels["transform.x"];
      return layer && channel ? (sample(channel, clockOf(layer, seconds)) as number) : undefined;
    });
  }

  it("what is left shows the same on every frame", () => {
    const random = randomFrom(seed);
    const store = ProjectStore.create(createProject({ name: "关键帧" }));
    const main = () => store.getState().timelines["main"];
    const track = Object.values(main()?.tracks ?? {}).find(({ kind }) => kind === "video")?.id;
    const keys = Array.from({ length: 5 }, (_, index) => ({
      time: String(index * 2),
      value: random.int(1000),
    }));
    const clip = {
      id: "c",
      start: "0",
      duration: "8",
      source: { kind: "color", color: "#112233" },
      properties: { "transform.x": { keys, before: "pingpong", after: "continue" } },
    };
    const added = store.execute({
      type: "clip.add",
      params: { timeline: "main", track, clip },
    });
    expect(added.ok).toBe(true);
    const before = picture(store);

    for (let round = 0; round < 30; round++) {
      const ids = Object.keys(main()?.clips ?? {});
      const id = random.pick(ids) as string;
      const at = `${1 + random.int(FRAMES - 2)}/30`;
      const end = `${1 + random.int(FRAMES - 2)}/30`;
      const moves = [
        { type: "clip.split", params: { timeline: "main", clip: id, at } },
        { type: "clip.trim", params: { timeline: "main", clip: id, start: at } },
        { type: "clip.trim", params: { timeline: "main", clip: id, end } },
      ];
      store.execute(random.pick(moves) as CommandCall);
      picture(store).forEach((value, frame) => {
        if (value !== undefined && before[frame] !== undefined) {
          expect(value).toBeCloseTo(before[frame] as number, 6);
        }
      });
    }
  });
});

describe.each([1, 2, 3, 4, 5, 6, 7, 8])("random work, undone step by step, seed %i", (seed) => {
  it("comes back exactly, and goes forward exactly", () => {
    const random = randomFrom(seed);
    const store = openUnlocked();
    for (let round = 0; round < 300; round++) {
      const before = store.getState();
      const result = store.execute(randomCommand(store, random));
      if (!result.ok || store.getState() === before) continue;
      const after = store.getState();
      expect(store.undo()).toBe(true);
      expect(deepEqual(store.getState(), before)).toBe(true);
      expect(store.redo()).toBe(true);
      expect(deepEqual(store.getState(), after)).toBe(true);
    }
  });
});
