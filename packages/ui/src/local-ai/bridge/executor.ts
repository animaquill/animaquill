import { framedMessage, type Mail } from "@animaquill/agent";
import { cleanName } from "../../chat/relay.ts";
import { aiTask, type Origin, type ProjectState, type ProjectStore } from "@animaquill/core";
import {
  CallerState,
  WRITE_TOOLS,
  createToolset,
  type BridgeClient,
  type BridgeResult,
  type ListenAnswer,
  type ListenRequest,
  type LookAnswer,
  type LookRequest,
  type Tool,
  type ToolHost,
  type ToolResult,
  type AgentCard,
  type AgentDirectory,
  type SendOutcome,
} from "@animaquill/tools";

/**
 * Runs the calls of AI tools on this computer in the editor (docs/design/online-offline.md of
 * AnimaQuill Cloud, 5.1): the same tools as the assistant in the browser, on the project open in
 * this window, through the same store. Each session of an AI tool has what it read of the project
 * (`CallerState`), and its changes as batches: one batch while it keeps changing, a new one after
 * ten minutes without, each an origin of its own that people take back as a whole: `ai:mcp-` with
 * the session, this start of the page and the batch, so that a batch after a reload, or after the
 * relay changed, is never one of before. Calls go one after the other, as the editor has one
 * compositor, and only on the project they are for. A change that comes again under the same id, as
 * after the relay changed, gets the answer it got and is not made twice; one this page has no record
 * of is not made at all, as it may have been made by a page that is gone.
 */

/** How long without a change before the next change of a session is a batch of its own. */
export const BATCH_GAP_MS = 10 * 60 * 1000;
/** How many answers of changes are kept to give again, for how long, and how much of them. */
const KEPT_ANSWERS = 200;
const KEPT_MS = 10 * 60 * 1000;
const KEPT_BYTES = 4 * 1024 * 1024;

/** What the tools need of the editor, as the assistant in the browser has it too. */
export type EditorToolParts = Pick<
  ToolHost,
  "selection" | "problems" | "describe" | "problemInputs" | "ranNow" | "whoIs"
> & {
  readonly look?: (request: LookRequest, signal: AbortSignal) => Promise<LookAnswer>;
  readonly listen?: (request: ListenRequest, signal: AbortSignal) => Promise<ListenAnswer>;
};

export interface BridgeCall {
  readonly call: string;
  readonly session: string;
  readonly client?: BridgeClient;
  readonly answer: string;
  readonly tool: string;
  readonly args: unknown;
  /** The project it is for: it runs on no other. */
  readonly project?: { readonly mode: "online" | "offline"; readonly key: string };
  /** It comes again, as after the relay changed, see the top. */
  readonly again?: boolean;
}

/** A change a session made, for whoever tells people. */
export interface BridgeWrite {
  readonly origin: Origin;
  readonly session: string;
  readonly client: BridgeClient | undefined;
  readonly tool: string;
  readonly store: ProjectStore;
  readonly result: ToolResult;
}

export interface BridgeExecutorOptions {
  /** The project of this window. */
  readonly store: () => ProjectStore | undefined;
  /** What the page says the project of this window is, and its name, to check calls against. */
  readonly project?: () =>
    | { readonly mode: "online" | "offline"; readonly key: string; readonly name: string }
    | undefined;
  readonly parts: EditorToolParts;
  /** Whether the page is in the background, where the browser draws nothing. */
  readonly hidden: () => boolean;
  /** The bytes of a picture a tool gave, kept by `look`. */
  readonly picture: (
    image: string,
  ) => Promise<{ readonly type: string; readonly data: string } | undefined>;
  readonly wrote?: (write: BridgeWrite) => void;
  readonly now?: () => number;
  /**
   * The other conversations of the project a session sees and sends words to, as `mcp:` and its
   * session, by the name of its tool (docs/design/ai-teamwork.md of AnimaQuill Cloud, 3).
   */
  readonly agents?: (id: string, name: () => string) => AgentDirectory;
}

/** Messages that wait for one session at most, and how long the same words go once. */
const MAX_MAIL = 50;
const REPEAT_MS = 60_000;

interface SessionState {
  readonly caller: CallerState;
  tools: readonly Tool[];
  readonly store: ProjectStore;
  client: BridgeClient | undefined;
  /** The batch it changes the project as now, and when it last did. */
  batch: number;
  lastWrite: number;
  /** The project as its batch found it. */
  start: ProjectState | undefined;
  answer: string;
  /** What stops the call that runs. */
  signal: AbortSignal | undefined;
}

const failed = (text: string): BridgeResult => ({ text, isError: true });

export class BridgeExecutor {
  readonly #options: BridgeExecutorOptions;
  readonly #sessions = new Map<string, SessionState>();
  /** Calls that run or wait, by id: one that comes again meanwhile waits for the same answer. */
  readonly #running = new Map<
    string,
    { readonly controller: AbortController; readonly result: Promise<BridgeResult> }
  >();
  /** What changes answered, without pictures, to give again: see `KEPT_ANSWERS`. */
  readonly #answers = new Map<string, { readonly at: number; readonly result: BridgeResult }>();
  #answerBytes = 0;
  /** The last batch of each session on this page, which a session read anew goes on from. */
  readonly #batches = new Map<string, number>();
  /** Messages of conversations for each session, which go with its next result. */
  readonly #mail = new Map<string, Mail[]>();
  /** The words each sent to a session lately, and when, for the same words within a minute. */
  readonly #recent = new Map<string, number>();
  /** This start of the page, in the origins of its batches. */
  readonly #start: string;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(options: BridgeExecutorOptions) {
    this.#options = options;
    const now = (options.now ?? Date.now)();
    const random = crypto.getRandomValues(new Uint32Array(1))[0] ?? 0;
    this.#start = `${now.toString(36)}${(random % 1296).toString(36).padStart(2, "0")}`;
  }

  #originOf(session: string, batch: number): Origin {
    return aiTask(`mcp-${session}-${this.#start}-${batch}`);
  }

  /** The origin a session changes the project as now, see the top. */
  originOf(session: string): Origin | undefined {
    const state = this.#sessions.get(session);
    return state && this.#originOf(session, state.batch);
  }

  /** Runs a call, or gives what it gave before. */
  run(call: BridgeCall): Promise<BridgeResult> {
    const running = this.#running.get(call.call);
    if (running) return running.result;
    const kept = this.#answers.get(call.call);
    if (kept) return Promise.resolve(kept.result);
    const controller = new AbortController();
    const result = this.#queue
      .then(() => this.#run(call, controller.signal))
      .catch((error: unknown) =>
        failed(`error failed: the editor could not run the call: ${(error as Error).message}`),
      )
      .then((done) => {
        if (WRITE_TOOLS.has(call.tool)) this.#keep(call.call, done);
        return done;
      })
      .finally(() => this.#running.delete(call.call));
    this.#running.set(call.call, { controller, result });
    this.#queue = result;
    return result;
  }

  /** Keeps what a change answered, the oldest going first past the limits. */
  #keep(call: string, result: BridgeResult): void {
    const now = (this.#options.now ?? Date.now)();
    const kept = { text: result.text, isError: result.isError };
    this.#answers.set(call, { at: now, result: kept });
    this.#answerBytes += kept.text.length * 2;
    for (const [id, { at, result: old }] of this.#answers) {
      const over =
        this.#answers.size > KEPT_ANSWERS || this.#answerBytes > KEPT_BYTES || now - at >= KEPT_MS;
      if (!over || id === call) break;
      this.#answers.delete(id);
      this.#answerBytes -= old.text.length * 2;
    }
  }

  /** The AI tool stopped waiting for a call. */
  cancel(call: string): void {
    this.#running.get(call)?.controller.abort();
  }

  /** Another project is open, or none: what the sessions read is of the one before. */
  reset(): void {
    for (const { controller } of this.#running.values()) controller.abort();
    this.#sessions.clear();
  }

  #sessionOf(call: BridgeCall, store: ProjectStore): SessionState {
    const known = this.#sessions.get(call.session);
    if (known && known.store === store) {
      if (call.client) known.client = call.client;
      return known;
    }
    const { parts } = this.#options;
    const caller = new CallerState();
    // A session read anew, as on another project, changes it as a batch of its own.
    const batch = (this.#batches.get(call.session) ?? 0) + 1;
    this.#batches.set(call.session, batch);
    const state: SessionState = {
      caller,
      store,
      client: call.client,
      batch,
      lastWrite: 0,
      start: undefined,
      answer: call.answer,
      signal: undefined,
      tools: [],
    };
    const host: ToolHost = {
      store: () => (this.#options.store() === store ? store : undefined),
      origin: () => this.#originOf(call.session, state.batch),
      answer: () => `${call.session}:${state.answer}`,
      stopped: () => state.signal?.aborted === true,
      problems: parts.problems,
      ...(parts.selection && { selection: parts.selection }),
      ...(parts.describe && { describe: parts.describe }),
      ...(parts.problemInputs && { problemInputs: parts.problemInputs }),
      ...(parts.ranNow && { ranNow: parts.ranNow }),
      ...(parts.whoIs && { whoIs: parts.whoIs }),
      ...(this.#options.agents && {
        agents: this.#options.agents(`mcp:${call.session}`, () => nameOf(state.client)),
      }),
      ...(parts.look && {
        look: (request: LookRequest) =>
          parts.look?.(
            request,
            state.signal ?? new AbortController().signal,
          ) as Promise<LookAnswer>,
      }),
      ...(parts.listen && {
        listen: (request: ListenRequest) =>
          parts.listen?.(
            request,
            state.signal ?? new AbortController().signal,
          ) as Promise<ListenAnswer>,
      }),
      taskStart: () => state.start,
    };
    // No `planFirst`, no `approve`: the AI tool has a plan mode of its own, and asks people before
    // a change in its own way; "AI 改项目前先问我" is for the assistant of the editor.
    state.tools = createToolset(host, caller);
    this.#sessions.set(call.session, state);
    return state;
  }

  async #run(call: BridgeCall, signal: AbortSignal): Promise<BridgeResult> {
    const store = this.#options.store();
    if (!store || signal.aborted) {
      return failed(
        "error editor-not-open: the editor that took the call has no project open any more, so nothing was done. The call runs once the project is open in the editor again.",
      );
    }
    const open = this.#options.project?.();
    if (
      call.project &&
      open &&
      (open.key !== call.project.key || open.mode !== call.project.mode)
    ) {
      return failed(
        `error editor-not-open: the editor that took the call has the project ${JSON.stringify(open.name)} open now, not the one the call was for, so nothing was done. The call runs once that project is open in the editor again.`,
      );
    }
    const writes = WRITE_TOOLS.has(call.tool);
    if (call.again && writes) {
      return failed(
        "error outcome-unknown: this change came again after the connection to the editor was lost, and the editor that has the project now has no record of it, so it was not made again here. Whether it was made before is not known: aq_timeline_read, aq_object_read or aq_file_read show the project as it is now.",
      );
    }
    const session = this.#sessionOf(call, store);
    const tool = session.tools.find(({ name }) => name === call.tool);
    if (!tool) return failed(`error unknown-tool: there is no tool ${JSON.stringify(call.tool)}.`);
    const now = (this.#options.now ?? Date.now)();
    if (writes && session.lastWrite > 0 && now - session.lastWrite > BATCH_GAP_MS) {
      session.batch += 1;
      this.#batches.set(call.session, session.batch);
      session.start = undefined;
    }
    session.start ??= store.getState();
    session.answer = call.answer;
    if (call.tool === "aq_render_frames" && tool.validate(call.args) === undefined) {
      if (this.#options.hidden()) {
        return failed(
          "error editor-hidden: the AnimaQuill editor is in a background tab, where the browser draws nothing, so no frame was rendered. Rendering frames takes the editor in front; the user can bring it there.",
        );
      }
    }
    session.signal = signal;
    let result: ToolResult;
    try {
      result = await tool.run(call.args);
    } finally {
      session.signal = undefined;
    }
    if (writes && !result.isError) {
      session.lastWrite = now;
      this.#options.wrote?.({
        origin: this.#originOf(call.session, session.batch),
        session: call.session,
        client: session.client,
        tool: call.tool,
        store,
        result,
      });
    }
    return this.#forBridge(result, call.session);
  }

  /** The sessions on this page, as others the conversations of the chat see and send to. */
  cards(): readonly AgentCard[] {
    return [...this.#sessions].map(([session, state]) => ({
      id: `mcp:${session}`,
      kind: "tool" as const,
      name: nameOf(state.client),
      state: "tool" as const,
      changed: [],
      accepts: "yes" as const,
    }));
  }

  /**
   * A message of a conversation for a session, by `mcp:` and its session: it goes with its next
   * result, as nothing here can wake an AI tool.
   */
  deliver(id: string, mail: Mail): SendOutcome {
    const session = id.slice("mcp:".length);
    if (!this.#sessions.has(session)) return { refused: "unknown" };
    const now = (this.#options.now ?? Date.now)();
    for (const [key, at] of this.#recent) if (now - at > REPEAT_MS) this.#recent.delete(key);
    const key = `${session}\n${mail.from.id}\n${mail.text}`;
    if (this.#recent.has(key)) return { refused: "repeat" };
    const waiting = this.#mail.get(session) ?? [];
    if (waiting.length >= MAX_MAIL) return { refused: "full" };
    this.#recent.set(key, now);
    this.#mail.set(session, [...waiting, mail]);
    return { sent: "waits", until: "tool" };
  }

  /**
   * A result as it goes to the AI tool: its pictures as bytes, those for people left out, and the
   * messages of conversations that wait for the session after it, marked as theirs.
   */
  async #forBridge(result: ToolResult, session?: string): Promise<BridgeResult> {
    const mail = session === undefined ? [] : (this.#mail.get(session) ?? []);
    if (session !== undefined) this.#mail.delete(session);
    // As words of an AI conversation for a tool that can run commands: not to be trusted.
    const messages = mail
      .map((each) => `\n\n${framedMessage(each.from, each.text, each.seal, true)}`)
      .join("");
    const images: { type: string; data: string }[] = [];
    const missing: string[] = [];
    for (const image of result.images ?? []) {
      if (image.forPeople) continue;
      const bytes = await this.#options.picture(image.image).catch(() => undefined);
      if (bytes) images.push(bytes);
      else
        missing.push(`${image.note.replace(/\]$/, "")} — not attached: the picture is not here]`);
    }
    const text =
      (missing.length === 0 ? result.text : `${missing.join("\n")}\n${result.text}`) + messages;
    return { text, isError: result.isError, ...(images.length > 0 && { images }) };
  }
}

/** How long the name of an AI tool is at most, as others see it. */
const MAX_NAME = 40;

/**
 * The name of an AI tool as it says it, for the conversations of the chat: without characters that
 * do not show or turn text around, and no longer than `MAX_NAME`.
 */
export function nameOf(client: BridgeClient | undefined): string {
  return cleanName(client?.name ?? "", MAX_NAME) || "AI tool";
}
