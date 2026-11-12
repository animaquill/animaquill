import { withoutKeys } from "./secrets.ts";

/**
 * AI services people bring themselves: which kinds there are, how each is reached, and what people
 * set up. Keys are not part of this, see `KeyStore` of the host.
 */

/** How a service is talked to. These are the ones the browser agent supports. */
export type Protocol =
  | "anthropic-messages"
  | "openai-responses"
  | "openai-completions"
  | "google-generative-ai"
  | "mistral-conversations";

export const PROTOCOLS: readonly Protocol[] = [
  "anthropic-messages",
  "openai-responses",
  "openai-completions",
  "google-generative-ai",
  "mistral-conversations",
];

/**
 * How the browser reaches a service: straight, or through the relay of the platform, which is for
 * services whose answers the browser may not read (no CORS). Only where the editor is hosted on a
 * platform, for people signed in to it: see `AiRelay` of the host.
 */
export type Route = "direct" | "relay";

export interface ServiceKind {
  readonly id: string;
  /** What the service calls itself. Names of products are not translated. */
  readonly name: string;
  readonly protocol: Protocol;
  /** Where it is, which people can change. Empty for services people point at themselves. */
  readonly baseUrl: string;
  /** What the library knows about the models of this service, by its name there. */
  readonly catalog?: string;
  /** How it is reached unless people say otherwise. */
  readonly route: Route;
  /**
   * Whether a browser was seen reading its answers. Others are worth a try, and get a hint when
   * they fail. See docs/research/pi-agent.md, section 3, of the closed repository.
   */
  readonly tested: boolean;
  /** People give the address, as for a server of their own. */
  readonly custom?: true;
}

/**
 * The kinds of services, and how each is reached by default: tested 2026-11-09 from Chrome with a
 * key that is not valid. Change this table when a service changes; people can change the route of
 * a service they set up, and nothing else depends on it.
 */
export const SERVICE_KINDS: readonly ServiceKind[] = [
  {
    id: "anthropic",
    name: "Anthropic",
    protocol: "anthropic-messages",
    baseUrl: "https://api.anthropic.com",
    catalog: "anthropic",
    route: "direct",
    tested: true,
  },
  {
    id: "openai",
    name: "OpenAI",
    protocol: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
    catalog: "openai",
    route: "direct",
    tested: false,
  },
  {
    id: "google",
    name: "Google Gemini",
    protocol: "google-generative-ai",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    catalog: "google",
    route: "direct",
    tested: true,
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    protocol: "openai-completions",
    baseUrl: "https://api.deepseek.com",
    catalog: "deepseek",
    route: "direct",
    tested: true,
  },
  {
    id: "dashscope",
    name: "通义千问 DashScope",
    protocol: "openai-completions",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    route: "direct",
    tested: true,
  },
  {
    id: "siliconflow",
    name: "硅基流动 SiliconFlow",
    protocol: "openai-completions",
    baseUrl: "https://api.siliconflow.cn/v1",
    route: "direct",
    tested: true,
  },
  {
    id: "qianfan",
    name: "百度千帆",
    protocol: "openai-completions",
    baseUrl: "https://qianfan.baidubce.com/v2",
    route: "direct",
    tested: true,
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    protocol: "openai-completions",
    baseUrl: "https://openrouter.ai/api/v1",
    catalog: "openrouter",
    route: "direct",
    tested: false,
  },
  {
    id: "xai",
    name: "xAI",
    protocol: "openai-responses",
    baseUrl: "https://api.x.ai/v1",
    catalog: "xai",
    route: "direct",
    tested: true,
  },
  {
    id: "zai",
    name: "Z.ai",
    protocol: "openai-completions",
    baseUrl: "https://api.z.ai/api/paas/v4",
    catalog: "zai",
    route: "direct",
    tested: true,
  },
  {
    id: "groq",
    name: "Groq",
    protocol: "openai-completions",
    baseUrl: "https://api.groq.com/openai/v1",
    catalog: "groq",
    route: "direct",
    tested: true,
  },
  {
    id: "mistral",
    name: "Mistral",
    protocol: "mistral-conversations",
    baseUrl: "https://api.mistral.ai",
    catalog: "mistral",
    route: "direct",
    tested: true,
  },
  {
    id: "together",
    name: "Together",
    protocol: "openai-completions",
    baseUrl: "https://api.together.ai/v1",
    catalog: "together",
    route: "direct",
    tested: true,
  },
  {
    id: "huggingface",
    name: "Hugging Face",
    protocol: "openai-completions",
    baseUrl: "https://router.huggingface.co/v1",
    catalog: "huggingface",
    route: "direct",
    tested: true,
  },
  {
    id: "cerebras",
    name: "Cerebras",
    protocol: "openai-completions",
    baseUrl: "https://api.cerebras.ai/v1",
    catalog: "cerebras",
    route: "direct",
    tested: false,
  },
  {
    id: "volcengine",
    name: "火山方舟",
    protocol: "openai-completions",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    route: "direct",
    tested: false,
  },
  {
    id: "moonshot",
    name: "月之暗面 Kimi",
    protocol: "openai-completions",
    baseUrl: "https://api.moonshot.cn/v1",
    catalog: "moonshotai-cn",
    route: "relay",
    tested: true,
  },
  {
    id: "zhipu",
    name: "智谱 BigModel",
    protocol: "openai-completions",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    route: "relay",
    tested: true,
  },
  {
    id: "minimax",
    name: "MiniMax",
    protocol: "anthropic-messages",
    baseUrl: "https://api.minimaxi.com/anthropic",
    catalog: "minimax-cn",
    route: "relay",
    tested: true,
  },
  {
    id: "fireworks",
    name: "Fireworks",
    protocol: "openai-completions",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    catalog: "fireworks",
    route: "relay",
    tested: true,
  },
  {
    id: "nvidia",
    name: "NVIDIA",
    protocol: "openai-completions",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    catalog: "nvidia",
    route: "relay",
    tested: true,
  },
  {
    id: "openai-compatible",
    name: "OpenAI 兼容",
    protocol: "openai-completions",
    baseUrl: "",
    route: "direct",
    tested: false,
    custom: true,
  },
  {
    id: "anthropic-compatible",
    name: "Anthropic 兼容",
    protocol: "anthropic-messages",
    baseUrl: "",
    route: "direct",
    tested: false,
    custom: true,
  },
];

export const kindOf = (id: string): ServiceKind | undefined =>
  SERVICE_KINDS.find((kind) => kind.id === id);

/** A service people set up. Its key is kept apart, by `id`. */
export interface ServiceConfig {
  readonly id: string;
  readonly kind: string;
  /** What people call it, such as "公司的 DeepSeek". */
  readonly name: string;
  readonly baseUrl: string;
  /** The model the chat uses. Empty until people pick one. */
  readonly model: string;
  readonly route: Route;
}

/** Everything about AI that people set up, apart from keys. Shared by all windows. */
export interface AiSettings {
  readonly services: readonly ServiceConfig[];
  /** The service the chat uses. */
  readonly current: string | undefined;
  /** How many tools one task can call at most, so that AI stuck in a loop stops on its own. */
  readonly maxToolCalls: number;
  /**
   * The settings list the model packs that are hidden (`ModelPack.hidden`), such as the words of
   * toolset 2026.1 to compare with, so that people can choose them for a model. A preference of
   * what to see only: which pack a model has is `packFor`.
   */
  readonly showHiddenPacks?: true;
  /**
   * The model pack people chose for a model, by the name of the model as services have it: for every
   * service that has it. A model without one gets the pack that is for it, see `choosePack`.
   */
  readonly packFor?: Readonly<Record<string, string>>;
}

export const DEFAULT_MAX_TOOL_CALLS = 50;
export const TOOL_CALL_LIMITS = { min: 1, max: 500 } as const;

export const EMPTY_AI_SETTINGS: AiSettings = {
  services: [],
  current: undefined,
  maxToolCalls: DEFAULT_MAX_TOOL_CALLS,
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function readService(value: unknown): ServiceConfig | undefined {
  if (!isRecord(value)) return undefined;
  const { id, kind, name, baseUrl, model, route } = value;
  if (typeof id !== "string" || typeof kind !== "string" || !kindOf(kind)) return undefined;
  if (typeof name !== "string" || typeof baseUrl !== "string" || typeof model !== "string") {
    return undefined;
  }
  if (route !== "direct" && route !== "relay") return undefined;
  return { id, kind, name, baseUrl, model, route };
}

/** Reads what was saved. Services that cannot be read are left out, not the rest of them. */
export function readAiSettings(value: unknown): AiSettings | undefined {
  if (!isRecord(value) || !Array.isArray(value.services)) return undefined;
  const services = value.services.map(readService).filter((service) => service !== undefined);
  const current =
    typeof value.current === "string" && services.some(({ id }) => id === value.current)
      ? value.current
      : services[0]?.id;
  const limit = value.maxToolCalls;
  const maxToolCalls =
    typeof limit === "number" && Number.isInteger(limit)
      ? Math.min(TOOL_CALL_LIMITS.max, Math.max(TOOL_CALL_LIMITS.min, limit))
      : DEFAULT_MAX_TOOL_CALLS;
  const packFor = readPackFor(value.packFor);
  return {
    services,
    current,
    maxToolCalls,
    ...(value.showHiddenPacks === true && { showHiddenPacks: true }),
    ...(packFor && { packFor }),
  };
}

/** People's choices of packs, as far as they are names of models and ids of packs. */
function readPackFor(value: unknown): Readonly<Record<string, string>> | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value).filter(
    ([model, pack]) =>
      model !== "" && typeof pack === "string" && /^[a-z0-9-]+\/[a-z0-9-]+$/.test(pack),
  );
  return entries.length > 0 ? Object.fromEntries(entries as [string, string][]) : undefined;
}

/** Only https, and plain http for this computer and the local network, where servers of one's own are. */
export function checkBaseUrl(text: string): string | undefined {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  if (url.username || url.password || url.search || url.hash) return undefined;
  return url.href.replace(/\/+$/, "");
}

/** Why talking to a service did not work, in a few kinds that call for different advice. */
export type FailureKind = "network" | "key" | "rate" | "notFound" | "server" | "other";

export interface ServiceFailure {
  readonly kind: FailureKind;
  /** What the service or the browser said, without keys. */
  readonly message: string;
}

const FAILURES: readonly [FailureKind, RegExp][] = [
  [
    "network",
    /failed to fetch|networkerror|load failed|connection error|fetch failed|err_[a-z_]+|\bcors\b|net::/i,
  ],
  [
    "key",
    /\b40[13]\b|api[ _-]?key|unauthori[sz]ed|authenticat|permission denied|invalid[_ ]?(?:x-)?api|incorrect api/i,
  ],
  ["rate", /\b429\b|rate[ _-]?limit|quota|too many requests|insufficient[_ ]balance/i],
  ["notFound", /\b404\b|not[ _]found|does not exist|no such model|unknown model/i],
  ["server", /\b5\d\d\b|overloaded|internal server error|bad gateway|unavailable/i],
];

/** What kind of failure a message tells of. */
export function failureOf(
  message: string,
  keys: Iterable<string | undefined> = [],
): ServiceFailure {
  const clean = withoutKeys(message, keys).slice(0, 2000);
  const kind = FAILURES.find(([, pattern]) => pattern.test(clean))?.[0] ?? "other";
  return { kind, message: clean };
}

export interface ListedModel {
  readonly id: string;
  readonly name?: string;
}

export type ModelList =
  | { readonly ok: true; readonly models: readonly ListedModel[] }
  | { readonly ok: false; readonly failure: ServiceFailure };

interface ListRequest {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly read: (body: unknown) => ListedModel[];
}

const idsIn = (body: unknown, field: string): ListedModel[] => {
  const list = isRecord(body) ? body[field] : undefined;
  if (!Array.isArray(list)) return [];
  return list.flatMap((item) => {
    if (!isRecord(item)) return [];
    const id = typeof item.id === "string" ? item.id : undefined;
    const name = typeof item.display_name === "string" ? item.display_name : undefined;
    return id ? [{ id, ...(name && name !== id && { name }) }] : [];
  });
};

function listRequest(protocol: Protocol, baseUrl: string, key: string): ListRequest {
  const bearer: Record<string, string> = key ? { authorization: `Bearer ${key}` } : {};
  switch (protocol) {
    case "anthropic-messages":
      return {
        url: `${baseUrl}/v1/models?limit=1000`,
        headers: {
          ...(key && { "x-api-key": key }),
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true",
        },
        read: (body) => idsIn(body, "data"),
      };
    case "google-generative-ai":
      return {
        url: `${baseUrl}/models?pageSize=1000`,
        headers: key ? { "x-goog-api-key": key } : {},
        read: (body) => {
          const list = isRecord(body) && Array.isArray(body.models) ? body.models : [];
          return list.flatMap((item: unknown) => {
            if (!isRecord(item) || typeof item.name !== "string") return [];
            const methods = item.supportedGenerationMethods;
            if (Array.isArray(methods) && !methods.includes("generateContent")) return [];
            const id = item.name.replace(/^models\//, "");
            const name = typeof item.displayName === "string" ? item.displayName : undefined;
            return [{ id, ...(name && { name }) }];
          });
        },
      };
    case "mistral-conversations":
      return { url: `${baseUrl}/v1/models`, headers: bearer, read: (body) => idsIn(body, "data") };
    case "openai-responses":
    case "openai-completions":
      return { url: `${baseUrl}/models`, headers: bearer, read: (body) => idsIn(body, "data") };
  }
}

/** Asks a service which models it has. */
export async function listModels(
  protocol: Protocol,
  baseUrl: string,
  key: string,
  options: {
    readonly signal?: AbortSignal;
    readonly fetch?: typeof fetch;
    /** What goes with the request besides the key, such as what the relay of the platform needs. */
    readonly headers?: Readonly<Record<string, string>>;
  } = {},
): Promise<ModelList> {
  const request = listRequest(protocol, baseUrl, key);
  const send = options.fetch ?? globalThis.fetch.bind(globalThis);
  try {
    const response = await send(request.url, {
      headers: { ...request.headers, ...options.headers },
      ...(options.signal && { signal: options.signal }),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      return { ok: false, failure: failureOf(`${response.status} ${body.slice(0, 500)}`, [key]) };
    }
    const models = request.read(await response.json());
    const sorted = models.toSorted((a, b) => a.id.localeCompare(b.id));
    return { ok: true, models: sorted };
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    return { ok: false, failure: failureOf(message, [key]) };
  }
}
