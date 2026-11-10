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
  createModels,
  createProvider,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
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
import type { AnswerEnd, AssistantEntry, ChatEntry, ToolEntry } from "./entries.ts";
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
  /** How fast it writes, to have time to stop it. Without it, all at once. */
  readonly charactersPerSecond?: number;
  /** How many requests it got. */
  requests?: number;
}

/** A tool, as AI sees it and as the editor runs it. Failing is throwing, with what AI should read. */
export interface ToolSpec {
  readonly name: string;
  /** For people. */
  readonly label: string;
  /** For AI, which picks tools by it. */
  readonly description: string;
  /** JSON Schema, checked before `run`: what does not fit goes back to AI and does not run. */
  readonly parameters: Record<string, unknown>;
  run(args: Record<string, unknown>): Promise<string>;
}

/** What happens while AI answers, in the order it happens. */
export type RunEvent =
  | { readonly type: "text"; readonly delta: string }
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
  /** The conversation so far. */
  readonly history: readonly ChatEntry[];
  readonly prompt: string;
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

/** The models pi knows of for a service, for people to pick from. */
export async function knownModels(
  catalog: string | undefined,
  protocol: Protocol,
): Promise<readonly { readonly id: string; readonly name: string }[]> {
  const models = Object.values(await catalogOf(catalog));
  return models
    .filter((model) => model.api === protocol)
    .map(({ id, name }) => ({ id, name }))
    .toSorted((a, b) => a.id.localeCompare(b.id));
}

/**
 * The model as pi wants it. What pi knows of it helps, such as how long its answers can be and how
 * its service differs from the protocol. A model pi does not know gets what is safe for most.
 */
async function modelOf(endpoint: Endpoint, provider: string): Promise<Model<Api>> {
  const catalog = await catalogOf(endpoint.catalog);
  const same = Object.values(catalog).filter((model) => model.api === endpoint.protocol);
  const known = same.find((model) => model.id === endpoint.model);
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
  return { ...base, provider, baseUrl: endpoint.baseUrl };
}

/**
 * What pi calls the provider of a kind of service. The same for what was said before, so that pi
 * knows an earlier answer came from where the next one goes.
 */
const providerOf = (service: string) => (service === FAKE ? FAKE : `aq-${service}`);
const FAKE = "fake";

const isFake = (endpoint: Endpoint | FakeEndpoint): endpoint is FakeEndpoint => "fake" in endpoint;

/** Turns our record of the conversation into pi's messages. */
function messagesOf(history: readonly ChatEntry[]): Message[] {
  const stops: Record<AnswerEnd, AssistantMessage["stopReason"]> = {
    done: "stop",
    tools: "toolUse",
    length: "length",
    stopped: "aborted",
    failed: "error",
  };
  return history.map((entry): Message => {
    switch (entry.role) {
      case "user":
        return { role: "user", content: entry.text, timestamp: entry.at };
      case "tool":
        return {
          role: "toolResult",
          toolCallId: entry.call,
          toolName: entry.name,
          content: [{ type: "text", text: entry.text }],
          isError: !entry.ok,
          timestamp: entry.at,
        };
      case "assistant":
        return {
          role: "assistant",
          content: [
            ...(entry.text ? [{ type: "text" as const, text: entry.text }] : []),
            ...entry.calls.map((call) => ({
              type: "toolCall" as const,
              id: call.id,
              name: call.name,
              arguments: call.args as never,
            })),
          ],
          api: entry.protocol,
          provider: providerOf(entry.service),
          model: entry.model,
          usage: NO_USAGE,
          stopReason: stops[entry.end],
          timestamp: entry.at,
        };
    }
  });
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
    models: [{ id: FAKE }],
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
      model = await modelOf(endpoint, provider);
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

  const tools: AgentTool[] = options.tools.map((tool) => ({
    name: tool.name,
    label: tool.label,
    description: tool.description,
    parameters: tool.parameters,
    executionMode: "sequential",
    execute: async (_id, args) => {
      const text = await tool.run(args as Record<string, unknown>);
      return { content: [{ type: "text", text }], details: undefined };
    },
  }));

  const agent = new Agent({
    initialState: {
      systemPrompt: options.system,
      model,
      tools,
      messages: messagesOf(options.history) as AgentMessage[],
    },
    streamFn: (request, context, streamOptions) => {
      // Through the relay, only where requests go changes, and what goes with them.
      const relay = isFake(endpoint) ? undefined : endpoint.relay;
      return models.streamSimple(
        relay ? { ...request, baseUrl: relay.baseUrl } : request,
        context,
        {
          ...streamOptions,
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
    finishTurn: () => (options.enough?.() ? { action: "end" } : undefined),
  });

  const clean = (text: string) => withoutKeys(text, [key]);
  agent.subscribe((event: AgentEvent) => {
    if (event.type === "message_update") {
      const update = event.assistantMessageEvent;
      if (update.type === "text_delta") onEvent({ type: "text", delta: update.delta });
    } else if (event.type === "tool_execution_start") {
      const args = (event.args ?? {}) as Record<string, unknown>;
      onEvent({ type: "tool", id: event.toolCallId, name: event.toolName, args });
    } else if (event.type === "message_end") {
      const message = event.message as Message;
      if (message.role === "assistant") {
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
          },
        });
      } else if (message.role === "toolResult") {
        const entry: ToolEntry = {
          role: "tool",
          call: message.toolCallId,
          name: message.toolName,
          ok: !message.isError,
          text: clean(textOf(message.content)),
          at: message.timestamp,
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
    await agent.prompt(options.prompt);
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
