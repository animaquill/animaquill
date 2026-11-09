import {
  Conversation,
  SYSTEM_PROMPT,
  allTools,
  kindOf,
  readEntry,
  type ChatEntry,
  type Endpoint,
  type FakeEndpoint,
  type SelectionFacts,
  type TaskOutcome,
} from "@animaquill/agent";
import { aiTask, type ProjectStore, type UndoResult } from "@animaquill/core";
import { memoryChats, type ChatStore, type SavedChatSummary } from "@animaquill/host";
import { Emitter } from "../workbench/emitter.ts";
import type { AiSettingsStore } from "./settings.ts";

/** Why a message cannot go out yet, before any service is asked. */
export type ChatHold = "noProject" | "noService" | "noModel" | "relay" | "badUrl";

export interface ChatSnapshot {
  /** The conversation of the open project, which is new until somebody writes in it. */
  readonly conversation: Conversation | undefined;
  readonly id: string | undefined;
  /** Earlier conversations of the open project, newest first. */
  readonly saved: readonly SavedChatSummary[];
  /** Why the last message did not go out. */
  readonly hold: ChatHold | undefined;
  /** Changes to the project went back or came again, which the buttons of tasks show. */
  readonly undoTick: number;
}

export interface ChatSessionOptions {
  readonly chats: ChatStore | undefined;
  readonly ai: AiSettingsStore;
  /** The project of this window, and what this browser keeps it by. */
  readonly project: () => { readonly store: ProjectStore; readonly key: string } | undefined;
  readonly subscribeProject: (listener: () => void) => () => void;
  readonly selection: () => SelectionFacts | undefined;
  /** What taking back or doing again came to, for people. */
  readonly undone: (result: UndoResult) => void;
  /** For tests: a service that answers from a script, instead of the one people chose. */
  readonly fake?: () => FakeEndpoint | undefined;
}

/** How long changes wait before the conversation is written, so that a stream is a few writes. */
const SAVE_DELAY_MS = 500;
const TITLE_LENGTH = 40;

const newChatId = () =>
  `chat-${Date.now().toString(36)}-${crypto.getRandomValues(new Uint32Array(1))[0]?.toString(36)}`;

/**
 * The chat of a window: one conversation at a time for the open project, the service it goes to,
 * and what the tasks of AI did to the project. Conversations are kept in this browser, by project.
 */
export class ChatSession {
  readonly #options: ChatSessionOptions;
  readonly #chats: ChatStore;
  readonly #emitter = new Emitter();
  #snapshot: ChatSnapshot = {
    conversation: undefined,
    id: undefined,
    saved: [],
    hold: undefined,
    undoTick: 0,
  };
  #project: { readonly store: ProjectStore; readonly key: string } | undefined;
  #stopWatching: (() => void) | undefined;
  #saving: ReturnType<typeof setTimeout> | undefined;
  #pending: (() => Promise<void>) | undefined;

  constructor(options: ChatSessionOptions) {
    this.#options = options;
    this.#chats = options.chats ?? memoryChats();
    options.subscribeProject(() => this.#follow());
    this.#follow();
  }

  subscribe = this.#emitter.subscribe;
  getSnapshot = (): ChatSnapshot => this.#snapshot;

  #set(changes: Partial<ChatSnapshot>): void {
    this.#snapshot = { ...this.#snapshot, ...changes };
    this.#emitter.emit();
  }

  /** Another project came: its own conversations, and the task of the one before stops. */
  #follow(): void {
    const project = this.#options.project();
    if (project?.store === this.#project?.store && project?.key === this.#project?.key) return;
    this.#snapshot.conversation?.stop();
    void this.flush();
    this.#project = project;
    this.#start([], undefined);
    if (project) void this.#loadLatest(project.key);
  }

  async #loadLatest(project: string): Promise<void> {
    try {
      const saved = await this.#chats.list(project);
      if (this.#project?.key !== project) return;
      this.#set({ saved });
      const latest = saved[0];
      // Somebody may have started to write meanwhile.
      if (latest && this.#snapshot.conversation?.getSnapshot().entries.length === 0) {
        await this.open(latest.id);
      }
    } catch (error) {
      console.warn("Conversations could not be read", error);
    }
  }

  #start(entries: readonly ChatEntry[], id: string | undefined): void {
    this.#stopWatching?.();
    const conversation = new Conversation({
      entries,
      system: SYSTEM_PROMPT,
      tools: (task) => this.#toolsOf(task),
    });
    const chatId = id ?? newChatId();
    let known = conversation.getSnapshot().entries;
    this.#stopWatching = conversation.subscribe(() => {
      const now = conversation.getSnapshot().entries;
      if (now === known) return;
      known = now;
      this.#saveSoon(chatId, now);
    });
    this.#set({ conversation, id: chatId, hold: undefined });
  }

  /** The tools of one task, on the project that was open when it started, and only that one. */
  #toolsOf(task: string) {
    const project = this.#project;
    let seen = project?.store.revision;
    return allTools({
      store: () =>
        project && this.#options.project()?.store === project.store ? project.store : undefined,
      task,
      selection: this.#options.selection,
      seen: () => seen,
      saw: (revision) => (seen = revision),
    });
  }

  #saveSoon(id: string, entries: readonly ChatEntry[]): void {
    const project = this.#project?.key;
    if (project === undefined || entries.length === 0) return;
    const first = entries.find((entry) => entry.role === "user");
    const title = (first?.role === "user" ? first.text : "").trim().slice(0, TITLE_LENGTH);
    this.#pending = async () => {
      const chat = { id, project, title, updatedAt: Date.now(), entries };
      try {
        await this.#chats.save(chat);
        if (this.#project?.key !== project) return;
        const others = this.#snapshot.saved.filter((saved) => saved.id !== id);
        const { entries: _entries, ...summary } = chat;
        this.#set({ saved: [summary, ...others] });
      } catch (error) {
        console.warn("The conversation could not be kept", error);
      }
    };
    clearTimeout(this.#saving);
    this.#saving = setTimeout(() => void this.flush(), SAVE_DELAY_MS);
  }

  /** Writes what waits to be written. */
  async flush(): Promise<void> {
    clearTimeout(this.#saving);
    const pending = this.#pending;
    this.#pending = undefined;
    await pending?.();
  }

  get running(): boolean {
    return this.#snapshot.conversation?.running === true;
  }

  /** A conversation from the start. The one before stays among the saved ones. */
  newConversation(): void {
    if (this.running) return;
    void this.flush();
    this.#start([], undefined);
  }

  async open(id: string): Promise<void> {
    const project = this.#project?.key;
    if (project === undefined || this.running) return;
    await this.flush();
    const saved = await this.#chats.load(project, id).catch((error: unknown) => {
      console.warn("A conversation could not be read", error);
      return undefined;
    });
    if (!saved || this.#project?.key !== project) return;
    const entries = saved.entries.map(readEntry).filter((entry) => entry !== undefined);
    this.#start(entries, id);
  }

  async remove(id: string): Promise<void> {
    const project = this.#project?.key;
    if (project === undefined) return;
    if (id === this.#snapshot.id) {
      if (this.running) return;
      this.#pending = undefined;
      this.#start([], undefined);
    }
    await this.#chats.remove(project, id).catch((error: unknown) => {
      console.warn("A conversation could not be taken away", error);
    });
    this.#set({ saved: this.#snapshot.saved.filter((saved) => saved.id !== id) });
  }

  /** Where a message would go now, or why it cannot go. */
  async #target(): Promise<
    | {
        readonly endpoint: Endpoint | FakeEndpoint;
        readonly key: () => Promise<string | undefined>;
      }
    | ChatHold
  > {
    const fake = this.#options.fake?.();
    if (fake) return { endpoint: fake, key: async () => undefined };
    const { ai } = this.#options;
    const service = ai.current;
    const kind = service && kindOf(service.kind);
    if (!service || !kind) return "noService";
    if (!service.model) return "noModel";
    if (!service.baseUrl) return "badUrl";
    // There is no relay yet. People can still try straight, which the route setting allows.
    if (service.route === "relay") return "relay";
    const endpoint: Endpoint = {
      service: service.kind,
      protocol: kind.protocol,
      baseUrl: service.baseUrl,
      model: service.model,
      catalog: kind.catalog,
    };
    return { endpoint, key: () => ai.keyOf(service.id) };
  }

  /** Sends a message, which starts a task. Resolves once the task is over. */
  async send(text: string): Promise<TaskOutcome | undefined> {
    const conversation = this.#snapshot.conversation;
    if (!conversation || conversation.running || !text.trim()) return undefined;
    if (!this.#project) {
      this.#set({ hold: "noProject" });
      return undefined;
    }
    const target = await this.#target();
    if (typeof target === "string") {
      this.#set({ hold: target });
      return undefined;
    }
    this.#set({ hold: undefined });
    const maxToolCalls = this.#options.ai.getSnapshot().maxToolCalls;
    return conversation.send(text, { ...target, maxToolCalls });
  }

  stop(): void {
    this.#snapshot.conversation?.stop();
  }

  /** Whether what a task changed can be taken back now, or done again. */
  undoState(task: string): "undo" | "redo" | undefined {
    const store = this.#project?.store;
    if (!store) return undefined;
    if (store.canUndoOrigin(aiTask(task))) return "undo";
    if (store.canRedoOrigin(aiTask(task))) return "redo";
    return undefined;
  }

  /** Takes back everything a task changed, in one step. What people changed since then stays. */
  undoTask(task: string): void {
    const store = this.#project?.store;
    if (!store) return;
    this.#options.undone(store.undoOrigin(aiTask(task)));
    this.#set({ undoTick: this.#snapshot.undoTick + 1 });
  }

  redoTask(task: string): void {
    const store = this.#project?.store;
    if (!store) return;
    this.#options.undone(store.redoOrigin(aiTask(task)));
    this.#set({ undoTick: this.#snapshot.undoTick + 1 });
  }
}
