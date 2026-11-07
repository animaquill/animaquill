import { useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { Tip } from "../app/Tip.tsx";
import { useWorkbench } from "../app/context.ts";
import styles from "./FrameRateStatus.module.css";

/** Rounded the way the frame rate of the project is shown next to it. */
const shown = (fps: number) => Number(fps.toFixed(2));

/** How many frames the preview really shows, next to what the project asks for. */
export function FrameRateStatus() {
  const { frameRate } = useWorkbench();
  const { t } = useTranslation();
  const snapshot = useSyncExternalStore(frameRate.subscribe, frameRate.getSnapshot);
  if (snapshot.state === "none") return null;
  const reading = snapshot.state === "playing" ? snapshot.reading : undefined;
  const value = reading
    ? t("preview.frameRate.value", { painted: reading.painted })
    : t("preview.frameRate.idle");
  const usage = reading
    ? t("preview.frameRate.playing", {
        painted: reading.painted,
        fps: shown(reading.fps),
        dropped: reading.dropped,
      })
    : t(snapshot.state === "playing" ? "preview.frameRate.waiting" : "preview.frameRate.paused");

  return (
    <Tip name={t("preview.frameRate.name")} usage={usage}>
      <span
        className={styles.item}
        data-short={reading?.short || undefined}
        aria-label={t("preview.frameRate.label", { value })}
      >
        {value}
      </span>
    </Tip>
  );
}
