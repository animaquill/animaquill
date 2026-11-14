// Adapted from pi-web (https://github.com/agegr/pi-web), lib/model-catalog.ts, commit 57cea50.
// Copyright (c) 2026 agegr. MIT License; see LICENSES/pi-web.txt.
/**
 * The open catalog of models at models.dev: what each provider there says of each model it has,
 * and how to tell which of those is the model people add to a service of theirs. It fills in what a
 * service and pi do not say (docs/design/settings-and-properties.md of AnimaQuill Cloud, 6.3).
 *
 * Nothing of a browser and nothing of anyone: the editor takes the catalog straight from models.dev,
 * and a platform takes it for the editor where the browser cannot (`ModelCatalogAccess`), both with
 * a request that says nothing of who asks. Both keep it flattened (`flattenModelsDev`), which is
 * also what the platform answers with.
 */

/** Where the catalog is, as anyone can read it. */
export const MODELS_DEV_URL = "https://models.dev/api.json";
/** How long a copy of the catalog is good for, on a device and on the platform. */
export const MODEL_CATALOG_MAX_AGE_MS = 60 * 60_000;

/** Dollars per million tokens, as far as the catalog says them. */
export interface CatalogCost {
  readonly input?: number;
  readonly output?: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
}

/** One model of one provider in the catalog. */
export interface CatalogEntry {
  readonly providerId: string;
  readonly providerName: string;
  /** Where the provider is, where the catalog says. */
  readonly providerBaseUrl?: string;
  readonly id: string;
  readonly name: string;
  readonly reasoning?: boolean;
  readonly image?: boolean;
  /** The efforts of reasoning it takes, where the catalog names them, such as "low" and "max". */
  readonly efforts?: readonly string[];
  readonly contextWindow?: number;
  readonly maxTokens?: number;
  readonly cost: CatalogCost;
  /** It holds no conversation: it answers with something other than text. */
  readonly chat?: false;
}

/** The catalog as kept and passed on: flattened, with when it was taken. */
export interface ModelCatalog {
  /** Milliseconds since 1970. */
  readonly fetchedAt: number;
  readonly entries: readonly CatalogEntry[];
}

/** What a model is, as the catalog matched it: only what it said. */
export interface CatalogPreset {
  readonly name?: string;
  readonly reasoning?: boolean;
  readonly image?: boolean;
  readonly efforts?: readonly string[];
  readonly contextWindow?: number;
  readonly maxTokens?: number;
  /** Only where the price is to be trusted, see `CatalogPrice`. */
  readonly cost?: Required<CatalogCost>;
}

/**
 * How the model was told among the providers that have it: by the name of the service
 * ("provider"), by the name of the host of its address ("base-url"), or as most of them have it
 * ("consensus").
 */
export type CatalogMatch = "provider" | "base-url" | "consensus";

/**
 * Whether the price can be taken: where it was matched to one provider, or most of them agree.
 * Otherwise why not: no provider has the model, none says a price, too few say one, or they differ.
 */
export type CatalogPrice =
  | {
      readonly status: "reliable";
      readonly method: CatalogMatch;
      readonly cost: Required<CatalogCost>;
      readonly support: number;
      readonly total: number;
    }
  | {
      readonly status: "unreliable";
      readonly reason: "no-exact-match" | "no-valid-price" | "insufficient-support" | "conflict";
      readonly support: number;
      readonly total: number;
    };

export interface CatalogRecommendation {
  /** How many providers have the model. None: the catalog does not know it. */
  readonly exactMatches: number;
  readonly method: CatalogMatch | "none";
  /** The provider it was matched to, by provider or address. */
  readonly matchedProviderId?: string;
  readonly matchedProviderName?: string;
  readonly preset: CatalogPreset;
  readonly price: CatalogPrice;
}

const CONSENSUS_MIN_SHARE = 0.6;
const CONSENSUS_MIN_SUPPORT = 5;
/** Hosts of providers that the catalog does not say, or says otherwise. */
const KNOWN_PROVIDER_HOSTS: Readonly<Record<string, readonly string[]>> = {
  anthropic: ["api.anthropic.com"],
  google: ["generativelanguage.googleapis.com"],
  openai: ["api.openai.com"],
  openrouter: ["openrouter.ai"],
  deepseek: ["api.deepseek.com"],
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const cleanString = (value: unknown, most = 300): string | undefined =>
  typeof value === "string" && value.trim() && value.length <= most ? value.trim() : undefined;

/** The most tokens a catalog can say a model reads or writes, and the most a price can be. */
const MOST_TOKENS = 100_000_000;
const MOST_PRICE = 1_000_000;

const nonNegative = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value < MOST_PRICE
    ? value
    : undefined;

const positiveInteger = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= MOST_TOKENS
    ? value
    : undefined;

function readCost(value: unknown): CatalogCost {
  if (!isRecord(value)) return {};
  const cost: Record<string, number> = {};
  const put = (name: keyof CatalogCost, raw: unknown) => {
    const number = nonNegative(raw);
    if (number !== undefined) cost[name] = number;
  };
  put("input", value.input);
  put("output", value.output);
  put("cacheRead", value.cache_read ?? value.cacheRead);
  put("cacheWrite", value.cache_write ?? value.cacheWrite);
  return cost;
}

/** What a model takes and gives, as the lists of `modalities` name them, in lower case. */
const listOf = (value: unknown): string[] | undefined =>
  Array.isArray(value)
    ? value
        .filter((each): each is string => typeof each === "string")
        .map((each) => each.trim().toLowerCase())
    : undefined;

/** The efforts the catalog names, from `reasoning_options` (`{type: "effort", values}`). */
function effortsOf(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  for (const option of value) {
    if (!isRecord(option) || option.type !== "effort") continue;
    const efforts = listOf(option.values)?.filter((each) => /^[a-z]{1,20}$/.test(each));
    if (efforts && efforts.length > 0) return [...new Set(efforts)];
  }
  return undefined;
}

const normalizeProvider = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9]/g, "");

const normalizeModelId = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/^models\//, "");

function hostname(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return new URL(value).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return undefined;
  }
}

const hostMatches = (actual: string, expected: string): boolean =>
  actual === expected || actual.endsWith(`.${expected}`);

function providerMatches(entry: CatalogEntry, hints: readonly string[]): boolean {
  return hints.some((hint) => {
    const normalized = normalizeProvider(hint);
    return (
      normalized !== "" &&
      (normalizeProvider(entry.providerId) === normalized ||
        normalizeProvider(entry.providerName) === normalized)
    );
  });
}

function baseUrlMatches(entry: CatalogEntry, baseUrl: string): boolean {
  const actual = hostname(baseUrl);
  if (!actual) return false;
  const known = KNOWN_PROVIDER_HOSTS[normalizeProvider(entry.providerId)] ?? [];
  const own = hostname(entry.providerBaseUrl);
  return [...known, ...(own ? [own] : [])].some((candidate) => hostMatches(actual, candidate));
}

function exactModelMatches(entry: CatalogEntry, query: string): boolean {
  const wanted = normalizeModelId(query);
  if (!wanted) return false;
  const id = normalizeModelId(entry.id);
  return id === wanted || `${entry.providerId.toLowerCase()}/${id}` === wanted;
}

type Priced = CatalogEntry & { readonly cost: CatalogCost & { input: number; output: number } };

const validPrice = (entry: CatalogEntry): entry is Priced =>
  entry.cost.input !== undefined && entry.cost.output !== undefined;

/** The value most of them have: at least 60% of all, and not tied. */
function modeValue<T>(
  values: readonly T[],
  total: number,
  keyFor: (value: T) => string,
): T | undefined {
  if (values.length === 0 || total <= 0) return undefined;
  const groups = new Map<string, { value: T; count: number }>();
  for (const value of values) {
    const key = keyFor(value);
    const current = groups.get(key);
    if (current) current.count += 1;
    else groups.set(key, { value, count: 1 });
  }
  const ranked = [...groups.values()].toSorted((a, b) => b.count - a.count);
  const winner = ranked[0];
  if (!winner || winner.count / total < CONSENSUS_MIN_SHARE) return undefined;
  if (ranked[1]?.count === winner.count) return undefined;
  return winner.value;
}

function modeNumber(values: readonly number[]): number | undefined {
  const groups = new Map<number, number>();
  for (const value of values) groups.set(value, (groups.get(value) ?? 0) + 1);
  const ranked = [...groups.entries()].toSorted((a, b) => b[1] - a[1]);
  if (!ranked[0] || ranked[1]?.[1] === ranked[0][1]) return undefined;
  return ranked[0][0];
}

/** Only what is there: no field holding undefined. */
function defined<T extends object>(value: { readonly [K in keyof T]: T[K] | undefined }): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, each]) => each !== undefined),
  ) as unknown as T;
}

const presetOf = (entry: CatalogEntry): CatalogPreset =>
  defined<CatalogPreset>({
    name: entry.name,
    reasoning: entry.reasoning,
    image: entry.image,
    efforts: entry.efforts,
    contextWindow: entry.contextWindow,
    maxTokens: entry.maxTokens,
  });

function consensusPreset(entries: readonly CatalogEntry[]): CatalogPreset {
  const total = entries.length;
  const of = <T>(pick: (entry: CatalogEntry) => T | undefined) =>
    entries.flatMap((entry) => {
      const value = pick(entry);
      return value === undefined ? [] : [value];
    });
  return defined<CatalogPreset>({
    name: modeValue(
      of((entry) => entry.name),
      total,
      (value) => value.toLowerCase(),
    ),
    reasoning: modeValue(
      of((entry) => entry.reasoning),
      total,
      String,
    ),
    image: modeValue(
      of((entry) => entry.image),
      total,
      String,
    ),
    efforts: modeValue(
      of((entry) => entry.efforts),
      total,
      (value) => value.toSorted().join(),
    ),
    contextWindow: modeValue(
      of((entry) => entry.contextWindow),
      total,
      String,
    ),
    maxTokens: modeValue(
      of((entry) => entry.maxTokens),
      total,
      String,
    ),
  });
}

function priceOf(entry: Priced, method: "provider" | "base-url"): CatalogPrice {
  return {
    status: "reliable",
    method,
    cost: {
      input: entry.cost.input,
      output: entry.cost.output,
      cacheRead: entry.cost.cacheRead ?? 0,
      cacheWrite: entry.cost.cacheWrite ?? 0,
    },
    support: 1,
    total: 1,
  };
}

function consensusPrice(entries: readonly CatalogEntry[]): CatalogPrice {
  const priced = entries.filter(validPrice);
  if (priced.length === 0)
    return { status: "unreliable", reason: "no-valid-price", support: 0, total: 0 };
  if (priced.length === 1)
    return { status: "unreliable", reason: "insufficient-support", support: 1, total: 1 };
  const groups = new Map<string, Priced[]>();
  for (const entry of priced) {
    const key = JSON.stringify([entry.cost.input, entry.cost.output]);
    const group = groups.get(key);
    if (group) group.push(entry);
    else groups.set(key, [entry]);
  }
  const ranked = [...groups.values()].toSorted((a, b) => b.length - a.length);
  const winner = ranked[0];
  if (!winner?.[0])
    return { status: "unreliable", reason: "no-valid-price", support: 0, total: priced.length };
  const agreed =
    winner.length / priced.length >= CONSENSUS_MIN_SHARE || winner.length >= CONSENSUS_MIN_SUPPORT;
  if (ranked[1]?.length === winner.length || !agreed)
    return {
      status: "unreliable",
      reason: "conflict",
      support: winner.length,
      total: priced.length,
    };
  return {
    status: "reliable",
    method: "consensus",
    cost: {
      input: winner[0].cost.input,
      output: winner[0].cost.output,
      cacheRead: modeNumber(winner.map((entry) => entry.cost.cacheRead ?? 0)) ?? 0,
      cacheWrite: modeNumber(winner.map((entry) => entry.cost.cacheWrite ?? 0)) ?? 0,
    },
    support: winner.length,
    total: priced.length,
  };
}

/**
 * The catalog of models.dev as entries: one for each model of each provider, with only what is
 * read here. Anything not made as the catalog makes it is left out, not guessed.
 */
export function flattenModelsDev(value: unknown): CatalogEntry[] {
  if (!isRecord(value)) return [];
  const entries: CatalogEntry[] = [];
  for (const [providerId, provider] of Object.entries(value)) {
    if (!isRecord(provider) || !isRecord(provider.models)) continue;
    const providerName = cleanString(provider.name) ?? providerId;
    const providerBaseUrl = cleanString(provider.api, 2000);
    for (const [fallbackId, model] of Object.entries(provider.models)) {
      if (!isRecord(model)) continue;
      const id = cleanString(model.id) ?? cleanString(fallbackId);
      if (!id) continue;
      const modalities = isRecord(model.modalities) ? model.modalities : {};
      const input = listOf(modalities.input);
      const output = listOf(modalities.output);
      const limit = isRecord(model.limit) ? model.limit : {};
      const reasoning = typeof model.reasoning === "boolean" ? model.reasoning : undefined;
      entries.push(
        defined<CatalogEntry>({
          providerId,
          providerName,
          providerBaseUrl,
          id,
          name: cleanString(model.name) ?? id,
          reasoning,
          image:
            input && (input.includes("text") || input.includes("image"))
              ? input.includes("image")
              : undefined,
          efforts: reasoning ? effortsOf(model.reasoning_options) : undefined,
          contextWindow: positiveInteger(limit.context),
          maxTokens: positiveInteger(limit.output),
          cost: readCost(model.cost),
          chat: output && !output.includes("text") ? (false as const) : undefined,
        }),
      );
    }
  }
  return entries;
}

/**
 * One entry as kept or passed on, field by field as `flattenModelsDev` makes them: what is not
 * made so is left out, and an entry without its names is none.
 */
function readEntry(value: unknown): CatalogEntry | undefined {
  if (!isRecord(value)) return undefined;
  const providerId = cleanString(value.providerId);
  const providerName = cleanString(value.providerName);
  const id = cleanString(value.id);
  const name = cleanString(value.name);
  if (!providerId || !providerName || !id || !name) return undefined;
  const flag = (each: unknown) => (typeof each === "boolean" ? each : undefined);
  const efforts = Array.isArray(value.efforts)
    ? value.efforts.filter(
        (each): each is string => typeof each === "string" && /^[a-z]{1,20}$/.test(each),
      )
    : undefined;
  return defined<CatalogEntry>({
    providerId,
    providerName,
    providerBaseUrl: cleanString(value.providerBaseUrl, 2000),
    id,
    name,
    reasoning: flag(value.reasoning),
    image: flag(value.image),
    efforts: efforts && efforts.length > 0 ? efforts.slice(0, 10) : undefined,
    contextWindow: positiveInteger(value.contextWindow),
    maxTokens: positiveInteger(value.maxTokens),
    cost: readCost(value.cost),
    chat: value.chat === false ? (false as const) : undefined,
  });
}

/** A catalog as kept or passed on, or undefined where that is not what it is. */
export function readModelCatalog(value: unknown): ModelCatalog | undefined {
  if (!isRecord(value) || !Array.isArray(value.entries)) return undefined;
  const fetchedAt = value.fetchedAt;
  if (typeof fetchedAt !== "number" || !Number.isFinite(fetchedAt)) return undefined;
  const entries = value.entries.flatMap((entry) => {
    const read = readEntry(entry);
    return read ? [read] : [];
  });
  return { fetchedAt, entries };
}

/**
 * What the catalog says of a model of a service: the providers that have this very id (without
 * case, without `models/`, also as `provider/id`), and of those the one the service is, by its
 * names (`hints`) and then by the host of its address; else what most of them say. The price is
 * judged on its own: of the matched provider, else only where most of them agree.
 */
export function recommendFromCatalog(
  entries: readonly CatalogEntry[],
  query: string,
  hints: readonly string[] = [],
  baseUrl = "",
): CatalogRecommendation {
  const exact = entries.filter((entry) => exactModelMatches(entry, query));
  if (exact.length === 0)
    return {
      exactMatches: 0,
      method: "none",
      preset: {},
      price: { status: "unreliable", reason: "no-exact-match", support: 0, total: 0 },
    };
  const byProvider = exact.filter((entry) => providerMatches(entry, hints));
  const byUrl = exact.filter((entry) => baseUrlMatches(entry, baseUrl));
  const matched = byProvider[0] ?? byUrl[0];
  const method: CatalogMatch =
    byProvider.length > 0 ? "provider" : byUrl.length > 0 ? "base-url" : "consensus";
  const preset = matched ? presetOf(matched) : consensusPreset(exact);
  const providerPrice = byProvider.find(validPrice);
  const urlPrice = byUrl.find(validPrice);
  const price = providerPrice
    ? priceOf(providerPrice, "provider")
    : urlPrice
      ? priceOf(urlPrice, "base-url")
      : consensusPrice(exact);
  return {
    exactMatches: exact.length,
    method,
    ...(matched && {
      matchedProviderId: matched.providerId,
      matchedProviderName: matched.providerName,
    }),
    preset: price.status === "reliable" ? { ...preset, cost: price.cost } : preset,
    price,
  };
}
