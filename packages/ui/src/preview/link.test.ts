import type { MediaLibrary } from "../media/library.ts";
import { ProjectStore, orderedTracks, type CommandCall } from "@animaquill/core";
import type { FromCompositor, ToCompositor } from "@animaquill/render";
import type { ProjectLibrary } from "@animaquill/host";
import { createProject } from "@animaquill/schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DiagnosticsRecorder } from "../diagnostics/recorder.ts";
import { SceneHandles } from "../overlay/scene-handles.ts";
import { SceneRegistrations } from "../properties/registrations.ts";
import type { PropertyWriter } from "../properties/writer.ts";
import type { TimelineEditor } from "../timeline/editor.ts";
import { Emitter } from "../workbench/emitter.ts";
import { PreviewLink } from "./link.ts";
import { PreviewFrameRate } from "./frame-rate.ts";
import { PreviewQuality } from "./quality.ts";
import { PreviewStatus, type PreviewMessages } from "./status.ts";

type Listener = (event: { data: unknown; source: unknown }) => void;

let listeners: Listener[] = [];
const links: PreviewLink[] = [];

beforeEach(() => {
  listeners = [];
  vi.stubGlobal("addEventListener", (type: string, listener: Listener) => {
    if (type === "message") listeners.push(listener);
  });
  vi.stubGlobal("removeEventListener", () => {});
  vi.stubGlobal("document", {
    addEventListener: () => {},
    removeEventListener: () => {},
    visibilityState: "visible",
  });
});

afterEach(() => {
  for (const link of links.splice(0)) link.dispose();
  vi.unstubAllGlobals();
});

function setup(
  hearsFirst?: (store: ProjectStore) => void,
  {
    files = new Map<string, Blob>(),
    registrations,
    handles,
  }: { files?: Map<string, Blob>; registrations?: SceneRegistrations; handles?: SceneHandles } = {},
) {
  const restored: ((hash: string) => void)[] = [];
  const store = ProjectStore.create(createProject({ name: "预览" }));
  hearsFirst?.(store);
  const main = () => store.getState().timelines["main"];
  const track = orderedTracks(main() as never).find(({ kind }) => kind === "video")?.id;
  const run = (call: CommandCall) => {
    const result = store.execute(call);
    if (!result.ok) throw new Error(result.error.message);
  };
  const clip = (id: string, extra = {}) =>
    run({
      type: "clip.add",
      params: {
        timeline: "main",
        track,
        clip: {
          id,
          start: "0",
          duration: "5",
          source: { kind: "color", color: "#ff0000" },
          ...extra,
        },
      },
    });
  clip("c", { properties: { opacity: 0.5 } });

  const sent: ToCompositor[] = [];
  const contentWindow = { postMessage: (message: ToCompositor) => sent.push(message) };
  const frame = { contentWindow } as unknown as HTMLIFrameElement;
  const emitter = new Emitter();
  let previewed = new Map<string, Map<string, unknown>>();
  const preview = (values: Map<string, Map<string, unknown>>) => {
    previewed = values;
    emitter.emit();
  };
  const writer = {
    subscribe: emitter.subscribe,
    getPreviewed: () => previewed,
  } as unknown as PropertyWriter;
  const view: (() => void)[] = [];
  const clock = {
    playing: false,
    frame: 0,
    playbackStart: undefined as { frame: number; since: number } | undefined,
  };
  const timeline = {
    subscribe: () => () => {},
    subscribeView: (listener: () => void) => {
      view.push(listener);
      return () => {};
    },
    getSnapshot: () => ({ playing: clock.playing }),
    model: { id: "main", rate: { fps: 30 } },
    get frame() {
      return clock.frame;
    },
    get playbackStart() {
      return clock.playbackStart;
    },
  } as unknown as TimelineEditor;
  /** The playhead got here. */
  const tick = (to: number) => {
    clock.frame = to;
    for (const listener of view) listener();
  };
  const frameRate = new PreviewFrameRate(timeline);
  const settings = {
    load: () => Promise.resolve(undefined),
    save: () => Promise.resolve(),
    listen: () => () => {},
  };
  const quality = new PreviewQuality(settings, frameRate);
  const status = new PreviewStatus({
    problem: () => {},
    stopped: () => {},
    revisions: () => {},
    restarted: () => {},
  });
  const link = new PreviewLink(
    frame,
    timeline,
    writer,
    store,
    {
      media: () => ({ get: (id: string) => Promise.resolve(files.get(id)) }),
    } as unknown as ProjectLibrary,
    () => {},
    new DiagnosticsRecorder("test"),
    {
      onRestored: (listener: (hash: string) => void) => {
        restored.push(listener);
        return () => {};
      },
    } as unknown as MediaLibrary,
    status,
    { origins: ["https://scene.example"], compositor: "https://box.example", run: true },
    frameRate,
    quality,
    registrations,
    handles,
  );
  links.push(link);
  const hello = () => {
    for (const listener of listeners) listener({ data: { type: "ready" }, source: contentWindow });
  };
  const ofType = <T extends ToCompositor["type"]>(type: T) =>
    sent.filter((message): message is Extract<ToCompositor, { type: T }> => message.type === type);
  const fromCompositor = (data: FromCompositor) => {
    for (const listener of listeners) listener({ data, source: contentWindow });
  };
  const restore = (hash: string) => {
    for (const listener of restored) listener(hash);
  };
  return {
    store,
    run,
    clip,
    restore,
    sent,
    preview,
    hello,
    link,
    ofType,
    clock,
    tick,
    status,
    quality,
    contentWindow,
    fromCompositor,
  };
}

const set = (clip: string, path: string, value: unknown) => ({
  type: "property.edit",
  params: { timeline: "main", edits: [{ owner: { clip }, path, op: "set", value }] },
});

const showing = (values: Record<string, unknown>) =>
  new Map([["c", new Map(Object.entries(values))]]);

describe("problems of a scene", () => {
  /** A scene on the timeline, with what the compositor gets to hear. */
  function withScene() {
    const context = setup();
    const noted = vi.fn<PreviewMessages["problem"]>();
    const kept: ReadonlyMap<string, string>[] = [];
    const { status, run, hello, ofType, fromCompositor } = context;
    vi.spyOn(status, "noteProblem").mockImplementation((clip, revision, problem) =>
      noted(clip, revision, problem, true),
    );
    vi.spyOn(status, "noteRevisions").mockImplementation((revisions) => kept.push(revisions));
    run({
      type: "scene.add",
      params: {
        id: "s",
        scene: { name: "场景", entry: "index.html", runtime: 1 },
        files: { "index.html": "one" },
      },
    });
    context.clip("sc", { start: "5", source: { kind: "scene", scene: "s" } });
    hello();
    const current = () => {
      const { source } =
        ofType("plan")
          .at(-1)
          ?.plan.layers.find(({ id }) => id === "sc") ?? {};
      return (source as { revision: string }).revision;
    };
    const say = (revision: string) =>
      fromCompositor({
        type: "scene-problem",
        layer: "sc",
        revision,
        problem: { kind: "error", message: "oops", frame: 0 },
      });
    return { ...context, noted, kept, current, say };
  }

  it("get through from what the plan shows", () => {
    const { noted, current, say } = withScene();
    say(current());
    expect(noted).toHaveBeenCalledOnce();
  });

  it("stay out from a state of the scene that is on its way out", () => {
    const { noted, current, run, say } = withScene();
    const old = current();
    run({ type: "file.write", params: { path: "scenes/s/index.html", text: "two" } });
    say(old);
    expect(noted).not.toHaveBeenCalled();
    say(current());
    expect(noted).toHaveBeenCalledOnce();
  });

  it("stay out from a clip that is gone", () => {
    const { noted, fromCompositor, current } = withScene();
    const problem = { kind: "error", message: "oops", frame: 0 } as const;
    fromCompositor({ type: "scene-problem", layer: "nope", revision: current(), problem });
    expect(noted).not.toHaveBeenCalled();
  });

  it("say which states are current with every new plan", () => {
    const { kept, current, run } = withScene();
    run({ type: "file.write", params: { path: "scenes/s/index.html", text: "two" } });
    expect(kept.at(-1)).toEqual(new Map([["sc", current()]]));
  });
});

describe("the plan", () => {
  it("goes over once, and again only when something changed", () => {
    const { run, hello, store, ofType } = setup();
    hello();
    expect(ofType("plan")).toHaveLength(1);
    store.execute({ type: "project.rename", params: { name: "别的名字" } });
    expect(ofType("plan")).toHaveLength(1);
    run(set("c", "opacity", 0.25));
    expect(ofType("plan")).toHaveLength(2);
  });

  it("goes over again when a change is taken back", () => {
    const { run, hello, store, ofType } = setup();
    hello();
    run(set("c", "opacity", 0.25));
    store.undo();
    expect(ofType("plan")).toHaveLength(3);
    expect(ofType("plan").at(-1)?.plan.layers[0]?.channels["opacity"]).toMatchObject({
      value: 0.5,
    });
  });
});

describe("the quality of the preview", () => {
  it("draws the same world on fewer pixels, and says how large it would be", () => {
    const { hello, quality, ofType } = setup();
    hello();
    const full = ofType("plan")[0]?.plan;
    if (!full) throw new Error("no plan");
    expect(quality.getSnapshot().size).toEqual({
      shown: { width: full.width, height: full.height },
      full: { width: full.width, height: full.height },
    });
    quality.choose("half");
    const half = ofType("plan")[1];
    expect(half?.plan).toEqual({
      ...full,
      width: Math.round(full.width / 2),
      height: Math.round(full.height / 2),
    });
    // The stage is the world, and that does not change: scenes capture onto fewer pixels for it.
    expect(half?.plan.stage).toEqual(full.stage);
    expect(half?.full).toEqual({ width: full.width, height: full.height });
    expect(quality.getSnapshot().size?.shown).toEqual({
      width: half?.plan.width,
      height: half?.plan.height,
    });
    quality.choose("half");
    expect(ofType("plan")).toHaveLength(2);
  });

  it("keeps what is being tried out on top of a smaller plan", () => {
    const { hello, preview, quality, ofType } = setup();
    hello();
    preview(showing({ opacity: 0.25 }));
    quality.choose("quarter");
    const sent = ofType("plan").at(-1);
    expect(sent?.plan.layers[0]?.channels["opacity"]).toMatchObject({ value: 0.25 });
    expect(sent?.settled?.layers[0]?.channels["opacity"]).toMatchObject({ value: 0.5 });
    expect(sent?.settled?.width).toBe(sent?.plan.width);
  });

  it("is nothing to show once the preview is gone", () => {
    const { hello, link, quality } = setup();
    hello();
    link.dispose();
    expect(quality.getSnapshot().size).toBeUndefined();
  });
});

describe("a preview", () => {
  it("only sends what changed, and no plan", () => {
    const { hello, preview, ofType } = setup();
    hello();
    preview(showing({ "transform.x": 10 }));
    expect(ofType("plan")).toHaveLength(1);
    expect(ofType("channels")).toEqual([
      {
        type: "channels",
        layer: "c",
        channels: { "transform.x": { kind: "still", value: 10 } },
      },
    ]);
  });

  it("sends keys the way a plan has them", () => {
    const { hello, preview, ofType } = setup();
    hello();
    const keys = {
      keys: [
        { time: "0", value: 0 },
        { time: "1", value: 100 },
      ],
    };
    preview(showing({ "transform.x": keys }));
    expect(ofType("channels")[0]?.channels["transform.x"]).toMatchObject({ kind: "curve" });
  });

  it("takes a property away that the preview takes away", () => {
    const { hello, preview, ofType } = setup();
    hello();
    preview(showing({ opacity: undefined }));
    expect(ofType("channels")[0]?.channels).toEqual({ opacity: null });
  });

  it("gives back what the plan says when it ends", () => {
    const { hello, preview, ofType } = setup();
    hello();
    preview(showing({ opacity: 1, "transform.x": 10 }));
    preview(new Map());
    expect(ofType("channels").at(-1)).toEqual({
      type: "channels",
      layer: "c",
      channels: { opacity: { kind: "still", value: 0.5 }, "transform.x": null },
    });
  });

  it("gives back only what is not shown any more", () => {
    const { hello, preview, ofType } = setup();
    hello();
    preview(showing({ opacity: 1, "transform.x": 10 }));
    preview(showing({ "transform.x": 20 }));
    const after = ofType("channels").slice(1);
    expect(after).toHaveLength(1);
    expect(after[0]?.channels).toEqual({
      "transform.x": { kind: "still", value: 20 },
      opacity: { kind: "still", value: 0.5 },
    });
  });

  it("is part of a new plan that comes in the middle of it, so that it never leaves the picture", () => {
    const { hello, preview, run, sent, ofType } = setup();
    hello();
    preview(showing({ "transform.x": 10 }));
    sent.length = 0;
    run(set("c", "opacity", 0.25));
    expect(sent.map(({ type }) => type)).toEqual(["plan"]);
    expect(ofType("plan")[0]?.plan.layers[0]?.channels).toMatchObject({
      "transform.x": { value: 10 },
      opacity: { value: 0.25 },
    });
  });

  it("says what the project has underneath, so that nothing gets laid out for what is only shown", () => {
    const { hello, preview, run, ofType } = setup();
    hello();
    preview(showing({ "transform.width": 400 }));
    run(set("c", "opacity", 0.25));
    const [message] = ofType("plan").slice(-1);
    expect(message?.plan.layers[0]?.channels["transform.width"]).toMatchObject({ value: 400 });
    expect(message?.settled?.layers[0]?.channels["transform.width"]).toBeUndefined();
    expect(message?.settled?.layers[0]?.channels["opacity"]).toMatchObject({ value: 0.25 });
  });

  it("has nothing to say about that when nothing is shown", () => {
    const { hello, run, ofType } = setup();
    hello();
    run(set("c", "opacity", 0.25));
    expect(ofType("plan").at(-1)).not.toHaveProperty("settled");
  });

  it("says that again to a compositor that loaded in the middle of it", () => {
    const { hello, preview, ofType } = setup();
    hello();
    preview(showing({ "transform.width": 400 }));
    hello();
    const message = ofType("plan").at(-1);
    expect(message?.plan.layers[0]?.channels["transform.width"]).toMatchObject({ value: 400 });
    expect(message?.settled?.layers[0]?.channels["transform.width"]).toBeUndefined();
  });

  it("wins over what a new plan says about the same property", () => {
    const { hello, preview, run, ofType } = setup();
    hello();
    preview(showing({ opacity: 1 }));
    run(set("c", "opacity", 0.25));
    expect(ofType("plan").at(-1)?.plan.layers[0]?.channels["opacity"]).toMatchObject({ value: 1 });
  });

  it("goes on from what the new plan has when it ends", () => {
    const { hello, preview, run, ofType } = setup();
    hello();
    preview(showing({ opacity: 1 }));
    run(set("c", "opacity", 0.25));
    preview(new Map());
    expect(ofType("channels").at(-1)?.channels).toEqual({
      opacity: { kind: "still", value: 0.25 },
    });
  });

  it("does not send what is the same as before, however much else is shown", () => {
    const { hello, preview, ofType } = setup();
    hello();
    preview(showing({ opacity: 1, "transform.x": 10 }));
    const before = ofType("channels").length;
    preview(showing({ opacity: 1, "transform.x": 10 }));
    expect(ofType("channels")).toHaveLength(before);
    preview(showing({ opacity: 1, "transform.x": 20 }));
    expect(ofType("channels").at(-1)?.channels).toEqual({
      "transform.x": { kind: "still", value: 20 },
    });
  });

  it("sends the way of fitting the media, which is no curve", () => {
    const { hello, preview, ofType } = setup();
    hello();
    preview(showing({ fit: "cover" }));
    expect(ofType("channels").at(-1)).toEqual({
      type: "channels",
      layer: "c",
      channels: {},
      fit: "cover",
    });
    preview(new Map());
    expect(ofType("channels").at(-1)?.fit).toBe("contain");
  });

  it("gives back the way of fitting that the plan has", () => {
    const { hello, preview, run, ofType } = setup();
    hello();
    run(set("c", "fit", "fixed"));
    preview(showing({ fit: "cover" }));
    preview(new Map());
    expect(ofType("channels").at(-1)?.fit).toBe("fixed");
  });

  it("has the way of fitting in a new plan too", () => {
    const { hello, preview, run, ofType } = setup();
    hello();
    preview(showing({ fit: "fixed" }));
    run(set("c", "opacity", 0.25));
    expect(ofType("plan").at(-1)?.plan.layers[0]?.fit).toBe("fixed");
  });

  it("ending with the project taking over does not bring back the old value for a moment", () => {
    // What is being tried hears about a change before the link does, and ends the preview with it.
    let onChange = () => {};
    const { hello, preview, store, sent, ofType } = setup((early) => {
      early.subscribe(() => onChange());
    });
    hello();
    preview(showing({ opacity: 0.25 }));
    sent.length = 0;
    onChange = () => {
      onChange = () => {};
      preview(new Map());
    };
    store.execute(set("c", "opacity", 0.25));
    expect(sent.map(({ type }) => type)).toEqual(["plan"]);
    expect(ofType("plan")[0]?.plan.layers[0]?.channels["opacity"]).toMatchObject({ value: 0.25 });
  });

  it("has nothing to give back for a clip that left, and does not stumble over it", () => {
    const { hello, preview, run, ofType } = setup();
    hello();
    preview(showing({ "transform.x": 10 }));
    run({ type: "clip.remove", params: { timeline: "main", clips: ["c"] } });
    const before = ofType("channels").length;
    preview(new Map());
    expect(ofType("channels")).toHaveLength(before);
  });

  it("waits for the compositor", () => {
    const { preview, sent } = setup();
    preview(showing({ "transform.x": 10 }));
    expect(sent).toEqual([]);
  });

  it("starts over when the compositor loads again", () => {
    const { hello, preview, ofType } = setup();
    hello();
    preview(showing({ "transform.x": 10 }));
    hello();
    expect(ofType("plan")).toHaveLength(2);
    expect(ofType("plan").at(-1)?.plan.layers[0]?.channels["transform.x"]).toEqual({
      kind: "still",
      value: 10,
    });
  });
});

describe("who gets read", () => {
  /** A message that goes off when somebody looks at what is in it. */
  const trap = (source: unknown) => {
    let reads = 0;
    const event = {
      source,
      get data() {
        reads += 1;
        return { type: "ready" };
      },
    };
    return { event, reads: () => reads };
  };

  it("nobody but the compositor, because reading is what builds a message", () => {
    const { sent } = setup();
    const stranger = { parent: undefined };
    const { event, reads } = trap(stranger);
    for (const listener of listeners) listener(event);
    expect(reads()).toBe(0);
    expect(sent).toEqual([]);
  });

  it("a message of the compositor, once", () => {
    const { contentWindow } = setup();
    const { event, reads } = trap(contentWindow);
    for (const listener of listeners) listener(event);
    expect(reads()).toBe(1);
  });

  it("not even when there is a whole flood of it, and the sender goes", () => {
    const { contentWindow, ofType } = setup();
    const scene = {} as { parent: unknown };
    const page = Object.assign(contentWindow, { 0: scene, length: 1 });
    scene.parent = page;
    const { event, reads } = trap(scene);
    for (let message = 0; message < 40; message += 1) {
      for (const listener of listeners) listener(event);
    }
    expect(reads()).toBe(0);
    expect(ofType("evict")).toEqual([{ type: "evict", index: 0, frames: 1 }]);
  });
});

describe("a compositor that said hello", () => {
  it("first hears where scenes run", () => {
    const { hello, sent } = setup();
    hello();
    expect(sent[0]).toEqual({
      type: "setup",
      origins: ["https://scene.example"],
      compositor: "https://box.example",
      run: true,
      retired: [],
    });
    expect(sent[1]?.type).toBe("plan");
  });

  it("hears where a compositor before it saw something hang, which it cannot know", () => {
    const { hello, ofType, fromCompositor } = setup();
    hello();
    fromCompositor({ type: "origin-retired", origin: "https://scene.example" });
    hello();
    expect(ofType("setup").at(-1)?.retired).toEqual(["https://scene.example"]);
  });

  it("knows nothing, so the same goes for one that loaded again", () => {
    const { hello, ofType, status } = setup();
    hello();
    status.noteScene("c", { state: "stopped", reason: "flood" });
    hello();
    expect(ofType("setup")).toHaveLength(2);
    expect(status.getSnapshot().scenes.size).toBe(0);
  });
});

describe("how time goes over", () => {
  const start = { frame: 0, since: 0 };

  it("while paused, as a jump for every move", () => {
    const { hello, tick, ofType } = setup();
    hello();
    tick(30);
    expect(ofType("seek").at(-1)).toEqual({ type: "seek", seconds: 1, jump: true });
    expect(ofType("play")).toEqual([]);
  });

  it("starting to play tells where from, and that it is a jump", () => {
    const { hello, clock, tick, ofType } = setup();
    hello();
    clock.playing = true;
    clock.playbackStart = start;
    tick(30);
    expect(ofType("play")).toHaveLength(1);
    expect(ofType("play")[0]).toMatchObject({ seconds: 1, rate: 1, jump: true });
  });

  it("while playing, does not say so with every frame", () => {
    const { hello, clock, tick, ofType } = setup();
    hello();
    clock.playing = true;
    clock.playbackStart = start;
    for (let frame = 1; frame < 10; frame += 1) tick(frame);
    expect(ofType("play")).toHaveLength(1);
  });

  it("corrects itself every now and then, which is not a jump", () => {
    vi.useFakeTimers();
    const { hello, clock, tick, ofType } = setup();
    hello();
    clock.playing = true;
    clock.playbackStart = start;
    tick(1);
    tick(2);
    vi.advanceTimersByTime(1100);
    tick(3);
    vi.useRealTimers();
    expect(ofType("play")).toHaveLength(2);
    expect(ofType("play").at(-1)).toMatchObject({ seconds: 0.1, jump: false });
  });

  it("moving the playhead while playing is a jump again", () => {
    const { hello, clock, tick, ofType } = setup();
    hello();
    clock.playing = true;
    clock.playbackStart = start;
    tick(1);
    tick(2);
    clock.playbackStart = { frame: 90, since: 500 };
    tick(90);
    expect(ofType("play").at(-1)).toMatchObject({ seconds: 3, jump: true });
  });

  it("stopping says so, once", () => {
    const { hello, clock, tick, ofType } = setup();
    hello();
    clock.playing = true;
    clock.playbackStart = start;
    tick(1);
    clock.playing = false;
    tick(1);
    tick(1);
    expect(ofType("pause")).toHaveLength(1);
  });

  it("never says that it stopped without having started", () => {
    const { hello, tick, ofType } = setup();
    hello();
    tick(1);
    tick(2);
    expect(ofType("pause")).toEqual([]);
  });

  it("a compositor that loaded again starts over", () => {
    const { hello, clock, tick, ofType } = setup();
    hello();
    clock.playing = true;
    clock.playbackStart = start;
    tick(1);
    hello();
    tick(2);
    expect(ofType("play")).toHaveLength(2);
  });
});

describe("an asset whose file comes back", () => {
  const asset = { kind: "image", path: "assets/logo.png", storage: "local", hash: "sha256-a" };
  const scene = { name: "标题", entry: "index.html", runtime: 1 };

  function withScene() {
    const files = new Map<string, Blob>();
    const context = setup(undefined, { files });
    context.run({ type: "asset.add", params: { id: "logo", asset } });
    context.run({
      type: "scene.add",
      params: { id: "s", scene, files: { "index.html": `<script>aq.asset("logo")</script>` } },
    });
    context.clip("scene", { start: "6", source: { kind: "scene", scene: "s" } });
    context.hello();
    return { ...context, files };
  }

  it("goes to the scenes that ask for it, all of it again", async () => {
    const { restore, sent, files } = withScene();
    files.set("sha256-a", new Blob(["png"]));
    restore("sha256-a");
    await vi.waitFor(() => expect(sent.some(({ type }) => type === "scene-files")).toBe(true));
    const message = sent.find((candidate) => candidate.type === "scene-files");
    expect(message?.type === "scene-files" && message.assets.has("logo")).toBe(true);
  });

  it("is nothing to a scene that does not ask for it", async () => {
    const { restore, sent } = withScene();
    restore("sha256-other");
    // Long enough for an answer that would be on its way.
    await new Promise((done) => setTimeout(done, 50));
    expect(sent.some(({ type }) => type === "scene-files")).toBe(false);
  });
});

describe("what the compositor says about scenes", () => {
  it("goes to the status of the preview", () => {
    const { hello, fromCompositor, status } = setup();
    hello();
    fromCompositor({ type: "scene-status", layer: "c", status: { state: "unsupported" } });
    expect(status.getSnapshot().scenes.get("c")).toEqual({ state: "unsupported" });
  });

  it("gets a retry through", () => {
    const { hello, link, ofType } = setup();
    hello();
    link.retryScene("c");
    expect(ofType("scene-retry")).toEqual([{ type: "scene-retry", layer: "c" }]);
  });
});

describe("what a scene works out itself", () => {
  function withScene(registrations?: SceneRegistrations) {
    const context = setup(undefined, registrations ? { registrations } : {});
    context.run({
      type: "scene.add",
      params: {
        id: "s",
        scene: { name: "场景", entry: "index.html", runtime: 1 },
        files: { "index.html": "one" },
      },
    });
    context.clip("sc", {
      start: "5",
      source: { kind: "scene", scene: "s" },
      properties: { "param.size": 10, opacity: 0.5 },
    });
    context.hello();
    return context;
  }
  const onScene = (values: Record<string, unknown>) =>
    new Map([["sc", new Map(Object.entries(values))]]);
  const keys = { keys: [{ time: "0", value: 1 }] };

  it("goes in the plan as the clip stores it", () => {
    const { ofType } = withScene();
    const layer = ofType("plan")[0]?.plan.layers.find(({ id }) => id === "sc");
    expect(layer?.content).toEqual({ "param.size": 10 });
  });

  it("goes with a preview as the clip would store it, and back to what it stores", () => {
    const { preview, ofType } = withScene();
    preview(onScene({ "param.size": keys, "object.arm.x": 3, "transform.x": 5 }));
    expect(ofType("channels").at(-1)).toEqual({
      type: "channels",
      layer: "sc",
      channels: { "transform.x": { kind: "still", value: 5 } },
      content: { "param.size": keys, "object.arm.x": 3 },
    });
    preview(new Map());
    expect(ofType("channels").at(-1)?.content).toEqual({ "param.size": 10, "object.arm.x": null });
  });

  it("registers what it says about itself, for the state it came from", () => {
    const registrations = new SceneRegistrations();
    registrations.open("p");
    const { fromCompositor } = withScene(registrations);
    const registration = JSON.stringify({
      objects: [{ id: "arm", properties: [] }],
      elements: [],
      complete: true,
    });
    fromCompositor({ type: "scene-objects", layer: "sc", revision: "r9", registration });
    const found = () => registrations.registrationOf("r9", () => "null")?.registration;
    expect(found()?.objects).toEqual([{ id: "arm", properties: [] }]);
    expect(found()?.complete).toBe(true);
    fromCompositor({ type: "scene-objects-unsure", layer: "sc", revision: "r8" });
    expect(found()?.complete).toBe(true);
    fromCompositor({ type: "scene-objects-unsure", layer: "sc", revision: "r9" });
    expect(found()?.complete).toBe(false);
  });
});

describe("where the objects of a scene are", () => {
  it("is asked of the clip that wants it, once the compositor is there, and only when that changes", () => {
    const handles = new SceneHandles();
    handles.want("c");
    const { hello, ofType } = setup(undefined, { handles });
    expect(ofType("handles")).toEqual([]);
    hello();
    expect(ofType("handles")).toEqual([{ type: "handles", layer: "c" }]);
    handles.want("c");
    handles.want(undefined);
    expect(ofType("handles")).toEqual([
      { type: "handles", layer: "c" },
      { type: "handles", layer: null },
    ]);
    // A compositor that loaded again knows nothing.
    handles.want("c");
    hello();
    expect(ofType("handles").at(-1)).toEqual({ type: "handles", layer: "c" });
    expect(ofType("handles")).toHaveLength(4);
  });

  it("goes where the handles are kept, as raw as it came", () => {
    const handles = new SceneHandles({ schedule: (run) => (run(), () => {}) });
    handles.want("c");
    const registration = {
      objects: [{ id: "arm", properties: [{ path: "x", type: "number" as const }] }],
      elements: [],
      complete: true,
    };
    expect(handles.of("c", "r1", 4, registration)).toEqual([]);
    const { hello, fromCompositor } = setup(undefined, { handles });
    hello();
    const move = { kind: "move", id: "m", at: [0, 0], bind: { x: "x" } };
    const raw = [{ object: "arm", handles: [move] }];
    fromCompositor({ type: "scene-handles", layer: "c", revision: "r1", frame: 4, handles: raw });
    expect(handles.getVersion()).toBe(1);
    expect(handles.of("c", "r1", 4, registration)).toEqual([{ object: "arm", handles: [move] }]);
  });
});
