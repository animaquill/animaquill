/**
 * What an AI task changed, before and after, from its undo log (`ProjectStore.beforeAfterOf`): the
 * same whether it is done or taken back, after people changed some of it, and after the project
 * was opened again.
 */
import { describe, expect, it } from "vitest";
import { loadFixture } from "../../schema/scripts/fixture.ts";
import { getIn } from "./patch.ts";
import {
  ProjectStore,
  USER,
  aiTask,
  type CommandCall,
  type CommandResult,
  type ExecuteOptions,
  type UndoResult,
} from "./store.ts";

function open(): ProjectStore {
  const files = loadFixture("v1");
  const manifest = JSON.parse(files.get("animaquill.json") as string);
  delete manifest.tags;
  files.set("animaquill.json", JSON.stringify(manifest));
  const { store } = ProjectStore.open(files);
  if (!store) throw new Error("fixture did not open");
  return store;
}

function success<T extends CommandResult | UndoResult>(result: T): Extract<T, { ok: true }> {
  if (!result.ok) throw new Error(`${result.error.code}: ${JSON.stringify(result.error.params)}`);
  return result as Extract<T, { ok: true }>;
}

const run = (store: ProjectStore, call: CommandCall, options: ExecuteOptions = {}) =>
  success(store.execute(call, options));

const AI = aiTask("one");
const CLIP = ["timelines", "main", "clips", "clip_title"];
const SCENE_CODE = ["files", "scenes/title/index.html"];

const setProperty = (path: string, value: unknown, clip = "clip_title"): CommandCall => ({
  type: "clip.setProperty",
  params: { timeline: "main", clip, path, value },
});

const ANIMATED = {
  keys: [
    { time: "0", value: 0 },
    { time: "2", value: 1 },
  ],
};

/** A task of each shape: a value, keys, code, and a clip that goes, as one batch after another. */
function aiChanges(store: ProjectStore): void {
  // Twice at one place: before is what the first found, after what the last wrote.
  run(store, setProperty("param.size", 70), { origin: AI });
  run(store, setProperty("opacity", ANIMATED), { origin: AI });
  run(store, setProperty("param.size", 80), { origin: AI });
  run(
    store,
    { type: "file.write", params: { path: "scenes/title/index.html", text: "<p>new</p>\n" } },
    { origin: AI },
  );
  run(
    store,
    { type: "clip.remove", params: { timeline: "main", clips: ["clip_idea"] } },
    {
      origin: AI,
    },
  );
  run(
    store,
    {
      type: "clip.update",
      params: { timeline: "main", clip: "clip_title", changes: { duration: "4" } },
    },
    { origin: AI },
  );
}

const at = (state: unknown, path: readonly string[]) => getIn(state, path);

describe("before and after an AI task", () => {
  it("are the project when it started and as it ended, right after it", () => {
    const store = open();
    const start = store.getState();
    aiChanges(store);
    const end = store.getState();
    const seen = store.beforeAfterOf(AI);
    expect(seen?.before).toEqual(start);
    expect(seen?.after).toEqual(end);
  });

  it("have each shape: a value, keys, code, a clip that went", () => {
    const store = open();
    aiChanges(store);
    const { before, after } = store.beforeAfterOf(AI) ?? {};
    expect(at(before, [...CLIP, "properties", "param.size"])).toBe(64);
    expect(at(after, [...CLIP, "properties", "param.size"])).toBe(80);
    expect(at(before, [...CLIP, "properties", "opacity"])).not.toEqual(ANIMATED);
    expect(at(after, [...CLIP, "properties", "opacity"])).toEqual(ANIMATED);
    expect(at(before, SCENE_CODE)).toContain("<");
    expect(at(before, SCENE_CODE)).not.toBe("<p>new</p>\n");
    expect(at(after, SCENE_CODE)).toBe("<p>new</p>\n");
    expect(at(before, ["timelines", "main", "clips", "clip_idea"])).toBeDefined();
    expect(at(after, ["timelines", "main", "clips", "clip_idea"])).toBeUndefined();
    expect(at(before, [...CLIP, "duration"])).toBe("5");
    expect(at(after, [...CLIP, "duration"])).toBe("4");
  });

  it("show what AI wrote where people changed it since, and the rest as it is now", () => {
    const store = open();
    aiChanges(store);
    run(store, setProperty("param.size", 99));
    run(store, setProperty("transform.x", 5));
    const { before, after } = store.beforeAfterOf(AI) ?? {};
    expect(at(after, [...CLIP, "properties", "param.size"])).toBe(80);
    expect(at(before, [...CLIP, "properties", "param.size"])).toBe(64);
    // Not this task's: the same both ways, as it is now.
    expect(at(before, [...CLIP, "properties", "transform.x"])).toBe(5);
    expect(at(after, [...CLIP, "properties", "transform.x"])).toBe(5);
  });

  it("stay the same once the task is taken back, and done again", () => {
    const store = open();
    const start = store.getState();
    aiChanges(store);
    const end = store.getState();
    success(store.undoOrigin(AI));
    expect(store.beforeAfterOf(AI)).toEqual({ before: start, after: end });
    success(store.redoOrigin(AI));
    expect(store.beforeAfterOf(AI)).toEqual({ before: start, after: end });
  });

  it("are the same after the project was opened again with its saved log", () => {
    const store = open();
    aiChanges(store);
    run(store, setProperty("param.size", 99));
    const expected = store.beforeAfterOf(AI);
    const record = JSON.parse(JSON.stringify(store.saveUndo(AI)));
    const { store: again } = ProjectStore.fromUpdates([store.encodeState()]);
    again?.restoreUndo([record]);
    expect(again?.beforeAfterOf(AI)).toEqual(expected);

    // And once it was taken back there.
    success(store.undoOrigin(AI));
    const undone = JSON.parse(JSON.stringify(store.saveUndo(AI)));
    const { store: third } = ProjectStore.fromUpdates([store.encodeState()]);
    third?.restoreUndo([undone]);
    expect(third?.beforeAfterOf(AI)).toEqual(store.beforeAfterOf(AI));
  });

  it("make up nothing of a clip that somebody took away since", () => {
    const store = open();
    run(store, setProperty("param.size", 80), { origin: AI });
    run(store, { type: "clip.remove", params: { timeline: "main", clips: ["clip_title"] } });
    const { before, after } = store.beforeAfterOf(AI) ?? {};
    expect(at(before, CLIP)).toBeUndefined();
    expect(at(after, CLIP)).toBeUndefined();
  });

  it("have a clip that AI added only after", () => {
    const store = open();
    const added = run(
      store,
      {
        type: "clip.add",
        params: {
          timeline: "main",
          track: "track_overlay",
          start: "40",
          duration: "1",
          source: { kind: "color", color: "#112233" },
        },
      },
      { origin: AI },
    );
    const id = (added.results[0] as { id: string }).id;
    const { before, after } = store.beforeAfterOf(AI) ?? {};
    expect(at(before, ["timelines", "main", "clips", id])).toBeUndefined();
    expect(at(after, ["timelines", "main", "clips", id])).toMatchObject({ start: "40" });
  });

  it("are not there without a log: of people, of a task this store never had, once forgotten", () => {
    const store = open();
    run(store, setProperty("param.size", 80));
    expect(store.beforeAfterOf(USER)).toBeUndefined();
    expect(store.beforeAfterOf(aiTask("elsewhere"))).toBeUndefined();
    run(store, setProperty("param.size", 70), { origin: AI });
    expect(store.beforeAfterOf(AI)).toBeDefined();
    store.forgetUndo(AI);
    expect(store.beforeAfterOf(AI)).toBeUndefined();
  });

  it("follow the project: another change elsewhere shows on both sides", () => {
    const store = open();
    run(store, setProperty("param.size", 80), { origin: AI });
    const first = store.beforeAfterOf(AI);
    expect(store.beforeAfterOf(AI)).toBe(first);
    run(store, { type: "project.rename", params: { name: "后来改的" } });
    const second = store.beforeAfterOf(AI);
    expect(second).not.toBe(first);
    expect(second?.before.manifest.name).toBe("后来改的");
    expect(second?.after.manifest.name).toBe("后来改的");
  });
});
