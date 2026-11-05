import { Feather, Search } from "lucide-react";
import { useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { formatCombo } from "../workbench/keys.ts";
import { useLayout, useWorkbench } from "./context.ts";
import { Menu } from "./Menu.tsx";
import styles from "./TitleBar.module.css";

export function TitleBar() {
  const workbench = useWorkbench();
  const { keybindings } = workbench;
  const { workspace: current } = useLayout();
  const { t } = useTranslation();
  useSyncExternalStore(keybindings.subscribe, keybindings.getSnapshot);

  const shortcutOf = (id: string) => {
    const combo = keybindings.keysFor(id)[0];
    return combo ? formatCombo(combo, keybindings.platform) : undefined;
  };

  const viewMenu = workbench.actions.menu("view").map((group) =>
    group.map((action) => {
      const shortcut = shortcutOf(action.id);
      return {
        id: action.id,
        label: (action.menu?.title ?? action.title)(t),
        run: action.run,
        ...(action.selected ? { selected: action.selected() } : {}),
        ...(shortcut ? { shortcut } : {}),
      };
    }),
  );
  const paletteShortcut = shortcutOf("view.commandPalette");

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
      <button
        type="button"
        className={styles.search}
        {...(paletteShortcut ? { "aria-keyshortcuts": paletteShortcut } : {})}
        onClick={() => workbench.palette.toggle()}
      >
        <Search size={14} />
        <span>{t("palette.title")}</span>
        {paletteShortcut && <kbd aria-hidden="true">{paletteShortcut}</kbd>}
      </button>
    </header>
  );
}
