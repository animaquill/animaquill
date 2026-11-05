import { useTranslation } from "react-i18next";
import { useLayout, useWorkbench } from "./context.ts";
import styles from "./StatusBar.module.css";

export function StatusBar() {
  const workbench = useWorkbench();
  const { workspace } = useLayout();
  const { t } = useTranslation();
  const current = workbench.layout.workspaces.find((item) => item.id === workspace);

  return (
    <footer className={styles.bar}>
      <span>{t("app.noProject")}</span>
      <span className={styles.spacer} />
      {current && <span>{current.title(t)}</span>}
      <span>{workbench.version}</span>
    </footer>
  );
}
