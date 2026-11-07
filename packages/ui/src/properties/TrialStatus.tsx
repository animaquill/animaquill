import { TriangleAlert } from "lucide-react";
import { useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { Tip } from "../app/Tip.tsx";
import { useWorkbench } from "../app/context.ts";
import { formatCombo } from "../workbench/keys.ts";
import styles from "./TrialStatus.module.css";

/** What is being tried and what can be done about it. It is in the title bar to stay in sight. */
export function TrialStatus() {
  const workbench = useWorkbench();
  const { trials, keybindings } = workbench;
  const { t } = useTranslation();
  const { count, conflicts, comparing } = useSyncExternalStore(
    trials.subscribe,
    trials.getSnapshot,
  );
  if (count === 0) return null;
  const saveKey = keybindings.keysFor("project.save")[0];
  return (
    <div className={styles.status} role="group" aria-label={t("trial.label")}>
      <span className={styles.count} role="status">
        {t("trial.count", { count })}
      </span>
      {conflicts > 0 && (
        <Tip name={t("trial.conflicts", { count: conflicts })} usage={t("trial.conflictsHelp")}>
          <span className={styles.conflicts} tabIndex={0}>
            <TriangleAlert size={12} />
            {t("trial.conflicts", { count: conflicts })}
          </span>
        </Tip>
      )}
      <Tip name={t("trial.compare")} usage={t("trial.compareHelp")}>
        <button
          type="button"
          className={styles.button}
          aria-pressed={comparing}
          onClick={() => trials.toggleCompare()}
        >
          {t("trial.compare")}
        </button>
      </Tip>
      <Tip name={t("trial.discard")} usage={t("trial.discardHelp")}>
        <button type="button" className={styles.button} onClick={() => trials.discard()}>
          {t("trial.discard")}
        </button>
      </Tip>
      <Tip
        name={t("trial.save")}
        usage={t("trial.saveHelp")}
        shortcut={saveKey && formatCombo(saveKey, keybindings.platform)}
      >
        <button type="button" className={styles.save} onClick={() => void workbench.save()}>
          {t("trial.save")}
        </button>
      </Tip>
    </div>
  );
}
