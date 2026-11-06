import { Circle, CircleAlert } from "lucide-react";
import { useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import type { InputChoice } from "../workbench/input-mode.ts";
import { FrameRateStatus, TimeStatus } from "../timeline/StatusItems.tsx";
import { useProject, useSession, useWorkbench } from "./context.ts";
import { Bubble } from "./Bubble.tsx";
import styles from "./StatusBar.module.css";
import { Tip } from "./Tip.tsx";

const CHOICES = ["auto", "mouse", "trackpad", "touch"] as const;

/** Shows what the editor takes the input for, and lets people put it right. */
function InputSwitch() {
  const { input } = useWorkbench();
  const { t } = useTranslation();
  const { choice, device } = useSyncExternalStore(input.subscribe, input.getSnapshot);
  const [anchor, setAnchor] = useState<DOMRect>();
  const close = () => setAnchor(undefined);

  return (
    <>
      <Tip name={t("input.label")} usage={t("input.usage")}>
        <button
          type="button"
          className={styles.name}
          aria-haspopup="dialog"
          aria-label={`${t("input.label")}：${t(`input.${device}`)}`}
          onClick={(event) => setAnchor(event.currentTarget.getBoundingClientRect())}
        >
          {t(`input.${device}`)}
        </button>
      </Tip>
      {anchor && (
        <Bubble anchor={anchor} title={t("input.label")} onClose={close}>
          <div className={styles.choices} role="radiogroup" aria-label={t("input.label")}>
            {CHOICES.map((id: InputChoice) => (
              <button
                key={id}
                type="button"
                role="radio"
                className={styles.choice}
                aria-checked={choice === id}
                {...(choice === id ? { "data-autofocus": true } : {})}
                onClick={() => {
                  input.choose(id);
                  close();
                }}
              >
                <strong>
                  {id === "auto"
                    ? t("input.autoNow", { device: t(`input.${device}`) })
                    : t(`input.${id}`)}
                </strong>
                <span>{t(`input.about.${id}`)}</span>
              </button>
            ))}
          </div>
        </Bubble>
      )}
    </>
  );
}

/** Nothing gets recorded without this being on the screen. */
function RecordingStatus() {
  const { diagnostics, layout } = useWorkbench();
  const { t } = useTranslation();
  const recording = useSyncExternalStore(diagnostics.subscribe, diagnostics.getRecording);
  if (!recording) return null;
  return (
    <Tip name={t("diagnostics.recording")} usage={t("diagnostics.recordingUsage")}>
      <button type="button" className={styles.name} onClick={() => layout.openPanel("performance")}>
        <Circle size={9} fill="currentColor" className={styles.recording} />
        {t("diagnostics.recording")}
      </button>
    </Tip>
  );
}

export function StatusBar() {
  const workbench = useWorkbench();
  const { store, save } = useSession();
  const project = useProject(store);
  const { t } = useTranslation();

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
      <RecordingStatus />
      {project && <TimeStatus />}
      {project && <FrameRateStatus />}
      <InputSwitch />
    </footer>
  );
}
