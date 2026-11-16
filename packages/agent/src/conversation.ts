import type { SelectionFacts } from "@animaquill/tools";
import {
  COMPACT_AT,
  contextNow,
  coveredBy,
  cutOf,
  estimateTokens,
  fills,
  hasPictures,
  picturesGoneBefore,
  summaryInForce,
  transcriptOf,
} from "./compaction.ts";
import {
  type AnswerEnd,
  type AssistantEntry,
  type AttachedImage,
  type ChatEntry,
  type SummaryEntry,
  type ToolEntry,
  type UserEntry,
} from "./entries.ts";
import { createLiveStore, type LiveStore } from "./live.ts";
import type {
  AnswerStamp,
  CallSettings,
  Endpoint,
  FakeEndpoint,
  Pictures,
  RunEvent,
  RunResult,
  ToolSpec,
} from "./pi.ts";
import type { AnswerUsage } from "./entries.ts";
import { AUTO_RETRIES, passes, retryDelay } from "./retry.ts";
import { failureOf, type ServiceFailure } from "./services.ts";

/**
 * One conversation with AI in the browser: what was said, and the task that runs now. Each message
 * of people starts a task, and the tools AI calls for it change the project as that task, so that
 * people can take all of it back at once. Nothing here knows the page or the editor: the editor
 * gives the tools, the service and the key.
 */

/** How a task ended: as an answer ends, or because it called as many tools as it may. */
export type TaskEnd = AnswerEnd | "limit";

export interface TaskOutcome {
  readonly task: string;
  readonly end: TaskEnd;
  readonly failure?: ServiceFailure;
  /** It went through the relay of the platform, which is what the browser could not reach. */
  readonly relayed?: true;
}

/** A tool that runs now, as AI called it. */
export interface RunningTool {
  readonly id: string;
  readonly name: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly startedAt: number;
}

/** A failure that passes, such as a busy service: the task waits, then tries again by itself. */
export interface RetryWait {
  /** Which try comes next, from 1, of `of`. */
  readonly attempt: number;
  readonly of: number;
  /** When it goes. */
  readonly at: number;
  readonly failure: ServiceFailure;
}

/**
 * What runs now. The words of the answer on their way are in `Conversation.live`, which changes
 * with every piece of them; this changes only when a tool begins or ends, or the task waits.
 */
export interface RunningTask {
  /** Empty while people had the earlier conversation summed up, which is no task. */
  readonly task: string;
  readonly startedAt: number;
  readonly tool: RunningTool | undefined;
  readonly retry: RetryWait | undefined;
  /** The earlier conversation is being summed up, to make room in the context (`compaction.ts`). */
  readonly compacting?: true;
}

/**
 * What making room in the context came to: a summary, only the old pictures left out, nothing
 * that could be left out, or it stopped.
 */
export type RoomMade = "summary" | "pictures" | "none" | "stopped";

export interface ConversationSnapshot {
  readonly entries: readonly ChatEntry[];
  readonly running: RunningTask | undefined;
  /** How the last task ended. */
  readonly last: TaskOutcome | undefined;
}

/**
 * Where a task goes and what goes with it: the service, its key, how far AI may go, and what the
 * model pack for its model gives (the system prompt, the tools, how to call the model). Each task
 * has its own: the model can change between two messages, and with it the pack.
 */
export interface TaskTarget {
  readonly endpoint: Endpoint | FakeEndpoint;
  readonly key: () => Promise<string | undefined>;
  readonly maxToolCalls: number;
  readonly system: string;
  /**
   * The tools of a task, which change the project as that task. `signal` stops when the task does,
   * for a tool that waits, such as one that waits for people to stop playing.
   */
  readonly tools: (task: string, signal: AbortSignal) => readonly ToolSpec[];
  /** How to call its model, as its model pack says. */
  readonly call?: CallSettings;
  /** What its answers are recorded as made with. */
  readonly stamp?: AnswerStamp;
  /**
   * Whether the pictures of the conversation go to its model, and where they are read from:
   * without it, or where the model does not take pictures, only the line of each goes.
   */
  readonly pictures?: Pictures;
  /**
   * Whether room is made by itself once the context is 80 % full, as the settings say: a summary
   * of the earlier conversation by the same model. A request that did not fit makes room anyway.
   */
  readonly compact?: boolean;
}

export interface ConversationOptions {
  readonly entries?: readonly ChatEntry[];
  /** A new answer of the model begins, before any of its tools run. */
  readonly onAnswer?: () => void;
  /** A new name for a task, which no other task of this project has. */
  readonly newTask?: () => string;
  readonly now?: () => number;
  /** Waits before a try again, see `RetryWait`; resolves early when the signal stops the task. */
  readonly wait?: (ms: number, signal: AbortSignal) => Promise<void>;
}

const waitFor = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done);
  });

const newTaskId = () => {
  const random = crypto.getRandomValues(new Uint32Array(2));
  return `chat-${Date.now().toString(36)}-${[...random].map((n) => n.toString(36)).join("")}`;
};

/** Says that a task called as many tools as it may, to AI and for people. */
export const limitReason = (max: number): string =>
  `error limit: this task has called tools ${max} times, as many as it may; this call and those after it in this task are not run.`;

export class Conversation {
  readonly #options: ConversationOptions;
  readonly #listeners = new Set<() => void>();
  #snapshot: ConversationSnapshot;
  #controller: AbortController | undefined;
  /** The words of the answer on its way, see `LiveAnswer`. */
  readonly live: LiveStore = createLiveStore();

  constructor(options: ConversationOptions) {
    this.#options = options;
    this.#snapshot = { entries: options.entries ?? [], running: undefined, last: undefined };
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  getSnapshot = (): ConversationSnapshot => this.#snapshot;

  get running(): boolean {
    return this.#snapshot.running !== undefined;
  }

  #set(snapshot: Partial<ConversationSnapshot>): void {
    this.#snapshot = { ...this.#snapshot, ...snapshot };
    for (const listener of this.#listeners) listener();
  }

  /** Stops the task that runs, if any. What AI changed so far stays, and can be taken back. */
  stop(): void {
    this.#controller?.abort();
  }

  /**
   * Starts a task with what people wrote, and waits for it to end. One at a time: while a task
   * runs this does nothing and says so with undefined. `selection` is what the editor showed as
   * people sent it, kept with the message (see `UserEntry.selection`).
   */
  async send(
    text: string,
    target: TaskTarget,
    images: readonly AttachedImage[] = [],
    selection?: SelectionFacts,
    marks: Pick<UserEntry, "plan" | "fromPlan"> = {},
  ): Promise<TaskOutcome | undefined> {
    if (this.running || (!text.trim() && images.length === 0)) return undefined;
    const now = this.#options.now ?? Date.now;
    const task = (this.#options.newTask ?? newTaskId)();
    const user: UserEntry = {
      role: "user",
      text,
      at: now(),
      task,
      ...(images.length > 0 && { images }),
      ...(selection && { selection }),
      ...(marks.plan && { plan: true as const }),
      ...(marks.fromPlan !== undefined && { fromPlan: marks.fromPlan }),
    };
    const history = this.#snapshot.entries;
    this.#set({ entries: [...history, user] });
    return this.#run(task, target, history, user);
  }

  /**
   * Tries the last task again after it failed: it goes on from where it was, as the same task, so
   * that what it changed before stays one thing to take back. Undefined when it did not fail.
   */
  async retry(target: TaskTarget): Promise<TaskOutcome | undefined> {
    if (this.running) return undefined;
    const task = this.tasks.at(-1);
    if (task === undefined || this.failedTask() !== task) return undefined;
    return this.#run(task, target, this.#snapshot.entries, undefined);
  }

  /** The last task, where it ended in a failure: it can be tried again. */
  failedTask(): string | undefined {
    const { entries, last } = this.#snapshot;
    const task = this.tasks.at(-1);
    if (task === undefined) return undefined;
    if (last?.task === task) return last.end === "failed" ? task : undefined;
    // A summary people asked for after it is no answer.
    const answer = entries.findLast((entry) => entry.role !== "summary");
    return answer?.role === "assistant" && answer.end === "failed" ? task : undefined;
  }

  /**
   * Sums up the earlier conversation now, as people asked: the same as when the context fills up.
   * One thing at a time: while a task runs this does nothing and says so with undefined.
   */
  async compact(target: TaskTarget): Promise<RoomMade | undefined> {
    if (this.running || cutOf(this.#snapshot.entries) === undefined) return undefined;
    const now = this.#options.now ?? Date.now;
    const controller = new AbortController();
    this.#controller = controller;
    this.#set({
      running: { task: "", startedAt: now(), tool: undefined, retry: undefined, compacting: true },
    });
    try {
      return await this.#makeRoom(target, "people", controller.signal);
    } finally {
      if (this.#controller === controller) this.#controller = undefined;
      this.#set({ running: undefined });
    }
  }

  /** Whether people can have the earlier conversation summed up now. */
  get compactable(): boolean {
    return !this.running && cutOf(this.#snapshot.entries) !== undefined;
  }

  /**
   * Makes room in the context: a summary of all but the last two turns (or the last two answers of
   * one long turn), by the model of the task. Where the model cannot write one, the pictures of that
   * part are left out instead. The summary is an entry of its own: nothing before it changes.
   */
  async #makeRoom(
    target: TaskTarget,
    by: SummaryEntry["by"],
    signal: AbortSignal,
  ): Promise<RoomMade> {
    const now = this.#options.now ?? Date.now;
    const entries = this.#snapshot.entries;
    const running = this.#snapshot.running;
    if (running) this.#set({ running: { ...running, tool: undefined, compacting: true } });
    try {
      const cut = cutOf(entries);
      const context = contextNow(entries);
      const before = context?.used ?? estimateTokens(entries);
      const start = summaryInForce(entries)?.through ?? 0;
      const gone = picturesGoneBefore(entries);
      if (cut) {
        const { summarize } = await import("./pi.ts");
        const answer = await summarize({
          endpoint: target.endpoint,
          key: target.key,
          transcript: transcriptOf(entries, cut.through),
          signal,
        });
        if (signal.aborted) return "stopped";
        if (answer.ok) {
          const left =
            estimateTokens(entries.slice(start, Math.max(start, gone)), false) +
            estimateTokens(entries.slice(Math.max(start, gone), cut.through)) +
            estimateTokens(
              summaryInForce(entries) ? [summaryInForce(entries) as SummaryEntry] : [],
            );
          const after = Math.max(0, before - left + Math.ceil(answer.text.length / 4));
          const window = answer.window ?? context?.window;
          this.#add({
            role: "summary",
            kind: "summary",
            through: cut.through,
            text: answer.text,
            ...(cut.asked !== undefined && { asked: cut.asked }),
            count: coveredBy(entries, cut.through),
            before,
            after,
            ...(window !== undefined && { window }),
            by,
            at: now(),
            service: answer.service,
            model: answer.model,
            usage: answer.usage,
          });
          return "summary";
        }
      }
      // No summary: the pictures of all but the turn that runs go, where there are any still.
      const last = entries.findLastIndex((entry) => entry.role === "user");
      const through = cut?.through ?? Math.max(0, last);
      const part = entries.slice(gone, through);
      if (through <= gone || !hasPictures(part)) return "none";
      const saved = estimateTokens(part) - estimateTokens(part, false);
      this.#add({
        role: "summary",
        kind: "pictures",
        through,
        count: coveredBy(entries, through),
        before,
        after: Math.max(0, before - saved),
        ...(context?.window !== undefined && { window: context.window }),
        by,
        at: now(),
      });
      return "pictures";
    } catch {
      return signal.aborted ? "stopped" : "none";
    } finally {
      const still = this.#snapshot.running;
      if (still?.compacting && still.task !== "") {
        const { compacting: _compacting, ...rest } = still;
        this.#set({ running: rest });
      }
    }
  }

  #add(entry: ChatEntry): void {
    this.#set({ entries: [...this.#snapshot.entries, entry] });
  }

  async #run(
    task: string,
    target: TaskTarget,
    history: readonly ChatEntry[],
    prompt: UserEntry | undefined,
  ): Promise<TaskOutcome> {
    const now = this.#options.now ?? Date.now;
    const controller = new AbortController();
    this.#controller = controller;
    this.live.dispatch({ type: "start", at: now() });
    this.#set({
      running: { task, startedAt: now(), tool: undefined, retry: undefined },
      last: undefined,
    });

    let calls = 0;
    let attempts = 0;
    let retries = 0;
    /** A failed answer that is tried again: kept back, and only kept if the tries run out. */
    let held: AssistantEntry | undefined;
    const max = target.maxToolCalls;
    const relayed =
      "relay" in target.endpoint && target.endpoint.relay !== undefined ? true : undefined;
    const onEvent = (event: RunEvent) => {
      const running = this.#snapshot.running;
      if (!running) return;
      const at = now();
      if (event.type === "text" || event.type === "thinking") {
        this.live.dispatch({ type: event.type, delta: event.delta, at });
      } else if (event.type === "tool") {
        this.live.dispatch({ type: "heard", at });
        const tool = { id: event.id, name: event.name, args: event.args, startedAt: at };
        this.#set({ running: { ...running, tool } });
      } else {
        const { entry } = event;
        this.live.dispatch({ type: "heard", at, clear: entry.role === "assistant" });
        // A failure that passes is tried again, and one that did not fit makes room first: either
        // is kept back, and kept only if that does not help.
        if (
          entry.role === "assistant" &&
          entry.end === "failed" &&
          !controller.signal.aborted &&
          ((retries < AUTO_RETRIES && passes(entry.error ?? "")) ||
            (overflowed?.(entry.error ?? "", entry.usage?.window) ?? false))
        ) {
          held = entry;
          return;
        }
        if (entry.role === "assistant" && entry.end !== "failed") answered += 1;
        if (entry.role === "tool") attempts += 1;
        const tool = entry.role === "tool" ? undefined : running.tool;
        this.#set({ entries: [...this.#snapshot.entries, entry], running: { ...running, tool } });
      }
    };

    let outcome: TaskOutcome;
    /** Answers that went through in this run, and how many there were when room was last made. */
    let answered = 0;
    let roomAt: number | undefined;
    /** Nothing more can be summed up in this task: it goes on as it is. */
    let noRoom = false;
    /** The conversation does not fit, even with room made. */
    let full = false;
    let overflowed: ((error: string, window?: number) => boolean) | undefined;
    const auto = target.compact === true;
    try {
      const pi = await import("./pi.ts");
      const { runTask } = pi;
      overflowed = pi.overflowed;
      let result: RunResult;
      let first = prompt;
      // The last request took most of the context: room first, then the task goes on from there.
      if (auto && fills(this.#snapshot.entries)) {
        const made = await this.#makeRoom(target, "auto", controller.signal);
        if (made === "summary" || made === "pictures") first = undefined;
      }
      for (; ; first = undefined) {
        held = undefined;
        if (controller.signal.aborted) {
          result = { end: "stopped" };
          break;
        }
        result = await runTask({
          endpoint: target.endpoint,
          key: target.key,
          system: target.system,
          tools: target.tools(task, controller.signal),
          ...(target.call && { call: target.call }),
          ...(target.stamp && { stamp: target.stamp }),
          ...(this.#options.onAnswer && { onAnswer: this.#options.onAnswer }),
          history: first === undefined ? this.#snapshot.entries : history,
          ...(first !== undefined && {
            prompt: first.text,
            ...(first.images && { images: first.images }),
            ...(first.plan && { plan: true }),
          }),
          ...(target.pictures && { pictures: target.pictures }),
          signal: controller.signal,
          before: () => {
            if (calls >= max) return { reason: limitReason(max), stop: true };
            calls += 1;
            return undefined;
          },
          enough: () => attempts >= max,
          ...(auto &&
            !noRoom && {
              full: (usage: AnswerUsage) =>
                usage.window !== undefined &&
                usage.input + usage.cacheRead + usage.cacheWrite >= usage.window * COMPACT_AT,
            }),
          onEvent,
        });
        if (result.full && !controller.signal.aborted) {
          const made = await this.#makeRoom(target, "auto", controller.signal);
          if (made === "none") noRoom = true;
          continue;
        }
        // It did not fit: room once, then again only after an answer went through.
        if (result.end === "failed" && result.overflow && !controller.signal.aborted) {
          const made =
            roomAt === undefined || answered > roomAt
              ? await this.#makeRoom(target, "auto", controller.signal)
              : "none";
          roomAt = answered;
          if (made === "summary" || made === "pictures") continue;
          if (made === "none") full = true;
          break;
        }
        const error = result.error ?? "";
        if (
          result.end !== "failed" ||
          retries >= AUTO_RETRIES ||
          controller.signal.aborted ||
          !passes(error)
        )
          break;
        retries += 1;
        const delay = retryDelay(retries, error);
        const running = this.#snapshot.running;
        const failure = failureOf(error);
        if (running) {
          const retry = { attempt: retries, of: AUTO_RETRIES, at: now() + delay, failure };
          this.#set({ running: { ...running, tool: undefined, retry } });
        }
        await (this.#options.wait ?? waitFor)(delay, controller.signal);
        if (controller.signal.aborted) {
          result = { end: "stopped" };
          break;
        }
        const waiting = this.#snapshot.running;
        if (waiting) this.#set({ running: { ...waiting, retry: undefined } });
        this.live.dispatch({ type: "heard", at: now(), clear: true });
      }
      // The tries ran out, or the task stopped while it waited: the last failure is kept.
      // Set in `onEvent`, which the types do not follow.
      const last = held as AssistantEntry | undefined;
      if (last) {
        const { error: _error, ...stopped } = last;
        const kept: AssistantEntry =
          result.end === "stopped" ? { ...stopped, end: "stopped" } : last;
        this.#set({ entries: [...this.#snapshot.entries, kept] });
      }
      const limited = result.end === "tools" && attempts >= max;
      outcome = {
        task,
        end: limited ? "limit" : result.end,
        ...(result.end === "failed" && {
          failure: full
            ? { kind: "contextFull" as const, message: result.error ?? "" }
            : failureOf(result.error ?? ""),
        }),
        ...(relayed && { relayed }),
      };
    } catch (error) {
      // Loading the library can fail, such as when the network went away after an update.
      const message = error instanceof Error ? error.message : String(error);
      outcome = { task, end: "failed", failure: failureOf(message), ...(relayed && { relayed }) };
    }
    if (this.#controller === controller) this.#controller = undefined;
    this.live.dispatch({ type: "heard", at: now(), clear: true });
    this.#set({ running: undefined, last: outcome });
    return outcome;
  }

  /** The tasks of this conversation, newest last, with what came of their tools. */
  get tasks(): readonly string[] {
    return this.#snapshot.entries.flatMap((entry) => (entry.role === "user" ? [entry.task] : []));
  }

  /** What the tools of a task said, by the call they answer. */
  resultsOf(task: string): ReadonlyMap<string, ToolEntry> {
    const results = new Map<string, ToolEntry>();
    let inside = false;
    for (const entry of this.#snapshot.entries) {
      if (entry.role === "user") inside = entry.task === task;
      else if (inside && entry.role === "tool") results.set(entry.call, entry);
    }
    return results;
  }
}
