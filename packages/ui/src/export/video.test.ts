import { ProjectStore, USER, orderedTracks } from "@animaquill/core";
import type { FolderAccess, GrowingFile, ProjectLibrary, SettingsStore } from "@animaquill/host";
import type { EncodedFrame, VideoFileOptions } from "@animaquill/media";
import {
  StillFailed,
  type EncodedChunk,
  type FrameToEncode,
  type StillFailure,
} from "@animaquill/render";
import { SoundFailed } from "@animaquill/audio";
import { createProject } from "@animaquill/schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PreviewStatus } from "../preview/status.ts";
import type { TimelineEditor } from "../timeline/editor.ts";
import { Dialogs, type FormAnswer } from "../workbench/dialogs.ts";
import { Notifications } from "../workbench/notifications.ts";
import { MemoryExports } from "../workbench/memory-library.ts";
import type { ProjectSession } from "../workbench/session.ts";
import { WindowClosed, type ExportCompositorOptions } from "./compositor.ts";
import type { ExportWindow, ExportWindows } from "./window.ts";
import { bitrateFor } from "./codecs.ts";
import type { MakeAudioEncoder } from "./sound.ts";
import {
  framesOf,
  VideoExport,
  type SavedState,
  type VideoExportOptions,
  type VideoWriter,
} from "./video.ts";

const t = ((key: string, options?: Record<string, unknown>) => {
  const { interpolation: _, ...fields } = options ?? {};
  return Object.keys(fields).length > 0 ? `${key} ${JSON.stringify(fields)}` : key;
}) as never;

const FORMAT = { id: "small", name: "小屏", width: 640, height: 360, fps: "30" };

/** What an export kept, as the editor reads it. */
const stateOf = (saved: { readonly state: unknown } | undefined) =>
  saved ? (saved.state as SavedState) : undefined;

class FakeFile implements GrowingFile {
  readonly name = "视频.mp4";
  readonly kind = "file" as const;
  readonly target = { kind: "download", name: "视频.mp4" };
  readonly writes: number[] = [];
  finished = false;
  abandoned = false;
  failAbandon = false;
  async write(_: Uint8Array<ArrayBuffer>, position: number) {
    this.writes.push(position);
  }
  async finish() {
    this.finished = true;
  }
  /** As the host does it: the file only goes when no other export goes to the same place. */
  async abandon(others: readonly unknown[] = []) {
    if (this.failAbandon) throw new Error("stays");
    const same = (other: unknown) => JSON.stringify(other) === JSON.stringify(this.target);
    if (!others.some(same)) this.abandoned = true;
  }
}

/** A compositor that gives one chunk per frame, and can be told to fail or to wait. */
class FakeCompositor {
  readonly frames: FrameToEncode[] = [];
  config: VideoEncoderConfig | undefined;
  onChunk: ((chunk: EncodedChunk) => void) | undefined;
  disposed = false;
  finished = false;
  failAt: { index: number; failure: StillFailure } | undefined;
  hold: Promise<void> | undefined;
  noHardware = false;
  /** The window goes away while this frame is asked for. Once. */
  closeAt: number | undefined;
  /** Chunks come this many frames late, as from a real encoder, and get lost with a window. */
  lag = 0;
  queued: EncodedChunk[] = [];
  /** How large each chunk is. */
  chunkBytes = 1;
  /** What the next encoder says about decoding, for the first chunk it gives. */
  description = [1, 2, 3];
  starts = 0;
  /**
   * Chunks come as messages do, a little later than the frame was taken, and still in order: what
   * an encoder gave for one frame comes with the answer to whatever it is asked next.
   */
  late = false;
  readonly #inFlight: {
    readonly chunk: EncodedChunk;
    readonly to: (chunk: EncodedChunk) => void;
  }[] = [];
  #first = true;

  #arrive() {
    for (const { chunk, to } of this.#inFlight.splice(0)) to(chunk);
  }

  async startEncoding(
    config: VideoEncoderConfig,
    onChunk: (chunk: EncodedChunk) => void,
    _onWrong?: (what: string) => void,
  ) {
    this.#arrive();
    this.starts += 1;
    this.#first = true;
    this.queued = [];
    if (this.noHardware && config.hardwareAcceleration === "prefer-hardware") {
      throw new StillFailed({ reason: "encoder", message: "no hardware" });
    }
    this.config = config;
    this.onChunk = onChunk;
  }
  /** As if the page went away at this frame: it never gets further. */
  crashAt: number | undefined;
  async encodeFrame(frame: FrameToEncode) {
    this.#arrive();
    if (this.hold) await this.hold;
    if (this.crashAt === frame.index) await new Promise(() => {});
    if (this.failAt?.index === frame.index) throw new StillFailed(this.failAt.failure);
    if (this.closeAt === frame.index) {
      this.closeAt = undefined;
      throw new WindowClosed();
    }
    this.frames.push(frame);
    const first = this.#first;
    this.#first = false;
    const bytes = new Uint8Array(this.chunkBytes);
    bytes[0] = frame.index % 256;
    this.queued.push({
      data: bytes.buffer,
      key: frame.keyFrame,
      timestamp: frame.timestamp,
      duration: frame.duration,
      ...(first && {
        decoderConfig: {
          codec: this.config?.codec ?? "avc1.64001e",
          description: new Uint8Array(this.description),
        },
      }),
    });
    while (this.queued.length > this.lag) this.#emit();
  }
  #emit() {
    const chunk = this.queued.shift();
    if (!chunk) return;
    const { onChunk } = this;
    if (!this.late) {
      onChunk?.(chunk);
      return;
    }
    this.#inFlight.push({ chunk, to: (each: EncodedChunk) => onChunk?.(each) });
  }
  flushes = 0;
  async flushEncoding() {
    while (this.queued.length > 0) this.#emit();
    this.#arrive();
    this.flushes += 1;
  }
  async finishEncoding() {
    while (this.queued.length > 0) this.#emit();
    this.#arrive();
    this.finished = true;
  }
  dispose() {
    this.disposed = true;
  }
}

class FakeWriter implements VideoWriter {
  readonly frames: EncodedFrame[] = [];
  readonly sounds: EncodedFrame[] = [];
  /** What went in, in order: "v" for a frame of picture, "s" for one of sound. */
  readonly order: string[] = [];
  readonly configs: (VideoDecoderConfig | undefined)[] = [];
  finished = false;
  cancelled = false;
  failAt: number | undefined;
  async add(frame: EncodedFrame, decoderConfig?: VideoDecoderConfig) {
    if (this.frames.length === this.failAt) throw new Error("disk full");
    this.frames.push(frame);
    this.configs.push(decoderConfig);
    this.order.push("v");
  }
  async addSound(frame: EncodedFrame) {
    this.sounds.push(frame);
    this.order.push("s");
  }
  async finish() {
    this.finished = true;
  }
  async cancel() {
    this.cancelled = true;
  }
}

class FakeAudioData {
  readonly timestamp: number;
  readonly numberOfFrames: number;
  constructor(init: { timestamp: number; numberOfFrames: number }) {
    this.timestamp = init.timestamp;
    this.numberOfFrames = init.numberOfFrames;
  }
  close() {}
}

/** An audio encoder that gives a chunk for each piece. */
const soundEncoder: MakeAudioEncoder = ({ output }) => ({
  configure() {},
  encodeQueueSize: 0,
  encode(data: AudioData) {
    const { timestamp, numberOfFrames } = data as unknown as FakeAudioData;
    const chunk = {
      byteLength: 1,
      timestamp,
      duration: Math.round((numberOfFrames * 1e6) / 48_000),
      copyTo: () => {},
    };
    output(chunk as unknown as EncodedAudioChunk, {});
  },
  flush: async () => {},
  close() {},
});

class FakeWindow implements ExportWindow {
  readonly kind = "window" as const;
  readonly document = { window: true } as unknown as Document;
  closedNow = Promise.withResolvers<void>();
  readonly closed = this.closedNow.promise;
  closes = 0;
  close() {
    this.closes += 1;
  }
}

class FakeWindows implements ExportWindows {
  supported = true;
  activation = true;
  refuse = false;
  readonly opened: FakeWindow[] = [];
  canOpenNow() {
    return this.activation;
  }
  async open() {
    if (this.refuse) return undefined;
    const opened = new FakeWindow();
    this.opened.push(opened);
    return opened;
  }
}

function setup(
  changes: Partial<VideoExportOptions> = {},
  seconds = 2,
  sound = false,
  /** Another page on the same device: the same project, and what exports kept. */
  before?: { readonly store: ProjectStore; readonly exports: MemoryExports },
) {
  const store =
    before?.store ?? ProjectStore.create(createProject({ name: "片子", format: FORMAT }));
  const main = () => store.getState().timelines["main"];
  const track = orderedTracks(main() as never).find(({ kind }) => kind === "video")?.id;
  const clip = {
    id: "c",
    start: "0",
    duration: String(seconds),
    source: { kind: "color", color: "#ff0000" },
  };
  const added = before
    ? { ok: true as const }
    : store.execute({ type: "clip.add", params: { timeline: "main", track, ...clip } });
  if (!added.ok) throw new Error(`${added.error.code}: ${JSON.stringify(added.error.params)}`);
  if (sound && !before) {
    const audio = orderedTracks(main() as never).find(({ kind }) => kind === "audio")?.id;
    const asset = { kind: "audio", path: "assets/tone.wav", storage: "local", hash: "sha256-tone" };
    store.execute({ type: "asset.add", params: { id: "tone", asset } });
    const tone = {
      id: "tone-clip",
      start: "0",
      duration: String(seconds),
      source: { kind: "audio", media: { asset: "tone" } },
    };
    const placed = store.execute({
      type: "clip.add",
      params: { timeline: "main", track: audio, ...tone },
    });
    if (!placed.ok) throw new Error(`${placed.error.code}: ${JSON.stringify(placed.error.params)}`);
  }
  const mixed: { from: number; frames: number }[] = [];
  const dialogs = new Dialogs();
  const notifications = new Notifications();
  const preview = new PreviewStatus({
    problem: () => {},
    stopped: () => {},
    revisions: () => {},
    restarted: () => {},
  });
  const file = new FakeFile();
  const compositor = new FakeCompositor();
  const writer = new FakeWriter();
  const opened: ExportCompositorOptions[] = [];
  const writerOptions: VideoFileOptions[] = [];
  const chooseFile = vi.fn<FolderAccess["chooseFile"]>(async () => file);
  const reopen = vi.fn<FolderAccess["reopen"]>(async () => file);
  /** As the host does it: the file goes, unless another export goes to the same place. */
  const dropTarget = vi.fn<FolderAccess["dropTarget"]>(async (target, others) => {
    const same = (other: unknown) => JSON.stringify(other) === JSON.stringify(target);
    if (others.some(same)) return false;
    file.abandoned = true;
    return file.failAbandon;
  });
  const folders = { chooseFile, reopen, dropTarget, savesInBrowser: false };
  const values = new Map<string, unknown>();
  const windows = new FakeWindows();
  const exports = before?.exports ?? new MemoryExports();
  windows.supported = false;
  const settings: SettingsStore = {
    load: async (key) => values.get(key),
    save: async (key, value) => void values.set(key, value),
    listen: () => () => {},
  };
  const selection = new Set<string>();
  const clipBox = { id: "c", clip: main()?.clips["c"], start: 0, end: seconds };
  const model = {
    id: "main",
    rate: { fps: 30, nominal: 30 },
    duration: seconds,
    boxes: new Map([["c", clipBox]]),
  };
  const timeline = {
    frame: 0,
    model,
    getSnapshot: () => ({ selection, model }),
    seek: vi.fn(),
    selectOnly: vi.fn(),
  };
  const videos = new VideoExport({
    session: { store, subscribe: () => () => {} } as unknown as ProjectSession,
    timeline: timeline as unknown as TimelineEditor,
    projects: { media: () => ({ get: async () => undefined }) } as unknown as ProjectLibrary,
    folders: folders as unknown as FolderAccess,
    settings,
    preview,
    dialogs,
    notifications,
    t,
    compositorUrl: "https://box.example/compositor.html",
    sceneOrigins: [],
    sceneStage: undefined,
    support: async () => true,
    compositor: (options) => {
      opened.push(options);
      return compositor;
    },
    writer: async (_, options) => {
      writerOptions.push(options);
      return writer;
    },
    soundSupport: async () => true,
    soundEncoder,
    windows,
    exports,
    sounds: { whenMade: async () => ({ state: "ready" }) },
    mixer: () => ({
      mix: async (from: number, frames: number) => {
        mixed.push({ from, frames });
        return {
          length: frames,
          numberOfChannels: 2,
          getChannelData: () => new Float32Array(frames),
        } as unknown as AudioBuffer;
      },
    }),
    ...changes,
  });
  const said = () => notifications.getSnapshot().map(({ message }) => message);
  return {
    videos,
    exports,
    windows,
    store,
    mixed,
    writerOptions,
    dialogs,
    file,
    compositor,
    writer,
    opened,
    chooseFile,
    reopen,
    dropTarget,
    folders,
    values,
    selection,
    timeline,
    said,
  };
}

type Context = ReturnType<typeof setup>;

/** Answers the dialog of the export, with its first choices unless told otherwise. */
async function answer(context: Context, changes: FormAnswer | null = {}) {
  await vi.waitFor(() => expect(context.dialogs.getSnapshot()?.kind).toBe("form"));
  const form = context.dialogs.getSnapshot() as Extract<
    ReturnType<Dialogs["getSnapshot"]>,
    { kind: "form" }
  >;
  const values = Object.fromEntries(form.fields.map(({ id, value }) => [id, value]));
  context.dialogs.answer(changes === null ? undefined : { ...values, ...changes });
  return form;
}

const notice = async ({ dialogs }: Context) => {
  await vi.waitFor(() => expect(dialogs.getSnapshot()?.kind).toBe("confirm"));
  const shown = dialogs.getSnapshot() as Extract<
    ReturnType<Dialogs["getSnapshot"]>,
    { kind: "confirm" }
  >;
  dialogs.answer(true);
  return shown;
};

beforeEach(() => {
  vi.stubGlobal("document", { baseURI: "https://editor.example/" });
  vi.stubGlobal("AudioData", FakeAudioData);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the frames of an export", () => {
  it("are as many as fit, at the rate of the format", () => {
    expect(framesOf({ from: 0, to: 2 }, { num: 30, den: 1 }).total).toBe(60);
    expect(framesOf({ from: 0, to: 2.01 }, { num: 30, den: 1 }).total).toBe(61);
    expect(framesOf({ from: 1, to: 1 }, { num: 30, den: 1 }).total).toBe(0);
    expect(framesOf({ from: 0, to: 10 }, { num: 30000, den: 1001 }).total).toBe(300);
  });

  it("start the file at zero, wherever on the timeline they are, and keep exact times", () => {
    const { at } = framesOf({ from: 2, to: 4 }, { num: 30000, den: 1001 });
    expect(at(0)).toMatchObject({ seconds: 2, timestamp: 0, keyFrame: true });
    expect(at(1)).toMatchObject({ timestamp: 33367, duration: 33366 });
    expect(at(30).timestamp).toBe(1_001_000);
  });

  it("have a key frame every two seconds", () => {
    const { at } = framesOf({ from: 0, to: 5 }, { num: 30, den: 1 });
    const keys = Array.from({ length: 150 }, (_, index) => at(index).keyFrame);
    expect(keys.flatMap((key, index) => (key ? [index] : []))).toEqual([0, 60, 120]);
  });
});

describe("exporting a video", () => {
  it("asks how first, and going back from there does nothing", async () => {
    const context = setup();
    const running = context.videos.start();
    const form = await answer(context, null);
    await running;
    expect(form.fields.map(({ id }) => id)).toEqual(["format", "range", "quality"]);
    expect(form.fields[2]?.value).toBe("standard");
    expect(context.chooseFile).not.toHaveBeenCalled();
    expect(context.opened).toEqual([]);
  });

  it("says what it does: codec, no sound, and that it takes the project as it is now", async () => {
    const context = setup();
    const running = context.videos.start();
    const form = await answer(context, null);
    await running;
    expect(form.notes?.join("\n")).toContain("export.video.codec.avc");
    expect(form.notes).toContain("export.video.sound.none");
    expect(form.notes).toContain("export.video.snapshot");
    expect(form.notes).not.toContain("export.video.noCaptions");
  });

  it("encodes every frame of the timeline, and finishes the file", async () => {
    const context = setup();
    const running = context.videos.start();
    await answer(context);
    await running;
    expect(context.compositor.frames).toHaveLength(60);
    expect(context.compositor.config).toMatchObject({ width: 640, height: 360, framerate: 30 });
    expect(context.writer.frames).toHaveLength(60);
    expect(context.writer.frames[1]?.timestamp).toBeCloseTo(1 / 30, 5);
    expect(context.writer.configs[0]).toMatchObject({ codec: context.compositor.config?.codec });
    expect(context.writer.finished).toBe(true);
    expect(context.file.finished).toBe(true);
    expect(context.file.abandoned).toBe(false);
    expect(context.compositor.disposed).toBe(true);
    expect(context.said()[0]).toContain("export.video.done");
    expect(context.videos.getSnapshot()).toBeUndefined();
  });

  it("takes the graphics card first, and says which it used", async () => {
    const context = setup();
    const running = context.videos.start();
    const form = await answer(context);
    await running;
    expect(form.notes).toContain("export.video.acceleration.hardware");
    expect(context.compositor.config?.hardwareAcceleration).toBe("prefer-hardware");
    expect(context.said()[0]).toContain("export.video.encoded.hardware");
  });

  it("goes over to the processor when the graphics card does not start", async () => {
    const context = setup();
    context.compositor.noHardware = true;
    const running = context.videos.start();
    await answer(context);
    await running;
    expect(context.compositor.config?.hardwareAcceleration).toBe("prefer-software");
    expect(context.compositor.frames).toHaveLength(60);
    expect(context.said()[0]).toContain("export.video.encoded.software");
  });

  it("asks for an MP4 by the name of the project and the format", async () => {
    const context = setup();
    const running = context.videos.start();
    await answer(context);
    await running;
    const [name, kind] = context.chooseFile.mock.calls[0] as [string, { extension: string }];
    expect(name).toContain("片子");
    expect(name).toContain("小屏");
    expect(kind.extension).toBe("mp4");
  });

  it("is WebM where only VP9 can be encoded", async () => {
    const context = setup({ support: async ({ codec }) => codec.startsWith("vp09") });
    const running = context.videos.start();
    const form = await answer(context);
    await running;
    expect(form.notes?.join("\n")).toContain("export.video.codec.vp9");
    expect(context.chooseFile.mock.calls[0]?.[1].extension).toBe("webm");
  });

  it("does not start where nothing can be encoded", async () => {
    const context = setup({ support: async () => false });
    const running = context.videos.start();
    expect((await notice(context)).message).toBe("export.video.cannotEncode");
    await running;
    expect(context.chooseFile).not.toHaveBeenCalled();
  });

  it("exports the part with the selected clips, when people say so", async () => {
    const context = setup({}, 4);
    context.selection.add("c");
    const running = context.videos.start();
    const form = await answer(context);
    await running;
    expect(form.fields[1]?.options.map(({ id }) => id)).toEqual(["all", "selection"]);
    expect(form.fields[1]?.value).toBe("selection");
    expect(context.compositor.frames).toHaveLength(120);
  });

  it("draws what is saved when it started, whatever happens to the project meanwhile", async () => {
    const context = setup();
    const hold = Promise.withResolvers<void>();
    context.compositor.hold = hold.promise;
    const running = context.videos.start();
    await answer(context);
    await vi.waitFor(() => expect(context.opened).toHaveLength(1));
    const { state, plan } = context.opened[0] as ExportCompositorOptions;
    context.store.execute({ type: "clip.remove", params: { timeline: "main", clips: ["c"] } });
    hold.resolve();
    await running;
    expect(Object.keys(state.timelines["main"]?.clips ?? {})).toHaveLength(1);
    expect(Object.keys(context.store.getState().timelines["main"]?.clips ?? {})).toHaveLength(0);
    expect(plan.layers.map(({ id }) => id)).toEqual(["c"]);
  });

  it("keeps the quality people chose for the next time", async () => {
    const context = setup();
    let running = context.videos.start();
    await answer(context, { quality: "high" });
    await running;
    expect(context.compositor.config?.bitrate).toBeGreaterThan(2_000_000);
    expect(context.values.get("export.video")).toEqual({ quality: "high" });
    running = context.videos.start();
    const form = await answer(context, null);
    await running;
    expect(form.fields[2]?.value).toBe("high");
  });

  it("says how far it is, and how long it takes", async () => {
    const context = setup();
    const hold = Promise.withResolvers<void>();
    const seen: unknown[] = [];
    context.videos.subscribe(() => seen.push(context.videos.getSnapshot()));
    context.compositor.hold = hold.promise;
    const running = context.videos.start();
    await answer(context);
    await vi.waitFor(() =>
      expect(context.videos.getSnapshot()).toMatchObject({ done: 0, total: 60 }),
    );
    hold.resolve();
    await running;
    expect(seen).toContainEqual(expect.objectContaining({ done: 30, total: 60 }));
    expect(seen).toContainEqual(
      expect.objectContaining({ done: 30, remainingMs: expect.any(Number) }),
    );
  });

  it("waits for the file when it falls behind, instead of piling frames up", async () => {
    const context = setup();
    // Frames large enough that every one fills a piece, and a disk that does not keep up.
    context.compositor.chunkBytes = 1024 * 1024;
    const release = Promise.withResolvers<void>();
    const { addPiece } = context.exports;
    context.exports.addPiece = async (id, track, piece) => {
      await release.promise;
      return addPiece.call(context.exports, id, track, piece);
    };
    const running = context.videos.start();
    await answer(context);
    await vi.waitFor(() => expect(context.compositor.frames.length).toBeGreaterThan(30));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(context.compositor.frames.length).toBeLessThanOrEqual(33);
    release.resolve();
    await running;
    expect(context.writer.frames).toHaveLength(60);
  });

  it("asks first where it would be otherwise than the project, and goes on only when people say", async () => {
    const asked: unknown[] = [];
    let go = false;
    const differences = {
      confirm: vi.fn(async (_state: unknown, query: unknown) => {
        asked.push(query);
        return go;
      }),
    };
    const context = setup({ differences });
    const stopped = context.videos.start();
    await answer(context);
    await stopped;
    expect(asked).toEqual([{ timeline: "main", format: "small", part: "both", from: 0, to: 2 }]);
    expect(context.chooseFile).not.toHaveBeenCalled();
    expect(context.writer.frames).toEqual([]);
    expect(context.videos.queue.getSnapshot()).toEqual([]);
    go = true;
    const running = context.videos.start();
    await answer(context);
    await running;
    expect(context.writer.frames).toHaveLength(60);
  });

  it("asks for one at a time", async () => {
    const context = setup();
    const running = context.videos.start();
    await vi.waitFor(() => expect(context.dialogs.getSnapshot()?.kind).toBe("form"));
    await context.videos.start();
    expect(context.said()).toContain("export.video.busy");
    await answer(context);
    await running;
  });
});

describe("the sound of a video", () => {
  it("is not there when there is nothing to hear", async () => {
    const context = setup();
    const running = context.videos.start();
    await answer(context);
    await running;
    expect(context.writerOptions[0]?.sound).toBeUndefined();
    expect(context.mixed).toEqual([]);
  });

  it("is AAC where it can be, and the dialog says so", async () => {
    const context = setup({}, 2, true);
    const running = context.videos.start();
    const form = await answer(context);
    await running;
    expect(form.notes).toContain("export.video.sound.aac");
    expect(context.writerOptions[0]?.sound).toBe("aac");
    expect(context.said()[0]).toContain("export.video.encodedWithSound");
    expect(context.mixed).toEqual([{ from: 0, frames: 96_000 }]);
    expect(context.writer.sounds).toHaveLength(1);
    expect(context.writer.sounds[0]?.duration).toBeCloseTo(2, 5);
  });

  it("is Opus in the MP4 without AAC, and the dialog says what that means", async () => {
    const context = setup({ soundSupport: async ({ codec }) => codec === "opus" }, 2, true);
    const running = context.videos.start();
    const form = await answer(context);
    await running;
    expect(form.notes).toContain("export.video.sound.opusInMp4");
    expect(context.writerOptions[0]).toMatchObject({ codec: "avc", sound: "opus" });
  });

  it("is Opus with VP9, which goes in WebM", async () => {
    const context = setup({ support: async ({ codec }) => codec.startsWith("vp09") }, 2, true);
    const running = context.videos.start();
    const form = await answer(context);
    await running;
    expect(form.notes).toContain("export.video.sound.opus");
    expect(context.writerOptions[0]).toMatchObject({ codec: "vp9", sound: "opus" });
  });

  it("is left out where it cannot be encoded, and the dialog says so", async () => {
    const context = setup({ soundSupport: async () => false }, 2, true);
    const running = context.videos.start();
    const form = await answer(context);
    await running;
    expect(form.notes).toContain("export.video.sound.cannot");
    expect(context.writerOptions[0]?.sound).toBeUndefined();
  });

  it("goes along with the picture, so that the file gets both in turns", async () => {
    const framesAtMix: number[] = [];
    const context = setup(
      {
        mixer: () => ({
          mix: async (_: number, frames: number) => {
            framesAtMix.push(context.compositor.frames.length);
            return {
              length: frames,
              numberOfChannels: 2,
              getChannelData: () => new Float32Array(frames),
            } as unknown as AudioBuffer;
          },
        }),
      },
      25,
      true,
    );
    const running = context.videos.start();
    await answer(context);
    await running;
    // The second piece of sound starts at 10 seconds, and comes once the picture is nearly there.
    expect(framesAtMix[1]).toBeGreaterThanOrEqual(9 * 30 - 1);
    expect(framesAtMix[1]).toBeLessThanOrEqual(10 * 30);
    expect(context.writer.sounds).toHaveLength(3);
    // In the file both come in turns, by time.
    const { order } = context.writer;
    const second = order.indexOf("s", order.indexOf("s") + 1);
    // The frame at ten seconds goes first, with the same time as the sound.
    expect(order.slice(0, second).filter((kind) => kind === "v")).toHaveLength(301);
  });

  it("stops where the file of a sound is missing, and goes there", async () => {
    const tone = { id: "tone-clip", file: "sha256-tone", start: 1, end: 2, offset: 0, gain: 1 };
    const context = setup(
      {
        mixer: () => ({
          mix: () => Promise.reject(new SoundFailed(tone, "missing-file")),
        }),
      },
      2,
      true,
    );
    const running = context.videos.start();
    await answer(context);
    const shown = await notice(context);
    await running;
    expect(shown.message).toContain("export.failure.missingFile");
    expect(shown.message).toContain('"frame":31');
    expect(context.timeline.seek).toHaveBeenCalledWith(30);
    // Nothing got as far as a place to go on from, which it does not say. It stays in the list to
    // be retried, with its file, which is still empty.
    expect(shown.message).not.toContain("export.video.kept");
    expect(shown.message).toContain("export.video.retry");
    expect(context.file.abandoned).toBe(false);
    expect(context.videos.queue.getSnapshot()).toMatchObject([{ status: "failed", done: 0 }]);
  });
});

describe("a sound that code makes", () => {
  /** A sound clip at one second, for a second. */
  function addMadeSound(store: ProjectStore) {
    const audio = orderedTracks(store.getState().timelines["main"] as never).find(
      ({ kind }) => kind === "audio",
    )?.id;
    const sound = { name: "铃", entry: "sound.js", runtime: 1 };
    const code = "aq.sound(({ frames }) => new Float32Array(frames));";
    store.execute({
      type: "sound.add",
      params: { id: "s", manifest: sound, files: { "sound.js": code } },
    });
    const clip = {
      id: "bell",
      start: "1",
      duration: "1",
      source: { kind: "sound", sound: "s" },
      properties: { "param.duration": 1 },
    };
    const placed = store.execute({
      type: "clip.add",
      params: { timeline: "main", track: audio, ...clip },
    });
    if (!placed.ok) throw new Error(`${placed.error.code}: ${JSON.stringify(placed.error.params)}`);
  }

  it("is waited for, with the export saying so, and stops it where it does not come", async () => {
    const asked: string[] = [];
    const made = Promise.withResolvers<{ state: "failed"; reason: "time" }>();
    const context = setup({
      sounds: {
        whenMade: (sound, state) => {
          asked.push(`${sound.sound}@${state.manifest.name}`);
          return made.promise;
        },
      },
      mixer: (plan, source) => ({
        mix: async (_: number, frames: number) => {
          for (const sound of plan.sounds) await source(sound);
          return {
            length: frames,
            numberOfChannels: 2,
            getChannelData: () => new Float32Array(frames),
          } as unknown as AudioBuffer;
        },
      }),
    });
    addMadeSound(context.store);
    const bell = context.store.getState().timelines["main"]?.clips["bell"];
    (context.timeline.model.boxes as Map<string, unknown>).set("bell", { id: "bell", clip: bell });
    const running = context.videos.start();
    await answer(context);
    await vi.waitFor(() => expect(context.videos.getSnapshot()?.makingSound).toBe(true));
    expect(asked).toEqual(["s@片子"]);
    made.resolve({ state: "failed", reason: "time" });
    const shown = await notice(context);
    await running;
    expect(shown.message).toContain("sound.failed.time");
    expect(shown.message).toContain("铃");
    expect(shown.message).toContain('"frame":31');
  });
});

describe("an export that does not finish", () => {
  it("stops when people say so, and leaves no file", async () => {
    const context = setup();
    const hold = Promise.withResolvers<void>();
    context.compositor.hold = hold.promise;
    const running = context.videos.start();
    await answer(context);
    await vi.waitFor(() => expect(context.videos.getSnapshot()).toBeDefined());
    context.videos.cancel();
    expect(context.videos.getSnapshot()?.stopping).toBe(true);
    await running;
    expect(context.file.abandoned).toBe(true);
    expect(context.file.finished).toBe(false);
    // Nothing got to the file: it only gets written once everything is encoded.
    expect(context.writerOptions).toEqual([]);
    expect(context.exports.saved.size).toBe(0);
    expect(context.compositor.disposed).toBe(true);
    expect(context.said()).toEqual(["export.video.cancelled"]);
    expect(context.videos.getSnapshot()).toBeUndefined();
  });

  it("says when what it wrote has to stay", async () => {
    const context = setup();
    context.file.failAbandon = true;
    const hold = Promise.withResolvers<void>();
    context.compositor.hold = hold.promise;
    const running = context.videos.start();
    await answer(context);
    await vi.waitFor(() => expect(context.videos.getSnapshot()).toBeDefined());
    context.videos.cancel();
    expect((await notice(context)).message).toContain("export.video.leftBehind");
    await running;
  });

  it("stops at a frame without a picture, and takes people there", async () => {
    const context = setup();
    context.compositor.failAt = {
      index: 45,
      failure: { reason: "missing-file", layer: "c", file: "a" },
    };
    const running = context.videos.start();
    await answer(context);
    const shown = await notice(context);
    await running;
    expect(shown.title).toBe("export.video.failed");
    expect(shown.message).toContain("export.video.failedAt");
    expect(shown.message).toContain('"frame":46');
    expect(shown.message).toContain("0:01/15");
    expect(shown.message).toContain("export.failure.missingFile");
    expect(context.timeline.seek).toHaveBeenCalledWith(45);
    expect(context.timeline.selectOnly).toHaveBeenCalledWith("c");
    expect(context.compositor.frames).toHaveLength(45);
    // Nothing got as far as a place to go on from, which it does not say. It stays in the list,
    // failed, to be retried with the same choices and the same file.
    expect(shown.message).not.toContain("export.video.kept");
    expect(shown.message).toContain("export.video.retry");
    expect(context.file.abandoned).toBe(false);
    const [kept] = await context.exports.all();
    expect(stateOf(kept)?.queue).toMatchObject({ status: "failed" });
    expect(stateOf(kept)?.queue?.failure).toContain("export.failure.missingFile");
    expect(context.writer.finished).toBe(false);
  });

  it("stops where a join is that this editor cannot do, and takes people there", async () => {
    const context = setup();
    const { store } = context;
    const main = store.getState().timelines["main"];
    const track = orderedTracks(main as never).find(({ kind }) => kind === "video")?.id;
    const next = {
      id: "d",
      start: "2",
      duration: "1",
      source: { kind: "color", color: "#00ff00" },
    };
    store.execute({ type: "clip.add", params: { timeline: "main", track, ...next } });
    const path = "timelines/main/timeline.json";
    const timeline = JSON.parse(store.exportFiles().files.get(path) as string);
    const video = timeline.tracks.find(({ kind }: { kind: string }) => kind === "video");
    video.joins = [{ id: "j", from: "c", to: "d", library: "lib", resource: "ink", duration: "1" }];
    expect(store.importFile(path, JSON.stringify(timeline), { origin: USER }).ok).toBe(true);
    const running = context.videos.start();
    await answer(context);
    const shown = await notice(context);
    await running;
    expect(shown.title).toBe("export.video.failed");
    expect(shown.message).toContain("export.failure.join");
    // Half of it is before the cut at two seconds.
    expect(shown.message).toContain('"frame":46');
    expect(context.timeline.seek).toHaveBeenCalledWith(45);
    expect(context.timeline.selectOnly).toHaveBeenCalledWith("c");
    expect(context.compositor.frames).toHaveLength(45);
  });

  it("stops where a transition of sound is, which this editor does not play yet", async () => {
    const silence = () => ({
      mix: async (_: number, frames: number) =>
        ({
          length: frames,
          numberOfChannels: 2,
          getChannelData: () => new Float32Array(frames),
        }) as unknown as AudioBuffer,
    });
    const context = setup({ mixer: silence }, 2, true);
    const { store } = context;
    const path = "timelines/main/timeline.json";
    const timeline = JSON.parse(store.exportFiles().files.get(path) as string);
    const audio = timeline.tracks.find(({ kind }: { kind: string }) => kind === "audio");
    audio.clips[0].exit = { type: "fade", duration: "1/2" };
    expect(store.importFile(path, JSON.stringify(timeline), { origin: USER }).ok).toBe(true);
    const running = context.videos.start();
    await answer(context);
    const shown = await notice(context);
    await running;
    expect(shown.message).toContain("export.failure.soundTransition");
    expect(shown.message).toContain('"frame":46');
    expect(context.compositor.frames).toHaveLength(45);
  });

  it("stops when the file does not take what it gets", async () => {
    const context = setup();
    context.writer.failAt = 10;
    const running = context.videos.start();
    await answer(context);
    const shown = await notice(context);
    await running;
    expect(shown.message).toContain("export.video.writeFailed");
    expect(shown.message).toContain("disk full");
    // What it got to stays, for after what went wrong is put right.
    expect(context.file.abandoned).toBe(false);
    expect(context.exports.saved.size).toBe(1);
  });

  it("stops when this device has no room to keep what it does", async () => {
    const context = setup();
    context.compositor.chunkBytes = 1024 * 1024;
    context.exports.failingPieces = true;
    const running = context.videos.start();
    await answer(context);
    const shown = await notice(context);
    await running;
    expect(shown.message).toContain("export.video.writeFailed");
    expect(context.compositor.frames.length).toBeLessThan(60);
    // Nothing got as far as a place to go on from. It stays in the list, without any piece.
    expect(shown.message).not.toContain("export.video.kept");
    expect(context.file.abandoned).toBe(false);
    expect(context.exports.saved.size).toBe(1);
    expect(context.exports.count([...context.exports.saved.keys()][0] ?? "", "video")).toBe(0);
  });

  it("stops when the compositor goes away", async () => {
    const context = setup();
    context.compositor.encodeFrame = () =>
      Promise.reject(new StillFailed({ reason: "compositor" }));
    const running = context.videos.start();
    await answer(context);
    const shown = await notice(context);
    expect(shown.message).toContain("export.failure.compositor");
    await running;
    expect(shown.message).not.toContain("export.video.kept");
    expect(context.file.abandoned).toBe(false);
    expect(context.videos.queue.getSnapshot()).toMatchObject([{ status: "failed" }]);
  });

  it("keeps what it got to when that is a place to go on from, and says so", async () => {
    const context = setup({}, 20);
    context.compositor.failAt = {
      index: 400,
      failure: { reason: "missing-file", layer: "c", file: "a" },
    };
    const running = context.videos.start();
    await answer(context);
    const shown = await notice(context);
    await running;
    expect(shown.message).toContain("export.video.kept");
    expect(context.file.abandoned).toBe(false);
    expect(context.exports.saved.size).toBe(1);
  });

  it("says that the storage of the browser is full when the first place to go on from does not fit", async () => {
    const context = setup({}, 20);
    context.exports.save = async () => {
      throw new DOMException("full", "QuotaExceededError");
    };
    const running = context.videos.start();
    await answer(context);
    const shown = await notice(context);
    await running;
    expect(shown.message).toContain("export.storage.full");
    expect(shown.message).not.toContain("export.video.kept");
    expect(context.file.abandoned).toBe(true);
  });

  it("says that the storage of the browser is full when a later place to go on from does not fit", async () => {
    const context = setup({}, 20);
    const save = context.exports.save.bind(context.exports);
    let saves = 0;
    context.exports.save = async (saved) => {
      saves += 1;
      if (saves === 2) throw new DOMException("full", "QuotaExceededError");
      return save(saved);
    };
    const running = context.videos.start();
    await answer(context);
    const shown = await notice(context);
    await running;
    expect(shown.message).toContain("export.storage.full");
  });

  it("leaves no pieces behind when it is stopped while some are on their way to the disk", async () => {
    const context = setup({}, 20);
    context.compositor.chunkBytes = 300 * 1024;
    const addPiece = context.exports.addPiece.bind(context.exports);
    const slow = Promise.withResolvers<void>();
    let pieces = 0;
    context.exports.addPiece = async (id, track, piece) => {
      pieces += 1;
      // The disk is slow for a moment, as it is now and then.
      if (pieces === 3) await slow.promise;
      return addPiece(id, track, piece);
    };
    const running = context.videos.start();
    await answer(context);
    await vi.waitFor(() => expect(pieces).toBeGreaterThanOrEqual(3));
    context.videos.cancel();
    await running;
    slow.resolve();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const left = [...context.exports.kept.values()].flatMap((tracks) =>
      [...tracks.values()].map((each) => each.size),
    );
    expect(left.filter((count) => count > 0)).toEqual([]);
    expect(await context.exports.all()).toEqual([]);
  });

  it("does not hold a compositor that stops answering against the graphics card", async () => {
    const context = setup();
    const start = context.compositor.startEncoding.bind(context.compositor);
    let calls = 0;
    context.compositor.startEncoding = async (config, onChunk, onWrong) => {
      calls += 1;
      // As after the watch gave up on it: every request fails from then on.
      if (calls <= 1) throw new StillFailed({ reason: "compositor" });
      return start(config, onChunk, onWrong);
    };
    const running = context.videos.start();
    await answer(context);
    const shown = await notice(context);
    await running;
    expect(shown.message).toContain("export.failure.compositor");
    expect(context.values.get("export.hardwareFailed")).toBeUndefined();
    const again = context.videos.start();
    // The one that failed is offered first, and left for later.
    await vi.waitFor(() => expect(context.dialogs.getSnapshot()?.kind).toBe("choice"));
    context.dialogs.answer(undefined);
    const form = await answer(context);
    await again;
    expect(form.notes).toContain("export.video.acceleration.hardware");
  });

  it("stops and says so when what it keeps is cleared while it runs", async () => {
    const context = setup({}, 20);
    context.compositor.chunkBytes = 100 * 1024;
    const encode = context.compositor.encodeFrame.bind(context.compositor);
    const gate = Promise.withResolvers<void>();
    let reached = false;
    context.compositor.encodeFrame = async (frame) => {
      if (frame.index === 320 && !reached) {
        reached = true;
        await gate.promise;
      }
      return encode(frame);
    };
    const running = context.videos.start();
    await answer(context);
    await vi.waitFor(() => expect(reached).toBe(true));
    const [saved] = await context.exports.all();
    await context.exports.remove(saved?.id ?? "");
    gate.resolve();
    const shown = await notice(context);
    await running;
    expect(shown.message).toContain("export.video.notKept");
    expect(shown.message).not.toContain("export.video.kept");
    expect(shown.message).not.toContain("export.video.writeFailed");
    expect(await context.exports.all()).toEqual([]);
    expect(context.file.abandoned).toBe(true);
  });

  it("does not start without a file", async () => {
    const context = setup();
    context.chooseFile.mockResolvedValueOnce(undefined);
    const running = context.videos.start();
    await answer(context);
    await running;
    expect(context.opened).toEqual([]);
  });
});

describe("the window of an export", () => {
  const withWindows = (changes: Partial<VideoExportOptions> = {}) => {
    const context = setup(changes);
    context.windows.supported = true;
    return context;
  };

  it("is where the compositor goes, opened right away after the button for exporting", async () => {
    const context = withWindows();
    const places = new Set<string | undefined>();
    context.videos.subscribe(() => places.add(context.videos.getSnapshot()?.place));
    const running = context.videos.start();
    const form = await answer(context);
    await running;
    expect(places).toContain("window");
    expect(form.notes).toContain("export.window.inWindow");
    const [opened] = context.windows.opened;
    expect(context.opened[0]?.document).toBe(opened?.document);
    expect(context.compositor.frames).toHaveLength(60);
    expect(opened?.closes).toBeGreaterThan(0);
  });

  it("takes a press of a button when the browser wants one", async () => {
    const context = withWindows();
    context.windows.activation = false;
    const running = context.videos.start();
    await answer(context);
    await vi.waitFor(() => expect(context.dialogs.getSnapshot()?.kind).toBe("choice"));
    expect(context.windows.opened).toHaveLength(0);
    context.dialogs.answer("window");
    await running;
    expect(context.windows.opened).toHaveLength(1);
    expect(context.opened[0]?.document).toBe(context.windows.opened[0]?.document);
  });

  it("stays on this page when people say so, or when the browser does not open one", async () => {
    for (const how of ["page", "refused"] as const) {
      const context = withWindows();
      context.windows.activation = false;
      context.windows.refuse = how === "refused";
      const running = context.videos.start();
      await answer(context);
      await vi.waitFor(() => expect(context.dialogs.getSnapshot()?.kind).toBe("choice"));
      context.dialogs.answer(how === "page" ? "page" : "window");
      await running;
      expect(context.opened[0]?.document).toBe(document);
      expect(context.compositor.frames).toHaveLength(60);
    }
  });

  it("is not there in a browser without one, which says to stay in front", async () => {
    const context = setup();
    const running = context.videos.start();
    const form = await answer(context);
    await running;
    expect(form.notes).toContain("export.window.noWindow");
    expect(context.opened[0]?.document).toBe(document);
  });

  it("leaves no file when people go back instead of choosing", async () => {
    const context = withWindows();
    context.windows.activation = false;
    const running = context.videos.start();
    await answer(context);
    await vi.waitFor(() => expect(context.dialogs.getSnapshot()?.kind).toBe("choice"));
    context.dialogs.answer(undefined);
    await running;
    expect(context.file.abandoned).toBe(true);
    expect(context.opened).toEqual([]);
  });

  describe("closed while the export goes on", () => {
    const closing = () => {
      const context = withWindows();
      context.compositor.lag = 2;
      context.compositor.closeAt = 30;
      return context;
    };

    it("pauses, keeps what was written, and says how to go on", async () => {
      const context = closing();
      const running = context.videos.start();
      await answer(context);
      await vi.waitFor(() => expect(context.videos.getSnapshot()?.paused).toBe(true));
      expect(context.said()).toContain("export.window.paused");
      expect(context.file.abandoned).toBe(false);
      // Two frames were still in the encoder when the window went.
      expect(context.videos.getSnapshot()?.done).toBe(28);
      context.videos.cancel();
      await running;
    });

    it("goes on in a new window from the first frame that did not make it", async () => {
      const context = closing();
      const running = context.videos.start();
      await answer(context);
      await vi.waitFor(() => expect(context.videos.getSnapshot()?.paused).toBe(true));
      context.videos.resume();
      await running;
      expect(context.windows.opened).toHaveLength(2);
      expect(context.compositor.starts).toBe(2);
      expect(context.opened[1]?.document).toBe(context.windows.opened[1]?.document);
      const times = context.writer.frames.map(({ timestamp }) => Math.round(timestamp * 30));
      expect(times).toEqual(Array.from({ length: 60 }, (_, index) => index));
      // A new encoder starts with a key frame, wherever that is.
      expect(context.writer.frames[28]?.key).toBe(true);
      expect(context.file.finished).toBe(true);
      expect(context.said().at(-1)).toContain("export.video.done");
    });

    it("can be stopped while it waits, and then leaves no file", async () => {
      const context = closing();
      const running = context.videos.start();
      await answer(context);
      await vi.waitFor(() => expect(context.videos.getSnapshot()?.paused).toBe(true));
      context.videos.cancel();
      await running;
      expect(context.file.abandoned).toBe(true);
      expect(context.said()).toContain("export.video.cancelled");
    });

    it("goes on in this page when the browser does not open another window", async () => {
      const context = closing();
      const running = context.videos.start();
      await answer(context);
      await vi.waitFor(() => expect(context.videos.getSnapshot()?.paused).toBe(true));
      context.windows.refuse = true;
      context.videos.resume();
      await running;
      expect(context.opened[1]?.document).toBe(document);
      expect(context.writer.frames).toHaveLength(60);
    });

    it("starts over when the new encoder encodes another way, as after a reload", async () => {
      const context = closing();
      const running = context.videos.start();
      await answer(context);
      await vi.waitFor(() => expect(context.videos.getSnapshot()?.paused).toBe(true));
      context.compositor.description = [9, 9];
      context.videos.resume();
      await running;
      // As after a reload: it starts over, and says so.
      expect(context.said()).toContain("export.resume.encoderChanged");
      const times = context.writer.frames.map(({ timestamp }) => Math.round(timestamp * 30));
      expect(times).toEqual(Array.from({ length: 60 }, (_, index) => index));
      expect(context.file.finished).toBe(true);
    });
  });
});

describe("an export that stopped halfway", () => {
  /** Exports 20 seconds, which has a place to go on from at 10, and the page goes away at 12. */
  const crashed = async (sound = false) => {
    const first = setup({}, 20, sound);
    first.compositor.crashAt = 360;
    // As from a real encoder: what comes out lags behind what goes in, until it is emptied.
    first.compositor.lag = 2;
    // Large enough that there are pieces after the last place to go on from, too.
    first.compositor.chunkBytes = 512 * 1024;
    void first.videos.start();
    await answer(first);
    await vi.waitFor(() =>
      expect(
        (first.exports.saved.values().next().value?.state as { progress: { frame: number } })
          ?.progress.frame,
      ).toBe(300),
    );
    await vi.waitFor(() => expect(first.compositor.frames).toHaveLength(360));
    // A page that goes away lets go of what it held.
    first.exports.claimed.clear();
    const next = setup({}, 20, sound, first);
    return { first, next };
  };

  const offered = async (context: Context, choice: string | undefined) => {
    const offering = context.videos.offerResume();
    await vi.waitFor(() => expect(context.dialogs.getSnapshot()?.kind).toBe("choice"));
    const shown = context.dialogs.getSnapshot() as Extract<
      ReturnType<Dialogs["getSnapshot"]>,
      { kind: "choice" }
    >;
    context.dialogs.answer(choice);
    return { shown, offering };
  };

  it("is offered to go on, with how far it got", async () => {
    const { next } = await crashed();
    const { shown, offering } = await offered(next, undefined);
    await offering;
    expect(shown.title).toBe("export.resume.title");
    expect(shown.message).toContain('"frame":300');
    expect(shown.message).toContain('"total":600');
    // Going back from there leaves it for the next time.
    expect(next.exports.saved.size).toBe(1);
  });

  it("goes on from the last place it could, and the file has it all, in order", async () => {
    const { first, next } = await crashed();
    const { offering } = await offered(next, "continue");
    await offering;
    expect(next.reopen).toHaveBeenCalledOnce();
    expect(next.compositor.frames[0]).toMatchObject({ index: 300, keyFrame: true });
    expect(next.compositor.frames).toHaveLength(300);
    const times = next.writer.frames.map(({ timestamp }) => Math.round(timestamp * 30));
    expect(times).toEqual(Array.from({ length: 600 }, (_, index) => index));
    // The bytes of the first part are those of the first page.
    expect(next.writer.frames[299]?.data[0]).toBe(299 % 256);
    expect(next.writer.configs[0]).toMatchObject({ codec: next.compositor.config?.codec });
    expect(next.file.finished).toBe(true);
    expect(next.exports.saved.size).toBe(0);
    expect(next.exports.count([...first.exports.kept.keys()][0] ?? "", "video")).toBe(0);
  });

  it("makes the sound again from the start, so that it has no seam", async () => {
    const { next } = await crashed(true);
    const { offering } = await offered(next, "continue");
    await offering;
    expect(next.mixed[0]).toEqual({ from: 0, frames: 480_000 });
    expect(next.writer.sounds.map(({ timestamp }) => timestamp)).toEqual([0, 10]);
  });

  it("asks before it goes on with a project that changed since", async () => {
    const { next } = await crashed();
    next.store.execute({ type: "project.rename", params: { name: "改了" } });
    const { offering } = await offered(next, "continue");
    await vi.waitFor(() =>
      expect(next.dialogs.getSnapshot()).toMatchObject({ title: "export.resume.changedTitle" }),
    );
    next.dialogs.answer("again");
    await offering;
    // From the start, with what there is now.
    expect(next.compositor.frames[0]?.index).toBe(0);
    expect(next.compositor.frames).toHaveLength(600);
    expect(next.writer.frames).toHaveLength(600);
  });

  it("exports the whole timeline as it is now when it starts over with what there is now", async () => {
    const { next } = await crashed();
    const main = () => next.store.getState().timelines["main"];
    const track = orderedTracks(main() as never).find(({ kind }) => kind === "video")?.id;
    const longer = {
      id: "d",
      start: "20",
      duration: "5",
      source: { kind: "color", color: "#0000ff" },
    };
    next.store.execute({ type: "clip.add", params: { timeline: "main", track, ...longer } });
    const { offering } = await offered(next, "continue");
    await vi.waitFor(() =>
      expect(next.dialogs.getSnapshot()).toMatchObject({ title: "export.resume.changedTitle" }),
    );
    next.dialogs.answer("again");
    await offering;
    expect(next.writer.frames).toHaveLength(750);
  });

  it("can be given up when the project changed", async () => {
    const { next } = await crashed();
    next.store.execute({ type: "project.rename", params: { name: "改了" } });
    const { offering } = await offered(next, "continue");
    await vi.waitFor(() =>
      expect(next.dialogs.getSnapshot()).toMatchObject({ title: "export.resume.changedTitle" }),
    );
    next.dialogs.answer("discard");
    await offering;
    expect(next.exports.saved.size).toBe(0);
    expect(next.compositor.frames).toEqual([]);
    expect(next.file.abandoned).toBe(true);
  });

  it("goes somewhere else when the file is gone", async () => {
    const { next } = await crashed();
    next.reopen.mockResolvedValueOnce("gone");
    const { offering } = await offered(next, "continue");
    await vi.waitFor(() =>
      expect(next.dialogs.getSnapshot()).toMatchObject({ title: "export.resume.goneTitle" }),
    );
    next.dialogs.answer("choose");
    await offering;
    expect(next.chooseFile).toHaveBeenCalledOnce();
    expect(next.compositor.frames[0]?.index).toBe(300);
    expect(next.writer.frames).toHaveLength(600);
  });

  it("starts over when the encoder now encodes another way, and says so", async () => {
    const { next } = await crashed();
    next.compositor.description = [7, 7, 7];
    const { offering } = await offered(next, "continue");
    await offering;
    expect(next.said()).toContain("export.resume.encoderChanged");
    expect(next.compositor.frames[0]?.index).toBe(300);
    expect(next.compositor.frames.at(-600)).toMatchObject({ index: 0, keyFrame: true });
    const times = next.writer.frames.map(({ timestamp }) => Math.round(timestamp * 30));
    expect(times).toEqual(Array.from({ length: 600 }, (_, index) => index));
    const description = next.writer.configs[0]?.description as Uint8Array | undefined;
    expect(description && [...description]).toEqual([7, 7, 7]);
  });

  it("starts over cleanly when what the old encoder still gave comes after it found out", async () => {
    const { next } = await crashed();
    next.compositor.description = [7, 7, 7];
    next.compositor.late = true;
    const { offering } = await offered(next, "continue");
    await offering;
    expect(next.said()).toContain("export.resume.encoderChanged");
    expect(next.said().join()).not.toContain("export.video.wrongOutput");
    const times = next.writer.frames.map(({ timestamp }) => Math.round(timestamp * 30));
    expect(times).toEqual(Array.from({ length: 600 }, (_, index) => index));
  });

  it("given up when people chose to export asks nothing more", async () => {
    const { next } = await crashed();
    const running = next.videos.start();
    await vi.waitFor(() => expect(next.dialogs.getSnapshot()?.kind).toBe("choice"));
    next.dialogs.answer("discard");
    await running;
    expect(next.dialogs.getSnapshot()).toBeUndefined();
    expect(await next.exports.all()).toEqual([]);
  });

  it("goes on with the processor after a reload when the processor had taken over", async () => {
    /** Hardware describes its stream as [1,2,3], the processor as [9,9,9]; hardware fails at 450. */
    const flaky = (context: Context) => {
      const start = context.compositor.startEncoding.bind(context.compositor);
      context.compositor.startEncoding = async (config, onChunk, onWrong) => {
        context.compositor.description =
          config.hardwareAcceleration === "prefer-software" ? [9, 9, 9] : [1, 2, 3];
        return start(config, onChunk, onWrong);
      };
      const encode = context.compositor.encodeFrame.bind(context.compositor);
      context.compositor.encodeFrame = async (frame) => {
        if (
          context.compositor.config?.hardwareAcceleration === "prefer-hardware" &&
          frame.index === 450
        ) {
          throw new StillFailed({ reason: "encoder", message: "Encoder failure." });
        }
        return encode(frame);
      };
    };
    const first = setup({}, 30);
    flaky(first);
    // The processor takes over, starts over from 0, and the page goes away at frame 500 of it.
    first.compositor.crashAt = 500;
    const configs: (string | undefined)[] = [];
    void first.videos.start();
    await answer(first);
    await vi.waitFor(() =>
      expect(first.compositor.frames.filter(({ index }) => index === 499).length).toBeGreaterThan(
        0,
      ),
    );
    // What it kept was encoded by the processor, after the graphics card failed.
    const kept = first.exports.saved.values().next().value?.state as SavedState | undefined;
    expect(kept?.progress.acceleration).toBe("software");
    first.exports.claimed.clear();
    const next = setup({}, 30, false, first);
    // The same browser: what it remembers is there too.
    for (const [key, value] of first.values) next.values.set(key, value);
    flaky(next);
    const start = next.compositor.startEncoding.bind(next.compositor);
    next.compositor.startEncoding = async (config, onChunk, onWrong) => {
      configs.push(config.hardwareAcceleration);
      return start(config, onChunk, onWrong);
    };
    const offering = next.videos.offerResume();
    await vi.waitFor(() => expect(next.dialogs.getSnapshot()?.kind).toBe("choice"));
    next.dialogs.answer("continue");
    await offering;
    expect(configs[0]).toBe("prefer-software");
    expect(next.said()).not.toContain("export.resume.encoderChanged");
    expect(next.said().join()).toContain("export.video.encoded.software");
    const times = next.writer.frames.map(({ timestamp }) => Math.round(timestamp * 30));
    expect(times).toEqual(Array.from({ length: 900 }, (_, index) => index));
  });

  it("starts over once more with the processor when the graphics card fails after a start over", async () => {
    const first = setup({}, 20);
    first.compositor.crashAt = 360;
    first.compositor.lag = 2;
    void first.videos.start();
    await answer(first);
    await vi.waitFor(() => expect(first.compositor.frames).toHaveLength(360));
    first.exports.claimed.clear();
    const next = setup({}, 20, false, first);
    // This browser now encodes another way, so it starts over from the first frame.
    next.compositor.description = [7, 7, 7];
    const start = next.compositor.startEncoding.bind(next.compositor);
    next.compositor.startEncoding = async (config, onChunk, onWrong) => {
      // The processor describes its stream in its own way, as OpenH264 does next to a driver.
      if (config.hardwareAcceleration === "prefer-software")
        next.compositor.description = [9, 9, 9];
      return start(config, onChunk, onWrong);
    };
    const encode = next.compositor.encodeFrame.bind(next.compositor);
    let hardwareFrames = 0;
    next.compositor.encodeFrame = async (frame) => {
      if (next.compositor.config?.hardwareAcceleration === "prefer-hardware") {
        hardwareFrames += 1;
        // After the start over, at frame 450.
        if (hardwareFrames > 1 && frame.index === 450) {
          throw new StillFailed({ reason: "encoder", message: "Encoder failure." });
        }
      }
      return encode(frame);
    };
    const offering = next.videos.offerResume();
    await vi.waitFor(() => expect(next.dialogs.getSnapshot()?.kind).toBe("choice"));
    next.dialogs.answer("continue");
    await offering;
    expect(next.said().join()).toContain("export.video.encoded.software");
    const times = next.writer.frames.map(({ timestamp }) => Math.round(timestamp * 30));
    expect(times).toEqual(Array.from({ length: 600 }, (_, index) => index));
  });

  it("says that the graphics card failed before, and tries it again when people say so", async () => {
    const context = setup();
    context.compositor.noHardware = true;
    const first = context.videos.start();
    await answer(context);
    await first;
    expect(context.values.get("export.hardwareFailed")).toMatchObject({
      failed: { avc: expect.any(Number) },
    });
    context.compositor.noHardware = false;
    const retry = context.videos.start();
    await vi.waitFor(() => expect(context.dialogs.getSnapshot()?.kind).toBe("form"));
    const form = context.dialogs.getSnapshot() as Extract<
      ReturnType<Dialogs["getSnapshot"]>,
      { kind: "form" }
    >;
    expect(form.fields.map(({ id }) => id)).toContain("card");
    context.dialogs.answer({
      ...Object.fromEntries(form.fields.map(({ id, value }) => [id, value])),
      card: "retry",
    });
    await retry;
    expect(context.compositor.config?.hardwareAcceleration).toBe("prefer-hardware");
    expect(context.values.get("export.hardwareFailed")).toMatchObject({ failed: {} });
  });

  it("does not write into a file that has something else in it now, and asks for another place", async () => {
    const { next } = await crashed();
    next.reopen.mockResolvedValueOnce("taken");
    const offering = next.videos.offerResume();
    await vi.waitFor(() => expect(next.dialogs.getSnapshot()?.kind).toBe("choice"));
    next.dialogs.answer("continue");
    await vi.waitFor(() =>
      expect((next.dialogs.getSnapshot() as { message?: string } | undefined)?.message).toContain(
        "export.resume.taken",
      ),
    );
    next.dialogs.answer(undefined);
    await offering;
    expect(next.compositor.frames).toEqual([]);
  });

  it("can be given up, and leaves nothing", async () => {
    const { first, next } = await crashed();
    const { offering } = await offered(next, "discard");
    await offering;
    expect(next.exports.saved.size).toBe(0);
    expect(next.exports.count([...first.exports.kept.keys()][0] ?? "", "video")).toBe(0);
    expect(next.file.abandoned).toBe(true);
    expect(next.said()).toContain("export.resume.discarded");
  });

  it("is not offered while another window is at it", async () => {
    const first = setup({}, 20);
    first.compositor.crashAt = 360;
    void first.videos.start();
    await answer(first);
    await vi.waitFor(() => expect(first.compositor.frames).toHaveLength(360));
    const next = setup({}, 20, false, first);
    await next.videos.offerResume();
    expect(next.dialogs.getSnapshot()).toBeUndefined();
  });
});

describe("an export and the windows around it", () => {
  const crashedAt = async (frame: number) => {
    const first = setup({}, 20);
    first.compositor.crashAt = frame;
    first.compositor.lag = 2;
    void first.videos.start();
    await answer(first);
    await vi.waitFor(() => expect(first.compositor.frames).toHaveLength(frame));
    first.exports.claimed.clear();
    return first;
  };

  const choice = (context: Context) =>
    vi.waitFor(() => expect(context.dialogs.getSnapshot()?.kind).toBe("choice"));

  it("asks in one window at a time, so that two never do two things with one export", async () => {
    const first = await crashedAt(360);
    const one = setup({}, 20, false, first);
    const other = setup({}, 20, false, first);
    const asking = one.videos.offerResume();
    await choice(one);
    await other.videos.offerResume();
    expect(other.dialogs.getSnapshot()).toBeUndefined();
    one.dialogs.answer("continue");
    await asking;
    expect(one.writer.frames).toHaveLength(600);
  });

  it("gives up only what nobody is at", async () => {
    const first = await crashedAt(360);
    const one = setup({}, 20, false, first);
    const other = setup({}, 20, false, first);
    const hold = Promise.withResolvers<void>();
    one.compositor.hold = hold.promise;
    const asking = one.videos.offerResume();
    await choice(one);
    one.dialogs.answer("continue");
    await vi.waitFor(() => expect(one.videos.getSnapshot()).toBeDefined());
    // The other window does not get to give it up while this one goes on.
    await other.videos.offerResume();
    expect(other.dialogs.getSnapshot()).toBeUndefined();
    expect(other.windows.opened).toHaveLength(0);
    hold.resolve();
    await asking;
    const times = one.writer.frames.map(({ timestamp }) => Math.round(timestamp * 30));
    expect(times).toEqual(Array.from({ length: 600 }, (_, index) => index));
  });

  it("comes first when people export again, and no second export starts next to it", async () => {
    const first = await crashedAt(360);
    const next = setup({}, 20, false, first);
    const starting = next.videos.start();
    await vi.waitFor(() => expect(next.dialogs.getSnapshot()?.kind).toBe("choice"));
    // Asking again meanwhile asks nothing more.
    await next.videos.offerResume();
    expect(next.dialogs.getSnapshot()?.kind).toBe("choice");
    next.dialogs.answer("continue");
    await starting;
    expect(next.opened).toHaveLength(1);
    expect(next.compositor.frames[0]?.index).toBe(300);
  });

  it("does not ask about one that stopped while a new one is being started", async () => {
    const first = await crashedAt(360);
    const next = setup({}, 20, false, first);
    const starting = next.videos.start();
    await vi.waitFor(() => expect(next.dialogs.getSnapshot()?.kind).toBe("choice"));
    // People leave the old one for later, and go on to a new export.
    next.dialogs.answer(undefined);
    await vi.waitFor(() => expect(next.dialogs.getSnapshot()?.kind).toBe("form"));
    const asking = next.videos.offerResume();
    let asked = 0;
    next.dialogs.subscribe(() => {
      if (next.dialogs.getSnapshot()?.kind === "choice") asked += 1;
    });
    await answer(next);
    await starting;
    await asking;
    expect(asked).toBe(0);
    expect(next.opened).toHaveLength(1);
  });

  it("is drawn from the project as it was when its snapshot was taken", async () => {
    const first = setup({}, 20);
    first.compositor.crashAt = 360;
    void first.videos.start();
    await vi.waitFor(() => expect(first.dialogs.getSnapshot()?.kind).toBe("form"));
    // Another window renames the project while people choose how to export.
    first.store.execute({ type: "project.rename", params: { name: "改了" } });
    await answer(first);
    await vi.waitFor(() => expect(first.compositor.frames).toHaveLength(360));
    expect(first.opened[0]?.state.manifest.name).toBe("改了");
    first.exports.claimed.clear();
    const next = setup({}, 20, false, first);
    const { offering } = await offeredNow(next, "continue");
    await offering;
    // Nothing changed since the snapshot, so it goes on without asking.
    expect(next.compositor.frames[0]?.index).toBe(300);
    expect(next.opened[0]?.state.manifest.name).toBe("改了");
  });

  it("keeps a place to go on from that fits, right after it started over", async () => {
    const first = await crashedAt(360);
    const next = setup({}, 20, false, first);
    next.compositor.description = [7, 7, 7];
    next.compositor.chunkBytes = 512 * 1024;
    next.compositor.crashAt = 100;
    void offeredNow(next, "continue");
    await vi.waitFor(() => expect(next.said()).toContain("export.resume.encoderChanged"));
    await vi.waitFor(() =>
      expect(next.compositor.frames.filter(({ index }) => index < 100)).toHaveLength(100),
    );
    const saved = [...first.exports.saved.values()][0]?.state as SavedState;
    expect(saved.progress).toMatchObject({ frame: 0, videoPieces: 0 });
    next.exports.claimed.clear();
    const third = setup({}, 20, false, first);
    third.compositor.description = [1, 2, 3];
    const { offering } = await offeredNow(third, "continue");
    await offering;
    const times = third.writer.frames.map(({ timestamp }) => Math.round(timestamp * 30));
    expect(times).toEqual(Array.from({ length: 600 }, (_, index) => index));
  });

  it("pauses again when its new window is closed before it got going", async () => {
    const context = setup();
    context.windows.supported = true;
    context.compositor.lag = 2;
    context.compositor.closeAt = 30;
    const running = context.videos.start();
    await answer(context);
    await vi.waitFor(() => expect(context.videos.getSnapshot()?.paused).toBe(true));
    const start = context.compositor.startEncoding.bind(context.compositor);
    let closing = 1;
    context.compositor.startEncoding = async (config, onChunk) => {
      if (closing > 0) {
        closing -= 1;
        throw new WindowClosed();
      }
      return start(config, onChunk);
    };
    context.videos.resume();
    await vi.waitFor(() => expect(closing).toBe(0));
    await vi.waitFor(() => expect(context.videos.getSnapshot()?.paused).toBe(true));
    expect(context.dialogs.getSnapshot()).toBeUndefined();
    expect(context.file.abandoned).toBe(false);
    context.videos.resume();
    await running;
    expect(context.writer.frames).toHaveLength(60);
  });

  it("keeps what it got to when it fails, and goes on from there once that is put right", async () => {
    const context = setup({}, 20);
    context.compositor.lag = 2;
    context.compositor.failAt = {
      index: 400,
      failure: { reason: "missing-file", layer: "c", file: "a" },
    };
    const running = context.videos.start();
    await answer(context);
    const shown = await notice(context);
    await running;
    expect(shown.message).toContain("export.video.kept");
    expect(context.file.abandoned).toBe(false);
    // The file is back. Exporting again goes on where it stopped.
    context.compositor.failAt = undefined;
    const frames = context.compositor.frames.length;
    const again = context.videos.start();
    await vi.waitFor(() => expect(context.dialogs.getSnapshot()?.kind).toBe("choice"));
    context.dialogs.answer("continue");
    await again;
    expect(context.compositor.frames[frames]).toMatchObject({ index: 300, keyFrame: true });
    const times = context.writer.frames.map(({ timestamp }) => Math.round(timestamp * 30));
    expect(times).toEqual(Array.from({ length: 600 }, (_, index) => index));
  });

  /** A graphics card that encodes `taking` frames and gives `giving` of them back, and then fails. */
  function failingCard(context: Context, taking: number, giving: number) {
    const encode = context.compositor.encodeFrame.bind(context.compositor);
    let taken = 0;
    context.compositor.encodeFrame = async (frame) => {
      if (context.compositor.config?.hardwareAcceleration !== "prefer-hardware") {
        return encode(frame);
      }
      if (taken >= taking) {
        throw new StillFailed({ reason: "encoder", message: "Encoder creation error." });
      }
      taken += 1;
      // As WebCodecs does it: the frames go in, and what comes out comes later, or never.
      if (taken <= giving) return encode(frame);
      context.compositor.frames.push(frame);
    };
  }

  it("goes over to the processor when the graphics card fails on the first frame", async () => {
    const context = setup();
    failingCard(context, 0, 0);
    const running = context.videos.start();
    await answer(context);
    await running;
    expect(context.compositor.config?.hardwareAcceleration).toBe("prefer-software");
    expect(context.writer.frames).toHaveLength(60);
    expect(context.said()[0]).toContain("export.video.encoded.software");
  });

  it("goes over to the processor with every frame when the graphics card took a few first", async () => {
    const context = setup();
    failingCard(context, 3, 0);
    const running = context.videos.start();
    await answer(context);
    await running;
    expect(context.said()[0]).toContain("export.video.encoded.software");
    const times = context.writer.frames.map(({ timestamp }) => Math.round(timestamp * 30));
    expect(times).toEqual(Array.from({ length: 60 }, (_, index) => index));
  });

  it("goes back to the last place kept when the graphics card failed after giving frames", async () => {
    const context = setup({}, 20);
    failingCard(context, 450, 440);
    const running = context.videos.start();
    await answer(context);
    await running;
    expect(context.said()[0]).toContain("export.video.encoded.software");
    // The processor starts where the last ten seconds were kept, on a key frame.
    const software = context.compositor.frames.slice(450);
    expect(software[0]).toMatchObject({ index: 300, keyFrame: true });
    const times = context.writer.frames.map(({ timestamp }) => Math.round(timestamp * 30));
    expect(times).toEqual(Array.from({ length: 600 }, (_, index) => index));
  });

  it("uses the processor the next time after the graphics card failed", async () => {
    const context = setup();
    failingCard(context, 3, 0);
    const first = context.videos.start();
    await answer(context);
    await first;
    const again = context.videos.start();
    const form = await answer(context);
    await again;
    expect(form.notes).toContain("export.video.acceleration.software");
    expect(context.compositor.starts).toBe(3);
  });

  it("stops when what it keeps gets far larger than the bitrate says", async () => {
    const context = setup({}, 20);
    context.compositor.chunkBytes = 1024 * 1024;
    const running = context.videos.start();
    await answer(context);
    const shown = await notice(context);
    await running;
    expect(shown.message).toContain("export.video.wrongOutput");
    // It stopped soon after the limit, which is far from all the frames.
    expect(context.compositor.frames.length).toBeLessThan(400);
  });

  it("stops when the compositor gives back what is not even a chunk", async () => {
    const context = setup();
    const start = context.compositor.startEncoding.bind(context.compositor);
    context.compositor.startEncoding = async (config, onChunk, onWrong) => {
      await start(config, onChunk);
      onWrong?.("data");
    };
    const running = context.videos.start();
    await answer(context);
    const shown = await notice(context);
    await running;
    expect(shown.message).toContain("export.video.wrongOutput");
  });

  it("does not take what the compositor gives that it did not ask for", async () => {
    const context = setup();
    const start = context.compositor.startEncoding.bind(context.compositor);
    const tenth = framesOf({ from: 0, to: 1 }, { num: 30, den: 1 }).at(10).timestamp;
    context.compositor.startEncoding = (config, onChunk) =>
      start(config, (chunk) =>
        // A time no frame has, in place of the one of its frame.
        onChunk(chunk.timestamp === tenth ? { ...chunk, timestamp: 123 } : chunk),
      );
    const running = context.videos.start();
    await answer(context);
    const shown = await notice(context);
    await running;
    expect(shown.message).toContain("export.video.wrongOutput");
    expect(context.writer.frames).toHaveLength(0);
  });

  it("stops at a place to go on from when frames went missing", async () => {
    const context = setup({}, 20);
    const encode = context.compositor.encodeFrame.bind(context.compositor);
    context.compositor.encodeFrame = async (frame) => {
      if (frame.index === 200) {
        // Into the encoder, and never out of it.
        context.compositor.frames.push(frame);
        return;
      }
      return encode(frame);
    };
    const running = context.videos.start();
    await answer(context);
    const shown = await notice(context);
    await running;
    expect(shown.message).toContain("export.video.wrongOutput");
    expect(context.compositor.frames.length).toBeLessThanOrEqual(301);
  });

  it("asks first when the browser has little room for what it keeps", async () => {
    const context = setup({ storage: async () => ({ quota: 1000, usage: 900 }) }, 20);
    const running = context.videos.start();
    await answer(context);
    await vi.waitFor(() => expect(context.dialogs.getSnapshot()?.kind).toBe("choice"));
    const asked = context.dialogs.getSnapshot() as Extract<
      ReturnType<Dialogs["getSnapshot"]>,
      { kind: "choice" }
    >;
    expect(asked.title).toBe("export.storage.title");
    expect(asked.message).toContain("needed");
    context.dialogs.answer(undefined);
    await running;
    expect(context.chooseFile).not.toHaveBeenCalled();
  });

  it("counts what a download keeps in the browser too", async () => {
    // Twenty seconds of the format, with room for one copy and not for two.
    const bytes = (bitrateFor({ width: 640, height: 360, fps: 30 }, "standard") * 20) / 8;
    const storage = async () => ({ quota: bytes * 1.5, usage: 0 });
    const asks = async (savesInBrowser: boolean) => {
      const context = setup({ storage }, 20);
      context.folders.savesInBrowser = savesInBrowser;
      const running = context.videos.start();
      await answer(context);
      // Either it asks, or it goes on to the compositor.
      await vi.waitFor(() =>
        expect(context.dialogs.getSnapshot()?.kind === "choice" || context.opened.length > 0).toBe(
          true,
        ),
      );
      const kind = context.dialogs.getSnapshot()?.kind;
      if (kind === "choice") context.dialogs.answer(undefined);
      await running;
      return kind === "choice";
    };
    expect(await asks(false)).toBe(false);
    expect(await asks(true)).toBe(true);
  });

  it("says that the storage of the browser is full, not the file", async () => {
    const context = setup({}, 20);
    context.compositor.chunkBytes = 1024 * 1024;
    context.exports.addPiece = async () => {
      throw new DOMException("full", "QuotaExceededError");
    };
    const running = context.videos.start();
    await answer(context);
    const shown = await notice(context);
    await running;
    expect(shown.message).toContain("export.storage.full");
  });

  it("says how far the sound got while it catches up after a reload", async () => {
    const first = setup({}, 120, true);
    first.compositor.crashAt = 3200;
    void first.videos.start();
    await answer(first);
    await vi.waitFor(() => expect(first.compositor.frames).toHaveLength(3200));
    first.exports.claimed.clear();
    const next = setup({}, 120, false, first);
    const seen: (number | undefined)[] = [];
    next.videos.subscribe(() => seen.push(next.videos.getSnapshot()?.catchingUp));
    const { offering } = await offeredNow(next, "continue");
    await offering;
    expect(seen.some((ratio) => ratio !== undefined && ratio > 0 && ratio < 1)).toBe(true);
    expect(next.writer.sounds.at(-1)?.timestamp).toBe(110);
  });
});

/** Asks about an unfinished export now, and answers. */
async function offeredNow(context: Context, choice: string | undefined) {
  const offering = context.videos.offerResume();
  await vi.waitFor(() => expect(context.dialogs.getSnapshot()?.kind).toBe("choice"));
  context.dialogs.answer(choice);
  return { offering };
}

describe("what unfinished exports leave", () => {
  /** An export of twenty seconds that stops at frame 400, after a place to go on from. */
  async function stopped(context: Context) {
    context.compositor.failAt = {
      index: 400,
      failure: { reason: "missing-file", layer: "c", file: "a" },
    };
    const running = context.videos.start();
    await answer(context);
    await notice(context);
    await running;
  }

  it("goes with its empty file when people clear it on the start page", async () => {
    const context = setup({}, 20);
    await stopped(context);
    const [saved] = await context.exports.all();
    expect(await context.videos.forget(saved?.id ?? "")).toBe(true);
    expect(await context.exports.all()).toEqual([]);
    expect(context.dropTarget).toHaveBeenCalledWith(saved?.target, [], true);
    expect(context.file.abandoned).toBe(true);
  });

  it("goes when the editor starts after a month, whichever project it is of, with its file", async () => {
    const context = setup({}, 20);
    await stopped(context);
    const [saved] = await context.exports.all();
    if (!saved) throw new Error("Nothing kept");
    await context.exports.save({
      ...saved,
      project: "别的项目",
      savedAt: Date.now() - 31 * 86_400_000,
    });
    expect(await context.videos.unfinished()).toEqual([]);
    await context.videos.cleanUp();
    expect(await context.exports.all()).toEqual([]);
    expect(context.dropTarget).toHaveBeenCalledWith(saved.target, [], false);
  });

  /** Starts an export with the one before waiting: people answer the question about it. */
  async function again(context: Context, choice: string | undefined, failAt?: number) {
    context.compositor.failAt =
      failAt === undefined
        ? undefined
        : { index: failAt, failure: { reason: "missing-file", layer: "c", file: "a" } };
    const running = context.videos.start();
    await vi.waitFor(() => expect(context.dialogs.getSnapshot()?.kind).toBe("choice"));
    context.dialogs.answer(choice);
    await answer(context);
    if (failAt !== undefined) await notice(context);
    await running;
  }

  it("takes the place of the one before when people say so, once it has a place of its own", async () => {
    const context = setup({}, 20);
    await stopped(context);
    const [older] = await context.exports.all();
    await again(context, "new", 400);
    const left = await context.exports.all();
    expect(left).toHaveLength(1);
    expect(left[0]?.id).not.toBe(older?.id);
    expect(context.exports.count(older?.id ?? "", "video")).toBe(0);
    expect(context.said()).toContain("export.resume.replaced");
    // The new one goes to the same file, which therefore stays.
    expect(context.file.abandoned).toBe(false);
  });

  it("leaves the one before when the new one stops before it has a place of its own", async () => {
    const context = setup({}, 20);
    await stopped(context);
    const [older] = await context.exports.all();
    await again(context, "new", 100);
    // The one before stays as it was, and the new one is in the list too, failed.
    const left = await context.exports.all();
    expect(left.map(({ id }) => id)).toContain(older?.id);
    expect(left).toHaveLength(2);
    expect(context.videos.queue.getSnapshot().map(({ status }) => status)).toEqual([
      "failed",
      "failed",
    ]);
    expect(context.said()).not.toContain("export.resume.replaced");
    // That one still goes to the file, which therefore stays.
    expect(context.file.abandoned).toBe(false);
  });

  it("leaves the one before when people leave it for later", async () => {
    const context = setup({}, 20);
    await stopped(context);
    await again(context, undefined, 400);
    expect(await context.exports.all()).toHaveLength(2);
    expect(context.said()).not.toContain("export.resume.replaced");
  });

  it("finished, takes the place of the one before too", async () => {
    const context = setup({}, 20);
    await stopped(context);
    await again(context, "new");
    expect(await context.exports.all()).toEqual([]);
    expect(context.said()).toContain("export.resume.replaced");
  });

  it("suggests another name than one that an unfinished export of the project goes to", async () => {
    const context = setup({}, 20);
    await stopped(context);
    const [older] = await context.exports.all();
    if (!older) throw new Error("Nothing kept");
    const first = context.chooseFile.mock.calls[0]?.[0] ?? "";
    await context.exports.save({ ...older, target: { kind: "download", name: first } });
    await again(context, undefined, 400);
    const names = context.chooseFile.mock.calls.map(([name]) => name);
    expect(names[1]).not.toBe(names[0]);
    expect(names[1]).toContain("export.video.fileNumbered");
  });
});

describe("the line of exports", () => {
  /** Waits until an export holds at a frame, as a slow one would. */
  function holdAt(context: Context, at: number) {
    const encode = context.compositor.encodeFrame.bind(context.compositor);
    const gate = Promise.withResolvers<void>();
    let reached = false;
    context.compositor.encodeFrame = async (frame) => {
      if (frame.index === at && !reached) {
        reached = true;
        await gate.promise;
      }
      return encode(frame);
    };
    return {
      reached: () => vi.waitFor(() => expect(reached).toBe(true)),
      go: () => gate.resolve(),
    };
  }

  /** Which exports ran, in the order they did, by the frames they started with. */
  function runs(context: Context) {
    const seen: string[] = [];
    context.videos.subscribe(() => {
      const id = context.videos.getSnapshot()?.id;
      if (id && seen.at(-1) !== id) seen.push(id);
    });
    return seen;
  }

  const statuses = (context: Context) =>
    context.videos.queue.getSnapshot().map(({ status }) => status);

  const frameTimes = (context: Context) =>
    context.writer.frames.map(({ timestamp }) => Math.round(timestamp * 30));

  it("puts what people ask for while one runs in line, and runs it next, in the same window", async () => {
    const context = setup();
    context.windows.supported = true;
    const order = runs(context);
    const held = holdAt(context, 10);
    const running = context.videos.start();
    await answer(context);
    await held.reached();
    const second = context.videos.start();
    const form = await answer(context, { quality: "high" });
    await second;
    expect(form.confirm).toBe("export.queue.add");
    expect(form.notes?.at(-1)).toContain("export.queue.inLine");
    expect(statuses(context)).toEqual(["running", "waiting"]);
    expect(context.said().at(-1)).toContain("export.queue.added");
    expect(context.said().at(-1)).toContain('"ahead":1');
    // What it is to do is kept, for after a reload.
    const waiting = context.videos.queue.getSnapshot()[1];
    const kept = context.exports.saved.get(waiting?.id ?? "")?.state as SavedState;
    expect(kept.queue?.status).toBe("waiting");
    expect(kept.plan.quality).toBe("high");
    // Nothing of it runs yet: no compositor that a watchdog could find silent.
    expect(context.opened).toHaveLength(1);
    held.go();
    await running;
    expect(order).toHaveLength(2);
    expect(statuses(context)).toEqual(["done", "done"]);
    expect(context.writerOptions).toHaveLength(2);
    expect(frameTimes(context)).toEqual([
      ...Array.from({ length: 60 }, (_, index) => index),
      ...Array.from({ length: 60 }, (_, index) => index),
    ]);
    expect(context.compositor.config?.bitrate).toBe(
      bitrateFor({ width: 640, height: 360, fps: 30 }, "high"),
    );
    expect(context.windows.opened).toHaveLength(1);
    expect(context.opened[1]?.document).toBe(context.windows.opened[0]?.document);
    expect(context.windows.opened[0]?.closes).toBeGreaterThan(0);
    expect(context.exports.saved.size).toBe(0);
  });

  it("goes on with the next one when one fails, and keeps the one that failed", async () => {
    const context = setup();
    const held = holdAt(context, 10);
    context.compositor.failAt = {
      index: 20,
      failure: { reason: "missing-file", layer: "c", file: "a" },
    };
    const running = context.videos.start();
    await answer(context);
    await held.reached();
    const second = context.videos.start();
    await answer(context);
    await second;
    held.go();
    // The second fails at the same frame: it is the same project.
    await vi.waitFor(() => expect(statuses(context)).toEqual(["failed", "failed"]));
    await running;
    expect(context.opened).toHaveLength(2);
  });

  it("keeps the order people asked in, also for one that paused and went on", async () => {
    const context = setup();
    const order = runs(context);
    const held = holdAt(context, 10);
    const running = context.videos.start();
    await answer(context);
    await held.reached();
    for (let more = 0; more < 2; more += 1) {
      const next = context.videos.start();
      await answer(context);
      await next;
    }
    const [first, second, third] = context.videos.queue.getSnapshot();
    context.videos.pause(second?.id);
    expect(statuses(context)).toEqual(["running", "paused", "waiting"]);
    expect(context.videos.queue.ahead(third?.id ?? "")).toBe(1);
    // Going on before its turn came puts it back where it was: before the third.
    context.videos.goOn(second?.id ?? "");
    expect(statuses(context)).toEqual(["running", "waiting", "waiting"]);
    held.go();
    await running;
    expect(order).toEqual([first?.id, second?.id, third?.id]);
  });

  it("lets the next one go while one that waits is paused, and that one goes when people say so", async () => {
    const context = setup();
    const order = runs(context);
    const held = holdAt(context, 10);
    const running = context.videos.start();
    await answer(context);
    await held.reached();
    for (let more = 0; more < 2; more += 1) {
      const next = context.videos.start();
      await answer(context);
      await next;
    }
    const [first, second, third] = context.videos.queue.getSnapshot();
    context.videos.pause(second?.id);
    held.go();
    await running;
    expect(order).toEqual([first?.id, third?.id]);
    expect(statuses(context)).toEqual(["done", "paused", "done"]);
    expect(stateOf(context.exports.saved.get(second?.id ?? ""))?.queue?.status).toBe("paused");
    context.videos.goOn(second?.id ?? "");
    await vi.waitFor(() => expect(statuses(context)).toEqual(["done", "done", "done"]));
    expect(order).toEqual([first?.id, third?.id, second?.id]);
  });

  it("pauses at the next place to go on from, and goes on from there with every frame once", async () => {
    const context = setup({}, 20);
    context.windows.supported = true;
    context.compositor.lag = 2;
    const held = holdAt(context, 100);
    const running = context.videos.start();
    await answer(context);
    await held.reached();
    context.videos.pause();
    expect(context.videos.getSnapshot()?.pausing).toBe(true);
    held.go();
    await running;
    // It went on to frame 300, which is a place to go on from, and not a frame further.
    expect(context.compositor.frames).toHaveLength(300);
    expect(statuses(context)).toEqual(["paused"]);
    const [entry] = context.videos.queue.getSnapshot();
    const kept = context.exports.saved.get(entry?.id ?? "")?.state as SavedState;
    expect(kept.progress.frame).toBe(300);
    expect(kept.queue?.status).toBe("paused");
    expect(context.said().at(-1)).toContain("export.queue.paused");
    // A paused one does not hold on to the window.
    expect(context.videos.getSnapshot()).toBeUndefined();
    expect(context.windows.opened[0]?.closes).toBeGreaterThan(0);
    context.videos.goOn(entry?.id ?? "");
    await vi.waitFor(() => expect(statuses(context)).toEqual(["done"]));
    expect(context.reopen).toHaveBeenCalledOnce();
    expect(context.compositor.frames[300]).toMatchObject({ index: 300, keyFrame: true });
    expect(context.compositor.frames).toHaveLength(600);
    expect(frameTimes(context)).toEqual(Array.from({ length: 600 }, (_, index) => index));
    expect(context.file.finished).toBe(true);
    expect(context.exports.saved.size).toBe(0);
  });

  it("goes back to the last place kept when it is paused while its window is closed", async () => {
    const context = setup({}, 20);
    context.windows.supported = true;
    context.compositor.lag = 2;
    context.compositor.closeAt = 400;
    const running = context.videos.start();
    await answer(context);
    await vi.waitFor(() => expect(context.videos.getSnapshot()?.paused).toBe(true));
    context.videos.pause();
    await running;
    expect(statuses(context)).toEqual(["paused"]);
    const [entry] = context.videos.queue.getSnapshot();
    expect(stateOf(context.exports.saved.get(entry?.id ?? ""))?.progress.frame).toBe(300);
    context.videos.goOn(entry?.id ?? "");
    await vi.waitFor(() => expect(statuses(context)).toEqual(["done"]));
    expect(frameTimes(context)).toEqual(Array.from({ length: 600 }, (_, index) => index));
  });

  it("does not pause what is being written into the file", async () => {
    const context = setup();
    const writing = Promise.withResolvers<void>();
    const { add } = context.writer;
    context.writer.add = async (frame, config) => {
      await writing.promise;
      return add.call(context.writer, frame, config);
    };
    const running = context.videos.start();
    await answer(context);
    await vi.waitFor(() => expect(context.videos.getSnapshot()?.writing).toBe(true));
    context.videos.pause();
    expect(context.videos.getSnapshot()?.pausing).toBeUndefined();
    writing.resolve();
    await running;
    expect(statuses(context)).toEqual(["done"]);
  });

  it("retries from where it was kept, and retrying again before it is put right leaves no more behind", async () => {
    const context = setup({}, 12);
    context.compositor.lag = 2;
    context.compositor.chunkBytes = 512 * 1024;
    const fail = {
      index: 340,
      failure: { reason: "missing-file", layer: "c", file: "a" },
    } as const;
    context.compositor.failAt = fail;
    const running = context.videos.start();
    await answer(context);
    await notice(context);
    await running;
    const [entry] = context.videos.queue.getSnapshot();
    const id = entry?.id ?? "";
    expect(entry).toMatchObject({ status: "failed", done: 300 });
    expect(entry?.failure).toContain("export.failure.missingFile");
    const pieces = context.exports.count(id, "video");
    // Once it fails sooner, once where it did: what came after the place kept never adds up.
    for (const at of [320, 340]) {
      context.compositor.failAt = { ...fail, index: at };
      context.videos.retry(id);
      await notice(context);
      await vi.waitFor(() => expect(statuses(context)).toEqual(["failed"]));
      const now = context.exports.count(id, "video");
      if (at < fail.index) expect(now).toBeLessThan(pieces);
      else expect(now).toBe(pieces);
      expect(context.exports.saved.size).toBe(1);
    }
    // It went on from frame 300 each time, not from the start.
    expect(context.compositor.frames.filter(({ index }) => index === 0)).toHaveLength(1);
    context.compositor.failAt = undefined;
    context.videos.retry(id);
    await vi.waitFor(() => expect(statuses(context)).toEqual(["done"]));
    expect(frameTimes(context)).toEqual(Array.from({ length: 360 }, (_, index) => index));
    expect(context.exports.saved.size).toBe(0);
    expect(context.exports.count(id, "video")).toBe(0);
    expect(context.file.finished).toBe(true);
  });

  it("starts over with the same choices and file when it failed before a place to go on from", async () => {
    const context = setup();
    context.compositor.failAt = {
      index: 20,
      failure: { reason: "missing-file", layer: "c", file: "a" },
    };
    const running = context.videos.start();
    await answer(context);
    await notice(context);
    await running;
    context.compositor.failAt = undefined;
    const [entry] = context.videos.queue.getSnapshot();
    context.videos.retry(entry?.id ?? "");
    await vi.waitFor(() => expect(statuses(context)).toEqual(["done"]));
    expect(context.chooseFile).toHaveBeenCalledOnce();
    expect(frameTimes(context)).toEqual(Array.from({ length: 60 }, (_, index) => index));
  });

  it("can take one that waits out of the line, with its file, before it ever ran", async () => {
    const context = setup();
    const held = holdAt(context, 10);
    const running = context.videos.start();
    await answer(context);
    await held.reached();
    const second = context.videos.start();
    await answer(context);
    await second;
    const [, waiting] = context.videos.queue.getSnapshot();
    await context.videos.remove(waiting?.id ?? "");
    expect(context.exports.saved.has(waiting?.id ?? "")).toBe(false);
    expect(statuses(context)).toEqual(["running"]);
    held.go();
    await running;
    expect(context.writerOptions).toHaveLength(1);
  });

  describe("after a reload", () => {
    /** Two in line, the first stopped with the page at frame 360 of 600. */
    async function reloaded(pauseSecond = false) {
      const first = setup({}, 20);
      first.compositor.crashAt = 360;
      void first.videos.start();
      await answer(first);
      await vi.waitFor(() => expect(first.compositor.frames).toHaveLength(360));
      const second = first.videos.start();
      await answer(first);
      await second;
      if (pauseSecond) {
        const id = first.videos.queue.getSnapshot()[1]?.id ?? "";
        first.videos.pause(id);
        await vi.waitFor(() =>
          expect(stateOf(first.exports.saved.get(id))?.queue?.status).toBe("paused"),
        );
      }
      // A page that goes away lets go of what it held.
      first.exports.claimed.clear();
      const next = setup({}, 20, false, first);
      const offering = next.videos.offerResume();
      await vi.waitFor(() => expect(next.dialogs.getSnapshot()?.kind).toBe("choice"));
      return { first, next, offering };
    }

    it("has the line as it was, and goes on with all of it when people say so", async () => {
      const first = setup({}, 20);
      first.compositor.crashAt = 360;
      void first.videos.start();
      await answer(first);
      await vi.waitFor(() => expect(first.compositor.frames).toHaveLength(360));
      const second = first.videos.start();
      await answer(first);
      await second;
      first.exports.claimed.clear();
      const next = setup({}, 20, false, first);
      const offering = next.videos.offerResume();
      await vi.waitFor(() => expect(next.dialogs.getSnapshot()?.kind).toBe("choice"));
      expect(next.videos.queue.getSnapshot()).toMatchObject([
        { status: "interrupted", done: 300, total: 600, restored: true },
        { status: "waiting", done: 0, total: 600, restored: true },
      ]);
      // What was in line does not go before people said so.
      expect(next.opened).toHaveLength(0);
      next.dialogs.answer("continue");
      await offering;
      expect(next.videos.queue.getSnapshot().map(({ status }) => status)).toEqual(["done", "done"]);
      expect(next.reopen).toHaveBeenCalledTimes(2);
      expect(next.compositor.frames[0]).toMatchObject({ index: 300, keyFrame: true });
      expect(next.compositor.frames[300]).toMatchObject({ index: 0, keyFrame: true });
      expect(frameTimes(next)).toEqual([
        ...Array.from({ length: 600 }, (_, index) => index),
        ...Array.from({ length: 600 }, (_, index) => index),
      ]);
      expect(next.exports.saved.size).toBe(0);
    });

    it("keeps one that was paused paused, and asks nothing about it", async () => {
      const { next } = await reloaded(true);
      next.dialogs.answer(undefined);
      await vi.waitFor(() => expect(next.dialogs.getSnapshot()).toBeUndefined());
      expect(next.videos.queue.getSnapshot().map(({ status }) => status)).toEqual([
        "interrupted",
        "paused",
      ]);
      const [, paused] = next.videos.queue.getSnapshot();
      next.videos.goOn(paused?.id ?? "");
      await vi.waitFor(() =>
        expect(next.videos.queue.getSnapshot().map(({ status }) => status)).toEqual([
          "interrupted",
          "done",
        ]),
      );
    });

    it("goes nowhere by itself when people leave it for later", async () => {
      const { next, offering } = await reloaded();
      next.dialogs.answer(undefined);
      await offering;
      expect(next.opened).toHaveLength(0);
      expect(next.reopen).not.toHaveBeenCalled();
      expect(next.videos.queue.getSnapshot().map(({ status }) => status)).toEqual([
        "interrupted",
        "waiting",
      ]);
    });

    it("is on the start page, with how far each one got", async () => {
      const { next } = await reloaded();
      next.dialogs.answer(undefined);
      const found = await next.videos.unfinished();
      expect(found.map(({ status, done, total }) => ({ status, done, total }))).toEqual(
        expect.arrayContaining([
          { status: "interrupted", done: 300, total: 600 },
          { status: "waiting", done: 0, total: 600 },
        ]),
      );
    });

    it("is not the list of another window that has it", async () => {
      const first = setup({}, 20);
      first.compositor.crashAt = 360;
      void first.videos.start();
      await answer(first);
      await vi.waitFor(() => expect(first.compositor.frames).toHaveLength(360));
      const other = setup({}, 20, false, first);
      await other.videos.offerResume();
      expect(other.videos.queue.getSnapshot()).toEqual([]);
    });

    it("waits for a press when the browser does not let it write the file without one", async () => {
      const { next } = await reloaded();
      // As a browser does it: writing the file again takes a press of a button just before.
      const activation = { isActive: true };
      vi.stubGlobal("navigator", { userActivation: activation });
      // The press was for the first one, and is over before the second one's turn comes.
      next.reopen.mockImplementation(async () => {
        const pressed = activation.isActive;
        activation.isActive = false;
        return pressed ? next.file : "denied";
      });
      next.dialogs.answer("continue");
      await vi.waitFor(() =>
        expect(next.videos.queue.getSnapshot().map(({ status }) => status)).toEqual([
          "done",
          "paused",
        ]),
      );
      expect(next.videos.queue.getSnapshot()[1]?.needsPress).toBe(true);
      expect(next.said().join()).toContain("export.queue.needsPress");
      // No question that would go nowhere without a press.
      expect(next.dialogs.getSnapshot()).toBeUndefined();
      activation.isActive = true;
      next.videos.goOn(next.videos.queue.getSnapshot()[1]?.id ?? "");
      activation.isActive = false;
      await vi.waitFor(() => expect(next.videos.queue.getSnapshot()[1]?.status).toBe("done"));
    });
  });

  describe("waiting", () => {
    it("is said, for a file that takes long to be read, and is not a failure", async () => {
      const read = Promise.withResolvers<Blob | undefined>();
      const context = setup({
        projects: { media: () => ({ get: () => read.promise }) } as unknown as ProjectLibrary,
      });
      const encode = context.compositor.encodeFrame.bind(context.compositor);
      let asked = false;
      context.compositor.encodeFrame = async (frame) => {
        if (frame.index === 5 && !asked) {
          asked = true;
          // As the compositor does it: the frame waits until the file is there.
          await context.opened[0]?.media("sha256-big");
        }
        return encode(frame);
      };
      const running = context.videos.start();
      await answer(context);
      await vi.waitFor(() => expect(context.videos.getSnapshot()?.readingMedia).toBe(true), {
        timeout: 2000,
      });
      expect(statuses(context)).toEqual(["running"]);
      read.resolve(new Blob(["x"]));
      await vi.waitFor(() => expect(context.videos.getSnapshot()?.readingMedia).toBeUndefined());
      await running;
      expect(statuses(context)).toEqual(["done"]);
    });
  });
});

describe("an export in line, where it could go wrong", () => {
  const statuses = (context: Context) =>
    context.videos.queue.getSnapshot().map(({ status }) => status);
  const missing = (index: number) =>
    ({ index, failure: { reason: "missing-file", layer: "c", file: "a" } }) as const;

  it("keeps what it got to when the disk is full and not even the failure can be kept", async () => {
    const context = setup({}, 20);
    context.compositor.lag = 2;
    context.compositor.chunkBytes = 256 * 1024;
    const save = context.exports.save.bind(context.exports);
    const addPiece = context.exports.addPiece.bind(context.exports);
    let full = false;
    context.exports.addPiece = async (id, track, piece) => {
      if (full) throw new DOMException("full", "QuotaExceededError");
      return addPiece(id, track, piece);
    };
    context.exports.save = async (saved) => {
      if (full) throw new DOMException("full", "QuotaExceededError");
      return save(saved);
    };
    const encode = context.compositor.encodeFrame.bind(context.compositor);
    let id = "";
    let pieces = 0;
    context.compositor.encodeFrame = async (frame) => {
      if (frame.index === 320 && !id) {
        const [kept] = await context.exports.all();
        id = kept?.id ?? "";
        pieces = context.exports.count(id, "video");
        full = true;
      }
      return encode(frame);
    };
    const running = context.videos.start();
    await answer(context);
    const shown = await notice(context);
    await running;
    expect(pieces).toBeGreaterThan(0);
    expect(shown.message).toContain("export.storage.full");
    expect(shown.message).toContain("export.video.kept");
    // The rule from before: what got to a place to go on from stays when it fails.
    expect(context.exports.saved.size).toBe(1);
    expect(stateOf(context.exports.saved.get(id))?.progress.frame).toBe(300);
    expect(context.exports.count(id, "video")).toBe(pieces);
    expect(context.file.abandoned).toBe(false);
    expect(context.videos.queue.getSnapshot()).toMatchObject([{ status: "failed", done: 300 }]);
    // Once there is room again, it goes on from there.
    full = false;
    context.videos.retry(id);
    await vi.waitFor(() => expect(statuses(context)).toEqual(["done"]));
    const times = context.writer.frames.map(({ timestamp }) => Math.round(timestamp * 30));
    expect(times).toEqual(Array.from({ length: 600 }, (_, index) => index));
  });

  it("does not go on with one that was removed while it got ready to go on", async () => {
    const context = setup({}, 20);
    context.compositor.lag = 2;
    context.compositor.failAt = missing(340);
    const running = context.videos.start();
    await answer(context);
    await notice(context);
    await running;
    const [entry] = context.videos.queue.getSnapshot();
    const id = entry?.id ?? "";
    context.compositor.failAt = undefined;
    const gate = Promise.withResolvers<void>();
    // As while the browser asks people whether the page may write the file again.
    context.reopen.mockImplementationOnce(async () => {
      await gate.promise;
      return context.file;
    });
    const compositors = context.opened.length;
    context.videos.retry(id);
    await vi.waitFor(() => expect(context.reopen).toHaveBeenCalled());
    // The row says it runs, and its button for stopping is pressed: no export is live yet.
    context.videos.cancel(id);
    await vi.waitFor(() => expect(context.videos.queue.getSnapshot()).toEqual([]));
    expect(context.exports.saved.size).toBe(0);
    gate.resolve();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(context.writer.frames).toHaveLength(0);
    expect(context.file.finished).toBe(false);
    expect(context.exports.saved.size).toBe(0);
    expect(context.videos.getSnapshot()).toBeUndefined();
    // It stopped where it was, without starting anything or saying anything more.
    expect(context.opened).toHaveLength(compositors);
    expect(context.dialogs.getSnapshot()).toBeUndefined();
  });

  it("uses the press for the file when one that needs it goes on while another runs", async () => {
    const first = setup({}, 20);
    first.compositor.crashAt = 360;
    void first.videos.start();
    await answer(first);
    await vi.waitFor(() => expect(first.compositor.frames).toHaveLength(360));
    const second = first.videos.start();
    await answer(first);
    await second;
    first.exports.claimed.clear();
    const next = setup({}, 20, false, first);
    const activation = { isActive: true };
    vi.stubGlobal("navigator", { userActivation: activation });
    // A press counts for the first question the browser asks after it.
    next.reopen.mockImplementation(async () => {
      const pressed = activation.isActive;
      activation.isActive = false;
      return pressed ? next.file : "denied";
    });
    const offering = next.videos.offerResume();
    await vi.waitFor(() => expect(next.dialogs.getSnapshot()?.kind).toBe("choice"));
    next.dialogs.answer("continue");
    await offering;
    const waiting = next.videos.queue.getSnapshot().find(({ needsPress }) => needsPress);
    expect(waiting).toBeDefined();
    // A new one, which runs for a while.
    const encode = next.compositor.encodeFrame.bind(next.compositor);
    const gate = Promise.withResolvers<void>();
    let reached = false;
    next.compositor.encodeFrame = async (frame) => {
      if (frame.index === 10 && !reached) {
        reached = true;
        await gate.promise;
      }
      return encode(frame);
    };
    const third = next.videos.start();
    await answer(next);
    await vi.waitFor(() => expect(reached).toBe(true));
    // People press 继续, as the notice told them, and the press is over a moment later.
    activation.isActive = true;
    next.videos.goOn(waiting?.id ?? "");
    activation.isActive = false;
    gate.resolve();
    await third;
    await vi.waitFor(() =>
      expect(next.videos.queue.getSnapshot().find(({ id }) => id === waiting?.id)?.status).toBe(
        "done",
      ),
    );
  });

  it("does not throw away what one that was retried got to, for one that was to replace it", async () => {
    const context = setup({}, 40);
    context.compositor.lag = 2;
    context.compositor.failAt = missing(400);
    const running = context.videos.start();
    await answer(context);
    await notice(context);
    await running;
    const [old] = context.videos.queue.getSnapshot();
    const oldId = old?.id ?? "";
    // People start another export: the one that failed is offered first, and they start anew.
    context.compositor.failAt = missing(20);
    const again = context.videos.start();
    await vi.waitFor(() => expect(context.dialogs.getSnapshot()?.kind).toBe("choice"));
    context.dialogs.answer("new");
    await answer(context);
    await notice(context);
    await again;
    const newer = context.videos.queue.getSnapshot().find(({ id }) => id !== oldId);
    // People retry the old one after all, which gets further, and fails again.
    context.compositor.failAt = missing(700);
    context.videos.retry(oldId);
    await notice(context);
    await vi.waitFor(() => expect(context.videos.getSnapshot()).toBeUndefined());
    // And the new one, which now gets past a place to go on from.
    context.compositor.failAt = missing(1000);
    context.videos.retry(newer?.id ?? "");
    await notice(context);
    await vi.waitFor(() => expect(context.videos.getSnapshot()).toBeUndefined());
    expect(context.exports.saved.has(oldId)).toBe(true);
    expect(stateOf(context.exports.saved.get(oldId))?.progress.frame).toBe(600);
    expect(context.said()).not.toContain("export.resume.replaced");
  });

  it("says what the export that runs waits for, not what the one before it waited for", async () => {
    const reads = new Map<string, PromiseWithResolvers<Blob | undefined>>();
    const context = setup({
      projects: {
        media: () => ({
          get: (hash: string) => {
            const read = Promise.withResolvers<Blob | undefined>();
            reads.set(hash, read);
            return read.promise;
          },
        }),
      } as unknown as ProjectLibrary,
    });
    const encode = context.compositor.encodeFrame.bind(context.compositor);
    let runs = 0;
    const gate = Promise.withResolvers<void>();
    let reached = false;
    context.compositor.encodeFrame = async (frame) => {
      if (frame.index === 3 && !reached) {
        reached = true;
        await gate.promise;
      }
      if (frame.index === 5) {
        runs += 1;
        const options = context.opened.at(-1);
        if (runs === 1) {
          // The first asks for a big file, and fails before it is there.
          void options?.media("first-big");
          throw new StillFailed({ reason: "missing-file", layer: "c", file: "a" });
        }
        if (runs === 2) await options?.media("second-big");
      }
      return encode(frame);
    };
    const running = context.videos.start();
    await answer(context);
    await vi.waitFor(() => expect(reached).toBe(true));
    const second = context.videos.start();
    await answer(context);
    await second;
    gate.resolve();
    await notice(context);
    await vi.waitFor(() => expect(context.videos.getSnapshot()?.readingMedia).toBe(true), {
      timeout: 2000,
    });
    // The file of the first comes, long after it stopped.
    reads.get("first-big")?.resolve(new Blob(["x"]));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(context.videos.getSnapshot()?.readingMedia).toBe(true);
    reads.get("second-big")?.resolve(new Blob(["x"]));
    await running;
  });

  it("says where a pause that could not be kept as one goes on from after a reload", async () => {
    const context = setup({}, 20);
    const save = context.exports.save.bind(context.exports);
    context.exports.save = async (saved) => {
      if (stateOf(saved)?.queue?.status === "paused")
        throw new DOMException("full", "QuotaExceededError");
      return save(saved);
    };
    const encode = context.compositor.encodeFrame.bind(context.compositor);
    context.compositor.encodeFrame = async (frame) => {
      if (frame.index === 100) context.videos.pause();
      return encode(frame);
    };
    const running = context.videos.start();
    await answer(context);
    await running;
    const said = context.said().at(-1) ?? "";
    expect(said).toContain("export.queue.pausedNotKept");
    expect(said).toContain('"frame":300');
    expect(statuses(context)).toEqual(["paused"]);
  });

  it("fails where it cannot go on at all, instead of waiting as if paused", async () => {
    const context = setup({}, 20);
    context.compositor.failAt = missing(340);
    const running = context.videos.start();
    await answer(context);
    await notice(context);
    await running;
    const [entry] = context.videos.queue.getSnapshot();
    // The browser cannot encode the way it did any more, and no other way fits the file.
    let supported = true;
    const support = vi.fn(async () => supported);
    const changed = setup({ support }, 20, false, {
      store: context.store,
      exports: context.exports,
    });
    context.exports.claimed.clear();
    supported = false;
    await changed.videos.offerResume();
    expect(changed.dialogs.getSnapshot()).toBeUndefined();
    changed.videos.retry(entry?.id ?? "");
    await notice(changed);
    await vi.waitFor(() =>
      expect(changed.videos.queue.getSnapshot()).toMatchObject([{ status: "failed" }]),
    );
    expect(changed.videos.queue.getSnapshot()[0]?.failure).toContain("export.video.cannotEncode");
  });

  it("goes on with the next one while one waits for an answer, and asks once people press", async () => {
    const first = setup({}, 20);
    first.compositor.crashAt = 360;
    void first.videos.start();
    await answer(first);
    await vi.waitFor(() => expect(first.compositor.frames).toHaveLength(360));
    const second = first.videos.start();
    await answer(first);
    await second;
    const third = first.videos.start();
    await answer(first);
    await third;
    first.exports.claimed.clear();
    const next = setup({}, 20, false, first);
    // The file of the second is gone: when its turn comes, and when people go on with it.
    next.reopen.mockImplementation(async () =>
      [2, 4].includes(next.reopen.mock.calls.length) ? "gone" : next.file,
    );
    const offering = next.videos.offerResume();
    await vi.waitFor(() => expect(next.dialogs.getSnapshot()?.kind).toBe("choice"));
    const [, gone] = next.videos.queue.getSnapshot();
    next.dialogs.answer("continue");
    await offering;
    // The second needs an answer about its file, which nobody is there to give: the third goes.
    expect(next.videos.queue.getSnapshot().map(({ status }) => status)).toEqual([
      "done",
      "paused",
      "done",
    ]);
    expect(next.videos.queue.getSnapshot()[1]?.needsPress).toBe(true);
    next.videos.goOn(gone?.id ?? "");
    await vi.waitFor(() =>
      expect(next.dialogs.getSnapshot()).toMatchObject({ title: "export.resume.goneTitle" }),
    );
    next.dialogs.answer("choose");
    await vi.waitFor(() => expect(next.videos.queue.getSnapshot()[1]?.status).toBe("done"));
  });

  it("says so when another window has the one people want to clear", async () => {
    const first = setup({}, 20);
    first.compositor.crashAt = 360;
    void first.videos.start();
    await answer(first);
    await vi.waitFor(() => expect(first.compositor.frames).toHaveLength(360));
    const other = setup({}, 20, false, first);
    const [kept] = await other.exports.all();
    expect(await other.videos.forget(kept?.id ?? "")).toBe(false);
    expect(other.said()).toContain("export.resume.elsewhere");
  });

  it("says so when old ones leave empty files that it may not take away", async () => {
    const context = setup({}, 20);
    context.compositor.failAt = missing(400);
    const running = context.videos.start();
    await answer(context);
    await notice(context);
    await running;
    const [saved] = await context.exports.all();
    if (!saved) throw new Error("Nothing kept");
    await context.exports.save({ ...saved, savedAt: Date.now() - 31 * 86_400_000 });
    // The browser would ask whether the file may go, which nothing is there to answer.
    context.dropTarget.mockResolvedValue(true);
    await context.videos.cleanUp();
    expect(await context.exports.all()).toEqual([]);
    expect(context.said().join()).toContain("export.queue.oldEmptyLeft");
  });

  it("asks again before it takes the place of one that got further since people said so", async () => {
    const context = setup({}, 20);
    context.compositor.failAt = missing(400);
    const running = context.videos.start();
    await answer(context);
    await notice(context);
    await running;
    const [old] = await context.exports.all();
    if (!old) throw new Error("Nothing kept");
    context.compositor.failAt = undefined;
    const encode = context.compositor.encodeFrame.bind(context.compositor);
    const gate = Promise.withResolvers<void>();
    let reached = false;
    context.compositor.encodeFrame = async (frame) => {
      if (frame.index === 10 && !reached) {
        reached = true;
        await gate.promise;
      }
      return encode(frame);
    };
    const again = context.videos.start();
    await vi.waitFor(() => expect(context.dialogs.getSnapshot()?.kind).toBe("choice"));
    context.dialogs.answer("new");
    await answer(context);
    await vi.waitFor(() => expect(reached).toBe(true));
    // Meanwhile the old one got further, as if it had gone on somewhere.
    const state = stateOf(old);
    if (!state) throw new Error("Nothing kept");
    await context.exports.save({
      ...old,
      state: { ...state, progress: { ...state.progress, frame: 500, videoPieces: 9 } },
    });
    gate.resolve();
    await vi.waitFor(() =>
      expect(context.dialogs.getSnapshot()).toMatchObject({ title: "export.queue.replaceTitle" }),
    );
    context.dialogs.answer(undefined);
    await again;
    expect(context.exports.saved.has(old.id)).toBe(true);
    expect(context.said()).not.toContain("export.resume.replaced");
  });
});
