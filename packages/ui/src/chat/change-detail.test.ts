import {
  ProjectStore,
  aiTask,
  type CommandCall,
  type CommandResult,
  type ExecuteOptions,
} from "@animaquill/core";
import { describe, expect, it } from "vitest";
import { loadFixture } from "../../../schema/scripts/fixture.ts";
import { detailOf, hasKeys, keysChart, keysOf, mayOpen, shapeOf } from "./change-detail.ts";
import type { TurnChange } from "./summary.ts";

/**
 * What a line of the card of a task shows when it opens (S-D1): fields before and after, keys as
 * curves, code, the moment of the picture, and nothing for a line that has nothing more.
 */

function open(): ProjectStore {
  const files = loadFixture("v1");
  // Its tags lock it.
  const manifest = JSON.parse(files.get("animaquill.json") as string);
  delete manifest.tags;
  files.set("animaquill.json", JSON.stringify(manifest));
  const { store } = ProjectStore.open(files);
  if (!store) throw new Error("fixture did not open");
  return store;
}

const AI = aiTask("t");

function run(store: ProjectStore, call: CommandCall, options: ExecuteOptions = { origin: AI }) {
  const result: CommandResult = store.execute(call, options);
  if (!result.ok) throw new Error(result.error.code);
  return result;
}

const setProperty = (path: string, value: unknown, clip = "clip_title"): CommandCall => ({
  type: "clip.setProperty",
  params: { timeline: "main", clip, path, value },
});

const clipChange = (
  id: string,
  change: TurnChange["change"],
  fields: readonly string[] = [],
): TurnChange => ({
  key: id,
  kind: "clip",
  id,
  timeline: "main",
  change,
  fields: fields.map((path) => ({ path })),
});

function seen(store: ProjectStore) {
  const value = store.beforeAfterOf(AI);
  if (!value) throw new Error("no log");
  return value;
}

describe("a line of the card, opened", () => {
  it("has each field it changed, before and after, and the moment of the clip", () => {
    const store = open();
    run(store, setProperty("param.size", 80));
    run(store, {
      type: "clip.update",
      params: { timeline: "main", clip: "clip_title", changes: { duration: "4" } },
    });
    const change = clipChange("clip_title", "changed", ["duration", "properties.param.size"]);
    const detail = detailOf(change, seen(store));
    expect(detail?.fields).toEqual([
      { path: "duration", before: "5", after: "4" },
      { path: "properties.param.size", before: 64, after: 80 },
    ]);
    // On a video track: its middle, after the change.
    expect(detail?.picture).toEqual({ timeline: "main", seconds: 2 });
    expect(detail?.clock).toEqual({ from: 0, to: 4 });
  });

  it("draws keys of numbers as two curves, and lists those of anything else", () => {
    const store = open();
    run(
      store,
      setProperty("opacity", {
        keys: [
          { time: "0", value: 0 },
          { time: "4", value: 1 },
        ],
      }),
    );
    run(
      store,
      setProperty("param.accent", {
        keys: [
          { time: "0", value: "#ff0000" },
          { time: "1", value: "#00ff00" },
        ],
      }),
    );
    const detail = detailOf(
      clipChange("clip_title", "changed", ["properties.opacity", "properties.param.accent"]),
      seen(store),
    );
    const [opacity, accent] = detail?.fields ?? [];
    expect(opacity && hasKeys(opacity)).toBe(true);
    const chart = opacity && keysChart(opacity, detail?.clock);
    expect(chart?.lines.map(({ side }) => side)).toEqual(["before", "after"]);
    expect(chart?.lines[1]?.points.split(" ")).toHaveLength(64);
    expect(chart?.dots.filter(({ side }) => side === "after")).toHaveLength(2);
    // The fixture has three keys there.
    expect(chart?.dots.filter(({ side }) => side === "before")).toHaveLength(3);
    expect(accent && keysChart(accent, detail?.clock)).toBeUndefined();
    // A value without keys is one flat line, without dots.
    const still = keysChart(
      { path: "properties.opacity", before: 0.5, after: { keys: [{ time: "1", value: 1 }] } },
      { from: 0, to: 2 },
    );
    expect(still?.dots.map(({ side }) => side)).toEqual(["after"]);
    expect(new Set(still?.lines[0]?.points.split(" ").map((point) => point.split(",")[1]))).toEqual(
      new Set(["52"]),
    );
    expect(keysOf(accent?.after)).toEqual([
      { time: 0, value: "#ff0000" },
      { time: 1, value: "#00ff00" },
    ]);
  });

  it("has the code of a file before and after, and the scene of it to look at", () => {
    const store = open();
    run(store, {
      type: "file.write",
      params: { path: "scenes/title/index.html", text: "<p>new</p>\n" },
    });
    const detail = detailOf(
      {
        key: "f",
        kind: "file",
        id: "scenes/title/index.html",
        change: "changed",
        fields: [],
        lines: { added: 1, removed: 3 },
      },
      seen(store),
      "main",
    );
    expect(detail?.code).toMatchObject({ path: "scenes/title/index.html", after: "<p>new</p>\n" });
    expect(detail?.code?.before).toContain("<");
    expect(detail?.code?.large).toBe(false);
    // The first clip of the scene on the timeline people look at.
    expect(detail?.picture).toEqual({ timeline: "main", seconds: 2.5 });
  });

  it("has only the picture of a clip that went, and nothing of one that cannot be seen", () => {
    const store = open();
    run(store, {
      type: "clip.remove",
      params: { timeline: "main", clips: ["clip_idea", "clip_hit"] },
    });
    const both = seen(store);
    expect(detailOf(clipChange("clip_idea", "removed"), both)).toEqual({
      fields: [],
      picture: { timeline: "main", seconds: 11 },
      clock: { from: 0, to: 2 },
    });
    // A sound on an audio track: nothing beyond its sentence.
    expect(detailOf(clipChange("clip_hit", "removed"), both)).toBeUndefined();
  });

  it("has no picture where only where it is or how long changed: the two would be alike", () => {
    const store = open();
    run(store, {
      type: "clip.update",
      params: { timeline: "main", clip: "clip_title", changes: { duration: "4" } },
    });
    const detail = detailOf(clipChange("clip_title", "changed", ["duration"]), seen(store));
    expect(detail?.picture).toBeUndefined();
    expect(detail?.fields).toEqual([{ path: "duration", before: "5", after: "4" }]);
  });

  it("has no picture where only the name of a clip changed", () => {
    const store = open();
    run(store, {
      type: "clip.update",
      params: { timeline: "main", clip: "clip_title", changes: { name: "新名字" } },
    });
    const detail = detailOf(clipChange("clip_title", "changed", ["name"]), seen(store));
    expect(detail?.picture).toBeUndefined();
    expect(detail?.fields).toHaveLength(1);
  });
});

describe("whether a line may open at all", () => {
  it("is so for code, fields, and what can be in the picture; never without a log", () => {
    expect(mayOpen(clipChange("c", "removed"))).toBe("maybe");
    expect(mayOpen(clipChange("c", "changed", ["duration"]))).toBe("surely");
    expect(mayOpen({ ...clipChange("m", "removed"), kind: "marker" })).toBe("never");
    expect(mayOpen({ ...clipChange("t", "changed", ["position"]), kind: "track" })).toBe("never");
    expect(mayOpen({ ...clipChange("t", "changed", ["name"]), kind: "track" })).toBe("surely");
    const store = open();
    expect(store.beforeAfterOf(AI)).toBeUndefined();
  });
});

describe("values", () => {
  it("show as the properties panel has them", () => {
    expect(shapeOf("duration", "2.5")).toEqual({ kind: "time", seconds: 2.5 });
    expect(shapeOf("enter.duration", "1/2")).toEqual({ kind: "time", seconds: 0.5 });
    expect(shapeOf("properties.param.accent", "#ff8800")).toEqual({
      kind: "color",
      color: "#ff8800",
    });
    expect(shapeOf("loop", true)).toEqual({ kind: "boolean", on: true });
    expect(shapeOf("properties.opacity", 0.33333)).toEqual({ kind: "text", text: "0.333" });
    expect(shapeOf("properties.transform.scale", [1, 2])).toEqual({ kind: "text", text: "1, 2" });
    expect(shapeOf("name", undefined)).toEqual({ kind: "none" });
    // A built-in property that is not there has its default.
    expect(shapeOf("properties.opacity", undefined)).toEqual({ kind: "text", text: "1" });
    expect(shapeOf("name", "<b>x</b>")).toEqual({ kind: "text", text: "<b>x</b>" });
  });
});
