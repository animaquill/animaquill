import type { ProjectGroup } from "@animaquill/host";
import { isCloudKind, type ProjectCard } from "./cards.ts";

/**
 * The views of the start page, see the design of the start page (docs/design/start-and-cloud.md of
 * AnimaQuill Cloud), 6.1 and 6.2: each item of the side bar is a view on the right, which lists
 * the cards it is about, filtered, searched and sorted as people say. A library of their own or
 * "发现" later are items more, of the same kind. No DOM.
 */

/** A view on the right: one of the side bar, or a group by its id. */
export type ViewId = "recent" | "all" | "starred" | "exports" | `group:${string}`;

export const groupView = (group: string): ViewId => `group:${group}`;

export const groupOfView = (view: ViewId): string | undefined =>
  view.startsWith("group:") ? view.slice("group:".length) : undefined;

/** Which projects of a view show: all of them, those of the platform, or folders. */
export type Filter = "all" | "cloud" | "local";
export type Sort = "opened" | "updated" | "name";
export type Display = "cards" | "list";

export const SORTS: readonly Sort[] = ["opened", "updated", "name"];
export const DEFAULT_SORT: Sort = "updated";

/** An item of the side bar. */
export interface StartSection {
  readonly id: ViewId;
  /** Which block it is in. */
  readonly block: "projects" | "groups";
  /** What it is called: a word to translate, or the name of a group as it is. */
  readonly label: { readonly key: string } | { readonly text: string };
  /** How many projects it has, where it says. */
  readonly count: number | undefined;
}

export interface SectionInput {
  readonly cards: readonly ProjectCard[];
  /** The groups people see, in order, see `shownGroups`. */
  readonly groups: readonly ProjectGroup[];
  /** How many exports stopped halfway on this device. */
  readonly unfinishedExports: number;
}

/** The items of the side bar, in order: only those that have something to show, see 6.1. */
export function sectionsOf({ cards, groups, unfinishedExports }: SectionInput): StartSection[] {
  const starred = cards.filter((card) => card.starred).length;
  return [
    { id: "recent", block: "projects", label: { key: "start.view.recent" }, count: undefined },
    { id: "all", block: "projects", label: { key: "start.view.all" }, count: cards.length },
    ...(starred > 0
      ? [
          {
            id: "starred",
            block: "projects",
            label: { key: "start.view.starred" },
            count: starred,
          } as const,
        ]
      : []),
    ...(unfinishedExports > 0
      ? [
          {
            id: "exports",
            block: "projects",
            label: { key: "start.view.exports" },
            count: unfinishedExports,
          } as const,
        ]
      : []),
    ...groups.map((group): StartSection => ({
      id: groupView(group.id),
      block: "groups",
      label: { text: group.name },
      count: cards.filter((card) => card.group === group.id).length,
    })),
  ];
}

/** A view that is not there any more, such as a group taken away elsewhere, is "最近打开". */
export function viewThere(view: ViewId, sections: readonly StartSection[]): ViewId {
  return sections.some((section) => section.id === view) ? view : "recent";
}

/** Which filters there are: none where only one kind of project can be here at all, see 6.2. */
export function filtersOf({
  hasPlatform,
  canFolders,
}: {
  readonly hasPlatform: boolean;
  readonly canFolders: boolean;
}): Filter[] {
  return hasPlatform && canFolders ? ["all", "cloud", "local"] : [];
}

/** The cards of a view, before filtering: "最近打开" only has what was opened in this browser. */
export function cardsOfView(cards: readonly ProjectCard[], view: ViewId): ProjectCard[] {
  const group = groupOfView(view);
  if (group !== undefined) return cards.filter((card) => card.group === group);
  switch (view) {
    case "recent":
      return cards.filter((card) => card.openedAt !== undefined);
    case "starred":
      return cards.filter((card) => card.starred);
    case "exports":
      return [];
    default:
      return [...cards];
  }
}

export function passes(card: ProjectCard, filter: Filter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "cloud":
      return isCloudKind(card.kind);
    case "local":
      return card.kind === "local";
  }
}

const normalized = (text: string) => text.normalize("NFKC").toLocaleLowerCase("zh-CN").trim();

/** Whether a project is what people search for, by its name. */
export function matches(card: ProjectCard, search: string): boolean {
  const wanted = normalized(search);
  return wanted === "" || normalized(card.name).includes(wanted);
}

const byName = (a: ProjectCard, b: ProjectCard) =>
  a.name.localeCompare(b.name, "zh-CN", { numeric: true }) || a.id.localeCompare(b.id);

/** Later first; what has no time last, by name. */
const byTime =
  (of: (card: ProjectCard) => number | undefined) => (a: ProjectCard, b: ProjectCard) => {
    const at = of(a);
    const bt = of(b);
    if (at === bt) return byName(a, b);
    if (at === undefined) return 1;
    if (bt === undefined) return -1;
    return bt - at;
  };

export function sortCards(cards: readonly ProjectCard[], sort: Sort): ProjectCard[] {
  switch (sort) {
    case "opened":
      return cards.toSorted(byTime((card) => card.openedAt));
    case "updated":
      return cards.toSorted(byTime((card) => card.updatedAt));
    case "name":
      return cards.toSorted(byName);
  }
}

/** "最近打开" is always by when, see 6.1: people cannot sort it. */
export const sortOfView = (view: ViewId, sort: Sort): Sort => (view === "recent" ? "opened" : sort);

export interface ViewChoice {
  readonly view: ViewId;
  readonly filter: Filter;
  readonly search: string;
  readonly sort: Sort;
}

/** What a view lists, as people chose. */
export function viewCards(cards: readonly ProjectCard[], choice: ViewChoice): ProjectCard[] {
  const listed = cardsOfView(cards, choice.view).filter(
    (card) => passes(card, choice.filter) && matches(card, choice.search),
  );
  return sortCards(listed, sortOfView(choice.view, choice.sort));
}

/**
 * Whether the view shows the welcome in place of a grid, see 6.2: nothing was opened here yet, or
 * there is no project at all. Projects of the platform that were not opened here are listed under
 * it then, so that people on another computer see theirs.
 */
export function isWelcome(cards: readonly ProjectCard[], view: ViewId): boolean {
  if (view !== "recent" && view !== "all") return false;
  return cardsOfView(cards, view).length === 0;
}

/** What "你的云端项目" lists under the welcome. */
export function remoteCards(cards: readonly ProjectCard[]): ProjectCard[] {
  return sortCards(
    cards.filter((card) => card.kind === "cloudRemote"),
    "updated",
  );
}

/** How sorting and showing are for each view, as this browser keeps them, see 6.2. */
export interface ViewHabits {
  readonly sort: Sort;
  readonly display: Display;
}

export const DEFAULT_HABITS: ViewHabits = { sort: DEFAULT_SORT, display: "cards" };

/** What was kept of the habits of the views, of any version: what is not understood goes. */
export function readHabits(kept: unknown): ReadonlyMap<string, ViewHabits> {
  const habits = new Map<string, ViewHabits>();
  if (typeof kept !== "object" || kept === null) return habits;
  const views = (kept as { views?: unknown }).views;
  if (typeof views !== "object" || views === null) return habits;
  for (const [view, value] of Object.entries(views)) {
    const { sort, display } = (value ?? {}) as Partial<Record<keyof ViewHabits, unknown>>;
    habits.set(view, {
      sort: SORTS.includes(sort as Sort) ? (sort as Sort) : DEFAULT_SORT,
      display: display === "list" ? "list" : "cards",
    });
  }
  return habits;
}

export function writeHabits(habits: ReadonlyMap<string, ViewHabits>): unknown {
  return { version: 1, views: Object.fromEntries(habits) };
}
