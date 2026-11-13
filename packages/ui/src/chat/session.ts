import {
  Conversation,
  askModel,
  browserSystemPrompt,
  readEntry,
  toolSpecsOf,
  type ChatEntry,
  type Endpoint,
  type FakeEndpoint,
  type ModelRef,
  type PackNote,
  type ReasoningLevel,
  type ServiceConfig,
  type SmallAsk,
  type TaskOutcome,
  type TaskTarget,
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
  REASONING,
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
  ChatNewer,
  memoryChats,
  type AccountAccess,
  type ChatStore,
  type SavedChat,
  type SavedChatSummary,
  type WindowMemory,
} from "@animaquill/host";
import { Emitter } from "../workbench/emitter.ts";
import {
  askingIn,
  changesIn,
  cleanTitle,
  firstWords,
  searchChats,
  type Found,
} from "./conversations.ts";
import { Drafts } from "./drafts.ts";
import type { ModelPacks } from "./packs.ts";
import type { AiSettingsStore } from "./settings.ts";
import { clipsOf, summaryOf } from "./summary.ts";

/**
 * Why a message cannot go out yet, before any service is asked. Through the relay of the platform:
 * there is none here (`relayMissing`), it does not take the address (`relayUrl`), or nobody is
 * signed in to the platform (`relaySignIn`).
 */
export type ChatHold =
  | "noProject"
  | "noService"
  | "noModel"
  | "badUrl"
  | "relayMissing"
  | "relayUrl"
  | "relaySignIn"
  /** The service of the model of the conversation was taken away. */
  | "modelGone"
  /** The model of the conversation was turned off in the settings. */
  | "modelOff";

/** Where a conversation was copied from, see `ChatSession.fork`. */
export interface ForkedFrom {
  readonly title: string;
  /** Up to which turn, from 1: the turn whose words went to the new one's input box. */
  readonly turn: number;
}

/**
 * The model a conversation uses, as the chat shows it: its own, or the default where it chose
 * none. `off` and `gone` say that it cannot be used as it is: turned off, or its service gone.
 */
export interface ModelNow {
  readonly ref: ModelRef;
  readonly service: ServiceConfig | undefined;
  readonly state: "ok" | "off" | "gone";
  /** The conversation chose it, rather than taking the default. */
  readonly own: boolean;
}

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
  /** What the conversation open is called, and who named it; empty until it has words. */
  readonly title: string;
  readonly titleBy: "auto" | "user" | undefined;
  /** The model the conversation open chose; none takes the default. */
  readonly model: ModelRef | undefined;
  /** How hard its model reasons, as chosen for this conversation; none as set up. */
  readonly reasoning: ReasoningLevel | undefined;
  readonly forkedFrom: ForkedFrom | undefined;
  /**
   * Models whose pack people chose again from where this conversation picks its model: its next
   * answer with one of them takes the pack chosen now (and says so), see `choosePack`. Kept with the
   * conversation, so that it holds after a reload.
   */
  readonly repick: readonly string[];
  /** Messages that go once the task that runs is done, oldest first. */
  readonly queued: readonly string[];
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
  /** Another device wrote a conversation, which shows as it has it now. */
  readonly chatReplaced?: () => void;
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
  /** The memory of this window, where drafts and the conversation open are kept. */
  readonly memory?: WindowMemory;
  /** For tests: what a small request to a model answers, such as for a title. See `askModel`. */
  readonly ask?: (
    endpoint: Endpoint,
    key: string | undefined,
    options: SmallAsk,
  ) => Promise<{ readonly ok: boolean; readonly text?: string }>;
}

/**
 * How long changes wait before the conversation is written while a task runs, so that a stream is a
 * few writes. Once the task ends it is written right away.
 */
const SAVE_DELAY_MS = 500;
const TITLE_LENGTH = 40;
/** At most this many tokens for the title the model writes, and this long to wait for it. */
const TITLE_TOKENS = 60;
const TITLE_TIMEOUT_MS = 20_000;
/** Where the window keeps which conversation of a project it had open. */
const openKey = (project: string) => `chat.open\n${project}`;

/** What the model is asked for the title of a conversation: words to the AI, in English. */
export const titlePrompt = (text: string): string =>
  "Write a title of at most 8 words for a conversation that begins with the message below, in the " +
  "language of the message. Reply with the title only, without quotes.\n\nMessage:\n" +
  text.slice(0, 1000);

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
    title: "",
    titleBy: undefined,
    model: undefined,
    reasoning: undefined,
    forkedFrom: undefined,
    repick: [],
    queued: [],
  };
  /** What people wrote and did not send yet, by conversation. */
  readonly drafts: Drafts;
  /** The last task, once people took back what it did: its clips are no longer marked. */
  #unmarked: string | undefined;
  #project: { readonly store: ProjectStore; readonly key: string } | undefined;
  #stopWatching: (() => void) | undefined;
  #saving: ReturnType<typeof setTimeout> | undefined;
  /** What the tools keep of the conversation that is open, see `CallerState`. */
  #caller = new CallerState();
  #pending: (() => Promise<void>) | undefined;
  /** A pack chosen again that the task starting takes, until an answer comes with it. */
  #taking: { readonly model: string; readonly answers: number } | undefined;

  constructor(options: ChatSessionOptions) {
    this.#options = options;
    this.#chats = options.chats ?? memoryChats();
    this.drafts = new Drafts(options.memory);
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
    // A new conversation this window had open, with words in its input box, is that one again.
    const kept = project && this.#options.memory?.read(openKey(project.key));
    const draft = project && kept ? this.drafts.read(project.key, kept) : "";
    this.#start([], draft ? kept || undefined : undefined, undefined);
    if (project) void this.#loadLatest(project.key, kept || undefined);
  }

  /** The conversations of a project, and the one this window had open, else the newest. */
  async #loadLatest(project: string, kept: string | undefined): Promise<void> {
    try {
      const saved = await this.#chats.list(project);
      if (this.#project?.key !== project) return;
      this.#set({ saved });
      const open = saved.find((each) => each.id === kept);
      const latest =
        open ?? (this.drafts.read(project, this.#snapshot.id ?? "") ? undefined : saved[0]);
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
  #start(
    entries: readonly ChatEntry[],
    id: string | undefined,
    caller: unknown,
    kept: Partial<
      Pick<SavedChat, "title" | "titleBy" | "model" | "reasoning" | "forkedFrom" | "repick">
    > = {},
  ): void {
    this.#stopWatching?.();
    this.#taking = undefined;
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
        this.#took(now);
        this.#saveSoon(chatId, now);
        this.#mark(now);
      }
      // A task that ended has its last answer on the screen: people may leave right after reading
      // it, before a write that waits would come.
      const was = running;
      running = conversation.running;
      if (was && !running) void this.flush();
    });
    this.#set({
      conversation,
      id: chatId,
      hold: undefined,
      title: kept.title ?? "",
      titleBy: kept.titleBy,
      model: kept.model,
      reasoning: readReasoning(kept.reasoning),
      forkedFrom: kept.forkedFrom,
      repick: kept.repick ?? [],
      queued: [],
    });
    const project = this.#project?.key;
    if (project !== undefined) this.#options.memory?.write(openKey(project), chatId);
    this.#mark(entries);
  }

  /** A pack chosen again came with an answer, which the next ones then keep: it is taken. */
  #took(entries: readonly ChatEntry[]): void {
    const taking = this.#taking;
    if (!taking || answersIn(entries) <= taking.answers) return;
    this.#taking = undefined;
    const { repick } = this.#snapshot;
    if (repick.includes(taking.model)) {
      this.#set({ repick: repick.filter((each) => each !== taking.model) });
    }
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
    if (project === undefined || entries.length === 0 || id !== this.#snapshot.id) return;
    const { title: named, titleBy, model, reasoning, forkedFrom, repick } = this.#snapshot;
    const title = titleBy !== undefined && named ? named : firstWords(entries, TITLE_LENGTH);
    const changes = changesIn(entries);
    const caller = this.#caller;
    this.#pending = async () => {
      const chat: SavedChat = {
        id,
        project,
        title,
        updatedAt: Date.now(),
        ...(titleBy !== undefined && named && { titleBy }),
        ...(changes > 0 && { changes }),
        ...(askingIn(entries) && { asking: true as const }),
        entries,
        caller: caller.toJSON(),
        ...(model && { model }),
        ...(reasoning !== undefined && { reasoning }),
        ...(forkedFrom && { forkedFrom }),
        ...(repick.length > 0 && { repick }),
      };
      try {
        await this.#chats.save(chat);
        if (this.#project?.key !== project) return;
        const others = this.#snapshot.saved.filter((saved) => saved.id !== id);
        const {
          entries: _entries,
          caller: _caller,
          model: _model,
          reasoning: _reasoning,
          repick: _repick,
          ...summary
        } = chat;
        this.#set({ saved: [summary, ...others] });
      } catch (error) {
        if (error instanceof ChatNewer) {
          // Another device wrote it meanwhile: theirs is the conversation now, and what this one
          // had is a conversation of its own (see `CloudChats`), which the list shows.
          if (this.#project?.key === project && this.#snapshot.id === id) {
            clearTimeout(this.#saving);
            this.#pending = undefined;
            await this.open(id);
          }
          if (this.#project?.key === project) {
            const saved = await this.#chats.list(project).catch(() => undefined);
            if (saved && this.#project?.key === project) this.#set({ saved });
          }
          this.#options.chatReplaced?.();
          return;
        }
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

  /** What this browser keeps the open project by, which drafts are kept under. */
  get projectKey(): string | undefined {
    return this.#project?.key;
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
    this.#start(entries, id, saved.caller, {
      ...(saved.titleBy !== undefined && { title: saved.title, titleBy: saved.titleBy }),
      ...(isModelRef(saved.model) && { model: saved.model }),
      ...(typeof saved.reasoning === "string" && { reasoning: saved.reasoning }),
      ...(isForkedFrom(saved.forkedFrom) && { forkedFrom: saved.forkedFrom }),
      ...(Array.isArray(saved.repick) && {
        repick: saved.repick.filter((model): model is string => typeof model === "string"),
      }),
    });
  }

  /** Saves what the conversation open is now, such as its model, where it has words to keep. */
  #keep(): void {
    const { conversation, id } = this.#snapshot;
    if (!conversation || id === undefined) return;
    this.#saveSoon(id, conversation.getSnapshot().entries);
  }

  /**
   * The model of the conversation open from its next turn on, which it keeps: other conversations
   * and the settings stay as they are. Nothing takes the default again, until the first message.
   */
  chooseModel(ref: ModelRef | undefined): void {
    this.#set({ model: ref, hold: undefined });
    this.#keep();
  }

  /** How hard the model of the conversation open reasons; nothing leaves it to the settings. */
  chooseReasoning(level: ReasoningLevel | undefined): void {
    this.#set({ reasoning: level });
    this.#keep();
  }

  /** The model the conversation open uses, see `ModelNow`; none where there is no default. */
  modelNow(): ModelNow | undefined {
    const own = this.#snapshot.model;
    const { ai } = this.#options;
    if (own) {
      const service = ai.serviceOf(own.service);
      return {
        ref: own,
        service,
        state: !service ? "gone" : service.enabled.includes(own.model) ? "ok" : "off",
        own: true,
      };
    }
    const chosen = ai.defaultModel();
    return chosen
      ? {
          ref: { service: chosen.service.id, model: chosen.model },
          service: chosen.service,
          state: "ok",
          own: false,
        }
      : undefined;
  }

  /**
   * How hard the model of the conversation open reasons: as the conversation chose, else as set up
   * for the model, else as its pack says (`undefined` here).
   */
  reasoningNow(model: string): ReasoningLevel | undefined {
    return this.#snapshot.reasoning ?? this.#options.ai.getSnapshot().reasoningFor?.[model];
  }

  /** Renames a conversation of the project, which keeps that name: no title comes for it any more. */
  async rename(id: string, title: string): Promise<void> {
    const name = title.trim().slice(0, TITLE_LENGTH * 2);
    const project = this.#project?.key;
    if (!name || project === undefined) return;
    if (id === this.#snapshot.id) {
      this.#set({ title: name, titleBy: "user" });
      this.#keep();
      if (this.#snapshot.conversation?.getSnapshot().entries.length === 0) return;
      return this.flush();
    }
    const saved = await this.#chats.load(project, id).catch(() => undefined);
    if (!saved || this.#project?.key !== project) return;
    const chat: SavedChat = { ...saved, title: name, titleBy: "user" };
    await this.#chats.save(chat).catch((error: unknown) => {
      console.warn("The conversation could not be kept", error);
    });
    this.#set({
      saved: this.#snapshot.saved.map((each) =>
        each.id === id ? { ...each, title: name, titleBy: "user" } : each,
      ),
    });
  }

  /**
   * Finds words in the conversations of the project: what people said, what AI answered, and the
   * titles. Every conversation kept is read, which are at most 50.
   */
  async search(query: string): Promise<readonly Found[]> {
    const project = this.#project?.key;
    if (project === undefined || !query.trim()) return [];
    await this.flush();
    const chats = await Promise.all(
      this.#snapshot.saved.map(async (summary) => {
        const saved = await this.#chats.load(project, summary.id).catch(() => undefined);
        const entries = (saved?.entries ?? [])
          .map(readEntry)
          .filter((entry) => entry !== undefined);
        return { summary, entries };
      }),
    );
    return searchChats(chats, query);
  }

  /**
   * A new conversation with what the one open said before a turn, and the words of that turn in its
   * input box, not sent. It keeps the model; the project stays as it is, with what AI changed after.
   */
  fork(task: string): void {
    const { conversation, id } = this.#snapshot;
    const project = this.#project?.key;
    if (!conversation || this.running || project === undefined || id === undefined) return;
    const entries = conversation.getSnapshot().entries;
    const start = entries.findIndex((entry) => entry.role === "user" && entry.task === task);
    const user = entries[start];
    if (user?.role !== "user") return;
    const turn = entries.slice(0, start + 1).filter((entry) => entry.role === "user").length;
    const title = this.#snapshot.title || firstWords(entries, TITLE_LENGTH);
    const { model, reasoning, repick } = this.#snapshot;
    void this.flush();
    const copy = newChatId();
    this.#start(entries.slice(0, start), copy, undefined, {
      ...(model && { model }),
      ...(reasoning !== undefined && { reasoning }),
      repick,
      forkedFrom: { title, turn },
    });
    this.drafts.write(project, copy, user.text);
    this.#keep();
  }

  /** Queues a message to go once the task that runs is done. */
  queue(text: string): void {
    if (!text.trim()) return;
    this.#set({ queued: [...this.#snapshot.queued, text] });
  }

  /** Takes a queued message back, which then does not go. Says what it was. */
  unqueue(index: number): string | undefined {
    const { queued } = this.#snapshot;
    const text = queued[index];
    if (text === undefined) return undefined;
    this.#set({ queued: queued.filter((_, at) => at !== index) });
    return text;
  }

  /**
   * After a task: the next message queued goes, where the task was done as it should be; after a
   * stop, a failure or the limit it waits for people. The conversation gets a title after its
   * first turn.
   */
  #after(conversation: Conversation, outcome: TaskOutcome | undefined): void {
    if (this.#snapshot.conversation !== conversation || !outcome) return;
    void this.#title(conversation);
    const [next, ...rest] = this.#snapshot.queued;
    if (next === undefined || outcome.end !== "done") return;
    this.#set({ queued: rest });
    void this.send(next);
  }

  /**
   * A short title from the model of the conversation, after its first turn: one small request,
   * where the settings say so and people did not name the conversation. Its first words stay
   * otherwise.
   */
  async #title(conversation: Conversation): Promise<void> {
    const { titleBy, id } = this.#snapshot;
    const entries = conversation.getSnapshot().entries;
    if (titleBy !== undefined || !this.#options.ai.getSnapshot().autoTitle) return;
    if (entries.filter((entry) => entry.role === "user").length !== 1) return;
    const first = entries.find((entry) => entry.role === "user");
    const answered = entries.some((entry) => entry.role === "assistant" && entry.end !== "failed");
    if (first?.role !== "user" || !answered) return;
    const target = await this.#target();
    if (typeof target === "string" || ("fake" in target.endpoint && !this.#options.ask)) return;
    const ask = this.#options.ask ?? askModel;
    const said = await ask(target.endpoint as Endpoint, await target.key(), {
      prompt: titlePrompt(first.text),
      maxTokens: TITLE_TOKENS,
      timeoutMs: TITLE_TIMEOUT_MS,
      maxChars: 200,
    }).catch(() => undefined);
    const title = said?.ok ? cleanTitle(said.text ?? "", TITLE_LENGTH) : undefined;
    // People may have named it, or gone to another, meanwhile.
    if (!title || this.#snapshot.id !== id || this.#snapshot.titleBy !== undefined) return;
    this.#set({ title, titleBy: "auto" });
    this.#keep();
  }

  async remove(id: string): Promise<void> {
    const project = this.#project?.key;
    if (project === undefined) return;
    if (id === this.#snapshot.id) {
      if (this.running) return;
      this.#pending = undefined;
      clearTimeout(this.#saving);
      this.#start([], undefined, undefined);
    }
    this.drafts.clear(project, id);
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
    const { repick, conversation } = this.#snapshot;
    if (from !== "now" || !conversation || repick.includes(model)) return;
    this.#set({ repick: [...repick, model] });
    // Written right away: people may leave right after choosing, and expect it to hold.
    this.#keep();
    void this.flush();
  }

  /** Whether the next answer of the conversation open takes the pack chosen for a model now. */
  repicking(model: string): boolean {
    return this.#snapshot.repick.includes(model);
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
    const repick = this.#snapshot.repick.includes(model);
    // The choice holds until an answer comes with it: that answer then keeps the pack.
    if (repick) this.#taking = { model, answers: answersIn(entries) };
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
    const now = this.modelNow();
    if (!now) return ai.getSnapshot().services.length === 0 ? "noService" : "noModel";
    if (now.state === "gone") return "modelGone";
    if (now.state === "off") return "modelOff";
    const service = now.service as ServiceConfig;
    const { model } = now.ref;
    const endpoint = ai.endpointOf(service, model);
    if (endpoint === undefined) return "noService";
    if (typeof endpoint === "string") return endpoint;
    // Not known yet is worth a try: the relay says so when nobody is signed in.
    if (endpoint.relay && this.#options.account?.getSnapshot().status === "signedOut")
      return "relaySignIn";
    return { endpoint, key: () => ai.keyOf(service.id), model };
  }

  /**
   * Sends a message, which starts a task. Resolves once the task is over. Words that do not go out,
   * or that the service refused before it said anything, go back to the input box.
   */
  async send(text: string): Promise<TaskOutcome | undefined> {
    const conversation = this.#snapshot.conversation;
    if (!conversation || conversation.running || !text.trim()) return undefined;
    const id = this.#snapshot.id;
    const project = this.#project?.key;
    const target = await this.#taskTarget(conversation);
    if (!target) {
      if (project !== undefined && id !== undefined) this.drafts.restore(project, id, text);
      return undefined;
    }
    // The first message settles the model of the conversation: another default later is not it.
    if (!this.#snapshot.model) {
      const now = this.modelNow();
      if (now) this.#set({ model: now.ref });
    }
    const outcome = await conversation.send(text, target);
    if (outcome?.end === "failed" && project !== undefined && id !== undefined) {
      const entries = conversation.getSnapshot().entries;
      const turn = entries.slice(entries.findLastIndex((entry) => entry.role === "user") + 1);
      const silent = turn.every(
        (entry) => entry.role === "assistant" && entry.text === "" && entry.calls.length === 0,
      );
      if (silent) this.drafts.restore(project, id, text);
    }
    this.#after(conversation, outcome);
    return outcome;
  }

  /**
   * The last turn once more, as a new turn with the same words. What it changed stays, unless
   * people took it back first (`undoTask`).
   */
  async resend(): Promise<TaskOutcome | undefined> {
    const last = this.#snapshot.conversation
      ?.getSnapshot()
      .entries.findLast((entry) => entry.role === "user");
    return last?.role === "user" ? this.send(last.text) : undefined;
  }

  /**
   * Tries the last task of the conversation again after it failed, as the same task: what it
   * changed so far stays, and the task goes on from there. See `Conversation.retry`.
   */
  async retry(): Promise<TaskOutcome | undefined> {
    const conversation = this.#snapshot.conversation;
    if (!conversation || conversation.running || !conversation.failedTask()) return undefined;
    const target = await this.#taskTarget(conversation);
    if (!target) return undefined;
    const outcome = await conversation.retry(target);
    this.#after(conversation, outcome);
    return outcome;
  }

  /** Where the next task of a conversation goes, and what goes with it; or why it cannot go. */
  async #taskTarget(conversation: Conversation): Promise<TaskTarget | undefined> {
    const caller = this.#caller;
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
    const { maxToolCalls } = this.#options.ai.getSnapshot();
    const reasoning = this.reasoningNow(target.model);
    // Another conversation may have opened meanwhile: this one is no longer on the screen.
    if (this.#snapshot.conversation !== conversation) return undefined;
    const { use, note } = this.#packFor(target.model, conversation.getSnapshot().entries);
    return {
      endpoint: target.endpoint,
      key: target.key,
      maxToolCalls,
      system: browserSystemPrompt(use.texts),
      tools: (task) => this.#toolsOf(task, caller, use),
      // How hard the model reasons: as people set it for the model, else as its pack says.
      call: reasoning === undefined ? use.call : { ...use.call, reasoning },
      stamp: { toolset: TOOLSET_VERSION, texts: use.used, pack: note },
    };
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

const REASONING_LEVELS: ReadonlySet<string> = new Set(REASONING);

/** How many answers of the model a conversation has. */
const answersIn = (entries: readonly ChatEntry[]): number =>
  entries.reduce((count, entry) => count + (entry.role === "assistant" ? 1 : 0), 0);

/** A step of reasoning as kept, where it is one. */
function readReasoning(value: unknown): ReasoningLevel | undefined {
  return typeof value === "string" && REASONING_LEVELS.has(value)
    ? (value as ReasoningLevel)
    : undefined;
}

function isModelRef(value: unknown): value is ModelRef {
  const ref = value as Partial<ModelRef> | undefined;
  return typeof ref?.service === "string" && typeof ref.model === "string";
}

function isForkedFrom(value: unknown): value is ForkedFrom {
  const from = value as Partial<ForkedFrom> | undefined;
  return typeof from?.title === "string" && typeof from.turn === "number";
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
