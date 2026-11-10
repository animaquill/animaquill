import { Emitter } from "../workbench/emitter.ts";
import { cleanMessage, cleanName, cleanStack, type StackFrame } from "./privacy.ts";
import type { DiagnosticsRecorder } from "./recorder.ts";
import type { TrailEntry } from "./trail.ts";

type Value = string | number | boolean | undefined;

/** Where an error was caught. */
export type ErrorSource =
  /** Thrown and caught by nobody. */
  | "window"
  /** A promise that failed, and nobody was waiting for it. */
  | "promise"
  /** A tab that could not be drawn. */
  | "panel"
  /** The whole editor could not be drawn. */
  | "app"
  /** The compositor in its sandbox. */
  | "compositor"
  /** A command that went wrong, rather than one that said no. */
  | "command";

export type ErrorStatus =
  /** People are being asked whether to send it. */
  | "asking"
  /** Only on the list: there is nowhere to send it, or people were asked enough already. */
  | "quiet"
  | "sending"
  | "sent"
  /** It did not arrive, and people can try again. */
  | "failed"
  /** People said no. */
  | "declined";

/** What a host gets, when people send it. */
export interface ErrorReport {
  readonly format: 1;
  readonly kind: "error";
  readonly version: string;
  /** When it first happened. */
  readonly at: string;
  /** How long the page had been open by then. */
  readonly uptimeMs: number;
  readonly device: Readonly<Record<string, Value>>;
  readonly error: {
    readonly source: ErrorSource;
    readonly fingerprint: string;
    readonly name: string;
    readonly message: string;
    /** How often it happened while the page was open. */
    readonly count: number;
    readonly frames: readonly StackFrame[];
    readonly droppedFrames: number;
    /** Which components were being drawn, for a tab or the editor that could not be. */
    readonly componentFrames?: readonly StackFrame[];
    readonly panel?: string;
    readonly commands?: readonly string[];
  };
  /** What happened before, oldest first. */
  readonly trail: readonly TrailEntry[];
}

export interface CaughtError {
  readonly id: number;
  readonly fingerprint: string;
  readonly source: ErrorSource;
  readonly name: string;
  readonly message: string;
  readonly count: number;
  /** Milliseconds since the page opened. */
  readonly at: number;
  readonly status: ErrorStatus;
  readonly sentId?: string;
  /** All that would leave, exactly. */
  readonly report: ErrorReport;
}

export interface ErrorsSnapshot {
  /** Newest first. */
  readonly errors: readonly CaughtError[];
  /** The one people are being asked about. Only ever one, so that nothing piles up in the corner. */
  readonly asking: CaughtError | undefined;
}

export interface CaughtContext {
  readonly panel?: string;
  readonly commands?: readonly string[];
  /** What React says it was drawing. */
  readonly componentStack?: string;
}

export interface ErrorReportsOptions {
  readonly version: string;
  readonly recorder: DiagnosticsRecorder;
  /** Where people's reports go. Without it they can still save them. */
  readonly send?: (report: ErrorReport) => Promise<string>;
  /** The sites that serve the code of the editor. Places anywhere else stay out of reports. */
  readonly origins: () => readonly string[];
  /** Names people gave things that are open now, such as the project and its files. */
  readonly secrets: () => Iterable<string>;
  readonly device: () => Readonly<Record<string, Value>>;
  /** Milliseconds on a clock that goes on, for when errors came and how many came in a second. */
  readonly now?: () => number;
}

/** Asking more often than this in one page is pestering, whatever goes wrong. */
export const MAX_ASKS = 3;
/** More different errors than this in one page say the same as the first ones. */
const MAX_KEPT = 50;
const NAME = /^[\w.:-]{1,60}$/;
/** Nothing is wrong: the browser only says that it put off some layout to the next frame. */
const HARMLESS = [/^ResizeObserver loop/];
/**
 * More errors than this in a second are a storm: the rest are only counted, so that going wrong
 * every frame does not also make the editor slow.
 */
const MAX_PER_SECOND = 20;
/** A count that goes up every frame needs no new picture every frame. */
const COUNTS_EVERY_MS = 250;
/** Messages of errors without a place, already cleaned, for when they come again. */
const MAX_CLEANED = 100;

const EMPTY: ErrorsSnapshot = { errors: [], asking: undefined };

/** A short hash that stays the same for the same text, which is all a fingerprint needs. */
export function hashText(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, "0") + (h1 >>> 0).toString(16).padStart(8, "0");
}

/**
 * Which error this is, the same each time it happens in this build: where it was thrown, from where,
 * and what kind it is. Messages count only without a stack, because they can say different things
 * about the same mistake.
 */
export function fingerprintOf(
  source: ErrorSource,
  name: string,
  message: string,
  frames: readonly StackFrame[],
): string {
  const places = frames
    .slice(0, 3)
    .map(({ fn, file, line, column }) => `${fn ?? ""}@${file}:${line}:${column}`);
  const what = places.length > 0 ? places.join("|") : message;
  return hashText(`${source}|${name}|${what}`);
}

const names = (values: readonly string[] | undefined) =>
  values?.filter((value) => NAME.test(value));

function describe(error: unknown): { name: unknown; message: unknown; stack: unknown } {
  if (
    error instanceof Error ||
    (typeof error === "object" && error !== null && "message" in error)
  ) {
    const { name, message, stack } = error as {
      name?: unknown;
      message?: unknown;
      stack?: unknown;
    };
    return { name, message, stack };
  }
  return { name: undefined, message: error, stack: undefined };
}

/**
 * Errors of the editor while the page is open, and whether people want to send them. It asks once
 * for each of them, and nothing leaves before people say so with the report in front of them.
 */
export class ErrorReports {
  readonly #emitter = new Emitter();
  readonly #options: ErrorReportsOptions;
  readonly #now: () => number;
  /** What was taken in already, so that one error caught on two ways counts once. */
  readonly #seen = new WeakSet<object>();
  #errors: CaughtError[] = [];
  #snapshot = EMPTY;
  #asked = 0;
  #nextId = 1;
  #catching = false;
  #second = 0;
  #inSecond = 0;
  /** Counts went up since the last picture, which is made when somebody looks or soon after. */
  #stale = false;
  #countsSoon = false;
  readonly #cleaned = new Map<string, string>();

  constructor(options: ErrorReportsOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => performance.now());
  }

  subscribe = this.#emitter.subscribe;
  getSnapshot = (): ErrorsSnapshot => {
    if (this.#stale) this.#refresh();
    return this.#snapshot;
  };

  get canSend(): boolean {
    return this.#options.send !== undefined;
  }

  /** Takes in an error. It never throws: failing here would only hide the first failure. */
  capture(source: ErrorSource, error: unknown, context: CaughtContext = {}): void {
    if (this.#catching) return;
    this.#catching = true;
    try {
      this.#capture(source, error, context);
    } catch (failure) {
      console.warn("An error could not be taken in", failure);
    } finally {
      this.#catching = false;
    }
  }

  #capture(source: ErrorSource, error: unknown, context: CaughtContext): void {
    if (typeof error === "object" && error !== null) {
      if (this.#seen.has(error)) return;
      this.#seen.add(error);
    }
    const { recorder, origins } = this.#options;
    const described = describe(error);
    const raw = typeof described.message === "string" ? described.message : "";
    // Before anything that costs: these come in storms of their own.
    if (HARMLESS.some((pattern) => pattern.test(raw))) return;
    const now = this.#now();
    if (now - this.#second > 1000) {
      this.#second = now;
      this.#inSecond = 0;
    }
    this.#inSecond += 1;
    if (this.#inSecond > MAX_PER_SECOND) {
      recorder.trail.add("error.storm", {}, true);
      return;
    }
    const name = cleanName(described.name);
    const { frames, dropped } = cleanStack(described.stack, origins());
    // With a place, the message does not count, so the same error again costs next to nothing.
    const known =
      frames.length > 0
        ? this.#errors.find(
            (caught) => caught.fingerprint === fingerprintOf(source, name, "", frames),
          )
        : undefined;
    // None of it is in the code of the editor, so what it says could come from anywhere.
    const message = known
      ? known.message
      : frames.length === 0 && dropped > 0
        ? ""
        : this.#clean(described.message);
    const fingerprint = known?.fingerprint ?? fingerprintOf(source, name, message, frames);
    // An error that comes every frame is one line, or it would push out what led to it.
    recorder.trail.add("error", { source, name }, true);
    recorder.note("error", { source, name, message });
    const again = known ?? this.#errors.find((caught) => caught.fingerprint === fingerprint);
    if (again) {
      this.#count(again);
      return;
    }
    const at = this.#now();
    const component = context.componentStack
      ? cleanStack(context.componentStack, origins()).frames
      : undefined;
    const panel =
      context.panel !== undefined && NAME.test(context.panel) ? context.panel : undefined;
    const commands = names(context.commands);
    const report: ErrorReport = {
      format: 1,
      kind: "error",
      version: this.#options.version,
      at: new Date().toISOString(),
      uptimeMs: Math.round(at),
      device: this.#device(),
      error: {
        source,
        fingerprint,
        name,
        message,
        count: 1,
        frames,
        droppedFrames: dropped,
        ...(component && component.length > 0 && { componentFrames: component }),
        ...(panel && { panel }),
        ...(commands && commands.length > 0 && { commands }),
      },
      trail: recorder.trail.entries(),
    };
    const ask = this.canSend && this.#snapshot.asking === undefined && this.#asked < MAX_ASKS;
    if (ask) this.#asked += 1;
    const caught: CaughtError = {
      id: this.#nextId++,
      fingerprint,
      source,
      name,
      message,
      count: 1,
      at,
      status: ask ? "asking" : "quiet",
      report,
    };
    this.#errors = [caught, ...this.#errors].slice(0, MAX_KEPT);
    this.#publish();
  }

  /** Cleaning a message goes through every name in the project, so each is cleaned once. */
  #clean(message: unknown): string {
    const text = typeof message === "string" ? message : String(message);
    let cleaned = this.#cleaned.get(text);
    if (cleaned === undefined) {
      cleaned = cleanMessage(text, this.#options.secrets());
      if (this.#cleaned.size >= MAX_CLEANED) this.#cleaned.clear();
      this.#cleaned.set(text, cleaned);
    }
    return cleaned;
  }

  /** One more of an error. Whoever watches hears of it a little later, with all that came since. */
  #count(caught: CaughtError): void {
    const count = caught.count + 1;
    const next = {
      ...caught,
      count,
      report: { ...caught.report, error: { ...caught.report.error, count } },
    };
    this.#errors = this.#errors.with(this.#errors.indexOf(caught), next);
    this.#stale = true;
    if (this.#countsSoon) return;
    this.#countsSoon = true;
    setTimeout(() => {
      this.#countsSoon = false;
      if (this.#stale) this.#publish();
    }, COUNTS_EVERY_MS);
  }

  /** Facts about the device are nice to have, and no reason to lose the error. */
  #device(): Readonly<Record<string, Value>> {
    try {
      return this.#options.device();
    } catch {
      return {};
    }
  }

  #replace(
    caught: CaughtError,
    changes: Partial<Pick<CaughtError, "count" | "status" | "sentId">>,
  ) {
    const count = changes.count ?? caught.count;
    const next: CaughtError = {
      ...caught,
      ...changes,
      report: { ...caught.report, error: { ...caught.report.error, count } },
    };
    this.#errors = this.#errors.map((error) => (error.id === caught.id ? next : error));
    this.#publish();
    return next;
  }

  #refresh(): void {
    const errors = this.#errors;
    this.#snapshot = { errors, asking: errors.find(({ status }) => status === "asking") };
    this.#stale = false;
  }

  #publish(): void {
    this.#refresh();
    this.#emitter.emit();
  }

  #find(id: number): CaughtError | undefined {
    return this.#errors.find((error) => error.id === id);
  }

  /** People said no. The same error does not ask again while the page is open. */
  decline(id: number): void {
    const caught = this.#find(id);
    if (caught?.status === "asking") this.#replace(caught, { status: "declined" });
  }

  /** People said yes, with what leaves in front of them. */
  async send(id: number): Promise<void> {
    const caught = this.#find(id);
    const { send } = this.#options;
    if (!caught || !send || caught.status === "sending" || caught.status === "sent") return;
    const sending = this.#replace(caught, { status: "sending" });
    try {
      const sentId = await send(sending.report);
      this.#replace(this.#find(id) ?? sending, { status: "sent", sentId });
    } catch (error) {
      console.warn("The report of an error did not arrive", error);
      this.#replace(this.#find(id) ?? sending, { status: "failed" });
    }
  }
}

/**
 * Catches what nobody else does on this page, and what compositors in their sandboxes say went wrong
 * there. Returns how to stop.
 */
export function watchPage(
  reports: ErrorReports,
  recorder: DiagnosticsRecorder,
  compositorUrl: string,
) {
  const compositor = new URL(compositorUrl, location.href).href;
  const onError = (event: ErrorEvent) => {
    reports.capture("window", event.error ?? { name: "Error", message: event.message });
  };
  const onRejection = (event: PromiseRejectionEvent) => reports.capture("promise", event.reason);
  // Anything can write to this page, and reading `data` is what builds a message: only the frames
  // of compositors are listened to.
  const onMessage = (event: MessageEvent) => {
    const { source } = event;
    if (!source) return;
    const frame = [...document.querySelectorAll("iframe")].find(
      (element) => element.contentWindow === source,
    );
    if (!frame || !frame.src.startsWith(compositor)) return;
    const data: unknown = event.data;
    if (
      typeof data !== "object" ||
      data === null ||
      (data as { type?: unknown }).type !== "failed"
    ) {
      return;
    }
    const { name, message, stack } = data as { name?: unknown; message?: unknown; stack?: unknown };
    reports.capture("compositor", { name, message, stack });
  };
  const onVisibility = () => recorder.trail.add("visibility", { state: document.visibilityState });
  addEventListener("error", onError);
  addEventListener("unhandledrejection", onRejection);
  addEventListener("message", onMessage);
  document.addEventListener("visibilitychange", onVisibility);
  return () => {
    document.removeEventListener("visibilitychange", onVisibility);
    removeEventListener("message", onMessage);
    removeEventListener("unhandledrejection", onRejection);
    removeEventListener("error", onError);
  };
}
