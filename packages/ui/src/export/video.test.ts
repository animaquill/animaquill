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
    // Nothing got as far as a place to go on from: nothing stays, and nothing says it does.
    expect(shown.message).not.toContain("export.video.kept");
    expect(context.file.abandoned).toBe(true);
    expect(context.exports.saved.size).toBe(0);
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
    store.execute({ type: "sound.add", params: { id: "s", sound, files: { "sound.js": code } } });
    const clip = {
      id: "bell",
      start: "1",
      duration: "1",
      source: { kind: "sound", sound: "s" },
      properties: { "param.duration": 1 },
    };
    const placed = store.execute({
      type: "clip.add",
      params: { timeline: "main", track: audio, clip },
    });
    if (!placed.ok) throw new Error(placed.error.message);
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
    // Nothing got as far as a place to go on from: nothing stays, and nothing says it does.
    expect(shown.message).not.toContain("export.video.kept");
    expect(context.file.abandoned).toBe(true);
    expect(context.exports.saved.size).toBe(0);
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
    // Nothing got as far as a place to go on from: nothing stays, and nothing says it does.
    expect(shown.message).not.toContain("export.video.kept");
    expect(context.file.abandoned).toBe(true);
    expect(context.exports.saved.size).toBe(0);
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
    // Nothing got as far as a place to go on from: nothing stays, and nothing says it does.
    expect(shown.message).not.toContain("export.video.kept");
    expect(context.file.abandoned).toBe(true);
    expect(context.exports.saved.size).toBe(0);
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
    next.store.execute({ type: "clip.add", params: { timeline: "main", track, clip: longer } });
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
    expect((await context.exports.all()).map(({ id }) => id)).toEqual([older?.id]);
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
