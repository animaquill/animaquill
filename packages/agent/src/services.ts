import { parseListedModels, type ListedModel } from "./model-discovery.ts";
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
  /** Where adding a service lists it. */
  readonly group: ServiceGroup;
  /**
   * The models a new service of this kind starts with, best first: its newest flagship and a
   * cheaper one, as far as pi knows them (see `recommendedOf`). Kinds without a catalog have none.
   */
  readonly recommended?: readonly string[];
}

/** How adding a service groups the kinds: the common ones, those in China, more, one's own. */
export type ServiceGroup = "common" | "china" | "more" | "own";
export const SERVICE_GROUPS: readonly ServiceGroup[] = ["common", "china", "more", "own"];

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
    group: "common",
    recommended: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"],
  },
  {
    id: "openai",
    name: "OpenAI",
    protocol: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
    catalog: "openai",
    route: "direct",
    tested: false,
    group: "common",
    recommended: ["gpt-6.1-sol", "gpt-6.1-terra", "gpt-6-luna"],
  },
  {
    id: "google",
    name: "Google Gemini",
    protocol: "google-generative-ai",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    catalog: "google",
    route: "direct",
    tested: true,
    group: "common",
    recommended: ["gemini-4-argon", "gemini-3.8-flash"],
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    protocol: "openai-completions",
    baseUrl: "https://api.deepseek.com",
    catalog: "deepseek",
    route: "direct",
    tested: true,
    group: "common",
    recommended: ["deepseek-v4-pro", "deepseek-flash"],
  },
  {
    id: "dashscope",
    name: "通义千问 DashScope",
    protocol: "openai-completions",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    route: "direct",
    tested: true,
    group: "china",
  },
  {
    id: "siliconflow",
    name: "硅基流动 SiliconFlow",
    protocol: "openai-completions",
    baseUrl: "https://api.siliconflow.cn/v1",
    route: "direct",
    tested: true,
    group: "china",
  },
  {
    id: "qianfan",
    name: "百度千帆",
    protocol: "openai-completions",
    baseUrl: "https://qianfan.baidubce.com/v2",
    route: "direct",
    tested: true,
    group: "china",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    protocol: "openai-completions",
    baseUrl: "https://openrouter.ai/api/v1",
    catalog: "openrouter",
    route: "direct",
    tested: false,
    group: "common",
    recommended: [
      "~openai/gpt-sol-latest",
      "~google/gemini-pro-latest",
      "~deepseek/deepseek-pro-latest",
    ],
  },
  {
    id: "xai",
    name: "xAI",
    protocol: "openai-responses",
    baseUrl: "https://api.x.ai/v1",
    catalog: "xai",
    route: "direct",
    tested: true,
    group: "more",
    recommended: ["grok-4.7"],
  },
  {
    id: "zai",
    name: "Z.ai",
    protocol: "openai-completions",
    baseUrl: "https://api.z.ai/api/paas/v4",
    catalog: "zai",
    route: "direct",
    tested: true,
    group: "more",
    recommended: ["glm-5.3", "glm-5.3-flash"],
  },
  {
    id: "groq",
    name: "Groq",
    protocol: "openai-completions",
    baseUrl: "https://api.groq.com/openai/v1",
    catalog: "groq",
    route: "direct",
    tested: true,
    group: "more",
    recommended: ["openai/gpt-oss-120b", "qwen/qwen3.8-27b"],
  },
  {
    id: "mistral",
    name: "Mistral",
    protocol: "mistral-conversations",
    baseUrl: "https://api.mistral.ai",
    catalog: "mistral",
    route: "direct",
    tested: true,
    group: "more",
    recommended: ["mistral-large-latest", "mistral-medium-latest"],
  },
  {
    id: "together",
    name: "Together",
    protocol: "openai-completions",
    baseUrl: "https://api.together.ai/v1",
    catalog: "together",
    route: "direct",
    tested: true,
    group: "more",
    recommended: ["moonshotai/Kimi-K3", "zai-org/GLM-5.3"],
  },
  {
    id: "huggingface",
    name: "Hugging Face",
    protocol: "openai-completions",
    baseUrl: "https://router.huggingface.co/v1",
    catalog: "huggingface",
    route: "direct",
    tested: true,
    group: "more",
    recommended: ["deepseek-ai/DeepSeek-V4-Pro", "moonshotai/Kimi-K2.6"],
  },
  {
    id: "cerebras",
    name: "Cerebras",
    protocol: "openai-completions",
    baseUrl: "https://api.cerebras.ai/v1",
    catalog: "cerebras",
    route: "direct",
    tested: false,
    group: "more",
    recommended: ["gpt-oss-120b", "qwen-3.8-27b"],
  },
  {
    id: "volcengine",
    name: "火山方舟",
    protocol: "openai-completions",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    route: "direct",
    tested: false,
    group: "china",
  },
  {
    id: "moonshot",
    name: "月之暗面 Kimi",
    protocol: "openai-completions",
    baseUrl: "https://api.moonshot.cn/v1",
    catalog: "moonshotai-cn",
    route: "relay",
    tested: true,
    group: "china",
    recommended: ["kimi-k3.1-pro", "kimi-k3"],
  },
  {
    id: "zhipu",
    name: "智谱 BigModel",
    protocol: "openai-completions",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    route: "relay",
    tested: true,
    group: "china",
  },
  {
    id: "minimax",
    name: "MiniMax",
    protocol: "anthropic-messages",
    baseUrl: "https://api.minimaxi.com/anthropic",
    catalog: "minimax-cn",
    route: "relay",
    tested: true,
    group: "china",
    recommended: ["MiniMax-M3", "MiniMax-M3.1-Flash"],
  },
  {
    id: "fireworks",
    name: "Fireworks",
    protocol: "openai-completions",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    catalog: "fireworks",
    route: "relay",
    tested: true,
    group: "more",
    recommended: ["accounts/fireworks/models/kimi-k3", "accounts/fireworks/models/glm-5p3"],
  },
  {
    id: "nvidia",
    name: "NVIDIA",
    protocol: "openai-completions",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    catalog: "nvidia",
    route: "relay",
    tested: true,
    group: "more",
    recommended: ["z-ai/glm-5.3-flash", "deepseek-ai/deepseek-v4.1-flash"],
  },
  {
    id: "openai-compatible",
    name: "OpenAI 兼容",
    protocol: "openai-completions",
    baseUrl: "",
    route: "direct",
    tested: false,
    custom: true,
    group: "own",
  },
  {
    id: "anthropic-compatible",
    name: "Anthropic 兼容",
    protocol: "anthropic-messages",
    baseUrl: "",
    route: "direct",
    tested: false,
    custom: true,
    group: "own",
  },
];

export const kindOf = (id: string): ServiceKind | undefined =>
  SERVICE_KINDS.find((kind) => kind.id === id);

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

export type ModelList =
  | { readonly ok: true; readonly models: readonly ListedModel[] }
  | { readonly ok: false; readonly failure: ServiceFailure };

interface ListRequest {
  readonly url: string;
  readonly headers: Record<string, string>;
}

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
      };
    case "google-generative-ai":
      return {
        url: `${baseUrl}/models?pageSize=1000`,
        headers: key ? { "x-goog-api-key": key } : {},
      };
    case "mistral-conversations":
      return { url: `${baseUrl}/v1/models`, headers: bearer };
    case "openai-responses":
    case "openai-completions":
      return { url: `${baseUrl}/models`, headers: bearer };
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
    return { ok: true, models: parseListedModels(await response.json()) };
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    return { ok: false, failure: failureOf(message, [key]) };
  }
}

/**
 * The models a new service starts with: those of its kind's `recommended` that the service has, or
 * else the first three it has, for people to choose from afterwards.
 */
export function recommendedOf(kind: ServiceKind, models: readonly ListedModel[]): string[] {
  const ids = new Set(models.map((model) => model.id));
  const listed = (kind.recommended ?? []).filter((id) => ids.has(id));
  return listed.length > 0 ? listed : models.slice(0, 3).map((model) => model.id);
}
