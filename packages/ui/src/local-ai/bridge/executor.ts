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
} from "@animaquill/tools";

/**
 * Runs the calls of AI tools on this computer in the editor (docs/design/online-offline.md of
 * AnimaQuill Cloud, 5.1): the same tools as the assistant in the browser, on the project open in
 * this window, through the same store. Each session of an AI tool has what it read of the project
 * (`CallerState`), and its changes as batches: one batch while it keeps changing, a new one after
 * ten minutes without, each an origin of its own that people take back as a whole. Calls go one
 * after the other, as the editor has one compositor; a call that comes again under the same id, as
 * after the relay changed, gets the answer it got, and is not run twice.
 */

/** How long without a change before the next change of a session is a batch of its own. */
export const BATCH_GAP_MS = 10 * 60 * 1000;
/** How many answers are kept to give again, and for how long. */
const KEPT_ANSWERS = 200;
const KEPT_MS = 10 * 60 * 1000;

/** What the tools need of the editor, as the assistant in the browser has it too. */
export type EditorToolParts = Pick<
  ToolHost,
  "selection" | "problems" | "describe" | "problemInputs" | "ranNow"
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
  readonly parts: EditorToolParts;
  /** Whether the page is in the background, where the browser draws nothing. */
  readonly hidden: () => boolean;
  /** The bytes of a picture a tool gave, kept by `look`. */
  readonly picture: (
    image: string,
  ) => Promise<{ readonly type: string; readonly data: string } | undefined>;
  readonly wrote?: (write: BridgeWrite) => void;
  readonly now?: () => number;
}

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
  readonly #answers = new Map<
    string,
    { readonly at: number; readonly result: Promise<BridgeResult> }
  >();
  readonly #running = new Map<string, AbortController>();
  #queue: Promise<unknown> = Promise.resolve();

  constructor(options: BridgeExecutorOptions) {
    this.#options = options;
  }

  /** The origin a session changes the project as now, see the top. */
  originOf(session: string): Origin | undefined {
    const state = this.#sessions.get(session);
    return state && aiTask(`mcp-${session}-${state.batch}`);
  }

  /** Runs a call, or gives what it gave before. */
  run(call: BridgeCall): Promise<BridgeResult> {
    const now = (this.#options.now ?? Date.now)();
    for (const [id, { at }] of this.#answers) {
      if (this.#answers.size <= KEPT_ANSWERS && now - at < KEPT_MS) break;
      this.#answers.delete(id);
    }
    const known = this.#answers.get(call.call);
    if (known) return known.result;
    const controller = new AbortController();
    this.#running.set(call.call, controller);
    const result = this.#queue
      .then(() => this.#run(call, controller.signal))
      .catch((error: unknown) =>
        failed(`error failed: the editor could not run the call: ${(error as Error).message}`),
      )
      .finally(() => this.#running.delete(call.call));
    this.#queue = result;
    this.#answers.set(call.call, { at: now, result });
    return result;
  }

  /** The AI tool stopped waiting for a call. */
  cancel(call: string): void {
    this.#running.get(call)?.abort();
  }

  /** Another project is open, or none: what the sessions read is of the one before. */
  reset(): void {
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
    const state: SessionState = {
      caller,
      store,
      client: call.client,
      batch: 1,
      lastWrite: 0,
      start: undefined,
      answer: call.answer,
      signal: undefined,
      tools: [],
    };
    const host: ToolHost = {
      store: () => (this.#options.store() === store ? store : undefined),
      origin: () => aiTask(`mcp-${call.session}-${state.batch}`),
      answer: () => `${call.session}:${state.answer}`,
      stopped: () => state.signal?.aborted === true,
      problems: parts.problems,
      ...(parts.selection && { selection: parts.selection }),
      ...(parts.describe && { describe: parts.describe }),
      ...(parts.problemInputs && { problemInputs: parts.problemInputs }),
      ...(parts.ranNow && { ranNow: parts.ranNow }),
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
    if (!store) {
      return failed(
        "error editor-not-open: the editor that took the call has no project open any more, so nothing was done.",
      );
    }
    const session = this.#sessionOf(call, store);
    const tool = session.tools.find(({ name }) => name === call.tool);
    if (!tool) return failed(`error unknown-tool: there is no tool ${JSON.stringify(call.tool)}.`);
    const now = (this.#options.now ?? Date.now)();
    const writes = WRITE_TOOLS.has(call.tool);
    if (writes && session.lastWrite > 0 && now - session.lastWrite > BATCH_GAP_MS) {
      session.batch += 1;
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
        origin: aiTask(`mcp-${call.session}-${session.batch}`),
        session: call.session,
        client: session.client,
        tool: call.tool,
        store,
        result,
      });
    }
    return this.#forBridge(result);
  }

  /** A result as it goes to the AI tool: its pictures as bytes, those for people left out. */
  async #forBridge(result: ToolResult): Promise<BridgeResult> {
    const images: { type: string; data: string }[] = [];
    const missing: string[] = [];
    for (const image of result.images ?? []) {
      if (image.forPeople) continue;
      const bytes = await this.#options.picture(image.image).catch(() => undefined);
      if (bytes) images.push(bytes);
      else
        missing.push(`${image.note.replace(/\]$/, "")} — not attached: the picture is not here]`);
    }
    const text = missing.length === 0 ? result.text : `${missing.join("\n")}\n${result.text}`;
    return { text, isError: result.isError, ...(images.length > 0 && { images }) };
  }
}
