import {
  Conversation,
  askModel,
  browserSystemPrompt,
  entriesToKeep,
  readEntries,
  readEntry,
  summaryInForce,
  toolSpecsOf,
  type ChatEntry,
  type Endpoint,
  type FakeEndpoint,
  type ModelRef,
  type PackNote,
  type ReasoningLevel,
  type RoomMade,
  type AttachedImage,
  type ServiceConfig,
  type SmallAsk,
  type TaskOutcome,
  type TaskTarget,
  type UserEntry,
} from "@animaquill/agent";
import {
  aiTask,
  type ClipDescription,
  type ClipState,
  type CommandFailure,
  type ProblemSet,
  type ProjectState,
  type ProjectStore,
  type ManyUndoResult,
  type StaticInputs,
  type UndoResult,
} from "@animaquill/core";
import {
  Approvals,
  CallerState,
  DEFAULT_PACK,
  REASONING,
  TOOLSET_VERSION,
  builtinPacks,
  choosePack,
  createToolset,
  usePack,
  type ListenAnswer,
  type ListenRequest,
  type LookAnswer,
  type LookRequest,
  type ModelPack,
  type PackUse,
  type Approval,
  type ApproveRequest,
  type SelectionFacts,
  type ToolHost,
} from "@animaquill/tools";
import {
  ChatNewer,
  memoryChats,
  type AccountAccess,
  type ChatImageStore,
  type ChatStore,
  type SavedChat,
  type SavedChatSummary,
  type WindowMemory,
} from "@animaquill/host";
import { Emitter } from "../workbench/emitter.ts";
import {
  planKey,
  type ManyTakeBack,
  type UndoState,
  type UndoWhyNot,
} from "../workbench/undo-keeper.ts";
import {
  askingIn,
  changesIn,
  cleanTitle,
  firstWords,
  searchChats,
  type Found,
} from "./conversations.ts";
import { ChatAttachments, type FrameShot } from "./attachments.ts";
import { Drafts } from "./drafts.ts";
import { PlanDrafts } from "./plan.ts";
import { plainOf } from "./refs.ts";
import { DEFAULT_IMAGE_BYTES, DEFAULT_SHOT_SIZE, type ShotSize } from "./shots.ts";
import type { ModelPacks } from "./packs.ts";
import type { AiSettingsStore } from "./settings.ts";
import { clipsOf, placesOf, summaryOf, type TurnSummary } from "./summary.ts";
import { groupsOf } from "./turns.ts";

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
  | "modelOff"
  /** The message has pictures, and the model of the conversation takes none. */
  | "noPictures";

/** What a message keeps of the editor where nothing shows: no timeline, nothing selected. */
const NOTHING_SHOWN: SelectionFacts = { timeline: undefined, playhead: undefined, clips: [] };

/**
 * What a message keeps of the editor where people took "带上" off for it: nothing, and that they
 * did not share it, which is what AI is told (`aq_selection_read`).
 */
export const WITHHELD: SelectionFacts = { ...NOTHING_SHOWN, hidden: true };

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

/**
 * The chat of a window, as its parts read it. Several conversations of the open project can run at
 * once (docs/design/ai-teamwork.md of AnimaQuill Cloud, 1): the fields that are of one conversation
 * are of the one the chat shows (`id`), and `runs` says how each of those the window has stands.
 */
export interface ChatSnapshot {
  /** The conversation shown, which is new until somebody writes in it. */
  readonly conversation: Conversation | undefined;
  readonly id: string | undefined;
  /** Earlier conversations of the open project, newest first. */
  readonly saved: readonly SavedChatSummary[];
  /** Why the last message of the conversation shown did not go out. */
  readonly hold: ChatHold | undefined;
  /** Changes to the project went back or came again, which the buttons of tasks show. */
  readonly undoTick: number;
  /** The clips the last task of the conversation shown changed or made. */
  readonly marked: ReadonlySet<string>;
  /**
   * The clips the last task of each conversation of the window changed or made, which the timeline
   * marks until its next one: by clip, the conversation that changed it last.
   */
  readonly marks: ReadonlyMap<string, string>;
  /** What the conversation shown is called, and who named it; empty until it has words. */
  readonly title: string;
  readonly titleBy: "auto" | "user" | undefined;
  /** The model the conversation shown chose; none takes the default. */
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
  readonly queued: readonly Queued[];
  /**
   * The switch "先出方案" of the conversation shown: its next message asks for a plan first, see
   * `UserEntry.plan`. Each conversation has its own; a new one starts without.
   */
  readonly planFirst: boolean;
  /**
   * Changes AI wants to make in the conversation shown that wait for people to allow them ("AI
   * 改项目前先问我", S-D4), oldest first: the first of a task is the card under it. Never kept: after
   * a reload the task stopped.
   */
  readonly approvals: readonly PendingApproval[];
  /** Those of every conversation of the window, oldest first. */
  readonly allApprovals: readonly PendingApproval[];
  /**
   * The conversation shown went on here, in a copy, as another device wrote the one it was while
   * it ran: that one is theirs now. Only for as long as the window has it.
   */
  readonly splitFrom: SplitFrom | undefined;
  /** The conversations the window has, as the list of conversations and the status bar show them. */
  readonly runs: readonly RunSummary[];
}

/** The conversation another device wrote while this one ran, see `ChatSnapshot.splitFrom`. */
export interface SplitFrom {
  readonly id: string;
  readonly title: string;
}

/** How a conversation the window has stands, see `ChatSnapshot.runs`. */
export interface RunSummary {
  readonly id: string;
  /** As people named it, or its first words; empty for one without words. */
  readonly title: string;
  /**
   * A task runs; it waits for people (a change to allow, a question of AI, a plan); or neither.
   * A task that waits for a change to be allowed waits.
   */
  readonly state: "running" | "waiting" | "idle";
  /** It ended a task, or asked, while it was not shown: people have not seen that yet. */
  readonly unseen: boolean;
  /** When the task that runs started. */
  readonly startedAt?: number;
}

/** A change that waits for people to allow it, see `ChatSnapshot.approvals`. */
export interface PendingApproval {
  readonly id: string;
  /** The task that wants to make it. */
  readonly task: string;
  /** The conversation of that task. */
  readonly chat: string;
  readonly request: ApproveRequest;
}

/** What people answer to a change that waits for them. */
export type ApprovalAnswer = Exclude<Approval, "stopped">;

/** A message that waits for the task that runs, with its pictures. */
export interface Queued {
  readonly text: string;
  readonly images?: readonly AttachedImage[];
  /** What the editor showed as people sent it, which goes with it: not what it shows once it goes. */
  readonly selection?: SelectionFacts;
  /** It asks for a plan first, as the switch was when people sent it. */
  readonly plan?: true;
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
  /**
   * Takes back all of a task or does it again, one window at a time, and says what came of it, see
   * `UndoKeeper`. Without it the store does it right away, and `undone` says what came of it.
   */
  readonly takeBack?: (task: string, direction: "undo" | "redo") => Promise<unknown>;
  /**
   * Takes back several tasks at once, or does them again, one window at a time, see
   * `UndoKeeper.takeBackMany`. Without it the store does it right away.
   */
  readonly takeBackMany?: (
    tasks: readonly string[],
    direction: "undo" | "redo",
    expected?: string,
  ) => Promise<ManyTakeBack | undefined>;
  /** Whether a task can be taken back here, and why not, see `UndoKeeper.stateOf`. */
  readonly undoStateOf?: (task: string) => UndoState;
  /** For tests: a service that answers from a script, instead of the one people chose. */
  readonly fake?: () => FakeEndpoint | undefined;
  /**
   * Who changes the project as an origin of AI that is no conversation of the chat, such as an AI
   * tool on this computer: what the tools tell AI of what others changed names it.
   */
  readonly whoIs?: ToolHost["whoIs"];
  /** The memory of this window, where drafts and the conversation open are kept. */
  readonly memory?: WindowMemory;
  /** Where the pictures of conversations are kept; without it, for as long as the page. */
  readonly images?: ChatImageStore | undefined;
  /** Renders the frame at the playhead, as the export does, to go with a message. */
  readonly shoot?: (signal: AbortSignal) => Promise<FrameShot | undefined>;
  /** How large a frame goes at most, as set (see `ShotSize`). */
  readonly shotSize?: () => ShotSize;
  /**
   * Renders frames for AI, as `aq_render_frames` asks (see `FrameLooks`): with whether its model
   * sees the pictures, and what stops the task.
   */
  readonly look?: (request: LookRequest, sees: boolean, signal: AbortSignal) => Promise<LookAnswer>;
  /** Mixes and measures the sound for AI, as `aq_audio_analyze` asks (see `SoundListens`). */
  readonly listen?: (request: ListenRequest, signal: AbortSignal) => Promise<ListenAnswer>;
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
/** How many tasks keep the project as they started it, for AI to compare with. */
const KEPT_STARTS = 10;
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

/** How many conversations that have nothing going on a window keeps besides the one shown. */
export const KEPT_IDLE = 8;

/** What a conversation of the window keeps besides what was said, as the snapshot shows it. */
interface RunFields {
  readonly title: string;
  readonly titleBy: "auto" | "user" | undefined;
  readonly model: ModelRef | undefined;
  readonly reasoning: ReasoningLevel | undefined;
  readonly forkedFrom: ForkedFrom | undefined;
  readonly repick: readonly string[];
  readonly queued: readonly Queued[];
  readonly planFirst: boolean;
  readonly hold: ChatHold | undefined;
  readonly marked: ReadonlySet<string>;
  readonly splitFrom: SplitFrom | undefined;
}

/**
 * One conversation the window has, which runs on its own whether it is shown or not: what was
 * said, what its tools read, what it waits to write, what is queued in it.
 */
interface Run {
  /** Its id; another one once it went on in a copy of its own, see `#split`. */
  id: string;
  /** The project it is of, as this browser keeps it: what it is written under, whatever opens later. */
  readonly project: string | undefined;
  readonly conversation: Conversation;
  /** What the tools keep of it, see `CallerState`. */
  readonly caller: CallerState;
  fields: RunFields;
  /** A pack chosen again that the task starting takes, until an answer comes with it. */
  taking: { readonly model: string; readonly answers: number } | undefined;
  /** The write that waits, and the timer it waits for; the write on its way. */
  pending: (() => Promise<void>) | undefined;
  saving: ReturnType<typeof setTimeout> | undefined;
  writing: Promise<void> | undefined;
  /** Its last task, once people took back what it did: its clips are no longer marked. */
  unmarked: string | undefined;
  unseen: boolean;
  /** It was deleted: nothing of it is written any more. */
  gone: boolean;
  /** A task of it is about to start: where it goes is being worked out. */
  starting: number;
  /** The last write of it failed: what it has here is newer than what is kept. */
  unsaved: boolean;
  /** When it was last shown, or last ran: the one longest ago goes first, see `KEPT_IDLE`. */
  used: number;
  readonly unwatch: () => void;
}

const NO_FIELDS: RunFields = {
  title: "",
  titleBy: undefined,
  model: undefined,
  reasoning: undefined,
  forkedFrom: undefined,
  repick: [],
  queued: [],
  planFirst: false,
  hold: undefined,
  marked: new Set(),
  splitFrom: undefined,
};

/**
 * The chat of a window: the conversations of the open project, the services they go to, and what
 * their tasks did to the project. Several can run at once, each on its own (docs/design/
 * ai-teamwork.md of AnimaQuill Cloud, 1): showing another only changes which one the chat shows.
 * Conversations are kept by project, in this browser or with the account.
 */
export class ChatSession {
  readonly #options: ChatSessionOptions;
  readonly #chats: ChatStore;
  readonly #emitter = new Emitter();
  #snapshot: ChatSnapshot = {
    conversation: undefined,
    id: undefined,
    saved: [],
    undoTick: 0,
    marks: new Map(),
    ...NO_FIELDS,
    approvals: [],
    allApprovals: [],
    runs: [],
  };
  /** What people wrote and did not send yet, by conversation. */
  readonly drafts: Drafts;
  /** The pictures of those drafts. */
  readonly attachments: ChatAttachments;
  /** Plans as people changed them, see `PlanDrafts`. */
  readonly planDrafts: PlanDrafts;
  #project: { readonly store: ProjectStore; readonly key: string } | undefined;
  /** The conversations of the window, in the order they came, and the one shown. */
  readonly #runs = new Map<string, Run>();
  #shown: Run | undefined;
  /** The project as each of the latest tasks started, for AI to compare with (`taskStart`). */
  readonly #started = new Map<string, ProjectState>();
  /** What people allowed in each run of a task, by what stops the run: only for as long as it. */
  readonly #allowed = new WeakMap<AbortSignal, Approvals>();
  /** How each change that waits for people is answered, by its id. */
  readonly #answers = new Map<string, (answer: Approval) => void>();
  #approvals: readonly PendingApproval[] = [];
  #askedCount = 0;
  #clock = 0;

  constructor(options: ChatSessionOptions) {
    this.#options = options;
    this.#chats = options.chats ?? memoryChats();
    this.drafts = new Drafts(options.memory);
    this.planDrafts = new PlanDrafts(options.memory);
    this.attachments = new ChatAttachments({
      memory: options.memory,
      images: options.images,
      ...(options.shoot && { shoot: options.shoot }),
      side: () => {
        const size = options.shotSize?.() ?? DEFAULT_SHOT_SIZE;
        return size === "original" ? undefined : size;
      },
      maxBytes: () => this.imageBytes(),
    });
    options.subscribeProject(() => this.#follow());
    this.#follow();
  }

  subscribe = this.#emitter.subscribe;
  getSnapshot = (): ChatSnapshot => this.#snapshot;

  #set(changes: Partial<ChatSnapshot>): void {
    this.#snapshot = { ...this.#snapshot, ...changes };
    this.#emitter.emit();
  }

  /** A conversation of the window, by its id; the one shown without one. */
  #runOf(chat?: string): Run | undefined {
    return chat === undefined ? this.#shown : this.#runs.get(chat);
  }

  /** The conversation of the window a task is of; the one shown where none of them has it. */
  #runOfTask(task: string): Run | undefined {
    for (const run of this.#runs.values()) {
      if (run.conversation.tasks.includes(task)) return run;
    }
    return this.#shown;
  }

  /** Changes what a conversation keeps; the snapshot follows where it is the one shown. */
  #update(run: Run, changes: Partial<RunFields>): void {
    run.fields = { ...run.fields, ...changes };
    if (run === this.#shown) this.#snapshot = { ...this.#snapshot, ...changes };
    this.#snapshot = { ...this.#snapshot, ...this.#overview() };
    this.#emitter.emit();
  }

  /** Whether a conversation has anything going on: a task, a change to allow, a queued message. */
  #busy(run: Run): boolean {
    return (
      run.conversation.running ||
      run.starting > 0 ||
      run.fields.queued.length > 0 ||
      this.#approvals.some((each) => each.chat === run.id)
    );
  }

  /**
   * What the snapshot says of all conversations of the window: how each stands, what they marked,
   * what waits for people. The same objects where nothing changed, so that nothing renders again.
   */
  #overview(): Pick<ChatSnapshot, "runs" | "marks" | "approvals" | "allApprovals"> {
    const runs: RunSummary[] = [];
    for (const run of this.#runs.values()) {
      const talk = run.conversation.getSnapshot();
      const waits =
        this.#approvals.some((each) => each.chat === run.id) ||
        (!talk.running && askingIn(talk.entries));
      const state = waits ? "waiting" : talk.running ? "running" : "idle";
      const title =
        run.fields.titleBy !== undefined && run.fields.title
          ? run.fields.title
          : firstWords(talk.entries, TITLE_LENGTH);
      runs.push({
        id: run.id,
        title,
        state,
        unseen: run.unseen,
        ...(talk.running && { startedAt: talk.running.startedAt }),
      });
    }
    const before = this.#snapshot;
    const sameRuns =
      runs.length === before.runs.length &&
      runs.every((run, at) => {
        const was = before.runs[at];
        return (
          was !== undefined &&
          was.id === run.id &&
          was.title === run.title &&
          was.state === run.state &&
          was.unseen === run.unseen &&
          was.startedAt === run.startedAt
        );
      });
    const marks = new Map<string, string>();
    for (const run of [...this.#runs.values()].toSorted((a, b) => a.used - b.used)) {
      for (const clip of run.fields.marked) marks.set(clip, run.id);
    }
    const sameMarks =
      marks.size === before.marks.size &&
      [...marks].every(([clip, chat]) => before.marks.get(clip) === chat);
    const shown = this.#shown?.id;
    const approvals = this.#approvals.filter((each) => each.chat === shown);
    const sameApprovals =
      approvals.length === before.approvals.length &&
      approvals.every((each, at) => each === before.approvals[at]);
    return {
      runs: sameRuns ? before.runs : runs,
      marks: sameMarks ? before.marks : marks,
      approvals: sameApprovals ? before.approvals : approvals,
      allApprovals: this.#approvals,
    };
  }

  /** Says again how the conversations stand, where that changed. */
  #refresh(): void {
    const overview = this.#overview();
    const before = this.#snapshot;
    if (
      overview.runs === before.runs &&
      overview.marks === before.marks &&
      overview.approvals === before.approvals &&
      overview.allApprovals === before.allApprovals
    )
      return;
    this.#set(overview);
  }

  /** Another project came: its own conversations, and the tasks of the one before stop. */
  #follow(): void {
    const project = this.#options.project();
    if (project?.store === this.#project?.store && project?.key === this.#project?.key) return;
    // Deleting from a map while going through it is safe: each one comes once.
    for (const run of this.#runs.values()) this.#retire(run);
    this.#shown = undefined;
    this.#project = project;
    // A new conversation this window had open, with words in its input box, is that one again.
    const kept = project && this.#options.memory?.read(openKey(project.key));
    const draft = project && kept ? this.drafts.read(project.key, kept) : "";
    this.#start([], draft ? kept || undefined : undefined, undefined);
    if (project) void this.#loadLatest(project.key, kept || undefined);
  }

  /**
   * A conversation the window lets go of: its task stops, and what it waits to write is written,
   * once the task is over, under the project it is of.
   */
  #retire(run: Run): void {
    this.#runs.delete(run.id);
    run.conversation.stop();
    const done = () => {
      run.unwatch();
      void this.#flushRun(run);
    };
    if (!run.conversation.running) {
      done();
      return;
    }
    const stop = run.conversation.subscribe(() => {
      if (run.conversation.running) return;
      stop();
      done();
    });
  }

  /**
   * Reads the conversations of the project again, as where they are kept changed: they go with the
   * account from now on, say. An empty conversation shows the newest of them.
   */
  reloadList(): Promise<void> {
    const project = this.#project;
    return project ? this.#loadLatest(project.key, this.#snapshot.id) : Promise.resolve();
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
   * A conversation, from what was kept of it if anything, which the chat shows from now on: what
   * AI read in it still counts, as far as the project is the one it read (a reopened project has
   * new revisions, see `CallerState`). The one shown before goes on where it has words.
   */
  #start(
    entries: readonly ChatEntry[],
    id: string | undefined,
    caller: unknown,
    kept: Partial<
      Pick<
        SavedChat,
        "title" | "titleBy" | "model" | "reasoning" | "forkedFrom" | "repick" | "planFirst"
      >
    > = {},
  ): Run {
    const tools = caller === undefined ? new CallerState() : CallerState.from(caller);
    const conversation = new Conversation({
      entries,
      // Each answer of the model is one: a change that fails holds back the rest of it.
      onAnswer: () => tools.beginAnswer(),
    });
    const chatId = id ?? newChatId();
    let known = conversation.getSnapshot().entries;
    let running = conversation.running;
    // Set once the run is made, which the listener only needs after.
    let made: Run | undefined;
    const unwatch = conversation.subscribe(() => {
      const run = made;
      if (!run) return;
      const now = conversation.getSnapshot().entries;
      const was = running;
      running = conversation.running;
      if (now !== known) {
        known = now;
        this.#took(run, now);
        this.#saveSoon(run);
        this.#mark(run, now);
      }
      if (running) run.used = ++this.#clock;
      // A task that ended has its last answer on the screen: people may leave right after reading
      // it, before a write that waits would come. Where it is not shown, people did not see it.
      if (was && !running) {
        void this.#flushRun(run);
        if (run !== this.#shown && this.#runs.get(run.id) === run) run.unseen = true;
      }
      if (this.#runs.get(run.id) === run) this.#refresh();
    });
    const old = this.#runs.get(chatId);
    if (old) this.#retire(old);
    const run: Run = {
      id: chatId,
      project: this.#project?.key,
      conversation,
      caller: tools,
      fields: {
        ...NO_FIELDS,
        title: kept.title ?? "",
        titleBy: kept.titleBy,
        model: kept.model,
        reasoning: readReasoning(kept.reasoning),
        forkedFrom: kept.forkedFrom,
        repick: kept.repick ?? [],
        planFirst: kept.planFirst === true,
      },
      taking: undefined,
      pending: undefined,
      saving: undefined,
      writing: undefined,
      unmarked: undefined,
      unseen: false,
      gone: false,
      starting: 0,
      unsaved: false,
      used: ++this.#clock,
      unwatch,
    };
    made = run;
    this.#runs.set(chatId, run);
    this.#mark(run, entries, false);
    this.#show(run);
    return run;
  }

  /**
   * Shows a conversation of the window. The one shown before stays where it has anything going on
   * or words to keep; the window keeps at most `KEPT_IDLE` with nothing going on besides.
   */
  #show(run: Run): void {
    const before = this.#shown;
    this.#shown = run;
    run.unseen = false;
    run.used = ++this.#clock;
    if (
      before &&
      before !== run &&
      this.#runs.get(before.id) === before &&
      !this.#busy(before) &&
      before.conversation.getSnapshot().entries.length === 0
    ) {
      this.#runs.delete(before.id);
      before.unwatch();
    }
    const idle = [...this.#runs.values()]
      .filter((each) => each !== run && !this.#busy(each) && !each.unseen)
      .toSorted((a, b) => a.used - b.used);
    for (const each of idle.slice(0, Math.max(0, idle.length - KEPT_IDLE))) this.#retire(each);
    this.#snapshot = {
      ...this.#snapshot,
      ...run.fields,
      conversation: run.conversation,
      id: run.id,
    };
    this.#snapshot = { ...this.#snapshot, ...this.#overview() };
    this.#emitter.emit();
    const project = this.#project?.key;
    if (project !== undefined) this.#options.memory?.write(openKey(project), run.id);
  }

  /** A pack chosen again came with an answer, which the next ones then keep: it is taken. */
  #took(run: Run, entries: readonly ChatEntry[]): void {
    const taking = run.taking;
    if (!taking || answersIn(entries) <= taking.answers) return;
    run.taking = undefined;
    const { repick } = run.fields;
    if (repick.includes(taking.model)) {
      this.#update(run, { repick: repick.filter((each) => each !== taking.model) });
    }
  }

  /** Marks the clips of the last task of a conversation, the one that runs or ran last. */
  #mark(run: Run, entries: readonly ChatEntry[], tell = true): void {
    const start = entries.findLastIndex((entry) => entry.role === "user");
    const last = entries[start];
    const task = last?.role === "user" ? last.task : undefined;
    const marked =
      task === undefined || task === run.unmarked
        ? new Set<string>()
        : clipsOf(summaryOf(entries.slice(start)));
    const before = run.fields.marked;
    if (marked.size === before.size && [...marked].every((clip) => before.has(clip))) return;
    if (tell) this.#update(run, { marked });
    else run.fields = { ...run.fields, marked };
  }

  /** The task of a conversation whose changes the timeline marks, or would. */
  #lastTask(run: Run | undefined): string | undefined {
    return run?.conversation.tasks.at(-1);
  }

  /**
   * What the editor shows now, to keep with a message sent now: nothing selected where it shows no
   * timeline, so that the message still says it has a record.
   */
  #shownFacts(): SelectionFacts {
    return this.#options.selection() ?? NOTHING_SHOWN;
  }

  /** What a message sent now would keep of the editor, see `#shownFacts`: for the chat to show it. */
  shownNow(): SelectionFacts {
    return this.#shownFacts();
  }

  /** The tools of one task, on the project that was open when it started, and only that one. */
  #toolsOf(task: string, run: Run, use: PackUse, signal: AbortSignal) {
    const project = this.#project;
    const { conversation, caller } = run;
    const { selection, problems, describe, problemInputs, ranNow, look, listen } = this.#options;
    // A task tried again goes on from where it was: it started where it started the first time.
    if (project && !this.#started.has(task)) {
      this.#started.set(task, project.store.getState());
      for (const old of this.#started.keys()) {
        if (this.#started.size <= KEPT_STARTS) break;
        this.#started.delete(old);
      }
    }
    const settings = this.#options.ai;
    const ask = (request: ApproveRequest) => this.#ask(run, task, request, signal);
    let approvals = this.#allowed.get(signal);
    if (!approvals) {
      approvals = new Approvals();
      this.#allowed.set(signal, approvals);
    }
    const sees = () => this.#seesPictures(run) !== false;
    const tools = createToolset(
      {
        store: () =>
          project && this.#options.project()?.store === project.store ? project.store : undefined,
        origin: () => aiTask(task),
        stopped: () => signal.aborted,
        // As the settings say at each call: turned on or off, from the next change on.
        get approve() {
          return settings.getSnapshot().askBeforeEdit === true ? ask : undefined;
        },
        // As the message the task started with asked, not as the switch is now.
        planFirst: () =>
          conversation
            .getSnapshot()
            .entries.some((entry) => entry.role === "user" && entry.task === task && entry.plan),
        selection,
        // What the editor showed as each message of the conversation was sent, for "sent".
        sent: () =>
          conversation
            .getSnapshot()
            .entries.flatMap((entry) =>
              entry.role === "user"
                ? [{ text: entry.text, ...(entry.selection && { selection: entry.selection }) }]
                : [],
            ),
        problems,
        ...(describe && { describe }),
        ...(problemInputs && { problemInputs }),
        ...(ranNow && { ranNow }),
        ...(look && {
          look: (request: LookRequest) => look(request, sees(), signal),
        }),
        taskStart: () => this.#started.get(task),
        ...(listen && { listen: (request: ListenRequest) => listen(request, signal) }),
        // Another conversation of the window by its name, or an AI tool on this computer.
        whoIs: (origin) => {
          const chat = origin.startsWith("ai:") ? this.chatOfTask(origin.slice(3)) : undefined;
          if (chat) return chat.id === run.id ? undefined : { id: chat.id, name: chat.title };
          return this.#options.whoIs?.(origin);
        },
      },
      caller,
      use.texts,
      { results: use.results, approvals },
    );
    return toolSpecsOf(tools);
  }

  /**
   * Shows a change AI wants to make to people, and waits for their answer: "stopped" once the task
   * stops meanwhile, whatever they click after, and right away for a task that stopped already.
   */
  #ask(run: Run, task: string, request: ApproveRequest, signal: AbortSignal): Promise<Approval> {
    if (signal.aborted) return Promise.resolve("stopped");
    this.#askedCount += 1;
    const id = `${task}#${this.#askedCount}`;
    return new Promise((resolve) => {
      const done = (answer: Approval) => {
        if (!this.#answers.has(id)) return;
        this.#answers.delete(id);
        signal.removeEventListener("abort", stop);
        this.#approvals = this.#approvals.filter((each) => each.id !== id);
        this.#refresh();
        resolve(signal.aborted ? "stopped" : answer);
      };
      const stop = () => done("stopped");
      signal.addEventListener("abort", stop, { once: true });
      this.#answers.set(id, done);
      this.#approvals = [...this.#approvals, { id, task, chat: run.id, request }];
      if (run !== this.#shown) run.unseen = true;
      this.#refresh();
    });
  }

  /** People's answer to a change that waits for them, of any conversation, by its id. */
  answerApproval(id: string, answer: ApprovalAnswer): void {
    this.#answers.get(id)?.(answer);
  }

  /**
   * "不允许，并告诉 AI 怎么改": what people wrote while a change of the conversation shown waits for
   * them does not allow the one they see (the first that waits) and goes to AI with it, which reads
   * it in the result of that call and goes on with the task. Only the words: a block of the editor
   * as what it says, pictures stay where they are. Whether there was a change to answer.
   */
  declineWith(text: string): boolean {
    const words = plainOf(text).trim();
    const [first] = this.#snapshot.approvals;
    if (!first || words === "") return false;
    this.answerApproval(first.id, { no: words });
    return true;
  }

  /** Writes a conversation soon: right away once its task is over, see `flush`. */
  #saveSoon(run: Run): void {
    const { project, id } = run;
    const entries = run.conversation.getSnapshot().entries;
    if (project === undefined || entries.length === 0 || run.gone) return;
    const { title: named, titleBy, model, reasoning, forkedFrom, repick, planFirst } = run.fields;
    const title = titleBy !== undefined && named ? named : firstWords(entries, TITLE_LENGTH);
    const changes = changesIn(entries);
    // What the list of all conversations says it had: the model as people call it.
    const now = this.#modelOf(run);
    const modelName =
      now && (this.#options.ai.modelOf(now.ref.service, now.ref.model)?.name ?? now.ref.model);
    const caller = run.caller;
    run.pending = async () => {
      const chat: SavedChat = {
        id,
        project,
        title,
        updatedAt: Date.now(),
        ...(titleBy !== undefined && named && { titleBy }),
        ...(changes > 0 && { changes }),
        ...(askingIn(entries) && { asking: true as const }),
        entries: entriesToKeep(entries),
        caller: caller.toJSON(),
        ...(model && { model }),
        ...(reasoning !== undefined && { reasoning }),
        ...(forkedFrom && { forkedFrom }),
        ...(modelName && { modelName }),
        ...(repick.length > 0 && { repick }),
        ...(planFirst && { planFirst: true as const }),
      };
      try {
        await this.#chats.save(chat);
        run.unsaved = false;
        if (this.#project?.key !== project) return;
        const others = this.#snapshot.saved.filter((saved) => saved.id !== id);
        const {
          entries: _entries,
          caller: _caller,
          model: _model,
          reasoning: _reasoning,
          repick: _repick,
          planFirst: _planFirst,
          ...summary
        } = chat;
        this.#set({ saved: [summary, ...others] });
      } catch (error) {
        if (error instanceof ChatNewer) {
          // Another device wrote it meanwhile: theirs is the conversation now. What this page had
          // went into a copy (see `AccountChats`), and whatever this page writes of it from now on
          // goes there, never over theirs: also the last write of one the window let go of, or one
          // being deleted. Nothing here waits for that, as it runs where the writes of this
          // conversation wait.
          const hosted = this.#runs.get(id) === run;
          clearTimeout(run.saving);
          run.pending = undefined;
          if (error.copy) {
            this.#split(run, error.copy, hosted);
            if (!hosted) void this.#flushRun(run);
            else if (!this.#busy(run)) {
              // Nothing goes on in it: the chat shows theirs, and the copy is in the list.
              if (run === this.#shown) void this.#showTheirs(run, id);
              else this.#retire(run);
            }
          } else if (hosted) {
            // What this page had says what theirs says: it goes on as it is.
            if (this.#busy(run)) this.#saveSoon(run);
            else if (run === this.#shown) void this.open(id, true);
            else this.#retire(run);
          }
          if (this.#project?.key === project) {
            const saved = await this.#chats.list(project).catch(() => undefined);
            if (saved && this.#project?.key === project) this.#set({ saved });
          }
          this.#options.chatReplaced?.();
          return;
        }
        run.unsaved = true;
        console.warn("The conversation could not be kept", error);
      }
    };
    clearTimeout(run.saving);
    run.saving = setTimeout(() => void this.#flushRun(run), SAVE_DELAY_MS);
  }

  /**
   * A conversation another device wrote while something went on here goes on as the copy that
   * what this page had of it went into: its id, its name, the change that waits for people, its
   * draft; and it is written there from now on, all of it. The id it had is the other device's
   * conversation now, which opens as they left it.
   */
  #split(run: Run, copy: { readonly id: string; readonly title: string }, hosted: boolean): void {
    const from = run.id;
    const entries = run.conversation.getSnapshot().entries;
    const title =
      run.fields.titleBy !== undefined && run.fields.title
        ? run.fields.title
        : firstWords(entries, TITLE_LENGTH);
    run.id = copy.id;
    if (hosted) {
      this.#runs.delete(from);
      this.#runs.set(copy.id, run);
    }
    this.#approvals = this.#approvals.map((each) =>
      each.chat === from ? { ...each, chat: copy.id } : each,
    );
    const { project } = run;
    if (project !== undefined) {
      const draft = this.drafts.read(project, from);
      if (draft) this.drafts.write(project, copy.id, draft);
      this.drafts.clear(project, from);
      // Plans as people changed them, for "按这个做" there.
      for (const entry of entries) {
        if (entry.role !== "tool" || entry.name !== "aq_propose") continue;
        const steps = this.planDrafts.read(project, from, entry.call);
        if (steps === undefined) continue;
        this.planDrafts.write(project, copy.id, entry.call, steps);
        this.planDrafts.write(project, from, entry.call, undefined);
      }
    }
    if (run === this.#shown) {
      this.#snapshot = { ...this.#snapshot, id: copy.id };
      if (project !== undefined) this.#options.memory?.write(openKey(project), copy.id);
    }
    this.#update(run, {
      title: copy.title,
      titleBy: "user",
      splitFrom: { id: from, title },
    });
    this.#saveSoon(run);
  }

  /**
   * Shows what another device wrote of a conversation, in place of the copy this page's went on
   * as, where that copy is still shown and nothing went on in it meanwhile: people who started to
   * write in it stay there, and "打开那边的版本" shows theirs.
   */
  async #showTheirs(run: Run, id: string): Promise<void> {
    const project = this.#project?.key;
    if (project === undefined) return;
    const saved = await this.#chats.load(project, id).catch(() => undefined);
    if (!saved || this.#project?.key !== project || this.#runs.has(id)) return;
    if (this.#shown !== run || this.#busy(run)) return;
    this.#startSaved(id, saved);
  }

  /** Writes what a conversation waits to write, after what is on its way. */
  async #flushRun(run: Run): Promise<void> {
    clearTimeout(run.saving);
    const pending = run.pending;
    run.pending = undefined;
    const before = run.writing;
    if (!pending) {
      await before;
      return;
    }
    const writing = (async () => {
      await before?.catch(() => {});
      await pending();
    })();
    run.writing = writing;
    try {
      await writing;
    } finally {
      if (run.writing === writing) run.writing = undefined;
    }
  }

  /** Writes what any conversation of the window waits to write. */
  async flush(): Promise<void> {
    await Promise.all([...this.#runs.values()].map((run) => this.#flushRun(run)));
  }

  /** What this browser keeps the open project by, which drafts are kept under. */
  get projectKey(): string | undefined {
    return this.#project?.key;
  }

  /** Whether a task of the conversation shown runs. */
  get running(): boolean {
    return this.#shown?.conversation.running === true;
  }

  /** How many conversations of the window have a task that runs. */
  get runningCount(): number {
    let count = 0;
    for (const run of this.#runs.values()) if (run.conversation.running) count += 1;
    return count;
  }

  /** The conversation of the window with this id, where the window has it. */
  conversationOf(chat: string): Conversation | undefined {
    return this.#runs.get(chat)?.conversation;
  }

  /** A conversation from the start, shown. The one before goes on, and stays among the saved ones. */
  newConversation(): void {
    const before = this.#shown;
    if (before) void this.#flushRun(before);
    this.#start([], undefined, undefined);
  }

  /**
   * Shows a conversation of the project. One the window has with something going on is shown as it
   * is; another is read again from where it is kept, for what another device wrote. `again` reads
   * it again in any case, where nothing runs in it.
   */
  async open(id: string, again = false): Promise<void> {
    const project = this.#project?.key;
    if (project === undefined) return;
    const had = this.#runs.get(id);
    if (had && (had.conversation.running || (!again && (had === this.#shown || this.#busy(had))))) {
      if (had !== this.#shown) this.#show(had);
      return;
    }
    if (had) await this.#flushRun(had);
    // What is kept of it is older than what the window has, as it could not be written: the
    // window's, rather than reading it again.
    if (had && had.unsaved && !again && this.#runs.get(id) === had) {
      if (had !== this.#shown) this.#show(had);
      return;
    }
    const fields = had?.fields;
    const said = had?.conversation.getSnapshot().entries;
    const saved = await this.#chats.load(project, id).catch((error: unknown) => {
      console.warn("A conversation could not be read", error);
      return undefined;
    });
    if (this.#project?.key !== project) return;
    // Something started in it meanwhile, or people changed it (its model, its name, "先出方案"),
    // or it waits to be written: as it is now, what was read is no newer.
    const now = this.#runs.get(id);
    const changed =
      !again &&
      now !== undefined &&
      now === had &&
      (now.fields !== fields ||
        now.conversation.getSnapshot().entries !== said ||
        now.pending !== undefined ||
        now.unsaved);
    if (now && (this.#busy(now) || changed)) {
      if (now !== this.#shown) this.#show(now);
      return;
    }
    if (!saved) {
      if (now && now !== this.#shown) this.#show(now);
      return;
    }
    this.#startSaved(id, saved);
  }

  /** A conversation as it was kept, shown from now on. */
  #startSaved(id: string, saved: SavedChat): void {
    // What this editor cannot read stays where it was, and goes back as it was.
    const entries = readEntries(saved.entries);
    this.#start(entries, id, saved.caller, {
      ...(saved.titleBy !== undefined && { title: saved.title, titleBy: saved.titleBy }),
      ...(isModelRef(saved.model) && { model: saved.model }),
      ...(typeof saved.reasoning === "string" && { reasoning: saved.reasoning }),
      ...(isForkedFrom(saved.forkedFrom) && { forkedFrom: saved.forkedFrom }),
      ...(Array.isArray(saved.repick) && {
        repick: saved.repick.filter((model): model is string => typeof model === "string"),
      }),
      ...(saved.planFirst === true && { planFirst: true }),
    });
  }

  /** Saves what a conversation is now, such as its model, where it has words to keep. */
  #keep(run: Run | undefined): void {
    if (run) this.#saveSoon(run);
  }

  /**
   * The model of the conversation shown from its next turn on, which it keeps: other conversations
   * and the settings stay as they are. Nothing takes the default again, until the first message.
   */
  chooseModel(ref: ModelRef | undefined): void {
    const run = this.#shown;
    if (!run) return;
    this.#update(run, { model: ref, hold: undefined });
    this.#keep(run);
  }

  /**
   * The switch "先出方案" of the conversation shown, from its next message on: a task that runs
   * goes on as its message asked.
   */
  setPlanFirst(on: boolean): void {
    const run = this.#shown;
    if (!run || run.fields.planFirst === on) return;
    this.#update(run, { planFirst: on });
    this.#keep(run);
  }

  /**
   * People accepted a plan ("按这个做"), as they changed it: it goes as their message, and the
   * switch goes off, so that AI does it.
   */
  async acceptPlan(call: string, text: string): Promise<TaskOutcome | undefined> {
    const run = this.#shown;
    const project = this.#project?.key;
    if (!run || run.conversation.running || !text.trim() || project === undefined) return undefined;
    const { conversation } = run;
    const went = () =>
      conversation
        .getSnapshot()
        .entries.some((entry) => entry.role === "user" && entry.fromPlan === call);
    // Once it went, and not before: where it cannot go, the switch and the card stay as they were.
    let off = false;
    const goneOff = () => {
      if (off || !went()) return;
      off = true;
      if (run.fields.planFirst) {
        this.#update(run, { planFirst: false });
        this.#keep(run);
      }
      this.planDrafts.write(project, run.id, call, undefined);
    };
    const stop = conversation.subscribe(goneOff);
    try {
      return await this.#send(run, text, [], undefined, { fromPlan: call });
    } finally {
      stop();
      goneOff();
    }
  }

  /** How hard the model of the conversation shown reasons; nothing leaves it to the settings. */
  chooseReasoning(level: ReasoningLevel | undefined): void {
    const run = this.#shown;
    if (!run) return;
    this.#update(run, { reasoning: level });
    this.#keep(run);
  }

  /** The model the conversation shown uses, see `ModelNow`; none where there is no default. */
  modelNow(): ModelNow | undefined {
    return this.#modelOf(this.#shown);
  }

  #modelOf(run: Run | undefined): ModelNow | undefined {
    const own = run?.fields.model;
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
   * How hard the model of the conversation shown reasons: as the conversation chose, else as set up
   * for the model, else as its pack says (`undefined` here).
   */
  reasoningNow(model: string): ReasoningLevel | undefined {
    return this.#reasoningOf(this.#shown, model);
  }

  #reasoningOf(run: Run | undefined, model: string): ReasoningLevel | undefined {
    return run?.fields.reasoning ?? this.#options.ai.getSnapshot().reasoningFor?.[model];
  }

  /** Renames a conversation of the project, which keeps that name: no title comes for it any more. */
  async rename(id: string, title: string): Promise<void> {
    const name = title.trim().slice(0, TITLE_LENGTH * 2);
    const project = this.#project?.key;
    if (!name || project === undefined) return;
    const run = this.#runs.get(id);
    if (run) {
      this.#update(run, { title: name, titleBy: "user" });
      this.#keep(run);
      if (run.conversation.getSnapshot().entries.length === 0) return;
      return this.#flushRun(run);
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
   * A new conversation with what the one shown said before a turn, and the words of that turn in
   * its input box, not sent; or, from its answer (`after`), with all of that turn too and the box
   * empty. It keeps the model; the project stays as it is, with what AI changed after.
   */
  fork(task: string, from: "before" | "after" = "before"): void {
    const run = this.#shown;
    const project = this.#project?.key;
    if (!run || run.conversation.running || project === undefined) return;
    const entries = run.conversation.getSnapshot().entries;
    const start = entries.findIndex((entry) => entry.role === "user" && entry.task === task);
    const user = entries[start];
    if (user?.role !== "user") return;
    const turn = entries.slice(0, start + 1).filter((entry) => entry.role === "user").length;
    // After the turn: all of it goes along, up to the next message of people, and the box is empty.
    const next = entries.findIndex((entry, index) => index > start && entry.role === "user");
    const end = from === "before" ? start : next < 0 ? entries.length : next;
    const title = run.fields.title || firstWords(entries, TITLE_LENGTH);
    const { model, reasoning, repick } = run.fields;
    void this.#flushRun(run);
    const copy = newChatId();
    const made = this.#start(entries.slice(0, end), copy, undefined, {
      ...(model && { model }),
      ...(reasoning !== undefined && { reasoning }),
      repick,
      forkedFrom: { title, turn },
    });
    if (from === "before") {
      this.drafts.write(project, copy, user.text);
      this.attachments.restore(project, copy, user.images ?? []);
    }
    this.#keep(made);
  }

  /**
   * Queues a message in the conversation shown to go once its task is done, with what the editor
   * shows now: as people send it, not as it goes. `WITHHELD` where people took that off for it.
   */
  queue(
    text: string,
    images: readonly AttachedImage[] = [],
    selection: SelectionFacts = this.#shownFacts(),
  ): void {
    const run = this.#shown;
    if (!run || (!text.trim() && images.length === 0)) return;
    const plan = run.fields.planFirst;
    this.#update(run, {
      queued: [
        ...run.fields.queued,
        { text, ...(images.length > 0 && { images }), selection, ...(plan && { plan: true }) },
      ],
    });
  }

  /** Takes a queued message of the conversation shown back, which then does not go. Says what it was. */
  unqueue(index: number): Queued | undefined {
    const run = this.#shown;
    const message = run?.fields.queued[index];
    if (!run || message === undefined) return undefined;
    this.#update(run, { queued: run.fields.queued.filter((_, at) => at !== index) });
    return message;
  }

  /**
   * After a task: the next message queued goes, where the task was done as it should be; after a
   * stop, a failure or the limit it waits for people. The conversation gets a title after its
   * first turn. All of this whether it is shown or not.
   */
  #after(run: Run, outcome: TaskOutcome | undefined): void {
    // How the service did, for the dot beside it in the settings: what failed, until one goes.
    const service = outcome && !this.#options.fake?.() ? this.#modelOf(run)?.service : undefined;
    if (service && outcome?.failure) this.#options.ai.noteRequest(service.id, outcome.failure);
    else if (service && outcome && outcome.end !== "failed" && outcome.end !== "stopped")
      this.#options.ai.noteRequest(service.id, undefined);
    if (this.#runs.get(run.id) !== run || !outcome) return;
    void this.#title(run);
    const [next, ...rest] = run.fields.queued;
    if (next === undefined || outcome.end !== "done") return;
    this.#update(run, { queued: rest });
    void this.#sendQueued(run, next);
  }

  /**
   * A short title from the model of the conversation, after its first turn: one small request,
   * where the settings say so and people did not name the conversation. Its first words stay
   * otherwise.
   */
  async #title(run: Run): Promise<void> {
    const entries = run.conversation.getSnapshot().entries;
    if (run.fields.titleBy !== undefined || !this.#options.ai.getSnapshot().autoTitle) return;
    if (entries.filter((entry) => entry.role === "user").length !== 1) return;
    const first = entries.find((entry) => entry.role === "user");
    const answered = entries.some((entry) => entry.role === "assistant" && entry.end !== "failed");
    if (first?.role !== "user" || !answered) return;
    const target = await this.#target(run);
    if (typeof target === "string" || ("fake" in target.endpoint && !this.#options.ask)) return;
    const ask = this.#options.ask ?? askModel;
    const said = await ask(target.endpoint as Endpoint, await target.key(), {
      prompt: titlePrompt(first.text),
      maxTokens: TITLE_TOKENS,
      timeoutMs: TITLE_TIMEOUT_MS,
      maxChars: 200,
    }).catch(() => undefined);
    const title = said?.ok ? cleanTitle(said.text ?? "", TITLE_LENGTH) : undefined;
    // People may have named it meanwhile, or it went away.
    if (!title || this.#runs.get(run.id) !== run || run.fields.titleBy !== undefined) return;
    this.#update(run, { title, titleBy: "auto" });
    this.#keep(run);
  }

  /**
   * Deletes a conversation of the project. Where its task runs, it stops first and is deleted
   * once the task is over: what it changed stays in the project.
   */
  async remove(id: string): Promise<void> {
    const project = this.#project?.key;
    if (project === undefined) return;
    const run = this.#runs.get(id);
    if (run) {
      this.#runs.delete(id);
      run.gone = true;
      run.conversation.stop();
      if (run.conversation.running) await idleOf(run.conversation);
      clearTimeout(run.saving);
      run.pending = undefined;
      run.unwatch();
      await run.writing?.catch(() => {});
      if (run === this.#shown) {
        this.#shown = undefined;
        this.#start([], undefined, undefined);
      } else this.#refresh();
    }
    // Another device wrote it meanwhile, and what this page had went into a copy (`#split`): that
    // is what goes, and theirs stays.
    const gone = run?.id ?? id;
    this.drafts.clear(project, id);
    await this.#chats.remove(project, gone).catch((error: unknown) => {
      console.warn("A conversation could not be taken away", error);
    });
    this.#set({ saved: this.#snapshot.saved.filter((saved) => saved.id !== gone) });
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
   * shown, which then says so.
   */
  choosePack(model: string, pack: string | undefined, from: "now" | "next" = "next"): void {
    this.#options.ai.choosePack([model], pack);
    const run = this.#shown;
    if (from !== "now" || !run || run.fields.repick.includes(model)) return;
    this.#update(run, { repick: [...run.fields.repick, model] });
    // Written right away: people may leave right after choosing, and expect it to hold.
    this.#keep(run);
    void this.#flushRun(run);
  }

  /** Whether the next answer of the conversation shown takes the pack chosen for a model now. */
  repicking(model: string): boolean {
    return this.#shown?.fields.repick.includes(model) === true;
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
   * The pack for the next answer of a conversation. A conversation keeps its pack, at the version
   * it began with, while the model stays: an update, like another choice in the settings, counts
   * from the next conversation. Where that version is not kept any more, the version installed goes
   * on (the chat says so); a new model, or a pack that is gone, chooses again, see `choosePack`.
   */
  #packFor(
    run: Run,
    model: string,
    entries: readonly ChatEntry[],
  ): { readonly use: PackUse; readonly note: PackNote } {
    const last = entries.findLast((entry) => entry.role === "assistant");
    const repick = run.fields.repick.includes(model);
    // The choice holds until an answer comes with it: that answer then keeps the pack.
    if (repick) run.taking = { model, answers: answersIn(entries) };
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

  /** Where a message of a conversation would go now, or why it cannot go. */
  async #target(run: Run | undefined): Promise<
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
    const now = this.#modelOf(run);
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
   * Sends a message in the conversation shown, which starts a task. Resolves once the task is over,
   * whichever conversation is shown by then. Words that do not go out, or that the service refused
   * before it said anything, go back to the input box of the conversation. The message keeps what
   * the editor shows as it is called, unless `selection` says what it showed when people sent it
   * (a queued message).
   */
  send(
    text: string,
    images: readonly AttachedImage[] = [],
    selection?: SelectionFacts,
    marks?: Pick<UserEntry, "plan" | "fromPlan" | "rewrites">,
  ): Promise<TaskOutcome | undefined> {
    const run = this.#shown;
    return run ? this.#send(run, text, images, selection, marks) : Promise.resolve(undefined);
  }

  async #send(
    run: Run,
    text: string,
    images: readonly AttachedImage[] = [],
    selection?: SelectionFacts,
    marks?: Pick<UserEntry, "plan" | "fromPlan" | "rewrites">,
  ): Promise<TaskOutcome | undefined> {
    // Before anything waits: people may select something else meanwhile, or switch "先出方案".
    const shown = selection ?? this.#shownFacts();
    const marked = marks ?? (run.fields.planFirst ? { plan: true as const } : {});
    const { conversation, id, project } = run;
    if (conversation.running || (!text.trim() && images.length === 0)) return undefined;
    const putBack = () => {
      if (project === undefined) return;
      this.drafts.restore(project, id, text);
      this.attachments.restore(project, id, images);
    };
    // Pictures do not go to a model said not to take them: people choose another, or go without.
    if (images.length > 0 && this.#seesPictures(run) === false) {
      this.#update(run, { hold: "noPictures" });
      putBack();
      return undefined;
    }
    const target = await this.#taskTarget(run);
    if (!target) {
      putBack();
      return undefined;
    }
    // The first message settles the model of the conversation: another default later is not it.
    if (!run.fields.model) {
      const now = this.#modelOf(run);
      if (now) this.#update(run, { model: now.ref });
    }
    const outcome = await conversation.send(text, target, images, shown, marked);
    if (outcome?.end === "failed" && project !== undefined) {
      const entries = conversation.getSnapshot().entries;
      const turn = entries.slice(entries.findLastIndex((entry) => entry.role === "user") + 1);
      const silent = turn.every(
        (entry) => entry.role === "assistant" && entry.text === "" && entry.calls.length === 0,
      );
      if (silent) putBack();
    }
    this.#after(run, outcome);
    return outcome;
  }

  /** A queued message, as it was when people sent it: also whether it asked for a plan first. */
  sendQueued(queued: Queued): Promise<TaskOutcome | undefined> {
    const run = this.#shown;
    return run ? this.#sendQueued(run, queued) : Promise.resolve(undefined);
  }

  #sendQueued(run: Run, queued: Queued): Promise<TaskOutcome | undefined> {
    return this.#send(run, queued.text, queued.images, queued.selection, {
      ...(queued.plan && { plan: true }),
    });
  }

  /**
   * A turn of the conversation shown once more, as a new turn at the end: the last one unless
   * `task` says which. With the same words, or with the words (and pictures) people edited it to,
   * which marks the new message as rewriting the old one (`UserEntry.rewrites`), so that the old
   * turn folds away under it. What the editor showed goes as it went; what it changed stays,
   * unless people took it back first (`undoTask`). It asks for a plan first as it did.
   */
  async resend(
    edited?: { readonly text: string; readonly images?: readonly AttachedImage[] },
    task?: string,
  ): Promise<TaskOutcome | undefined> {
    const run = this.#shown;
    const last = run?.conversation
      .getSnapshot()
      .entries.findLast(
        (entry) => entry.role === "user" && (task === undefined || entry.task === task),
      );
    if (!run || last?.role !== "user") return undefined;
    const text = edited?.text ?? last.text;
    const images = edited?.images ?? last.images ?? [];
    const same = (a: readonly AttachedImage[], b: readonly AttachedImage[]) =>
      a.length === b.length && a.every((image, index) => image.image === b[index]?.image);
    const rewritten =
      edited !== undefined && (text !== last.text || !same(images, last.images ?? []));
    return this.#send(run, text, images, last.selection, {
      ...(last.plan && { plan: true }),
      ...(rewritten && { rewrites: last.task }),
    });
  }

  /**
   * Why a message with these pictures could not go now in the conversation shown, as `send` would
   * find before it goes; or nothing, where it would go. Nothing changes by asking.
   */
  async holdFor(images: readonly AttachedImage[]): Promise<ChatHold | undefined> {
    const run = this.#shown;
    if (images.length > 0 && this.#seesPictures(run) === false) return "noPictures";
    if (!this.#project) return "noProject";
    const target = await this.#target(run);
    return typeof target === "string" ? target : undefined;
  }

  /** The last turn once more without its pictures, where its model or service took none. */
  async resendWithoutPictures(): Promise<TaskOutcome | undefined> {
    const run = this.#shown;
    const last = run?.conversation.getSnapshot().entries.findLast((entry) => entry.role === "user");
    return run && last?.role === "user"
      ? this.#send(run, last.text, [], last.selection, { ...(last.plan && { plan: true }) })
      : undefined;
  }

  /**
   * Whether the model of the conversation shown takes pictures, as its settings say (a catalog
   * filled in, or people): nothing where nobody said, and then pictures go and the service answers.
   */
  seesPictures(): boolean | undefined {
    return this.#seesPictures(this.#shown);
  }

  #seesPictures(run: Run | undefined): boolean | undefined {
    if (this.#options.fake?.()) return true;
    const now = this.#modelOf(run);
    if (!now?.service) return undefined;
    return this.#options.ai.modelOf(now.ref.service, now.ref.model)?.image;
  }

  /** The largest picture the model of the conversation shown takes, in bytes. */
  imageBytes(): number {
    const now = this.modelNow();
    const values = now?.service && this.#options.ai.modelOf(now.ref.service, now.ref.model)?.values;
    return values?.imageMaxBytes ?? DEFAULT_IMAGE_BYTES;
  }

  /**
   * Tries the last task of the conversation shown again after it failed, as the same task: what it
   * changed so far stays, and the task goes on from there. See `Conversation.retry`.
   */
  async retry(): Promise<TaskOutcome | undefined> {
    const run = this.#shown;
    const conversation = run?.conversation;
    if (!run || !conversation || conversation.running || !conversation.failedTask())
      return undefined;
    const target = await this.#taskTarget(run);
    if (!target) return undefined;
    const outcome = await conversation.retry(target);
    this.#after(run, outcome);
    return outcome;
  }

  /**
   * Where the next task of a conversation goes, and what goes with it; or why it cannot go. The
   * conversation counts as busy meanwhile, so that it stays with the window: the task starts right
   * after.
   */
  async #taskTarget(run: Run): Promise<TaskTarget | undefined> {
    run.starting += 1;
    try {
      return await this.#targetOfTask(run);
    } finally {
      run.starting -= 1;
    }
  }

  async #targetOfTask(run: Run): Promise<TaskTarget | undefined> {
    if (!this.#project) {
      this.#update(run, { hold: "noProject" });
      return undefined;
    }
    const target = await this.#target(run);
    if (typeof target === "string") {
      this.#update(run, { hold: target });
      return undefined;
    }
    if (run.fields.hold !== undefined) this.#update(run, { hold: undefined });
    const { maxToolCalls } = this.#options.ai.getSnapshot();
    const reasoning = this.#reasoningOf(run, target.model);
    // The window let go of it meanwhile, as another project opened.
    if (this.#runs.get(run.id) !== run) return undefined;
    const { conversation } = run;
    const { use, note } = this.#packFor(run, target.model, conversation.getSnapshot().entries);
    const sees = this.#seesPictures(run) !== false;
    return {
      pictures: { sees, read: (ref) => this.attachments.base64Of(ref) },
      endpoint: target.endpoint,
      key: target.key,
      maxToolCalls,
      system: browserSystemPrompt(use.texts, sees),
      tools: (task, signal) => this.#toolsOf(task, run, use, signal),
      // How hard the model reasons: as people set it for the model, else as its pack says.
      call: reasoning === undefined ? use.call : { ...use.call, reasoning },
      stamp: { toolset: TOOLSET_VERSION, texts: use.used, pack: note },
      // The earlier conversation is summed up once the context is 80 % full, unless people said not.
      compact: this.#options.ai.getSnapshot().autoCompact !== false,
    };
  }

  /**
   * Sums up the earlier conversation shown now, as people asked, with the model of the
   * conversation: what happens by itself once the context is 80 % full (see `Conversation.compact`).
   */
  async compact(): Promise<RoomMade | undefined> {
    const run = this.#shown;
    if (!run?.conversation.compactable) return undefined;
    const target = await this.#taskTarget(run);
    if (!target || this.#runs.get(run.id) !== run) return undefined;
    const made = await run.conversation.compact(target);
    // What people wrote meanwhile waited for it, as for a task.
    const [next, ...rest] = run.fields.queued;
    if (next !== undefined && this.#runs.get(run.id) === run) {
      this.#update(run, { queued: rest });
      void this.#sendQueued(run, next);
    }
    return made;
  }

  /**
   * A new conversation where the one shown no longer fits its model: it starts from the summary of
   * this one, where there is one, with the last words of people in its input box, not sent.
   */
  continueFresh(): void {
    const run = this.#shown;
    const project = this.#project?.key;
    if (!run || run.conversation.running || project === undefined) return;
    const { model, reasoning, repick } = run.fields;
    const entries = run.conversation.getSnapshot().entries;
    const last = entries.findLast((entry) => entry.role === "user");
    const summary = summaryInForce(entries);
    const turn = entries.filter((entry) => entry.role === "user").length;
    const title = run.fields.title || firstWords(entries, TITLE_LENGTH);
    void this.#flushRun(run);
    const copy = newChatId();
    const made = this.#start(summary ? [{ ...summary, through: 0 }] : [], copy, undefined, {
      ...(model && { model }),
      ...(reasoning !== undefined && { reasoning }),
      repick,
      forkedFrom: { title, turn },
    });
    if (last?.role === "user") {
      this.drafts.write(project, copy, last.text);
      this.attachments.restore(project, copy, last.images ?? []);
    }
    this.#keep(made);
  }

  /** Stops the task of a conversation: the one shown without an id. */
  stop(chat?: string): void {
    this.#runOf(chat)?.conversation.stop();
  }

  /** Stops the tasks of every conversation of the window. */
  stopAll(): void {
    for (const run of this.#runs.values()) run.conversation.stop();
  }

  /** Whether what a task changed can be taken back now, or done again. */
  undoState(task: string): "undo" | "redo" | undefined {
    const store = this.#project?.store;
    if (!store) return undefined;
    if (store.canUndoOrigin(aiTask(task))) return "undo";
    if (store.canRedoOrigin(aiTask(task))) return "redo";
    return undefined;
  }

  /** The tasks of the conversation of a task from that one on, the oldest first. */
  #tasksFrom(task: string): readonly string[] {
    const tasks = this.#runOfTask(task)?.conversation.tasks ?? [];
    const at = tasks.indexOf(task);
    return at < 0 ? [] : tasks.slice(at);
  }

  /**
   * Whether going back to before this turn would take something back: of this turn or a later
   * one of its conversation. Nothing else is ever taken back by it.
   */
  canGoBack(task: string): boolean {
    const store = this.#project?.store;
    return (
      store !== undefined && this.#tasksFrom(task).some((each) => store.canUndoOrigin(aiTask(each)))
    );
  }

  /**
   * What going back to before this turn would take back now: this turn and every later one of its
   * conversation, the AI's changes only. Turns that cannot go back are listed with why, where
   * they changed something; those already taken back, or that changed nothing, are not.
   */
  backPlan(task: string): BackPlan | undefined {
    const store = this.#project?.store;
    const tasks = this.#tasksFrom(task);
    if (!store || tasks.length === 0) return undefined;
    const plan = store.undoOrigins(tasks.map(aiTask), { dryRun: true });
    return this.#backPlanOf(task, tasks, plan);
  }

  #backPlanOf(from: string, tasks: readonly string[], plan: ManyUndoResult): BackPlan {
    const of = new Map(plan.ok ? plan.each.map(({ origin, result }) => [origin, result]) : []);
    const entries = this.#runOfTask(from)?.conversation.getSnapshot().entries ?? [];
    const rows: BackRow[] = [];
    for (const task of tasks) {
      const result = of.get(aiTask(task));
      const summary = this.#summaryOfTask(task, entries);
      if (result?.ok) {
        rows.push({
          task,
          places: placesOf(
            summary,
            result.patches.map(({ path }) => path),
          ),
          kept: placesOf(summary, result.kept),
        });
        continue;
      }
      const changed = placesOf(summary);
      if (result?.error.code === "undo-blocked") {
        rows.push({ task, places: changed, kept: 0, whyNot: result.error.obstacle ?? "changed" });
        continue;
      }
      // No log of it here: gone, or made on another device; or taken back already.
      const state = this.#options.undoStateOf?.(task);
      if (changed > 0 && state?.direction === undefined && state?.whyNot !== undefined) {
        rows.push({ task, places: changed, kept: 0, whyNot: state.whyNot });
      }
    }
    const going = rows.filter((row) => row.whyNot === undefined);
    return {
      from,
      rows,
      places: going.reduce((sum, row) => sum + row.places, 0),
      kept: going.reduce((sum, row) => sum + row.kept, 0),
      key: planKey(plan),
    };
  }

  /** What a turn did, as its card says. */
  #summaryOfTask(task: string, entries: readonly ChatEntry[]): TurnSummary {
    const group = groupsOf(entries).find(({ user }) => user.task === task);
    return summaryOf(group?.entries ?? []);
  }

  /**
   * Goes back to before a turn as `plan` said: takes back that turn and every later one of its
   * conversation, the newest first, each as its card would. Where what would go back now is not
   * what the plan said, nothing goes back and the outcome says what would now. The messages stay.
   */
  async backTo(plan: BackPlan): Promise<BackOutcome | undefined> {
    const store = this.#project?.store;
    const run = this.#runOfTask(plan.from);
    const tasks = this.#tasksFrom(plan.from);
    if (!store || tasks.length === 0) return undefined;
    const origins = tasks.map(aiTask);
    const many: ManyTakeBack | undefined = this.#options.takeBackMany
      ? await this.#options.takeBackMany(tasks, "undo", plan.key)
      : (() => {
          const now = store.undoOrigins(origins, { dryRun: true });
          if (planKey(now) !== plan.key) return { done: false, plan: now } as const;
          const going = now.ok
            ? now.each.filter(({ result }) => result.ok).map(({ origin }) => origin)
            : [];
          return { done: true, result: store.undoOrigins(going) } as const;
        })();
    this.#set({ undoTick: this.#snapshot.undoTick + 1 });
    if (!many) return undefined;
    if (!many.done) return { done: false, plan: this.#backPlanOf(plan.from, tasks, many.plan) };
    const each = many.result.ok ? many.result.each : [];
    const entries = run?.conversation.getSnapshot().entries ?? [];
    const all = run?.conversation.tasks ?? [];
    const failure = (task: string, error: CommandFailure) => ({
      task,
      turn: all.indexOf(task) + 1,
      error,
    });
    const taken: string[] = [];
    let places = 0;
    let failed: ReturnType<typeof failure> | undefined;
    for (const { origin, result } of each) {
      const task = origin.slice("ai:".length);
      if (result.ok) {
        taken.push(task);
        const paths = result.patches.map(({ path }) => path);
        places += placesOf(this.#summaryOfTask(task, entries), paths);
      } else {
        failed ??= failure(task, result.error);
      }
    }
    if (!many.result.ok) failed = failure(plan.from, many.result.error);
    const last = this.#lastTask(run);
    if (run && last !== undefined && taken.includes(last)) {
      run.unmarked = last;
      this.#mark(run, run.conversation.getSnapshot().entries);
    }
    return { done: true, places, taken, ...(failed && { failed }) };
  }

  /** Does again what going back to before a turn took back, the oldest first. */
  async redoBack(taken: readonly string[]): Promise<void> {
    const store = this.#project?.store;
    if (!store || taken.length === 0) return;
    if (this.#options.takeBackMany) await this.#options.takeBackMany(taken, "redo");
    else store.redoOrigins(taken.map(aiTask));
    for (const run of this.#runs.values()) {
      if (run.unmarked !== undefined && taken.includes(run.unmarked)) {
        run.unmarked = undefined;
        this.#mark(run, run.conversation.getSnapshot().entries);
      }
    }
    this.#set({ undoTick: this.#snapshot.undoTick + 1 });
  }

  /** What people asked for in a task of a conversation of the window, on one line. */
  labelOf(task: string): string | undefined {
    const entries = this.#runOfTask(task)?.conversation.getSnapshot().entries ?? [];
    const asked = entries.find((entry) => entry.role === "user" && entry.task === task);
    if (asked?.role !== "user") return undefined;
    const line = asked.text.replace(/\s+/g, " ").trim();
    return line.length > 40 ? `${line.slice(0, 39)}…` : line;
  }

  /**
   * The conversation of the window a task is of, by its id and title, where the window has one
   * that has it: for who changed something.
   */
  chatOfTask(task: string): { readonly id: string; readonly title: string } | undefined {
    for (const run of this.#runs.values()) {
      if (!run.conversation.tasks.includes(task)) continue;
      const summary = this.#snapshot.runs.find((each) => each.id === run.id);
      return { id: run.id, title: summary?.title ?? run.fields.title };
    }
    return undefined;
  }

  /** Takes back everything a task changed, in one step. What people changed since then stays. */
  async undoTask(task: string): Promise<void> {
    await this.#takeBack(task, "undo");
    const run = this.#runOfTask(task);
    if (run && task === this.#lastTask(run)) {
      run.unmarked = task;
      this.#mark(run, run.conversation.getSnapshot().entries);
    }
  }

  async redoTask(task: string): Promise<void> {
    await this.#takeBack(task, "redo");
    const run = this.#runOfTask(task);
    if (run && task === run.unmarked) {
      run.unmarked = undefined;
      this.#mark(run, run.conversation.getSnapshot().entries);
    }
  }

  async #takeBack(task: string, direction: "undo" | "redo"): Promise<void> {
    const store = this.#project?.store;
    if (!store) return;
    const { takeBack, undone } = this.#options;
    if (takeBack) await takeBack(task, direction);
    else
      undone(
        direction === "undo" ? store.undoOrigin(aiTask(task)) : store.redoOrigin(aiTask(task)),
      );
    this.#set({ undoTick: this.#snapshot.undoTick + 1 });
  }
}

/** Resolves once no task runs in a conversation. */
function idleOf(conversation: Conversation): Promise<void> {
  return new Promise((resolve) => {
    if (!conversation.running) {
      resolve();
      return;
    }
    const stop = conversation.subscribe(() => {
      if (conversation.running) return;
      stop();
      resolve();
    });
  });
}

/** A turn in the list of "back to before this turn": what of it goes back, or why nothing can. */
export interface BackRow {
  readonly task: string;
  /** How many places go back, counted as its card does; for one that cannot, as many as it changed. */
  readonly places: number;
  /** How many places of it stay, because they were changed since. */
  readonly kept: number;
  readonly whyNot?: UndoWhyNot;
}

/** What "back to before this turn" would do now, see `ChatSession.backPlan`. */
export interface BackPlan {
  /** The turn it goes back to before. */
  readonly from: string;
  /** Each turn from that one on that has something to say, the oldest first. */
  readonly rows: readonly BackRow[];
  readonly places: number;
  readonly kept: number;
  /** What it was worked out from, see `planKey`. */
  readonly key: string;
}

/** What came of going back to before a turn, see `ChatSession.backTo`. */
export type BackOutcome =
  /** The project changed since the list was shown: nothing went back, and this is what would now. */
  | { readonly done: false; readonly plan: BackPlan }
  | {
      readonly done: true;
      /** How many places went back, counted as the cards do. */
      readonly places: number;
      /** The turns that went back, to do them again. */
      readonly taken: readonly string[];
      /** The first turn that did not go back although it should have, and why. */
      readonly failed?: {
        readonly task: string;
        /** Which turn of the conversation it is, from 1. */
        readonly turn: number;
        readonly error: CommandFailure;
      };
    };

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
