import {
  createProject,
  formatTime,
  readProject,
  toSeconds,
  type Project,
} from "@animaquill/schema";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { loadFixture } from "../../schema/scripts/fixture.ts";
import { COMMANDS } from "./commands.ts";
import { buildAudioPlan, buildRenderPlan } from "./render-plan.ts";
import { orderedSections, orderedTracks, projectFrameRate, timelineLength } from "./model.ts";
import {
  ProjectStore,
  USER,
  aiTask,
  mergeUpdates,
  type CommandResult,
  type ExecuteOptions,
  type UndoResult,
} from "./store.ts";

const MAIN = "timelines/main/timeline.json";
const AI = aiTask("task-1");

/**
 * A project as the editor saved it before positions became world coordinates: a color, a video with
 * an opacity and a fit, and a sound, but no transform. People have projects like this, so this is
 * the real thing and not something built with today's code. Never change it.
 */
const SAVED_BEFORE_WORLD_COORDINATES =
  "ATveyuOjDgAnAQdwcm9qZWN0CG1hbmlmZXN0ASgA3srjow4ADWZvcm1hdFZlcnNpb24BfQEoAN7K46MOAAJpZAF3EnByb2plY3RfbjdlNXRwY2lrZSgA3srjow4ABG5hbWUBdwnml6fpobnnm64oAN7K46MOAAlsYW5ndWFnZXMBdQF2AgJpZHcFemgtQ04EbmFtZXcG5Lit5paHKADeyuOjDgADZnBzAXcCMzAoAN7K46MOAAdmb3JtYXRzAXUBdgUCaWR3CWxhbmRzY2FwZQRuYW1ldwbmqKrlsY8Fd2lkdGh9gB4GaGVpZ2h0fbgQA2Zwc3cCMzAoAN7K46MOAAl0aW1lbGluZXMBdQF3BG1haW4nAQdwcm9qZWN0BnNjZW5lcwEnAQdwcm9qZWN0BnNvdW5kcwEnAQdwcm9qZWN0B2xvY2FsZXMBJwEHcHJvamVjdAl0aW1lbGluZXMBJwDeyuOjDgsEbWFpbgEoAN7K46MODARuYW1lAXcG5Li757q/JwDeyuOjDgwIc2VjdGlvbnMBJwDeyuOjDg4Sc2VjdGlvbl9sdmMzcnhhNWh5ASgA3srjow4PAmlkAXcSc2VjdGlvbl9sdmMzcnhhNWh5KADeyuOjDg8IZHVyYXRpb24BdwIxMCgA3srjow4PBW9yZGVyAX0AJwDeyuOjDgwGdHJhY2tzAScA3srjow4TEHRyYWNrXzhvYTZwM3BuemYBKADeyuOjDhQCaWQBdxB0cmFja184b2E2cDNwbnpmKADeyuOjDhQEa2luZAF3BXZpZGVvKADeyuOjDhQFb3JkZXIBfQAnAN7K46MOExB0cmFja19jZXV0bnRzZGgwASgA3srjow4YAmlkAXcQdHJhY2tfY2V1dG50c2RoMCgA3srjow4YBGtpbmQBdwVhdWRpbygA3srjow4YBW9yZGVyAX0BJwDeyuOjDgwFY2xpcHMBJwDeyuOjDgwLdHJhbnNpdGlvbnMBJwDeyuOjDgwHbWFya2VycwEnAN7K46MODAlvdmVycmlkZXMBJwEHcHJvamVjdAVmaWxlcwEnAQdwcm9qZWN0BmFzc2V0cwEoAN7K46MOIQdmb290YWdlAXYFBGtpbmR3BXZpZGVvBHBhdGh3DGFzc2V0cy9hLm1wNAdzdG9yYWdldwVsb2NhbARoYXNodwlzaGEyNTYtYWEEaW5mb3YDCGR1cmF0aW9udwIyMAV3aWR0aH2APAZoZWlnaHR9sCEnAN7K46MOHAdjX2NvbG9yASgA3srjow4jBXN0YXJ0AXcBMCgA3srjow4jCGR1cmF0aW9uAXcBMigA3srjow4jBnNvdXJjZQF2AgRraW5kdwVjb2xvcgVjb2xvcncHI2ZmMDAwMCgA3srjow4jAmlkAXcHY19jb2xvcigA3srjow4jBXRyYWNrAXcQdHJhY2tfOG9hNnAzcG56ZicA3srjow4cB2NfdmlkZW8BKADeyuOjDikFc3RhcnQBdwEyKADeyuOjDikIZHVyYXRpb24BdwE1KADeyuOjDikGc291cmNlAXYCBGtpbmR3BXZpZGVvBW1lZGlhdgEFYXNzZXR3B2Zvb3RhZ2UoAN7K46MOKQZvZmZzZXQBdwExKADeyuOjDikCaWQBdwdjX3ZpZGVvKADeyuOjDikFdHJhY2sBdxB0cmFja184b2E2cDNwbnpmJwDeyuOjDhwHY19hdWRpbwEoAN7K46MOMAVzdGFydAF3ATIoAN7K46MOMAhkdXJhdGlvbgF3ATUoAN7K46MOMAZzb3VyY2UBdgIEa2luZHcFYXVkaW8FbWVkaWF2AQVhc3NldHcHZm9vdGFnZScA3srjow4wCnByb3BlcnRpZXMBKADeyuOjDjQMYXVkaW8udm9sdW1lAX1DKADeyuOjDjACaWQBdwdjX2F1ZGlvKADeyuOjDjAFdHJhY2sBdxB0cmFja19jZXV0bnRzZGgwJwDeyuOjDikKcHJvcGVydGllcwEoAN7K46MOOAdvcGFjaXR5AXw/AAAAKADeyuOjDjgDZml0AXcFY292ZXIA";

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
    expect(failure(setProperty(store, "object.秤砣.x", 1)).code).toBe("invalid-params");
    expect(failure(setProperty(store, "object.constructor.x", 1)).code).toBe("invalid-params");
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
    expect(store.undo().ok).toBe(true);
    expect(property(store, "param.size")).toBe(80);
    expect(store.undo().ok).toBe(true);
    expect(property(store, "param.size")).toBe(64);
    expect(store.redo().ok).toBe(true);
    expect(property(store, "param.size")).toBe(80);
  });

  it("has nothing to do on a fresh project", () => {
    const store = open();
    expect(store.canUndo).toBe(false);
    expect(store.undo().ok).toBe(false);
    expect(store.redo().ok).toBe(false);
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
    expect(store.undoTask("task-1").ok).toBe(true);
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
    expect(store.redoTask("task-1").ok).toBe(true);
    expect(property(store, "param.size")).toBe(80);
  });

  it("does nothing for a task it does not know", () => {
    expect(open().undoTask("nobody").ok).toBe(false);
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
    expect(store.undo().ok).toBe(false);
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
    expect(a.undo().ok).toBe(false);
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

/** Writes a property the way the editor did when `properties` was a map of its own. */
function writeLikeBefore(store: ProjectStore, id: string, path: string, value: unknown): void {
  const inside = (map: Y.Map<unknown>, key: string) => map.get(key) as Y.Map<unknown>;
  const main = inside(inside(store.doc.getMap("project"), "timelines"), "main");
  const owner = inside(inside(main, "clips"), id);
  store.doc.transact(() => {
    let properties = owner.get("properties");
    if (!(properties instanceof Y.Map)) {
      properties = new Y.Map<unknown>();
      owner.set("properties", properties);
    }
    (properties as Y.Map<unknown>).set(path, value);
  }, "old");
}

function freshProject(): ProjectStore {
  const store = ProjectStore.create(createProject({ name: "并发" }));
  const track = Object.values(timeline(store).tracks).find(({ kind }) => kind === "video");
  const color = { kind: "color", color: "#112233" };
  for (const [index, id] of ["c", "d"].entries()) {
    const added = { id, start: String(index * 10), duration: "8", source: color };
    success(
      store.execute({
        type: "clip.add",
        params: { timeline: "main", track: track?.id, clip: added },
      }),
    );
  }
  return store;
}

const edit = (store: ProjectStore, clipId: string, change: object, options: ExecuteOptions = {}) =>
  store.execute(
    {
      type: "property.edit",
      params: { timeline: "main", edits: [{ owner: { clip: clipId }, ...change }] },
    },
    options,
  );

describe("two devices writing different properties", () => {
  it("keeps both on a clip that had none", () => {
    const a = freshProject();
    const b = twin(a);
    success(edit(a, "c", { path: "opacity", op: "set", value: 0.5 }));
    success(edit(b, "c", { path: "transform.x", op: "setKey", time: "1", value: 100 }));
    sync(a, b);
    const both = { opacity: 0.5, "transform.x": { keys: [{ time: "1", value: 100 }] } };
    expect(clip(a, "c")?.properties).toEqual(both);
    expect(clip(b, "c")?.properties).toEqual(both);
  });

  it("does not depend on who is first, or who wins", () => {
    for (let round = 0; round < 12; round += 1) {
      const a = freshProject();
      const b = twin(a);
      success(edit(a, "c", { path: "transform.x", op: "set", value: 1 }));
      success(edit(b, "c", { path: "transform.y", op: "set", value: 2 }));
      success(edit(a, "c", { path: "transform.scale", op: "set", value: 3 }));
      if (round % 2 === 0) sync(a, b);
      else sync(b, a);
      const properties = { "transform.x": 1, "transform.y": 2, "transform.scale": 3 };
      expect(clip(a, "c")?.properties).toEqual(properties);
      expect(clip(b, "c")?.properties).toEqual(properties);
    }
  });

  it("keeps both after the clip got its first property from somebody else", () => {
    const a = freshProject();
    const b = twin(a);
    success(edit(a, "c", { path: "opacity", op: "set", value: 0.5 }));
    sync(a, b);
    success(edit(a, "c", { path: "transform.x", op: "set", value: 1 }));
    success(edit(b, "c", { path: "transform.y", op: "set", value: 2 }));
    sync(a, b);
    expect(clip(b, "c")?.properties).toEqual({
      opacity: 0.5,
      "transform.x": 1,
      "transform.y": 2,
    });
  });

  it("each can undo their own afterwards", () => {
    const a = freshProject();
    const b = twin(a);
    success(edit(a, "c", { path: "opacity", op: "set", value: 0.5 }));
    success(edit(b, "c", { path: "transform.x", op: "set", value: 1 }));
    sync(a, b);
    expect(a.undo().ok).toBe(true);
    sync(a, b);
    expect(clip(b, "c")?.properties).toEqual({ "transform.x": 1 });
    expect(b.undo().ok).toBe(true);
    sync(a, b);
    expect(clip(a, "c")?.properties).toBeUndefined();
    expect(clip(b, "c")?.properties).toBeUndefined();
  });

  it("leaves one value on both when they write the same property", () => {
    const a = freshProject();
    const b = twin(a);
    success(edit(a, "c", { path: "opacity", op: "set", value: 0.25 }));
    success(edit(b, "c", { path: "opacity", op: "set", value: 0.75 }));
    sync(a, b);
    expect(property(a, "opacity", "c")).toBe(property(b, "opacity", "c"));
    expect([0.25, 0.75]).toContain(property(a, "opacity", "c"));
  });

  it("a property and another field of the clip do not touch each other", () => {
    const a = freshProject();
    const b = twin(a);
    success(edit(a, "c", { path: "opacity", op: "set", value: 0.5 }));
    const changes = { name: "新名字" };
    success(b.execute({ type: "clip.update", params: { timeline: "main", clip: "c", changes } }));
    sync(a, b);
    expect(clip(a, "c")).toMatchObject({ name: "新名字", properties: { opacity: 0.5 } });
  });

  it("holds for what comes with a whole clip too", () => {
    const a = freshProject();
    const b = twin(a);
    const track = clip(a, "c")?.track;
    const added = {
      id: "e",
      start: "30",
      duration: "1",
      source: { kind: "color", color: "#112233" },
      properties: { opacity: 0.5 },
    };
    const params = { timeline: "main", track, clip: added };
    success(a.execute({ type: "clip.add", params }));
    sync(a, b);
    success(edit(a, "e", { path: "transform.x", op: "set", value: 1 }));
    success(edit(b, "e", { path: "transform.y", op: "set", value: 2 }));
    sync(a, b);
    expect(clip(b, "e")?.properties).toEqual({
      opacity: 0.5,
      "transform.x": 1,
      "transform.y": 2,
    });
  });

  it("holds for tracks", () => {
    const a = freshProject();
    const b = twin(a);
    const withProperties = (store: ProjectStore, properties: object) => {
      const file = JSON.parse(store.exportFiles().files.get(MAIN) as string) as {
        tracks: { kind: string; properties?: object }[];
      };
      for (const track of file.tracks) if (track.kind === "audio") track.properties = properties;
      return JSON.stringify(file);
    };
    success(a.importFile(MAIN, withProperties(a, { "audio.volume": -6 })));
    success(b.importFile(MAIN, withProperties(b, { "audio.pan": 0.5 })));
    sync(a, b);
    const audio = Object.values(timeline(a).tracks).find(({ kind }) => kind === "audio");
    expect(audio).toMatchObject({ properties: { "audio.volume": -6, "audio.pan": 0.5 } });
  });

  it("holds for the first file of a project", () => {
    const a = freshProject();
    const b = twin(a);
    const asset = (id: string) => ({
      id,
      asset: { kind: "image", path: `assets/${id}.png`, storage: "local", hash: `sha256-${id}` },
    });
    success(a.execute({ type: "asset.add", params: asset("one") }));
    success(b.execute({ type: "asset.add", params: asset("two") }));
    sync(a, b);
    expect(Object.keys(a.getState().assets ?? {}).toSorted()).toEqual(["one", "two"]);
    expect(Object.keys(b.getState().assets ?? {}).toSorted()).toEqual(["one", "two"]);
  });

  it("holds for the first notes of a project", () => {
    const a = freshProject();
    const b = twin(a);
    const note = (id: string) => {
      const createdAt = "2026-11-06T00:00:00Z";
      const text = "一条批注";
      const notes = [{ id, status: "pending", text, timeline: "main", time: "1", createdAt }];
      return JSON.stringify({ notes });
    };
    success(a.importFile("notes.json", note("one")));
    success(b.importFile("notes.json", note("two")));
    sync(a, b);
    expect(Object.keys(a.getState().notes ?? {}).toSorted()).toEqual(["one", "two"]);
  });

  it("makes no map for what not everything has, because that is what two devices fight over", () => {
    const store = open();
    const inside = (map: Y.Map<unknown>, key: string) => map.get(key) as Y.Map<unknown>;
    const root = store.doc.getMap("project") as Y.Map<unknown>;
    const main = inside(inside(root, "timelines"), "main");
    const fromFile = inside(inside(main, "clips"), "clip_logo");
    expect(fromFile.has("properties")).toBe(false);
    expect(fromFile.get("properties/transform.x")).toBeDefined();
    expect(root.has("assets")).toBe(false);
    expect([...root.keys()].some((key) => key.startsWith("assets/"))).toBe(true);

    const added = {
      id: "e",
      start: "100",
      duration: "1",
      source: { kind: "color", color: "#112233" },
      properties: { opacity: 0.5 },
    };
    const params = { timeline: "main", track: clip(store, "clip_logo")?.track, clip: added };
    success(store.execute({ type: "clip.add", params }));
    const fromCommand = inside(inside(main, "clips"), "e");
    expect(fromCommand.has("properties")).toBe(false);
    expect(fromCommand.get("properties/opacity")).toBe(0.5);
  });

  it("lets a file take all of them away, and undo bring them back", () => {
    const a = freshProject();
    success(edit(a, "c", { path: "opacity", op: "set", value: 0.5 }));
    success(edit(a, "c", { path: "transform.x", op: "set", value: 1 }));
    const file = JSON.parse(a.exportFiles().files.get(MAIN) as string) as {
      tracks: { clips: { properties?: object }[] }[];
    };
    for (const track of file.tracks) for (const item of track.clips) delete item.properties;
    success(a.importFile(MAIN, JSON.stringify(file)));
    expect(clip(a, "c")).not.toHaveProperty("properties");
    const { store: opened } = ProjectStore.fromUpdates([a.encodeState()]);
    expect(clip(opened as ProjectStore, "c")).not.toHaveProperty("properties");
    expect(a.undo().ok).toBe(true);
    expect(clip(a, "c")?.properties).toEqual({ opacity: 0.5, "transform.x": 1 });
  });

  it("goes through saving: what comes back is the same", () => {
    const a = freshProject();
    success(edit(a, "c", { path: "opacity", op: "set", value: 0.5 }));
    const { store } = ProjectStore.fromUpdates([a.encodeState()]);
    expect(store?.getState()).toEqual(a.getState());
    expect(store?.exportFiles().files).toEqual(a.exportFiles().files);
  });
});

describe("a document from when properties had a map of their own", () => {
  function written() {
    const store = freshProject();
    writeLikeBefore(store, "c", "opacity", 0.5);
    writeLikeBefore(store, "c", "transform.x", 10);
    return store;
  }

  it("shows what is in there, also when it comes in from somewhere else", () => {
    const store = written();
    expect(clip(store, "c")?.properties).toEqual({ opacity: 0.5, "transform.x": 10 });
    const { store: opened } = ProjectStore.fromUpdates([store.encodeState()]);
    expect(clip(opened as ProjectStore, "c")?.properties).toEqual({
      opacity: 0.5,
      "transform.x": 10,
    });
  });

  it("adds to it without losing anything", () => {
    const store = written();
    success(edit(store, "c", { path: "transform.y", op: "set", value: 20 }));
    expect(clip(store, "c")?.properties).toEqual({
      opacity: 0.5,
      "transform.x": 10,
      "transform.y": 20,
    });
  });

  it("changes what was in there, and the new value stays after opening again", () => {
    const store = written();
    success(edit(store, "c", { path: "opacity", op: "set", value: 0.25 }));
    expect(property(store, "opacity", "c")).toBe(0.25);
    const { store: opened } = ProjectStore.fromUpdates([store.encodeState()]);
    expect(property(opened as ProjectStore, "opacity", "c")).toBe(0.25);
  });

  it("clears what was in there for good", () => {
    const store = written();
    success(edit(store, "c", { path: "opacity", op: "clear" }));
    expect(property(store, "opacity", "c")).toBeUndefined();
    const { store: opened } = ProjectStore.fromUpdates([store.encodeState()]);
    expect(property(opened as ProjectStore, "opacity", "c")).toBeUndefined();
    expect(property(opened as ProjectStore, "transform.x", "c")).toBe(10);
  });

  it("lets a file take all of it away", () => {
    const store = written();
    const file = JSON.parse(store.exportFiles().files.get(MAIN) as string) as {
      tracks: { clips: { properties?: object }[] }[];
    };
    for (const track of file.tracks) for (const item of track.clips) delete item.properties;
    success(store.importFile(MAIN, JSON.stringify(file)));
    expect(clip(store, "c")).not.toHaveProperty("properties");
    const { store: opened } = ProjectStore.fromUpdates([store.encodeState()]);
    expect(clip(opened as ProjectStore, "c")).not.toHaveProperty("properties");
  });

  it("does not bring an old value back when a new one is cleared", () => {
    const store = written();
    success(edit(store, "c", { path: "opacity", op: "set", value: 0.25 }));
    success(edit(store, "c", { path: "opacity", op: "clear" }));
    expect(property(store, "opacity", "c")).toBeUndefined();
  });

  it("undoes and redoes like anywhere else", () => {
    const store = written();
    success(edit(store, "c", { path: "opacity", op: "set", value: 0.25 }));
    expect(store.undo().ok).toBe(true);
    expect(property(store, "opacity", "c")).toBe(0.5);
    expect(store.redo().ok).toBe(true);
    expect(property(store, "opacity", "c")).toBe(0.25);
  });

  it("merges with what two devices do to it", () => {
    const a = written();
    const b = twin(a);
    expect(clip(b, "c")?.properties).toEqual({ opacity: 0.5, "transform.x": 10 });
    success(edit(a, "c", { path: "opacity", op: "set", value: 0.25 }));
    success(edit(b, "c", { path: "transform.y", op: "set", value: 20 }));
    success(edit(b, "c", { path: "transform.x", op: "clear" }));
    sync(a, b);
    const merged = { opacity: 0.25, "transform.y": 20 };
    expect(clip(a, "c")?.properties).toEqual(merged);
    expect(clip(b, "c")?.properties).toEqual(merged);
  });

  it("merges with a device that still writes the old way", () => {
    const a = freshProject();
    const b = twin(a);
    success(edit(a, "c", { path: "transform.x", op: "set", value: 1 }));
    writeLikeBefore(b, "c", "transform.y", 2);
    sync(a, b);
    const merged = { "transform.x": 1, "transform.y": 2 };
    expect(clip(a, "c")?.properties).toEqual(merged);
    expect(clip(b, "c")?.properties).toEqual(merged);
  });

  it("the value that was written last in the new way wins over the old way", () => {
    const store = freshProject();
    success(edit(store, "c", { path: "opacity", op: "set", value: 0.25 }));
    writeLikeBefore(store, "c", "opacity", 0.75);
    expect(property(store, "opacity", "c")).toBe(0.25);
    // The first one made the old map. This one comes in as a change to a map that is there.
    writeLikeBefore(store, "c", "opacity", 0.9);
    expect(property(store, "opacity", "c")).toBe(0.25);
    const { store: opened } = ProjectStore.fromUpdates([store.encodeState()]);
    expect(property(opened as ProjectStore, "opacity", "c")).toBe(0.25);
  });

  it("does not take a name that means something to objects for a property", () => {
    const store = freshProject();
    writeLikeBefore(store, "c", "__proto__", { keys: [{ time: "0", value: 1 }] });
    writeLikeBefore(store, "c", "opacity", 0.5);
    const properties = clip(store, "c")?.properties as object;
    expect(Object.getPrototypeOf(properties)).toBe(Object.prototype);
    expect(Object.keys(properties)).toEqual(["opacity"]);
    const { store: opened } = ProjectStore.fromUpdates([store.encodeState()]);
    expect(Object.keys(clip(opened as ProjectStore, "c")?.properties as object)).toEqual([
      "opacity",
    ]);
  });
});

describe("what a document can hold that nothing should", () => {
  const ownerOf = (store: ProjectStore, id: string) => {
    const inside = (map: Y.Map<unknown>, key: string) => map.get(key) as Y.Map<unknown>;
    const main = inside(inside(store.doc.getMap("project"), "timelines"), "main");
    return inside(inside(main, "clips"), id);
  };

  it.each([["properties/__proto__"], ["__proto__"]])("stays out when it comes in as %s", (key) => {
    const store = freshProject();
    success(edit(store, "c", { path: "opacity", op: "set", value: 0.5 }));
    const owner = ownerOf(store, "c");
    store.doc.transact(() => owner.set(key, { keys: [{ time: "0", value: 1 }] }), "other");
    for (const opened of [store, ProjectStore.fromUpdates([store.encodeState()]).store]) {
      const found = clip(opened as ProjectStore, "c") as object;
      const properties = clip(opened as ProjectStore, "c")?.properties as object;
      expect(Object.getPrototypeOf(found)).toBe(Object.prototype);
      expect(Object.getPrototypeOf(properties)).toBe(Object.prototype);
      expect(Object.keys(properties)).toEqual(["opacity"]);
      expect(Object.keys(found)).not.toContain("__proto__");
    }
  });

  it("does not stop the rest of a change", () => {
    const store = freshProject();
    const owner = ownerOf(store, "c");
    store.doc.transact(() => {
      owner.set("properties/__proto__", 1);
      owner.set("properties/opacity", 0.5);
    }, "other");
    expect(clip(store, "c")?.properties).toEqual({ opacity: 0.5 });
  });
});

describe("taking several steps back in a row", () => {
  const keys = (store: ProjectStore) =>
    (property(store, "transform.x", "c") as { keys: { time: string }[] } | undefined)?.keys.map(
      ({ time }) => time,
    );
  const setKey = (store: ProjectStore, time: string, options: ExecuteOptions = {}) =>
    success(edit(store, "c", { path: "transform.x", op: "setKey", time, value: 1 }, options));

  it("goes all the way back through its own changes, and forward again", () => {
    const store = freshProject();
    setKey(store, "0");
    setKey(store, "1");
    setKey(store, "2");
    store.undo();
    expect(keys(store)).toEqual(["0", "1"]);
    store.undo();
    expect(keys(store)).toEqual(["0"]);
    store.undo();
    expect(keys(store)).toBeUndefined();
    store.redo();
    store.redo();
    store.redo();
    expect(keys(store)).toEqual(["0", "1", "2"]);
  });

  it("stops where an AI task changed the same property", () => {
    const store = freshProject();
    setKey(store, "0");
    setKey(store, "1", { origin: AI });
    setKey(store, "2");
    expect(store.undo().ok).toBe(true);
    expect(keys(store)).toEqual(["0", "1"]);
    store.undo();
    expect(keys(store)).toEqual(["0", "1"]);
  });

  it("stops where somebody on another device changed it", () => {
    const a = freshProject();
    const b = twin(a);
    setKey(a, "0");
    sync(a, b);
    setKey(b, "1");
    sync(a, b);
    setKey(a, "2");
    a.undo();
    a.undo();
    expect(keys(a)).toEqual(["0", "1"]);
  });

  it("goes on with other properties when asked again, not by itself", () => {
    const store = freshProject();
    success(edit(store, "c", { path: "opacity", op: "set", value: 0.5 }));
    setKey(store, "0");
    setKey(store, "1", { origin: AI });
    setKey(store, "2");
    store.undo();
    expect(store.undo().ok).toBe(false);
    expect(property(store, "opacity", "c")).toBe(0.5);
    expect(keys(store)).toEqual(["0", "1"]);
    expect(store.undo().ok).toBe(true);
    expect(property(store, "opacity", "c")).toBeUndefined();
    expect(keys(store)).toEqual(["0", "1"]);
  });

  it("the AI task can still take back what is its own", () => {
    const store = freshProject();
    setKey(store, "0");
    setKey(store, "1", { origin: AI });
    setKey(store, "2");
    store.undo();
    expect(store.undoTask("task-1").ok).toBe(true);
    expect(keys(store)).toEqual(["0"]);
  });

  it("takes back what is left of it once the AI task took back its own", () => {
    const store = freshProject();
    setKey(store, "0");
    setKey(store, "1", { origin: AI });
    expect(store.undoTask("task-1").ok).toBe(true);
    expect(store.undo().ok).toBe(true);
    expect(keys(store)).toBeUndefined();
  });

  it("does not take back an AI task over what the person did afterwards", () => {
    const store = freshProject();
    setKey(store, "1", { origin: AI });
    setKey(store, "2");
    expect(store.undoTask("task-1").ok).toBe(false);
    expect(keys(store)).toEqual(["1", "2"]);
  });

  it("does not redo over what somebody did after the undo", () => {
    const store = freshProject();
    setKey(store, "0");
    store.undo();
    setKey(store, "1", { origin: AI });
    expect(store.redo().ok).toBe(false);
    expect(keys(store)).toEqual(["1"]);
  });

  it("does not redo what an AI task took back in the meantime", () => {
    const store = freshProject();
    setKey(store, "0");
    setKey(store, "1", { origin: AI });
    setKey(store, "2");
    store.undo();
    store.undoTask("task-1");
    expect(store.redo().ok).toBe(false);
    expect(keys(store)).toEqual(["0"]);
  });

  it("redoes what it undid when the other device did something else", () => {
    const a = freshProject();
    const b = twin(a);
    setKey(a, "0");
    a.undo();
    sync(a, b);
    success(edit(b, "c", { path: "opacity", op: "set", value: 0.5 }));
    sync(a, b);
    expect(a.redo().ok).toBe(true);
    expect(keys(a)).toEqual(["0"]);
  });

  it("takes a clip away with what was in it, as long as that is all its own", () => {
    const store = freshProject();
    success(edit(store, "c", { path: "opacity", op: "set", value: 0.5 }));
    store.undo();
    store.undo();
    store.undo();
    expect(Object.keys(timeline(store).clips)).toEqual([]);
  });

  it("leaves a clip that somebody else put something in", () => {
    const store = freshProject();
    success(edit(store, "d", { path: "opacity", op: "set", value: 0.5 }, { origin: AI }));
    store.undo();
    expect(Object.keys(timeline(store).clips)).toContain("d");
  });

  it("undoes a change with several steps on top of each other as one", () => {
    const store = freshProject();
    const track = clip(store, "c")?.track;
    const added = {
      id: "e",
      start: "30",
      duration: "1",
      source: { kind: "color", color: "#000000" },
    };
    const calls = [
      { type: "clip.add", params: { timeline: "main", track, clip: added } },
      {
        type: "property.edit",
        params: {
          timeline: "main",
          edits: [{ owner: { clip: "e" }, path: "opacity", op: "set", value: 0.5 }],
        },
      },
    ];
    success(store.executeBatch(calls));
    expect(store.undo().ok).toBe(true);
    expect(clip(store, "e")).toBeUndefined();
    expect(store.redo().ok).toBe(true);
    expect(property(store, "opacity", "e")).toBe(0.5);
  });
});

/** Another window, with a client id to decide who wins: at the same time, the higher one does. */
function windowOf(store: ProjectStore, clientID: number): ProjectStore {
  const doc = new Y.Doc();
  doc.clientID = clientID;
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(store.doc), "sync");
  return new ProjectStore(doc);
}

function blocked(result: UndoResult) {
  if (result.ok) throw new Error("expected this to stay as it is");
  expect(result.error.code).toBe("undo-blocked");
  return result.error;
}

function taken(result: UndoResult) {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result;
}

const opacity = (store: ProjectStore, id = "c") => property(store, "opacity", id);
const setOpacity = (store: ProjectStore, value: number, options: ExecuteOptions = {}, id = "c") =>
  success(edit(store, id, { path: "opacity", op: "set", value }, options));
const clearOpacity = (store: ProjectStore, options: ExecuteOptions = {}) =>
  success(edit(store, "c", { path: "opacity", op: "clear" }, options));
const moveTo = (store: ProjectStore, id: string, start: string, options: ExecuteOptions = {}) =>
  success(
    store.execute(
      { type: "clip.move", params: { timeline: "main", clips: [{ clip: id, start }] } },
      options,
    ),
  );

describe("taking back a write the document no longer holds", () => {
  it("leaves the same value written by somebody else over an older step", () => {
    const store = freshProject();
    setOpacity(store, 0.2);
    setOpacity(store, 0.5);
    setOpacity(store, 0.8);
    setOpacity(store, 0.5, { origin: AI });
    blocked(store.undo());
    expect(opacity(store)).toBe(0.5);
    blocked(store.undo());
    expect(opacity(store)).toBe(0.5);
    blocked(store.undo());
    expect(opacity(store)).toBe(0.5);
  });

  it("does the same for a value that was switched back and forth", () => {
    const store = freshProject();
    const hide = (hidden: boolean, options: ExecuteOptions = {}) =>
      success(
        store.execute(
          { type: "clip.update", params: { timeline: "main", clip: "c", changes: { hidden } } },
          options,
        ),
      );
    hide(true);
    hide(false);
    hide(true, { origin: AI });
    blocked(store.undo());
    blocked(store.undo());
    expect(clip(store, "c")?.hidden).toBe(true);
  });

  it("does not bring back what somebody else also took away", () => {
    const store = freshProject();
    setOpacity(store, 0.2);
    clearOpacity(store);
    setOpacity(store, 0.9, { origin: AI });
    clearOpacity(store, { origin: AI });
    blocked(store.undo());
    expect(opacity(store)).toBeUndefined();
  });

  it("does not let an AI task take back what a person wrote with the same value", () => {
    const store = freshProject();
    setOpacity(store, 0.2, { origin: AI });
    setOpacity(store, 0.8, { origin: AI });
    setOpacity(store, 0.2);
    blocked(store.undoTask("task-1"));
    expect(opacity(store)).toBe(0.2);
  });

  it("does not take back an AI task from the same value on another device", () => {
    const a = freshProject();
    setOpacity(a, 0.2, { origin: AI });
    const b = twin(a);
    setOpacity(b, 0.5);
    sync(a, b);
    setOpacity(b, 0.2);
    sync(a, b);
    blocked(a.undoTask("task-1"));
    expect(opacity(a)).toBe(0.2);
  });

  describe.each([
    ["the first", 2, 1],
    ["the second", 1, 2],
  ])("two windows writing the same value at once, %s one winning", (_, first, second) => {
    const setUp = () => {
      const base = freshProject();
      setOpacity(base, 1);
      const a = windowOf(base, first);
      const b = windowOf(base, second);
      setOpacity(a, 0.5);
      setOpacity(b, 0.5);
      sync(a, b);
      return first > second ? { winner: a, loser: b } : { winner: b, loser: a };
    };

    it("takes back the write the document holds", () => {
      const { winner, loser } = setUp();
      taken(winner.undo());
      sync(winner, loser);
      expect(opacity(winner)).toBe(1);
      expect(opacity(loser)).toBe(1);
    });

    it("does not take back the other one, before or after", () => {
      const { winner, loser } = setUp();
      blocked(loser.undo());
      expect(opacity(loser)).toBe(0.5);
      taken(winner.undo());
      sync(winner, loser);
      expect(opacity(loser)).toBe(1);
      expect(loser.canUndo).toBe(false);
    });

    it("does not go on from the undo of the other one", () => {
      const { winner, loser } = setUp();
      taken(winner.undo());
      sync(winner, loser);
      blocked(loser.undo());
      expect(opacity(loser)).toBe(1);
    });
  });

  it("does not mistake a clip that came back for the one it wrote to", () => {
    const a = freshProject();
    const b = twin(a);
    const remove = { type: "clip.remove", params: { timeline: "main", clips: ["c"] } };
    moveTo(a, "c", "1");
    sync(a, b);
    success(b.execute(remove));
    sync(a, b);
    taken(b.undo());
    sync(a, b);
    expect(clip(a, "c")?.start).toBe("1");
    blocked(a.undo());
    expect(clip(a, "c")?.start).toBe("1");
  });

  it("does not write into a clip that is gone, when there is no write of it left to see", () => {
    const a = freshProject();
    const b = twin(a);
    setOpacity(a, 0.5);
    a.undo();
    sync(a, b);
    success(b.execute({ type: "clip.remove", params: { timeline: "main", clips: ["c"] } }));
    sync(a, b);
    blocked(a.redo());
    expect(clip(a, "c")).toBeUndefined();
  });

  it("does not redo into a clip that was replaced, with the same content", () => {
    const a = freshProject();
    const b = twin(a);
    setOpacity(a, 0.5);
    a.undo();
    sync(a, b);
    const remove = { type: "clip.remove", params: { timeline: "main", clips: ["c"] } };
    success(b.execute(remove));
    taken(b.undo());
    sync(a, b);
    blocked(a.redo());
    expect(opacity(a)).toBeUndefined();
  });

  it("sees the text of a file like anything else", () => {
    const a = ProjectStore.create(createProject({ name: "文件" }), { "code/a.js": "一" });
    const b = twin(a);
    const save = (store: ProjectStore, text: string) =>
      success(store.importFile("code/a.js", text));
    save(a, "二");
    sync(a, b);
    save(b, "三");
    save(b, "二");
    sync(a, b);
    blocked(a.undo());
    expect(a.getState().files["code/a.js"]).toBe("二");
  });
});

describe("whose a value is after it was put back", () => {
  it("is whoever wrote it before: the path goes back to the AI task", () => {
    const store = freshProject();
    setOpacity(store, 0.2);
    setOpacity(store, 0.5, { origin: AI });
    setOpacity(store, 0.8);
    taken(store.undo());
    expect(opacity(store)).toBe(0.5);
    blocked(store.undo());
    expect(opacity(store)).toBe(0.5);
    taken(store.undoTask("task-1"));
    expect(opacity(store)).toBe(0.2);
  });

  it("is the person again once the task took back its own", () => {
    const store = freshProject();
    setOpacity(store, 0.2);
    setOpacity(store, 0.5, { origin: AI });
    taken(store.undoTask("task-1"));
    taken(store.undo());
    expect(opacity(store)).toBeUndefined();
  });

  it("is the step again after a redo", () => {
    const store = freshProject();
    setOpacity(store, 0.2);
    setOpacity(store, 0.5);
    taken(store.undo());
    taken(store.redo());
    taken(store.undo());
    taken(store.undo());
    expect(opacity(store)).toBeUndefined();
    taken(store.redo());
    taken(store.redo());
    expect(opacity(store)).toBe(0.5);
  });

  it("is the task again after a redo of the task", () => {
    const store = freshProject();
    setOpacity(store, 0.2, { origin: AI });
    setOpacity(store, 0.4, { origin: AI });
    taken(store.undoTask("task-1"));
    expect(opacity(store)).toBeUndefined();
    taken(store.redoTask("task-1"));
    expect(opacity(store)).toBe(0.4);
    taken(store.undoTask("task-1"));
    expect(opacity(store)).toBeUndefined();
  });

  it("is nobody's to take when it was there from the start", () => {
    const store = freshProject();
    const other = twin(store);
    setOpacity(other, 0.5);
    taken(other.undo());
    expect(opacity(other)).toBeUndefined();
    expect(other.canUndo).toBe(false);
  });

  it("is no write of somebody else in the window that took it back", () => {
    const store = freshProject();
    moveTo(store, "c", "1");
    moveTo(store, "d", "11");
    moveTo(store, "c", "2");
    taken(store.undo());
    taken(store.undo());
    taken(store.undo());
    expect(clip(store, "c")?.start).toBe("0");
    expect(clip(store, "d")?.start).toBe("10");
  });

  it("is a write from elsewhere in any other window", () => {
    const a = freshProject();
    const b = twin(a);
    setOpacity(a, 0.2);
    sync(a, b);
    setOpacity(b, 0.5);
    sync(a, b);
    taken(b.undo());
    sync(a, b);
    expect(opacity(a)).toBe(0.2);
    blocked(a.undo());
    expect(opacity(a)).toBe(0.2);
  });

  it("keeps a clip that was taken away and put back as it was", () => {
    const store = freshProject();
    setOpacity(store, 0.5, { origin: AI });
    moveTo(store, "c", "1");
    success(store.execute({ type: "clip.remove", params: { timeline: "main", clips: ["c"] } }));
    taken(store.undo());
    taken(store.undo());
    expect(clip(store, "c")?.start).toBe("0");
    taken(store.undoTask("task-1"));
    expect(opacity(store)).toBeUndefined();
  });

  it("does not depend on what is left of old writes in the document", () => {
    const store = freshProject();
    for (let value = 1; value <= 20; value++) setOpacity(store, value / 100);
    for (let value = 19; value >= 1; value--) {
      taken(store.undo());
      expect(opacity(store)).toBe(value / 100);
    }
  });
});

describe("a step that cannot go back", () => {
  it("is all that happens: the one before it waits to be asked for", () => {
    const store = freshProject();
    moveTo(store, "d", "11");
    moveTo(store, "c", "1");
    moveTo(store, "c", "2", { origin: AI });
    blocked(store.undo());
    expect(clip(store, "c")?.start).toBe("2");
    expect(clip(store, "d")?.start).toBe("11");
    taken(store.undo());
    expect(clip(store, "c")?.start).toBe("2");
    expect(clip(store, "d")?.start).toBe("10");
  });

  it("says what stayed", () => {
    const store = freshProject();
    setOpacity(store, 0.2);
    setOpacity(store, 0.5, { origin: AI });
    expect(blocked(store.undo()).conflicts).toEqual([
      ["timelines", "main", "clips", "c", "properties", "opacity"],
    ]);
  });

  it("is gone from the list, and writes nothing", () => {
    const store = freshProject();
    setOpacity(store, 0.2);
    setOpacity(store, 0.5, { origin: AI });
    const { revision } = store;
    const before = store.getState();
    blocked(store.undo());
    expect(store.revision).toBe(revision);
    expect(store.getState()).toBe(before);
    expect(store.canRedo).toBe(false);
  });

  it("does not slide on the way forward either", () => {
    const store = freshProject();
    moveTo(store, "d", "11");
    moveTo(store, "c", "1");
    store.undo();
    store.undo();
    success(
      store.execute({ type: "project.rename", params: { name: "另一个名字" } }, { origin: AI }),
    );
    moveTo(store, "d", "12", { origin: AI });
    blocked(store.redo());
    expect(clip(store, "c")?.start).toBe("0");
    expect(clip(store, "d")?.start).toBe("12");
    taken(store.redo());
    expect(clip(store, "c")?.start).toBe("1");
  });

  it("does not slide for an AI task", () => {
    const store = freshProject();
    moveTo(store, "d", "11", { origin: AI });
    moveTo(store, "c", "1", { origin: AI });
    taken(store.undoTask("task-1"));
    moveTo(store, "c", "2");
    moveTo(store, "d", "12");
    blocked(store.redoTask("task-1"));
    expect(clip(store, "c")?.start).toBe("2");
    expect(clip(store, "d")?.start).toBe("12");
  });

  it("is about the whole change: what can go back of a change does", () => {
    const store = freshProject();
    const both = [
      { owner: { clip: "c" }, path: "opacity", op: "set", value: 0.5 },
      { owner: { clip: "d" }, path: "opacity", op: "set", value: 0.5 },
    ];
    success(store.execute({ type: "property.edit", params: { timeline: "main", edits: both } }));
    setOpacity(store, 0.7, { origin: AI }, "d");
    expect(taken(store.undo()).kept).toEqual([
      ["timelines", "main", "clips", "d", "properties", "opacity"],
    ]);
    expect(opacity(store, "c")).toBeUndefined();
    expect(opacity(store, "d")).toBe(0.7);
    taken(store.redo());
    expect(opacity(store, "c")).toBe(0.5);
  });

  it("keeps nothing when all of it went back", () => {
    const store = freshProject();
    setOpacity(store, 0.5);
    expect(taken(store.undo()).kept).toEqual([]);
  });

  it("names a path once, however often the change wrote there", () => {
    const store = freshProject();
    const twice = [0.5, 0.6].map((value) => ({
      type: "clip.setProperty",
      params: { timeline: "main", clip: "c", path: "opacity", value },
    }));
    success(store.executeBatch(twice));
    setOpacity(store, 0.7, { origin: AI });
    expect(blocked(store.undo()).conflicts).toHaveLength(1);
  });

  it("has nothing to say on a project without a history", () => {
    const store = freshProject();
    expect(twin(store).undo()).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "nothing-to-undo" }),
    });
    expect(twin(store).redo()).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "nothing-to-undo" }),
    });
    expect(store.undoTask("nobody").ok).toBe(false);
    expect(store.redoTask("nobody").ok).toBe(false);
  });

  it("says why: somebody else changed it", () => {
    const store = freshProject();
    setOpacity(store, 0.2);
    setOpacity(store, 0.5, { origin: AI });
    expect(blocked(store.undo()).obstacle).toBe("changed");
  });

  it("says nothing about why when all of it went back", () => {
    const store = freshProject();
    setOpacity(store, 0.2);
    expect(taken(store.undo())).not.toHaveProperty("obstacle");
  });

  it("says why for the part that stayed", () => {
    const store = freshProject();
    const both = [
      { owner: { clip: "c" }, path: "opacity", op: "set", value: 0.5 },
      { owner: { clip: "d" }, path: "opacity", op: "set", value: 0.5 },
    ];
    success(store.execute({ type: "property.edit", params: { timeline: "main", edits: both } }));
    setOpacity(store, 0.7, { origin: AI }, "d");
    expect(taken(store.undo()).obstacle).toBe("changed");
  });

  it("is told apart from a locked project, which keeps its history", () => {
    const store = freshProject();
    setOpacity(store, 0.5, { origin: AI });
    const lock = { tags: [{ name: "定稿", locked: true }] };
    success(store.execute({ type: "project.setTags", params: lock }));
    const code = (result: UndoResult) => (result.ok ? undefined : result.error.code);
    expect(code(store.undo())).toBe("project-locked");
    expect(code(store.redo())).toBe("project-locked");
    expect(code(store.undoTask("task-1"))).toBe("project-locked");
    expect(code(store.redoTask("task-1"))).toBe("project-locked");
    success(store.execute({ type: "project.setTags", params: { tags: [] } }));
    taken(store.undoTask("task-1"));
    expect(opacity(store)).toBeUndefined();
    taken(store.undo());
    expect(store.getState().manifest.tags).toEqual(lock.tags);
  });
});

describe("taking back what is on a locked track", () => {
  const trackOf = (store: ProjectStore, id = "c") => clip(store, id)?.track as string;
  const lockTrack = (
    store: ProjectStore,
    track: string | undefined,
    locked = true,
    options: ExecuteOptions = {},
  ) =>
    success(
      store.execute(
        { type: "track.update", params: { timeline: "main", track, changes: { locked } } },
        options,
      ),
    );
  const addTrack = (store: ProjectStore, id = "k") =>
    success(store.execute({ type: "track.add", params: { timeline: "main", kind: "video", id } }));
  const moveToTrack = (store: ProjectStore, track: string, options: ExecuteOptions = {}) =>
    success(
      store.execute(
        { type: "clip.move", params: { timeline: "main", clips: [{ clip: "c", track }] } },
        options,
      ),
    );

  it("does not change it for an AI task", () => {
    const store = freshProject();
    moveTo(store, "c", "1", { origin: AI });
    lockTrack(store, trackOf(store));
    expect(blocked(store.undoTask("task-1")).obstacle).toBe("locked");
    expect(clip(store, "c")?.start).toBe("1");
  });

  it("does not change it for the person either, when the lock came from elsewhere", () => {
    const store = freshProject();
    setOpacity(store, 0.5);
    lockTrack(store, trackOf(store), true, { origin: AI });
    expect(blocked(store.undo()).obstacle).toBe("locked");
    expect(opacity(store)).toBe(0.5);
  });

  it("does not change it on the way forward", () => {
    const store = freshProject();
    moveTo(store, "c", "1");
    store.undo();
    lockTrack(store, trackOf(store), true, { origin: AI });
    expect(blocked(store.redo()).obstacle).toBe("locked");
    expect(clip(store, "c")?.start).toBe("0");
  });

  it("does not take a clip away from it", () => {
    const store = freshProject();
    const added = {
      id: "e",
      start: "8",
      duration: "1",
      source: { kind: "color", color: "#000000" },
    };
    const params = { timeline: "main", track: trackOf(store), clip: added };
    success(store.execute({ type: "clip.add", params }));
    lockTrack(store, trackOf(store), true, { origin: AI });
    blocked(store.undo());
    expect(clip(store, "e")).toBeDefined();
  });

  it("does not bring back a clip on it", () => {
    const store = freshProject();
    success(store.execute({ type: "clip.remove", params: { timeline: "main", clips: ["d"] } }));
    lockTrack(store, trackOf(store), true, { origin: AI });
    expect(blocked(store.undo()).obstacle).toBe("locked");
    expect(clip(store, "d")).toBeUndefined();
  });

  it("does not move a clip back onto it", () => {
    const store = freshProject();
    const home = trackOf(store);
    addTrack(store);
    moveToTrack(store, "k");
    lockTrack(store, home, true, { origin: AI });
    expect(blocked(store.undo()).obstacle).toBe("locked");
    expect(trackOf(store)).toBe("k");
  });

  it("does not take a clip off it", () => {
    const store = freshProject();
    addTrack(store);
    moveToTrack(store, "k");
    lockTrack(store, "k", true, { origin: AI });
    blocked(store.undo());
    expect(trackOf(store)).toBe("k");
  });

  it("does not take the track itself away", () => {
    const store = freshProject();
    addTrack(store);
    lockTrack(store, "k", true, { origin: AI });
    expect(blocked(store.undo()).obstacle).toBe("locked");
    expect(timeline(store).tracks["k"]).toBeDefined();
  });

  it("does not change a transition on it", () => {
    const store = open();
    const track = clip(store)?.track;
    success(
      store.execute({ type: "clip.remove", params: { timeline: "main", clips: ["clip_title"] } }),
    );
    lockTrack(store, track, true, { origin: AI });
    blocked(store.undo());
    expect(clip(store)).toBeUndefined();
    expect(timeline(store).transitions["tr_1"]?.from).toBeUndefined();
  });

  it("does not change what a version changes about a clip on it", () => {
    const store = open();
    const file = "timelines/main/overrides/language.en.json";
    const document = JSON.parse(store.exportFiles().files.get(file) as string);
    document.clips["clip_title"] = { hidden: { value: true } };
    success(store.importFile(file, JSON.stringify(document)));
    lockTrack(store, clip(store)?.track, true, { origin: AI });
    blocked(store.undo());
    expect(timeline(store).overrides["language.en"]?.clips?.["clip_title"]).toBeDefined();
  });

  it("takes back the rest of the change", () => {
    const store = freshProject();
    const other = (addTrack(store), "k");
    const added = {
      id: "e",
      start: "0",
      duration: "1",
      source: { kind: "color", color: "#000000" },
    };
    success(
      store.execute({ type: "clip.add", params: { timeline: "main", track: other, clip: added } }),
    );
    const both = [
      { owner: { clip: "c" }, path: "opacity", op: "set", value: 0.5 },
      { owner: { clip: "e" }, path: "opacity", op: "set", value: 0.5 },
    ];
    success(store.execute({ type: "property.edit", params: { timeline: "main", edits: both } }));
    lockTrack(store, trackOf(store), true, { origin: AI });
    const result = taken(store.undo());
    expect(result.obstacle).toBe("locked");
    expect(opacity(store)).toBe(0.5);
    expect(opacity(store, "e")).toBeUndefined();
  });

  it("takes back what a file wrote there, which goes back to what the lock is for", () => {
    const store = freshProject();
    const track = trackOf(store);
    lockTrack(store, track);
    const before = store.getState();
    const document = JSON.parse(store.exportFiles().files.get(MAIN) as string);
    for (const each of document.tracks) {
      for (const item of each.clips) if (item.id === "c") item.properties = { opacity: 0.5 };
    }
    success(store.importFile(MAIN, JSON.stringify(document)));
    expect(opacity(store)).toBe(0.5);
    expect(taken(store.undo()).kept).toEqual([]);
    expect(store.getState()).toEqual(before);
    expect(taken(store.redo()).kept).toEqual([]);
    expect(opacity(store)).toBe(0.5);
    expect(taken(store.undo()).kept).toEqual([]);
    expect(opacity(store)).toBeUndefined();
  });

  it("does not take a file for permission once the lock came after it", () => {
    const store = freshProject();
    const document = JSON.parse(store.exportFiles().files.get(MAIN) as string);
    for (const each of document.tracks) {
      for (const item of each.clips) if (item.id === "c") item.properties = { opacity: 0.5 };
    }
    success(store.importFile(MAIN, JSON.stringify(document)));
    lockTrack(store, trackOf(store), true, { origin: AI });
    blocked(store.undo());
    expect(opacity(store)).toBe(0.5);
  });

  it("leaves the track itself open: a lock can always be taken back", () => {
    const store = freshProject();
    moveTo(store, "c", "1");
    lockTrack(store, trackOf(store));
    taken(store.undo());
    expect(timeline(store).tracks[trackOf(store)]?.locked).toBeUndefined();
    taken(store.undo());
    expect(clip(store, "c")?.start).toBe("0");
  });

  it("can go on after the lock is gone", () => {
    const store = freshProject();
    moveTo(store, "c", "1", { origin: AI });
    lockTrack(store, trackOf(store));
    lockTrack(store, trackOf(store), false);
    taken(store.undoTask("task-1"));
    expect(clip(store, "c")?.start).toBe("0");
  });

  it("does not mind other tracks", () => {
    const store = freshProject();
    addTrack(store);
    moveTo(store, "c", "1");
    lockTrack(store, "k", true, { origin: AI });
    taken(store.undo());
    expect(clip(store, "c")?.start).toBe("0");
  });

  it("goes by the moment of each step: a change that locks after moving goes back whole", () => {
    const store = freshProject();
    const track = trackOf(store);
    success(
      store.executeBatch([
        { type: "clip.move", params: { timeline: "main", clips: [{ clip: "c", start: "1" }] } },
        { type: "track.update", params: { timeline: "main", track, changes: { locked: true } } },
      ]),
    );
    expect(taken(store.undo()).kept).toEqual([]);
    expect(clip(store, "c")?.start).toBe("0");
    expect(timeline(store).tracks[track]?.locked).toBeUndefined();
  });

  it("goes by the moment of each step: a change that unlocks first goes back whole", () => {
    const store = freshProject();
    const track = trackOf(store);
    lockTrack(store, track);
    success(
      store.executeBatch([
        { type: "track.update", params: { timeline: "main", track, changes: { locked: false } } },
        { type: "clip.move", params: { timeline: "main", clips: [{ clip: "c", start: "1" }] } },
      ]),
    );
    expect(taken(store.undo()).kept).toEqual([]);
    expect(clip(store, "c")?.start).toBe("0");
    expect(timeline(store).tracks[track]?.locked).toBe(true);
  });
});

describe("an asset that only a version uses", () => {
  const file = "timelines/main/overrides/language.en.json";

  it("cannot be removed, like one a clip uses", () => {
    const store = open();
    const error = failure(
      store.execute({ type: "asset.remove", params: { asset: "narration-en" } }),
    );
    expect(error.code).toBe("asset-in-use");
    expect(error.message).toContain("版本");
    expect(store.getState().assets?.["narration-en"]).toBeDefined();
    expect(
      Object.values(timeline(store).clips).map(({ source }) => JSON.stringify(source)),
    ).not.toContainEqual(expect.stringContaining("narration-en"));
  });

  it("can go once the version does not use it", () => {
    const store = open();
    const document = JSON.parse(store.exportFiles().files.get(file) as string);
    for (const changes of Object.values<{ source?: object }>(document.clips)) delete changes.source;
    success(store.importFile(file, JSON.stringify(document)));
    success(store.execute({ type: "asset.remove", params: { asset: "narration-en" } }));
    expect(store.getState().assets?.["narration-en"]).toBeUndefined();
  });
});

describe("a level taken back one entry at a time", () => {
  const withoutProperties = (store: ProjectStore) => {
    const file = JSON.parse(store.exportFiles().files.get(MAIN) as string);
    for (const track of file.tracks) for (const item of track.clips) delete item.properties;
    return JSON.stringify(file);
  };
  const withProperties = (store: ProjectStore, properties: object) => {
    const file = JSON.parse(store.exportFiles().files.get(MAIN) as string);
    for (const track of file.tracks) {
      for (const item of track.clips) if (item.id === "c") item.properties = properties;
    }
    return JSON.stringify(file);
  };

  it("brings back what a file took away, next to what somebody added since", () => {
    const store = freshProject();
    setOpacity(store, 0.5);
    success(edit(store, "c", { path: "transform.x", op: "set", value: 3 }));
    success(store.importFile(MAIN, withoutProperties(store)));
    expect(clip(store, "c")).not.toHaveProperty("properties");
    success(edit(store, "c", { path: "transform.y", op: "set", value: 7 }, { origin: AI }));
    expect(taken(store.undo()).kept).toEqual([]);
    expect(clip(store, "c")?.properties).toEqual({
      opacity: 0.5,
      "transform.x": 3,
      "transform.y": 7,
    });
  });

  it("takes away what a file added, except what somebody changed since", () => {
    const store = freshProject();
    success(store.importFile(MAIN, withProperties(store, { opacity: 0.5, "transform.x": 1 })));
    success(edit(store, "c", { path: "transform.x", op: "set", value: 2 }, { origin: AI }));
    success(edit(store, "c", { path: "transform.y", op: "set", value: 7 }, { origin: AI }));
    taken(store.undo());
    expect(clip(store, "c")?.properties).toEqual({ "transform.x": 2, "transform.y": 7 });
  });

  it("does the same for assets", () => {
    const store = freshProject();
    const asset = (id: string) => ({ kind: "image", path: `assets/${id}.png`, storage: "local" });
    const assets = { one: asset("one"), two: asset("two") };
    success(store.importFile("assets.json", JSON.stringify({ assets })));
    const changed = { ...asset("two"), hash: "sha256-b" };
    const next = JSON.stringify({ assets: { ...assets, two: changed } });
    success(store.importFile("assets.json", next, { origin: AI }));
    taken(store.undo());
    expect(store.getState().assets).toEqual({ two: changed });
  });

  it("does the same for notes", () => {
    const store = freshProject();
    const note = (id: string, text: string) => ({
      id,
      status: "pending",
      text,
      timeline: "main",
      time: "1",
      createdAt: "2026-11-06T00:00:00Z",
    });
    const write = (notes: object[], options?: ExecuteOptions) =>
      success(store.importFile("notes.json", JSON.stringify({ notes }), options));
    write([note("a", "一"), note("b", "二")]);
    write([note("a", "一"), note("b", "别人改的")], { origin: AI });
    taken(store.undo());
    expect(Object.keys(store.getState().notes ?? {})).toEqual(["b"]);
  });

  it("merges with what another window does to the same level", () => {
    const a = freshProject();
    const b = twin(a);
    success(a.importFile(MAIN, withProperties(a, { opacity: 0.5 })));
    success(edit(b, "c", { path: "transform.x", op: "set", value: 2 }));
    sync(a, b);
    taken(a.undo());
    sync(a, b);
    expect(clip(b, "c")?.properties).toEqual({ "transform.x": 2 });
  });
});

describe("taking back what something else came to depend on", () => {
  const image = { kind: "image", path: "assets/p.png", storage: "local" };
  const addAsset = (store: ProjectStore, options: ExecuteOptions = {}) =>
    success(store.execute({ type: "asset.add", params: { id: "pic", asset: image } }, options));
  const videoTrack = (store: ProjectStore) =>
    Object.values(timeline(store).tracks).find(({ kind }) => kind === "video")?.id as string;
  const addClip = (
    store: ProjectStore,
    id: string,
    source: object,
    options: ExecuteOptions = {},
    track = videoTrack(store),
  ) =>
    success(
      store.execute(
        {
          type: "clip.add",
          params: {
            timeline: "main",
            track,
            clip: { id, start: "8", duration: "1", source },
          },
        },
        options,
      ),
    );
  const picture = { kind: "image", media: { asset: "pic" } };
  const rewrite = <T>(
    store: ProjectStore,
    file: string,
    change: (document: T) => void,
    options: ExecuteOptions = {},
  ) => {
    const document = JSON.parse(store.exportFiles().files.get(file) as string) as T;
    change(document);
    return success(store.importFile(file, JSON.stringify(document), options));
  };

  it("keeps an asset a person started to use", () => {
    const store = freshProject();
    addAsset(store, { origin: AI });
    addClip(store, "e", picture);
    expect(blocked(store.undoTask("task-1")).obstacle).toBe("inUse");
    expect(store.getState().assets?.["pic"]).toBeDefined();
    expect(store.exportFiles().problems).toEqual([]);
  });

  it("keeps an asset an AI task started to use", () => {
    const store = freshProject();
    addAsset(store);
    addClip(store, "e", picture, { origin: AI });
    blocked(store.undo());
    expect(store.getState().assets?.["pic"]).toBeDefined();
  });

  it("lets go of the asset once nothing uses it", () => {
    const store = freshProject();
    addAsset(store, { origin: AI });
    addClip(store, "e", picture);
    taken(store.undo());
    taken(store.undoTask("task-1"));
    expect(store.getState().assets).toBeUndefined();
  });

  it("takes back an asset together with what used it", () => {
    const store = freshProject();
    addAsset(store, { origin: AI });
    addClip(store, "e", picture, { origin: AI });
    taken(store.undoTask("task-1"));
    expect(store.getState().assets).toBeUndefined();
    expect(clip(store, "e")).toBeUndefined();
    taken(store.redoTask("task-1"));
    expect(clip(store, "e")?.source).toEqual(picture);
    expect(store.getState().assets?.["pic"]).toEqual(image);
  });

  it("keeps a track with clips on it", () => {
    const store = freshProject();
    const { results } = success(
      store.execute(
        { type: "track.add", params: { timeline: "main", kind: "video" } },
        { origin: AI },
      ),
    );
    const { id } = results[0] as { id: string };
    addClip(store, "e", { kind: "color", color: "#000000" }, {}, id);
    blocked(store.undoTask("task-1"));
    expect(timeline(store).tracks[id]).toBeDefined();
    expect(store.exportFiles().problems).toEqual([]);
  });

  it("takes back a track together with its clips, whichever comes first", () => {
    const store = freshProject();
    const color = { kind: "color", color: "#000000" };
    success(
      store.executeBatch([
        { type: "track.add", params: { timeline: "main", kind: "video", id: "k" } },
        {
          type: "clip.add",
          params: {
            timeline: "main",
            track: "k",
            clip: { id: "e", start: "0", duration: "1", source: color },
          },
        },
      ]),
    );
    expect(taken(store.undo()).kept).toEqual([]);
    expect(timeline(store).tracks["k"]).toBeUndefined();
    expect(taken(store.redo()).kept).toEqual([]);
    expect(clip(store, "e")?.track).toBe("k");
  });

  it("brings back a track with its clips and transitions, in any order", () => {
    const store = open();
    const before = store.getState();
    const track = clip(store)?.track;
    success(store.execute({ type: "track.remove", params: { timeline: "main", track } }));
    expect(taken(store.undo()).kept).toEqual([]);
    expect(store.getState()).toEqual(before);
    expect(taken(store.redo()).kept).toEqual([]);
    expect(timeline(store).transitions["tr_1"]).toBeUndefined();
  });

  it("does not bring back a clip on a track that is gone", () => {
    const store = freshProject();
    const { results } = success(
      store.execute({ type: "track.add", params: { timeline: "main", kind: "video" } }),
    );
    const { id } = results[0] as { id: string };
    addClip(store, "e", { kind: "color", color: "#000000" }, {}, id);
    store.undo();
    success(
      store.execute(
        { type: "track.remove", params: { timeline: "main", track: id } },
        { origin: AI },
      ),
    );
    blocked(store.redo());
    expect(clip(store, "e")).toBeUndefined();
  });

  it("does not bring back a clip whose asset is gone", () => {
    const store = freshProject();
    addAsset(store, { origin: AI });
    addClip(store, "e", picture);
    store.undo();
    success(store.execute({ type: "asset.remove", params: { asset: "pic" } }, { origin: AI }));
    blocked(store.redo());
    expect(clip(store, "e")).toBeUndefined();
  });

  it("does not bring back a removed clip whose asset is gone", () => {
    const store = freshProject();
    addAsset(store);
    addClip(store, "e", picture);
    success(store.execute({ type: "clip.remove", params: { timeline: "main", clips: ["e"] } }));
    success(store.execute({ type: "asset.remove", params: { asset: "pic" } }, { origin: AI }));
    blocked(store.undo());
    expect(clip(store, "e")).toBeUndefined();
    expect(store.exportFiles().problems).toEqual([]);
  });

  it("does not move a clip back to a track that is gone", () => {
    const store = freshProject();
    const { results } = success(
      store.execute({ type: "track.add", params: { timeline: "main", kind: "video" } }),
    );
    const { id } = results[0] as { id: string };
    const home = videoTrack(store);
    addClip(store, "e", { kind: "color", color: "#000000" }, {}, id);
    success(
      store.execute({
        type: "clip.move",
        params: { timeline: "main", clips: [{ clip: "e", track: home }] },
      }),
    );
    success(
      store.execute(
        { type: "track.remove", params: { timeline: "main", track: id } },
        { origin: AI },
      ),
    );
    blocked(store.undo());
    expect(clip(store, "e")?.track).toBe(home);
  });

  it("does not change a source back to what is gone", () => {
    const store = freshProject();
    addAsset(store);
    addClip(store, "e", picture);
    const color = { kind: "color", color: "#000000" };
    success(
      store.execute({
        type: "clip.update",
        params: { timeline: "main", clip: "e", changes: { source: color } },
      }),
    );
    success(store.execute({ type: "asset.remove", params: { asset: "pic" } }, { origin: AI }));
    blocked(store.undo());
    expect(clip(store, "e")?.source).toEqual(color);
  });

  it("does not put a clip on a track of the wrong kind, which would cost the whole timeline", () => {
    const store = freshProject();
    const audio = Object.values(timeline(store).tracks).find(({ kind }) => kind === "audio")?.id;
    const nested = { kind: "timeline", timeline: "main" };
    addClip(store, "e", { kind: "color", color: "#000000" });
    success(
      store.execute({
        type: "clip.update",
        params: { timeline: "main", clip: "e", changes: { source: nested } },
      }),
    );
    success(
      store.execute(
        {
          type: "clip.move",
          params: { timeline: "main", clips: [{ clip: "e", track: audio }] },
        },
        { origin: AI },
      ),
    );
    blocked(store.undo());
    expect(clip(store, "e")?.source).toEqual(nested);
    expect(store.exportFiles().problems).toEqual([]);
  });

  it("keeps a clip a transition goes from", () => {
    const store = freshProject();
    addClip(store, "e", { kind: "color", color: "#000000" });
    const home = clip(store, "e")?.track;
    rewrite(
      store,
      MAIN,
      (file: { tracks: { id: string; transitions?: object[] }[] }) => {
        const track = file.tracks.find(({ id }) => id === home);
        if (track) track.transitions = [{ id: "t", type: "dissolve", from: "e", duration: "1" }];
      },
      { origin: AI },
    );
    blocked(store.undo());
    expect(clip(store, "e")).toBeDefined();
    expect(store.exportFiles().problems).toEqual([]);
  });

  it("keeps a track when what is on it has to stay", () => {
    const store = freshProject();
    const home = clip(store, "c")?.track;
    success(
      store.execute(
        { type: "track.add", params: { timeline: "main", kind: "video", id: "k" } },
        { origin: AI },
      ),
    );
    addClip(store, "e", { kind: "color", color: "#000000" }, { origin: AI }, "k");
    rewrite(store, MAIN, (file: { tracks: { id: string; transitions?: object[] }[] }) => {
      const track = file.tracks.find(({ id }) => id === home);
      if (track) track.transitions = [{ id: "t", type: "dissolve", from: "e", duration: "1" }];
    });
    blocked(store.undoTask("task-1"));
    expect(clip(store, "e")?.track).toBe("k");
    expect(timeline(store).tracks["k"]).toBeDefined();
    expect(store.exportFiles().problems).toEqual([]);
  });

  it("keeps the last section, without which no timeline can be saved", () => {
    const store = freshProject();
    const [first] = Object.keys(timeline(store).sections);
    success(
      store.execute({ type: "section.add", params: { timeline: "main", id: "s", duration: "2" } }),
    );
    success(
      store.execute(
        { type: "section.remove", params: { timeline: "main", section: first } },
        { origin: AI },
      ),
    );
    blocked(store.undo());
    expect(Object.keys(timeline(store).sections)).toEqual(["s"]);
    expect(store.exportFiles().files.has(MAIN)).toBe(true);
  });

  it("keeps a scene a clip uses", () => {
    const store = freshProject();
    const scene = { name: "场景", entry: "index.html", runtime: 1 };
    success(store.importFile("scenes/s/scene.json", JSON.stringify(scene), { origin: AI }));
    addClip(store, "e", { kind: "scene", scene: "s" });
    blocked(store.undoTask("task-1"));
    expect(store.getState().scenes["s"]).toBeDefined();
  });

  it("keeps a sound a clip uses", () => {
    const store = freshProject();
    const audio = Object.values(timeline(store).tracks).find(({ kind }) => kind === "audio")?.id;
    const sound = { name: "声音", entry: "main.js", runtime: 1 };
    success(store.importFile("sounds/s/sound.json", JSON.stringify(sound), { origin: AI }));
    addClip(store, "e", { kind: "sound", sound: "s" }, {}, audio);
    blocked(store.undoTask("task-1"));
    expect(store.getState().sounds["s"]).toBeDefined();
  });

  it("keeps an asset that a version shows instead of something else", () => {
    const store = open();
    const file = "timelines/main/overrides/language.en.json";
    addAsset(store, { origin: AI });
    rewrite(store, file, ({ clips }: { clips: Record<string, { source?: object }> }) => {
      for (const changes of Object.values(clips)) {
        if (changes.source) changes.source = { value: { kind: "audio", media: { asset: "pic" } } };
      }
    });
    blocked(store.undoTask("task-1"));
    expect(store.getState().assets?.["pic"]).toBeDefined();
  });

  describe("that was already broken", () => {
    const without = (id: string) => (document: { assets: Record<string, unknown> }) => {
      delete document.assets[id];
    };

    it("does not stop what has nothing to do with it", () => {
      const store = freshProject();
      addAsset(store);
      addClip(store, "e", picture);
      const { results } = success(
        store.execute({ type: "track.add", params: { timeline: "main", kind: "video" } }),
      );
      const { id } = results[0] as { id: string };
      const home = clip(store, "e")?.track;
      success(
        store.execute(
          { type: "clip.move", params: { timeline: "main", clips: [{ clip: "e", track: id }] } },
          { origin: AI },
        ),
      );
      rewrite(store, "assets.json", without("pic"));
      taken(store.undoTask("task-1"));
      expect(clip(store, "e")?.track).toBe(home);
    });

    it("goes back and forth as often as people like", () => {
      const store = open();
      const before = store.getState();
      rewrite(store, "assets.json", without("studio-loop"));
      const after = store.getState();
      taken(store.undo());
      expect(store.getState()).toEqual(before);
      taken(store.redo());
      expect(store.getState()).toEqual(after);
      taken(store.undo());
      expect(store.getState()).toEqual(before);
    });

    it("can go back to how it was after somebody repaired it", () => {
      const store = open();
      const { assets } = store.getState();
      rewrite(store, "assets.json", without("studio-loop"));
      const broken = store.getState();
      const asset = assets?.["studio-loop"];
      success(store.execute({ type: "asset.add", params: { id: "studio-loop", asset } }));
      expect(store.getState()).not.toEqual(broken);
      taken(store.undo());
      expect(store.getState()).toEqual(broken);
    });

    it("does not take in new things that would break", () => {
      const store = freshProject();
      addAsset(store, { origin: AI });
      addClip(store, "e", picture, { origin: AI });
      rewrite(store, "assets.json", without("pic"));
      taken(store.undo());
      const later = { ...picture };
      success(
        store.execute(
          {
            type: "clip.add",
            params: {
              timeline: "main",
              track: videoTrack(store),
              clip: { id: "f", start: "9", duration: "1", source: later },
            },
          },
          { origin: aiTask("another") },
        ),
      );
      blocked(store.redo());
      expect(store.getState().assets?.["pic"]).toBeDefined();
    });
  });
});

describe("while an update is missing", () => {
  /** A window that got the second of two updates: the field is gone, the new value is waiting. */
  function torn() {
    const a = freshProject();
    const doc = new Y.Doc();
    doc.clientID = a.doc.clientID + 1;
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(a.doc), "sync");
    const b = new ProjectStore(doc);
    const updates: Uint8Array[] = [];
    a.onLocalUpdate((update) => updates.push(update));
    success(
      a.execute({
        type: "clip.update",
        params: { timeline: "main", clip: "d", changes: { name: "新名字" } },
      }),
    );
    moveTo(a, "c", "2");
    b.applyUpdates([updates[1] as Uint8Array]);
    return { a, b, updates };
  }

  const code = (result: CommandResult | UndoResult) => (result.ok ? undefined : result.error.code);

  it("has a document with a hole in it, which is why this matters", () => {
    const { b } = torn();
    expect(b.isMissingUpdates).toBe(true);
    const reading = new ProjectStore(b.doc);
    expect(clip(reading, "c")?.start).toBeUndefined();
    reading.destroy();
  });

  it("shows the last whole project, which can still be drawn and saved", () => {
    const { b } = torn();
    expect(clip(b, "c")?.start).toBe("0");
    expect(buildRenderPlan(b.getState(), "main")).toBeDefined();
    expect(b.exportFiles().problems).toEqual([]);
  });

  it("holds back everything that arrives in the meantime", () => {
    const a = freshProject();
    const b = twin(a);
    const c = twin(a);
    const fromA: Uint8Array[] = [];
    a.onLocalUpdate((update) => fromA.push(update));
    moveTo(a, "c", "1");
    moveTo(a, "c", "2");
    const fromC: Uint8Array[] = [];
    c.onLocalUpdate((update) => fromC.push(update));
    success(c.execute({ type: "project.rename", params: { name: "第三个窗口" } }));
    const seen = vi.fn<() => void>();
    b.subscribe(seen);
    const before = b.getState();
    b.applyUpdates([fromA[1] as Uint8Array]);
    b.applyUpdates(fromC);
    expect(b.getState()).toBe(before);
    expect(seen).not.toHaveBeenCalled();
    b.applyUpdates([fromA[0] as Uint8Array]);
    expect(seen).toHaveBeenCalledOnce();
    expect(clip(b, "c")?.start).toBe("2");
    expect(b.getState().manifest.name).toBe("第三个窗口");
  });

  it("shows what it held back also when the last piece changes nothing", () => {
    const a = freshProject();
    const b = twin(a);
    const updates: Uint8Array[] = [];
    a.onLocalUpdate((update) => updates.push(update));
    moveTo(a, "c", "1");
    success(a.execute({ type: "clip.remove", params: { timeline: "main", clips: ["c"] } }));
    b.applyUpdates([updates.at(-1) as Uint8Array]);
    expect(b.isMissingUpdates).toBe(true);
    expect(clip(b, "c")).toBeDefined();
    const seen = vi.fn<() => void>();
    b.subscribe(seen);
    b.applyUpdates([Y.encodeStateAsUpdate(a.doc, Y.encodeStateVector(b.doc))]);
    expect(b.isMissingUpdates).toBe(false);
    expect(clip(b, "c")).toBeUndefined();
    expect(seen).toHaveBeenCalledOnce();
  });

  it("does not hold back what needs nothing", () => {
    const a = freshProject();
    const b = twin(a);
    const updates: Uint8Array[] = [];
    a.onLocalUpdate((update) => updates.push(update));
    moveTo(a, "c", "1");
    const seen = vi.fn<() => void>();
    b.subscribe(seen);
    b.applyUpdates(updates);
    expect(seen).toHaveBeenCalledOnce();
    expect(clip(b, "c")?.start).toBe("1");
  });

  it("shows what there is once nothing more is coming, holes and all", () => {
    const { b } = torn();
    const seen = vi.fn<() => void>();
    b.subscribe(seen);
    b.catchUp([]);
    expect(seen).toHaveBeenCalledOnce();
    expect(clip(b, "c")?.start).toBeUndefined();
  });

  it("goes on from what it held back, keeping what did not change", () => {
    const { b, updates } = torn();
    const before = b.getState();
    b.applyUpdates(updates);
    expect(clip(b, "c")?.start).toBe("2");
    expect(b.getState().timelines["main"]?.tracks).toBe(before.timelines["main"]?.tracks);
    expect(new ProjectStore(b.doc).getState()).toEqual(b.getState());
  });

  it("takes no commands, and says why", () => {
    const { b } = torn();
    const { revision } = b;
    const result = b.execute({
      type: "clip.move",
      params: { timeline: "main", clips: [{ clip: "c", start: "30" }] },
    });
    expect(code(result)).toBe("missing-updates");
    expect(failure(result).message).toContain("刷新");
    expect(b.revision).toBe(revision);
    expect(b.canUndo).toBe(false);
  });

  it("takes no batches, files or trial runs", () => {
    const { b } = torn();
    const rename = { type: "project.rename", params: { name: "不会改" } };
    expect(code(b.executeBatch([rename]))).toBe("missing-updates");
    expect(code(b.execute(rename, { dryRun: true }))).toBe("missing-updates");
    expect(code(b.importFile("code/a.js", "x"))).toBe("missing-updates");
    expect(b.getState().manifest.name).toBe("并发");
  });

  it("does not touch what is on the lists, and goes on with them afterwards", () => {
    const { a, b, updates } = torn();
    void a;
    const other = freshProject();
    void other;
    b.applyUpdates(updates);
    setOpacity(b, 0.5);
    setOpacity(b, 0.7);
    b.undo();
    setOpacity(b, 0.6, { origin: AI });
    const next: Uint8Array[] = [];
    a.onLocalUpdate((update) => next.push(update));
    success(a.execute({ type: "project.rename", params: { name: "一" } }));
    success(a.execute({ type: "project.rename", params: { name: "二" } }));
    b.applyUpdates([next[1] as Uint8Array]);
    expect(code(b.undo())).toBe("missing-updates");
    expect(code(b.redo())).toBe("missing-updates");
    expect(code(b.undoTask("task-1"))).toBe("missing-updates");
    expect(code(b.redoTask("task-1"))).toBe("missing-updates");
    b.applyUpdates(next);
    taken(b.undoTask("task-1"));
    expect(opacity(b)).toBe(0.5);
    taken(b.undo());
    expect(opacity(b)).toBeUndefined();
  });

  it("leaves no lasting damage once the update arrives", () => {
    const { a, b, updates } = torn();
    moveTo(a, "d", "11");
    const refused = b.execute({
      type: "clip.move",
      params: { timeline: "main", clips: [{ clip: "c", start: "30" }] },
    });
    expect(refused.ok).toBe(false);
    b.applyUpdates(updates);
    expect(b.isMissingUpdates).toBe(false);
    expect(clip(b, "c")?.start).toBe("2");
    expect(code(b.undo())).toBe("nothing-to-undo");
    sync(a, b);
    expect(clip(a, "c")?.start).toBe("2");
    expect(a.exportFiles().files.has(MAIN)).toBe(true);
    expect(buildRenderPlan(b.getState(), "main")).toBeDefined();
    moveTo(b, "d", "40");
    const { store: reopened } = ProjectStore.fromUpdates([a.mergeWith([b.encodeState()])]);
    expect(clip(reopened as ProjectStore, "c")?.start).toBe("2");
  });

  it("takes changes again after everything there is was read, with or without the update", () => {
    const { b, updates } = torn();
    b.catchUp([]);
    expect(b.isMissingUpdates).toBe(true);
    success(b.execute({ type: "project.rename", params: { name: "还能用" } }));
    expect(b.getState().manifest.name).toBe("还能用");
    b.catchUp(updates);
    expect(b.isMissingUpdates).toBe(false);
  });

  it("waits again when more arrives after that", () => {
    const { b } = torn();
    b.catchUp([]);
    b.applyUpdates([new Uint8Array([0, 0])]);
    expect(code(b.execute({ type: "project.rename", params: { name: "不会改" } }))).toBe(
      "missing-updates",
    );
  });

  it("is no reason to wait when nothing arrived", () => {
    const { b } = torn();
    b.catchUp([]);
    b.applyUpdates([]);
    success(b.execute({ type: "project.rename", params: { name: "还能用" } }));
  });

  it("does not lock people out of a project with a damaged log", () => {
    const { a, updates } = torn();
    const { store, damaged } = ProjectStore.fromUpdates([
      freshProject().encodeState(),
      updates[1] as Uint8Array,
    ]);
    expect(damaged).toBe(0);
    void a;
    expect(store?.isMissingUpdates).toBe(true);
    success(
      (store as ProjectStore).execute({ type: "project.rename", params: { name: "还能用" } }),
    );
  });

  it("does not take a log for lost when shortening it", () => {
    const { b, updates } = torn();
    b.mergeWith([]);
    expect(b.isMissingUpdates).toBe(true);
    success(b.execute({ type: "project.rename", params: { name: "还能用" } }));
    b.mergeWith(updates);
    expect(b.isMissingUpdates).toBe(false);
  });

  it("notices a missing delete as well", () => {
    const a = freshProject();
    const b = twin(a);
    const updates: Uint8Array[] = [];
    a.onLocalUpdate((update) => updates.push(update));
    success(
      a.execute({
        type: "marker.add",
        params: { timeline: "main", marker: { id: "m", time: "1" } },
      }),
    );
    success(a.execute({ type: "marker.remove", params: { timeline: "main", marker: "m" } }));
    b.applyUpdates([updates[1] as Uint8Array]);
    expect(b.isMissingUpdates).toBe(true);
    expect(code(b.execute({ type: "project.rename", params: { name: "不会改" } }))).toBe(
      "missing-updates",
    );
    b.applyUpdates([updates[0] as Uint8Array]);
    success(b.execute({ type: "project.rename", params: { name: "改了" } }));
  });
});

describe("a version file for a timeline that is not there", () => {
  const file = "timelines/nope/overrides/language.en.json";
  const text = JSON.stringify({ scope: { language: "en" } });

  it("is refused, and says why", () => {
    const store = open();
    const before = store.getState();
    const error = failure(store.importFile(file, text));
    expect(error.code).toBe("invalid-file");
    expect(error.problems).toEqual([
      expect.objectContaining({ severity: "error", code: "timeline-missing", file }),
    ]);
    expect(store.getState()).toBe(before);
    expect(store.exportFiles().problems).toEqual([]);
  });

  it("does not get far enough to look at what is in it", () => {
    const store = open();
    const error = failure(store.importFile(file, "not json"));
    expect(error.problems).toHaveLength(1);
    expect(error.problems?.[0]?.code).not.toBe("timeline-missing");
  });

  it("is fine for a timeline that is there", () => {
    const store = open();
    success(
      store.importFile(
        "timelines/main/overrides/language.fr.json",
        JSON.stringify({ scope: { language: "fr" } }),
      ),
    );
    expect(timeline(store).overrides["language.fr"]).toEqual({ scope: { language: "fr" } });
  });

  it("does not take a name every object has for a timeline", () => {
    const store = open();
    const error = failure(store.importFile("timelines/constructor/overrides/a.json", text));
    expect(error.problems?.[0]?.code).toBe("timeline-missing");
  });
});

describe("a real document from when assets, notes and properties had maps of their own", () => {
  /**
   * Saved by the code of that time, not made with today's code: this is what people have. The
   * example project plus real work on it: more properties in maps that were there, a first map, a
   * map that was emptied again, an asset that came and one that went, a note, a track with
   * properties, and versions with maps inside of maps. Never change these two files.
   */
  const folder = new URL("../fixtures/before-flat-levels/", import.meta.url);
  const update = () =>
    Uint8Array.from(Buffer.from(readFileSync(new URL("document.txt", folder), "utf8"), "base64"));
  const saved = () => {
    const { store, damaged } = ProjectStore.fromUpdates([update()]);
    if (!store || damaged > 0) throw new Error("the sample did not open");
    return store;
  };
  const SEEN_BACK_THEN = JSON.parse(readFileSync(new URL("state.json", folder), "utf8"));
  const reopened = (store: ProjectStore) =>
    ProjectStore.fromUpdates([store.encodeState()]).store as ProjectStore;
  const rewrite = (store: ProjectStore, path: string, change: (document: never) => void) => {
    const document = JSON.parse(store.exportFiles().files.get(path) as string);
    change(document as never);
    return success(store.importFile(path, JSON.stringify(document)));
  };
  const VERSION = "timelines/main/overrides/language.en.json";
  const voiceTrack = (store: ProjectStore) =>
    timeline(store).tracks["track_voice"] as { readonly properties?: object };

  it("is still what was saved back then", () => {
    const digest = (name: string) =>
      createHash("sha256")
        .update(readFileSync(new URL(name, folder)))
        .digest("hex");
    expect(digest("document.txt")).toBe(
      "74bc890c02b037442652889fbac9aed318cdaff93690a63f43aff888fb02b610",
    );
    expect(digest("state.json")).toBe(
      "d6937ab3adb15823869473ecaa8e99355cb0275c17b008e5d63d76fada6dcf2d",
    );
  });

  it("really has them", () => {
    const root = saved().doc.getMap<Y.Map<unknown>>("project");
    const main = (root.get("timelines") as Y.Map<Y.Map<Y.Map<Y.Map<unknown>>>>).get("main");
    expect(root.get("assets")).toBeInstanceOf(Y.Map);
    expect(root.get("notes")).toBeInstanceOf(Y.Map);
    expect(main?.get("tracks")?.get("track_voice")?.get("properties")).toBeInstanceOf(Y.Map);
    expect(main?.get("clips")?.get("clip_interview")?.get("properties")).toBeInstanceOf(Y.Map);
    const version = main?.get("overrides")?.get("language.en") as Y.Map<Y.Map<Y.Map<unknown>>>;
    const changes = version.get("clips")?.get("clip_interview") as Y.Map<unknown>;
    expect(changes.get("properties")).toBeInstanceOf(Y.Map);
  });

  it("writes next to them, where two windows cannot get in each other's way", () => {
    const store = saved();
    setProperty(store, "opacity", 0.1, {}, "clip_interview");
    const asset = { kind: "image", path: "assets/n.png", storage: "local" };
    success(store.execute({ type: "asset.add", params: { id: "new", asset } }));
    rewrite(store, "notes.json", (document: { notes: { id: string; text: string }[] }) => {
      for (const note of document.notes) if (note.id === "note_later") note.text = "看过了";
    });
    rewrite(store, MAIN, (document: { tracks: { id: string; properties?: object }[] }) => {
      const track = document.tracks.find(({ id }) => id === "track_voice");
      if (track) track.properties = { ...track.properties, "audio.volume": -6 };
    });
    type Level = Y.Map<unknown>;
    const root = store.doc.getMap<unknown>("project");
    const main = (root.get("timelines") as Y.Map<Y.Map<Y.Map<Level>>>).get("main");
    const video = main?.get("clips")?.get("clip_interview") as Level;
    const voice = main?.get("tracks")?.get("track_voice") as Level;
    expect(video.get("properties/opacity")).toBe(0.1);
    expect((video.get("properties") as Level).has("opacity")).toBe(false);
    expect(voice.get("properties/audio.volume")).toBe(-6);
    expect((voice.get("properties") as Level).has("audio.volume")).toBe(false);
    expect(root.get("assets/new")).toEqual(asset);
    expect((root.get("assets") as Level).has("new")).toBe(false);
    expect(root.get("notes/note_later")).toMatchObject({ text: "看过了" });
    expect((root.get("notes") as Level).has("note_later")).toBe(false);
  });

  it("reads as it read back then", () => {
    expect(saved().getState()).toEqual(SEEN_BACK_THEN);
  });

  it("writes valid files, which read the same", () => {
    const { files, problems } = saved().exportFiles();
    expect(problems).toEqual([]);
    const { store } = ProjectStore.open(files);
    expect((store as ProjectStore).exportFiles().files).toEqual(files);
  });

  it("takes changes to properties in a map, and keeps the others next to them", () => {
    const store = saved();
    const before = clip(store, "clip_interview")?.properties;
    setProperty(store, "opacity", 0.1, {}, "clip_interview");
    setProperty(store, "transform.y", 8, {}, "clip_interview");
    expect(clip(reopened(store), "clip_interview")?.properties).toEqual({
      ...before,
      opacity: 0.1,
      "transform.y": 8,
    });
  });

  it("takes them away for good, also the last one of a map", () => {
    const store = saved();
    for (const path of Object.keys(clip(store, "clip_card")?.properties ?? {})) {
      success(edit(store, "clip_card", { path, op: "clear" }));
    }
    expect(clip(store, "clip_card")).not.toHaveProperty("properties");
    expect(clip(reopened(store), "clip_card")).not.toHaveProperty("properties");
  });

  it("writes into a map that was emptied", () => {
    const store = saved();
    setProperty(store, "opacity", 0.1, {}, "clip_hit");
    expect(clip(reopened(store), "clip_hit")?.properties).toEqual({ opacity: 0.1 });
  });

  it("undoes and redoes all of that exactly", () => {
    const store = saved();
    const steps: (() => unknown)[] = [
      () => setProperty(store, "opacity", 0.1, {}, "clip_interview"),
      () => edit(store, "clip_card", { path: "opacity", op: "clear" }),
      () => store.execute({ type: "asset.remove", params: { asset: "later" } }),
      () =>
        rewrite(store, "notes.json", (document: { notes: unknown[] }) => {
          document.notes.pop();
        }),
      () =>
        rewrite(store, MAIN, (document: { tracks: { id: string; properties?: object }[] }) => {
          delete document.tracks.find(({ id }) => id === "track_voice")?.properties;
        }),
      () =>
        rewrite(store, VERSION, (document: { clips: Record<string, { properties?: object }> }) => {
          delete (document.clips["clip_interview"] as { properties?: object }).properties;
        }),
    ];
    const states = [store.getState()];
    for (const step of steps) {
      step();
      states.push(store.getState());
    }
    expect(new Set(states).size).toBe(steps.length + 1);
    for (const state of states.toReversed().slice(1)) {
      taken(store.undo());
      expect(store.getState()).toEqual(state);
    }
    expect(store.getState()).toEqual(SEEN_BACK_THEN);
    for (const state of states.slice(1)) {
      taken(store.redo());
      expect(store.getState()).toEqual(state);
    }
    expect(reopened(store).getState()).toEqual(store.getState());
  });

  it("takes changes to assets", () => {
    const store = saved();
    const asset = { kind: "image", path: "assets/n.png", storage: "local" };
    success(store.execute({ type: "asset.add", params: { id: "new", asset } }));
    success(store.execute({ type: "asset.remove", params: { asset: "later" } }));
    const { assets } = reopened(store).getState();
    expect(assets?.["new"]).toEqual(asset);
    expect(assets?.["later"]).toBeUndefined();
    expect(Object.keys(assets ?? {})).toHaveLength(Object.keys(SEEN_BACK_THEN.assets).length);
  });

  it("does not bring back what went away from a map", () => {
    expect(saved().getState().assets?.["gone"]).toBeUndefined();
  });

  it("takes changes to notes", () => {
    const store = saved();
    rewrite(store, "notes.json", (document: { notes: { id: string; text: string }[] }) => {
      for (const note of document.notes) if (note.id === "note_later") note.text = "看过了";
    });
    expect(reopened(store).getState().notes?.["note_later"]?.text).toBe("看过了");
    expect(Object.keys(reopened(store).getState().notes ?? {})).toHaveLength(
      Object.keys(SEEN_BACK_THEN.notes).length,
    );
  });

  it("takes changes to what a track has", () => {
    const store = saved();
    rewrite(store, MAIN, (document: { tracks: { id: string; properties?: object }[] }) => {
      const track = document.tracks.find(({ id }) => id === "track_voice");
      if (track) track.properties = { ...track.properties, "audio.volume": -6 };
    });
    expect(voiceTrack(reopened(store)).properties).toEqual({
      ...voiceTrack(saved()).properties,
      "audio.volume": -6,
    });
  });

  it("takes changes to what a version changes", () => {
    const store = saved();
    type Version = { clips: Record<string, { properties: Record<string, object> }> };
    rewrite(store, VERSION, (document: Version) => {
      const changes = document.clips["clip_interview"] as Version["clips"][string];
      changes.properties["transform.x"] = { value: 1 };
    });
    const { clips } = timeline(reopened(store)).overrides["language.en"] ?? {};
    expect(clips?.["clip_interview"]?.properties).toEqual({
      opacity: { value: 0.6, base: 0.75 },
      "transform.x": { value: 1 },
    });
  });

  it("merges what two windows write at the same time, into a map or next to it", () => {
    const a = saved();
    const b = twin(a);
    setProperty(a, "transform.y", 1, {}, "clip_interview");
    setProperty(b, "transform.scale", 2, {}, "clip_interview");
    const asset = { kind: "image", path: "assets/n.png", storage: "local" };
    success(a.execute({ type: "asset.add", params: { id: "from-a", asset } }));
    success(b.execute({ type: "asset.add", params: { id: "from-b", asset } }));
    sync(a, b);
    expect(a.getState()).toEqual(b.getState());
    expect(clip(a, "clip_interview")?.properties).toMatchObject({
      "transform.y": 1,
      "transform.scale": 2,
    });
    expect(a.getState().assets).toMatchObject({ "from-a": asset, "from-b": asset });
    expect(reopened(a).getState()).toEqual(a.getState());
  });

  it("knows what is the same write there too", () => {
    const store = saved();
    setProperty(store, "opacity", 0.1, {}, "clip_interview");
    setProperty(store, "opacity", 0.2, { origin: AI }, "clip_interview");
    setProperty(store, "opacity", 0.1, { origin: AI }, "clip_interview");
    blocked(store.undo());
    expect(property(store, "opacity", "clip_interview")).toBe(0.1);
  });
});

describe("ids that every object knows", () => {
  const NAMES = ["constructor", "toString", "valueOf", "hasOwnProperty"];

  describe.each(NAMES)("%s", (name) => {
    const params = (store: ProjectStore) => {
      const { id: track } = Object.values(timeline(store).tracks)[0] as { id: string };
      const { id: section } = Object.values(timeline(store).sections)[0] as { id: string };
      return { track, section };
    };

    it.each([
      ["clip.setProperty", { clip: name, path: "opacity", value: 1 }],
      ["clip.clearProperty", { clip: name, path: "opacity" }],
      [
        "property.edit",
        { edits: [{ owner: { clip: name }, path: "opacity", op: "set", value: 1 }] },
      ],
      ["property.edit", { edits: [{ owner: { clip: name }, path: "opacity", op: "clear" }] }],
      ["clip.remove", { clips: [name] }],
      ["clip.update", { clip: name, changes: { name: "x" } }],
      ["clip.move", { clips: [{ clip: name, start: "1" }] }],
      ["clip.trim", { clip: name, end: "1" }],
      ["clip.split", { clip: name, at: "1" }],
      ["track.update", { track: name, changes: { name: "x" } }],
      ["track.move", { track: name }],
      ["track.remove", { track: name }],
      ["section.update", { section: name, duration: "1" }],
      ["section.remove", { section: name }],
      ["marker.update", { marker: name, changes: { name: "x" } }],
      ["marker.remove", { marker: name }],
    ])("is not there for %s %j", (type, extra) => {
      const store = freshProject();
      const result = store.execute({ type, params: { timeline: "main", ...extra } });
      expect(failure(result).code).toBe("not-found");
    });

    it("is no timeline", () => {
      const store = freshProject();
      const { track } = params(store);
      const calls = [
        { type: "clip.remove", params: { timeline: name, clips: ["c"] } },
        { type: "track.update", params: { timeline: name, track, changes: { name: "x" } } },
        { type: "timeline.rename", params: { timeline: name, name: "x" } },
      ];
      for (const call of calls) expect(failure(store.execute(call)).code).toBe("not-found");
    });

    it("is no track to put a clip on", () => {
      const store = freshProject();
      const clipOf = {
        id: "e",
        start: "30",
        duration: "1",
        source: { kind: "color", color: "#000000" },
      };
      const result = store.execute({
        type: "clip.add",
        params: { timeline: "main", track: name, clip: clipOf },
      });
      expect(failure(result).code).toBe("not-found");
    });

    it("is no file", () => {
      const store = freshProject();
      expect(failure(store.execute({ type: "asset.remove", params: { asset: name } })).code).toBe(
        "not-found",
      );
    });

    it("can be the id of something new like any other", () => {
      const store = freshProject();
      const { track } = params(store);
      const added = {
        id: name,
        start: "30",
        duration: "1",
        source: { kind: "color", color: "#000000" },
      };
      success(
        store.execute({ type: "clip.add", params: { timeline: "main", track, clip: added } }),
      );
      success(edit(store, name, { path: "opacity", op: "set", value: 0.5 }));
      expect(timeline(store).clips[name]?.properties).toEqual({ opacity: 0.5 });
      const asset = { kind: "image", path: "assets/a.png", storage: "local" };
      success(store.execute({ type: "asset.add", params: { id: name, asset } }));
      expect(store.exportFiles().problems).toEqual([]);
    });
  });
});

describe("clearing a property", () => {
  function broken() {
    const store = freshProject();
    success(edit(store, "c", { path: "opacity", op: "set", value: 0.5 }));
    // Nothing that a command lets through: another program, or a version that was less careful.
    writeLikeBefore(store, "c", "fit", "stretch");
    writeLikeBefore(store, "c", "transform.scale", "很大");
    return store;
  }

  it("works next to a broken value, which is the way out of it", () => {
    const store = broken();
    const params = { timeline: "main", clip: "c", path: "opacity" };
    success(store.execute({ type: "clip.clearProperty", params }));
    expect(property(store, "opacity", "c")).toBeUndefined();
  });

  it("works on the broken value itself", () => {
    const store = broken();
    success(edit(store, "c", { path: "fit", op: "clear" }));
    success(edit(store, "c", { path: "transform.scale", op: "clear" }));
    expect(clip(store, "c")?.properties).toEqual({ opacity: 0.5 });
    expect(store.exportFiles().problems).toEqual([]);
  });

  it("is not stopped by a clip that is broken in another way", () => {
    const store = freshProject();
    success(edit(store, "c", { path: "opacity", op: "set", value: 0.5 }));
    const inside = (map: Y.Map<unknown>, key: string) => map.get(key) as Y.Map<unknown>;
    const main = inside(inside(store.doc.getMap("project"), "timelines"), "main");
    store.doc.transact(() => inside(inside(main, "clips"), "c").set("fadeIn", "很久"), "old");
    success(edit(store, "c", { path: "opacity", op: "clear" }));
  });

  it("lets other properties be written next to a broken value", () => {
    const store = broken();
    success(edit(store, "c", { path: "transform.x", op: "set", value: 3 }));
    expect(property(store, "transform.x", "c")).toBe(3);
  });

  it("still checks what is written", () => {
    const store = broken();
    expect(failure(edit(store, "c", { path: "opacity", op: "set", value: 2 })).code).toBe(
      "invalid-value",
    );
  });

  describe("the last property of a clip", () => {
    const fileOf = (store: ProjectStore) => store.exportFiles().files.get(MAIN) as string;

    it("leaves no trace in the state or the file", () => {
      const store = freshProject();
      const before = fileOf(store);
      success(edit(store, "c", { path: "opacity", op: "set", value: 0.5 }));
      success(edit(store, "c", { path: "opacity", op: "clear" }));
      expect(clip(store, "c")).not.toHaveProperty("properties");
      expect(fileOf(store)).toBe(before);
    });

    it("leaves no trace after undo either", () => {
      const store = freshProject();
      const before = fileOf(store);
      success(edit(store, "c", { path: "opacity", op: "set", value: 0.5 }));
      store.undo();
      expect(clip(store, "c")).not.toHaveProperty("properties");
      expect(fileOf(store)).toBe(before);
      store.redo();
      expect(property(store, "opacity", "c")).toBe(0.5);
    });

    it("leaves no trace after removing the last key", () => {
      const store = freshProject();
      success(edit(store, "c", { path: "opacity", op: "setKey", time: "0", value: 0.5 }));
      success(edit(store, "c", { path: "opacity", op: "clear" }));
      expect(clip(store, "c")).not.toHaveProperty("properties");
    });

    it("also not with the map of an older document", () => {
      const store = freshProject();
      writeLikeBefore(store, "c", "opacity", 0.5);
      success(edit(store, "c", { path: "opacity", op: "clear" }));
      expect(clip(store, "c")).not.toHaveProperty("properties");
    });

    it("also not on the other device", () => {
      const a = freshProject();
      success(edit(a, "c", { path: "opacity", op: "set", value: 0.5 }));
      const b = twin(a);
      success(edit(a, "c", { path: "opacity", op: "clear" }));
      sync(a, b);
      expect(clip(b, "c")).not.toHaveProperty("properties");
    });

    it("an empty one in a file is the same as none", () => {
      const store = freshProject();
      const file = JSON.parse(fileOf(store)) as { tracks: { clips: { properties?: object }[] }[] };
      for (const track of file.tracks) for (const item of track.clips) item.properties = {};
      const { revision } = store;
      success(store.importFile(MAIN, JSON.stringify(file)));
      expect(store.revision).toBe(revision);
      expect(store.canUndo).toBe(true);
      expect(clip(store, "c")).not.toHaveProperty("properties");
    });
  });
});

describe("keys on what cannot have any", () => {
  const keyed = {
    keys: [
      { time: "0", value: "cover" },
      { time: "1", value: "contain" },
    ],
  };
  const color = { kind: "color", color: "#112233" };

  /** Hand-written, as a project could be before the rule was stated. */
  function handWritten() {
    const files = loadFixture("v1");
    const manifest = JSON.parse(files.get("animaquill.json") as string);
    delete manifest.tags;
    files.set("animaquill.json", JSON.stringify(manifest));
    const main = JSON.parse(files.get(MAIN) as string) as {
      tracks: { clips: { id: string; properties?: Record<string, unknown> }[] }[];
    };
    const logo = main.tracks.flatMap(({ clips }) => clips).find(({ id }) => id === "clip_logo");
    if (!logo) throw new Error("no clip");
    logo.properties = { ...logo.properties, fit: keyed };
    files.set(MAIN, JSON.stringify(main));
    return { files, main };
  }

  it("a project that has them still opens, and says so", () => {
    const { files } = handWritten();
    const { store, problems } = ProjectStore.open(files);
    expect(store).toBeDefined();
    expect(problems.filter(({ severity }) => severity === "error")).toEqual([]);
    expect(problems.map(({ code }) => code)).toContain("not-animatable");
    expect(property(store as ProjectStore, "fit", "clip_logo")).toEqual(keyed);
  });

  it("cannot come in with a new clip", () => {
    const store = freshProject();
    const added = {
      id: "e",
      start: "30",
      duration: "1",
      source: color,
      properties: { fit: keyed },
    };
    const track = clip(store, "c")?.track;
    const result = store.execute({
      type: "clip.add",
      params: { timeline: "main", track, clip: added },
    });
    expect(failure(result).code).toBe("not-animatable");
  });

  it("cannot come in with a file", () => {
    const store = freshProject();
    const file = JSON.parse(store.exportFiles().files.get(MAIN) as string) as {
      tracks: { clips: { properties?: object }[] }[];
    };
    for (const track of file.tracks)
      for (const item of track.clips) item.properties = { fit: keyed };
    const error = failure(store.importFile(MAIN, JSON.stringify(file)));
    expect(error.code).toBe("invalid-file");
    expect(error.problems?.map(({ code }) => code)).toContain("not-animatable");
    expect(property(store, "fit", "c")).toBeUndefined();
  });

  it("cannot come in with a version either", () => {
    const store = open();
    const path = "timelines/main/overrides/format.vertical.json";
    const file = JSON.parse(store.exportFiles().files.get(path) as string) as {
      clips: Record<string, { properties?: Record<string, unknown> }>;
    };
    const [first] = Object.values(file.clips);
    if (!first) throw new Error("no clip");
    first.properties = { ...first.properties, fit: { value: keyed, base: "cover" } };
    const error = failure(store.importFile(path, JSON.stringify(file)));
    expect(error.problems?.map(({ code }) => code)).toContain("not-animatable");
  });

  it("a file that only has the old ones can still change other things", () => {
    const { files, main } = handWritten();
    const { store } = ProjectStore.open(files);
    const title = main.tracks.flatMap(({ clips }) => clips).find(({ id }) => id === "clip_logo");
    Object.assign(title as object, { name: "新名字" });
    success((store as ProjectStore).importFile(MAIN, JSON.stringify(main)));
    expect(clip(store as ProjectStore, "clip_logo")?.name).toBe("新名字");
    expect(property(store as ProjectStore, "fit", "clip_logo")).toEqual(keyed);
  });

  it("cannot be added to through an edit, and a plain value takes them away", () => {
    const { files } = handWritten();
    const { store } = ProjectStore.open(files);
    const opened = store as ProjectStore;
    const write = { path: "fit", op: "write", time: "2", value: "fixed" };
    expect(failure(edit(opened, "clip_logo", write)).code).toBe("not-animatable");
    success(edit(opened, "clip_logo", { path: "fit", op: "set", value: "fixed" }));
    expect(property(opened, "fit", "clip_logo")).toBe("fixed");
  });
});

describe("a project saved before positions became world coordinates", () => {
  const saved = () => {
    const update = Uint8Array.from(Buffer.from(SAVED_BEFORE_WORLD_COORDINATES, "base64"));
    const { store, damaged } = ProjectStore.fromUpdates([update]);
    expect(damaged).toBe(0);
    if (!store) throw new Error("nothing opened");
    return store;
  };

  it("shows the same picture and plays the same sound", () => {
    const state = saved().getState();
    const plan = buildRenderPlan(state, "main");
    expect(plan).toMatchObject({ width: 1920, height: 1080, background: "#000000" });
    expect(plan?.layers).toEqual([
      {
        id: "c_color",
        start: 0,
        end: 2,
        offset: 0,
        source: { kind: "color", color: "#ff0000" },
        fit: "contain",
        fades: { in: 0, out: 0 },
        channels: {},
      },
      {
        id: "c_video",
        start: 2,
        end: 7,
        offset: 1,
        source: { kind: "video", file: "sha256-aa" },
        fit: "cover",
        fades: { in: 0, out: 0 },
        channels: { opacity: { kind: "still", value: 0.5 } },
      },
    ]);
    expect(buildAudioPlan(state, "main").sounds).toHaveLength(1);
  });

  it("still goes through the checks, so nothing is left out when it is written", () => {
    const { files, problems } = saved().exportFiles();
    expect(problems).toEqual([]);
    expect(files.has(MAIN)).toBe(true);
    const { project, problems: read } = readProject(files);
    expect(read.filter((problem) => problem.severity === "error")).toEqual([]);
    expect(project?.timelines.get("main")?.document?.tracks[0]?.clips).toHaveLength(2);
  });

  it("can be edited as before", () => {
    const store = saved();
    const set = { timeline: "main", clip: "c_video", path: "opacity", value: 0.25 };
    success(store.execute({ type: "clip.setProperty", params: set }));
    const layer = buildRenderPlan(store.getState(), "main")?.layers[1];
    expect(layer?.channels["opacity"]).toEqual({ kind: "still", value: 0.25 });
  });

  it("two devices can go on with it without losing anything", () => {
    const a = saved();
    const b = twin(a);
    success(edit(a, "c_video", { path: "transform.x", op: "set", value: 10 }));
    success(edit(b, "c_video", { path: "transform.y", op: "set", value: 20 }));
    success(edit(a, "c_color", { path: "opacity", op: "set", value: 0.5 }));
    success(edit(b, "c_color", { path: "transform.x", op: "set", value: 30 }));
    sync(a, b);
    for (const store of [a, b]) {
      expect(clip(store, "c_video")?.properties).toEqual({
        fit: "cover",
        opacity: 0.5,
        "transform.x": 10,
        "transform.y": 20,
      });
      expect(clip(store, "c_color")?.properties).toEqual({ opacity: 0.5, "transform.x": 30 });
    }
    expect(a.exportFiles().files).toEqual(b.exportFiles().files);
  });

  it("clears what it held, for good", () => {
    const store = saved();
    success(edit(store, "c_video", { path: "opacity", op: "clear" }));
    success(edit(store, "c_video", { path: "fit", op: "clear" }));
    const { store: opened } = ProjectStore.fromUpdates([store.encodeState()]);
    expect(clip(opened as ProjectStore, "c_video")).not.toHaveProperty("properties");
  });

  it("can take in more files, and take away the ones it had", () => {
    const store = saved();
    const asset = { kind: "image", path: "assets/b.png", storage: "local", hash: "sha256-b" };
    success(store.execute({ type: "asset.add", params: { id: "picture", asset } }));
    expect(Object.keys(store.getState().assets ?? {}).toSorted()).toEqual(["footage", "picture"]);
    success(
      store.execute({
        type: "clip.remove",
        params: { timeline: "main", clips: ["c_video", "c_audio"] },
      }),
    );
    success(store.execute({ type: "asset.remove", params: { asset: "footage" } }));
    const { store: opened } = ProjectStore.fromUpdates([store.encodeState()]);
    expect(Object.keys((opened as ProjectStore).getState().assets ?? {})).toEqual(["picture"]);
  });
});
