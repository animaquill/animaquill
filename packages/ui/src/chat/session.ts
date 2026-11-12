import {
  Conversation,
  browserSystemPrompt,
  kindOf,
  readEntry,
  toolSpecsOf,
  type ChatEntry,
  type Endpoint,
  type FakeEndpoint,
  type PackNote,
  type TaskOutcome,
} from "@animaquill/agent";
import {
  aiTask,
  type ClipDescription,
  type ClipState,
  type ProblemSet,
  type ProjectStore,
  type StaticInputs,
  type UndoResult,
} from "@animaquill/core";
import {
  CallerState,
  DEFAULT_PACK,
  TOOLSET_VERSION,
  builtinPacks,
  choosePack,
  createToolset,
  usePack,
  type ModelPack,
  type PackUse,
  type SelectionFacts,
  type ToolHost,
} from "@animaquill/tools";
import {
  memoryChats,
  type AccountAccess,
  type ChatStore,
  type SavedChatSummary,
} from "@animaquill/host";
import { Emitter } from "../workbench/emitter.ts";
import type { ModelPacks } from "./packs.ts";
import type { AiSettingsStore } from "./settings.ts";
import { clipsOf, summaryOf } from "./summary.ts";

/**
 * Why a message cannot go out yet, before any service is asked. Through the relay of the platform:
 * there is none here (`relayMissing`), it does not take the address (`relayUrl`), or nobody is
 * signed in to the platform (`relaySignIn`).
 */
export type ChatHold =
  "noProject" | "noService" | "noModel" | "badUrl" | "relayMissing" | "relayUrl" | "relaySignIn";

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
  /** The clips the last task changed or made, which the timeline marks until the next one. */
  readonly marked: ReadonlySet<string>;
}

/** What `ChatSession.packOptions` gives for a model. */
export interface PackOptions {
  /** People chose the pack it has, rather than leaving it to the one recommended. */
  readonly chosen: boolean;
  /** What the model gets when people choose none. */
  readonly recommended: ModelPack;
  /** What a new conversation with the model gets now. */
  readonly current: ModelPack;
  readonly packs: readonly {
    readonly pack: ModelPack;
    readonly recommended: boolean;
    readonly current: boolean;
  }[];
}

export interface ChatSessionOptions {
  readonly chats: ChatStore | undefined;
  readonly ai: AiSettingsStore;
  /** The model packs installed here; without them, those that come with AnimaQuill. */
  readonly packs?: ModelPacks;
  /** The account on the platform, which the relay of AI services is only for. */
  readonly account?: AccountAccess | undefined;
  /** The project of this window, and what this browser keeps it by. */
  readonly project: () => { readonly store: ProjectStore; readonly key: string } | undefined;
  readonly subscribeProject: (listener: () => void) => () => void;
  readonly selection: () => SelectionFacts | undefined;
  /** All problems the editor knows of, which AI checks its work with. */
  readonly problems: () => ProblemSet;
  /** What a scene says about the properties of a clip, once the editor ran it. */
  readonly describe?: (clip: ClipState) => ClipDescription | undefined;
  /** What the problems of the project alone need, to tell what a batch of AI changes. */
  readonly problemInputs?: () => StaticInputs;
  /** Whether the code of a scene or a sound, as it is now, ran in the editor, see `ToolHost`. */
  readonly ranNow?: ToolHost["ranNow"];
  /** What taking back or doing again came to, for people. */
  readonly undone: (result: UndoResult) => void;
  /** For tests: a service that answers from a script, instead of the one people chose. */
  readonly fake?: () => FakeEndpoint | undefined;
}

/**
 * How long changes wait before the conversation is written while a task runs, so that a stream is a
 * few writes. Once the task ends it is written right away.
 */
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
    marked: new Set(),
  };
  /** The last task, once people took back what it did: its clips are no longer marked. */
  #unmarked: string | undefined;
  #project: { readonly store: ProjectStore; readonly key: string } | undefined;
  #stopWatching: (() => void) | undefined;
  #saving: ReturnType<typeof setTimeout> | undefined;
  /** What the tools keep of the conversation that is open, see `CallerState`. */
  #caller = new CallerState();
  #pending: (() => Promise<void>) | undefined;
  /** Conversations, by id and model, whose next answer takes the pack chosen for the model now. */
  readonly #repick = new Set<string>();

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
    this.#start([], undefined, undefined);
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

  /**
   * A conversation, from what was kept of it if anything: what AI read in it still counts, as far
   * as the project is the one it read (a reopened project has new revisions, see `CallerState`).
   */
  #start(entries: readonly ChatEntry[], id: string | undefined, caller: unknown): void {
    this.#stopWatching?.();
    const tools = caller === undefined ? new CallerState() : CallerState.from(caller);
    this.#caller = tools;
    const conversation = new Conversation({
      entries,
      // Each answer of the model is one: a change that fails holds back the rest of it.
      onAnswer: () => tools.beginAnswer(),
    });
    const chatId = id ?? newChatId();
    let known = conversation.getSnapshot().entries;
    let running = conversation.running;
    this.#stopWatching = conversation.subscribe(() => {
      const now = conversation.getSnapshot().entries;
      if (now !== known) {
        known = now;
        this.#saveSoon(chatId, now);
        this.#mark(now);
      }
      // A task that ended has its last answer on the screen: people may leave right after reading
      // it, before a write that waits would come.
      const was = running;
      running = conversation.running;
      if (was && !running) void this.flush();
    });
    this.#set({ conversation, id: chatId, hold: undefined });
    this.#mark(entries);
  }

  /** Marks the clips of the last task, the one that runs or ran last. */
  #mark(entries: readonly ChatEntry[]): void {
    const start = entries.findLastIndex((entry) => entry.role === "user");
    const last = entries[start];
    const task = last?.role === "user" ? last.task : undefined;
    const marked =
      task === undefined || task === this.#unmarked
        ? new Set<string>()
        : clipsOf(summaryOf(entries.slice(start)));
    const before = this.#snapshot.marked;
    if (marked.size === before.size && [...marked].every((clip) => before.has(clip))) return;
    this.#set({ marked });
  }

  /** The task whose changes the timeline marks, or would. */
  #lastTask(): string | undefined {
    return this.#snapshot.conversation?.tasks.at(-1);
  }

  /** The tools of one task, on the project that was open when it started, and only that one. */
  #toolsOf(task: string, caller: CallerState, use: PackUse) {
    const project = this.#project;
    const { selection, problems, describe, problemInputs, ranNow } = this.#options;
    const tools = createToolset(
      {
        store: () =>
          project && this.#options.project()?.store === project.store ? project.store : undefined,
        origin: () => aiTask(task),
        selection,
        problems,
        ...(describe && { describe }),
        ...(problemInputs && { problemInputs }),
        ...(ranNow && { ranNow }),
      },
      caller,
      use.texts,
      { results: use.results },
    );
    return toolSpecsOf(tools);
  }

  #saveSoon(id: string, entries: readonly ChatEntry[]): void {
    const project = this.#project?.key;
    if (project === undefined || entries.length === 0) return;
    const first = entries.find((entry) => entry.role === "user");
    const title = (first?.role === "user" ? first.text : "").trim().slice(0, TITLE_LENGTH);
    const caller = this.#caller;
    this.#pending = async () => {
      const chat = { id, project, title, updatedAt: Date.now(), entries, caller: caller.toJSON() };
      try {
        await this.#chats.save(chat);
        if (this.#project?.key !== project) return;
        const others = this.#snapshot.saved.filter((saved) => saved.id !== id);
        const { entries: _entries, caller: _caller, ...summary } = chat;
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
    this.#start([], undefined, undefined);
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
    this.#start(entries, id, saved.caller);
  }

  async remove(id: string): Promise<void> {
    const project = this.#project?.key;
    if (project === undefined) return;
    if (id === this.#snapshot.id) {
      if (this.running) return;
      this.#pending = undefined;
      this.#start([], undefined, undefined);
    }
    await this.#chats.remove(project, id).catch((error: unknown) => {
      console.warn("A conversation could not be taken away", error);
    });
    this.#set({ saved: this.#snapshot.saved.filter((saved) => saved.id !== id) });
  }

  /** The packs that can be used here: AnimaQuill's own, then those installed. */
  #packs(): readonly ModelPack[] {
    return this.#options.packs?.getSnapshot().packs ?? builtinPacks();
  }

  /**
   * The packs people can choose for a model, for where they pick a model: each with whether it is
   * the one recommended for the model (what it gets when people choose none: see `choosePack`),
   * and whether it is the one a new conversation gets now. Hidden packs are there only when the
   * settings show them or people chose one for this model.
   */
  packOptions(model: string): PackOptions {
    const packs = this.#packs();
    const settings = this.#options.ai.getSnapshot();
    const chosen = settings.packFor?.[model];
    const recommended = choosePack(model, packs).pack;
    const now = choosePack(model, packs, chosen);
    return {
      chosen: now.by === "chosen",
      recommended,
      current: now.pack,
      packs: packs
        .filter(
          (pack) => !pack.hidden || settings.showHiddenPacks === true || pack.id === now.pack.id,
        )
        .map((pack) => ({
          pack,
          recommended: pack.id === recommended.id,
          current: pack.id === now.pack.id,
        })),
    };
  }

  /**
   * A pack for a model from now on (by its name, as the settings keep it: the same choice as there),
   * nothing for the one recommended. From the settings ("next") it comes with the next conversation;
   * from where a conversation picks its model ("now") also with the next answer of the conversation
   * open, which then says so.
   */
  choosePack(model: string, pack: string | undefined, from: "now" | "next" = "next"): void {
    this.#options.ai.choosePack([model], pack);
    if (from === "now" && this.#snapshot.id !== undefined) {
      this.#repick.add(`${this.#snapshot.id}\n${model}`);
    }
  }

  /** Whether the next answer of the conversation open takes the pack chosen for a model now. */
  repicking(model: string): boolean {
    return this.#repick.has(`${this.#snapshot.id}\n${model}`);
  }

  /** The pack people would get for a model in a new conversation, and how. */
  choiceFor(model: string): { readonly pack: ModelPack; readonly note: PackNote } {
    const choice = choosePack(
      model,
      this.#packs(),
      this.#options.ai.getSnapshot().packFor?.[model],
    );
    return { pack: choice.pack, note: noteOf(choice.pack, choice.by) };
  }

  /**
   * The pack for the next answer of the conversation. A conversation keeps its pack, at the version
   * it began with, while the model stays: an update, like another choice in the settings, counts
   * from the next conversation. Where that version is not kept any more, the version installed goes
   * on (the chat says so); a new model, or a pack that is gone, chooses again, see `choosePack`.
   */
  #packFor(
    model: string,
    entries: readonly ChatEntry[],
  ): { readonly use: PackUse; readonly note: PackNote } {
    const last = entries.findLast((entry) => entry.role === "assistant");
    const repick = this.#repick.delete(`${this.#snapshot.id}\n${model}`);
    if (!repick && last?.role === "assistant" && last.model === model && last.pack && last.texts) {
      const { id, hash } = last.texts;
      const pinned =
        id === DEFAULT_PACK.id
          ? DEFAULT_PACK
          : (this.#options.packs?.versionOf(id, hash) ??
            this.#packs().find((pack) => pack.id === id));
      if (pinned) return { use: usePack(pinned, model), note: { ...last.pack, name: pinned.name } };
    }
    const { pack, note } = this.choiceFor(model);
    return { use: usePack(pack, model), note };
  }

  /** Where a message would go now, or why it cannot go. */
  async #target(): Promise<
    | {
        readonly endpoint: Endpoint | FakeEndpoint;
        readonly key: () => Promise<string | undefined>;
        readonly model: string;
      }
    | ChatHold
  > {
    const fake = this.#options.fake?.();
    if (fake) return { endpoint: fake, key: async () => undefined, model: fake.model ?? "fake" };
    const { ai } = this.#options;
    const service = ai.current;
    const kind = service && kindOf(service.kind);
    if (!service || !kind) return "noService";
    if (!service.model) return "noModel";
    if (!service.baseUrl) return "badUrl";
    const route = ai.routeOf(service);
    if (typeof route === "string") return route;
    // Not known yet is worth a try: the relay says so when nobody is signed in.
    if (route.relay && this.#options.account?.getSnapshot().status === "signedOut")
      return "relaySignIn";
    const endpoint: Endpoint = {
      service: service.kind,
      protocol: kind.protocol,
      baseUrl: route.baseUrl,
      model: service.model,
      catalog: kind.catalog,
      ...(route.relay && { relay: route.relay }),
    };
    return { endpoint, key: () => ai.keyOf(service.id), model: service.model };
  }

  /** Sends a message, which starts a task. Resolves once the task is over. */
  async send(text: string): Promise<TaskOutcome | undefined> {
    const conversation = this.#snapshot.conversation;
    const caller = this.#caller;
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
    const { use, note } = this.#packFor(target.model, conversation.getSnapshot().entries);
    // Another conversation may have opened meanwhile: this one is no longer on the screen.
    if (this.#snapshot.conversation !== conversation) return undefined;
    return conversation.send(text, {
      endpoint: target.endpoint,
      key: target.key,
      maxToolCalls,
      system: browserSystemPrompt(use.texts),
      tools: (task) => this.#toolsOf(task, caller, use),
      call: use.call,
      stamp: { toolset: TOOLSET_VERSION, texts: use.used, pack: note },
    });
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
    if (task === this.#lastTask()) {
      this.#unmarked = task;
      this.#mark(this.#snapshot.conversation?.getSnapshot().entries ?? []);
    }
  }

  redoTask(task: string): void {
    const store = this.#project?.store;
    if (!store) return;
    this.#options.undone(store.redoOrigin(aiTask(task)));
    this.#set({ undoTick: this.#snapshot.undoTick + 1 });
    if (task === this.#unmarked) {
      this.#unmarked = undefined;
      this.#mark(this.#snapshot.conversation?.getSnapshot().entries ?? []);
    }
  }
}

/** What an answer records of its pack, for people. */
export function noteOf(pack: ModelPack, by: PackNote["by"]): PackNote {
  return {
    name: pack.name,
    ...(pack.author && !pack.builtin && { author: pack.author.name }),
    ...(pack.builtin && { builtin: true }),
    by,
  };
}
