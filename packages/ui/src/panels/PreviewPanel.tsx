import { Pause, Play, SkipBack, SkipForward } from "lucide-react";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { Tip } from "../app/Tip.tsx";
import { useSession, useWorkbench } from "../app/context.ts";
import { PreviewLink } from "../preview/link.ts";
import { formatTimecode, frameAt } from "../timeline/frames.ts";
import { ToolButton } from "../timeline/ToolButton.tsx";
import styles from "./PreviewPanel.module.css";

export function PreviewPanel() {
  const workbench = useWorkbench();
  const { timeline, properties, trials, projects, media, compositorUrl } = workbench;
  const { notifications, diagnostics } = workbench;
  const { t } = useTranslation();
  const { store } = useSession();
  const { playing, model } = useSyncExternalStore(timeline.subscribe, timeline.getSnapshot);
  const frame = useSyncExternalStore(timeline.subscribeView, () => timeline.frame);
  const { count, comparing } = useSyncExternalStore(trials.subscribe, trials.getSnapshot);
  const picture = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    const element = picture.current;
    if (!element || !store) return;
    const warned = new Set<string>();
    const onProblem = (file: string) => {
      if (!warned.has(file)) notifications.push(t("notice.previewCannotDecode"));
      warned.add(file);
    };
    const link = new PreviewLink(
      element,
      timeline,
      properties,
      store,
      projects,
      onProblem,
      diagnostics,
      media,
    );
    // The compositor says hello once it has loaded, so the link has to listen first.
    element.src = compositorUrl;
    return () => link.dispose();
  }, [compositorUrl, diagnostics, media, notifications, projects, properties, store, t, timeline]);

  return (
    <div className={styles.panel}>
      <iframe
        ref={picture}
        className={styles.picture}
        title={t("panel.preview.title")}
        // No same-origin: whatever runs there one day has no way into the editor.
        sandbox="allow-scripts"
        tabIndex={-1}
      />
      {count > 0 && (
        <div className={styles.showing} data-comparing={comparing || undefined} role="status">
          {comparing ? t("trial.showingSaved") : t("trial.showingTrial")}
        </div>
      )}
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
          <Tip name={t("timeline.time")} usage={t("timeline.timeFormat")}>
            <span className={styles.time}>
              <output aria-live="off">{formatTimecode(frame, model.rate)}</output>
              <span>| {formatTimecode(frameAt(model.duration, model.rate), model.rate)}</span>
            </span>
          </Tip>
        )}
      </div>
    </div>
  );
}
