import type { ProjectSummary } from "@animaquill/host";
import { Feather, FolderInput, Plus, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { sizeOf, type UnfinishedExport } from "../export/video.ts";
import { useWorkbench } from "./context.ts";
import styles from "./StartPage.module.css";

const when = new Intl.DateTimeFormat("zh-CN", { dateStyle: "short", timeStyle: "short" });

/** What people see before a project is open: every panel needs a project to show anything. */
/** What exports that stopped halfway take on this device, which people should be able to clear. */
function UnfinishedExports({ projects }: { projects: readonly ProjectSummary[] }) {
  const { videos } = useWorkbench();
  const { t } = useTranslation();
  const [found, setFound] = useState<readonly UnfinishedExport[]>([]);
  const refresh = useCallback(() => {
    void videos.unfinished().then(setFound);
  }, [videos]);
  useEffect(refresh, [refresh]);
  if (found.length === 0) return null;
  const nameOf = (id: string) => projects.find((project) => project.id === id)?.name ?? "";
  return (
    <section aria-label={t("export.unfinished.title")}>
      <h2>{t("export.unfinished.title")}</h2>
      <p className={styles.muted}>{t("export.unfinished.about")}</p>
      <ul className={styles.list}>
        {found.map(({ id, project, name, bytes }) => (
          <li key={id} className={styles.unfinished}>
            <span className={styles.name}>
              {t("export.unfinished.item", {
                project: nameOf(project),
                file: name,
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

export function StartPage() {
  const workbench = useWorkbench();
  const { t } = useTranslation();
  const [projects, setProjects] = useState<readonly ProjectSummary[]>();
  const [failed, setFailed] = useState(false);

  // "No projects yet" would be a frightening thing to say when the list merely cannot be read.
  const refresh = useCallback(() => {
    workbench.session.list().then(setProjects, (error: unknown) => {
      console.warn("Projects could not be listed", error);
      setFailed(true);
    });
  }, [workbench]);

  useEffect(refresh, [refresh]);

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
            onClick={() => void workbench.newProject()}
          >
            <Plus size={16} />
            {t("project.new")}
          </button>
          <button
            type="button"
            className={styles.bringIn}
            onClick={() => void workbench.importProject().then(refresh)}
          >
            <FolderInput size={16} />
            {t("transfer.importAction")}
          </button>
        </div>

        {projects && projects.length > 0 && <h2>{t("project.recent")}</h2>}
        {projects?.length === 0 && <p className={styles.muted}>{t("project.none")}</p>}
        {failed && (
          <p className={styles.failed} role="alert">
            {t("project.listFailed")}
          </p>
        )}
        <ul className={styles.list}>
          {projects?.map((project) => (
            <li key={project.id}>
              <button
                type="button"
                className={styles.project}
                onClick={() => void workbench.openProject(project.id)}
              >
                <span className={styles.name}>{project.name}</span>
                <span className={styles.time}>{when.format(project.updatedAt)}</span>
              </button>
              <button
                type="button"
                className={styles.remove}
                aria-label={t("project.removeButton", { name: project.name })}
                onClick={() => {
                  void workbench.removeProject(project).then((removed) => {
                    if (removed) refresh();
                  });
                }}
              >
                <X size={14} />
              </button>
            </li>
          ))}
        </ul>

        <p className={styles.muted}>{t("project.localHint")}</p>
        <UnfinishedExports projects={projects ?? []} />
      </div>
    </main>
  );
}
