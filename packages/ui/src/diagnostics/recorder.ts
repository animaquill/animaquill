import { Emitter } from "../workbench/emitter.ts";
import { Trail } from "./trail.ts";

/** Enough to catch a problem. It ends by itself, so that a forgotten recording costs nothing. */
const MAX_RECORDING_MS = 10 * 60 * 1000;
const MAX_EVENTS = 6000;
/** Two frames at 60 Hz: anything longer is something people can see. */
const NOTICEABLE_GAP_MS = 34;
const MEMORY_EVERY_MS = 5000;
/** Upper ends of the groups that frame times are counted in. */
const FRAME_BUCKETS_MS = [8, 16, 33, 50, 100, 250, 1000] as const;
export const FRAME_TIME_GROUPS = [
  "<=8",
  "<=16",
  "<=33",
  "<=50",
  "<=100",
  "<=250",
  "<=1000",
  "more",
] as const;
/** Often enough to feel live, rarely enough to cost nothing. */
const REFRESH_MS = 250;
const RECENT_EVENTS = 60;
/** Too many to read, and the numbers above already say it. */
const NOT_LISTED = new Set(["memory"]);

type Value = string | number | boolean | undefined;

export interface DiagnosticsEvent {
  /** Milliseconds since the recording started. */
  readonly t: number;
  readonly kind: string;
  readonly [key: string]: Value;
}

export interface DiagnosticsReport {
  readonly format: 1;
  readonly version: string;
  readonly startedAt: string;
  readonly durationMs: number;
  readonly device: Readonly<Record<string, Value>>;
  readonly project: unknown;
  readonly frameTimes: Readonly<Record<string, number>>;
  readonly events: readonly DiagnosticsEvent[];
  /** Events that did not fit. */
  readonly dropped: number;
  /**
   * Whether something that competes with playing went on at some time while recording, by what it is,
   * such as `hashing`. When it did is in the events of the same kind.
   */
  readonly during: Readonly<Record<string, boolean>>;
}

/** Something that is on or off, such as hashing files, which a recording follows. */
export interface Condition {
  get(): boolean;
  subscribe(listener: () => void): () => void;
}

export type DiagnosticsStatus = "idle" | "recording" | "finished";

/** What the panel shows. It only changes as a whole, so that it can be compared. */
export interface DiagnosticsSnapshot {
  readonly status: DiagnosticsStatus;
  readonly elapsedMs: number;
  readonly limitReached: boolean;
  readonly counts: {
    readonly slowFrames: number;
    readonly cold: number;
    readonly gaps: number;
    readonly audioLate: number;
    readonly errors: number;
  };
  readonly framesPerSecond: number;
  readonly memoryMb: number | undefined;
  readonly frameTimes: Readonly<Record<string, number>>;
  /** Newest first. */
  readonly recent: readonly DiagnosticsEvent[];
  readonly report: DiagnosticsReport | undefined;
  readonly sentId: string | undefined;
}

const IDLE: DiagnosticsSnapshot = {
  status: "idle",
  elapsedMs: 0,
  limitReached: false,
  counts: { slowFrames: 0, cold: 0, gaps: 0, audioLate: 0, errors: 0 },
  framesPerSecond: 0,
  memoryMb: undefined,
  frameTimes: {},
  recent: [],
  report: undefined,
  sentId: undefined,
};

/** What the graphics card calls itself. Decoding and drawing depend on it more than on anything. */
function graphicsCard(): string | undefined {
  try {
    const context = document.createElement("canvas").getContext("webgl");
    const info = context?.getExtension("WEBGL_debug_renderer_info");
    return info ? String(context?.getParameter(info.UNMASKED_RENDERER_WEBGL)) : undefined;
  } catch {
    return undefined;
  }
}

export function deviceFacts(): Readonly<Record<string, Value>> {
  const { deviceMemory } = navigator as { deviceMemory?: number };
  return {
    userAgent: navigator.userAgent,
    cores: navigator.hardwareConcurrency,
    memoryGb: deviceMemory,
    screen: `${screen.width}x${screen.height}@${devicePixelRatio}`,
    window: `${innerWidth}x${innerHeight}`,
    graphicsCard: graphicsCard(),
  };
}

/**
 * Collects how the editor runs, while people ask for it. It holds numbers and never what people
 * make: no names of projects or files, and no content. What people do also goes in the black box,
 * which is always on and goes with a report of an error.
 */
export class DiagnosticsRecorder {
  readonly trail = new Trail();
  readonly #emitter = new Emitter();
  readonly #version: string;
  readonly #sample: (note: Note) => () => void;
  readonly #device: () => Readonly<Record<string, Value>>;
  #startedAt = 0;
  #status: DiagnosticsStatus = "idle";
  #snapshot = IDLE;
  #refresh: ReturnType<typeof setInterval> | undefined;
  /** When the last frames arrived, to count how many a second. */
  #frameMoments: number[] = [];
  #events: DiagnosticsEvent[] = [];
  #dropped = 0;
  #frameTimes = new Map<string, number>();
  #stopSampling: (() => void) | undefined;
  readonly #conditions = new Map<string, Condition>();
  /** Whether each was on at some time while recording. */
  #during = new Map<string, boolean>();
  #stopWatching: (() => void)[] = [];

  constructor(
    version: string,
    sample: (note: Note) => () => void = samplePage,
    device: () => Readonly<Record<string, Value>> = deviceFacts,
  ) {
    this.#version = version;
    this.#sample = sample;
    this.#device = device;
  }

  subscribe = this.#emitter.subscribe;
  getSnapshot = (): DiagnosticsSnapshot => this.#snapshot;
  getRecording = (): boolean => this.#status === "recording";

  start(): void {
    if (this.getRecording()) return;
    this.#status = "recording";
    this.#startedAt = performance.now();
    this.#frameMoments = [];
    this.#events = [];
    this.#dropped = 0;
    this.#frameTimes = new Map();
    this.#stopSampling = this.#sample((kind, data) => this.note(kind, data));
    this.#during = new Map();
    for (const [kind, condition] of this.#conditions) this.#follow(kind, condition);
    this.#refresh = setInterval(() => this.#publish(), REFRESH_MS);
    this.#publish();
  }

  /**
   * Notes when something that competes with playing goes on and off, while recording: `kind` is the
   * name of the event, with `on`. Once for each kind, for as long as the recorder is there.
   */
  watch(kind: string, condition: Condition): void {
    this.#conditions.set(kind, condition);
    if (this.getRecording()) this.#follow(kind, condition);
  }

  #follow(kind: string, condition: Condition): void {
    let on = condition.get();
    this.#during.set(kind, on);
    this.note(kind, { on });
    this.#stopWatching.push(
      condition.subscribe(() => {
        const now = condition.get();
        if (now === on) return;
        on = now;
        if (now) this.#during.set(kind, true);
        this.note(kind, { on });
      }),
    );
  }

  #publish(report?: DiagnosticsReport, sentId?: string): void {
    const events = this.#events;
    const now = performance.now();
    const counts = { slowFrames: 0, cold: 0, gaps: 0, audioLate: 0, errors: 0 };
    let memoryMb: number | undefined;
    let limitReached = false;
    for (const { kind, cold, mb } of events) {
      if (kind === "frame") counts.slowFrames += 1;
      if (kind === "frame" && typeof cold === "number") counts.cold += cold;
      if (kind === "gap") counts.gaps += 1;
      if (kind === "audio.late") counts.audioLate += 1;
      if (kind === "error") counts.errors += 1;
      if (kind === "memory" && typeof mb === "number") memoryMb = mb;
      if (kind === "limit") limitReached = true;
    }
    this.#frameMoments = this.#frameMoments.filter((moment) => now - moment <= 1000);
    this.#snapshot = {
      status: this.#status,
      elapsedMs: report?.durationMs ?? now - this.#startedAt,
      limitReached,
      counts,
      framesPerSecond: report ? this.#averageFrames(report) : this.#frameMoments.length,
      memoryMb,
      frameTimes: Object.fromEntries(this.#frameTimes),
      recent: events
        .filter(({ kind }) => !NOT_LISTED.has(kind))
        .slice(-RECENT_EVENTS)
        .toReversed(),
      report,
      sentId,
    };
    this.#emitter.emit();
  }

  /** Afterwards the last second means nothing, so this is over the whole recording. */
  #averageFrames({ durationMs }: DiagnosticsReport): number {
    const frames = [...this.#frameTimes.values()].reduce((sum, count) => sum + count, 0);
    return durationMs > 0 ? Math.round((frames * 1000) / durationMs) : 0;
  }

  #stop(): void {
    this.#stopSampling?.();
    this.#stopSampling = undefined;
    for (const stop of this.#stopWatching.splice(0)) stop();
    clearInterval(this.#refresh);
    this.#refresh = undefined;
  }

  /** Throws away what was collected. */
  discard(): void {
    this.#stop();
    this.#status = "idle";
    this.#events = [];
    this.#snapshot = IDLE;
    this.#emitter.emit();
  }

  /** Something people did or the editor went through, for the black box and any recording. */
  mark(kind: string, data: Readonly<Record<string, Value>> = {}, merge = false): void {
    this.trail.add(kind, data, merge);
    this.note(kind, data);
  }

  /** `at` is when it happened, as `performance.now()`, for what is heard of later. */
  note(kind: string, data: Readonly<Record<string, Value>> = {}, at = performance.now()): void {
    if (!this.getRecording()) return;
    if (this.#events.length >= MAX_EVENTS) {
      this.#dropped += 1;
      return;
    }
    const t = Math.max(Math.round(at - this.#startedAt), 0);
    this.#events.push({ ...data, t, kind });
  }

  /** Every frame counts towards the totals, and only slow ones get a line of their own. */
  noteFrame(ms: number, data: Readonly<Record<string, Value>>, slow: boolean): void {
    if (!this.getRecording()) return;
    this.#frameMoments.push(performance.now());
    const bucket = FRAME_BUCKETS_MS.find((limit) => ms <= limit);
    const key = bucket === undefined ? "more" : `<=${bucket}`;
    this.#frameTimes.set(key, (this.#frameTimes.get(key) ?? 0) + 1);
    if (slow) this.note("frame", { ...data, ms: Math.round(ms) });
  }

  /** Ends the recording. The report stays for people to look at until they decide what to do. */
  finish(project: unknown): DiagnosticsReport {
    const report: DiagnosticsReport = {
      format: 1,
      version: this.#version,
      startedAt: new Date(Date.now() - (performance.now() - this.#startedAt)).toISOString(),
      durationMs: Math.round(performance.now() - this.#startedAt),
      device: this.#device(),
      project,
      frameTimes: Object.fromEntries(this.#frameTimes),
      events: this.#events,
      dropped: this.#dropped,
      during: Object.fromEntries(this.#during),
    };
    this.#stop();
    this.#status = "finished";
    this.#publish(report);
    return report;
  }

  markSent(id: string): void {
    const { report } = this.#snapshot;
    if (report) this.#publish(report, id);
  }
}

type Note = (kind: string, data: Readonly<Record<string, Value>>) => void;

/** Watches the page itself. Returns how to stop. */
function samplePage(note: Note): () => void {
  let last = performance.now();
  let frame = requestAnimationFrame(function watch(this: void, now) {
    if (now - last > NOTICEABLE_GAP_MS && document.visibilityState === "visible") {
      note("gap", { ms: Math.round(now - last) });
    }
    last = now;
    frame = requestAnimationFrame(watch);
  });

  // Errors come from `ErrorReports`, which takes out what people made.
  const onVisibility = () => note("visibility", { state: document.visibilityState });
  document.addEventListener("visibilitychange", onVisibility);

  const tasks =
    typeof PerformanceObserver !== "undefined" &&
    PerformanceObserver.supportedEntryTypes.includes("longtask")
      ? new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            note("longtask", { ms: Math.round(entry.duration) });
          }
        })
      : undefined;
  tasks?.observe({ type: "longtask" });

  const memory = setInterval(() => {
    const { memory: heap } = performance as { memory?: { usedJSHeapSize: number } };
    if (heap) note("memory", { mb: Math.round(heap.usedJSHeapSize / 1024 ** 2) });
  }, MEMORY_EVERY_MS);

  const stop = () => {
    cancelAnimationFrame(frame);
    clearInterval(memory);
    clearTimeout(limit);
    tasks?.disconnect();
    document.removeEventListener("visibilitychange", onVisibility);
  };
  const limit = setTimeout(() => {
    note("limit", {});
    stop();
  }, MAX_RECORDING_MS);
  return stop;
}
