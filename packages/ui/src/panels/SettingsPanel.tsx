import { ChevronLeft } from "lucide-react";
import { useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { useWorkbench } from "../app/context.ts";
import { AccountSyncPage } from "../chat/AccountSyncPage.tsx";
import { AiModelsPage } from "../chat/AiModelsPage.tsx";
import { ModelPacksSettings } from "../chat/ModelPacksSettings.tsx";
import { SETTINGS_PAGES } from "../workbench/settings-nav.ts";
import styles from "./SettingsPanel.module.css";

/**
 * Preferences that all windows share, in pages: a list of them on the left and the page on the
 * right, or one level at a time where the tab is narrow (see `SettingsPlace`). Where the settings
 * of a window are is the window's own.
 */
export function SettingsPanel() {
  const { settingsNav, aiSync } = useWorkbench();
  const { t } = useTranslation();
  const place = useSyncExternalStore(settingsNav.subscribe, settingsNav.getSnapshot);
  const { available } = useSyncExternalStore(aiSync.subscribe, aiSync.getSnapshot);
  const pages = SETTINGS_PAGES.filter((page) => page !== "account" || available);

  return (
    <div className={styles.panel} data-testid="settings-panel">
      <div className={styles.layout} data-depth={place.depth}>
        <nav className={styles.nav} aria-label={t("settings.pagesLabel")}>
          {pages.map((page) => (
            <button
              key={page}
              type="button"
              className={styles.navItem}
              aria-current={page === place.page ? "page" : undefined}
              onClick={() => settingsNav.go({ page, depth: 1 })}
            >
              {t(`settings.pages.${page}`)}
            </button>
          ))}
        </nav>
        <div className={styles.page}>
          {place.page === "editing" && <EditingSettings />}
          {place.page === "models" && <AiModelsPage />}
          {place.page === "account" && available && <AccountSyncPage />}
          {place.page === "packs" && (
            <div className={styles.scroll}>
              <BackToPages />
              <ModelPacksSettings />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** Up to the list of pages, where the settings show one level at a time. */
export function BackToPages() {
  const { settingsNav } = useWorkbench();
  const { t } = useTranslation();
  return (
    <button
      type="button"
      className={styles.back}
      data-testid="settings-back"
      onClick={() => settingsNav.go({ page: settingsNav.getSnapshot().page, depth: 0 })}
    >
      <ChevronLeft size={14} aria-hidden /> {t("settings.back")}
    </button>
  );
}

function EditingSettings() {
  const { trials } = useWorkbench();
  const { t } = useTranslation();
  const { enabled, count } = useSyncExternalStore(trials.subscribe, trials.getSnapshot);
  return (
    <div className={styles.scroll}>
      <BackToPages />
      <h2 className={styles.group}>{t("settings.editing")}</h2>
      <label className={styles.setting}>
        <input
          type="checkbox"
          checked={enabled}
          onChange={(event) => trials.setEnabled(event.target.checked)}
        />
        <span>
          <strong>{t("settings.trial")}</strong>
          <span className={styles.help}>{t("settings.trialHelp")}</span>
          {!enabled && count > 0 && (
            <span className={styles.pending}>{t("settings.trialPending", { count })}</span>
          )}
        </span>
      </label>
    </div>
  );
}
