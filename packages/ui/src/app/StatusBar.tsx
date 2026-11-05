import { CircleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useLayout, useProject, useSession, useWorkbench } from "./context.ts";
import styles from "./StatusBar.module.css";

export function StatusBar() {
  const workbench = useWorkbench();
  const { workspace } = useLayout();
  const { store, save } = useSession();
  const project = useProject(store);
  const { t } = useTranslation();
  const current = workbench.layout.workspaces.find((item) => item.id === workspace);

  const saveText = {
    saved: t("project.saved"),
    saving: t("project.saving"),
    failed: t("project.saveFailed"),
  }[save];

  return (
    <footer className={styles.bar}>
      {project ? (
        <button
          type="button"
          className={styles.name}
          onClick={() => void workbench.renameProject()}
        >
          {project.manifest.name}
        </button>
      ) : (
        <span>{t("app.noProject")}</span>
      )}
      {project && (
        <span className={save === "failed" ? styles.failed : undefined} role="status">
          {save === "failed" && <CircleAlert size={12} />}
          {saveText}
        </span>
      )}
      <span className={styles.spacer} />
      {project && current && <span>{current.title(t)}</span>}
      <span>{workbench.version}</span>
    </footer>
  );
}
