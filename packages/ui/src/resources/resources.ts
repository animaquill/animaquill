import { fuzzyMatch } from "../workbench/fuzzy.ts";

/**
 * Resources, as the tabs that find and use them show them: everything that can be used again, see
 * docs/design/resource-panels.md. What they are and where they come from is plain data here, so
 * that the transitions tab, the effects and assets tabs and the explorer list them the same way.
 * Nothing here touches the DOM.
 */

/** Where a resource is: with the editor, in the project, or in a library that the project uses. */
export type ResourceSource =
  | { readonly kind: "built-in" }
  | { readonly kind: "project" }
  | { readonly kind: "library"; readonly library: string; readonly name: string };

export interface Resource<T = unknown> {
  /** Unique among all resources, and the same from one session to the next: recent use goes by it. */
  readonly id: string;
  readonly source: ResourceSource;
  /**
   * Its type, which says how it is used and where it can go: one of a fixed list, such as
   * `transition.enter`. See docs/design/libraries.md, "分类".
   */
  readonly type: string;
  readonly name: string;
  /** Free words for finding it, from whoever made it. */
  readonly tags: readonly string[];
  /** Other words it is found by that people do not see, such as how the project writes it. */
  readonly keywords?: readonly string[];
  /** What the tab that shows it needs to use it. */
  readonly data: T;
}

/** How a list of resources is grouped. "Recently used" always comes first. */
export type Grouping = "source" | "tag" | "type";

export const GROUPINGS: readonly Grouping[] = ["source", "tag", "type"];

/** What a group of resources is, for its heading. */
export type GroupKey =
  | { readonly kind: "recent" }
  | { readonly kind: "source"; readonly source: ResourceSource }
  /** Without a tag for the resources that have none. */
  | { readonly kind: "tag"; readonly tag: string | undefined }
  | { readonly kind: "type"; readonly type: string };

export interface ResourceGroup<T> {
  /** Unique among the groups of a list. */
  readonly id: string;
  readonly key: GroupKey;
  readonly items: readonly Resource<T>[];
}

/** How many recently used resources show first. */
export const RECENT_SHOWN = 6;

/** Where a source is, as a key that stays the same: one for each library. */
export const sourceKey = (source: ResourceSource): string =>
  source.kind === "library" ? `library:${source.library}` : source.kind;

const SOURCE_ORDER: Readonly<Record<ResourceSource["kind"], number>> = {
  "built-in": 0,
  project: 1,
  library: 2,
};

function compareSources(a: ResourceSource, b: ResourceSource): number {
  const order = SOURCE_ORDER[a.kind] - SOURCE_ORDER[b.kind];
  if (order !== 0) return order;
  return a.kind === "library" && b.kind === "library" ? a.name.localeCompare(b.name, "zh-CN") : 0;
}

/** How well a resource fits what people typed, or undefined when it does not. */
function scoreOf(resource: Resource, query: string): number | undefined {
  const scores = [resource.name, ...resource.tags, ...(resource.keywords ?? [])].flatMap(
    (text, index) => {
      const match = fuzzyMatch(query, text);
      // The name counts most: people see it.
      return match ? [match.score * (index === 0 ? 1 : 0.6)] : [];
    },
  );
  return scores.length > 0 ? Math.max(...scores) : undefined;
}

export interface BrowseOptions {
  readonly query: string;
  readonly grouping: Grouping;
  /** Ids of what was used, the most recent first. */
  readonly recent: readonly string[];
  /** Types in the order they show, see `GroupKey`. Others come after them. */
  readonly types?: readonly string[];
  /** A type that what is selected is about, which comes first after what was used recently. */
  readonly firstType?: string | undefined;
}

/** What of some resources shows as used recently, the most recent first. */
function recentOf<T>(resources: readonly Resource<T>[], recent: readonly string[]) {
  const byId = new Map(resources.map((resource) => [resource.id, resource]));
  return recent
    .flatMap((id) => {
      const resource = byId.get(id);
      return resource ? [resource] : [];
    })
    .slice(0, RECENT_SHOWN);
}

/** The ids that a list shows as used recently, in the order it shows them. */
export const recentShown = <T>(
  resources: readonly Resource<T>[],
  { query, recent }: Pick<BrowseOptions, "query" | "recent">,
): readonly string[] =>
  recentOf(query.trim() ? browseFound(resources, query.trim()) : resources, recent).map(
    ({ id }) => id,
  );

/** What fits what people typed, the best first. */
function browseFound<T>(resources: readonly Resource<T>[], typed: string): readonly Resource<T>[] {
  const scored = resources.flatMap((resource) => {
    const score = scoreOf(resource, typed);
    return score === undefined ? [] : [{ resource, score }];
  });
  return scored.toSorted((a, b) => b.score - a.score).map(({ resource }) => resource);
}

/**
 * The groups of resources that people see: what was used recently, then by where they are, by
 * their tags (one can be in several) or by their type. A query keeps those that fit, the best ones
 * first, in groups as they would be. Empty groups go.
 */
export function browse<T>(
  resources: readonly Resource<T>[],
  { query, grouping, recent, types = [], firstType }: BrowseOptions,
): readonly ResourceGroup<T>[] {
  const typed = query.trim();
  const found = typed ? browseFound(resources, typed) : resources;
  const recentItems = recentOf(found, recent);
  const groups: ResourceGroup<T>[] = [];
  if (recentItems.length > 0) {
    groups.push({ id: "recent", key: { kind: "recent" }, items: recentItems });
  }
  const by = new Map<string, { id: string; key: GroupKey; items: Resource<T>[] }>();
  const add = (id: string, key: GroupKey, resource: Resource<T>) => {
    const group = by.get(id) ?? { id, key, items: [] };
    by.set(id, group);
    group.items.push(resource);
  };
  for (const resource of found) {
    if (grouping === "source") {
      add(
        `source:${sourceKey(resource.source)}`,
        { kind: "source", source: resource.source },
        resource,
      );
    } else if (grouping === "type") {
      add(`type:${resource.type}`, { kind: "type", type: resource.type }, resource);
    } else if (resource.tags.length === 0) {
      add("tag:", { kind: "tag", tag: undefined }, resource);
    } else {
      for (const tag of new Set(resource.tags)) add(`tag:${tag}`, { kind: "tag", tag }, resource);
    }
  }
  const order = (key: GroupKey): readonly [number, string] => {
    if (key.kind === "type") {
      const index = types.indexOf(key.type);
      const placed = key.type === firstType ? -1 : index === -1 ? types.length : index;
      return [placed, key.type];
    }
    if (key.kind === "tag") return [key.tag === undefined ? 1 : 0, key.tag ?? ""];
    return [0, ""];
  };
  const rest = [...by.values()].toSorted((a, b) => {
    if (a.key.kind === "source" && b.key.kind === "source") {
      return compareSources(a.key.source, b.key.source);
    }
    const [first, firstName] = order(a.key);
    const [second, secondName] = order(b.key);
    return first - second || firstName.localeCompare(secondName, "zh-CN");
  });
  return [...groups, ...rest];
}

/** Recent use, the most recent first: what was used goes to the front, and the oldest go. */
export function usedNow(recent: readonly string[], id: string, limit: number): readonly string[] {
  return [id, ...recent.filter((known) => known !== id)].slice(0, limit);
}

/**
 * Recent use in the order an open list keeps, so that what people click does not move under the
 * mouse: what was used since `before` and is not among what the list shows (`showing`) comes first,
 * the most recent first; the rest stays in the order the list had (`order`), and what it did not
 * have goes after that. The list takes the order of `after` as it is when it is opened again.
 */
export function steadyRecent(
  order: readonly string[],
  before: readonly string[],
  after: readonly string[],
  showing: ReadonlySet<string>,
): readonly string[] {
  const was = new Map(before.map((id, index) => [id, index]));
  // Used since: new, or now in front of something that was in front of it. What was dropped
  // leaves the rest in the order they were.
  const used = new Set<string>();
  let behind = Number.POSITIVE_INFINITY;
  for (let index = after.length - 1; index >= 0; index--) {
    const id = after[index] as string;
    const place = was.get(id);
    if (place === undefined || place > behind) used.add(id);
    if (place !== undefined) behind = Math.min(behind, place);
  }
  const fresh = after.filter((id) => used.has(id) && !showing.has(id));
  const placed = new Set(fresh);
  const kept = new Set(after);
  const rest = order.filter((id) => kept.has(id) && !placed.has(id));
  for (const id of rest) placed.add(id);
  return [...fresh, ...rest, ...after.filter((id) => !placed.has(id))];
}
