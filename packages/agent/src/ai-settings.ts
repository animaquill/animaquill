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
 * AnimaQuill Cloud, 6.5). Pages of version 2 leave settings of version 3 alone (`newer`).
 */
import { COMPARISON_PACK_ID, REASONING } from "@animaquill/tools";
import type { ModelCost, ReasoningLevel, ThinkingLevelMap } from "./model-discovery.ts";
import { checkBaseUrl, kindOf, type Route } from "./services.ts";

export const AI_SETTINGS_VERSION = 3;

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
  /** Headers that go with every request to it, such as what a gateway of a company wants. */
  readonly headers?: Readonly<Record<string, string>>;
  /**
   * The header the key goes in, for a server of one's own that wants it elsewhere than its
   * protocol puts it, such as Azure's `api-key`. The key itself is kept apart as any key.
   */
  readonly keyHeader?: string;
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
  readonly kept?: KeptSettings;
}

/** Which key sends a message: the other one makes a new line. */
export type SendWith = "enter" | "modEnter";

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
      readonly settings: AiSettings;
      /** The version they were written in: 1 and 2 are upgraded as they are read. */
      readonly from: 1 | 2 | 3;
      /** Headers that cannot be sent were left out, such as one with letters `fetch` refuses. */
      readonly headersLeftOut?: true;
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
  "current",
  "reasoningFor",
  "packFor",
  "showHiddenPacks",
  "maxToolCalls",
  "autoTitle",
  "expandThinking",
  "sendWith",
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
 * platform. A header named like a secret is theirs to send: the settings only remind them, see
 * `looksSecret`, and the key has a header of its own to go in (`ServiceConfig.keyHeader`).
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

/**
 * Whether the value of a header looks like a key (`sk-…`, `Bearer …`, a long random string): the
 * settings remind people that headers go with the account as they are, and keys belong in the key.
 */
export const looksSecret = (value: string): boolean =>
  /^\s*(?:sk-|bearer\s|basic\s|ghp_|xox[bp]-|AIza)/i.test(value) ||
  (value.match(/[A-Za-z0-9_+/=-]{32,}/g) ?? []).some(
    (run) =>
      // An id such as a UUID, with or without its dashes, is no secret.
      !/^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i.test(run) &&
      /[A-Za-z]/.test(run) &&
      /[0-9]/.test(run),
  );

/** A name of a header the key can go in. */
export const isKeyHeader = (value: unknown): value is string =>
  typeof value === "string" && headerProblem(value, "") === undefined;

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
  version: 1 | 2 | 3,
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
 * model in `model`, which becomes the one turned on.
 */
function readService(
  value: unknown,
  version: 1 | 2 | 3,
): { service: ServiceConfig; modelFields: Record<string, Record<string, unknown>> } | undefined {
  if (!isRecord(value)) return undefined;
  const { id, kind, name, baseUrl, route } = value;
  if (typeof id !== "string" || id === "" || typeof kind !== "string" || !kindOf(kind)) {
    return undefined;
  }
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
  const headers = version === 3 ? readHeaders(value.headers) : undefined;
  const paused =
    version === 3 && Array.isArray(value.paused)
      ? [...new Set(value.paused as unknown[])].filter(isModelName)
      : [];
  return {
    service: {
      id,
      kind,
      name,
      baseUrl,
      route,
      ...(version === 3 && custom && isApi(value.api) && { api: value.api }),
      ...(version === 3 &&
        custom &&
        isKeyHeader(value.keyHeader) && { keyHeader: value.keyHeader }),
      ...(headers && { headers }),
      enabled,
      ...(paused.length > 0 && enabled.length === 0 && { paused }),
      ...(models && { models }),
    },
    modelFields: extra,
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

/** The default model as it has to be: one that is on, while any is. */
export function settledDefault(
  services: readonly ServiceConfig[],
  wanted: ModelRef | undefined,
): ModelRef | undefined {
  return isEnabled(services, wanted) ? wanted : firstEnabled(services);
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
  if (version !== undefined && version !== 1 && version !== 2 && version !== AI_SETTINGS_VERSION) {
    return { kind: "newer" };
  }
  const from = version === AI_SETTINGS_VERSION ? 3 : version === 2 ? 2 : 1;
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
  const fields = unknownFields(value, TOP_FIELDS);
  const kept: KeptSettings = {
    ...(fields && { fields }),
    ...(Object.keys(serviceFields).length > 0 && { serviceFields }),
    ...(Object.keys(modelFields).length > 0 && { modelFields }),
    ...(unread.length > 0 && { services: unread }),
  };
  const settings: AiSettings = {
    services,
    default: settledDefault(services, wanted),
    ...(reasoningFor && { reasoningFor }),
    ...(packFor && { packFor }),
    ...(showHiddenPacks && { showHiddenPacks: true }),
    maxToolCalls: readLimit(value.maxToolCalls),
    autoTitle: typeof value.autoTitle === "boolean" ? value.autoTitle : true,
    expandThinking: value.expandThinking === true,
    ...(value.sendWith === "modEnter" && { sendWith: "modEnter" as const }),
    ...(Object.keys(kept).length > 0 && { kept }),
  };
  // Set while the services were read, which control flow does not see.
  const leftOut = headersLeftOut as boolean;
  return { kind: "ok", settings, from, ...(leftOut && { headersLeftOut: true as const }) };
}

/** A model as it is saved: only what it has, with what was not understood back in place. */
export function writeModel(
  model: ModelConfig,
  kept?: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return {
    ...kept,
    ...Object.fromEntries(Object.entries(model).filter(([, value]) => value !== undefined)),
  };
}

/**
 * The settings as they are saved: version 3, with what was not understood back in place, and with
 * `current` and each service's `model` as version 1 had them, for a page of before.
 */
export function writeAiSettings(settings: AiSettings): Record<string, unknown> {
  const { kept } = settings;
  const fallback = settledDefault(settings.services, settings.default);
  const services = settings.services.map((service) => ({
    ...kept?.serviceFields?.[service.id],
    id: service.id,
    kind: service.kind,
    name: service.name,
    baseUrl: service.baseUrl,
    route: service.route,
    ...(service.api && { api: service.api }),
    ...(service.keyHeader && { keyHeader: service.keyHeader }),
    ...(service.headers && Object.keys(service.headers).length > 0 && { headers: service.headers }),
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
  // What the page of before read: the settings of version 2 as version 1 has them.
  const read = readAiSettings({ ...writeAiSettings(latest), version: undefined });
  if (read.kind !== "ok") return undefined;
  const was = read.settings;
  const before = new Map(was.services.map((service) => [service.id, service]));
  const services = now.services.map((service): ServiceConfig => {
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
      ...(base.keyHeader && { keyHeader: base.keyHeader }),
      ...(base.headers && { headers: base.headers }),
      ...(all.length > 0 && { models: all }),
    };
  });
  return {
    ...now,
    services,
    ...(latest.kept && { kept: { ...latest.kept, ...now.kept } }),
  };
}
