// Adapted from pi-web (https://github.com/agegr/pi-web), lib/model-discovery.ts, commit 57cea50.
// Copyright (c) 2026 agegr. MIT License; see LICENSES/pi-web.txt.
/**
 * What a service says of its models when asked (`/models`): services and gateways answer in many
 * shapes, and some say how much a model reads at once and writes at most, whether it thinks and
 * how hard it can, and whether it takes pictures. Only fields that mean the same everywhere are
 * read: not the price (one gateway quotes it per token, another per million), and not `max_tokens`
 * (LiteLLM fills it with either limit).
 */
import { REASONING } from "@animaquill/tools";

/** A step of reasoning, as model packs and pi name them. */
export type ReasoningLevel = (typeof REASONING)[number];

/**
 * What a model is sent for each step of reasoning, as pi has it (`Model.thinkingLevelMap`): a step
 * that is not there goes as pi writes it by default, `null` is a step the model does not take. pi
 * offers "xhigh" and "max" only where they are there.
 */
export type ThinkingLevelMap = Partial<Record<ReasoningLevel, string | null>>;

/** Dollars per million tokens. */
export interface ModelCost {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

/** A model a service has, as far as it or pi said. Missing fields are not known. */
export interface ListedModel {
  readonly id: string;
  readonly name?: string;
  /** How many tokens it reads at once. */
  readonly contextWindow?: number;
  /** How many tokens one answer has at most. */
  readonly maxTokens?: number;
  /** Dollars per million tokens, as pi knows them; never from what a service says. */
  readonly cost?: ModelCost;
  readonly reasoning?: boolean;
  readonly image?: boolean;
  /** The steps of reasoning it takes and how each is sent, where that is known. */
  readonly thinkingLevelMap?: ThinkingLevelMap;
  /** It holds no conversation, such as one that only embeds text or reads it out. */
  readonly chat?: false;
  /** How it differs from its protocol, as pi knows it (`Model.compat`). */
  readonly compat?: Readonly<Record<string, unknown>>;
}

/**
 * The steps of reasoning a model takes, as pi works them out (`getSupportedThinkingLevels`): only
 * "off" where it does not think; else every step its map does not take away, and "xhigh" and
 * "max" only where its map has them.
 */
export function supportedLevels(
  reasoning: boolean | undefined,
  map: ThinkingLevelMap | undefined,
): ReasoningLevel[] {
  if (reasoning === false) return ["off"];
  return REASONING.filter((level) => {
    const mapped = map?.[level];
    if (mapped === null) return false;
    return level === "xhigh" || level === "max" ? mapped !== undefined : true;
  });
}

const CONTEXT_WINDOW_FIELDS = [
  "context_length",
  "contextLength",
  "context_window",
  "contextWindow",
  "max_model_len",
  "max_input_tokens",
  "inputTokenLimit",
];
const MAX_TOKENS_FIELDS = [
  "max_output_tokens",
  "maxOutputTokens",
  "max_completion_tokens",
  "outputTokenLimit",
];
const REASONING_FIELDS = ["supports_reasoning", "supportsReasoning", "reasoning", "thinking"];
/** Steps a list of efforts can name, as pi takes them: "off" is never one of them. */
const EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
/**
 * Ids of models that hold no conversation: embedding, reading out, transcribing, pictures,
 * moderation, ranking.
 */
const NOT_CHAT =
  /(?:^|[-_/.])(?:embed(?:ding)?s?|text-embedding|whisper|tts|transcri(?:be|ption)|dall-e|gpt-image|imagen|moderation|rerank(?:er)?|speech|audio-only|bge|e5)(?:$|[-_/.\d])/i;
// Every spelling of the list of efforts; the first one that is an array wins.
const EFFORT_LIST_FIELDS = ["supported_efforts", "supportedEfforts", "reasoning_levels"];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const cleanString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

function firstPositiveInteger(
  value: Record<string, unknown>,
  fields: readonly string[],
): number | undefined {
  for (const field of fields) {
    const raw = value[field];
    const number = typeof raw === "string" && /^\d+$/.test(raw.trim()) ? Number(raw) : raw;
    if (typeof number === "number" && Number.isSafeInteger(number) && number > 0) return number;
  }
  return undefined;
}

/**
 * Whether it takes pictures, from `modalities.input` (models.dev) or a bare `input` array. A list
 * that names neither text nor pictures says nothing.
 */
function imageFromValue(value: Record<string, unknown>): boolean | undefined {
  const modalities = value.modalities;
  const list =
    isRecord(modalities) && Array.isArray(modalities.input)
      ? modalities.input
      : Array.isArray(value.input)
        ? value.input
        : undefined;
  if (!list) return undefined;
  const input = new Set(
    list
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim().toLowerCase()),
  );
  if (!input.has("text") && !input.has("image")) return undefined;
  return input.has("image");
}

/**
 * How it is sent each step, from a list of efforts it advertises, as pi-web has it: every step the
 * list leaves out is one it does not take (`null`), and "xhigh" and "max" are named to be offered
 * at all. "off" stays as pi has it, even where the list names "none": the list names efforts, not
 * whether pi should take that one for no thinking. A list naming none of the steps says nothing.
 */
function mapFromEfforts(value: Record<string, unknown>): ThinkingLevelMap | undefined {
  const list = EFFORT_LIST_FIELDS.map((field) => value[field]).find(Array.isArray);
  if (!list) return undefined;
  const advertised = new Set(list.filter((effort): effort is string => typeof effort === "string"));
  if (!EFFORTS.some((level) => advertised.has(level))) return undefined;
  const map: Partial<Record<ReasoningLevel, string | null>> = {};
  for (const level of EFFORTS) {
    if (!advertised.has(level)) map[level] = null;
    else if (level === "xhigh" || level === "max") map[level] = level;
  }
  return map;
}

/**
 * Whether it holds a conversation, where something says it does not: Google's methods, the kinds
 * of answers it gives (`modalities.output`, `architecture.output_modalities`), a `type` or `object`
 * that names another use, or an id of such a model.
 */
function isChat(value: Record<string, unknown>, id: string): boolean {
  const methods = value.supportedGenerationMethods;
  if (Array.isArray(methods)) return methods.includes("generateContent");
  const modalities = value.modalities;
  const architecture = value.architecture;
  const output =
    isRecord(modalities) && Array.isArray(modalities.output)
      ? modalities.output
      : isRecord(architecture) && Array.isArray(architecture.output_modalities)
        ? architecture.output_modalities
        : undefined;
  if (output && !output.includes("text")) return false;
  const type = cleanString(value.type)?.toLowerCase();
  if (type !== undefined && /embed|rerank|audio|image|moderation|speech/.test(type)) return false;
  return !NOT_CHAT.test(id);
}

function modelFromValue(value: unknown): ListedModel | undefined {
  if (typeof value === "string") {
    const id = value.trim();
    return id ? { id, ...(NOT_CHAT.test(id) && { chat: false as const }) } : undefined;
  }
  if (!isRecord(value)) return undefined;
  const rawId = cleanString(value.id) ?? cleanString(value.model) ?? cleanString(value.name);
  if (!rawId) return undefined;
  const id = rawId.startsWith("models/") ? rawId.slice("models/".length) : rawId;
  if (!id) return undefined;
  const name =
    cleanString(value.display_name) ??
    cleanString(value.displayName) ??
    (cleanString(value.id) || cleanString(value.model) ? cleanString(value.name) : undefined);
  const reasoning = REASONING_FIELDS.some((field) => value[field] === true);
  const thinkingLevelMap = reasoning ? mapFromEfforts(value) : undefined;
  const image = imageFromValue(value);
  const contextWindow = firstPositiveInteger(value, CONTEXT_WINDOW_FIELDS);
  const maxTokens = firstPositiveInteger(value, MAX_TOKENS_FIELDS);
  return {
    id,
    ...(name && name !== id && { name }),
    ...(contextWindow && { contextWindow }),
    ...(maxTokens && { maxTokens }),
    ...(reasoning && { reasoning }),
    ...(image !== undefined && { image }),
    ...(thinkingLevelMap && { thinkingLevelMap }),
    ...(!isChat(value, id) && { chat: false as const }),
  };
}

function listFromResponse(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (!isRecord(value)) return [];
  for (const key of ["data", "models", "results", "items"]) {
    const candidate = value[key];
    if (Array.isArray(candidate)) return candidate;
    if (isRecord(candidate)) return Object.values(candidate);
  }
  return [];
}

/** The models in what a service answered to `/models`, each once, by id. */
export function parseListedModels(value: unknown): ListedModel[] {
  const seen = new Set<string>();
  const models: ListedModel[] = [];
  for (const item of listFromResponse(value)) {
    const model = modelFromValue(item);
    if (!model || seen.has(model.id)) continue;
    seen.add(model.id);
    models.push(model);
  }
  return models.toSorted((a, b) => a.id.localeCompare(b.id));
}
