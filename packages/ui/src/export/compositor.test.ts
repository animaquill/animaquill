import type { ProjectState, RenderPlan } from "@animaquill/core";
import {
  SCENE_CORNER,
  StillFailed,
  type EncodedChunk,
  type ToCompositor,
} from "@animaquill/render";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExportCompositor, MAX_DESCRIPTION_BYTES, ownChunk, WindowClosed } from "./compositor.ts";

type Listener = (event: unknown) => void;

const plan = (layers: RenderPlan["layers"] = []): RenderPlan => ({
  width: 1280,
  height: 720,
  stage: { width: 1280, height: 720 },
  camera: {},
  background: "#000000",
  scenes: { format: "f", language: "zh-CN", fps: { num: 30, den: 1 } },
  layers,
});

const clip = (file: string): RenderPlan["layers"][number] => ({
  id: "clip",
  start: 0,
  end: 10,
  offset: 0,
  source: { kind: "image", file },
  fit: "contain",
  fades: { in: 0, out: 0 },
  channels: {},
});

const noScene: ProjectState = { files: {}, scenes: {} } as unknown as ProjectState;

let frame: {
  contentWindow: { postMessage: ReturnType<typeof vi.fn> };
  style: Record<string, string>;
  hidden: boolean;
  src: string;
  setAttribute: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
};
let listeners: Listener[];
let mount: Document;
let appended: unknown[];

/** What else the window gets told about, such as being closed. */
let others: Map<string, Listener[]>;

const view = {
  addEventListener: (type: string, listener: Listener) => {
    if (type === "message") listeners.push(listener);
    else others.set(type, [...(others.get(type) ?? []), listener]);
  },
  removeEventListener: (type: string, listener: Listener) => {
    if (type === "message") listeners = listeners.filter((known) => known !== listener);
    else
      others.set(
        type,
        (others.get(type) ?? []).filter((known) => known !== listener),
      );
  },
  focus: () => {},
};

beforeEach(() => {
  listeners = [];
  appended = [];
  frame = {
    contentWindow: { postMessage: vi.fn() },
    style: {},
    hidden: false,
    src: "",
    setAttribute: vi.fn(),
    remove: vi.fn(),
  };
  others = new Map();
  mount = {
    defaultView: view,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    visibilityState: "visible",
    createElement: () => frame,
    body: { append: (element: unknown) => appended.push(element) },
  } as unknown as Document;
  // What the keyboard keeper and the watchdog use. They are the same for the preview.
  vi.stubGlobal("document", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.stubGlobal("addEventListener", vi.fn());
  vi.stubGlobal("removeEventListener", vi.fn());
});

afterEach(() => vi.unstubAllGlobals());

const say = (data: unknown, source: unknown = frame.contentWindow) => {
  for (const listener of listeners) listener({ source, data });
};

const sent = (): ToCompositor[] =>
  frame.contentWindow.postMessage.mock.calls.map(([message]) => message as ToCompositor);

const open = (options: Partial<ConstructorParameters<typeof ExportCompositor>[0]> = {}) =>
  new ExportCompositor({
    url: "/compositor.html",
    document: mount,
    setup: { origins: ["https://scene.example"], compositor: "https://box.example", run: true },
    plan: plan(),
    state: noScene,
    media: async () => undefined,
    ...options,
  });

describe("an export compositor", () => {
  it("goes where it is told, with the window of that document listening", () => {
    const compositor = open();
    expect(appended).toEqual([frame]);
    expect(listeners).toHaveLength(1);
    expect(frame.src).toBe("/compositor.html");
    compositor.dispose();
  });

  it("runs in a sandbox", () => {
    const compositor = open();
    expect(frame.setAttribute).toHaveBeenCalledWith("sandbox", "allow-scripts");
    compositor.dispose();
  });

  it("keeps the corner with the scenes on the screen, or they would not get drawn", () => {
    const compositor = open();
    const { style } = frame;
    expect(frame.hidden).toBe(false);
    expect(style).toMatchObject({
      position: "fixed",
      right: "0",
      bottom: "0",
      width: `${SCENE_CORNER}px`,
      height: `${SCENE_CORNER}px`,
    });
    expect(style["opacity"]).toBeUndefined();
    expect(style["visibility"]).toBeUndefined();
    expect(style["display"]).toBeUndefined();
    compositor.dispose();
  });

  it("first says what it is for, so that it never draws anything by itself", () => {
    const saved = plan();
    const compositor = open({ plan: saved });
    say({ type: "ready" });
    expect(sent().map(({ type }) => type)).toEqual(["exporting", "setup", "plan"]);
    expect(sent()[2]).toEqual({ type: "plan", plan: saved });
    compositor.dispose();
  });

  it("writes through the port the compositor said hello with, which works from any window", () => {
    const compositor = open();
    const port = { postMessage: vi.fn(), close: vi.fn() };
    for (const listener of listeners) {
      listener({ source: frame.contentWindow, data: { type: "ready" }, ports: [port] });
    }
    expect(port.postMessage.mock.calls.map(([message]) => message.type)).toEqual([
      "exporting",
      "setup",
      "plan",
    ]);
    expect(sent()).toEqual([]);
    compositor.dispose();
    expect(port.close).toHaveBeenCalled();
  });

  it("gets nothing that is only being tried: there is one plan, and no way to add to it", () => {
    const compositor = open();
    say({ type: "ready" });
    const types = sent().map(({ type }) => type);
    expect(types).not.toContain("channels");
    expect(types).not.toContain("seek");
    expect(sent()[2]).not.toHaveProperty("settled");
    compositor.dispose();
  });

  it("leaves what comes from anybody else unread", () => {
    const compositor = open();
    let reads = 0;
    const trap = {
      source: {},
      get data() {
        reads += 1;
        return { type: "ready" };
      },
    };
    for (const listener of listeners) listener(trap);
    expect(reads).toBe(0);
    expect(sent()).toEqual([]);
    compositor.dispose();
  });

  it("gives the picture it gets for its request", async () => {
    const compositor = open();
    say({ type: "ready" });
    const still = compositor.still(2.5);
    await vi.waitFor(() => expect(sent().at(-1)?.type).toBe("still"));
    expect(sent().at(-1)).toEqual({ type: "still", request: 1, seconds: 2.5 });
    const image = {} as ImageBitmap;
    const nobodyAsked = { close: vi.fn() };
    say({ type: "still", request: 2, image: nobodyAsked });
    expect(nobodyAsked.close).toHaveBeenCalled();
    say({ type: "still", request: 1, image });
    await expect(still).resolves.toBe(image);
    compositor.dispose();
  });

  it("asks only after hello", async () => {
    const compositor = open();
    const still = compositor.still(1);
    await Promise.resolve();
    expect(sent()).toEqual([]);
    say({ type: "ready" });
    await vi.waitFor(() => expect(sent().at(-1)?.type).toBe("still"));
    compositor.dispose();
    await expect(still).rejects.toThrow();
  });

  it("gives the reason there is no picture", async () => {
    const compositor = open();
    say({ type: "ready" });
    const still = compositor.still(1);
    await vi.waitFor(() => expect(sent().at(-1)?.type).toBe("still"));
    const failure = { reason: "missing-file", layer: "clip", file: "a" };
    say({ type: "still", request: 1, failure });
    const error = await still.catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(StillFailed);
    expect((error as StillFailed).failure).toEqual(failure);
    compositor.dispose();
  });

  it("sends the files of the plan", async () => {
    const file = new Blob(["a"]);
    const compositor = open({ plan: plan([clip("a")]), media: async () => file });
    say({ type: "needs", id: "a" });
    await vi.waitFor(() => expect(sent()).toEqual([{ type: "file", id: "a", file }]));
    compositor.dispose();
  });

  it("says so when a file of the plan is not there, so that nobody waits for it", async () => {
    const compositor = open({ plan: plan([clip("a")]) });
    say({ type: "needs", id: "a" });
    await vi.waitFor(() => expect(sent()).toEqual([{ type: "no-file", id: "a" }]));
    compositor.dispose();
  });

  it("treats a file that cannot be read as not there", async () => {
    const compositor = open({
      plan: plan([clip("a")]),
      media: () => Promise.reject(new Error("no")),
    });
    say({ type: "needs", id: "a" });
    await vi.waitFor(() => expect(sent()).toEqual([{ type: "no-file", id: "a" }]));
    compositor.dispose();
  });

  it("sends nothing the plan does not use", async () => {
    const media = vi.fn(async () => new Blob(["a"]));
    const compositor = open({ media });
    say({ type: "needs", id: "other" });
    await vi.waitFor(() => expect(sent()).toEqual([{ type: "no-file", id: "other" }]));
    expect(media).not.toHaveBeenCalled();
    compositor.dispose();
  });

  it("passes on origins scenes have to stay away from", () => {
    const onRetired = vi.fn();
    const compositor = open({ onRetired });
    say({ type: "origin-retired", origin: "https://scene.example" });
    expect(onRetired).toHaveBeenCalledWith("https://scene.example");
    compositor.dispose();
  });

  it("does not go on after loading again, which forgot everything", async () => {
    const compositor = open();
    say({ type: "ready" });
    const still = compositor.still(1);
    await vi.waitFor(() => expect(sent().at(-1)?.type).toBe("still"));
    say({ type: "ready" });
    const error = await still.catch((reason: unknown) => reason);
    expect((error as StillFailed).failure).toEqual({ reason: "compositor" });
  });

  it("goes away with everything in it, and what was waiting ends", async () => {
    const compositor = open();
    say({ type: "ready" });
    const still = compositor.still(1);
    await vi.waitFor(() => expect(sent().at(-1)?.type).toBe("still"));
    compositor.dispose();
    expect(frame.remove).toHaveBeenCalled();
    expect(listeners).toEqual([]);
    await expect(still).rejects.toThrow("Export stopped");
  });

  it("stops with what was asked of it when its window is closed", async () => {
    const compositor = open();
    say({ type: "ready" });
    const still = compositor.still(1).catch((reason: unknown) => reason);
    await vi.waitFor(() => expect(sent().at(-1)?.type).toBe("still"));
    for (const listener of others.get("pagehide") ?? []) listener({});
    expect(await still).toBeInstanceOf(WindowClosed);
    expect(listeners).toEqual([]);
  });

  it("turns what comes from a window of its own into bytes of this page", async () => {
    const compositor = open();
    say({ type: "ready" });
    const chunks: EncodedChunk[] = [];
    void compositor
      .startEncoding({ codec: "avc1.640028", width: 2, height: 2 }, (chunk) => chunks.push(chunk))
      .catch(() => {});
    await vi.waitFor(() => expect(sent().at(-1)?.type).toBe("encode-start"));
    const data = new Uint8Array([5, 6]).buffer;
    say({
      type: "encoded",
      data,
      key: true,
      timestamp: 0,
      duration: 1,
      decoderConfig: { codec: "avc1", description: new Uint8Array([1, 2]) },
    });
    expect(chunks[0]?.data).toBeInstanceOf(ArrayBuffer);
    expect(chunks[0]?.data).not.toBe(data);
    expect(chunks[0]?.decoderConfig?.description).toBeInstanceOf(Uint8Array);
    expect([...new Uint8Array(chunks[0]?.data ?? new ArrayBuffer(0))]).toEqual([5, 6]);
    compositor.dispose();
  });

  it("has no picture any more once it is gone", async () => {
    const compositor = open();
    say({ type: "ready" });
    compositor.dispose();
    await expect(compositor.still(1)).rejects.toThrow("Export stopped");
  });

  it("gives up when it stops answering", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("document", {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      visibilityState: "visible",
    });
    try {
      const compositor = open();
      say({ type: "ready" });
      const still = compositor.still(1).catch((reason: unknown) => reason);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(((await still) as StillFailed).failure).toEqual({ reason: "compositor" });
      expect(frame.remove).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("an export compositor that waits", () => {
  /** Lets time go by, answering every ping the way a compositor that is there does. */
  async function pass(ms: number, answer: boolean) {
    let answered = 0;
    for (let at = 0; at < ms; at += 100) {
      await vi.advanceTimersByTimeAsync(100);
      if (!answer) continue;
      const pings = sent().filter((message) => message.type === "ping");
      for (const ping of pings.slice(answered)) say({ type: "pong", nonce: ping.nonce });
      answered = pings.length;
    }
  }

  const visible = (state: DocumentVisibilityState) => {
    (mount as unknown as { visibilityState: string }).visibilityState = state;
  };

  it("is not taken for hung while it waits for a file that takes long to read", async () => {
    vi.useFakeTimers();
    try {
      const read = Promise.withResolvers<Blob | undefined>();
      const compositor = open({ plan: plan([clip("big")]), media: () => read.promise });
      say({ type: "ready" });
      const encoding = compositor.startEncoding(
        { codec: "avc1.64001e", width: 2, height: 2 },
        () => {},
      );
      say({ type: "needs", id: "big" });
      // Two minutes of a 4K file coming off a slow disk.
      await pass(120_000, true);
      expect(frame.remove).not.toHaveBeenCalled();
      read.resolve(new Blob(["x"]));
      await vi.advanceTimersByTimeAsync(0);
      expect(sent().some((message) => message.type === "file")).toBe(true);
      const request = sent().find((message) => message.type === "encode-start");
      say({ type: "encode-answer", request: (request as { request: number }).request });
      await encoding;
      compositor.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("counts no time while its page is not on the screen, however long that is", async () => {
    vi.useFakeTimers();
    try {
      const compositor = open();
      say({ type: "ready" });
      const still = compositor.still(1).catch((reason: unknown) => reason);
      visible("hidden");
      // A browser that stops drawing a page in the background does not answer either.
      await pass(600_000, false);
      expect(frame.remove).not.toHaveBeenCalled();
      visible("visible");
      await pass(1000, true);
      expect(frame.remove).not.toHaveBeenCalled();
      compositor.dispose();
      expect(await still).toBeInstanceOf(DOMException);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("encoding in an export compositor", () => {
  const toEncode = { index: 0, seconds: 1, timestamp: 0, duration: 33333, keyFrame: true };

  it("starts the encoder, sends frames and ends, each once it is answered", async () => {
    const compositor = open();
    say({ type: "ready" });
    const chunks: unknown[] = [];
    const started = compositor.startEncoding(
      { codec: "avc1.640028", width: 2, height: 2 },
      (chunk) => chunks.push(chunk),
    );
    await vi.waitFor(() => expect(sent().at(-1)?.type).toBe("encode-start"));
    expect(sent().at(-1)).toMatchObject({ request: 1, config: { codec: "avc1.640028" } });
    say({ type: "encode-answer", request: 1 });
    await started;

    const encoded = compositor.encodeFrame(toEncode);
    await vi.waitFor(() => expect(sent().at(-1)?.type).toBe("encode-frame"));
    expect(sent().at(-1)).toEqual({ type: "encode-frame", request: 2, ...toEncode });
    const chunk = { data: new ArrayBuffer(1), key: true, timestamp: 0, duration: 33333 };
    say({ type: "encoded", ...chunk });
    say({ type: "encode-answer", request: 2 });
    await encoded;
    expect(chunks).toEqual([
      { data: new ArrayBuffer(1), key: true, timestamp: 0, duration: 33333 },
    ]);

    const finished = compositor.finishEncoding();
    await vi.waitFor(() => expect(sent().at(-1)?.type).toBe("encode-end"));
    say({ type: "encode-answer", request: 3 });
    await finished;
    compositor.dispose();
  });

  it("gives the reason a frame has no picture", async () => {
    const compositor = open();
    say({ type: "ready" });
    const encoded = compositor.encodeFrame(toEncode).catch((error: unknown) => error);
    await vi.waitFor(() => expect(sent().at(-1)?.type).toBe("encode-frame"));
    const failure = { reason: "scene-frame", layer: "a", wanted: 30 };
    say({ type: "encode-answer", request: 1, failure });
    expect(((await encoded) as StillFailed).failure).toEqual(failure);
    compositor.dispose();
  });

  it("hears nothing from the encoder once it is gone", async () => {
    const compositor = open();
    say({ type: "ready" });
    const onChunk = vi.fn();
    void compositor
      .startEncoding({ codec: "vp09.00.40.08", width: 2, height: 2 }, onChunk)
      .catch(() => {});
    await vi.waitFor(() => expect(sent().at(-1)?.type).toBe("encode-start"));
    compositor.dispose();
    say({ type: "encoded", data: new ArrayBuffer(1), key: true, timestamp: 0, duration: 1 });
    expect(onChunk).not.toHaveBeenCalled();
  });
});

describe("what an encoder of the sandbox gives back", () => {
  const chunk = { key: true, timestamp: 0, duration: 33_333 };

  it("is copied into bytes of this page", () => {
    const data = new Uint8Array([1, 2, 3]).buffer;
    const description = new Uint8Array([9, 9]);
    const own = ownChunk({ ...chunk, data, decoderConfig: { codec: "avc1.64001e", description } });
    if (typeof own === "string") throw new Error(own);
    expect([...new Uint8Array(own.data)]).toEqual([1, 2, 3]);
    expect(own.data).not.toBe(data);
    expect([...new Uint8Array(own.decoderConfig?.description as ArrayBuffer)]).toEqual([9, 9]);
  });

  it("is no chunk when its bytes are a number or only look like bytes, and nothing gets made", () => {
    expect(ownChunk({ ...chunk, data: 2 ** 31 })).toBe("data");
    expect(ownChunk({ ...chunk, data: { length: 2 ** 31, byteLength: 2 ** 31 } })).toBe("data");
    expect(ownChunk({ ...chunk, data: [1, 2, 3] })).toBe("data");
    expect(ownChunk(7)).toBe("chunk");
  });

  it("is no chunk with a description larger than any decoder needs", () => {
    const data = new ArrayBuffer(1);
    const description = new ArrayBuffer(MAX_DESCRIPTION_BYTES + 1);
    const decoderConfig = { codec: "avc1.64001e", description };
    expect(ownChunk({ ...chunk, data, decoderConfig })).toBe("description");
    const odd = { codec: "avc1.64001e", description: { length: 3 } };
    expect(ownChunk({ ...chunk, data, decoderConfig: odd })).toBe("description");
    expect(ownChunk({ ...chunk, data, decoderConfig: { codec: 7 } })).toBe("codec");
  });
});
