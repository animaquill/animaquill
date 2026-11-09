import { useTranslation } from "react-i18next";
import { useWorkbench } from "../app/context.ts";
import styles from "./EmptyDock.module.css";

/** Closing every tab is allowed, so the way back has to be right there. */
export function EmptyDock() {
  const workbench = useWorkbench();
  const { t } = useTranslation();
  return (
    <div className={styles.empty}>
      <h2>{t("dock.empty")}</h2>
      <p>{t("dock.emptyHint")}</p>
      <button type="button" onClick={() => workbench.layout.resetLayout()}>
        {t("dock.restore")}
      </button>
    </div>
  );
}
