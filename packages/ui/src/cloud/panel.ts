import type { RepositoryStatus, RepositoryUnusable } from "@animaquill/host";
import type { TFunction } from "i18next";
import type { CloudProjectsSnapshot } from "./projects.ts";
import {
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
 * - Not connected: "仅本机", and a click opens the dialog that connects it.
 * - Only in this browser, without the platform, as projects were made before (the design, 7):
 *   "只在浏览器里", as something to do something about, and the panel says why that is not safe
 *   and the ways out: into a folder, to the platform, a copy as a file.
 * - Connected and in step: "☁ 已同步". A project of the platform that was opened without a folder
 *   says "☁ 云端项目" then, has a row that says it is only in this browser, with "关联文件夹…",
 *   and "从这个浏览器移除…" in place of "断开云端…".
 * - The platform has changes that are not in the repository yet: "☁ 有未保存的更改，平台只保留
 *   7 天", in the status bar and on the row of archiving, as the platform keeps its copy for a week
 *   only (the design, 1). Where they cannot be saved, also why, as something to do something
 *   about; where they only wait for the next archive, as something on its way.
 * - Its repository cannot be used (the design, 5.1): why, and when the platform takes the project
 *   away, in the status bar and on the row of the repository, with the ways out: ask GitHub again,
 *   let the platform at the repository again, another repository, a copy as a project of this
 *   computer, disconnecting a folder, and deleting it. The project cannot be edited meanwhile.
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
  /** Opens the dialog that connects the project, see `CloudProjects.beginConnect`. */
  | "connect"
  /** The same dialog, for a project of the platform that has no repository yet. */
  | "chooseRepository"
  /** The same dialog, for a project whose connecting stopped before it was on the platform. */
  | "finishConnect"
  | "switchRepository"
  | "disconnect"
  | "removeFromBrowser"
  /** Puts a project that is only in this browser into a folder, and it goes on syncing. */
  | "linkFolder"
  | "archiveNow"
  /** Asks GitHub again whether a repository that cannot be used can be used now. */
  | "recheck"
  /** Lets the platform at the repository again, on GitHub: as `installApp` does. */
  | "reauthorize"
  | "reinstall"
  | "restoreApp"
  /** A copy into a folder, which is a project of this computer, and does not sync. */
  | "saveAsLocal"
  /** Takes the project away on the platform. */
  | "deleteCloud"
  | "continueWithEditor"
  | "installApp"
  | "signIn"
  | "reload"
  /** Tries syncing again, see `CloudSession.resume`. */
  | "retry"
  | "resolveStuck"
  /** Moves a project that is only in this browser into a folder, see `FolderMove`. */
  | "moveToFolder"
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
  /** What a click on the status opens: the dialog that connects the project, or the panel. */
  readonly opens: "connect" | "panel";
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
   * Where the project is on this computer. For "none", "browser" is a project only in this browser,
   * without the platform.
   */
  readonly local?: "folder" | "browser";
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
  /** For "linked" with `local` "folder": what its folder is called, where that is known. */
  readonly folder?: string;
  /** This browser can write folders, so that a project that is only in it can move into one. */
  readonly canMoveToFolder: boolean;
  /**
   * For "linked": its repository cannot be used, and so the project cannot be edited, see
   * `CloudProjects.unusable`.
   */
  readonly unusable?: RepositoryUnusable;
  /** For "linked": whoever is signed in can take it away on the platform, see `CloudProjects`. */
  readonly canDelete?: boolean;
  /** Milliseconds since 1970. */
  readonly now: number;
}

/** What the panel needs, from what `CloudProjects` says and what it holds says right now. */
export function panelInputOf(
  snapshot: CloudProjectsSnapshot,
  more: Pick<
    PanelInput,
    "name" | "canMoveToFolder" | "now" | "persisted" | "clearsWhenIdle" | "unusable" | "canDelete"
  >,
): PanelInput {
  if (snapshot.kind === "none")
    return { kind: "none", ...(snapshot.local && { local: snapshot.local }), ...more };
  const archive = snapshot.repository?.getSnapshot();
  return {
    kind: "linked",
    local: snapshot.local,
    made: snapshot.made,
    sync: snapshot.session.getSnapshot(),
    ...(archive && { archive }),
    ...more,
  };
}

const plain = { interpolation: { escapeValue: false } } as const;

/**
 * What helps with a pause of archiving, the most likely first. Another repository is always
 * there, at the end of the panel, unless it is what helps most.
 */
const PAUSE_ACTIONS: Readonly<Record<string, readonly PanelActionId[]>> = {
  diverged: ["continueWithEditor"],
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
    case "rebuilt":
      return ["reload"];
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

  // Only in this browser, with nothing else that has it: not safe, and the ways out.
  if (input.kind === "none" && input.local === "browser") {
    return {
      level: "attention",
      bar: t("cloud.panel.bar.onlyHere"),
      barAbout: t("cloud.onlyHere.text"),
      github: undefined,
      opens: "panel",
      title,
      rows: [
        row("local", t("cloud.onlyHere.text"), {
          notes: [t("cloud.onlyHere.note")],
          tone: "attention",
          actions: actions([
            ...(input.canMoveToFolder ? (["moveToFolder"] as const) : []),
            "connect",
            "saveCopy",
          ]),
        }),
      ],
      actions: [],
      sync: undefined,
      archive: undefined,
    };
  }
  // A linked project always says how syncing goes: one that does not is taken to be not connected.
  if (input.kind === "none" || !input.sync) {
    return {
      level: "none",
      bar: t("cloud.panel.bar.local"),
      barAbout: t("cloud.panel.about.local"),
      github: undefined,
      opens: "connect",
      title,
      rows: [],
      actions: [action("connect", { kind: "primary" })],
      sync: undefined,
      archive: undefined,
    };
  }
  const { state, problem, pending, here, retryAt } = input.sync;
  const watch = input.archive;
  const status = watch?.status;
  const repository = status?.repository;
  const isDirect = input.local === "browser";
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
        notes: [
          unusableFix(unusable, t),
          t("cloud.unusable.readOnly"),
          t("cloud.unusable.ways"),
          ...(isDirect ? [] : [t("cloud.unusable.waysFolder")]),
        ],
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
          notes: [t("cloud.panel.repository.unfinishedNote"), t("github.week")],
          tone: "attention",
          actions: actions(["finishConnect"]),
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
      rows.push(
        row("repository", t("cloud.panel.repository.none"), {
          notes: [t("github.week")],
          tone: "attention",
          actions: actions(["chooseRepository"]),
        }),
      );
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
  const syncText = isStuck
    ? problem
      ? problem.kind === "rejected"
        ? t("cloud.problem.rejected", { reason: t(`cloud.reason.${problem.reason}`), ...plain })
        : t(`cloud.problem.${problem.kind}`)
      : t("cloud.status.paused")
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
      ],
      ...(isStuck && { tone: "attention" as const, actions: actions(syncActions(problem)) }),
    }),
  );

  // ---- archiving: what says why it cannot be used says it all. An error says that the
  // platform keeps its copy for a week only.
  const week = github?.kind === "error" ? [t("github.week")] : [];
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
          notes: [fix, ...(detail ? [detail] : []), ...(kept ? [kept] : []), ...week],
          tone: "attention",
          actions: actions(helps),
        }),
      );
    } else {
      const kept = keptText(status, t);
      const isBusy = status.archiving || watch.archiveAt !== undefined;
      const detail = isFailing ? pauseDetail(status, t) : undefined;
      const isError = github?.kind === "error";
      rows.push(
        row("archive", archiveText(status, watch.archiveAt, now, t), {
          notes: [
            ...(isError && github.cause === "failingLong" && github.reason ? [github.reason] : []),
            ...(isError && github.fix && github.cause !== "kept" ? [github.fix] : []),
            ...(detail ? [detail] : []),
            ...(kept ? [kept] : []),
            ...(isError && github.cause === "kept" && github.fix ? [github.fix] : []),
            ...week,
            // An archive is of what the platform has: what did not get there yet is not in it.
            ...(pending > 0 ? [t("cloud.panel.archive.notSent")] : []),
          ],
          ...(isError && { tone: "attention" as const }),
          actions: [action("archiveNow", { enabled: !isBusy })],
        }),
      );
    }
  }

  // ---- where it is on this computer
  if (!isDirect) {
    rows.push(
      row(
        "local",
        input.folder === undefined
          ? t("cloud.panel.local.someFolder")
          : t("cloud.panel.local.folder", { folder: input.folder, ...plain }),
      ),
    );
  } else {
    const notes = [
      // The browser may clear it when its disk is nearly full: what did not get to the platform
      // would go with it.
      ...(input.persisted === false ? [t("cloud.persist.note")] : []),
      // Safari clears it after seven days without a visit, unless it keeps it for good.
      ...(input.clearsWhenIdle && input.persisted !== true && pending > 0
        ? [t("cloud.persist.idle")]
        : []),
    ];
    rows.push(
      row("local", t("cloud.panel.local.browser"), {
        notes,
        ...(notes.length > 0 && { tone: "attention" as const }),
        ...(input.canMoveToFolder && { actions: [action("linkFolder")] }),
      }),
    );
  }

  // The parts in the order of the status bar.
  const order: readonly PanelSection[] = ["local", "sync", "github"];
  const syncAbout = rows.find((each) => each.id === "sync")?.text ?? bar;
  return {
    level,
    bar,
    barAbout: syncAbout,
    github,
    opens: "panel",
    title,
    rows: rows.toSorted((a, b) => order.indexOf(a.section) - order.indexOf(b.section)),
    actions: [
      // Another repository at any time, not only where archiving paused: here, unless a row
      // says so already, as the way out of what it says.
      ...(repository &&
      !rows.some((each) => each.actions.some((offered) => offered.id === "switchRepository"))
        ? [action("switchRepository")]
        : []),
      // A copy as a project of this computer, which does not sync: of what is on the platform.
      ...(input.canMoveToFolder && input.made !== false ? [action("saveAsLocal")] : []),
      action(isDirect ? "removeFromBrowser" : "disconnect", { kind: "danger" }),
      ...(input.canDelete && input.made !== false
        ? [action("deleteCloud", { kind: "danger" })]
        : []),
    ],
    sync: state,
    archive: status?.state,
  };
}
