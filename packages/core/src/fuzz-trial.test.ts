import { describe, expect, it } from "vitest";
import {
  FUZZ,
  openUnlocked,
  randomCommand,
  randomEdit,
  randomFrom,
  replica,
  sync,
  type Random,
} from "./fuzz-support.ts";
import { deepEqual } from "./patch.ts";
import type { PropertyEdit } from "./property-edit.ts";
import { ProjectStore, aiTask, type CommandCall } from "./store.ts";
import { Trial } from "./trial.ts";

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

describe.each([1, 2, 3, 4, 5, 6, 7, 8])("trying things out, seed %i", FUZZ, (seed) => {
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
      const to = String(random.int(9));
      const edits: PropertyEdit[] = [
        { owner, path, op: "setKey", time, value },
        { owner, path, op: "setKey", time, value },
        { owner, path, op: "write", time, value },
        { owner, path, op: "moveKey", moves: [{ from: time, to }] },
        { owner, path, op: "setInterp", times: [time], ease: { interp: "hold" } },
        { owner, path, op: "putKeys", keys: [{ time, value, interp: "hold" }] },
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
