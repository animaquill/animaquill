import { ProjectStore, USER, orderedTracks, type RenderPlan } from "@animaquill/core";
import type { FolderAccess, ProjectLibrary } from "@animaquill/host";
import { StillFailed, type StillFailure } from "@animaquill/render";
import { createProject } from "@animaquill/schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PreviewStatus } from "../preview/status.ts";
import type { TimelineEditor } from "../timeline/editor.ts";
import { Dialogs } from "../workbench/dialogs.ts";
import { Notifications } from "../workbench/notifications.ts";
import type { ProjectSession } from "../workbench/session.ts";
import type { ExportCompositorOptions } from "./compositor.ts";
import { StillExport, type StillCompositor, type StillExportOptions } from "./still.ts";

/** Says the key and what goes into it, so that what is said can be checked without the words. */
const t = ((key: string, options?: Record<string, unknown>) => {
  const { interpolation: _, ...fields } = options ?? {};
  return Object.keys(fields).length > 0 ? `${key} ${JSON.stringify(fields)}` : key;
}) as never;

function setup(changes: Partial<StillExportOptions> = {}) {
  const store = ProjectStore.create(createProject({ name: "封面" }));
  const main = () => store.getState().timelines["main"];
  const track = orderedTracks(main() as never).find(({ kind }) => kind === "video")?.id;
  const clip = { id: "c", start: "0", duration: "5", source: { kind: "color", color: "#ff0000" } };
  store.execute({ type: "clip.add", params: { timeline: "main", track, clip } });

  const dialogs = new Dialogs();
  const notifications = new Notifications();
  const preview = new PreviewStatus({
    problem: () => {},
    stopped: () => {},
    revisions: () => {},
    restarted: () => {},
  });
  const saveFile = vi.fn<FolderAccess["saveFile"]>();
  const opened: ExportCompositorOptions[] = [];
  const dispose = vi.fn();
  const answer = Promise.withResolvers<ImageBitmap>();
  const still = vi.fn<StillCompositor["still"]>(() => answer.promise);
  const png = new Blob(["png"]);
  const stills = new StillExport({
    session: { store } as unknown as ProjectSession,
    timeline: {
      frame: 45,
      model: { id: "main", rate: { fps: 30 }, boxes: new Map() },
    } as unknown as TimelineEditor,
    projects: {
      media: () => ({ get: async () => undefined }),
    } as unknown as ProjectLibrary,
    folders: { saveFile } as unknown as FolderAccess,
    preview,
    dialogs,
    notifications,
    t,
    compositorUrl: "https://box.example/compositor.html",
    sceneOrigins: ["https://scene-0.example", "https://scene-1.example"],
    sceneStage: undefined,
    compositor: (options) => {
      opened.push(options);
      return { still, dispose };
    },
    encode: async () => png,
    ...changes,
  });
  const said = () => notifications.getSnapshot().map(({ message }) => message);
  return { stills, store, dialogs, preview, saveFile, opened, dispose, answer, still, png, said };
}

const noticeOf = async ({ dialogs }: { dialogs: Dialogs }) => {
  await vi.waitFor(() => expect(dialogs.getSnapshot()?.kind).toBe("confirm"));
  return dialogs.getSnapshot() as Extract<ReturnType<Dialogs["getSnapshot"]>, { kind: "confirm" }>;
};

beforeEach(() => {
  vi.stubGlobal("document", { baseURI: "https://editor.example/" });
});

afterEach(() => vi.unstubAllGlobals());

describe("exporting the frame at the playhead", () => {
  it("asks for the moment of the playhead", async () => {
    const context = setup();
    const running = context.stills.run();
    context.answer.resolve({} as ImageBitmap);
    await running;
    expect(context.still).toHaveBeenCalledExactlyOnceWith(1.5);
  });

  it("gives people the file, and says so", async () => {
    const context = setup();
    const running = context.stills.run();
    context.answer.resolve({} as ImageBitmap);
    await running;
    expect(context.saveFile).toHaveBeenCalledOnce();
    const [file, name] = context.saveFile.mock.calls[0] as [Blob, string];
    expect(file).toBe(context.png);
    expect(name).toContain("export.frameFile");
    expect(name).toContain("封面");
    expect(name).toContain("45");
    expect(context.said()[0]).toContain("export.frameDone");
  });

  it("draws what is in the project, at the size of the output", async () => {
    const context = setup();
    const running = context.stills.run();
    context.answer.resolve({} as ImageBitmap);
    await running;
    const { plan, state } = context.opened[0] as ExportCompositorOptions;
    expect(state).toBe(context.store.getState());
    expect(plan.layers.map(({ id }) => id)).toEqual(["c"]);
    expect((plan as RenderPlan).width).toBeGreaterThan(0);
  });

  it("does not follow what happens to the project once it started", async () => {
    const context = setup();
    const running = context.stills.run();
    const before = context.opened[0]?.state;
    context.store.execute({ type: "project.rename", params: { name: "改了" } });
    context.answer.resolve({} as ImageBitmap);
    await running;
    expect(context.opened[0]?.state).toBe(before);
    expect(context.saveFile.mock.calls[0]?.[1]).toContain("封面");
  });

  it("stays out of the way of the scenes of the preview", async () => {
    const context = setup();
    context.preview.noteRetired("https://scene-0.example");
    const running = context.stills.run();
    context.answer.resolve({} as ImageBitmap);
    await running;
    const { setup: scenes } = context.opened[0] as ExportCompositorOptions;
    expect(scenes.origins).toEqual(["https://scene-1.example", "https://scene-0.example"]);
    expect(scenes.retired).toEqual(["https://scene-0.example"]);
    expect(scenes.compositor).toBe("https://box.example");
  });

  it("takes along that scenes were switched off, and passes on origins that retire", async () => {
    const context = setup();
    context.preview.restart({ runScenes: false });
    const running = context.stills.run();
    const options = context.opened[0] as ExportCompositorOptions;
    expect(options.setup.run).toBe(false);
    options.onRetired?.("https://scene-1.example");
    expect(context.preview.retiredOrigins).toEqual(["https://scene-1.example"]);
    context.answer.resolve({} as ImageBitmap);
    await running;
  });

  it("shows that it is working, and cleans up", async () => {
    const context = setup();
    const running = context.stills.run();
    expect(context.dialogs.getSnapshot()?.kind).toBe("progress");
    context.answer.resolve({} as ImageBitmap);
    await running;
    expect(context.dialogs.getSnapshot()).toBeUndefined();
    expect(context.dispose).toHaveBeenCalledOnce();
  });

  it("stops when people say so, and then there is no file", async () => {
    const context = setup();
    const running = context.stills.run();
    const dialog = context.dialogs.getSnapshot();
    if (dialog?.kind === "progress") dialog.stop();
    await running;
    expect(context.saveFile).not.toHaveBeenCalled();
    expect(context.dispose).toHaveBeenCalledOnce();
    expect(context.said()).toEqual(["export.frameCancelled"]);
  });

  it("does not save what comes in after people said stop", async () => {
    const encoded = Promise.withResolvers<Blob>();
    const context = setup({ encode: () => encoded.promise });
    const running = context.stills.run();
    context.answer.resolve({} as ImageBitmap);
    await vi.waitFor(() => expect(context.dialogs.getSnapshot()?.kind).toBe("progress"));
    await Promise.resolve();
    await Promise.resolve();
    const dialog = context.dialogs.getSnapshot();
    if (dialog?.kind === "progress") dialog.stop();
    encoded.resolve(new Blob(["png"]));
    await running;
    expect(context.saveFile).not.toHaveBeenCalled();
  });

  it("does nothing without a timeline", async () => {
    const context = setup({ timeline: { frame: 0 } as unknown as TimelineEditor });
    await context.stills.run();
    expect(context.opened).toEqual([]);
    expect(context.dialogs.getSnapshot()).toBeUndefined();
  });
});

describe("a frame where a join is that this editor cannot do", () => {
  it("is not made, because the preview shows a dissolve instead, and it says why", async () => {
    const context = setup();
    const { store } = context;
    const path = "timelines/main/timeline.json";
    const timeline = JSON.parse(store.exportFiles().files.get(path) as string);
    const video = timeline.tracks.find(({ kind }: { kind: string }) => kind === "video");
    video.clips[0].duration = "1";
    video.clips.push({
      id: "d",
      start: "1",
      duration: "4",
      source: { kind: "color", color: "#00ff00" },
    });
    const join = {
      id: "j",
      from: "c",
      to: "d",
      type: "plugin.star",
      duration: "1",
      align: "after",
    };
    video.joins = [join];
    expect(store.importFile(path, JSON.stringify(timeline), { origin: USER }).ok).toBe(true);
    // The playhead is at frame 45, a second and a half: within the join, which starts at one.
    const running = context.stills.run();
    const notice = await noticeOf(context);
    context.dialogs.answer(true);
    await running;
    expect(notice.message).toContain("export.failure.join");
    expect(context.opened).toEqual([]);
    expect(context.saveFile).not.toHaveBeenCalled();
  });
});

describe("what people hear when there is no frame", () => {
  const failing = async (failure: StillFailure, changes: Partial<StillExportOptions> = {}) => {
    const context = setup(changes);
    const running = context.stills.run();
    context.answer.reject(new StillFailed(failure));
    const notice = await noticeOf(context);
    context.dialogs.answer(true);
    await running;
    expect(context.saveFile).not.toHaveBeenCalled();
    expect(context.dispose).toHaveBeenCalledOnce();
    expect(notice.title).toBe("export.frameFailed");
    expect(notice.noticeOnly).toBe(true);
    return notice.message;
  };

  it("names the clip whose file is missing, by what people called it", async () => {
    const clip = { name: "片头", source: { kind: "video" } };
    const message = await failing(
      { reason: "missing-file", layer: "c", file: "a" },
      {
        timeline: {
          frame: 0,
          model: { id: "main", rate: { fps: 30 }, boxes: new Map([["c", { clip }]]) },
        } as unknown as TimelineEditor,
      },
    );
    expect(message).toContain("export.failure.missingFile");
    expect(message).toContain("片头");
  });

  it("says when a file cannot be read", async () => {
    const message = await failing({ reason: "cannot-decode", layer: "c", file: "a" });
    expect(message).toContain("export.failure.cannotDecode");
  });

  it("says which frame a scene did not give", async () => {
    const message = await failing({ reason: "scene-frame", layer: "c", wanted: 7, got: 6 });
    expect(message).toContain("export.failure.sceneFrame");
    expect(message).toContain("7");
  });

  it.each([
    ["unsupported", "export.failure.sceneUnsupported"],
    ["off", "export.failure.sceneOff"],
    ["too-new", "preview.tooNew"],
    ["closed", "export.failure.sceneClosed"],
  ] as const)("says what a scene that is %s means", async (state, key) => {
    const message = await failing({ reason: "scene", layer: "c", status: { state } });
    expect(message).toContain(key);
  });

  it("says why a scene stopped, in the words of the preview", async () => {
    const status = { state: "stopped", reason: "stuck" } as const;
    const message = await failing({ reason: "scene", layer: "c", status });
    expect(message).toContain("preview.stoppedScene.stuck");
  });

  it("says when the compositor stopped answering", async () => {
    expect(await failing({ reason: "compositor" })).toBe("export.failure.compositor");
  });

  it("says what went wrong with anything else", async () => {
    const context = setup();
    vi.spyOn(console, "warn").mockImplementationOnce(() => {});
    const running = context.stills.run();
    context.answer.reject(new Error("too large"));
    const notice = await noticeOf(context);
    context.dialogs.answer(true);
    await running;
    expect(notice.message).toContain("too large");
  });
});
