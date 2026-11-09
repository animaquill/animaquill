import { useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { useWorkbench } from "../app/context.ts";
import { AiServicesSettings } from "../chat/AiServicesSettings.tsx";
import styles from "./SettingsPanel.module.css";

/** Preferences that all windows share. What belongs to a tab stays on that tab. */
export function SettingsPanel() {
  const { trials } = useWorkbench();
  const { t } = useTranslation();
  const { enabled, count } = useSyncExternalStore(trials.subscribe, trials.getSnapshot);

  return (
    <div className={styles.panel}>
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
      <AiServicesSettings />
    </div>
  );
}
