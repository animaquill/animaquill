// Adapted from pi-web (https://github.com/agegr/pi-web), lib/model-discovery.ts, commit 57cea50.
// Copyright (c) 2026 agegr. MIT License; see LICENSES/pi-web.txt.
/**
 * What a service says of its models when asked (`/models`): services and gateways answer in many
 * shapes, and some say how much a model reads at once, whether it thinks and how hard it can, and
 * whether it takes pictures. Only fields that mean the same everywhere are read: not the price (one
 * gateway quotes it per token, another per million) and not the most an answer writes.
 */
import { REASONING } from "@animaquill/tools";

/** A step of reasoning, as model packs and pi name them. */
export type ReasoningLevel = (typeof REASONING)[number];

/** A model a service has, as far as it or pi said. Missing fields are not known. */
export interface ListedModel {
  readonly id: string;
  readonly name?: string;
  /** How many tokens it reads at once. */
  readonly contextWindow?: number;
  /** Dollars per million tokens, as pi knows them; never from what a service says. */
  readonly cost?: { readonly input: number; readonly output: number };
  readonly reasoning?: boolean;
  readonly image?: boolean;
  /** The steps of reasoning it takes, where that is known. */
  readonly levels?: readonly ReasoningLevel[];
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
const REASONING_FIELDS = ["supports_reasoning", "supportsReasoning", "reasoning", "thinking"];
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
 * The steps it takes, from a list of efforts it advertises: "off" always (pi takes the lowest step
 * for it where a model cannot stop thinking), and those of ours the list names. A list naming none
 * of them says nothing.
 */
function levelsFromEfforts(value: Record<string, unknown>): ReasoningLevel[] | undefined {
  const list = EFFORT_LIST_FIELDS.map((field) => value[field]).find(Array.isArray);
  if (!list) return undefined;
  const advertised = new Set(list.filter((effort): effort is string => typeof effort === "string"));
  const levels = REASONING.filter((level) => level !== "off" && advertised.has(level));
  return levels.length > 0 ? ["off", ...levels] : undefined;
}

function modelFromValue(value: unknown): ListedModel | undefined {
  if (typeof value === "string") {
    const id = value.trim();
    return id ? { id } : undefined;
  }
  if (!isRecord(value)) return undefined;
  const rawId = cleanString(value.id) ?? cleanString(value.model) ?? cleanString(value.name);
  if (!rawId) return undefined;
  const id = rawId.startsWith("models/") ? rawId.slice("models/".length) : rawId;
  if (!id) return undefined;
  // Google lists what can only embed: those take no conversation.
  const methods = value.supportedGenerationMethods;
  if (Array.isArray(methods) && !methods.includes("generateContent")) return undefined;
  const name =
    cleanString(value.display_name) ??
    cleanString(value.displayName) ??
    (cleanString(value.id) || cleanString(value.model) ? cleanString(value.name) : undefined);
  const reasoning = REASONING_FIELDS.some((field) => value[field] === true);
  const levels = reasoning ? levelsFromEfforts(value) : undefined;
  const image = imageFromValue(value);
  const contextWindow = firstPositiveInteger(value, CONTEXT_WINDOW_FIELDS);
  return {
    id,
    ...(name && name !== id && { name }),
    ...(contextWindow && { contextWindow }),
    ...(reasoning && { reasoning }),
    ...(image !== undefined && { image }),
    ...(levels && { levels }),
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
