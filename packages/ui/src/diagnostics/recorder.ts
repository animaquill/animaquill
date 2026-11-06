import { Emitter } from "../workbench/emitter.ts";

/** Enough to catch a problem. It ends by itself, so that a forgotten recording costs nothing. */
const MAX_RECORDING_MS = 10 * 60 * 1000;
const MAX_EVENTS = 6000;
const MAX_TEXT = 300;
/** Two frames at 60 Hz: anything longer is something people can see. */
const NOTICEABLE_GAP_MS = 34;
const MEMORY_EVERY_MS = 5000;
/** Upper ends of the groups that frame times are counted in. */
const FRAME_BUCKETS_MS = [8, 16, 33, 50, 100, 250, 1000] as const;

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
}

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

function deviceFacts(): Readonly<Record<string, Value>> {
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

const shorten = (value: unknown) => String(value).slice(0, MAX_TEXT);

/**
 * Collects how the editor runs, while people ask for it. It holds numbers and never what people
 * make: no names of projects or files, and no content.
 */
export class DiagnosticsRecorder {
  readonly #emitter = new Emitter();
  readonly #version: string;
  readonly #sample: (note: Note) => () => void;
  readonly #device: () => Readonly<Record<string, Value>>;
  #startedAt = 0;
  #recording = false;
  #events: DiagnosticsEvent[] = [];
  #dropped = 0;
  #frameTimes = new Map<string, number>();
  #stopSampling: (() => void) | undefined;

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
  getRecording = (): boolean => this.#recording;

  start(): void {
    if (this.#recording) return;
    this.#recording = true;
    this.#startedAt = performance.now();
    this.#events = [];
    this.#dropped = 0;
    this.#frameTimes = new Map();
    this.#stopSampling = this.#sample((kind, data) => this.note(kind, data));
    this.#emitter.emit();
  }

  /** Throws away what was collected. */
  discard(): void {
    if (!this.#recording) return;
    this.#stopSampling?.();
    this.#stopSampling = undefined;
    this.#recording = false;
    this.#events = [];
    this.#emitter.emit();
  }

  note(kind: string, data: Readonly<Record<string, Value>> = {}): void {
    if (!this.#recording) return;
    if (this.#events.length >= MAX_EVENTS) {
      this.#dropped += 1;
      return;
    }
    const t = Math.round(performance.now() - this.#startedAt);
    this.#events.push({ ...data, t, kind });
  }

  /** Every frame counts towards the totals, and only slow ones get a line of their own. */
  noteFrame(ms: number, data: Readonly<Record<string, Value>>, slow: boolean): void {
    if (!this.#recording) return;
    const bucket = FRAME_BUCKETS_MS.find((limit) => ms <= limit);
    const key = bucket === undefined ? "more" : `<=${bucket}`;
    this.#frameTimes.set(key, (this.#frameTimes.get(key) ?? 0) + 1);
    if (slow) this.note("frame", { ...data, ms: Math.round(ms) });
  }

  /** Ends the recording. */
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
    };
    this.discard();
    return report;
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

  const onError = (event: ErrorEvent) => note("error", { message: shorten(event.message) });
  const onRejection = (event: PromiseRejectionEvent) =>
    note("rejection", { message: shorten(event.reason) });
  const onVisibility = () => note("visibility", { state: document.visibilityState });
  addEventListener("error", onError);
  addEventListener("unhandledrejection", onRejection);
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
    removeEventListener("unhandledrejection", onRejection);
    removeEventListener("error", onError);
  };
  const limit = setTimeout(() => {
    note("limit", {});
    stop();
  }, MAX_RECORDING_MS);
  return stop;
}
