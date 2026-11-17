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
import { Draft } from "./draft.ts";
import {
  FUZZ,
  checkJoinsKept,
  randomCommand,
  randomFrom,
  replica,
  seedIds,
  sync,
  type Random,
} from "./fuzz-support.ts";
import {
  clipEnd,
  clipOffset,
  clipStart,
  timelineLength,
  type ClipState,
  type TimelineState,
} from "./model.ts";
import { deepEqual } from "./patch.ts";
import { closeGaps, mergeSpans, openGap } from "./ripple-edits.ts";
import { placedSections } from "./section-edits.ts";
import { ProjectStore, USER, type CommandCall } from "./store.ts";

/**
 * Ripple edits at random on timelines of every sort: several tracks of pictures and sounds,
 * linked groups, joins, transitions, keyframes, sections and markers, sounds that already overlap,
 * and tracks that take no part. After each edit, what the design asks of them (pro-editing.md,
 * P3a): it is all or nothing; no new overlaps; no clip gets lost, and each part shows what it did;
 * linked clips stay in step; tracks that take no part stay as they were, to the letter; clips keep
 * their order; sections and markers move by what was taken out; joins either still join or are
 * said to be gone; properties and keyframes stay; undo and redo give back exactly what was there.
 * Putting a stretch in and taking it out again leaves everything where it was. Two devices that do
 * ripple edits and other edits at once end up with the same valid project.
 *
 * `FUZZ_SEEDS` runs more or fewer seeds than the 200 of every check.
 */

const SEEDS = Array.from({ length: Number(process.env["FUZZ_SEEDS"] ?? 200) }, (_, i) => i + 1);
const MAIN = "timelines/main/timeline.json";
const FPS = 30n;
const frames = (count: number) => rational(BigInt(count), FPS);
const t = (value: Rational) => formatTime(value);
const media = { asset: "file" };
const TRACKS = ["V1", "V2", "A1", "A2", "C1"] as const;
const isSound = (track: string) => track.startsWith("A");
const isCaption = (track: string) => track.startsWith("C");

const main = (store: ProjectStore): TimelineState => store.getState().timelines["main"]!;
const maxOf = (a: Rational, b: Rational) => (compare(a, b) >= 0 ? a : b);
const minOf = (a: Rational, b: Rational) => (compare(a, b) <= 0 ? a : b);

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

/** A timeline of 4 to 14 seconds on frames, made at random from a seed. */
function randomProject(random: Random): ProjectStore {
  const files = writeProject(createProject({ name: "随机波纹" }));
  const timeline = JSON.parse(files.get(MAIN) as string);
  const sections = Array.from({ length: 1 + random.int(4) }, (_, index) => ({
    id: `s${index}`,
    duration: t(frames(30 + random.int(90))),
  }));
  const length = sections.reduce((sum, { duration }) => add(sum, parseTime(duration)), ZERO);
  const lengthFrames = Number((length.n * FPS) / length.d);
  const clips: Record<string, ClipFile[]> = { V1: [], V2: [], A1: [], A2: [], C1: [] };
  const cursors: Record<string, number> = { V1: 0, V2: 0, A1: 0, A2: 0, C1: 0 };
  let made = 0;
  let links = 0;
  const clipOn = (
    track: string,
    start: number,
    duration: number,
    link?: string,
    clock?: number,
  ): ClipFile => {
    made += 1;
    // In a group, one clock for all: the same moment of the file at the same moment.
    const offset = clock === undefined ? random.int(3) * 15 : start - clock;
    // Pictures of a group are videos; others can be colours or pictures, which have no beginning.
    const choice = random.int(20);
    const kind = isSound(track)
      ? "audio"
      : isCaption(track)
        ? "caption"
        : link !== undefined || choice >= 9
          ? "video"
          : choice < 6
            ? "color"
            : "image";
    const source =
      kind === "color"
        ? { kind: "color", color: "#336699" }
        : kind === "image"
          ? { kind: "image", media: { asset: "pic" } }
          : kind === "caption"
            ? { kind: "caption", text: "字幕" }
            : { kind, media };
    const clip: ClipFile = {
      id: `c${made}`,
      start: t(frames(start)),
      duration: t(frames(duration)),
      ...((kind === "video" || kind === "audio") && offset > 0 && { offset: t(frames(offset)) }),
      source,
      ...(link && { link }),
    };
    const fades = !isSound(track) && !isCaption(track);
    if (fades && duration > 40 && random.chance(0.3)) {
      clip.enter = { type: "fade", duration: "1/3" };
    }
    if (fades && duration > 40 && random.chance(0.3)) {
      clip.exit = { type: "fade", duration: "1/2" };
    }
    if (!isCaption(track) && random.chance(0.4)) {
      const path = isSound(track) ? "audio.volume" : "opacity";
      const values = isSound(track) ? [0, -6] : [1, 0.5];
      clip.properties = {
        [path]: {
          keys: [
            { time: "0", value: values[0] },
            { time: t(frames(10 + random.int(30))), value: values[1] },
          ],
        },
      };
    }
    clips[track]!.push(clip);
    return clip;
  };
  for (let round = 0; round < 40; round++) {
    const gap = random.chance(0.4) ? 0 : 1 + random.int(25);
    const duration = 5 + random.int(50);
    if (random.chance(0.35)) {
      // A linked group: a picture and its sound, sometimes a second sound. A sound can start
      // later and end earlier or later than the picture (J and L cuts), on the same clock.
      const [picture, sound] = random.chance(0.5) ? ["V1", "A1"] : ["V2", "A2"];
      const third = random.chance(0.2) ? (sound === "A1" ? "A2" : "A1") : undefined;
      const members = [picture, sound, ...(third ? [third] : [])] as string[];
      const start = Math.max(...members.map((track) => cursors[track]!)) + gap;
      if (start + duration + 12 > lengthFrames) continue;
      links += 1;
      const link = `l${links}`;
      const clock = start - random.int(3) * 15;
      for (const track of members) {
        const later = track !== picture && random.chance(0.3) ? 1 + random.int(6) : 0;
        const longer = track !== picture && random.chance(0.4) ? random.int(19) - 9 : 0;
        const own = Math.max(3, duration - later + longer);
        clipOn(track, start + later, own, link, clock);
        cursors[track] = start + later + own;
      }
    } else {
      const track = random.pick(TRACKS)!;
      // Sounds can be on top of each other already: the format lets them.
      const back = isSound(track) && random.chance(0.15) ? 1 + random.int(10) : 0;
      const start = Math.max(0, cursors[track]! + gap - back);
      if (start + duration > lengthFrames) continue;
      clipOn(track, start, duration);
      cursors[track] = Math.max(cursors[track]!, start + duration);
    }
  }
  const joins: object[] = [];
  // Joins between pictures and between sounds, in the middle of their cut or all on one side.
  for (const track of ["V1", "V2", "A1", "A2"]) {
    const list = clips[track]!;
    for (let index = 0; index + 1 < list.length; index++) {
      const [from, to] = [list[index]!, list[index + 1]!];
      const touches =
        compare(add(parseTime(from.start), parseTime(from.duration)), parseTime(to.start)) === 0;
      // Room for a join on both sides and what else is at their edges, as the editor makes them.
      const roomy = [from, to].every(
        ({ duration }) => compare(parseTime(duration), frames(20)) >= 0,
      );
      if (touches && roomy && random.chance(0.6)) {
        joins.push({
          id: `j${joins.length}`,
          from: from.id,
          to: to.id,
          type: "fade",
          duration: "1/3",
          ...(random.chance(0.4) && { align: random.chance(0.5) ? "before" : "after" }),
          track,
        });
      }
    }
  }
  timeline.sections = sections;
  timeline.markers = Array.from({ length: random.int(6) }, (_, index) => ({
    id: `m${index}`,
    time: t(frames(random.int(lengthFrames + 1))),
    ...(random.chance(0.4) && { duration: t(frames(1 + random.int(60))) }),
  }));
  timeline.tracks = TRACKS.map((id) => ({
    id,
    kind: isSound(id) ? "audio" : isCaption(id) ? "caption" : "video",
    clips: clips[id],
    ...(joins.some((join) => (join as { track: string }).track === id) && {
      joins: joins
        .filter((join) => (join as { track: string }).track === id)
        .map(({ track: _track, ...join }: any) => join),
    }),
  }));
  files.set(MAIN, JSON.stringify(timeline));
  const assets = JSON.parse(files.get("assets.json") ?? '{"assets":{}}');
  assets.assets.pic = { kind: "image", path: "assets/pic.png", storage: "local", hash: "sha256-p" };
  files.set("assets.json", JSON.stringify(assets));
  const { store, problems } = ProjectStore.open(files);
  if (!store) throw new Error(JSON.stringify(problems));
  return store;
}

/** Moments on frames from the start to the end. */
function momentIn(random: Random, timeline: TimelineState): Rational {
  const length = timelineLength(timeline);
  const last = Number((length.n * FPS) / length.d);
  return frames(random.int(last + 1));
}

/** Tracks that take part, or all of them (undefined). */
function someTracks(random: Random): readonly string[] | undefined {
  if (random.chance(0.4)) return undefined;
  const tracks = TRACKS.filter(() => random.chance(0.6));
  return tracks.length > 0 ? tracks : ["V1"];
}

/** Stretches where nothing is on the tracks that take part, for edits that get through. */
function freeStretches(timeline: TimelineState, tracks: readonly string[] | undefined) {
  const taken = Object.values(timeline.clips)
    .filter((clip) => tracks === undefined || tracks.includes(clip.track))
    .map((clip) => ({ from: clipStart(clip), to: clipEnd(clip) }));
  const busy = mergeSpans(taken);
  const free: { from: Rational; to: Rational }[] = [];
  let at = ZERO;
  for (const span of busy) {
    if (compare(span.from, at) > 0) free.push({ from: at, to: span.from });
    at = maxOf(at, span.to);
  }
  const length = timelineLength(timeline);
  if (compare(length, at) > 0) free.push({ from: at, to: length });
  return free;
}

type Step = {
  readonly call: CommandCall;
  readonly kind: "close" | "remove" | "range" | "other" | "open" | "add" | "moveInsert" | "trim";
};

/** Ids of a clip and, mostly, of its partners, as the editor lists them. */
function withPartners(timeline: TimelineState, random: Random, first: string): string[] {
  const link = timeline.clips[first]?.link;
  if (!link || !random.chance(0.7)) return [first];
  const ids = Object.keys(timeline.clips).toSorted();
  return ids.filter((id) => id === first || timeline.clips[id]?.link === link);
}

/** Inserting and ripple trimming, which put time in or take it out around what they change. */
function randomRoomStep(store: ProjectStore, random: Random, choice: number): Step {
  const timeline = main(store);
  const rippleTracks = someTracks(random);
  const tracksParam = rippleTracks ? { rippleTracks } : {};
  const ids = Object.keys(timeline.clips).toSorted();
  const length = timelineLength(timeline);
  if (choice === 0) {
    return {
      kind: "open",
      call: {
        type: "timeline.openGap",
        params: {
          timeline: "main",
          at: t(random.chance(0.05) ? add(length, frames(1)) : momentIn(random, timeline)),
          duration: t(frames(1 + random.int(90))),
          ...tracksParam,
        },
      },
    };
  }
  if (choice === 1) {
    const track = random.pick(TRACKS)!;
    const past = random.chance(0.1) ? add(length, frames(random.int(30))) : undefined;
    return {
      kind: "add",
      call: {
        type: "clip.add",
        params: {
          timeline: "main",
          track,
          start: t(past ?? momentIn(random, timeline)),
          duration: t(frames(1 + random.int(60))),
          source: isSound(track) ? { kind: "audio", media } : { kind: "color", color: "#884422" },
          overlap: "insert",
          ...tracksParam,
        },
      },
    };
  }
  if (choice === 2) {
    const group = withPartners(timeline, random, random.pick(ids) ?? "none");
    const by = frames(random.int(121) - 60);
    // Now and then a single clip to the other track of its kind.
    const across = group.length === 1 && random.chance(0.3);
    return {
      kind: "moveInsert",
      call: {
        type: "clip.move",
        params: {
          timeline: "main",
          clips: group.map((id) => {
            const clip = timeline.clips[id];
            const other = clip && { V1: "V2", V2: "V1", A1: "A2", A2: "A1" }[clip.track];
            return {
              clip: id,
              start: t(maxOf(ZERO, add(parseTime(clip?.start ?? "0"), by))),
              ...(across && other && { track: other }),
            };
          }),
          overlap: "insert",
          ...tracksParam,
        },
      },
    };
  }
  // A ripple trim of one edge, with its partners as the editor lists them (their edges can be
  // elsewhere, as a sound longer or shorter than its picture), or alone, as with Alt or an AI that
  // leaves them out. Mostly a clip of a group: that is where they come apart if anything goes wrong.
  const linked = ids.filter((id) => timeline.clips[id]?.link !== undefined);
  const first = random.pick(random.chance(0.7) && linked.length > 0 ? linked : ids) ?? "none";
  const clip = timeline.clips[first];
  const edge = random.chance(0.5) ? "start" : "end";
  const edgeOf = (each: ClipState) => (edge === "start" ? clipStart(each) : clipEnd(each));
  const group = clip?.link
    ? ids.filter((id) => id !== first && timeline.clips[id]?.link === clip.link)
    : [];
  // All of them, as the editor lists them, or some or none, as Alt or an AI that leaves them out.
  const partners = random.chance(0.5) ? group : group.filter(() => random.chance(0.4));
  // Sometimes another clip as well, which is trimmed by as much.
  const stray = random.chance(0.05) ? [random.pick(ids) ?? first] : [];
  const together = [...new Set([...partners, ...stray])].filter((id) => id !== first);
  let at = ZERO;
  if (clip) {
    const by = frames(random.int(121) - 60);
    at = add(edgeOf(clip), by);
    const [low, high] =
      edge === "start"
        ? [ZERO, subtract(clipEnd(clip), frames(1))]
        : [add(clipStart(clip), frames(1)), add(clipEnd(clip), frames(120))];
    at = maxOf(low, minOf(high, at));
  }
  return {
    kind: "trim",
    call: {
      type: "clip.trim",
      params: {
        timeline: "main",
        clip: first,
        [edge]: t(at),
        ...(together.length > 0 && { together }),
        ripple: true,
        ...tracksParam,
      },
    },
  };
}

/** Edits that put time in or take it out around what they change themselves, see `checkRoom`. */
const ROOM = new Set<Step["kind"]>(["open", "add", "moveInsert", "trim"]);

function randomStep(store: ProjectStore, random: Random): Step {
  const timeline = main(store);
  const rippleTracks = someTracks(random);
  const tracksParam = rippleTracks ? { rippleTracks } : {};
  const choice = random.int(18);
  if (choice >= 10) return randomRoomStep(store, random, Math.floor((choice - 10) / 2));
  if (choice < 4) {
    const free = freeStretches(timeline, rippleTracks);
    const ranges = Array.from({ length: 1 + random.int(3) }, () => {
      const stretch = random.chance(0.75) ? random.pick(free) : undefined;
      let from = stretch?.from ?? momentIn(random, timeline);
      let to = stretch?.to ?? momentIn(random, timeline);
      if (compare(from, to) > 0) [from, to] = [to, from];
      if (compare(from, to) === 0) to = add(to, frames(1));
      return { from: t(from), to: t(to) };
    });
    return {
      kind: "close",
      call: { type: "timeline.closeGap", params: { timeline: "main", ranges, ...tracksParam } },
    };
  }
  if (choice < 7) {
    const ids = Object.keys(timeline.clips).toSorted();
    const first = random.pick(ids) ?? "none";
    const link = timeline.clips[first]?.link;
    // As the editor selects: with the partners, or alone as with Alt.
    const partners =
      link && random.chance(0.7)
        ? ids.filter((id) => timeline.clips[id]?.link === link && id !== first)
        : [];
    const more = random.chance(0.2) ? [random.pick(ids) ?? first] : [];
    const clips = [...new Set([first, ...partners, ...more])];
    return {
      kind: "remove",
      call: {
        type: "clip.remove",
        params: { timeline: "main", clips, ripple: true, ...tracksParam },
      },
    };
  }
  if (choice < 9) {
    let from = momentIn(random, timeline);
    let to = momentIn(random, timeline);
    if (compare(from, to) > 0) [from, to] = [to, from];
    if (compare(from, to) === 0) to = add(to, frames(1));
    return {
      kind: "range",
      call: {
        type: "timeline.removeRange",
        params: {
          timeline: "main",
          from: t(from),
          to: t(to),
          ...(rippleTracks && { tracks: rippleTracks }),
          ...(random.chance(0.5) && { ripple: true }),
        },
      },
    };
  }
  // Dropping a linked group over another, which cuts what is under it.
  const ids = Object.keys(timeline.clips).toSorted();
  const clip = timeline.clips[random.pick(ids) ?? "none"];
  const group = clip?.link
    ? ids.filter((id) => timeline.clips[id]?.link === clip.link)
    : clip
      ? [clip.id]
      : [];
  const by = frames(random.int(61) - 30);
  return {
    kind: "other",
    call: {
      type: "clip.move",
      params: {
        timeline: "main",
        clips: group.map((id) => ({
          clip: id,
          start: t(maxOf(ZERO, add(parseTime(timeline.clips[id]!.start), by))),
        })),
        overlap: "overwrite",
      },
    },
  };
}

function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const name = key(item);
    const group = groups.get(name);
    if (group) group.push(item);
    else groups.set(name, [item]);
  }
  return groups;
}

/**
 * How much time clips on one track share, pair by pair. Cutting two sounds that already overlap
 * makes more pairs, never more shared time.
 */
function overlapsOn(timeline: TimelineState): ReadonlyMap<string, Rational> {
  const totals = new Map<string, Rational>();
  const byTrack = groupBy(Object.values(timeline.clips), ({ track }) => track);
  for (const [track, clips] of byTrack) {
    let total = ZERO;
    for (const [index, a] of clips.entries()) {
      for (const b of clips.slice(index + 1)) {
        const shared = subtract(minOf(clipEnd(a), clipEnd(b)), maxOf(clipStart(a), clipStart(b)));
        if (compare(shared, ZERO) > 0) total = add(total, shared);
      }
    }
    totals.set(track, total);
  }
  return totals;
}

/** Where a moment goes when stretches are taken out: back by those before it, or to the start of one it is in. */
function closedMoment(
  gaps: readonly { from: Rational; to: Rational }[],
  moment: Rational,
): Rational {
  let back = ZERO;
  for (const { from, to } of gaps) {
    if (compare(to, moment) <= 0) back = add(back, subtract(to, from));
    else if (compare(from, moment) < 0) return subtract(from, back);
  }
  return subtract(moment, back);
}

/** A clip without where it is: what it shows and what it has must stay the same. */
const without = (clip: ClipState) => {
  const {
    start: _start,
    duration: _duration,
    offset: _offset,
    link: _link,
    enter: _enter,
    exit: _exit,
    ...rest
  } = clip;
  return rest;
};

/** The part of a clip that a lift leaves, by where it was: what it showed then. */
interface Part {
  readonly from: Rational;
  readonly to: Rational;
  /** What its clock read at `from`. */
  readonly clock: Rational;
}

function partsLeft(clip: ClipState, span: { from: Rational; to: Rational } | undefined): Part[] {
  const from = clipStart(clip);
  const to = clipEnd(clip);
  const clockAt = (moment: Rational) => add(clipOffset(clip), subtract(moment, from));
  if (!span || compare(span.to, from) <= 0 || compare(span.from, to) >= 0) {
    return [{ from, to, clock: clockAt(from) }];
  }
  const parts: Part[] = [];
  if (compare(from, span.from) < 0) parts.push({ from, to: span.from, clock: clockAt(from) });
  if (compare(to, span.to) > 0) parts.push({ from: span.to, to, clock: clockAt(span.to) });
  return parts;
}

/** Checks one ripple edit that went through against what the design asks of it. */
function checkEdit(step: Step, before: TimelineState, after: TimelineState, result: any): void {
  const params = step.call.params as any;
  const tracks: readonly string[] | undefined =
    step.kind === "range" ? params.tracks : params.rippleTracks;
  const takesPart = (track: string) => tracks === undefined || tracks.includes(track);
  const ripples = step.kind !== "range" || params.ripple === true;

  // What was taken out, in time order.
  let gaps: { from: Rational; to: Rational }[] = [];
  if (step.kind === "close") {
    gaps = [
      ...mergeSpans(
        params.ranges.map((r: any) => ({ from: parseTime(r.from), to: parseTime(r.to) })),
      ),
    ];
  } else if (step.kind === "remove") {
    gaps = [
      ...mergeSpans(
        params.clips.map((id: string) => ({
          from: clipStart(before.clips[id]!),
          to: clipEnd(before.clips[id]!),
        })),
      ),
    ];
  } else if (ripples) {
    gaps = [{ from: parseTime(params.from), to: parseTime(params.to) }];
  }
  const lifted =
    step.kind === "range" ? { from: parseTime(params.from), to: parseTime(params.to) } : undefined;
  const removed = new Set<string>(step.kind === "remove" ? params.clips : []);
  const pieces = new Map<string, string>(
    (result?.split ?? []).map(({ clip, piece }: { clip: string; piece: string }) => [clip, piece]),
  );

  // 2. No new overlaps: no more time that clips of a track share.
  const was = overlapsOn(before);
  for (const [track, shared] of overlapsOn(after)) {
    expect(compare(shared, was.get(track) ?? ZERO), `overlap on ${track}`).toBeLessThanOrEqual(0);
  }

  const untouched = new Set<string>();
  // 3, 5, 6, 9. Every clip: gone as asked, or there with what it showed, where it should be.
  const accounted = new Set<string>();
  for (const clip of Object.values(before.clips)) {
    if (removed.has(clip.id)) {
      expect(after.clips[clip.id]).toBeUndefined();
      continue;
    }
    if (!takesPart(clip.track)) {
      // Not a letter changed, apart from a transition that works again where a join went.
      const { enter: _e, exit: _x, ...rest } = after.clips[clip.id]!;
      const { enter: _f, exit: _y, ...kept } = clip;
      expect(rest).toEqual(kept);
      checkKeptTransitions(before, after, clip, after.clips[clip.id]!);
      accounted.add(clip.id);
      continue;
    }
    const parts = partsLeft(clip, lifted);
    const ids =
      parts.length === 2 ? [clip.id, pieces.get(clip.id)] : parts.length === 1 ? [clip.id] : [];
    if (parts.length === 0) expect(after.clips[clip.id]).toBeUndefined();
    parts.forEach((part, index) => {
      const id = ids[index];
      expect(id).toBeDefined();
      const now = after.clips[id!];
      expect(now, `${clip.id} part ${index}`).toBeDefined();
      accounted.add(id!);
      const shift = ripples ? subtract(part.from, closedMoment(gaps, part.from)) : ZERO;
      expect(t(clipStart(now!))).toBe(t(subtract(part.from, shift)));
      expect(t(subtract(clipEnd(now!), clipStart(now!)))).toBe(t(subtract(part.to, part.from)));
      expect(t(clipOffset(now!))).toBe(t(part.clock));
      expect(now!.track).toBe(clip.track);
      expect(without(now!)).toEqual({ ...without(clip), id: id! });
      // A clip that was not cut keeps its transitions as they were.
      const whole =
        parts.length === 1 &&
        compare(part.from, clipStart(clip)) === 0 &&
        compare(part.to, clipEnd(clip)) === 0;
      if (whole) {
        untouched.add(clip.id);
        checkKeptTransitions(before, after, clip, now!);
      }
    });
  }
  // Nothing new but the parts after cuts.
  for (const id of Object.keys(after.clips)) expect(accounted.has(id), id).toBe(true);

  // 6. Clips stay in their order on each track: one that started earlier starts no later.
  const kept = Object.values(before.clips).filter((clip) => after.clips[clip.id]);
  for (const a of kept) {
    for (const b of kept) {
      if (a.track !== b.track || compare(clipStart(a), clipStart(b)) >= 0) continue;
      expect(
        compare(clipStart(after.clips[a.id]!), clipStart(after.clips[b.id]!)),
      ).toBeLessThanOrEqual(0);
    }
  }

  // 4. Linked clips at one time that were in step stay in step: every part of one and every part of
  // the other that show the same part of the file (the two parts of a cut never do); and those of
  // one group that were in the same time still are, see `checkGroups`.
  const clockOf = (clip: ClipState) => subtract(clipStart(clip), clipOffset(clip));
  const partsOf = (id: string) =>
    [after.clips[id], after.clips[pieces.get(id) ?? ""]].filter(
      (clip): clip is ClipState => clip !== undefined,
    );
  const sharesPart = (x: ClipState, y: ClipState) => {
    const length = (clip: ClipState) => subtract(clipEnd(clip), clipStart(clip));
    return (
      compare(clipOffset(x), add(clipOffset(y), length(y))) < 0 &&
      compare(clipOffset(y), add(clipOffset(x), length(x))) < 0
    );
  };
  for (const a of Object.values(before.clips)) {
    for (const b of Object.values(before.clips)) {
      if (a.id >= b.id || !a.link || a.link !== b.link) continue;
      if (!takesPart(a.track) || !takesPart(b.track)) continue;
      // Partners at one time: what is in between them in time never ripples one and not the other.
      const together =
        compare(clipStart(a), clipEnd(b)) < 0 && compare(clipStart(b), clipEnd(a)) < 0;
      if (!together || compare(clockOf(a), clockOf(b)) !== 0) continue;
      for (const x of partsOf(a.id)) {
        for (const y of partsOf(b.id)) {
          if (!sharesPart(x, y)) continue;
          const about = JSON.stringify({ call: step.call, a, b, x, y });
          expect(t(clockOf(x)), about).toBe(t(clockOf(y)));
        }
      }
    }
  }
  checkGroups(before, after, takesPart);

  // 7. Sections and markers move with what was taken out, and no marker goes; but only when all of
  // the timeline after the first stretch moves. A track that does not take part and has something
  // after it keeps them exactly where they are.
  const stays =
    gaps[0] !== undefined &&
    Object.values(before.clips).some(
      (clip) =>
        !removed.has(clip.id) &&
        !takesPart(clip.track) &&
        compare(clipEnd(clip), gaps[0]!.from) > 0,
    );
  const timelineGaps = stays ? [] : gaps;
  if (stays) {
    expect(after.sections).toEqual(before.sections);
    expect(after.markers).toEqual(before.markers);
  }
  const placedBefore = placedSections(before);
  const expected = placedBefore
    .map(({ id, start, end }) => ({
      id,
      length: subtract(closedMoment(timelineGaps, end), closedMoment(timelineGaps, start)),
    }))
    .filter(({ length }) => compare(length, ZERO) > 0);
  const all = expected.length === 0;
  const shouldBe = all ? [{ id: placedBefore[0]!.id, length: frames(1) }] : expected;
  const lengthBefore = timelineLength(before);
  let reach = ZERO;
  for (const clip of Object.values(after.clips)) reach = maxOf(reach, clipEnd(clip));
  const plain = shouldBe.reduce((sum, { length }) => add(sum, length), ZERO);
  const wanted = maxOf(plain, minOf(reach, lengthBefore));
  const last = shouldBe.at(-1)!;
  const grown = [
    ...shouldBe.slice(0, -1),
    { id: last.id, length: add(last.length, subtract(wanted, plain)) },
  ];
  expect(placedSections(after).map(({ id, duration }) => `${id}:${t(duration)}`)).toEqual(
    grown.map(({ id, length }) => `${id}:${t(length)}`),
  );
  expect(Object.keys(after.markers).toSorted()).toEqual(Object.keys(before.markers).toSorted());
  for (const marker of Object.values(before.markers)) {
    const time = closedMoment(timelineGaps, parseTime(marker.time));
    const now = after.markers[marker.id]!;
    expect(now.time).toBe(t(time));
    if (marker.duration === undefined) expect(now.duration).toBeUndefined();
    else {
      const end = closedMoment(
        timelineGaps,
        add(parseTime(marker.time), parseTime(marker.duration)),
      );
      const length = subtract(end, time);
      expect(now.duration).toBe(compare(length, ZERO) > 0 ? t(length) : undefined);
    }
  }
  expect(t(timelineLength(after))).toBe(t(wanted));

  // 8. Joins still join, or are said to be gone, or went with a clip of theirs.
  const said = new Set<string>(result?.joinsRemoved ?? []);
  for (const [id, join] of Object.entries(after.joins ?? {})) {
    const wasJoined = before.joins?.[id];
    const [from, to] = [after.clips[join.from ?? ""], after.clips[join.to ?? ""]];
    if (!wasJoined || !from || !to) continue;
    const fromBefore = before.clips[wasJoined.from ?? ""];
    const toBefore = before.clips[wasJoined.to ?? ""];
    const touchedBefore =
      fromBefore && toBefore && compare(clipEnd(fromBefore), clipStart(toBefore)) === 0;
    if (touchedBefore) expect(t(clipEnd(from))).toBe(t(clipStart(to)));
    // Between two clips that were not cut, a join stays as it was: its kind and how long it is.
    const sides = [wasJoined.from ?? "", wasJoined.to ?? ""];
    if (sides.every((side) => untouched.has(side) || !takesPart(before.clips[side]?.track ?? ""))) {
      expect(join).toEqual(wasJoined);
    }
  }
  for (const id of Object.keys(before.joins ?? {})) {
    if (after.joins?.[id]) continue;
    const join = before.joins![id]!;
    const [from, to] = [join.from ?? "", join.to ?? ""];
    const sideGone = !after.clips[from] || !after.clips[to] || removed.has(from) || removed.has(to);
    if (!sideGone) expect(said.has(id), `join ${id}`).toBe(true);
  }
}

/**
 * Members of a linked group on tracks that take part that were in the same time still are, also
 * after a cut: parts after one cut of a group are a group of their own, apart from the parts
 * before it. Without tracks that take part, as when clips drop over others, only the last.
 */
function checkGroups(
  before: TimelineState,
  after: TimelineState,
  takesPart: ((track: string) => boolean) | undefined,
  ignored: ReadonlySet<string> = new Set(),
): void {
  const groups = groupBy(
    Object.values(after.clips).filter(
      ({ id, link, track }) =>
        link !== undefined && takesPart?.(track) === true && !ignored.has(id),
    ),
    ({ link }) => link!,
  );
  for (const members of groups.values()) {
    // Clips that were in one time in a group before are in one time in a group now.
    const fromSame = groupBy(members, (clip) => {
      const was = before.clips[clip.id];
      return was ? `${was.link} ${was.start} ${was.duration}` : "new";
    });
    for (const [key, same] of fromSame) {
      if (key === "new") continue;
      const spans = new Set(same.map((clip) => `${clip.start}+${clip.duration}`));
      expect(spans.size, `group ${key}`).toBe(1);
    }
  }
  // Parts after one cut of two or more clips of a group are a group of their own, apart from the
  // parts before it; the part of the only one cut there stays in its group.
  const oldLinks = new Set(Object.values(before.clips).map(({ link }) => link));
  const fresh = groupBy(
    Object.values(after.clips).filter(
      ({ id, link }) => !before.clips[id] && link !== undefined && oldLinks.has(link),
    ),
    ({ link, start }) => `${link} ${start}`,
  );
  for (const [key, same] of fresh) expect(same.length, `parts ${key} kept their link`).toBe(1);
}

/**
 * The transitions at the edges of every clip fit in it: in at the start and out at the end take no
 * more than the clip is long together. Where a join is at an edge, its part there counts instead.
 */
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
    const length = subtract(clipEnd(clip), clipStart(clip));
    expect(compare(total, length), `${clip.id} ${JSON.stringify(about)}`).toBeLessThanOrEqual(0);
  }
}

/**
 * A clip that was not cut keeps its transitions as they were; where a join at an edge went (or
 * moved to a part after a cut), the
 * transition there works again and may have got shorter to fit, of the same kind.
 */
function checkKeptTransitions(
  before: TimelineState,
  after: TimelineState,
  clip: ClipState,
  now: ClipState,
): void {
  for (const [edge, side] of [
    ["enter", "to"],
    ["exit", "from"],
  ] as const) {
    const freed = Object.entries(before.joins ?? {}).some(
      ([id, join]) => join[side] === clip.id && after.joins?.[id]?.[side] !== clip.id,
    );
    const was = clip[edge];
    const is = now[edge];
    if (!freed || was === undefined) {
      expect(is).toEqual(was);
      continue;
    }
    if (is === undefined) continue;
    expect(is.type).toBe(was.type);
    expect(compare(parseTime(is.duration), parseTime(was.duration))).toBeLessThanOrEqual(0);
  }
}

/** Sources that have no beginning, whose clock moves forward instead, see `trimClip`. */
const isTimeless = (clip: ClipState) =>
  clip.source.kind === "color" || clip.source.kind === "image" || clip.source.kind === "caption";

/**
 * Checks one edit that put time in or took it out around clips that it changes itself: inserting
 * (`timeline.openGap`, `clip.add` and `clip.move` with insert) and ripple trims. The same as
 * `checkEdit` asks, with the clips that it changes itself where it put them.
 */
function checkRoom(step: Step, before: TimelineState, after: TimelineState, result: any): void {
  const params = step.call.params as any;
  const own: string[] = [];
  const special = new Set<string>();
  let open: { at: Rational; length: Rational } | undefined;
  let close: { from: Rational; to: Rational } | undefined;
  /** What the clips it changes itself have to look like. */
  const wanted = new Map<
    string,
    { start: Rational; duration: Rational; offset: Rational; track: string; clockMoved?: boolean }
  >();
  if (step.kind === "open") {
    open = { at: parseTime(params.at), length: parseTime(params.duration) };
  } else if (step.kind === "add") {
    open = { at: parseTime(params.start), length: parseTime(params.duration) };
    own.push(params.track);
    const added = after.clips[result.id];
    expect(added).toBeDefined();
    expect([added!.track, added!.start, added!.duration]).toEqual([
      params.track,
      params.start,
      params.duration,
    ]);
  } else if (step.kind === "moveInsert") {
    const landed = (params.clips as { clip: string; start: string; track?: string }[]).map(
      ({ clip, start, track }) => {
        const was = before.clips[clip]!;
        special.add(clip);
        own.push(track ?? was.track);
        const from = parseTime(start);
        wanted.set(clip, {
          start: from,
          duration: parseTime(was.duration),
          offset: clipOffset(was),
          track: track ?? was.track,
        });
        return { from, to: add(from, parseTime(was.duration)) };
      },
    );
    const from = landed.reduce((a, b) => minOf(a, b.from), landed[0]!.from);
    const to = landed.reduce((a, b) => maxOf(a, b.to), landed[0]!.to);
    open = { at: from, length: subtract(to, from) };
  } else {
    const ids = [params.clip as string, ...((params.together ?? []) as string[])];
    const trimmed = before.clips[params.clip]!;
    for (const id of new Set(ids)) {
      const was = before.clips[id]!;
      special.add(id);
      own.push(was.track);
      const start = clipStart(was);
      let duration = subtract(clipEnd(was), clipStart(was));
      let offset = clipOffset(was);
      let clockMoved = false;
      // Every clip of the trim: the same edge by the same amount as the clip, where it starts.
      if (params.end !== undefined) {
        const [from, to] = [parseTime(params.end), clipEnd(trimmed)];
        if (compare(from, to) < 0) close = { from, to };
        else if (compare(from, to) > 0) open = { at: to, length: subtract(from, to) };
        duration = add(duration, subtract(from, to));
      } else {
        const [s, s2] = [clipStart(trimmed), parseTime(params.start)];
        if (compare(s2, s) > 0) close = { from: s, to: s2 };
        else if (compare(s2, s) < 0) open = { at: s, length: subtract(s, s2) };
        if (compare(s2, s) !== 0) {
          const by = subtract(s2, s);
          duration = subtract(duration, by);
          offset = add(offset, by);
          // A picture has no beginning: its clock moves forward instead.
          if (compare(offset, ZERO) < 0 && isTimeless(was)) {
            offset = ZERO;
            clockMoved = true;
          }
        }
      }
      wanted.set(id, { start, duration, offset, track: was.track, clockMoved });
    }
  }
  const listed: readonly string[] | undefined = params.rippleTracks;
  const tracks = listed && [...new Set([...listed, ...own])];
  const takesPart = (track: string) => tracks === undefined || tracks.includes(track);
  const pieces = new Map<string, string>(
    (result?.split ?? []).map(({ clip, piece }: { clip: string; piece: string }) => [clip, piece]),
  );
  const added = step.kind === "add" ? result.id : undefined;

  // 2. No new overlaps.
  const was = overlapsOn(before);
  for (const [track, shared] of overlapsOn(after)) {
    expect(compare(shared, was.get(track) ?? ZERO), `overlap on ${track}`).toBeLessThanOrEqual(0);
  }

  // 3, 5, 6, 9. Every clip there, with what it showed, where it should be.
  const accounted = new Set<string>(added ? [added] : []);
  const untouched = new Set<string>();
  for (const clip of Object.values(before.clips)) {
    const now = after.clips[clip.id];
    expect(now, clip.id).toBeDefined();
    accounted.add(clip.id);
    const want = wanted.get(clip.id);
    if (want) {
      expect(
        [t(clipStart(now!)), t(parseTime(now!.duration)), now!.track],
        JSON.stringify(step.call),
      ).toEqual([t(want.start), t(want.duration), want.track]);
      // A picture that grew in front moved its clock: its keys are later, the rest is the same.
      expect(t(clipOffset(now!))).toBe(t(want.offset));
      if (!want.clockMoved) {
        const { properties: _p, track: _t, ...rest } = without(now!);
        const { properties: _q, track: _u, ...restBefore } = without(clip);
        expect(rest).toEqual(restBefore);
        expect(now!.properties).toEqual(clip.properties);
      }
      continue;
    }
    if (!takesPart(clip.track)) {
      const { enter: _e, exit: _x, ...rest } = now!;
      const { enter: _f, exit: _y, ...kept } = clip;
      expect(rest).toEqual(kept);
      checkKeptTransitions(before, after, clip, now!);
      continue;
    }
    const from = clipStart(clip);
    const to = clipEnd(clip);
    let parts: Part[] = [{ from, to, clock: clipOffset(clip) }];
    if (open) {
      const { at, length } = open;
      if (compare(from, at) >= 0)
        parts = [{ from: add(from, length), to: add(to, length), clock: clipOffset(clip) }];
      else if (compare(to, at) > 0) {
        parts = [
          { from, to: at, clock: clipOffset(clip) },
          {
            from: add(at, length),
            to: add(to, length),
            clock: add(clipOffset(clip), subtract(at, from)),
          },
        ];
      }
    } else if (close) {
      // Nothing was in there, or nothing would have happened.
      expect(compare(to, close.from) <= 0 || compare(from, close.to) >= 0, clip.id).toBe(true);
      if (compare(from, close.to) >= 0) {
        const by = subtract(close.to, close.from);
        parts = [{ from: subtract(from, by), to: subtract(to, by), clock: clipOffset(clip) }];
      }
    }
    const ids = parts.length === 2 ? [clip.id, pieces.get(clip.id)] : [clip.id];
    parts.forEach((part, index) => {
      const id = ids[index];
      expect(id, `${clip.id} cut`).toBeDefined();
      const there = after.clips[id!];
      expect(there, `${clip.id} part ${index}`).toBeDefined();
      accounted.add(id!);
      expect(t(clipStart(there!))).toBe(t(part.from));
      expect(t(clipEnd(there!))).toBe(t(part.to));
      expect(t(clipOffset(there!))).toBe(t(part.clock));
      expect(there!.track).toBe(clip.track);
      expect(without(there!)).toEqual({ ...without(clip), id: id! });
    });
    if (parts.length === 1) {
      untouched.add(clip.id);
      checkKeptTransitions(before, after, clip, now!);
    }
  }
  for (const id of Object.keys(after.clips)) expect(accounted.has(id), id).toBe(true);

  // 6. Order on each track, apart from what the edit put somewhere itself.
  const kept = Object.values(before.clips).filter((clip) => !special.has(clip.id));
  for (const a of kept) {
    for (const b of kept) {
      if (a.track !== b.track || compare(clipStart(a), clipStart(b)) >= 0) continue;
      expect(
        compare(clipStart(after.clips[a.id]!), clipStart(after.clips[b.id]!)),
      ).toBeLessThanOrEqual(0);
    }
  }

  // 4. Partners in step stay in step; what a move puts elsewhere is up to it.
  const clockOf = (clip: ClipState) => subtract(clipStart(clip), clipOffset(clip));
  const moving = step.kind === "moveInsert" ? special : new Set<string>();
  for (const a of Object.values(before.clips)) {
    for (const b of Object.values(before.clips)) {
      if (a.id >= b.id || !a.link || a.link !== b.link) continue;
      if (!takesPart(a.track) || !takesPart(b.track) || moving.has(a.id) || moving.has(b.id)) {
        continue;
      }
      const together =
        compare(clipStart(a), clipEnd(b)) < 0 && compare(clipStart(b), clipEnd(a)) < 0;
      if (!together || compare(clockOf(a), clockOf(b)) !== 0) continue;
      // A picture whose clock moved forward in front shows something else there now.
      if (wanted.has(a.id) && isTimeless(a)) continue;
      if (wanted.has(b.id) && isTimeless(b)) continue;
      const partsOf = (id: string) =>
        [after.clips[id], after.clips[pieces.get(id) ?? ""]].filter(
          (clip): clip is ClipState => clip !== undefined,
        );
      for (const x of partsOf(a.id)) {
        for (const y of partsOf(b.id)) {
          const length = (clip: ClipState) => subtract(clipEnd(clip), clipStart(clip));
          const shares =
            compare(clipOffset(x), add(clipOffset(y), length(y))) < 0 &&
            compare(clipOffset(y), add(clipOffset(x), length(x))) < 0;
          if (!shares) continue;
          expect(t(clockOf(x)), JSON.stringify({ call: step.call, a, b })).toBe(t(clockOf(y)));
        }
      }
    }
  }
  checkGroups(before, after, takesPart, special);

  // 7. Sections and markers make room or close up, when all of the timeline from there on moves.
  const from = open ? open.at : close?.from;
  const stays =
    from !== undefined &&
    Object.values(before.clips).some(
      (clip) => !moving.has(clip.id) && !takesPart(clip.track) && compare(clipEnd(clip), from) > 0,
    );
  const lengthBefore = timelineLength(before);
  const placedBefore = placedSections(before);
  let plain = placedBefore.map(({ id, duration }) => ({ id, length: duration }));
  const markersWanted = new Map(
    Object.values(before.markers).map((marker) => [
      marker.id,
      {
        time: parseTime(marker.time),
        duration: marker.duration === undefined ? undefined : parseTime(marker.duration),
      },
    ]),
  );
  if (!stays && open && compare(open.at, lengthBefore) <= 0) {
    const { at, length } = open;
    const into =
      placedBefore.find(({ start, end }) => compare(start, at) <= 0 && compare(at, end) < 0) ??
      placedBefore.at(-1)!;
    plain = plain.map((each) =>
      each.id === into.id ? { id: each.id, length: add(each.length, length) } : each,
    );
    for (const [id, marker] of markersWanted) {
      if (compare(marker.time, at) >= 0)
        markersWanted.set(id, { ...marker, time: add(marker.time, length) });
      else if (marker.duration && compare(add(marker.time, marker.duration), at) > 0) {
        markersWanted.set(id, { ...marker, duration: add(marker.duration, length) });
      }
    }
  } else if (!stays && close) {
    const gaps = [close];
    plain = placedBefore
      .map(({ id, start, end }) => ({
        id,
        length: subtract(closedMoment(gaps, end), closedMoment(gaps, start)),
      }))
      .filter(({ length }) => compare(length, ZERO) > 0);
    if (plain.length === 0) plain = [{ id: placedBefore[0]!.id, length: frames(1) }];
    for (const [id, marker] of markersWanted) {
      const time = closedMoment(gaps, marker.time);
      if (marker.duration === undefined) markersWanted.set(id, { time, duration: undefined });
      else {
        const left = subtract(closedMoment(gaps, add(marker.time, marker.duration)), time);
        markersWanted.set(id, { time, duration: compare(left, ZERO) > 0 ? left : undefined });
      }
    }
  }
  let reach = ZERO;
  for (const clip of Object.values(after.clips)) reach = maxOf(reach, clipEnd(clip));
  const plainLength = plain.reduce((sum, { length }) => add(sum, length), ZERO);
  const total = maxOf(plainLength, reach);
  const last = plain.at(-1)!;
  const grown = [
    ...plain.slice(0, -1),
    { id: last.id, length: add(last.length, subtract(total, plainLength)) },
  ];
  expect(placedSections(after).map(({ id, duration }) => `${id}:${t(duration)}`)).toEqual(
    grown.map(({ id, length }) => `${id}:${t(length)}`),
  );
  for (const [id, { time, duration }] of markersWanted) {
    const now = after.markers[id]!;
    expect([now.time, now.duration]).toEqual([t(time), duration && t(duration)]);
  }
  expect(Object.keys(after.markers)).toHaveLength(markersWanted.size);
  // The timeline ends no earlier than the last of what is on it.
  expect(compare(timelineLength(after), reach)).toBeGreaterThanOrEqual(0);

  // 8. Joins still join, or are said to be gone, or went with a clip of theirs.
  const said = new Set<string>(result?.joinsRemoved ?? []);
  for (const [id, join] of Object.entries(after.joins ?? {})) {
    const wasJoined = before.joins?.[id];
    const [a, b] = [after.clips[join.from ?? ""], after.clips[join.to ?? ""]];
    if (!wasJoined || !a || !b) continue;
    const fromBefore = before.clips[wasJoined.from ?? ""];
    const toBefore = before.clips[wasJoined.to ?? ""];
    if (fromBefore && toBefore && compare(clipEnd(fromBefore), clipStart(toBefore)) === 0) {
      expect(t(clipEnd(a))).toBe(t(clipStart(b)));
    }
    const sides = [wasJoined.from ?? "", wasJoined.to ?? ""];
    if (sides.every((side) => untouched.has(side) || !takesPart(before.clips[side]?.track ?? ""))) {
      expect(join).toEqual(wasJoined);
    }
  }
  for (const id of Object.keys(before.joins ?? {})) {
    if (after.joins?.[id]) continue;
    const join = before.joins![id]!;
    if (after.clips[join.from ?? ""] && after.clips[join.to ?? ""]) {
      expect(said.has(id), `join ${id}`).toBe(true);
    }
  }
}

describe.each(SEEDS)("ripple edits at random, seed %i", FUZZ, (seed) => {
  it("do all or nothing, lose nothing and move what follows, sections and markers by as much", () => {
    seedIds(seed);
    const random = randomFrom(seed);
    const store = randomProject(random);
    checkTransitionsFit(main(store), "the project as it was made");
    let done = 0;
    let made = 0;
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
      checkTransitionsFit(after, step.call);
      checkJoinsKept(before, after, step.call.params);
      if (step.kind === "other") checkGroups(before, after, undefined);
      else if (ROOM.has(step.kind)) {
        made += 1;
        checkRoom(step, before, after, result.results[0]);
      } else {
        done += 1;
        checkEdit(step, before, after, result.results[0]);
      }
      // 10. One step back is exactly where it was, and forward again exactly where it got to. What
      // changed nothing is no step.
      if (random.chance(0.4) && !deepEqual(before, after)) {
        expect(store.undo().ok).toBe(true);
        expect(main(store)).toEqual(before);
        expect(store.redo().ok).toBe(true);
        expect(main(store)).toEqual(after);
      }
    }
    expect(done).toBeGreaterThan(0);
    expect(made).toBeGreaterThan(0);
    expect(store.exportFiles().problems).toEqual([]);
  });

  it("put a stretch in and take it out again, and leave everything where it was", () => {
    seedIds(seed);
    const random = randomFrom(seed);
    const store = randomProject(random);
    for (let round = 0; round < 10; round++) {
      const before = main(store);
      const at = momentIn(random, before);
      const length = frames(1 + random.int(90));
      const tracks = someTracks(random);
      const draft = new Draft(store.getState(), USER);
      const { split } = openGap(draft, "main", at, length, tracks);
      const opened = draft.state.timelines["main"]!;
      // Nothing is in what was put in, on the tracks that take part.
      for (const clip of Object.values(opened.clips)) {
        if (tracks && !tracks.includes(clip.track)) continue;
        const apart =
          compare(clipEnd(clip), at) <= 0 || compare(clipStart(clip), add(at, length)) >= 0;
        expect(apart).toBe(true);
      }
      // The timeline ends no earlier than what is on it, also where sections stayed.
      let reach = ZERO;
      for (const clip of Object.values(opened.clips)) reach = maxOf(reach, clipEnd(clip));
      expect(compare(timelineLength(opened), reach)).toBeGreaterThanOrEqual(0);
      closeGaps(draft, "main", [{ from: at, to: add(at, length) }], tracks);
      const after = draft.state.timelines["main"]!;
      // Sections only grow at the end, where what moved on reached past it while they stayed.
      const grown = subtract(maxOf(reach, timelineLength(before)), timelineLength(before));
      const stays =
        tracks !== undefined &&
        Object.values(before.clips).some(
          (clip) => !tracks.includes(clip.track) && compare(clipEnd(clip), at) > 0,
        );
      const lastBefore = placedSections(before).at(-1)!;
      const sectionsWanted = placedSections(before).map(({ id, duration }) =>
        id === lastBefore.id && stays ? `${id}:${t(add(duration, grown))}` : `${id}:${t(duration)}`,
      );
      expect(placedSections(after).map(({ id, duration }) => `${id}:${t(duration)}`)).toEqual(
        sectionsWanted,
      );
      expect(after.markers).toEqual(before.markers);
      const pieces = new Map(split.map(({ clip, piece }) => [clip, piece]));
      for (const clip of Object.values(before.clips)) {
        const piece = pieces.get(clip.id);
        if (!piece) {
          expect(after.clips[clip.id]).toEqual(clip);
          continue;
        }
        // Cut at the moment, the two parts show what it showed, where it showed it.
        const [left, right] = [after.clips[clip.id]!, after.clips[piece]!];
        expect([left.start, t(clipEnd(left)), right.start, t(clipEnd(right))]).toEqual([
          clip.start,
          t(at),
          t(at),
          t(clipEnd(clip)),
        ]);
        expect(t(clipOffset(right))).toBe(t(add(clipOffset(clip), subtract(at, clipStart(clip)))));
        expect(without(right)).toEqual({ ...without(clip), id: piece });
      }
      expect(Object.keys(after.clips)).toHaveLength(
        Object.keys(before.clips).length + split.length,
      );
    }
  });

  it("on two devices at once with other edits, end up the same and valid", () => {
    seedIds(seed);
    const random = randomFrom(seed);
    const a = randomProject(random);
    const b = replica(a);
    for (let round = 0; round < 80; round++) {
      const store = random.chance(0.5) ? a : b;
      if (random.chance(0.1)) store.undo();
      else if (random.chance(0.5)) store.execute(randomStep(store, random).call);
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
