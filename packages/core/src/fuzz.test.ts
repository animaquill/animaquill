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
import type { ProjectState } from "./model.ts";
import { deepEqual } from "./patch.ts";
import { buildRenderPlan } from "./render-plan.ts";
import type { PropertyEdit } from "./property-edit.ts";
import { ProjectStore, USER, aiTask, type CommandCall } from "./store.ts";
import { Trial } from "./trial.ts";
import { clockOf } from "./view.ts";

/** Small and repeatable: a failure can be reproduced from its seed. */
type Random = ReturnType<typeof randomFrom>;

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
  const state = store.getState();
  const scene = random.pick(Object.keys(state.scenes)) ?? "none";
  const file = random.pick(Object.keys(state.files)) ?? "code/none.js";
  const page = { "index.html": `<p>${random.int(9)}</p>`, "a.js": String(random.int(9)) };
  const calls: (() => CommandCall)[] = [
    () => ({
      type: "scene.add",
      params: {
        id: random.pick(["s1", "s2", "s3"]),
        scene: { name: "场景", entry: "index.html", runtime: 1 },
        files: page,
      },
    }),
    () => ({ type: "scene.update", params: { scene, changes: { name: `n${random.int(9)}` } } }),
    () => ({ type: "scene.remove", params: { scene } }),
    () => ({
      type: "clip.add",
      params: {
        timeline,
        track,
        clip: {
          start: String(random.int(60)),
          duration: "1",
          source: { kind: "scene", scene },
        },
        overlap: "overwrite",
      },
    }),
    () => ({ type: "file.write", params: { path: file, text: `t${random.int(9)}` } }),
    () => ({ type: "file.write", params: { path: `code/f${random.int(3)}.js`, text: "x" } }),
    () => ({
      type: "file.write",
      params: { path: `scenes/${scene}/n${random.int(3)}.js`, text: "x" },
    }),
    () => ({ type: "file.remove", params: { path: file } }),
    () => ({ type: "file.rename", params: { from: file, to: `code/r${random.int(3)}.js` } }),
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
      expect(store.undo()).toMatchObject({ ok: true, kept: [] });
      expect(deepEqual(store.getState(), before)).toBe(true);
      expect(store.redo()).toMatchObject({ ok: true, kept: [] });
      expect(deepEqual(store.getState(), after)).toBe(true);
    }
  });
});

/** What can be written by whom, few enough that the same value is written over and over. */
const WRITERS = [USER, USER, aiTask("t0"), aiTask("t1")];
const PATHS = ["c", "d"].flatMap((clip) => ["opacity", "transform.x"].map((path) => [clip, path]));

interface ModelWrite {
  readonly path: string;
  readonly value: number;
  readonly replaced: ModelWrite | undefined;
}

/** How taking things back should go, told as simply as possible: one write replaces another. */
class WrittenModel {
  readonly current = new Map<string, ModelWrite | undefined>();
  readonly done = new Map<string, ModelWrite[][]>();
  readonly undone = new Map<string, ModelWrite[][]>();

  list(lists: Map<string, ModelWrite[][]>, origin: string): ModelWrite[][] {
    const list = lists.get(origin) ?? [];
    lists.set(origin, list);
    return list;
  }

  write(origin: string, path: string, value: number): void {
    const replaced = this.current.get(path);
    const write = { path, value, replaced };
    this.current.set(path, write);
    this.list(this.done, origin).push([write]);
    this.undone.set(origin, []);
  }

  /** Takes writes back one by one. Returns how many went. */
  takeBack(writes: readonly ModelWrite[], to: ModelWrite[][]): number {
    const back: ModelWrite[] = [];
    for (const write of writes) {
      if (this.current.get(write.path) !== write) continue;
      this.current.set(write.path, write.replaced);
      back.push(write);
    }
    if (back.length > 0) to.push(back);
    return back.length;
  }

  bringBack(writes: readonly ModelWrite[], to: ModelWrite[][]): number {
    const back: ModelWrite[] = [];
    for (const write of writes) {
      if (this.current.get(write.path) !== write.replaced) continue;
      this.current.set(write.path, write);
      back.push(write);
    }
    if (back.length > 0) to.push(back);
    return back.length;
  }
}

describe.each([1, 2, 3, 4, 5, 6, 7, 8])("taking back what others write over, seed %i", (seed) => {
  it("goes by who wrote what, never by the value", () => {
    const random = randomFrom(seed);
    const store = ProjectStore.create(createProject({ name: "模型" }));
    const track = Object.values(store.getState().timelines["main"]?.tracks ?? {})[0]?.id;
    for (const [index, id] of ["c", "d"].entries()) {
      const clip = {
        id,
        start: String(index),
        duration: "1",
        source: { kind: "color", color: "#000000" },
      };
      store.execute({ type: "clip.add", params: { timeline: "main", track, clip } });
    }
    const model = new WrittenModel();
    const read = ([clip, path]: readonly string[]) =>
      store.getState().timelines["main"]?.clips[clip as string]?.properties?.[path as string];
    const matches = () => {
      for (const path of PATHS) {
        expect(read(path)).toBe(model.current.get(path.join(" "))?.value);
      }
    };
    for (let round = 0; round < 600; round++) {
      const task = `t${random.int(2)}`;
      const roll = random.int(100);
      if (roll < 60) {
        const origin = random.pick(WRITERS) as string;
        const path = random.pick(PATHS) as readonly string[];
        const value = random.int(2) / 2;
        if (read(path) === value) continue;
        const [clip, name] = path;
        store.execute(
          { type: "clip.setProperty", params: { timeline: "main", clip, path: name, value } },
          { origin },
        );
        model.write(origin, path.join(" "), value);
      } else if (roll < 75) {
        const entry = model.list(model.done, USER).pop();
        if (!entry) continue;
        const went = model.takeBack(entry, model.list(model.undone, USER));
        expect(store.undo().ok).toBe(went > 0);
      } else if (roll < 85) {
        const entry = model.list(model.undone, USER).pop();
        if (!entry) continue;
        const went = model.bringBack(entry, model.list(model.done, USER));
        expect(store.redo().ok).toBe(went > 0);
      } else if (roll < 95) {
        const origin = aiTask(task);
        const writes = model.list(model.done, origin).splice(0).flat();
        if (writes.length === 0) continue;
        const went = model.takeBack(writes.toReversed(), model.list(model.undone, origin));
        expect(store.undoTask(task).ok).toBe(went > 0);
      } else {
        const origin = aiTask(task);
        const entry = model.list(model.undone, origin).pop();
        if (!entry) continue;
        const went = model.bringBack(entry.toReversed(), model.list(model.done, origin));
        expect(store.redoTask(task).ok).toBe(went > 0);
      }
      matches();
    }
  });
});

/** Everything that can point at something else, looked at the slow way. */
function danglingIn(state: ProjectState): readonly string[] {
  const wrong: string[] = [];
  for (const timeline of Object.values(state.timelines)) {
    if (Object.keys(timeline.sections).length === 0) wrong.push("no section");
    for (const clip of Object.values(timeline.clips)) {
      if (!timeline.tracks[clip.track]) wrong.push(`${clip.id} is on ${clip.track}`);
      const { media, scene } = clip.source as { media?: { asset?: string }; scene?: string };
      if (media?.asset && !state.assets?.[media.asset])
        wrong.push(`${clip.id} uses ${media.asset}`);
      if (scene && !state.scenes[scene]) wrong.push(`${clip.id} shows ${scene}`);
    }
    for (const transition of Object.values(timeline.transitions)) {
      for (const clip of [transition.from, transition.to]) {
        if (clip && !timeline.clips[clip]) wrong.push(`${transition.id} goes to ${clip}`);
      }
      if (!timeline.tracks[transition.track]) wrong.push(`${transition.id} is on a lost track`);
    }
  }
  for (const [id, { entry }] of Object.entries(state.scenes)) {
    const path = `scenes/${id}/${entry}`;
    if (state.files[path] === undefined) wrong.push(`${id} has no ${entry}`);
  }
  return wrong;
}

describe.each([1, 2, 3, 4, 5, 6, 7, 8])("taking back with several people, seed %i", (seed) => {
  it("never leaves anything pointing at nothing", () => {
    const random = randomFrom(seed);
    const store = openUnlocked();
    expect(danglingIn(store.getState())).toEqual([]);
    const assets = ["a", "b", "c"];
    const asset = { kind: "image", path: "assets/a.png", storage: "local" };
    for (let round = 0; round < 500; round++) {
      const task = `t${random.int(3)}`;
      const roll = random.int(100);
      const origin = random.chance(0.5) ? aiTask(task) : USER;
      const id = random.pick(assets) as string;
      const tracks = Object.values(store.getState().timelines["main"]?.tracks ?? {});
      const video = random.pick(tracks.filter(({ kind }) => kind === "video"))?.id;
      if (roll < 10) store.undo();
      else if (roll < 15) store.redo();
      else if (roll < 25) store.undoTask(task);
      else if (roll < 30) store.redoTask(task);
      else if (roll < 40) store.execute({ type: "asset.add", params: { id, asset } }, { origin });
      else if (roll < 50)
        store.execute({ type: "asset.remove", params: { asset: id } }, { origin });
      else if (roll < 65) {
        const clip = {
          start: String(random.int(60)),
          duration: "1",
          source: { kind: "image", media: { asset: id } },
        };
        if (store.getState().assets?.[id]) {
          store.execute(
            {
              type: "clip.add",
              params: { timeline: "main", track: video, clip, overlap: "overwrite" },
            },
            { origin },
          );
        }
      } else store.execute(randomCommand(store, random), { origin });
      expect(danglingIn(store.getState())).toEqual([]);
    }
  });
});

describe.each([1, 2, 3, 4])("updates that arrive late and out of order, seed %i", (seed) => {
  it("leave no holes, whatever people do in the meantime", () => {
    const random = randomFrom(seed);
    const stores = [openUnlocked()];
    stores.push(replica(stores[0] as ProjectStore), replica(stores[0] as ProjectStore));
    const queues: Uint8Array[][] = stores.map(() => []);
    stores.forEach((store, from) =>
      store.onLocalUpdate((update) =>
        queues.forEach((queue, to) => {
          if (to !== from) queue.push(update);
        }),
      ),
    );
    const deliver = (index: number) => {
      const queue = queues[index] as Uint8Array[];
      const [update] = queue.splice(random.int(queue.length), 1);
      if (update) stores[index]?.applyUpdates([update]);
    };
    let refused = 0;
    for (let round = 0; round < 400; round++) {
      const store = random.pick(stores) as ProjectStore;
      const behind = store.isMissingUpdates;
      const before = store.revision;
      const result = random.chance(0.1)
        ? store.undo()
        : store.execute(randomCommand(store, random));
      if (behind) {
        refused += 1;
        expect(result.ok).toBe(false);
        expect(store.revision).toBe(before);
      }
      for (let count = random.int(3); count > 0; count--) deliver(random.int(stores.length));
      for (const each of stores) {
        // What people see is always whole, also while the document is not.
        for (const clip of Object.values(each.getState().timelines["main"]?.clips ?? {})) {
          expect(clip.start).toBeDefined();
          expect(clip.duration).toBeDefined();
          expect(clip.source).toBeDefined();
        }
        if (round % 20 === 0) expect(each.exportFiles().problems).toEqual([]);
      }
    }
    expect(refused).toBeGreaterThan(0);
    for (const index of stores.keys()) while (queues[index]?.length) deliver(index);
    for (const store of stores) expect(store.isMissingUpdates).toBe(false);
    expect(stores[1]?.getState()).toEqual(stores[0]?.getState());
    expect(stores[2]?.getState()).toEqual(stores[0]?.getState());
    const clips = Object.values(stores[0]?.getState().timelines["main"]?.clips ?? {});
    for (const clip of clips) {
      expect(clip.start).toBeDefined();
      expect(clip.duration).toBeDefined();
      expect(clip.source).toBeDefined();
    }
    expect(stores[0]?.exportFiles().problems).toEqual([]);
  });
});

describe.each([1, 2, 3, 4, 5, 6, 7, 8])("taking back around locked tracks, seed %i", (seed) => {
  it("leaves what is on them as it is, for everyone", () => {
    const random = randomFrom(seed);
    const store = openUnlocked();
    const lockedIn = (state: ProjectState) =>
      Object.values(state.timelines["main"]?.tracks ?? {})
        .filter(({ locked }) => locked)
        .map(({ id }) => id);
    const contentOf = (state: ProjectState, tracks: readonly string[]) => {
      const clips = Object.values(state.timelines["main"]?.clips ?? {});
      return clips.filter(({ track }) => tracks.includes(track));
    };
    /** What a scene on a locked track runs is what it shows, so that stays too. */
    const codeOf = (state: ProjectState, tracks: readonly string[]) => {
      const scenes = contentOf(state, tracks).flatMap(({ source }) =>
        source.kind === "scene" ? [source.scene as string] : [],
      );
      const isTheirs = (path: string) =>
        scenes.some((id) => path.startsWith(`scenes/${id}/`)) ||
        (scenes.length > 0 && path.startsWith("code/"));
      return {
        manifests: scenes.map((id) => state.scenes[id]),
        files: Object.entries(state.files).filter(([path]) => isTheirs(path)),
      };
    };
    let held = 0;
    let lockedCode = 0;
    for (let round = 0; round < 1000; round++) {
      const task = `t${random.int(3)}`;
      const roll = random.int(100);
      const before = store.getState();
      if (roll < 25) {
        const tracks = Object.keys(before.timelines["main"]?.tracks ?? {});
        const track = random.pick(tracks);
        const changes = { locked: random.chance(0.5) };
        store.execute({ type: "track.update", params: { timeline: "main", track, changes } });
        continue;
      }
      if (roll < 70) {
        const origin = random.chance(0.5) ? aiTask(task) : USER;
        store.execute(randomCommand(store, random), { origin });
        const still = lockedIn(before).filter((id) => lockedIn(store.getState()).includes(id));
        if (codeOf(before, still).files.length > 0) lockedCode += 1;
        expect(codeOf(store.getState(), still)).toEqual(codeOf(before, still));
        continue;
      }
      const result =
        roll < 80
          ? store.undoTask(task)
          : roll < 85
            ? store.redoTask(task)
            : roll < 95
              ? store.undo()
              : store.redo();
      if (!result.ok && result.error.obstacle === "locked") held += 1;
      const locked = lockedIn(before).filter((id) => lockedIn(store.getState()).includes(id));
      expect(contentOf(store.getState(), locked)).toEqual(contentOf(before, locked));
      expect(codeOf(store.getState(), locked)).toEqual(codeOf(before, locked));
    }
    expect(held).toBeGreaterThan(0);
    expect(lockedCode).toBeGreaterThan(0);
  });
});

/** Changes to clips that do the same on two copies of a project, so nothing that makes up an id. */
function randomClipChange(
  store: ProjectStore,
  random: ReturnType<typeof randomFrom>,
  round: number,
): CommandCall {
  const main = store.getState().timelines["main"];
  const clips = Object.values(main?.clips ?? {});
  const clip = random.pick(clips)?.id ?? "none";
  const alone = random.pick(clips.filter(({ link }) => link === undefined))?.id ?? "none";
  const track = random.pick(Object.keys(main?.tracks ?? {})) ?? "none";
  const timeline = "main";
  const calls: (() => CommandCall)[] = [
    () => ({
      type: "clip.split",
      params: { timeline, clip: alone, at: String(random.int(60)), id: `cut${round}` },
    }),
    () => ({
      type: "clip.split",
      params: { timeline, clip: alone, at: `${random.int(180)}/3`, id: `cut${round}` },
    }),
    () => ({ type: "clip.trim", params: { timeline, clip, start: String(random.int(40)) } }),
    () => ({ type: "clip.trim", params: { timeline, clip, end: String(1 + random.int(80)) } }),
    () => ({
      type: "clip.move",
      params: { timeline, clips: [{ clip, start: String(random.int(60)) }] },
    }),
    () => ({ type: "clip.move", params: { timeline, clips: [{ clip, track }] } }),
    () => ({ type: "clip.remove", params: { timeline, clips: [clip] } }),
    () => ({
      type: "clip.add",
      params: {
        timeline,
        track,
        clip: {
          id: `new${round}`,
          start: String(random.int(60)),
          duration: "4",
          source: { kind: "color", color: "#112233" },
        },
      },
    }),
  ];
  return (random.pick(calls) as () => CommandCall)();
}

/** What cutting a clip out and pasting it does: the clip goes, and a copy takes its place. */
function moveByPasting(store: ProjectStore, random: Random, round: number): readonly CommandCall[] {
  const main = store.getState().timelines["main"];
  const moved = random.pick(Object.values(main?.clips ?? {}).filter(({ link }) => !link));
  if (!moved) return [];
  const { track, ...clip } = moved;
  const copy = { ...clip, id: `moved${round}`, start: String(100 + round * 40) };
  return [
    { type: "clip.remove", params: { timeline: "main", clips: [moved.id] } },
    { type: "clip.add", params: { timeline: "main", track, clip: copy, movedFrom: moved.id } },
  ];
}

/** Everything that can be seen and everything that waits, without when it started waiting. */
function lookAt(store: ProjectStore, trial: Trial) {
  const clips = Object.values(store.getState().timelines["main"]?.clips ?? {});
  const tried = [...trial.kept].flatMap(([clip, held]) =>
    [...held].map(([path, { base, value, moved }]) => ({ clip, path, base, value, moved })),
  );
  return {
    clips: clips.toSorted((a, b) => a.id.localeCompare(b.id)),
    tried: tried.toSorted((a, b) => `${a.clip} ${a.path}`.localeCompare(`${b.clip} ${b.path}`)),
  };
}

/** What people get from the keys: whatever they did last goes first. */
const historyOf = (store: ProjectStore, trial: Trial) => ({
  canUndo: () => store.canUndo || trial.canUndo,
  undo: () => (trial.undoesFirst ? trial.undo() : store.undo()),
  redo: () => (trial.redoesFirst ? trial.redo() : store.redo()),
});

const randomClipOf = (store: ProjectStore, random: ReturnType<typeof randomFrom>) =>
  random.pick(Object.keys(store.getState().timelines["main"]?.clips ?? {})) ?? "none";

describe.each([1, 2, 3, 4, 5, 6, 7, 8])("trying things out, seed %i", (seed) => {
  it("saving comes to the same as writing right away, whatever happens to the clips", () => {
    const random = randomFrom(seed);
    const direct = openUnlocked();
    const tried = replica(direct);
    const trial = new Trial(tried, "main");
    const same = () => {
      expect(trial.save().ok).toBe(true);
      expect(trial.count).toBe(0);
      expect(deepEqual(tried.getState().timelines, direct.getState().timelines)).toBe(true);
    };
    for (let round = 0; round < 400; round++) {
      if (random.chance(0.75)) {
        const clip = randomClipOf(direct, random);
        const edits = [randomEdit(clip, random), randomEdit(clip, random)] as PropertyEdit[];
        const wrote = direct.execute({
          type: "property.edit",
          params: { timeline: "main", edits },
        });
        expect(trial.write(edits).ok).toBe(wrote.ok);
      } else if (random.chance(0.2)) {
        // A copy brings along what the project holds, which is what makes the two different here.
        const start = random.int(1000);
        const calls = (store: ProjectStore) => moveByPasting(store, randomFrom(start), round);
        expect(tried.executeBatch(calls(tried)).ok).toBe(direct.executeBatch(calls(direct)).ok);
      } else {
        const call = randomClipChange(direct, random, round);
        expect(tried.execute(call).ok).toBe(direct.execute(call).ok);
      }
      if (random.chance(0.05)) same();
    }
    same();
  });

  it("going back and forth shows exactly what was there", () => {
    const random = randomFrom(seed);
    const store = openUnlocked();
    const trial = new Trial(store, "main");
    const seen = () => JSON.stringify(lookAt(store, trial).tried);
    const past: string[] = [];
    let future: string[] = [];
    for (let round = 0; round < 150; round++) {
      const before = seen();
      if (past.length > 0 && random.chance(0.3)) {
        expect(trial.undo()).toBe(true);
        expect(seen()).toBe(past.pop());
        future.push(before);
      } else if (future.length > 0 && random.chance(0.3)) {
        expect(trial.redo()).toBe(true);
        expect(seen()).toBe(future.pop());
        past.push(before);
      } else {
        if (random.chance(0.1)) trial.discard();
        else trial.write([randomEdit(randomClipOf(store, random), random) as PropertyEdit]);
        if (seen() !== before) {
          past.push(before);
          future = [];
        }
      }
    }
    expect(store.canUndo).toBe(false);
  });

  it("what people try wins, whatever others do at the same time", () => {
    const random = randomFrom(seed);
    const store = openUnlocked();
    const other = replica(store);
    const trial = new Trial(store, "main");
    const clips = () => store.getState().timelines["main"]?.clips ?? {};
    for (let round = 0; round < 300; round++) {
      trial.write([randomEdit(randomClipOf(store, random), random) as PropertyEdit]);
      if (random.chance(0.5)) {
        other.execute(randomCommand(other, random));
        sync(store, other);
      }
      for (const clip of trial.changes.keys()) expect(Object.hasOwn(clips(), clip)).toBe(true);
      if (!random.chance(0.1)) continue;
      const wanted = [...trial.changes].flatMap(([clip, held]) =>
        [...held].map(([path, { value }]) => ({ clip, path, value })),
      );
      expect(trial.save().ok).toBe(true);
      for (const { clip, path, value } of wanted) {
        expect(deepEqual(clips()[clip]?.properties?.[path], value)).toBe(true);
      }
      expect(trial.count).toBe(0);
      sync(store, other);
    }
  });

  /** Everything people can do on their own, on a few clips, so that it all lands on each other. */
  function randomWork(
    store: ProjectStore,
    trial: Trial,
    random: Random,
    round: number,
    { saving = true } = {},
  ): void {
    const clip = randomClipOf(store, random);
    const roll = random.int(13);
    if (roll < 6) {
      const path = random.pick(["opacity", "transform.x", "transform.y"]) as string;
      const time = String(random.int(9));
      const value = random.int(100) / 100;
      const owner = { clip };
      const edits: PropertyEdit[] = [
        { owner, path, op: "setKey", time, value },
        { owner, path, op: "write", time, value },
        { owner, path, op: "set", value },
        { owner, path, op: "clear" },
      ];
      trial.write([random.pick(edits) as PropertyEdit]);
    } else if (roll === 6) trial.discard({ clip, path: "transform.x" });
    else if (roll === 7) trial.discard();
    else if (roll === 8) store.executeBatch(moveByPasting(store, random, round));
    else if (roll === 9 && saving) trial.save();
    else store.execute(randomClipChange(store, random, round));
  }

  it("going back and forward comes to exactly the same, whatever happened to the clips", () => {
    const random = randomFrom(seed);
    const store = openUnlocked();
    const trial = new Trial(store, "main");
    const { canUndo, undo, redo } = historyOf(store, trial);
    let steps = 0;
    for (let round = 0; round < 500; round++) {
      randomWork(store, trial, random, round);
      if (!random.chance(0.2)) continue;
      const before = lookAt(store, trial);
      const count = 1 + random.int(12);
      let taken = 0;
      while (taken < count && canUndo()) {
        undo();
        taken += 1;
      }
      for (let step = 0; step < taken; step += 1) redo();
      expect(lookAt(store, trial)).toEqual(before);
      steps += taken;
    }
    expect(steps).toBeGreaterThan(100);
  });

  it.each([
    ["without saving", false],
    ["with saving", true],
  ])("going all the way back and forward comes to the same as well, %s", (_, saving) => {
    const random = randomFrom(seed);
    const store = openUnlocked();
    const trial = new Trial(store, "main");
    const { canUndo, undo, redo } = historyOf(store, trial);
    for (let round = 0; round < 60; round++) randomWork(store, trial, random, round, { saving });
    const before = lookAt(store, trial);
    let taken = 0;
    while (canUndo()) {
      undo();
      taken += 1;
    }
    // Saving ends the steps, and what is set aside then stays until it gets a clip again.
    if (!saving) expect([...trial.kept.keys()]).toEqual([]);
    for (let step = 0; step < taken; step += 1) redo();
    expect(lookAt(store, trial)).toEqual(before);
  });

  it("a reload brings back all of it, whatever the state", () => {
    const random = randomFrom(seed);
    const store = openUnlocked();
    const trial = new Trial(store, "main");
    const { undo } = historyOf(store, trial);
    for (let round = 0; round < 300; round++) {
      randomWork(store, trial, random, round);
      if (random.chance(0.3) && store.canUndo) undo();
      if (!random.chance(0.15)) continue;
      const next = new Trial(store, "main");
      const kept: unknown = JSON.parse(JSON.stringify(trial.toStored() ?? null)) ?? undefined;
      expect(next.restore(kept)).toMatchObject({ dropped: 0, stale: 0, unreadable: false });
      expect(lookAt(store, next).tried).toEqual(lookAt(store, trial).tried);
      next.dispose();
    }
  });

  it("what is shown can always be saved", () => {
    const random = randomFrom(seed);
    const store = openUnlocked();
    const trial = new Trial(store, "main");
    const { undo } = historyOf(store, trial);
    const clips = () => store.getState().timelines["main"]?.clips ?? {};
    for (let round = 0; round < 300; round++) {
      randomWork(store, trial, random, round);
      if (random.chance(0.2) && store.canUndo) undo();
      if (!random.chance(0.1)) continue;
      const wanted = [...trial.changes].flatMap(([clip, held]) =>
        [...held].map(([path, { value }]) => ({ clip, path, value })),
      );
      expect(trial.save().ok).toBe(true);
      for (const { clip, path, value } of wanted) {
        expect(deepEqual(clips()[clip]?.properties?.[path], value)).toBe(true);
      }
      expect(trial.count).toBe(0);
    }
  });

  it("AI working on the same clips takes nothing away from going back and forward", () => {
    const random = randomFrom(seed);
    const store = openUnlocked();
    const trial = new Trial(store, "main");
    const { canUndo, undo, redo } = historyOf(store, trial);
    for (let round = 0; round < 300; round++) {
      randomWork(store, trial, random, round);
      const task = `t${round % 3}`;
      if (random.chance(0.3)) {
        store.execute(randomClipChange(store, random, 2000 + round), { origin: aiTask(task) });
      }
      if (random.chance(0.05)) store.undoTask(task);
      if (random.chance(0.05)) store.redoTask(task);
      if (!random.chance(0.1)) continue;
      const before = lookAt(store, trial);
      const count = 1 + random.int(6);
      let taken = 0;
      while (taken < count && canUndo()) {
        undo();
        taken += 1;
      }
      for (let step = 0; step < taken; step += 1) redo();
      const after = lookAt(store, trial);
      const onClips = ({ tried, clips }: typeof after) =>
        tried.filter(({ clip }) => clips.some(({ id }) => id === clip));
      expect(after.clips).toEqual(before.clips);
      expect(onClips(after)).toEqual(onClips(before));
    }
  });

  it("going back and forward holds while another window takes things back as well", () => {
    const random = randomFrom(seed);
    const store = openUnlocked();
    const other = replica(store);
    const trial = new Trial(store, "main");
    const { canUndo, undo, redo } = historyOf(store, trial);
    let inOther = 0;
    const goBackAndForward = (count: number) => {
      const before = lookAt(store, trial);
      let taken = 0;
      while (taken < count && canUndo()) {
        undo();
        taken += 1;
      }
      for (let step = 0; step < taken; step += 1) redo();
      const after = lookAt(store, trial);
      expect(after.clips).toEqual(before.clips);
      const onClips = ({ tried, clips }: typeof after) =>
        tried.filter(({ clip }) => clips.some(({ id }) => id === clip));
      expect(onClips(after)).toEqual(onClips(before));
      // What another window got in the way of goes back only in part, which says too little to tell
      // what became of a clip. That can leave a copy with what is set aside, but nothing goes missing.
      expect(after.tried).toEqual(expect.arrayContaining(before.tried));
    };
    for (let round = 0; round < 300; round++) {
      randomWork(store, trial, random, round);
      if (random.chance(0.4)) {
        const roll = random.int(4);
        if (roll === 0 && other.canUndo) inOther += other.undo().ok ? 1 : 0;
        else if (roll === 1 && other.canRedo) other.redo();
        else other.execute(randomClipChange(other, random, 1000 + round));
        sync(store, other);
      }
      if (random.chance(0.1)) goBackAndForward(1 + random.int(6));
    }
    goBackAndForward(Number.POSITIVE_INFINITY);
    expect(inOther).toBeGreaterThan(0);
  });
});
