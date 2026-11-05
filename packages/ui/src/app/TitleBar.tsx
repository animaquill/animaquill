import { Feather } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useLayout, useWorkbench } from "./context.ts";
import { Menu } from "./Menu.tsx";
import styles from "./TitleBar.module.css";

export function TitleBar() {
  const workbench = useWorkbench();
  const { workspace: current } = useLayout();
  const { t } = useTranslation();

  const viewMenu = workbench.actions.menu("view").map((group) =>
    group.map((action) => ({
      id: action.id,
      label: action.title(t),
      run: action.run,
      ...(action.selected ? { selected: action.selected() } : {}),
    })),
  );

  return (
    <header className={styles.bar}>
      <div className={styles.brand}>
        <Feather size={16} />
        <span>AnimaQuill</span>
      </div>
      <Menu label={t("menu.view")} groups={viewMenu} />
      <div className={styles.workspaces} role="group" aria-label={t("workspace.label")}>
        {workbench.layout.workspaces.map((workspace) => (
          <button
            key={workspace.id}
            type="button"
            aria-pressed={workspace.id === current}
            onClick={() => workbench.layout.switchWorkspace(workspace.id)}
          >
            {workspace.title(t)}
          </button>
        ))}
      </div>
    </header>
  );
}
