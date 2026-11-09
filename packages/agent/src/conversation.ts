import type { AnswerEnd, ChatEntry, ToolEntry, UserEntry } from "./entries.ts";
import type { Endpoint, FakeEndpoint, RunEvent, ToolSpec } from "./pi.ts";
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
}

/** What runs now: the answer so far, and the tool that is running. */
export interface RunningTask {
  readonly task: string;
  /** What AI wrote of the answer that is on its way. */
  readonly text: string;
  readonly tool: { readonly id: string; readonly name: string } | undefined;
}

export interface ConversationSnapshot {
  readonly entries: readonly ChatEntry[];
  readonly running: RunningTask | undefined;
  /** How the last task ended. */
  readonly last: TaskOutcome | undefined;
}

/** Where a task goes: the service, its key, and how far AI may go. */
export interface TaskTarget {
  readonly endpoint: Endpoint | FakeEndpoint;
  readonly key: () => Promise<string | undefined>;
  readonly maxToolCalls: number;
}

export interface ConversationOptions {
  readonly entries?: readonly ChatEntry[];
  readonly system: string;
  /** The tools of a task, which change the project as that task. */
  readonly tools: (task: string) => readonly ToolSpec[];
  /** A new name for a task, which no other task of this project has. */
  readonly newTask?: () => string;
  readonly now?: () => number;
}

const newTaskId = () => {
  const random = crypto.getRandomValues(new Uint32Array(2));
  return `chat-${Date.now().toString(36)}-${[...random].map((n) => n.toString(36)).join("")}`;
};

/** Says that a task called as many tools as it may, to AI and for people. */
export const limitReason = (max: number): string =>
  `limit: 这次任务调用工具已经达到上限（${max} 次），这个工具没有执行。停下来，告诉用户做到了哪里，用户可以让你继续。`;

export class Conversation {
  readonly #options: ConversationOptions;
  readonly #listeners = new Set<() => void>();
  #snapshot: ConversationSnapshot;
  #controller: AbortController | undefined;

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
    const controller = new AbortController();
    this.#controller = controller;
    const user: UserEntry = { role: "user", text, at: now(), task };
    const history = this.#snapshot.entries;
    this.#set({
      entries: [...history, user],
      running: { task, text: "", tool: undefined },
      last: undefined,
    });

    let calls = 0;
    let attempts = 0;
    const max = target.maxToolCalls;
    const onEvent = (event: RunEvent) => {
      const running = this.#snapshot.running;
      if (!running) return;
      if (event.type === "text") {
        this.#set({ running: { ...running, text: running.text + event.delta } });
      } else if (event.type === "tool") {
        this.#set({ running: { ...running, tool: { id: event.id, name: event.name } } });
      } else {
        if (event.entry.role === "tool") attempts += 1;
        const done = event.entry.role === "tool" ? undefined : running.tool;
        this.#set({
          entries: [...this.#snapshot.entries, event.entry],
          running: { ...running, text: "", tool: done },
        });
      }
    };

    let outcome: TaskOutcome;
    try {
      const { runTask } = await import("./pi.ts");
      const result = await runTask({
        endpoint: target.endpoint,
        key: target.key,
        system: this.#options.system,
        tools: this.#options.tools(task),
        history,
        prompt: text,
        signal: controller.signal,
        before: () => {
          if (calls >= max) return { reason: limitReason(max), stop: true };
          calls += 1;
          return undefined;
        },
        enough: () => attempts >= max,
        onEvent,
      });
      const limited = result.end === "tools" && attempts >= max;
      outcome = {
        task,
        end: limited ? "limit" : result.end,
        ...(result.end === "failed" && { failure: failureOf(result.error ?? "") }),
      };
    } catch (error) {
      // Loading the library can fail, such as when the network went away after an update.
      const message = error instanceof Error ? error.message : String(error);
      outcome = { task, end: "failed", failure: failureOf(message) };
    }
    if (this.#controller === controller) this.#controller = undefined;
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
