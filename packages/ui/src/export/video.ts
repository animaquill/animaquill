import { readSound, SoundFailed, SoundMixer, type SoundSource } from "@animaquill/audio";
import {
  buildAudioPlan,
  buildRenderPlan,
  madeSoundsOf,
  timelineLength,
  type AudioPlan,
  type ProjectState,
  type ProjectStore,
  type RenderPlan,
  type SoundLayer,
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
import { failureOf, StillFailed, type EncodedChunk, type FrameToEncode } from "@animaquill/render";
import { toSeconds } from "@animaquill/schema";
import type { TFunction } from "i18next";
import { formatTimecode } from "../timeline/frames.ts";
import type { TimelineEditor } from "../timeline/editor.ts";
import type { Dialogs, FormField } from "../workbench/dialogs.ts";
import { Emitter } from "../workbench/emitter.ts";
import type { Notifications } from "../workbench/notifications.ts";
import type { MadeSounds, SoundFailure } from "../media/sounds.ts";
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
import { describeFailure, type ExportFailure } from "./words.ts";

/** An export that nobody went on with for this long is not going to be. */
const KEEP_UNFINISHED_MS = 30 * 24 * 60 * 60 * 1000;
/** Sound that has to catch up does so this much at a time, and says how far it is in between. */
const CATCH_UP_SECONDS = 30;
/** What an export keeps is about as large as its video. A little more, to be sure. */
const ROOM_MARGIN = 1.2;
/** Larger than any frame an encoder gives at any bitrate it takes. */
const MAX_CHUNK_BYTES = 64 * 1024 * 1024;

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
  /** Where sounds made by code come from. */
  readonly sounds: Pick<MadeSounds, "whenMade">;
  readonly mixer?: (plan: AudioPlan, source: SoundSource) => PieceMixer;
  /** How much room the browser has for what an export keeps. */
  readonly storage?: () => Promise<StorageEstimate | undefined>;
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
  /** How much of the disk that takes, for people deciding what to clear. */
  readonly bytes?: number;
  /** What the encoder said about decoding, which a new one has to say the same way. */
  readonly decoderConfig?: VideoDecoderConfig;
}

export interface SavedState {
  readonly plan: SavedPlan;
  readonly progress: SavedProgress;
}

/** An export that stopped halfway, as people see it. */
export interface UnfinishedExport {
  readonly id: string;
  readonly project: string;
  readonly name: string;
  readonly savedAt: number;
  /** What it keeps takes this much room. */
  readonly bytes: number;
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
  /** The sound catches up, after a reload, this much of the way. */
  readonly catchingUp?: number;
  /** Code makes a sound that comes next, and the picture waits for it. */
  readonly makingSound?: boolean;
}

/** A moment of the timeline that did not make it into the video. */
class FrameFailed extends Error {
  readonly index: number;
  readonly seconds: number;
  readonly failure: ExportFailure;

  constructor(index: number, seconds: number, failure: ExportFailure) {
    super(`Frame ${index}: ${failure.reason}`);
    this.index = index;
    this.seconds = seconds;
    this.failure = failure;
  }
}

/** Code did not make a sound that the export needs, and without it the file would sound wrong. */
class SoundNotMade extends Error {
  readonly sound: SoundLayer;
  readonly why: SoundFailure;

  constructor(sound: SoundLayer, why: SoundFailure) {
    super(`Sound ${sound.id} not made: ${why}`);
    this.sound = sound;
    this.why = why;
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

/** The compositor gave something that is not what it was asked for. */
class WrongOutput extends Error {
  constructor(what: string) {
    super(`The compositor gave what was not asked for: ${what}`);
  }
}

/** What is wrong with a chunk from the sandbox, if anything: it gets checked like any input. */
function problemWith(
  chunk: EncodedChunk,
  asked: ReadonlySet<number>,
  codec: string,
): string | undefined {
  const { data, key, timestamp, duration, decoderConfig } = chunk;
  if (
    !(data instanceof ArrayBuffer) ||
    data.byteLength === 0 ||
    data.byteLength > MAX_CHUNK_BYTES
  ) {
    return "data";
  }
  if (typeof key !== "boolean") return "key";
  if (!Number.isFinite(timestamp) || !asked.has(timestamp)) return "timestamp";
  if (!Number.isFinite(duration) || duration < 0) return "duration";
  if (decoderConfig && !decoderConfig.codec.startsWith(codec)) return "codec";
  return undefined;
}

const isQuotaError = (error: unknown): boolean =>
  error instanceof DOMException
    ? error.name === "QuotaExceededError"
    : error instanceof Error && isQuotaError(error.cause);

const browserStorage = async (): Promise<StorageEstimate | undefined> =>
  (globalThis as { navigator?: Navigator }).navigator?.storage?.estimate?.();

/** Bytes for people. */
export function sizeOf(bytes: number): string {
  const gigabytes = bytes / 1024 ** 3;
  return gigabytes >= 1 ? `${gigabytes.toFixed(1)} GB` : `${Math.ceil(bytes / 1024 ** 2)} MB`;
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
  /** Something asks about an export, which nothing else may do at the same time. */
  #busy = false;
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

  /** Whether an export, or the questions before one, is under way in this window. */
  #isBusy(): boolean {
    return this.#busy || this.#job !== undefined;
  }

  /**
   * Asks about each export of this project that stopped before it was finished. Returns whether
   * people went on with one or gave it up, as opposed to leaving it for later or there being none.
   */
  async #offer(store: ProjectStore): Promise<boolean> {
    const { exports, dialogs, t } = this.#options;
    if (this.#isBusy()) return false;
    const id = store.getState().manifest.id;
    const found = await exports.list(id).catch(() => []);
    const waiting = found
      .filter(({ state }) => (state as SavedState | undefined)?.plan?.version === 1)
      .toSorted((a, b) => b.savedAt - a.savedAt);
    for (const saved of waiting) {
      // Another window may be at it, or asking about it. The one that asks keeps it until it is
      // decided, so that two windows never do two things with one export.
      const release = await exports.claim(saved.id);
      if (!release) continue;
      if (Date.now() - saved.savedAt > KEEP_UNFINISHED_MS) {
        await exports.remove(saved.id).catch(() => {});
        release();
        continue;
      }
      await this.#quiet();
      if (this.#options.session.store !== store || this.#isBusy()) {
        release();
        return false;
      }
      this.#busy = true;
      try {
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
        if (answer === undefined) {
          release();
          return false;
        }
        if (answer === "discard") {
          await this.#discard(saved, plan.kind);
          release();
          return true;
        }
        this.#busy = false;
        await this.#continue(store, saved, release);
        return true;
      } finally {
        this.#busy = false;
      }
    }
    return false;
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

  /** What it kept goes. The file only goes if it is still the empty one the export made. */
  async #discard(saved: SavedExport, kind: FileKind): Promise<void> {
    const { exports, folders, notifications, t } = this.#options;
    await exports.remove(saved.id).catch(() => {});
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

  async #continue(store: ProjectStore, saved: SavedExport, release: () => void): Promise<void> {
    let handedOn = false;
    try {
      handedOn = await this.#goOn(store, saved, release);
    } finally {
      if (!handedOn) release();
    }
  }

  /** Returns whether the export took over the claim on it. */
  async #goOn(store: ProjectStore, saved: SavedExport, release: () => void): Promise<boolean> {
    const { dialogs, folders, t, notifications } = this.#options;
    const state = saved.state as SavedState;
    let plan = state.plan;
    let progress: SavedProgress | undefined = state.progress;
    const name = nameOfTarget(saved.target);
    const plain = { interpolation: { escapeValue: false } };
    this.#busy = true;
    try {
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
          return false;
        }
        if (answer !== "choose") return false;
        const chosen = await folders.chooseFile(name, plan.kind).catch(() => undefined);
        if (!chosen) return false;
        file = chosen;
      }
      if (!(await (this.#options.support ?? browserSupport)(plan.encoding.config))) {
        const encoding = await this.#encodingFor(store.getState(), plan);
        // The file was asked for as one kind, and the other kind would not open as that.
        if (!encoding || containerOf(encoding.codec) !== containerOf(plan.encoding.codec)) {
          await this.#notice(t("export.video.failed"), t("export.video.cannotEncode"));
          return false;
        }
        notifications.push(t("export.resume.cannotEncode"));
        plan = { ...plan, encoding };
        progress = undefined;
      }
      const place = await this.#placeFor();
      if (!place) return false;
      // What the video is drawn from, and what it is checked against, at the same moment.
      const now = store.getState();
      const snapshot = await snapshotOfFiles(store.exportFiles().files);
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
          place.close();
          if (answer === "discard") await this.#discard(saved, plan.kind);
          return false;
        }
        const again = this.#planAgain(now, plan);
        if (!again) {
          place.close();
          await this.#notice(t("export.video.failed"), t("export.resume.planGone"));
          return false;
        }
        plan = { ...again, snapshot };
        progress = undefined;
        if (store.getState() !== now) {
          // It changed again while people were asked. Then this is a new snapshot again.
          place.close();
          return false;
        }
      }
      this.#busy = false;
      await this.#run({ id: saved.id, plan, progress, state: now, file, place }, release);
      return true;
    } finally {
      this.#busy = false;
    }
  }

  /** An encoding for the format of a plan, the way the plan wanted it, in this browser. */
  async #encodingFor(state: ProjectState, plan: SavedPlan): Promise<VideoEncoding | undefined> {
    const format = state.manifest.formats.find(({ id }) => id === plan.format);
    if (!format) return undefined;
    const shape = { width: format.width, height: format.height, fps: fpsOf(format.fps) };
    return chooseEncoding(shape, plan.quality, this.#options.support ?? browserSupport);
  }

  /**
   * The same export of the project as it is now: the whole timeline is as long as it is now, and a
   * part of it stays where it was. Nothing when what it was of is not there any more.
   */
  #planAgain(state: ProjectState, plan: SavedPlan): SavedPlan | undefined {
    const timeline = state.timelines[plan.timeline];
    const format = state.manifest.formats.find(({ id }) => id === plan.format);
    if (!timeline || !format) return undefined;
    const length = toSeconds(timelineLength(timeline));
    const range =
      plan.range.id === "all"
        ? { ...plan.range, to: length }
        : { ...plan.range, to: Math.min(plan.range.to, length) };
    if (range.to <= range.from) return undefined;
    return { ...plan, range };
  }

  /** What exports that stopped halfway keep on this device, for people to see and clear. */
  async unfinished(): Promise<readonly UnfinishedExport[]> {
    const all = await this.#options.exports.all().catch(() => []);
    return all
      .filter(({ state }) => (state as SavedState | undefined)?.plan?.version === 1)
      .map(({ id, project, savedAt, target, state }) => ({
        id,
        project,
        savedAt,
        name: nameOfTarget(target),
        bytes: (state as SavedState).progress.bytes ?? 0,
      }))
      .toSorted((a, b) => b.savedAt - a.savedAt);
  }

  /** Takes away what an export that stopped halfway keeps. False when a window is at it. */
  async forget(id: string): Promise<boolean> {
    const { exports } = this.#options;
    const release = await exports.claim(id);
    if (!release) return false;
    try {
      await exports.remove(id);
      return true;
    } finally {
      release();
    }
  }

  /** Asks how, and exports. Over when the export is. */
  async start(): Promise<void> {
    const { session, notifications, t } = this.#options;
    if (this.#isBusy()) {
      notifications.push(t("export.video.busy"));
      return;
    }
    const { store } = session;
    if (!store) return;
    // One that stopped halfway comes first: it is what people likely want, and it holds the place.
    if (await this.#offer(store)) return;
    if (this.#isBusy()) return;
    this.#busy = true;
    let job: Job | undefined;
    let release: (() => void) | undefined;
    try {
      const prepared = await this.#prepare(store);
      job = prepared?.job;
      release = prepared?.release;
    } finally {
      this.#busy = false;
    }
    if (job && release) await this.#run(job, release);
  }

  async #prepare(
    store: ProjectStore,
  ): Promise<{ readonly job: Job; readonly release: () => void } | undefined> {
    const { timeline, dialogs, t, exports } = this.#options;
    const { model } = timeline;
    if (!model) return undefined;
    const asked = store.getState();
    const { formats } = asked.manifest;
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
      return undefined;
    }
    const ranges = this.#ranges();
    const first = formats[0];
    const firstEncoding = first && encodings.get(`${first.id}/${quality}`);
    const audioPlan = buildAudioPlan(asked, model.id);
    const soundSupport = this.#options.soundSupport ?? browserSoundSupport;
    const sounds = {
      mp4: await chooseSoundEncoding("mp4", soundSupport),
      webm: await chooseSoundEncoding("webm", soundSupport),
    };
    const audible = !new SoundMixer(audioPlan, { fileOf: async () => undefined }).silent;
    const firstSound = firstEncoding && sounds[containerOf(firstEncoding.codec)];
    const answer = await dialogs.form({
      title: t("export.video.title"),
      fields: this.#fields(asked, ranges, quality),
      notes: this.#notes(asked, firstEncoding, audible, firstSound),
      confirm: t("export.video.start"),
    });
    if (!answer) return undefined;
    const format = formats.find(({ id }) => id === answer["format"]) ?? first;
    const range = ranges.find(({ id }) => id === answer["range"]) ?? ranges[0];
    const chosen = isQuality(answer["quality"]) ? answer["quality"] : quality;
    const encoding = format && encodings.get(`${format.id}/${chosen}`);
    if (!format || !range) return undefined;
    if (!encoding) {
      await this.#notice(t("export.video.failed"), t("export.video.cannotEncodeFormat"));
      return undefined;
    }
    const plan = buildRenderPlan(asked, model.id, { format: format.id });
    if (!plan) return undefined;
    const total = framesOf(range, plan.scenes.fps).total;
    if (total === 0) {
      await this.#notice(t("export.video.failed"), t("export.video.empty"));
      return undefined;
    }
    const container = containerOf(encoding.codec);
    const soundEncoding = audible ? sounds[container] : undefined;
    const seconds = range.to - range.from;
    const bytes =
      ((encoding.config.bitrate ?? 0) + (soundEncoding?.config.bitrate ?? 0)) * (seconds / 8);
    if (!(await this.#roomFor(bytes))) return undefined;
    const kind: FileKind = {
      description: t(`export.video.kind.${container}`),
      mime: `video/${container}`,
      extension: container,
    };
    const name = t("export.video.file", {
      name: asked.manifest.name,
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
      return undefined;
    }
    if (!file) return undefined;
    const place = await this.#placeFor();
    if (!place) {
      await file.abandon().catch(() => {});
      return undefined;
    }
    void this.#saveQuality(chosen);
    // What the video is drawn from and what it is known by, at one moment: people may have changed
    // the project while they chose.
    const state = store.getState();
    const snapshot = await snapshotOfFiles(store.exportFiles().files);
    const saved: SavedPlan = {
      version: 1,
      snapshot,
      timeline: model.id,
      format: format.id,
      range,
      quality: chosen,
      kind,
      encoding,
      sound: soundEncoding,
    };
    const id = `export-${crypto.randomUUID()}`;
    const release = await exports.claim(id);
    if (!release) {
      place.close();
      return undefined;
    }
    return { job: { id, plan: saved, progress: undefined, state, file, place }, release };
  }

  /**
   * Whether this device has room for what the export keeps while it runs, which is about as much
   * as the video itself. Asks when it looks short, because the estimate of a browser is only that.
   */
  async #roomFor(bytes: number): Promise<boolean> {
    const { dialogs, t } = this.#options;
    const estimate = await (this.#options.storage ?? browserStorage)().catch(() => undefined);
    if (!estimate?.quota) return true;
    const free = estimate.quota - (estimate.usage ?? 0);
    const needed = bytes * ROOM_MARGIN;
    if (free >= needed) return true;
    const answer = await dialogs.choose({
      title: t("export.storage.title"),
      message: t("export.storage.short", { needed: sizeOf(needed), free: sizeOf(free) }),
      choices: [{ id: "go", label: t("export.storage.anyway") }],
    });
    return answer === "go";
  }

  async #run(job: Job, release: () => void): Promise<void> {
    const { t, notifications } = this.#options;
    const exports = this.#options.exports;
    const { id, state, file, plan: saved } = job;
    let place = job.place;
    const timelineId = saved.timeline;
    const plan = buildRenderPlan(state, timelineId, { format: saved.format });
    if (!plan) {
      place.close();
      release();
      return;
    }
    const { range } = saved;
    const frames = framesOf(range, plan.scenes.fps);
    const { total } = frames;
    const controller = new AbortController();
    const { signal } = controller;
    this.#controller = controller;
    const resumed = job.progress;
    let started = { at: performance.now(), done: resumed?.frame ?? 0 };
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
    let bytes = resumed?.bytes ?? 0;
    let decoding = resumed?.decoderConfig;
    let soundDecoding: AudioDecoderConfig | undefined;
    let changed = false;
    /** Something came back that is not what was asked for. */
    let wrong: string | undefined;
    /** Timestamps of frames asked for, whose chunks have not come yet. */
    const asked = new Set<number>();
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
            bytes,
            ...(decoding && { decoderConfig: decoding }),
          },
        },
      );
    /** Where the encoder now in use started, and what it is to be done about it. */
    let encoderStart = index;
    let next: "compositor" | "encoder" | undefined = "compositor";
    let triedSoftware = used.acceleration === "software";
    try {
      // What came after the last place to go on from is not to be trusted, and the sound is
      // quick to make again, so that it never has a seam.
      await exports.dropPieces(id, "video", video.nextSeq);
      await exports.dropPieces(id, "sound", 0);
      await checkpoint(index);
      // An encoder may leave out how long a frame is, which would make the last one last no time.
      const frameMicros = Math.round((1e6 * plan.scenes.fps.den) / plan.scenes.fps.num);
      const prefix = used.config.codec.slice(0, 4);
      const onChunk = (chunk: EncodedChunk) => {
        // What comes out of the sandbox is checked like anything that comes from outside.
        const problem = problemWith(chunk, asked, prefix);
        if (problem) {
          wrong ??= problem;
          return;
        }
        asked.delete(chunk.timestamp);
        if (chunk.decoderConfig) {
          decoding ??= chunk.decoderConfig;
          if (!sameDecoding(decoding, chunk.decoderConfig)) changed = true;
        }
        if (changed) return;
        videoChunks += 1;
        bytes += chunk.data.byteLength;
        const frame: EncodedFrame = {
          data: new Uint8Array(chunk.data),
          key: chunk.key,
          timestamp: chunk.timestamp / 1e6,
          duration: (chunk.duration || frameMicros) / 1e6,
        };
        keep(() => video.add(frame));
      };
      if (saved.sound) {
        const audioPlan = buildAudioPlan(state, timelineId);
        const media = this.#options.projects.media(state.manifest.id);
        const made = new Map(madeSoundsOf(state, timelineId).map((each) => [each.file, each]));
        // A sound made by code is a file like any other once it is there, made from this state.
        const source: SoundSource = async (layer) => {
          const wanted = layer.made && made.get(layer.file);
          if (!wanted) return undefined;
          this.#makingSound(true);
          const outcome = await untilAborted(
            this.#options.sounds.whenMade(wanted, state, signal),
            signal,
          ).finally(() => this.#makingSound(false));
          if (outcome.state === "failed") throw new SoundNotMade(layer, outcome.reason);
          const wav = await media.get(layer.file).catch(() => undefined);
          if (!wav) throw new SoundFailed(layer, "missing-file");
          return (from, to) => readSound(wav, from, to);
        };
        const mixer =
          this.#options.mixer?.(audioPlan, source) ??
          new SoundMixer(audioPlan, { fileOf: (hash) => media.get(hash), source });
        soundTrack = new SoundTrackEncoder(
          mixer,
          range,
          saved.sound,
          (frame, decoderConfig) => {
            soundDecoding ??= decoderConfig;
            bytes += frame.data.byteLength;
            keep(() => sound.add(frame));
          },
          this.#options.soundEncoder,
        );
      }
      const hear = async (seconds: number) => {
        const track = soundTrack;
        if (!track) return;
        try {
          const goal = Math.min(seconds, range.to - range.from);
          // After a reload the sound starts over, which takes a while: people should see that.
          while (goal - track.seconds > CATCH_UP_SECONDS) {
            this.#catchingUp(track.seconds, goal);
            await untilAborted(track.until(track.seconds + CATCH_UP_SECONDS), signal);
          }
          await untilAborted(track.until(goal), signal);
          this.#catchingUp(undefined, 0);
        } catch (error) {
          if (!(error instanceof SoundFailed || error instanceof SoundNotMade)) throw error;
          const failed = error.sound;
          const at = Math.max(failed.start, range.from);
          const where = Math.floor((at - range.from) * fps + FRAME_TOLERANCE);
          const failure: ExportFailure =
            error instanceof SoundNotMade
              ? { reason: "sound-not-made", layer: failed.id, why: error.why }
              : { reason: error.reason, layer: failed.id, file: failed.file };
          throw new FrameFailed(where, at, failure);
        }
      };
      const segment = frames.segment;
      /** The first frame of a new encoder, which has to be a key frame. */
      let restartAt: number | undefined = index;
      for (;;) {
        try {
          if (next === "compositor") {
            compositor?.dispose();
            compositor = openCompositor(place);
          }
          const current = compositor as VideoCompositor;
          if (next) {
            next = undefined;
            asked.clear();
            encoderStart = index;
            restartAt = index;
            used = await this.#startEncoder(current, used, onChunk, signal);
          }
          for (; index < total; index += 1) {
            if (writeFailed) throw writeFailed;
            if (wrong) throw new WrongOutput(wrong);
            if (changed) throw new ResumeFailed();
            if (index % segment === 0 && index !== restartAt) {
              // Everything before this frame is on the disk, and this is where it goes on from.
              await untilAborted(current.flushEncoding(), signal);
              await untilAborted(written, signal);
              await video.flush();
              if (writeFailed) throw writeFailed;
              if (changed) throw new ResumeFailed();
              if (wrong) throw new WrongOutput(wrong);
              // A frame for each frame, and none more.
              if (videoChunks !== index) throw new WrongOutput("count");
              await checkpoint(index);
            }
            const planned = frames.at(index);
            const frame = index === restartAt ? { ...planned, keyFrame: true } : planned;
            await hear(frame.timestamp / 1e6 + SOUND_LEAD_SECONDS);
            asked.add(frame.timestamp);
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
          if (wrong) throw new WrongOutput(wrong);
          await untilAborted(written, signal);
          if (videoChunks !== total) throw new WrongOutput("count");
          break;
        } catch (error) {
          if (signal.aborted) throw error;
          if (error instanceof ResumeFailed && !startedOver && videoChunks === encoderStart) {
            // A new encoder that encodes another way: what was there cannot go on with this.
            notifications.push(t("export.resume.encoderChanged"));
            await untilAborted(written, signal);
            await exports.dropPieces(id, "video", 0);
            video.restart();
            changed = false;
            decoding = undefined;
            index = 0;
            videoChunks = 0;
            bytes = 0;
            startedOver = true;
            await checkpoint(0);
            started = { at: performance.now(), done: 0 };
            next = "encoder";
            continue;
          }
          const encoderBroke =
            error instanceof FrameFailed &&
            error.failure.reason === "failed" &&
            videoChunks === encoderStart;
          if (encoderBroke && !triedSoftware) {
            // A graphics card that said it encodes and then does not: the processor does.
            console.warn("The graphics card does not encode, the processor does", error);
            triedSoftware = true;
            used = inSoftware(used);
            next = "encoder";
            continue;
          }
          if (!(error instanceof WindowClosed)) throw error;
          // What the encoder had not given out yet went with the window. It starts over there.
          compositor?.dispose();
          await untilAborted(written, signal);
          index = videoChunks;
          place = await this.#pause(signal, index, total);
          started = { at: performance.now(), done: index };
          next = "compositor";
        }
      }
      await hear(Infinity);
      await untilAborted(soundTrack?.finish() ?? Promise.resolve(), signal);
      await untilAborted(written, signal);
      await video.flush();
      await sound.flush();
      if (writeFailed) throw writeFailed;
      await checkpoint(total);
      compositor?.dispose();
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
      this.#set(undefined);
      if (signal.aborted) {
        // People said stop: nothing of it stays.
        const cleaned = await file.abandon().then(
          () => true,
          (reason: unknown) => {
            console.warn("An unfinished export stayed behind", reason);
            return false;
          },
        );
        await exports.remove(id).catch(() => {});
        await this.#stopped(error, true, cleaned, file, state, range);
      } else {
        // What it got to stays, as far as there is a place to go on from: once what went wrong is
        // put right, it goes on from there.
        await this.#stopped(error, false, true, file, state, range);
      }
    } finally {
      compositor?.dispose();
      place.close();
      release();
      this.#resume = undefined;
      this.#controller = undefined;
      this.#set(undefined);
    }
  }

  /** How far the sound has got, while it has a way to go before the picture can go on. */
  #makingSound(on: boolean): void {
    const job = this.#job;
    if (!job || (job.makingSound ?? false) === on) return;
    if (on) this.#set({ ...job, makingSound: true });
    else {
      const { makingSound: _, ...rest } = job;
      this.#set(rest);
    }
  }

  #catchingUp(done: number | undefined, total: number): void {
    const job = this.#job;
    if (!job) return;
    if (done === undefined) {
      if (job.catchingUp !== undefined) {
        const { catchingUp: _, ...rest } = job;
        this.#set(rest);
      }
      return;
    }
    this.#set({ ...job, catchingUp: total > 0 ? Math.min(done / total, 1) : 0 });
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
      // A window that went away is no reason to think less of the graphics card.
      if (signal.aborted || error instanceof WindowClosed || encoding.acceleration !== "hardware") {
        throw error;
      }
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
    } else if (error instanceof WrongOutput) {
      console.warn("Export stopped", error);
      message = t("export.video.wrongOutput");
    } else if (error instanceof WriteFailed) {
      console.warn("Export stopped", error.cause);
      const full = isQuotaError(error.cause);
      message = full
        ? t("export.storage.full")
        : t("export.video.writeFailed", { file: file.name, error: error.message, ...plain });
    } else {
      console.warn("Export stopped", error);
      message = describeFailure(t, failureOf(error), state, timeline);
    }
    await this.#notice(t("export.video.failed"), `${message}${t("export.video.kept")}`);
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
export const snapshotOf = (store: ProjectStore): Promise<string> =>
  snapshotOfFiles(store.exportFiles().files);

export async function snapshotOfFiles(files: ReadonlyMap<string, string>): Promise<string> {
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
