/**
 * Everything about AI that people set up, apart from keys: the services, the models they turned on
 * in each, the default model, and preferences. Shared by all windows, and one day by all devices of
 * an account, so reading it is strict and forgiving at once: what this editor does not know is kept
 * as it was and written back, and what a newer editor wrote is not written over at all.
 *
 * Version 1 (until 0.3.55) had one model per service and a service "in use" (`current`). Version 2
 * turns on any number of models per service and has one default model. It still writes `current`
 * and each service's `model`, so that a page of before that is still open keeps working. Version 3
 * (0.3.65) has everything of each model people set up or a catalog filled in (`ModelConfig`), and
 * for servers of one's own the protocol and headers; version 2 had only a size for models people
 * named themselves, which version 3 reads as theirs (docs/design/settings-and-properties.md of
 * AnimaQuill Cloud, 6.5). Pages of version 2 leave settings of version 3 alone (`newer`). Version 4
 * (0.3.72) keeps the address and headers of each service and model apart, with its key, as what is
 * secret of it (`ServiceSecret`): the settings as saved have none of them (`writeAiSettings`,
 * `secretsOf`), and they are put back as they are read (`withSecrets`). It has no header of its
 * own for the key either: what version 3 had of one becomes a header like any other
 * (`AiSettingsReading.keyHeaders`). Pages of version 3 leave settings of version 4 alone.
 */
import { COMPARISON_PACK_ID, REASONING } from "@animaquill/tools";
import type { ModelCost, ReasoningLevel, ThinkingLevelMap } from "./model-discovery.ts";
import { checkBaseUrl, kindOf, type Route } from "./services.ts";

export const AI_SETTINGS_VERSION = 4;

/** Headers people send a service or a model, by their names. */
export type Headers = Readonly<Record<string, string>>;

/**
 * What is secret of a service, kept apart from the settings with its key (see `KeyStore` of the
 * host): the key, the address, the headers, and the address and headers each model has of its own.
 */
export interface ServiceSecret {
  readonly key?: string;
  readonly baseUrl?: string;
  readonly headers?: Headers;
  readonly models?: Readonly<
    Record<string, { readonly baseUrl?: string; readonly headers?: Headers }>
  >;
}

/** The protocols people can choose for a server of their own, and for a model of any service. */
export const MODEL_APIS = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
] as const;
export type ModelApi = (typeof MODEL_APIS)[number];

/**
 * How a model differs from its protocol, as pi takes it (`Model.compat`): only what the settings
 * have a switch for. DeepSeek's way of thinking is two keys at once (`thinkingFormat` and
 * `requiresReasoningContentOnAssistantMessages`), one switch.
 */
export interface ModelCompat {
  readonly thinkingFormat?: "deepseek";
  readonly requiresReasoningContentOnAssistantMessages?: boolean;
  readonly supportsDeveloperRole?: boolean;
  readonly forceAdaptiveThinking?: boolean;
}

/**
 * What can be set for a model. Anything left out is as pi knows it of the model, or what is safe
 * for most where pi does not know it.
 */
export interface ModelValues {
  /** What people see it as. */
  readonly name?: string;
  /** It thinks before it answers. */
  readonly reasoning?: boolean;
  /** It takes pictures. */
  readonly image?: boolean;
  /** How many tokens it reads at once. */
  readonly contextWindow?: number;
  /** How many tokens one answer has at most. */
  readonly maxTokens?: number;
  /** The largest picture it takes, in bytes: larger ones are made smaller first. */
  readonly imageMaxBytes?: number;
  /** Dollars per million tokens: all four, or none. */
  readonly cost?: ModelCost;
  /** Where this model is, instead of where its service is. */
  readonly baseUrl?: string;
  /** How this model is talked to, instead of how its service is. */
  readonly api?: ModelApi;
  /** Headers of this model, on top of those of its service. */
  readonly headers?: Readonly<Record<string, string>>;
  readonly compat?: ModelCompat;
  /** How each step of reasoning is sent, and which it does not take, see `ThinkingLevelMap`. */
  readonly thinkingLevelMap?: ThinkingLevelMap;
}

/**
 * A cell of a model's settings as people see it, which a catalog can fill and people can change:
 * each step of reasoning is one (`thinking.<step>`), the four prices are one.
 */
export type ModelField =
  | "name"
  | "reasoning"
  | "image"
  | "contextWindow"
  | "maxTokens"
  | "cost"
  | `thinking.${ReasoningLevel}`;

export const MODEL_FIELDS: readonly ModelField[] = [
  "name",
  "reasoning",
  "image",
  "contextWindow",
  "maxTokens",
  "cost",
  ...REASONING.map((level) => `thinking.${level}` as const),
];

/** Where a catalog's values came from: the service's list of models, pi, or models.dev. */
export type CatalogSource = "service" | "pi" | "models.dev";
export const CATALOG_SOURCES: readonly CatalogSource[] = ["service", "pi", "models.dev"];

/** Why the price of models.dev was not taken, see `CatalogPrice` of the host. */
export type PriceDoubt = "no-exact-match" | "no-valid-price" | "insufficient-support" | "conflict";

/**
 * What a catalog filled in the last time: which cells and from where, and what the cells were
 * before, to undo it (`snapshot`: a cell that is not in it was empty).
 */
export interface CatalogFill {
  /** The catalogs that gave something, most trusted first. */
  readonly from: readonly CatalogSource[];
  /** How models.dev told which of its entries this model is. */
  readonly by?: "provider" | "base-url" | "consensus";
  /** The provider of models.dev it matched. */
  readonly matched?: string;
  /** Why models.dev's price was not taken, where it was not. */
  readonly priceDoubt?: PriceDoubt;
  readonly fields: readonly ModelField[];
  readonly snapshot: Readonly<Partial<Record<ModelField, unknown>>>;
}

/** A model of a service, as people set it up, see `ModelValues`. */
export interface ModelConfig extends ModelValues {
  /** Its name at the service: what requests ask for. */
  readonly id: string;
  /** How it came: named by hand, or picked from what the service listed. */
  readonly added?: "hand" | "service";
  /** What a catalog filled in last. */
  readonly filled?: CatalogFill;
  /** Cells people changed, which a catalog does not fill again. */
  readonly edited?: readonly ModelField[];
}

/** A service people set up. Its key is kept apart, by `id`. */
export interface ServiceConfig {
  readonly id: string;
  readonly kind: string;
  /** What people call it, such as "公司的 DeepSeek". */
  readonly name: string;
  readonly baseUrl: string;
  readonly route: Route;
  /** How a server of one's own is talked to, where people chose; else as its kind is. */
  readonly api?: ModelApi;
  /**
   * Headers that go with every request to it, such as what a gateway of a company wants, or the key
   * of a server of one's own that wants it in a header of its own (`api-key: …`).
   */
  readonly headers?: Readonly<Record<string, string>>;
  /**
   * When what is secret of it (`ServiceSecret`) last changed here, so that whatever reads the
   * settings knows to read that again: it is kept apart, and changes on its own.
   */
  readonly secretAt?: number;
  /** The models people turned on, by their names at the service, in order. */
  readonly enabled: readonly string[];
  /** The models that were on as people turned the whole service off, to turn on again. */
  readonly paused?: readonly string[];
  /** Models people added or set something of, by `id`. Those of pi's catalog need none. */
  readonly models?: readonly ModelConfig[];
}

/** A model of a service. */
export interface ModelRef {
  readonly service: string;
  readonly model: string;
}

/**
 * What this editor does not understand of the settings, kept to be written back as it was: fields
 * of a newer editor, and services it cannot read (of a kind it does not have, say). Anything named
 * like a secret is not kept: keys never belong here.
 */
export interface KeptSettings {
  readonly fields?: Readonly<Record<string, unknown>>;
  /** Fields of readable services that this editor does not know, by service. */
  readonly serviceFields?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  /** Fields of models that this editor does not know, by service and then model. */
  readonly modelFields?: Readonly<
    Record<string, Readonly<Record<string, Readonly<Record<string, unknown>>>>>
  >;
  readonly services?: readonly unknown[];
}

export interface AiSettings {
  readonly services: readonly ServiceConfig[];
  /** What a new conversation uses. Always a model that is on, while any is. */
  readonly default: ModelRef | undefined;
  /**
   * The models people keep at hand, first in the chat's list, in their order: the first of them is
   * what a new conversation uses (`default`), see `favoritesOf`. Pages of before keep it as a field
   * they do not know, and change only `default`, which `favoritesOf` takes as the first again.
   */
  readonly favorites?: readonly ModelRef[];
  /** How hard a model reasons unless a conversation says otherwise; else its pack says. */
  readonly reasoningFor?: Readonly<Record<string, ReasoningLevel>>;
  /**
   * The model pack people chose for a model, by the name of the model as services have it: for every
   * service that has it. A model without one gets the pack that is for it, see `choosePack`.
   */
  readonly packFor?: Readonly<Record<string, string>>;
  /**
   * The settings list the model packs that are hidden (`ModelPack.hidden`), such as the words of
   * toolset 2026.1 to compare with, so that people can choose them for a model. A preference of
   * what to see only: which pack a model has is `packFor`.
   */
  readonly showHiddenPacks?: true;
  /** How many tools one task can call at most, so that AI stuck in a loop stops on its own. */
  readonly maxToolCalls: number;
  /** A conversation gets a short title from the model after its first turn. */
  readonly autoTitle: boolean;
  /** Thinking shows in full rather than one line. */
  readonly expandThinking: boolean;
  /** Which key sends what was typed in the chat: Enter, unless people chose Ctrl+Enter (⌘ Enter). */
  readonly sendWith?: SendWith;
  /** How large a frame for the chat is at most on its longer side: 1568 unless people chose. */
  readonly shotSize?: ShotSide;
  /** How large the frames AI renders are where it does not say: medium unless people chose. */
  readonly lookSize?: "small" | "large";
  /** AI renders frames while people play, which it waits for unless people said not to. */
  readonly lookWhilePlaying?: true;
  /**
   * The earlier conversation is summed up by itself once the context is 80 % full, unless people
   * said not to (`false`).
   */
  readonly autoCompact?: false;
  /**
   * AI asks before each change of the project, and changes it only once people allow it ("AI 改项目
   * 前先问我", S-D4): off unless people turned it on. Only people change it: no tool does.
   */
  readonly askBeforeEdit?: true;
  /**
   * What a conversation does with messages of other conversations and AI tools
   * (docs/design/ai-teamwork.md of AnimaQuill Cloud, 3): takes them (without this), asks people
   * first, or takes none.
   */
  readonly fromAgents?: "ask" | "no";
  /**
   * A message to AI goes with what the editor shows (the clips selected and the playhead, which AI
   * reads with `aq_selection_read`) unless people took that off (`false`) under the box of the
   * chat, which stays so for their next messages.
   */
  readonly carrySelection?: false;
  readonly kept?: KeptSettings;
}

/** Which key sends a message: the other one makes a new line. */
export type SendWith = "enter" | "modEnter";

/** How large a frame for the chat is at most: 1568 pixels, 1024, or as the project has it. */
export type ShotSide = 1024 | 1568 | "original";

export const DEFAULT_MAX_TOOL_CALLS = 50;
export const TOOL_CALL_LIMITS = { min: 1, max: 500 } as const;
/** What a model people named reads at once, unless they said. */
export const DEFAULT_CONTEXT_WINDOW = 128_000;

export const EMPTY_AI_SETTINGS: AiSettings = {
  services: [],
  default: undefined,
  maxToolCalls: DEFAULT_MAX_TOOL_CALLS,
  autoTitle: true,
  expandThinking: false,
};

/** What reading the settings came to. */
export type AiSettingsReading =
  | {
      readonly kind: "ok";
      /**
       * What was read. A service of version 4 has no address and no headers until they are put
       * back from what is secret of it (`withSecrets`).
       */
      readonly settings: AiSettings;
      /** The version they were written in: 1, 2 and 3 are upgraded as they are read. */
      readonly from: 1 | 2 | 3 | 4;
      /** Headers that cannot be sent were left out, such as one with letters `fetch` refuses. */
      readonly headersLeftOut?: true;
      /**
       * They have addresses or headers in them, as versions before 4 do: those go into what is
       * secret of each service, and the settings are saved again without them.
       */
      readonly inline?: true;
      /**
       * The header a service's key went in, by service, as version 3 had it: the key goes into the
       * headers under that name (`keyIntoHeader`), and it is no key any more.
       */
      readonly keyHeaders?: Readonly<Record<string, string>>;
    }
  /** Written by a newer editor: not to be written over, see `readAiSettings`. */
  | { readonly kind: "newer" }
  /** Not settings at all. */
  | { readonly kind: "broken" };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Names of fields that hold a secret, which are never kept: see `KeptSettings`. Whole names only,
 * without case, `-` or `_`: `apiKey` and `refresh_token` go, `maxTokens` and `authType` stay.
 */
const SECRET =
  /^(?:(?:api|access|secret|private|client)?key|(?:access|auth|bearer|refresh|id|session)?token|(?:client)?secret|password|passwd|passphrase|credentials?|authorization|cookie)$/;

export const isSecretName = (name: string): boolean =>
  SECRET.test(name.toLowerCase().replaceAll(/[-_]/g, ""));

/** A value kept as it was, without anything in it under the name of a secret, however deep. */
function withoutSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutSecrets);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([name]) => !isSecretName(name))
      .map(([name, inner]) => [name, withoutSecrets(inner)]),
  );
}

function unknownFields(
  value: Record<string, unknown>,
  known: ReadonlySet<string>,
): Record<string, unknown> | undefined {
  const entries = Object.entries(value)
    .filter(([name]) => !known.has(name) && !isSecretName(name))
    .map(([name, inner]) => [name, withoutSecrets(inner)] as const);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

const TOP_FIELDS = new Set([
  "version",
  "services",
  "default",
  "favorites",
  "current",
  "reasoningFor",
  "packFor",
  "showHiddenPacks",
  "maxToolCalls",
  "autoTitle",
  "expandThinking",
  "sendWith",
  "shotSize",
  "lookSize",
  "lookWhilePlaying",
  "autoCompact",
  "askBeforeEdit",
  "fromAgents",
  "carrySelection",
]);
const SERVICE_FIELDS = new Set([
  "id",
  "kind",
  "name",
  "baseUrl",
  "route",
  "api",
  "headers",
  "keyHeader",
  "secretAt",
  "enabled",
  "paused",
  "models",
  "model",
]);
const MODEL_KEYS = new Set([
  "id",
  "added",
  "filled",
  "edited",
  "name",
  "reasoning",
  "image",
  "contextWindow",
  "maxTokens",
  "imageMaxBytes",
  "cost",
  "baseUrl",
  "api",
  "headers",
  "compat",
  "thinkingLevelMap",
]);

const isModelName = (value: unknown): value is string =>
  typeof value === "string" && value.trim() !== "" && value.length <= 200;

const positiveInteger = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;

const price = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value < 1e6
    ? value
    : undefined;

/** The most a value sent for a step of reasoning has, in characters. */
export const THINKING_VALUE_LENGTH = 10;
/** Header names as HTTP has them (a token), and what a value may have: what `fetch` takes. */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,100}$/;
const HEADER_VALUE = /^[\t\x20-\x7e]{0,4000}$/;
/** How many headers a service or a model has at most, and how long their values are together. */
export const MOST_HEADERS = 32;
export const MOST_HEADER_BYTES = 8 * 1024;
/**
 * Headers that are never people's own: those of the browser and the connection, and those of the
 * platform. A header named like a secret is theirs to send, such as the key of a server that wants
 * it in a header of its own: headers are kept as secret as keys.
 */
const NOT_A_HEADER =
  /^(?:host|cookie2?|set-cookie2?|user-agent|origin|referer|connection|keep-alive|content-length|content-type|transfer-encoding|te|trailer|upgrade|expect|accept-encoding|proxy-.*|sec-.*|x-forwarded-.*|forwarded|via|x-real-ip|true-client-ip|cf-connecting-ip|x-client-ip|x-animaquill.*|aq-.*|x-aq-.*)$/i;

/** Why a header cannot be one of people's own, or undefined where it can. */
export function headerProblem(name: string, value: string): "name" | "value" | undefined {
  if (!HEADER_NAME.test(name) || NOT_A_HEADER.test(name)) return "name";
  if (!HEADER_VALUE.test(value)) return "value";
  return undefined;
}

/** Whether headers together are too many or too long, see `MOST_HEADERS`. */
export function tooManyHeaders(headers: Readonly<Record<string, string>>): boolean {
  const values = Object.values(headers);
  const bytes = values.reduce((sum, value) => sum + value.length, 0);
  return values.length > MOST_HEADERS || bytes > MOST_HEADER_BYTES;
}

/** A name of a header the key went in, as version 3 had it. */
const isKeyHeader = (value: unknown): value is string =>
  typeof value === "string" && headerProblem(value, "") === undefined;

/**
 * The headers of a service once the key goes in one of them, as version 3 had it with a header of
 * its own for the key (`api-key`): `Authorization` gets `Bearer <key>`, any other the key itself.
 */
export function keyIntoHeader(headers: Headers | undefined, name: string, key: string): Headers {
  const value = name.toLowerCase() === "authorization" ? `Bearer ${key}` : key;
  const others = Object.entries(headers ?? {}).filter(
    ([each]) => each.toLowerCase() !== name.toLowerCase(),
  );
  return Object.fromEntries([...others, [name, value]]);
}

/** Whether reading the settings now left out a header that cannot be sent, see `readAiSettings`. */
let headersLeftOut = false;

function readHeaders(value: unknown): Readonly<Record<string, string>> | undefined {
  if (!isRecord(value)) return undefined;
  const headers: Record<string, string> = {};
  let bytes = 0;
  for (const [name, each] of Object.entries(value)) {
    if (typeof each !== "string" || headerProblem(name, each) !== undefined) {
      headersLeftOut = true;
      continue;
    }
    if (Object.keys(headers).length >= MOST_HEADERS || bytes + each.length > MOST_HEADER_BYTES) {
      headersLeftOut = true;
      break;
    }
    headers[name] = each;
    bytes += each.length;
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}

const isApi = (value: unknown): value is ModelApi => MODEL_APIS.includes(value as ModelApi);

function readCost(value: unknown): ModelCost | undefined {
  if (!isRecord(value)) return undefined;
  const input = price(value.input);
  const output = price(value.output);
  const cacheRead = price(value.cacheRead);
  const cacheWrite = price(value.cacheWrite);
  if (input === undefined || output === undefined) return undefined;
  return { input, output, cacheRead: cacheRead ?? 0, cacheWrite: cacheWrite ?? 0 };
}

function readThinking(value: unknown): ThinkingLevelMap | undefined {
  if (!isRecord(value)) return undefined;
  const map: Partial<Record<ReasoningLevel, string | null>> = {};
  for (const level of REASONING) {
    const said = value[level];
    if (said === null) map[level] = null;
    else if (
      typeof said === "string" &&
      said.trim() !== "" &&
      said.length <= THINKING_VALUE_LENGTH &&
      /^[\x21-\x7e]+$/.test(said)
    )
      map[level] = said;
  }
  return Object.keys(map).length > 0 ? map : undefined;
}

function readCompat(value: unknown): ModelCompat | undefined {
  if (!isRecord(value)) return undefined;
  const compat: Record<string, unknown> = {};
  if (value.thinkingFormat === "deepseek") compat.thinkingFormat = "deepseek";
  for (const name of [
    "requiresReasoningContentOnAssistantMessages",
    "supportsDeveloperRole",
    "forceAdaptiveThinking",
  ] as const) {
    if (typeof value[name] === "boolean") compat[name] = value[name];
  }
  return Object.keys(compat).length > 0 ? (compat as ModelCompat) : undefined;
}

const isField = (value: unknown): value is ModelField => MODEL_FIELDS.includes(value as ModelField);

const readFields = (value: unknown): ModelField[] =>
  Array.isArray(value) ? [...new Set(value.filter(isField))] : [];

function readFill(value: unknown): CatalogFill | undefined {
  if (!isRecord(value)) return undefined;
  const from = Array.isArray(value.from)
    ? CATALOG_SOURCES.filter((source) => (value.from as unknown[]).includes(source))
    : [];
  const fields = readFields(value.fields);
  if (from.length === 0 || fields.length === 0) return undefined;
  const snapshot = isRecord(value.snapshot)
    ? Object.fromEntries(Object.entries(value.snapshot).filter(([field]) => isField(field)))
    : {};
  const by = value.by;
  const doubt = value.priceDoubt;
  return {
    from,
    ...((by === "provider" || by === "base-url" || by === "consensus") && { by }),
    ...(typeof value.matched === "string" &&
      value.matched.length <= 200 && {
        matched: value.matched,
      }),
    ...((doubt === "no-exact-match" ||
      doubt === "no-valid-price" ||
      doubt === "insufficient-support" ||
      doubt === "conflict") && { priceDoubt: doubt }),
    fields,
    snapshot: withoutSecrets(snapshot) as CatalogFill["snapshot"],
  };
}

/**
 * A model as version 3 wrote it, or as version 2 wrote a model people named themselves (an id and
 * a size, which people gave). What does not make sense is left out, field by field.
 */
export function readModel(value: unknown): ModelConfig | undefined {
  if (!isRecord(value) || !isModelName(value.id)) return undefined;
  const name =
    typeof value.name === "string" && value.name.trim() !== "" && value.name.length <= 200
      ? value.name
      : undefined;
  const baseUrl =
    typeof value.baseUrl === "string" &&
    value.baseUrl.length <= 2000 &&
    // As people can give one: http(s), without a user, a password or a query.
    checkBaseUrl(value.baseUrl) !== undefined
      ? value.baseUrl
      : undefined;
  const headers = readHeaders(value.headers);
  const cost = readCost(value.cost);
  const compat = readCompat(value.compat);
  const thinkingLevelMap = readThinking(value.thinkingLevelMap);
  const filled = readFill(value.filled);
  const edited = readFields(value.edited);
  const contextWindow = positiveInteger(value.contextWindow);
  const maxTokens = positiveInteger(value.maxTokens);
  const imageMaxBytes = positiveInteger(value.imageMaxBytes);
  return {
    id: value.id,
    ...((value.added === "hand" || value.added === "service") && { added: value.added }),
    ...(name !== undefined && { name }),
    ...(typeof value.reasoning === "boolean" && { reasoning: value.reasoning }),
    ...(typeof value.image === "boolean" && { image: value.image }),
    ...(contextWindow !== undefined && { contextWindow }),
    ...(maxTokens !== undefined && { maxTokens }),
    ...(imageMaxBytes !== undefined && { imageMaxBytes }),
    ...(cost && { cost }),
    ...(baseUrl !== undefined && { baseUrl }),
    ...(isApi(value.api) && { api: value.api }),
    ...(headers && { headers }),
    ...(compat && { compat }),
    ...(thinkingLevelMap && { thinkingLevelMap }),
    ...(filled && { filled }),
    ...(edited.length > 0 && { edited }),
  };
}

/** The models of a service, each once; version 2's are models people named, with their size. */
function readModels(
  value: unknown,
  version: 1 | 2 | 3 | 4,
): { models: ModelConfig[] | undefined; extra: Record<string, Record<string, unknown>> } {
  const extra: Record<string, Record<string, unknown>> = {};
  if (!Array.isArray(value) || version === 1) return { models: undefined, extra };
  const seen = new Set<string>();
  const models = value.flatMap((item): ModelConfig[] => {
    const model = readModel(item);
    if (!model || seen.has(model.id)) return [];
    seen.add(model.id);
    if (version === 2)
      return [
        {
          id: model.id,
          added: "hand",
          ...(model.contextWindow !== undefined && {
            contextWindow: model.contextWindow,
            edited: ["contextWindow"],
          }),
        },
      ];
    const unknown = unknownFields(item as Record<string, unknown>, MODEL_KEYS);
    if (unknown) extra[model.id] = unknown;
    return [model];
  });
  return { models: models.length > 0 ? models : undefined, extra };
}

/**
 * A service as any version wrote it, or nothing where it cannot be read. Version 1 has the one
 * model in `model`, which becomes the one turned on. Version 4 has no address (an empty one until
 * what is secret of it is put back) and no header for the key.
 */
function readService(
  value: unknown,
  version: 1 | 2 | 3 | 4,
):
  | {
      service: ServiceConfig;
      modelFields: Record<string, Record<string, unknown>>;
      keyHeader?: string;
    }
  | undefined {
  if (!isRecord(value)) return undefined;
  const { id, kind, name, route } = value;
  if (typeof id !== "string" || id === "" || typeof kind !== "string" || !kindOf(kind)) {
    return undefined;
  }
  const baseUrl = version === 4 && value.baseUrl === undefined ? "" : value.baseUrl;
  if (typeof name !== "string" || typeof baseUrl !== "string") return undefined;
  if (route !== "direct" && route !== "relay") return undefined;
  let enabled: string[];
  if (version === 1) {
    if (typeof value.model !== "string") return undefined;
    enabled = value.model.trim() === "" ? [] : [value.model];
  } else {
    if (value.enabled !== undefined && !Array.isArray(value.enabled)) return undefined;
    enabled = [...new Set((value.enabled ?? []) as unknown[])].filter(isModelName);
  }
  const { models, extra } = readModels(value.models, version);
  const custom = kindOf(kind)?.custom === true;
  const headers = version >= 3 ? readHeaders(value.headers) : undefined;
  const paused =
    version >= 3 && Array.isArray(value.paused)
      ? [...new Set(value.paused as unknown[])].filter(isModelName)
      : [];
  return {
    service: {
      id,
      kind,
      name,
      baseUrl,
      route,
      ...(version >= 3 && custom && isApi(value.api) && { api: value.api }),
      ...(headers && { headers }),
      ...(version === 4 &&
        positiveInteger(value.secretAt) !== undefined && { secretAt: value.secretAt as number }),
      enabled,
      ...(paused.length > 0 && enabled.length === 0 && { paused }),
      ...(models && { models }),
    },
    modelFields: extra,
    ...(version >= 3 && custom && isKeyHeader(value.keyHeader) && { keyHeader: value.keyHeader }),
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

function readReasoningFor(value: unknown): Readonly<Record<string, ReasoningLevel>> | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value).filter(
    ([model, level]) =>
      model !== "" && typeof level === "string" && (REASONING as readonly string[]).includes(level),
  );
  return entries.length > 0 ? Object.fromEntries(entries as [string, ReasoningLevel][]) : undefined;
}

function readLimit(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value)
    ? Math.min(TOOL_CALL_LIMITS.max, Math.max(TOOL_CALL_LIMITS.min, value))
    : DEFAULT_MAX_TOOL_CALLS;
}

/** The first model that is on, in the order of the services. */
function firstEnabled(services: readonly ServiceConfig[]): ModelRef | undefined {
  for (const service of services) {
    const model = service.enabled[0];
    if (model !== undefined) return { service: service.id, model };
  }
  return undefined;
}

/** Whether a model is on in its service. */
export function isEnabled(services: readonly ServiceConfig[], ref: ModelRef | undefined): boolean {
  if (!ref) return false;
  return services.some(({ id, enabled }) => id === ref.service && enabled.includes(ref.model));
}

/**
 * The default model as it has to be: one that is on, while any is. Where the one wanted is not,
 * the first favorite that is, else the first model on.
 */
export function settledDefault(
  services: readonly ServiceConfig[],
  wanted: ModelRef | undefined,
  favorites: readonly ModelRef[] = [],
): ModelRef | undefined {
  if (isEnabled(services, wanted)) return wanted;
  return favorites.find((ref) => isEnabled(services, ref)) ?? firstEnabled(services);
}

const sameRef = (a: ModelRef | undefined, b: ModelRef | undefined): boolean =>
  a !== undefined && b !== undefined && a.service === b.service && a.model === b.model;

/**
 * The favorite models as the chat lists them: in people's order, each once, the default first —
 * where a page of before (which knows only `default`) made another model the default, that one
 * becomes the first favorite. Without favorites, none: the default alone is not one.
 */
export function favoritesOf(
  settings: Pick<AiSettings, "services" | "default" | "favorites">,
): readonly ModelRef[] {
  const listed: ModelRef[] = [];
  for (const ref of settings.favorites ?? []) {
    if (!listed.some((each) => sameRef(each, ref))) listed.push(ref);
  }
  if (listed.length === 0) return listed;
  const chosen = settings.default;
  const first = listed.find((ref) => isEnabled(settings.services, ref));
  if (!chosen || sameRef(first, chosen)) return listed;
  return [chosen, ...listed.filter((ref) => !sameRef(ref, chosen))];
}

function readFavorites(value: unknown): readonly ModelRef[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const refs = value.flatMap((ref) =>
    isRecord(ref) && typeof ref.service === "string" && isModelName(ref.model)
      ? [{ service: ref.service, model: ref.model }]
      : [],
  );
  return refs.length > 0 ? refs : undefined;
}

/**
 * Reads what was saved, of either version. What is not understood is kept (`KeptSettings`), not
 * dropped: services that cannot be read, fields of a newer editor. Settings of a version after this
 * one are "newer", to be left alone rather than read in part and written over: people are asked to
 * update the editor instead (decision 2026-11-11).
 */
export function readAiSettings(value: unknown): AiSettingsReading {
  headersLeftOut = false;
  if (!isRecord(value) || !Array.isArray(value.services)) return { kind: "broken" };
  const version = value.version;
  if (
    version !== undefined &&
    version !== 1 &&
    version !== 2 &&
    version !== 3 &&
    version !== AI_SETTINGS_VERSION
  ) {
    return { kind: "newer" };
  }
  const from = version === 4 ? 4 : version === 3 ? 3 : version === 2 ? 2 : 1;
  const keyHeaders: Record<string, string> = {};
  let inline = from < 4;
  const services: ServiceConfig[] = [];
  const unread: unknown[] = [];
  const serviceFields: Record<string, Readonly<Record<string, unknown>>> = {};
  const modelFields: Record<string, Record<string, Record<string, unknown>>> = {};
  const ids = new Set<string>();
  for (const raw of value.services) {
    const read = readService(raw, from);
    if (!read || ids.has(read.service.id)) {
      unread.push(withoutSecrets(raw));
      continue;
    }
    const { service } = read;
    ids.add(service.id);
    services.push(service);
    if (read.keyHeader !== undefined) keyHeaders[service.id] = read.keyHeader;
    if (
      from === 4 &&
      isRecord(raw) &&
      (raw.baseUrl !== undefined ||
        raw.headers !== undefined ||
        raw.keyHeader !== undefined ||
        (Array.isArray(raw.models) &&
          raw.models.some(
            (model) =>
              isRecord(model) && (model.baseUrl !== undefined || model.headers !== undefined),
          )))
    )
      inline = true;
    const extra = unknownFields(raw as Record<string, unknown>, SERVICE_FIELDS);
    if (extra) serviceFields[service.id] = extra;
    if (Object.keys(read.modelFields).length > 0) modelFields[service.id] = read.modelFields;
  }

  let packFor = readPackFor(value.packFor);
  let showHiddenPacks = value.showHiddenPacks === true;
  let wanted: ModelRef | undefined;
  if (from >= 2) {
    const chosen = value.default;
    wanted =
      isRecord(chosen) && typeof chosen.service === "string" && isModelName(chosen.model)
        ? { service: chosen.service, model: chosen.model }
        : undefined;
  } else {
    // The service in use, with its model; else the first that has one, as the chat would want.
    const current = services.find(({ id }) => id === value.current);
    const first = current?.enabled[0];
    wanted = current && first !== undefined ? { service: current.id, model: first } : undefined;
    // The words to compare with were a switch for every model: now they are a hidden pack, chosen
    // for each model that was on, and shown, so that nothing changes for who had it on.
    if (value.comparisonTexts === true) {
      showHiddenPacks = true;
      const chosen: Record<string, string> = { ...packFor };
      for (const service of services) {
        for (const model of service.enabled) chosen[model] ??= COMPARISON_PACK_ID;
      }
      packFor = Object.keys(chosen).length > 0 ? chosen : undefined;
    }
  }

  const reasoningFor = from >= 2 ? readReasoningFor(value.reasoningFor) : undefined;
  const favorites = from >= 2 ? readFavorites(value.favorites) : undefined;
  const fields = unknownFields(value, TOP_FIELDS);
  const kept: KeptSettings = {
    ...(fields && { fields }),
    ...(Object.keys(serviceFields).length > 0 && { serviceFields }),
    ...(Object.keys(modelFields).length > 0 && { modelFields }),
    ...(unread.length > 0 && { services: unread }),
  };
  const settings: AiSettings = {
    services,
    default: settledDefault(services, wanted, favorites),
    ...(favorites && { favorites }),
    ...(reasoningFor && { reasoningFor }),
    ...(packFor && { packFor }),
    ...(showHiddenPacks && { showHiddenPacks: true }),
    maxToolCalls: readLimit(value.maxToolCalls),
    autoTitle: typeof value.autoTitle === "boolean" ? value.autoTitle : true,
    expandThinking: value.expandThinking === true,
    ...(value.sendWith === "modEnter" && { sendWith: "modEnter" as const }),
    ...((value.shotSize === 1024 || value.shotSize === "original") && {
      shotSize: value.shotSize,
    }),
    ...((value.lookSize === "small" || value.lookSize === "large") && {
      lookSize: value.lookSize,
    }),
    ...(value.lookWhilePlaying === true && { lookWhilePlaying: true as const }),
    ...(value.autoCompact === false && { autoCompact: false as const }),
    ...(value.askBeforeEdit === true && { askBeforeEdit: true as const }),
    ...((value.fromAgents === "ask" || value.fromAgents === "no") && {
      fromAgents: value.fromAgents,
    }),
    ...(value.carrySelection === false && { carrySelection: false as const }),
    ...(Object.keys(kept).length > 0 && { kept }),
  };
  // Set while the services were read, which control flow does not see.
  const leftOut = headersLeftOut as boolean;
  return {
    kind: "ok",
    settings,
    from,
    ...(leftOut && { headersLeftOut: true as const }),
    ...(inline && services.length > 0 && { inline: true as const }),
    ...(Object.keys(keyHeaders).length > 0 && { keyHeaders }),
  };
}

/**
 * A model as it is saved: only what it has, with what was not understood back in place, and
 * without its address and headers, which are secret (`secretsOf`).
 */
export function writeModel(
  model: ModelConfig,
  kept?: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const { baseUrl: _baseUrl, headers: _headers, ...rest } = model;
  return {
    ...kept,
    ...Object.fromEntries(Object.entries(rest).filter(([, value]) => value !== undefined)),
  };
}

/**
 * What is secret of each service of the settings, by its id, but its key: its address, its
 * headers, and those of its models that have their own. See `ServiceSecret`.
 */
export function secretsOf(settings: Pick<AiSettings, "services">): Map<string, ServiceSecret> {
  const secrets = new Map<string, ServiceSecret>();
  for (const service of settings.services) {
    const models: Record<string, { baseUrl?: string; headers?: Headers }> = {};
    for (const model of service.models ?? []) {
      const own = {
        ...(model.baseUrl !== undefined && { baseUrl: model.baseUrl }),
        ...(model.headers && Object.keys(model.headers).length > 0 && { headers: model.headers }),
      };
      if (Object.keys(own).length > 0) models[model.id] = own;
    }
    secrets.set(service.id, {
      ...(service.baseUrl !== "" && { baseUrl: service.baseUrl }),
      ...(service.headers &&
        Object.keys(service.headers).length > 0 && { headers: service.headers }),
      ...(Object.keys(models).length > 0 && { models }),
    });
  }
  return secrets;
}

/**
 * The settings with what is secret of each service put back: its address and headers, and those of
 * its models. A service without any keeps what it has. What does not make sense of them is left
 * out, as it is of settings that are read.
 */
export function withSecrets(
  settings: AiSettings,
  secretOf: (service: string) => ServiceSecret | undefined,
): AiSettings {
  return {
    ...settings,
    services: settings.services.map((service) => {
      const secret = secretOf(service.id);
      if (!secret) return service;
      const headers = readHeaders(secret.headers);
      const baseUrl =
        typeof secret.baseUrl === "string" && secret.baseUrl.length <= 2000
          ? secret.baseUrl
          : service.baseUrl;
      const { headers: _headers, ...rest } = service;
      return {
        ...rest,
        baseUrl,
        ...(headers && { headers }),
        ...(service.models && {
          models: service.models.map((model) => {
            const own = secret.models?.[model.id];
            const { baseUrl: _url, headers: _own, ...plain } = model;
            if (!own) return plain;
            const read = readModel({ id: model.id, baseUrl: own.baseUrl, headers: own.headers });
            return {
              ...plain,
              ...(read?.baseUrl !== undefined && { baseUrl: read.baseUrl }),
              ...(read?.headers && { headers: read.headers }),
            };
          }),
        }),
      };
    }),
  };
}

/**
 * The settings as they are saved: version 4, without what is secret of the services (see
 * `secretsOf`), with what was not understood back in place, and with `current` and each service's
 * `model` as version 1 had them, for a page of before.
 */
export function writeAiSettings(settings: AiSettings): Record<string, unknown> {
  const { kept } = settings;
  const fallback = settledDefault(settings.services, settings.default, settings.favorites);
  const services = settings.services.map((service) => ({
    ...kept?.serviceFields?.[service.id],
    id: service.id,
    kind: service.kind,
    name: service.name,
    route: service.route,
    ...(service.api && { api: service.api }),
    ...(service.secretAt !== undefined && { secretAt: service.secretAt }),
    enabled: service.enabled,
    ...(service.paused && service.paused.length > 0 && { paused: service.paused }),
    ...(service.models &&
      service.models.length > 0 && {
        models: service.models.map((model) =>
          writeModel(model, kept?.modelFields?.[service.id]?.[model.id]),
        ),
      }),
    model: fallback?.service === service.id ? fallback.model : (service.enabled[0] ?? ""),
  }));
  return {
    ...kept?.fields,
    version: AI_SETTINGS_VERSION,
    services: [...services, ...(kept?.services ?? [])],
    ...(fallback && { default: fallback }),
    ...(settings.favorites && settings.favorites.length > 0 && { favorites: settings.favorites }),
    ...((fallback?.service ?? settings.services[0]?.id) !== undefined && {
      current: fallback?.service ?? settings.services[0]?.id,
    }),
    ...(settings.reasoningFor && { reasoningFor: settings.reasoningFor }),
    ...(settings.packFor && { packFor: settings.packFor }),
    ...(settings.showHiddenPacks && { showHiddenPacks: true }),
    maxToolCalls: settings.maxToolCalls,
    autoTitle: settings.autoTitle,
    expandThinking: settings.expandThinking,
    ...(settings.sendWith === "modEnter" && { sendWith: "modEnter" }),
    ...(settings.shotSize !== undefined &&
      settings.shotSize !== 1568 && { shotSize: settings.shotSize }),
    ...(settings.lookSize !== undefined && { lookSize: settings.lookSize }),
    ...(settings.lookWhilePlaying && { lookWhilePlaying: true }),
    ...(settings.autoCompact === false && { autoCompact: false }),
    ...(settings.askBeforeEdit && { askBeforeEdit: true }),
    ...(settings.fromAgents !== undefined && { fromAgents: settings.fromAgents }),
    ...(settings.carrySelection === false && { carrySelection: false }),
  };
}

/** Every model that is on, each name once, in the order of the services. */
export function enabledModelsOf(settings: Pick<AiSettings, "services">): string[] {
  return [...new Set(settings.services.flatMap((service) => service.enabled))];
}

/** How many models are on, in all services. */
export const enabledCountOf = (settings: Pick<AiSettings, "services">): number =>
  settings.services.reduce((count, service) => count + service.enabled.length, 0);

/**
 * Settings of version 2 again, after a page of version 1 (0.3.56 and before) wrote the settings
 * over: it reads the services in use and their model from what version 2 writes for it, and writes
 * back only those, which would leave one model per service. `latest` is what version 2 wrote last
 * (kept apart, where pages of before do not write), `old` what is saved now.
 *
 * What the page of before changed is told by what differs from `latest` as version 1 has it, which
 * is what that page read: names, addresses and routes, services it added or took away, a model it
 * picked (turned on, and the default if it was the one in use), the limit, the packs. Everything
 * else is as `latest` has it, also what neither version understands (`KeptSettings`), which that
 * page never saw. A page older still, without packs, leaves them as they were.
 *
 * It cannot tell a change of that page from a change made in version 2 after the page read: where
 * version 2 saved again before that page wrote, see `AiSettingsStore`, what it saved goes back.
 */
export function recoverOldWrite(latest: AiSettings, old: unknown): AiSettings | undefined {
  const reading = readAiSettings(old);
  if (reading.kind === "ok" && reading.from === 2 && isRecord(old)) {
    // Services the page wrote models of: in the others it said nothing of them at all (such as a
    // page that made its settings from the entries of an account, which has no models in them).
    const named = new Set(
      (Array.isArray(old.services) ? old.services : []).flatMap((service) =>
        isRecord(service) && Array.isArray(service.models) && typeof service.id === "string"
          ? [service.id]
          : [],
      ),
    );
    return recoverVersion2(latest, reading.settings, named);
  }
  if (reading.kind !== "ok" || reading.from !== 1 || !isRecord(old)) return undefined;
  const now = reading.settings;
  // What the page of before read: the settings of version 2 as version 1 has them, with the
  // addresses, which settings of before version 4 had in them. Where it wrote no services at all,
  // it read those of version 4, without addresses: it saw none of them.
  const written = writeAiSettings(latest);
  const sawNone =
    now.services.length === 0 && (!Array.isArray(old.services) || old.services.length === 0);
  const read = readAiSettings({
    ...written,
    version: undefined,
    services: sawNone
      ? []
      : (written.services as unknown[]).map((service) => {
          const known = isRecord(service)
            ? latest.services.find(({ id }) => id === service.id)
            : undefined;
          return known && isRecord(service) ? { ...service, baseUrl: known.baseUrl } : service;
        }),
  });
  if (read.kind !== "ok") return undefined;
  const was = read.settings;
  const before = new Map(was.services.map((service) => [service.id, service]));
  const taken = now.services.map((service): ServiceConfig => {
    const base = latest.services.find(({ id }) => id === service.id);
    const seen = before.get(service.id);
    if (!base || !seen) return service;
    const picked = service.enabled[0];
    const changed = picked !== undefined && picked !== seen.enabled[0];
    const pick = <K extends "name" | "baseUrl" | "route">(field: K) =>
      service[field] === seen[field] ? base[field] : service[field];
    return {
      ...base,
      name: pick("name"),
      baseUrl: pick("baseUrl"),
      route: pick("route"),
      enabled: changed && !base.enabled.includes(picked) ? [...base.enabled, picked] : base.enabled,
    };
  });
  // What that page could not read (a service of version 4 has no address for it) it never saw,
  // and did not take away.
  const unseen = latest.services.filter(
    (service) => !before.has(service.id) && !taken.some(({ id }) => id === service.id),
  );
  const services = [...taken, ...unseen];
  const sameDefault =
    now.default?.service === was.default?.service && now.default?.model === was.default?.model;
  const samePacks =
    !("packFor" in old) || JSON.stringify(now.packFor) === JSON.stringify(was.packFor);
  const sameShown = !("showHiddenPacks" in old) || now.showHiddenPacks === was.showHiddenPacks;
  const packFor = samePacks ? latest.packFor : now.packFor;
  const showHiddenPacks = sameShown ? latest.showHiddenPacks : now.showHiddenPacks;
  const { packFor: _packs, showHiddenPacks: _shown, kept: _kept, ...rest } = latest;
  // What neither understands stays; what the page of before brought besides goes with it.
  const fields = { ...latest.kept?.fields, ...now.kept?.fields };
  const seenServices = new Set((latest.kept?.services ?? []).map((value) => JSON.stringify(value)));
  const unread = [
    ...(latest.kept?.services ?? []),
    ...(now.kept?.services ?? []).filter((value) => !seenServices.has(JSON.stringify(value))),
  ];
  const kept: KeptSettings = {
    ...(Object.keys(fields).length > 0 && { fields }),
    ...(latest.kept?.serviceFields && { serviceFields: latest.kept.serviceFields }),
    ...(unread.length > 0 && { services: unread }),
  };
  return {
    ...rest,
    services,
    default: settledDefault(services, sameDefault ? latest.default : now.default),
    ...(packFor && { packFor }),
    ...(showHiddenPacks && { showHiddenPacks: true }),
    maxToolCalls: now.maxToolCalls === was.maxToolCalls ? latest.maxToolCalls : now.maxToolCalls,
    ...(Object.keys(kept).length > 0 && { kept }),
  };
}

/**
 * Settings of version 3 again, after a page of version 2 (0.3.57 to 0.3.63) wrote over them: such
 * a page leaves settings of version 3 alone, so it only does that where it read them before they
 * were version 3, and what it wrote is everything as it was then, with its change. That is taken,
 * and what only version 3 has goes back on top: the protocol and headers of each service, and of
 * each model what version 2 does not have. Models people named that the page took away stay away
 * where it wrote the models of that service (`wroteModels`); where it wrote none at all, as a page that
 * made its settings from the entries of an account does, nothing is taken away. A size it gave a
 * model people named is theirs.
 */
function recoverVersion2(
  latest: AiSettings,
  now: AiSettings,
  wroteModels: ReadonlySet<string>,
): AiSettings {
  const before = new Map(latest.services.map((service) => [service.id, service]));
  const services = now.services.map((service): ServiceConfig => {
    const base = before.get(service.id);
    if (!base) return service;
    const theirs = new Map((service.models ?? []).map((model) => [model.id, model]));
    const wrote = wroteModels.has(service.id);
    const models = (base.models ?? []).flatMap((model): ModelConfig[] => {
      const named = theirs.get(model.id);
      if (model.added === "hand" && !named && wrote) return [];
      if (named?.contextWindow === undefined || named.contextWindow === model.contextWindow)
        return [model];
      return [
        {
          ...model,
          contextWindow: named.contextWindow,
          edited: [...new Set([...(model.edited ?? []), "contextWindow" as const])],
        },
      ];
    });
    const known = new Set(models.map((model) => model.id));
    const added = (service.models ?? []).filter((model) => !known.has(model.id));
    const all = [...models, ...added];
    const { models: _theirs, ...rest } = service;
    return {
      ...rest,
      ...(base.api && { api: base.api }),
      ...(base.headers && { headers: base.headers }),
      ...(all.length > 0 && { models: all }),
    };
  });
  return {
    ...now,
    services,
    // Only this version has favorites: they go back as they were.
    ...(latest.favorites && !now.favorites && { favorites: latest.favorites }),
    ...(latest.kept && { kept: { ...latest.kept, ...now.kept } }),
  };
}
