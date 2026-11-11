import type { FolderStatus, ProjectSummary } from "@animaquill/host";
import { Ellipsis, Feather, FolderInput, FolderOpen, Plus, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import type { CloudRow, LocalRow, StartListSnapshot } from "../cloud/start-list.ts";
import { sizeOf, type UnfinishedExport } from "../export/video.ts";
import { formatSize } from "../transfer/transfer.ts";
import type { ProjectFoldersSnapshot, WaitingFolder } from "../workbench/project-folders.ts";
import { CloudText } from "./CloudText.tsx";
import { useWorkbench } from "./context.ts";
import { Menu, type MenuItem } from "./Menu.tsx";
import styles from "./StartPage.module.css";
import { agoText, cloudRowView, localRowView } from "./start-view.ts";

const noSubscription = () => () => {};
const NO_FOLDERS: ProjectFoldersSnapshot = { open: undefined, waiting: undefined, moves: 0 };
const noFolders = () => NO_FOLDERS;
/** How often the times on the page move on. */
const TICK_MS = 60_000;

/** What exports that stopped halfway take on this device, which people should be able to clear. */
function UnfinishedExports({ lists }: { lists: StartListSnapshot }) {
  const { videos } = useWorkbench();
  const { t } = useTranslation();
  const [found, setFound] = useState<readonly UnfinishedExport[]>([]);
  const refresh = useCallback(() => {
    void videos.unfinished().then(setFound);
  }, [videos]);
  useEffect(refresh, [refresh]);
  if (found.length === 0) return null;
  const nameOf = (id: string) =>
    lists.local.find((row) => row.key === id)?.name ??
    lists.browser.find((project) => project.id === id)?.name ??
    lists.cloud.find((row) => row.key === id)?.name ??
    "";
  return (
    <section aria-label={t("export.unfinished.title")}>
      <h2>{t("export.unfinished.title")}</h2>
      <p className={styles.muted}>{t("export.unfinished.about")}</p>
      <ul className={styles.list}>
        {found.map(({ id, project, name, bytes, status, done, total }) => (
          <li key={id} className={styles.unfinished}>
            <span className={styles.name}>
              {t("export.unfinished.item", {
                project: nameOf(project),
                file: name,
                status:
                  total > 0
                    ? t("export.unfinished.percent", {
                        status: t(`export.unfinished.status.${status}`),
                        percent: Math.floor((done / total) * 100),
                      })
                    : t(`export.unfinished.status.${status}`),
                size: sizeOf(bytes),
                interpolation: { escapeValue: false },
              })}
            </span>
            <button type="button" onClick={() => void videos.forget(id).then(refresh)}>
              {t("export.unfinished.clear")}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** A project folder that the address of this window asks for, which waits for people. */
function Waiting({ waiting }: { waiting: WaitingFolder }) {
  const { projectFolders } = useWorkbench();
  const { t } = useTranslation();
  const { record, status } = waiting;
  if (!projectFolders) return null;
  if (status === "ask") {
    return (
      <section className={styles.waiting} aria-label={t("folder.continue", { name: record.name })}>
        <button
          type="button"
          className={styles.create}
          onClick={() => void projectFolders.openRecent(record)}
        >
          <FolderOpen size={16} />
          {t("folder.continue", { name: record.name })}
        </button>
        <p className={styles.muted}>{t("folder.continueHint")}</p>
      </section>
    );
  }
  return (
    <section className={styles.waiting} role="alert">
      <p>
        {status === "gone"
          ? t("folder.waitingGone", { name: record.name })
          : t("folder.waitingBlocked", { name: record.name })}
      </p>
      {status === "gone" && (
        <button
          type="button"
          className={styles.bringIn}
          onClick={() => void projectFolders.findAgain(record)}
        >
          {t("folder.findAgain")}
        </button>
      )}
    </section>
  );
}

/**
 * The projects on this computer: folders opened in this browser before, the most recent first,
 * each with how its folder is now and how it stands with the platform. A project that moved here
 * from the browser may have copies of the files of its assets there still, which people can let
 * go of.
 */
function LocalProjects({
  rows,
  now,
  refresh,
}: {
  rows: readonly LocalRow[];
  now: number;
  refresh: () => void;
}) {
  const { projectFolders } = useWorkbench();
  const { t } = useTranslation();
  const [statuses, setStatuses] = useState<ReadonlyMap<string, FolderStatus>>(new Map());
  const [copies, setCopies] = useState<ReadonlyMap<string, number>>(new Map());

  // Looking at a folder can take a while, as on a network: the list does not wait for it.
  useEffect(() => {
    if (!projectFolders) return;
    let isCurrent = true;
    for (const { record } of rows) {
      void projectFolders.projects.statusOf(record).then((status) => {
        if (isCurrent) setStatuses((before) => new Map(before).set(record.id, status));
      });
      void projectFolders.copiesOf(record).then((size) => {
        if (isCurrent) setCopies((before) => new Map(before).set(record.id, size));
      });
    }
    return () => {
      isCurrent = false;
    };
  }, [projectFolders, rows]);

  if (!projectFolders) return null;
  return (
    <ul className={styles.list} aria-label={t("start.local")}>
      {rows.map((row) => {
        const { record } = row;
        const view = localRowView(row, statuses.get(row.key), t);
        const kept = copies.get(row.key) ?? 0;
        return (
          <li key={row.key} data-project={row.key}>
            <button
              type="button"
              className={styles.project}
              onClick={() => void projectFolders.openRecent(record).then(refresh)}
            >
              <span className={styles.line}>
                <span className={styles.name}>{row.name}</span>
                <span className={styles.time}>{agoText(row.openedAt, now, t)}</span>
              </span>
              <span className={styles.about}>
                <span className={view.gone ? styles.warning : undefined}>{view.place}</span>
                {view.mark !== undefined && (
                  <span
                    className={view.attention ? `${styles.mark} ${styles.warning}` : styles.mark}
                    data-mark={row.mark?.kind}
                    {...(view.hint && { title: view.hint })}
                  >
                    <CloudText text={view.mark} />
                  </span>
                )}
              </span>
            </button>
            {view.gone && (
              <>
                <button
                  type="button"
                  className={styles.again}
                  onClick={() => void projectFolders.findAgain(record).then(refresh)}
                >
                  {t("folder.findAgain")}
                </button>
                <button
                  type="button"
                  className={styles.again}
                  onClick={() => void projectFolders.saveElsewhere(record).then(refresh)}
                >
                  {t("folder.saveElsewhere")}
                </button>
              </>
            )}
            {kept > 0 && (
              <button
                type="button"
                className={styles.again}
                title={t("folder.move.copiesHint", { size: formatSize(kept) })}
                onClick={() => void projectFolders.releaseCopies(record).then(refresh)}
              >
                {t("folder.move.releaseShort", { size: formatSize(kept) })}
              </button>
            )}
            <button
              type="button"
              className={styles.remove}
              aria-label={t("folder.removeButton", { name: row.name })}
              title={t("folder.remove")}
              onClick={() => {
                void projectFolders.remove(record).then((removed) => {
                  if (removed) refresh();
                });
              }}
            >
              <X size={14} />
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** The projects that are only in this browser: old ones, and those of a browser without folders. */
function BrowserProjects({
  projects,
  known,
  now,
  refresh,
}: {
  projects: readonly ProjectSummary[];
  /** They are known to be only here, see `StartLists.browserKnown`. */
  known: boolean;
  now: number;
  refresh: () => void;
}) {
  const workbench = useWorkbench();
  const { projectFolders } = workbench;
  const { t } = useTranslation();
  return (
    <ul className={styles.list} aria-label={t("start.browser")}>
      {projects.map((project) => (
        <li key={project.id} data-project={project.id}>
          <button
            type="button"
            className={styles.project}
            onClick={() => void workbench.openProject(project.id)}
          >
            <span className={styles.line}>
              <span className={styles.name}>{project.name}</span>
              <span className={styles.time}>{agoText(project.updatedAt, now, t)}</span>
            </span>
            {/* Not safe: the browser can clear it at any time. On its own line, not over the page. */}
            {known && (
              <span className={styles.about}>
                <span
                  className={`${styles.mark} ${styles.warning}`}
                  data-mark="onlyHere"
                  title={t("start.hint.onlyHere")}
                >
                  {t("start.mark.onlyHere")}
                </span>
              </span>
            )}
          </button>
          {projectFolders && (
            <button
              type="button"
              className={styles.again}
              aria-label={t("folder.move.button", { name: project.name })}
              onClick={() => void projectFolders.moveToFolder(project.id).then(refresh)}
            >
              {t("folder.move.action")}
            </button>
          )}
          <button
            type="button"
            className={styles.remove}
            aria-label={t("project.removeButton", { name: project.name })}
            // One that moved into a folder meanwhile is not removed, and shows where it is now.
            onClick={() => void workbench.removeProject(project).then(refresh)}
          >
            <X size={14} />
          </button>
        </li>
      ))}
    </ul>
  );
}

/**
 * The projects of the platform that have no folder on this computer, see the design of the start
 * page, 2: each opens as it is, kept in this browser, or goes into a folder first. What else there
 * is to do with one is under "更多".
 */
function CloudProjectList({
  rows,
  now,
  refresh,
}: {
  rows: readonly CloudRow[];
  now: number;
  refresh: () => void;
}) {
  const { cloud, projectFolders } = useWorkbench();
  const { t } = useTranslation();
  /** One thing at a time: a project that is on its way here must not be asked for twice. */
  const [busy, setBusy] = useState(false);
  if (!cloud || rows.length === 0) return null;
  // Each of these asks and says what it has to by itself: the list only shows what came of it.
  const run = (work: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    void work().finally(() => {
      setBusy(false);
      refresh();
    });
  };
  return (
    <ul className={styles.list} aria-label={t("start.cloud")}>
      {rows.map((row) => {
        const view = cloudRowView(row, { now, canDownload: projectFolders !== undefined }, t);
        const words = { name: row.name, interpolation: { escapeValue: false } };
        const about = { name: row.name, copy: row.copy };
        const more: Record<(typeof view.more)[number], MenuItem> = {
          openOnGitHub: {
            id: "openOnGitHub",
            label: t("start.openOnGitHub"),
            run: () => void window.open(view.address, "_blank", "noopener,noreferrer"),
          },
          // By what this browser keeps it by, not by its id on the platform.
          removeHere: {
            id: "removeHere",
            label: t("start.removeHere"),
            disabled: busy,
            run: () => {
              const { key } = row;
              if (key !== undefined) run(() => cloud.removeFromBrowser(key));
            },
          },
          deleteCloud: {
            id: "deleteCloud",
            label: t("start.deleteCloud"),
            disabled: busy,
            run: () => run(() => cloud.deleteFromCloud(row.project, row.name)),
          },
        };
        return (
          <li key={row.project} data-project={row.project} data-listed={row.listed}>
            <button
              type="button"
              className={`${styles.project} ${styles.cloudProject}`}
              aria-label={t("start.openNamed", words)}
              disabled={busy}
              onClick={() => run(() => cloud.openCloudProject(row.project, about))}
            >
              <span className={styles.words}>
                <span className={styles.name}>{row.name}</span>
                <span className={styles.about}>
                  {view.about.map((text) => (
                    <span key={text}>{text}</span>
                  ))}
                  {view.mark !== undefined && (
                    <span
                      className={`${styles.mark} ${styles.warning}`}
                      data-mark={row.mark.kind}
                      {...(view.hint && { title: view.hint })}
                    >
                      <CloudText text={view.mark} />
                    </span>
                  )}
                </span>
              </span>
              <span className={styles.openWord} aria-hidden="true">
                {t("start.open")}
              </span>
            </button>
            {view.download && (
              <button
                type="button"
                className={styles.again}
                aria-label={t("start.downloadNamed", words)}
                disabled={busy}
                // Right in the click: the browser lets the editor ask for a folder only then.
                onClick={() => run(() => cloud.downloadToFolder(row.project, about))}
              >
                {t("start.download")}
              </button>
            )}
            {view.more.length > 0 && (
              <Menu
                label={t("start.more", words)}
                trigger={<Ellipsis size={14} />}
                triggerClassName={styles.more}
                align="end"
                groups={() => [view.more.map((id) => more[id])]}
              />
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** The column of the platform: its projects, or why there are none to show. */
function CloudColumn({
  lists,
  now,
  refresh,
}: {
  lists: StartListSnapshot;
  now: number;
  refresh: () => void;
}) {
  const workbench = useWorkbench();
  const { t } = useTranslation();
  const section = useRef<HTMLElement>(null);
  const asked = useSyncExternalStore(
    workbench.cloudColumn.subscribe,
    workbench.cloudColumn.getSnapshot,
  );
  // "打开云端的项目…" of the menu means this column, as it is now.
  useEffect(() => {
    if (!asked) return;
    workbench.cloudColumn.set(false);
    refresh();
    section.current?.scrollIntoView({ block: "nearest" });
    section.current?.focus({ preventScroll: true });
  }, [asked, workbench, refresh]);
  const { cloudState, cloud } = lists;
  return (
    <section
      ref={section}
      className={styles.column}
      aria-label={t("start.cloud")}
      data-cloud-list={cloudState}
      tabIndex={-1}
    >
      <h2>{t("start.cloud")}</h2>
      {cloudState === "signedOut" && (
        <p className={styles.say}>
          <span>{t("start.cloudSignedOut")}</span>
          <button type="button" className={styles.bringIn} onClick={() => void workbench.signIn()}>
            {t("start.signIn")}
          </button>
        </p>
      )}
      {cloudState === "unreadable" && (
        <p className={styles.say} role="status">
          <span className={styles.warning}>{t("start.cloudUnreadable")}</span>
          <button type="button" className={styles.bringIn} onClick={refresh}>
            {t("start.readAgain")}
          </button>
        </p>
      )}
      {cloudState === "loading" && <p className={styles.muted}>{t("start.cloudLoading")}</p>}
      {cloudState === "ready" && cloud.length === 0 && (
        <p className={styles.muted}>{t("start.cloudEmpty")}</p>
      )}
      <CloudProjectList rows={cloud} now={now} refresh={refresh} />
    </section>
  );
}

/**
 * What people see before a project is open: every panel needs a project to show anything. The
 * projects on this computer, and next to them those of the platform where the editor is hosted on
 * one, see `StartList`: every project shows once.
 */
export function StartPage() {
  const workbench = useWorkbench();
  const { projectFolders, start } = workbench;
  const { t } = useTranslation();
  const lists = useSyncExternalStore(start.subscribe, start.getSnapshot);
  const folders = useSyncExternalStore(
    projectFolders?.subscribe ?? noSubscription,
    projectFolders?.getSnapshot ?? noFolders,
  );
  const [now, setNow] = useState(() => Date.now());
  const refresh = useCallback(() => void start.refresh(), [start]);

  // A project that moved into a folder in another window is listed as a folder from then on.
  useEffect(refresh, [refresh, folders.waiting, folders.moves]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, []);
  // People come back to the window: what another window or another computer did meanwhile shows.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [refresh]);

  const { local, browser, cloudState, failed, loading } = lists;
  const hasCloud = cloudState !== "none";
  // "No projects yet" would be a frightening thing to say when the list merely cannot be read.
  const isUnread = failed.projects || failed.folders;
  const nothing = !loading && !isUnread && local.length === 0 && browser.length === 0;

  return (
    <main className={styles.page}>
      <div className={styles.content} data-columns={hasCloud ? 2 : 1}>
        <h1>
          <Feather size={28} />
          AnimaQuill
        </h1>
        <p className={styles.tagline}>{t("app.tagline")}</p>

        <div className={styles.actions}>
          <button
            type="button"
            className={styles.create}
            onClick={() => void workbench.newProject().then(refresh)}
          >
            <Plus size={16} />
            {t("project.new")}
          </button>
          {projectFolders ? (
            <button
              type="button"
              className={styles.bringIn}
              onClick={() => void workbench.openFolder().then(refresh)}
            >
              <FolderOpen size={16} />
              {t("folder.openAction")}
            </button>
          ) : (
            <button
              type="button"
              className={styles.bringIn}
              onClick={() => void workbench.importProject().then(refresh)}
            >
              <FolderInput size={16} />
              {t("transfer.importAction")}
            </button>
          )}
          {projectFolders && <span className={styles.dropHint}>{t("folder.dropHint")}</span>}
        </div>

        {folders.waiting && <Waiting waiting={folders.waiting} />}
        {(isUnread || failed.links) && (
          <p className={styles.failed} role="alert">
            {t("project.listFailed")}
          </p>
        )}

        <div className={styles.columns}>
          <section className={styles.column} aria-label={t("start.local")}>
            {projectFolders && (local.length > 0 || nothing) && (
              <>
                <h2>{t("start.local")}</h2>
                {nothing && <p className={styles.muted}>{t("start.localEmpty")}</p>}
                <LocalProjects rows={local} now={now} refresh={refresh} />
              </>
            )}
            {/*
              Only where there are any: old ones, and those of a browser without folders, where
              they are all there is on this computer, and stand next to those of the platform.
            */}
            {(browser.length > 0 || (!projectFolders && hasCloud)) && <h2>{t("start.browser")}</h2>}
            {browser.length > 0 && (
              <>
                <BrowserProjects
                  projects={browser}
                  known={lists.browserKnown}
                  now={now}
                  refresh={refresh}
                />
                {projectFolders && <p className={styles.muted}>{t("folder.browserHint")}</p>}
              </>
            )}
            {!projectFolders && nothing && <p className={styles.muted}>{t("project.none")}</p>}
            <p className={styles.muted}>
              {projectFolders
                ? t("folder.localHint")
                : hasCloud
                  ? t("folder.unsupported")
                  : t("newProject.unsupported")}
            </p>
          </section>
          {hasCloud && <CloudColumn lists={lists} now={now} refresh={refresh} />}
        </div>

        <UnfinishedExports lists={lists} />
      </div>
    </main>
  );
}
