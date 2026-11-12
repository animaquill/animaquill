/**
 * Everything about AI that people set up, apart from keys: the services, the models they turned on
 * in each, the default model, and preferences. Shared by all windows, and one day by all devices of
 * an account, so reading it is strict and forgiving at once: what this editor does not know is kept
 * as it was and written back, and what a newer editor wrote is not written over at all.
 *
 * Version 1 (until 0.3.55) had one model per service and a service "in use" (`current`). Version 2
 * turns on any number of models per service and has one default model. It still writes `current`
 * and each service's `model`, so that a page of before that is still open keeps working.
 */
import { COMPARISON_PACK_ID, REASONING } from "@animaquill/tools";
import type { ReasoningLevel } from "./model-discovery.ts";
import { kindOf, type Route } from "./services.ts";

export const AI_SETTINGS_VERSION = 2;

/** A model people named themselves, which neither pi nor the service told of. */
export interface CustomModel {
  readonly id: string;
  /** How many tokens it reads at once, where people said; 128k is assumed otherwise. */
  readonly contextWindow?: number;
}

/** A service people set up. Its key is kept apart, by `id`. */
export interface ServiceConfig {
  readonly id: string;
  readonly kind: string;
  /** What people call it, such as "公司的 DeepSeek". */
  readonly name: string;
  readonly baseUrl: string;
  readonly route: Route;
  /** The models people turned on, by their names at the service, in order. */
  readonly enabled: readonly string[];
  /** Models people named themselves. */
  readonly models?: readonly CustomModel[];
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
  readonly kept?: KeptSettings;
}

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
      /** The version they were written in: 1 is upgraded as it is read. */
      readonly from: 1 | 2;
    }
  /** Written by a newer editor: not to be written over, see `readAiSettings`. */
  | { readonly kind: "newer" }
  /** Not settings at all. */
  | { readonly kind: "broken" };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Names of fields that could hold a secret, which are never kept: see `KeptSettings`. */
const SECRET = /key|token|secret|password|credential|auth/i;

function withoutSecrets(value: unknown): unknown {
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([name]) => !SECRET.test(name)));
}

function unknownFields(
  value: Record<string, unknown>,
  known: ReadonlySet<string>,
): Record<string, unknown> | undefined {
  const entries = Object.entries(value).filter(([name]) => !known.has(name) && !SECRET.test(name));
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
]);
const SERVICE_FIELDS = new Set([
  "id",
  "kind",
  "name",
  "baseUrl",
  "route",
  "enabled",
  "models",
  "model",
]);

const isModelName = (value: unknown): value is string =>
  typeof value === "string" && value.trim() !== "" && value.length <= 200;

function readCustomModels(value: unknown): CustomModel[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<string>();
  const models = value.flatMap((item): CustomModel[] => {
    if (!isRecord(item) || !isModelName(item.id) || seen.has(item.id)) return [];
    seen.add(item.id);
    const window = item.contextWindow;
    return [
      {
        id: item.id,
        ...(typeof window === "number" &&
          Number.isSafeInteger(window) &&
          window > 0 && { contextWindow: window }),
      },
    ];
  });
  return models.length > 0 ? models : undefined;
}

/**
 * A service as either version wrote it, or nothing where it cannot be read. Version 1 has the one
 * model in `model`, which becomes the one turned on.
 */
function readService(value: unknown, version: 1 | 2): ServiceConfig | undefined {
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
  const models = version === 2 ? readCustomModels(value.models) : undefined;
  return { id, kind, name, baseUrl, route, enabled, ...(models && { models }) };
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
  if (!isRecord(value) || !Array.isArray(value.services)) return { kind: "broken" };
  const version = value.version;
  if (version !== undefined && version !== 1 && version !== AI_SETTINGS_VERSION) {
    return { kind: "newer" };
  }
  const from = version === AI_SETTINGS_VERSION ? 2 : 1;
  const services: ServiceConfig[] = [];
  const unread: unknown[] = [];
  const serviceFields: Record<string, Readonly<Record<string, unknown>>> = {};
  const ids = new Set<string>();
  for (const raw of value.services) {
    const service = readService(raw, from);
    if (!service || ids.has(service.id)) {
      unread.push(withoutSecrets(raw));
      continue;
    }
    ids.add(service.id);
    services.push(service);
    const extra = unknownFields(raw as Record<string, unknown>, SERVICE_FIELDS);
    if (extra) serviceFields[service.id] = extra;
  }

  let packFor = readPackFor(value.packFor);
  let showHiddenPacks = value.showHiddenPacks === true;
  let wanted: ModelRef | undefined;
  if (from === 2) {
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

  const reasoningFor = from === 2 ? readReasoningFor(value.reasoningFor) : undefined;
  const fields = unknownFields(value, TOP_FIELDS);
  const kept: KeptSettings = {
    ...(fields && { fields }),
    ...(Object.keys(serviceFields).length > 0 && { serviceFields }),
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
    ...(Object.keys(kept).length > 0 && { kept }),
  };
  return { kind: "ok", settings, from };
}

/**
 * The settings as they are saved: version 2, with what was not understood back in place, and with
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
    enabled: service.enabled,
    ...(service.models && service.models.length > 0 && { models: service.models }),
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
 * (kept apart, where pages of before do not write), `old` what is saved now. What the page of
 * before changed is taken over: names, addresses and routes, services it added or took away, a
 * model it picked (turned on, and the default if it was the one in use), the limit and the packs.
 * The rest stays as version 2 had it.
 */
export function recoverOldWrite(latest: AiSettings, old: unknown): AiSettings | undefined {
  const reading = readAiSettings(old);
  if (reading.kind !== "ok" || reading.from !== 1) return undefined;
  const now = reading.settings;
  // What the page of before read: the settings of version 2 as version 1 has them.
  const was = readAiSettings({ ...writeAiSettings(latest), version: undefined });
  if (was.kind !== "ok") return undefined;
  const before = new Map(was.settings.services.map((service) => [service.id, service]));
  const services = now.services.map((service): ServiceConfig => {
    const base = latest.services.find(({ id }) => id === service.id);
    if (!base) return service;
    const picked = service.enabled[0];
    const changed = picked !== undefined && picked !== before.get(service.id)?.enabled[0];
    return {
      ...base,
      name: service.name,
      baseUrl: service.baseUrl,
      route: service.route,
      enabled: changed && !base.enabled.includes(picked) ? [...base.enabled, picked] : base.enabled,
    };
  });
  const sameDefault =
    now.default?.service === was.settings.default?.service &&
    now.default?.model === was.settings.default?.model;
  const { packFor: _packs, showHiddenPacks: _shown, kept: _kept, ...rest } = latest;
  const serviceFields = latest.kept?.serviceFields;
  const kept: KeptSettings = {
    ...now.kept,
    ...(serviceFields && { serviceFields }),
  };
  return {
    ...rest,
    services,
    default: settledDefault(services, sameDefault ? latest.default : now.default),
    ...(now.packFor && { packFor: now.packFor }),
    ...(now.showHiddenPacks && { showHiddenPacks: true }),
    maxToolCalls: now.maxToolCalls,
    ...(Object.keys(kept).length > 0 && { kept }),
  };
}
