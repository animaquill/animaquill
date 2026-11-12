import {
  groupTime,
  starTime,
  type FolderStatus,
  type ProjectGroup,
  type ProjectMarks,
  type ProjectSummary,
} from "@animaquill/host";
import type { TFunction } from "i18next";
import { httpsLink } from "../app/links.ts";
import { githubAbout, githubOfListed } from "../cloud/github-status.ts";
import { unusableLine, unusableWays } from "../cloud/unusable.ts";
import {
  markHint,
  type CloudMark,
  type CloudRow,
  type LocalRow,
  type StartLists,
} from "../cloud/start-list.ts";

/**
 * The cards of the start page, see the design of the start page (docs/design/start-and-cloud.md of
 * AnimaQuill Cloud), 6.3: every project once, as `StartList` found it, with how people organised
 * it, see `ProjectOrganizer`. What each card says and offers is worked out here, without the DOM,
 * so that tests read what people read.
 */

export type CardKind =
  /** A folder on this computer, not connected. */
  | "local"
  /** A folder on this computer, connected to a project of the platform. */
  | "cloudFolder"
  /** A project of the platform with a copy in this browser, and no folder. */
  | "cloudHere"
  /** A project of the platform that this browser has nothing of. */
  | "cloudRemote"
  /** Only in this browser, with no folder and no platform: from before, or of a test. */
  | "onlyHere";

const CLOUD_KINDS: ReadonlySet<CardKind> = new Set(["cloudFolder", "cloudHere", "cloudRemote"]);

export const isCloudKind = (kind: CardKind): boolean => CLOUD_KINDS.has(kind);

/** Where the star and the group of a project of the platform are kept, see `ProjectMarks`. */
export const cloudMarksKey = (project: string): string => `cloud:${project}`;

export interface ProjectCard {
  /** One card per project: the key this browser keeps it by, or `cloud:` and its id on the platform. */
  readonly id: string;
  readonly kind: CardKind;
  readonly name: string;
  /** What this browser keeps it by, see `CloudLink.key`: what its address says. */
  readonly key: string | undefined;
  /** Its id on the platform. */
  readonly project: string | undefined;
  /**
   * Where its star and its group are kept, see `ProjectMarks`. Undefined: it cannot be organised,
   * as a project of another account.
   */
  readonly marksKey: string | undefined;
  /** When it was last opened in this browser. Undefined: never, as far as this browser knows. */
  readonly openedAt: number | undefined;
  /** When it last changed, as far as anything here says. */
  readonly updatedAt: number | undefined;
  readonly starred: boolean;
  /** The id of its group, one that is there. */
  readonly group: string | undefined;
  /** Whose project of the platform it is, see `ProjectMarks.account`, where that is known. */
  readonly owner: string | undefined;
  /**
   * How long its main timeline is, in milliseconds, as the platform's list says: the cover kept in
   * this browser can say otherwise, see `StartCovers`.
   */
  readonly durationMs: number | undefined;
  /** Its cover on the platform, as the list says, see `CloudProjectSummary.cover`. */
  readonly cover: { readonly etag: string; readonly at: number } | undefined;
  /** What it came from. */
  readonly source:
    | { readonly kind: "local"; readonly row: LocalRow }
    | { readonly kind: "cloud"; readonly row: CloudRow }
    | {
        readonly kind: "browser";
        readonly summary: ProjectSummary;
        /** It is known to be only here, see `StartLists.browserKnown`. */
        readonly known: boolean;
      };
}

export interface Organized {
  readonly marks: ReadonlyMap<string, ProjectMarks>;
  /** The groups there are, without those taken away. */
  readonly groups: readonly ProjectGroup[];
}

export const NOTHING_ORGANIZED: Organized = { marks: new Map(), groups: [] };

/** Where a star or a group of a card is kept, see `StartOrganizer.star`. */
export interface MarksTarget {
  readonly key: string;
  /**
   * What this browser keeps a project of the platform by, which is written too: a folder that is
   * disconnected later, or a copy that the platform no longer has, keeps how it was organised.
   */
  readonly also?: string;
  /** Whose project of the platform it is. */
  readonly account?: string;
}

/** Where the star and the group of a card go, or undefined where it cannot be organised. */
export function marksTargetOf(card: ProjectCard): MarksTarget | undefined {
  if (card.marksKey === undefined) return undefined;
  return {
    key: card.marksKey,
    ...(card.key !== undefined && card.key !== card.marksKey && { also: card.key }),
    ...(card.owner !== undefined && { account: card.owner }),
  };
}

/** The groups people see: those not taken away, by name. */
export function shownGroups(groups: readonly ProjectGroup[]): ProjectGroup[] {
  return groups
    .filter((group) => group.deleted !== true)
    .toSorted((a, b) => a.name.localeCompare(b.name, "zh-CN", { numeric: true }));
}

const latest = (...times: (number | undefined)[]): number | undefined => {
  const known = times.filter((at): at is number => at !== undefined);
  return known.length > 0 ? Math.max(...known) : undefined;
};

/** The cards of every project there is, in no particular order: views sort them. */
export function composeCards(lists: StartLists, organized: Organized): ProjectCard[] {
  const { marks } = organized;
  const groups = new Set(organized.groups.filter((group) => !group.deleted).map(({ id }) => id));
  /**
   * The star and the group, each as it was last changed: kept by the project of the platform, or
   * by what this browser keeps it by, as for a folder organised before it was connected, or one
   * that was disconnected since. Both are written while it is connected, see `marksTargetOf`.
   */
  const organizing = (
    key: string | undefined,
    project: string | undefined,
    mark: CloudMark | undefined,
    owner: string | undefined,
  ) => {
    if (mark?.kind === "otherAccount") {
      return { marksKey: undefined, starred: false, group: undefined, owner: undefined };
    }
    const own = key === undefined ? undefined : marks.get(key);
    const cloud = project === undefined ? undefined : marks.get(cloudMarksKey(project));
    /** Of the two that say something of it, the one that said it last; the platform's at a tie. */
    const later = <K extends "starredAt" | "group">(
      field: K,
      time: (marks: ProjectMarks | undefined) => number,
    ): ProjectMarks[K] | undefined => {
      const saying = [cloud, own].filter((each) => each?.[field] !== undefined);
      const [first, second] = saying;
      if (!first) return undefined;
      return (!second || time(first) >= time(second) ? first : second)[field];
    };
    const starredAt = later("starredAt", starTime);
    const group = later("group", groupTime);
    return {
      marksKey: project === undefined ? key : cloudMarksKey(project),
      starred: starredAt !== undefined && starredAt !== null,
      group: group !== undefined && group !== null && groups.has(group) ? group : undefined,
      owner: project === undefined ? undefined : owner,
    };
  };
  const openedOf = (key: string | undefined) =>
    key === undefined ? undefined : marks.get(key)?.openedAt;

  const local = lists.local.map((row): ProjectCard => {
    const linked = row.project !== undefined;
    return {
      id: row.key,
      kind: linked ? "cloudFolder" : "local",
      name: row.name,
      key: row.key,
      project: row.project,
      ...organizing(row.key, row.project, row.mark, row.owner),
      openedAt: latest(row.openedAt, openedOf(row.key)),
      updatedAt: row.updatedAt,
      durationMs: row.durationMs,
      cover: row.cover,
      source: { kind: "local", row },
    };
  });
  const cloud = lists.cloud.map((row): ProjectCard => {
    const here = row.key !== undefined;
    return {
      id: row.key ?? cloudMarksKey(row.project),
      kind: here ? "cloudHere" : "cloudRemote",
      name: row.name,
      key: row.key,
      project: row.project,
      ...organizing(row.key, row.project, row.mark, row.owner),
      // A copy from before this was noted was opened here at some point: when it last changed is
      // the best there is to go by.
      openedAt: here ? (openedOf(row.key) ?? row.updatedAt) : undefined,
      updatedAt: row.updatedAt,
      durationMs: row.durationMs,
      cover: row.cover,
      source: { kind: "cloud", row },
    };
  });
  const browser = lists.browser.map((summary): ProjectCard => ({
    id: summary.id,
    kind: "onlyHere",
    name: summary.name,
    key: summary.id,
    project: undefined,
    ...organizing(summary.id, undefined, undefined, undefined),
    openedAt: openedOf(summary.id) ?? summary.updatedAt,
    updatedAt: summary.updatedAt,
    durationMs: undefined,
    cover: undefined,
    source: { kind: "browser", summary, known: lists.browserKnown },
  }));
  return [...local, ...cloud, ...browser];
}

// ---- what a card says

export type StatusTone = "plain" | "warning";

/**
 * Where a project is, for the small sign before its line: a folder of this computer, a project of
 * the platform, one of those with a folder of this computer too, or only this browser.
 */
export type CardPlace = "cloud" | "cloudFolder" | "folder" | "browser";

export interface CardStatus {
  /** Where it is, for the small sign before the line. */
  readonly place: CardPlace;
  /** The line under the name, such as "本地 · intro" or "云端 · 只在这个浏览器里". */
  readonly text: string;
  readonly tone: StatusTone;
  /** It stands out more than a warning: saving into GitHub went wrong. */
  readonly alert?: true;
  /** What the line means and what people can do, for hovering. */
  readonly hint: string | undefined;
}

const plain = { interpolation: { escapeValue: false } } as const;

/** What a project of the platform needs people to do, on the line in place of where it is. */
function cloudTrouble(
  mark: CloudMark,
  { pending, needsSignIn }: { readonly pending: boolean; readonly needsSignIn: boolean },
  t: TFunction,
): string | undefined {
  switch (mark.kind) {
    case "attention":
      return t("start.status.attention");
    case "noRepository":
      return t("start.status.noRepository");
    case "otherAccount":
      return t("start.status.otherAccount");
    default:
      if (needsSignIn) return t("start.status.afterSignIn");
      return pending ? t("start.status.pending") : undefined;
  }
}

/** What the platform says of a card of one of its projects, see `CloudRow`, or undefined. */
const platformOf = (card: ProjectCard) => {
  const { source } = card;
  if (source.kind === "browser") return undefined;
  if (source.kind === "local" && card.kind === "local") return undefined;
  return source.row;
};

/**
 * Whether the repository of the project of a card cannot be used, and so the project cannot be
 * edited, see the design, 5.1: the card opens no project then, and says why and what helps.
 */
export function isUnusable(card: ProjectCard): boolean {
  return platformOf(card)?.unusable !== undefined;
}

/**
 * The line of a card. `folder`: how its folder is, once that is known; looking can take a while,
 * as on a network. `now`: for how many days the platform keeps a project that cannot be edited.
 */
export function cardStatus(
  card: ProjectCard,
  folder: FolderStatus | undefined,
  t: TFunction,
  now = Date.now(),
): CardStatus {
  const { source } = card;
  // What says most: a project that cannot be edited, then one that cannot get into its repository,
  // as the platform keeps it a week only. Changes on their way there say so, as nothing to do.
  const platform = platformOf(card);
  const where: CardPlace = card.kind === "cloudFolder" ? "cloudFolder" : "cloud";
  if (platform?.unusable) {
    return {
      place: where,
      text: unusableLine(platform.unusable, now, t),
      tone: "warning",
      hint: t("start.hint.unusable"),
    };
  }
  const github = platform?.archive && githubOfListed(platform.archive, now, t);
  if (github?.kind === "error" && github.cause !== "noRepository") {
    return {
      place: where,
      text: t("start.status.githubFailed"),
      tone: "warning",
      alert: true,
      hint: githubAbout(github, t),
    };
  }
  const githubWord = github?.kind === "pending" ? t("start.status.githubPending") : undefined;
  if (source.kind === "browser") {
    return source.known
      ? {
          place: "browser",
          text: t("start.mark.onlyHere"),
          tone: "warning",
          hint: t("start.hint.onlyHere"),
        }
      : { place: "browser", text: t("start.status.inBrowser"), tone: "plain", hint: undefined };
  }
  if (source.kind === "local") {
    const { row } = source;
    const isGone = folder === "gone" || folder === "blocked";
    if (card.kind === "local" || row.mark === undefined) {
      return isGone
        ? {
            place: "folder",
            text: t(`folder.recentStatus.${folder}`),
            tone: "warning",
            hint: undefined,
          }
        : {
            place: "folder",
            text: t("start.status.local", { folder: row.folder, ...plain }),
            tone: "plain",
            hint: t("folder.folderLabel", { folder: row.folder, ...plain }),
          };
    }
    const trouble = isGone
      ? t(`folder.recentStatus.${folder}`)
      : cloudTrouble(row.mark, { pending: row.pending, needsSignIn: false }, t);
    return {
      place: "cloudFolder",
      text: t("start.status.cloud", {
        what: trouble ?? githubWord ?? t("start.status.withFolder"),
        ...plain,
      }),
      tone: trouble === undefined ? "plain" : "warning",
      hint:
        markHint(row.mark, t) ??
        (githubWord !== undefined && github
          ? githubAbout(github, t)
          : t("folder.folderLabel", { folder: row.folder, ...plain })),
    };
  }
  const { row } = source;
  const trouble = cloudTrouble(row.mark, row, t);
  const place =
    row.key !== undefined
      ? t("start.status.onlyBrowser")
      : row.copy === "live"
        ? t("start.status.notHere")
        : t("start.status.fromGitHub");
  return {
    place: "cloud",
    text: t("start.status.cloud", { what: trouble ?? githubWord ?? place, ...plain }),
    tone: trouble === undefined ? "plain" : "warning",
    hint:
      markHint(row.mark, t) ??
      (githubWord !== undefined && github ? githubAbout(github, t) : undefined),
  };
}

/** Where a project is, for the column of the list: its repository, or its folder. */
export function cardPlace(card: ProjectCard, t: TFunction): string {
  const { source } = card;
  if (source.kind === "browser") return t("start.place.browser");
  if (source.kind === "local") {
    const { row } = source;
    const repository =
      row.mark?.kind === "linked" || row.mark?.kind === "attention"
        ? row.mark.repository
        : undefined;
    return card.kind === "local"
      ? t("start.place.local", { folder: row.folder, ...plain })
      : t("start.place.cloud", { where: repository ?? row.folder, ...plain });
  }
  return t("start.place.cloud", {
    where: source.row.repository?.fullName ?? t("start.place.noRepository"),
    ...plain,
  });
}

// ---- what a card offers

export type CardAction =
  | "open"
  | "rename"
  | "star"
  | "unstar"
  | "moveToGroup"
  | "connect"
  | "linkFolder"
  | "disconnect"
  | "removeHere"
  | "openOnGitHub"
  | "deleteCloud"
  /** A copy into a folder, as a project of this computer that does not sync. */
  | "saveAsLocal"
  /** Asks GitHub again about a repository that cannot be used. */
  | "recheck"
  | "reauthorize"
  | "reinstall"
  | "restoreApp"
  | "switchRepository"
  | "findAgain"
  | "saveElsewhere"
  | "releaseCopies"
  | "removeFromList"
  | "moveToFolder"
  | "saveCopy"
  | "delete";

export interface CardContext {
  /** The editor is hosted on a platform. */
  readonly hasPlatform: boolean;
  /** This browser can write folders. */
  readonly canFolders: boolean;
  /** How its folder is, where it has one and that is known. */
  readonly folder: FolderStatus | undefined;
  /** Bytes of copies of its files that this browser keeps and can let go of, see `releaseCopies`. */
  readonly copies: number;
}

/** Where "在 GitHub 上打开" goes: only an https address. */
export function gitHubAddress(card: ProjectCard): string | undefined {
  const { source } = card;
  if (source.kind === "local") return httpsLink(source.row.repositoryUrl);
  if (source.kind === "cloud") return httpsLink(source.row.repository?.url);
  return undefined;
}

/**
 * What the menu of a card offers, in groups: only what works now, see the design, 6.3. What every
 * card has first, then what is of its kind.
 */
export function cardActions(card: ProjectCard, context: CardContext): CardAction[][] {
  const { hasPlatform, canFolders } = context;
  // Only a folder has a status, and copies of files people brought in.
  const isFolder = card.source.kind === "local";
  const folder = isFolder ? context.folder : undefined;
  const copies = isFolder ? context.copies : 0;
  const isGone = folder === "gone" || folder === "blocked";
  const when = (isThere: boolean, ...actions: CardAction[]): CardAction[] =>
    isThere ? actions : [];
  const github = when(gitHubAddress(card) !== undefined, "openOnGitHub");
  const deletable = when(
    card.source.kind !== "browser" && card.source.row.deletable,
    "deleteCloud",
  );
  const platform = platformOf(card);
  const unusable = platform?.unusable;
  // What the platform has of it to copy, or what this browser has: not once both are gone.
  const hasContent = platform?.copy === "live" || card.key !== undefined;
  const savable = when(canFolders && hasPlatform && hasContent, "saveAsLocal");
  const common: CardAction[] = [
    "open",
    // One that this browser has nothing of has to change on the platform: not yet. One that
    // cannot be edited cannot be renamed either.
    ...when(card.kind !== "cloudRemote" && !unusable, "rename"),
    ...when(card.marksKey !== undefined, card.starred ? "unstar" : "star", "moveToGroup"),
  ];
  const folderGone = when(isGone, "findAgain", "saveElsewhere");
  const kept = when(copies > 0, "releaseCopies");
  const groups = (): CardAction[][] => {
    if (unusable && card.kind !== "local" && card.kind !== "onlyHere") {
      // Why it cannot be edited and what helps, see the design, 5.1.
      const ways: CardAction[] = unusableWays(unusable, {
        hasContent: platform?.copy === "live",
      });
      return [
        common,
        [
          ...savable,
          ...ways,
          ...when(card.kind === "cloudFolder" && !isGone, "disconnect"),
          ...github,
        ],
        [
          ...when(card.kind === "cloudFolder", "removeFromList"),
          ...when(card.kind === "cloudHere", "removeHere"),
          ...deletable,
        ],
      ];
    }
    switch (card.kind) {
      case "local":
        return [
          common,
          [...when(hasPlatform && !isGone, "connect"), ...folderGone, ...kept],
          ["removeFromList"],
        ];
      case "cloudFolder":
        return [
          common,
          [...when(!isGone, "disconnect"), ...savable, ...folderGone, ...github, ...kept],
          ["removeFromList", ...deletable],
        ];
      case "cloudHere":
        return [
          common,
          [...when(canFolders, "linkFolder"), ...savable, ...github],
          ["removeHere", ...deletable],
        ];
      case "cloudRemote":
        return [common, [...when(canFolders, "linkFolder"), ...savable, ...github], deletable];
      case "onlyHere":
        return [
          common,
          [...when(canFolders, "moveToFolder"), ...when(hasPlatform, "connect"), "saveCopy"],
          ["delete"],
        ];
    }
  };
  return groups().filter((group) => group.length > 0);
}

/**
 * What the dialog of a card whose project cannot be edited offers, see `isUnusable`: the ways out
 * of its menu, deleting it last.
 */
export function unusableChoices(card: ProjectCard, context: CardContext): CardAction[] {
  const [, ways = [], last = []] = cardActions(card, context);
  return [
    ...ways.filter((action) => action !== "openOnGitHub"),
    ...last.filter((action) => action === "deleteCloud"),
  ];
}

/** Menu items that take something away, which show as such. */
export const DANGEROUS: ReadonlySet<CardAction> = new Set(["deleteCloud", "delete"]);

// ---- what a card looks like without a cover

/** How many colors there are for a project without a cover, see `--aq-cover-1` and on. */
export const COVER_COLORS = 8;

/**
 * Which color a project without a cover gets, 1 to `COVER_COLORS`: always the same one for it,
 * wherever it is listed, by its id on the platform or what this browser keeps it by.
 */
export function coverColorOf(card: ProjectCard): number {
  const of = card.project ?? card.id;
  // FNV-1a: cheap, and the same in every browser.
  let hash = 0x811c9dc5;
  for (let index = 0; index < of.length; index += 1) {
    hash ^= of.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return ((hash >>> 0) % COVER_COLORS) + 1;
}

/** The first letter of its name, for the picture of a project without a cover. */
export function initialOf(name: string): string {
  const [first] = [...name.trim()];
  return first === undefined ? "?" : first.toLocaleUpperCase("zh-CN");
}
