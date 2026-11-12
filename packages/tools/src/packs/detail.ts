/**
 * How much results give, in three steps a model pack chooses from: only how many lines and how
 * long, never what a line looks like. A model that passes `limit` or `response_format` itself gets
 * what it asked for, within the same maximum.
 */
export const DETAILS = ["concise", "standard", "detailed"] as const;

export type Detail = (typeof DETAILS)[number];

export interface DetailLimits {
  /** How many clips aq_timeline_read lists without `limit`. */
  readonly timeline: number;
  /** How many results aq_search gives without `limit`. */
  readonly search: number;
  /** How many problems aq_check_run lists without `limit`. */
  readonly problems: number;
  /** What aq_object_read gives without `response_format`. */
  readonly objects: "concise" | "detailed";
  /** How many changed objects a result of aq_edit names. */
  readonly changed: number;
  /** How many scenes, sounds, assets and code files the overview lists of each. */
  readonly listed: number;
  /** How long one result may be, in characters. */
  readonly result: number;
}

export const DETAIL_LIMITS: Readonly<Record<Detail, DetailLimits>> = {
  concise: {
    timeline: 100,
    search: 25,
    problems: 50,
    objects: "concise",
    changed: 10,
    listed: 15,
    result: 20_000,
  },
  // What results gave before there were steps: the default pack has it.
  standard: {
    timeline: 200,
    search: 50,
    problems: 100,
    objects: "detailed",
    changed: 20,
    listed: 30,
    result: 40_000,
  },
  detailed: {
    timeline: 500,
    search: 100,
    problems: 200,
    objects: "detailed",
    changed: 40,
    listed: 60,
    result: 40_000,
  },
};

/**
 * What `{default}` stands for in the words of a parameter, by its key: the value it has when the
 * model leaves it out, at a step of detail. `{max}` is the most its schema takes, wherever it says.
 */
export const DEFAULTS: Readonly<Record<string, (limits: DetailLimits) => string>> = {
  "tools.aq_timeline_read.params.limit": (limits) => String(limits.timeline),
  "tools.aq_search.params.limit": (limits) => String(limits.search),
  "tools.aq_check_run.params.limit": (limits) => String(limits.problems),
  "tools.aq_object_read.params.response_format": (limits) => JSON.stringify(limits.objects),
  "tools.aq_file_read.params.limit": () => "2000",
};

/** What `{listed}` stands for, by key: how many the overview lists of each kind. */
export const LISTED_KEYS: ReadonlySet<string> = new Set(["tools.aq_project_status.description"]);

const PLACEHOLDER = /\{(default|max|listed)\}/g;

/**
 * A table with `{default}`, `{max}` and `{listed}` put in as a step of detail has them, where its
 * key has them: words that say how many a result gives say what it does give. Other braces stay.
 */
export function filledTexts<T extends Readonly<Record<string, unknown>>>(
  texts: T,
  limits: DetailLimits,
  maximum: (key: string) => number | undefined,
): T {
  let changed = false;
  const filled: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(texts)) {
    if (typeof value !== "string" || !value.includes("{")) {
      filled[key] = value;
      continue;
    }
    const text = value.replace(PLACEHOLDER, (whole, name: string) => {
      const put =
        name === "default"
          ? DEFAULTS[key]?.(limits)
          : name === "max"
            ? maximum(key)?.toString()
            : LISTED_KEYS.has(key)
              ? String(limits.listed)
              : undefined;
      return put ?? whole;
    });
    if (text !== value) changed = true;
    filled[key] = text;
  }
  return changed ? (filled as T) : texts;
}
