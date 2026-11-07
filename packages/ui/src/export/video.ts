import { SoundFailed, SoundMixer } from "@animaquill/audio";
import {
  buildAudioPlan,
  buildRenderPlan,
  type AudioPlan,
  type ProjectState,
  type ProjectStore,
  type RenderPlan,
} from "@animaquill/core";
import type {
  ExportStore,
  FileKind,
  FolderAccess,
  GrowingFile,
  SavedExport,
  SettingsStore,
} from "@animaquill/host";
import {
  containerOf,
  VideoFileWriter,
  type ByteSink,
  type EncodedFrame,
  type VideoFileOptions,
} from "@animaquill/media";
import {
  failureOf,
  StillFailed,
  type EncodedChunk,
  type FrameToEncode,
  type StillFailure,
} from "@animaquill/render";
import type { TFunction } from "i18next";
import { formatTimecode } from "../timeline/frames.ts";
import type { TimelineEditor } from "../timeline/editor.ts";
import type { Dialogs, FormField } from "../workbench/dialogs.ts";
import { Emitter } from "../workbench/emitter.ts";
import type { Notifications } from "../workbench/notifications.ts";
import type { ProjectSession } from "../workbench/session.ts";
import {
  browserSupport,
  chooseEncoding,
  inSoftware,
  QUALITIES,
  bitrateFor,
  type Quality,
  type SupportCheck,
  type VideoEncoding,
} from "./codecs.ts";
import {
  ExportCompositor,
  exportCompositorOptions,
  WindowClosed,
  type ExportCompositorOptions,
  type ExportSite,
} from "./compositor.ts";
import {
  fillExportWindow,
  pictureInPictureWindows,
  thisPage,
  type ExportWindow,
  type ExportWindows,
} from "./window.ts";
import {
  browserSoundSupport,
  chooseSoundEncoding,
  SoundTrackEncoder,
  type MakeAudioEncoder,
  type PieceMixer,
  type SoundEncoding,
  type SoundSupportCheck,
} from "./sound.ts";
import { PieceWriter, writeTracks } from "./pieces.ts";
import { describeFailure } from "./words.ts";

/** A key frame every this many seconds, which is what seeking in a player costs at most. */
const KEY_FRAME_SECONDS = 2;
/**
 * What an export keeps of where it got, every ten seconds of the video. A crash costs at most that,
 * and each time the encoder has to empty itself, which costs a moment.
 */
const KEY_FRAMES_PER_SEGMENT = 5;
/** Frames out of the encoder that may wait for the file. More means the disk does not keep up. */
const MAX_UNWRITTEN = 30;
/** People decide by this, so it should not jump around with every frame. */
const ESTIMATE_AFTER_FRAMES = 10;
const SETTINGS_KEY = "export.video";
/** Seconds are floats, frames are not. */
const FRAME_TOLERANCE = 1e-6;

export type VideoCompositor = Pick<
  ExportCompositor,
  "startEncoding" | "encodeFrame" | "flushEncoding" | "finishEncoding" | "dispose"
>;

export interface VideoWriter {
  add(frame: EncodedFrame, decoderConfig?: VideoDecoderConfig): Promise<void>;
  addSound(frame: EncodedFrame, decoderConfig?: AudioDecoderConfig): Promise<void>;
  finish(): Promise<void>;
  cancel(): Promise<void>;
}

export interface VideoExportOptions extends ExportSite {
  readonly session: ProjectSession;
  readonly timeline: TimelineEditor;
  readonly folders: FolderAccess;
  readonly settings: SettingsStore;
  readonly exports: ExportStore;
  readonly dialogs: Dialogs;
  readonly notifications: Notifications;
  readonly t: TFunction;
  /** For tests. */
  readonly compositor?: (options: ExportCompositorOptions) => VideoCompositor;
  readonly support?: SupportCheck;
  readonly writer?: (sink: ByteSink, options: VideoFileOptions) => Promise<VideoWriter>;
  readonly soundSupport?: SoundSupportCheck;
  readonly soundEncoder?: MakeAudioEncoder;
  readonly mixer?: (plan: AudioPlan) => PieceMixer;
  /** Where the compositor goes, when not into a window of its own made here. */
  readonly windows?: ExportWindows;
}

/**
 * Everything an export was asked to do, as it is kept for after a reload: the project comes back by
 * its snapshot, and the rest is settings.
 */
export interface SavedPlan {
  readonly version: 1;
  /** Of the files of the project when it started, see `snapshotOf`. */
  readonly snapshot: string;
  readonly timeline: string;
  readonly format: string;
  readonly range: Range;
  readonly quality: Quality;
  readonly kind: FileKind;
  readonly encoding: VideoEncoding;
  /** Nothing when there is no sound to hear, or none that can be encoded. */
  readonly sound: SoundEncoding | undefined;
}

/** How far it got, as far as is on the disk. */
export interface SavedProgress {
  /** The first frame that is not. It is a key frame. */
  readonly frame: number;
  /** How many pieces of picture are kept up to there. */
  readonly videoPieces: number;
  /** What the encoder said about decoding, which a new one has to say the same way. */
  readonly decoderConfig?: VideoDecoderConfig;
}

export interface SavedState {
  readonly plan: SavedPlan;
  readonly progress: SavedProgress;
}

/** An export as it runs. */
interface Job {
  readonly id: string;
  readonly plan: SavedPlan;
  readonly progress: SavedProgress | undefined;
  /** The project as it was when the export started, or as it is now, which is the same. */
  readonly state: ProjectState;
  readonly file: GrowingFile;
  readonly place: ExportWindow;
}

/** Sound gets mixed this far ahead of the picture, so that the file gets both in turns. */
const SOUND_LEAD_SECONDS = 1;

/** How an export is doing, for the status bar. */
export interface VideoJob {
  readonly name: string;
  readonly done: number;
  readonly total: number;
  /** Until there is enough to go by, nobody knows. */
  readonly remainingMs?: number;
  readonly stopping: boolean;
  /** In a window of its own, which goes on whatever happens to this page, or here. */
  readonly place: ExportWindow["kind"];
  /** Its window was closed. It waits for people to say it goes on. */
  readonly paused: boolean;
  /** All frames are encoded, and the file gets written. */
  readonly writing?: boolean;
}

/** A moment of the timeline that did not make it into the video. */
class FrameFailed extends Error {
  readonly index: number;
  readonly seconds: number;
  readonly failure: StillFailure;

  constructor(index: number, seconds: number, failure: StillFailure) {
    super(`Frame ${index}: ${failure.reason}`);
    this.index = index;
    this.seconds = seconds;
    this.failure = failure;
  }
}

/** A new encoder after a pause does not encode the way the first one did, so the file cannot go on. */
class ResumeFailed extends Error {
  constructor() {
    super("The encoder changed when the export went on");
  }
}

/** Whether frames of two encoders can be in one track: a track only says once how to decode. */
function sameDecoding(a: VideoDecoderConfig, b: VideoDecoderConfig): boolean {
  if (a.codec !== b.codec || a.codedWidth !== b.codedWidth || a.codedHeight !== b.codedHeight) {
    return false;
  }
  const bytes = (config: VideoDecoderConfig) =>
    config.description ? [...new Uint8Array(config.description as ArrayBuffer)].join() : "";
  return bytes(a) === bytes(b);
}

/** The file did not take what was written. */
class WriteFailed extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
  }
}

interface Range {
  readonly id: "all" | "selection";
  readonly from: number;
  readonly to: number;
}

/** The frames of a range, at the rate of the format. Times of the file start at zero. */
export function framesOf(
  { from, to }: { readonly from: number; readonly to: number },
  { num, den }: RenderPlan["scenes"]["fps"],
): {
  readonly total: number;
  /** Frames from one place to go on from to the next. Each of them is a key frame. */
  readonly segment: number;
  at(index: number): FrameToEncode;
} {
  const total = Math.max(Math.ceil(((to - from) * num) / den - FRAME_TOLERANCE), 0);
  const keyEvery = Math.max(Math.round((KEY_FRAME_SECONDS * num) / den), 1);
  const micros = (index: number) => Math.round((index * 1e6 * den) / num);
  return {
    total,
    segment: keyEvery * KEY_FRAMES_PER_SEGMENT,
    at: (index) => ({
      index,
      seconds: from + (index * den) / num,
      timestamp: micros(index),
      duration: micros(index + 1) - micros(index),
      keyFrame: index % keyEvery === 0,
    }),
  };
}

/** Ends as soon as people ask for it. What it was waiting for gets stopped by whoever called this. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) reject(signal.reason);
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    work.then(resolve, reject);
  });
}

const isQuality = (value: unknown): value is Quality =>
  typeof value === "string" && (QUALITIES as readonly string[]).includes(value);

/**
 * Exports a timeline as a video file without sound, frame by frame, each one drawn the way a still
 * is: with everything in it, or not at all. It takes the project as it is when it starts. Editing
 * goes on meanwhile and changes nothing about it, and the preview goes on working too.
 */
export class VideoExport {
  readonly #options: VideoExportOptions;
  readonly #emitter = new Emitter();
  #job: VideoJob | undefined;
  #controller: AbortController | undefined;
  readonly #windows: ExportWindows;
  /** Takes the window it goes on in, while it waits for one. */
  #resume: ((opening: Promise<ExportWindow | undefined>) => void) | undefined;

  constructor(options: VideoExportOptions) {
    this.#options = options;
    // A project that opens may have an export that stopped halfway, after a reload or a crash.
    let shown = options.session.store;
    options.session.subscribe(() => {
      const { store } = options.session;
      if (store === shown) return;
      shown = store;
      if (store) void this.#offer(store);
    });
    this.#windows =
      options.windows ??
      pictureInPictureWindows((page) =>
        fillExportWindow(page, options.t, this, () => this.cancel()),
      );
  }

  subscribe = this.#emitter.subscribe;
  getSnapshot = (): VideoJob | undefined => this.#job;

  #set(job: VideoJob | undefined): void {
    this.#job = job;
    this.#emitter.emit();
  }

  /** Stops the export under way. It cleans up after itself, and says so when it is over. */
  cancel(): void {
    if (!this.#job || !this.#controller) return;
    this.#set({ ...this.#job, stopping: true });
    this.#controller.abort(new DOMException("Export stopped", "AbortError"));
  }

  /**
   * Goes on after its window was closed, in a new one. People have to have pressed something just
   * now, or the browser opens no window: this is for a button.
   */
  resume(): void {
    const go = this.#resume;
    if (!go) return;
    this.#resume = undefined;
    go(this.#windows.supported ? this.#windows.open() : Promise.resolve(undefined));
  }

  /**
   * Asks whether an export of this project that stopped halfway goes on. Over when people decided,
   * and when the export is, if it goes on. It only asks when nothing else is asked right now.
   */
  async offerResume(): Promise<void> {
    const { store } = this.#options.session;
    if (store) await this.#offer(store);
  }

  async #offer(store: ProjectStore): Promise<void> {
    const { exports, dialogs, t } = this.#options;
    if (this.#job) return;
    const id = store.getState().manifest.id;
    const found = await exports.list(id).catch(() => []);
    const waiting = found
      .filter(({ state }) => (state as SavedState | undefined)?.plan?.version === 1)
      .toSorted((a, b) => b.savedAt - a.savedAt);
    for (const saved of waiting) {
      // Another window may be at it.
      const release = await exports.claim(saved.id);
      if (!release) continue;
      release();
      await this.#quiet();
      if (this.#options.session.store !== store || this.#job) return;
      const { plan, progress } = saved.state as SavedState;
      const total = this.#totalOf(store.getState(), plan);
      const answer = await dialogs.choose({
        title: t("export.resume.title"),
        message: t("export.resume.message", {
          file: nameOfTarget(saved.target),
          frame: progress.frame,
          total,
          percent: total > 0 ? Math.floor((progress.frame / total) * 100) : 0,
          interpolation: { escapeValue: false },
        }),
        choices: [
          { id: "discard", label: t("export.resume.discard") },
          { id: "continue", label: t("export.resume.continue"), kind: "primary" },
        ],
      });
      // Going back from there leaves it for the next time.
      if (answer === undefined) return;
      if (answer === "discard") await this.#discard(saved, plan.kind);
      else await this.#continue(store, saved);
      return;
    }
  }

  /** Until no dialog is open, which this would take the place of. */
  async #quiet(): Promise<void> {
    const { dialogs } = this.#options;
    if (!dialogs.getSnapshot()) return;
    await new Promise<void>((resolve) => {
      const stop = dialogs.subscribe(() => {
        if (dialogs.getSnapshot()) return;
        stop();
        resolve();
      });
    });
  }

  #totalOf(state: ProjectState, plan: SavedPlan): number {
    const render = buildRenderPlan(state, plan.timeline, { format: plan.format });
    return render ? framesOf(plan.range, render.scenes.fps).total : 0;
  }

  async #discard(saved: SavedExport, kind: FileKind): Promise<void> {
    const { exports, folders, notifications, t } = this.#options;
    await exports.remove(saved.id).catch(() => {});
    // The dialog for saving made an empty file, which should go with it.
    const file = await folders.reopen(saved.target, kind).catch(() => "gone" as const);
    const left =
      typeof file === "string"
        ? file === "denied"
        : await file.abandon().then(
            () => false,
            () => true,
          );
    notifications.push(t("export.resume.discarded"));
    if (left) {
      const name = nameOfTarget(saved.target);
      notifications.push(
        t("export.resume.emptyLeft", { file: name, interpolation: { escapeValue: false } }),
      );
    }
  }

  async #continue(store: ProjectStore, saved: SavedExport): Promise<void> {
    const { dialogs, folders, t, notifications } = this.#options;
    const state = saved.state as SavedState;
    let plan = state.plan;
    let progress: SavedProgress | undefined = state.progress;
    const name = nameOfTarget(saved.target);
    const plain = { interpolation: { escapeValue: false } };
    // The file first: the browser asks about it right after the button, which it takes for that.
    let file = await folders.reopen(saved.target, plan.kind).catch(() => "gone" as const);
    if (typeof file === "string") {
      const answer = await dialogs.choose({
        title: t("export.resume.goneTitle"),
        message: t(file === "gone" ? "export.resume.gone" : "export.resume.denied", {
          file: name,
          ...plain,
        }),
        choices: [
          { id: "discard", label: t("export.resume.discard") },
          { id: "choose", label: t("export.resume.chooseAgain"), kind: "primary" },
        ],
      });
      if (answer === "discard") {
        await this.#discard(saved, plan.kind);
        return;
      }
      if (answer !== "choose") return;
      const chosen = await folders.chooseFile(name, plan.kind).catch(() => undefined);
      if (!chosen) return;
      file = chosen;
    }
    const snapshot = await snapshotOf(store);
    if (snapshot !== plan.snapshot) {
      const answer = await dialogs.choose({
        title: t("export.resume.changedTitle"),
        message: t("export.resume.changed"),
        choices: [
          { id: "discard", label: t("export.resume.discard") },
          { id: "again", label: t("export.resume.again"), kind: "primary" },
        ],
      });
      if (answer !== "again") {
        if (answer === "discard") await this.#discard(saved, plan.kind);
        return;
      }
      plan = { ...plan, snapshot };
      progress = undefined;
    }
    if (!(await (this.#options.support ?? browserSupport)(plan.encoding.config))) {
      const render = buildRenderPlan(store.getState(), plan.timeline, { format: plan.format });
      const format = store.getState().manifest.formats.find(({ id }) => id === plan.format);
      const shape = render &&
        format && { width: format.width, height: format.height, fps: fpsOf(format.fps) };
      const encoding =
        shape &&
        (await chooseEncoding(shape, plan.quality, this.#options.support ?? browserSupport));
      // The file was asked for as one kind, and the other kind would not open as that.
      if (!encoding || containerOf(encoding.codec) !== containerOf(plan.encoding.codec)) {
        await this.#notice(t("export.video.failed"), t("export.video.cannotEncode"));
        return;
      }
      notifications.push(t("export.resume.cannotEncode"));
      plan = { ...plan, encoding };
      progress = undefined;
    }
    const place = await this.#placeFor();
    if (!place) return;
    await this.#run({ id: saved.id, plan, progress, state: store.getState(), file, place });
  }

  /** Asks how, and exports. Over when the export is. */
  async start(): Promise<void> {
    const { session, timeline, dialogs, notifications, t } = this.#options;
    if (this.#job) {
      notifications.push(t("export.video.busy"));
      return;
    }
    const { store } = session;
    const { model } = timeline;
    if (!store || !model) return;
    const state = store.getState();
    const { formats } = state.manifest;
    const quality = await this.#savedQuality();
    const support = this.#options.support ?? browserSupport;
    const encodings = new Map<string, VideoEncoding | undefined>();
    await Promise.all(
      formats.flatMap((format) =>
        QUALITIES.map(async (each) => {
          const shape = { width: format.width, height: format.height, fps: fpsOf(format.fps) };
          encodings.set(`${format.id}/${each}`, await chooseEncoding(shape, each, support));
        }),
      ),
    );
    if (![...encodings.values()].some(Boolean)) {
      await this.#notice(t("export.video.failed"), t("export.video.cannotEncode"));
      return;
    }
    const ranges = this.#ranges();
    const first = formats[0];
    const firstEncoding = first && encodings.get(`${first.id}/${quality}`);
    const audioPlan = buildAudioPlan(state, model.id);
    const soundSupport = this.#options.soundSupport ?? browserSoundSupport;
    const sounds = {
      mp4: await chooseSoundEncoding("mp4", soundSupport),
      webm: await chooseSoundEncoding("webm", soundSupport),
    };
    const audible = !new SoundMixer(audioPlan, { fileOf: async () => undefined }).silent;
    const firstSound = firstEncoding && sounds[containerOf(firstEncoding.codec)];
    const answer = await dialogs.form({
      title: t("export.video.title"),
      fields: this.#fields(state, ranges, quality),
      notes: this.#notes(state, firstEncoding, audible, firstSound),
      confirm: t("export.video.start"),
    });
    if (!answer) return;
    const format = formats.find(({ id }) => id === answer["format"]) ?? first;
    const range = ranges.find(({ id }) => id === answer["range"]) ?? ranges[0];
    const chosen = isQuality(answer["quality"]) ? answer["quality"] : quality;
    const encoding = format && encodings.get(`${format.id}/${chosen}`);
    if (!format || !range) return;
    if (!encoding) {
      await this.#notice(t("export.video.failed"), t("export.video.cannotEncodeFormat"));
      return;
    }
    const plan = buildRenderPlan(state, model.id, { format: format.id });
    if (!plan) return;
    if (framesOf(range, plan.scenes.fps).total === 0) {
      await this.#notice(t("export.video.failed"), t("export.video.empty"));
      return;
    }
    const container = containerOf(encoding.codec);
    const soundEncoding = sounds[container];
    const sound =
      audible && soundEncoding ? { plan: audioPlan, encoding: soundEncoding } : undefined;
    const kind: FileKind = {
      description: t(`export.video.kind.${container}`),
      mime: `video/${container}`,
      extension: container,
    };
    const name = t("export.video.file", {
      name: state.manifest.name,
      format: format.name,
      extension: container,
      interpolation: { escapeValue: false },
    });
    // This has to come right after people pressed the button: the browser asks where it goes.
    let file: GrowingFile | undefined;
    try {
      file = await this.#options.folders.chooseFile(name, kind);
    } catch (error) {
      console.warn("No file to export to", error);
      await this.#notice(t("export.video.failed"), t("export.video.noFile"));
      return;
    }
    if (!file) return;
    const place = await this.#placeFor();
    if (!place) {
      await file.abandon().catch(() => {});
      return;
    }
    void this.#saveQuality(chosen);
    const saved: SavedPlan = {
      version: 1,
      snapshot: await snapshotOf(store),
      timeline: model.id,
      format: format.id,
      range,
      quality: chosen,
      kind,
      encoding,
      sound: sound?.encoding,
    };
    const id = `export-${crypto.randomUUID()}`;
    await this.#run({ id, plan: saved, progress: undefined, state, file, place });
  }

  async #run(job: Job): Promise<void> {
    const { t, notifications } = this.#options;
    const exports = this.#options.exports;
    const { id, state, file, plan: saved } = job;
    const timelineId = saved.timeline;
    const plan = buildRenderPlan(state, timelineId, { format: saved.format });
    if (!plan) return;
    const { range } = saved;
    const frames = framesOf(range, plan.scenes.fps);
    const { total } = frames;
    const release = await exports.claim(id);
    if (!release) {
      notifications.push(t("export.resume.elsewhere"));
      return;
    }
    const controller = new AbortController();
    const { signal } = controller;
    this.#controller = controller;
    const resumed = job.progress;
    let started = { at: performance.now(), done: resumed?.frame ?? 0 };
    let place = job.place;
    this.#set({
      name: file.name,
      done: resumed?.frame ?? 0,
      total,
      stopping: false,
      place: place.kind,
      paused: false,
    });
    let compositor: VideoCompositor | undefined;
    let soundTrack: SoundTrackEncoder | undefined;
    let written: Promise<void> = Promise.resolve();
    let unwritten = 0;
    let writeFailed: WriteFailed | undefined;
    let used = saved.encoding;
    /** The disk does not keep up, and frames would pile up in memory. */
    const behind = () => unwritten > MAX_UNWRITTEN;
    const openCompositor = (where: ExportWindow): VideoCompositor => {
      const options = {
        ...exportCompositorOptions(this.#options, state, plan),
        document: where.document,
      };
      return this.#options.compositor?.(options) ?? new ExportCompositor(options);
    };
    let index = resumed?.frame ?? 0;
    let videoChunks = index;
    let decoding = resumed?.decoderConfig;
    let soundDecoding: AudioDecoderConfig | undefined;
    let changed = false;
    /** The first frames of a new encoder showed that it does not go on with what was there. */
    let startedOver = false;
    const fps = plan.scenes.fps.num / plan.scenes.fps.den;
    const video = new PieceWriter(exports, id, "video", resumed?.videoPieces ?? 0);
    const sound = new PieceWriter(exports, id, "sound");
    const keep = (work: () => Promise<void>) => {
      unwritten += 1;
      written = written
        .then(() => (writeFailed ? undefined : work()))
        .catch((error: unknown) => {
          writeFailed ??= new WriteFailed(error);
        })
        .finally(() => {
          unwritten -= 1;
        });
    };
    let target = file.target;
    const checkpoint = (frame: number) =>
      this.#keep(
        id,
        state.manifest.id,
        target,
        () => {
          target = { kind: "download", name: file.name };
          return target;
        },
        {
          plan: saved,
          progress: {
            frame,
            videoPieces: video.nextSeq,
            ...(decoding && { decoderConfig: decoding }),
          },
        },
      );
    try {
      // What came after the last place to go on from is not to be trusted, and the sound is
      // quick to make again, so that it never has a seam.
      await exports.dropPieces(id, "video", video.nextSeq);
      await exports.dropPieces(id, "sound", 0);
      await checkpoint(index);
      compositor = openCompositor(place);
      // An encoder may leave out how long a frame is, which would make the last one last no time.
      const frameMicros = Math.round((1e6 * plan.scenes.fps.den) / plan.scenes.fps.num);
      const onChunk = (chunk: EncodedChunk) => {
        if (chunk.decoderConfig) {
          decoding ??= chunk.decoderConfig;
          if (!sameDecoding(decoding, chunk.decoderConfig)) changed = true;
        }
        if (changed) return;
        videoChunks += 1;
        const frame: EncodedFrame = {
          data: new Uint8Array(chunk.data),
          key: chunk.key,
          timestamp: chunk.timestamp / 1e6,
          duration: (chunk.duration || frameMicros) / 1e6,
        };
        keep(() => video.add(frame));
      };
      used = await this.#startEncoder(compositor, used, onChunk, signal);
      if (saved.sound) {
        const audioPlan = buildAudioPlan(state, timelineId);
        const media = this.#options.projects.media(state.manifest.id);
        const mixer =
          this.#options.mixer?.(audioPlan) ??
          new SoundMixer(audioPlan, { fileOf: (hash) => media.get(hash) });
        soundTrack = new SoundTrackEncoder(
          mixer,
          range,
          saved.sound,
          (frame, decoderConfig) => {
            soundDecoding ??= decoderConfig;
            keep(() => sound.add(frame));
          },
          this.#options.soundEncoder,
        );
      }
      const hear = async (seconds: number) => {
        try {
          await untilAborted(soundTrack?.until(seconds) ?? Promise.resolve(), signal);
        } catch (error) {
          if (!(error instanceof SoundFailed)) throw error;
          const { sound: failed, reason } = error;
          const at = Math.max(failed.start, range.from);
          const where = Math.floor((at - range.from) * fps + FRAME_TOLERANCE);
          const failure = { reason, layer: failed.id, file: failed.file };
          throw new FrameFailed(where, at, failure);
        }
      };
      const segment = frames.segment;
      /** The first frame of a new encoder, which has to be a key frame. */
      let restartAt: number | undefined = index;
      for (;;) {
        const current = compositor;
        try {
          for (; index < total; index += 1) {
            if (writeFailed) throw writeFailed;
            if (changed) throw new ResumeFailed();
            if (index % segment === 0 && index !== restartAt) {
              // Everything before this frame is on the disk, and this is where it goes on from.
              await untilAborted(current.flushEncoding(), signal);
              await untilAborted(written, signal);
              await video.flush();
              if (writeFailed) throw writeFailed;
              if (changed) throw new ResumeFailed();
              await checkpoint(index);
            }
            const planned = frames.at(index);
            const frame = index === restartAt ? { ...planned, keyFrame: true } : planned;
            await hear(frame.timestamp / 1e6 + SOUND_LEAD_SECONDS);
            await untilAborted(current.encodeFrame(frame), signal).catch((error: unknown) => {
              if (error instanceof StillFailed) {
                throw new FrameFailed(index, frame.seconds, error.failure);
              }
              throw error;
            });
            while (behind()) await untilAborted(written, signal);
            this.#progress(index + 1, total, started);
          }
          await untilAborted(current.finishEncoding(), signal);
          if (changed) throw new ResumeFailed();
          break;
        } catch (error) {
          if (
            error instanceof ResumeFailed &&
            resumed &&
            !startedOver &&
            videoChunks === resumed.frame
          ) {
            // A new encoder that encodes another way: what was there cannot go on with this.
            notifications.push(t("export.resume.encoderChanged"));
            current.dispose();
            await untilAborted(written, signal);
            await exports.dropPieces(id, "video", 0);
            video.restart();
            changed = false;
            decoding = undefined;
            index = 0;
            videoChunks = 0;
            restartAt = 0;
            startedOver = true;
            started = { at: performance.now(), done: 0 };
            compositor = openCompositor(place);
            used = await this.#startEncoder(compositor, used, onChunk, signal);
            continue;
          }
          if (!(error instanceof WindowClosed) || signal.aborted) throw error;
          // What the encoder had not given out yet went with the window. It starts over there.
          current.dispose();
          await untilAborted(written, signal);
          index = videoChunks;
          restartAt = index;
          place = await this.#pause(signal, index, total);
          started = { at: performance.now(), done: index };
          compositor = openCompositor(place);
          used = await this.#startEncoder(compositor, used, onChunk, signal);
        }
      }
      await hear(Infinity);
      await untilAborted(soundTrack?.finish() ?? Promise.resolve(), signal);
      await untilAborted(written, signal);
      await video.flush();
      await sound.flush();
      if (writeFailed) throw writeFailed;
      await checkpoint(total);
      compositor.dispose();
      place.close();
      await this.#writeFile(id, file, saved, fps, decoding, soundDecoding, signal);
      await exports.remove(id).catch((error: unknown) => console.warn("An export stays", error));
      const done = file.kind === "download" ? "export.video.doneDownload" : "export.video.done";
      const picture = t(`export.video.encoded.${used.acceleration}`, {
        codec: t(`export.video.codecName.${used.codec}`),
      });
      const how = saved.sound
        ? t("export.video.encodedWithSound", {
            picture,
            sound: t(`export.video.codecName.${saved.sound.codec}`),
          })
        : picture;
      notifications.push(t(done, { file: file.name, how, interpolation: { escapeValue: false } }));
    } catch (error) {
      compositor?.dispose();
      // What went wrong is said here, and the window only shows how far it got.
      place.close();
      soundTrack?.close();
      const cleaned = await file.abandon().then(
        () => true,
        (reason: unknown) => {
          console.warn("An unfinished export stayed behind", reason);
          return false;
        },
      );
      await exports.remove(id).catch(() => {});
      this.#set(undefined);
      await this.#stopped(error, signal.aborted, cleaned, file, state, range);
    } finally {
      compositor?.dispose();
      place.close();
      release();
      this.#resume = undefined;
      this.#controller = undefined;
      this.#set(undefined);
    }
  }

  /**
   * Keeps where it got. A browser that cannot keep the file people chose gets a download instead,
   * after a reload, which people should know before that happens.
   */
  async #keep(
    id: string,
    project: string,
    target: unknown,
    instead: () => unknown,
    state: SavedState,
  ): Promise<void> {
    const { exports, notifications, t } = this.#options;
    const saved = { id, project, savedAt: Date.now(), state };
    try {
      await exports.save({ ...saved, target });
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "DataCloneError")) throw error;
      const download = instead();
      await exports.save({ ...saved, target: download });
      notifications.push(t("export.resume.noKeeping"));
    }
  }

  /** Puts what was kept into the file people chose, which is where it first gets written. */
  async #writeFile(
    id: string,
    file: GrowingFile,
    saved: SavedPlan,
    fps: number,
    decoding: VideoDecoderConfig | undefined,
    soundDecoding: AudioDecoderConfig | undefined,
    signal: AbortSignal,
  ): Promise<void> {
    const job = this.#job;
    if (job) this.#set({ ...job, writing: true });
    const makeWriter = this.#options.writer ?? ((sink, o) => VideoFileWriter.start(sink, o));
    const options: VideoFileOptions = {
      codec: saved.encoding.codec,
      frameRate: fps,
      ...(saved.sound && { sound: saved.sound.codec }),
    };
    const writer = await makeWriter(file, options).catch((error: unknown) => {
      throw new WriteFailed(error);
    });
    let firstPicture = true;
    let firstSound = true;
    try {
      await writeTracks(this.#options.exports, id, {
        add: (frame) => {
          const config = firstPicture ? decoding : undefined;
          firstPicture = false;
          signal.throwIfAborted();
          return writer.add(frame, config);
        },
        addSound: (frame) => {
          const config = firstSound ? soundDecoding : undefined;
          firstSound = false;
          signal.throwIfAborted();
          return writer.addSound(frame, config);
        },
      });
      await writer.finish();
      await file.finish();
    } catch (error) {
      await writer.cancel().catch(() => {});
      if (signal.aborted) throw error;
      throw new WriteFailed(error);
    }
  }

  /** Where it goes: a window of its own where there can be one, which takes people pressing. */
  async #placeFor(): Promise<ExportWindow | undefined> {
    const { dialogs, t } = this.#options;
    const windows = this.#windows;
    if (!windows.supported) return thisPage();
    if (windows.canOpenNow()) {
      const opened = await windows.open();
      if (opened) return opened;
    }
    const answer = await dialogs.choose({
      title: t("export.window.askTitle"),
      message: t("export.window.ask"),
      choices: [
        { id: "page", label: t("export.window.stay") },
        { id: "window", label: t("export.window.open"), kind: "primary" },
      ],
    });
    if (answer === undefined) return undefined;
    if (answer === "page") return thisPage();
    return (await windows.open()) ?? thisPage();
  }

  /** Waits for people to say it goes on, after its window was closed. */
  #pause(signal: AbortSignal, done: number, total: number): Promise<ExportWindow> {
    const { notifications, t } = this.#options;
    const job = this.#job;
    if (job) {
      const { name, stopping, place } = job;
      this.#set({ name, done, total, stopping, place, paused: true });
    }
    notifications.push(t("export.window.paused"));
    return new Promise((resolve, reject) => {
      const stop = () => reject(signal.reason);
      signal.addEventListener("abort", stop, { once: true });
      this.#resume = (opening) => {
        void opening.then((opened) => {
          signal.removeEventListener("abort", stop);
          const place = opened ?? thisPage();
          const now = this.#job;
          if (now) this.#set({ ...now, paused: false, place: place.kind });
          resolve(place);
        });
      };
    });
  }

  /** A graphics card can say it encodes and then not start. The processor is slower and there. */
  async #startEncoder(
    compositor: VideoCompositor,
    encoding: VideoEncoding,
    onChunk: (chunk: EncodedChunk) => void,
    signal: AbortSignal,
  ): Promise<VideoEncoding> {
    try {
      await untilAborted(compositor.startEncoding(encoding.config, onChunk), signal);
      return encoding;
    } catch (error) {
      if (signal.aborted || encoding.acceleration !== "hardware") throw error;
      console.warn("The graphics card does not encode, the processor does", error);
      const software = inSoftware(encoding);
      if (!(await (this.#options.support ?? browserSupport)(software.config))) throw error;
      await untilAborted(compositor.startEncoding(software.config, onChunk), signal);
      return software;
    }
  }

  #progress(
    done: number,
    total: number,
    started: { readonly at: number; readonly done: number },
  ): void {
    const job = this.#job;
    if (!job) return;
    const spent = performance.now() - started.at;
    const since = done - started.done;
    const remainingMs =
      since >= ESTIMATE_AFTER_FRAMES ? Math.round((spent / since) * (total - done)) : undefined;
    this.#set({
      ...job,
      done,
      total,
      ...(remainingMs !== undefined && { remainingMs }),
    });
  }

  async #stopped(
    error: unknown,
    cancelled: boolean,
    cleaned: boolean,
    file: GrowingFile,
    state: ProjectState,
    range: Range,
  ): Promise<void> {
    const { t, notifications, timeline } = this.#options;
    const plain = { interpolation: { escapeValue: false } };
    const left = cleaned ? "" : t("export.video.leftBehind", { file: file.name, ...plain });
    if (cancelled) {
      if (cleaned) notifications.push(t("export.video.cancelled"));
      else await this.#notice(t("export.video.cancelled"), left);
      return;
    }
    let message: string;
    if (error instanceof FrameFailed) {
      const at = this.#locate(error, range);
      const reason = describeFailure(t, error.failure, state, timeline);
      message = t("export.video.failedAt", { frame: error.index + 1, at, reason, ...plain });
    } else if (error instanceof ResumeFailed) {
      message = t("export.window.resumeFailed");
    } else if (error instanceof WriteFailed) {
      console.warn("Export stopped", error.cause);
      message = t("export.video.writeFailed", { file: file.name, error: error.message, ...plain });
    } else {
      console.warn("Export stopped", error);
      message = describeFailure(t, failureOf(error), state, timeline);
    }
    await this.#notice(t("export.video.failed"), `${message}${left}`);
  }

  /** Takes people to where it went wrong: the playhead goes there, and the clip gets selected. */
  #locate({ seconds, failure }: FrameFailed, range: Range): string {
    const { timeline } = this.#options;
    const { model } = timeline;
    if (!model) return "";
    const frame = Math.floor(Math.min(seconds, range.to) * model.rate.fps + FRAME_TOLERANCE);
    timeline.seek(frame);
    if ("layer" in failure && model.boxes.has(failure.layer)) timeline.selectOnly(failure.layer);
    return formatTimecode(frame, model.rate);
  }

  #ranges(): readonly Range[] {
    const { model, selection } = this.#options.timeline.getSnapshot();
    if (!model) return [];
    const all: Range = { id: "all", from: 0, to: model.duration };
    const boxes = [...selection].flatMap((id) => {
      const box = model.boxes.get(id);
      return box ? [box] : [];
    });
    if (boxes.length === 0) return [all];
    const from = Math.min(...boxes.map(({ start }) => start));
    const to = Math.max(...boxes.map(({ end }) => end));
    return [all, { id: "selection", from, to }];
  }

  #fields(state: ProjectState, ranges: readonly Range[], quality: Quality): FormField[] {
    const { t, timeline } = this.#options;
    const rate = timeline.model?.rate;
    const at = (seconds: number) =>
      rate ? formatTimecode(Math.round(seconds * rate.fps), rate) : String(seconds);
    const { formats } = state.manifest;
    return [
      {
        id: "format",
        label: t("export.video.format"),
        value: formats[0]?.id ?? "",
        options: formats.map(({ id, name, width, height, fps }) => ({
          id,
          label: t("export.video.formatOption", { name, width, height, fps, ...PLAIN }),
        })),
      },
      {
        id: "range",
        label: t("export.video.range"),
        value: ranges.at(-1)?.id ?? "all",
        options: ranges.map(({ id, from, to }) => ({
          id,
          label: t(`export.video.ranges.${id}`, { from: at(from), to: at(to) }),
        })),
      },
      {
        id: "quality",
        label: t("export.video.quality"),
        value: quality,
        options: QUALITIES.map((id) => ({ id, label: t(`export.video.qualities.${id}`) })),
      },
    ];
  }

  #notes(
    state: ProjectState,
    encoding: VideoEncoding | undefined,
    audible: boolean,
    sound: SoundEncoding | undefined,
  ): string[] {
    const { t, timeline } = this.#options;
    const notes: string[] = [];
    const first = state.manifest.formats[0];
    if (first) {
      const shape = { width: first.width, height: first.height, fps: fpsOf(first.fps) };
      const mbps = (each: Quality) => (bitrateFor(shape, each) / 1e6).toFixed(1);
      notes.push(
        t("export.video.bitrates", {
          width: first.width,
          height: first.height,
          fps: shape.fps,
          small: mbps("small"),
          standard: mbps("standard"),
          high: mbps("high"),
        }),
      );
    }
    if (encoding) {
      notes.push(t(`export.video.codec.${encoding.codec}`));
      notes.push(t(`export.video.acceleration.${encoding.acceleration}`));
    }
    if (!audible) notes.push(t("export.video.sound.none"));
    else if (!sound) notes.push(t("export.video.sound.cannot"));
    else if (sound.codec === "aac") notes.push(t("export.video.sound.aac"));
    else if (encoding && containerOf(encoding.codec) === "mp4") {
      notes.push(t("export.video.sound.opusInMp4"));
    } else notes.push(t("export.video.sound.opus"));
    const tracks = Object.values(state.timelines[timeline.model?.id ?? ""]?.tracks ?? {});
    const clips = Object.values(state.timelines[timeline.model?.id ?? ""]?.clips ?? {});
    const captions = new Set(tracks.filter(({ kind }) => kind === "caption").map(({ id }) => id));
    if (clips.some(({ track }) => captions.has(track))) notes.push(t("export.video.noCaptions"));
    notes.push(t(this.#windows.supported ? "export.window.inWindow" : "export.window.noWindow"));
    notes.push(t("export.video.snapshot"));
    return notes;
  }

  async #notice(title: string, message: string): Promise<void> {
    await this.#options.dialogs.confirm({
      title,
      message,
      confirm: this.#options.t("dialog.close"),
      noticeOnly: true,
    });
  }

  async #savedQuality(): Promise<Quality> {
    const saved = await this.#options.settings.load(SETTINGS_KEY).catch(() => undefined);
    const quality = (saved as { quality?: unknown } | undefined)?.quality;
    return isQuality(quality) ? quality : "standard";
  }

  async #saveQuality(quality: Quality): Promise<void> {
    await this.#options.settings.save(SETTINGS_KEY, { quality }).catch(() => {});
  }
}

const PLAIN = { interpolation: { escapeValue: false } };

/** What a target was called when it was made, for people. */
function nameOfTarget(target: unknown): string {
  const known = target as { readonly name?: string; readonly handle?: { readonly name?: string } };
  return known.handle?.name ?? known.name ?? "";
}

/**
 * What a project is, as text, in a few bytes: two of them that read the same are the same. An
 * export that goes on after a reload only does that with the project it started with.
 */
export async function snapshotOf(store: ProjectStore): Promise<string> {
  const { files } = store.exportFiles();
  const text = [...files]
    .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([path, content]) => `${path}\u0000${content}`)
    .join("\u0000");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** A rate as the project writes it, such as "30" or "30000/1001". */
function fpsOf(rate: string): number {
  const [num = "30", den = "1"] = rate.split("/");
  return Number(num) / Number(den);
}
