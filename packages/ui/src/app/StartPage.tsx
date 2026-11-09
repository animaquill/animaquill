import type { FolderRecord, FolderStatus, ProjectSummary } from "@animaquill/host";
import { Feather, FolderInput, FolderOpen, Plus, X } from "lucide-react";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { sizeOf, type UnfinishedExport } from "../export/video.ts";
import { formatSize } from "../transfer/transfer.ts";
import type { ProjectFoldersSnapshot, WaitingFolder } from "../workbench/project-folders.ts";
import { useWorkbench } from "./context.ts";
import styles from "./StartPage.module.css";

const when = new Intl.DateTimeFormat("zh-CN", { dateStyle: "short", timeStyle: "short" });

const noSubscription = () => () => {};
const NO_FOLDERS: ProjectFoldersSnapshot = { open: undefined, waiting: undefined, moves: 0 };
const noFolders = () => NO_FOLDERS;

/** What people see before a project is open: every panel needs a project to show anything. */
/** What exports that stopped halfway take on this device, which people should be able to clear. */
function UnfinishedExports({
  projects,
  records,
}: {
  projects: readonly ProjectSummary[];
  records: readonly FolderRecord[];
}) {
  const { videos } = useWorkbench();
  const { t } = useTranslation();
  const [found, setFound] = useState<readonly UnfinishedExport[]>([]);
  const refresh = useCallback(() => {
    void videos.unfinished().then(setFound);
  }, [videos]);
  useEffect(refresh, [refresh]);
  if (found.length === 0) return null;
  const nameOf = (id: string) =>
    records.find((record) => record.id === id)?.name ??
    projects.find((project) => project.id === id)?.name ??
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
 * Folders opened in this browser before, the most recent first, and how each is now. A project that
 * moved here from the browser may have copies of the files of its assets there still, which people
 * can let go of.
 */
function RecentFolders({
  records,
  statuses,
  copies,
  refresh,
}: {
  records: readonly FolderRecord[];
  statuses: ReadonlyMap<string, FolderStatus>;
  copies: ReadonlyMap<string, number>;
  refresh: () => void;
}) {
  const { projectFolders } = useWorkbench();
  const { t } = useTranslation();
  if (!projectFolders || records.length === 0) return null;
  return (
    <>
      <h2>{t("project.recent")}</h2>
      <ul className={styles.list}>
        {records.map((record) => {
          // Looking at a folder can take a while, as on a network: the list does not wait for it.
          const status = statuses.get(record.id);
          return (
            <li key={record.id}>
              <button
                type="button"
                className={styles.project}
                onClick={() => void projectFolders.openRecent(record).then(refresh)}
              >
                <span className={styles.name}>{record.name}</span>
                <span className={styles.folder}>
                  {status === undefined || status === "ready"
                    ? t("folder.folderLabel", { folder: record.folder.name })
                    : t(`folder.recentStatus.${status}`)}
                </span>
                <span className={styles.time}>{when.format(record.openedAt)}</span>
              </button>
              {status === "gone" && (
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
              {(copies.get(record.id) ?? 0) > 0 && (
                <button
                  type="button"
                  className={styles.again}
                  title={t("folder.move.copiesHint", {
                    size: formatSize(copies.get(record.id) ?? 0),
                  })}
                  onClick={() => void projectFolders.releaseCopies(record).then(refresh)}
                >
                  {t("folder.move.releaseShort", { size: formatSize(copies.get(record.id) ?? 0) })}
                </button>
              )}
              <button
                type="button"
                className={styles.remove}
                aria-label={t("folder.removeButton", { name: record.name })}
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
    </>
  );
}

export function StartPage() {
  const workbench = useWorkbench();
  const { projectFolders } = workbench;
  const { t } = useTranslation();
  const [projects, setProjects] = useState<readonly ProjectSummary[]>();
  const [records, setRecords] = useState<readonly FolderRecord[]>([]);
  const [statuses, setStatuses] = useState<ReadonlyMap<string, FolderStatus>>(new Map());
  const [copies, setCopies] = useState<ReadonlyMap<string, number>>(new Map());
  /** The folders this browser knows cannot be read: nobody can tell its projects from them then. */
  const [foldersFailed, setFoldersFailed] = useState(false);
  const [failed, setFailed] = useState(false);
  const folders = useSyncExternalStore(
    projectFolders?.subscribe ?? noSubscription,
    projectFolders?.getSnapshot ?? noFolders,
  );

  // "No projects yet" would be a frightening thing to say when the list merely cannot be read.
  const refresh = useCallback(() => {
    workbench.session.list().then(setProjects, (error: unknown) => {
      console.warn("Projects could not be listed", error);
      setFailed(true);
    });
    projectFolders?.list().then(
      (found) => {
        setFoldersFailed(false);
        setRecords(found);
        for (const record of found) {
          void projectFolders.projects
            .statusOf(record)
            .then((status) => setStatuses((before) => new Map(before).set(record.id, status)));
          void projectFolders
            .copiesOf(record)
            .then((size) => setCopies((before) => new Map(before).set(record.id, size)));
        }
      },
      (error: unknown) => {
        console.warn("Project folders could not be listed", error);
        setFoldersFailed(true);
        setFailed(true);
      },
    );
  }, [workbench, projectFolders]);

  // A project that moved into a folder in another window is listed as a folder from then on.
  useEffect(refresh, [refresh, folders.waiting, folders.moves]);

  // The log of a project folder is in the browser too, but it is no project of the browser. Where
  // the folders cannot be read, nothing tells them apart: then none of them shows.
  const inFolders = new Set(records.map(({ id }) => id));
  const inBrowser = foldersFailed
    ? []
    : projects?.filter(({ id, folder }) => folder !== true && !inFolders.has(id));
  const nothing = projects !== undefined && inBrowser?.length === 0 && records.length === 0;

  return (
    <main className={styles.page}>
      <div className={styles.content}>
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
        {nothing && <p className={styles.muted}>{t("project.none")}</p>}
        {failed && (
          <p className={styles.failed} role="alert">
            {t("project.listFailed")}
          </p>
        )}
        <RecentFolders records={records} statuses={statuses} copies={copies} refresh={refresh} />

        {inBrowser && inBrowser.length > 0 && (
          <h2>{projectFolders ? t("folder.browserProjects") : t("project.recent")}</h2>
        )}
        <ul className={styles.list}>
          {inBrowser?.map((project) => (
            <li key={project.id}>
              <button
                type="button"
                className={styles.project}
                onClick={() => void workbench.openProject(project.id)}
              >
                <span className={styles.name}>{project.name}</span>
                <span className={styles.time}>{when.format(project.updatedAt)}</span>
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
        {projectFolders && inBrowser && inBrowser.length > 0 && (
          <p className={styles.muted}>{t("folder.browserHint")}</p>
        )}

        <p className={styles.muted}>
          {projectFolders ? t("folder.localHint") : t("folder.unsupported")}
        </p>
        <UnfinishedExports projects={projects ?? []} records={records} />
      </div>
    </main>
  );
}
