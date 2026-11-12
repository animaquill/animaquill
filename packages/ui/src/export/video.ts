import { readSound, SoundFailed, SoundMixer, type SoundSource } from "@animaquill/audio";
import {
  buildAudioPlan,
  buildRenderPlan,
  entryOf,
  madeSoundsOf,
  showsAt,
  timelineLength,
  transitionsNotDone,
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
  type VideoCodecName,
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
import { projectKeyOf, type ProjectSession } from "../workbench/session.ts";
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
import {
  ExportQueue,
  Pace,
  statusAfterReload,
  type ExportStatus,
  type QueueEntry,
  type SavedQueue,
  type SavedStatus,
} from "./queue.ts";
import { describeFailure, notDoneFailure, type ExportFailure } from "./words.ts";

/** An export that nobody went on with for this long is not going to be. */
const KEEP_UNFINISHED_MS = 30 * 24 * 60 * 60 * 1000;
/** Sound that has to catch up does so this much at a time, and says how far it is in between. */
const CATCH_UP_SECONDS = 30;
/** What an export keeps is about as large as its video. A little more, to be sure. */
const ROOM_MARGIN = 1.2;
/**
 * What an export keeps may be this many times what its bitrate says, and some. Encoders miss their
 * bitrate now and then, by far less than this: much more is something else filling the disk.
 */
const MAX_BYTES_FACTOR = 4;
const MAX_BYTES_EXTRA = 256 * 1024 * 1024;

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
/** Codecs the graphics card of this browser failed at, by when. */
const HARDWARE_KEY = "export.hardwareFailed";
/** A driver gets updated now and then: after this the graphics card gets another chance. */
const HARDWARE_MEMORY_MS = 30 * 24 * 60 * 60 * 1000;
/** Seconds are floats, frames are not. */
const FRAME_TOLERANCE = 1e-6;
/** A file that takes longer than this to be read gets said, so that a wait does not look like a hang. */
const READING_SAID_AFTER_MS = 400;

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
  /** How what is kept was encoded, which can be the processor after the graphics card failed. */
  readonly acceleration?: VideoEncoding["acceleration"];
  /** How many frames there are, for people, also where the project is not open. */
  readonly total?: number;
}

export interface SavedState {
  readonly plan: SavedPlan;
  readonly progress: SavedProgress;
  /** Where it is in the line of exports. Not there in what was kept before there was one. */
  readonly queue?: SavedQueue;
}

/** An export that stopped halfway, as people see it. */
export interface UnfinishedExport {
  readonly id: string;
  readonly project: string;
  readonly name: string;
  readonly savedAt: number;
  /** What it keeps takes this much room. */
  readonly bytes: number;
  readonly status: ExportStatus;
  readonly done: number;
  readonly total: number;
}

/** An export as it runs. */
interface Job {
  readonly id: string;
  readonly plan: SavedPlan;
  readonly progress: SavedProgress | undefined;
  /** The project as it was when the export started, or as it is now, which is the same. */
  readonly state: ProjectState;
  /** What this browser keeps that project by, see `projectKeyOf`. */
  readonly project: string;
  readonly file: GrowingFile;
  readonly place: ExportWindow;
}

/** Sound gets mixed this far ahead of the picture, so that the file gets both in turns. */
const SOUND_LEAD_SECONDS = 1;

/** How an export is doing, for the status bar. */
export interface VideoJob {
  readonly id: string;
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
  /** A file of the project takes a while to be read, and the picture waits for it. */
  readonly readingMedia?: boolean;
  /** The page it is drawn in is not on the screen, where a browser may stop drawing. */
  readonly hidden?: boolean;
  /** People paused it: it goes on to the next place to go on from, and stops there. */
  readonly pausing?: boolean;
}

/** What this window has of an export in its list. */
interface Held {
  /** Lets go of the claim on it, which this window keeps for as long as it is in the list. */
  readonly release: () => void;
  /** The project as it was when people asked for it, while this page has that. */
  state?: ProjectState;
  /** What it was asked to do, until it first runs: after that it goes on from what was kept. */
  fresh?: Omit<Job, "place"> | undefined;
  /** The export that this one is to take the place of. */
  replaces?: Replacing | undefined;
  /** Where it goes, and as what, to open the file again right after a press. */
  target?: unknown;
  kind?: FileKind | undefined;
  /** The file opened again right after people pressed, for when its turn comes. */
  opened?: Promise<GrowingFile | "gone" | "denied" | "taken"> | undefined;
  /** Stops it while it gets ready to go on, before there is an export under way to stop. */
  preparing?: AbortController | undefined;
  /** People just pressed for it to go, and it goes right away: the browser may ask questions. */
  pressed?: boolean | undefined;
}

/** People paused the export, and it got to a place to go on from. */
class PausedHere extends Error {
  constructor() {
    super("The export was paused");
  }
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
  const bytes = ({ description }: VideoDecoderConfig) =>
    description === undefined
      ? new Uint8Array()
      : ArrayBuffer.isView(description)
        ? new Uint8Array(description.buffer, description.byteOffset, description.byteLength)
        : new Uint8Array(description);
  const first = bytes(a);
  const second = bytes(b);
  if (first.length !== second.length) return false;
  for (let at = 0; at < first.length; at += 1) if (first[at] !== second[at]) return false;
  return true;
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
  // Its shape and its size are known by now, see `ownChunk`.
  if (data.byteLength === 0) return "data";
  if (typeof key !== "boolean") return "key";
  if (!Number.isFinite(timestamp) || !asked.has(timestamp)) return "timestamp";
  if (!Number.isFinite(duration) || duration < 0) return "duration";
  if (decoderConfig && !decoderConfig.codec.startsWith(codec)) return "codec";
  return undefined;
}

/** What the export kept was cleared while it ran, see `ExportStore.addPiece`. */
const isGone = (error: unknown): boolean =>
  error instanceof DOMException
    ? error.name === "NotFoundError"
    : error instanceof Error && isGone(error.cause);

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
  /** The exports of this window, in line. */
  readonly #queue = new ExportQueue();
  /** What this window holds of each export in its list. */
  readonly #held = new Map<string, Held>();
  /** Over once what the exports before this page kept is in the list. */
  readonly #restored: Promise<void>;
  /** The line goes, one export after the other, until this is over. */
  #pumping: Promise<void> | undefined;
  /** Where the exports in line go, one after the other: a window takes a press to open. */
  #place: ExportWindow | undefined;
  #placeGone = false;
  /** People asked the export that runs to pause. */
  #pauseAsked = false;
  /** Tells the export that waits for its window that people paused it. */
  #onPauseAsked: (() => void) | undefined;
  /** How fast the export that runs goes, without what it waits for. */
  #pace: Pace | undefined;
  /** The run under way, which what it waits for belongs to. */
  #runNow: object | undefined;
  /**
   * What is being written of each export, one write after the other: a change of its place in line
   * reads what is kept and writes it back, and must not undo a place to go on from written meanwhile.
   */
  readonly #writes = new Map<string, Promise<unknown>>();
  /** Exports whose records went: nothing writes them back. Ids are never used again. */
  readonly #removed = new Set<string>();

  constructor(options: VideoExportOptions) {
    this.#options = options;
    // A project that opens may have an export that stopped halfway, after a reload or a crash.
    let shown = options.session.store;
    options.session.subscribe(() => {
      const { store } = options.session;
      if (store === shown) return;
      shown = store;
      if (store) void this.#opened(store);
    });
    const watch = {
      subscribe: (listener: () => void) => {
        const stopJob = this.subscribe(listener);
        const stopQueue = this.#queue.subscribe(listener);
        return () => {
          stopJob();
          stopQueue();
        };
      },
      getSnapshot: () => {
        const job = this.#job;
        return job && { ...job, after: this.#queue.waiting() };
      },
    };
    this.#windows =
      options.windows ??
      pictureInPictureWindows((page) =>
        fillExportWindow(
          page,
          options.t,
          watch,
          () => this.cancel(),
          () => this.pause(),
        ),
      );
    this.#restored = this.#restore();
  }

  subscribe = this.#emitter.subscribe;
  getSnapshot = (): VideoJob | undefined => this.#job;

  /** The exports of this window, as people see them in the list. */
  get queue(): Pick<ExportQueue, "subscribe" | "getSnapshot" | "ahead" | "waiting"> {
    return this.#queue;
  }

  #set(job: VideoJob | undefined): void {
    this.#job = job;
    this.#emitter.emit();
  }

  /**
   * Stops an export. The one under way cleans up after itself, and says so when it is over. One
   * that is not under way goes from the list with what it kept, as with `remove`.
   */
  cancel(id?: string): void {
    if (id !== undefined && id !== this.#job?.id) {
      void this.remove(id);
      return;
    }
    if (!this.#job || !this.#controller) return;
    this.#set({ ...this.#job, stopping: true });
    this.#controller.abort(new DOMException("Export stopped", "AbortError"));
  }

  /**
   * Pauses an export. One that waits for its turn stays where it is in line, and does not go until
   * people say so. The one under way goes on to the next place to go on from and stops there, which
   * costs nothing of what it did; one whose window was closed goes back to the last one. Then the
   * next in line goes, in the same window.
   */
  pause(id?: string): void {
    const job = this.#job;
    const which = id ?? job?.id;
    if (which === undefined) return;
    const entry = this.#queue.get(which);
    if (entry?.status === "waiting") {
      this.#queue.update(which, { status: "paused", restored: undefined });
      void this.#saveStatus(which, "paused");
      return;
    }
    if (!job || job.id !== which || job.stopping || job.writing || job.pausing) return;
    this.#pauseAsked = true;
    this.#set({ ...job, pausing: true });
    this.#onPauseAsked?.();
  }

  /**
   * Puts an export that is paused, failed or stopped with the page back in line, in the place it
   * had. It goes on from where it was kept. Comes from a button: when it goes right away, the
   * browser may ask about the file and the window, which takes a press just before.
   */
  goOn(id: string): void {
    const entry = this.#queue.get(id);
    if (!entry || entry.status === "running" || entry.status === "done") return;
    this.#letBe(id);
    this.#openNow(id);
    this.#queue.update(id, {
      status: "waiting",
      restored: undefined,
      needsPress: undefined,
      failure: undefined,
    });
    void this.#saveStatus(id, "waiting");
    if (!this.#busy) void this.#pump();
  }

  /** People go on with this one after all: no new export takes its place without asking again. */
  #letBe(id: string): void {
    for (const other of this.#held.values()) {
      if (other.replaces?.saved.id === id) other.replaces = undefined;
    }
  }

  /**
   * The press people just made is used now for what takes one: being let to write its file again.
   * By its turn, when another one runs first, the press is long over.
   */
  #openNow(id: string): void {
    const held = this.#held.get(id);
    if (!held) return;
    // Right away, it goes while the press still counts, and may ask people questions.
    if (!this.#isRunning() && !this.#busy) held.pressed = true;
    if (held.fresh || held.target === undefined || !held.kind) return;
    held.opened = this.#options.folders.reopen(held.target, held.kind).catch(() => "gone" as const);
  }

  /** Same as going on: from where it was kept. What went wrong should be put right by then. */
  retry(id: string): void {
    this.goOn(id);
  }

  /** All that are paused or stopped with the page go on, each in its place in line. */
  goOnWithAll(): void {
    for (const entry of this.#queue.getSnapshot()) {
      const stopped =
        entry.status === "paused" ||
        entry.status === "interrupted" ||
        (entry.status === "waiting" && entry.restored);
      if (!stopped) continue;
      this.#letBe(entry.id);
      this.#openNow(entry.id);
      this.#queue.update(entry.id, {
        status: "waiting",
        restored: undefined,
        needsPress: undefined,
      });
      void this.#saveStatus(entry.id, "waiting");
    }
    if (!this.#busy) void this.#pump();
  }

  /**
   * Takes an export out of the list, with what it kept and its file while that is still the empty
   * one it made. The one under way is stopped. A finished one only leaves the list.
   */
  async remove(id: string): Promise<void> {
    if (id === this.#job?.id) {
      this.cancel();
      return;
    }
    const entry = this.#queue.get(id);
    if (!entry) return;
    if (entry.status === "done") {
      this.#queue.remove(id);
      return;
    }
    // One that gets ready to go on, which may wait for the browser to ask about its file, stops
    // there: it does not go on once that is answered.
    this.#held.get(id)?.preparing?.abort();
    const saved = await this.#savedOf(id);
    if (saved) {
      if (await this.#dropEntry(saved, true)) this.#sayEmptyLeft(saved);
    } else {
      // Only in this page: what it would write to goes.
      const fresh = this.#held.get(id)?.fresh;
      if (fresh) await this.#abandon(fresh.file, id);
      this.#forgetEntry(id);
    }
    this.#options.notifications.push(this.#options.t("export.queue.removed"));
  }

  /** The finished ones leave the list. */
  clearDone(): void {
    for (const { id, status } of this.#queue.getSnapshot()) {
      if (status === "done") this.#queue.remove(id);
    }
  }

  /**
   * A project goes away: this window lets go of its exports, so that what they kept goes with it.
   * One under way stops.
   */
  async letGoOfProject(project: string): Promise<void> {
    for (const entry of this.#queue.getSnapshot()) {
      if (entry.project !== project) continue;
      this.#held.get(entry.id)?.preparing?.abort();
      if (entry.id === this.#job?.id) {
        this.cancel();
        // Until it cleaned up after itself: what comes after it in line may go on meanwhile.
        await new Promise<void>((resolve) => {
          const check = () => {
            if (this.#job?.id === entry.id) return;
            stop();
            resolve();
          };
          const stop = this.subscribe(check);
          check();
        });
      }
      this.#forgetEntry(entry.id);
    }
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
    if (store) await this.#opened(store);
  }

  /** A project opened: what stopped with the page before is offered, and what waits for it goes. */
  async #opened(store: ProjectStore): Promise<void> {
    await this.#offer(store);
    if (this.#options.session.store === store) await this.#pump();
  }

  /** Whether an export, or the questions before one, is under way in this window. */
  get busy(): boolean {
    return this.#isBusy();
  }

  /** Whether exports go one after the other in this window right now. */
  #isRunning(): boolean {
    return this.#job !== undefined || this.#pumping !== undefined;
  }

  /** Whether an export, or the questions before one, is under way in this window. */
  #isBusy(): boolean {
    return this.#busy || this.#isRunning();
  }

  /**
   * What exports kept before this page goes in its list, as it was: in line, paused, failed, or
   * stopped with the page. Nothing of it goes on by itself, because going on takes people pressing a
   * button. Another window that has one keeps it.
   */
  async #restore(): Promise<void> {
    const all = await this.#options.exports.all().catch(() => []);
    for (const saved of all.toSorted((a, b) => orderOf(a) - orderOf(b))) await this.#adopt(saved);
  }

  /**
   * Takes a kept export into the list of this window, unless another window has it. This window
   * keeps the claim on it for as long as it is in the list. Resolves to whether it is in the list.
   */
  async #adopt(saved: SavedExport): Promise<boolean> {
    if (this.#held.has(saved.id)) return true;
    if ((saved.state as SavedState | undefined)?.plan?.version !== 1) return false;
    const release = await this.#options.exports.claim(saved.id);
    if (!release) return false;
    if (this.#held.has(saved.id)) {
      release();
      return true;
    }
    if (isExpired(saved)) {
      await this.#drop(saved, false);
      release();
      return false;
    }
    const { progress, queue, plan } = saved.state as SavedState;
    this.#held.set(saved.id, { release, target: saved.target, kind: plan.kind });
    this.#queue.put({
      id: saved.id,
      project: saved.project,
      name: nameOfTarget(saved.target),
      status: statusAfterReload(queue),
      order: orderOf(saved),
      done: progress.frame,
      total: progress.total ?? 0,
      ...(queue?.failure !== undefined && { failure: queue.failure }),
      restored: true,
    });
    return true;
  }

  /** It leaves the list, and this window lets go of it. What it kept is somebody else's business. */
  #forgetEntry(id: string): void {
    this.#held.get(id)?.release();
    this.#held.delete(id);
    this.#queue.remove(id);
  }

  /** What is kept of an export now, if anything. */
  async #savedOf(id: string): Promise<SavedExport | undefined> {
    const all = await this.#options.exports.all().catch(() => []);
    return all.find((saved) => saved.id === id);
  }

  /** Writes what is kept of an export after whatever was being written of it before. */
  #inTurn<T>(id: string, write: () => Promise<T>): Promise<T> {
    const before = this.#writes.get(id) ?? Promise.resolve();
    const now = before.catch(() => {}).then(write);
    const settled = now.catch(() => {});
    this.#writes.set(id, settled);
    void settled.then(() => {
      if (this.#writes.get(id) === settled) this.#writes.delete(id);
    });
    return now;
  }

  /** What an export kept goes, after whatever was being written of it, and is never written again. */
  async #removeKept(id: string): Promise<void> {
    this.#removed.add(id);
    await this.#inTurn(id, () => this.#options.exports.remove(id)).catch((error: unknown) =>
      console.warn("An export stays", error),
    );
  }

  /** Keeps where an export is in line, next to what it did. Losing that costs little. */
  #saveStatus(id: string, status: SavedStatus, failure?: string): Promise<void> {
    return this.#inTurn(id, async () => {
      if (this.#removed.has(id)) return;
      const saved = await this.#savedOf(id);
      if (!saved) return;
      const state = saved.state as SavedState;
      const order = this.#queue.get(id)?.order ?? orderOf(saved);
      const queue: SavedQueue = { status, order, ...(failure !== undefined && { failure }) };
      await this.#options.exports
        .save({ ...saved, savedAt: Date.now(), state: { ...state, queue } })
        .catch((error: unknown) => console.warn("Where an export is in line is not kept", error));
    });
  }

  /**
   * Asks about each export of this project that stopped with the page, and on starting a new one
   * also about each that failed. Returns whether people went on with one or gave it up, as opposed
   * to leaving it for later or there being none.
   */
  async #offer(store: ProjectStore, fromStart = false): Promise<boolean | Replacing> {
    const { exports, dialogs, t } = this.#options;
    await this.#restored;
    if (this.#isBusy()) return false;
    const id = projectKeyOf(store);
    const found = await exports.list(id).catch(() => []);
    // What other windows let go of since this page started is this one's now.
    for (const saved of found.toSorted((a, b) => orderOf(a) - orderOf(b))) {
      await this.#adopt(saved);
    }
    const asked = (saved: SavedExport) => {
      const status = this.#queue.get(saved.id)?.status;
      return status === "interrupted" || (fromStart && status === "failed");
    };
    const waiting = found.filter(asked).toSorted((a, b) => b.savedAt - a.savedAt);
    for (const saved of waiting) {
      if (isExpired(saved)) {
        await this.#dropEntry(saved, false);
        continue;
      }
      await this.#quiet();
      if (this.#options.session.store !== store || this.#isBusy()) return false;
      // It may have gone on, or gone, while another question was open.
      if (!asked(saved)) continue;
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
            // People who chose to export may want another one, which then takes its place.
            ...(fromStart ? [{ id: "new", label: t("export.resume.startNew") }] : []),
            { id: "continue", label: t("export.resume.continue"), kind: "primary" },
          ],
        });
        if (answer === "new") return { saved };
        // Going back from there leaves it for the next time.
        if (answer === undefined) return false;
        if (answer === "discard") {
          await this.#discard(saved);
          return true;
        }
        // The line it was in goes on with it, as it would have without the reload.
        for (const entry of this.#queue.getSnapshot()) {
          if (entry.project === id && entry.status === "waiting" && entry.restored) {
            this.#queue.update(entry.id, { restored: undefined });
          }
        }
        this.#queue.update(saved.id, { status: "waiting", restored: undefined });
        const held = this.#held.get(saved.id);
        if (held) held.pressed = true;
        this.#busy = false;
        await this.#pump();
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

  /** What it kept goes, and its file too when that is still empty. People said so. */
  async #discard(saved: SavedExport): Promise<void> {
    const { notifications, t } = this.#options;
    const left = await this.#dropEntry(saved, true);
    notifications.push(t("export.resume.discarded"));
    if (left) this.#sayEmptyLeft(saved);
  }

  #sayEmptyLeft(saved: SavedExport): void {
    const { notifications, t } = this.#options;
    const name = nameOfTarget(saved.target);
    notifications.push(
      t("export.resume.emptyLeft", { file: name, interpolation: { escapeValue: false } }),
    );
  }

  /** As `#drop`, and the export leaves the list of this window too. */
  async #dropEntry(saved: SavedExport, ask: boolean): Promise<boolean> {
    try {
      return await this.#drop(saved, ask);
    } finally {
      this.#forgetEntry(saved.id);
    }
  }

  /**
   * What an export kept goes, and so does the file it was to write, as long as that is still the
   * empty one it made and no other export goes there: the file only gets written at the end, and a
   * new export may have been told the same place. With `ask` the browser may ask whether the file
   * may go, which takes a press of a button just before. Resolves to whether an empty file stays.
   */
  async #drop(saved: SavedExport, ask: boolean): Promise<boolean> {
    const { folders } = this.#options;
    await this.#removeKept(saved.id);
    const others = await this.#othersThan(saved.id);
    if (!others) return true;
    return folders.dropTarget(saved.target, others, ask).catch(() => true);
  }

  /**
   * Where the other exports kept here go, or undefined when that cannot be read: then nothing may
   * be taken away, since it could be one of theirs.
   */
  async #othersThan(id: string): Promise<readonly unknown[] | undefined> {
    const all = await this.#options.exports.all().catch(() => undefined);
    if (!all) return undefined;
    const kept = all.filter((saved) => saved.id !== id).map(({ target }) => target);
    // Those in line here that did not get to keep anything yet go somewhere too.
    const fresh = [...this.#held]
      .filter(([other, held]) => other !== id && held.fresh)
      .map(([, held]) => held.fresh?.file.target);
    return [...kept, ...fresh];
  }

  /**
   * Takes back what an export of this window wrote, and its file as far as that is still empty and
   * no other export goes there. Resolves to whether everything went.
   */
  async #abandon(file: GrowingFile, id: string): Promise<boolean> {
    // Without the others, the file is as good as theirs: it stays.
    const others = (await this.#othersThan(id)) ?? [file.target];
    return file.abandon(others).then(
      () => true,
      (reason: unknown) => {
        console.warn("An unfinished export stayed behind", reason);
        return false;
      },
    );
  }

  /**
   * What exports that nobody went on with for long kept, on this device, whichever project they
   * are of. Once when the editor starts, so that it is gone whether the project is opened or not.
   */
  async cleanUp(): Promise<void> {
    const { exports, notifications, t } = this.#options;
    await this.#restored;
    const left: string[] = [];
    for (const saved of await exports.all().catch(() => [])) {
      if (!isExpired(saved)) continue;
      if (this.#held.has(saved.id)) {
        if (saved.id === this.#job?.id) continue;
        if (await this.#dropEntry(saved, false)) left.push(nameOfTarget(saved.target));
        continue;
      }
      const release = await exports.claim(saved.id);
      if (!release) continue;
      try {
        if (await this.#drop(saved, false)) left.push(nameOfTarget(saved.target));
      } finally {
        release();
      }
    }
    // Without people pressing something, the browser may not let a page take a file away.
    if (left.length > 0) {
      notifications.push(
        t("export.queue.oldEmptyLeft", {
          files: left.join("、"),
          count: left.length,
          interpolation: { escapeValue: false },
        }),
      );
    }
  }

  /**
   * Goes on with an export that ran before, from what it kept. Without `held.state` it goes on with
   * the project as it is now, which has to be the same as when it started. `pressed` says whether
   * people pressed a button just now, which the browser wants before it lets a page write a file
   * again: without it, it waits for one.
   */
  async #goOn(
    saved: SavedExport,
    held: Held,
    pressed: boolean,
    stopped: AbortSignal,
  ): Promise<void> {
    const { dialogs, folders, t, notifications } = this.#options;
    const state = saved.state as SavedState;
    let plan = state.plan;
    let progress: SavedProgress | undefined = state.progress;
    const name = nameOfTarget(saved.target);
    const plain = { interpolation: { escapeValue: false } };
    const store = this.#openKey() === saved.project ? this.#options.session.store : undefined;
    const before = held.state ?? store?.getState();
    if (!before) return;
    /** It cannot go on as it is, which no press of a button changes. */
    const fail = (reason: string) => {
      this.#queue.update(saved.id, { status: "failed", failure: reason });
      void this.#saveStatus(saved.id, "failed", reason);
      this.#tell(t("export.video.failed"), reason);
    };
    /**
     * It waits for people: the browser only lets a page write the file again right after a press,
     * and a question nobody is there to answer would hold up everything after it in line.
     */
    const waitForPress = (why: "needsPress" | "needsAnswer") => {
      this.#queue.update(saved.id, { status: "paused", needsPress: true });
      void this.#saveStatus(saved.id, "paused");
      notifications.push(t(`export.queue.${why}`, { file: name, ...plain }));
    };
    this.#busy = true;
    try {
      // The file first: the browser asks about it right after the button, which it takes for that.
      const opening = held.opened ?? folders.reopen(saved.target, plan.kind);
      held.opened = undefined;
      let file = await opening.catch(() => "gone" as const);
      if (stopped.aborted) return;
      if (typeof file === "string" && !pressed) {
        waitForPress(file === "denied" ? "needsPress" : "needsAnswer");
        return;
      }
      if (typeof file === "string") {
        const answer = await dialogs.choose({
          title: t("export.resume.goneTitle"),
          message: t(`export.resume.${file}`, {
            file: name,
            ...plain,
          }),
          choices: [
            { id: "discard", label: t("export.resume.discard") },
            { id: "choose", label: t("export.resume.chooseAgain"), kind: "primary" },
          ],
        });
        if (stopped.aborted) return;
        if (answer === "discard") {
          await this.#discard(saved);
          return;
        }
        if (answer !== "choose") return;
        const chosen = await folders.chooseFile(name, plan.kind).catch(() => undefined);
        if (stopped.aborted || !chosen) return;
        file = chosen;
      }
      // The way what is kept was encoded, which the processor may have taken over.
      const keptWay =
        progress?.acceleration === "software" ? inSoftware(plan.encoding) : plan.encoding;
      if (!(await (this.#options.support ?? browserSupport)(keptWay.config))) {
        const encoding = await this.#encodingFor(before, plan);
        if (stopped.aborted) return;
        // The file was asked for as one kind, and the other kind would not open as that.
        if (!encoding || containerOf(encoding.codec) !== containerOf(plan.encoding.codec)) {
          fail(t("export.video.cannotEncode"));
          return;
        }
        notifications.push(t("export.resume.cannotEncode"));
        plan = { ...plan, encoding };
        progress = undefined;
      }
      // What the video is drawn from, and what it is checked against, at the same moment. The project
      // as this page had it when the export started is that already.
      let now = before;
      if (!held.state && store) {
        now = store.getState();
        const snapshot = await snapshotOfFiles(store.exportFiles().files);
        if (stopped.aborted) return;
        if (snapshot !== plan.snapshot) {
          if (!pressed) {
            waitForPress("needsAnswer");
            return;
          }
          const answer = await dialogs.choose({
            title: t("export.resume.changedTitle"),
            message: t("export.resume.changed"),
            choices: [
              { id: "discard", label: t("export.resume.discard") },
              { id: "again", label: t("export.resume.again"), kind: "primary" },
            ],
          });
          if (stopped.aborted) return;
          if (answer !== "again") {
            if (answer === "discard") await this.#discard(saved);
            return;
          }
          const again = this.#planAgain(now, plan);
          if (!again) {
            fail(t("export.resume.planGone"));
            return;
          }
          plan = { ...again, snapshot };
          progress = undefined;
          // It changed again while people were asked. Then this is a new snapshot again.
          if (store.getState() !== now) return;
        }
      }
      const place = await this.#placeHere();
      if (stopped.aborted || !place) return;
      // From now on this page knows what it is of, also when the project changes or closes.
      held.state = now;
      this.#busy = false;
      await this.#run(
        { id: saved.id, plan, progress, state: now, project: saved.project, file, place },
        held,
      );
    } finally {
      this.#busy = false;
    }
  }

  /**
   * Asks whether a new export still takes the place of one that got further since people said so.
   * It does not hold up the export: the question waits for whatever is asked now.
   */
  #askReplace(old: SavedExport): void {
    const { dialogs, notifications, t } = this.#options;
    const { progress } = old.state as SavedState;
    void this.#quiet().then(async () => {
      const answer = await dialogs.choose({
        title: t("export.queue.replaceTitle"),
        message: t("export.queue.replaceChanged", {
          file: nameOfTarget(old.target),
          frame: progress.frame,
          interpolation: { escapeValue: false },
        }),
        choices: [{ id: "replace", label: t("export.queue.replace"), kind: "danger" }],
      });
      const entry = this.#queue.get(old.id);
      if (answer !== "replace" || !entry || entry.status === "running") return;
      const now = await this.#savedOf(old.id);
      if (!now) return;
      if (await this.#dropEntry(now, true)) this.#sayEmptyLeft(now);
      notifications.push(t("export.resume.replaced"));
    });
  }

  /** An encoding for the format of a plan, the way the plan wanted it, in this browser. */
  async #encodingFor(state: ProjectState, plan: SavedPlan): Promise<VideoEncoding | undefined> {
    const format = state.manifest.formats.find(({ id }) => id === plan.format);
    if (!format) return undefined;
    const shape = { width: format.width, height: format.height, fps: fpsOf(format.fps) };
    const support = this.#options.support ?? browserSupport;
    return chooseEncoding(shape, plan.quality, support, await this.#noHardware());
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
      .filter((saved) => (saved.state as SavedState | undefined)?.plan?.version === 1)
      .filter((saved) => !isExpired(saved))
      .map(({ id, project, savedAt, target, state }) => {
        const { progress, queue } = state as SavedState;
        const entry = this.#queue.get(id);
        return {
          id,
          project,
          savedAt,
          name: nameOfTarget(target),
          bytes: progress.bytes ?? 0,
          status: entry?.status ?? statusAfterReload(queue),
          done: progress.frame,
          total: progress.total ?? entry?.total ?? 0,
        };
      })
      .toSorted((a, b) => b.savedAt - a.savedAt);
  }

  /**
   * Takes away what an export that stopped halfway keeps, and its file while that is still empty.
   * It comes from a button, so the browser may ask about the file. False when a window is at it.
   */
  async forget(id: string): Promise<boolean> {
    const { exports } = this.#options;
    const { notifications, t } = this.#options;
    if (this.#held.has(id)) {
      if (id === this.#job?.id) {
        notifications.push(t("export.queue.clearRunning"));
        return false;
      }
      this.#held.get(id)?.preparing?.abort();
      const saved = await this.#savedOf(id);
      if (!saved) this.#forgetEntry(id);
      else if (await this.#dropEntry(saved, true)) this.#sayEmptyLeft(saved);
      return true;
    }
    const release = await exports.claim(id);
    if (!release) {
      notifications.push(t("export.resume.elsewhere"));
      return false;
    }
    try {
      const saved = await this.#savedOf(id);
      if (!saved) return true;
      if (await this.#drop(saved, true)) this.#sayEmptyLeft(saved);
      return true;
    } finally {
      release();
    }
  }

  /**
   * Asks how, and puts the export in line. When none goes yet, it goes right away, and this is over
   * when the line is: when it and whatever came after it are done. Otherwise it is over once the
   * export is in line.
   */
  async start(): Promise<void> {
    const { session, notifications, t } = this.#options;
    await this.#restored;
    if (this.#busy) {
      notifications.push(t("export.video.busy"));
      return;
    }
    const { store } = session;
    if (!store) return;
    let replacing: Replacing | undefined;
    if (!this.#isRunning()) {
      // One that stopped halfway comes first: it is what people likely want, and it holds the place.
      const offered = await this.#offer(store, true);
      if (offered === true) return;
      replacing = offered === false ? undefined : offered;
      if (this.#busy) return;
    }
    this.#busy = true;
    let prepared: Prepared | undefined;
    try {
      // A window only when this one goes right away: one in line goes in the window of the line.
      prepared = await this.#prepare(store, !this.#isRunning());
    } finally {
      this.#busy = false;
    }
    if (!prepared) {
      // People may have put one back in line while they were asked.
      if (!this.#isRunning() && this.#queue.next((entry) => this.#canRun(entry))) {
        await this.#pump();
      }
      return;
    }
    const { job, release, total, place } = prepared;
    const fresh = job;
    this.#held.set(job.id, {
      release,
      state: job.state,
      fresh,
      target: job.file.target,
      kind: job.plan.kind,
      ...(replacing && { replaces: replacing }),
    });
    const order = this.#queue.nextOrder();
    this.#queue.put({
      id: job.id,
      project: job.project,
      name: job.file.name,
      status: "waiting",
      order,
      done: 0,
      total,
    });
    if (place) this.#usePlace(place);
    if (!this.#isRunning()) {
      await this.#pump();
      return;
    }
    // It waits for its turn: what it is asked to do is kept now, so that a reload does not lose it.
    await this.#keep(
      job.id,
      job.project,
      job.file.target,
      () => ({ kind: "download", name: job.file.name }),
      {
        plan: job.plan,
        progress: { frame: 0, videoPieces: 0, bytes: 0, total },
        queue: { status: "waiting", order },
      },
    ).catch((error: unknown) => console.warn("An export in line is not kept", error));
    notifications.push(
      t("export.queue.added", {
        file: job.file.name,
        ahead: this.#queue.ahead(job.id),
        interpolation: { escapeValue: false },
      }),
    );
  }

  /** The exports in line go, one after the other, until none can go. */
  #pump(): Promise<void> {
    this.#pumping ??= this.#drain().finally(() => {
      this.#pumping = undefined;
    });
    return this.#pumping;
  }

  async #drain(): Promise<void> {
    await this.#restored;
    try {
      for (;;) {
        const next = this.#queue.next((entry) => this.#canRun(entry));
        if (!next) break;
        await this.#runEntry(next);
        // Whatever happened to it, it is not in line any more: else it would go again and again.
        if (this.#queue.get(next.id)?.status === "waiting") {
          this.#queue.update(next.id, { status: "paused" });
        }
      }
    } finally {
      this.#closePlace();
    }
  }

  /**
   * Whether it can go now: one from before a reload waits for people, and one this page does not
   * know the project of needs the project open.
   */
  #canRun(entry: QueueEntry): boolean {
    if (entry.restored) return false;
    const held = this.#held.get(entry.id);
    if (!held) return false;
    if (held.state) return true;
    return this.#openKey() === entry.project;
  }

  async #runEntry(entry: QueueEntry): Promise<void> {
    const { id } = entry;
    const held = this.#held.get(id);
    if (!held) {
      this.#queue.remove(id);
      return;
    }
    const pressed = held.pressed === true || isPressed();
    held.pressed = undefined;
    this.#queue.update(id, { status: "running", needsPress: undefined, failure: undefined });
    const preparing = new AbortController();
    held.preparing = preparing;
    try {
      const { fresh } = held;
      if (fresh) {
        held.fresh = undefined;
        const place = await this.#placeHere();
        if (preparing.signal.aborted) return;
        if (!place) {
          // People did not want it to go now. It waits for them, with what it was asked to do.
          held.fresh = fresh;
          this.#queue.update(id, { status: "paused" });
          return;
        }
        await this.#run({ ...fresh, place }, held);
        return;
      }
      const saved = await this.#savedOf(id);
      if (!saved) {
        this.#forgetEntry(id);
        return;
      }
      await this.#goOn(saved, held, pressed, preparing.signal);
    } finally {
      held.preparing = undefined;
      // It went back to where it was, as when people went back from a question about it.
      if (this.#queue.get(id)?.status === "running") {
        const back = entry.status === "waiting" ? "paused" : entry.status;
        this.#queue.update(id, { status: back });
        if (back === "paused") void this.#saveStatus(id, "paused");
      }
    }
  }

  /** Where the export whose turn it is goes: where the one before went, while that is there. */
  async #placeHere(): Promise<ExportWindow | undefined> {
    if (this.#place && !this.#placeGone) return this.#place;
    this.#place = undefined;
    const place = await this.#placeFor();
    if (place) this.#usePlace(place);
    return place;
  }

  #usePlace(place: ExportWindow): void {
    if (this.#place === place) return;
    if (this.#place && this.#place !== place) this.#place.close();
    this.#place = place;
    this.#placeGone = false;
    void place.closed.then(() => {
      if (this.#place === place) this.#placeGone = true;
    });
  }

  #closePlace(): void {
    this.#place?.close();
    this.#place = undefined;
  }

  async #prepare(store: ProjectStore, withPlace: boolean): Promise<Prepared | undefined> {
    const { timeline, dialogs, t, exports } = this.#options;
    const { model } = timeline;
    if (!model) return undefined;
    const asked = store.getState();
    const { formats } = asked.manifest;
    const quality = await this.#savedQuality();
    const support = this.#options.support ?? browserSupport;
    const noHardware = await this.#noHardware();
    const encodingsWith = async (avoid: ReadonlySet<VideoCodecName>) => {
      const found = new Map<string, VideoEncoding | undefined>();
      await Promise.all(
        formats.flatMap((format) =>
          QUALITIES.map(async (each) => {
            const shape = { width: format.width, height: format.height, fps: fpsOf(format.fps) };
            found.set(`${format.id}/${each}`, await chooseEncoding(shape, each, support, avoid));
          }),
        ),
      );
      return found;
    };
    const encodings = await encodingsWith(noHardware);
    // The graphics card failed here before: people can see that, and give it another try.
    const remembered = noHardware.size > 0 ? await encodingsWith(new Set()) : undefined;
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
    // Where unfinished exports of this project go, so that a new one does not suggest the same.
    const project = projectKeyOf(store);
    const kept = await exports.list(project).catch(() => []);
    const taken = new Set(kept.map(({ target }) => nameOfTarget(target)));
    for (const entry of this.#queue.getSnapshot()) {
      if (entry.project === project && entry.status !== "done") taken.add(entry.name);
    }
    const answer = await dialogs.form({
      title: t("export.video.title"),
      fields: this.#fields(asked, ranges, quality, remembered !== undefined),
      notes: this.#notes(asked, firstEncoding, audible, firstSound, !withPlace),
      confirm: t(withPlace ? "export.video.start" : "export.queue.add"),
    });
    if (!answer) return undefined;
    const format = formats.find(({ id }) => id === answer["format"]) ?? first;
    const range = ranges.find(({ id }) => id === answer["range"]) ?? ranges[0];
    const chosen = isQuality(answer["quality"]) ? answer["quality"] : quality;
    const retry = remembered !== undefined && answer["card"] === "retry";
    if (retry) await this.#forgetHardwareFailed();
    const encoding = format && (retry ? remembered : encodings).get(`${format.id}/${chosen}`);
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
    const nameWith = (number: number) =>
      t(number === 1 ? "export.video.file" : "export.video.fileNumbered", {
        name: asked.manifest.name,
        format: format.name,
        extension: container,
        number,
        interpolation: { escapeValue: false },
      });
    let number = 1;
    while (taken.has(nameWith(number))) number += 1;
    const name = nameWith(number);
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
    let place: ExportWindow | undefined;
    if (withPlace) {
      place = await this.#placeHere();
      if (!place) {
        await this.#abandon(file, "");
        return undefined;
      }
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
      if (place && !this.#isRunning()) this.#closePlace();
      return undefined;
    }
    return {
      job: { id, plan: saved, progress: undefined, state, project: projectKeyOf(store), file },
      place,
      release,
      total,
    };
  }

  /**
   * Whether this device has room for what the export keeps while it runs, which is about as much
   * as the video itself, and twice that for a download. Asks when it looks short, because the
   * estimate of a browser is only that.
   */
  async #roomFor(bytes: number): Promise<boolean> {
    const { dialogs, t } = this.#options;
    const estimate = await (this.#options.storage ?? browserStorage)().catch(() => undefined);
    if (!estimate?.quota) return true;
    const free = estimate.quota - (estimate.usage ?? 0);
    // A download is put together in the storage of the browser too, next to what the export keeps.
    const copies = this.#options.folders.savesInBrowser ? 2 : 1;
    const needed = bytes * copies * ROOM_MARGIN;
    if (free >= needed) return true;
    const answer = await dialogs.choose({
      title: t("export.storage.title"),
      message: t("export.storage.short", { needed: sizeOf(needed), free: sizeOf(free) }),
      choices: [{ id: "go", label: t("export.storage.anyway") }],
    });
    return answer === "go";
  }

  async #run(job: Job, held: Held): Promise<void> {
    const { t, notifications } = this.#options;
    const exports = this.#options.exports;
    const { id, state, project, file, plan: saved } = job;
    let place = job.place;
    const timelineId = saved.timeline;
    const plan = buildRenderPlan(state, timelineId, { format: saved.format });
    if (!plan) return;
    const { range } = saved;
    const frames = framesOf(range, plan.scenes.fps);
    const { total } = frames;
    // The file says what the project says, or the export stops where it would not.
    const timeline = entryOf(state.timelines, timelineId);
    const heard = saved.sound ? buildAudioPlan(state, timelineId) : undefined;
    const notDone = timeline ? transitionsNotDone(timeline, plan, heard) : [];
    const controller = new AbortController();
    const { signal } = controller;
    this.#controller = controller;
    this.#pauseAsked = false;
    const resumed = job.progress;
    const order = this.#queue.get(id)?.order ?? this.#queue.nextOrder();
    this.#pace = new Pace(performance.now(), resumed?.frame ?? 0);
    /** This run of it: what an earlier one still says when it is over goes nowhere. */
    const run = {};
    this.#runNow = run;
    this.#set({
      id,
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
    // A place to go on from was encoded by the processor after the graphics card failed: it goes on
    // that way, or it would not fit what is there.
    let used =
      job.progress?.acceleration === "software" ? inSoftware(saved.encoding) : saved.encoding;
    /** The disk does not keep up, and frames would pile up in memory. */
    const behind = () => unwritten > MAX_UNWRITTEN;
    /** Files of the project being read for the compositor, which the picture waits for. */
    let reading = 0;
    let readingSaid: ReturnType<typeof setTimeout> | undefined;
    const openCompositor = (where: ExportWindow): VideoCompositor => {
      const base = exportCompositorOptions(this.#options, state, project, plan);
      const options = {
        ...base,
        document: where.document,
        media: (hash: string) => {
          reading += 1;
          // Only a read that takes a while gets said, or the status would flicker with every file.
          readingSaid ??= setTimeout(() => {
            readingSaid = undefined;
            if (reading > 0) this.#flag(run, "readingMedia", true);
          }, READING_SAID_AFTER_MS);
          return base.media(hash).finally(() => {
            reading -= 1;
            if (reading > 0) return;
            clearTimeout(readingSaid);
            readingSaid = undefined;
            this.#flag(run, "readingMedia", false);
          });
        },
      };
      return this.#options.compositor?.(options) ?? new ExportCompositor(options);
    };
    /** A page that is not on the screen may not get drawn, and then the export waits for it. */
    const watchHidden = (where: ExportWindow) => {
      const page = where.document;
      const update = () => this.#flag(run, "hidden", page.visibilityState === "hidden");
      page.addEventListener?.("visibilitychange", update);
      update();
      return () => {
        page.removeEventListener?.("visibilitychange", update);
        this.#flag(run, "hidden", false);
      };
    };
    let unwatch = watchHidden(place);
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
    /**
     * The first frames of a new encoder showed that it does not go on with what was there, so it
     * started over: once for each way of encoding, which the graphics card failing can change.
     */
    let startedOverWith: VideoEncoding["acceleration"] | undefined;
    /**
     * An encoder is on its way out. What it still gives comes before the next one has started, and
     * belongs to frames that are asked for again: counting it would put them in the file twice.
     */
    let replacing = false;
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
    /**
     * The export people chose to do again with this one. It goes once this one has a place to go
     * on from of its own: until then, what that one did is all there is.
     */
    const dropReplaced = async () => {
      const old = held.replaces;
      if (!old) return;
      held.replaces = undefined;
      const now = await this.#savedOf(old.saved.id);
      if (!now) return;
      const before = (old.saved.state as SavedState).progress;
      const after = (now.state as SavedState).progress;
      if (before.frame === after.frame && before.videoPieces === after.videoPieces) {
        if (await this.#dropEntry(now, false)) this.#sayEmptyLeft(now);
        notifications.push(t("export.resume.replaced"));
        return;
      }
      // It got further since people said this one takes its place: that was not what they saw.
      this.#askReplace(now);
    };
    /** How many of the bytes are of the picture, which can go back to the last place kept. */
    let videoBytes = 0;
    /** The last place kept, which an encoder that broke goes back to. */
    let kept = { frame: index, videoPieces: video.nextSeq, videoBytes, decoding };
    /** The same, as it is on the disk. */
    let keptProgress: SavedProgress = {
      frame: index,
      videoPieces: video.nextSeq,
      bytes,
      ...(decoding && { decoderConfig: decoding }),
      acceleration: used.acceleration,
      total,
    };
    const keepState = (queue: SavedQueue, progress = keptProgress) =>
      this.#keep(
        id,
        project,
        target,
        () => {
          target = { kind: "download", name: file.name };
          return target;
        },
        { plan: saved, progress, queue },
      );
    const checkpoint = async (frame: number) => {
      const progress: SavedProgress = {
        frame,
        videoPieces: video.nextSeq,
        bytes,
        ...(decoding && { decoderConfig: decoding }),
        acceleration: used.acceleration,
        total,
      };
      await keepState({ status: "running", order }, progress);
      // Only what is on the disk counts as kept: a place that did not get there is not one.
      keptProgress = progress;
      held.target = target;
      kept = { frame, videoPieces: video.nextSeq, videoBytes, decoding };
      this.#queue.update(id, { done: frame, total });
    };
    /** Where the encoder now in use started, and what it is to be done about it. */
    let encoderStart = index;
    let next: "compositor" | "encoder" | undefined = "compositor";
    let triedSoftware = used.acceleration === "software";
    try {
      // What came after the last place to go on from is not to be trusted, and the sound is
      // quick to make again, so that it never has a seam. Doing it again after a failure leaves
      // no more on the disk than doing it once.
      await exports.dropPieces(id, "video", video.nextSeq);
      await exports.dropPieces(id, "sound", 0);
      await checkpoint(index);
      // An encoder may leave out how long a frame is, which would make the last one last no time.
      const frameMicros = Math.round((1e6 * plan.scenes.fps.den) / plan.scenes.fps.num);
      const prefix = used.config.codec.slice(0, 4);
      const bitrate = (saved.encoding.config.bitrate ?? 0) + (saved.sound?.config.bitrate ?? 0);
      const maxBytes =
        ((bitrate * (range.to - range.from)) / 8) * MAX_BYTES_FACTOR + MAX_BYTES_EXTRA;
      const onChunk = (chunk: EncodedChunk) => {
        if (replacing) return;
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
        videoBytes += chunk.data.byteLength;
        const frame: EncodedFrame = {
          data: new Uint8Array(chunk.data),
          key: chunk.key,
          timestamp: chunk.timestamp / 1e6,
          duration: (chunk.duration || frameMicros) / 1e6,
        };
        keep(() => video.add(frame));
        if (bytes > maxBytes) wrong ??= "size";
      };
      const onWrong = (what: string) => {
        if (!replacing) wrong ??= what;
      };
      if (saved.sound) {
        const audioPlan = buildAudioPlan(state, timelineId);
        const media = this.#options.projects.media(project);
        const made = new Map(madeSoundsOf(state, timelineId).map((each) => [each.file, each]));
        // A sound made by code is a file like any other once it is there, made from this state.
        const source: SoundSource = async (layer) => {
          const wanted = layer.made && made.get(layer.file);
          if (!wanted) return undefined;
          this.#flag(run, "makingSound", true);
          const outcome = await untilAborted(
            this.#options.sounds.whenMade(wanted, state, project, signal),
            signal,
          ).finally(() => this.#flag(run, "makingSound", false));
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
            if (bytes > maxBytes) wrong ??= "size";
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
            this.#catchingUp(run, track.seconds, goal);
            await untilAborted(track.until(track.seconds + CATCH_UP_SECONDS), signal);
          }
          await untilAborted(track.until(goal), signal);
          this.#catchingUp(run, undefined, 0);
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
            used = await this.#startEncoder(current, used, onChunk, onWrong, signal);
            replacing = false;
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
              await dropReplaced();
              // A place to go on from is where a pause costs nothing.
              if (this.#pauseAsked) throw new PausedHere();
            }
            const planned = frames.at(index);
            const frame = index === restartAt ? { ...planned, keyFrame: true } : planned;
            const otherwise = notDone.find((span) => showsAt(span, frame.seconds));
            if (otherwise) throw new FrameFailed(index, frame.seconds, notDoneFailure(otherwise));
            await hear(frame.timestamp / 1e6 + SOUND_LEAD_SECONDS);
            asked.add(frame.timestamp);
            await untilAborted(current.encodeFrame(frame), signal).catch((error: unknown) => {
              if (error instanceof StillFailed) {
                throw new FrameFailed(index, frame.seconds, error.failure);
              }
              throw error;
            });
            while (behind()) await untilAborted(written, signal);
            this.#progress(index + 1, total);
          }
          await untilAborted(current.finishEncoding(), signal);
          if (changed) throw new ResumeFailed();
          if (wrong) throw new WrongOutput(wrong);
          await untilAborted(written, signal);
          if (videoChunks !== total) throw new WrongOutput("count");
          break;
        } catch (error) {
          if (signal.aborted || error instanceof PausedHere) throw error;
          replacing = true;
          const again = startedOverWith !== used.acceleration;
          if (error instanceof ResumeFailed && again && videoChunks === encoderStart) {
            // A new encoder that encodes another way: what was there cannot go on with this.
            notifications.push(t("export.resume.encoderChanged"));
            await untilAborted(written, signal);
            // Once the pieces go, what was kept before is no place to go on from any more.
            keptProgress = { frame: 0, videoPieces: 0, bytes: 0, total };
            await exports.dropPieces(id, "video", 0);
            video.rewind(0);
            changed = false;
            decoding = undefined;
            index = 0;
            videoChunks = 0;
            bytes = 0;
            videoBytes = 0;
            startedOverWith = used.acceleration;
            await checkpoint(0);
            this.#pace.restart(performance.now(), 0);
            next = "encoder";
            continue;
          }
          const encoderBroke =
            (error instanceof FrameFailed || error instanceof StillFailed) &&
            error.failure.reason === "encoder";
          if (encoderBroke && !triedSoftware) {
            // A graphics card that said it encodes and then does not: the processor does. It may
            // have taken frames and given some back before it said so, so it all goes back to the
            // last place kept, as after a reload. This device does not get to try it again.
            console.warn("The graphics card does not encode, the processor does", error);
            triedSoftware = true;
            void this.#noteHardwareFailed(used.codec);
            used = inSoftware(used);
            await untilAborted(written, signal);
            if (writeFailed) throw writeFailed;
            await exports.dropPieces(id, "video", kept.videoPieces);
            video.rewind(kept.videoPieces);
            bytes -= videoBytes - kept.videoBytes;
            ({ videoBytes, decoding } = kept);
            index = kept.frame;
            videoChunks = kept.frame;
            this.#pace.restart(performance.now(), index);
            next = "encoder";
            continue;
          }
          if (!(error instanceof WindowClosed)) throw error;
          // What the encoder had not given out yet went with the window. It starts over there.
          compositor?.dispose();
          await untilAborted(written, signal);
          index = videoChunks;
          unwatch();
          place = await this.#pause(signal, index, total);
          this.#usePlace(place);
          unwatch = watchHidden(place);
          this.#pace.restart(performance.now(), index);
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
      await dropReplaced();
      compositor?.dispose();
      await this.#writeFile(id, file, saved, fps, decoding, soundDecoding, signal);
      await this.#removeKept(id);
      this.#queue.update(id, { status: "done", done: total, total });
      this.#held.get(id)?.release();
      this.#held.delete(id);
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
      soundTrack?.close();
      this.#set(undefined);
      if (signal.aborted) {
        // People said stop: nothing of it stays.
        await this.#removeKept(id);
        const cleaned = await this.#abandon(file, id);
        this.#forgetEntry(id);
        await this.#stopped(error, true, cleaned, file, { state, project }, range);
      } else if (error instanceof PausedHere) {
        // Everything up to here is on the disk, and it goes on from here when people say so.
        const stays = await keepState({ status: "paused", order }).then(
          () => true,
          (reason: unknown) => {
            console.warn("A paused export is not kept as paused", reason);
            return false;
          },
        );
        this.#queue.update(id, { status: "paused", done: keptProgress.frame, total });
        notifications.push(
          t(stays ? "export.queue.paused" : "export.queue.pausedNotKept", {
            file: file.name,
            frame: keptProgress.frame,
            total,
            interpolation: { escapeValue: false },
          }),
        );
      } else if (isGone(error)) {
        // Somebody cleared what it kept while it ran: there is nothing to go on from. What a last
        // place to go on from wrote again goes too.
        await this.#removeKept(id);
        const cleaned = await this.#abandon(file, id);
        this.#forgetEntry(id);
        await this.#stopped(error, false, cleaned, file, { state, project }, range, false);
      } else {
        // What it got to stays in the list, failed, as far as there is a place to go on from: once
        // what went wrong is put right, a retry goes on from there. Without one it starts over,
        // with the same choices and the same file.
        const reason = this.#reasonOf(error, file, { state, project }, range);
        // The one this was to take the place of stays as it is: this one is no better now.
        held.replaces = undefined;
        const failed = await keepState({ status: "failed", order, failure: reason }).then(
          () => true,
          () => false,
        );
        if (failed) {
          this.#queue.update(id, {
            status: "failed",
            failure: reason,
            done: keptProgress.frame,
            total,
          });
          this.#sayFailed(
            reason,
            keptProgress.frame > 0 ? "export.video.kept" : "export.video.retry",
          );
        } else if (keptProgress.frame > 0) {
          // Not even that can be kept, as when the storage of the browser is full. The last place
          // to go on from is on the disk as it was, and stays: here it is failed, and after a
          // reload it is one that stopped with the page, which goes on from there just the same.
          this.#queue.update(id, {
            status: "failed",
            failure: reason,
            done: keptProgress.frame,
            total,
          });
          this.#sayFailed(reason, "export.video.kept");
        } else {
          // Nothing to go on from, and nothing that says it failed: nothing stays.
          await this.#removeKept(id);
          const cleaned = await this.#abandon(file, id);
          this.#forgetEntry(id);
          await this.#stopped(error, false, cleaned, file, { state, project }, range, false);
        }
      }
    } finally {
      compositor?.dispose();
      clearTimeout(readingSaid);
      unwatch();
      this.#resume = undefined;
      this.#onPauseAsked = undefined;
      this.#pauseAsked = false;
      this.#controller = undefined;
      this.#pace = undefined;
      this.#runNow = undefined;
      this.#set(undefined);
    }
  }

  /** What the export waits for, or not any more. Waiting does not count for how long it takes. */
  #flag(run: object, name: "makingSound" | "readingMedia" | "hidden", on: boolean): void {
    if (this.#runNow !== run) return;
    this.#pace?.wait(name, on, performance.now());
    const job = this.#job;
    if (!job || (job[name] ?? false) === on) return;
    if (on) this.#set({ ...job, [name]: true });
    else {
      const { [name]: _, ...rest } = job;
      this.#set(rest);
    }
  }

  #catchingUp(run: object, done: number | undefined, total: number): void {
    if (this.#runNow !== run) return;
    this.#pace?.wait("catchingUp", done !== undefined, performance.now());
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
    await this.#inTurn(id, async () => {
      // Writing it again would bring back what people, or a window, took away.
      if (this.#removed.has(id)) {
        throw new DOMException("The export is not kept any more", "NotFoundError");
      }
      const saved = { id, project, savedAt: Date.now(), state };
      try {
        await exports.save({ ...saved, target });
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "DataCloneError")) throw error;
        const download = instead();
        await exports.save({ ...saved, target: download });
        notifications.push(t("export.resume.noKeeping"));
      }
    });
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

  /**
   * Waits for people to say it goes on, after its window was closed. People pausing it then goes
   * back to the last place to go on from, which takes nothing that would not be done again anyway.
   */
  #pause(signal: AbortSignal, done: number, total: number): Promise<ExportWindow> {
    const { notifications, t } = this.#options;
    const job = this.#job;
    if (job) {
      const { id, name, stopping, place } = job;
      this.#set({ id, name, done, total, stopping, place, paused: true });
    }
    notifications.push(t("export.window.paused"));
    return new Promise((resolve, reject) => {
      const stop = () => reject(signal.reason);
      signal.addEventListener("abort", stop, { once: true });
      const paused = () => {
        signal.removeEventListener("abort", stop);
        this.#resume = undefined;
        reject(new PausedHere());
      };
      if (this.#pauseAsked) paused();
      this.#onPauseAsked = paused;
      this.#resume = (opening) => {
        this.#onPauseAsked = undefined;
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
    onWrong: (what: string) => void,
    signal: AbortSignal,
  ): Promise<VideoEncoding> {
    try {
      await untilAborted(compositor.startEncoding(encoding.config, onChunk, onWrong), signal);
      return encoding;
    } catch (error) {
      // Only the encoder failing says something about the graphics card: a window that went away
      // or a compositor that stopped answering does not, and the processor would not help.
      const encoder = error instanceof StillFailed && error.failure.reason === "encoder";
      if (signal.aborted || !encoder || encoding.acceleration !== "hardware") throw error;
      console.warn("The graphics card does not encode, the processor does", error);
      void this.#noteHardwareFailed(encoding.codec);
      const software = inSoftware(encoding);
      if (!(await (this.#options.support ?? browserSupport)(software.config))) throw error;
      await untilAborted(compositor.startEncoding(software.config, onChunk, onWrong), signal);
      return software;
    }
  }

  #progress(done: number, total: number): void {
    const job = this.#job;
    if (!job) return;
    const remainingMs = this.#pace?.remainingMs(
      performance.now(),
      done,
      total,
      ESTIMATE_AFTER_FRAMES,
    );
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
    of: Pick<Job, "state" | "project">,
    range: Range,
    kept = false,
  ): Promise<void> {
    const { t, notifications } = this.#options;
    const plain = { interpolation: { escapeValue: false } };
    const left = cleaned ? "" : t("export.video.leftBehind", { file: file.name, ...plain });
    if (cancelled) {
      if (cleaned) notifications.push(t("export.video.cancelled"));
      else this.#tell(t("export.video.cancelled"), left);
      return;
    }
    const message = this.#reasonOf(error, file, of, range);
    const after = kept ? t("export.video.kept") : left;
    this.#tell(t("export.video.failed"), `${message}${after}`);
  }

  /** Says that it failed, and what people can do: the export stays in the list. */
  #sayFailed(reason: string, after: "export.video.kept" | "export.video.retry"): void {
    const { t } = this.#options;
    this.#tell(t("export.video.failed"), `${reason}${t(after)}`);
  }

  /**
   * Shows a notice without holding up the line: the next export goes meanwhile. It waits for a
   * question that is open, such as the one for the next export, instead of taking its place.
   */
  #tell(title: string, message: string): void {
    void this.#quiet().then(() => this.#notice(title, message));
  }

  /** What went wrong, for people. A frame that failed is where the timeline goes. */
  #reasonOf(
    error: unknown,
    file: GrowingFile,
    of: Pick<Job, "state" | "project">,
    range: Range,
  ): string {
    const { state } = of;
    const { t, timeline } = this.#options;
    const plain = { interpolation: { escapeValue: false } };
    // Wherever the storage of the browser said so: a piece, a place to go on from, the start.
    if (isQuotaError(error)) {
      console.warn("Export stopped", error);
      return t("export.storage.full");
    }
    if (isGone(error)) {
      console.warn("Export stopped", error);
      return t("export.video.notKept");
    }
    if (error instanceof FrameFailed) {
      const at = this.#locate(error, range, of.project);
      const reason = describeFailure(t, error.failure, state, timeline);
      return t("export.video.failedAt", { frame: error.index + 1, at, reason, ...plain });
    }
    if (error instanceof ResumeFailed) return t("export.window.resumeFailed");
    if (error instanceof WrongOutput) {
      console.warn("Export stopped", error);
      return t("export.video.wrongOutput");
    }
    if (error instanceof WriteFailed) {
      console.warn("Export stopped", error.cause);
      return t("export.video.writeFailed", { file: file.name, error: error.message, ...plain });
    }
    console.warn("Export stopped", error);
    return describeFailure(t, failureOf(error), state, timeline);
  }

  /** What this browser keeps the open project by, see `projectKeyOf`. */
  #openKey(): string | undefined {
    const { store } = this.#options.session;
    return store && projectKeyOf(store);
  }

  /** Takes people to where it went wrong: the playhead goes there, and the clip gets selected. */
  #locate({ seconds, failure }: FrameFailed, range: Range, project: string): string {
    const { timeline } = this.#options;
    const { model } = timeline;
    // An export of another project than the one that is open has nowhere to take people.
    if (!model || this.#openKey() !== project) return "";
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

  #fields(
    state: ProjectState,
    ranges: readonly Range[],
    quality: Quality,
    cardFailed: boolean,
  ): FormField[] {
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
      ...(cardFailed
        ? [
            {
              id: "card",
              label: t("export.video.card"),
              value: "processor",
              options: [
                { id: "processor", label: t("export.video.cardFailed") },
                { id: "retry", label: t("export.video.cardRetry") },
              ],
            },
          ]
        : []),
    ];
  }

  #notes(
    state: ProjectState,
    encoding: VideoEncoding | undefined,
    audible: boolean,
    sound: SoundEncoding | undefined,
    inLine: boolean,
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
    // Last, where it is seen right above the button that says so.
    if (inLine) notes.push(t("export.queue.inLine", { count: this.#queue.waiting() + 1 }));
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

  /** When the graphics card failed at each codec, as far as that is recent. */
  async #hardwareFailures(): Promise<Map<VideoCodecName, number>> {
    const saved = await this.#options.settings.load(HARDWARE_KEY).catch(() => undefined);
    const failed = (saved as { version?: unknown; failed?: unknown } | undefined)?.failed;
    const found = new Map<VideoCodecName, number>();
    if (typeof failed !== "object" || failed === null) return found;
    const now = Date.now();
    for (const [codec, at] of Object.entries(failed)) {
      if (!VIDEO_CODECS.has(codec) || typeof at !== "number") continue;
      if (now - at < HARDWARE_MEMORY_MS) found.set(codec as VideoCodecName, at);
    }
    return found;
  }

  /** Codecs to encode with the processor, because the graphics card failed at them here. */
  async #noHardware(): Promise<ReadonlySet<VideoCodecName>> {
    return new Set((await this.#hardwareFailures()).keys());
  }

  async #forgetHardwareFailed(): Promise<void> {
    await this.#options.settings.save(HARDWARE_KEY, { version: 1, failed: {} }).catch(() => {});
  }

  async #noteHardwareFailed(codec: VideoCodecName): Promise<void> {
    const failed = await this.#hardwareFailures();
    failed.set(codec, Date.now());
    await this.#options.settings
      .save(HARDWARE_KEY, { version: 1, failed: Object.fromEntries(failed) })
      .catch(() => {});
  }
}

const VIDEO_CODECS: ReadonlySet<string> = new Set<VideoCodecName>(["avc", "vp9", "av1"]);

const PLAIN = { interpolation: { escapeValue: false } };

/** An export that stopped, which people chose to do again with a new one. */
interface Replacing {
  readonly saved: SavedExport;
}

/** What people chose for an export, before it is in line. */
interface Prepared {
  readonly job: Omit<Job, "place">;
  /** Where it goes, when it goes right away. */
  readonly place: ExportWindow | undefined;
  /** The claim on it, which this window keeps while it is in the list. */
  readonly release: () => void;
  readonly total: number;
}

/** Its place in line. What was kept before there was a line goes by when it was kept. */
const orderOf = ({ savedAt, state }: SavedExport): number =>
  (state as SavedState | undefined)?.queue?.order ?? savedAt;

/** Whether people pressed something just now, which the browser wants before some questions. */
const isPressed = (): boolean =>
  (globalThis as { navigator?: Navigator }).navigator?.userActivation?.isActive === true;

const isExpired = ({ savedAt }: SavedExport) => Date.now() - savedAt > KEEP_UNFINISHED_MS;

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
