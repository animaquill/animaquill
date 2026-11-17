import {
  Animation as AnimationSchema,
  EASE_PRESET_NAMES,
  add,
  compare,
  createProject,
  divide,
  formatTime,
  isAnimation,
  multiply,
  parseTime,
  rational,
  readProject,
  subtract,
  toSeconds,
  type Animation,
  type Key,
  type PropertyValue,
  type Rational,
} from "@animaquill/schema";
import { afterAll, describe, expect, it } from "vitest";
import { compileChannel, sample } from "./curve.ts";
import { FUZZ, randomFrom, replica, seedIds, sync, type Random } from "./fuzz-support.ts";
import { clipOffset, clipStart, orderedTracks, type TimelineState } from "./model.ts";
import { deepEqual } from "./patch.ts";
import { ProjectStore } from "./store.ts";

/**
 * Stretching, squeezing, moving and reversing keys at random (`retimeKeys`, keyframes-and-fit.md
 * 1.5 and K6): several clips whose clocks are off the timeline by odd amounts, several properties,
 * every way of easing, before and after, shaking; a part of the keys or all of them, on frames or
 * not, mappings that land on other keys, squeeze to nothing or turn around. After each one, what
 * the design asks of it:
 *
 * 1. It is done, or refused as a whole, and then nothing changed.
 * 2. No moved key is lost, and the values are the same ones.
 * 3. The moved keys are in the same order, or exactly the other way round, each where the mapping
 *    takes it (with frames, the nearest frame of the project on the timeline).
 * 4. The other keys stay as they are; only those right where one lands go, and all of them are in
 *    `removed`.
 * 5. Mapping back gives exactly what was there when nothing went and no frames rounded anything,
 *    and reversing twice gives exactly what was there.
 * 6. All keys of a property reversed in place, with only linear, bezier and presets, is the old
 *    curve played backwards: new(a + b − t) = old(t) within 1e-9.
 * 7. Every property it writes is valid in the format: times in order, one at each, handles in range.
 * 8. Undo gives exactly what was there before, redo what was there after; two devices that retime the
 *    same keys at once end up with the same valid project.
 *
 * `FUZZ_SEEDS` runs more or fewer seeds than 200.
 */

const SEEDS = Array.from({ length: Number(process.env["FUZZ_SEEDS"] ?? 200) }, (_, i) => i + 1);
const ROUNDS = 12;
const PATHS = ["transform.x", "transform.y", "transform.rotation", "param.points"] as const;
const RATES = ["30", "24", "30000/1001"] as const;

const counts = {
  interleaved: 0,
  done: 0,
  refused: 0,
  reversed: 0,
  played: 0,
  removed: 0,
  framed: 0,
  back: 0,
};

const main = (store: ProjectStore): TimelineState => store.getState().timelines["main"]!;

/** A number with six decimals, as the editor writes handles. */
const sixDigits = (random: Random, low: number, high: number) =>
  Number((low + (random.int(1_000_001) / 1_000_000) * (high - low)).toFixed(6));

function randomEase(random: Random): Partial<Key> {
  const choice = random.int(10);
  if (choice < 2) return {};
  if (choice === 2) return { interp: "linear" };
  if (choice === 3) return { interp: "hold" };
  if (choice === 4) return { interp: "spring", spring: { stiffness: 100, damping: 8 } };
  if (choice <= 6) {
    return { interp: "bezier", out: [sixDigits(random, 0, 1), sixDigits(random, -1, 2)] };
  }
  const preset = random.chance(0.05)
    ? "wobble"
    : (random.pick(EASE_PRESET_NAMES) as (typeof EASE_PRESET_NAMES)[number]);
  const presetParams = preset.startsWith("steps")
    ? { steps: 1 + random.int(5) }
    : preset.startsWith("elastic") && random.chance(0.5)
      ? { amplitude: 1 + random.int(3) / 2, period: 0.2 + random.int(4) / 10 }
      : undefined;
  return { interp: "preset", preset, ...(presetParams && { presetParams }) };
}

/** Keys mostly on a coarse grid, so that what moves lands on other keys now and then. */
function randomAnimation(random: Random, path: string): Animation {
  const count = 1 + random.int(8);
  const moments = new Map<string, Rational>();
  for (let index = 0; index < count; index += 1) {
    const moment = random.chance(0.8)
      ? rational(BigInt(random.int(16)), 2n)
      : rational(BigInt(random.int(300)), BigInt(1 + random.int(90)));
    moments.set(formatTime(moment), moment);
  }
  const sorted = [...moments.values()].toSorted(compare);
  const keys = sorted.map((moment): Key => {
    const number = () => random.int(2001) / 10 - 100;
    const value = path === "param.points" ? [number(), number()] : number();
    // Arriving handles, which only count after a bezier, and are kept as they are either way.
    const arrival = random.chance(0.3)
      ? { in: [sixDigits(random, 0, 1), sixDigits(random, -1, 2)] as [number, number] }
      : {};
    return { time: formatTime(moment), value, ...arrival, ...randomEase(random) };
  });
  const modes = ["hold", "loop", "pingpong", "continue"] as const;
  const numbers = path !== "param.points";
  const mode = () => random.pick(numbers ? modes : modes.slice(0, 3)) as (typeof modes)[number];
  return {
    keys,
    ...(random.chance(0.3) && { before: mode() }),
    ...(random.chance(0.3) && { after: mode() }),
    ...(random.chance(0.2) && {
      modifiers: [{ type: "noise" as const, amount: 1 + random.int(5), seed: random.int(100) }],
    }),
  };
}

/** Clips on two tracks whose clocks are off the timeline, by frames and by less than that. */
function randomProject(random: Random): ProjectStore {
  const fps = random.pick(RATES) as string;
  const format = { id: "landscape", name: "横屏", width: 1920, height: 1080, fps };
  const store = ProjectStore.create(createProject({ name: "伸缩", format }));
  const tracks = orderedTracks(main(store)).filter(({ kind }) => kind === "video");
  const run = (type: string, params: object) => {
    const result = store.execute({ type, params });
    if (!result.ok) throw new Error(`${result.error.code}: ${JSON.stringify(result.error.params)}`);
  };
  const clips = 1 + random.int(3);
  for (let index = 0; index < clips; index += 1) {
    const offset = random.chance(0.5) ? "0" : `${random.int(60)}/${1 + random.int(90)}`;
    run("clip.add", {
      timeline: "main",
      track: tracks[index % tracks.length]?.id,
      id: `c${index}`,
      start: `${index * 48 + random.int(4)}/${random.chance(0.7) ? 1 : 3}`,
      duration: "11",
      ...(offset !== "0" && { offset }),
      source: { kind: "color", color: "#336699" },
    });
    const edits = PATHS.filter(() => random.chance(0.7)).map((path) => ({
      owner: { clip: `c${index}` },
      path,
      op: "set",
      value: randomAnimation(random, path),
    }));
    if (edits.length > 0) run("property.edit", { timeline: "main", edits });
  }
  return store;
}

interface Chosen {
  readonly clip: string;
  readonly path: string;
  /** From the clock of the clip to the timeline: add this. */
  readonly toTimeline: Rational;
  readonly keys: readonly Key[];
  readonly all: Animation;
  readonly times: readonly string[];
}

function animationsOf(store: ProjectStore) {
  const found: { clip: string; path: string; animation: Animation; toTimeline: Rational }[] = [];
  for (const clip of Object.values(main(store).clips).toSorted((a, b) =>
    a.id.localeCompare(b.id),
  )) {
    const toTimeline = subtract(clipStart(clip), clipOffset(clip));
    for (const [path, value] of Object.entries(clip.properties ?? {}).toSorted(([a], [b]) =>
      a.localeCompare(b),
    )) {
      if (isAnimation(value)) found.push({ clip: clip.id, path, animation: value, toTimeline });
    }
  }
  return found;
}

/** Some keys of some properties, or all of one, or all of everything. */
function randomChoice(store: ProjectStore, random: Random): readonly Chosen[] {
  const all = animationsOf(store);
  const how = random.int(4);
  const one = random.pick(all);
  return all.flatMap(({ clip, path, animation, toTimeline }): Chosen[] => {
    const keys =
      how === 0
        ? animation.keys
        : how === 1
          ? one?.clip === clip && one.path === path
            ? animation.keys
            : []
          : animation.keys.filter(() => random.chance(how === 2 ? 0.5 : 0.25));
    if (keys.length === 0) return [];
    return [{ clip, path, toTimeline, keys, all: animation, times: keys.map(({ time }) => time) }];
  });
}

const timelineOf = (chosen: Chosen, key: Key) => add(parseTime(key.time), chosen.toTimeline);

function span(choice: readonly Chosen[]): [Rational, Rational] {
  const moments = choice.flatMap((chosen) => chosen.keys.map((key) => timelineOf(chosen, key)));
  const sorted = moments.toSorted(compare);
  return [sorted[0] as Rational, sorted.at(-1) as Rational];
}

/** Where on the timeline `[a, b]` goes: stretched, squeezed, moved or turned around, by chance. */
function randomMapping(random: Random, [first, last]: [Rational, Rational], rate: Rational) {
  const length = compare(first, last) === 0 ? rational(1n) : subtract(last, first);
  const frame = divide(rational(1n), rate);
  const [a, b] = [first, add(first, length)];
  const factor = random.pick([
    rational(2n),
    rational(1n, 2n),
    rational(3n, 2n),
    rational(-1n),
    rational(-2n),
    rational(-1n, 3n),
    rational(1n, 100n),
    rational(-1n, 100n),
    rational(1n),
  ]) as Rational;
  const stretched = multiply(length, factor);
  const kind = random.int(4);
  // From the start, from the end, turned around in place, or moved somewhere as well.
  if (kind === 0) return { from: [a, b], to: [a, add(a, stretched)] } as const;
  if (kind === 1) return { from: [a, b], to: [subtract(b, stretched), b] } as const;
  if (kind === 2) return { from: [a, b], to: [b, a] } as const;
  const by = multiply(frame, rational(BigInt(random.int(61) - 30)));
  return { from: [a, b], to: [add(a, by), add(add(a, by), stretched)] } as const;
}

const mapped = (moment: Rational, [a, b]: readonly Rational[], [c, d]: readonly Rational[]) =>
  add(c!, divide(multiply(subtract(moment, a!), subtract(d!, c!)), subtract(b!, a!)));

/** The nearest frame, halves up, on the timeline. */
function nearestFrame(moment: Rational, rate: Rational): Rational {
  const { n, d } = multiply(moment, rate);
  const twice = 2n * n + d;
  const below = twice / (2n * d) - (twice < 0n && twice % (2n * d) !== 0n ? 1n : 0n);
  return divide(rational(below), rate);
}

/** Where a key goes, on the clock of its clip. */
function expectedTime(
  chosen: Chosen,
  key: Key,
  mapping: ReturnType<typeof randomMapping>,
  frames: boolean,
  rate: Rational,
): string {
  const moment = mapped(timelineOf(chosen, key), mapping.from, mapping.to);
  const landed = frames ? nearestFrame(moment, rate) : moment;
  return formatTime(subtract(landed, chosen.toTimeline));
}

function editsOf(
  choice: readonly Chosen[],
  mapping: { readonly from: readonly Rational[]; readonly to: readonly Rational[] },
  frames: boolean,
) {
  const clock = (chosen: Chosen, moment: Rational) =>
    formatTime(subtract(moment, chosen.toTimeline));
  return choice.map((chosen) => ({
    owner: { clip: chosen.clip },
    path: chosen.path,
    op: "retimeKeys",
    times: chosen.times,
    from: mapping.from.map((moment) => clock(chosen, moment)),
    to: mapping.to.map((moment) => clock(chosen, moment)),
    ...(frames && { frames: true }),
  }));
}

const retime = (store: ProjectStore, edits: readonly object[]) =>
  store.execute({ type: "property.edit", params: { timeline: "main", edits } });

const valueOf = (store: ProjectStore, clip: string, path: string): PropertyValue | undefined =>
  main(store).clips[clip]?.properties?.[path];

const onlyCurve = (animation: Animation): Animation => {
  const { modifiers: _modifiers, ...rest } = animation;
  return rest;
};

const PLAYS_BACK = new Set([undefined, "linear", "bezier", "preset"]);

function checkWritten(value: PropertyValue | undefined): void {
  expect(isAnimation(value as never)).toBe(true);
  const animation = value as Animation;
  expect(AnimationSchema.safeParse(animation).success).toBe(true);
  const times = animation.keys.map(({ time }) => parseTime(time));
  times.slice(1).forEach((time, index) => {
    expect(compare(times[index] as Rational, time)).toBeLessThan(0);
  });
  for (const key of animation.keys) {
    for (const handle of [key.out, key.in]) {
      if (handle) expect(handle[0] >= 0 && handle[0] <= 1).toBe(true);
    }
  }
}

function within(actual: unknown, expected: unknown): boolean {
  if (typeof actual === "number" && typeof expected === "number") {
    // 1e-9 of the value: times far along the clock already lose that much as floats.
    return Math.abs(actual - expected) <= 1e-9 * Math.max(1, Math.abs(expected));
  }
  if (Array.isArray(actual) && Array.isArray(expected)) {
    return (
      actual.length === expected.length && actual.every((part, i) => within(part, expected[i]))
    );
  }
  return deepEqual(actual, expected);
}

/** Invariant 6: the keys of each property that were all reversed in place play backwards. */
function checkPlayedBackwards(
  before: readonly Chosen[],
  store: ProjectStore,
  mapping: ReturnType<typeof randomMapping>,
  random: Random,
): void {
  const [a, b] = mapping.from as readonly [Rational, Rational];
  for (const chosen of before) {
    if (chosen.keys.length !== chosen.all.keys.length) continue;
    if (!chosen.all.keys.every((key) => PLAYS_BACK.has(key.interp))) continue;
    const type = chosen.path === "param.points" ? "numbers" : "number";
    const old = compileChannel(onlyCurve(chosen.all), type);
    const now = compileChannel(onlyCurve(valueOf(store, chosen.clip, chosen.path) as never), type);
    if (!old || !now) throw new Error("no channel");
    // The mirror of the timeline, on the clock of the clip: a + b − t.
    const mirror = toSeconds(subtract(add(a, b), multiply(chosen.toTimeline, rational(2n))));
    const first = toSeconds(parseTime(chosen.keys[0]!.time));
    const last = toSeconds(parseTime(chosen.keys.at(-1)!.time));
    for (let step = 0; step < 50; step += 1) {
      const t = first + (random.int(1_000_000) / 1_000_000) * (last - first);
      const was = sample(old, t);
      const is = sample(now, mirror - t);
      if (!within(is, was)) {
        throw new Error(
          `${chosen.clip} ${chosen.path} at ${t}: ${String(is)} is not ${String(was)}`,
        );
      }
    }
    counts.played += 1;
  }
}

/** Another edit of keys or of a clip: a key moved, easing changed, the clip trimmed. */
function otherEdit(store: ProjectStore, random: Random) {
  const one = random.pick(animationsOf(store));
  const timeline = "main";
  if (!one || random.chance(0.25)) {
    const clip = random.pick(Object.keys(main(store).clips)) ?? "none";
    const side = random.chance(0.5)
      ? { start: `${random.int(40)}/3` }
      : { end: `${20 + random.int(200)}/3` };
    return { type: "clip.trim", params: { timeline, clip, ...side } };
  }
  const { clip, path, animation } = one;
  const key = random.pick(animation.keys) as Key;
  const owner = { clip };
  const edit = random.chance(0.5)
    ? { owner, path, op: "moveKey", moves: [{ from: key.time, to: `${random.int(60)}/4` }] }
    : {
        owner,
        path,
        op: "setInterp",
        times: [key.time],
        ease: random.pick([
          { interp: "hold" },
          { interp: "bezier", out: [0.3, 1.2], in: [0.6, 0.9] },
          { interp: "preset", preset: "elasticOut" },
          { interp: "linear" },
        ]),
      };
  return { type: "property.edit", params: { timeline, edits: [edit] } };
}

describe.each(SEEDS)("retiming keys at random, seed %i", (seed) => {
  it("keeps every promise of the design", FUZZ, () => {
    seedIds(seed);
    const random = randomFrom(seed);
    const store = randomProject(random);
    const rate = parseTime(store.getState().manifest.fps as string);
    for (let round = 0; round < ROUNDS; round += 1) {
      const choice = randomChoice(store, random);
      if (choice.length === 0) continue;
      const mapping = randomMapping(random, span(choice), rate);
      const frames = random.chance(0.5);
      const before = structuredClone(store.getState());
      const result = retime(store, editsOf(choice, mapping, frames));

      // 1. All or nothing; two moved keys of a property on one frame is what it says.
      const collides = choice.some((chosen) => {
        const landed = chosen.keys.map((key) => expectedTime(chosen, key, mapping, frames, rate));
        return new Set(landed).size < landed.length;
      });
      if (!result.ok) {
        counts.refused += 1;
        expect(deepEqual(store.getState(), before)).toBe(true);
        if (collides) expect(result.error.params).toMatchObject({ rule: "keys-collide" });
        else expect(result.error.params).not.toMatchObject({ rule: "keys-collide" });
        continue;
      }
      expect(collides).toBe(false);
      counts.done += 1;
      if (frames) counts.framed += 1;
      const after = structuredClone(store.getState());
      const reported =
        (result.results[0] as { removed?: { clip: string; path: string; times: string[] }[] })
          ?.removed ?? [];
      const reversed =
        compare(mapping.to[1] as Rational, mapping.to[0] as Rational) < 0 !==
        compare(mapping.from[1] as Rational, mapping.from[0] as Rational) < 0;
      if (reversed) counts.reversed += 1;

      for (const chosen of choice) {
        const now = valueOf(store, chosen.clip, chosen.path) as Animation;
        // 7. Valid in the format.
        checkWritten(now);
        const byTime = new Map(now.keys.map((key) => [key.time, key]));
        // 2 and 3. Every moved key where the mapping takes it, with its value, in order or reversed.
        const landed = chosen.keys.map((key) => expectedTime(chosen, key, mapping, frames, rate));
        for (const [index, key] of chosen.keys.entries()) {
          const there = byTime.get(landed[index] as string);
          expect(there?.value).toEqual(key.value);
        }
        const order = landed.map((time) => parseTime(time));
        order.slice(1).forEach((moment, index) => {
          expect(compare(order[index] as Rational, moment)).toBe(reversed ? 1 : -1);
        });
        // 4. The rest stays, apart from what is right where one landed, which is said.
        const landing = new Set(landed);
        const chosenTimes = new Set(chosen.times);
        const gone = reported.find(
          ({ clip, path }) => clip === chosen.clip && path === chosen.path,
        );
        const expectedGone: string[] = [];
        for (const key of chosen.all.keys) {
          if (chosenTimes.has(key.time)) continue;
          if (landing.has(key.time)) expectedGone.push(key.time);
          else expect(byTime.get(key.time)).toEqual(key);
        }
        expect(gone?.times ?? []).toEqual(expectedGone);
        if (expectedGone.length > 0) counts.removed += 1;
        expect(now.keys).toHaveLength(chosen.all.keys.length - expectedGone.length);
        // Shaking stays; before and after turn around only when all keys do.
        expect(now.modifiers).toEqual(chosen.all.modifiers);
        const turned = reversed && chosen.keys.length === chosen.all.keys.length;
        expect(now.before).toEqual(turned ? chosen.all.after : chosen.all.before);
        expect(now.after).toEqual(turned ? chosen.all.before : chosen.all.after);
      }

      // 6. Played backwards.
      const inPlace =
        !frames &&
        compare(mapping.to[0] as Rational, mapping.from[1] as Rational) === 0 &&
        compare(mapping.to[1] as Rational, mapping.from[0] as Rational) === 0;
      if (inPlace) checkPlayedBackwards(choice, store, mapping, random);

      // 8. Undo and redo.
      // What changes nothing leaves no step, and undo would take back the one before.
      const changed = !deepEqual(after, before);
      if (changed) {
        expect(store.undo().ok).toBe(true);
        expect(deepEqual(store.getState(), before)).toBe(true);
        expect(store.redo().ok).toBe(true);
        expect(deepEqual(store.getState(), after)).toBe(true);
      }

      // 5. Back again, when nothing went and nothing was rounded; reversing is its own way back.
      if (!frames && reported.length === 0) {
        const moved = choice.map((chosen) => ({
          ...chosen,
          times: chosen.keys.map((key) => expectedTime(chosen, key, mapping, false, rate)),
        }));
        const back = retime(store, editsOf(moved, { from: mapping.to, to: mapping.from }, false));
        expect(back.ok).toBe(true);
        expect(deepEqual(store.getState(), before)).toBe(true);
        counts.back += 1;
        if (inPlace) {
          retime(store, editsOf(choice, mapping, false));
          const twice = retime(store, editsOf(moved, mapping, false));
          expect(twice.ok).toBe(true);
          expect(deepEqual(store.getState(), before)).toBe(true);
        }
        // Go on from where it was after, so that later rounds start from more mixed up keys.
        if (random.chance(0.5)) retime(store, editsOf(choice, mapping, false));
      }
    }
  });

  it(
    "other edits after a retime, taken back one by one, come back to exactly what was there",
    FUZZ,
    () => {
      seedIds(seed);
      const random = randomFrom(seed + 20_000);
      const store = randomProject(random);
      const rate = parseTime(store.getState().manifest.fps as string);
      for (let round = 0; round < 4; round += 1) {
        const choice = randomChoice(store, random);
        if (choice.length === 0) continue;
        const before = structuredClone(store.getState());
        const mapping = randomMapping(random, span(choice), rate);
        const done = retime(store, editsOf(choice, mapping, random.chance(0.5)));
        if (!done.ok || deepEqual(store.getState(), before)) continue;
        let steps = 1;
        for (let more = 1 + random.int(5); more > 0; more -= 1) {
          const was = store.getState();
          const result = store.execute(otherEdit(store, random));
          if (result.ok && !deepEqual(store.getState(), was)) steps += 1;
        }
        for (; steps > 0; steps -= 1) expect(store.undo().ok).toBe(true);
        expect(deepEqual(store.getState(), before)).toBe(true);
        counts.interleaved += 1;
      }
    },
  );

  it(
    "two devices that retime the same keys at once end up with the same valid project",
    FUZZ,
    () => {
      seedIds(seed);
      const random = randomFrom(seed + 10_000);
      const a = randomProject(random);
      const b = replica(a);
      const rate = parseTime(a.getState().manifest.fps as string);
      for (const store of [a, b]) {
        const choice = randomChoice(store, random);
        if (choice.length === 0) continue;
        retime(
          store,
          editsOf(choice, randomMapping(random, span(choice), rate), random.chance(0.5)),
        );
      }
      sync(a, b);
      sync(a, b);
      expect(deepEqual(a.getState(), b.getState())).toBe(true);
      const { files, problems } = a.exportFiles();
      expect(problems).toEqual([]);
      const errors = readProject(files).problems.filter(({ severity }) => severity === "error");
      expect(errors).toEqual([]);
      for (const { animation } of animationsOf(a)) checkWritten(animation);
    },
  );
});

// Over all seeds that ran: with fewer than the usual 200 these are fewer as well.
afterAll(() => {
  {
    const share = SEEDS.length / 200;
    expect(counts.done).toBeGreaterThan(600 * share);
    expect(counts.refused).toBeGreaterThan(200 * share);
    expect(counts.reversed).toBeGreaterThan(300 * share);
    expect(counts.played).toBeGreaterThan(30 * share);
    expect(counts.removed).toBeGreaterThan(15 * share);
    expect(counts.framed).toBeGreaterThan(300 * share);
    expect(counts.back).toBeGreaterThan(300 * share);
    expect(counts.interleaved).toBeGreaterThan(200 * share);
  }
});
