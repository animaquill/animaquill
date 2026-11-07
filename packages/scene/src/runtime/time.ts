import type { SceneClock } from "./clock.ts";

/**
 * A fixed date for a scene to live on, so that "now" is the same moment on every day and every
 * machine. How that moment reads is another matter: local time and language are the machine's.
 */
export const SCENE_EPOCH = Date.UTC(2026, 0, 1);

/** What the runtime itself keeps of the real thing, for its own waiting. */
export interface RealTime {
  readonly now: () => number;
  /** When `now()` was 0, in the same terms as a `TimeBase`. */
  readonly origin: number;
  readonly setTimeout: (run: () => void, ms: number) => number;
  readonly clearTimeout: (id: number) => void;
  readonly requestFrame: (run: () => void) => number;
}

/** Takes these before anything replaces them. */
export function realTime(): RealTime {
  const now = performance.now.bind(performance);
  const wait = window.setTimeout.bind(window);
  const stop = window.clearTimeout.bind(window);
  const frame = window.requestAnimationFrame.bind(window);
  return {
    now,
    origin: performance.timeOrigin,
    setTimeout: (run, ms) => wait(run, ms),
    clearTimeout: (id) => stop(id),
    requestFrame: (run) => frame(run),
  };
}

/**
 * A `Date` that reads the scene's clock. Everything else about dates stays what it was. Travels to
 * workers as text, so it can only use what it gets.
 */
export function clockDate(Real: DateConstructor, now: () => number): DateConstructor {
  // A function and not a class, because `Date()` without `new` has to work, and gives a string.
  function Date(this: unknown, ...args: unknown[]): unknown {
    if (new.target === undefined) return new Real(now()).toString();
    return Reflect.construct(Real, args.length === 0 ? [now()] : args, new.target);
  }
  Object.defineProperty(Date, "length", { value: Real.length });
  Object.defineProperty(Date, "prototype", { value: Real.prototype, writable: false });
  Object.defineProperties(Date, {
    now: { value: now, writable: true, configurable: true },
    parse: { value: Real.parse.bind(Real), writable: true, configurable: true },
    UTC: { value: Real.UTC.bind(Real), writable: true, configurable: true },
  });
  Object.defineProperty(Real.prototype, "constructor", {
    value: Date,
    writable: true,
    configurable: true,
  });
  return Date as unknown as DateConstructor;
}

interface TemporalNow {
  instant(): unknown;
  timeZoneId(): string;
  zonedDateTimeISO(zone?: string): unknown;
  plainDateTimeISO(zone?: string): unknown;
  plainDateISO(zone?: string): unknown;
  plainTimeISO(zone?: string): unknown;
}

interface ZonedDateTime {
  toPlainDateTime(): unknown;
  toPlainDate(): unknown;
  toPlainTime(): unknown;
}

interface Temporal {
  readonly Now: TemporalNow;
  readonly Instant: {
    fromEpochMilliseconds(milliseconds: number): {
      toZonedDateTimeISO(zone: string): ZonedDateTime;
    };
  };
}

/** Travels to workers as text, so it can only use what it gets. */
export function installTemporal(wall: () => number): void {
  const { Temporal } = globalThis as unknown as { Temporal?: Temporal };
  if (!Temporal) return;
  const { Now } = Temporal;
  const instant = () => Temporal.Instant.fromEpochMilliseconds(wall());
  const zoned = (zone = Now.timeZoneId()) => instant().toZonedDateTimeISO(zone);
  Now.instant = instant;
  Now.zonedDateTimeISO = zoned;
  Now.plainDateTimeISO = (zone) => zoned(zone).toPlainDateTime();
  Now.plainDateISO = (zone) => zoned(zone).toPlainDate();
  Now.plainTimeISO = (zone) => zoned(zone).toPlainTime();
}

/** Travels to workers as text, so it can only use what it gets. */
export function installIntl(wall: () => number): void {
  const prototype = Intl.DateTimeFormat.prototype;
  const format = Object.getOwnPropertyDescriptor(prototype, "format");
  const { formatToParts } = prototype;
  Object.defineProperty(prototype, "format", {
    ...format,
    get(this: Intl.DateTimeFormat) {
      const bound = format?.get?.call(this) as Intl.DateTimeFormat["format"];
      return (date?: Date | number) => bound(date ?? wall());
    },
  });
  prototype.formatToParts = function parts(date) {
    return formatToParts.call(this, date ?? wall());
  };
}

/**
 * Marks, measures and what the browser measured by itself. That last part is real time, and tells
 * the same as a clock. A worker needs this too, so it travels as text, with nothing from outside.
 */
export function installMeasures(now: () => number): void {
  const mark = performance.mark.bind(performance);
  const measure = performance.measure.bind(performance);
  const entries = performance.getEntries.bind(performance);
  const byType = performance.getEntriesByType.bind(performance);
  const byName = performance.getEntriesByName.bind(performance);
  const isOwn = ({ entryType }: PerformanceEntry) =>
    entryType === "mark" || entryType === "measure";

  performance.mark = (name, options) => mark(name, { startTime: now(), ...options });
  performance.measure = (name, first, second) => {
    if (typeof first === "object") {
      const ends = first.end !== undefined || first.duration !== undefined;
      return measure(name, ends ? first : { ...first, end: now() });
    }
    return measure(name, { start: first ?? 0, end: second ?? now() });
  };
  performance.getEntries = () => entries().filter(isOwn);
  performance.getEntriesByType = (type) => byType(type).filter(isOwn);
  performance.getEntriesByName = (name, type) => byName(name, type).filter(isOwn);
}

function installPerformance(clock: SceneClock): void {
  performance.now = () => clock.now;
  Object.defineProperty(Performance.prototype, "timeOrigin", { get: () => SCENE_EPOCH });
  installMeasures(() => clock.now);

  const timing = performance.timing as unknown as Record<string, unknown>;
  const fixed: Record<string, unknown> = {};
  for (const name in timing) {
    if (typeof timing[name] === "number") fixed[name] = SCENE_EPOCH;
  }
  Object.defineProperty(Performance.prototype, "timing", { get: () => fixed });
  const [date = "", time = ""] = new Date(SCENE_EPOCH).toISOString().split(/[T.]/);
  const [year, month, day] = date.split("-");
  Object.defineProperty(Document.prototype, "lastModified", {
    get: () => `${month}/${day}/${year} ${time}`,
  });
}

/** Timers can also hide in places that do not look like timers. */
function installHiddenTimers(clock: SceneClock): void {
  AbortSignal.timeout = (milliseconds) => {
    const controller = new AbortController();
    const abort = () => controller.abort(new DOMException("signal timed out", "TimeoutError"));
    clock.setTimer(abort, milliseconds, false);
    return controller.signal;
  };
  const { scheduler } = globalThis as unknown as {
    scheduler?: {
      postTask(run: () => unknown, options?: { delay?: number } & object): Promise<unknown>;
    };
  };
  if (scheduler) {
    const postTask = scheduler.postTask.bind(scheduler);
    scheduler.postTask = (run, { delay = 0, ...options } = {}) =>
      delay > 0
        ? new Promise((resolve) => clock.setTimer(() => resolve(undefined), delay, false)).then(
            () => postTask(run, options),
          )
        : postTask(run, options);
  }
  const idle = (run: IdleRequestCallback) => {
    let left = 50;
    const deadline = { didTimeout: false, timeRemaining: () => (left = Math.max(left - 1, 0)) };
    return clock.setTimer(() => run(deadline), 0, false);
  };
  window.requestIdleCallback = idle;
  window.cancelIdleCallback = (id) => clock.clearTimer(id);
}

const handlerOf = (handler: TimerHandler, args: unknown[]) =>
  typeof handler === "function"
    ? () => (handler as (...args: unknown[]) => void)(...args)
    : // oxlint-disable-next-line no-new-func -- a timer with a string is older than this rule
      new Function(String(handler));

/**
 * Replaces everything that tells the time. This has to happen before any code of the project runs,
 * and the replacements have to survive `document.open`, which they do because they are globals.
 */
export function installTime(clock: SceneClock): void {
  const wall = () => SCENE_EPOCH + clock.now;

  window.requestAnimationFrame = (callback) => clock.requestFrame(callback);
  window.cancelAnimationFrame = (id) => clock.cancelFrame(id);
  window.setTimeout = ((handler: TimerHandler, delay = 0, ...args: unknown[]) =>
    clock.setTimer(handlerOf(handler, args) as () => void, delay, false)) as typeof setTimeout;
  window.setInterval = ((handler: TimerHandler, delay = 0, ...args: unknown[]) =>
    clock.setTimer(handlerOf(handler, args) as () => void, delay, true)) as typeof setInterval;
  window.clearTimeout = (id) => clock.clearTimer(Number(id));
  window.clearInterval = window.clearTimeout;

  installPerformance(clock);
  window.Date = clockDate(Date, wall);
  installTemporal(wall);
  installIntl(wall);
  installHiddenTimers(clock);

  const timeline = Object.getOwnPropertyDescriptor(AnimationTimeline.prototype, "currentTime");
  Object.defineProperty(AnimationTimeline.prototype, "currentTime", {
    ...timeline,
    get(this: AnimationTimeline) {
      return this instanceof DocumentTimeline ? clock.now : timeline?.get?.call(this);
    },
  });
  Object.defineProperty(Event.prototype, "timeStamp", { get: () => clock.now });
}
