import { useTranslation } from "react-i18next";
import styles from "./ActivityBar.module.css";
import { useLayout, useWorkbench } from "./context.ts";

export function ActivityBar() {
  const workbench = useWorkbench();
  const { visible } = useLayout();
  const { t } = useTranslation();

  return (
    <nav className={styles.bar} aria-label={t("activity.label")}>
      {workbench.panels
        .list()
        .filter((panel) => panel.activity)
        .map((panel) => (
          <button
            key={panel.type}
            type="button"
            title={panel.title(t)}
            aria-label={panel.title(t)}
            aria-pressed={visible.has(panel.type)}
            onClick={() => workbench.layout.openPanel(panel.type)}
          >
            <panel.icon size={22} />
          </button>
        ))}
    </nav>
  );
}
