import {
  ZERO,
  add,
  compare,
  formatTime,
  parseTime,
  subtract,
  type Rational,
} from "@animaquill/schema";
import { describe, expect, it } from "vitest";
import { Draft } from "./draft.ts";
import { FUZZ, openUnlocked, randomFrom, seedIds, type Random } from "./fuzz-support.ts";
import { timelineLength, type TimelineState } from "./model.ts";
import { applyGapPlan, closingPlan, openingPlan, placedSections } from "./section-edits.ts";
import { USER, type ProjectStore } from "./store.ts";

/**
 * Sections split, merged, removed and with boundaries dragged, at random, and the stretches that
 * ripple edits will take out and put in: sections always lie end to end from zero, the timeline is
 * as long as they are together, and nothing on it gets lost or moves when it should not.
 */

const FRAME = parseTime("1/30");
const main = (store: ProjectStore): TimelineState => store.getState().timelines["main"]!;
const t = (value: Rational) => formatTime(value);

/** A moment on a frame, from zero to a little past the end. */
const frameIn = (random: Random, length: Rational): Rational => {
  const frames = Math.round(
    (Number(length.n) / Number(length.d) / Number(FRAME.n)) * Number(FRAME.d),
  );
  return add(ZERO, { n: BigInt(random.int(frames + 3)) * FRAME.n, d: FRAME.d });
};

/** Where sections start and end: they lie end to end from zero, each longer than nothing. */
function boundaries(timeline: TimelineState): readonly string[] {
  const placed = placedSections(timeline);
  let at = ZERO;
  for (const { start, end, duration } of placed) {
    expect(t(start)).toBe(t(at));
    expect(compare(duration, ZERO)).toBeGreaterThan(0);
    at = end;
  }
  expect(t(at)).toBe(t(timelineLength(timeline)));
  return placed.map(({ end }) => t(end));
}

/** Everything on the timeline but its sections. */
const content = (timeline: TimelineState) =>
  structuredClone({ clips: timeline.clips, markers: timeline.markers, joins: timeline.joins });

function randomStep(store: ProjectStore, random: Random) {
  const timeline = main(store);
  const placed = placedSections(timeline);
  const length = timelineLength(timeline);
  const section = random.pick(placed);
  switch (random.int(4)) {
    case 0:
      return {
        type: "section.split",
        params: { timeline: "main", at: t(frameIn(random, length)) },
      };
    case 1:
      return { type: "section.remove", params: { timeline: "main", section: section?.id } };
    case 2:
      return {
        type: "section.moveBoundary",
        params: { timeline: "main", section: section?.id, at: t(frameIn(random, length)) },
      };
    default:
      return {
        type: "section.update",
        params: {
          timeline: "main",
          section: section?.id,
          duration: t(add(FRAME, frameIn(random, parseTime("4")))),
        },
      };
  }
}

/**
 * What versions say of sections, of every sort: with a base and without, of two sections next to
 * each other and of one alone. English already makes 讲解 26 seconds long, with a base.
 */
function withVersionSections(store: ProjectStore): void {
  const rewrite = (path: string, sections: object) => {
    const text = store.exportFiles().files.get(path) as string;
    const document = { ...JSON.parse(text), sections };
    const result = store.importFile(path, JSON.stringify(document), { origin: USER });
    if (!result.ok) throw new Error(`${path}: ${JSON.stringify(result)}`);
  };
  rewrite("timelines/main/overrides/format.vertical.json", {
    section_intro: { duration: { value: "6" } },
  });
  rewrite("timelines/main/overrides/version.en.vertical.json", {
    section_intro: { duration: { value: "3", base: "5" } },
    section_body: { duration: { value: "18" } },
    section_end: { duration: { value: "4", base: "5.005" } },
  });
}

/** How long each version is, which is what removing a section must not change. */
const versionLengths = (timeline: TimelineState) =>
  Object.fromEntries(
    Object.entries(timeline.overrides).map(([name, version]) => [
      name,
      t(
        placedSections(timeline).reduce(
          (length, { id, duration }) =>
            add(
              length,
              version.sections?.[id] ? parseTime(version.sections[id].duration.value) : duration,
            ),
          ZERO,
        ),
      ),
    ]),
  );

/** Versions only speak of sections that are there. */
const versionsAboutGone = (timeline: TimelineState) =>
  Object.values(timeline.overrides).flatMap((version) =>
    Object.keys(version.sections ?? {}).filter((id) => !Object.hasOwn(timeline.sections, id)),
  );

/** The base of a version of a section, against what the master has, for those that have one. */
const basesOf = (timeline: TimelineState) =>
  Object.entries(timeline.overrides).flatMap(([name, version]) =>
    Object.entries(version.sections ?? {}).flatMap(([id, { duration }]) =>
      duration.base === undefined ? [] : [`${name} ${id} ${duration.base}`],
    ),
  );

describe.each([1, 2, 3, 4, 5, 6, 7, 8])("sections at random, seed %i", FUZZ, (seed) => {
  it("lie end to end, keep the length and leave what is on the timeline", () => {
    seedIds(seed);
    const random = randomFrom(seed);
    const store = openUnlocked();
    withVersionSections(store);
    expect(basesOf(main(store))).toHaveLength(3);
    for (let step = 0; step < 120; step += 1) {
      const before = structuredClone(main(store));
      const ends = boundaries(before);
      const call = randomStep(store, random);
      const result = store.execute(call);
      if (!result.ok) {
        // Refused, and nothing changed.
        expect(main(store)).toEqual(before);
        continue;
      }
      const after = main(store);
      const now = boundaries(after);
      expect(content(after)).toEqual(content(before));
      const { type, params } = call as { type: string; params: Record<string, string> };
      if (type === "section.update") {
        expect(now.length).toBe(ends.length);
      } else {
        // The length stays, and only the one boundary is new, gone or moved.
        expect(now.at(-1)).toBe(ends.at(-1));
        const added = now.filter((end) => !ends.includes(end));
        const gone = ends.filter((end) => !now.includes(end));
        if (type === "section.split") expect([added, gone]).toEqual([[params["at"]], []]);
        if (type === "section.remove") expect(added).toEqual([]);
        if (type === "section.remove") expect(gone).toHaveLength(1);
        if (type === "section.moveBoundary" && ends.includes(params["at"] as string)) {
          expect(now).toEqual(ends);
        } else if (type === "section.moveBoundary") {
          expect(added).toEqual([params["at"]]);
          expect(gone).toHaveLength(1);
        }
      }
      expect(store.exportFiles().problems).toEqual([]);
      expect(versionsAboutGone(after)).toEqual([]);
      if (type === "section.remove") {
        // Every version is as long as it was, and a base adds up as the durations do.
        expect(versionLengths(after)).toEqual(versionLengths(before));
        const gone = Object.keys(before.sections).find((id) => !Object.hasOwn(after.sections, id));
        for (const [name, version] of Object.entries(after.overrides)) {
          const old = before.overrides[name]?.sections ?? {};
          for (const [id, { duration }] of Object.entries(version.sections ?? {})) {
            if (old[id]?.duration.value === duration.value || gone === undefined) continue;
            const master = (section: string) => before.sections[section]?.duration ?? "0";
            const sum = (field: "value" | "base") =>
              t(
                add(
                  parseTime(old[id]?.duration[field] ?? master(id)),
                  parseTime(old[gone]?.duration[field] ?? master(gone)),
                ),
              );
            expect(duration.value).toBe(sum("value"));
            if (duration.base !== undefined) expect(duration.base).toBe(sum("base"));
          }
        }
      }
      // One step back is exactly where it was, and forward again exactly where it got to.
      if (random.chance(0.3)) {
        const done = structuredClone(after);
        expect(store.undo().ok).toBe(true);
        expect(main(store)).toEqual(before);
        expect(store.redo().ok).toBe(true);
        expect(main(store)).toEqual(done);
      }
    }
  });
});

const seconds = (value: Rational) => Number(value.n) / Number(value.d);

describe.each([1, 2, 3, 4, 5, 6, 7, 8])("stretches out and in, seed %i", FUZZ, (seed) => {
  it("move sections and markers with them, and lose none of the markers", () => {
    seedIds(seed);
    const random = randomFrom(seed);
    const store = openUnlocked();
    // Some sections and markers of all sorts first.
    for (let step = 0; step < 12; step += 1) {
      const length = timelineLength(main(store));
      store.execute({
        type: "section.split",
        params: { timeline: "main", at: t(frameIn(random, length)) },
      });
      store.execute({
        type: "marker.add",
        params: {
          timeline: "main",
          time: t(frameIn(random, length)),
          ...(random.chance(0.5) && { duration: t(add(FRAME, frameIn(random, parseTime("3")))) }),
        },
      });
    }
    for (let round = 0; round < 40; round += 1) {
      const timeline = main(store);
      const length = timelineLength(timeline);
      const a = frameIn(random, length);
      const b = frameIn(random, length);
      const closing = random.chance(0.5);
      const draft = new Draft(store.getState(), "user");
      let from = compare(a, b) <= 0 ? a : b;
      let to = compare(a, b) <= 0 ? b : a;
      if (compare(to, length) > 0) to = length;
      if (compare(from, to) >= 0) from = subtract(to, FRAME);
      if (compare(from, ZERO) < 0) continue;
      const at = compare(a, length) > 0 ? length : a;
      const by = add(FRAME, frameIn(random, parseTime("2")));
      const plan = closing ? closingPlan(timeline, from, to, FRAME) : openingPlan(timeline, at, by);
      applyGapPlan(draft, "main", plan);
      const after = draft.state.timelines["main"] as TimelineState;
      boundaries(after);
      const ends = placedSections(timeline).map(({ end }) => end);
      const now = placedSections(after).map(({ end }) => end);
      expect(Object.keys(after.markers).toSorted()).toEqual(
        Object.keys(timeline.markers).toSorted(),
      );
      if (closing) {
        const gap = subtract(to, from);
        const all = compare(from, ZERO) === 0 && compare(to, length) === 0;
        expect(t(timelineLength(after))).toBe(t(all ? FRAME : subtract(length, gap)));
        if (!all) {
          // Boundaries before it stay, those after it move back by its length, and those inside
          // it come to where it starts, with a section that ends there or none.
          const expected = ends
            .map((end) =>
              compare(end, to) >= 0 ? subtract(end, gap) : compare(end, from) > 0 ? from : end,
            )
            .filter((end) => compare(end, ZERO) > 0)
            .map(t);
          expect(now.map(t)).toEqual([...new Set(expected)]);
        }
        for (const [id, marker] of Object.entries(timeline.markers)) {
          const time = parseTime(marker.time);
          const moved = parseTime(after.markers[id]!.time);
          const wanted =
            compare(time, to) >= 0 ? subtract(time, gap) : compare(time, from) > 0 ? from : time;
          expect(t(moved)).toBe(t(wanted));
        }
      } else {
        expect(t(timelineLength(after))).toBe(t(add(length, by)));
        const expected = ends.map((end) => (compare(end, at) > 0 ? add(end, by) : end));
        // At the end the last one gets longer, and its end is past where it was.
        if (compare(at, length) === 0) expected[expected.length - 1] = add(length, by);
        expect(now.map(t)).toEqual(expected.map(t));
        for (const [id, marker] of Object.entries(timeline.markers)) {
          const time = parseTime(marker.time);
          const moved = after.markers[id]!;
          expect(seconds(parseTime(moved.time))).toBeCloseTo(
            compare(time, at) >= 0 ? seconds(add(time, by)) : seconds(time),
            9,
          );
          if (marker.duration !== undefined && compare(time, at) < 0) {
            const end = add(time, parseTime(marker.duration));
            const grows = compare(end, at) > 0;
            expect(moved.duration).toBe(
              t(grows ? add(parseTime(marker.duration), by) : parseTime(marker.duration)),
            );
          }
        }
      }
    }
  });
});
