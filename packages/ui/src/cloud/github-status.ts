/**
 * How a project of the platform stands with its repository on GitHub, as one of three words, see
 * the design of the start page of AnimaQuill Cloud, 8 ("三个分开的保存状态"): "已同步", everything
 * the platform has is in the repository; "待同步", changes are on their way there, which the
 * platform takes care of by itself; "错误", they cannot get there until people do something, or
 * have not for long. Only an error stands out, and says why, what helps, and that the platform
 * keeps its copy for a week only.
 *
 * What counts as what, by what the platform says:
 *
 * | What | Which |
 * | --- | --- |
 * | Archived all of it, nothing waits | synced |
 * | Changes wait for the next archive, or one runs | pending |
 * | An archive failed for GitHub's or the platform's sake (away, limiting, no network, an error of the platform's own): it tries again by itself | pending, for the first hour |
 * | ...and has failed since for an hour or more (`failingSince`) | error |
 * | Archiving paused, for any reason (`RepositoryPause`: changes on GitHub, the repository archived, read only, a protected branch, transferred, gone, the App uninstalled or suspended, animaquill.json or the project not as the format says), also one this editor does not know | error |
 * | Files the last archive could not write (`kept`): the repository has an older version of them | error |
 * | Changes of GitHub clash with the project's, or files of it could not be taken in (the list's `conflicts`, `blocked`) | error |
 * | No repository yet, as one from before every project had one ("还差一步：选仓库"), or connecting stopped halfway | error |
 * | The repository cannot be used (`unusable`): the project cannot be edited, which says more than an error, see `unusable.ts` | error, with its own words |
 * | Nothing known yet, as before the platform answered | pending |
 *
 * Large files that do not fit, files too large and names GitHub does not take have no word of
 * their own here: the platform does not pause or fail archives for them now. What it says one day
 * that this editor does not know pauses archiving, and so is an error, with the platform's words.
 *
 * No DOM: the same input says the same thing.
 */
import type { CloudProjectSummary, RepositoryStatus, RepositoryUnusable } from "@animaquill/host";
import type { TFunction } from "i18next";
import { keptText, pauseDetail, pauseText } from "./repository-text.ts";
import { unusableFix, unusableTitle } from "./unusable.ts";

/** An archive failing this long for GitHub's or the platform's sake is an error for people too. */
export const FAILING_LONG_MS = 60 * 60_000;

export type GitHubKind = "synced" | "pending" | "error";

/** Why it is what it is, in a word that tells the cases apart. */
export type GitHubCause =
  | "synced"
  | "waiting"
  | "archiving"
  | "retrying"
  | "unknown"
  | "failingLong"
  | "paused"
  | "kept"
  | "conflicts"
  | "blocked"
  | "noRepository"
  | "unfinished"
  | "unusable";

export interface GitHubState {
  readonly kind: GitHubKind;
  readonly cause: GitHubCause;
  /** For an error: why, in words, and what helps. */
  readonly reason?: string;
  readonly fix?: string;
}

const plain = { interpolation: { escapeValue: false } } as const;

const pending = (cause: GitHubCause): GitHubState => ({ kind: "pending", cause });

const error = (cause: GitHubCause, reason: string, fix: string): GitHubState => ({
  kind: "error",
  cause,
  reason,
  fix,
});

const isFailingLong = (since: number | undefined, now: number): boolean =>
  since !== undefined && now - since >= FAILING_LONG_MS;

/** The failure that went on for long, in words. */
const failingLong = (
  since: number,
  now: number,
  detail: string | undefined,
  t: TFunction,
): GitHubState =>
  error(
    "failingLong",
    t("github.reason.failingLong", {
      hours: Math.max(1, Math.floor((now - since) / FAILING_LONG_MS)),
    }) + (detail ? t("github.reason.detail", { detail, ...plain }) : ""),
    t("github.fix.failingLong"),
  );

export interface StatusInput {
  /** How archiving goes, as the platform last said. Undefined where nothing is known yet. */
  readonly status: RepositoryStatus | undefined;
  /** The repository cannot be used, see `CloudProjects.unusable`. */
  readonly unusable?: RepositoryUnusable;
  /** Connecting stopped before the project was on the platform, see `CloudPanel`. */
  readonly unfinished?: boolean;
  /** Milliseconds since 1970. */
  readonly now: number;
}

/** How the open project stands with its repository, by what the platform says of it. */
export function githubOfStatus(input: StatusInput, t: TFunction): GitHubState {
  const { status, unusable, unfinished, now } = input;
  if (unusable) return error("unusable", unusableTitle(unusable, t), unusableFix(unusable, t));
  if (unfinished)
    return error(
      "unfinished",
      t("cloud.panel.repository.unfinished"),
      t("cloud.panel.repository.unfinishedNote"),
    );
  if (!status) return pending("unknown");
  if (status.state === "none")
    return error("noRepository", t("cloud.panel.repository.none"), t("github.fix.noRepository"));
  if (status.state === "paused") {
    const { reason, fix } = pauseText(status, t);
    const detail = pauseDetail(status, t);
    return error("paused", detail ? `${reason}（${detail}）` : reason, fix);
  }
  if (isFailingLong(status.failingSince, now))
    return failingLong(status.failingSince as number, now, status.detail, t);
  const kept = keptText(status, t);
  if (kept) return error("kept", kept, t("github.fix.kept"));
  if (status.archiving) return pending("archiving");
  if ((status.failures ?? 0) > 0) return pending("retrying");
  if (status.dirtySince !== undefined || status.head > status.archivedSeq)
    return pending("waiting");
  return { kind: "synced", cause: "synced" };
}

/** What the list of the platform says of a project, as far as its repository goes. */
export type ListedArchive = Pick<CloudProjectSummary, "attention" | "repository" | "archive">;

/** How a project of the list stands with its repository, for the start page. */
export function githubOfListed(summary: ListedArchive, now: number, t: TFunction): GitHubState {
  const { attention, repository, archive } = summary;
  if (repository?.unusable)
    return error(
      "unusable",
      unusableTitle(repository.unusable, t),
      unusableFix(repository.unusable, t),
    );
  switch (attention) {
    case "noRepository":
      return error("noRepository", t("cloud.panel.repository.none"), t("github.fix.noRepository"));
    case "conflicts":
      return error("conflicts", t("start.hint.conflicts"), t("github.fix.open"));
    case "blocked":
      return error("blocked", t("start.hint.blocked"), t("github.fix.open"));
    case undefined:
    case "unusable":
      break;
    default: {
      // Archiving paused, or something a newer platform says: people have to do something.
      const { reason, fix } = pauseText(
        { ...(repository?.reason && { reason: repository.reason }) },
        t,
      );
      return error("paused", reason, fix);
    }
  }
  if (!repository) return pending("unknown");
  if (repository.state === "paused") {
    const { reason, fix } = pauseText(
      { ...(repository.reason && { reason: repository.reason }) },
      t,
    );
    return error("paused", reason, fix);
  }
  if (isFailingLong(archive?.failingSince, now))
    return failingLong(archive?.failingSince as number, now, undefined, t);
  if (archive?.behind) return pending(archive.failingSince === undefined ? "waiting" : "retrying");
  return { kind: "synced", cause: "synced" };
}

/** The word of the status bar and of a card. */
export function githubText(state: GitHubState, t: TFunction): string {
  if (state.cause === "unusable" || state.cause === "noRepository" || state.cause === "unfinished")
    return state.reason ?? t("github.text.error");
  return t(`github.text.${state.kind}`);
}

/**
 * What hovering says, and the panel too: for an error, that saving into GitHub failed, why, what
 * helps, and that the platform keeps its copy for a week only.
 */
export function githubAbout(state: GitHubState, t: TFunction): string {
  if (state.kind === "error")
    return t("github.about.error", {
      reason: (state.reason ?? "").replace(/。$/, ""),
      fix: state.fix ?? "",
      ...plain,
    });
  const said =
    state.cause === "synced" || state.cause === "unknown" || state.cause === "retrying"
      ? state.cause
      : "pending";
  return t(`github.about.${said}`);
}
