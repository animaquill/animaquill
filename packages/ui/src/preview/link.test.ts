import type { MediaLibrary } from "../media/library.ts";
import { ProjectStore, orderedTracks, type CommandCall } from "@animaquill/core";
import type { ToCompositor } from "@animaquill/render";
import type { ProjectLibrary } from "@animaquill/host";
import { createProject } from "@animaquill/schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DiagnosticsRecorder } from "../diagnostics/recorder.ts";
import type { PropertyWriter } from "../properties/writer.ts";
import type { TimelineEditor } from "../timeline/editor.ts";
import { Emitter } from "../workbench/emitter.ts";
import { PreviewLink } from "./link.ts";

type Listener = (event: { data: unknown; source: unknown }) => void;

let listeners: Listener[] = [];

beforeEach(() => {
  listeners = [];
  vi.stubGlobal("addEventListener", (_: string, listener: Listener) => listeners.push(listener));
  vi.stubGlobal("removeEventListener", () => {});
});

afterEach(() => vi.unstubAllGlobals());

function setup(hearsFirst?: (store: ProjectStore) => void) {
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
  const timeline = {
    subscribe: () => () => {},
    subscribeView: () => () => {},
    getSnapshot: () => ({ playing: false }),
    model: { id: "main", rate: { fps: 30 } },
    frame: 0,
    playbackStart: undefined,
  } as unknown as TimelineEditor;
  const link = new PreviewLink(
    frame,
    timeline,
    writer,
    store,
    {} as ProjectLibrary,
    () => {},
    new DiagnosticsRecorder("test"),
    { onRestored: () => () => {} } as unknown as MediaLibrary,
  );
  const hello = () => {
    for (const listener of listeners) listener({ data: { type: "ready" }, source: contentWindow });
  };
  const ofType = <T extends ToCompositor["type"]>(type: T) =>
    sent.filter((message): message is Extract<ToCompositor, { type: T }> => message.type === type);
  return { store, run, clip, sent, preview, hello, link, ofType };
}

const set = (clip: string, path: string, value: unknown) => ({
  type: "property.edit",
  params: { timeline: "main", edits: [{ owner: { clip }, path, op: "set", value }] },
});

const showing = (values: Record<string, unknown>) =>
  new Map([["c", new Map(Object.entries(values))]]);

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
