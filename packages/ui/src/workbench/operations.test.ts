import {
  ProjectStore,
  aiTask,
  folderBatch,
  orderedTracks,
  type CommandCall,
} from "@animaquill/core";
import { createProject } from "@animaquill/schema";
import type { TFunction } from "i18next";
import { describe, expect, it } from "vitest";
import { operationText } from "../app/operation-text.ts";
import { createI18n } from "../i18n/i18n.ts";
import { Emitter } from "./emitter.ts";
import { OperationLog, type StoreSource } from "./operations.ts";

const red = { kind: "color", color: "#ff0000" };

/** A source of stores that can change, as the project session is. */
function sourceOf(store: ProjectStore | undefined) {
  const emitter = new Emitter();
  let snapshot = { store };
  const source: StoreSource = {
    subscribe: emitter.subscribe,
    getSnapshot: () => snapshot,
  };
  return {
    source,
    open(next: ProjectStore | undefined) {
      snapshot = { store: next };
      emitter.emit();
    },
  };
}

function setup() {
  const store = ProjectStore.create(createProject({ name: "操作" }));
  const timeline = store.getState().timelines["main"];
  const track = timeline && orderedTracks(timeline).find(({ kind }) => kind === "video")?.id;
  const run = (calls: readonly CommandCall[], origin?: string) => {
    const result = store.executeBatch(calls, origin === undefined ? {} : { origin });
    if (!result.ok) throw new Error(result.error.message);
  };
  let next = 0;
  const add = (id: string, origin?: string) => {
    const clip = { id, start: String(next++), duration: "1", source: red };
    run([{ type: "clip.add", params: { timeline: "main", track, clip } }], origin);
  };
  const opacity = (id: string, value: number) =>
    run([
      {
        type: "property.edit",
        params: {
          timeline: "main",
          edits: [{ owner: { clip: id }, path: "opacity", op: "set", value }],
        },
      },
    ]);
  const { source, open } = sourceOf(store);
  const log = new OperationLog(source);
  return { store, log, add, opacity, run, open };
}

/** After the log has heard all of it. */
const settled = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

let loaded: TFunction | undefined;
async function words(): Promise<TFunction> {
  loaded ??= (await createI18n()).t;
  return loaded;
}

describe("the list of what changed the project", () => {
  it("names what people did here, newest first, with properties by their names", async () => {
    const { log, add, opacity } = setup();
    add("a");
    opacity("a", 0.5);
    await settled();
    const t = await words();
    const list = log.getSnapshot();
    expect(list.map((operation) => operationText(t, operation))).toEqual([
      "改了不透明度",
      "添加片段",
    ]);
    expect(list.map(({ source }) => source)).toEqual(["you", "you"]);
  });

  it("takes back up to a step from there, and does the last one again", async () => {
    const { log, store, add } = setup();
    add("a");
    add("b");
    add("c");
    await settled();
    const [c, b, a] = log.getSnapshot();
    if (!a || !b || !c) throw new Error("not listed");
    expect([a, b, c].every((operation) => log.canUndoTo(operation))).toBe(true);
    store.undo();
    store.undo();
    await settled();
    const list = log.getSnapshot();
    expect(list.map(({ undone }) => undone)).toEqual([true, true, false]);
    // What was taken back last comes back first, and only that.
    expect(log.redoable?.id).toBe(b.id);
    store.redo();
    await settled();
    expect(log.getSnapshot().map(({ undone }) => undone)).toEqual([true, false, false]);
    expect(log.redoable?.id).toBe(c.id);
    // Something new leaves nothing to do again.
    add("d");
    await settled();
    expect(log.getSnapshot()).toHaveLength(3);
    expect(log.redoable).toBeUndefined();
    expect(Object.keys(store.getState().timelines["main"]?.clips ?? {}).toSorted()).toEqual([
      "a",
      "b",
      "d",
    ]);
  });

  it("has an AI task and a batch of files as one each, which go back as a whole", async () => {
    const { log, store, add } = setup();
    const task = aiTask("t1");
    add("a", task);
    add("b", task);
    add("c");
    add("d", task);
    add("e", folderBatch("1"));
    await settled();
    const t = await words();
    const list = log.getSnapshot();
    expect(list.map((operation) => operationText(t, operation))).toEqual([
      "外部文件：并入 1 个文件",
      "AI：改了 3 处",
      "添加片段",
    ]);
    const ai = list[1];
    if (!ai) throw new Error("not listed");
    expect(log.canUndoOrigin(ai)).toBe(true);
    store.undoOrigin(task);
    await settled();
    expect(log.getSnapshot()[1]?.undone).toBe(true);
    expect(log.canUndoOrigin(ai)).toBe(false);
    expect(log.canRedoOrigin(ai)).toBe(true);
    // Taking back the AI task is no step of the person here.
    expect(log.getSnapshot()[2]?.undone).toBe(false);
  });

  it("lists what another window did, which it cannot take back", async () => {
    const { log, store } = setup();
    const other = ProjectStore.fromUpdates([store.encodeState()]).store;
    if (!other) throw new Error("no copy");
    const updates: Uint8Array[] = [];
    other.onLocalUpdate((update) => updates.push(update));
    const timeline = other.getState().timelines["main"];
    const track = timeline && orderedTracks(timeline).find(({ kind }) => kind === "video")?.id;
    other.execute({
      type: "clip.add",
      params: {
        timeline: "main",
        track,
        clip: { id: "x", start: "0", duration: "1", source: red },
      },
    });
    store.applyUpdates(updates);
    await settled();
    const [operation] = log.getSnapshot();
    expect(operation?.source).toBe("other");
    expect(operation && log.canUndoTo(operation)).toBe(false);
  });

  it("starts afresh with another project, and keeps only the latest", async () => {
    const { log, add, open } = setup();
    for (let index = 0; index < 40; index++) add(`c${index}`);
    await settled();
    expect(log.getSnapshot()).toHaveLength(30);
    open(ProjectStore.create(createProject({ name: "另一个" })));
    await settled();
    expect(log.getSnapshot()).toEqual([]);
  });
});
