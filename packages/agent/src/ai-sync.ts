/**
 * The AI settings as entries, to go with an account (see `@animaquill/host/ai-sync`): each service,
 * the order of the services, the default model, each choice of a pack and of how hard a model
 * reasons, each other field, each installed pack is one entry, merged on its own. This turns the
 * settings as they are saved (`writeAiSettings`, and the installed packs) into entries and back.
 *
 * What this editor does not know goes as it is: a field of a newer editor is an entry of its own
 * (`field:<name>`), a service of a kind it does not have is a service like any other. Only what is
 * worked out from the rest is left out (`current`, each service's `model`): the settings work them
 * out again as they are saved.
 */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Fields of the saved settings that are entries of their own kind, or worked out from others. */
const NOT_FIELDS = new Set([
  "version",
  "services",
  "default",
  "current",
  "reasoningFor",
  "packFor",
]);

/** Whether an entry is of the installed packs, rather than of the settings. */
export const isPackEntry = (name: string): boolean => name.startsWith("installed:");

/**
 * The settings as saved (`writeAiSettings`) as entries, or undefined where that is not what they
 * are: nothing is taken from them then, rather than everything taken for gone.
 */
export function entriesOfSettings(saved: unknown): Map<string, unknown> | undefined {
  if (!isRecord(saved) || !Array.isArray(saved.services)) return undefined;
  if (saved.version !== 2) return undefined;
  const entries = new Map<string, unknown>();
  const order: string[] = [];
  for (const service of saved.services) {
    if (!isRecord(service) || typeof service.id !== "string" || service.id === "") continue;
    if (entries.has(`service:${service.id}`)) continue;
    const { model: _model, ...rest } = service;
    entries.set(`service:${service.id}`, rest);
    order.push(service.id);
  }
  entries.set("order", order);
  entries.set("default", isRecord(saved.default) ? saved.default : null);
  for (const [kind, field] of [
    ["reasoning", "reasoningFor"],
    ["pack", "packFor"],
  ] as const) {
    const map = saved[field];
    if (!isRecord(map)) continue;
    for (const [model, value] of Object.entries(map)) entries.set(`${kind}:${model}`, value);
  }
  for (const [name, value] of Object.entries(saved)) {
    if (!NOT_FIELDS.has(name) && value !== undefined) entries.set(`field:${name}`, value);
  }
  return entries;
}

/** What an installed pack is known by among the others: where it came from. */
function packName(pack: Record<string, unknown>): string | undefined {
  const source = pack.source;
  if (isRecord(source) && typeof source.kind === "string") {
    const from = typeof source.url === "string" ? source.url : source.name;
    if (typeof from === "string") return `installed:${source.kind}:${from}`.slice(0, 300);
  }
  return typeof pack.installedAt === "number" ? `installed:at:${pack.installedAt}` : undefined;
}

/** The installed packs as saved (`ModelPacks` of the editor) as entries. */
export function entriesOfPacks(saved: unknown): Map<string, unknown> {
  const entries = new Map<string, unknown>();
  const packs = isRecord(saved) && Array.isArray(saved.packs) ? saved.packs : [];
  for (const pack of packs) {
    if (!isRecord(pack)) continue;
    const name = packName(pack);
    if (name !== undefined) entries.set(name, pack);
  }
  return entries;
}

/** The settings to save, from entries: as `writeAiSettings` writes them, but what it works out. */
export function settingsOfEntries(entries: ReadonlyMap<string, unknown>): Record<string, unknown> {
  const services = new Map<string, unknown>();
  const reasoningFor: Record<string, unknown> = {};
  const packFor: Record<string, unknown> = {};
  const fields: Record<string, unknown> = {};
  let order: readonly unknown[] = [];
  let chosen: unknown = null;
  for (const [name, value] of entries) {
    const colon = name.indexOf(":");
    const kind = colon < 0 ? name : name.slice(0, colon);
    const of = name.slice(colon + 1);
    if (kind === "service" && colon >= 0) services.set(of, value);
    else if (kind === "order" && Array.isArray(value)) order = value;
    else if (kind === "default") chosen = value;
    else if (kind === "reasoning" && colon >= 0) reasoningFor[of] = value;
    else if (kind === "pack" && colon >= 0) packFor[of] = value;
    else if (kind === "field" && colon >= 0 && !NOT_FIELDS.has(of)) fields[of] = value;
  }
  // In the order last given, then those it does not have yet, as they were added elsewhere.
  const ids = [
    ...new Set([
      ...order.filter((id): id is string => typeof id === "string" && services.has(id)),
      ...[...services.keys()].toSorted(),
    ]),
  ];
  return {
    ...fields,
    version: 2,
    services: ids.map((id) => services.get(id)),
    ...(isRecord(chosen) && { default: chosen }),
    ...(Object.keys(reasoningFor).length > 0 && { reasoningFor }),
    ...(Object.keys(packFor).length > 0 && { packFor }),
  };
}

/** The installed packs to save, from entries. */
export function packsOfEntries(entries: ReadonlyMap<string, unknown>): { packs: unknown[] } {
  const packs = [...entries]
    .filter(([name]) => isPackEntry(name))
    .map(([, pack]) => pack)
    .toSorted(
      (a, b) =>
        (isRecord(a) && typeof a.installedAt === "number" ? a.installedAt : 0) -
        (isRecord(b) && typeof b.installedAt === "number" ? b.installedAt : 0),
    );
  return { packs };
}

/** A value as text that does not depend on the order of the fields. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isRecord(value))
    return `{${Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .toSorted()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

/**
 * What changed from `before` to `after`: entries that are new or other than they were, and those
 * that are gone. Only of the names `of` says, so that the settings and the packs go apart.
 */
export function entryChanges(
  before: ReadonlyMap<string, unknown>,
  after: ReadonlyMap<string, unknown>,
): {
  readonly changed: readonly (readonly [string, unknown])[];
  readonly removed: readonly string[];
} {
  const changed: [string, unknown][] = [];
  for (const [name, value] of after) {
    if (!before.has(name) || canonical(before.get(name)) !== canonical(value))
      changed.push([name, value]);
  }
  const removed = [...before.keys()].filter((name) => !after.has(name));
  return { changed, removed };
}
