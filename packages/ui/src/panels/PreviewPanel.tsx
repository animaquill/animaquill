import { MonitorPlay, Pause, Play, SkipBack, SkipForward } from "lucide-react";
import { useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { useWorkbench } from "../app/context.ts";
import { formatTimecode, frameAt } from "../timeline/frames.ts";
import { ToolButton } from "../timeline/ToolButton.tsx";
import styles from "./PreviewPanel.module.css";

export function PreviewPanel() {
  const { timeline } = useWorkbench();
  const { t } = useTranslation();
  const { playing, model } = useSyncExternalStore(timeline.subscribe, timeline.getSnapshot);
  const frame = useSyncExternalStore(timeline.subscribeView, () => timeline.frame);

  return (
    <div className={styles.panel}>
      <div className={styles.picture}>
        <MonitorPlay size={32} />
        <p>{t("panel.preview.hint")}</p>
      </div>
      <div className={styles.transport} role="toolbar" aria-label={t("timeline.transport")}>
        <div className={styles.buttons}>
          <ToolButton
            name={t("timeline.action.previousFrame")}
            usage={t("timeline.help.previousFrame")}
            action="previousFrame"
            icon={SkipBack}
            onClick={() => timeline.stepFrames(-1)}
          />
          <ToolButton
            name={playing ? t("timeline.pause") : t("timeline.play")}
            usage={t("timeline.help.play")}
            action="play"
            icon={playing ? Pause : Play}
            onClick={() => timeline.togglePlayback()}
          />
          <ToolButton
            name={t("timeline.action.nextFrame")}
            usage={t("timeline.help.nextFrame")}
            action="nextFrame"
            icon={SkipForward}
            onClick={() => timeline.stepFrames(1)}
          />
        </div>
        {model && (
          <div className={styles.time}>
            <output aria-live="off">{formatTimecode(frame, model.rate)}</output>
            <span>/ {formatTimecode(frameAt(model.duration, model.rate), model.rate)}</span>
          </div>
        )}
      </div>
    </div>
  );
}
