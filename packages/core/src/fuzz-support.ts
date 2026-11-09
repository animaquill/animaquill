/**
 * What the random tests share, `fuzz*.test.ts`. They are in several files so that they run at the
 * same time: in one, they took longer than all the other unit tests together.
 */
import { add, compare, parseTime } from "@animaquill/schema";
import { onTestFinished, vi } from "vitest";
import * as Y from "yjs";
import { loadFixture } from "../../schema/scripts/fixture.ts";
import type { KeyEase } from "./property-edit.ts";
import { ProjectStore, type CommandCall } from "./store.ts";

/** Small and repeatable: a failure can be reproduced from its seed. */
export type Random = ReturnType<typeof randomFrom>;

/**
 * New ids from a seed instead of from chance, until the test is over: `newId` takes its bytes from
 * `crypto.getRandomValues`, and ids that differ from run to run make a seed do something else each
 * time, because what gets picked goes by sorted ids.
 */
export function seedIds(seed: number): void {
  const random = randomFrom(seed);
  vi.spyOn(globalThis.crypto, "getRandomValues").mockImplementation((array) => {
    if (array instanceof Uint8Array) array.forEach((_, index) => (array[index] = random.int(256)));
    return array;
  });
  onTestFinished(() => {
    vi.restoreAllMocks();
  });
}

export function randomFrom(seed: number) {
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

export function openUnlocked(): ProjectStore {
  const files = loadFixture("v1");
  const manifest = JSON.parse(files.get("animaquill.json") as string);
  delete manifest.tags;
  files.set("animaquill.json", JSON.stringify(manifest));
  const { store } = ProjectStore.open(files);
  if (!store) throw new Error("fixture did not open");
  return store;
}

export function replica(store: ProjectStore): ProjectStore {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(store.doc), "sync");
  return new ProjectStore(doc);
}

export function sync(a: ProjectStore, b: ProjectStore): void {
  Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc, Y.encodeStateVector(b.doc)), "sync");
  Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(b.doc, Y.encodeStateVector(a.doc)), "sync");
}

const MOMENTS = ["0", "1/3", "1", "2.5", "7/3"];
export const EASES: readonly KeyEase[] = [
  { interp: "linear" },
  { interp: "hold" },
  { interp: "bezier", out: [0.42, 0] },
  { interp: "bezier", out: [0.42, 0], in: [0.58, 1] },
];
export const HOLD = { interp: "hold" } as const;

/** Few moments and few properties, so that edits land on each other's keys all the time. */
export function randomEdit(clip: string, random: ReturnType<typeof randomFrom>): object {
  const owner = { clip };
  const path = random.pick([
    "opacity",
    "transform.x",
    "transform.rotation",
    "object.arm.x",
    "object.arm_l.x",
  ]) as string;
  const moment = () => random.pick(MOMENTS) as string;
  const time = moment();
  const value = random.int(100) / 100;
  const edits = [
    { owner, path, op: "write", time, value },
    { owner, path, op: "write", time, value },
    { owner, path, op: "setKey", time, value },
    { owner, path, op: "setKey", time, value },
    { owner, path, op: "removeKey", time },
    { owner, path, op: "moveKey", moves: [{ from: time, to: moment() }] },
    {
      owner,
      path,
      op: "moveKey",
      moves: [
        { from: moment(), to: time },
        { from: time, to: "3" },
      ],
    },
    { owner, path, op: "setInterp", times: [time, moment()], ease: random.pick(EASES) },
    { owner, path, op: "setInterp", times: [time], ease: random.pick(EASES) },
    { owner, path, op: "putKeys", keys: [{ time, value, interp: "hold" }] },
    { owner, path, op: "set", value },
    { owner, path, op: "clear" },
  ];
  return random.pick(edits) as object;
}

export function randomCommand(
  store: ProjectStore,
  random: ReturnType<typeof randomFrom>,
): CommandCall {
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
  const sound = random.pick(Object.keys(state.sounds)) ?? "none";
  const file = random.pick(Object.keys(state.files)) ?? "code/none.js";
  const page = { "index.html": `<p>${random.int(9)}</p>`, "a.js": String(random.int(9)) };
  // Two names for one object, so that keys go back and forth between them and land on each other.
  const [from, to] = random.chance(0.5)
    ? ["object.arm", "object.arm_l"]
    : ["object.arm_l", "object.arm"];
  const rename = (renames: readonly object[]): CommandCall => ({
    type: "property.rename",
    params: { timeline, renames },
  });
  // Mostly a clip that has something to rename, or nothing would ever get renamed.
  const withArm = clips.filter((id) =>
    Object.keys(main?.clips[id]?.properties ?? {}).some((path) => path.startsWith("object.arm")),
  );
  const armed = (random.chance(0.8) ? random.pick(withArm) : undefined) ?? clip;
  const join = random.pick(Object.keys(main?.joins ?? {})) ?? "none";
  /** The clip that starts where another ends, on its track: where a join can go. */
  const nextOf = (id: string) => {
    const before = main?.clips[id];
    if (!before) return undefined;
    const end = add(parseTime(before.start), parseTime(before.duration));
    return Object.values(main?.clips ?? {}).find(
      (other) => other.track === before.track && compare(parseTime(other.start), end) === 0,
    )?.id;
  };
  const calls: (() => CommandCall)[] = [
    () => rename([{ owner: { clip: armed }, from: `${from}.*`, to: `${to}.*` }]),
    () =>
      rename([
        {
          owner: { clip: armed },
          from: `${from}.x`,
          to: `${to}.x`,
          scale: random.pick([2, 0.5, -1]),
          offset: random.int(3),
        },
      ]),
    () =>
      rename([
        { owner: { clip: armed }, from: "object.arm.x", to: "object.arm_l.x" },
        { owner: { clip: armed }, from: "object.arm_l.x", to: "object.arm.x" },
      ]),
    () =>
      rename(
        clips
          .filter(() => random.chance(0.3))
          .map((id) => ({ owner: { clip: id }, from: `${from}.*`, to: `${to}.*` })),
      ),
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
      type: "sound.add",
      params: {
        id: random.pick(["n1", "n2", "n3"]),
        sound: { name: "声音", entry: "a.js", runtime: 1 },
        files: { "a.js": String(random.int(9)) },
      },
    }),
    () => ({ type: "sound.update", params: { sound, changes: { name: `n${random.int(9)}` } } }),
    () => ({ type: "sound.remove", params: { sound } }),
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
    () => ({
      type: "clip.add",
      params: {
        timeline,
        track,
        clip: { start: String(random.int(60)), duration: "1", source: { kind: "sound", sound } },
        overlap: "overwrite",
      },
    }),
    () => ({ type: "file.write", params: { path: file, text: `t${random.int(9)}` } }),
    () => ({ type: "file.write", params: { path: `code/f${random.int(3)}.js`, text: "x" } }),
    () => ({
      type: "file.write",
      params: { path: `scenes/${scene}/n${random.int(3)}.js`, text: "x" },
    }),
    () => ({
      type: "file.write",
      params: { path: `sounds/${sound}/n${random.int(3)}.js`, text: "x" },
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
    () => ({
      type: "clip.update",
      params: { timeline, clip, changes: { duration: random.pick(["1/3", "1", "3"]) } },
    }),
    // What comes in and goes out of clips, which trimming, cutting and removing take along.
    () => ({
      type: "clip.setTransition",
      params: {
        timeline,
        clip,
        [random.chance(0.5) ? "enter" : "exit"]: random.chance(0.2)
          ? null
          : {
              type: "fade",
              duration: random.pick(["1/3", "0.5", "1", "2"]),
              ...(random.chance(0.5) && { curve: [0.42, 0, 0.58, 1] }),
            },
      },
    }),
    () => ({
      type: "clip.setTransition",
      params: {
        timeline,
        clip,
        enter: { type: "fade", duration: "1/3" },
        exit: { type: "fade", duration: "1/3" },
      },
    }),
    () => ({ type: "clip.remove", params: { timeline, clips: [clip] } }),
    // Joins: on the cut after a clip, which there often is in the example, changed and taken away.
    () => ({
      type: "join.add",
      params: {
        timeline,
        from: clip,
        to: nextOf(clip) ?? clip,
        ...randomTransition(random),
        ...(random.chance(0.5) && { duration: random.pick(["1/3", "0.5", "1", "3"]) }),
        ...(random.chance(0.3) && { align: random.pick(["center", "before", "after"]) }),
      },
    }),
    () => ({
      type: "join.update",
      params: {
        timeline,
        join,
        changes: random.pick([
          { duration: random.pick(["1/4", "0.5", "1", "2"]) },
          randomTransition(random),
          { align: random.pick(["center", "before", "after"]) },
          { curve: [0.42, 0, 0.58, 1] },
          { curve: null, align: null },
        ]),
      },
    }),
    () => ({ type: "join.remove", params: { timeline, joins: [join] } }),
    // Effects: two people often pick the same id, which only one of them gets, and change what an
    // effect takes while somebody else takes it away.
    () => ({
      type: "effect.add",
      params: {
        timeline,
        clip,
        id: random.pick(["fx1", "fx2", "fx3"]),
        type: random.pick(["brightness", "blur", "crop"]),
        ...(random.chance(0.3) && { index: 0 }),
      },
    }),
    () => ({
      type: "effect.remove",
      params: { timeline, clip, effects: [random.pick(["fx1", "fx2", "fx3"])] },
    }),
    () => ({
      type: "effect.move",
      params: { timeline, clip, effect: random.pick(["fx1", "fx2", "fx3"]), index: random.int(3) },
    }),
    () => ({
      type: "effect.update",
      params: {
        timeline,
        clip,
        effect: random.pick(["fx1", "fx2", "fx3"]),
        enabled: random.chance(0.5),
      },
    }),
    () => ({
      type: "property.edit",
      params: {
        timeline,
        edits: [
          {
            owner: { clip },
            path: random.pick(["effect.fx1.brightness", "effect.fx2.radius", "effect.fx3.left"]),
            value: random.int(10) / 10,
            ...(random.chance(0.5) ? { op: "setKey", time: random.pick(MOMENTS) } : { op: "set" }),
          },
        ],
      },
    }),
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
    () => ({ type: "track.add", params: { timeline, kind: "audio" } }),
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

/** What a join or a transition is, picked from what comes with the editor and what does not. */
export function randomTransition(random: Random): Record<string, unknown> {
  return (
    random.pick<Record<string, unknown>>([
      { type: "fade" },
      { type: "dip", values: { color: random.pick(["#000000", "#ffffff"]) as string } },
      { type: "wipe", values: { direction: random.pick(["left", "up"]) as string } },
      { type: "push", values: { direction: random.pick(["right", "down"]) as string } },
      { type: "plugin.star" },
    ]) ?? { type: "fade" }
  );
}

/** Many rounds each, which takes seconds on a busy machine, with every file at the same time. */
export const FUZZ = { timeout: 60_000 };
