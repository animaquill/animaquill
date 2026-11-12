/**
 * The only place that uses pi (`@earendil-works/pi-ai` and `pi-agent-core`), the library that talks
 * to AI services and runs the loop of an agent. Its API changes with nearly every minor version, so
 * it is pinned, and an upgrade only changes this file: everything else speaks the shapes of
 * `entries.ts`, `services.ts` and the types below. The rest of the editor loads this file on demand,
 * which keeps the library out of the first screen.
 */
import {
  Agent,
  type AgentEvent,
  type AgentMessage,
  type AgentTool,
} from "@earendil-works/pi-agent-core";
import {
  clampThinkingLevel,
  createModels,
  getSupportedThinkingLevels,
  createProvider,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxThinking,
  fauxToolCall,
  type Api,
  type AssistantMessage,
  type ClientIdentity,
  type FauxResponseStep,
  type Message,
  type Model,
  type ProviderStreams,
  type Usage,
} from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { googleGenerativeAIApi } from "@earendil-works/pi-ai/api/google-generative-ai.lazy";
import { mistralConversationsApi } from "@earendil-works/pi-ai/api/mistral-conversations.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import type { CallSettings, TextsUsed } from "@animaquill/tools";
import type {
  AnswerEnd,
  AnswerUsage,
  AssistantEntry,
  ChatEntry,
  PackNote,
  ToolEntry,
} from "./entries.ts";
import type { ListedModel, ReasoningLevel } from "./model-discovery.ts";
import { withoutKeys } from "./secrets.ts";
import type { Protocol } from "./services.ts";

/** Who the requests are from. pi says "pi" unless it is told otherwise. */
const IDENTITY: ClientIdentity = {
  userAgent: { custom: "AnimaQuill" },
  attribution: { name: "AnimaQuill", url: "https://github.com/animaquill/animaquill" },
};

/** The model of a service, and where it is. */
export interface Endpoint {
  /** The kind of service, see `ServiceKind`. */
  readonly service: string;
  readonly protocol: Protocol;
  readonly baseUrl: string;
  readonly model: string;
  /** What pi knows about the models of this kind of service, by pi's name for it. */
  readonly catalog?: string | undefined;
  /**
   * Where the requests go instead, for a service reached through the relay of the platform: the
   * relay's address for `baseUrl`, and what has to go with every request. The service is still the
   * same one: pi tells services apart by their address, which the relay's keeps in it.
   */
  readonly relay?: Relayed | undefined;
}

/** A service through the relay of the platform, see `Endpoint.relay`. */
export interface Relayed {
  readonly baseUrl: string;
  readonly headers: Readonly<Record<string, string>>;
}

/** One step of a pretend service, for tests: what it answers to the next request. */
export interface FakeAnswer {
  readonly text?: string;
  /** What it says of its thinking first, as services that summarize it do. */
  readonly thinking?: string;
  readonly calls?: readonly { readonly name: string; readonly args: Record<string, unknown> }[];
  /** Fails the request with this message instead. */
  readonly error?: string;
}

/**
 * A service that answers from a script, for tests. Each request takes the next answer. A function
 * gets what the tools said to the answer before, to answer like a model that read it.
 */
export interface FakeEndpoint {
  readonly fake: (FakeAnswer | ((results: readonly ToolEntry[]) => FakeAnswer))[];
  /** The name of the model it plays, as answers record it; "fake" without one. */
  readonly model?: string;
  /** How fast it writes, to have time to stop it. Without it, all at once. */
  readonly charactersPerSecond?: number;
  /** How many requests it got. */
  requests?: number;
}

/** What a tool said, for AI to read, and what it changed or found, for people. */
export interface ToolOutput {
  readonly text: string;
  readonly isError: boolean;
  /** For the summary of a turn: kept with the result, never sent to the model. */
  readonly data?: Readonly<Record<string, unknown>>;
  /** The turn waits for the user now: it ends after the tools of this answer. */
  readonly terminate?: true;
}

/** A tool, as AI sees it and as the editor runs it. */
export interface ToolSpec {
  readonly name: string;
  /** For people. */
  readonly label: string;
  /** For AI, which picks tools by it. */
  readonly description: string;
  /** JSON Schema, as the model gets it. */
  readonly parameters: Record<string, unknown>;
  /**
   * The tool's own check of a call, before anything else: what it says goes back to AI as the
   * result, and the call does not run. Without it, pi checks against `parameters`.
   */
  validate?(args: unknown): string | undefined;
  run(args: Record<string, unknown>): Promise<ToolOutput>;
}

/**
 * How to call the model, as a model pack says: every field is what the host has by default when it
 * is left out. A closed list, so that nothing else reaches a request. pi 1.5.0 has no way to say
 * `parallelToolCalls` for any protocol (only Codex sends it, always on), so it changes nothing yet,
 * and it does not pass the display of thinking on from its simple requests: Anthropic always gets
 * "summarized", which is what the browser wants.
 */
export type { CallSettings };

/** What every answer of a task says it was made with, see `AssistantEntry`. */
export interface AnswerStamp {
  readonly toolset?: string;
  readonly texts?: TextsUsed;
  readonly pack?: PackNote;
}

/** What happens while AI answers, in the order it happens. */
export type RunEvent =
  | { readonly type: "text"; readonly delta: string }
  /** What the model said of its thinking, where its service gives a summary. */
  | { readonly type: "thinking"; readonly delta: string }
  | { readonly type: "entry"; readonly entry: AssistantEntry | ToolEntry }
  | {
      readonly type: "tool";
      readonly id: string;
      readonly name: string;
      readonly args: Readonly<Record<string, unknown>>;
    };

export interface RunOptions {
  readonly endpoint: Endpoint | FakeEndpoint;
  /** The key, read when a request goes out. Undefined for services without one. */
  readonly key: () => Promise<string | undefined>;
  readonly system: string;
  readonly tools: readonly ToolSpec[];
  /** How to call the model. */
  readonly call?: CallSettings;
  /** What every answer is recorded as made with. */
  readonly stamp?: AnswerStamp;
  /** A new answer of the model begins, before any tool of it runs. */
  readonly onAnswer?: () => void;
  /** The conversation so far. */
  readonly history: readonly ChatEntry[];
  /**
   * What people wrote, which starts the task. Without it the task goes on from the history, which
   * then ends with what people wrote or what tools said: to try again after a failure.
   */
  readonly prompt?: string;
  readonly signal: AbortSignal;
  /**
   * Asked before each tool runs, with its arguments checked: a reason not to run it goes to AI
   * instead, and `stop` ends the task after the tools of this answer.
   */
  readonly before?: (call: {
    readonly id: string;
    readonly name: string;
  }) => { readonly reason: string; readonly stop: boolean } | undefined;
  /** Asked after each answer and its tools: true ends the task there. */
  readonly enough?: () => boolean;
  readonly onEvent: (event: RunEvent) => void;
}

export interface RunResult {
  readonly end: AnswerEnd;
  /** What went wrong, without the key. */
  readonly error?: string;
}

const NO_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const API: Record<Protocol, () => ProviderStreams> = {
  "anthropic-messages": anthropicMessagesApi,
  "openai-responses": openAIResponsesApi,
  "openai-completions": openAICompletionsApi,
  "google-generative-ai": googleGenerativeAIApi,
  "mistral-conversations": mistralConversationsApi,
};

type Catalog = Readonly<Record<string, Model<Api>>>;

/** What pi knows of the models of a service, loaded only for the services people use. */
const CATALOGS: Readonly<Record<string, () => Promise<unknown>>> = {
  anthropic: () =>
    import("@earendil-works/pi-ai/providers/anthropic.models").then((m) => m.ANTHROPIC_MODELS),
  openai: () =>
    import("@earendil-works/pi-ai/providers/openai.models").then((m) => m.OPENAI_MODELS),
  google: () =>
    import("@earendil-works/pi-ai/providers/google.models").then((m) => m.GOOGLE_MODELS),
  deepseek: () =>
    import("@earendil-works/pi-ai/providers/deepseek.models").then((m) => m.DEEPSEEK_MODELS),
  openrouter: () =>
    import("@earendil-works/pi-ai/providers/openrouter.models").then((m) => m.OPENROUTER_MODELS),
  xai: () => import("@earendil-works/pi-ai/providers/xai.models").then((m) => m.XAI_MODELS),
  zai: () => import("@earendil-works/pi-ai/providers/zai.models").then((m) => m.ZAI_MODELS),
  groq: () => import("@earendil-works/pi-ai/providers/groq.models").then((m) => m.GROQ_MODELS),
  mistral: () =>
    import("@earendil-works/pi-ai/providers/mistral.models").then((m) => m.MISTRAL_MODELS),
  together: () =>
    import("@earendil-works/pi-ai/providers/together.models").then((m) => m.TOGETHER_MODELS),
  huggingface: () =>
    import("@earendil-works/pi-ai/providers/huggingface.models").then((m) => m.HUGGINGFACE_MODELS),
  cerebras: () =>
    import("@earendil-works/pi-ai/providers/cerebras.models").then((m) => m.CEREBRAS_MODELS),
  "moonshotai-cn": () =>
    import("@earendil-works/pi-ai/providers/moonshotai-cn.models").then(
      (m) => m.MOONSHOTAI_CN_MODELS,
    ),
  "minimax-cn": () =>
    import("@earendil-works/pi-ai/providers/minimax-cn.models").then((m) => m.MINIMAX_CN_MODELS),
  fireworks: () =>
    import("@earendil-works/pi-ai/providers/fireworks.models").then((m) => m.FIREWORKS_MODELS),
  nvidia: () =>
    import("@earendil-works/pi-ai/providers/nvidia.models").then((m) => m.NVIDIA_MODELS),
};

async function catalogOf(name: string | undefined): Promise<Catalog> {
  const load = name === undefined ? undefined : CATALOGS[name];
  if (!load) return {};
  try {
    return ((await load()) ?? {}) as Catalog;
  } catch (error) {
    console.warn("What pi knows of these models could not be loaded", error);
    return {};
  }
}

/** The models pi knows of for a service, with what it knows of each, for people to pick from. */
export async function knownModels(
  catalog: string | undefined,
  protocol: Protocol,
): Promise<readonly ListedModel[]> {
  const models = Object.values(await catalogOf(catalog));
  return models
    .filter((model) => model.api === protocol && (model.type ?? "chat") === "chat")
    .map((model) => ({
      id: model.id,
      name: model.name,
      contextWindow: model.contextWindow,
      cost: { input: model.cost.input, output: model.cost.output },
      reasoning: model.reasoning,
      image: model.input.includes("image"),
      levels: getSupportedThinkingLevels(model) as ReasoningLevel[],
    }))
    .toSorted((a, b) => a.id.localeCompare(b.id));
}

/**
 * How well pi knows a model: as itself ("listed", with its prices), as a close version of one it
 * lists ("relative": its context, not its prices), or not at all.
 */
type Known = "listed" | "relative" | "unknown";

/**
 * The model as pi wants it. What pi knows of it helps, such as how long its answers can be and how
 * its service differs from the protocol. A model pi does not know gets what is safe for most.
 */
async function modelOf(endpoint: Endpoint, provider: string): Promise<Model<Api>> {
  return (await knownModelOf(endpoint, provider)).model;
}

async function knownModelOf(
  endpoint: Endpoint,
  provider: string,
): Promise<{ readonly model: Model<Api>; readonly known: Known }> {
  const catalog = await catalogOf(endpoint.catalog);
  const same = Object.values(catalog).filter((model) => model.api === endpoint.protocol);
  const listed = same.find((model) => model.id === endpoint.model);
  const known = listed ?? relativeOf(same, endpoint.model);
  const base: Model<Api> = known ?? {
    id: endpoint.model,
    name: endpoint.model,
    api: endpoint.protocol,
    provider,
    baseUrl: endpoint.baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8192,
    // How this service differs from the protocol, as pi knows it for the others of the service.
    ...(same[0]?.compat !== undefined && { compat: same[0].compat }),
  };
  return {
    model: { ...base, provider, baseUrl: endpoint.baseUrl },
    known: listed ? "listed" : known ? "relative" : "unknown",
  };
}

/**
 * What an answer took, as we keep it: the cost only where pi lists the prices of this very model or
 * the service billed it, the size of the context where pi knows the model at all.
 */
export function usageOf(usage: Usage | undefined, model: Model<Api>, known: Known): AnswerUsage {
  const billed = usage?.cost.totalFromProvider === true;
  const cost = usage && (billed || known === "listed") ? usage.cost.total : undefined;
  return {
    input: usage?.input ?? 0,
    output: usage?.output ?? 0,
    cacheRead: usage?.cacheRead ?? 0,
    cacheWrite: usage?.cacheWrite ?? 0,
    ...(cost !== undefined && Number.isFinite(cost) && { cost }),
    ...(known !== "unknown" && model.contextWindow > 0 && { window: model.contextWindow }),
  };
}

/** Our record of what an answer took, as pi has it, for what pi works out from it. */
function piUsage(usage: AnswerUsage | undefined): Usage {
  if (!usage) return NO_USAGE;
  const { input, output, cacheRead, cacheWrite } = usage;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: input + output + cacheRead + cacheWrite,
    cost: { ...NO_USAGE.cost, total: usage.cost ?? 0 },
  };
}

/**
 * The closest model pi knows to one it does not, such as an earlier version of the same model:
 * "claude-fable-5" for "claude-fable-5-2". It has the same ways, and a newer version is no less.
 */
function relativeOf(models: readonly Model<Api>[], id: string): Model<Api> | undefined {
  const relatives = models.filter(
    (model) => id.startsWith(model.id) && /^[-.]/.test(id.slice(model.id.length)),
  );
  const closest = relatives.toSorted((a, b) => b.id.length - a.id.length)[0];
  return closest && { ...closest, id, name: id };
}

/**
 * What pi calls the provider of a kind of service. The same for what was said before, so that pi
 * knows an earlier answer came from where the next one goes.
 */
const providerOf = (service: string) => (service === FAKE ? FAKE : `aq-${service}`);
const FAKE = "fake";

const isFake = (endpoint: Endpoint | FakeEndpoint): endpoint is FakeEndpoint => "fake" in endpoint;

/** How much of an earlier call of a tool that is no more, and of its result, the model gets. */
const OLD_CALL_TEXT = 200;
const OLD_RESULT_TEXT = 300;

/**
 * The id of a call as it goes back to the service: for OpenAI's Responses only the call id, without
 * the id of its item, whose reasoning item our record does not keep (see `messagesOf`).
 */
const callIdOf = (protocol: string, id: string): string =>
  protocol === "openai-responses" ? (id.split("|")[0] ?? id) : id;

const cut = (text: string, most: number) => (text.length > most ? `${text.slice(0, most)}…` : text);

/**
 * Turns our record of the conversation into pi's messages. Calls of tools that the model does not
 * have now, such as those of the tools before these, go as text, as services refuse a call of a tool
 * that is not in the list: the calls and what came of them follow the answer as one message of the
 * user, and the answer keeps only its own words. The same record always gives the same messages, for
 * the caches.
 *
 * Our record keeps the words and calls of answers, not the reasoning items of OpenAI's Responses
 * (nor its `phase`, nor the signatures of Anthropic's thinking). A call there has an id of the item
 * after "|" (`call_…|fc_…`), and OpenAI checks that such an item comes with the reasoning item it
 * was paired with: without it, the next message is refused. So calls of that protocol go back with
 * their call id only (`callIdOf`), as pi does for calls of another model. Keeping answers as each
 * protocol has them, to send them back as they were, is a design of its own, still to come.
 */
function messagesOf(history: readonly ChatEntry[], tools: ReadonlySet<string>): Message[] {
  const stops: Record<AnswerEnd, AssistantMessage["stopReason"]> = {
    done: "stop",
    tools: "toolUse",
    length: "length",
    stopped: "aborted",
    failed: "error",
  };
  const messages: Message[] = [];
  /** Ids of calls as they go back, where they differ from the record, see `callIdOf`. */
  const ids = new Map<string, string>();
  /** The calls of tools no more, by id, and what each came to so far, as lines of text. */
  let old = new Map<string, string>();
  const flush = (at: number) => {
    if (old.size === 0) return;
    const text = `Earlier tool calls with the old tool set (no longer available) and their results:\n${[...old.values()].join("\n")}`;
    messages.push({ role: "user", content: text, timestamp: at });
    old = new Map();
  };
  for (const entry of history) {
    if (entry.role !== "tool") flush(entry.at);
    switch (entry.role) {
      case "user":
        messages.push({ role: "user", content: entry.text, timestamp: entry.at });
        break;
      case "tool": {
        const call = old.get(entry.call);
        if (call !== undefined) {
          const outcome = entry.ok ? "ok" : "error";
          old.set(entry.call, `${call} → ${outcome}: ${cut(entry.text, OLD_RESULT_TEXT)}`);
        } else {
          messages.push({
            role: "toolResult",
            toolCallId: ids.get(entry.call) ?? entry.call,
            toolName: entry.name,
            content: [{ type: "text", text: entry.text }],
            isError: !entry.ok,
            timestamp: entry.at,
          });
        }
        break;
      }
      case "assistant": {
        // What the model said stays its own: calls written as text would teach it to write calls.
        const current = entry.calls.filter((call) => tools.has(call.name));
        for (const call of entry.calls.filter(({ name }) => !tools.has(name))) {
          old.set(call.id, `- ${call.name} ${cut(JSON.stringify(call.args), OLD_CALL_TEXT)}`);
        }
        if (entry.text === "" && current.length === 0) break;
        // pi leaves out an answer that failed or got stopped anyway, and cannot go on after one: to
        // try again, the history has to end where the task was before it.
        if ((entry.end === "failed" || entry.end === "stopped") && entry.calls.length === 0) break;
        for (const call of current) {
          const id = callIdOf(entry.protocol, call.id);
          if (id !== call.id) ids.set(call.id, id);
        }
        messages.push({
          role: "assistant",
          content: [
            ...(entry.text ? [{ type: "text" as const, text: entry.text }] : []),
            ...current.map((call) => ({
              type: "toolCall" as const,
              id: ids.get(call.id) ?? call.id,
              name: call.name,
              arguments: call.args as never,
            })),
          ],
          api: entry.protocol,
          provider: providerOf(entry.service),
          model: entry.model,
          usage: piUsage(entry.usage),
          // An answer whose calls all went to text ended there, as far as the model is told.
          stopReason: entry.end === "tools" && current.length === 0 ? "stop" : stops[entry.end],
          timestamp: entry.at,
        });
        break;
      }
    }
  }
  flush(history.at(-1)?.at ?? 0);
  return messages;
}

const textOf = (content: readonly { readonly type: string; readonly text?: string }[]) =>
  content.flatMap((part) => (part.type === "text" && part.text ? [part.text] : [])).join("");

function endOf(message: AssistantMessage): AnswerEnd {
  switch (message.stopReason) {
    case "toolUse":
      return "tools";
    case "length":
      return "length";
    case "aborted":
      return "stopped";
    case "error":
      return "failed";
    default:
      return "done";
  }
}

/** The fake service of a test, as pi's pretend provider. */
function fakeProvider(endpoint: FakeEndpoint, results: () => readonly ToolEntry[]) {
  const cps = endpoint.charactersPerSecond;
  const faux = fauxProvider({
    provider: FAKE,
    models: [{ id: endpoint.model ?? FAKE }],
    ...(cps !== undefined && { tokensPerSecond: cps, tokenSize: { min: 1, max: 1 } }),
  });
  const step: FauxResponseStep = () => {
    endpoint.requests = (endpoint.requests ?? 0) + 1;
    const next = endpoint.fake.shift();
    const answer = typeof next === "function" ? next(results()) : next;
    if (!answer) return fauxAssistantMessage("（假的服务没有更多回答了）");
    if (answer.error !== undefined) {
      return fauxAssistantMessage([], { stopReason: "error", errorMessage: answer.error });
    }
    const calls = answer.calls ?? [];
    return fauxAssistantMessage(
      [
        ...(answer.thinking ? [fauxThinking(answer.thinking)] : []),
        ...(answer.text ? [fauxText(answer.text)] : []),
        ...calls.map((call) => fauxToolCall(call.name, call.args as never)),
      ],
      { stopReason: calls.length > 0 ? "toolUse" : "stop" },
    );
  };
  // Enough steps for any task: each one reads the script when its request comes.
  faux.setResponses(Array.from({ length: 1000 }, () => step));
  return faux;
}

/**
 * Runs one task: the prompt, then answers and tools until AI is done, fails, gets stopped or is told
 * to stop. It never throws: what goes wrong is in the result, without the key.
 */
export async function runTask(options: RunOptions): Promise<RunResult> {
  const { endpoint, signal, onEvent } = options;
  let key: string | undefined;
  const seen: ToolEntry[] = [];
  let service: string;
  let protocol: string;
  const models = createModels({ identity: IDENTITY });
  let model: Model<Api>;
  let known: Known = "unknown";
  if (isFake(endpoint)) {
    const faux = fakeProvider(endpoint, () => seen);
    models.setProvider(faux.provider);
    model = faux.getModel() as Model<Api>;
    service = FAKE;
    protocol = model.api;
  } else {
    service = endpoint.service;
    protocol = endpoint.protocol;
    const provider = providerOf(endpoint.service);
    try {
      ({ model, known } = await knownModelOf(endpoint, provider));
    } catch (error) {
      return { end: "failed", error: withoutKeys(String(error)) };
    }
    models.setProvider(
      createProvider({
        id: provider,
        name: endpoint.service,
        baseUrl: endpoint.baseUrl,
        auth: {
          apiKey: {
            name: "key",
            resolve: async () => ({ auth: key ? { apiKey: key } : {} }),
          },
        },
        models: [model],
        api: API[endpoint.protocol](),
      }),
    );
  }

  /** A tool of the last answer asked the user: the turn ends after its tools. */
  let asked = false;
  const tools: AgentTool[] = options.tools.map((tool) => ({
    name: tool.name,
    label: tool.label,
    description: tool.description,
    parameters: tool.parameters,
    executionMode: "sequential",
    // Our own check comes first, so that the model reads our error and not pi's.
    ...(tool.validate && {
      prepareArguments: (args: unknown) => {
        const error = tool.validate?.(args);
        if (error !== undefined) throw new Error(error);
        return args as never;
      },
    }),
    execute: async (_id, args) => {
      const output = await tool.run(args as Record<string, unknown>);
      if (output.terminate) asked = true;
      return {
        content: [{ type: "text", text: output.text }],
        details: output.data,
        ...(output.isError && { isError: true }),
      };
    },
  }));
  const names = new Set(options.tools.map((tool) => tool.name));
  const call = options.call ?? {};
  // "Off" is the least the model can think: off where it can be, else its lowest step (low for
  // GPT-6.1 Sol, which takes no "none"), as pi has the steps of each model.
  const wanted =
    call.reasoning === undefined ? undefined : clampThinkingLevel(model, call.reasoning);
  const reasoning = wanted === "off" ? undefined : wanted;
  const settings = {
    ...(reasoning !== undefined && { reasoning }),
    ...(call.maxOutputTokens !== undefined && { maxTokens: call.maxOutputTokens }),
    ...(call.temperature !== undefined && { temperature: call.temperature }),
    ...(call.cache !== undefined && { cacheRetention: call.cache }),
    ...(protocol === "anthropic-messages" &&
      call.anthropic?.thinkingDisplay !== undefined && {
        thinkingDisplay: call.anthropic.thinkingDisplay,
      }),
  };

  const agent = new Agent({
    initialState: {
      systemPrompt: options.system,
      model,
      tools,
      messages: messagesOf(options.history, names) as AgentMessage[],
    },
    streamFn: (request, context, streamOptions) => {
      // Through the relay, only where requests go changes, and what goes with them.
      const relay = isFake(endpoint) ? undefined : endpoint.relay;
      return models.streamSimple(
        relay ? { ...request, baseUrl: relay.baseUrl } : request,
        context,
        {
          ...streamOptions,
          ...settings,
          ...(relay && { headers: { ...streamOptions?.headers, ...relay.headers } }),
          // Retrying is for people to decide: a failure shows right away.
          maxRetries: 0,
        },
      );
    },
    getApiKey: async () => {
      key = await options.key();
      // Some servers of one's own need no key, and their libraries still want one.
      return key || (isFake(endpoint) ? undefined : "none");
    },
    toolExecution: "sequential",
    identity: IDENTITY,
    beforeToolCall: async ({ toolCall }) => {
      const no = options.before?.({ id: toolCall.id, name: toolCall.name });
      return no ? { block: true, reason: no.reason, terminate: no.stop } : undefined;
    },
    finishTurn: () => (asked || options.enough?.() ? { action: "end" } : undefined),
  });

  const clean = (text: string) => withoutKeys(text, [key]);
  const stamp = options.stamp ?? {};
  let thinking = "";
  /** When the thinking of this answer began, and how long it went on. */
  let thoughtFrom: number | undefined;
  let thinkingMs: number | undefined;
  /** When each tool began, by call. */
  const toolStarts = new Map<string, number>();
  const thought = () => {
    if (thoughtFrom !== undefined && thinkingMs === undefined)
      thinkingMs = Date.now() - thoughtFrom;
  };
  agent.subscribe((event: AgentEvent) => {
    if (event.type === "turn_start") {
      thinking = "";
      thoughtFrom = undefined;
      thinkingMs = undefined;
      options.onAnswer?.();
    } else if (event.type === "message_update") {
      const update = event.assistantMessageEvent;
      if (update.type === "text_delta" || update.type === "toolcall_start") thought();
      if (update.type === "text_delta") onEvent({ type: "text", delta: update.delta });
      if (update.type === "thinking_delta" && update.delta !== "") {
        thoughtFrom ??= Date.now();
        thinking += update.delta;
        onEvent({ type: "thinking", delta: update.delta });
      }
    } else if (event.type === "tool_execution_start") {
      const args = (event.args ?? {}) as Record<string, unknown>;
      toolStarts.set(event.toolCallId, Date.now());
      onEvent({ type: "tool", id: event.toolCallId, name: event.toolName, args });
    } else if (event.type === "message_end") {
      const message = event.message as Message;
      if (message.role === "assistant") {
        thought();
        const error = message.errorMessage;
        onEvent({
          type: "entry",
          entry: {
            role: "assistant",
            text: textOf(message.content),
            calls: message.content.flatMap((part) =>
              part.type === "toolCall"
                ? [{ id: part.id, name: part.name, args: part.arguments }]
                : [],
            ),
            at: message.timestamp,
            end: endOf(message),
            ...(error !== undefined && message.stopReason === "error" && { error: clean(error) }),
            service,
            protocol,
            model: model.id,
            ...(thinking.trim() !== "" && { thinking: thinking.trim() }),
            ...(thinking.trim() !== "" && thinkingMs !== undefined && { thinkingMs }),
            ...(stamp.toolset !== undefined && { toolset: stamp.toolset }),
            ...(stamp.texts !== undefined && { texts: stamp.texts }),
            ...(stamp.pack !== undefined && { pack: stamp.pack }),
            usage: usageOf(message.usage, model, known),
            endedAt:
              message.durationMs === undefined
                ? Date.now()
                : message.timestamp + message.durationMs,
          },
        });
        thinking = "";
        thoughtFrom = undefined;
        thinkingMs = undefined;
      } else if (message.role === "toolResult") {
        const details = (message as { details?: unknown }).details;
        const startedAt = toolStarts.get(message.toolCallId);
        const entry: ToolEntry = {
          role: "tool",
          call: message.toolCallId,
          name: message.toolName,
          ok: !message.isError,
          text: clean(textOf(message.content)),
          at: message.timestamp,
          ...(startedAt !== undefined && { startedAt }),
          ...(typeof details === "object" &&
            details !== null && {
              data: details as Readonly<Record<string, unknown>>,
            }),
        };
        seen.push(entry);
        onEvent({ type: "entry", entry });
      }
    }
  });

  const stop = () => agent.abort();
  signal.addEventListener("abort", stop);
  try {
    if (signal.aborted) return { end: "stopped" };
    if (options.prompt === undefined) await agent.continue();
    else await agent.prompt(options.prompt);
  } catch (error) {
    return { end: "failed", error: clean(error instanceof Error ? error.message : String(error)) };
  } finally {
    signal.removeEventListener("abort", stop);
  }
  const last = agent.state.messages.findLast(
    (message): message is AssistantMessage => message.role === "assistant",
  );
  if (signal.aborted) return { end: "stopped" };
  if (!last) return { end: "failed", error: clean(agent.state.errorMessage ?? "") };
  const end = endOf(last);
  if (end === "failed") return { end, error: clean(last.errorMessage ?? "") };
  return { end };
}

/** How long a test of a model waits for its answer. */
export const TEST_TIMEOUT_MS = 20_000;

/** What asking a model for a word came to, see `testModel`. */
export type ModelTest =
  | { readonly ok: true; readonly ms: number; readonly text: string }
  | { readonly ok: false; readonly ms: number; readonly error: string };

/**
 * Asks a model to answer "OK" and nothing else, the way the chat asks it (straight or through the
 * relay), to see that the key, the address and the model work: at most 16 tokens, no retry, 20
 * seconds at most. It never throws, and what it says has no key in it.
 */
export async function testModel(
  endpoint: Endpoint,
  key: string | undefined,
  options: { readonly signal?: AbortSignal; readonly timeoutMs?: number } = {},
): Promise<ModelTest> {
  const started = Date.now();
  const clean = (text: string) => withoutKeys(text, [key]);
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), options.timeoutMs ?? TEST_TIMEOUT_MS);
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeout.signal])
    : timeout.signal;
  try {
    const provider = providerOf(endpoint.service);
    const model = await modelOf(endpoint, provider);
    const models = createModels({ identity: IDENTITY });
    models.setProvider(
      createProvider({
        id: provider,
        name: endpoint.service,
        baseUrl: endpoint.baseUrl,
        auth: {
          apiKey: {
            name: "key",
            // Some servers of one's own need no key, and their libraries still want one.
            resolve: async () => ({ auth: { apiKey: key || "none" } }),
          },
        },
        models: [model],
        api: API[endpoint.protocol](),
      }),
    );
    const relay = endpoint.relay;
    const message = await models.completeSimple(
      relay ? { ...model, baseUrl: relay.baseUrl } : model,
      { messages: [{ role: "user", content: "Reply with OK only.", timestamp: Date.now() }] },
      {
        maxTokens: 16,
        maxRetries: 0,
        cacheRetention: "none",
        signal,
        ...(relay && { headers: { ...relay.headers } }),
      },
    );
    const ms = Date.now() - started;
    if (message.stopReason === "error" || message.stopReason === "aborted") {
      const said = message.errorMessage ?? "";
      return {
        ok: false,
        ms,
        error: clean(timeout.signal.aborted ? `timeout after ${ms} ms ${said}`.trim() : said),
      };
    }
    return { ok: true, ms, text: clean(textOf(message.content)).trim().slice(0, 120) };
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    return { ok: false, ms: Date.now() - started, error: clean(message) };
  } finally {
    clearTimeout(timer);
  }
}
