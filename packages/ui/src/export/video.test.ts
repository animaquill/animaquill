import { ProjectStore, orderedTracks } from "@animaquill/core";
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
import type { MakeAudioEncoder } from "./sound.ts";
import { framesOf, VideoExport, type VideoExportOptions, type VideoWriter } from "./video.ts";

const t = ((key: string, options?: Record<string, unknown>) => {
  const { interpolation: _, ...fields } = options ?? {};
  return Object.keys(fields).length > 0 ? `${key} ${JSON.stringify(fields)}` : key;
}) as never;

const FORMAT = { id: "small", name: "小屏", width: 640, height: 360, fps: "30" };

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
  async abandon() {
    this.abandoned = true;
    if (this.failAbandon) throw new Error("stays");
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
  #first = true;

  async startEncoding(config: VideoEncoderConfig, onChunk: (chunk: EncodedChunk) => void) {
    this.starts += 1;
    this.#first = true;
    this.queued = [];
    if (this.noHardware && config.hardwareAcceleration === "prefer-hardware") {
      throw new StillFailed({ reason: "failed", message: "no hardware" });
    }
    this.config = config;
    this.onChunk = onChunk;
  }
  /** As if the page went away at this frame: it never gets further. */
  crashAt: number | undefined;
  async encodeFrame(frame: FrameToEncode) {
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
        decoderConfig: { codec: "avc1.64001e", description: new Uint8Array(this.description) },
      }),
    });
    while (this.queued.length > this.lag) this.#emit();
  }
  #emit() {
    const chunk = this.queued.shift();
    if (chunk) this.onChunk?.(chunk);
  }
  flushes = 0;
  async flushEncoding() {
    while (this.queued.length > 0) this.#emit();
    this.flushes += 1;
  }
  async finishEncoding() {
    while (this.queued.length > 0) this.#emit();
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
    : store.execute({ type: "clip.add", params: { timeline: "main", track, clip } });
  if (!added.ok) throw new Error(added.error.message);
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
      params: { timeline: "main", track: audio, clip: tone },
    });
    if (!placed.ok) throw new Error(placed.error.message);
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
    folders: { chooseFile, reopen } as unknown as FolderAccess,
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
    expect(context.writer.configs[0]).toMatchObject({ codec: "avc1.64001e" });
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

  it("runs one at a time", async () => {
    const context = setup();
    const hold = Promise.withResolvers<void>();
    context.compositor.hold = hold.promise;
    const running = context.videos.start();
    await answer(context);
    await vi.waitFor(() => expect(context.videos.getSnapshot()).toBeDefined());
    await context.videos.start();
    expect(context.said()).toContain("export.video.busy");
    hold.resolve();
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
    expect(context.file.abandoned).toBe(true);
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
    expect(context.file.abandoned).toBe(true);
    expect(context.writer.finished).toBe(false);
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
    expect(context.file.abandoned).toBe(true);
    expect(context.exports.saved.size).toBe(0);
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
    expect(context.file.abandoned).toBe(true);
  });

  it("stops when the compositor goes away", async () => {
    const context = setup();
    context.compositor.encodeFrame = () =>
      Promise.reject(new StillFailed({ reason: "compositor" }));
    const running = context.videos.start();
    await answer(context);
    expect((await notice(context)).message).toContain("export.failure.compositor");
    await running;
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

    it("stops when the new encoder encodes another way, because the file cannot take that", async () => {
      const context = closing();
      const running = context.videos.start();
      await answer(context);
      await vi.waitFor(() => expect(context.videos.getSnapshot()?.paused).toBe(true));
      context.compositor.description = [9, 9];
      context.videos.resume();
      const shown = await notice(context);
      await running;
      expect(shown.message).toContain("export.window.resumeFailed");
      expect(context.file.abandoned).toBe(true);
      expect(context.writer.frames).toHaveLength(0);
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
    expect(next.writer.configs[0]).toMatchObject({ codec: "avc1.64001e" });
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
