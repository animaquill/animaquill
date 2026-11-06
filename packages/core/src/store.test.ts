import {
  createProject,
  formatTime,
  readProject,
  toSeconds,
  type Project,
} from "@animaquill/schema";
import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { loadFixture } from "../../schema/scripts/fixture.ts";
import { COMMANDS } from "./commands.ts";
import { orderedSections, orderedTracks, projectFrameRate, timelineLength } from "./model.ts";
import {
  ProjectStore,
  USER,
  aiTask,
  mergeUpdates,
  type CommandResult,
  type ExecuteOptions,
} from "./store.ts";

const MAIN = "timelines/main/timeline.json";
const AI = aiTask("task-1");

function openFiles(files: ReadonlyMap<string, string>): ProjectStore {
  const { store } = ProjectStore.open(files);
  if (!store) throw new Error("fixture did not open");
  return store;
}

/** The example project without its locked tag, so that it can be changed. */
function open(): ProjectStore {
  const files = loadFixture("v1");
  const manifest = JSON.parse(files.get("animaquill.json") as string);
  delete manifest.tags;
  files.set("animaquill.json", JSON.stringify(manifest));
  return openFiles(files);
}

const timeline = (store: ProjectStore) => {
  const value = store.getState().timelines["main"];
  if (!value) throw new Error("no main timeline");
  return value;
};
const clip = (store: ProjectStore, id = "clip_title") => timeline(store).clips[id];
const property = (store: ProjectStore, path: string, id = "clip_title") =>
  clip(store, id)?.properties?.[path];

const setProperty = (
  store: ProjectStore,
  path: string,
  value: unknown,
  options: ExecuteOptions = {},
  id = "clip_title",
) =>
  store.execute(
    { type: "clip.setProperty", params: { timeline: "main", clip: id, path, value } },
    options,
  );

/** The track of this clip is full, and these tests are about something else than making room. */
const moveClip = (store: ProjectStore, start: string, options: ExecuteOptions = {}) =>
  store.execute(
    {
      type: "clip.move",
      params: { timeline: "main", clips: [{ clip: "clip_title", start }], overlap: "overwrite" },
    },
    options,
  );

function failure(result: CommandResult) {
  if (result.ok) throw new Error("expected the command to fail");
  return result.error;
}

function success(result: CommandResult) {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result;
}

/** A second copy of the project, as on another device. */
function twin(store: ProjectStore): ProjectStore {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(store.doc), "sync");
  return new ProjectStore(doc);
}

function sync(a: ProjectStore, b: ProjectStore): void {
  Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc, Y.encodeStateVector(b.doc)), "sync");
  Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(b.doc, Y.encodeStateVector(a.doc)), "sync");
}

describe("files", () => {
  it("gives back exactly the files it was given", () => {
    const original = loadFixture("v1");
    const { files, problems } = openFiles(original).exportFiles();
    expect(problems).toEqual([]);
    for (const [path, text] of files) expect(text, path).toBe(original.get(path));
  });

  it("keeps scene, sound and shared code as text, and leaves other files out", () => {
    const { files } = open().exportFiles();
    expect(files.has("scenes/title/index.html")).toBe(true);
    expect(files.has("sounds/impacts/main.js")).toBe(true);
    expect(files.has("code/animate.js")).toBe(true);
    expect(files.has("AGENTS.md")).toBe(false);
  });

  it("writes valid files after changes", () => {
    const store = open();
    success(moveClip(store, "1"));
    success(store.execute({ type: "track.add", params: { timeline: "main", kind: "video" } }));
    const { files, problems } = store.exportFiles();
    expect(problems).toEqual([]);
    const read = readProject(files);
    expect(read.problems.filter((problem) => problem.severity === "error")).toEqual([]);
  });

  it("does not open what is no project", () => {
    expect(ProjectStore.open(new Map()).store).toBeUndefined();
  });

  it("opens with a broken document, reports it, and does not write it back", () => {
    const files = loadFixture("v1");
    files.set("notes.json", "{oops");
    const { store, problems } = ProjectStore.open(files);
    expect(problems.some((problem) => problem.file === "notes.json")).toBe(true);
    expect(store?.exportFiles().files.has("notes.json")).toBe(false);
  });

  it("starts a new project", () => {
    const store = ProjectStore.create(createProject({ name: "新项目" }));
    expect(store.exportFiles().problems).toEqual([]);
    expect(store.getState().manifest.name).toBe("新项目");
  });

  it("comes back the same from the saved document", () => {
    const store = open();
    success(moveClip(store, "1"));
    const doc = new Y.Doc();
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(store.doc));
    expect(new ProjectStore(doc).exportFiles().files).toEqual(store.exportFiles().files);
  });
});

describe("saved updates", () => {
  it("bring a project back", () => {
    const store = open();
    success(moveClip(store, "1"));
    const { store: loaded, damaged } = ProjectStore.fromUpdates([store.encodeState()]);
    expect(damaged).toBe(0);
    expect(loaded?.exportFiles().files).toEqual(store.exportFiles().files);
  });

  it("can be saved one change at a time and merged later", () => {
    const store = open();
    const saved = [store.encodeState()];
    store.onLocalUpdate((update) => saved.push(update));
    success(moveClip(store, "1"));
    success(setProperty(store, "param.size", 80));
    expect(saved).toHaveLength(3);
    const { store: fromLog } = ProjectStore.fromUpdates(saved);
    const { store: fromMerged } = ProjectStore.fromUpdates([mergeUpdates(saved)]);
    expect(fromLog?.getState()).toEqual(store.getState());
    expect(fromMerged?.getState()).toEqual(store.getState());
  });

  it("can arrive in any order", () => {
    const store = open();
    const saved = [store.encodeState()];
    store.onLocalUpdate((update) => saved.push(update));
    success(moveClip(store, "1"));
    success(moveClip(store, "2"));
    const { store: loaded } = ProjectStore.fromUpdates(saved.toReversed());
    expect(clip(loaded as ProjectStore)?.start).toBe("2");
  });

  it("are skipped when damaged, and the rest still opens", () => {
    const store = open();
    const broken = new Uint8Array([255, 255, 255, 1, 2, 3]);
    const { store: loaded, damaged } = ProjectStore.fromUpdates([broken, store.encodeState()]);
    expect(damaged).toBe(1);
    expect(loaded?.getState().manifest.name).toBe("原子是什么");
  });

  it("open nothing without a project in them", () => {
    expect(ProjectStore.fromUpdates([]).store).toBeUndefined();
    expect(ProjectStore.fromUpdates([new Uint8Array([9, 9])]).store).toBeUndefined();
  });

  it("do not save what came from somewhere else again", () => {
    const a = open();
    const b = twin(a);
    const saved: Uint8Array[] = [];
    b.onLocalUpdate((update) => saved.push(update));
    const updates: Uint8Array[] = [];
    a.onLocalUpdate((update) => updates.push(update));
    success(moveClip(a, "1"));
    b.applyUpdates(updates);
    expect(clip(b)?.start).toBe("1");
    expect(saved).toEqual([]);
  });

  it("notice when one went missing, and recover when it arrives", () => {
    const a = open();
    const b = twin(a);
    const updates: Uint8Array[] = [];
    a.onLocalUpdate((update) => updates.push(update));
    success(moveClip(a, "1"));
    success(moveClip(a, "2"));
    expect(b.isMissingUpdates).toBe(false);
    b.applyUpdates([updates[1] as Uint8Array]);
    expect(b.isMissingUpdates).toBe(true);
    expect(clip(b)?.start).toBe("0");
    b.applyUpdates([updates[0] as Uint8Array]);
    expect(b.isMissingUpdates).toBe(false);
    expect(clip(b)?.start).toBe("2");
  });

  it("can be merged with damaged ones among them, which are left out", () => {
    const store = open();
    const saved = [store.encodeState()];
    store.onLocalUpdate((update) => saved.push(update));
    success(moveClip(store, "1"));
    const merged = store.mergeWith([new Uint8Array([255, 255, 255, 1]), ...saved]);
    const { store: loaded, damaged } = ProjectStore.fromUpdates([merged]);
    expect(damaged).toBe(0);
    expect(loaded?.getState()).toEqual(store.getState());
  });

  it("merge in what another window wrote", () => {
    const a = open();
    const b = twin(a);
    const fromB: Uint8Array[] = [];
    b.onLocalUpdate((update) => fromB.push(update));
    success(moveClip(b, "7"));
    const { store: loaded } = ProjectStore.fromUpdates([a.mergeWith(fromB)]);
    expect(clip(loaded as ProjectStore)?.start).toBe("7");
  });

  it("stop being reported when asked", () => {
    const store = open();
    const saved: Uint8Array[] = [];
    const stop = store.onLocalUpdate((update) => saved.push(update));
    stop();
    success(moveClip(store, "1"));
    expect(saved).toEqual([]);
  });

  it("include undo, so that it survives too", () => {
    const store = open();
    const saved = [store.encodeState()];
    store.onLocalUpdate((update) => saved.push(update));
    success(moveClip(store, "1"));
    store.undo();
    expect(clip(ProjectStore.fromUpdates(saved).store as ProjectStore)?.start).toBe("0");
  });
});

describe("running commands", () => {
  it("changes the project and says what it did", () => {
    const store = open();
    const result = success(setProperty(store, "param.size", 80));
    expect(property(store, "param.size")).toBe(80);
    expect(result.patches).toHaveLength(1);
    expect(result.revision).toBe(store.revision);
  });

  it("keeps the identity of everything that did not change", () => {
    const store = open();
    const before = store.getState();
    success(setProperty(store, "param.size", 80));
    const after = store.getState();
    expect(after).not.toBe(before);
    expect(after.timelines["main"]?.clips["clip_logo"]).toBe(
      before.timelines["main"]?.clips["clip_logo"],
    );
    expect(after.timelines["highlight"]).toBe(before.timelines["highlight"]);
    expect(after.manifest).toBe(before.manifest);
  });

  it("does not change the old state", () => {
    const store = open();
    const before = store.getState();
    success(setProperty(store, "param.size", 80));
    expect(before.timelines["main"]?.clips["clip_title"]?.properties?.["param.size"]).toBe(64);
  });

  it("tells listeners, and stops when asked", () => {
    const store = open();
    const listener = vi.fn();
    const stop = store.subscribe(listener);
    success(setProperty(store, "param.size", 80));
    expect(listener).toHaveBeenCalledOnce();
    stop();
    success(setProperty(store, "param.size", 90));
    expect(listener).toHaveBeenCalledOnce();
  });

  it("does nothing, and counts nothing, when nothing changes", () => {
    const store = open();
    const revision = store.revision;
    const result = success(
      store.execute({
        type: "clip.update",
        params: { timeline: "main", clip: "clip_title", changes: {} },
      }),
    );
    expect(result.patches).toEqual([]);
    expect(store.revision).toBe(revision);
  });

  it("refuses what it does not know", () => {
    expect(failure(open().execute({ type: "clip.explode" })).code).toBe("unknown-command");
  });

  it("refuses wrong parameters", () => {
    const store = open();
    const result = store.execute({
      type: "clip.move",
      params: { timeline: "main", clips: [{ clip: "clip_title", start: 5 }] },
    });
    expect(failure(result).code).toBe("invalid-params");
    expect(failure(store.execute({ type: "project.rename", params: { name: "" } })).code).toBe(
      "invalid-params",
    );
    expect(
      failure(store.execute({ type: "project.rename", params: { name: "a", x: 1 } })).code,
    ).toBe("invalid-params");
  });

  it("says when something does not exist", () => {
    const store = open();
    expect(failure(setProperty(store, "param.size", 1, {}, "gone")).code).toBe("not-found");
    expect(
      failure(store.execute({ type: "timeline.rename", params: { timeline: "gone", name: "a" } }))
        .code,
    ).toBe("not-found");
  });

  it("refuses values the format does not allow", () => {
    const store = open();
    expect(failure(setProperty(store, "opacity", 2)).code).toBe("invalid-value");
    expect(failure(setProperty(store, "transfrom.x", 1)).code).toBe("invalid-value");
    expect(property(store, "transfrom.x")).toBeUndefined();
  });

  it("refuses a clip on a track that cannot hold it", () => {
    const store = open();
    const result = store.execute({
      type: "clip.move",
      params: { timeline: "main", clips: [{ clip: "clip_title", track: "track_voice" }] },
    });
    expect(failure(result).code).toBe("wrong-track");
    const added = store.execute({
      type: "clip.add",
      params: {
        timeline: "main",
        track: "track_voice",
        clip: { start: "0", duration: "1", source: { kind: "color", color: "#000000" } },
      },
    });
    expect(failure(added).code).toBe("wrong-track");
  });

  it("protects the clips of a locked track, from people and AI alike", () => {
    const store = open();
    expect(failure(setProperty(store, "opacity", 0.5, {}, "clip_lottie")).code).toBe(
      "track-locked",
    );
    expect(failure(setProperty(store, "opacity", 0.5, { origin: AI }, "clip_lottie")).code).toBe(
      "track-locked",
    );
    const remove = store.execute({
      type: "track.remove",
      params: { timeline: "main", track: "track_overlay" },
    });
    expect(failure(remove).code).toBe("track-locked");
    const moveIn = store.execute({
      type: "clip.move",
      params: { timeline: "main", clips: [{ clip: "clip_title", track: "track_overlay" }] },
    });
    expect(failure(moveIn).code).toBe("track-locked");
  });

  it("every command has a name of the form area.action", () => {
    for (const command of COMMANDS) expect(command.type).toMatch(/^[a-z]+\.[a-zA-Z]+$/);
    expect(new Set(COMMANDS.map((command) => command.type)).size).toBe(COMMANDS.length);
  });
});

describe("checking without doing", () => {
  it("reports what would happen and changes nothing", () => {
    const store = open();
    const revision = store.revision;
    const result = success(setProperty(store, "param.size", 80, { dryRun: true }));
    expect(result.patches).toHaveLength(1);
    expect(property(store, "param.size")).toBe(64);
    expect(store.revision).toBe(revision);
    expect(store.history).toEqual([]);
  });

  it("finds the same mistakes", () => {
    expect(failure(setProperty(open(), "opacity", 2, { dryRun: true })).code).toBe("invalid-value");
  });
});

describe("batches", () => {
  it("are one change, and one undo step", () => {
    const store = open();
    const before = store.revision;
    success(
      store.executeBatch([
        { type: "project.rename", params: { name: "新名字" } },
        { type: "timeline.rename", params: { timeline: "main", name: "新主线" } },
      ]),
    );
    expect(store.revision).toBe(before + 1);
    store.undo();
    expect(store.getState().manifest.name).toBe("原子是什么");
    expect(timeline(store).name).toBe("主线");
  });

  it("let a command build on the one before it", () => {
    const store = open();
    success(
      store.executeBatch([
        { type: "track.add", params: { timeline: "main", id: "track_new", kind: "video" } },
        {
          type: "clip.add",
          params: {
            timeline: "main",
            track: "track_new",
            clip: {
              id: "clip_new",
              start: "0",
              duration: "1",
              source: { kind: "color", color: "#000000" },
            },
          },
        },
      ]),
    );
    expect(clip(store, "clip_new")?.track).toBe("track_new");
  });

  it("change nothing at all when one command fails", () => {
    const store = open();
    const revision = store.revision;
    const result = store.executeBatch([
      { type: "project.rename", params: { name: "新名字" } },
      { type: "clip.move", params: { timeline: "main", clips: [{ clip: "gone", start: "1" }] } },
    ]);
    expect(failure(result).code).toBe("not-found");
    expect(store.getState().manifest.name).toBe("原子是什么");
    expect(store.revision).toBe(revision);
  });
});

describe("undo", () => {
  it("takes back one command at a time, and brings it back", () => {
    const store = open();
    success(setProperty(store, "param.size", 80));
    success(setProperty(store, "param.size", 90));
    expect(store.undo()).toBe(true);
    expect(property(store, "param.size")).toBe(80);
    expect(store.undo()).toBe(true);
    expect(property(store, "param.size")).toBe(64);
    expect(store.redo()).toBe(true);
    expect(property(store, "param.size")).toBe(80);
  });

  it("has nothing to do on a fresh project", () => {
    const store = open();
    expect(store.canUndo).toBe(false);
    expect(store.undo()).toBe(false);
    expect(store.redo()).toBe(false);
  });

  it("does not take back loading the project", () => {
    const store = open();
    store.undo();
    expect(store.getState().manifest.name).toBe("原子是什么");
  });

  it("restores what a command removed, clips and transitions alike", () => {
    const store = open();
    const before = store.exportFiles().files.get(MAIN);
    success(
      store.execute({ type: "track.remove", params: { timeline: "main", track: "track_video" } }),
    );
    expect(clip(store)).toBeUndefined();
    store.undo();
    expect(store.exportFiles().files.get(MAIN)).toBe(before);
  });

  it("forgets what could be redone after a new change", () => {
    const store = open();
    success(setProperty(store, "param.size", 80));
    store.undo();
    success(setProperty(store, "param.size", 90));
    expect(store.canRedo).toBe(false);
  });

  it("leaves what an AI task did", () => {
    const store = open();
    success(setProperty(store, "param.size", 80));
    success(setProperty(store, "param.accent", "#ff0000", { origin: AI }));
    store.undo();
    expect(property(store, "param.size")).toBe(64);
    expect(property(store, "param.accent")).toBe("#ff0000");
  });
});

describe("assets", () => {
  const asset = {
    kind: "video",
    name: "采访.mp4",
    path: "assets/a.mp4",
    storage: "local",
    info: { duration: "6" },
  };

  function withAsset() {
    const store = ProjectStore.create(createProject({ name: "素材" }));
    const main = store.getState().timelines["main"];
    const track = main && orderedTracks(main).find(({ kind }) => kind === "video");
    success(store.execute({ type: "asset.add", params: { id: "a", asset } }));
    success(
      store.execute({
        type: "clip.add",
        params: {
          timeline: "main",
          track: track?.id,
          clip: {
            id: "c",
            start: "2",
            duration: "4",
            offset: "1",
            source: { kind: "video", media: { asset: "a" } },
          },
        },
      }),
    );
    return store;
  }

  const trimEnd = (store: ProjectStore, end: string) =>
    store.execute({ type: "clip.trim", params: { timeline: "main", clip: "c", end } });

  it("are part of the project, and undo takes them back", () => {
    const store = ProjectStore.create(createProject({ name: "素材" }));
    success(store.execute({ type: "asset.add", params: { id: "a", asset } }));
    expect(store.getState().assets?.["a"]?.name).toBe("采访.mp4");
    expect(store.exportFiles().problems).toEqual([]);
    store.undo();
    expect(store.getState().assets?.["a"]).toBeUndefined();
  });

  it("cannot go while a clip uses them", () => {
    const store = withAsset();
    const remove = () => store.execute({ type: "asset.remove", params: { asset: "a" } });
    expect(failure(remove()).code).toBe("asset-in-use");
    success(store.execute({ type: "clip.remove", params: { timeline: "main", clips: ["c"] } }));
    success(remove());
  });

  it("stop a clip from growing past the end of its content", () => {
    const store = withAsset();
    success(trimEnd(store, "7"));
    expect(failure(trimEnd(store, "7.5")).code).toBe("source-end");
  });

  it("do not stop a clip that loops", () => {
    const store = withAsset();
    success(
      store.execute({
        type: "clip.update",
        params: { timeline: "main", clip: "c", changes: { loop: true } },
      }),
    );
    success(trimEnd(store, "9"));
  });
});

describe("the frame rate of a project", () => {
  it("is its own, apart from the rates formats are exported at", () => {
    const store = ProjectStore.create(createProject({ name: "帧率" }));
    success(store.execute({ type: "project.setFrameRate", params: { fps: "24" } }));
    const { manifest } = store.getState();
    expect(projectFrameRate(manifest)).toBe("24");
    expect(manifest.formats[0]?.fps).toBe("30");
    expect(store.exportFiles().problems).toEqual([]);
  });

  it("follows the first format in a project that has none", () => {
    const store = open();
    expect(projectFrameRate(store.getState().manifest)).toBe(
      store.getState().manifest.formats[0]?.fps,
    );
  });

  it("has to be a rate", () => {
    const store = open();
    const result = store.execute({ type: "project.setFrameRate", params: { fps: "0" } });
    expect(failure(result).code).toBe("invalid-params");
  });
});

describe("undo of a change that writes a field twice", () => {
  it("goes all the way back", () => {
    const store = open();
    success(
      store.executeBatch([
        { type: "project.rename", params: { name: "第一次" } },
        { type: "project.rename", params: { name: "第二次" } },
      ]),
    );
    store.undo();
    expect(store.getState().manifest.name).toBe("原子是什么");
    store.redo();
    expect(store.getState().manifest.name).toBe("第二次");
  });

  it("still stops at what somebody else wrote before it", () => {
    const store = open();
    success(store.execute({ type: "project.rename", params: { name: "AI 写的" } }, { origin: AI }));
    success(
      store.executeBatch([
        { type: "project.rename", params: { name: "第一次" } },
        { type: "project.rename", params: { name: "第二次" } },
      ]),
    );
    store.undo();
    expect(store.getState().manifest.name).toBe("AI 写的");
  });
});

describe("undoing an AI task", () => {
  it("takes back everything the task did in one step", () => {
    const store = open();
    success(setProperty(store, "param.size", 80, { origin: AI }));
    success(moveClip(store, "1", { origin: AI }));
    success(store.execute({ type: "project.rename", params: { name: "AI 改的" } }, { origin: AI }));
    expect(store.undoTask("task-1")).toBe(true);
    expect(property(store, "param.size")).toBe(64);
    expect(clip(store)?.start).toBe("0");
    expect(store.getState().manifest.name).toBe("原子是什么");
  });

  it("leaves what the person did, also in the same clip", () => {
    const store = open();
    success(setProperty(store, "param.size", 80, { origin: AI }));
    success(setProperty(store, "param.accent", "#00ff00"));
    store.undoTask("task-1");
    expect(property(store, "param.size")).toBe(64);
    expect(property(store, "param.accent")).toBe("#00ff00");
  });

  it("does not overwrite a value the person changed afterwards", () => {
    const store = open();
    success(setProperty(store, "param.size", 80, { origin: AI }));
    success(setProperty(store, "param.size", 100));
    store.undoTask("task-1");
    expect(property(store, "param.size")).toBe(100);
  });

  it("keeps tasks apart", () => {
    const store = open();
    success(setProperty(store, "param.size", 80, { origin: aiTask("a") }));
    success(setProperty(store, "param.accent", "#00ff00", { origin: aiTask("b") }));
    store.undoTask("a");
    expect(property(store, "param.size")).toBe(64);
    expect(property(store, "param.accent")).toBe("#00ff00");
  });

  it("can be brought back", () => {
    const store = open();
    success(setProperty(store, "param.size", 80, { origin: AI }));
    store.undoTask("task-1");
    expect(store.redoTask("task-1")).toBe(true);
    expect(property(store, "param.size")).toBe(80);
  });

  it("does nothing for a task it does not know", () => {
    expect(open().undoTask("nobody")).toBe(false);
  });
});

describe("the person wins over an AI task that did not see the change", () => {
  it("stops the task when the same property changed", () => {
    const store = open();
    const seen = store.revision;
    success(setProperty(store, "param.size", 80));
    const result = setProperty(store, "param.size", 50, { origin: AI, baseRevision: seen });
    const error = failure(result);
    expect(error.code).toBe("conflict");
    expect(error.conflicts?.[0]?.at(-1)).toBe("param.size");
    expect(property(store, "param.size")).toBe(80);
  });

  it("lets the task go on when the person changed something else", () => {
    const store = open();
    const seen = store.revision;
    success(setProperty(store, "param.size", 80));
    success(setProperty(store, "param.accent", "#00ff00", { origin: AI, baseRevision: seen }));
    expect(property(store, "param.size")).toBe(80);
    expect(property(store, "param.accent")).toBe("#00ff00");
  });

  it("lets the task go on when another clip changed", () => {
    const store = open();
    const seen = store.revision;
    success(setProperty(store, "opacity", 0.5, {}, "clip_logo"));
    success(setProperty(store, "opacity", 0.5, { origin: AI, baseRevision: seen }));
  });

  it("is not stopped by its own earlier changes", () => {
    const store = open();
    const seen = store.revision;
    success(setProperty(store, "param.size", 80, { origin: AI, baseRevision: seen }));
    success(setProperty(store, "param.size", 90, { origin: AI, baseRevision: seen }));
  });

  it("stops the task when the clip it wants to change is gone", () => {
    const store = open();
    const seen = store.revision;
    success(
      store.execute({ type: "clip.remove", params: { timeline: "main", clips: ["clip_title"] } }),
    );
    const error = failure(setProperty(store, "param.size", 50, { origin: AI, baseRevision: seen }));
    expect(error.code).toBe("not-found");
  });

  it("stops the task when a clip was removed and came back", () => {
    const store = open();
    const seen = store.revision;
    success(
      store.execute({ type: "clip.remove", params: { timeline: "main", clips: ["clip_title"] } }),
    );
    store.undo();
    const error = failure(setProperty(store, "param.size", 50, { origin: AI, baseRevision: seen }));
    expect(error.code).toBe("conflict");
  });

  it("sees changes from other devices too", () => {
    const store = open();
    const other = twin(store);
    const seen = store.revision;
    success(setProperty(other, "param.size", 80));
    sync(store, other);
    expect(
      failure(setProperty(store, "param.size", 50, { origin: AI, baseRevision: seen })).code,
    ).toBe("conflict");
  });

  it("does not trust a revision from the future", () => {
    const store = open();
    const result = setProperty(store, "param.size", 50, {
      origin: AI,
      baseRevision: store.revision + 5,
    });
    expect(failure(result).code).toBe("stale-revision");
  });

  it("does not stop a person, who does not name a revision", () => {
    const store = open();
    success(setProperty(store, "param.size", 80, { origin: AI }));
    success(setProperty(store, "param.size", 90));
    expect(property(store, "param.size")).toBe(90);
  });
});

describe("a locked project", () => {
  const locked = () => {
    const store = open();
    success(
      store.execute({
        type: "project.setTags",
        params: { tags: [{ name: "已发布", locked: true }] },
      }),
    );
    return store;
  };

  it("stays locked when it is opened from its files", () => {
    const store = openFiles(loadFixture("v1"));
    expect(failure(setProperty(store, "param.size", 80)).code).toBe("project-locked");
  });

  it("refuses every change, from people and AI", () => {
    const store = locked();
    expect(failure(setProperty(store, "param.size", 80)).code).toBe("project-locked");
    expect(failure(setProperty(store, "param.size", 80, { origin: AI })).code).toBe(
      "project-locked",
    );
    expect(failure(store.importFile("scenes/title/index.html", "x")).code).toBe("project-locked");
  });

  it("does not let undo get around it", () => {
    const store = open();
    success(setProperty(store, "param.size", 80));
    success(
      store.execute({
        type: "project.setTags",
        params: { tags: [{ name: "已发布", locked: true }] },
      }),
    );
    expect(store.undo()).toBe(false);
    expect(property(store, "param.size")).toBe(80);
  });

  it("can be unlocked by the person, and only by the person", () => {
    const store = locked();
    const byAi = store.execute({ type: "project.setTags", params: { tags: [] } }, { origin: AI });
    expect(failure(byAi).code).toBe("user-only");
    success(store.execute({ type: "project.setTags", params: { tags: [] } }));
    success(setProperty(store, "param.size", 80));
  });

  it("does not let an AI change tags through a file either", () => {
    const store = open();
    const manifest = JSON.parse(store.exportFiles().files.get("animaquill.json") as string);
    manifest.tags = [];
    const result = store.importFile("animaquill.json", JSON.stringify(manifest), { origin: AI });
    expect(failure(result).code).toBe("user-only");
  });
});

describe("clips and tracks", () => {
  it("adds a clip with a new id", () => {
    const store = open();
    const result = success(
      store.execute({
        type: "clip.add",
        params: {
          timeline: "main",
          track: "track_video",
          clip: { start: "40", duration: "1", source: { kind: "color", color: "#000000" } },
        },
      }),
    );
    const { id } = result.results[0] as { id: string };
    expect(clip(store, id)?.track).toBe("track_video");
  });

  it("refuses an id that is taken", () => {
    const store = open();
    const result = store.execute({
      type: "clip.add",
      params: {
        timeline: "main",
        track: "track_video",
        clip: {
          id: "clip_title",
          start: "40",
          duration: "1",
          source: { kind: "color", color: "#000000" },
        },
      },
    });
    expect(failure(result).code).toBe("id-taken");
  });

  it("removes a clip and repairs its transitions", () => {
    const store = open();
    success(
      store.execute({ type: "clip.remove", params: { timeline: "main", clips: ["clip_title"] } }),
    );
    const transition = timeline(store).transitions["tr_1"];
    expect(transition?.from).toBeUndefined();
    expect(transition?.to).toBe("clip_interview");
    success(
      store.execute({
        type: "clip.remove",
        params: { timeline: "main", clips: ["clip_interview"] },
      }),
    );
    expect(timeline(store).transitions["tr_1"]).toBeUndefined();
  });

  it("updates and clears fields of a clip", () => {
    const store = open();
    success(
      store.execute({
        type: "clip.update",
        params: {
          timeline: "main",
          clip: "clip_title",
          changes: { name: "新名字", duration: "4" },
          clear: ["fadeOut"],
        },
      }),
    );
    expect(clip(store)?.name).toBe("新名字");
    expect(clip(store)?.duration).toBe("4");
    expect(clip(store)?.fadeOut).toBeUndefined();
  });

  it("writes times in their canonical form", () => {
    const store = open();
    success(moveClip(store, "25/2"));
    expect(clip(store)?.start).toBe("12.5");
  });

  it("moves a clip to another track by changing one field", () => {
    const store = open();
    success(
      store.execute({ type: "track.add", params: { timeline: "main", id: "free", kind: "video" } }),
    );
    const result = success(
      store.execute({
        type: "clip.move",
        params: { timeline: "main", clips: [{ clip: "clip_logo", track: "free" }] },
      }),
    );
    expect(result.patches).toHaveLength(1);
  });

  it("sets and clears a property", () => {
    const store = open();
    const keys = {
      keys: [
        { time: "0", value: 0 },
        { time: "1", value: 1 },
      ],
    };
    success(setProperty(store, "opacity", keys, {}, "clip_logo"));
    expect(property(store, "opacity", "clip_logo")).toEqual(keys);
    success(
      store.execute({
        type: "clip.clearProperty",
        params: { timeline: "main", clip: "clip_logo", path: "opacity" },
      }),
    );
    expect(property(store, "opacity", "clip_logo")).toBeUndefined();
  });

  it("removes a track with everything on it", () => {
    const store = open();
    success(
      store.execute({ type: "track.remove", params: { timeline: "main", track: "track_video" } }),
    );
    expect(timeline(store).tracks["track_video"]).toBeUndefined();
    expect(clip(store)).toBeUndefined();
    expect(timeline(store).transitions["tr_1"]).toBeUndefined();
    expect(store.exportFiles().problems).toEqual([]);
  });

  it("puts tracks in order, also between two others", () => {
    const store = open();
    const ids = () => orderedTracks(timeline(store)).map((track) => track.id);
    const [first, second, third] = ids();
    success(
      store.execute({
        type: "track.move",
        params: { timeline: "main", track: third, before: second },
      }),
    );
    expect(ids().slice(0, 3)).toEqual([first, third, second]);
    success(store.execute({ type: "track.move", params: { timeline: "main", track: first } }));
    expect(ids().at(-1)).toBe(first);
    success(
      store.execute({
        type: "track.add",
        params: { timeline: "main", id: "track_top", kind: "video", before: ids()[0] },
      }),
    );
    expect(ids()[0]).toBe("track_top");
  });

  it("only allows settings a track has", () => {
    const store = open();
    const result = store.execute({
      type: "track.update",
      params: { timeline: "main", track: "track_video", changes: { muted: true } },
    });
    expect(failure(result).code).toBe("invalid-value");
    success(
      store.execute({
        type: "track.update",
        params: { timeline: "main", track: "track_voice", changes: { muted: true } },
      }),
    );
  });

  it("keeps at least one section", () => {
    const store = ProjectStore.create(createProject({ name: "a" }));
    const main = store.getState().timelines["main"];
    const [section] = Object.keys(main?.sections ?? {});
    const result = store.execute({ type: "section.remove", params: { timeline: "main", section } });
    expect(failure(result).code).toBe("last-section");
  });

  it("adds, resizes and removes sections", () => {
    const store = open();
    success(
      store.execute({
        type: "section.add",
        params: { timeline: "main", id: "section_new", duration: "3", before: "section_body" },
      }),
    );
    const order = () => orderedSections(timeline(store)).map((section) => section.id);
    expect(order()).toEqual(["section_intro", "section_new", "section_body", "section_end"]);
    success(
      store.execute({
        type: "section.update",
        params: { timeline: "main", section: "section_new", duration: "4", name: "新" },
      }),
    );
    expect(timeline(store).sections["section_new"]?.duration).toBe("4");
    success(
      store.execute({
        type: "section.remove",
        params: { timeline: "main", section: "section_new" },
      }),
    );
    expect(order()).not.toContain("section_new");
  });

  it("adds, changes and removes markers", () => {
    const store = open();
    const added = success(
      store.execute({
        type: "marker.add",
        params: { timeline: "main", marker: { time: "3", name: "这里" } },
      }),
    );
    const { id } = added.results[0] as { id: string };
    success(
      store.execute({
        type: "marker.update",
        params: { timeline: "main", marker: id, changes: { note: "看这里" } },
      }),
    );
    expect(timeline(store).markers[id]?.note).toBe("看这里");
    success(store.execute({ type: "marker.remove", params: { timeline: "main", marker: id } }));
    expect(timeline(store).markers[id]).toBeUndefined();
  });
});

describe("editing clips on the timeline", () => {
  const color = { kind: "color", color: "#000000" };
  const video = { kind: "video", media: { asset: "interview" } };

  /** A project with one empty video track, and these clips on it. */
  function withClips(clips: readonly Record<string, unknown>[]) {
    const store = ProjectStore.create(createProject({ name: "剪辑" }));
    const main = store.getState().timelines["main"];
    const track = main && orderedTracks(main).find(({ kind }) => kind === "video");
    if (!track) throw new Error("no video track");
    for (const added of clips) {
      success(
        store.execute({
          type: "clip.add",
          params: { timeline: "main", track: track.id, clip: { source: color, ...added } },
        }),
      );
    }
    return { store, track: track.id };
  }

  const spanOf = (store: ProjectStore, id: string) => {
    const found = clip(store, id);
    return [found?.start, found?.duration, found?.offset];
  };
  const trim = (store: ProjectStore, id: string, edges: Record<string, string>) =>
    store.execute({ type: "clip.trim", params: { timeline: "main", clip: id, ...edges } });
  const move = (store: ProjectStore, id: string, start: string, overlap?: string) =>
    store.execute({
      type: "clip.move",
      params: {
        timeline: "main",
        clips: [{ clip: id, start }],
        ...(overlap ? { overlap } : {}),
      },
    });
  const length = (store: ProjectStore) => timelineLength(timeline(store));

  describe("overlaps", () => {
    it("refuses a clip where there already is one", () => {
      const { store, track } = withClips([{ id: "a", start: "0", duration: "5" }]);
      const result = store.execute({
        type: "clip.add",
        params: {
          timeline: "main",
          track,
          clip: { start: "4", duration: "2", source: color },
        },
      });
      expect(failure(result).code).toBe("overlap");
    });

    it("lets clips touch", () => {
      const { store } = withClips([
        { id: "a", start: "0", duration: "5" },
        { id: "b", start: "5", duration: "5" },
      ]);
      expect(clip(store, "b")?.start).toBe("5");
    });

    it("refuses to move onto another clip, unless told to overwrite", () => {
      const { store } = withClips([
        { id: "a", start: "0", duration: "2" },
        { id: "b", start: "5", duration: "2" },
      ]);
      expect(failure(move(store, "a", "4")).code).toBe("overlap");
      expect(clip(store, "a")?.start).toBe("0");
      success(move(store, "a", "4", "overwrite"));
      expect(spanOf(store, "b")).toEqual(["6", "1", "1"]);
    });

    it("refuses to change the numbers of a clip so that it overlaps", () => {
      const { store } = withClips([
        { id: "a", start: "0", duration: "2" },
        { id: "b", start: "5", duration: "2" },
      ]);
      const result = store.execute({
        type: "clip.update",
        params: { timeline: "main", clip: "a", changes: { duration: "6" } },
      });
      expect(failure(result).code).toBe("overlap");
    });

    it("still lets people name a clip that overlaps after a merge", () => {
      const { store: a, track } = withClips([]);
      const b = twin(a);
      const add = (store: ProjectStore, id: string) =>
        success(
          store.execute({
            type: "clip.add",
            params: {
              timeline: "main",
              track,
              clip: { id, start: "0", duration: "5", source: color },
            },
          }),
        );
      add(a, "a");
      add(b, "b");
      sync(a, b);
      success(
        a.execute({
          type: "clip.update",
          params: { timeline: "main", clip: "a", changes: { name: "新名字" } },
        }),
      );
      expect(clip(a, "a")?.name).toBe("新名字");
    });

    it("refuses to trim into a neighbour", () => {
      const { store } = withClips([
        { id: "a", start: "0", duration: "2" },
        { id: "b", start: "5", duration: "2" },
      ]);
      expect(failure(trim(store, "a", { end: "5.5" })).code).toBe("overlap");
      success(trim(store, "a", { end: "5" }));
    });
  });

  describe("overwriting", () => {
    it("removes what is covered completely", () => {
      const { store } = withClips([
        { id: "a", start: "0", duration: "5" },
        { id: "b", start: "6", duration: "1" },
      ]);
      success(move(store, "a", "4", "overwrite"));
      expect(clip(store, "b")).toBeUndefined();
    });

    it("trims the end of what it lands on", () => {
      const { store } = withClips([
        { id: "a", start: "0", duration: "5" },
        { id: "b", start: "6", duration: "1" },
      ]);
      success(move(store, "b", "4", "overwrite"));
      expect(spanOf(store, "a")).toEqual(["0", "4", undefined]);
    });

    it("cuts a long clip in two when it lands in the middle", () => {
      const { store } = withClips([
        { id: "a", start: "0", duration: "10" },
        { id: "b", start: "12", duration: "2" },
      ]);
      success(move(store, "b", "4", "overwrite"));
      expect(spanOf(store, "a")).toEqual(["0", "4", undefined]);
      const rest = Object.values(timeline(store).clips).find(({ start }) => start === "6");
      expect(rest?.duration).toBe("4");
      expect(rest?.offset).toBe("6");
    });

    it("undoes a clip that was first trimmed and then covered, in one step", () => {
      const { store } = withClips([
        { id: "a", start: "0", duration: "4" },
        { id: "b", start: "4", duration: "4" },
        { id: "c", start: "10", duration: "5" },
      ]);
      const before = timeline(store).clips;
      success(
        store.execute({
          type: "clip.move",
          params: {
            timeline: "main",
            clips: [
              { clip: "a", start: "8" },
              { clip: "b", start: "12" },
            ],
            overlap: "overwrite",
          },
        }),
      );
      expect(clip(store, "c")).toBeUndefined();
      store.undo();
      expect(timeline(store).clips).toEqual(before);
    });

    it("cuts a long clip wherever several clips land on it", () => {
      const { store } = withClips([
        { id: "long", start: "0", duration: "10" },
        { id: "a", start: "20", duration: "1" },
        { id: "b", start: "21", duration: "1" },
        { id: "c", start: "22", duration: "1" },
      ]);
      success(
        store.execute({
          type: "clip.move",
          params: {
            timeline: "main",
            clips: [
              { clip: "a", start: "1" },
              { clip: "b", start: "4" },
              { clip: "c", start: "7" },
            ],
            overlap: "overwrite",
          },
        }),
      );
      const parts = Object.values(timeline(store).clips)
        .filter(({ id }) => !["a", "b", "c"].includes(id))
        .map(({ start, duration, offset }) => [start, duration, offset])
        .toSorted((x, y) => Number(x[0]) - Number(y[0]));
      expect(parts).toEqual([
        ["0", "1", undefined],
        ["2", "2", "2"],
        ["5", "2", "5"],
        ["8", "2", "8"],
      ]);
    });

    it("removes clips between the ones that land, and keeps those next to them", () => {
      const { store } = withClips([
        { id: "stays", start: "0", duration: "2" },
        { id: "goes", start: "2", duration: "2" },
        { id: "trimmed", start: "4", duration: "2" },
        { id: "a", start: "20", duration: "3" },
      ]);
      success(move(store, "a", "2", "overwrite"));
      expect(clip(store, "goes")).toBeUndefined();
      expect(clip(store, "stays")?.duration).toBe("2");
      expect(spanOf(store, "trimmed")).toEqual(["5", "1", "1"]);
    });

    it("is one step to undo", () => {
      const { store } = withClips([
        { id: "a", start: "0", duration: "10" },
        { id: "b", start: "12", duration: "2" },
      ]);
      const before = timeline(store).clips;
      success(move(store, "b", "4", "overwrite"));
      store.undo();
      expect(timeline(store).clips).toEqual(before);
    });

    it("works when adding a clip too", () => {
      const { store, track } = withClips([{ id: "a", start: "0", duration: "10" }]);
      success(
        store.execute({
          type: "clip.add",
          params: {
            timeline: "main",
            track,
            clip: { id: "b", start: "8", duration: "5", source: color },
            overlap: "overwrite",
          },
        }),
      );
      expect(spanOf(store, "a")).toEqual(["0", "8", undefined]);
    });

    it("does not reach into another track", () => {
      const { store, track } = withClips([{ id: "a", start: "0", duration: "5" }]);
      success(
        store.execute({
          type: "track.add",
          params: { timeline: "main", id: "other", kind: "video" },
        }),
      );
      success(
        store.execute({
          type: "clip.add",
          params: {
            timeline: "main",
            track: "other",
            clip: { id: "b", start: "0", duration: "5", source: color },
            overlap: "overwrite",
          },
        }),
      );
      expect(clip(store, "a")?.track).toBe(track);
      expect(spanOf(store, "a")).toEqual(["0", "5", undefined]);
    });

    it("stays away from a locked track", () => {
      const { store, track } = withClips([
        { id: "a", start: "0", duration: "2" },
        { id: "b", start: "5", duration: "2" },
      ]);
      success(
        store.execute({
          type: "track.update",
          params: { timeline: "main", track, changes: { locked: true } },
        }),
      );
      expect(failure(move(store, "a", "4", "overwrite")).code).toBe("track-locked");
      expect(clip(store, "b")?.start).toBe("5");
    });
  });

  describe("moving several clips", () => {
    const moveAll = (
      store: ProjectStore,
      clips: readonly Record<string, string>[],
      overlap?: string,
    ) =>
      store.execute({
        type: "clip.move",
        params: { timeline: "main", clips, ...(overlap ? { overlap } : {}) },
      });

    it("moves neighbours past each other's old place", () => {
      const { store } = withClips([
        { id: "a", start: "0", duration: "2" },
        { id: "b", start: "2", duration: "2" },
      ]);
      success(
        moveAll(store, [
          { clip: "a", start: "1" },
          { clip: "b", start: "3" },
        ]),
      );
      expect(clip(store, "a")?.start).toBe("1");
      expect(clip(store, "b")?.start).toBe("3");
      expect(clip(store, "b")?.duration).toBe("2");
    });

    it("does not let the clips it moves overwrite each other", () => {
      const { store } = withClips([
        { id: "a", start: "0", duration: "2" },
        { id: "b", start: "2", duration: "2" },
      ]);
      success(
        moveAll(
          store,
          [
            { clip: "a", start: "1" },
            { clip: "b", start: "3" },
          ],
          "overwrite",
        ),
      );
      expect(clip(store, "a")?.duration).toBe("2");
      expect(clip(store, "b")?.duration).toBe("2");
    });

    it("refuses when they would land on each other", () => {
      const { store } = withClips([
        { id: "a", start: "0", duration: "2" },
        { id: "b", start: "2", duration: "2" },
      ]);
      const result = moveAll(store, [
        { clip: "a", start: "5" },
        { clip: "b", start: "5" },
      ]);
      expect(failure(result).code).toBe("overlap");
    });

    it("refuses the same clip twice", () => {
      const { store } = withClips([{ id: "a", start: "0", duration: "2" }]);
      const result = moveAll(store, [
        { clip: "a", start: "5" },
        { clip: "a", start: "6" },
      ]);
      expect(failure(result).code).toBe("invalid-value");
    });

    it("is one step to undo", () => {
      const { store } = withClips([
        { id: "a", start: "0", duration: "2" },
        { id: "b", start: "2", duration: "2" },
      ]);
      success(
        moveAll(store, [
          { clip: "a", start: "10" },
          { clip: "b", start: "12" },
        ]),
      );
      store.undo();
      expect(clip(store, "a")?.start).toBe("0");
      expect(clip(store, "b")?.start).toBe("2");
    });

    it("stays quick with thousands of clips", () => {
      const clips = Array.from({ length: 3000 }, (_, index) => ({
        id: `c${index}`,
        start: String(index * 2),
        duration: "1",
      }));
      const project = createProject({ name: "大项目" });
      const main = project.timelines.get("main")?.document;
      if (!main) throw new Error("no timeline");
      const track = {
        id: "track",
        kind: "video",
        clips: clips.map((item) => ({ ...item, source: color })),
      };
      const store = ProjectStore.create({
        ...project,
        timelines: new Map([
          ["main", { document: { ...main, tracks: [track] } as never, overrides: new Map() }],
        ]),
      });
      const started = performance.now();
      success(
        store.execute({
          type: "clip.move",
          params: {
            timeline: "main",
            clips: clips.map(({ id, start }) => ({ clip: id, start: `${start}.5` })),
            overlap: "overwrite",
          },
        }),
      );
      expect(performance.now() - started).toBeLessThan(2000);
      expect(clip(store, "c2999")?.start).toBe("5998.5");
    });

    it("writes nothing for a clip that stays where it is", () => {
      const { store } = withClips([{ id: "a", start: "0", duration: "2" }]);
      const revision = store.revision;
      success(moveAll(store, [{ clip: "a", start: "0" }]));
      expect(store.revision).toBe(revision);
      expect(store.canUndo).toBe(true);
    });
  });

  describe("the length of a timeline", () => {
    it("grows with a clip placed past the end, in the last section", () => {
      const { store, track } = withClips([]);
      success(
        store.execute({
          type: "section.add",
          params: { timeline: "main", id: "second", duration: "2" },
        }),
      );
      expect(toSeconds(length(store))).toBe(12);
      success(
        store.execute({
          type: "clip.add",
          params: {
            timeline: "main",
            track,
            clip: { start: "15", duration: "5", source: color },
          },
        }),
      );
      expect(toSeconds(length(store))).toBe(20);
      expect(timeline(store).sections["second"]?.duration).toBe("10");
    });

    it("grows when a clip moves or gets longer past the end", () => {
      const { store } = withClips([{ id: "a", start: "0", duration: "2" }]);
      success(move(store, "a", "11"));
      expect(toSeconds(length(store))).toBe(13);
      success(trim(store, "a", { end: "14" }));
      expect(toSeconds(length(store))).toBe(14);
      success(
        store.execute({
          type: "clip.update",
          params: { timeline: "main", clip: "a", changes: { duration: "5" } },
        }),
      );
      expect(toSeconds(length(store))).toBe(16);
    });

    it("stays as it is when there is room, and undoes with the change", () => {
      const { store } = withClips([{ id: "a", start: "0", duration: "2" }]);
      expect(toSeconds(length(store))).toBe(10);
      success(move(store, "a", "20"));
      store.undo();
      expect(toSeconds(length(store))).toBe(10);
    });

    it("stays exact with frame rates that have no finite decimal", () => {
      const { store } = withClips([{ id: "a", start: "1001/30000", duration: "10" }]);
      expect(formatTime(length(store))).toBe("301001/30000");
    });
  });

  describe("trimming", () => {
    const animated = {
      opacity: {
        keys: [
          { time: "1", value: 0 },
          { time: "3", value: 1 },
        ],
      },
    };

    it("moves the end without touching anything else", () => {
      const { store } = withClips([{ id: "a", start: "2", duration: "5" }]);
      success(trim(store, "a", { end: "4" }));
      expect(spanOf(store, "a")).toEqual(["2", "2", undefined]);
    });

    it("moves the start, and the content stays where it is on the timeline", () => {
      const { store } = withClips([{ id: "a", start: "2", duration: "5" }]);
      success(trim(store, "a", { start: "3.5" }));
      expect(spanOf(store, "a")).toEqual(["3.5", "3.5", "1.5"]);
    });

    it("leaves keys alone, so that they come back when trimmed back", () => {
      const { store } = withClips([{ id: "a", start: "0", duration: "5", properties: animated }]);
      success(trim(store, "a", { start: "2" }));
      expect(property(store, "opacity", "a")).toEqual(animated.opacity);
      success(trim(store, "a", { start: "0" }));
      expect(spanOf(store, "a")).toEqual(["0", "5", undefined]);
      expect(property(store, "opacity", "a")).toEqual(animated.opacity);
    });

    it("can move both edges at once", () => {
      const { store } = withClips([{ id: "a", start: "2", duration: "5" }]);
      success(trim(store, "a", { start: "3", end: "4" }));
      expect(spanOf(store, "a")).toEqual(["3", "1", "1"]);
    });

    it("needs an end after the start", () => {
      const { store } = withClips([{ id: "a", start: "2", duration: "5" }]);
      expect(failure(trim(store, "a", { end: "2" })).code).toBe("invalid-value");
      expect(failure(trim(store, "a", { start: "7" })).code).toBe("invalid-value");
    });

    it("stops at the beginning of content that has one", () => {
      const { store } = withClips([{ id: "a", start: "2", duration: "5", source: video }]);
      expect(failure(trim(store, "a", { start: "1" })).code).toBe("source-start");
      expect(clip(store, "a")?.start).toBe("2");
    });

    it("can bring back what was trimmed, up to the beginning", () => {
      const { store } = withClips([
        { id: "a", start: "2", duration: "5", source: video, offset: "3" },
      ]);
      success(trim(store, "a", { start: "0" }));
      expect(spanOf(store, "a")).toEqual(["0", "7", "1"]);
    });

    it("lets a picture grow forward, moving its keys along", () => {
      const words = [{ text: "你好", time: "1" }];
      const effects = [
        { id: "fx", type: "blur", properties: { radius: { keys: [{ time: "1", value: 2 }] } } },
      ];
      const { store } = withClips([
        { id: "a", start: "2", duration: "5", properties: animated, effects },
      ]);
      success(trim(store, "a", { start: "0.5" }));
      expect(spanOf(store, "a")).toEqual(["0.5", "6.5", undefined]);
      const keys = (property(store, "opacity", "a") as { keys: { time: string }[] }).keys;
      expect(keys.map(({ time }) => time)).toEqual(["2.5", "4.5"]);
      expect(clip(store, "a")?.effects?.[0]?.properties).toEqual({
        radius: { keys: [{ time: "2.5", value: 2 }] },
      });

      const caption = ProjectStore.create(createProject({ name: "字幕" }));
      success(
        caption.execute({
          type: "track.add",
          params: { timeline: "main", id: "captions", kind: "caption" },
        }),
      );
      success(
        caption.execute({
          type: "clip.add",
          params: {
            timeline: "main",
            track: "captions",
            clip: {
              id: "c",
              start: "2",
              duration: "1",
              source: { kind: "caption", text: "你好", words },
            },
          },
        }),
      );
      success(trim(caption, "c", { start: "1" }));
      expect(clip(caption, "c")?.source).toMatchObject({ words: [{ time: "2" }] });
    });

    it("copes with values that are lists", () => {
      const effects = [{ id: "fx", type: "tint", properties: { color: [1, 0, 0] } }];
      const { store } = withClips([
        { id: "a", start: "5", duration: "2", effects, properties: { "param.points": [1, 2, 3] } },
      ]);
      success(trim(store, "a", { start: "4" }));
      expect(clip(store, "a")?.effects?.[0]?.properties).toEqual({ color: [1, 0, 0] });
      expect(property(store, "param.points", "a")).toEqual([1, 2, 3]);
    });

    it("leaves a move by somebody else alone when only the end changes", () => {
      const { store: a } = withClips([{ id: "a", start: "2", duration: "5" }]);
      const b = twin(a);
      success(trim(a, "a", { end: "5" }));
      success(move(b, "a", "20"));
      sync(a, b);
      expect(clip(a, "a")?.start).toBe("20");
      expect(clip(a, "a")?.duration).toBe("3");
    });

    it("takes the keys of a version along when a picture grows forward", () => {
      const store = open();
      success(
        store.execute({
          type: "track.add",
          params: { timeline: "main", id: "free", kind: "video" },
        }),
      );
      success(
        store.execute({
          type: "clip.add",
          params: {
            timeline: "main",
            track: "free",
            clip: { id: "pic", start: "5", duration: "1", source: color },
          },
        }),
      );
      const main = store.getState().timelines["main"];
      const version = Object.keys(main?.overrides ?? {})[0] as string;
      success(
        store.importFile(
          `timelines/main/overrides/${version}.json`,
          JSON.stringify({
            scope: main?.overrides[version]?.scope,
            clips: {
              pic: {
                properties: { opacity: { value: { keys: [{ time: "1", value: 0.5 }] } } },
              },
            },
          }),
        ),
      );
      success(trim(store, "pic", { start: "4.5" }));
      const after = timeline(store).overrides[version]?.clips?.["pic"]?.properties;
      expect(after?.["opacity"]?.value).toEqual({ keys: [{ time: "1.5", value: 0.5 }] });
    });

    it("does not touch a locked track", () => {
      const { store, track } = withClips([{ id: "a", start: "0", duration: "5" }]);
      success(
        store.execute({
          type: "track.update",
          params: { timeline: "main", track, changes: { locked: true } },
        }),
      );
      expect(failure(trim(store, "a", { end: "4" })).code).toBe("track-locked");
    });

    it("is one step to undo", () => {
      const { store } = withClips([{ id: "a", start: "2", duration: "5" }]);
      success(trim(store, "a", { start: "3", end: "4" }));
      store.undo();
      expect(spanOf(store, "a")).toEqual(["2", "5", undefined]);
    });
  });

  describe("cutting", () => {
    const split = (store: ProjectStore, id: string, at: string) => {
      const result = success(
        store.execute({ type: "clip.split", params: { timeline: "main", clip: id, at } }),
      );
      return (result.results[0] as { id: string }).id;
    };

    it("makes two clips that together show the same", () => {
      const { store } = withClips([{ id: "a", start: "2", duration: "6", offset: "1" }]);
      const right = split(store, "a", "5");
      expect(spanOf(store, "a")).toEqual(["2", "3", "1"]);
      expect(spanOf(store, right)).toEqual(["5", "3", "4"]);
    });

    it("gives both parts all keys, which keeps every value the same", () => {
      const opacity = {
        keys: [
          { time: "1", value: 0 },
          { time: "3", value: 1 },
        ],
      };
      const { store } = withClips([
        { id: "a", start: "0", duration: "6", properties: { opacity } },
      ]);
      const right = split(store, "a", "2");
      expect(property(store, "opacity", "a")).toEqual(opacity);
      expect(property(store, "opacity", right)).toEqual(opacity);
    });

    it("keeps the fades on the outside", () => {
      const { store } = withClips([
        { id: "a", start: "0", duration: "6", fadeIn: "1", fadeOut: "2" },
      ]);
      const right = split(store, "a", "3");
      expect(clip(store, "a")?.fadeIn).toBe("1");
      expect(clip(store, "a")?.fadeOut).toBeUndefined();
      expect(clip(store, right)?.fadeIn).toBeUndefined();
      expect(clip(store, right)?.fadeOut).toBe("2");
    });

    it("hands a transition out of the clip to the part after the cut", () => {
      const store = open();
      const right = split(store, "clip_title", "2");
      expect(timeline(store).transitions["tr_1"]?.from).toBe(right);
      expect(timeline(store).transitions["tr_1"]?.to).toBe("clip_interview");
    });

    it("cuts linked clips along, and the parts after the cut stay linked to each other", () => {
      const { store, track } = withClips([]);
      success(
        store.execute({
          type: "track.add",
          params: { timeline: "main", id: "sound", kind: "audio" },
        }),
      );
      const sound = { kind: "audio", media: { asset: "interview" } };
      const add = (id: string, on: string, source: unknown) =>
        success(
          store.execute({
            type: "clip.add",
            params: {
              timeline: "main",
              track: on,
              clip: { id, start: "0", duration: "6", link: "link_a", source },
            },
          }),
        );
      add("picture", track, video);
      add("voice", "sound", sound);
      const right = split(store, "picture", "2");
      const clips = Object.values(timeline(store).clips);
      expect(clips).toHaveLength(4);
      const parts = clips.filter((item) => item.start === "2");
      expect(parts.map(({ id }) => id)).toContain(right);
      expect(new Set(parts.map(({ link }) => link)).size).toBe(1);
      expect(parts[0]?.link).not.toBe("link_a");
      expect(clip(store, "voice")?.link).toBe("link_a");
      expect(clip(store, "voice")?.duration).toBe("2");
    });

    it("leaves a linked clip alone when it does not reach the cut", () => {
      const { store, track } = withClips([]);
      success(
        store.execute({
          type: "track.add",
          params: { timeline: "main", id: "sound", kind: "audio" },
        }),
      );
      const addTo = (id: string, on: string, duration: string, source: unknown) =>
        success(
          store.execute({
            type: "clip.add",
            params: {
              timeline: "main",
              track: on,
              clip: { id, start: "0", duration, link: "link_a", source },
            },
          }),
        );
      addTo("picture", track, "6", video);
      addTo("voice", "sound", "1", { kind: "audio", media: { asset: "interview" } });
      const right = split(store, "picture", "2");
      expect(clip(store, "voice")?.duration).toBe("1");
      expect(clip(store, right)?.link).toBe("link_a");
    });

    it("leaves a linked clip on a locked track whole", () => {
      const { store, track } = withClips([]);
      const sound = { kind: "audio", media: { asset: "interview" } };
      success(
        store.execute({
          type: "track.add",
          params: { timeline: "main", id: "sound", kind: "audio" },
        }),
      );
      const addTo = (id: string, on: string, source: unknown) =>
        success(
          store.execute({
            type: "clip.add",
            params: {
              timeline: "main",
              track: on,
              clip: { id, start: "0", duration: "6", link: "link_a", source },
            },
          }),
        );
      addTo("picture", track, video);
      addTo("voice", "sound", sound);
      success(
        store.execute({
          type: "track.update",
          params: { timeline: "main", track: "sound", changes: { locked: true } },
        }),
      );
      split(store, "picture", "2");
      expect(clip(store, "voice")?.duration).toBe("6");
      expect(clip(store, "picture")?.duration).toBe("2");
    });

    it("gives both parts what a version changes about the clip", () => {
      const store = open();
      const main = store.getState().timelines["main"];
      const version = Object.keys(main?.overrides ?? {})[0] as string;
      success(
        store.importFile(
          `timelines/main/overrides/${version}.json`,
          JSON.stringify({
            scope: main?.overrides[version]?.scope,
            clips: { clip_card: { hidden: { value: true }, offset: { value: "1" } } },
          }),
        ),
      );
      const right = split(store, "clip_card", "26");
      const clips = timeline(store).overrides[version]?.clips;
      expect(clips?.[right]?.hidden).toEqual({ value: true });
      expect(clips?.[right]?.offset).toBeUndefined();
      expect(clips?.["clip_card"]?.hidden).toEqual({ value: true });
      store.undo();
      expect(timeline(store).overrides[version]?.clips?.[right]).toBeUndefined();
    });

    it("needs a moment inside the clip", () => {
      const { store } = withClips([{ id: "a", start: "2", duration: "5" }]);
      for (const at of ["2", "7", "1", "9"]) {
        const result = store.execute({
          type: "clip.split",
          params: { timeline: "main", clip: "a", at },
        });
        expect(failure(result).code).toBe("invalid-value");
      }
    });

    it("refuses an id that is taken", () => {
      const { store } = withClips([
        { id: "a", start: "0", duration: "5" },
        { id: "b", start: "6", duration: "1" },
      ]);
      const result = store.execute({
        type: "clip.split",
        params: { timeline: "main", clip: "a", at: "2", id: "b" },
      });
      expect(failure(result).code).toBe("id-taken");
    });

    it("is one step to undo", () => {
      const { store } = withClips([{ id: "a", start: "0", duration: "6" }]);
      const before = timeline(store).clips;
      split(store, "a", "2");
      store.undo();
      expect(timeline(store).clips).toEqual(before);
      store.redo();
      expect(Object.keys(timeline(store).clips)).toHaveLength(2);
    });

    it("writes valid files", () => {
      const store = open();
      split(store, "clip_interview", "10");
      const { files, problems } = store.exportFiles();
      expect(problems).toEqual([]);
      expect(readProject(files).problems.filter(({ severity }) => severity === "error")).toEqual(
        [],
      );
    });
  });
});

describe("two people at once", () => {
  it("keeps both changes to different properties of one clip", () => {
    const a = open();
    const b = twin(a);
    success(setProperty(a, "param.size", 80));
    success(setProperty(b, "param.accent", "#00ff00"));
    sync(a, b);
    for (const store of [a, b]) {
      expect(property(store, "param.size")).toBe(80);
      expect(property(store, "param.accent")).toBe("#00ff00");
    }
  });

  it("agrees on one value when both change the same property", () => {
    const a = open();
    const b = twin(a);
    success(setProperty(a, "param.size", 80));
    success(setProperty(b, "param.size", 90));
    sync(a, b);
    expect(property(a, "param.size")).toBe(property(b, "param.size"));
  });

  it("keeps a change to a clip that someone moved to another track", () => {
    const a = open();
    const b = twin(a);
    success(
      a.execute({ type: "track.add", params: { timeline: "main", id: "free", kind: "video" } }),
    );
    sync(a, b);
    success(
      a.execute({
        type: "clip.move",
        params: { timeline: "main", clips: [{ clip: "clip_logo", track: "free" }] },
      }),
    );
    success(setProperty(b, "opacity", 0.5, {}, "clip_logo"));
    sync(a, b);
    expect(property(a, "opacity", "clip_logo")).toBe(0.5);
  });

  it("still writes a valid timeline when both sides of a transition go at once", () => {
    const a = open();
    const b = twin(a);
    const remove = (store: ProjectStore, id: string) =>
      success(store.execute({ type: "clip.remove", params: { timeline: "main", clips: [id] } }));
    remove(a, "clip_title");
    remove(b, "clip_interview");
    sync(a, b);
    expect(a.exportFiles().problems).toEqual([]);
  });

  describe("a clip left behind on a track someone removed", () => {
    const leftBehind = () => {
      const a = open();
      const b = twin(a);
      success(
        a.execute({ type: "track.remove", params: { timeline: "main", track: "track_captions" } }),
      );
      success(
        b.execute({
          type: "clip.add",
          params: {
            timeline: "main",
            track: "track_captions",
            clip: {
              id: "clip_late",
              start: "20",
              duration: "1",
              source: { kind: "caption", text: "还在" },
            },
          },
        }),
      );
      sync(a, b);
      return a;
    };

    it("can be removed", () => {
      const store = leftBehind();
      success(
        store.execute({ type: "clip.remove", params: { timeline: "main", clips: ["clip_late"] } }),
      );
      expect(clip(store, "clip_late")).toBeUndefined();
    });

    it("can be changed, moved and moved away", () => {
      const store = leftBehind();
      success(
        store.execute({
          type: "clip.update",
          params: { timeline: "main", clip: "clip_late", changes: { name: "新名字" } },
        }),
      );
      success(
        store.execute({
          type: "track.add",
          params: { timeline: "main", id: "new", kind: "caption" },
        }),
      );
      success(
        store.execute({
          type: "clip.move",
          params: { timeline: "main", clips: [{ clip: "clip_late", track: "new" }] },
        }),
      );
      expect(clip(store, "clip_late")?.track).toBe("new");
    });
  });

  it("keeps a clip added to a track someone removed", () => {
    const a = open();
    const b = twin(a);
    success(
      a.execute({ type: "track.remove", params: { timeline: "main", track: "track_captions" } }),
    );
    success(
      b.execute({
        type: "clip.add",
        params: {
          timeline: "main",
          track: "track_captions",
          clip: {
            id: "clip_late",
            start: "20",
            duration: "1",
            source: { kind: "caption", text: "还在" },
          },
        },
      }),
    );
    sync(a, b);
    const { files, problems } = a.exportFiles();
    expect(problems).toEqual([]);
    expect(files.get(MAIN)).toContain("clip_late");
    expect(files.get(MAIN)).toContain("recovered-caption");
  });

  it("still writes a valid timeline when both remove the last sections", () => {
    const store = ProjectStore.create(createProject({ name: "a" }));
    success(
      store.execute({
        type: "section.add",
        params: { timeline: "main", id: "second", duration: "2" },
      }),
    );
    const other = twin(store);
    const first = Object.keys(store.getState().timelines["main"]?.sections ?? {}).find(
      (id) => id !== "second",
    );
    success(
      store.execute({ type: "section.remove", params: { timeline: "main", section: "second" } }),
    );
    success(
      other.execute({ type: "section.remove", params: { timeline: "main", section: first } }),
    );
    sync(store, other);
    const { problems, files } = store.exportFiles();
    expect(problems).toEqual([]);
    expect(readProject(files).problems.filter((problem) => problem.severity === "error")).toEqual(
      [],
    );
  });

  it("merges edits of the same text", () => {
    const a = open();
    const b = twin(a);
    const path = "code/animate.js";
    const text = a.getState().files[path] as string;
    success(a.importFile(path, `// 开头\n${text}`));
    success(b.importFile(path, `${text}// 结尾\n`));
    sync(a, b);
    expect(a.getState().files[path]).toBe(`// 开头\n${text}// 结尾\n`);
    expect(b.getState().files[path]).toBe(a.getState().files[path]);
  });

  it("does not put the changes of others on my undo list", () => {
    const a = open();
    const b = twin(a);
    success(setProperty(b, "param.size", 80));
    sync(a, b);
    expect(a.canUndo).toBe(false);
    expect(a.undo()).toBe(false);
    expect(property(a, "param.size")).toBe(80);
  });
});

describe("files changed outside of the editor", () => {
  const change = (store: ProjectStore, path: string, edit: (document: any) => void) => {
    const document = JSON.parse(store.exportFiles().files.get(path) as string);
    edit(document);
    return JSON.stringify(document);
  };

  it("become the smallest possible change", () => {
    const store = open();
    const text = change(store, MAIN, (document) => {
      document.tracks[0].clips[0].properties["param.size"] = 80;
    });
    const result = success(store.importFile(MAIN, text));
    expect(result.patches).toEqual([
      {
        op: "set",
        path: ["timelines", "main", "clips", "clip_title", "properties", "param.size"],
        value: 80,
      },
    ]);
    expect(property(store, "param.size")).toBe(80);
  });

  it("change nothing when the file is the same", () => {
    const store = open();
    const result = success(store.importFile(MAIN, store.exportFiles().files.get(MAIN) as string));
    expect(result.patches).toEqual([]);
  });

  it("are refused when not valid, with the reasons for the AI", () => {
    const store = open();
    const text = change(store, MAIN, (document) => {
      document.tracks[0].clips[0].start = 5;
    });
    const error = failure(store.importFile(MAIN, text, { origin: AI }));
    expect(error.code).toBe("invalid-file");
    expect(error.problems?.[0]?.path).toBe("tracks.0.clips.0.start");
    expect(clip(store)?.start).toBe("0");
  });

  it("are refused when the text is no JSON", () => {
    expect(failure(open().importFile(MAIN, "{oops")).code).toBe("invalid-file");
  });

  it("can be undone like any command", () => {
    const store = open();
    const before = store.exportFiles().files.get(MAIN);
    success(
      store.importFile(
        MAIN,
        change(store, MAIN, (document) => {
          document.tracks[0].clips.pop();
          document.name = "别的名字";
        }),
      ),
    );
    store.undo();
    expect(store.exportFiles().files.get(MAIN)).toBe(before);
  });

  it("count as the AI task that wrote them", () => {
    const store = open();
    success(
      store.importFile(
        MAIN,
        change(store, MAIN, (document) => {
          document.name = "AI 改的";
        }),
        { origin: AI },
      ),
    );
    expect(store.canUndo).toBe(false);
    store.undoTask("task-1");
    expect(timeline(store).name).toBe("主线");
  });

  it("conflict with what the person changed in the same place", () => {
    const store = open();
    const seen = store.revision;
    const text = change(store, MAIN, (document) => {
      document.tracks[0].clips[0].properties["param.size"] = 50;
    });
    success(setProperty(store, "param.size", 80));
    const result = store.importFile(MAIN, text, { origin: AI, baseRevision: seen });
    expect(failure(result).code).toBe("conflict");
  });

  it("keep the order of tracks when it did not change", () => {
    const store = open();
    const [first, second, third] = orderedTracks(timeline(store)).map((track) => track.id);
    success(
      store.execute({
        type: "track.move",
        params: { timeline: "main", track: third, before: second },
      }),
    );
    const text = store.exportFiles().files.get(MAIN) as string;
    const result = success(store.importFile(MAIN, text));
    expect(result.patches).toEqual([]);
    expect(first).toBeDefined();
  });

  it("change the order of tracks when the file does", () => {
    const store = open();
    success(
      store.importFile(
        MAIN,
        change(store, MAIN, (document) => {
          document.tracks.reverse();
        }),
      ),
    );
    expect(orderedTracks(timeline(store))[0]?.id).toBe("track_captions");
  });

  it("work for every kind of document", () => {
    const store = open();
    const paths = [...store.exportFiles().files.keys()].filter((path) => path.endsWith(".json"));
    expect(paths.length).toBeGreaterThan(10);
    for (const path of paths) {
      expect(
        success(store.importFile(path, store.exportFiles().files.get(path) as string)).patches,
        path,
      ).toEqual([]);
    }
  });

  it("can bring in a new override and a new scene", () => {
    const store = open();
    const overrides = JSON.stringify({
      scope: { format: "landscape" },
      clips: { clip_title: { hidden: { value: true } } },
    });
    success(store.importFile("timelines/main/overrides/format.landscape.json", overrides));
    expect(timeline(store).overrides["format.landscape"]).toBeDefined();
    const scene = JSON.stringify({ name: "新场景", entry: "index.html", runtime: 1 });
    success(store.importFile("scenes/new/scene.json", scene));
    success(store.importFile("scenes/new/index.html", "<p>新</p>"));
    expect(store.exportFiles().files.get("scenes/new/index.html")).toBe("<p>新</p>");
    expect(store.exportFiles().files.has("scenes/new/scene.json")).toBe(true);
  });

  it("change code with a small edit, which can be undone", () => {
    const store = open();
    const path = "code/animate.js";
    const before = store.getState().files[path] as string;
    success(store.importFile(path, `${before}// 新的一行\n`));
    expect(store.getState().files[path]).toBe(`${before}// 新的一行\n`);
    store.undo();
    expect(store.getState().files[path]).toBe(before);
  });

  it("handle text with emoji at the edges of a change", () => {
    const store = open();
    const path = "code/animate.js";
    success(store.importFile(path, "😀😀"));
    success(store.importFile(path, "😀😁"));
    expect(store.getState().files[path]).toBe("😀😁");
  });

  it("ignore files the project does not keep", () => {
    const store = open();
    const result = success(store.importFile("AGENTS.md", "别的内容"));
    expect(result.patches).toEqual([]);
  });

  it("cannot change the format version", () => {
    const store = open();
    const text = change(store, "animaquill.json", (document) => {
      document.formatVersion = 2;
    });
    expect(failure(store.importFile("animaquill.json", text)).code).toBe("format-mismatch");
  });
});

describe("history", () => {
  it("records who did what", () => {
    const store = open();
    success(setProperty(store, "param.size", 80));
    success(setProperty(store, "param.accent", "#00ff00", { origin: AI }));
    expect(store.history.map((entry) => [entry.origin, entry.commands])).toEqual([
      [USER, ["clip.setProperty"]],
      [AI, ["clip.setProperty"]],
    ]);
    expect(store.history[0]?.patches).toHaveLength(1);
  });

  it("does not record what was refused", () => {
    const store = open();
    setProperty(store, "opacity", 2);
    expect(store.history).toEqual([]);
  });
});

describe("cleaning up", () => {
  it("stops following the document", () => {
    const store = open();
    const listener = vi.fn();
    store.subscribe(listener);
    store.destroy();
    const project = { ...createProject({ name: "x" }) } as Project;
    expect(project).toBeDefined();
    store.doc.transact(() => store.doc.getMap("project").set("libraries", { libraries: [] }));
    expect(listener).not.toHaveBeenCalled();
  });
});
