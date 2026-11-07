import {
  compare,
  createProject,
  isAnimation,
  parseTime,
  readProject,
  type Rational,
} from "@animaquill/schema";
import { describe, expect, it } from "vitest";
import { sample } from "./curve.ts";
import { FUZZ, openUnlocked, randomCommand, randomFrom, replica, sync } from "./fuzz-support.ts";
import type { ProjectState } from "./model.ts";
import { deepEqual } from "./patch.ts";
import { buildRenderPlan } from "./render-plan.ts";
import { ProjectStore, USER, aiTask, type CommandCall } from "./store.ts";
import { clockOf } from "./view.ts";

describe.each([1, 2, 3, 4, 5, 6, 7, 8])("random work on two devices, seed %i", FUZZ, (seed) => {
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
  FUZZ,
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

describe.each([1, 2, 3, 4, 5, 6, 7, 8])("keys through cuts and trims, seed %i", FUZZ, (seed) => {
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

describe.each([1, 2, 3, 4, 5, 6, 7, 8])(
  "random work, undone step by step, seed %i",
  FUZZ,
  (seed) => {
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
  },
);

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

describe.each([1, 2, 3, 4, 5, 6, 7, 8])(
  "taking back what others write over, seed %i",
  FUZZ,
  (seed) => {
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
  },
);

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

describe.each([1, 2, 3, 4, 5, 6, 7, 8])(
  "taking back with several people, seed %i",
  FUZZ,
  (seed) => {
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
  },
);
