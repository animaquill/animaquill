import type {
  RepositoryChoice,
  RepositoryPause,
  RepositoryRefusal,
  RepositoryStatus,
} from "@animaquill/host";
import type { TFunction } from "i18next";

/**
 * How saving a project to GitHub reads, see docs/design/phase5-step14.md 3.1.10: what the platform
 * says about archiving, and why a repository cannot be chosen, in words. No DOM, so that tests read
 * what people read. The words for Git are the editor's own: "存档", never commit or push.
 */

const PAUSES: ReadonlySet<string> = new Set<RepositoryPause>([
  "diverged",
  "gone",
  "uninstalled",
  "suspended",
  "archived",
  "protected",
  "transferred",
  "manifest",
  "invalid",
]);

/** A reason the editor knows, or undefined for one of a newer platform. */
export const knownPause = (reason: string | undefined): RepositoryPause | undefined =>
  reason !== undefined && PAUSES.has(reason) ? (reason as RepositoryPause) : undefined;

const plain = { interpolation: { escapeValue: false } } as const;

/** At most this many paths in a line, then "等 N 个". */
const PATHS_IN_A_LINE = 5;

export const pathList = (paths: readonly string[]): string =>
  paths.length <= PATHS_IN_A_LINE
    ? paths.join("、")
    : `${paths.slice(0, PATHS_IN_A_LINE).join("、")} 等 ${paths.length} 个`;

const clock = new Intl.DateTimeFormat("zh-CN", {
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() &&
  a.getMonth() === b.getMonth() &&
  a.getDate() === b.getDate();

/**
 * A moment as people say it: "刚刚" for the last minute, the time for others of today, and the day
 * too for others.
 */
export function momentText(at: number, now: number, t: TFunction): string {
  if (at <= now && now - at < 60_000) return t("repository.status.justNow");
  const when = new Date(at);
  return sameDay(when, new Date(now))
    ? clock.format(when)
    : `${when.getMonth() + 1}月${when.getDate()}日 ${clock.format(when)}`;
}

/** Why archiving paused, and what helps. */
export function pauseText(
  status: Pick<RepositoryStatus, "reason" | "diverged">,
  t: TFunction,
): { readonly reason: string; readonly fix: string } {
  const known = knownPause(status.reason);
  if (known === "diverged")
    return {
      reason: t("repository.pause.diverged", { count: status.diverged?.files.length ?? 0 }),
      fix: t("repository.fix.diverged"),
    };
  if (known) return { reason: t(`repository.pause.${known}`), fix: t(`repository.fix.${known}`) };
  return {
    reason: t("repository.pause.other", { reason: status.reason ?? "?", ...plain }),
    fix: t("repository.fix.other"),
  };
}

/**
 * What the platform's own short word about a pause is worth showing: GitHub's words for a branch it
 * does not let move, and what is wrong with the project's files. The others are notes for whoever
 * runs the platform.
 */
export function pauseDetail(
  status: Pick<RepositoryStatus, "reason" | "detail">,
  t: TFunction,
): string | undefined {
  const { reason, detail } = status;
  if (!detail) return undefined;
  if (reason === "protected") return t("repository.status.said", { detail, ...plain });
  if (reason === "manifest" || reason === "invalid")
    return t("repository.status.detail", { detail, ...plain });
  return undefined;
}

/**
 * How archiving goes, in one line: running, waiting for changes to settle, done, or paused. For a
 * project that is not saved to GitHub, that it is not.
 */
export function archiveStateText(status: RepositoryStatus, now: number, t: TFunction): string {
  if (status.state === "none") return t("repository.status.none");
  if (status.state === "paused")
    return t("repository.status.paused", { reason: pauseText(status, t).reason, ...plain });
  if (status.archiving) return t("repository.status.archiving");
  if (status.retryAt !== undefined && (status.failures ?? 0) > 0)
    return t("repository.status.retry", { time: momentText(status.retryAt, now, t) });
  if (status.dirtySince !== undefined || status.head > status.archivedSeq) {
    if (status.nextAt === undefined || status.nextAt <= now)
      return t("repository.status.waitingSoon");
    return t("repository.status.waiting", {
      count: Math.max(1, Math.ceil((status.nextAt - now) / 60_000)),
    });
  }
  return t("repository.status.upToDate");
}

export function lastArchiveText(status: RepositoryStatus, now: number, t: TFunction): string {
  const last = status.lastArchive;
  return last
    ? t("repository.status.last", { time: momentText(last.at, now, t) })
    : t("repository.status.never");
}

/** The files the last archive could not write, or undefined where it wrote them all. */
export function keptText(status: RepositoryStatus, t: TFunction): string | undefined {
  const kept = status.kept ?? [];
  return kept.length === 0
    ? undefined
    : t("repository.status.kept", { files: pathList(kept), ...plain });
}

export function repositoryText(
  repository: NonNullable<RepositoryStatus["repository"]>,
  t: TFunction,
): string {
  return t("repository.status.repository", {
    name: repository.fullName,
    visibility: t(repository.private ? "repository.private" : "repository.public"),
    ...plain,
  });
}

/** What the platform said about a repository people tried to choose. */
export interface ChoiceRefusal {
  readonly code: RepositoryRefusal;
  /** For "hasProject": what of a project is there. */
  readonly files?: readonly string[];
}

export type UnusableReason =
  "current" | "notPushable" | "archived" | "linked" | "hasProject" | "notFound";

/**
 * Why a repository cannot be chosen, or undefined where it can: as the list says, and as the
 * platform said when people tried it (a project at its top shows only then).
 */
export function unusableReason(
  choice: RepositoryChoice,
  refusal: ChoiceRefusal | undefined,
  current: number | undefined,
): UnusableReason | undefined {
  if (choice.id === current) return "current";
  if (!choice.pushable || refusal?.code === "notPushable") return "notPushable";
  if (choice.archived) return "archived";
  if (choice.linked || refusal?.code === "linkedElsewhere") return "linked";
  if (refusal?.code === "hasProject") return "hasProject";
  if (refusal?.code === "notFound") return "notFound";
  return undefined;
}

export function unusableText(
  reason: UnusableReason,
  refusal: ChoiceRefusal | undefined,
  t: TFunction,
): string {
  if (reason === "hasProject")
    return t("repository.unusable.hasProject", {
      files: pathList(refusal?.files ?? []),
      ...plain,
    });
  return t(`repository.unusable.${reason}`);
}

export type NameProblem = "empty" | "tooLong" | "characters" | "dots" | "dotGit";

/** What GitHub does not take as a repository name, as the platform checks it too. */
export function nameProblem(name: string): NameProblem | undefined {
  if (name.length === 0) return "empty";
  if (name.length > 100) return "tooLong";
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return "characters";
  if (name === "." || name === "..") return "dots";
  if (/\.git$/i.test(name)) return "dotGit";
  return undefined;
}

/**
 * The name a new repository gets at first: the project's name where GitHub takes it as it is, in
 * lower case with dashes for spaces, and otherwise its id, as names are mostly Chinese.
 */
export function defaultRepositoryName(name: string, id: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replaceAll(/\s+/g, "-")
    .replaceAll(/-{2,}/g, "-")
    .replaceAll(/^[-.]+|[-.]+$/g, "");
  if (slug.length > 0 && nameProblem(slug) === undefined) return slug;
  const fallback = id.replaceAll(/[^A-Za-z0-9._-]/g, "-").slice(0, 100);
  return nameProblem(fallback) === undefined ? fallback : "animaquill-project";
}

/**
 * What an archive with the editor's content does to the files that changed on GitHub: those the
 * project has are written over, or written back where GitHub took them away; those it does not
 * have are taken away. `.gitattributes` is the platform's only in its lines, which get written over.
 */
export function divergedOutcome(
  diverged: NonNullable<RepositoryStatus["diverged"]>,
  has: (path: string) => boolean,
): {
  readonly overwritten: readonly string[];
  readonly removed: readonly string[];
  readonly restored: readonly string[];
} {
  const deleted = new Set(diverged.deleted);
  const overwritten: string[] = [];
  const removed: string[] = [];
  const restored: string[] = [];
  for (const path of diverged.files) {
    if (path === ".gitattributes") overwritten.push(path);
    else if (deleted.has(path)) {
      if (has(path)) restored.push(path);
    } else if (has(path)) overwritten.push(path);
    else removed.push(path);
  }
  return { overwritten, removed, restored };
}
