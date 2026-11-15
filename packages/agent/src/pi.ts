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
  type ImageContent,
  type Message,
  type UserMessage,
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
import {
  NOT_ATTACHED,
  promptOf,
  type AnswerEnd,
  type AnswerUsage,
  type AssistantEntry,
  type AttachedImage,
  type ChatEntry,
  type ImageRef,
  type PackNote,
  type ToolEntry,
  type ToolPicture,
  type UserEntry,
} from "./entries.ts";
import type { ModelValues } from "./ai-settings.ts";
import type { ListedModel, ThinkingLevelMap } from "./model-discovery.ts";
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
  /**
   * What people set of the model, or a catalog filled in, over what pi knows of it: see
   * `applyModelSettings`. `baseUrl` and `api` of it are already in the endpoint's `baseUrl` and
   * `protocol`; `headers` are the service's and the model's together.
   */
  readonly settings?: ModelValues | undefined;
}

/** The headers the libraries of the protocols put a key in. */
const KEY_HEADERS = ["authorization", "x-api-key", "x-goog-api-key"] as const;

/**
 * The headers of a request to a service without a key: the libraries of the protocols, which want
 * one, put "none" in their key header, which goes empty here (a `null` takes a header away in
 * them), so that a server that takes its key in a header of people's own (`api-key: …`) gets only
 * that. One of people's own of the same name (`Authorization: Bearer …`) takes the place of the
 * library's: through the relay theirs go under its prefix, so the libraries' all go empty.
 */
export function keylessHeaders(
  key: string | undefined,
  own: Readonly<Record<string, string>> | undefined,
  relay?: Relayed,
): Record<string, string> {
  if (key) return {};
  const theirs = new Map(
    Object.entries(own ?? {}).map(([name, value]) => [name.toLowerCase(), value]),
  );
  return Object.fromEntries(
    KEY_HEADERS.map((each) => [each, (!relay?.passPrefix && theirs.get(each)) || null]),
  ) as unknown as Record<string, string>;
}

/** A service through the relay of the platform, see `Endpoint.relay`. */
export interface Relayed {
  readonly baseUrl: string;
  readonly headers: Readonly<Record<string, string>>;
  /**
   * What the relay takes headers of the model by, on their way to the service: it passes on only
   * those of the libraries of services otherwise. Without it they do not go through the relay.
   */
  readonly passPrefix?: string;
}

/** The model as it goes to the relay: its address, and its headers as the relay takes them. */
function relayed(model: Model<Api>, relay: Relayed): Model<Api> {
  const { headers, ...rest } = model;
  const prefix = relay.passPrefix;
  const passed =
    prefix && headers
      ? Object.fromEntries(
          Object.entries(headers).map(([name, value]) => [`${prefix}${name.toLowerCase()}`, value]),
        )
      : undefined;
  return { ...rest, baseUrl: relay.baseUrl, ...(passed && { headers: passed }) } as Model<Api>;
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
  /** Hears the messages of each request, as pi sends them: for tests of what the model gets. */
  readonly heard?: (messages: readonly unknown[]) => void;
}

/** What a tool said, for AI to read, and what it changed or found, for people. */
export interface ToolOutput {
  readonly text: string;
  readonly isError: boolean;
  /** For the summary of a turn: kept with the result, never sent to the model. */
  readonly data?: Readonly<Record<string, unknown>>;
  /** Pictures that go to the model before the text, kept where the host keeps pictures. */
  readonly images?: readonly ToolPicture[];
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

/**
 * Whether pictures go to the model, and where their bytes are read from. A model people did not
 * say about (`ModelValues.image`) is tried with them: the service says so where it takes none.
 */
export interface Pictures {
  readonly sees: boolean;
  /** The bytes of a picture, as base64; nothing where they are not here, and its line goes alone. */
  readonly read: (
    ref: ImageRef,
  ) => Promise<{ readonly data: string; readonly mimeType: string } | undefined>;
}

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
  /** The pictures that go with the prompt, whose lines go after its words. */
  readonly images?: readonly AttachedImage[];
  /** Whether pictures go to the model, see `Pictures`; without it, only their lines. */
  readonly pictures?: Pictures;
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
      maxTokens: model.maxTokens,
      cost: {
        input: model.cost.input,
        output: model.cost.output,
        cacheRead: model.cost.cacheRead,
        cacheWrite: model.cost.cacheWrite,
      },
      reasoning: model.reasoning,
      image: model.input.includes("image"),
      ...(model.thinkingLevelMap && {
        thinkingLevelMap: { ...model.thinkingLevelMap } as ThinkingLevelMap,
      }),
      ...(model.compat && { compat: { ...model.compat } as Readonly<Record<string, unknown>> }),
    }))
    .toSorted((a, b) => a.id.localeCompare(b.id));
}

/**
 * The model as pi takes it, with what people set or a catalog filled in over what pi knows
 * (`base`): its name, whether it thinks and takes pictures, how much it reads and writes, its
 * prices, how each step of reasoning is sent (the map as a whole: people's replaces pi's), the
 * largest picture, headers on top of pi's, and switches of the protocol on top of pi's. Where the
 * model is and how it is talked to are the endpoint's (`Endpoint.baseUrl`, `protocol`). The same
 * for the browser and for the cloud: both build the model with this.
 */
export function applyModelSettings(
  base: Model<Api>,
  settings: ModelValues | undefined,
): Model<Api> {
  if (!settings) return base;
  const {
    name,
    reasoning,
    image,
    contextWindow,
    maxTokens,
    imageMaxBytes,
    cost,
    headers,
    compat,
    thinkingLevelMap,
  } = settings;
  const input: Model<Api>["input"] =
    image === undefined
      ? base.input
      : image
        ? [...new Set([...base.input, "text" as const, "image" as const])]
        : base.input.filter((kind) => kind !== "image");
  const limits = base.inputLimits;
  return {
    ...base,
    ...(name !== undefined && { name }),
    ...(reasoning !== undefined && { reasoning }),
    input,
    ...(contextWindow !== undefined && { contextWindow }),
    ...(maxTokens !== undefined && { maxTokens }),
    ...(cost && { cost: { ...base.cost, ...cost } }),
    ...(thinkingLevelMap !== undefined && { thinkingLevelMap: { ...thinkingLevelMap } }),
    ...(imageMaxBytes !== undefined && {
      inputLimits: {
        ...limits,
        images: {
          ...limits?.images,
          resize: { ...limits?.images?.resize, maxBytes: imageMaxBytes },
        },
      },
    }),
    ...(headers && Object.keys(headers).length > 0 && { headers: { ...base.headers, ...headers } }),
    ...(compat && { compat: { ...base.compat, ...compat } as Model<Api>["compat"] }),
  } as Model<Api>;
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

/**
 * The model of an endpoint as pi takes it, with everything people set of it: what the browser's
 * chat and the cloud's AI both send with (see `applyModelSettings`).
 */
export async function piModelOf(endpoint: Endpoint): Promise<Model<Api>> {
  return modelOf(endpoint, providerOf(endpoint.service));
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
  const model = applyModelSettings(
    { ...base, provider, baseUrl: endpoint.baseUrl, api: endpoint.protocol },
    endpoint.settings,
  );
  // Prices people gave, or a catalog filled in, are this very model's; so is a size they gave.
  const settled = endpoint.settings;
  return {
    model,
    known:
      listed || settled?.cost
        ? "listed"
        : known || settled?.contextWindow !== undefined
          ? "relative"
          : "unknown",
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

/**
 * How many pictures of a conversation go with a request at most: the most recent. Each is about
 * 1,600 tokens again with every request; the others go as their lines.
 */
export const MOST_PICTURES_SENT = 6;

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
function messagesOf(
  history: readonly ChatEntry[],
  tools: ReadonlySet<string>,
  said: (entry: UserEntry, at: number) => UserMessage["content"] = (entry) => promptOf(entry),
  shown: (entry: ToolEntry, at: number) => ToolResultContent = (entry) => [
    { type: "text", text: toolText(entry) },
  ],
): Message[] {
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
  for (const [index, entry] of history.entries()) {
    if (entry.role !== "tool") flush(entry.at);
    switch (entry.role) {
      case "user":
        messages.push({ role: "user", content: said(entry, index), timestamp: entry.at });
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
            content: shown(entry, index),
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

type ToolResultContent = Extract<Message, { role: "toolResult" }>["content"];

/** The pictures of a tool that go to the model: not those for people only. */
const sentPictures = (entry: Pick<ToolEntry, "images">): readonly ToolPicture[] =>
  (entry.images ?? []).filter((image) => !image.forPeople);

/**
 * What a tool said, with the line of each of its pictures that does not go with it, and why: the
 * words of the result already say which picture is which.
 */
function toolText(
  entry: Pick<ToolEntry, "text" | "images">,
  missing: (image: ToolPicture, index: number) => string | undefined = () => NOT_ATTACHED.missing,
): string {
  const notes = sentPictures(entry).flatMap((image, index) => {
    const why = missing(image, index);
    return why === undefined ? [] : [`${image.note.replace(/\]$/, "")} — not attached: ${why}]`];
  });
  return notes.length === 0 ? entry.text : `${notes.join("\n")}\n${entry.text}`;
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
  const step: FauxResponseStep = (context) => {
    endpoint.requests = (endpoint.requests ?? 0) + 1;
    endpoint.heard?.(context.messages);
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

  // A model people did not say about is tried with pictures: pi would put words in their place.
  const pictures = options.pictures;
  if (pictures?.sees && !model.input.includes("image")) {
    model = { ...model, input: [...model.input, "image"] };
  }
  // Each picture of the conversation and of the prompt where it is: only the most recent go again
  // with every request, the others as their lines, so that a long conversation does not fill up.
  const places = [
    ...options.history.flatMap((entry, at) =>
      entry.role === "user"
        ? (entry.images ?? []).map((image, index) => ({ at, index, image: image as ImageRef }))
        : entry.role === "tool"
          ? sentPictures(entry).map((image, index) => ({ at, index, image: image as ImageRef }))
          : [],
    ),
    ...(options.images ?? []).map((image, index) => ({ at: -1, index, image: image as ImageRef })),
  ];
  const placeOf = (at: number, index: number) => `${at}/${index}`;
  const recent = new Set(
    places.slice(-MOST_PICTURES_SENT).map(({ at, index }) => placeOf(at, index)),
  );
  /** The pictures read for this task, by their hash. */
  const loaded = new Map<string, ImageContent>();
  if (pictures?.sees) {
    for (const { at, index, image } of places) {
      if (!recent.has(placeOf(at, index)) || loaded.has(image.image)) continue;
      const read = await pictures.read(image).catch(() => undefined);
      if (read)
        loaded.set(image.image, { type: "image", data: read.data, mimeType: read.mimeType });
    }
  }
  const why = (at: number) => (image: ImageRef, index: number) =>
    !pictures?.sees
      ? pictures
        ? NOT_ATTACHED.blind
        : NOT_ATTACHED.missing
      : !recent.has(placeOf(at, index))
        ? NOT_ATTACHED.older
        : !loaded.has(image.image)
          ? NOT_ATTACHED.missing
          : undefined;
  /** What people said in a message, with the pictures that go, and the lines of those that do not. */
  const said = (entry: Pick<UserEntry, "text" | "images">, at: number): UserMessage["content"] => {
    const text = promptOf(entry, why(at));
    const images = (entry.images ?? []).flatMap((image, index) => {
      const content = why(at)(image, index) === undefined ? loaded.get(image.image) : undefined;
      return content ? [content] : [];
    });
    return images.length === 0 ? text : [{ type: "text", text }, ...images];
  };
  /** What a tool said, its pictures first, as far as they go: the newest ones, to a model that sees. */
  const shown = (entry: ToolEntry, at: number): ToolResultContent => {
    const images = sentPictures(entry).flatMap((image, index) => {
      const content = why(at)(image, index) === undefined ? loaded.get(image.image) : undefined;
      return content ? [content] : [];
    });
    return [...images, { type: "text", text: toolText(entry, why(at)) }];
  };
  /** The pictures of the calls of this task, by call, as they go to the record of the conversation. */
  const pictured = new Map<
    string,
    { readonly images: readonly ToolPicture[]; readonly text: string }
  >();

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
    execute: async (id, args) => {
      const output = await tool.run(args as Record<string, unknown>);
      if (output.terminate) asked = true;
      const images = output.images ?? [];
      if (images.length > 0) pictured.set(id, { images, text: output.text });
      // What it rendered goes to a model that sees pictures; the others get the lines only.
      const sent: ImageContent[] = [];
      const missing = new Map<ToolPicture, string>();
      for (const image of sentPictures(output)) {
        const read = pictures?.sees ? await pictures.read(image).catch(() => undefined) : undefined;
        if (read) sent.push({ type: "image", data: read.data, mimeType: read.mimeType });
        else missing.set(image, pictures?.sees ? NOT_ATTACHED.missing : NOT_ATTACHED.blind);
      }
      return {
        content: [...sent, { type: "text", text: toolText(output, (image) => missing.get(image)) }],
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
    // What a pack asks for is never more than the model writes at most, as people set it.
    ...(call.maxOutputTokens !== undefined && {
      maxTokens:
        model.maxTokens > 0
          ? Math.min(call.maxOutputTokens, model.maxTokens)
          : call.maxOutputTokens,
    }),
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
      messages: messagesOf(options.history, names, said, shown) as AgentMessage[],
    },
    streamFn: (request, context, streamOptions) => {
      // Through the relay, only where requests go changes, and what goes with them.
      const relay = isFake(endpoint) ? undefined : endpoint.relay;
      const keyHeaders = isFake(endpoint)
        ? {}
        : keylessHeaders(key, endpoint.settings?.headers, relay);
      return models.streamSimple(relay ? relayed(request as Model<Api>, relay) : request, context, {
        ...streamOptions,
        ...settings,
        headers: { ...streamOptions?.headers, ...relay?.headers, ...keyHeaders },
        // Retrying is for people to decide: a failure shows right away.
        maxRetries: 0,
      });
    },
    getApiKey: async () => {
      key = await options.key();
      // Some servers of one's own need no key, and their libraries still want one: it goes empty
      // on the way (`keylessHeaders`).
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
        const kept = pictured.get(message.toolCallId);
        const entry: ToolEntry = {
          role: "tool",
          call: message.toolCallId,
          name: message.toolName,
          ok: !message.isError,
          // The words as the tool said them: which pictures went is for each request to say.
          text: clean(kept ? kept.text : textOf(message.content)),
          ...(kept && { images: kept.images }),
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
    else {
      const content = said({ text: options.prompt, images: options.images ?? [] }, -1);
      await agent.prompt({ role: "user", content, timestamp: Date.now() } as AgentMessage);
    }
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
  return askModel(endpoint, key, { ...options, prompt: "Reply with OK only.", maxTokens: 16 });
}

/** A picture of 16 by 16 red pixels, as PNG, for the test of a model that takes pictures. */
export const RED_PICTURE =
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR42mP4z8BAEmIY1TCqYfhqAACQ+f8B8u7oVwAAAABJRU5ErkJggg==";

/**
 * Asks a model that should take pictures what colour a small red one is, the way the chat asks it:
 * only an answer that names the colour shows that it does (docs/design/settings-and-properties.md
 * of AnimaQuill Cloud, 6.4). Never throws, as `testModel`.
 */
export async function testModelPicture(
  endpoint: Endpoint,
  key: string | undefined,
  options: { readonly signal?: AbortSignal; readonly timeoutMs?: number } = {},
): Promise<ModelTest> {
  return askModel(endpoint, key, {
    ...options,
    prompt: "What colour is this picture? Answer with one word.",
    picture: { data: RED_PICTURE, mimeType: "image/png" },
    maxTokens: 16,
  });
}

/** What to ask a model in one small request, see `askModel`. */
export interface SmallAsk {
  readonly prompt: string;
  /** A picture that goes with it, as base64. */
  readonly picture?: { readonly data: string; readonly mimeType: string };
  readonly maxTokens: number;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  /** At most this many characters of the answer come back. */
  readonly maxChars?: number;
}

/**
 * One small request to a model, the way the chat asks it (straight or through the relay), with no
 * tools, no retry and no cache: such as a test, or the title of a conversation. It never throws,
 * and what it says has no key in it.
 */
export async function askModel(
  endpoint: Endpoint,
  key: string | undefined,
  options: SmallAsk,
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
            resolve: async () => ({
              auth: { apiKey: key || "none" },
            }),
          },
        },
        models: [model],
        api: API[endpoint.protocol](),
      }),
    );
    const relay = endpoint.relay;
    const message = await models.completeSimple(
      relay ? relayed(model, relay) : model,
      {
        messages: [
          {
            role: "user",
            content: options.picture
              ? [
                  { type: "text", text: options.prompt },
                  { type: "image", data: options.picture.data, mimeType: options.picture.mimeType },
                ]
              : options.prompt,
            timestamp: Date.now(),
          },
        ],
      },
      {
        maxTokens: options.maxTokens,
        maxRetries: 0,
        cacheRetention: "none",
        signal,
        headers: { ...relay?.headers, ...keylessHeaders(key, endpoint.settings?.headers, relay) },
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
    const text = clean(textOf(message.content)).trim();
    return { ok: true, ms, text: text.slice(0, options.maxChars ?? 120) };
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    return { ok: false, ms: Date.now() - started, error: clean(message) };
  } finally {
    clearTimeout(timer);
  }
}
