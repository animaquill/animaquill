import { compare, createProject, parseTime, readProject, writeProject } from "@animaquill/schema";
import { describe, expect, it } from "vitest";
import { FUZZ, randomFrom, randomTransition, seedIds, sync, type Random } from "./fuzz-support.ts";
import { deepEqual } from "./patch.ts";
import { buildRenderPlan } from "./render-plan.ts";
import { ProjectStore, USER, aiTask, type CommandCall } from "./store.ts";

/**
 * Two windows that set transitions at the edges of clips, cut, remove, trim and move clips, while
 * files put joins between them, change and take them away: what both come to is the same, the
 * files stay valid, and nothing breaks the picture.
 */

const MAIN = "timelines/main/timeline.json";
const color = { kind: "color", color: "#ff0000" };
const LENGTHS = ["1/4", "1/2", "1", "3/2"];

/** Six clips in a row, with transitions at some of their edges and joins between all of them. */
function base(): ProjectStore {
  const files = writeProject(createProject({ name: "并发转场" }));
  const timeline = JSON.parse(files.get(MAIN) as string);
  const video = timeline.tracks.find(({ kind }: { kind: string }) => kind === "video");
  for (let index = 0; index < 6; index++) {
    video.clips.push({
      id: `c${index}`,
      start: String(index * 2),
      duration: "2",
      source: color,
      ...(index % 2 === 0 ? { enter: { type: "fade", duration: "1/2" } } : {}),
      ...(index % 3 === 0 ? { exit: { type: "fade", duration: "1/3" } } : {}),
    });
  }
  video.joins = [0, 1, 2, 3, 4].map((index) => ({
    id: `j${index}`,
    from: `c${index}`,
    to: `c${index + 1}`,
    type: "fade",
    duration: "1/2",
  }));
  files.set(MAIN, JSON.stringify(timeline));
  const { store, problems } = ProjectStore.open(files);
  if (!store) throw new Error(JSON.stringify(problems));
  return store;
}

/** a + b of two exact times written as n or n/d. */
function addTimes(a: string, b: string): string {
  const parse = (time: string): readonly [number, number] => {
    if (time.includes("/")) {
      const [n, d] = time.split("/");
      return [Number(n), Number(d)];
    }
    const decimals = time.split(".")[1]?.length ?? 0;
    return [Math.round(Number(time) * 10 ** decimals), 10 ** decimals];
  };
  const [an, ad] = parse(a);
  const [bn, bd] = parse(b);
  return `${an * bd + bn * ad}/${ad * bd}`;
}

/** A part of a time: half or a third of it. */
function partOf(time: string, parts: number): string {
  const [n, d = "1"] = time.split("/");
  return `${n}/${Number(d) * parts}`;
}

/** Joins that files made, for an id of their own. Each seed counts from the start. */
let joinsMade = 0;

/** A file that somebody or AI changed: a join goes, gets longer or shorter, moves or comes. */
function changedFile(store: ProjectStore, random: Random): string {
  const document = JSON.parse(store.exportFiles().files.get(MAIN) as string);
  const video = document.tracks.find(({ kind }: { kind: string }) => kind === "video");
  const joins: any[] = (video.joins ??= []);
  const choice = random.int(4);
  if (choice === 0 && joins.length > 0) joins.splice(random.int(joins.length), 1);
  else if (choice === 1 && joins.length > 0) random.pick(joins).duration = random.pick(LENGTHS);
  else if (choice === 2 && joins.length > 0) {
    const join = random.pick(joins);
    join.from = random.pick(video.clips.map(({ id }: { id: string }) => id)) ?? join.from;
  } else if (video.clips.length > 1) {
    const sorted = video.clips.toSorted((a: any, b: any) => Number(a.start) - Number(b.start));
    const at = random.int(sorted.length - 1);
    joinsMade += 1;
    const [from, to] = [sorted[at].id, sorted[at + 1].id];
    joins.push({ id: `k${joinsMade}`, from, to, type: "fade", duration: random.pick(LENGTHS) });
  }
  if (joins.length === 0) delete video.joins;
  return JSON.stringify(document);
}

function step(store: ProjectStore, random: Random): void {
  const main = store.getState().timelines["main"];
  const clips = Object.keys(main?.clips ?? {}).toSorted();
  const clip = random.pick(clips) ?? "none";
  const state = main?.clips[clip];
  const timeline = "main";
  const track = Object.values(main?.tracks ?? {}).find(({ kind }) => kind === "video")?.id;
  const edge = random.chance(0.5) ? "enter" : "exit";
  const transition = () => ({
    type: "fade",
    duration: random.pick(LENGTHS),
    ...(random.chance(0.5) && { curve: [0.42, 0, 0.58, 1] }),
  });
  const joins = Object.keys(main?.joins ?? {}).toSorted();
  const join = random.pick(joins) ?? "none";
  // The clip that starts where the picked one ends: a cut, where a join can go.
  const next = Object.values(main?.clips ?? {}).find(
    (other) =>
      state !== undefined &&
      other.track === state.track &&
      compare(parseTime(other.start), parseTime(addTimes(state.start, state.duration))) === 0,
  );
  const commands: (() => CommandCall)[] = [
    () => ({
      type: "clip.setTransition",
      params: { timeline, clip, [edge]: random.chance(0.25) ? null : transition() },
    }),
    () => ({
      type: "join.add",
      params: {
        timeline,
        from: clip,
        to: next?.id ?? random.pick(clips) ?? clip,
        ...randomTransition(random),
        ...(random.chance(0.5) && { duration: random.pick(LENGTHS) }),
        ...(random.chance(0.3) && { align: random.pick(["center", "before", "after"]) }),
      },
    }),
    () => ({
      type: "join.update",
      params: {
        timeline,
        join,
        changes: random.pick([
          { duration: random.pick(LENGTHS) },
          randomTransition(random),
          { align: random.pick(["center", "before", "after"]) },
          { curve: [0.42, 0, 0.58, 1] },
          { curve: null },
        ]),
      },
    }),
    () => ({ type: "join.remove", params: { timeline, joins: [join] } }),
    () => {
      const at = state ? addTimes(state.start, partOf(state.duration, 2 + random.int(2))) : "0";
      return { type: "clip.split", params: { timeline, clip, at } };
    },
    () => ({ type: "clip.remove", params: { timeline, clips: [clip] } }),
    () => ({
      type: "clip.add",
      params: {
        timeline,
        track,
        source: color,
        start: String(20 + random.int(10) * 2),
        duration: "2",
        enter: transition(),
        exit: transition(),
      },
    }),
    () => ({
      type: "clip.trim",
      params: {
        timeline,
        clip,
        end: state ? addTimes(state.start, partOf(state.duration, 2)) : "1",
      },
    }),
    () => ({
      type: "clip.update",
      params: { timeline, clip, changes: { duration: random.pick(["1/3", "1", "2", "3"]) } },
    }),
    () => ({
      type: "clip.move",
      params: {
        timeline,
        clips: [
          {
            clip,
            start: String(Math.max(0, Number(state?.start ?? 0) + (random.pick([-1, 1, 2]) ?? 1))),
          },
        ],
        ...(random.chance(0.5) && { overlap: "overwrite" }),
      },
    }),
  ];
  const roll = random.int(10);
  if (roll === 0) store.undo();
  else if (roll === 1) store.redo();
  else if (roll < 4) {
    const origin = random.chance(0.5) ? USER : aiTask("t1");
    store.importFile(MAIN, changedFile(store, random), { origin });
  } else {
    store.execute((random.pick(commands) as () => CommandCall)());
  }
}

describe.each([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])("two windows and joins, seed %i", FUZZ, (seed) => {
  it("come to the same, stay valid and keep a picture", () => {
    const random = randomFrom(seed);
    seedIds(seed);
    joinsMade = 0;
    const a = base();
    const b = ProjectStore.fromUpdates([a.encodeState()]).store as ProjectStore;
    for (let round = 0; round < 300; round++) {
      step(random.chance(0.5) ? a : b, random);
      if (random.chance(0.2)) sync(a, b);
      if (round % 25 !== 0) continue;
      for (const store of [a, b]) {
        const { files, problems } = store.exportFiles();
        expect(problems, `round ${round}`).toEqual([]);
        const errors = readProject(files).problems.filter(({ severity }) => severity === "error");
        expect(errors, `round ${round}`).toEqual([]);
        const plan = buildRenderPlan(store.getState(), "main");
        expect(plan).toBeDefined();
        // The clips of a join show for all of it, on both sides of the cut.
        for (const { from, to, start, end } of plan?.joins ?? []) {
          const layers = plan?.layers ?? [];
          const shows = (id: string) => layers.find((layer) => layer.id === id)?.shows;
          expect(shows(from)?.to, `round ${round}`).toBe(end);
          expect(shows(to)?.from, `round ${round}`).toBe(start);
        }
      }
    }
    sync(a, b);
    sync(a, b);
    expect(deepEqual(a.getState(), b.getState())).toBe(true);
    expect(a.exportFiles().files).toEqual(b.exportFiles().files);
    expect(deepEqual(new ProjectStore(a.doc).getState(), a.getState())).toBe(true);
  });
});
