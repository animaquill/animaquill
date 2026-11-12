import type { AnswerEnd, AssistantEntry, ChatEntry, ToolEntry, UserEntry } from "./entries.ts";
import { createLiveStore, type LiveStore } from "./live.ts";
import type {
  AnswerStamp,
  CallSettings,
  Endpoint,
  FakeEndpoint,
  RunEvent,
  RunResult,
  ToolSpec,
} from "./pi.ts";
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
  readonly task: string;
  readonly startedAt: number;
  readonly tool: RunningTool | undefined;
  readonly retry: RetryWait | undefined;
}

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
  /** The tools of a task, which change the project as that task. */
  readonly tools: (task: string) => readonly ToolSpec[];
  /** How to call its model, as its model pack says. */
  readonly call?: CallSettings;
  /** What its answers are recorded as made with. */
  readonly stamp?: AnswerStamp;
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
   * runs this does nothing and says so with undefined.
   */
  async send(text: string, target: TaskTarget): Promise<TaskOutcome | undefined> {
    if (this.running || !text.trim()) return undefined;
    const now = this.#options.now ?? Date.now;
    const task = (this.#options.newTask ?? newTaskId)();
    const user: UserEntry = { role: "user", text, at: now(), task };
    const history = this.#snapshot.entries;
    this.#set({ entries: [...history, user] });
    return this.#run(task, target, history, text);
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
    const answer = entries.at(-1);
    return answer?.role === "assistant" && answer.end === "failed" ? task : undefined;
  }

  async #run(
    task: string,
    target: TaskTarget,
    history: readonly ChatEntry[],
    prompt: string | undefined,
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
        if (
          entry.role === "assistant" &&
          entry.end === "failed" &&
          retries < AUTO_RETRIES &&
          !controller.signal.aborted &&
          passes(entry.error ?? "")
        ) {
          held = entry;
          return;
        }
        if (entry.role === "tool") attempts += 1;
        const tool = entry.role === "tool" ? undefined : running.tool;
        this.#set({ entries: [...this.#snapshot.entries, entry], running: { ...running, tool } });
      }
    };

    let outcome: TaskOutcome;
    try {
      const { runTask } = await import("./pi.ts");
      let result: RunResult;
      for (let first = prompt; ; first = undefined) {
        held = undefined;
        result = await runTask({
          endpoint: target.endpoint,
          key: target.key,
          system: target.system,
          tools: target.tools(task),
          ...(target.call && { call: target.call }),
          ...(target.stamp && { stamp: target.stamp }),
          ...(this.#options.onAnswer && { onAnswer: this.#options.onAnswer }),
          history: first === undefined ? this.#snapshot.entries : history,
          ...(first !== undefined && { prompt: first }),
          signal: controller.signal,
          before: () => {
            if (calls >= max) return { reason: limitReason(max), stop: true };
            calls += 1;
            return undefined;
          },
          enough: () => attempts >= max,
          onEvent,
        });
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
        ...(result.end === "failed" && { failure: failureOf(result.error ?? "") }),
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
