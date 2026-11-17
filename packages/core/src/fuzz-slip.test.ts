import {
  ZERO,
  add,
  compare,
  createProject,
  formatTime,
  joinParts,
  parseTime,
  rational,
  readProject,
  subtract,
  writeProject,
  type Rational,
} from "@animaquill/schema";
import { describe, expect, it } from "vitest";
import {
  FUZZ,
  randomCommand,
  randomFrom,
  replica,
  seedIds,
  sync,
  type Random,
} from "./fuzz-support.ts";
import { clipEnd, clipOffset, clipStart, type ClipState, type TimelineState } from "./model.ts";
import { deepEqual } from "./patch.ts";
import { ProjectStore, type CommandCall } from "./store.ts";

/**
 * Slip, slide and roll at random on timelines of every sort: several tracks of pictures and sounds
 * of media that ends, colours, linked groups with sounds longer or shorter than their pictures,
 * joins, transitions, keyframes, sounds that already overlap. After each edit, what the design
 * asks of them (pro-editing.md, P5): it is all or nothing; no clip shares more time with another
 * than it did; no clip gets lost; what the edit is not about stays as it was, to the letter; a
 * slip keeps where clips are and how long, and moves what they show; a slide moves clips as they
 * are, and their neighbours cover what they did together; a roll keeps the two sides as long
 * together; linked clips that went together stay in step; nothing shows from before its media
 * starts or after it ends; transitions fit their clips; joins either still join or are said to be
 * gone; undo and redo give back exactly what was there. Two devices that do these and other edits
 * at once end up with the same valid project.
 *
 * `FUZZ_SEEDS` runs more or fewer seeds than the 200 of every check.
 */

const SEEDS = Array.from({ length: Number(process.env["FUZZ_SEEDS"] ?? 200) }, (_, i) => i + 1);
const MAIN = "timelines/main/timeline.json";
const FPS = 30n;
/** The media is 20 seconds long. */
const MEDIA_FRAMES = 600;
const frames = (count: number) => rational(BigInt(count), FPS);
const t = (value: Rational) => formatTime(value);
const media = { asset: "file" };
const TRACKS = ["V1", "V2", "A1", "A2"] as const;
const isSound = (track: string) => track.startsWith("A");
const main = (store: ProjectStore): TimelineState => store.getState().timelines["main"]!;
const maxOf = (a: Rational, b: Rational) => (compare(a, b) >= 0 ? a : b);
const minOf = (a: Rational, b: Rational) => (compare(a, b) <= 0 ? a : b);
const isTimeless = (clip: ClipState) => clip.source.kind === "color";
const clockOf = (clip: ClipState) => subtract(clipStart(clip), clipOffset(clip));
const lengthOf = (clip: ClipState) => subtract(clipEnd(clip), clipStart(clip));

interface ClipFile {
  id: string;
  start: string;
  duration: string;
  offset?: string;
  source: object;
  link?: string;
  enter?: object;
  exit?: object;
  properties?: object;
}

/** A timeline of clips mostly right after each other, made at random from a seed. */
function randomProject(random: Random): ProjectStore {
  const files = writeProject(createProject({ name: "随机滑移" }));
  const timeline = JSON.parse(files.get(MAIN) as string);
  const clips: Record<string, ClipFile[]> = { V1: [], V2: [], A1: [], A2: [] };
  const cursors: Record<string, number> = { V1: 0, V2: 0, A1: 0, A2: 0 };
  let made = 0;
  let links = 0;
  /** Where a clip of so long starts on its media: anywhere, now and then right at an end. */
  const randomClock = (duration: number) => {
    const room = MEDIA_FRAMES - duration;
    if (random.chance(0.15)) return 0;
    if (random.chance(0.15)) return room;
    return random.int(room + 1);
  };
  const clipOn = (track: string, start: number, duration: number, link?: string, at?: number) => {
    made += 1;
    const kind = isSound(track) ? "audio" : random.chance(0.3) ? "color" : "video";
    const offset = at ?? (kind === "color" ? random.int(3) * 10 : randomClock(duration));
    const clip: ClipFile = {
      id: `c${made}`,
      start: t(frames(start)),
      duration: t(frames(duration)),
      ...(offset > 0 && { offset: t(frames(offset)) }),
      source: kind === "color" ? { kind: "color", color: "#336699" } : { kind, media },
      ...(link && { link }),
    };
    if (!isSound(track) && duration > 40 && random.chance(0.3)) {
      clip.enter = { type: "fade", duration: "1/3" };
    }
    if (!isSound(track) && duration > 40 && random.chance(0.3)) {
      clip.exit = { type: "fade", duration: "1/2" };
    }
    if (random.chance(0.4)) {
      const path = isSound(track) ? "audio.volume" : "opacity";
      const values = isSound(track) ? [0, -6] : [1, 0.5];
      clip.properties = {
        [path]: {
          keys: [
            { time: t(frames(offset)), value: values[0] },
            { time: t(frames(offset + 10 + random.int(30))), value: values[1] },
          ],
        },
      };
    }
    clips[track]!.push(clip);
  };
  for (let round = 0; round < 30; round++) {
    const gap = random.chance(0.6) ? 0 : 1 + random.int(25);
    const duration = 5 + random.int(50);
    if (random.chance(0.35)) {
      // A picture and its sound on one clock, the sound now and then later, longer or shorter.
      const [picture, sound] = random.chance(0.5) ? ["V1", "A1"] : ["V2", "A2"];
      const start = Math.max(cursors[picture]!, cursors[sound]!) + gap;
      links += 1;
      const link = `l${links}`;
      const clock = randomClock(duration + 20);
      for (const track of [picture, sound] as string[]) {
        const later = track === sound && random.chance(0.3) ? 1 + random.int(6) : 0;
        const longer = track === sound && random.chance(0.4) ? random.int(19) - 9 : 0;
        const own = Math.max(3, duration - later + longer);
        clipOn(track, start + later, own, link, clock + later);
        cursors[track] = start + later + own;
      }
    } else {
      const track = random.pick(TRACKS)!;
      const back = isSound(track) && random.chance(0.15) ? 1 + random.int(10) : 0;
      const start = Math.max(0, cursors[track]! + gap - back);
      clipOn(track, start, duration);
      cursors[track] = Math.max(cursors[track]!, start + duration);
    }
  }
  const joins: { track: string; [key: string]: unknown }[] = [];
  for (const track of ["V1", "V2"]) {
    const list = clips[track]!;
    for (let index = 0; index + 1 < list.length; index++) {
      const [from, to] = [list[index]!, list[index + 1]!];
      const touches =
        compare(add(parseTime(from.start), parseTime(from.duration)), parseTime(to.start)) === 0;
      const roomy = [from, to].every(
        ({ duration }) => compare(parseTime(duration), frames(20)) >= 0,
      );
      if (touches && roomy && random.chance(0.6)) {
        const id = `j${joins.length}`;
        joins.push({ id, from: from.id, to: to.id, type: "fade", duration: "1/3", track });
      }
    }
  }
  const end = Math.max(...Object.values(cursors)) + 60;
  timeline.sections = [{ id: "s1", duration: t(frames(end)) }];
  timeline.tracks = TRACKS.map((id) => {
    const own = joins.filter((join) => join.track === id).map(({ track: _track, ...join }) => join);
    return {
      id,
      kind: isSound(id) ? "audio" : "video",
      clips: clips[id],
      ...(own.length > 0 && { joins: own }),
    };
  });
  files.set(MAIN, JSON.stringify(timeline));
  const assets = JSON.parse(files.get("assets.json") ?? '{"assets":{}}');
  assets.assets.file = {
    kind: "video",
    path: "assets/file.mp4",
    storage: "local",
    hash: "sha256-f",
    info: { duration: t(frames(MEDIA_FRAMES)) },
  };
  files.set("assets.json", JSON.stringify(assets));
  const { store, problems } = ProjectStore.open(files);
  if (!store) throw new Error(JSON.stringify(problems));
  return store;
}

type Kind = "slip" | "slide" | "roll";

interface Step {
  readonly kind: Kind;
  readonly call: CommandCall;
  readonly by: Rational;
}

/** A clip and, mostly, its partners at the same time on other tracks, as the editor lists them. */
function withPartners(timeline: TimelineState, random: Random, first: ClipState): ClipState[] {
  if (!first.link || random.chance(0.3)) return [first];
  const partners = Object.values(timeline.clips).filter(
    (clip) =>
      clip.id !== first.id &&
      clip.link === first.link &&
      clip.track !== first.track &&
      compare(clipStart(clip), clipEnd(first)) < 0 &&
      compare(clipStart(first), clipEnd(clip)) < 0,
  );
  return [first, ...partners.toSorted((a, b) => a.id.localeCompare(b.id))];
}

function randomStep(store: ProjectStore, random: Random): Step {
  const timeline = main(store);
  const ids = Object.keys(timeline.clips).toSorted();
  const first = timeline.clips[random.pick(ids) ?? ""];
  const by = frames(random.int(81) - 40);
  const choice = random.int(3);
  if (!first) {
    return {
      kind: "slip",
      by,
      call: { type: "clip.slip", params: { timeline: "main", clips: ["x"], by: t(by) } },
    };
  }
  const listed = withPartners(timeline, random, first);
  if (choice === 0) {
    const clips = listed.map(({ id }) => id);
    return {
      kind: "slip",
      by,
      call: { type: "clip.slip", params: { timeline: "main", clips, by: t(by) } },
    };
  }
  if (choice === 1) {
    // Now and then the clip right after the first as well, which slides with it as one block.
    const next = Object.values(timeline.clips).find(
      (clip) => clip.track === first.track && compare(clipStart(clip), clipEnd(first)) === 0,
    );
    const more = next && random.chance(0.25) ? [next] : [];
    const clips = [...new Set([...listed, ...more].map(({ id }) => id))];
    return {
      kind: "slide",
      by,
      call: { type: "clip.slide", params: { timeline: "main", clips, by: t(by) } },
    };
  }
  const edge = random.chance(0.5) ? "start" : "end";
  const own = edge === "start" ? clipStart(first) : clipEnd(first);
  const at = maxOf(ZERO, add(own, by));
  const edges = listed.map(({ id }) => ({ clip: id, edge }));
  return {
    kind: "roll",
    by: subtract(at, own),
    call: { type: "clip.roll", params: { timeline: "main", edges, at: t(at) } },
  };
}

function shared(a: ClipState, b: ClipState): Rational {
  const from = maxOf(clipStart(a), clipStart(b));
  const to = minOf(clipEnd(a), clipEnd(b));
  return compare(to, from) > 0 ? subtract(to, from) : ZERO;
}

/** Every transition and join takes no more of a clip than it has. */
function checkTransitionsFit(after: TimelineState, about: unknown): void {
  const joined = new Map<string, Rational>();
  for (const join of Object.values(after.joins ?? {})) {
    const from = after.clips[join.from ?? ""];
    const to = after.clips[join.to ?? ""];
    const transition = join.transition;
    if (!from || !to || !transition || compare(clipEnd(from), clipStart(to)) !== 0) continue;
    const [before, later] = joinParts(parseTime(transition.duration), transition.align);
    joined.set(`${from.id} exit`, before);
    joined.set(`${to.id} enter`, later);
  }
  for (const clip of Object.values(after.clips)) {
    const edge = (name: "enter" | "exit") =>
      joined.get(`${clip.id} ${name}`) ??
      (clip[name] === undefined ? ZERO : parseTime(clip[name]!.duration));
    const total = add(edge("enter"), edge("exit"));
    const fits = compare(total, lengthOf(clip)) <= 0;
    expect(fits, fits ? "" : `${clip.id} ${JSON.stringify({ about, clip })}`).toBe(true);
  }
}

/** Where the keys of a clip are on the timeline, which is what people see. */
function keysOnTimeline(clip: ClipState): string[] {
  return Object.entries(clip.properties ?? {}).flatMap(([path, value]) => {
    const keys = (value as { keys?: { time: string }[] }).keys ?? [];
    return keys.map(({ time }) => `${path}@${t(add(clockOf(clip), parseTime(time)))}`);
  });
}

/** The clips that a step is about, by what happens to them. */
function rolesOf(step: Step, before: TimelineState) {
  const params = step.call.params as {
    clips?: string[];
    edges?: { clip: string; edge: "start" | "end" }[];
  };
  const listed = new Set(params.clips ?? params.edges?.map(({ clip }) => clip) ?? []);
  /** Clips whose edges move with those listed, by which edge. */
  const facing = new Map<string, Set<"start" | "end">>();
  const face = (id: string, edge: "start" | "end") =>
    facing.set(id, new Set([...(facing.get(id) ?? []), edge]));
  if (step.kind === "slide") {
    for (const id of listed) {
      const clip = before.clips[id]!;
      for (const other of Object.values(before.clips)) {
        if (other.track !== clip.track || listed.has(other.id)) continue;
        if (compare(clipEnd(other), clipStart(clip)) === 0) face(other.id, "end");
        if (compare(clipStart(other), clipEnd(clip)) === 0) face(other.id, "start");
      }
    }
  }
  if (step.kind === "roll") {
    for (const { clip: id, edge } of params.edges ?? []) {
      face(id, edge);
      const clip = before.clips[id]!;
      const cut = edge === "start" ? clipStart(clip) : clipEnd(clip);
      for (const other of Object.values(before.clips)) {
        if (other.track !== clip.track || other.id === id) continue;
        const otherEdge = edge === "start" ? "end" : "start";
        const at = otherEdge === "start" ? clipStart(other) : clipEnd(other);
        if (compare(at, cut) === 0) face(other.id, otherEdge);
      }
    }
  }
  return { listed, facing };
}

function checkStep(step: Step, before: TimelineState, after: TimelineState, result: any): void {
  const about = JSON.stringify(step.call.params);
  const { listed, facing } = rolesOf(step, before);
  const { by } = step;

  // 3. No clip gets lost, and none comes.
  expect(Object.keys(after.clips).toSorted()).toEqual(Object.keys(before.clips).toSorted());

  // 2. No clip shares more time with another of its track than it did.
  const all = Object.values(after.clips);
  for (const [index, a] of all.entries()) {
    for (const b of all.slice(index + 1)) {
      if (a.track !== b.track) continue;
      const was = shared(before.clips[a.id]!, before.clips[b.id]!);
      expect(compare(shared(a, b), was), `${a.id} ${b.id} ${about}`).toBeLessThanOrEqual(0);
    }
  }

  // 4. What the edit is not about stays as it was, to the letter.
  for (const clip of Object.values(before.clips)) {
    if (listed.has(clip.id) || facing.has(clip.id)) continue;
    expect(after.clips[clip.id], `${clip.id} ${about}`).toEqual(clip);
  }

  // Nothing shows from before its media starts or after it ends.
  for (const clip of Object.values(after.clips)) {
    if (isTimeless(clip)) continue;
    expect(compare(clipOffset(clip), ZERO), `${clip.id} ${about}`).toBeGreaterThanOrEqual(0);
    const end = add(clipOffset(clip), lengthOf(clip));
    expect(compare(end, frames(MEDIA_FRAMES)), `${clip.id} ${about}`).toBeLessThanOrEqual(0);
  }

  if (step.kind === "slip") {
    // 5. Where and how long stay; what shows, keys too, is `by` further on.
    for (const id of listed) {
      const [was, now] = [before.clips[id]!, after.clips[id]!];
      expect([now.start, now.duration], about).toEqual([was.start, was.duration]);
      expect(keysOnTimeline(now), about).toEqual(
        keysOnTimeline({ ...was, start: t(subtract(clipStart(was), by)) }),
      );
      if (!isTimeless(was)) expect(t(clipOffset(now))).toBe(t(add(clipOffset(was), by)));
    }
  }

  if (step.kind === "slide") {
    // 6. The clips move as they are; each neighbour keeps its far edge and what it shows, and
    // still touches them: together they cover what they did.
    for (const id of listed) {
      const [was, now] = [before.clips[id]!, after.clips[id]!];
      expect(t(clipStart(now)), about).toBe(t(add(clipStart(was), by)));
      expect([now.duration, now.offset, now.properties], about).toEqual([
        was.duration,
        was.offset,
        was.properties,
      ]);
    }
    for (const [id, edges] of facing) {
      const [was, now] = [before.clips[id]!, after.clips[id]!];
      if (!edges.has("start")) expect(now.start, about).toBe(was.start);
      if (!edges.has("end")) expect(t(clipEnd(now)), about).toBe(t(clipEnd(was)));
      if (edges.has("start")) expect(t(clipStart(now)), about).toBe(t(add(clipStart(was), by)));
      if (edges.has("end")) expect(t(clipEnd(now)), about).toBe(t(add(clipEnd(was), by)));
      if (!isTimeless(was)) expect(t(clockOf(now)), about).toBe(t(clockOf(was)));
    }
  }

  if (step.kind === "roll") {
    // 7. Each moved edge goes by as much, the far ones stay, what clips show stays where it was:
    // two clips on a cut are as long together as they were.
    for (const [id, edges] of facing) {
      const [was, now] = [before.clips[id]!, after.clips[id]!];
      const start = edges.has("start") ? add(clipStart(was), by) : clipStart(was);
      const end = edges.has("end") ? add(clipEnd(was), by) : clipEnd(was);
      expect([t(clipStart(now)), t(clipEnd(now))], about).toEqual([t(start), t(end)]);
      if (!isTimeless(was)) expect(t(clockOf(now)), about).toBe(t(clockOf(was)));
    }
    for (const a of facing.keys()) {
      for (const b of facing.keys()) {
        const [wasA, wasB] = [before.clips[a]!, before.clips[b]!];
        if (wasA.track !== wasB.track || compare(clipEnd(wasA), clipStart(wasB)) !== 0) continue;
        if (!facing.get(a)!.has("end") || !facing.get(b)!.has("start")) continue;
        const total = add(lengthOf(wasA), lengthOf(wasB));
        const [nowA, nowB] = [after.clips[a]!, after.clips[b]!];
        expect(t(add(lengthOf(nowA), lengthOf(nowB))), about).toBe(t(total));
        expect(t(clipEnd(nowA)), about).toBe(t(clipStart(nowB)));
      }
    }
  }

  // 8. Linked clips in step stay in step, unless the edit moved what one of them shows and not
  // what the other does, as with Alt.
  const moves = (id: string) => step.kind !== "roll" && listed.has(id);
  for (const a of Object.values(before.clips)) {
    for (const b of Object.values(before.clips)) {
      if (a.id >= b.id || !a.link || a.link !== b.link || isTimeless(a) || isTimeless(b)) continue;
      if (compare(clockOf(a), clockOf(b)) !== 0 || moves(a.id) !== moves(b.id)) continue;
      const [x, y] = [after.clips[a.id]!, after.clips[b.id]!];
      expect(t(clockOf(x)), `${a.id} ${b.id} ${about}`).toBe(t(clockOf(y)));
    }
  }

  // 9. Transitions fit; joins still join, or are said to be gone.
  checkTransitionsFit(after, step.call);
  const said = new Set<string>(result?.joinsRemoved ?? []);
  for (const [id, join] of Object.entries(before.joins ?? {})) {
    const now = after.joins?.[id];
    const [from, to] = [before.clips[join.from ?? ""], before.clips[join.to ?? ""]];
    const together = from && to && compare(clipEnd(from), clipStart(to)) === 0;
    if (!together) continue;
    if (!now) {
      expect(said.has(id), `join ${id} ${about}`).toBe(true);
      continue;
    }
    const [a, b] = [after.clips[now.from ?? ""]!, after.clips[now.to ?? ""]!];
    expect(t(clipEnd(a)), about).toBe(t(clipStart(b)));
  }
}

describe.each(SEEDS)("slip, slide and roll at random, seed %i", FUZZ, (seed) => {
  it("do all or nothing, lose nothing, and keep what they promise", () => {
    seedIds(seed);
    const random = randomFrom(seed);
    const store = randomProject(random);
    checkTransitionsFit(main(store), "the project as it was made");
    const done: Record<Kind, number> = { slip: 0, slide: 0, roll: 0 };
    for (let round = 0; round < 60; round++) {
      const before = structuredClone(main(store));
      const step = randomStep(store, random);
      const result = store.execute(step.call);
      if (!result.ok) {
        // 1. Nothing changed.
        expect(main(store)).toEqual(before);
        continue;
      }
      const after = structuredClone(main(store));
      if (compare(step.by, ZERO) !== 0) done[step.kind] += 1;
      checkStep(step, before, after, result.results[0]);
      // 10. One step back is exactly where it was, and forward again where it got to.
      if (random.chance(0.4) && !deepEqual(before, after)) {
        expect(store.undo().ok).toBe(true);
        expect(main(store)).toEqual(before);
        expect(store.redo().ok).toBe(true);
        expect(main(store)).toEqual(after);
      }
    }
    expect(done.slip + done.slide + done.roll).toBeGreaterThan(0);
    expect(store.exportFiles().problems).toEqual([]);
  });

  it("on two devices at once with other edits, end up the same and valid", () => {
    seedIds(seed);
    const random = randomFrom(seed);
    const a = randomProject(random);
    const b = replica(a);
    for (let round = 0; round < 60; round++) {
      const store = random.chance(0.5) ? a : b;
      if (random.chance(0.1)) store.undo();
      else if (random.chance(0.6)) store.execute(randomStep(store, random).call);
      else store.execute(randomCommand(store, random));
      if (random.chance(0.2)) sync(a, b);
    }
    sync(a, b);
    sync(a, b);
    expect(deepEqual(a.getState(), b.getState())).toBe(true);
    const { files, problems } = a.exportFiles();
    expect(problems).toEqual([]);
    const errors = readProject(files).problems.filter((problem) => problem.severity === "error");
    expect(errors).toEqual([]);
  });
});

/** Over all seeds, every kind of edit gets through often, so that the checks above mean something. */
describe("slip, slide and roll at random", () => {
  it("get through often enough to tell", () => {
    const done: Record<Kind, number> = { slip: 0, slide: 0, roll: 0 };
    for (const seed of SEEDS.slice(0, 20)) {
      seedIds(seed);
      const random = randomFrom(seed);
      const store = randomProject(random);
      for (let round = 0; round < 60; round++) {
        const step = randomStep(store, random);
        if (store.execute(step.call).ok && compare(step.by, ZERO) !== 0) done[step.kind] += 1;
      }
    }
    expect(done.slip).toBeGreaterThan(100);
    expect(done.slide).toBeGreaterThan(100);
    expect(done.roll).toBeGreaterThan(100);
  });
});
