import type { CloudCopyProblem, RepositoryStatus, RepositoryUnusable } from "@animaquill/host";
import type { TFunction } from "i18next";
import type { CloudProjectsSnapshot, TakeBackState } from "./projects.ts";
import {
  BRANCH_MENDS,
  copyProblemText,
  goneKind,
  keptText,
  knownPause,
  momentText,
  pauseDetail,
  pauseText,
} from "./repository-text.ts";
import { githubOfStatus, type GitHubState } from "./github-status.ts";
import type { RepositoryWatchSnapshot } from "./repository-watch.ts";
import type { CloudProblem, CloudSnapshot, CloudState } from "./session.ts";
import { unusableFix, unusableKind, unusableLine, unusableWays } from "./unusable.ts";

/**
 * The one place in a project that says how it stands with the platform, see the design of the
 * start page (docs/design/start-and-cloud.md of AnimaQuill Cloud), 4: a status in the status bar,
 * and the panel it opens. Three things go into it: whether the project is connected and where it
 * is on this computer, how syncing goes, and how archiving into its repository goes. What comes
 * out is one level, the word of the status bar, the rows of the panel, and what people can do.
 *
 * - Only in this browser, without the platform: a project of the offline mode where the browser
 *   cannot write folders, or one that the platform took away with changes that did not get there:
 *   "只在浏览器里", as something to do something about, and the panel says why that is not safe
 *   and the way out, a copy as a file.
 * - In step: "☁ 已同步". The copy of a project of the online mode is only in this browser, and the
 *   panel says where the browser may not keep it, with "从这个浏览器移除…".
 * - The platform has changes that are not in the repository yet, on the row of archiving: where
 *   they cannot be saved, also why, as something to do something about; where they only wait for
 *   the next archive, as something on its way.
 * - Its repository cannot be used (the design, 5.1): why, and when the platform takes the project
 *   away, in the status bar and on the row of the repository, with the ways out: ask GitHub again,
 *   let the platform at the repository again, another repository, a copy in a folder, and
 *   deleting it. The project cannot be edited meanwhile.
 * - Without a network, or with changes on their way: "☁ 离线，3 个改动待发".
 * - Something people have to do: "☁ 要处理". Syncing stopped, archiving paused, the project
 *   has no repository yet, as one from before every project of the platform had one, or
 *   connecting it was not finished: it is not on the platform yet, as far as is known. The panel
 *   says which, and has the way back to the dialog that connects it.
 *
 * No DOM, and nothing of it is kept: the same input says the same thing.
 */

export type PanelLevel =
  /** Not connected. */
  | "none"
  | "ok"
  /** On its way: connecting, changes not sent yet, no network. It gets there by itself. */
  | "busy"
  /** People have to do something. */
  | "attention";

/** What people can do from the panel: whoever shows it runs it, see `CloudProjects`. */
export type PanelActionId =
  | "switchRepository"
  | "removeFromBrowser"
  | "archiveNow"
  /** Asks GitHub again whether a repository that cannot be used can be used now. */
  | "recheck"
  /** Lets the platform at the repository again, on GitHub: as `installApp` does. */
  | "reauthorize"
  | "reinstall"
  | "restoreApp"
  /** A copy into a folder, once, see `SaveToFolder`: a project of the offline mode from then on. */
  | "saveToFolder"
  /** Takes the project away on the platform. */
  | "deleteCloud"
  | "continueWithEditor"
  /**
   * What merging changes on GitHub waits for: the conflicts, a rewritten history, files that
   * would be written back, see `RepoMerges`.
   */
  | "resolveMerge"
  /** Files on GitHub that the merge did not take in, and the ways out. */
  | "showBlocked"
  | "installApp"
  | "signIn"
  | "reload"
  /** Tries syncing again, see `CloudSession.resume`. */
  | "retry"
  /** Tries again to take what this computer has onto the copy the platform made again. */
  | "takeBack"
  /** Has the platform make the project again from its branch as it is, see `wakeFromBranch`. */
  | "wakeAsItIs"
  | "resolveStuck"
  /** Saves a copy of the project as a file, see `exportProject`. */
  | "saveCopy";

export interface PanelAction {
  readonly id: PanelActionId;
  readonly label: string;
  readonly enabled: boolean;
  /** What people most likely want, or what takes something away. */
  readonly kind?: "primary" | "danger";
}

/** The three parts of the panel, as the three statuses of the status bar: see the top. */
export type PanelSection = "local" | "sync" | "github";

export interface PanelRow {
  readonly id: "repository" | "sync" | "archive" | "local";
  /** Which part of the panel it is in. */
  readonly section: PanelSection;
  readonly label: string;
  readonly text: string;
  /** Lines below it: what helps, and what else there is to know. */
  readonly notes: readonly string[];
  readonly tone: "plain" | "attention";
  /** Where people see it, as the repository on GitHub. */
  readonly link?: { readonly label: string; readonly url: string };
  readonly actions: readonly PanelAction[];
}

export interface CloudPanel {
  /** How syncing goes: the level of its status. */
  readonly level: PanelLevel;
  /** The word of the status of syncing, or of a project that does not sync. */
  readonly bar: string;
  /** What hovering over it says. */
  readonly barAbout: string;
  /**
   * How it stands with its repository, see `github-status.ts`: the third status. Undefined where
   * the platform saves projects to no repositories, or the project does not sync.
   */
  readonly github: GitHubState | undefined;
  readonly title: string;
  readonly rows: readonly PanelRow[];
  /** What the panel ends with. */
  readonly actions: readonly PanelAction[];
  /** How syncing and archiving are, as the status says them to whatever reads the page. */
  readonly sync: CloudState | undefined;
  readonly archive: RepositoryStatus["state"] | undefined;
}

export interface PanelInput {
  /** Whether the open project syncs, see `CloudProjectsSnapshot`. */
  readonly kind: CloudProjectsSnapshot["kind"];
  /**
   * Whether the browser keeps what it stores until people clear it, as it said, see
   * `CloudProjects.persisted`: false where it said no, undefined where nothing is known.
   */
  readonly persisted?: boolean;
  /** The browser clears what a page stores after days without a visit, see `StoragePersistence`. */
  readonly clearsWhenIdle?: boolean;
  /**
   * For "linked": whether the project is on the platform, as far as this window knows, see
   * `CloudProjectsSnapshot`. False: connecting it is not finished. Taken to be where nothing says.
   */
  readonly made?: boolean;
  /** For "linked": how syncing goes. */
  readonly sync?: CloudSnapshot;
  /** For "linked": how archiving goes. Undefined where the platform saves no projects to repositories. */
  readonly archive?: RepositoryWatchSnapshot;
  /** What the project is called. */
  readonly name: string;
  /**
   * For "linked": its repository cannot be used, and so the project cannot be edited, see
   * `CloudProjects.unusable`.
   */
  readonly unusable?: RepositoryUnusable;
  /** For "linked": whoever is signed in can take it away on the platform, see `CloudProjects`. */
  readonly canDelete?: boolean;
  /**
   * For "linked": how taking it back onto the copy the platform made again goes, see
   * `CloudProjects.takeBack`.
   */
  readonly takeBack?: TakeBackState;
  /**
   * For "linked": why the platform could not make the project again from its repository lately,
   * while the window waits for it to try again, see `CloudProjects.copyProblem`.
   */
  readonly copyProblem?: CloudCopyProblem;
  /** Milliseconds since 1970. */
  readonly now: number;
}

/** What the panel needs, from what `CloudProjects` says and what it holds says right now. */
/**
 * How taking a project back onto the copy the platform made again goes, in people's words, see
 * `TakeBackState`: for the panel, and the bar over a project that can only be looked at.
 */
export function takeBackText(state: TakeBackState, t: TFunction): string {
  switch (state) {
    case "running":
      return t("cloud.takeBack.waiting");
    case "stopped":
      return t("cloud.takeBack.cancelled");
    default:
      return t(`cloud.takeBack.${state}`);
  }
}

export function panelInputOf(
  snapshot: CloudProjectsSnapshot,
  more: Pick<
    PanelInput,
    | "name"
    | "now"
    | "persisted"
    | "clearsWhenIdle"
    | "unusable"
    | "canDelete"
    | "takeBack"
    | "copyProblem"
  >,
): PanelInput {
  if (snapshot.kind === "none") return { kind: "none", ...more };
  const archive = snapshot.repository?.getSnapshot();
  return {
    kind: "linked",
    made: snapshot.made,
    sync: snapshot.session.getSnapshot(),
    ...(archive && { archive }),
    ...more,
  };
}

const plain = { interpolation: { escapeValue: false } } as const;

/** How long the line about archiving says that changes on GitHub were merged. */
const MERGE_SHOWN_MS = 24 * 60 * 60_000;

/**
 * What helps with a pause of archiving, the most likely first. Another repository is always
 * there, at the end of the panel, unless it is what helps most.
 */
const PAUSE_ACTIONS: Readonly<Record<string, readonly PanelActionId[]>> = {
  diverged: ["continueWithEditor"],
  conflicts: ["resolveMerge"],
  blocked: ["showBlocked"],
  locked: [],
  rewritten: ["resolveMerge"],
  "too-large": ["continueWithEditor"],
  unmerged: ["resolveMerge"],
  gone: ["archiveNow"],
  uninstalled: ["installApp"],
  suspended: ["archiveNow"],
  archived: ["archiveNow"],
  protected: ["archiveNow"],
  transferred: [],
  manifest: ["archiveNow"],
  invalid: ["archiveNow"],
};

/** What helps where syncing waits for people. */
const syncActions = (problem: CloudProblem | undefined): readonly PanelActionId[] => {
  switch (problem?.kind) {
    case undefined:
    case "unsupported":
      return [];
    case "signed-out":
      return ["signIn"];
    case "outdated":
      return ["reload"];
    // Taking it back goes by itself: only once it stopped do people try again.
    case "rebuilt":
      return [];
    case "rejected":
    case "diverged":
    case "missing":
      // What the platform will not take stays here: the project can go on without it.
      return ["retry", "resolveStuck"];
    // What helps is on the row of the repository: syncing goes on by itself once it can be used.
    case "unusable":
    // The link goes by itself, see `CloudProjects`.
    case "deleted":
      return [];
    default:
      return ["retry"];
  }
};

/** When the project was last archived, and what comes next, in one line. */
function archiveText(
  status: RepositoryStatus,
  archiveAt: number | undefined,
  now: number,
  t: TFunction,
): string {
  const { lastArchive: last } = status;
  const before = !last
    ? undefined
    : last.at <= now && now - last.at < 60_000
      ? t("cloud.panel.archive.lastJustNow")
      : t("cloud.panel.archive.last", { time: momentText(last.at, now, t) });
  let next: string | undefined;
  if (archiveAt !== undefined) {
    const count = Math.max(1, Math.ceil((archiveAt - now) / 1000));
    next = t("cloud.panel.archive.archiveAt", { count });
  } else if (status.archiving) next = t("cloud.panel.archive.archiving");
  else if (status.retryAt !== undefined && (status.failures ?? 0) > 0)
    next = t("cloud.panel.archive.retry", { time: momentText(status.retryAt, now, t) });
  else if (status.dirtySince !== undefined || status.head > status.archivedSeq) {
    next =
      status.nextAt === undefined || status.nextAt <= now
        ? t("cloud.panel.archive.waitingSoon")
        : t("cloud.panel.archive.waiting", {
            count: Math.max(1, Math.ceil((status.nextAt - now) / 60_000)),
          });
  }
  if (before && next) return `${before}。${next}`;
  return before ?? next ?? t("cloud.panel.archive.never");
}

export function cloudPanel(input: PanelInput, t: TFunction): CloudPanel {
  const { now } = input;
  const title = t("cloud.panel.title", { name: input.name, ...plain });
  const action = (
    id: PanelActionId,
    more: { readonly enabled?: boolean; readonly kind?: "primary" | "danger" } = {},
  ): PanelAction => ({
    id,
    label: t(`cloud.panel.action.${id}`),
    enabled: more.enabled ?? true,
    ...(more.kind && { kind: more.kind }),
  });
  /** The first is what people most likely want. */
  const actions = (ids: readonly PanelActionId[]): PanelAction[] =>
    ids.map((id, index) => action(id, index === 0 ? { kind: "primary" } : {}));
  const sections: Record<PanelRow["id"], PanelSection> = {
    local: "local",
    sync: "sync",
    repository: "github",
    archive: "github",
  };
  const row = (
    id: PanelRow["id"],
    text: string,
    more: Partial<Pick<PanelRow, "notes" | "tone" | "link" | "actions">> = {},
  ): PanelRow => ({
    id,
    section: sections[id],
    label: t(`cloud.panel.row.${id}`),
    text,
    notes: more.notes ?? [],
    tone: more.tone ?? "plain",
    ...(more.link && { link: more.link }),
    actions: more.actions ?? [],
  });

  // Only in this browser, with nothing else that has it: not safe, and the way out. A linked
  // project always says how syncing goes: one that does not is taken to be one of these.
  if (input.kind === "none" || !input.sync) {
    return {
      level: "attention",
      bar: t("cloud.panel.bar.onlyHere"),
      barAbout: t("cloud.onlyHere.text"),
      github: undefined,
      title,
      rows: [
        row("local", t("cloud.onlyHere.text"), {
          notes: [t("cloud.onlyHere.note")],
          tone: "attention",
          actions: actions(["saveCopy"]),
        }),
      ],
      actions: [],
      sync: undefined,
      archive: undefined,
    };
  }
  const { state, problem, pending, here, retryAt } = input.sync;
  const watch = input.archive;
  const status = watch?.status;
  const repository = status?.repository;
  const isStuck = state === "paused";
  const isPaused = status?.state === "paused";
  // One from before every project of the platform had a repository, or one whose connecting
  // stopped halfway.
  const lacksRepository = status?.state === "none";
  // Connecting stopped before the project was on the platform: nothing is known of a repository,
  // and nothing says that the platform has the project at all. Only where there is a dialog to
  // go back to, which there is where the platform saves projects to repositories.
  const isUnfinished = input.made === false && watch !== undefined;
  const isAway = state === "offline" || state === "reconnecting";
  const { unusable } = input;
  // The third status: how it stands with its repository.
  const github =
    watch || unusable
      ? githubOfStatus(
          {
            status,
            ...(unusable && { unusable }),
            ...(isUnfinished && { unfinished: true }),
            now,
          },
          t,
        )
      : undefined;
  // ...and cannot save them now, rather than only waiting for the next archive.
  const isFailing = isPaused || (!status?.archiving && (status?.failures ?? 0) > 0);

  // The status of syncing: whether the platform has the changes, and nothing else.
  const level: PanelLevel = isStuck
    ? "attention"
    : state === "online" && pending === 0
      ? "ok"
      : "busy";
  const bar = isStuck
    ? t("cloud.panel.bar.error")
    : isAway
      ? t("cloud.panel.bar.offline")
      : state === "online" && pending === 0
        ? t("cloud.panel.bar.synced")
        : t("cloud.panel.bar.syncing");

  const rows: PanelRow[] = [];

  // ---- the repository
  if (unusable) {
    const ways = unusableWays(unusable, { hasContent: repository !== undefined });
    rows.push(
      row("repository", unusableLine(unusable, now, t), {
        notes: [unusableFix(unusable, t), t("cloud.unusable.readOnly"), t("cloud.unusable.ways")],
        tone: "attention",
        ...(repository?.url &&
          unusableKind(unusable) !== "deleted" && {
            link: { label: t("cloud.panel.action.openOnGitHub"), url: repository.url },
          }),
        actions: actions(ways),
      }),
    );
  } else if (watch) {
    if (isUnfinished) {
      rows.push(
        row("repository", t("cloud.panel.repository.unfinished"), {
          notes: [t("cloud.panel.repository.unfinishedNote")],
          tone: "attention",
        }),
      );
    } else if (repository) {
      const isStale = watch.trouble !== undefined && watch.trouble !== "signedOut";
      rows.push(
        row(
          "repository",
          t("cloud.panel.repository.value", {
            name: repository.fullName,
            visibility: t(repository.private ? "repository.private" : "repository.public"),
            ...plain,
          }),
          {
            ...(isStale && { notes: [t("cloud.panel.repository.stale")] }),
            ...(repository.url && {
              link: { label: t("cloud.panel.action.openOnGitHub"), url: repository.url },
            }),
          },
        ),
      );
    } else if (lacksRepository) {
      rows.push(row("repository", t("cloud.panel.repository.none"), { tone: "attention" }));
    } else {
      rows.push(
        row(
          "repository",
          watch.trouble === "signedOut"
            ? t("cloud.panel.repository.signedOut")
            : watch.trouble
              ? t("cloud.panel.repository.unknown")
              : t("cloud.panel.repository.checking"),
        ),
      );
    }
  }

  // ---- syncing
  const takeBack = problem?.kind === "rebuilt" ? input.takeBack : undefined;
  // The platform could not make it again lately, and tries again later.
  const notMade =
    !isStuck && input.sync.restoring === "released" && state !== "online"
      ? input.copyProblem
      : undefined;
  const syncText = isStuck
    ? problem
      ? problem.kind === "rejected"
        ? t("cloud.problem.rejected", { reason: t(`cloud.reason.${problem.reason}`), ...plain })
        : takeBack !== undefined
          ? takeBackText(takeBack, t)
          : t(`cloud.problem.${problem.kind}`)
      : t("cloud.status.paused")
    : notMade
      ? t("cloud.wake.busy", { why: copyProblemText(notMade, t), ...plain })
      : input.sync.restoring !== undefined && state !== "online"
        ? t("cloud.open.restoringReleased")
        : state === "online"
          ? pending > 0
            ? t("cloud.panel.sync.onlinePending", { count: pending })
            : t("cloud.panel.sync.online")
          : state === "offline"
            ? pending > 0
              ? t("cloud.panel.sync.offlinePending", { count: pending })
              : t("cloud.panel.sync.offline")
            : state === "reconnecting"
              ? retryAt === undefined
                ? t("cloud.panel.sync.reconnecting")
                : t("cloud.panel.sync.reconnectingAt", { time: momentText(retryAt, now, t) })
              : t("cloud.panel.sync.connecting");
  rows.push(
    row("sync", syncText, {
      notes: [
        ...(state === "reconnecting" && pending > 0
          ? [t("cloud.panel.sync.pending", { count: pending })]
          : []),
        ...(here || isStuck ? [] : [t("cloud.panel.sync.elsewhere")]),
        ...(notMade
          ? BRANCH_MENDS.has(notMade.code)
            ? [t("cloud.wake.fixed"), t("cloud.wake.fromGitHubNote")]
            : [t("cloud.wake.later")]
          : []),
      ],
      ...(isStuck && {
        tone: "attention" as const,
        actions: actions(
          takeBack === "signedOut"
            ? ["signIn"]
            : takeBack !== undefined && takeBack !== "running"
              ? ["takeBack"]
              : syncActions(problem),
        ),
      }),
      ...(notMade && {
        tone: "attention" as const,
        actions: actions(BRANCH_MENDS.has(notMade.code) ? ["wakeAsItIs"] : []),
      }),
    }),
  );

  // ---- archiving: what says why it cannot be used says it all.
  if (watch && status && repository && !unusable) {
    if (isPaused) {
      const { reason, fix } = pauseText(status, t);
      const detail = pauseDetail(status, t);
      const kept = keptText(status, t);
      // A repository that was deleted takes no archive again: another one is the way out.
      const helps =
        goneKind(status) === "deleted"
          ? (["switchRepository"] as const)
          : (PAUSE_ACTIONS[knownPause(status.reason) ?? ""] ?? ["archiveNow"]);
      rows.push(
        row("archive", t("cloud.panel.archive.paused", { reason, ...plain }), {
          notes: [...(fix ? [fix] : []), ...(detail ? [detail] : []), ...(kept ? [kept] : [])],
          tone: "attention",
          actions: actions(helps),
        }),
      );
    } else {
      const kept = keptText(status, t);
      const isBusy = status.archiving || watch.archiveAt !== undefined;
      const detail = isFailing ? pauseDetail(status, t) : undefined;
      const isError = github?.kind === "error";
      const archived = archiveText(status, watch.archiveAt, now, t);
      // A merge of what changed on GitHub lately says so first (the design, 10).
      const merged =
        status.merge && now - status.merge.at < MERGE_SHOWN_MS
          ? t("cloud.panel.archive.merged", {
              count: status.merge.files,
              archive: archived,
              ...plain,
            })
          : archived;
      rows.push(
        row("archive", merged, {
          notes: [
            ...(isError && github.cause === "failingLong" && github.reason ? [github.reason] : []),
            ...(isError && github.fix && github.cause !== "kept" ? [github.fix] : []),
            ...(detail ? [detail] : []),
            ...(kept ? [kept] : []),
            ...(isError && github.cause === "kept" && github.fix ? [github.fix] : []),
            // An archive is of what the platform has: what did not get there yet is not in it.
            ...(pending > 0 ? [t("cloud.panel.archive.notSent")] : []),
          ],
          ...(isError && { tone: "attention" as const }),
          actions: [action("archiveNow", { enabled: !isBusy })],
        }),
      );
    }
  }

  // ---- this computer: the copy is only in this browser, which may not keep it
  const notes = [
    // The browser may clear it when its disk is nearly full: what did not get to the platform
    // would go with it.
    ...(input.persisted === false ? [t("cloud.persist.note")] : []),
    // Safari clears it after seven days without a visit, unless it keeps it for good.
    ...(input.clearsWhenIdle && input.persisted !== true && pending > 0
      ? [t("cloud.persist.idle")]
      : []),
  ];
  if (notes.length > 0)
    rows.push(row("local", t("cloud.panel.local.browser"), { notes, tone: "attention" }));

  // The parts in the order of the status bar.
  const order: readonly PanelSection[] = ["local", "sync", "github"];
  const syncAbout = rows.find((each) => each.id === "sync")?.text ?? bar;
  return {
    level,
    bar,
    barAbout: syncAbout,
    github,
    title,
    rows: rows.toSorted((a, b) => order.indexOf(a.section) - order.indexOf(b.section)),
    actions: [
      // Another repository at any time, not only where archiving paused: here, unless a row
      // says so already, as the way out of what it says.
      ...(repository &&
      !rows.some((each) => each.actions.some((offered) => offered.id === "switchRepository"))
        ? [action("switchRepository")]
        : []),
      // A copy in a folder, once: of what is on the platform.
      ...(input.made !== false ? [action("saveToFolder")] : []),
      action("removeFromBrowser", { kind: "danger" }),
      ...(input.canDelete && input.made !== false
        ? [action("deleteCloud", { kind: "danger" })]
        : []),
    ],
    sync: state,
    archive: status?.state,
  };
}
