import { useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { Tip } from "../app/Tip.tsx";
import { useWorkbench } from "../app/context.ts";
import { formatCombo } from "../workbench/keys.ts";
import styles from "./RecordButton.module.css";

/**
 * Automatic keys, on and off: a round button that goes red while it records, in the keyframes and
 * in the properties. The same switch wherever it is, and the name says all of it.
 */
export function RecordButton() {
  const { properties, keybindings } = useWorkbench();
  const { t } = useTranslation();
  const recording = useSyncExternalStore(properties.subscribeRecording, properties.getRecording);
  const name = t("keyframes.record");
  // No key unless people gave it one.
  const combo = keybindings.keysFor("keyframes.toggleRecording")[0];
  return (
    <Tip
      name={name}
      usage=""
      shortcut={combo ? formatCombo(combo, keybindings.platform) : undefined}
    >
      <button
        type="button"
        className={styles.record}
        aria-label={name}
        aria-pressed={recording}
        data-recording={recording || undefined}
        onClick={() => properties.toggleRecording()}
      >
        <span className={styles.dot} />
      </button>
    </Tip>
  );
}

/** The red frame around what records, for as long as it does. */
export function RecordingFrame() {
  const { properties } = useWorkbench();
  const recording = useSyncExternalStore(properties.subscribeRecording, properties.getRecording);
  return recording ? <div className={styles.frame} data-testid="recording-frame" /> : null;
}
