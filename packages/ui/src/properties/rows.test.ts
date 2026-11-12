import { ProjectStore, orderedTracks } from "@animaquill/core";
import { createProject, type PropertySpec } from "@animaquill/schema";
import { describe, expect, it } from "vitest";
import { Emitter } from "../workbench/emitter.ts";
import { buildModel, type TimelineModel } from "../timeline/model.ts";
import { inspectSelection } from "./inspect.ts";
import { placeOf, PropertyRows } from "./rows.ts";

function setup() {
  const format = { id: "f", name: "画幅", width: 1920, height: 1080, fps: "30" };
  const store = ProjectStore.create(createProject({ name: "属性", format }));
  const main = () => {
    const timeline = store.getState().timelines["main"];
    if (!timeline) throw new Error("no timeline");
    return timeline;
  };
  const track = orderedTracks(main()).find(({ kind }) => kind === "video")?.id;
  const properties = {
    "transform.x": {
      keys: [
        { time: "0", value: 0 },
        { time: "1", value: 30 },
      ],
    },
  };
  const source = { kind: "color", color: "#ff0000" };
  const clip = { id: "c", start: "1", duration: "2", properties, source };
  const added = store.execute({ type: "clip.add", params: { timeline: "main", track, ...clip } });
  if (!added.ok) throw new Error(`${added.error.code}: ${JSON.stringify(added.error.params)}`);
  const view = new Emitter();
  const project = new Emitter();
  const tried = new Emitter();
  const trialSnapshot = { comparing: false };
  let frame = 0;
  let model: TimelineModel = buildModel("main", main(), "30");
  store.subscribe(() => {
    model = buildModel("main", main(), "30");
    project.emit();
  });
  const rows = new PropertyRows({
    timeline: {
      get model() {
        return model;
      },
      get frame() {
        return frame;
      },
      subscribe: project.subscribe,
      subscribeView: view.subscribe,
    },
    trials: {
      look: undefined,
      // As the trial session has it: the same until something changes.
      getSnapshot: () => trialSnapshot,
      subscribe: tried.subscribe,
    },
    state: () => store.getState(),
  });
  const selected = inspectSelection(model, new Set(["c"]));
  if (selected.kind !== "clip") throw new Error(selected.kind);
  const spec = (path: string) =>
    selected.objects.flatMap((object) => object.properties).find((one) => one.path === path) as
      PropertySpec | undefined;
  const go = (to: number) => {
    frame = to;
    view.emit();
  };
  return { store, rows, spec, go, view };
}

describe("rows of the properties tab", () => {
  it("say something new only when what they show changes", () => {
    const { rows, spec, go } = setup();
    const x = spec("transform.x") as PropertySpec;
    const y = spec("transform.y") as PropertySpec;
    go(30);
    const [atX, atY] = [rows.signatureOf("c", x), rows.signatureOf("c", y)];
    go(40);
    // Where it goes, x changes, and y stays what it was.
    expect(rows.signatureOf("c", x)).not.toBe(atX);
    expect(rows.signatureOf("c", y)).toBe(atY);
    expect(rows.inspect("c", x)?.row.value).toBe(10);
  });

  it("hear of the playhead, the project and what is tried", () => {
    const { rows, go, store } = setup();
    let heard = 0;
    const stop = rows.subscribe(() => (heard += 1));
    go(1);
    store.execute({
      type: "clip.update",
      params: { timeline: "main", clip: "c", changes: { name: "红" } },
    });
    expect(heard).toBe(2);
    stop();
    go(2);
    expect(heard).toBe(2);
  });

  it("know where their clip can change, which stays the same inside it", () => {
    const { rows, go } = setup();
    go(0);
    expect(placeOf(rows.placeOf("c"))).toEqual({ blocked: "outside", firstFrame: 30 });
    go(31);
    const inside = rows.placeOf("c");
    go(50);
    expect(rows.placeOf("c")).toBe(inside);
    expect(placeOf(inside).blocked).toBeUndefined();
  });

  it("look once for each moment, however often they are asked", () => {
    const { rows, spec, go, store } = setup();
    const x = spec("transform.x") as PropertySpec;
    go(40);
    const first = rows.inspect("c", x);
    expect(rows.inspect("c", x)).toBe(first);
    go(41);
    expect(rows.inspect("c", x)).not.toBe(first);
    const moved = rows.inspect("c", x);
    store.execute({
      type: "clip.update",
      params: { timeline: "main", clip: "c", changes: { name: "红" } },
    });
    expect(rows.inspect("c", x)).not.toBe(moved);
  });

  it("have nothing to show of a clip that is gone", () => {
    const { rows, spec, store } = setup();
    const x = spec("transform.x") as PropertySpec;
    store.execute({ type: "clip.remove", params: { timeline: "main", clips: ["c"] } });
    expect(rows.inspect("c", x)).toBeUndefined();
    expect(rows.signatureOf("c", x)).toBe("");
    expect(rows.placeOf("c")).toBe("");
  });
});
