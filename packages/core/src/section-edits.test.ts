import { createProject, formatTime, parseTime, type Rational } from "@animaquill/schema";
import { describe, expect, it } from "vitest";
import { loadFixture } from "../../schema/scripts/fixture.ts";
import { orderedSections, timelineLength, type TimelineState } from "./model.ts";
import { Draft } from "./draft.ts";
import { applyGapPlan, closingPlan, openingPlan, placedSections } from "./section-edits.ts";
import { ProjectStore, type CommandResult } from "./store.ts";

/** The example project without its locked tag: sections 片头 5, 讲解 20 and 结尾 5.005. */
function open(): ProjectStore {
  const files = loadFixture("v1");
  const manifest = JSON.parse(files.get("animaquill.json") as string);
  delete manifest.tags;
  files.set("animaquill.json", JSON.stringify(manifest));
  const { store } = ProjectStore.open(files);
  if (!store) throw new Error("fixture did not open");
  return store;
}

const main = (store: ProjectStore): TimelineState => {
  const value = store.getState().timelines["main"];
  if (!value) throw new Error("no main timeline");
  return value;
};

function success(result: CommandResult | { readonly ok: boolean }): unknown {
  if (!result.ok) throw new Error(`failed: ${JSON.stringify(result)}`);
  return "results" in result ? result.results[0] : undefined;
}

function failure(result: CommandResult) {
  if (result.ok) throw new Error("it went through");
  return result.error;
}

/** Each section as id and where it starts and ends, in seconds as written. */
const layout = (store: ProjectStore) =>
  placedSections(main(store)).map(
    ({ id, start, end }) => `${id} ${formatTime(start)}-${formatTime(end)}`,
  );

const length = (store: ProjectStore) => formatTime(timelineLength(main(store)));

const run = (store: ProjectStore, type: string, params: object) =>
  store.execute({ type, params: { timeline: "main", ...params } });

const clipsOf = (store: ProjectStore) => JSON.stringify(main(store).clips);
const markersOf = (store: ProjectStore) => JSON.stringify(main(store).markers);
const versionSections = (store: ProjectStore) =>
  Object.fromEntries(
    Object.entries(main(store).overrides).map(([name, version]) => [name, version.sections]),
  );

describe("section.remove", () => {
  it("gives its time to the section before it, so that nothing else moves", () => {
    const store = open();
    const clips = clipsOf(store);
    const markers = markersOf(store);
    success(run(store, "section.remove", { section: "section_body" }));
    expect(layout(store)).toEqual(["section_intro 0-25", "section_end 25-30.005"]);
    expect(length(store)).toBe("30.005");
    expect(clipsOf(store)).toBe(clips);
    expect(markersOf(store)).toBe(markers);
  });

  it("gives the time of the first section to the next one", () => {
    const store = open();
    success(run(store, "section.remove", { section: "section_intro" }));
    expect(layout(store)).toEqual(["section_body 0-25", "section_end 25-30.005"]);
    expect(main(store).sections["section_body"]?.name).toBe("讲解");
  });

  it("gives the time of the last section to the one before it", () => {
    const store = open();
    success(run(store, "section.remove", { section: "section_end" }));
    expect(layout(store)).toEqual(["section_intro 0-5", "section_body 5-30.005"]);
  });

  it("adds up what versions say of the two, which stay as long as they were", () => {
    const store = open();
    // 讲解 is 26 in the English versions, against 20 in the master, and 片头 says nothing there.
    success(run(store, "section.remove", { section: "section_intro" }));
    const versions = versionSections(store);
    expect(versions["language.en"]).toEqual({
      section_body: { duration: { value: "31", base: "25" } },
    });
    expect(versions["format.vertical"]).toBeUndefined();
    expect(store.exportFiles().problems).toEqual([]);
  });

  it("takes along what versions say of it", () => {
    const store = open();
    success(run(store, "section.remove", { section: "section_body" }));
    const versions = versionSections(store);
    expect(versions["language.en"]).toEqual({
      section_intro: { duration: { value: "31", base: "25" } },
    });
    const { problems, files } = store.exportFiles();
    expect(problems).toEqual([]);
    expect(files.get("timelines/main/overrides/language.en.json")).not.toContain("section_body");
  });

  it("goes back in one step", () => {
    const store = open();
    const before = structuredClone(main(store));
    success(run(store, "section.remove", { section: "section_body" }));
    success(store.undo());
    expect(main(store)).toEqual(before);
  });

  it("keeps the last section", () => {
    const store = ProjectStore.create(createProject({ name: "a" }));
    const [only] = Object.keys(main(store).sections);
    expect(failure(run(store, "section.remove", { section: only })).code).toBe("last-section");
  });
});

describe("section.split", () => {
  it("splits the section a moment is in, and the length stays", () => {
    const store = open();
    const clips = clipsOf(store);
    const made = success(run(store, "section.split", { at: "12", id: "s_new", name: "后半" }));
    expect(made).toEqual({ id: "s_new" });
    expect(layout(store)).toEqual([
      "section_intro 0-5",
      "section_body 5-12",
      "s_new 12-25",
      "section_end 25-30.005",
    ]);
    expect(main(store).sections["s_new"]?.name).toBe("后半");
    expect(main(store).sections["section_body"]?.name).toBe("讲解");
    expect(length(store)).toBe("30.005");
    expect(clipsOf(store)).toBe(clips);
  });

  it("splits the last section too", () => {
    const store = open();
    success(run(store, "section.split", { at: "28", id: "tail" }));
    expect(orderedSections(main(store)).map(({ id }) => id)).toEqual([
      "section_intro",
      "section_body",
      "section_end",
      "tail",
    ]);
    expect(layout(store).at(-1)).toBe("tail 28-30.005");
  });

  it.each([["0"], ["5"], ["25"]])("does not split where a section starts: %s", (at) => {
    const store = open();
    const error = failure(run(store, "section.split", { at }));
    expect(error).toMatchObject({ code: "invalid-value", params: { rule: "section-edge" } });
  });

  it("does not split at the end or after it", () => {
    const store = open();
    const error = failure(run(store, "section.split", { at: "30.005" }));
    expect(error).toMatchObject({ code: "invalid-value", params: { rule: "time-outside" } });
  });

  it("does not take an id the timeline has", () => {
    const store = open();
    expect(failure(run(store, "section.split", { at: "12", id: "clip_title" })).code).toBe(
      "id-taken",
    );
  });
});

describe("section.moveBoundary", () => {
  it("moves where one section ends and the next starts, and nothing else", () => {
    const store = open();
    const clips = clipsOf(store);
    success(run(store, "section.moveBoundary", { section: "section_intro", at: "7.5" }));
    expect(layout(store)).toEqual([
      "section_intro 0-7.5",
      "section_body 7.5-25",
      "section_end 25-30.005",
    ]);
    success(run(store, "section.moveBoundary", { section: "section_body", at: "24" }));
    expect(layout(store)).toEqual([
      "section_intro 0-7.5",
      "section_body 7.5-24",
      "section_end 24-30.005",
    ]);
    expect(clipsOf(store)).toBe(clips);
  });

  it.each([["5"], ["0"], ["25"], ["26"]])("keeps it inside the two sections: %s", (at) => {
    const store = open();
    const section = at === "5" ? "section_body" : "section_intro";
    const error = failure(run(store, "section.moveBoundary", { section, at }));
    expect(error).toMatchObject({ code: "invalid-value", params: { rule: "boundary-outside" } });
  });

  it("has no boundary after the last section", () => {
    const store = open();
    const error = failure(run(store, "section.moveBoundary", { section: "section_end", at: "29" }));
    expect(error).toMatchObject({ code: "invalid-value", params: { rule: "no-next-section" } });
  });
});

describe("section.update", () => {
  it("takes the name away", () => {
    const store = open();
    success(run(store, "section.update", { section: "section_body", clear: ["name"] }));
    expect(main(store).sections["section_body"]?.name).toBeUndefined();
    success(store.undo());
    expect(main(store).sections["section_body"]?.name).toBe("讲解");
  });
});

describe("marker.update", () => {
  it("takes fields away, and a marker without a duration is a point", () => {
    const store = open();
    success(
      run(store, "marker.update", {
        marker: "marker_hook",
        changes: { name: "开头" },
        clear: ["note", "color"],
      }),
    );
    expect(main(store).markers["marker_hook"]).toEqual({
      id: "marker_hook",
      time: "0.342",
      name: "开头",
    });
    success(
      run(store, "marker.update", { marker: "marker_turn", changes: {}, clear: ["duration"] }),
    );
    expect(main(store).markers["marker_turn"]?.duration).toBeUndefined();
    success(store.undo());
    expect(main(store).markers["marker_turn"]?.duration).toBe("2");
  });

  it("sets what it is given over what it would take away", () => {
    const store = open();
    success(
      run(store, "marker.update", {
        marker: "marker_turn",
        changes: { duration: "3" },
        clear: ["duration"],
      }),
    );
    expect(main(store).markers["marker_turn"]?.duration).toBe("3");
  });
});

/* What ripple edits will do to sections and markers. */

const t = (text: string): Rational => parseTime(text);
const ONE_FRAME = t("1/30");

const planText = (plan: ReturnType<typeof closingPlan>) => ({
  resized: Object.fromEntries([...plan.resized].map(([id, value]) => [id, formatTime(value)])),
  removed: plan.removed,
  markers: Object.fromEntries(
    [...plan.markers].map(([id, { time, duration }]) => [
      id,
      duration === undefined ? formatTime(time) : `${formatTime(time)}+${formatTime(duration)}`,
    ]),
  ),
});

describe("closingPlan", () => {
  // 片头 0-5, 讲解 5-25, 结尾 25-30.005; 钩子 at 0.342, 转折 5 to 7.
  it("shortens the sections it takes from and moves what comes after it", () => {
    const store = open();
    expect(planText(closingPlan(main(store), t("4"), t("6"), ONE_FRAME))).toEqual({
      resized: { section_intro: "4", section_body: "19" },
      removed: [],
      markers: { marker_turn: "4+1" },
    });
  });

  it("removes sections that are all in it", () => {
    const store = open();
    expect(planText(closingPlan(main(store), t("5"), t("25"), ONE_FRAME))).toEqual({
      resized: {},
      removed: ["section_body"],
      markers: { marker_turn: "5" },
    });
  });

  it("keeps the first section a frame long when all of them are in it", () => {
    const store = open();
    expect(planText(closingPlan(main(store), t("0"), t("30.005"), ONE_FRAME))).toEqual({
      resized: { section_intro: "1/30" },
      removed: ["section_body", "section_end"],
      markers: { marker_hook: "0", marker_turn: "0" },
    });
  });

  it("moves a marker in it to where it starts, and one after it by its length", () => {
    const store = open();
    expect(planText(closingPlan(main(store), t("0.2"), t("1"), ONE_FRAME))).toEqual({
      resized: { section_intro: "4.2" },
      removed: [],
      markers: { marker_hook: "0.2", marker_turn: "4.2+2" },
    });
  });

  it("leaves what is before it", () => {
    const store = open();
    expect(planText(closingPlan(main(store), t("26"), t("27"), ONE_FRAME))).toEqual({
      resized: { section_end: "4.005" },
      removed: [],
      markers: {},
    });
  });

  it("writes what it plans, and sections of versions go with their sections", () => {
    const store = open();
    const draft = new Draft(store.getState(), "user");
    applyGapPlan(draft, "main", closingPlan(main(store), t("4"), t("26"), ONE_FRAME));
    const after = draft.state.timelines["main"] as TimelineState;
    expect(
      placedSections(after).map(
        ({ id, start, end }) => `${id} ${formatTime(start)}-${formatTime(end)}`,
      ),
    ).toEqual(["section_intro 0-4", "section_end 4-8.005"]);
    expect(after.overrides["language.en"]?.sections?.["section_body"]).toBeUndefined();
    expect(after.overrides["language.en"]?.clips).toBeDefined();
    expect(after.markers["marker_turn"]).toEqual({ id: "marker_turn", time: "4", name: "转折" });
    expect(after.markers["marker_hook"]?.time).toBe("0.342");
  });
});

describe("openingPlan", () => {
  it("makes the section it goes into longer and moves what comes after it", () => {
    const store = open();
    expect(planText(openingPlan(main(store), t("10"), t("3")))).toEqual({
      resized: { section_body: "23" },
      removed: [],
      markers: {},
    });
    expect(planText(openingPlan(main(store), t("6"), t("3")))).toEqual({
      resized: { section_body: "23" },
      removed: [],
      markers: { marker_turn: "5+5" },
    });
  });

  it("goes into the section after a boundary, and into the last one at the end", () => {
    const store = open();
    expect(planText(openingPlan(main(store), t("5"), t("1"))).resized).toEqual({
      section_body: "21",
    });
    expect(planText(openingPlan(main(store), t("0"), t("1")))).toEqual({
      resized: { section_intro: "6" },
      removed: [],
      markers: { marker_hook: "1.342", marker_turn: "6+2" },
    });
    expect(planText(openingPlan(main(store), t("30.005"), t("1"))).resized).toEqual({
      section_end: "6.005",
    });
  });
});
