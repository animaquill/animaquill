/**
 * The settings of one model as people see them, cell by cell (`ModelField`): what each cell is now,
 * where its value came from, what a catalog would fill in, and the changes people make, including
 * undoing what a catalog filled (docs/design/settings-and-properties.md of AnimaQuill Cloud, 6.2 and
 * 6.3). Nothing here asks anything of anyone: what the catalogs say comes in as `CatalogSay`.
 */
import { REASONING } from "@animaquill/tools";
import {
  MODEL_FIELDS,
  type CatalogFill,
  type CatalogSource,
  type ModelConfig,
  type ModelField,
  type ModelValues,
  type PriceDoubt,
} from "./ai-settings.ts";
import type {
  ListedModel,
  ModelCost,
  ReasoningLevel,
  ThinkingLevelMap,
} from "./model-discovery.ts";

/** Where a cell's value comes from, as the settings mark it. */
export type FieldMark =
  /** People set it. */
  | "edited"
  /** A catalog filled it in, or pi knows it of a model of its catalog. */
  | "catalog"
  /** Nothing: empty, or as pi does by default. */
  | undefined;

const levelOf = (field: ModelField): ReasoningLevel | undefined =>
  field.startsWith("thinking.") ? (field.slice(9) as ReasoningLevel) : undefined;

/** The value of a cell; of a step of reasoning, what its map has for it. */
export function fieldValue(values: ModelValues, field: ModelField): unknown {
  const level = levelOf(field);
  if (level) return values.thinkingLevelMap?.[level];
  return values[field as Exclude<ModelField, `thinking.${string}`>];
}

/** A model with one cell set, or emptied with undefined. */
export function withField<T extends ModelValues>(values: T, field: ModelField, value: unknown): T {
  const level = levelOf(field);
  if (level) {
    const map: Partial<Record<ReasoningLevel, string | null>> = { ...values.thinkingLevelMap };
    if (value === undefined) delete map[level];
    else map[level] = value as string | null;
    const { thinkingLevelMap: _was, ...rest } = values;
    return (Object.keys(map).length > 0 ? { ...rest, thinkingLevelMap: map } : rest) as T;
  }
  const { [field as keyof ModelValues]: _was, ...rest } = values;
  return (value === undefined ? rest : { ...rest, [field]: value }) as T;
}

const THINKING_FIELDS = REASONING.map((level) => `thinking.${level}` as const);

/**
 * Whether a step of reasoning is one the model takes, as pi has it: not where its map says `null`,
 * and "xhigh" and "max" only where the map has them.
 */
export function levelSupported(map: ThinkingLevelMap | undefined, level: ReasoningLevel): boolean {
  const value = map?.[level];
  if (value === null) return false;
  return level === "xhigh" || level === "max" ? value !== undefined : true;
}

/**
 * What a step of reasoning is sent as, where people gave it: nothing where it goes as pi writes it
 * (for "xhigh" and "max", which need a value to be offered at all, their own name).
 */
export function levelText(map: ThinkingLevelMap | undefined, level: ReasoningLevel): string {
  const value = map?.[level];
  if (typeof value !== "string") return "";
  return (level === "xhigh" || level === "max") && value === level ? "" : value;
}

/** What a step of reasoning has in the map for whether it is taken and what it is sent as. */
export function levelEntry(
  level: ReasoningLevel,
  supported: boolean,
  text: string,
): string | null | undefined {
  if (!supported) return null;
  const trimmed = text.trim();
  if (trimmed !== "") return trimmed;
  return level === "xhigh" || level === "max" ? level : undefined;
}

/** The map as it is sent: nothing where every step is as pi has it by default. */
export function settledMap(map: ThinkingLevelMap | undefined): ThinkingLevelMap | undefined {
  if (!map) return undefined;
  const entries = REASONING.flatMap((level) =>
    map[level] === undefined ? [] : [[level, map[level]] as const],
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/**
 * What the catalogs say of a model, in the order they are trusted (6.3): what the service listed,
 * then pi's catalog, then models.dev, with whether the price of models.dev can be taken.
 */
export interface CatalogSay {
  readonly service?: ListedModel | undefined;
  readonly pi?: ListedModel | undefined;
  readonly modelsDev?:
    | {
        readonly preset: {
          readonly name?: string;
          readonly reasoning?: boolean;
          readonly image?: boolean;
          readonly efforts?: readonly string[];
          readonly contextWindow?: number;
          readonly maxTokens?: number;
          readonly cost?: ModelCost;
        };
        readonly by?: "provider" | "base-url" | "consensus" | undefined;
        readonly matched?: string | undefined;
        readonly priceDoubt?: PriceDoubt | undefined;
      }
    | undefined;
}

/** The steps of reasoning a list of efforts names, as pi-web reads such a list. */
export function mapFromEfforts(efforts: readonly string[]): ThinkingLevelMap | undefined {
  const named = new Set(efforts);
  const steps = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
  if (!steps.some((step) => named.has(step))) return undefined;
  const map: Partial<Record<ReasoningLevel, string | null>> = {};
  for (const step of steps) {
    if (!named.has(step)) map[step] = null;
    else if (step === "xhigh" || step === "max") map[step] = step;
  }
  return map;
}

/** What the catalogs would fill in, cell by cell, and from which. */
export interface CatalogValues {
  readonly values: ReadonlyMap<ModelField, unknown>;
  readonly from: ReadonlyMap<ModelField, CatalogSource>;
  readonly by?: "provider" | "base-url" | "consensus" | undefined;
  readonly matched?: string | undefined;
  readonly priceDoubt?: PriceDoubt | undefined;
}

/**
 * Cell by cell, the value of the most trusted catalog that has one. A map of the steps of
 * reasoning counts as a whole, from one catalog: every step gets its value there, also "as pi
 * does by default" (undefined), so that every step is marked as the catalog's.
 */
export function catalogValues(say: CatalogSay): CatalogValues {
  const values = new Map<ModelField, unknown>();
  const from = new Map<ModelField, CatalogSource>();
  const put = (field: ModelField, value: unknown, source: CatalogSource) => {
    if (value === undefined || values.has(field)) return;
    values.set(field, value);
    from.set(field, source);
  };
  const dev = say.modelsDev?.preset;
  const layers: [CatalogSource, ListedModel | undefined][] = [
    ["service", say.service],
    ["pi", say.pi],
  ];
  for (const [source, model] of layers) {
    if (!model) continue;
    put("name", model.name, source);
    put("reasoning", model.reasoning, source);
    put("image", model.image, source);
    put("contextWindow", model.contextWindow, source);
    put("maxTokens", model.maxTokens, source);
    // Only pi's prices: what services say of theirs means different things (model-discovery.ts).
    if (source === "pi") put("cost", model.cost, source);
  }
  if (dev) {
    put("name", dev.name, "models.dev");
    put("reasoning", dev.reasoning, "models.dev");
    put("image", dev.image, "models.dev");
    put("contextWindow", dev.contextWindow, "models.dev");
    put("maxTokens", dev.maxTokens, "models.dev");
    put("cost", dev.cost, "models.dev");
  }
  const reasoning = values.get("reasoning");
  if (reasoning === true) {
    const maps: [CatalogSource, ThinkingLevelMap | undefined][] = [
      ["service", say.service?.thinkingLevelMap],
      ["pi", say.pi?.reasoning ? (say.pi.thinkingLevelMap ?? {}) : undefined],
      ["models.dev", dev?.efforts ? mapFromEfforts(dev.efforts) : undefined],
    ];
    const found = maps.find(([, map]) => map !== undefined);
    const source = found?.[0] ?? from.get("reasoning") ?? "models.dev";
    for (const level of REASONING) {
      const field = `thinking.${level}` as const;
      values.set(field, found?.[1]?.[level]);
      from.set(field, source);
    }
  }
  return {
    values,
    from,
    ...(say.modelsDev?.by && { by: say.modelsDev.by }),
    ...(say.modelsDev?.matched && { matched: say.modelsDev.matched }),
    ...(say.modelsDev?.priceDoubt && { priceDoubt: say.modelsDev.priceDoubt }),
  };
}

/**
 * Fills in what the catalogs say: only cells that are empty, or with `again` also those a catalog
 * filled before; never a cell people set. What the cells were is kept to undo it (`undoFill`),
 * and that is all a fill keeps: the one before it cannot be undone any more. Where nothing changes
 * and nothing is new to mark, the model is as it was.
 */
export function fillModel(model: ModelConfig, say: CatalogValues, again = false): ModelConfig {
  const edited = new Set(model.edited ?? []);
  const before = new Set(model.filled?.fields ?? []);
  let next: ModelConfig = model;
  const fields: ModelField[] = [];
  const snapshot: Partial<Record<ModelField, unknown>> = {};
  for (const [field, value] of say.values) {
    if (edited.has(field)) continue;
    const now = fieldValue(model, field);
    const filledBefore = before.has(field);
    if (now !== undefined && !(again && filledBefore)) continue;
    fields.push(field);
    if (now !== undefined) snapshot[field] = now;
    next = withField(next, field, value);
  }
  if (fields.length === 0) return model;
  const sources = new Set(fields.map((field) => say.from.get(field)));
  const from = (["service", "pi", "models.dev"] as const).filter((source) => sources.has(source));
  const { filled: _was, ...rest } = next;
  const filled: CatalogFill = {
    from,
    ...(say.by && from.includes("models.dev") && { by: say.by }),
    ...(say.matched && from.includes("models.dev") && { matched: say.matched }),
    ...(say.priceDoubt && { priceDoubt: say.priceDoubt }),
    fields,
    snapshot,
  };
  return { ...rest, filled };
}

/** Undoes what a catalog filled in last: the cells go back as they were, as long as people left them. */
export function undoFill(model: ModelConfig): ModelConfig {
  const filled = model.filled;
  if (!filled) return model;
  const edited = new Set(model.edited ?? []);
  let next: ModelConfig = model;
  for (const field of filled.fields) {
    if (edited.has(field)) continue;
    next = withField(next, field, filled.snapshot[field]);
  }
  const { filled: _was, ...rest } = next;
  return rest;
}

/**
 * People set a cell: it is theirs from now on (`edited`), and a catalog does not fill it again.
 * A step of reasoning also writes the others as they are now (`current`), as the map that is sent
 * is the whole of it: one step set must not take away what pi had for the others.
 */
export function editField(
  model: ModelConfig,
  field: ModelField,
  value: unknown,
  current?: ThinkingLevelMap,
): ModelConfig {
  let next: ModelConfig = model;
  if (levelOf(field) && model.thinkingLevelMap === undefined && current)
    next = { ...next, thinkingLevelMap: current };
  next = withField(next, field, value);
  const edited = [...new Set([...(model.edited ?? []), field])];
  return { ...next, edited: MODEL_FIELDS.filter((each) => edited.includes(each)) };
}

/**
 * A cell back to what the catalogs say (`say`), or empty where they say nothing: no longer
 * people's, so that a catalog fills it again.
 */
export function revertField(
  model: ModelConfig,
  field: ModelField,
  say: CatalogValues,
): ModelConfig {
  const edited = (model.edited ?? []).filter((each) => each !== field);
  const { edited: _was, ...rest } = withField(model, field, say.values.get(field));
  const back: ModelConfig = edited.length > 0 ? { ...rest, edited } : rest;
  if (!say.values.has(field)) return back;
  const filled = back.filled;
  return {
    ...back,
    filled: filled
      ? { ...filled, fields: [...new Set([...filled.fields, field])] }
      : { from: [say.from.get(field) ?? "pi"], fields: [field], snapshot: {} },
  };
}

/** Where each cell of a model is from, as the settings mark it (see `FieldMark`). */
export function markOf(
  model: ModelConfig | undefined,
  field: ModelField,
  live: ModelValues | undefined,
): FieldMark {
  if (model?.edited?.includes(field)) return "edited";
  if (model?.filled?.fields.includes(field)) return "catalog";
  const own = model && fieldValue(model, field);
  if (own !== undefined) return "edited";
  if (levelOf(field)) {
    // The map pi has is the model's as a whole: each step of it is pi's.
    return live?.reasoning && model?.thinkingLevelMap === undefined && live.thinkingLevelMap
      ? "catalog"
      : undefined;
  }
  return live && fieldValue(live, field) !== undefined ? "catalog" : undefined;
}

/**
 * A model as it is used: what people set or a catalog filled in, and for the rest what pi knows
 * of it (`live`). The map of reasoning is people's as a whole, where they have one.
 */
export function effectiveValues(
  model: ModelConfig | undefined,
  live: ModelValues | undefined,
): ModelValues {
  const values: Record<string, unknown> = { ...live };
  for (const [name, value] of Object.entries(model ?? {})) {
    if (
      value !== undefined &&
      name !== "id" &&
      name !== "filled" &&
      name !== "edited" &&
      name !== "added"
    )
      values[name] = value;
  }
  return values as ModelValues;
}

/** Fields of the settings of a model that are not cells of a catalog, which people set alone. */
export const OWN_FIELDS = [
  "imageMaxBytes",
  "baseUrl",
  "api",
  "headers",
  "compat",
] as const satisfies readonly (keyof ModelValues)[];

/** What a model of pi's catalog is, as the settings take it. */
export function liveOf(model: ListedModel | undefined): ModelValues | undefined {
  if (!model) return undefined;
  return {
    ...(model.name !== undefined && { name: model.name }),
    ...(model.reasoning !== undefined && { reasoning: model.reasoning }),
    ...(model.image !== undefined && { image: model.image }),
    ...(model.contextWindow !== undefined && { contextWindow: model.contextWindow }),
    ...(model.maxTokens !== undefined && { maxTokens: model.maxTokens }),
    ...(model.cost !== undefined && { cost: model.cost }),
    ...(model.thinkingLevelMap !== undefined && { thinkingLevelMap: model.thinkingLevelMap }),
  };
}

/** The cells of the steps of reasoning, from "off" to "max". */
export { THINKING_FIELDS };
