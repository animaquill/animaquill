import { ChevronDown, Feather, LayoutDashboard, Search } from "lucide-react";
import { useEffect, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { TrialStatus } from "../properties/TrialStatus.tsx";
import { formatCombo } from "../workbench/keys.ts";
import { useLayout, useProject, useSession, useWorkbench } from "./context.ts";
import { Menu } from "./Menu.tsx";
import styles from "./TitleBar.module.css";

const MENUS = ["file", "edit", "view", "timeline", "help"] as const;

export function TitleBar() {
  const workbench = useWorkbench();
  const { keybindings } = workbench;
  const { layout, layouts } = useLayout();
  const { store } = useSession();
  const project = useProject(store);
  const { t } = useTranslation();
  useSyncExternalStore(keybindings.subscribe, keybindings.getSnapshot);

  const name = project?.manifest.name;
  useEffect(() => {
    document.title = name ? `${name} - AnimaQuill` : "AnimaQuill";
  }, [name]);

  const shortcutOf = (id: string) => {
    const combo = keybindings.keysFor(id)[0];
    return combo ? formatCombo(combo, keybindings.platform) : undefined;
  };

  const menuOf = (menu: string) =>
    workbench.actions.menu(menu).map((group) =>
      group.map((action) => {
        const shortcut = shortcutOf(action.id);
        return {
          id: action.id,
          label: (action.menu?.title ?? action.title)(t),
          run: () => workbench.actions.perform(action, "menu"),
          disabled: action.enabled?.() === false,
          ...(action.selected ? { selected: action.selected() } : {}),
          ...(shortcut ? { shortcut } : {}),
        };
      }),
    );
  const paletteShortcut = shortcutOf("view.commandPalette");
  const layoutName = layouts.find((choice) => choice.id === layout)?.title(t) ?? "";

  return (
    <header className={styles.bar}>
      <div className={styles.brand}>
        <Feather size={16} />
        <span>AnimaQuill</span>
        <small className={styles.version}>{workbench.version}</small>
      </div>
      {MENUS.map((menu) => (
        <Menu key={menu} label={t(`menu.${menu}`)} groups={() => menuOf(menu)} />
      ))}
      {store && (
        <div className={styles.layout}>
          <Menu
            label={t("layout.current", { name: layoutName })}
            triggerClassName={styles.layoutButton}
            trigger={
              <>
                <LayoutDashboard size={14} />
                <span>{layoutName}</span>
                <ChevronDown size={12} />
              </>
            }
            groups={() => menuOf("layout")}
          />
        </div>
      )}
      <div className={styles.end}>
        {store && <TrialStatus />}
        <button
          type="button"
          className={styles.search}
          aria-label={t("palette.title")}
          {...(paletteShortcut ? { "aria-keyshortcuts": paletteShortcut } : {})}
          onClick={() => workbench.palette.toggle()}
        >
          <Search size={14} />
          <span>{t("palette.title")}</span>
          {paletteShortcut && <kbd aria-hidden="true">{paletteShortcut}</kbd>}
        </button>
      </div>
    </header>
  );
}
