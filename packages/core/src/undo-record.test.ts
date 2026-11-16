/**
 * Taking back AI tasks and batches of files after the project was closed and opened again, see
 * `ProjectStore.saveUndo`. The random test that compares it with a store that stays open is in
 * fuzz-undo.test.ts.
 */
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { loadFixture } from "../../schema/scripts/fixture.ts";
import {
  ProjectStore,
  aiTask,
  folderBatch,
  repoBatch,
  type CommandResult,
  type ExecuteOptions,
} from "./store.ts";
import { isUndoRecord } from "./undo-record.ts";

function open(): ProjectStore {
  const files = loadFixture("v1");
  const manifest = JSON.parse(files.get("animaquill.json") as string);
  delete manifest.tags;
  files.set("animaquill.json", JSON.stringify(manifest));
  const { store } = ProjectStore.open(files);
  if (!store) throw new Error("fixture did not open");
  return store;
}

function success(result: CommandResult) {
  if (!result.ok) throw new Error(`${result.error.code}: ${JSON.stringify(result.error.params)}`);
  return result;
}

const property = (store: ProjectStore, path: string, id = "clip_title") =>
  store.getState().timelines["main"]?.clips[id]?.properties?.[path];

const setProperty = (
  store: ProjectStore,
  path: string,
  value: unknown,
  options: ExecuteOptions = {},
  id = "clip_title",
) =>
  success(
    store.execute(
      { type: "clip.setProperty", params: { timeline: "main", clip: id, path, value } },
      options,
    ),
  );

const rename = (store: ProjectStore, name: string, options: ExecuteOptions = {}) =>
  success(store.execute({ type: "project.rename", params: { name } }, options));

/** Everything a store would keep of its undo logs, through JSON as a host could keep it. */
const saved = (store: ProjectStore): unknown[] =>
  store.undoOrigins.map((origin) => JSON.parse(JSON.stringify(store.saveUndo(origin))));

/** The project closed and opened again, with what was saved of its undo logs at some time. */
function reopened(store: ProjectStore | Uint8Array, records: readonly unknown[]): ProjectStore {
  const update = store instanceof ProjectStore ? store.encodeState() : store;
  const { store: again } = ProjectStore.fromUpdates([update]);
  if (!again) throw new Error("did not open again");
  again.restoreUndo(records);
  return again;
}

const AI = aiTask("one");

describe("undo logs saved and read again", () => {
  it("take back a task and do it again after the project opened again", () => {
    const store = open();
    setProperty(store, "param.size", 80, { origin: AI });
    rename(store, "AI 改的", { origin: AI });
    const records = saved(store);
    expect(records.every(isUndoRecord)).toBe(true);
    const again = reopened(store, records);
    expect(again.undoOutlook(AI)).toEqual({ direction: "undo" });
    expect(again.undoOrigin(AI)).toMatchObject({ ok: true, kept: [] });
    expect(property(again, "param.size")).toBe(64);
    expect(again.getState().manifest.name).toBe("原子是什么");
    // Taken back there, saved, and opened once more: it can be done again.
    const third = reopened(again, saved(again));
    expect(third.undoOutlook(AI)).toEqual({ direction: "redo" });
    expect(third.redoOrigin(AI).ok).toBe(true);
    expect(property(third, "param.size")).toBe(80);
  });

  it("keep what people changed after they were saved", () => {
    const store = open();
    setProperty(store, "param.size", 80, { origin: AI });
    rename(store, "AI 改的", { origin: AI });
    const records = saved(store);
    rename(store, "我改的");
    const again = reopened(store, records);
    const result = again.undoOrigin(AI);
    expect(result).toMatchObject({ ok: true, kept: [["manifest", "name"]], obstacle: "changed" });
    expect(again.getState().manifest.name).toBe("我改的");
    expect(property(again, "param.size")).toBe(64);
  });

  it("say so where everything was changed since", () => {
    const store = open();
    rename(store, "AI 改的", { origin: AI });
    const records = saved(store);
    rename(store, "我改的");
    const again = reopened(store, records);
    expect(again.undoOutlook(AI)).toEqual({ direction: "undo", blocked: "changed" });
    expect(again.undoOrigin(AI).ok).toBe(false);
  });

  it("keep what another device wrote after they were saved", () => {
    const store = open();
    const other = new ProjectStore(new Y.Doc());
    Y.applyUpdate(other.doc, store.encodeState());
    rename(store, "AI 改的", { origin: AI });
    const records = saved(store);
    Y.applyUpdate(other.doc, Y.encodeStateAsUpdate(store.doc, Y.encodeStateVector(other.doc)));
    rename(other, "那台电脑改的");
    Y.applyUpdate(store.doc, Y.encodeStateAsUpdate(other.doc, Y.encodeStateVector(store.doc)));
    const again = reopened(store, records);
    expect(again.undoOutlook(AI).blocked).toBe("changed");
  });

  it("hand a place back to the task that wrote it before, as in the store that saved them", () => {
    const store = open();
    rename(store, "第一个任务", { origin: aiTask("a") });
    rename(store, "第二个任务", { origin: aiTask("b") });
    expect(store.undoOrigin(aiTask("b")).ok).toBe(true);
    const again = reopened(store, saved(store));
    expect(again.undoOrigin(aiTask("a")).ok).toBe(true);
    expect(again.getState().manifest.name).toBe("原子是什么");
  });

  it("come out the same in whatever order they are read, also one saved before the other", () => {
    const store = open();
    const [a, b] = [aiTask("a"), aiTask("b")];
    rename(store, "第一个任务", { origin: a });
    const first = JSON.parse(JSON.stringify(store.saveUndo(a)));
    rename(store, "第二个任务", { origin: b });
    store.undoOrigin(b);
    const second = JSON.parse(JSON.stringify(store.saveUndo(b)));
    for (const order of [
      [first, second],
      [second, first],
    ]) {
      const again = reopened(store, order);
      expect(again.undoOutlook(a)).toEqual(store.undoOutlook(a));
      expect(again.undoOutlook(b)).toEqual(store.undoOutlook(b));
    }
  });

  it("leave out one that cannot be taken up, and of another format of projects", () => {
    const store = open();
    rename(store, "AI 改的", { origin: AI });
    const [record] = saved(store) as [{ doc: { formatVersion: number } }];
    const older = {
      ...record,
      doc: { ...record.doc, formatVersion: record.doc.formatVersion - 1 },
    };
    // One that goes wrong as it is taken up, after it looked right.
    let looked = 0;
    const broken = {
      ...record,
      origin: aiTask("broken"),
      get marks() {
        looked += 1;
        if (looked > 1) throw new Error("broken");
        return (record as unknown as { marks: unknown }).marks;
      },
    };
    const fresh = reopened(store, []);
    expect(fresh.restoreUndo([older, broken, record])).toEqual([AI]);
    expect(fresh.undoOutlook(AI)).toEqual({ direction: "undo" });
  });

  it("hand a place back when people took back their own change after they were saved", () => {
    const store = open();
    rename(store, "AI 改的", { origin: AI });
    rename(store, "我改的");
    store.undo();
    // Saved again after people took something back, as the editor does.
    const again = reopened(store, saved(store));
    expect(again.undoOutlook(AI)).toEqual({ direction: "undo" });
  });

  it("keep a clip that people changed after a task made it", () => {
    const store = open();
    const added = success(
      store.execute(
        {
          type: "clip.add",
          params: {
            timeline: "main",
            track: Object.keys(store.getState().timelines["main"]?.tracks ?? {})[0],
            start: "40",
            duration: "1",
            source: { kind: "color", color: "#112233" },
            overlap: "overwrite",
          },
        },
        { origin: AI },
      ),
    );
    const id = added.patches[0]?.path[3] as string;
    const records = saved(store);
    const before = store.encodeState();
    setProperty(store, "opacity", 0.5, {}, id);
    const again = reopened(store, records);
    // The clip stays, with what people changed; the rest of the task goes, as without a reload.
    const clip = ["timelines", "main", "clips", id];
    expect(again.undoOrigin(AI)).toMatchObject({ ok: true, kept: [clip], obstacle: "changed" });
    expect(store.undoOrigin(AI)).toMatchObject({ ok: true, kept: [clip], obstacle: "changed" });
    expect(again.getState()).toEqual(store.getState());
    // Without the change of people it goes.
    expect(reopened(before, records).undoOrigin(AI)).toMatchObject({ ok: true, kept: [] });
  });

  it("take back batches of the folder and of the repository, also one the platform wrote", () => {
    const store = open();
    const code = Object.keys(store.getState().files)[0] as string;
    const base = store.getState().files[code] as string;
    const merge = (origin: string, text: string, before: string) =>
      store.mergeFiles([{ path: code, base: before, text }], {
        origin,
        baseOf: (path) => store.exportFiles().files.get(path),
      });
    expect(merge(folderBatch("tool-1"), `${base}// tool\n`, base).ok).toBe(true);
    const repo = store.writeAsPlatform(() =>
      merge(repoBatch("r1"), `// repo\n${base}// tool\n`, `${base}// tool\n`),
    );
    expect(repo.ok).toBe(true);
    const again = reopened(store, saved(store));
    expect(again.undoOrigin(repoBatch("r1")).ok).toBe(true);
    expect(again.undoOrigin(folderBatch("tool-1")).ok).toBe(true);
    expect(again.getState().files[code]).toBe(base);
  });

  it("count for a copy that lacks the last changes, which stay where they are", () => {
    const store = open();
    rename(store, "AI 改的", { origin: AI });
    const before = store.encodeState();
    setProperty(store, "param.size", 80, { origin: AI });
    const again = reopened(before, saved(store));
    const result = again.undoOrigin(AI);
    expect(result).toMatchObject({ ok: true, obstacle: "changed" });
    expect(again.getState().manifest.name).toBe("原子是什么");
  });

  it("are left out for another document of the same project, and where they cannot be read", () => {
    const store = open();
    rename(store, "AI 改的", { origin: AI });
    const records = saved(store);
    const other = open();
    expect(other.restoreUndo(records)).toEqual([]);
    expect(other.restoreUndo([{ format: 99 }, null, "x"])).toEqual([]);
    // Nor one with a path that would reach every object.
    const [record] = records as [{ done: { steps: { patch: { path: string[] } }[] }[] }];
    const poisoned = structuredClone(record);
    const patch = poisoned.done[0]?.steps[0]?.patch;
    if (!patch) throw new Error("no step");
    patch.path = ["__proto__", "x"];
    expect(store.restoreUndo([poisoned], { replace: true })).toEqual([]);
    expect(other.canUndoOrigin(AI)).toBe(false);
  });

  it("only take the place of a log of this store when asked to", () => {
    const store = open();
    rename(store, "AI 改的", { origin: AI });
    const records = saved(store);
    const twin = reopened(store, records);
    twin.undoOrigin(AI);
    const after = saved(twin);
    Y.applyUpdate(store.doc, Y.encodeStateAsUpdate(twin.doc, Y.encodeStateVector(store.doc)));
    expect(store.restoreUndo(after)).toEqual([]);
    expect(store.canUndoOrigin(AI)).toBe(true);
    expect(store.restoreUndo(after, { replace: true })).toEqual([AI]);
    expect(store.undoOutlook(AI)).toEqual({ direction: "redo" });
    expect(store.undoOrigin(AI).ok).toBe(false);
  });

  it("are gone with forgetUndo", () => {
    const store = open();
    rename(store, "AI 改的", { origin: AI });
    store.forgetUndo(AI);
    expect(store.undoOrigins).toEqual([]);
    expect(store.saveUndo(AI)).toBeUndefined();
  });
});
