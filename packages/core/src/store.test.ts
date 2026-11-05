import { createProject, readProject, type Project } from "@animaquill/schema";
import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { loadFixture } from "../../schema/scripts/fixture.ts";
import { COMMANDS } from "./commands.ts";
import { orderedSections, orderedTracks } from "./model.ts";
import { ProjectStore, USER, aiTask, type CommandResult, type ExecuteOptions } from "./store.ts";

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

const moveClip = (store: ProjectStore, start: string, options: ExecuteOptions = {}) =>
  store.execute(
    { type: "clip.move", params: { timeline: "main", clip: "clip_title", start } },
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
      params: { timeline: "main", clip: "clip_title", start: 5 },
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
      params: { timeline: "main", clip: "clip_title", track: "track_voice" },
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
      params: { timeline: "main", clip: "clip_title", track: "track_overlay" },
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
      { type: "clip.move", params: { timeline: "main", clip: "gone", start: "1" } },
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
    const result = success(
      store.execute({
        type: "clip.move",
        params: { timeline: "main", clip: "clip_logo", track: "track_video" },
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
      a.execute({
        type: "clip.move",
        params: { timeline: "main", clip: "clip_logo", track: "track_video" },
      }),
    );
    success(setProperty(b, "opacity", 0.5, {}, "clip_logo"));
    sync(a, b);
    expect(property(a, "opacity", "clip_logo")).toBe(0.5);
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
