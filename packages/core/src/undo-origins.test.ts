/**
 * Taking back several AI tasks at once, as "back to before this turn" does: `undoOrigins` and
 * `redoOrigins`. The random test that compares them with taking back one task after the other is in
 * fuzz-undo-origins.test.ts.
 */
import { describe, expect, it } from "vitest";
import { loadFixture } from "../../schema/scripts/fixture.ts";
import {
  ProjectStore,
  aiTask,
  folderBatch,
  repoBatch,
  type CommandCall,
  type CommandResult,
  type ExecuteOptions,
  type ManyUndoResult,
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

function success(result: CommandResult) {
  if (!result.ok) throw new Error(`${result.error.code}: ${JSON.stringify(result.error.params)}`);
  return result;
}

const size = (store: ProjectStore) =>
  store.getState().timelines["main"]?.clips["clip_title"]?.properties?.["param.size"];

const setSize = (store: ProjectStore, value: number, options: ExecuteOptions = {}) =>
  success(
    store.execute(
      {
        type: "clip.setProperty",
        params: { timeline: "main", clip: "clip_title", path: "param.size", value },
      },
      options,
    ),
  );

const rename = (store: ProjectStore, name: string, options: ExecuteOptions = {}) =>
  success(store.execute({ type: "project.rename", params: { name } }, options));

const write = (store: ProjectStore, path: string, text: string, options: ExecuteOptions = {}) =>
  success(store.execute({ type: "file.write", params: { path, text } }, options));

const name = (store: ProjectStore) => store.getState().manifest.name;

/** Which origins went how, in the order they went. */
const went = (result: ManyUndoResult) => {
  if (!result.ok) throw new Error(result.error.code);
  return result.each.map(({ origin, result: each }) => [
    origin,
    each.ok ? each.kept.length : each.error.code,
  ]);
};

const ONE = aiTask("one");
const TWO = aiTask("two");
const THREE = aiTask("three");

/** Three turns of a conversation: the second and the third write where the one before did. */
function threeTurns(store = open()) {
  setSize(store, 70, { origin: ONE });
  rename(store, "第一轮", { origin: ONE });
  setSize(store, 80, { origin: TWO });
  write(store, "code/two.js", "// two\n", { origin: TWO });
  setSize(store, 90, { origin: THREE });
  rename(store, "第三轮", { origin: THREE });
  return store;
}

describe("taking back several turns at once", () => {
  it("goes back to before the first, the newest first whatever order they come in", () => {
    const store = threeTurns();
    const result = store.undoOrigins([ONE, THREE, TWO]);
    expect(went(result)).toEqual([
      [THREE, 0],
      [TWO, 0],
      [ONE, 0],
    ]);
    expect(size(store)).toBe(64);
    expect(name(store)).toBe("原子是什么");
    expect(store.getState().files["code/two.js"]).toBeUndefined();
    // Each is a change of its own, which each card can do again.
    expect([ONE, TWO, THREE].map((origin) => store.canRedoOrigin(origin))).toEqual([
      true,
      true,
      true,
    ]);
  });

  it("old to new would leave what an earlier turn wrote where a later one wrote again", () => {
    // What undoOrigins saves people from: one after the other the wrong way round.
    const store = threeTurns();
    for (const origin of [ONE, TWO, THREE]) store.undoOrigin(origin);
    expect(size(store)).toBe(80);
    expect(name(store)).toBe("第一轮");
  });

  it("a dry run says the same as the real one and writes nothing", () => {
    const store = threeTurns();
    setSize(store, 100);
    const revision = store.revision;
    const dry = store.undoOrigins([TWO, THREE], { dryRun: true });
    expect(store.revision).toBe(revision);
    expect(size(store)).toBe(100);
    expect(store.canUndoOrigin(TWO)).toBe(true);
    const real = store.undoOrigins([TWO, THREE]);
    const strip = (result: ManyUndoResult) =>
      result.ok
        ? result.each.map(({ origin, result: each }) =>
            each.ok
              ? { origin, patches: each.patches, kept: each.kept, obstacle: each.obstacle }
              : { origin, error: each.error },
          )
        : result;
    expect(strip(dry)).toEqual(strip(real));
  });

  it("keeps what people changed since, and what they took back of their own goes", () => {
    const store = threeTurns();
    setSize(store, 100);
    const result = store.undoOrigins([ONE, TWO, THREE]);
    expect(went(result)).toEqual([
      [THREE, 1],
      [TWO, 1],
      [ONE, 1],
    ]);
    expect(size(store)).toBe(100);
    expect(name(store)).toBe("原子是什么");

    // People's Ctrl+Z hands the place back to the last turn, which then takes it back too.
    const again = threeTurns();
    setSize(again, 100);
    again.undo();
    expect(size(again)).toBe(90);
    expect(went(again.undoOrigins([ONE, TWO, THREE]))).toEqual([
      [THREE, 0],
      [TWO, 0],
      [ONE, 0],
    ]);
    expect(size(again)).toBe(64);
  });

  it("leaves another conversation, a batch from the folder and one from GitHub", () => {
    const store = threeTurns();
    const other = aiTask("other-conversation");
    rename(store, "别的对话", { origin: other });
    const merge = (origin: string, text: string, before: string) =>
      store.mergeFiles([{ path: "code/two.js", base: before, text }], {
        origin,
        baseOf: (path) => store.exportFiles().files.get(path),
      });
    expect(merge(folderBatch("tool-1"), "// tool\n", "// two\n").ok).toBe(true);
    const result = store.undoOrigins([ONE, TWO, THREE]);
    expect(result.ok).toBe(true);
    expect(name(store)).toBe("别的对话");
    expect(store.getState().files["code/two.js"]).toBe("// tool\n");
    expect(size(store)).toBe(64);
    expect(store.canUndoOrigin(other)).toBe(true);
    expect(store.canUndoOrigin(folderBatch("tool-1"))).toBe(true);

    // What GitHub brought stays too.
    const repo = threeTurns();
    expect(
      repo.writeAsPlatform(() =>
        repo.mergeFiles([{ path: "code/two.js", base: "// two\n", text: "// repo\n" }], {
          origin: repoBatch("r1"),
          baseOf: (path) => repo.exportFiles().files.get(path),
        }),
      ).ok,
    ).toBe(true);
    repo.undoOrigins([ONE, TWO, THREE]);
    expect(repo.getState().files["code/two.js"]).toBe("// repo\n");

    // Only because they are not asked for: given along, they go too.
    const asked = threeTurns();
    rename(asked, "别的对话", { origin: other });
    asked.undoOrigins([ONE, TWO, THREE, other]);
    expect(name(asked)).toBe("原子是什么");
  });

  it("does them again as a whole, the oldest first, also after the project opened again", () => {
    const store = threeTurns();
    const before = store.getState();
    store.undoOrigins([ONE, TWO, THREE]);
    const records = store.loggedOrigins.map((origin) =>
      JSON.parse(JSON.stringify(store.saveUndo(origin))),
    );
    const { store: again } = ProjectStore.fromUpdates([store.encodeState()]);
    if (!again) throw new Error("did not open again");
    // In any order: they say when each was made.
    again.restoreUndo(records.toReversed());
    const result = again.redoOrigins([THREE, ONE, TWO]);
    expect(went(result).map(([origin]) => origin)).toEqual([ONE, TWO, THREE]);
    expect(again.getState()).toEqual(before);
    expect(went(again.undoOrigins([TWO, ONE, THREE])).map(([origin]) => origin)).toEqual([
      THREE,
      TWO,
      ONE,
    ]);
    expect(size(again)).toBe(64);
  });

  it("goes by when a turn was made, not by the order its record was read back in", () => {
    const store = threeTurns();
    const records = [THREE, ONE, TWO].map((origin) =>
      JSON.parse(JSON.stringify(store.saveUndo(origin))),
    );
    const { store: again } = ProjectStore.fromUpdates([store.encodeState()]);
    if (!again) throw new Error("did not open again");
    again.restoreUndo(records);
    expect(went(again.undoOrigins([ONE, TWO, THREE])).map(([origin]) => origin)).toEqual([
      THREE,
      TWO,
      ONE,
    ]);
    expect(size(again)).toBe(64);
  });

  it("goes by when a record was saved where an older one does not say when its entries were made", () => {
    const store = threeTurns();
    // Saved one after the other as each turn ended, before entries said when they were made.
    const records = [ONE, TWO, THREE].map((origin) => {
      const record = JSON.parse(JSON.stringify(store.saveUndo(origin)));
      for (const entry of [...record.done, ...record.undone]) delete entry.made;
      return record;
    });
    const { store: again } = ProjectStore.fromUpdates([store.encodeState()]);
    if (!again) throw new Error("did not open again");
    again.restoreUndo([records[1], records[2], records[0]]);
    expect(went(again.undoOrigins([ONE, TWO, THREE])).map(([origin]) => origin)).toEqual([
      THREE,
      TWO,
      ONE,
    ]);
    expect(size(again)).toBe(64);
    expect(name(again)).toBe("原子是什么");
  });

  it("has nothing to do for turns already taken back, and refuses people's own steps", () => {
    const store = threeTurns();
    store.undoOrigin(THREE);
    expect(went(store.undoOrigins([ONE, TWO, THREE]))).toEqual([
      [TWO, 0],
      [ONE, 0],
      [THREE, "nothing-to-undo"],
    ]);
    expect(store.undoOrigins(["user"])).toMatchObject({ ok: false });
  });

  it("says nothing goes back while the project is read only", () => {
    const store = threeTurns();
    store.readOnly = true;
    expect(store.undoOrigins([ONE], { dryRun: true })).toMatchObject({ ok: false });
    expect(store.undoOrigins([ONE])).toMatchObject({ ok: false });
    expect(store.canUndoOrigin(ONE)).toBe(true);
  });
});

describe("a turn that cut a clip, whose new part people changed since", () => {
  const timeline = "main";
  const clipsOf = (store: ProjectStore) => store.getState().timelines["main"]?.clips ?? {};

  /**
   * A turn cuts the interview after its blur: the new part has no blur, as cutting gives each part
   * only the effects that work in it. People move that part, so it stays when the turn goes back.
   */
  const run = (store: ProjectStore, type: string, params: object, options: ExecuteOptions = {}) =>
    success(store.execute({ type, params: { timeline, ...params } } as CommandCall, options));
  const cropOf = (store: ProjectStore, clip: string) =>
    clipsOf(store)[clip]?.properties?.["effect.fx_crop.left"];

  function cutAndMoved(then: (store: ProjectStore, piece: string) => void = () => {}) {
    const store = open();
    const before = Object.keys(clipsOf(store));
    run(store, "clip.split", { clip: "clip_interview", at: "13" }, { origin: ONE });
    const piece = Object.keys(clipsOf(store)).find((id) => !before.includes(id)) as string;
    then(store, piece);
    run(store, "clip.move", { clips: [{ clip: piece, start: "40" }] });
    const vertical = () => store.getState().timelines["main"]?.overrides?.["format.vertical"];
    return {
      store,
      piece,
      seen: clipsOf(store)[piece],
      vertical,
      seenVertical: vertical()?.clips?.[piece],
    };
  }

  it("keeps that part as people saw it, without the blur it never had", () => {
    const { store, piece, seen, vertical, seenVertical } = cutAndMoved();
    expect(seenVertical?.properties?.["fit"]).toEqual({ value: "contain", base: "cover" });
    expect(seen?.effects?.["fx_blur"]).toBeUndefined();
    expect(seen?.properties?.["effect.fx_blur.radius"]).toBeUndefined();
    const result = store.undoOrigin(ONE);
    expect(result).toMatchObject({ ok: true, obstacle: "changed" });
    expect(clipsOf(store)["clip_interview"]?.duration).toBe("12.5");
    expect(clipsOf(store)[piece]).toEqual(seen);
    // Also when it is vertical.
    expect(vertical()?.clips?.[piece]).toEqual(seenVertical);
  });

  it("does the same going back to before the turn, and as the dry run said", () => {
    const { store, piece, seen } = cutAndMoved();
    const dry = store.undoOrigins([ONE], { dryRun: true });
    const real = store.undoOrigins([ONE]);
    expect(went(real)).toEqual(went(dry));
    expect(clipsOf(store)[piece]).toEqual(seen);
  });

  it("takes back what the turn changed about that part later, in a change of its own", () => {
    const { store, piece } = cutAndMoved((cut, part) => {
      run(
        cut,
        "clip.setProperty",
        { clip: part, path: "effect.fx_crop.left", value: 0.77 },
        {
          origin: ONE,
        },
      );
      run(cut, "clip.update", { clip: part, changes: { duration: "2" } }, { origin: ONE });
    });
    expect(store.undoOrigin(ONE)).toMatchObject({ ok: true, obstacle: "changed" });
    expect(cropOf(store, piece)).toBe(0.1);
    expect(clipsOf(store)[piece]?.duration).toBe("4.5");
  });

  it("takes back what the turn changed elsewhere", () => {
    const { store } = cutAndMoved((cut) => {
      run(
        cut,
        "clip.setProperty",
        { clip: "clip_title", path: "param.size", value: 99 },
        {
          origin: ONE,
        },
      );
    });
    store.undoOrigin(ONE);
    expect(size(store)).toBe(64);
  });

  it("takes back two changes of a turn to a clip people moved, without any cut", () => {
    const store = open();
    for (const value of [0.5, 0.6]) {
      run(
        store,
        "clip.setProperty",
        { clip: "clip_interview", path: "effect.fx_crop.left", value },
        {
          origin: ONE,
        },
      );
    }
    run(store, "clip.move", { clips: [{ clip: "clip_interview", start: "40" }] });
    store.undoOrigin(ONE);
    expect(cropOf(store, "clip_interview")).toBe(0.1);
  });

  it("keeps what people wrote on that part", () => {
    const { store, piece } = cutAndMoved((cut, part) => {
      run(cut, "clip.setProperty", { clip: part, path: "effect.fx_crop.left", value: 0.5 });
    });
    store.undoOrigin(ONE);
    expect(cropOf(store, piece)).toBe(0.5);
    expect(clipsOf(store)[piece]?.effects?.["fx_blur"]).toBeUndefined();
  });

  it("decides the same after the project is opened again", () => {
    const edit = (store: ProjectStore, piece: string) =>
      run(
        store,
        "clip.setProperty",
        { clip: piece, path: "effect.fx_crop.left", value: 0.77 },
        {
          origin: ONE,
        },
      );
    const { store } = cutAndMoved(edit);
    const record = JSON.parse(JSON.stringify(store.saveUndo(ONE))) as unknown;
    const { store: again } = ProjectStore.fromUpdates([store.encodeState()]);
    if (!again) throw new Error("did not open again");
    again.restoreUndo([record]);
    store.undoOrigin(ONE);
    again.undoOrigin(ONE);
    expect(again.getState().timelines["main"]).toEqual(store.getState().timelines["main"]);
  });

  it("one by one, as a group and as a dry run alike, and done again comes back", () => {
    const edit = (store: ProjectStore, piece: string) =>
      run(
        store,
        "clip.setProperty",
        { clip: piece, path: "effect.fx_crop.left", value: 0.77 },
        {
          origin: ONE,
        },
      );
    const a = cutAndMoved(edit);
    const b = cutAndMoved(edit);
    // The parts have ids of their own: compare with one name for both.
    const snap = ({ store, piece }: typeof a) =>
      JSON.stringify(store.getState()).split(piece).join("PIECE");
    const start = snap(a);
    const dry = b.store.undoOrigins([ONE], { dryRun: true });
    expect(snap(b)).toBe(start);
    a.store.undoOrigin(ONE);
    const real = b.store.undoOrigins([ONE]);
    const undone = snap(a);
    expect(snap(b)).toBe(undone);
    expect(undone).not.toBe(start);
    const patches = (result: ManyUndoResult, piece: string) =>
      JSON.stringify(result.ok && result.each.map(({ result: each }) => each.ok && each.patches))
        .split(piece)
        .join("PIECE");
    expect(patches(dry, b.piece)).toBe(patches(real, b.piece));
    a.store.redoOrigin(ONE);
    b.store.redoOrigins([ONE]);
    expect(snap(a)).toBe(start);
    expect(snap(b)).toBe(start);
    a.store.undoOrigin(ONE);
    expect(snap(a)).toBe(undone);
  });
});
